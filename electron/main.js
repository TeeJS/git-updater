'use strict';

// Electron main process — the standalone GUI. Replaces the localhost web server:
// the renderer talks to the engine over IPC (no socket), the engine runs in-process
// (no shell, no self-elevation), and closing the window exits everything (on-demand).

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const github = require('../src/github');
const runner = require('../src/runner');
const state = require('../src/state');
const detect = require('../src/detect');
const catalog = require('../src/catalog');
const { log, LOG_FILE } = require('../src/log');

log(`--- git-updater ${app.getVersion()} started ---`);
process.on('uncaughtException', (e) => log(`UNCAUGHT: ${e && e.stack ? e.stack : e}`));
process.on('unhandledRejection', (e) => log(`UNHANDLED: ${e && e.stack ? e.stack : e}`));

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

// Config lives with state under %APPDATA%\git-updater — never the launch cwd.
const DATA_DIR = path.join(process.env.APPDATA || app.getPath('appData'), 'git-updater');
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
        v = await detect.registryVersion(r.detect || r.repo);
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
ipcMain.handle('scan:open', () => {
  if (scanWin && !scanWin.isDestroyed()) return scanWin.focus();
  scanWin = new BrowserWindow({
    width: 620,
    height: 640,
    parent: win,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  scanWin.loadFile(path.join(__dirname, '..', 'ui', 'scan.html'));
});
ipcMain.handle('scan:run', async () => {
  detect.clearCache();
  const tracked = new Set(readConfig().repos.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
  return catalog.matchInstalled(await detect.allInstalled(), tracked);
});
// Add the selected repos (as installer type — they were found in the uninstall registry).
ipcMain.handle('scan:add', (_e, repos) => {
  if (!Array.isArray(repos)) throw new Error('repos must be an array');
  const cfg = readConfig();
  if (!Array.isArray(cfg.repos)) cfg.repos = [];
  let added = 0;
  for (const full of repos) {
    const m = /^([^/]+)\/([^/]+)$/.exec(String(full));
    if (!m) continue;
    if (cfg.repos.some((r) => r.owner === m[1] && r.repo === m[2] && r.type === 'installer')) continue;
    cfg.repos.push({ owner: m[1], repo: m[2], type: 'installer' });
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
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease });
  const asset = repo.asset ? core.matchAsset(rel.assets, repo.asset) : core.pickWindowsAsset(rel.assets, repo.type);
  return { tag: rel.tag_name, asset: asset.name };
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select the portable apps folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return { path: r.canceled || !r.filePaths.length ? '' : r.filePaths[0] };
});
ipcMain.handle('check', async (_e, body = {}) => {
  const config = core.validateConfig(readConfig());
  return runner.run(config, { mode: 'check', only: body.only });
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

// --- lifecycle: single instance, on-demand ------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    migrateConfig();
    createWindow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => app.quit()); // close the window -> everything exits
}
