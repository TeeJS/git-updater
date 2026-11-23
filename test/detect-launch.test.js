'use strict';

// "Open App" for an installed program: which file does it open?
//
// The reported bug: Open App on PowerToys opened "PowerToys (Preview) x64 Setup" (Modify
// Setup: Uninstall / Cancel), not PowerToys. Windows has two rows for it, and the one
// git-updater chose names the SETUP as the app's icon. Both rows below are that PC's own
// registry text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../src/detect');
const platform = require('../src/platform');
const win = require('../src/platform/win');

const UNINSTALL = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const row = (key, values) => [`${UNINSTALL}\\${key}`, ...Object.entries(values).map(([name, value]) => `    ${name}    REG_SZ    ${value}`), ''].join('\r\n');

const CACHED_SETUP = 'C:\\ProgramData\\Package Cache\\{D324162D-1B7B-4245-A200-7F7EF7756930}\\PowerToysSetup-0.102.3101.0-x64.exe';
const POWERTOYS = [
  row('{BA4E4F4C-50DF-4E33-9E54-59DF54B18A9C}', {
    DisplayVersion: '0.102.3101.0',
    InstallLocation: 'C:\\Program Files\\PowerToys\\',
    UninstallString: 'MsiExec.exe /X{BA4E4F4C-50DF-4E33-9E54-59DF54B18A9C}',
    DisplayName: 'PowerToys (Preview)',
  }),
  row('{D324162D-1B7B-4245-A200-7F7EF7756930}', {
    DisplayIcon: `${CACHED_SETUP},0`,
    DisplayName: 'PowerToys (Preview) x64',
    DisplayVersion: '0.102.3101.0',
    UninstallString: `"${CACHED_SETUP}"  /uninstall`,
  }),
].join('\r\n');

const ONEDRIVE_SETUP = 'C:\\Program Files\\Microsoft OneDrive\\26.113.0614.0004_1\\OneDriveSetup.exe';
const ONEDRIVE = row('OneDriveSetup.exe', {
  DisplayName: 'Microsoft OneDrive',
  DisplayIcon: `${ONEDRIVE_SETUP},-101`,
  DisplayVersion: '26.113.0614.0004',
  UninstallString: `"${ONEDRIVE_SETUP}"  /uninstall  /allusers`,
});

// Runs fn with the inventory set to `rows`, and with no platform lookup behind it.
async function withInstalled(rows, fn) {
  const real = { installedApps: platform.installedApps, launchTargetFor: platform.launchTargetFor };
  platform.installedApps = async () => rows;
  platform.launchTargetFor = async () => null;
  detect.clearCache();
  try {
    return await fn();
  } finally {
    Object.assign(platform, real);
    detect.clearCache();
  }
}

test('isSetupFile: a setup kept in "Package Cache", or named setup or install, is not the app\'s program', () => {
  assert.ok(detect.isSetupFile(CACHED_SETUP));
  assert.ok(detect.isSetupFile('C:\\Users\\me\\AppData\\Local\\Package Cache\\{7116a5c9}\\python-3.14.6-amd64.exe'), 'the folder alone says so');
  assert.ok(detect.isSetupFile(ONEDRIVE_SETUP), 'the file name alone says so');
  assert.ok(detect.isSetupFile('C:\\Program Files\\Thing\\Thing-Installer.exe'));
  // An ordinary program is left alone.
  assert.equal(detect.isSetupFile('C:\\Program Files\\PowerToys\\PowerToys.exe'), false);
  assert.equal(detect.isSetupFile('C:\\Program Files\\Git\\git-bash.exe'), false);
  assert.equal(detect.isSetupFile('C:\\Program Files\\Package Cache Viewer\\viewer.exe'), false, 'only a folder named exactly Package Cache');
  // Only an .exe is judged: a macOS bundle or a Linux launcher is never caught by its name.
  assert.equal(detect.isSetupFile('/Applications/Install Helper.app'), false);
  assert.equal(detect.isSetupFile('/usr/share/applications/setup-tool.desktop'), false);
  assert.equal(detect.isSetupFile(null), false);
  assert.equal(detect.isSetupFile(''), false);
});

