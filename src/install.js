'use strict';

// IO edge: apply an update — portable swap (with rollback) or silent installer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { installerCmd } = require('./core');

const isWin = process.platform === 'win32';

// --- elevation helpers (Windows) -------------------------------------------

function isElevated() {
  if (!isWin) return true; // *nix: assume the user targets writable locations
  try {
    return spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function dirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.rw-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return false;
    return true; // other errors: let the real operation surface them
  }
}

// installers generally need admin; portable only if its target dir isn't writable.
function needsElevation(repo, elevated) {
  if (!isWin || elevated) return false;
  if (repo.type === 'installer') return true;
  return !dirWritable(repo.install.dir);
}

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

// Swap new files into dir: back up each existing target to .bak, move new in,
// delete .bak on success / restore on failure. A locked file (app running) aborts + rolls back.
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
        const bak = to + '.bak';
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
    for (const { to, bak } of backups) {
      try {
        fs.renameSync(bak, to);
      } catch {}
    }
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
      const err = new Error(`file in use (${e.path || 'target'}); close the app and re-run`);
      err.locked = true;
      throw err;
    }
    throw e;
  }
  for (const { bak } of backups) {
    try {
      fs.rmSync(bak, { force: true });
    } catch {}
  }
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
  try {
    sevenZip.callMain(['x', archName, '-y']); // extract flat into the mounted dir
  } catch (e) {
    // emscripten throws ExitStatus on exit(); non-zero status is a real failure
    if (e && e.status !== undefined && e.status !== 0) throw new Error(`7z extraction failed (code ${e.status})`);
  }
  fs.rmSync(path.join(destDir, archName), { force: true });
}

async function installPortable(archivePath, install) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-extract-'));
  try {
    if (/\.7z$/i.test(archivePath)) await extract7z(archivePath, tmp);
    else new AdmZip(archivePath).extractAllTo(tmp, /* overwrite */ true); // adm-zip >=0.5.10 is zip-slip-safe
    // Auto-flatten version-named wrapper folders (e.g. deskflow-1.26.0-.../) so updates
    // overwrite in place instead of piling up a new folder per release. Explicit strip wins.
    const src = install.strip != null ? stripDirs(tmp, install.strip) : stripDirs(tmp, Infinity);
    fs.mkdirSync(install.dir, { recursive: true });
    swapInPlace(src, install.dir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- installer --------------------------------------------------------------

function installInstaller(filePath, install, opts = {}) {
  const { exe, args } = installerCmd(install.kind, filePath, install.args);
  const command = [exe, ...args].join(' ');
  if (opts.dryRun) return { command, dryRun: true };
  if (!isWin) throw new Error('installer type is Windows-only');
  const r = spawnSync(exe, args, {
    windowsHide: true,
    timeout: opts.timeout || 10 * 60 * 1000,
    stdio: 'ignore',
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== 3010) throw new Error(`installer exited ${r.status}`); // 3010 = reboot required
  return { command, status: r.status };
}

module.exports = {
  isElevated,
  needsElevation,
  installPortable,
  installInstaller,
  // exported for tests
  swapInPlace,
  stripDirs,
};
