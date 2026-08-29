'use strict';

// Installed-version detection for "installer" apps: read DisplayVersion from the
// Windows uninstall registry. Uses reg.exe directly (signed MS utility, benign read,
// NO shell) — Node has no native registry API. ponytail: reg.exe query, swap for a
// native RegOpenKeyEx binding only if a child process is unacceptable.

const { spawnSync } = require('child_process');
const { cmpVersion } = require('./core');

const HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Parse `reg query <hive> /s` output into [{DisplayName, DisplayVersion}] blocks.
function queryHive(hive) {
  const r = spawnSync('reg', ['query', hive, '/s'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      if (cur) out.push(cur);
      cur = {};
    } else if (cur) {
      const m = line.match(/^\s+(DisplayName|DisplayVersion)\s+REG_\w+\s+(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

let cache = null; // one scan per run; cleared after installs so fresh versions show
function clearCache() {
  cache = null;
}
function allInstalled() {
  if (cache) return cache;
  cache = [];
  if (process.platform === 'win32') {
    for (const hive of HIVES) {
      try {
        for (const e of queryHive(hive)) if (e.DisplayName && e.DisplayVersion) cache.push(e);
      } catch {}
    }
  }
  return cache;
}

// Best DisplayVersion for an app whose registry DisplayName matches `needle`.
// Matches on alphanumerics only, so "7zip" finds "7-Zip" and "notepad-plus-plus"
// finds "Notepad++". Returns null when nothing matches (i.e. not installed).
function registryVersion(needle) {
  const t = norm(needle);
  if (t.length < 2) return null;
  // An app can have several entries (e.g. an old EXE install alongside a newer MSI
  // install) — report the highest version.
  const hits = allInstalled().filter((e) => {
    const dn = norm(e.DisplayName);
    return dn.length >= 2 && (dn.includes(t) || t.includes(dn));
  });
  if (!hits.length) return null;
  return hits.map((h) => h.DisplayVersion).sort(cmpVersion).pop();
}

// --- running-process detection (for a proactive "close the app" warning) ------
// tasklist.exe: a signed MS utility, benign read, NO shell.
const norm = (s) => String(s || '').toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9]/g, '');

function runningProcesses() {
  if (process.platform !== 'win32') return [];
  const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => { const m = l.match(/^"([^"]+)","([^"]+)"/); return m ? { name: m[1], pid: m[2] } : null; })
    .filter(Boolean);
}

function matches(needle) {
  const t = norm(needle);
  if (t.length < 3) return [];
  return runningProcesses().filter((p) => { const pn = norm(p.name); return pn.length >= 3 && (pn.includes(t) || t.includes(pn)); });
}

// Is a process whose name looks like `needle` running? Loose alphanumeric match
// (so "notepad-plus-plus" matches "notepad++.exe"); override per app with `process`.
function isRunning(needle) {
  return matches(needle).length > 0;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Close the running processes for `needle` — graceful WM_CLOSE by default (taskkill),
// or /F to force. taskkill is a signed MS utility, no shell. Waits briefly for exit.
// ponytail: taskkill by PID; force can lose unsaved work, so the UI double-confirms it.
async function closeApp(needle, opts = {}) {
  const procs = matches(needle);
  for (const p of procs) {
    spawnSync('taskkill', opts.force ? ['/PID', p.pid, '/F', '/T'] : ['/PID', p.pid], { windowsHide: true });
  }
  for (let i = 0; i < 15 && isRunning(needle); i++) await wait(200); // up to ~3s to exit
  return { closed: procs.length, stillRunning: isRunning(needle) };
}

module.exports = { registryVersion, isRunning, closeApp, clearCache };