test('PowerToys: the setup is not offered as the program, and the folder comes from its other row', async () => {
  const rows = win.parseHive(POWERTOYS);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].path, CACHED_SETUP, 'what the registry says, and what Open App used to run');
  await withInstalled(rows, async () => {
    assert.deepEqual(await detect.launchTarget('PowerToys'), { path: null, location: 'C:\\Program Files\\PowerToys' });
  });
  // The same whichever row Windows lists first.
  await withInstalled(rows.slice().reverse(), async () => {
    assert.deepEqual(await detect.launchTarget('PowerToys'), { path: null, location: 'C:\\Program Files\\PowerToys' });
  });
});

test('OneDrive: its only row names the setup and no folder, so nothing is offered rather than the setup', async () => {
  await withInstalled(win.parseHive(ONEDRIVE), async () => {
    assert.deepEqual(await detect.launchTarget('Microsoft OneDrive'), { path: null, location: null });
  });
});

test('an ordinary app is opened from its recorded program, as before', async () => {
  const obs = { name: 'OBS Studio', version: '32.1.2', flavor: 'exe', path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', location: 'C:\\Program Files\\obs-studio' };
  await withInstalled([obs], async () => {
    assert.deepEqual(await detect.launchTarget('obs-studio'), { path: obs.path, location: obs.location });
  });
  // A macOS bundle keeps its path whatever it is called.
  await withInstalled([{ name: 'Install Helper', version: '1.0', flavor: 'app', path: '/Applications/Install Helper.app' }], async () => {
    assert.deepEqual(await detect.launchTarget('Install Helper'), { path: '/Applications/Install Helper.app', location: null });
  });
});

test('a row with a real program and no folder still borrows the folder, and keeps its program', async () => {
  const rows = [
    { name: 'Thing', version: '2.0', flavor: 'msi', location: 'C:\\Program Files\\Thing' },
    { name: 'Thing', version: '2.0', flavor: 'exe', path: 'C:\\Program Files\\Thing\\thing.exe' },
  ];
  await withInstalled(rows, async () => {
    assert.deepEqual(await detect.launchTarget('Thing'), { path: 'C:\\Program Files\\Thing\\thing.exe', location: 'C:\\Program Files\\Thing' });
  });
});

test('the chosen row\'s own folder wins over another row\'s', async () => {
  const rows = [
    { name: 'Thing', version: '1.0', flavor: 'exe', location: 'C:\\Old\\Thing' },
    { name: 'Thing', version: '2.0', flavor: 'exe', path: 'C:\\Program Files\\Thing\\ThingSetup.exe', location: 'C:\\Program Files\\Thing' },
  ];
  await withInstalled(rows, async () => {
    assert.deepEqual(await detect.launchTarget('Thing'), { path: null, location: 'C:\\Program Files\\Thing' });
  });
});

test('nothing installed: still null', async () => {
  await withInstalled([], async () => {
    assert.equal(await detect.launchTarget('PowerToys'), null);
  });
});

// --- the Start Menu, as the last resort ------------------------------------------------------
//
// Six apps on the same PC had nothing launchable on record, and Open App said "couldn't find
// the program": Google Chrome, NAPS2, Zoom, PuTTY, Tailscale, and (once its setup was no longer
// taken for it) OneDrive. Every shortcut and target below is that PC's own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MENU = {
  'Google Chrome': 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  TikTok: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe',
  NAPS2: 'C:\\Program Files\\NAPS2\\NAPS2.exe',
  OneDrive: 'C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe',
  'PowerToys (Preview)': 'C:\\Program Files\\PowerToys\\PowerToys.exe',
  Pageant: 'C:\\Program Files\\PuTTY\\pageant.exe',
  PSFTP: 'C:\\Program Files\\PuTTY\\psftp.exe',
  'PuTTY Manual': 'C:\\Program Files\\PuTTY\\putty.chm',
  'PuTTY Web Site': 'C:\\Program Files\\PuTTY\\website.url',
  PuTTYgen: 'C:\\Program Files\\PuTTY\\puttygen.exe',
  PuTTY: 'C:\\Program Files\\PuTTY\\putty.exe',
  Tailscale: 'C:\\Program Files\\Tailscale\\tailscale-ipn.exe',
  'Zoom Workplace': 'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
};
const LINKS = Object.keys(MENU).map((name) => ({ name, file: `${name}.lnk` }));
const readMenu = (file) => MENU[file.replace(/\.lnk$/, '')];
const there = () => true;

