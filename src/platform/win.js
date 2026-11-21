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
      if (/^\d{8}$/.test(cur.InstallDate || '')) {
        const d = cur.InstallDate;
        const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        if (!Number.isNaN(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso) rec.installDate = iso;
      }
      out.push(rec);
    }
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      push();
      cur = {};
    } else if (cur) {
      const m = line.match(/^\s+(DisplayName|DisplayVersion|UninstallString|DisplayIcon|InstallLocation|InstallDate)\s+REG_\w+\s+(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  push();
  return out;
}

// Packaged (MSIX / Store) apps are not in the uninstall registry at all. Windows keeps the
// current user's packages as one registry key each, named by the package's full name:
//
//   ...\AppModel\Repository\Packages\MicrosoftCorporationII.Windows365_2.0.1601.0_x64__8wekyb3d8bbwe
//                                     <identity name>               _<version>_<arch>_<resource>_<publisher id>
//
// Listing that key (no /s — only the key names are wanted) is the same benign reg.exe read as
// the hives above. The record's name is the package's IDENTITY, a machine identifier, and it is
// flagged `packaged` so src/detect.js never matches it loosely against an app's display name.
const PACKAGES_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';

// Parse `reg query <PACKAGES_KEY>` output into [{ name, version, flavor: 'msix', packaged }].
// Exported for tests: pure string in, records out.
function parsePackageKeys(stdout) {
  const out = [];
  const seen = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/\\Repository\\Packages\\([a-z0-9][a-z0-9.-]*)_(\d+(?:\.\d+){1,3})_[a-z0-9]+_[^_\\]*_[a-z0-9]{13}$/i);
    if (!m) continue;
    const key = `${m[1].toLowerCase()}@${m[2]}`;
    if (seen.has(key)) continue; // a bundle registers one key per resource package
    seen.add(key);
    out.push({ name: m[1], version: m[2], flavor: 'msix', packaged: true });
  }
  return out;
}

// Every installed program: the three uninstall hives, plus the user's packaged apps, queried
// in parallel. A failed query yields '' and so no rows — never an error.
async function installedApps() {
  const [packages, ...hives] = await Promise.all([run('reg', ['query', PACKAGES_KEY]), ...HIVES.map((h) => run('reg', ['query', h, '/s']))]);
  return [...hives.flatMap(parseHive), ...parsePackageKeys(packages)];
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

module.exports = { installedApps, runningProcesses, killProcess, parseHive, parsePackageKeys, parseTasklist, cleanIconPath };
