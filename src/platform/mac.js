'use strict';

// macOS: there is no uninstall registry. The equivalent inventory is the set of .app
// bundles on disk plus each bundle's CFBundleShortVersionString.
//
// Primary source is `system_profiler SPApplicationsDataType -json` — one call that
// returns every app with its name, version and path. Like the three `reg query` calls
// on Windows it takes seconds, which is why the caller caches it for the whole run.
// Fallback is a directory scan reading each bundle's Info.plist directly, for machines
// where Spotlight indexing is off or system_profiler is unavailable.

const fs = require('fs');
const path = require('path');
const os = require('os');
const exec = require('./exec');
const { run } = exec;

const { isInstalledAppPath, APP_DIRS } = require('./appfilter');

// --- system_profiler ---------------------------------------------------------

// Parse `system_profiler SPApplicationsDataType -json` into [{ name, version, flavor, path }].
// Apple's own bundled apps are excluded: they update through Software Update, never
// from a GitHub release, so offering them would only produce false matches.
// Pure: JSON text in, records out. `dirs` overrides the app directories, for tests.
// Exported for tests.
function parseSystemProfiler(stdout, dirs) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = (data && data.SPApplicationsDataType) || [];
  const out = [];
  for (const r of rows) {
    if (!r || !r._name) continue;
    if (r.obtained_from === 'apple' || r.obtained_from === 'apple_sw') continue;
    const version = r.version || '';
    if (!version) continue;
    // Spotlight reports every bundle on disk, not the installed set. Without this the
    // inventory carries build outputs and caches, and because installedVersion() takes
    // the HIGHEST match, one of those silently pins an app as already up to date.
    if (!isInstalledAppPath(r.path, dirs)) continue;
    out.push({ name: r._name, version, flavor: 'app', path: r.path });
  }
  return out;
}

// --- Info.plist --------------------------------------------------------------

// Pull CFBundleShortVersionString out of an XML property list. Falls back to
// CFBundleVersion, which is what some apps put the user-facing version in.
// Pure: plist text in, version string or null out. Exported for tests.
function parseInfoPlistXml(text) {
  const pick = (key) => {
    const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'i');
    const m = re.exec(text);
    return m && m[1].trim() ? m[1].trim() : null;
  };
  return pick('CFBundleShortVersionString') || pick('CFBundleVersion');
}

// A bundle's version. XML plists are read directly; binary ones (`bplist00`, which is
// what Xcode emits for release builds) go through `defaults read`, an Apple-signed
// system tool that understands both formats.
async function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  let buf;
  try {
    buf = fs.readFileSync(plist);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') {
    return parseInfoPlistXml(buf.toString('utf8'));
  }
  // `defaults read` takes the path WITHOUT the .plist extension.
  const base = plist.replace(/\.plist$/, '');
  const v = (await run('defaults', ['read', base, 'CFBundleShortVersionString'])).trim();
  if (v) return v;
  return (await run('defaults', ['read', base, 'CFBundleVersion'])).trim() || null;
}

// Directory-scan fallback: every .app bundle in the standard locations, with the
// version read from its own Info.plist.
async function scanAppBundles() {
  const found = [];
  const list = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const dir of APP_DIRS()) {
    for (const name of list(dir)) {
      const appPath = path.join(dir, name);
      if (isInstalledAppPath(appPath)) {
        found.push({ name: name.replace(/\.app$/i, ''), appPath });
        continue;
      }
      // One level of vendor subfolder, matching what the predicate accepts — otherwise
      // this scan would miss /Applications/Utilities and every grouped installer like
      // Setapp, while the primary path happily reports them. The two inventories have to
      // agree, or the fallback is a different answer rather than the same one.
      for (const inner of list(appPath)) {
        const nested = path.join(appPath, inner);
        // Same predicate as the primary path, so both see exactly one set of things.
        if (!isInstalledAppPath(nested)) continue;
        found.push({ name: inner.replace(/\.app$/i, ''), appPath: nested });
      }
    }
  }
  const versions = await Promise.all(found.map((f) => bundleVersion(f.appPath)));
  return found
    .map((f, i) => ({ name: f.name, version: versions[i] || '', flavor: 'app', path: f.appPath }))
    .filter((r) => r.version);
}

async function installedApps() {
  // system_profiler walks the whole disk, so give it more room than the default.
  const out = await run('system_profiler', ['SPApplicationsDataType', '-json'], { timeout: 120_000 });
  const rows = parseSystemProfiler(out);
  return rows.length ? rows : scanAppBundles();
}

// --- processes ---------------------------------------------------------------