test('pickShortcut: each of the six apps resolves to its own program', () => {
  const pick = (own, rows) => detect.pickShortcut(LINKS, own, rows, readMenu, there);
  assert.equal(pick(['Google Chrome'], ['Google Chrome']), MENU['Google Chrome']);
  assert.equal(pick(['naps2'], ['NAPS2']), MENU.NAPS2);
  assert.equal(pick(['Zoom'], ['Zoom Workplace (64-bit)']), MENU['Zoom Workplace'], 'by the name of its installed row');
  assert.equal(pick(['PuTTY'], ['PuTTY release 0.84 (64-bit)']), MENU.PuTTY, 'not PSFTP, PuTTYgen, the manual or the web site');
  assert.equal(pick(['Tailscale'], ['Tailscale']), MENU.Tailscale);
  assert.equal(pick(['OneDrive'], ['Microsoft OneDrive']), MENU.OneDrive);
  assert.equal(pick(['PowerToys'], ['PowerToys (Preview) x64', 'PowerToys (Preview)']), MENU['PowerToys (Preview)'], 'a bracketed note is not part of the name');
});

test('pickShortcut: a shortcut that is not named for the app is never read, let alone opened', () => {
  const read = [];
  const target = detect.pickShortcut(LINKS, ['Thing'], ['Thing 2.0'], (file) => { read.push(file); return readMenu(file); }, there);
  assert.equal(target, null);
  assert.deepEqual(read, []);
  // One word of the name is not the name: Chrome's "TikTok" web app, PuTTY's PuTTYgen.
  assert.equal(detect.pickShortcut([{ name: 'TikTok', file: 'TikTok.lnk' }], ['Google Chrome'], ['Google Chrome'], readMenu, there), null);
  assert.equal(detect.pickShortcut([{ name: 'PuTTYgen', file: 'PuTTYgen.lnk' }, { name: 'PuTTY Manual', file: 'PuTTY Manual.lnk' }], ['PuTTY'], [], readMenu, there), null);
});

test('pickShortcut: a target that cannot be opened as the app is skipped', () => {
  const one = (target, exists = there) => detect.pickShortcut([{ name: 'Thing', file: 'Thing.lnk' }], ['Thing'], [], () => target, exists);
  assert.equal(one('C:\\Program Files\\Thing\\thing.exe'), 'C:\\Program Files\\Thing\\thing.exe');
  assert.equal(one('C:\\Program Files\\Thing\\ThingSetup.exe'), null, 'a setup');
  assert.equal(one('C:\\ProgramData\\Package Cache\\{1}\\thing.exe'), null, 'a cached setup');
  assert.equal(one('C:\\Program Files\\Thing\\unins000.exe'), null, 'an uninstaller');
  assert.equal(one('C:\\Users\\me\\AppData\\Local\\Thing\\Update.exe'), null, 'an updater that needs the shortcut\'s arguments');
  assert.equal(one('C:\\Program Files\\Java\\bin\\javaw.exe'), null, 'a shared host that needs them too');
  assert.equal(one('C:\\Program Files\\Thing\\manual.chm'), null, 'not a program');
  assert.equal(one('https://example.com/'), null);
  assert.equal(one(undefined), null, 'a shortcut with no target');
  assert.equal(one('C:\\Program Files\\Thing\\thing.exe', () => false), null, 'a program that is no longer there');
  // A shortcut that cannot be read is skipped, and the next one is tried.
  const links = [{ name: 'Thing', file: 'broken.lnk' }, { name: 'Thing', file: 'good.lnk' }];
  const read = (file) => { if (file === 'broken.lnk') throw new Error('unreadable'); return 'C:\\Program Files\\Thing\\thing.exe'; };
  assert.equal(detect.pickShortcut(links, ['Thing'], [], read, there), 'C:\\Program Files\\Thing\\thing.exe');
});

