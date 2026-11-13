'use strict';

// Background mode: start at login, and keep running in the tray when the window is closed.
// Both are opt-in (Settings -> Background) and off by default, so an existing install behaves
// exactly as it always did: closing the window quits.
//
// This file has no Electron import. The decisions are pure functions, and the stateful parts take
// the Electron pieces (app, Tray, Menu, nativeImage) as arguments, so tests can drive them with
// fakes. Nothing here spawns a shell, writes a scheduled task, opens a socket or starts a second
// process: "start at login" is Electron's own login-item setting (a registry Run value on
// Windows, a login item on macOS) or, on Linux, an XDG autostart file.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Passed to the app the login item starts, so it can tell a login start from a manual one.
const AUTO_START_ARG = '--auto-start';

// --- decisions ----------------------------------------------------------------

// Was this process started by the login item? macOS reports it itself; elsewhere it is the flag.
function isLoginLaunch(argv, opts = {}) {
  return (Array.isArray(argv) && argv.includes(AUTO_START_ARG)) || !!opts.macWasOpenedAtLogin;
}

// What the window does when the app starts:
//   'show'      a normal start (the user opened it)
//   'minimized' a login start: the window opens minimized to the taskbar, so it is visible
//   'hidden'    a login start with "keep running" on: no window, just the tray icon
// Linux never starts hidden: a tray icon there needs a desktop extension on some desktops, and a
// process nobody can see is exactly what this must not create.
function startupWindow(cfg, loginLaunch, platform = process.platform) {
  if (!loginLaunch) return 'show';
  if (cfg && cfg.keepRunning && platform !== 'linux') return 'hidden';
  return 'minimized';
}

// Closing the window hides it (instead of quitting) only when "keep running" is on, and never
// while the app is really quitting (Quit in the tray menu, Cmd+Q, system shutdown).
function shouldHideOnClose(cfg, quitting) {
  return !!(cfg && cfg.keepRunning) && !quitting;
}

// The window-all-closed event: with "keep running" on the app stays alive for its tray icon.
function keepAliveWithoutWindows(cfg, quitting) {
  return !!(cfg && cfg.keepRunning) && !quitting;
}

// The one flag worth carrying across the launcher's hand-off to the newest app-<version> folder.
function forwardArgs(argv) {
  return Array.isArray(argv) && argv.includes(AUTO_START_ARG) ? [AUTO_START_ARG] : [];
}

// The path the login item must point at: the stable launcher, never a versioned app-x.y.z folder
// (a self-update swaps versions, and that path would go stale). An AppImage is its own launcher.
function launcherPath(root, platform = process.platform, env = process.env) {
  if (platform === 'linux' && env.APPIMAGE) return env.APPIMAGE;
  return path.join(root, platform === 'win32' ? 'git-updater.exe' : 'git-updater');
}

function trayMenuTemplate(h) {
  // The first line is the running version (greyed out: it is a label, not a command).
  const head = h.version ? [{ label: `git-updater v${h.version}`, enabled: false }, { type: 'separator' }] : [];
  return [
    ...head,
    { label: 'Open git-updater', click: h.open },
    { label: 'Check now', click: h.checkNow },
    { type: 'separator' },
    { label: 'Quit', click: h.quit },
  ];
}

// --- start at login -----------------------------------------------------------

// What Electron's login-item API is given. macOS registers the app bundle itself; Windows needs
// the launcher path and the flag.
function loginItemSettings(enabled, launcher, platform = process.platform) {
  if (platform === 'darwin') return { openAtLogin: !!enabled };
  return { openAtLogin: !!enabled, path: launcher, args: [AUTO_START_ARG] };
}

function linuxAutostartPath(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'git-updater.desktop');
}

