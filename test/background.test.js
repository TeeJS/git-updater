'use strict';

// Background mode: start at login and keep running in the tray. The decisions are pure and the
// stateful parts take fakes for Electron, so all of it runs here without a display.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../src/background');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-bg-'));

test('a login start is recognised by the flag, or by macOS saying so', () => {
  assert.equal(bg.isLoginLaunch(['git-updater.exe', '--auto-start']), true);
  assert.equal(bg.isLoginLaunch(['git-updater.exe']), false);
  assert.equal(bg.isLoginLaunch(['x'], { macWasOpenedAtLogin: true }), true);
  assert.equal(bg.isLoginLaunch(undefined), false);
});

test('startup window: a manual start always shows; a login start is minimized, or hidden in the tray', () => {
  assert.equal(bg.startupWindow({ keepRunning: true }, false, 'win32'), 'show');
  assert.equal(bg.startupWindow({}, true, 'win32'), 'minimized', 'login, no tray: visible in the taskbar');
  assert.equal(bg.startupWindow({ keepRunning: true }, true, 'win32'), 'hidden');
  assert.equal(bg.startupWindow({ keepRunning: true }, true, 'darwin'), 'hidden');
  assert.equal(bg.startupWindow({ keepRunning: true }, true, 'linux'), 'minimized', 'never invisible on Linux, where the tray may not show');
});

test('closing hides to the tray only when keep running is on, and never while quitting', () => {
  assert.equal(bg.shouldHideOnClose({}, false), false, 'off by default: closing quits, as always');
  assert.equal(bg.shouldHideOnClose({ keepRunning: true }, false), true);
  assert.equal(bg.shouldHideOnClose({ keepRunning: true }, true), false, 'Quit really quits');
  assert.equal(bg.keepAliveWithoutWindows({ keepRunning: true }, false), true);
  assert.equal(bg.keepAliveWithoutWindows({ keepRunning: true }, true), false);
  assert.equal(bg.keepAliveWithoutWindows({}, false), false);
});

test('the login flag survives the launcher hand-off, and nothing else is forwarded', () => {
  assert.deepEqual(bg.forwardArgs(['x', '--auto-start', '--wait-pid', '12']), ['--auto-start']);
  assert.deepEqual(bg.forwardArgs(['x', '--wait-pid', '12']), []);
});

test('the login item points at the stable launcher, never a versioned folder', () => {
  assert.equal(bg.launcherPath('C:\\Apps\\git-updater', 'win32'), path.join('C:\\Apps\\git-updater', 'git-updater.exe'));
  assert.equal(bg.launcherPath('/opt/gu', 'linux', {}), path.join('/opt/gu', 'git-updater'));
  assert.equal(bg.launcherPath('/opt/gu', 'linux', { APPIMAGE: '/home/u/gu.AppImage' }), '/home/u/gu.AppImage');
});

test('the tray menu has Open, Check now and Quit', () => {
  const calls = [];
  const menu = bg.trayMenuTemplate({ open: () => calls.push('open'), checkNow: () => calls.push('check'), quit: () => calls.push('quit') });
  assert.deepEqual(menu.filter((m) => m.label).map((m) => m.label), ['Open git-updater', 'Check now', 'Quit']);
  menu.filter((m) => m.click).forEach((m) => m.click());
  assert.deepEqual(calls, ['open', 'check', 'quit']);
});

test('the tray menu starts with the running version, greyed out', () => {
  const menu = bg.trayMenuTemplate({ version: '0.2.7-beta.4', open() {}, checkNow() {}, quit() {} });
  assert.equal(menu[0].label, 'git-updater v0.2.7-beta.4');
  assert.equal(menu[0].enabled, false, 'a label, not a command');
  assert.equal(menu[0].click, undefined);
  assert.equal(menu[1].type, 'separator');
  assert.deepEqual(menu.filter((m) => m.label).map((m) => m.label).slice(1), ['Open git-updater', 'Check now', 'Quit']);
});

// --- start at login -----------------------------------------------------------

function fakeApp({ packaged = true, applies = true } = {}) {
  const state = { openAtLogin: false, last: null };
  return {
    isPackaged: packaged,
    state,
    setLoginItemSettings(s) { state.last = s; if (applies) state.openAtLogin = !!s.openAtLogin; },
    getLoginItemSettings() { return { openAtLogin: state.openAtLogin }; },
  };
}

test('Windows: the login item is the launcher with the login flag; off removes it', () => {
  const app = fakeApp();
  const launcher = 'C:\\Apps\\git-updater\\git-updater.exe';
  bg.setStartAtLogin(app, true, launcher, { platform: 'win32' });
  assert.deepEqual(app.state.last, { openAtLogin: true, path: launcher, args: ['--auto-start'] });
  assert.equal(bg.isStartAtLoginApplied(app, true, launcher, { platform: 'win32' }), true);
  bg.setStartAtLogin(app, false, launcher, { platform: 'win32' });
  assert.equal(app.state.openAtLogin, false);
});

test('macOS: the app registers itself', () => {
  const app = fakeApp();
  bg.setStartAtLogin(app, true, '/Applications/git-updater.app', { platform: 'darwin' });
  assert.deepEqual(app.state.last, { openAtLogin: true });
});

