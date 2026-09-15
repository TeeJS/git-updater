'use strict';

// macOS self-update via Squirrel.Mac, driven by electron-updater.
//
// This is the macOS counterpart to src/selfupdate.js, which is NOT used on macOS. The
// Windows/Linux model puts a launcher beside versioned `app-<version>/` folders and never
// swaps the running unit; a macOS `.app` is one sealed bundle with nowhere to put an
// external launcher, so that model does not apply here (see src/selfupdate.js:14-32).
//
// Instead we let Squirrel.Mac do what every other Electron app does on macOS: download the
// signed+notarized `.zip`, verify it against the `latest-mac.yml` manifest, swap the bundle
// via its own helper after the app quits, and relaunch. electron-updater wraps Squirrel.Mac
// and reads that manifest straight off our GitHub releases (the `github` provider, baked into
// the app's app-update.yml at build time from build.mac.publish in package.json).
//
// Loaded only on macOS — electron/main.js does `require('./macupdate')` behind an IS_MAC
// guard, so electron-updater never loads on Windows or Linux.

const selfupdate = require('../src/selfupdate');
const { log } = require('../src/log');

// electron-updater expects an electron-log-style logger (info/warn/error). Route it to our
// own append-only file log so a failed update leaves a trail in the same place as everything
// else. debug is a no-op — the info/warn/error stream is enough and keeps the log readable.
const logger = {
  info: (m) => log(`self-update(mac): ${String(m)}`),
  warn: (m) => log(`self-update(mac) WARN: ${String(m)}`),
  error: (m) => log(`self-update(mac) ERROR: ${String(m)}`),
  debug: () => {},
};

// Load + configure electron-updater's autoUpdater on first use, memoized. Requiring
// electron-updater pulls in a large module tree and constructs the native MacUpdater, so
// deferring it keeps that cost off app startup — the updater is only touched when the user
// clicks Check all.
let _autoUpdater = null;
function updater() {
  if (_autoUpdater) return _autoUpdater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false; // the banner's Update button drives the download
  autoUpdater.autoInstallOnAppQuit = false; // and we install explicitly, never by surprise
  autoUpdater.logger = logger;
  _autoUpdater = autoUpdater;
  return _autoUpdater;
}

// electron-updater 6 reports whether a newer release exists on the check result.
function isNewer(result) {
  return !!(result && result.isUpdateAvailable);
}

// Report a newer release, or null. Mirrors selfupdate.checkForUpdate's shape so the
// selfupdate:check handler can return the same { version } to the renderer.
async function check() {
  const autoUpdater = updater();
  const result = await autoUpdater.checkForUpdates();
  if (!isNewer(result)) return null;
  const version = result.updateInfo && result.updateInfo.version;
  return version ? { version } : null;
}

// Download the newer release and, once it is staged, hand off to Squirrel.Mac to swap the
// bundle and relaunch. Self-sufficient: it runs its own checkForUpdates first, so it does not
// depend on a prior check() call having primed autoUpdater.
//
// Resolves { relaunching:true, version } the moment the download is staged — before the swap —
// so the renderer can show "Restarting into X…", exactly like the Windows/Linux handler
// returns { relaunching } before its process exits. quitAndInstall then fires on a short timer.
function apply({ onProgress } = {}) {
  const autoUpdater = updater();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      autoUpdater.removeListener('download-progress', onProg);
      autoUpdater.removeListener('update-downloaded', onDone);
      autoUpdater.removeListener('error', onErr);
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onProg = (p) => {
      if (onProgress) onProgress('downloading', Math.round((p && p.percent) || 0));
    };
    const onDone = (info) => {
      const version = info && info.version;
      // Reuse the platform-neutral apply marker so the post-relaunch version check in
      // ui/index.html (selfUpdateLastApply) works on macOS too.
      try {
        selfupdate.writeApplyMarker({ expectVersion: version });
      } catch {}
      log(`self-update(mac): downloaded ${version}, restarting`);
      finish(resolve, { relaunching: true, version });
      // Let the IPC reply flush before Squirrel.Mac quits the app to swap the bundle.
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall();
        } catch (e) {
          log(`self-update(mac) ERROR quitAndInstall: ${e && e.stack ? e.stack : e}`);
        }
      }, 300);
    };
    const onErr = (err) => finish(reject, err instanceof Error ? err : new Error(String(err)));

    autoUpdater.on('download-progress', onProg);
    autoUpdater.once('update-downloaded', onDone);
    autoUpdater.on('error', onErr);

    autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (!isNewer(result)) {
          finish(reject, new Error('no newer release found'));
          return;
        }
        return autoUpdater.downloadUpdate();
      })
      .catch(onErr);
  });
}

module.exports = { check, apply };
