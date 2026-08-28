#!/usr/bin/env node
'use strict';

// git-updater entry point.
//   git-updater check|update|list-assets ...   -> delegate to the CLI (bin/watch.js)
//   git-updater                                -> start the local web UI + open browser
//
// The web UI is a thin HTTP layer over the same engine (src/*). Update runs inline:
// portable apps install under a user-writable portableRoot (no admin), and installers
// trigger their own UAC when they launch. For portable swaps into a protected dir
// (e.g. Program Files) run the exe as admin, or use the CLI which self-elevates per repo.
// ponytail: no per-repo elevation in the server path; CLI covers that case.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const core = require('./src/core');
const github = require('./src/github');
const runner = require('./src/runner');

const SUBCOMMANDS = new Set(['check', 'update', 'list-assets']);
const CONFIG_PATH = process.env.GITUPDATER_CONFIG || path.resolve('config.json');
const PORT = Number(process.env.GITUPDATER_PORT) || 8756;

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { portableRoot: '', repos: [] };
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Validate a deep clone (validateConfig mutates: it fills portable dirs from
// portableRoot). We persist the user's raw config so portableRoot stays the source.
function saveConfig(cfg) {
  core.validateConfig(JSON.parse(JSON.stringify(cfg))); // throws on invalid
  if (fs.existsSync(CONFIG_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
      const config = core.validateConfig(readConfig()); // fills portable dirs
      const opts =
        url.pathname === '/api/check'
          ? { mode: 'check', only: body.only }
          : { only: body.only, force: !!body.force, dryRun: !!body.dryRun };
      const { results, summary } = await runner.run(config, opts);
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