// The Exec value of a .desktop file quotes the path. Characters whose escaping depends on which
// layer of the spec reads them are refused rather than guessed at: a wrong guess starts nothing
// at login, silently.
function desktopExecQuote(p) {
  const s = String(p);
  if (/["`$\\\r\n]/.test(s)) throw new Error('the install path has characters an autostart entry cannot hold safely');
  return `"${s.replace(/%/g, '%%')}"`;
}

function linuxAutostartEntry(launcher) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=git-updater',
    'Comment=Keeps your apps current from their GitHub releases',
    `Exec=${desktopExecQuote(launcher)} ${AUTO_START_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

// Is the login start already set the way we want it? Used at launch so the system is only
// written to when it differs (a Run value that never changes should not be rewritten every start).
function isStartAtLoginApplied(app, enabled, launcher, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'linux') {
    const file = linuxAutostartPath(opts.env, opts.home);
    const fsx = opts.fs || fs;
    if (!enabled) return !fsx.existsSync(file);
    try { return fsx.readFileSync(file, 'utf8') === linuxAutostartEntry(launcher); } catch { return false; }
  }
  const settings = loginItemSettings(enabled, launcher, platform);
  const got = app.getLoginItemSettings(settings);
  return !!got.openAtLogin === !!enabled;
}

// Turn "start at login" on or off. Throws (so the Settings checkbox can go back and say why) when
// it cannot be done or the system did not take it.
function setStartAtLogin(app, enabled, launcher, opts = {}) {
  const platform = opts.platform || process.platform;
  if (!app.isPackaged && enabled) throw new Error('starting at login only works in an installed copy, not a development run');
  if (platform === 'linux') {
    const fsx = opts.fs || fs;
    const file = linuxAutostartPath(opts.env, opts.home);
    if (!enabled) { fsx.rmSync(file, { force: true }); return; }
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(file, linuxAutostartEntry(launcher));
    return;
  }
  if (platform !== 'win32' && platform !== 'darwin') throw new Error(`starting at login is not supported on ${platform}`);
  app.setLoginItemSettings(loginItemSettings(enabled, launcher, platform));
  if (!isStartAtLoginApplied(app, enabled, launcher, { platform })) {
    throw new Error('the operating system did not apply the start-at-login setting');
  }
}

// --- the tray and the quit flag ------------------------------------------------

// deps: { app, Tray, Menu, nativeImage, iconPath, readConfig, openWindow, checkNow,
//         platform?, log? }
function createBackground(deps) {
  const { app, Tray, Menu, nativeImage, iconPath, readConfig, openWindow, checkNow } = deps;
  const platform = deps.platform || process.platform;
  const log = deps.log || (() => {});
  let tray = null;
  let quitting = false;

  function quit() { quitting = true; app.quit(); }

  function createTray() {
    const size = platform === 'darwin' ? 22 : 32;
    const image = nativeImage.createFromPath(iconPath).resize({ width: size, height: size });
    tray = new Tray(image);
    tray.setToolTip('git-updater');
    const version = typeof app.getVersion === 'function' ? app.getVersion() : '';
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({ version, open: openWindow, checkNow, quit })));
    // Linux indicators ignore click events (the menu does the work there); elsewhere a click opens.
    if (platform !== 'linux') tray.on('click', openWindow);
    log('tray: icon shown');
  }

  // Make the icon match the setting: shown when "keep running" is on, gone when it is off.
  function syncTray() {
    const want = !!(readConfig() || {}).keepRunning;
    if (want && !tray) createTray();
    else if (!want && tray) {
      tray.destroy();
      tray = null;
      log('tray: icon removed');
    }
  }

  function setTooltip(text) { if (tray) tray.setToolTip(text || 'git-updater'); }

  return {
    syncTray,
    quit,
    setTooltip,
    markQuitting() { quitting = true; },
    isQuitting: () => quitting,
    hasTray: () => !!tray,
  };
}

module.exports = {
  AUTO_START_ARG,
  isLoginLaunch,
  startupWindow,
  shouldHideOnClose,
  keepAliveWithoutWindows,
  forwardArgs,
  launcherPath,
  trayMenuTemplate,
  loginItemSettings,
  linuxAutostartPath,
  desktopExecQuote,
  linuxAutostartEntry,
  isStartAtLoginApplied,
  setStartAtLogin,
  createBackground,
};
