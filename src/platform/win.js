'use strict';

// Windows: installed programs come from the uninstall registry, read with reg.exe
// (a signed MS utility, benign read, NO shell — Node has no native registry API).
// Running processes come from tasklist.exe, closed with taskkill.exe, both likewise.

const { spawnSync } = require('child_process');
const { run } = require('./exec');

const HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// A registry DisplayIcon value into a plain exe path, or null. DisplayIcon is usually
// the app's own exe (with an optional ",<index>" icon suffix and sometimes quotes), which
// is exactly what "Open App" wants to launch — but it can also point at an .ico or the
// uninstaller, so callers take it only when it is a real, non-uninstaller .exe. Pure;
// exported for tests.
function cleanIconPath(s) {
  let v = String(s || '').trim();
  v = v.replace(/,\s*-?\d+\s*$/, '').trim(); // strip a trailing icon index ("...app.exe",0 / .exe,-15)
  v = v.replace(/^"(.*)"$/, '$1').trim(); // then any wrapping quotes
  return v || null;
}

// Parse `reg query <hive> /s` output into [{ name, version, flavor, path?, location? }].
// flavor is how the app was installed ('msi' when MsiExec owns the uninstall string, else
// 'exe') — used to pick the SAME installer flavor on update so an MSI never lands beside an
// EXE install. path/location (added for "Open App") are the launchable exe from DisplayIcon
// and the InstallLocation directory; both optional, present only when the registry gave
// them. Exported for tests: pure string in, records out.
function parseHive(stdout) {
  const out = [];
  let cur = null;
  const push = () => {
    if (cur && cur.DisplayName && cur.DisplayVersion) {
      const icon = cleanIconPath(cur.DisplayIcon);
      const rec = {
        name: cur.DisplayName,
        version: cur.DisplayVersion,
        flavor: /msiexec/i.test(cur.UninstallString || '') ? 'msi' : 'exe',
      };
      if (icon && /\.exe$/i.test(icon) && !/unins/i.test(icon)) rec.path = icon;
      if (cur.InstallLocation) rec.location = cur.InstallLocation.replace(/[\\/]+$/, '');
      out.push(rec);
    }
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      push();
      cur = {};
    } else if (cur) {
      const m = line.match(/^\s+(DisplayName|DisplayVersion|UninstallString|DisplayIcon|InstallLocation)\s+REG_\w+\s+(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  push();
  return out;
}

// Every installed program, from the three uninstall hives queried in parallel.
async function installedApps() {
  const outs = await Promise.all(HIVES.map((h) => run('reg', ['query', h, '/s'])));
  return outs.flatMap(parseHive);
}

// Parse `tasklist /fo csv /nh` into [{ name, pid }]. Exported for tests.
function parseTasklist(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((l) => {
      const m = l.match(/^"([^"]+)","([^"]+)"/);
      return m ? { name: m[1], pid: m[2] } : null;
    })
    .filter(Boolean);
}

async function runningProcesses() {
  return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh']));
}

// Graceful WM_CLOSE by default, /F /T to force. Windows has no signal equivalent, so
// this stays a taskkill.exe call rather than process.kill().
function killProcess(pid, force) {
  spawnSync('taskkill', force ? ['/PID', String(pid), '/F', '/T'] : ['/PID', String(pid)], { windowsHide: true });
}

module.exports = { installedApps, runningProcesses, killProcess, parseHive, parseTasklist, cleanIconPath };