test('pickShortcut: the shortcut named exactly like the app is tried first', () => {
  // The real pair: Audacity 4 beside an older Audacity. Both are "audacity" once the number goes.
  const targets = { 'old.lnk': 'C:\\Program Files\\Audacity\\Audacity.exe', 'new.lnk': 'C:\\Program Files\\Audacity 4\\bin\\Audacity4.exe' };
  const links = [{ name: 'Audacity', file: 'old.lnk' }, { name: 'Audacity 4', file: 'new.lnk' }];
  const pick = (own, order = links) => detect.pickShortcut(order, own, [], (file) => targets[file], there);
  assert.equal(pick(['Audacity 4']), targets['new.lnk']);
  assert.equal(pick(['Audacity 4'], links.slice().reverse()), targets['new.lnk'], 'whatever order the Start Menu lists them in');
  assert.equal(pick(['audacity']), targets['old.lnk']);
  // The app's own name beats the name of an installed row.
  const two = [{ name: 'Zoom Workplace', file: 'a.lnk' }, { name: 'Zoom', file: 'b.lnk' }];
  assert.equal(detect.pickShortcut(two, ['Zoom'], ['Zoom Workplace (64-bit)'], (file) => `C:\\Zoom\\${file[0]}.exe`, there), 'C:\\Zoom\\b.exe');
});

test('startMenuProgram: asks the Start Menu with the app\'s installed rows, and never throws', async () => {
  const real = platform.startMenuShortcuts;
  try {
    platform.startMenuShortcuts = async () => LINKS;
    await withInstalled([{ name: 'Zoom Workplace (64-bit)', version: '7.1.41345', flavor: 'msi' }], async () => {
      assert.equal(await detect.startMenuProgram('Zoom', 'Zoom', readMenu, there), MENU['Zoom Workplace']);
      assert.equal(await detect.startMenuProgram('Zoom', 'Zoom', () => { throw new Error('no'); }, there), null);
    });
    // No Start Menu (macOS, Linux): nothing, and no shortcut is read.
    platform.startMenuShortcuts = async () => [];
    await withInstalled([], async () => {
      assert.equal(await detect.startMenuProgram('Zoom', 'Zoom', () => assert.fail('nothing to read'), there), null);
    });
    platform.startMenuShortcuts = async () => { throw new Error('unreadable'); };
    await withInstalled([], async () => {
      assert.equal(await detect.startMenuProgram('Zoom', 'Zoom', readMenu, there), null);
    });
  } finally {
    platform.startMenuShortcuts = real;
  }
});

test('startMenuShortcuts: lists the .lnk files of both Start Menu folders, and survives a missing one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-startmenu-'));
  try {
    const programs = (base) => path.join(dir, base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(path.join(programs('all'), 'PuTTY (64-bit)'), { recursive: true });
    fs.mkdirSync(programs('me'), { recursive: true });
    fs.writeFileSync(path.join(programs('all'), 'PuTTY (64-bit)', 'PuTTY.lnk'), '');
    fs.writeFileSync(path.join(programs('all'), 'Google Chrome.LNK'), '');
    fs.writeFileSync(path.join(programs('all'), 'desktop.ini'), '');
    fs.writeFileSync(path.join(programs('me'), 'Tailscale.lnk'), '');
    const found = await win.startMenuShortcuts({ programdata: path.join(dir, 'all'), APPDATA: path.join(dir, 'me') });
    assert.deepEqual(found.map((link) => link.name).sort(), ['Google Chrome', 'PuTTY', 'Tailscale']);
    assert.equal(found.find((link) => link.name === 'PuTTY').file, path.join(programs('all'), 'PuTTY (64-bit)', 'PuTTY.lnk'));
    // A folder that is not there, and a variable that is not set, add nothing.
    assert.deepEqual(await win.startMenuShortcuts({ ProgramData: path.join(dir, 'nowhere') }), []);
    assert.deepEqual(await win.startMenuShortcuts({}), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Open App asks the Start Menu last, on Windows only, through Electron\'s own shortcut reader', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const launch = main.slice(main.indexOf('async function launchApp('), main.indexOf("ipcMain.handle('app:launch'"));
  const folder = launch.indexOf('core.pickLaunchFile(shallowFiles(t.location');
  const menu = launch.indexOf('detect.startMenuProgram(');
  assert.ok(folder > 0 && menu > folder, 'after the recorded program and the install folder');
  assert.match(launch, /if \(!target && process\.platform === 'win32'\) \{\s+target = await detect\.startMenuProgram\(core\.detectName\(r\), core\.appName\(r\), \(file\) => shell\.readShortcutLink\(file\)\.target\);/);
});
