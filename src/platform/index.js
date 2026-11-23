'use strict';

// Platform strategy layer. Everything OS-specific lives behind this one interface:
//
//   installedApps()      -> [{ name, version, flavor }]   (async, slow, cached by caller)
//   runningProcesses()   -> [{ name, pid }]               (async)
//   killProcess(pid, force)                               (sync, best effort)
//
// `flavor` is how the app is currently installed — Windows 'msi' | 'exe', Linux
// 'deb' | 'rpm' | 'flatpak' | 'snap', macOS 'app'. The asset picker uses it to pick
// the SAME format on update, so a second copy never lands beside the first.
//
// Asset tables live in ./assets — that module is pure and IO-free so core.js can
// require it without dragging child_process into the "no IO" half of the engine.

const fs = require('fs');
const { assetTable } = require('./assets');

const IMPLS = {
  win32: () => require('./win'),
  darwin: () => require('./mac'),
  linux: () => require('./linux'),
};

// An unsupported platform gets a no-op implementation rather than a crash: portable
// installs still work, and only the "what's already installed" and "is it running"
// features go quiet — the same graceful degradation the Windows-only build had.
const NOOP = {
  installedApps: async () => [],
  runningProcesses: async () => [],
  killProcess: () => {},
};

// Optional per-platform archive handling. Only macOS defines it (ditto / hdiutil, so
// .app bundles keep their symlinks, modes and code signature); everywhere else the
// generic zip/7z/tar path in install.js does the work.
async function extract(archivePath, destDir) {
  const p = impl();
  return p.extract ? p.extract(archivePath, destDir) : false;
}

// Copy a whole folder, for moving an app to another drive (src/relocate.js), where a
// rename cannot do it. macOS uses ditto, the same tool that unpacks its archives, because an
// application bundle only stays launchable if its links, modes, extended attributes and
// signature all arrive intact. Everywhere else Node's own copy keeps what matters there:
// links as links, modes and times. Never over an existing folder.
async function copyTree(src, dest) {
  const p = impl();
  if (p.copyTree) return p.copyTree(src, dest);
  await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
}

// Optional integrity check on an extracted or installed payload. Only macOS defines it,
// where an application bundle is cryptographically sealed and a single stray file inside
// it makes the app refuse to launch. null means "nothing here to check".
async function verifyPayload(dir) {
  const p = impl();
  return p.verifyPayload ? p.verifyPayload(dir) : null;
}

// Optional per-platform launch resolution. Windows carries a program path in the
// uninstall registry, so its rows arrive launchable; the Linux inventories list packages
// rather than programs and have to go looking. null means "nothing to add".
async function launchTargetFor(name, flavor) {
  const p = impl();
  return p.launchTargetFor ? p.launchTargetFor(name, flavor) : null;
}

// Optional: the programs the operating system has on record apart from its installed-apps
// inventory, as full paths. Only Windows has such a list (the "App Paths" registry); it names
// the program of an app whose inventory row does not. [] means "nothing to add".
async function registeredPrograms() {
  const p = impl();
  return p.registeredPrograms ? p.registeredPrograms() : [];
}

// Optional per-platform launch. Windows and macOS hand the path to the OS shell, which
// does the right thing with an .exe or an .app. Linux has no such single gesture: a
// .desktop entry is a launch descriptor that xdg-open will happily open in a text editor,
// so that platform needs a launcher of its own. false means "not handled — use the shell".
async function launchApp(target) {
  const p = impl();
  return p.launchApp ? p.launchApp(target) : false;
}

function impl(platform) {
  const key = platform || process.platform;
  const make = IMPLS[key];
  return make ? make() : NOOP;
}

const current = impl();

module.exports = {
  impl,
  assetTable,
  extract,
  copyTree,
  verifyPayload,
  launchTargetFor,
  registeredPrograms,
  launchApp,
  installedApps: (...a) => current.installedApps(...a),
  runningProcesses: (...a) => current.runningProcesses(...a),
  killProcess: (...a) => current.killProcess(...a),
};
