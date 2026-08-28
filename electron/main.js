'use strict';

// Electron main process — the standalone GUI. Replaces the localhost web server:
// the renderer talks to the engine over IPC (no socket), the engine runs in-process
// (no shell, no self-elevation), and closing the window exits everything (on-demand).

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const runner = require('../src/runner');
const state = require('../src/state');

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
  win = new BrowserWindow({
    width: 840,
    height: 760,
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
ipcMain.handle('config:save', (_e, cfg) => {
  saveConfigFile(cfg);
  return { ok: true };
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
ipcMain.handle('update', async (_e, body = {}) => {
  if (updating) throw new Error('an update is already in progress');
  updating = true;
  let lock = null;
  try {
    const config = core.validateConfig(readConfig());
    if (!body.dryRun) lock = state.acquireLock();
    return await runner.run(config, { only: body.only, force: !!body.force, dryRun: !!body.dryRun });
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
