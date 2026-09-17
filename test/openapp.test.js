'use strict';

// "Open App" launch-target resolution. The choice of WHICH file to launch is pure
// (core.pickLaunchFile) and the registry path capture is pure (win.parseHive /
// cleanIconPath), so the whole matrix is testable from any host — exactly the parts
// that decide the wrong-vs-right executable.

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../src/core');
const win = require('../src/platform/win');

// --- core.pickLaunchFile ----------------------------------------------------

test('pickLaunchFile (win): prefers the app-named exe over bundled noise', () => {
  const files = [
    'ShareX.exe',
    'unins000.exe',
    'vc_redist.x64.exe',
    'ShareX.CrashHandler.exe',
    'ffmpeg.exe',
  ];
  assert.equal(core.pickLaunchFile(files, 'ShareX', 'win32'), 'ShareX.exe');
});

test('pickLaunchFile (win): a name match wins even when nested deeper', () => {
  const files = ['tools/ffmpeg.exe', 'bin/notepad++.exe', 'setup.exe'];
  assert.equal(core.pickLaunchFile(files, 'notepad-plus-plus', 'win32'), 'bin/notepad++.exe');
});

test('pickLaunchFile (win): with no name match, the shallowest non-noise exe wins', () => {
  const files = ['app/deep/thing.exe', 'main.exe', 'redist/vc_redist.exe'];
  assert.equal(core.pickLaunchFile(files, 'zzz', 'win32'), 'main.exe');
});

test('pickLaunchFile (win): falls back to noise-only when nothing else exists', () => {
  assert.equal(core.pickLaunchFile(['unins000.exe'], 'foo', 'win32'), 'unins000.exe');
});

test('pickLaunchFile (win): no exe at all -> null', () => {
  assert.equal(core.pickLaunchFile(['readme.txt', 'data.bin'], 'foo', 'win32'), null);
});

test('pickLaunchFile (mac): resolves the .app bundle dir from its many members', () => {
  const files = [
    'ShareX.app/Contents/Info.plist',
    'ShareX.app/Contents/MacOS/ShareX',
    'ShareX.app/Contents/Resources/icon.icns',
  ];
  assert.equal(core.pickLaunchFile(files, 'ShareX', 'darwin'), 'ShareX.app');
});

test('pickLaunchFile (mac): shallowest .app wins when several are present', () => {
  const files = ['Extra/Helper.app/Contents/x', 'Main.app/Contents/y'];
  assert.equal(core.pickLaunchFile(files, 'nomatch', 'darwin'), 'Main.app');
});

test('pickLaunchFile (linux): prefers an AppImage', () => {
  const files = ['deskflow.AppImage', 'README', 'lib/thing.so'];
  assert.equal(core.pickLaunchFile(files, 'deskflow', 'linux'), 'deskflow.AppImage');
});

test('pickLaunchFile (linux): falls back to a top-level extension-less binary', () => {
  const files = ['bin/deskflow', 'deskflow', 'share/doc/readme.txt'];
  assert.equal(core.pickLaunchFile(files, 'deskflow', 'linux'), 'deskflow');
});

test('pickLaunchFile: empty/missing manifest -> null', () => {
  assert.equal(core.pickLaunchFile([], 'foo', 'win32'), null);
  assert.equal(core.pickLaunchFile(undefined, 'foo', 'win32'), null);
});

// --- win.cleanIconPath ------------------------------------------------------

test('cleanIconPath: strips the trailing icon index and quotes', () => {
  assert.equal(win.cleanIconPath('"C:\\Program Files\\App\\app.exe",0'), 'C:\\Program Files\\App\\app.exe');
  assert.equal(win.cleanIconPath('C:\\App\\app.exe,-15'), 'C:\\App\\app.exe');
  assert.equal(win.cleanIconPath('C:\\App\\app.exe'), 'C:\\App\\app.exe');
  assert.equal(win.cleanIconPath(''), null);
});

