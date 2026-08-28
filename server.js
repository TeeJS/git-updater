#!/usr/bin/env node
'use strict';

// git-updater entry point.
//   git-updater check|update|list-assets ...   -> delegate to the CLI (bin/watch.js)
//   git-updater                                -> start the local web UI + open browser
//
// The web UI is a thin HTTP layer. Check/update are run by SPAWNING this same
// program as the CLI (with --json), so the CLI's per-repo Windows elevation applies
// to updates started from the browser too — the server never applies changes itself.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const core = require('./src/core');
const github = require('./src/github');

let IS_SEA = false;
try {
  IS_SEA = require('node:sea').isSea();
} catch {}

const SUBCOMMANDS = new Set(['check', 'update', 'list-assets']);
// Config lives next to the app (exe dir when packaged, repo root in dev), not the launch
// cwd — so shortcuts and OpenQuake hosting resolve the same file.
const APP_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = process.env.GITUPDATER_CONFIG || path.join(APP_DIR, 'config.json');
const PORT = Number(process.env.GITUPDATER_PORT) || 8756;

// Spawn this same app as the CLI and return its parsed {results, summary}. As a SEA
// exe that's `git-updater.exe <cmd>`; as node it's `node bin/watch.js <cmd>`.
function runCli(subcmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const pre = IS_SEA ? [] : [path.join(__dirname, 'bin', 'watch.js')];
    const args = [...pre, subcmd, '--json', '--config', CONFIG_PATH];
    if (opts.only) args.push('--only', opts.only);
    if (opts.force) args.push('--force');
    if (opts.dryRun) args.push('--dry-run');
    const child = spawn(process.execPath, args, { windowsHide: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error((err || out || `exited ${code}`).trim().split('\n').pop()));
      }
    });
  });
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { portableRoot: '', repos: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Light structural check only — enough to store the list. The portable-folder
// requirement is enforced later at check/update time, so apps can be added in any
// order (before or after the folder is set) without the save being rejected.
function saveConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.repos)) throw new Error('config: "repos" must be an array');
  cfg.repos.forEach((r, i) => {
    if (!r.owner || !r.repo) throw new Error(`app ${i + 1}: owner and repo are required`);
    if (r.type !== 'portable' && r.type !== 'installer') throw new Error(`app ${i + 1}: type must be portable or installer`);
  });
  if (fs.existsSync(CONFIG_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Native Windows folder picker (server runs locally, so it can show a real dialog).
function pickFolder() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
      "$d.Description='Select the portable apps folder';$d.ShowNewFolderButton=$true;" +
      "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}";
    const child = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

// CSRF/drive-by guard for state-changing (and dialog-popping) routes. A hostile
// page can't set a custom header cross-origin without a CORS preflight we never
// answer, and any Origin it does send won't be localhost. Same-origin UI passes.
function sameOriginOnly(req) {
  if (req.headers['x-git-updater'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h !== '127.0.0.1' && h !== 'localhost') return false;
    } catch {
      return false;
    }
  }
  return true;
}

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// SEA exe: UI is a bundled asset. Dev (node server.js): read from disk.
function loadUI() {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) return sea.getAsset('index.html', 'utf8');
  } catch {}
  return fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
}
function startServer() {
  const UI = loadUI();
  const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, UI, 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, readConfig());
    }
    // State-changing + dialog routes require the same-origin guard.
    const guarded =
      url.pathname === '/api/pick-folder' ||
      url.pathname === '/api/config' && req.method === 'POST' ||
      url.pathname === '/api/check' ||
      url.pathname === '/api/update';
    if (guarded && !sameOriginOnly(req)) return send(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
      return send(res, 200, { path: await pickFolder() });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const cfg = await readBody(req);
      saveConfig(cfg);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/list-assets') {
      const owner = url.searchParams.get('owner');
      const repo = url.searchParams.get('repo');
      if (!owner || !repo) return send(res, 400, { error: 'owner and repo required' });
      const prerelease = url.searchParams.get('prerelease') === 'true';
      return send(res, 200, await github.listAssets(owner, repo, { prerelease }));
    }
    if (req.method === 'POST' && (url.pathname === '/api/check' || url.pathname === '/api/update')) {
      const body = await readBody(req);
      core.validateConfig(JSON.parse(JSON.stringify(readConfig()))); // fail fast with a clear message
      const subcmd = url.pathname === '/api/check' ? 'check' : 'update';
      const { results, summary } = await runCli(subcmd, {
        only: body.only,
        force: !!body.force,
        dryRun: !!body.dryRun,
      });
      return send(res, 200, { results, summary });
    }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    const uiUrl = `http://127.0.0.1:${PORT}/`;
    console.log(`git-updater UI at ${uiUrl}  (config: ${CONFIG_PATH})`);
    if (process.platform === 'win32' && !process.env.GITUPDATER_NO_OPEN)
      spawn('cmd', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore' });
  });
}

// Delegate CLI subcommands to bin/watch.js (keeps its self-elevation logic);
// otherwise start the web UI.
if (SUBCOMMANDS.has(process.argv[2])) require('./bin/watch.js');
else startServer();
