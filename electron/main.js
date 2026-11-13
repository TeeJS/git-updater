'use strict';

// Electron main process — the standalone GUI. Replaces the localhost web server:
// the renderer talks to the engine over IPC (no socket), the engine runs in-process
// (no shell, no self-elevation). Quiet by default: nothing runs at startup and closing the
// window exits everything. Two opt-in settings change that (src/background.js): start at login,
// and keep running in the tray when the window is closed.

const { app, BrowserWindow, ipcMain, dialog, shell, screen, net, safeStorage, Tray, Menu, nativeImage, Notification, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const github = require('../src/github');
const runner = require('../src/runner');
const state = require('../src/state');
const detect = require('../src/detect');
const platform = require('../src/platform');
const paths = require('../src/paths');
const catalog = require('../src/catalog');
const selfupdate = require('../src/selfupdate');
const background = require('../src/background');
const cron = require('../src/cron');
const schedule = require('../src/schedule');
const autoupdate = require('../src/autoupdate');
const { log, LOG_FILE } = require('../src/log');

// macOS self-updates in place via Squirrel.Mac (electron/macupdate.js), not the launcher model
// in src/selfupdate.js. Required only on macOS, so electron-updater never loads on Win/Linux.
const IS_MAC = process.platform === 'darwin';
const macupdate = IS_MAC ? require('./macupdate') : null;

// Force HTTP/1.1 for all of Chromium's networking. TLS-inspecting corporate middleboxes
// (FortiEDR/FortiGate SSL inspection and the like) frequently mangle HTTP/2 streams, which
// surfaces as net::ERR_HTTP2_PROTOCOL_ERROR mid-download and kills self-update on managed
// machines even when nothing is actually being blocked. We keep using Electron net.fetch —
// it trusts the OS certificate store and proxy, which Node's https would not behind SSL
// inspection — and only drop the transport to h2-free HTTP/1.1. Must run before app ready.
app.commandLine.appendSwitch('disable-http2');

log(`--- git-updater ${app.getVersion()} started ---`);
process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log(`UNHANDLED: ${e && e.stack ? e.stack : e}`));

// Self-update layout (see src/selfupdate.js): the exe at ROOT is the launcher, updated versions
// live in ROOT\app-<version>\. Whichever copy this is, ROOT is where new versions land.
const ROOT = selfupdate.layout(process.execPath).root;

function dirHasFiles(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
function portableDir(cfg, r) {
  if (r.install && r.install.dir) return r.install.dir;
  return cfg.portableRoot ? `${cfg.portableRoot.replace(/[\\/]+$/, '')}/${r.repo}` : null;
}

// Config lives with state in git-updater's own config dir — never the launch cwd.
const DATA_DIR = paths.configDir();
const CONFIG_PATH = process.env.GITUPDATER_CONFIG || path.join(DATA_DIR, 'config.json');

// One-time import of an older config sitting next to the app or in the cwd.
function migrateConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  for (const legacy of [path.join(__dirname, '..', 'config.json'), path.resolve('config.json')]) {
    try {
      if (fs.existsSync(legacy)) {
        fs.copyFileSync(legacy, CONFIG_PATH);
        return;
      }
    } catch {}
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { portableRoot: '', repos: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Light structural check; the portable-folder requirement is enforced at check/update.
function saveConfigFile(cfg) {
  if (!cfg || !Array.isArray(cfg.repos)) throw new Error('config: "repos" must be an array');
  core.downloadLimitBytes(cfg); // rejects a bad limit here rather than at the next update
  cfg.repos.forEach((r, i) => {
    if (!r.owner || !r.repo) throw new Error(`app ${i + 1}: owner and repo are required`);
    if (r.type !== 'portable' && r.type !== 'installer') throw new Error(`app ${i + 1}: type must be portable or installer`);
  });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  }
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// GitHub access token (Settings). Kept out of config.json on purpose: that file is roamed,
// backed up on every save (*.bak), opened in an editor from Settings and round-tripped
// through the renderer. The token lives in its own file, encrypted with the OS credential
// store (DPAPI / Keychain / libsecret) via safeStorage, and never crosses the IPC bridge.
const TOKEN_PATH = path.join(DATA_DIR, 'github-token.bin');

let tokenInUse = false; // a saved token was actually decrypted and handed to the engine
function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH) || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(TOKEN_PATH)) || null;
  } catch (e) {
    log(`github token: could not read saved token: ${e && e.message ? e.message : e}`);
    return null;
  }
}
function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("this system has no secure credential store to keep the token in — set the GITHUB_TOKEN environment variable instead");
  }
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, safeStorage.encryptString(token), { mode: 0o600 });
}
function clearToken() {
  try { fs.rmSync(TOKEN_PATH, { force: true }); } catch {}
}