// --- win.parseHive path/location capture ------------------------------------

const REG_WITH_PATHS = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ShareX',
  '    DisplayName    REG_SZ    ShareX',
  '    DisplayVersion    REG_SZ    16.0.1',
  '    DisplayIcon    REG_SZ    "C:\\Program Files\\ShareX\\ShareX.exe",0',
  '    InstallLocation    REG_SZ    C:\\Program Files\\ShareX\\',
  '    UninstallString    REG_SZ    "C:\\Program Files\\ShareX\\unins000.exe"',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\IconIsUninstaller',
  '    DisplayName    REG_SZ    OddApp',
  '    DisplayVersion    REG_SZ    2.0',
  '    DisplayIcon    REG_SZ    C:\\OddApp\\unins000.exe,0',
  '    InstallLocation    REG_SZ    C:\\OddApp',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\IconIsIco',
  '    DisplayName    REG_SZ    IcoApp',
  '    DisplayVersion    REG_SZ    3.0',
  '    DisplayIcon    REG_SZ    C:\\IcoApp\\app.ico',
  '',
].join('\r\n');

test('parseHive: captures a real exe DisplayIcon as path and InstallLocation as location', () => {
  const [shareX] = win.parseHive(REG_WITH_PATHS);
  assert.equal(shareX.path, 'C:\\Program Files\\ShareX\\ShareX.exe'); // icon index stripped
  assert.equal(shareX.location, 'C:\\Program Files\\ShareX'); // trailing slash stripped
});

test('parseHive: rejects an uninstaller or a non-exe DisplayIcon as a launch path', () => {
  const recs = win.parseHive(REG_WITH_PATHS);
  const odd = recs.find((r) => r.name === 'OddApp');
  const ico = recs.find((r) => r.name === 'IcoApp');
  assert.equal(odd.path, undefined); // unins000.exe is not a launch target
  assert.equal(odd.location, 'C:\\OddApp'); // ...but the location is still usable
  assert.equal(ico.path, undefined); // an .ico is not launchable
  assert.equal(ico.location, undefined);
});

test('parseHive: entries with no icon/location stay exactly as before (no extra keys)', () => {
  const out = win.parseHive(
    [
      'HKLM\\...\\Plain',
      '    DisplayName    REG_SZ    Plain',
      '    DisplayVersion    REG_SZ    1.0',
      '    UninstallString    REG_SZ    MsiExec.exe /X{GUID}',
      '',
    ].join('\r\n')
  );
  assert.deepEqual(out, [{ name: 'Plain', version: '1.0', flavor: 'msi' }]);
});

test('launch file: an extension-less document is not a program', () => {
  // The Linux branch took any file without an extension, and LICENSE, README and COPYING
  // all qualify. notepad-plus-plus — a Windows app that had been installed into the Linux
  // portable folder — resolved to updater/LICENSE.
  const files = ['license.txt', 'readme.txt', 'updater/LICENSE', 'updater/README', 'notepad++.exe'];
  assert.equal(core.pickLaunchFile(files, 'notepad-plus-plus', 'linux'), null);
});

test('launch file: the execute bit decides when the caller can check it', () => {
  const files = ['LICENSE', 'brave', 'chrome_crashpad_handler'];
  const isExec = (p) => p === 'brave' || p === 'chrome_crashpad_handler';
  assert.equal(core.pickLaunchFile(files, 'brave-browser', 'linux', isExec), 'brave');
  // Without the predicate the name still has to carry the decision.
  assert.equal(core.pickLaunchFile(files, 'brave-browser', 'linux'), 'brave');
});

test('launch file: a manifest with no modes falls back rather than refusing', () => {
  // A .zip carries no permission bits, so everything can look non-executable. Narrowing
  // to nothing would turn "wrong file" into "no file", which is worse.
  const files = ['myapp', 'data/blob'];
  assert.equal(core.pickLaunchFile(files, 'myapp', 'linux', () => false), 'myapp');
});
