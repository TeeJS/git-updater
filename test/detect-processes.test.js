'use strict';

// Which running processes belong to an app — the answer decides what Close and Force close
// act on, so it is strict.
//
// Found on a real PC (2026-11-23): the entry `git` (git-for-windows/git) matched
// git-updater.exe, so the Git row always said "git is running" and its Force close killed
// git-updater itself. The same loose rule matched Windows' notepad.exe for notepad-plus-plus,
// and would match a Studio.exe for "Bambu Studio" or a Google.exe for "Google Chrome".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const detect = require('../src/detect');
const platform = require('../src/platform');
const { procMatches, isSelf } = detect;

test('a process is the app when it has the app\'s name, or starts with it', () => {
  assert.ok(procMatches('Joplin.exe', 'joplin'));
  assert.ok(procMatches('GitHubDesktop.exe', 'GitHub Desktop'), 'spelling and spacing do not matter');
  assert.ok(procMatches('Bedrock Panel.exe', 'bedrock-panel'));
  // The app's own helpers carry its name first.
  assert.ok(procMatches('PowerToys.Awake.exe', 'PowerToys'));
  assert.ok(procMatches('deskflow-core.exe', 'deskflow'));
  assert.ok(procMatches('bedrock-panel-portable.exe', 'bedrock-panel'));
  assert.ok(procMatches('git-bash.exe', 'git'));
  assert.ok(procMatches('git-credential-manager.exe', 'git'));
  assert.ok(procMatches('Brave Browser Helper (Renderer)', 'brave-browser'));
  // Letters are not words: the name must end where a word ends.
  assert.equal(procMatches('GitHubDesktop.exe', 'git'), false);
  assert.equal(procMatches('gitk.exe', 'git'), false);
  assert.equal(procMatches('codeium.exe', 'code'), false);
  // The app's name somewhere later in the process name is not the app.
  assert.equal(procMatches('Microsoft.CmdPal.Ext.PowerToys.exe', 'PowerToys'), false);
});

test('one word of the app\'s name is not the app', () => {
  for (const [proc, app] of [
    ['notepad.exe', 'notepad-plus-plus'],
    ['Studio.exe', 'Bambu Studio'],
    ['Studio.exe', 'obs-studio'],
    ['Editor.exe', 'faction-wars-editor'],
    ['Desktop.exe', 'GitHub Desktop'],
    ['app.exe', 'desktop-app'],
    ['Google.exe', 'Google Chrome'],
    ['Google.exe', 'Google Drive'],
    ['Microsoft.exe', 'Microsoft Edge'],
    ['Microsoft.exe', 'Microsoft Teams'],
    ['Windows.exe', 'nvm-windows'],
    ['Player.exe', 'VLC media player'],
    ['Panel.exe', 'bedrock-panel'],
  ]) assert.equal(procMatches(proc, app), false, `${proc} is not ${app}`);
  // Two apps that share a word do not share processes.
  assert.equal(procMatches('WINWORD.EXE', 'Microsoft Teams'), false);
  assert.equal(procMatches('Microsoft Word.exe', 'Microsoft Teams'), false);
  assert.equal(procMatches('ms-teams.exe', 'Microsoft Word'), false);
});

test('the main program the system records is the app, by its exact file name', () => {
  assert.equal(procMatches('brave.exe', 'brave-browser'), false, 'not by name alone');
  assert.ok(procMatches('brave.exe', 'brave-browser', ['brave.exe']));
  assert.ok(procMatches('obs64.exe', 'obs-studio', ['obs64.exe']));
  assert.ok(procMatches('MSEDGE.EXE', 'Microsoft Edge', ['msedge.exe']), 'case does not matter');
  assert.ok(procMatches('7zFM.exe', '7zip', ['7zFM.exe']));
  // Exact means exact: Notepad++ is not Notepad, and a main program has no "helpers".
  assert.ok(procMatches('notepad++.exe', 'notepad-plus-plus', ['notepad++.exe']));
  assert.equal(procMatches('notepad.exe', 'notepad-plus-plus', ['notepad++.exe']), false);
  assert.equal(procMatches('msedgewebview2.exe', 'Microsoft Edge', ['msedge.exe']), false);
});

