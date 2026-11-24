'use strict';

// An installer that failed names the programs that have the app's files open.
//
// Found on OBS: its installer failed with exit 6 while OBS was closed. Chrome and the Claude
// app had OBS's virtual-camera file (data\obs-plugins\win-dshow\obs-virtualcam-module64.dll)
// loaded, and the row said "if the app is open, close it and Retry", which was no help.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const inuse = require('../src/inuse');
const win = require('../src/platform/win');
const elevate = require('../src/elevate');
const helper = require('../src/helper');
const github = require('../src/github');
const detect = require('../src/detect');
const install = require('../src/install');
const runner = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-inuse-'));
const windowsOnly = os.platform() === 'win32' ? false : 'installer exit codes and the helper are Windows-only';
const OBS_DIR = String.raw`C:\Program Files\obs-studio`;

// --- the pieces ---------------------------------------------------------------------------

test('folderOf: the folder the record names, else its uninstaller\'s, else its program\'s', () => {
  assert.equal(inuse.folderOf({ location: String.raw`"C:\Users\u\AppData\Local\Music Assistant"` }), String.raw`C:\Users\u\AppData\Local\Music Assistant`);
  assert.equal(inuse.folderOf({ uninstallDir: OBS_DIR, path: String.raw`C:\Program Files\obs-studio\bin\64bit\obs64.exe` }), OBS_DIR, 'the whole app, not just bin\\64bit');
  assert.equal(inuse.folderOf({ path: String.raw`C:\Apps\Thing\thing.exe` }), String.raw`C:\Apps\Thing`);
  assert.equal(inuse.folderOf({ name: 'PuTTY' }), null);
  assert.equal(inuse.folderOf(null), null);
});

