'use strict';

// The platform inventory parsers. Every one of these is a pure string-in/records-out
// function precisely so the whole matrix is testable from any host — the subprocess
// that produces the string is the only part that needs the real OS.

const { test } = require('node:test');
const assert = require('node:assert');

const win = require('../src/platform/win');
const mac = require('../src/platform/mac');
const linux = require('../src/platform/linux');
const { assetTable } = require('../src/platform/assets');
const { impl } = require('../src/platform');

// --- Windows ----------------------------------------------------------------

const REG_OUT = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{23170F69-40C1-2702-2602-000001000000}',
  '    DisplayName    REG_SZ    7-Zip 26.02 (x64 edition)',
  '    DisplayVersion    REG_SZ    26.02',
  '    UninstallString    REG_SZ    MsiExec.exe /X{23170F69-40C1-2702-2602-000001000000}',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Notepad++',
  '    DisplayName    REG_SZ    Notepad++ (64-bit x64)',
  '    DisplayVersion    REG_SZ    8.7.1',
  '    UninstallString    REG_SZ    C:\\Program Files\\Notepad++\\uninstall.exe',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NoVersion',
  '    DisplayName    REG_SZ    Something Without A Version',
  '',
].join('\r\n');

test('win: parses the uninstall registry, dropping entries with no version', () => {
  assert.deepEqual(win.parseHive(REG_OUT), [
    { name: '7-Zip 26.02 (x64 edition)', version: '26.02', flavor: 'msi' },
    { name: 'Notepad++ (64-bit x64)', version: '8.7.1', flavor: 'exe' },
  ]);
});

test('win: MsiExec in the uninstall string means the msi flavor', () => {
  const [a, b] = win.parseHive(REG_OUT);
  assert.equal(a.flavor, 'msi'); // upgrading must stay on msi
  assert.equal(b.flavor, 'exe'); // ...and this one must stay on exe
});

test('win: parses tasklist csv', () => {
  const out = '"notepad++.exe","1234","Console","1","12,345 K"\r\n"ShareX.exe","99","Console","1","1 K"\r\n';
  assert.deepEqual(win.parseTasklist(out), [
    { name: 'notepad++.exe', pid: '1234' },
    { name: 'ShareX.exe', pid: '99' },
  ]);
});

// --- macOS ------------------------------------------------------------------

// Directories are passed explicitly so this runs identically on any host — the real
// defaults are POSIX paths, and the predicate that uses them is covered in appfilter.test.js.
const MAC_DIRS = ['/Applications', '/Users/teej/Applications'];

test('mac: parses system_profiler json, skipping Apple apps and non-installed bundles', () => {
  const out = JSON.stringify({
    SPApplicationsDataType: [
      { _name: 'ShareX', version: '21.0.0', path: '/Applications/ShareX.app', obtained_from: 'identified_developer' },
      { _name: 'Safari', version: '19.0', path: '/Applications/Safari.app', obtained_from: 'apple' },
      { _name: 'Console', version: '1.0', path: '/Applications/Utilities/Console.app', obtained_from: 'apple_sw' },
      { _name: 'No Version', path: '/Applications/NoVersion.app', obtained_from: 'unknown' },
      // Spotlight reports every bundle on disk, not the installed set. These are real
      // rows from a developer machine and must not reach the inventory: taking the
      // highest version across matches, any of them would pin an app as up to date.
      { _name: 'Electron', version: '44.3.0', path: '/Users/teej/p/node_modules/electron/dist/Electron.app', obtained_from: 'unknown' },
      { _name: 'Bedrock Panel', version: '9.9.9', path: '/Users/teej/p/dist/mac-arm64/Bedrock Panel.app', obtained_from: 'unknown' },
    ],
  });
  assert.deepEqual(mac.parseSystemProfiler(out, MAC_DIRS), [
    { name: 'ShareX', version: '21.0.0', flavor: 'app', path: '/Applications/ShareX.app' },
  ]);
});

test('mac: malformed system_profiler output yields nothing rather than throwing', () => {
  assert.deepEqual(mac.parseSystemProfiler('not json at all', MAC_DIRS), []);
  assert.deepEqual(mac.parseSystemProfiler('', MAC_DIRS), []);
});