test('git-updater is never one of an app\'s processes', () => {
  assert.ok(isSelf({ name: 'git-updater.exe', pid: 1 }));
  assert.ok(isSelf({ name: 'git-updater', pid: 1 }));
  assert.ok(isSelf({ name: 'git-updater Helper (Renderer)', pid: 1 }));
  assert.ok(isSelf({ name: 'anything.exe', pid: process.pid }), 'its own process, whatever it is called');
  assert.ok(isSelf({ name: require('node:path').basename(process.execPath), pid: 1 }), 'and every process of its own program file');
  assert.equal(isSelf({ name: 'git.exe', pid: 1 }), false);
  assert.equal(isSelf({ name: 'git-bash.exe', pid: 1 }), false);
});

// Runs `fn` against a made-up machine: `procs` running, `apps` in the installed inventory.
async function onMachine({ procs, apps = [], registered = [] }, fn) {
  const real = { runningProcesses: platform.runningProcesses, installedApps: platform.installedApps, killProcess: platform.killProcess, launchTargetFor: platform.launchTargetFor, registeredPrograms: platform.registeredPrograms };
  const killed = [];
  let alive = procs.slice();
  platform.runningProcesses = async () => alive.slice();
  platform.installedApps = async () => apps;
  platform.launchTargetFor = async () => null;
  platform.registeredPrograms = async () => registered;
  platform.killProcess = (pid, force) => { killed.push({ pid, force }); alive = alive.filter((p) => p.pid !== pid); };
  detect.clearCache();
  try {
    return await fn(killed);
  } finally {
    Object.assign(platform, real);
    detect.clearCache();
  }
}

test('closing Git for Windows closes Git, and leaves git-updater and everything else running', async () => {
  const procs = [
    { name: 'git-updater.exe', pid: '100' }, { name: 'git-updater.exe', pid: '101' },
    { name: 'git.exe', pid: '200' }, { name: 'git-bash.exe', pid: '201' },
    { name: 'GitHubDesktop.exe', pid: '300' }, { name: 'notepad.exe', pid: '400' },
  ];
  await onMachine({ procs }, async (killed) => {
    assert.equal(await detect.isRunning('git'), true);
    const result = await detect.closeApp('git', { force: true });
    assert.deepEqual(killed, [{ pid: '200', force: true }, { pid: '201', force: true }]);
    assert.deepEqual(result, { closed: 2, stillRunning: false });
  });
  // With only git-updater running, Git is not running at all — the row no longer says it is.
  await onMachine({ procs: procs.slice(0, 2) }, async (killed) => {
    assert.equal(await detect.isRunning('git'), false);
    assert.deepEqual(await detect.closeApp('git', { force: true }), { closed: 0, stillRunning: false });
    assert.deepEqual(killed, []);
  });
});

