'use strict';

// Installed-version detection for "installer" apps: read DisplayVersion from the
// Windows uninstall registry. Uses reg.exe directly (signed MS utility, benign read,
// NO shell) — Node has no native registry API. Everything here is ASYNC: these child
// processes take seconds, and a spawnSync would freeze the Electron main process
// (window paint, IPC) for that whole time.

const { spawn, spawnSync } = require('child_process');
const { cmpVersion } = require('./core');

const HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

const norm = (s) => String(s || '').toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a command without blocking; resolve its stdout ('' on any failure).
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? out : ''));
  });
}

// Parse `reg query <hive> /s` output into [{DisplayName, DisplayVersion, UninstallString}].
function parseHive(stdout) {
  const out = [];
  let cur = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      if (cur) out.push(cur);
      cur = {};
    } else if (cur) {
      const m = line.match(/^\s+(DisplayName|DisplayVersion|UninstallString)\s+REG_\w+\s+(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

let cache = null; // cleared after installs so fresh versions show
function clearCache() {
  cache = null;
}

// All installed programs (three uninstall hives queried in parallel).
async function allInstalled() {
  if (cache) return cache;
  if (process.platform !== 'win32') return (cache = []);
  const outs = await Promise.all(HIVES.map((h) => run('reg', ['query', h, '/s'])));
  cache = outs.flatMap((o) => parseHive(o)).filter((e) => e.DisplayName && e.DisplayVersion);
  return cache;
}

async function matchEntries(needle) {
  const t = norm(needle);
  if (t.length < 2) return [];
  return (await allInstalled()).filter((e) => {
    const dn = norm(e.DisplayName);
    return dn.length >= 2 && (dn.includes(t) || t.includes(dn));
  });
}

// Best DisplayVersion for an app whose registry DisplayName matches `needle`.
// An app can have several entries (e.g. an old EXE install alongside a newer MSI
// install) — report the highest version. null = not installed.
async function registryVersion(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  return hits.map((h) => h.DisplayVersion).sort(cmpVersion).pop();
}

// How is the app currently installed — 'msi' (MsiExec uninstall entry) or 'exe'
// (its own uninstaller)? null when not installed. Used to pick the SAME installer
// flavor on update, so an MSI never installs alongside an EXE install.
async function installedFlavor(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVersion(a.DisplayVersion, b.DisplayVersion));
  const top = hits[hits.length - 1];
  return /msiexec/i.test(top.UninstallString || '') ? 'msi' : 'exe';
}

// --- running-process detection (for a proactive "close the app" warning) ------
// tasklist.exe: a signed MS utility, benign read, NO shell.

async function runningProcesses() {
  if (process.platform !== 'win32') return [];
  const out = await run('tasklist', ['/fo', 'csv', '/nh']);
  return out
    .split(/\r?\n/)
    .map((l) => { const m = l.match(/^"([^"]+)","([^"]+)"/); return m ? { name: m[1], pid: m[2] } : null; })
    .filter(Boolean);
}

async function matchProcs(needle) {
  const t = norm(needle);
  if (t.length < 3) return [];
  return (await runningProcesses()).filter((p) => { const pn = norm(p.name); return pn.length >= 3 && (pn.includes(t) || t.includes(pn)); });
}

// Is a process whose name looks like `needle` running? Loose alphanumeric match
// (so "notepad-plus-plus" matches "notepad++.exe"); override per app with `process`.
async function isRunning(needle) {
  return (await matchProcs(needle)).length > 0;
}

// Close the running processes for `needle` — graceful WM_CLOSE by default (taskkill),
// or /F to force. taskkill is a signed MS utility, no shell. Waits briefly for exit.
// ponytail: taskkill by PID; force can lose unsaved work, so the UI double-confirms it.
async function closeApp(needle, opts = {}) {
  const procs = await matchProcs(needle);
  for (const p of procs) {
    spawnSync('taskkill', opts.force ? ['/PID', p.pid, '/F', '/T'] : ['/PID', p.pid], { windowsHide: true });
  }
  for (let i = 0; i < 15 && (await isRunning(needle)); i++) await wait(200); // up to ~3s to exit
  return { closed: procs.length, stillRunning: await isRunning(needle) };
}

module.exports = { registryVersion, installedFlavor, isRunning, closeApp, clearCache, allInstalled };
