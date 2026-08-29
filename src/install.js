'use strict';

// IO edge: apply an update — portable swap (with rollback) or silent installer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { installerCmd } = require('./core');
const { log } = require('./log');

const isWin = process.platform === 'win32';

// --- portable swap ----------------------------------------------------------

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

const OLD_SUFFIX = '.git-updater-old'; // previous version parked here during the swap

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

// Transactional portable install: extract into a staging dir ON THE SAME VOLUME as
// the target, then swap whole directories by rename — the app dir is always either
// the complete old version or the complete new one, never a mix. prevManifest (what
// WE shipped last time, from state) separates stale shipped files (dropped) from
// runtime-created user files (carried over). Returns the new manifest.
async function installPortable(archivePath, install, prevManifest) {
  const dest = path.resolve(install.dir);
  const parent = path.dirname(dest);
  const base = path.basename(dest);
  fs.mkdirSync(parent, { recursive: true });
  const oldDir = dest + OLD_SUFFIX;

  // Crash recovery: a previous run parked the old version and died before finishing.
  if (fs.existsSync(oldDir) && !fs.existsSync(dest)) fs.renameSync(oldDir, dest);
  fs.rmSync(oldDir, { recursive: true, force: true }); // any other leftover is disposable

  // Stage next to the destination so the renames below are same-volume (atomic-ish).
  const stage = fs.mkdtempSync(path.join(parent, `.${base}.git-updater-stage-`));
  try {
    if (/\.7z$/i.test(archivePath)) await extract7z(archivePath, stage);
    else if (/\.zip$/i.test(archivePath)) new AdmZip(archivePath).extractAllTo(stage, /* overwrite */ true); // adm-zip >=0.5.10 is zip-slip-safe
    else fs.copyFileSync(archivePath, path.join(stage, path.basename(archivePath))); // bare portable file (e.g. a single .exe)
    // Auto-flatten version-named wrapper folders (deskflow-1.26.0-.../). Explicit strip wins.
    const src = install.strip != null ? stripDirs(stage, install.strip) : stripDirs(stage, Infinity);
    const files = walk(src);
    if (files.length === 0) throw new Error('archive contained no files');

    // Swap: park the old dir, move the new one in; restore the old on any failure.
    const hadOld = fs.existsSync(dest);
    if (hadOld) {
      try {
        fs.renameSync(dest, oldDir); // EBUSY/EPERM here if the app is running
      } catch (e) {
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
          const err = new Error('app files are in use — close the app and Retry');
          err.locked = true;
          throw err;
        }
        throw e;
      }
    }
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      if (hadOld) fs.renameSync(oldDir, dest); // complete rollback: old version restored whole
      throw e;
    }

    // Carry over runtime files (user settings etc.): in the old dir, not shipped by the
    // new version, and not shipped by the PREVIOUS version either (those are stale and
    // stay dropped). Compared as strings only — a poisoned manifest can't reach outside.
    if (hadOld) {
      const norm = (f) => f.replace(/\\/g, '/');
      const shipped = new Set(files.map(norm));
      const prevShipped = new Set((prevManifest || []).map(norm));
      for (const rel of walk(oldDir)) {
        const n = norm(rel);
        if (shipped.has(n) || prevShipped.has(n)) continue;
        const to = path.join(dest, rel);
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(oldDir, rel), to);
        } catch {}
      }
      fs.rmSync(oldDir, { recursive: true, force: true }); // commit: old version gone
    }
    return files;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
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
  log(`  installer (${install.kind}): ${command}`);
  // Launch the installer directly (no PowerShell). A requireAdministrator installer that
  // can't elevate from a non-elevated parent fails here; surface a clear message instead.
  const r = spawnSync(exe, args, {
    windowsHide: true,
    timeout: opts.timeout || 10 * 60 * 1000,
    stdio: 'ignore',
  });
  if (r.error) {
    if (r.error.code === 'EACCES' || r.error.code === 'EPERM' || r.error.errno === -4092) {
      const err = new Error('needs administrator rights');
      err.elevation = true; // callers fall back to the installer's own window (UAC)
      throw err;
    }
    throw r.error;
  }
  if (r.status !== 0 && r.status !== 3010) {
    // 3010 = reboot required (success). 1603 from a silent machine-install is almost
    // always missing admin rights (silent installs can't show a UAC prompt).
    const byCode = {
      1602: 'installer was cancelled',
      1603: 'silent install needs administrator rights',
      1618: 'another installer is already running — wait for it to finish, then Retry',
      1619: 'installer package could not be opened',
      1620: 'installer package is invalid',
    };
    const err = new Error(byCode[r.status] || `installer failed (exit ${r.status}) — if the app is open, close it and Retry`);
    err.status = r.status;
    throw err;
  }
  return { command, status: r.status };
}

module.exports = {
  installPortable,
  installInstaller,
  detectInstallerKind,
  // exported for tests
  stripDirs,
  walk,
};