test('the main program comes only from the inventory row that is the app itself', async () => {
  const apps = [
    { name: 'Microsoft Edge', version: '156.0.1', flavor: 'exe', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    // Matches "Microsoft Edge" loosely, and is a shared runtime inside many other apps.
    { name: 'Microsoft Edge WebView2 Runtime', version: '156.0.2', flavor: 'exe', path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe' },
    { name: 'OBS Studio 32.2.2', version: '32.2.2', flavor: 'exe', path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' },
    { name: '7-Zip 26.06 (x64)', version: '26.06', flavor: 'exe', path: 'C:\\Program Files\\7-Zip\\7zFM.exe' },
    { name: 'Brave', version: '1.100.58', flavor: 'exe', path: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe' },
    // A recorded "program" that is a shared host or an installer names no process.
    { name: 'Some Java App', version: '1.0', flavor: 'exe', path: 'C:\\Program Files\\Java\\bin\\javaw.exe' },
    { name: 'PowerToys', version: '0.102', flavor: 'exe', path: 'C:\\ProgramData\\Package Cache\\{x}\\setup-powertoys.exe' },
  ];
  await onMachine({ procs: [], apps }, async () => {
    assert.deepEqual(await detect.mainPrograms('Microsoft Edge'), ['msedge.exe']);
    assert.deepEqual(await detect.mainPrograms('obs-studio'), ['obs64.exe']);
    assert.deepEqual(await detect.mainPrograms('7zip'), ['7zFM.exe']);
    assert.deepEqual(await detect.mainPrograms('brave-browser'), ['brave.exe']);
    assert.deepEqual(await detect.mainPrograms('Some Java App'), []);
    assert.deepEqual(await detect.mainPrograms('PowerToys'), []);
    assert.deepEqual(await detect.mainPrograms('not-installed-app'), []);
  });
  const procs = [{ name: 'msedge.exe', pid: '1' }, { name: 'msedgewebview2.exe', pid: '2' }, { name: 'Microsoft.exe', pid: '3' }];
  await onMachine({ procs, apps }, async (killed) => {
    await detect.closeApp('Microsoft Edge', { force: true });
    assert.deepEqual(killed, [{ pid: '1', force: true }], 'Edge only: not the WebView2 runtime other apps are using');
  });
});

// Found on a real PC: an MSI install of Google Chrome records no icon and no folder in the
// uninstall registry, so nothing there names chrome.exe — and "chrome" is only one word of
// "Google Chrome". Windows' App Paths list does name it.
test('App Paths names the program of an app whose inventory row does not', async () => {
  const apps = [{ name: 'Google Chrome', version: '157.0.8103.79', flavor: 'msi' }];
  const registered = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Audacity 4\\bin\\Audacity4.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files\\WinMerge\\WinMergeU.exe',
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files\\Java\\bin\\javaw.exe',
  ];
  await onMachine({ procs: [], apps, registered }, async () => {
    assert.deepEqual(await detect.mainPrograms('Google Chrome'), ['chrome.exe']);
    assert.deepEqual(await detect.mainPrograms('Microsoft Edge'), ['msedge.exe']);
    assert.deepEqual(await detect.mainPrograms('audacity'), ['Audacity4.exe'], 'a version on the folder and a bin folder are set aside');
    assert.deepEqual(await detect.mainPrograms('brave-browser'), ['brave.exe']);
    assert.deepEqual(await detect.mainPrograms('winmerge'), ['WinMergeU.exe']);
    // The folder must be the app's OWN: a vendor, or a folder further up, owns nothing.
    assert.deepEqual(await detect.mainPrograms('Google'), [], 'the folder is Chrome\'s, not all of Google\'s');
    assert.deepEqual(await detect.mainPrograms('Microsoft'), []);
    assert.deepEqual(await detect.mainPrograms('Microsoft Office'), [], 'Word is two folders below it');
    assert.deepEqual(await detect.mainPrograms('Chrome Application'), []);
    assert.deepEqual(await detect.mainPrograms('Java'), [], 'a shared host is never an app\'s program');
  });
  const procs = [{ name: 'chrome.exe', pid: '1' }, { name: 'msedge.exe', pid: '2' }, { name: 'Google.exe', pid: '3' }];
  await onMachine({ procs, apps, registered }, async (killed) => {
    assert.equal(await detect.isRunning('Google Chrome'), true);
    await detect.closeApp('Google Chrome');
    assert.deepEqual(killed, [{ pid: '1', force: false }]);
  });
  await onMachine({ procs, apps }, async () => {
    assert.equal(await detect.isRunning('Google Chrome'), false, 'without that record, one word of the name is still not enough');
  });
});

test('parseAppPaths: the registered file, whatever the key or the label is called', () => {
  const { parseAppPaths } = require('../src/platform/win');
  const out = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WinMerge.exe',
    '    (Standard)    REG_SZ    "C:\\Program Files\\WinMerge\\WinMergeU.exe"',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\wordpad.exe',
    '    (Default)    REG_EXPAND_SZ    "%ProgramFiles%\\Windows NT\\Accessories\\WORDPAD.EXE"',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\empty.exe',
    '    (Default)    REG_SZ    ',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\notanexe',
    '    (Default)    REG_SZ    C:\\Somewhere\\readme.txt',
    '    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].join('\r\n');
  assert.deepEqual(parseAppPaths(out, { ProgramFiles: 'C:\\Program Files' }), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\WinMerge\\WinMergeU.exe',
    'C:\\Program Files\\Windows NT\\Accessories\\WORDPAD.EXE',
  ]);
  assert.deepEqual(parseAppPaths(''), []);
});