test('a development run cannot register a login item; neither can a system that ignores it', () => {
  assert.throws(() => bg.setStartAtLogin(fakeApp({ packaged: false }), true, '/x', { platform: 'win32' }), /installed copy/);
  assert.doesNotThrow(() => bg.setStartAtLogin(fakeApp({ packaged: false }), false, '/x', { platform: 'win32' }), 'turning it off is always allowed');
  assert.throws(() => bg.setStartAtLogin(fakeApp({ applies: false }), true, '/x', { platform: 'win32' }), /did not apply/);
  assert.throws(() => bg.setStartAtLogin(fakeApp(), true, '/x', { platform: 'freebsd' }), /not supported/);
});

test('Linux: writes and removes an XDG autostart entry that runs the launcher with the flag', () => {
  const home = tmp();
  try {
    const env = { XDG_CONFIG_HOME: home };
    const launcher = '/home/user/My 100% Apps/git-updater';
    const app = fakeApp();
    bg.setStartAtLogin(app, true, launcher, { platform: 'linux', env });
    const file = bg.linuxAutostartPath(env);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^\[Desktop Entry\]/);
    assert.match(text, /Exec="\/home\/user\/My 100%% Apps\/git-updater" --auto-start/, 'quoted, with % doubled');
    assert.match(text, /Terminal=false/);
    assert.equal(bg.isStartAtLoginApplied(app, true, launcher, { platform: 'linux', env }), true);
    assert.equal(bg.isStartAtLoginApplied(app, true, '/other/path', { platform: 'linux', env }), false, 'a stale path is not "applied"');
    bg.setStartAtLogin(app, false, launcher, { platform: 'linux', env });
    assert.equal(fs.existsSync(file), false);
    assert.equal(bg.isStartAtLoginApplied(app, false, launcher, { platform: 'linux', env }), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Linux: a path with characters that cannot be quoted safely is refused, not guessed at', () => {
  assert.throws(() => bg.desktopExecQuote('/home/u/a"b/git-updater'), /cannot hold/);
  assert.throws(() => bg.desktopExecQuote('/home/u/a$b/git-updater'), /cannot hold/);
  assert.equal(bg.desktopExecQuote('/home/u/plain path/git-updater'), '"/home/u/plain path/git-updater"');
});

// --- the tray -----------------------------------------------------------------

function fakeElectron() {
  const made = { trays: [], menus: [] };
  class Tray {
    constructor(image) { this.image = image; this.destroyed = false; this.tooltip = ''; this.handlers = {}; made.trays.push(this); }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(m) { this.menu = m; }
    on(ev, fn) { this.handlers[ev] = fn; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (t) => { made.menus.push(t); return { template: t }; } };
  const nativeImage = { createFromPath: (p) => ({ p, resize: (o) => ({ p, size: o.width }) }) };
  return { made, Tray, Menu, nativeImage };
}

function controller(cfgRef, platform = 'win32') {
  const fx = fakeElectron();
  const events = [];
  const app = { quit: () => events.push('app.quit'), getVersion: () => '1.2.3' };
  const c = bg.createBackground({
    app, Tray: fx.Tray, Menu: fx.Menu, nativeImage: fx.nativeImage, iconPath: '/icon.png', platform,
    readConfig: () => cfgRef.cfg, openWindow: () => events.push('open'), checkNow: () => events.push('check'),
  });
  return { c, fx, events };
}

test('tray: shown when keep running is on, removed when it is turned off, never duplicated', () => {
  const cfg = { cfg: { keepRunning: false } };
  const { c, fx } = controller(cfg);
  c.syncTray();
  assert.equal(c.hasTray(), false, 'off by default: no icon');
  cfg.cfg.keepRunning = true;
  c.syncTray(); c.syncTray();
  assert.equal(fx.made.trays.length, 1, 'one icon however many times it is synced');
  assert.equal(fx.made.trays[0].tooltip, 'git-updater');
  assert.equal(fx.made.trays[0].image.size, 32);
  cfg.cfg.keepRunning = false;
  c.syncTray();
  assert.equal(fx.made.trays[0].destroyed, true);
  assert.equal(c.hasTray(), false);
});

test('tray: a click opens the window except on Linux, and the menu items do their jobs', () => {
  const cfg = { cfg: { keepRunning: true } };
  const win = controller(cfg, 'win32');
  win.c.syncTray();
  assert.equal(typeof win.fx.made.trays[0].handlers.click, 'function');
  win.fx.made.trays[0].handlers.click();
  assert.deepEqual(win.events, ['open']);
  const items = win.fx.made.menus[0];
  items.find((m) => m.label === 'Check now').click();
  items.find((m) => m.label === 'Quit').click();
  assert.deepEqual(win.events, ['open', 'check', 'app.quit']);
  assert.equal(win.c.isQuitting(), true, 'Quit marks the app as really quitting, so closing the window is not intercepted');

  const linux = controller(cfg, 'linux');
  linux.c.syncTray();
  assert.equal(linux.fx.made.trays[0].handlers.click, undefined);
  const mac = controller(cfg, 'darwin');
  mac.c.syncTray();
  assert.equal(mac.fx.made.trays[0].image.size, 22);
  assert.equal(win.fx.made.menus[0][0].label, 'git-updater v1.2.3', 'the real tray shows the app version first');
});

test('the tooltip can list what a background check found, and resets', () => {
  const cfg = { cfg: { keepRunning: true } };
  const { c, fx } = controller(cfg);
  c.syncTray();
  c.setTooltip('git-updater: 3 updates available');
  assert.equal(fx.made.trays[0].tooltip, 'git-updater: 3 updates available');
  c.setTooltip('');
  assert.equal(fx.made.trays[0].tooltip, 'git-updater');
});