test('parseHive: an app that names no folder gets its uninstaller\'s; an MSI never does', () => {
  const reg = [
    String.raw`HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio`,
    '    DisplayName    REG_SZ    OBS Studio',
    '    DisplayVersion    REG_SZ    32.1.2',
    String.raw`    UninstallString    REG_SZ    "C:\Program Files\obs-studio\uninstall.exe"`,
    '',
    String.raw`HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\{ABC}`,
    '    DisplayName    REG_SZ    PuTTY release 0.85 (64-bit)',
    '    DisplayVersion    REG_SZ    0.85.0.0',
    '    UninstallString    REG_SZ    MsiExec.exe /X{ABC}',
    '',
    String.raw`HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\Plain_is1`,
    '    DisplayName    REG_SZ    Plain',
    '    DisplayVersion    REG_SZ    1.0',
    String.raw`    UninstallString    REG_SZ    C:\Apps\Plain\unins000.exe /SILENT`,
    '',
    String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Music Assistant`,
    '    DisplayName    REG_SZ    Music Assistant',
    '    DisplayVersion    REG_SZ    0.7.4',
    String.raw`    InstallLocation    REG_SZ    "C:\Users\u\AppData\Local\Music Assistant"`,
    String.raw`    UninstallString    REG_SZ    "C:\Users\u\AppData\Local\Music Assistant\uninstall.exe"`,
  ].join('\r\n');
  const [obs, putty, plain, music] = win.parseHive(reg);
  assert.equal(obs.uninstallDir, OBS_DIR);
  assert.equal(putty.uninstallDir, undefined);
  assert.equal(plain.uninstallDir, String.raw`C:\Apps\Plain`);
  assert.equal(music.uninstallDir, undefined, 'it names its folder already');
});

test('parseUsers: one name per program, each once, in the order given', () => {
  assert.deepEqual(inuse.parseUsers('10940\tClaude\r\n28992\tGoogle Chrome\n30000\tGoogle Chrome\n\n31000\t\nnot a line\n'), ['Claude', 'Google Chrome']);
  assert.deepEqual(inuse.parseUsers(''), []);
});

test('reason: names the programs and says what to do, in plain words', () => {
  assert.equal(inuse.reason('OBS Studio', ['Google Chrome', 'Claude'], 6), 'Google Chrome and Claude are using OBS Studio\'s files — close them, then Retry (installer exit 6)');
  assert.equal(inuse.reason('OBS Studio', ['Google Chrome'], 6), 'Google Chrome is using OBS Studio\'s files — close it, then Retry (installer exit 6)');
  assert.equal(inuse.joinNames(['A', 'B', 'C']), 'A, B and C');
  assert.equal(inuse.reason('OBS Studio', [], 6), null, 'nobody named: the installer\'s own reason stands');
});

test('appLabel: the installed name without its version or bracketed note', () => {
  assert.equal(inuse.appLabel({ name: 'OBS Studio' }, 'obs-studio'), 'OBS Studio');
  assert.equal(inuse.appLabel({ name: '7-Zip 26.06 (x64)' }, '7zip'), '7-Zip');
  assert.equal(inuse.appLabel({}, 'obs-studio'), 'obs-studio');
});

test('namesUsing: asks the helper on Windows only, and only its own read-only question', async () => {
  const calls = [];
  const runHelper = async (exe, args) => { calls.push([exe, ...args]); return { code: 0, stdout: '28992\tGoogle Chrome\n10940\tClaude\n' }; };
  assert.deepEqual(await inuse.namesUsing(OBS_DIR, { helperPath: 'h.exe', runHelper, platform: 'win32' }), ['Google Chrome', 'Claude']);
  assert.deepEqual(calls, [['h.exe', '--who-uses', '--folder', OBS_DIR]]);
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(await inuse.namesUsing('/Applications/OBS.app', { helperPath: 'h', runHelper, platform }), [], `${platform}: files in use do not block an install there`);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(await inuse.namesUsing(OBS_DIR, { helperPath: null, runHelper, platform: 'win32' }), [], 'no helper, no question');
  assert.deepEqual(await inuse.namesUsing(OBS_DIR, { helperPath: 'h.exe', runHelper: async () => ({ code: 64010, stdout: '' }), platform: 'win32' }), []);
});

// --- the administrator run (where OBS failed) ---------------------------------------------

function fakeHelper(answers) {
  const spawn = (exe, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const answer = answers[args[0]];
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(`${helper.RESULTS_HEADER}\n${answer.map((c, i) => `${i} ${c}\n`).join('')}`));
      child.emit('close', 0);
    });
    return child;
  };
  return spawn;
}

function entry(stageBase, name, whyFailed) {
  const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
  fs.writeFileSync(path.join(keepDir, `${name}.exe`), 'MZ');
  const asked = [];
  return {
    asked,
    e: {
      key: `acme/${name}#installer`,
      item: { file: String.raw`C:\stage\${name}.exe`, sha256: '0'.repeat(64), kind: 'exe', args: ['/S'] },
      keepDir,
      succeed: () => ({ status: 'updated' }),
      ownWindow: () => ({ status: 'failed', reason: 'window' }),
      fail: (reason) => ({ status: 'failed', reason }),
      ...(whyFailed ? { whyFailed: async (code) => { asked.push(code); return whyFailed(code); } } : {}),
    },
  };
}

