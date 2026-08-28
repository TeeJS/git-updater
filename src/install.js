'use strict';

// IO edge: apply an update — portable swap (with rollback) or silent installer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { installerCmd } = require('./core');

const isWin = process.platform === 'win32';

// --- portable swap ----------------------------------------------------------

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // cross-volume (temp on C:, target on D:): copy then remove
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw e;
    }
  }
}

function walk(root, base = root, out = []) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (fs.statSync(full).isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

// If the zip wraps everything in N leading single-dir levels, descend past them.
function stripDirs(root, n) {
  let cur = root;
  for (let i = 0; i < n; i++) {
    const items = fs.readdirSync(cur);
    if (items.length === 1 && fs.statSync(path.join(cur, items[0])).isDirectory()) {
      cur = path.join(cur, items[0]);
    } else break;
  }
  return cur;
}

const BAK = '.git-updater.bak'; // distinct suffix so we never clash with an app's own .bak files

// Swap new files into dir: back up each existing target, move new in, delete
// backups on success / restore on failure. Returns the list of installed
// relative paths (for stale-file bookkeeping). A locked file aborts + rolls back.
function swapInPlace(src, dir) {
  const files = walk(src);
  const backups = []; // {to, bak}
  const placed = []; // to
  try {
    for (const rel of files) {
      const from = path.join(src, rel);
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to)) {
        const bak = to + BAK;
        if (fs.existsSync(bak)) fs.rmSync(bak, { force: true }); // clear a stale backup from a prior crash
        fs.renameSync(to, bak); // EBUSY/EPERM here if the file is in use
        backups.push({ to, bak });
      }
      moveFile(from, to);
      placed.push(to);
    }
  } catch (e) {
    for (const to of placed) {
      try {
        fs.rmSync(to, { force: true });
      } catch {}
    }
    const restoreFailed = [];
    for (const { to, bak } of backups) {
      try {
        fs.renameSync(bak, to);
      } catch {
        restoreFailed.push(to);
      }
    }
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
      const err = new Error(`file in use (${e.path || 'target'}); close the app and re-run`);
      err.locked = true;
      throw err;
    }
    if (restoreFailed.length) {
      throw new Error(
        `update failed and rollback was incomplete — restore these from their "${BAK}" copies: ${restoreFailed.join(', ')}`
      );
    }
    throw e;
  }
  for (const { bak } of backups) {
    try {
      fs.rmSync(bak, { force: true });
    } catch {}
  }
  return files;
}

// True only if `rel` resolves to a path INSIDE root (blocks "../escape" and absolute
// paths that a poisoned state.json manifest could smuggle in — critical since a prune
// can run elevated).
function within(root, rel) {
  const r = path.relative(root, path.resolve(root, rel));
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

// Remove files we installed in a previous version that are gone from the new one, then
// drop any directories left empty. Runtime-created files (user settings) are never in
// the manifest, so they are preserved. Returns the files that could NOT be deleted
// (e.g. locked) so the caller keeps tracking them for a retry next update.
function pruneStale(dir, oldFiles, newFiles) {
  const root = path.resolve(dir);
  const keep = new Set((newFiles || []).map((f) => f.replace(/\\/g, '/')));
  const stillStale = [];
  for (const rel of oldFiles || []) {
    if (keep.has(rel.replace(/\\/g, '/'))) continue;
    if (!within(root, rel)) continue; // path-traversal guard: never touch anything outside dir
    try {
      fs.rmSync(path.resolve(root, rel), { force: true });
    } catch {
      stillStale.push(rel); // deletion failed -> keep it in the manifest and retry later
    }
  }
  removeEmptyDirs(dir);
  return stillStale;
}

function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isDirectory()) removeEmptyDirs(full);
    } catch {}
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