// Parse `ps -Ao pid=,comm=` into [{ name, pid }]. comm is the full executable path
// (e.g. /Applications/Foo.app/Contents/MacOS/Foo), so the name is its basename —
// which is what matches the repo name the user tracks. Pure; exported for tests.
function parsePs(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({ name: path.posix.basename(m[2]), pid: m[1] });
  }
  return out;
}

async function runningProcesses() {
  return parsePs(await run('ps', ['-Ao', 'pid=,comm=']));
}

// POSIX signals, so no subprocess at all: SIGTERM lets the app save and quit,
// SIGKILL is the "force" path the UI double-confirms.
function killProcess(pid, force) {
  try {
    process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

// --- extraction --------------------------------------------------------------
// A .app bundle carries symlinks (Contents/Frameworks), Unix mode bits and a code
// signature. A generic JavaScript unzipper destroys all three and the result fails
// Gatekeeper, so macOS archives go through Apple's own tools instead: ditto for zips,
// hdiutil + ditto for disk images. Both are signed system utilities and take an argv
// array — no shell, consistent with the rest of the engine.

// Copying a 300MB bundle off a compressed disk image is not an inventory query — the
// 60s default would kill ditto mid-copy and, before the exit code was checked, that
// partial copy reported success. Matches the installer timeout in src/install.js.
const COPY_TIMEOUT = 10 * 60 * 1000;

// ditto succeeds SILENTLY, so its stdout says nothing about whether it worked; only the
// exit code does. A failure here must throw rather than leave a half-copied bundle that
// extracts clean and dies at first launch.
async function ditto(src, dest) {
  const r = await exec.runStatus('ditto', [src, dest], { timeout: COPY_TIMEOUT });
  if (r.code === 0) return;
  throw new Error(
    r.timedOut
      ? `copying ${path.basename(src)} timed out — the disk image may be on slow or failing media`
      : `copying ${path.basename(src)} failed (ditto exit ${r.code === null ? 'n/a' : r.code})`
  );
}

// Mount a .dmg, copy its payload out, unmount. The /Applications symlink that disk
// images conventionally carry is skipped: it is a drag-and-drop affordance, not payload.
async function extractDmg(dmgPath, destDir) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-dmg-'));
  // The mount must be judged by hdiutil's OWN exit code. mkdtempSync has already created
  // the mountpoint, so a failed attach still leaves a readable empty directory — testing
  // for a readdir throw could never fire, which made the licence-agreement message below
  // unreachable in precisely the case it was written for.
  const attach = await exec.runStatus(
    'hdiutil',
    ['attach', dmgPath, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt],
    { timeout: COPY_TIMEOUT }
  );
  try {
    if (attach.code !== 0) {
      fs.rmSync(mnt, { recursive: true, force: true });
      throw new Error(
        'could not mount the disk image — it may require accepting a licence agreement, which needs a human'
      );
    }
    let names;
    try {
      names = fs.readdirSync(mnt);
    } catch {
      throw new Error('the disk image mounted but could not be read');
    }
    let copied = 0;
    for (const name of names) {
      if (name.startsWith('.') || name === 'Applications') continue;
      await ditto(path.join(mnt, name), path.join(destDir, name)); // throws on failure
      copied++; // only reached when the copy actually succeeded
    }
    if (!copied) throw new Error('the disk image contained nothing to install');
  } finally {
    if (attach.code === 0) {
      await run('hdiutil', ['detach', mnt, '-force'], { acceptAnyExit: true });
      fs.rmSync(mnt, { recursive: true, force: true });
    }
  }
}

// Returns true when it handled the archive, false to let the generic path take it.
async function extract(archivePath, destDir) {
  if (/\.dmg$/i.test(archivePath)) {
    await extractDmg(archivePath, destDir);
    return true;
  }
  if (/\.zip$/i.test(archivePath)) {
    // -x extract, -k treat the source as a PKZip archive.
    //
    // NOTE: this bypasses the symlink-containment guard in src/tar.js entirely — ditto
    // is doing the extraction, so the archive's own paths and links are its problem, not
    // ours. That is deliberate (nothing else preserves a bundle's signature), but it does
    // mean a malicious .zip is contained by ditto's behaviour alone.
    const r = await exec.runStatus('ditto', ['-x', '-k', archivePath, destDir], { timeout: COPY_TIMEOUT });
    if (r.code !== 0) {
      throw new Error(
        r.timedOut
          ? 'extracting the archive timed out'
          : `extracting the archive failed (ditto exit ${r.code === null ? 'n/a' : r.code})`
      );
    }
    return true;
  }
  return false;
}

module.exports = {
  installedApps,
  runningProcesses,
  killProcess,
  extract,
  // exported for tests
  parseSystemProfiler,
  parseInfoPlistXml,
  parsePs,
  scanAppBundles,
  bundleVersion,
  extractDmg,
};