test('finish: an installer\'s own exit code is explained by who has the files open', async () => {
  const stageBase = tmp();
  try {
    const obs = entry(stageBase, 'obs', (code) => inuse.reason('OBS Studio', ['Google Chrome', 'Claude'], code));
    const busy = entry(stageBase, 'busy', () => 'never asked');
    const plain = entry(stageBase, 'plain', () => null);
    const old = entry(stageBase, 'old');
    const spawn = fakeHelper({ '--verify': [0, 0, 0, 0], '--install': [6, 1618, 7, 7] });
    const out = await elevate.finish([obs.e, busy.e, plain.e, old.e], { helperPath: 'h.exe', stageBase, spawn });
    assert.equal(out.get('acme/obs#installer').reason, 'Google Chrome and Claude are using OBS Studio\'s files — close them, then Retry (installer exit 6)');
    assert.match(out.get('acme/busy#installer').reason, /another installer is already running/, 'an exit code that already has a meaning keeps it');
    assert.deepEqual(busy.asked, []);
    assert.match(out.get('acme/plain#installer').reason, /^installer failed \(exit 7\)/, 'nobody has the files open: as before');
    assert.match(out.get('acme/old#installer').reason, /^installer failed \(exit 7\)/, 'an entry that cannot ask: as before');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

// --- the runner ---------------------------------------------------------------------------

async function withRelease(fn) {
  const real = {
    getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset, verifyDigest: github.verifyDigest,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease, isRunning: detect.isRunning, clearCache: detect.clearCache,
    installedVersion: detect.installedVersion, installedCopies: detect.installedCopies, installInstaller: install.installInstaller,
  };
  github.getLatestRelease = async () => ({ tag_name: 'v33.0.3', assets: [{ name: 'payload.zip', browser_download_url: 'https://example.invalid/payload.zip' }] });
  github.downloadAsset = async (_url, file) => {
    const zip = new AdmZip();
    zip.addFile('app.txt', Buffer.from('v2'));
    zip.writeZip(file);
  };
  github.verifyDigest = () => ({ skipped: true, note: 'no digest in test' });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => '32.1.2';
  detect.installedCopies = async () => [{ name: 'OBS Studio', version: '32.1.2', uninstallDir: OBS_DIR }];
  try {
    return await fn();
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, verifyDigest: real.verifyDigest, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, { isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion, installedCopies: real.installedCopies });
    install.installInstaller = real.installInstaller;
  }
}

const obsConfig = () => ({ portableRoot: '', repos: [{ owner: 'obsproject', repo: 'obs-studio', type: 'installer', asset: 'payload.zip', install: { kind: 'nsis' } }] });
const exit6 = () => { throw Object.assign(new Error('installer failed (exit 6) — if the app is open, close it and Retry'), { status: 6, genericExit: true }); };

test('runner: a failed installer names who has the app\'s files open', { skip: windowsOnly }, async () => {
  const dir = tmp();
  try {
    await withRelease(async () => {
      install.installInstaller = exit6;
      const asked = [];
      const inUse = async (folder) => { asked.push(folder); return ['Google Chrome', 'Claude']; };
      const { results } = await runner.run(obsConfig(), { statePath: path.join(dir, 's.json'), openFile: () => {}, inUse });
      assert.equal(results[0].status, 'failed');
      assert.equal(results[0].reason, 'Google Chrome and Claude are using OBS Studio\'s files — close them, then Retry (installer exit 6)');
      assert.deepEqual(asked, [OBS_DIR]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: with nobody holding the files, or nothing to ask, the installer\'s own reason stands', { skip: windowsOnly }, async () => {
  const dir = tmp();
  try {
    await withRelease(async () => {
      install.installInstaller = exit6;
      for (const opts of [{ inUse: async () => [] }, {}]) {
        const { results } = await runner.run(obsConfig(), { statePath: path.join(dir, 's.json'), openFile: () => {}, ...opts });
        assert.match(results[0].reason, /^installer failed \(exit 6\)/);
      }
      // An exit code the installer step already explains is never second-guessed.
      install.installInstaller = () => { throw Object.assign(new Error('another installer is already running — wait for it to finish, then Retry'), { status: 1618, genericExit: false }); };
      const { results } = await runner.run(obsConfig(), { statePath: path.join(dir, 's.json'), openFile: () => {}, inUse: async () => ['Google Chrome'] });
      assert.match(results[0].reason, /another installer is already running/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an installer set aside for the one prompt carries the same question to the end', { skip: windowsOnly }, async () => {
  const dir = tmp();
  const aside = [];
  try {
    await withRelease(async () => {
      install.installInstaller = () => { throw Object.assign(new Error('requires elevation'), { elevation: true }); };
      await runner.run(obsConfig(), { statePath: path.join(dir, 's.json'), openFile: () => {}, setAside: (e) => aside.push(e), inUse: async () => ['Google Chrome', 'Claude'] });
      assert.equal(aside.length, 1);
      assert.equal(await aside[0].whyFailed(6), 'Google Chrome and Claude are using OBS Studio\'s files — close them, then Retry (installer exit 6)');
      elevate.discard(aside[0]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install: an exit code it does not explain is marked so the runner may', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');
  assert.match(src, /err\.genericExit = !WIN_INSTALLER_CODES\[r\.status\];/);
});

test('app: the window\'s and the schedule\'s update runs can ask the helper', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.equal((main.match(/inUse: whoUsesFolder/g) || []).length, 2);
  assert.match(main, /function whoUsesFolder\(folder\) \{\s*return inuse\.namesUsing\(folder, \{ helperPath: installerHelperPath\(\), runHelper: elevate\.runHelper \}\);/);
});