// Extract a .7z into destDir using 7z-wasm (pure WASM, no external binary).
// Mounts destDir into the wasm FS, copies the archive in, extracts, cleans up.
async function extract7z(archivePath, destDir) {
  const SevenZip = require('7z-wasm');
  // In the packaged exe the .wasm is a SEA asset; in dev emscripten finds it itself.
  let wasmBinary;
  try {
    const sea = require('node:sea');
    if (sea.isSea()) wasmBinary = sea.getAsset('7zz.wasm');
  } catch {}
  const sevenZip = await SevenZip(wasmBinary ? { wasmBinary } : undefined);

  const mnt = '/out';
  sevenZip.FS.mkdir(mnt);
  sevenZip.FS.mount(sevenZip.NODEFS, { root: destDir }, mnt);
  const archName = 'input.7z';
  fs.copyFileSync(archivePath, path.join(destDir, archName));
  sevenZip.FS.chdir(mnt);

  let rc = 0;
  try {
    // callMain may RETURN the exit code (not throw) — capture both paths.
    const ret = sevenZip.callMain(['x', archName, '-y']); // extract flat into the mounted dir
    if (typeof ret === 'number') rc = ret;
  } catch (e) {
    rc = e && e.status !== undefined ? e.status : 1; // emscripten ExitStatus on exit()
  }
  fs.rmSync(path.join(destDir, archName), { force: true });

  // A corrupt/invalid .7z makes 7-Zip print "Is not archive" and exit nonzero, but the
  // extraction "succeeds" with zero files — verify BOTH the exit code and real output.
  const produced = walk(destDir).length;
  if (rc !== 0 || produced === 0) {
    throw new Error(`.7z extraction failed (exit ${rc}, ${produced} files) — the download may be corrupt or not a 7-Zip archive`);
  }
}

// Returns the list of installed relative paths (manifest) for stale-file bookkeeping.
async function installPortable(archivePath, install) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-extract-'));
  try {
    if (/\.7z$/i.test(archivePath)) await extract7z(archivePath, tmp);
    else new AdmZip(archivePath).extractAllTo(tmp, /* overwrite */ true); // adm-zip >=0.5.10 is zip-slip-safe
    // Auto-flatten version-named wrapper folders (e.g. deskflow-1.26.0-.../) so updates
    // overwrite in place instead of piling up a new folder per release. Explicit strip wins.
    const src = install.strip != null ? stripDirs(tmp, install.strip) : stripDirs(tmp, Infinity);
    if (walk(src).length === 0) throw new Error('archive contained no files');
    fs.mkdirSync(install.dir, { recursive: true });
    return swapInPlace(src, install.dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Detect an installer's silent-install technology from its bytes (far safer than
// assuming every .exe is NSIS). Falls back to null when unrecognized.
function detectInstallerKind(filePath) {
  if (/\.msi$/i.test(filePath)) return 'msi';
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'msi'; // OLE compound = MSI
  if (buf.indexOf(Buffer.from('Inno Setup')) !== -1) return 'inno';
  if (buf.indexOf(Buffer.from('Nullsoft')) !== -1) return 'nsis';
  return null;
}

// --- installer --------------------------------------------------------------

function installInstaller(filePath, install, opts = {}) {
  const { exe, args } = installerCmd(install.kind, filePath, install.args);
  const command = [exe, ...args].join(' ');
  if (opts.dryRun) return { command, dryRun: true };
  if (!isWin) throw new Error('installer type is Windows-only');
  // Launch the installer directly (no PowerShell). A requireAdministrator installer that
  // can't elevate from a non-elevated parent fails here; surface a clear message instead.
  const r = spawnSync(exe, args, {
    windowsHide: true,
    timeout: opts.timeout || 10 * 60 * 1000,
    stdio: 'ignore',
  });
  if (r.error) {
    if (r.error.code === 'EACCES' || r.error.code === 'EPERM' || r.error.errno === -4092) {
      throw new Error('needs administrator rights — right-click git-updater and "Run as administrator", then Retry');
    }
    throw r.error;
  }
  if (r.status !== 0 && r.status !== 3010) {
    // 3010 = reboot required (success). Give an actionable message; a nonzero exit is
    // most often the app being open (files in use).
    const byCode = {
      1602: 'installer was cancelled',
      1603: 'installer failed — close the app if it is running, then Retry (or it may need admin rights)',
      1618: 'another installer is already running — wait for it to finish, then Retry',
      1619: 'installer package could not be opened',
      1620: 'installer package is invalid',
    };
    throw new Error(byCode[r.status] || `installer failed (exit ${r.status}) — if the app is open, close it and Retry`);
  }
  return { command, status: r.status };
}

module.exports = {
  installPortable,
  installInstaller,
  detectInstallerKind,
  pruneStale,
  // exported for tests
  swapInPlace,
  stripDirs,
};