let win;
let pendingCheck = false; // "Check now" from the tray arrived before the window finished loading
// opts.minimized: a login start with no tray icon opens minimized to the taskbar, so it is visible.
function createWindow(opts = {}) {
  // Tall enough for the whole UI without scrolling, capped at the screen's work area.
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(920, wa.width), // wide enough for the Type column to show next to Auto-update (it hides below ~890)
    height: Math.min(1000, wa.height),
    minWidth: 720, // the list has an Auto-update column now; below this the app name would have no room
    minHeight: 480,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    show: !opts.minimized,
    icon: path.join(__dirname, 'icon.png'), // dev + packaged Linux; Win/mac use the bundled app icon

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer can't reach Node — only the narrow `window.api`
      nodeIntegration: false,
    },
  });
  if (opts.minimized) win.once('ready-to-show', () => { win.showInactive(); win.minimize(); });
  // With "keep running" on, closing the window hides it to the tray instead of quitting; Quit in the
  // tray menu, Cmd+Q and a system shutdown are really quitting and are never intercepted.
  win.on('close', (e) => {
    if (background.shouldHideOnClose(readConfig(), bg.isQuitting())) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('session-end', () => bg.markQuitting());
  win.webContents.once('did-finish-load', () => {
    if (pendingCheck) { pendingCheck = false; win.webContents.send('tray:check'); }
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

// Bring the window back (creating it if there is none), from the tray or a second launch.
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The tray's "Check now": show the window and run the same check as "Check all".
function requestCheck() {
  if (!win || win.isDestroyed()) { pendingCheck = true; createWindow(); return; }
  showWindow();
  if (win.webContents.isLoading()) pendingCheck = true;
  else win.webContents.send('tray:check');
}

const bg = background.createBackground({
  app, Tray, Menu, nativeImage, readConfig, log,
  iconPath: path.join(__dirname, 'icon.png'),
  openWindow: showWindow,
  checkNow: requestCheck,
});

// --- scheduled check (Settings -> Schedule) --------------------------------------
// A timer inside this one running process: no scheduled task, no helper. It only CHECKS and tells
// you; it never downloads or installs anything. The schedule engine is src/schedule.js.
let lastBackground = null; // what the last scheduled check found, for the window to show when it opens

function notify(body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'git-updater', body });
    n.on('click', showWindow);
    n.show();
  } catch (e) {
    log(`notification failed: ${e && e.message ? e.message : e}`);
  }
}

async function backgroundCheck() {
  const config = core.validateConfig(readConfig());
  const out = await runner.run(config, { mode: 'check' });
  applyRetypes(out.results);
  const results = (out.results || []).map((r) => ({ id: r.id, status: r.status, from: r.from, to: r.to, reason: r.reason }));
  // In a check, "current" is up to date, "failed" is an error and anything else is an update.
  const updates = results.filter((r) => r.status !== 'failed' && r.status !== 'current').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  lastBackground = { at: new Date().toISOString(), results };
  log(`scheduled check: ${results.length} apps, ${updates} with updates, ${failed} failed`);
  bg.setTooltip(updates ? `git-updater: ${updates} update${updates > 1 ? 's' : ''} available` : '');
  if (updates) notify(`${updates} update${updates > 1 ? 's' : ''} available. Click to open git-updater.`);
  else if (results.length && failed === results.length) notify(`The scheduled check could not finish: ${results[0].reason || 'see the log'}`);
  if (win && !win.isDestroyed()) win.webContents.send('schedule:done');
}

// "Auto-update git-updater" (Settings -> Updating) is the same as ticking an app in the list: the
// scheduled install updates git-updater itself too. If the window is not on screen (hidden in the
// tray, or minimized) the app comes back the same way, quietly, and says so in a notification.
async function backgroundSelfUpdate() {
  if (!app.isPackaged) { log('scheduled install: git-updater itself is not updated in a development run'); return; }
  try {
    const found = await checkSelfUpdate();
    if (!found) { log('scheduled install: git-updater is up to date'); return; }
    const onScreen = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    log(`scheduled install: updating git-updater to ${found.version}${onScreen ? '' : ' (restarting quietly)'}`);
    const send = (phase, pct) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', { id: 'self', phase, pct }); };
    await performSelfUpdate({ onProgress: send, quiet: !onScreen });
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    log(`scheduled install: git-updater could not update itself: ${why}`);
    notify(`git-updater could not update itself: ${why}`);
  }
}

// The scheduled install (Settings -> Schedule -> Install): updates only the apps ticked in the
// Auto-update column that are already installed, portable apps first. Unattended means it never
// opens an installer window or a permission prompt (an installer that needs one is reported as
// "needs you" and left for the window), and a running app follows "Automatically close apps and
// re-open when complete": on, it is closed gracefully and re-opened; off, it is skipped. Nothing is
// ever force-closed. The rules are in src/autoupdate.js; the runner records dates like any update.
async function backgroundInstall() {
  if (updating) return; // an update started from the window is running; the scheduler tries again next tick
  updating = true;
  const entries = [];
  try {
    const cfg = readConfig();
    const config = core.validateConfig(cfg);
    const installed = await computeInstalled(cfg);
    const { targets, skipped } = autoupdate.pickTargets(config.repos, installed);
    for (const s of skipped) log(`scheduled install: skipping ${s.name} (${s.why})`);
    if (!targets.length) log('scheduled install: no ticked apps that are installed');
    else log(`scheduled install: ${targets.map((r) => `${r.owner}/${r.repo}`).join(', ')}`);
    const autoClose = !!cfg.autoCloseReopen;
    let stopped = false; // GitHub said stop: git-updater itself is left for the next run too
    for (const r of targets) {
      const key = autoupdate.keyOf(r);
      const name = `${r.owner}/${r.repo}`;
      let lock = null;
      let result;
      try {
        lock = state.acquireLock();
        const out = await runner.run(config, { only: key, autoClose, unattended: true });
        result = out.results[0];
      } catch (e) {
        result = { status: 'failed', reason: e && e.message ? e.message : String(e) };
      } finally {
        state.releaseLock(lock);
      }
      entries.push({ name, result });
      if (result && result.closed && autoClose) {
        try { await launchApp(key); log(`scheduled install: re-opened ${name}`); } catch (e) { log(`scheduled install: could not re-open ${name}: ${e && e.message ? e.message : e}`); }
      }
      if (result && result.stopRun) { log('scheduled install: stopping (GitHub rate limit or a rejected token)'); stopped = true; break; }
    }
    if (entries.length) {
      const s = autoupdate.summarize(entries);
      log(`scheduled install: updated ${s.updated.length}, already current ${s.current}, need you ${s.needsYou.length + s.running.length}, failed ${s.failed.length}`);
      for (const x of s.needsYou) log(`scheduled install: ${x.name} needs you: ${x.reason}`);
      for (const x of s.failed) log(`scheduled install: ${x.name} failed: ${x.reason}`);
      const text = autoupdate.summaryText(s);
      if (text) notify(text);
    }
    // git-updater itself comes last, because applying its update restarts this process.
    if (cfg.selfAutoUpdate && !stopped) await backgroundSelfUpdate();
  } finally {
    updating = false;
    if (win && !win.isDestroyed()) win.webContents.send('schedule:done', { kind: 'install' });
  }
}

const scheduleState = schedule.fileState(path.join(DATA_DIR, 'schedule-state.json'));
const scheduler = schedule.createScheduler({
  readConfig, log,
  loadState: scheduleState.load,
  saveState: scheduleState.save,
  canRun: (name) => name !== 'install' || !updating,
  jobs: [
    { name: 'check', run: backgroundCheck },
    { name: 'install', run: backgroundInstall },
  ],
});

// The stable launcher (never a versioned app-x.y.z folder) is what the login entry starts.
const loginLauncher = () => background.launcherPath(ROOT, process.platform, process.env);
// At launch: if "start at login" is on, make sure the system's entry still matches (a moved
// install, or an entry removed by hand). Written only when it differs; never touched when off.
function reconcileLogin() {
  try {
    if (!readConfig().startAtLogin) return;
    if (!background.isStartAtLoginApplied(app, true, loginLauncher())) {
      background.setStartAtLogin(app, true, loginLauncher());
      log('start at login: entry refreshed');
    }
  } catch (e) {
    log(`start at login: ${e && e.message ? e.message : e}`);
  }
}

// --- IPC: the only bridge between the renderer and the engine -----------------
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('state:get', () => state.load());

// Locally-installed version + presence per app, BEFORE checking GitHub.
// Installer -> uninstall-registry DisplayVersion; Portable -> our manifest + folder.
async function computeInstalled(cfg) {
  detect.clearCache(); // fresh scan — versions change after installs
  const stt = state.load();
  const out = {};
  for (const r of cfg.repos) {
    const key = `${r.owner}/${r.repo}#${r.type}`;
    const rec = stt[key] || {};
    if (r.type === 'installer') {
      let v = null;
      try {
        v = await detect.installedVersion(r.detect || r.repo);
      } catch {}
      let date = rec.installedAt || null;
      if (!date && v) try { date = await detect.installedDate(r.detect || r.repo); } catch {}
      out[key] = { current: v, present: !!v, date: v ? date : null, lastAction: rec.lastAction || 'installed' };
    } else {
      const dir = portableDir(cfg, r);
      let current = (rec && rec.version) || null;
      let present = dirHasFiles(dir);
      // Neither a managed copy nor a git-updater record: fall back to the OS inventory. The
      // user may have installed the app by hand (e.g. dragged a dmg into /Applications) — it
      // then reads as installed though git-updater does not own the copy. For an SLA-guarded
      // dmg like Deskflow's, which cannot be unpacked unattended, this is the ONLY way it
      // ever shows as present.
      if (!present && !current) {
        let v = null;
        try {
          v = await detect.installedVersion(r.detect || r.repo);
        } catch {}
        if (v) {
          current = v;
          present = true;
        }
      }
      let date = rec.installedAt || null;
      if (!date && present) try { date = await detect.installedDate(r.detect || r.repo); } catch {}
      out[key] = { current, present, date: present ? date : null, lastAction: rec.lastAction || 'installed' };
    }
  }
  return out;
}
ipcMain.handle('installed:get', () => computeInstalled(readConfig()));
// The renderer calls this only after an interactive installer changes the OS version.
ipcMain.handle('installed:record-completion', async (_e, { appKey, fromVersion, wasInstall }) => {
  const r = readConfig().repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r || r.type !== 'installer') throw new Error('installer app not found');
  detect.clearCache();
  const version = await detect.installedVersion(r.detect || r.repo);
  if (!version || version === fromVersion) throw new Error('installer completion not detected');
  const stt = state.load();
  const installedAt = new Date().toISOString();
  const lastAction = wasInstall ? 'installed' : 'updated';
  // An interactive install supplies status provenance, not a release tag. The registry
  // may use a different version scheme; treating it as a tag can block a later reinstall.
  stt[appKey] = { ...(stt[appKey] || {}), repo: `${r.owner}/${r.repo}`, type: r.type, installedAt, lastAction };
  state.save(stt);
  return { installedAt, lastAction };
});
ipcMain.handle('folder:open', (_e, appKey) => {
  const cfg = readConfig();
  const r = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  const dir = r && portableDir(cfg, r);
  return dir ? shell.openPath(dir) : 'no folder';
});

