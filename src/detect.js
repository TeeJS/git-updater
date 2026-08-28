'use strict';

// Installed-version detection for "installer" apps: read DisplayVersion from the
// Windows uninstall registry. Uses reg.exe directly (signed MS utility, benign read,
// NO shell) — Node has no native registry API. ponytail: reg.exe query, swap for a
// native RegOpenKeyEx binding only if a child process is unacceptable.

const { spawnSync } = require('child_process');

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

let cache = null; // one scan per process is plenty
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

// Best DisplayVersion for an app whose registry DisplayName contains `needle`
// (case-insensitive). Returns null when nothing matches (i.e. not installed).
function registryVersion(needle) {
  if (!needle) return null;
  const n = String(needle).toLowerCase();
  const hit = allInstalled().find((e) => e.DisplayName.toLowerCase().includes(n));
  return hit ? hit.DisplayVersion : null;
}

module.exports = { registryVersion };