test('mac: reads CFBundleShortVersionString from an XML Info.plist', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Example</string>
  <key>CFBundleShortVersionString</key>
  <string>3.4.5</string>
  <key>CFBundleVersion</key>
  <string>3405</string>
</dict>
</plist>`;
  assert.equal(mac.parseInfoPlistXml(plist), '3.4.5');
});

test('mac: falls back to CFBundleVersion when there is no short version', () => {
  const plist = '<dict><key>CFBundleVersion</key><string>2026.1</string></dict>';
  assert.equal(mac.parseInfoPlistXml(plist), '2026.1');
  assert.equal(mac.parseInfoPlistXml('<dict></dict>'), null);
});

test('mac: ps output reduces the executable path to its basename', () => {
  const out = ['  123 /Applications/ShareX.app/Contents/MacOS/ShareX', '    7 /usr/sbin/cfprefsd', ''].join('\n');
  assert.deepEqual(mac.parsePs(out), [
    { name: 'ShareX', pid: '123' },
    { name: 'cfprefsd', pid: '7' },
  ]);
});

// --- Linux ------------------------------------------------------------------

test('linux: debian versions lose the epoch and the distro revision', () => {
  assert.equal(linux.cleanDebVersion('2:1.2.3-1ubuntu2'), '1.2.3');
  assert.equal(linux.cleanDebVersion('1.2.3-1'), '1.2.3');
  assert.equal(linux.cleanDebVersion('1.2.3'), '1.2.3');
  // "~" is Debian's prerelease marker and maps onto semver's "-".
  assert.equal(linux.cleanDebVersion('1.2.3~rc1-1'), '1.2.3-rc1');
});

test('linux: parses dpkg-query output and keeps only installed packages', () => {
  const out = [
    'ii \tnotepadqq\t2.0.0-1build3',
    'ii \tfirefox\t2:140.0-1',
    'rc \tremoved-but-configured\t1.0-1', // uninstalled, config retained — not an install
    'iU \thalf-configured\t3.0-1',
    'broken',
    '',
  ].join('\n');
  assert.deepEqual(linux.parseDpkg(out), [
    { name: 'notepadqq', version: '2.0.0', flavor: 'deb' },
    { name: 'firefox', version: '140.0', flavor: 'deb' },
  ]);
});

test('linux: parses rpm output and skips (none) versions', () => {
  const out = 'obs-studio\t31.0.2\ngpg-pubkey\t(none)\n';
  assert.deepEqual(linux.parseRpm(out), [{ name: 'obs-studio', version: '31.0.2', flavor: 'rpm' }]);
});

test('linux: parses flatpak and snap listings', () => {
  assert.deepEqual(linux.parseFlatpak('OBS Studio\t31.0.2\nGIMP\t3.0.4\n'), [
    { name: 'OBS Studio', version: '31.0.2', flavor: 'flatpak' },
    { name: 'GIMP', version: '3.0.4', flavor: 'flatpak' },
  ]);
  const snap = ['Name       Version   Rev    Tracking       Publisher   Notes', 'code       1.98.2    174    latest/stable  vscode✓     classic', ''].join('\n');
  assert.deepEqual(linux.parseSnap(snap), [{ name: 'code', version: '1.98.2', flavor: 'snap' }]);
  // Prose splits into columns too, and must not become a package named "No" at "snaps".
  assert.deepEqual(linux.parseSnap('No snaps are installed yet.\n'), []);
});

test('linux: an absent package manager contributes nothing, it does not throw', () => {
  // run() resolves '' when a command is missing or exits nonzero.
  assert.deepEqual(linux.parseDpkg(''), []);
  assert.deepEqual(linux.parseRpm(''), []);
  assert.deepEqual(linux.parseFlatpak(''), []);
  assert.deepEqual(linux.parseSnap(''), []);
});

// --- dispatch ---------------------------------------------------------------

test('platform: every supported OS resolves to a real implementation', () => {
  for (const key of ['win32', 'darwin', 'linux']) {
    const p = impl(key);
    assert.equal(typeof p.installedApps, 'function', key);
    assert.equal(typeof p.runningProcesses, 'function', key);
    assert.equal(typeof p.killProcess, 'function', key);
    assert.equal(assetTable(key).id, key);
  }
});

test('platform: an unsupported OS degrades to empty inventories, not a crash', async () => {
  const p = impl('aix');
  assert.deepEqual(await p.installedApps(), []);
  assert.deepEqual(await p.runningProcesses(), []);
  assert.doesNotThrow(() => p.killProcess(1, true));
  // ...and its asset table falls back to the Linux conventions.
  assert.equal(assetTable('aix').id, 'linux');
});

// --- store-managed apps -------------------------------------------------------
// An App Store app is updated by the App Store, never from a GitHub release, so offering
// it can only produce a false match. Worse than a false match, though: measured on a real
// machine, every App Store app carries its receipt INSIDE the bundle at
// Contents/_MASReceipt/receipt (Bitwarden, Developer, iScreen Shoter all do; Developer ID
// apps like Chrome and Docker have none). An update replaces the bundle whole, so the
// receipt goes with it and the app loses its App Store update path.

test('parseSystemProfiler: App Store apps are excluded, like Apple\'s own', () => {
  const json = JSON.stringify({
    SPApplicationsDataType: [
      { _name: 'Bitwarden', version: '2026.8.0', path: '/Applications/Bitwarden.app', obtained_from: 'mac_app_store' },
      { _name: 'Safari', version: '26.0', path: '/Applications/Safari.app', obtained_from: 'apple' },
      { _name: 'Legacy', version: '1.0', path: '/Applications/Legacy.app', obtained_from: 'apple_sw' },
      { _name: 'Docker', version: '4.90.0', path: '/Applications/Docker.app', obtained_from: 'identified_developer' },
      { _name: 'Deskflow', version: '1.26.0.0', path: '/Applications/Deskflow.app', obtained_from: 'unknown' },
    ],
  });
  const names = mac.parseSystemProfiler(json).map((r) => r.name).sort();
  // identified_developer and unknown are the two provenances a GitHub release can serve
  assert.deepEqual(names, ['Deskflow', 'Docker']);
});