// Collect this dir's files as manifest-style relative paths, shallowly (depth<=2 is enough
// to find an app's main exe without walking a whole install tree). Used only when an
// installer app has an InstallLocation but no usable DisplayIcon.
function shallowFiles(dir, depth = 2, prefix = '') {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth > 1) out = out.concat(shallowFiles(path.join(dir, e.name), depth - 1, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// "Open App": launch the installed program behind a tracked row.
//  - portable  -> resolve the main file from our own install manifest + the portable dir.
//  - installer -> the registry DisplayIcon exe, else hunt InstallLocation for it.
// Launch prefers shell.openPath (ShellExecute) — no shell spawn, no temp exec — so it
// stays within the same EDR posture as installs and "Open folder". Linux is the
// exception, and has to be: its launch target is a .desktop entry, and openPath sends
// that to the user's association for application/x-desktop, which on KDE is the text
// editor. The platform layer launches it properly there; see linux.launchApp.
async function launchApp(appKey) {
  const cfg = readConfig();
  const r = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r) throw new Error('app not found');
  let target = null;

  const portDir = r.type === 'portable' ? portableDir(cfg, r) : null;
  if (portDir && dirHasFiles(portDir)) {
    // A copy git-updater manages: launch it from our own manifest + the portable dir.
    const dir = portDir;
    const rec = state.load()[appKey];
    const files = (rec && rec.files) || shallowFiles(dir, 3);
    // On Unix the execute bit is what separates a program from a LICENSE file sitting at
    // the top of the same archive. core may not stat, so the check is supplied here.
    const isExec = (rel) => {
      try {
        return !!(fs.statSync(path.join(dir, rel)).mode & 0o111);
      } catch {
        return false;
      }
    };
    const rel = core.pickLaunchFile(files, r.repo, process.platform, isExec);
    if (rel) {
      const abs = path.join(dir, rel);
      if (fs.existsSync(abs)) target = abs;
    }
  } else {
    // An installer entry, OR a portable entry with no managed copy — the app was installed
    // by hand (found in the OS inventory, e.g. Deskflow in /Applications). Either way, launch
    // it from the OS's own record.
    const t = await detect.launchTarget(r.detect || r.repo);
    if (t && t.path && fs.existsSync(t.path)) target = t.path;
    if (!target && t && t.location && fs.existsSync(t.location)) {
      const rel = core.pickLaunchFile(shallowFiles(t.location, 2), r.repo, process.platform);
      if (rel) target = path.join(t.location, rel);
    }
  }

  if (!target) throw new Error(`couldn't find ${r.repo}'s program to open — try Open folder`);
  log(`launchApp ${appKey} -> ${target}`);
  if (await platform.launchApp(target)) return { ok: true, path: target };
  const err = await shell.openPath(target); // '' on success, else an OS error string
  if (err) throw new Error(err);
  return { ok: true, path: target };
}
ipcMain.handle('app:launch', (_e, appKey) => launchApp(appKey));
// The Settings screen's "Next runs" preview, and what the last scheduled check found.
ipcMain.handle('schedule:preview', (_e, expr) => {
  const v = cron.validate(String(expr || ''));
  return { ok: v.ok, error: v.error, runs: v.runs.map((d) => d.toISOString()) };
});
ipcMain.handle('schedule:last', () => lastBackground);

ipcMain.handle('config:save', (_e, cfg) => {
  const previous = readConfig();
  // A schedule that is switched on (or edited) must be valid. Only checked when those fields changed,
  // so a hand-edited bad value can never block saving every other setting.
  for (const k of ['Check', 'Install']) {
    const sched = (c) => `${!!(c && c[`schedule${k}Enabled`])}|${(c && c[`schedule${k}Cron`]) || ''}`;
    if (cfg && cfg[`schedule${k}Enabled`] && sched(cfg) !== sched(previous)) {
      const v = cron.validate(cfg[`schedule${k}Cron`]);
      if (!v.ok) throw new Error(`${k} schedule: ${v.error}`);
    }
  }
  const wasStartAtLogin = !!previous.startAtLogin;
  const wantsStartAtLogin = !!(cfg && cfg.startAtLogin);
  // The system's login list is written first, so a refusal (a development run, a system that
  // ignores it) reaches the Settings checkbox before anything is saved.
  if (wantsStartAtLogin !== wasStartAtLogin) {
    background.setStartAtLogin(app, wantsStartAtLogin, loginLauncher());
    log(`start at login: ${wantsStartAtLogin ? 'on' : 'off'}`);
  }
  try {
    saveConfigFile(cfg);
  } catch (e) {
    if (wantsStartAtLogin !== wasStartAtLogin) { try { background.setStartAtLogin(app, wasStartAtLogin, loginLauncher()); } catch {} }
    throw e;
  }
  bg.syncTray(); // the tray icon follows "keep running" at once, no restart
  return { ok: true };
});
ipcMain.handle('config:open', () => shell.openPath(CONFIG_PATH));
ipcMain.handle('log:open', () => shell.openPath(LOG_FILE));

// --- "Scan this PC" window: find installed catalog apps and add selected ---
let scanWin = null;
ipcMain.handle('scan:open', (_e, mode) => {
  if (scanWin && !scanWin.isDestroyed()) return scanWin.focus();
  scanWin = new BrowserWindow({
    width: 680,
    height: 680,
    parent: win,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Linux has no installed-apps mode, so the window always opens on the catalog there
  // rather than on a tab that would answer nothing.
  const wanted = SCAN_PLATFORMS.has(process.platform) ? mode : 'all';
  scanWin.loadFile(path.join(__dirname, '..', 'ui', 'scan.html'), wanted === 'all' ? { query: { mode: 'all' } } : undefined);
});
// "Scan this PC" reads what is ALREADY INSTALLED and offers matches. That is the wrong
// question on Linux, where a package manager already owns most of what it would find:
// accepting a suggestion installs a SECOND copy outside dpkg, and the user ends up with
// two, launching whichever the desktop happens to resolve.
//
// Browsing the catalog is unaffected and stays — it never inspects the system, so none of
// that applies. Windows and macOS keep the scan: there is no system package manager
// updating those apps behind our back, which is the entire reason this program exists.
//
// Refused here as well as hidden in the UI. A disabled button is a suggestion; an empty
// answer from the main process is the guarantee.
const SCAN_PLATFORMS = new Set(['win32', 'darwin']);

ipcMain.handle('app:platform', () => ({ platform: process.platform, canScan: SCAN_PLATFORMS.has(process.platform) }));

ipcMain.handle('scan:run', async () => {
  if (!SCAN_PLATFORMS.has(process.platform)) return [];
  detect.clearCache();
  const tracked = new Set(readConfig().repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
  return catalog.matchInstalled(await detect.allInstalled(), tracked); // filtered to this OS
});
// The whole catalog (for "All known apps" browsing), tracked entries flagged.
ipcMain.handle('catalog:all', () => {
  const tracked = new Set(readConfig().repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
  return catalog.CATALOG
    .map((c) => ({ name: c.name, repo: c.repo, tracked: tracked.has(c.repo.toLowerCase()) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
// Add selected repos: [{repo: "owner/name", type: "portable"|"installer"}].
ipcMain.handle('scan:add', (_e, items) => {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  const cfg = readConfig();
  if (!Array.isArray(cfg.repos)) cfg.repos = [];
  if (items.some((i) => i && i.type === 'portable') && !cfg.portableRoot) {
    throw new Error('set the portable apps folder first (main window → Settings), then add portable apps');
  }
  let added = 0;
  for (const it of items) {
    const m = /^([^/]+)\/([^/]+)$/.exec(String(it && it.repo));
    const type = it && it.type === 'portable' ? 'portable' : 'installer';
    if (!m) continue;
    if (cfg.repos.some((r) => r.owner === m[1] && r.repo === m[2] && r.type === type)) continue;
    cfg.repos.push({ owner: m[1], repo: m[2], type });
    added++;
  }
  if (added) saveConfigFile(cfg);
  if (win && !win.isDestroyed()) win.webContents.send('config-changed');
  if (scanWin && !scanWin.isDestroyed()) scanWin.close();
  return { added };
});
// Running check and close for a tracked app.
ipcMain.handle('app:is-running', async (_e, appKey) => {
  const r = readConfig().repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r) throw new Error('app not found');
  return detect.isRunning(r.process || r.repo);
});
ipcMain.handle('app:close', async (_e, { appKey, force }) => {
  const r = readConfig().repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  if (!r) throw new Error('app not found');
  log(`closeApp ${appKey} force=${!!force}`);
  return detect.closeApp(r.process || r.repo, { force: !!force });
});
// Validate a repo has a usable release before it's added (throws -> rejects).
ipcMain.handle('repo:validate', async (_e, { owner, repo, prerelease }) => {
  const rel = await github.getLatestRelease(owner, repo, { prerelease });
  return { ok: true, tag: rel.tag_name };
});
ipcMain.handle('release:open', (_e, { owner, repo }) =>
  shell.openExternal(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`)
);
// Preview which Windows asset auto-pick would choose for the latest release.
ipcMain.handle('asset:preview', async (_e, appKey) => {
  const repo = readConfig().repos.find((r) => `${r.owner}/${r.repo}#${r.type}` === appKey);
  if (!repo) throw new Error('app not found');
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease, tagPrefix: repo.tagPrefix });
  const asset = repo.asset ? core.matchAsset(rel.assets, repo.asset) : core.pickAsset(rel.assets, repo.type);
  return { tag: rel.tag_name, asset: asset.name };
});
// --- Self-update (portable, run-as-is) ----------------------------------------
// Checked only when the user runs "Check all" — no network at startup, same as
// tracked apps. Compares the latest release tag with the running version; on Update,
// downloads+verifies+extracts the new build, then hands off to a detached helper (a
// second copy of this same exe) to swap it in and relaunch once this process exits.
async function checkSelfUpdate() {
  if (!app.isPackaged) return null; // dev run
  try {
    const prerelease = !!readConfig().selfUpdatePrerelease; // self-update beta channel (Settings)
    if (IS_MAC) {
      // macOS applies in place via Squirrel.Mac (electron-updater), reading latest-mac.yml off
      // our GitHub releases — so what the banner reports is exactly what will install.
      const found = await macupdate.check({ prerelease });
      return found ? { version: found.version, canApply: true } : null;
    }
    const found = await selfupdate.checkForUpdate(app.getVersion(), { prerelease });
    return found ? { version: found.version, canApply: selfupdate.canApply() } : null;
  } catch (e) {
    log(`selfupdate check: ${e && e.message ? e.message : e}`); // e.g. no releases yet
    return null;
  }
}
ipcMain.handle('selfupdate:check', () => checkSelfUpdate());
ipcMain.handle('selfupdate:lastApply', () => selfupdate.consumeApplyMarker(app.getVersion()));
// The releases page for git-updater itself. The URL is built HERE, from the engine's own
// constants — the renderer never passes a URL across the bridge, same as release:open.
ipcMain.handle('selfupdate:openRelease', () =>
  shell.openExternal(`https://github.com/${selfupdate.REPO.owner}/${selfupdate.REPO.repo}/releases`)
);
ipcMain.handle('app:version', () => app.getVersion());
// Settings -> GitHub -> "Create token": opens GitHub's new-token page with the form filled in.
ipcMain.handle('token:openCreate', () => shell.openExternal(github.TOKEN_CREATE_URL));

// Token status for Settings: whether one is saved, plus the live quota. Never the token itself.
// `unreadable`: the file exists but could not be decrypted (OS credential key changed), so
// requests are going out without it — Settings must say so rather than claim it is saved.
ipcMain.handle('token:status', async () => {
  const saved = tokenInUse;
  const unreadable = !saved && fs.existsSync(TOKEN_PATH);
  const env = !saved && !!process.env.GITHUB_TOKEN;
  let quota = null;
  try { quota = await github.rateLimit(); } catch (e) { quota = { error: e.message }; }
  return { saved, unreadable, env, quota };
});
// Test the token against GitHub before keeping it, so a typo is caught here rather than as
// a wall of failed checks later.
ipcMain.handle('token:set', async (_e, token) => {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) throw new Error('paste a token first');
  const quota = await github.rateLimit(t);
  saveToken(t);
  github.setToken(t);
  tokenInUse = true;
  log(`github token saved (limit ${quota.limit}/h)`);
  return { ok: true, quota };
});
ipcMain.handle('token:clear', () => {
  clearToken();
  github.setToken(null);
  tokenInUse = false;
  log('github token removed');
  return { ok: true };
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the portable apps folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return { path: r.canceled || !r.filePaths.length ? '' : r.filePaths[0] };
});
// A check can discover that an app is typed as something the project does not publish,
// in either direction (see retypeIfUnavailable in src/runner.js). The runner only
// decides; persisting belongs here, because config.json is the main process's to own.
// Never silent: the renderer reports what changed and why, and it is logged.
function applyRetypes(results) {
  const changes = (results || []).filter((r) => r.retyped && (r.retyped.to === 'portable' || r.retyped.to === 'installer'));
  if (!changes.length) return;
  const cfg = readConfig();
  const hits = { portable: [], installer: [] };
  for (const r of changes) {
    const m = /^([^/]+)\/([^/]+)#(.+)$/.exec(r.id || '');
    if (!m) continue;
    const [, owner, repo, type] = m;
    const to = r.retyped.to;
    // If the user already tracks this repo as the target type, correcting would create a
    // duplicate entry. Leave the miscast one alone and let them untrack it.
    if (cfg.repos.some((x) => x.owner === owner && x.repo === repo && x.type === to)) continue;
    const entry = cfg.repos.find((x) => x.owner === owner && x.repo === repo && x.type === type);
    if (!entry) continue;
    entry.type = to;
    // Portable needs a folder to unpack into. Installer does not, but the folder is kept
    // rather than dropped so switching back by hand does not lose the chosen location.
    if (to === 'portable') entry.install = { ...(entry.install || {}), dir: r.retyped.dir };
    hits[to].push(`${owner}/${repo}`);
  }
  if (!hits.portable.length && !hits.installer.length) return;
  saveConfigFile(cfg);
  if (hits.portable.length) log(`retyped to portable (no installer published): ${hits.portable.join(', ')}`);
  if (hits.installer.length) log(`retyped to installer (no portable build published): ${hits.installer.join(', ')}`);
  if (win && !win.isDestroyed()) win.webContents.send('config-changed');
}

ipcMain.handle('check', async (_e, body = {}) => {
  const config = core.validateConfig(readConfig());
  const out = await runner.run(config, { mode: 'check', only: body.only });
  applyRetypes(out.results);
  return out;
});

let updating = false; // in-process guard; state lock guards other processes
ipcMain.handle('update', async (e, body = {}) => {
  if (updating) throw new Error('an update is already in progress');
  updating = true;
  let lock = null;
  try {
    const config = core.validateConfig(readConfig());
    if (!body.dryRun) lock = state.acquireLock();
    // Stream per-app progress to the renderer as it happens.
    const onProgress = (id, phase, pct) => e.sender.send('update:progress', { id, phase, pct });
    const openFile = (f) => shell.openPath(f); // ShellExecute: an installer's UAC manifest works
    return await runner.run(config, { only: body.only, force: !!body.force, dryRun: !!body.dryRun, autoClose: !!body.autoClose, onProgress, openFile });
  } finally {
    state.releaseLock(lock);
    updating = false;
  }
});

// Downloads+verifies+extracts the new build into ROOT\app-<version>\ (nothing running is
// touched), then restarts through the launcher, which hands off to it once this process is gone.
// Shared by the window's Update button and the scheduled install; the caller owns the `updating` flag.
// `quiet` (a scheduled run with no window on screen) is kept in the apply marker, so the new process
// starts hidden or minimized the way this one is instead of putting a window up.
async function performSelfUpdate({ onProgress, quiet = false }) {
  const cfg = readConfig();
  const prerelease = !!cfg.selfUpdatePrerelease; // self-update beta channel (Settings)
  if (IS_MAC) {
    // Squirrel.Mac downloads+verifies the signed zip, swaps the bundle and relaunches; it
    // owns the restart, so there is no launcher hand-off or app.exit here.
    const r = await macupdate.apply({ onProgress, prerelease, quiet });
    log(`self-update(mac): restarting into ${r.version}`);
    return r;
  }
  const { tag } = await selfupdate.prepareUpdate(ROOT, app.getVersion(), onProgress, { prerelease, maxBytes: core.downloadLimitBytes(cfg) });
  selfupdate.writeApplyMarker({ expectVersion: tag, quiet });
  selfupdate.relaunchViaLauncher(ROOT, process.pid);
  log(`self-update: restarting into ${tag}`);
  setTimeout(() => app.exit(0), 300); // let the IPC reply below flush before this process dies
  return { relaunching: true, version: tag };
}

ipcMain.handle('selfupdate:apply', async (e) => {
  if (updating) throw new Error('an update is already in progress');
  if (!app.isPackaged) throw new Error('self-update is unavailable in a dev run');
  updating = true;
  try {
    return await performSelfUpdate({ onProgress: (phase, pct) => e.sender.send('update:progress', { id: 'self', phase, pct }) });
  } catch (err) {
    log(`self-update FAILED: ${err && err.stack ? err.stack : err}`);
    throw err;
  } finally {
    updating = false; // only reached on a failure before the relaunch was started
  }
});

// --- lifecycle: launcher hand-off, single instance, quiet by default ------------
(async () => {
  // Relaunch after a self-update: the updating process still holds the single-instance lock
  // until it exits, so wait for it before handing off.
  const waitPid = selfupdate.waitPidArg(process.argv);
  if (waitPid) await selfupdate.waitForExit(waitPid);

  // Launcher role: a newer app-<version> sibling exists -> run that instead of ourselves.
  // Also lets a version folder that is itself outdated defer to the newest one.
  const target = app.isPackaged ? selfupdate.handoffTarget(process.execPath, app.getVersion()) : null;
  if (target) {
    log(`launcher: handing off to ${target.dir}`);
    selfupdate.launch(target.dir, background.forwardArgs(process.argv)); // the login flag must survive the hand-off
    app.exit(0);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(background.AUTO_START_ARG)) return; // a login start while already running: nothing to do
    showWindow(); // also brings back a window hidden in the tray
  });
  app.whenReady().then(() => {
    // Route the engine's HTTP through Chromium's network stack (Electron net.fetch): it trusts
    // the OS/Windows certificate store, so a corporate VPN/proxy's SSL-inspection root CA — the
    // one the browser already trusts — is honored here too. Node's own fetch ignores that store
    // and fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY on such networks.
    github.setFetch((url, init) => net.fetch(url, init));
    const savedToken = loadToken(); // safeStorage is only usable once the app is ready
    github.setToken(savedToken);
    tokenInUse = !!savedToken;
    migrateConfig();
    if (app.isPackaged) selfupdate.cleanupLeftovers(ROOT, app.getVersion()).catch(() => {});
    bg.syncTray();
    reconcileLogin();
    // The installed app uses the build's appId, so notifications carry its name; a development run gets its own
    // id (see background.appUserModelId) so it can never rename or re-icon the installed app's taskbar button.
    if (process.platform === 'win32') app.setAppUserModelId(background.appUserModelId(app.isPackaged));
    // The scheduled check: a tick every half minute, one shortly after start (a missed run is caught
    // up then), and one when the computer wakes (timers pause while it sleeps).
    setInterval(() => { scheduler.tick(); }, schedule.TICK_MS).unref();
    setTimeout(() => { scheduler.tick(); }, 15 * 1000).unref();
    powerMonitor.on('resume', () => { scheduler.tick(); });
    // A scheduled self-update with no window on screen restarts quietly: start the way a login start does
    // (hidden in the tray, or minimized) and say what happened, since nobody is looking at the window.
    const quietRestart = app.isPackaged ? selfupdate.takeQuietRestart(app.getVersion()) : null;
    if (quietRestart) {
      log(`quiet restart after a scheduled self-update (expected ${quietRestart.expectVersion}, running ${app.getVersion()})`);
      notify(quietRestart.ok
        ? `git-updater updated to v${app.getVersion()}.`
        : `git-updater tried to update to v${quietRestart.expectVersion} but is still v${app.getVersion()}. See the log.`);
    }
    const loginLaunch = !!quietRestart || background.isLoginLaunch(process.argv, { macWasOpenedAtLogin: IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin });
    const mode = background.startupWindow(readConfig(), loginLaunch, process.platform);
    if (mode === 'hidden') log('started at login: hidden in the tray');
    else createWindow({ minimized: mode === 'minimized' });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow();
  });
  app.on('before-quit', () => bg.markQuitting());
  // Closing the last window quits, on every platform INCLUDING macOS, where the convention is to
  // stay resident in the dock. That convention is declined: this app is quiet by default. The one
  // exception is the opt-in "keep running in the tray", which keeps it alive for its icon.
  app.on('window-all-closed', () => {
    if (!background.keepAliveWithoutWindows(readConfig(), bg.isQuitting())) app.quit();
  });
})();
