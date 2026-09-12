'use strict';

// Electron main process — the standalone GUI. Replaces the localhost web server:
// the renderer talks to the engine over IPC (no socket), the engine runs in-process
// (no shell, no self-elevation), and closing the window exits everything (on-demand).

const { app, BrowserWindow, ipcMain, dialog, shell, screen, net } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const github = require('../src/github');
const runner = require('../src/runner');
const state = require('../src/state');
const detect = require('../src/detect');
const paths = require('../src/paths');
const catalog = require('../src/catalog');
const selfupdate = require('../src/selfupdate');
const { log, LOG_FILE } = require('../src/log');

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

let win;
function createWindow() {
  // Tall enough for the whole UI without scrolling, capped at the screen's work area.
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 840,
    height: Math.min(1000, wa.height),
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer can't reach Node — only the narrow `window.api`
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

// --- IPC: the only bridge between the renderer and the engine -----------------
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('state:get', () => state.load());

// Locally-installed version + presence per app, BEFORE checking GitHub.
// Installer -> uninstall-registry DisplayVersion; Portable -> our manifest + folder.
ipcMain.handle('installed:get', async () => {
  detect.clearCache(); // fresh scan — versions change after installs
  const cfg = readConfig();
  const stt = state.load();
  const out = {};
  for (const r of cfg.repos) {
    const key = `${r.owner}/${r.repo}#${r.type}`;
    if (r.type === 'installer') {
      let v = null;
      try {
        v = await detect.installedVersion(r.detect || r.repo);
      } catch {}
      out[key] = { current: v, present: !!v };
    } else {
      const dir = portableDir(cfg, r);
      const rec = stt[key];
      out[key] = { current: (rec && rec.version) || null, present: dirHasFiles(dir) };
    }
  }
  return out;
});
ipcMain.handle('folder:open', (_e, appKey) => {
  const cfg = readConfig();
  const r = cfg.repos.find((x) => `${x.owner}/${x.repo}#${x.type}` === appKey);
  const dir = r && portableDir(cfg, r);
  return dir ? shell.openPath(dir) : 'no folder';
});
ipcMain.handle('config:save', (_e, cfg) => {
  saveConfigFile(cfg);
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
// Close a tracked app's running processes (graceful; force on request).
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
ipcMain.handle('selfupdate:check', async () => {
  if (!app.isPackaged) return null; // dev run
  try {
    const found = await selfupdate.checkForUpdate(app.getVersion());
    // canApply is false on macOS, where a running .app bundle cannot be swapped without
    // breaking the signature Gatekeeper re-checks. The banner still reports the new
    // version there; its button opens the release page instead of applying.
    return found ? { version: found.version, canApply: selfupdate.canApply() } : null;
  } catch (e) {
    log(`selfupdate check: ${e && e.message ? e.message : e}`); // e.g. no releases yet
    return null;
  }
});
ipcMain.handle('selfupdate:lastApply', () => selfupdate.consumeApplyMarker(app.getVersion()));
// The releases page for git-updater itself. The URL is built HERE, from the engine's own
// constants — the renderer never passes a URL across the bridge, same as release:open.
ipcMain.handle('selfupdate:openRelease', () =>
  shell.openExternal(`https://github.com/${selfupdate.REPO.owner}/${selfupdate.REPO.repo}/releases`)
);
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the portable apps folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return { path: r.canceled || !r.filePaths.length ? '' : r.filePaths[0] };
});
// A check can discover that an app typed as an installer publishes no installer, and
// correct it to portable (see retypeIfNoInstaller in src/runner.js). The runner only
// decides; persisting belongs here, because config.json is the main process's to own.
// Never silent: the renderer reports what changed and why, and it is logged.
function applyRetypes(results) {
  const changes = (results || []).filter((r) => r.retyped && r.retyped.to === 'portable');
  if (!changes.length) return;
  const cfg = readConfig();
  const hits = [];
  for (const r of changes) {
    const m = /^([^/]+)\/([^/]+)#(.+)$/.exec(r.id || '');
    if (!m) continue;
    const [, owner, repo, type] = m;
    // If the user already tracks this repo as portable, correcting would create a
    // duplicate entry. Leave the installer entry alone and let them untrack it.
    if (cfg.repos.some((x) => x.owner === owner && x.repo === repo && x.type === 'portable')) continue;
    const entry = cfg.repos.find((x) => x.owner === owner && x.repo === repo && x.type === type);
    if (!entry) continue;
    entry.type = 'portable';
    entry.install = { ...(entry.install || {}), dir: r.retyped.dir };
    hits.push(`${owner}/${repo}`);
  }
  if (!hits.length) return;
  saveConfigFile(cfg);
  log(`retyped to portable (no installer published): ${hits.join(', ')}`);
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
    return await runner.run(config, { only: body.only, force: !!body.force, dryRun: !!body.dryRun, onProgress, openFile });
  } finally {
    state.releaseLock(lock);
    updating = false;
  }
});

// Downloads+verifies+extracts the new build into ROOT\app-<version>\ (nothing running is
// touched), then restarts through the launcher, which hands off to it once this process is gone.
ipcMain.handle('selfupdate:apply', async (e) => {
  if (updating) throw new Error('an update is already in progress');
  if (!app.isPackaged) throw new Error('self-update is unavailable in a dev run');
  if (!selfupdate.canApply()) throw new Error('on macOS, download the new version from the release page');
  updating = true;
  try {
    const onProgress = (phase, pct) => e.sender.send('update:progress', { id: 'self', phase, pct });
    const { tag } = await selfupdate.prepareUpdate(ROOT, app.getVersion(), onProgress);
    selfupdate.writeApplyMarker({ expectVersion: tag });
    selfupdate.relaunchViaLauncher(ROOT, process.pid);
    log(`self-update: restarting into ${tag}`);
    setTimeout(() => app.exit(0), 300); // let the IPC reply below flush before this process dies
    return { relaunching: true, version: tag };
  } catch (e) {
    log(`self-update FAILED: ${e && e.stack ? e.stack : e}`);
    throw e;
  } finally {
    updating = false; // only reached on a failure before the relaunch was started
  }
});

// --- lifecycle: launcher hand-off, single instance, on-demand -------------------
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
    selfupdate.launch(target.dir);
    app.exit(0);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // Route the engine's HTTP through Chromium's network stack (Electron net.fetch): it trusts
    // the OS/Windows certificate store, so a corporate VPN/proxy's SSL-inspection root CA — the
    // one the browser already trusts — is honored here too. Node's own fetch ignores that store
    // and fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY on such networks.
    github.setFetch((url, init) => net.fetch(url, init));
    migrateConfig();
    if (app.isPackaged) selfupdate.cleanupLeftovers(ROOT, app.getVersion()).catch(() => {});
    createWindow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Close the window -> everything exits, on every platform INCLUDING macOS, where the
  // convention is normally to stay resident in the dock. That convention is declined on
  // purpose: git-updater runs nothing at startup, keeps no background service and phones
  // home never, and a process lingering after the window closes would contradict that.
  app.on('window-all-closed', () => app.quit());
})();
