'use strict';

// "Ask for administrator permission once per update run" (PROJECT-one-admin-prompt.md).
//
// With the setting on, an installer whose silent run failed for lack of administrator
// rights is SET ASIDE by the runner instead of opening its own window, and everything set
// aside is handed to the installer helper together when the window's run ends: one Windows
// prompt for all of them. These tests cover each link - the runner, src/elevate.js, the
// app's two handlers and the window's loop - with the helper itself replaced by a stand-in,
// so nothing here can make Windows show a prompt. The real helper is tested in
// helper.test.js and in helper/ (cargo test).

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');

const elevate = require('../src/elevate');
const helper = require('../src/helper');
const github = require('../src/github');
const detect = require('../src/detect');
const install = require('../src/install');
const runner = require('../src/runner');
const state = require('../src/state');

const { CODES } = helper;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-elevate-'));
const windowsOnly = os.platform() === 'win32' ? false : 'the helper takes drive-letter paths: a Windows-only feature';

// --- the switches the helper is given ------------------------------------------------------

test('switchesFor: the same silent switches a normal run uses, in the helper\'s two kinds', () => {
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'msi' }), { kind: 'msi', args: ['/qn', '/norestart'] });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'msi', args: ['/quiet', 'ALLUSERS=1'] }), { kind: 'msi', args: ['/quiet', 'ALLUSERS=1'] });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'nsis' }), { kind: 'exe', args: ['/S'] });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'inno' }), { kind: 'exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'] });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'exe', args: ['/quiet', '/norestart'] }), { kind: 'exe', args: ['/quiet', '/norestart'] });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'exe', switchless: true }), { kind: 'exe', args: [] });
  // A verbatim switch string goes through untouched, for an .exe and for an .msi.
  const raw = '/Q /C:"msiexec /i ""vcredist.msi"" /quiet /norestart"';
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'exe', rawArgs: `  ${raw} ` }), { kind: 'exe', raw });
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'msi', rawArgs: '/qn REBOOT=ReallySuppress' }), { kind: 'msi', raw: '/qn REBOOT=ReallySuppress' });
  // Pinned switches win over a verbatim string, as in a normal run.
  assert.deepStrictEqual(elevate.switchesFor({ kind: 'nsis', args: ['/S', '/D=C:\\X'], rawArgs: '/other' }), { kind: 'exe', args: ['/S', '/D=C:\\X'] });
});

test('switchesFor: kinds the helper does not run are not taken', () => {
  for (const kind of ['pkg', 'deb', 'rpm', 'msix', undefined]) assert.strictEqual(elevate.switchesFor({ kind }), null, String(kind));
  assert.strictEqual(elevate.switchesFor(null), null);
  // A plain .exe with no switches declared never runs silently, here or anywhere.
  assert.throws(() => elevate.switchesFor({ kind: 'exe' }), /needs explicit ones/);
});

// --- finish(): the end of the run ----------------------------------------------------------

// A stand-in for the helper: answers --verify and --install with what the test says, and
// records the job it was handed each time.
function fakeHelper(answers) {
  const calls = [];
  const spawn = (exe, args, options) => {
    const mode = args[0];
    const job = fs.readFileSync(args[2], 'utf8');
    calls.push({ exe, mode, job, options, files: job.split('\n').filter((l) => l.startsWith('file ')).map((l) => l.slice(5)) });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const answer = answers[mode];
    setImmediate(() => {
      if (answer.error) return child.emit('error', new Error(answer.error));
      if (answer.stdout !== undefined) child.stdout.emit('data', Buffer.from(answer.stdout));
      else if (answer.codes) child.stdout.emit('data', Buffer.from(`${helper.RESULTS_HEADER}\n${answer.codes.map((c, i) => (c === null ? '' : `${i} ${c}\n`)).join('')}`));
      child.emit('close', answer.exit === undefined ? 0 : answer.exit);
    });
    return child;
  };
  return { spawn, calls };
}

function entriesIn(stageBase, names) {
  const log = [];
  const entries = names.map((name, i) => {
    const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
    fs.writeFileSync(path.join(keepDir, `${name}.exe`), 'MZ');
    return {
      key: `acme/${name}#installer`,
      item: { file: `C:\\stage\\${name}.exe`, sha256: String(i).repeat(64), kind: 'exe', args: ['/S'] },
      keepDir,
      succeed: () => { log.push(`succeed ${name}`); return { id: `acme/${name}#installer`, status: 'updated' }; },
      ownWindow: () => { log.push(`window ${name}`); return { id: `acme/${name}#installer`, status: 'failed', reason: 'installer window opened — approve the UAC prompt and finish it, then Check' }; },
      fail: (reason) => ({ id: `acme/${name}#installer`, status: 'failed', reason }),
    };
  });
  return { entries, log };
}

const leftIn = (dir) => fs.readdirSync(dir).sort();

test('finish: one --verify, one --install, and each installer gets its own result', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = entriesIn(stageBase, ['a', 'b', 'c', 'd']);
    const { spawn, calls } = fakeHelper({ '--verify': { codes: [0, 0, 0, 0] }, '--install': { codes: [0, 3010, 1603, CODES.timedOut] } });
    const out = await elevate.finish(entries, { helperPath: 'C:\\app\\helper.exe', stageBase, spawn });

    assert.deepStrictEqual(calls.map((c) => [c.exe, c.mode, c.files.length]), [['C:\\app\\helper.exe', '--verify', 4], ['C:\\app\\helper.exe', '--install', 4]]);
    assert.ok(calls.every((c) => c.job.startsWith(`${helper.JOB_HEADER}\ntimeout 600\n`)), 'ten minutes per installer, as a normal run');
    assert.ok(calls.every((c) => c.options.windowsHide === true && !c.options.shell), 'never through a shell');
    assert.deepStrictEqual(log, ['succeed a', 'succeed b'], '0 and 3010 are an installer saying it succeeded');
    assert.strictEqual(out.get('acme/a#installer').status, 'updated');
    assert.strictEqual(out.get('acme/b#installer').status, 'updated');
    assert.match(out.get('acme/c#installer').reason, /^installer failed \(exit 1603\)/, 'elevated, 1603 no longer means "needs administrator rights"');
    assert.match(out.get('acme/d#installer').reason, /did not finish in time/);
    assert.deepStrictEqual(leftIn(stageBase), [], 'every kept installer and both job files are removed');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('finish: an unsigned installer opens its own window, a changed one fails, and only the rest are asked for', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = entriesIn(stageBase, ['good', 'unsigned', 'swapped', 'alsogood']);
    const { spawn, calls } = fakeHelper({ '--verify': { codes: [0, CODES.notSigned, CODES.hashMismatch, 0] }, '--install': { codes: [0, 0] } });
    const out = await elevate.finish(entries, { helperPath: 'h.exe', stageBase, spawn });

    assert.deepStrictEqual(calls[1].files, ['C:\\stage\\good.exe', 'C:\\stage\\alsogood.exe'], 'the prompt covers only what the helper will run');
    assert.deepStrictEqual(log, ['window unsigned', 'succeed good', 'succeed alsogood']);
    assert.match(out.get('acme/unsigned#installer').reason, /^installer window opened/);
    assert.match(out.get('acme/swapped#installer').reason, /changed after it was downloaded/);
    assert.strictEqual(out.get('acme/alsogood#installer').status, 'updated', 'results are matched to the installers that were asked for');
    assert.deepStrictEqual(leftIn(stageBase), [path.basename(entries[1].keepDir)], 'only the file its own window is using is kept');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('finish: nothing the helper will take means no prompt at all', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = entriesIn(stageBase, ['a', 'b']);
    const { spawn, calls } = fakeHelper({ '--verify': { codes: [CODES.notSigned, CODES.notAnInstaller] } });
    const out = await elevate.finish(entries, { helperPath: 'h.exe', stageBase, spawn });
    assert.deepStrictEqual(calls.map((c) => c.mode), ['--verify']);
    assert.deepStrictEqual(log, ['window a']);
    assert.match(out.get('acme/b#installer').reason, /not an installer that can be run with administrator permission/);
    assert.strictEqual((await elevate.finish([], { helperPath: 'h.exe', stageBase, spawn })).size, 0);
    assert.strictEqual(calls.length, 1, 'and nothing set aside starts nothing');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('finish: answering No (or letting the prompt time out) installs nothing and opens nothing', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = entriesIn(stageBase, ['a', 'b']);
    const { spawn } = fakeHelper({ '--verify': { codes: [0, 0] }, '--install': { exit: CODES.declined, stdout: '' } });
    const out = await elevate.finish(entries, { helperPath: 'h.exe', stageBase, spawn });
    assert.deepStrictEqual(log, []);
    for (const e of entries) assert.strictEqual(out.get(e.key).reason, 'administrator permission was not given — Retry');
    assert.deepStrictEqual(leftIn(stageBase), []);
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('finish: if the helper cannot be used, every installer opens its own window as before', async () => {
  const cases = [
    ['the helper is missing', { '--verify': { error: 'spawn ENOENT' } }],
    ['--verify exits with an error', { '--verify': { exit: CODES.badJob, stdout: '' } }],
    ['--verify prints something else', { '--verify': { stdout: 'nonsense' } }],
    ['--install cannot elevate', { '--verify': { codes: [0, 0] }, '--install': { exit: CODES.elevationFailed, stdout: '' } }],
    ['--install returns no results', { '--verify': { codes: [0, 0] }, '--install': { exit: CODES.noResults, stdout: '' } }],
    ['--install prints something else', { '--verify': { codes: [0, 0] }, '--install': { stdout: `${helper.RESULTS_HEADER}\n9 0\n` } }],
    ['--install cannot be started', { '--verify': { codes: [0, 0] }, '--install': { error: 'spawn EACCES' } }],
  ];
  for (const [what, answers] of cases) {
    const stageBase = tmp();
    try {
      const { entries, log } = entriesIn(stageBase, ['a', 'b']);
      const out = await elevate.finish(entries, { helperPath: 'h.exe', stageBase, spawn: fakeHelper(answers).spawn });
      assert.deepStrictEqual(log, ['window a', 'window b'], what);
      for (const e of entries) assert.match(out.get(e.key).reason, /^installer window opened/, what);
      assert.strictEqual(leftIn(stageBase).length, 2, `${what}: both files are kept for their windows`);
    } finally {
      fs.rmSync(stageBase, { recursive: true, force: true });
    }
  }
});

test('finish: every app gets an answer, whatever goes wrong', async () => {
  const stageBase = tmp();
  try {
    // An installer the run never reached, one whose record step throws, one whose window cannot open.
    const { entries } = entriesIn(stageBase, ['reached', 'never', 'recordfails', 'nowindow']);
    entries[2].succeed = () => { throw new Error('could not save the state file'); };
    entries[3].ownWindow = () => { throw new Error('needs administrator rights'); };
    const { spawn } = fakeHelper({ '--verify': { codes: [0, 0, 0, CODES.notSigned] }, '--install': { codes: [0, null, 0] } });
    const out = await elevate.finish(entries, { helperPath: 'h.exe', stageBase, spawn });
    assert.strictEqual(out.get('acme/reached#installer').status, 'updated');
    assert.match(out.get('acme/never#installer').reason, /stopped before this installer — Retry/);
    assert.strictEqual(out.get('acme/recordfails#installer').reason, 'could not save the state file');
    assert.strictEqual(out.get('acme/nowindow#installer').reason, 'needs administrator rights');
    assert.deepStrictEqual(leftIn(stageBase), []);

    // A job that cannot even be written (here: a path the helper would refuse).
    const bad = entriesIn(stageBase, ['x']);
    bad.entries[0].item.file = 'relative.exe';
    const again = await elevate.finish(bad.entries, { helperPath: 'h.exe', stageBase, spawn });
    assert.deepStrictEqual(bad.log, ['window x']);
    assert.match(again.get('acme/x#installer').reason, /^installer window opened/);
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

// --- the runner: setting an installer aside --------------------------------------------------

async function withRelease(fn) {
  const real = {
    getLatestRelease: github.getLatestRelease,
    downloadAsset: github.downloadAsset,
    verifyDigest: github.verifyDigest,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning,
    clearCache: detect.clearCache,
    installedVersion: detect.installedVersion,
    installInstaller: install.installInstaller,
  };
  github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: [{ name: 'payload.zip', browser_download_url: 'https://example.invalid/payload.zip' }] });
  github.downloadAsset = async (_url, file) => {
    const zip = new AdmZip();
    zip.addFile('app.txt', Buffer.from('v2'));
    zip.writeZip(file);
  };
  github.verifyDigest = () => ({ skipped: true, note: 'no digest in test' });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => '1.0.0';
  // What a silent run does without administrator rights: an .exe cannot start, an .msi ends 1603.
  install.installInstaller = () => { throw Object.assign(new Error('requires elevation'), { elevation: true }); };
  try {
    return await fn();
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, verifyDigest: real.verifyDigest, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, { isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion });
    install.installInstaller = real.installInstaller;
  }
}

const widget = () => ({ portableRoot: '', repos: [{ owner: 'acme', repo: 'widget', type: 'installer', asset: 'payload.zip', install: { kind: 'nsis' } }] });

test('runner: with the setting on, an installer that needs administrator rights is set aside, not opened', { skip: windowsOnly }, async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  const opened = [];
  const aside = [];
  try {
    await withRelease(async () => {
      const { results } = await runner.run(widget(), { statePath, openFile: (f) => opened.push(f), setAside: (e) => aside.push(e) });
      assert.strictEqual(results[0].status, 'failed');
      assert.strictEqual(results[0].needsAdmin, true);
      assert.strictEqual(results[0].reason, 'waiting for administrator permission');
    });
    assert.deepStrictEqual(opened, [], 'no installer window');
    assert.strictEqual(aside.length, 1);
    const entry = aside[0];
    assert.strictEqual(entry.key, 'acme/widget#installer');
    assert.deepStrictEqual({ kind: entry.item.kind, args: entry.item.args }, { kind: 'exe', args: ['/S'] });
    assert.ok(fs.existsSync(entry.item.file), 'the installer outlives the download folder');
    assert.strictEqual(entry.item.sha256, require('crypto').createHash('sha256').update(fs.readFileSync(entry.item.file)).digest('hex'));
    assert.ok(!fs.existsSync(statePath), 'nothing is recorded as installed yet');

    // Later, the administrator run succeeds. Other apps were updated in between: the record
    // is written into the state as it stands THEN, not the copy this run loaded.
    fs.writeFileSync(statePath, JSON.stringify({ 'other/app#portable': { version: '9.9.9' } }));
    const done = entry.succeed();
    assert.strictEqual(done.status, 'updated');
    assert.strictEqual(done.lastAction, 'updated');
    const saved = state.load(statePath);
    assert.strictEqual(saved['acme/widget#installer'].version, '2.0.0');
    assert.strictEqual(saved['other/app#portable'].version, '9.9.9', 'the later update was not overwritten');

    // Or it cannot be run by the helper: its own window, from the kept file, with the wording the window waits on.
    const windowed = entry.ownWindow();
    assert.deepStrictEqual(opened, [entry.item.file]);
    assert.match(windowed.reason, /^installer window opened — approve the UAC prompt/);
    assert.deepStrictEqual(entry.fail('administrator permission was not given — Retry').reason, 'administrator permission was not given — Retry');
  } finally {
    for (const e of aside) elevate.discard(e);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a scheduled run never sets anything aside, and the setting off changes nothing', { skip: windowsOnly }, async () => {
  const dir = tmp();
  const opened = [];
  const aside = [];
  try {
    await withRelease(async () => {
      const unattended = await runner.run(widget(), { statePath: path.join(dir, 'a.json'), unattended: true, openFile: (f) => opened.push(f), setAside: (e) => aside.push(e) });
      assert.match(unattended.results[0].reason, /^needs you: widget's installer needs administrator permission/);
      assert.deepStrictEqual([opened.length, aside.length], [0, 0]);
      const off = await runner.run(widget(), { statePath: path.join(dir, 'b.json'), openFile: (f) => opened.push(f) });
      assert.match(off.results[0].reason, /^installer window opened/);
      assert.strictEqual(off.results[0].needsAdmin, undefined);
      assert.strictEqual(opened.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an installer that fails for another reason is not set aside', { skip: windowsOnly }, async () => {
  const dir = tmp();
  const aside = [];
  try {
    await withRelease(async () => {
      install.installInstaller = () => { throw Object.assign(new Error('another installer is already running — wait for it to finish, then Retry'), { status: 1618 }); };
      const { results } = await runner.run(widget(), { statePath: path.join(dir, 's.json'), openFile: () => {}, setAside: (e) => aside.push(e) });
      assert.match(results[0].reason, /another installer is already running/);
      assert.strictEqual(aside.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the app: the two handlers ---------------------------------------------------------------

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
function between(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} ... ${end}`);
  return src.slice(a, b);
}

function appHandlers({ config, helperThere = true }) {
  const handlers = {};
  const seen = { runs: [], finished: [], discarded: [], progress: [] };
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    core: { validateConfig: (c) => c },
    readConfig: () => config,
    state: { acquireLock: () => 'lock', releaseLock: () => {} },
    shell: { openPath: () => {} },
    path,
    paths: { dataDir: () => 'C:\\data' },
    whoUsesFolder: async () => [],
    adminRun: () => (helperThere ? { helperPath: 'C:\\app\\resources\\helper\\git-updater-helper.exe' } : null),
    runner: {
      run: async (_config, opts) => {
        seen.runs.push(opts);
        if (opts.setAside) opts.setAside({ key: opts.only, keepDir: `keep-${opts.only}-${seen.runs.length}` });
        return { results: [{ id: opts.only, status: 'failed', needsAdmin: !!opts.setAside }] };
      },
    },
    elevate: {
      discard: (entry) => { if (entry) seen.discarded.push(entry.keepDir); },
      finish: async (entries, opts) => {
        seen.finished.push({ keys: entries.map((e) => e.key), opts });
        return new Map(entries.map((e) => [e.key, { id: e.key, status: 'updated' }]));
      },
    },
  };
  vm.runInNewContext(between(mainSrc, 'const pendingAdmin = new Map();', '// Downloads+verifies+extracts the new build'), context);
  const sender = { send: (channel, data) => seen.progress.push([channel, data]) };
  return { update: (body) => handlers.update({ sender }, body), admin: (body) => handlers['update:admin']({ sender }, body), seen };
}

test('app: the setting is read from the saved settings, and only then is anything set aside', async () => {
  const on = appHandlers({ config: { adminPromptOnce: true } });
  await on.update({ only: 'a' });
  assert.strictEqual(typeof on.seen.runs[0].setAside, 'function');
  await on.update({ only: 'a', dryRun: true });
  assert.strictEqual(on.seen.runs[1].setAside, undefined, 'a dry run sets nothing aside');

  const off = appHandlers({ config: {} });
  await off.update({ only: 'a', adminPromptOnce: true });
  assert.strictEqual(off.seen.runs[0].setAside, undefined, 'the window cannot switch it on by asking');

  const noHelper = appHandlers({ config: { adminPromptOnce: true }, helperThere: false });
  await noHelper.update({ only: 'a' });
  assert.strictEqual(noHelper.seen.runs[0].setAside, undefined, 'without the helper, the installer window route is kept');
});

test('app: update:admin runs what was set aside for the apps asked for, once, and drops the rest', async () => {
  const app = appHandlers({ config: { adminPromptOnce: true } });
  await app.update({ only: 'a' });
  await app.update({ only: 'b' });
  await app.update({ only: 'a' }); // a second attempt for the same app replaces the first
  await app.update({ only: 'c' });
  assert.deepStrictEqual(app.seen.discarded, ['keep-a-1']);

  const { results } = await app.admin({ keys: ['a', 'b', 'never-set-aside'] });
  assert.deepStrictEqual(app.seen.finished.map((f) => f.keys), [['a', 'b']]);
  assert.strictEqual(app.seen.finished[0].opts.helperPath, 'C:\\app\\resources\\helper\\git-updater-helper.exe');
  assert.strictEqual(app.seen.finished[0].opts.stageBase, path.join('C:\\data', 'staging'));
  assert.deepStrictEqual(results.map((r) => [r.id, r.status]), [['a', 'updated'], ['b', 'updated'], ['never-set-aside', 'failed']]);
  assert.match(results[2].reason, /nothing was waiting for administrator permission/);
  assert.ok(app.seen.discarded.includes('keep-c-4'), 'an app that was not asked for is dropped, not run later');
  assert.deepStrictEqual(app.seen.progress.map(([c, d]) => [c, d.id, d.phase]), [['update:progress', 'a', 'admin'], ['update:progress', 'b', 'admin']]);

  const again = await app.admin({ keys: ['a', 'b', 'c'] });
  assert.deepStrictEqual(app.seen.finished[1].keys, [], 'nothing is run twice');
  assert.ok(again.results.every((r) => r.status === 'failed'));
});

test('app: the scheduled run is never given the setting, and the window can reach the new handler', () => {
  const scheduled = mainSrc.split('\n').filter((l) => l.includes('runner.run(') && l.includes('unattended: true'));
  assert.ok(scheduled.length >= 1);
  for (const line of scheduled) assert.ok(!line.includes('setAside'), line.trim());
  assert.match(preloadSrc, /updateAdmin: \(body\) => ipcRenderer\.invoke\('update:admin', body\)/);
  assert.ok(mainSrc.includes('adminPromptOnce: adminStatus().offered }));'), 'the window is told whether the setting is offered here');
  assert.match(mainSrc, /if \(cfg\.adminPromptOnce != null\) cfg\.adminPromptOnce = !!cfg\.adminPromptOnce;/);
  // Packaged, the helper sits beside the app's resources; it is never looked for anywhere a user file could stand in.
  const where = between(mainSrc, 'function installerHelperPath()', '// Installers set aside during');
  assert.match(where, /process\.platform !== 'win32'\) return null/);
  assert.match(where, /path\.join\(process\.resourcesPath, 'helper', 'git-updater-helper\.exe'\)/);
});

// --- the window ------------------------------------------------------------------------------

function windowRun({ updates, admin }) {
  const calls = [];
  const watched = [];
  const shown = [];
  const context = {
    busy: false,
    st: {},
    renderRepos: () => {},
    holdVisible: () => {},
    msg: (text, cls) => shown.push([text, cls]),
    clean: (e) => String(e && e.message ? e.message : e),
    nameOfKey: (k) => k,
    watchInstall: (k, _from, _wasInstall, onComplete) => watched.push([k, typeof onComplete]),
    window: {
      api: {
        update: async (body) => { calls.push(`update ${body.only}`); return { results: [{ id: body.only, ...updates[body.only] }] }; },
        updateAdmin: async (body) => { calls.push(`admin ${body.keys.join('+')}`); return admin(body.keys); },
        openApp: async (k) => { calls.push(`reopen ${k}`); },
      },
    },
  };
  vm.runInNewContext(between(html, 'async function runBatch(', 'window.api.onProgress('), context);
  return { context, calls, watched, shown };
}

test('window: installers set aside are asked for once, after every app has had its turn', async () => {
  const w = windowRun({
    updates: {
      a: { status: 'failed', needsAdmin: true, reason: 'waiting for administrator permission', to: '2.0', closed: true },
      b: { status: 'updated', to: '3.0', closed: true },
      c: { status: 'failed', needsAdmin: true, reason: 'waiting for administrator permission', to: '4.0' },
    },
    admin: () => ({ results: [{ id: 'c', status: 'updated', to: '4.0' }, { id: 'a', status: 'updated', to: '2.0' }] }),
  });
  w.context.st = { a: { present: true }, b: { present: true }, c: {} };
  await w.context.runBatch(['a', 'b', 'c'], false, true);
  assert.deepStrictEqual(w.calls, ['update a', 'update b', 'reopen b', 'update c', 'admin a+c', 'reopen a'], 'an app closed for its update is re-opened only once it is installed');
  assert.deepStrictEqual([w.context.st.a.ph, w.context.st.b.ph, w.context.st.c.ph], ['updated', 'updated', 'installed']);
  assert.deepStrictEqual(w.shown.at(-1), ['2 updated, 1 installed.', 'ok']);
});

test('window: permission not given, an installer handed to its own window, and a failed call are each shown', async () => {
  const waiting = { status: 'failed', needsAdmin: true, reason: 'waiting for administrator permission', closed: true };
  const declined = windowRun({
    updates: { a: waiting, b: waiting },
    admin: () => ({ results: [{ id: 'a', status: 'failed', reason: 'administrator permission was not given — Retry' }, { id: 'b', status: 'failed', reason: 'installer window opened — approve the UAC prompt and finish it, then Check' }] }),
  });
  declined.context.st = { a: { present: true }, b: { present: true } };
  await declined.context.runBatch(['a', 'b'], false, true);
  assert.deepStrictEqual([declined.context.st.a.ph, declined.context.st.a.reason], ['failed', 'administrator permission was not given — Retry']);
  assert.strictEqual(declined.context.st.b.ph, 'waiting', 'its own installer window is open, so the row waits for it');
  assert.deepStrictEqual(declined.watched, [['b', 'function']], 'and the app is re-opened when that installer finishes');
  assert.deepStrictEqual(declined.calls, ['update a', 'update b', 'admin a+b', 'reopen a']);
  assert.deepStrictEqual(declined.shown.at(-1), ['1 waiting for its installer window, 1 failed.', 'bad']);

  const broken = windowRun({ updates: { a: waiting }, admin: () => { throw new Error('an update is already in progress'); } });
  broken.context.st = { a: { present: true } };
  await broken.context.runBatch(['a'], false, true);
  assert.deepStrictEqual([broken.context.st.a.ph, broken.context.st.a.reason], ['failed', 'an update is already in progress']);
  assert.deepStrictEqual(broken.calls, ['update a', 'admin a', 'reopen a']);
  assert.strictEqual(broken.context.busy, false);
});

test('window: with nothing set aside the run is exactly as before, and the new handler is never called', async () => {
  const w = windowRun({ updates: { a: { status: 'updated', to: '2.0' }, b: { status: 'failed', reason: 'download failed' } }, admin: () => { throw new Error('must not be called'); } });
  w.context.st = { a: { present: true }, b: { present: true } };
  await w.context.runBatch(['a', 'b'], false, false);
  assert.deepStrictEqual(w.calls, ['update a', 'update b']);
  assert.deepStrictEqual(w.shown.at(-1), ['1 updated, 1 failed.', 'bad']);
});

test('window: the setting is in Settings > Updating, off and hidden until the app says it can work here', async () => {
  const updating = between(html, 'id="sg-updating"', '</section>');
  assert.match(updating, /<div id="adminPromptOnceBlock" hidden>/);
  assert.match(updating, /<input type="checkbox" id="adminPromptOnce"> Ask for administrator permission once per update run<\/label>/);
  assert.ok(!/id="adminPromptOnce"[^>]*checked/.test(html), 'off unless the user turns it on');
  assert.match(html, /\$\('adminPromptOnce'\)\.checked = !!config\.adminPromptOnce;/);

  const block = between(html, "$('adminPromptOnce').onchange", "$('requireChecksum').onchange");
  for (const answer of [{ adminPromptOnce: true }, { adminPromptOnce: false }, {}]) {
    const els = { ...needsEls(), adminPromptOnce: { checked: true }, adminPromptOnceBlock: { hidden: true } };
    const saved = [];
    const config = {};
    const ctx = { $: (id) => els[id], config, saveConfig: async () => { saved.push({ ...config }); }, msg: () => {}, window: { addEventListener: () => {}, api: { getPlatform: async () => answer, adminStatus: async () => ({}) } } };
    vm.runInNewContext(block, ctx);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(els.adminPromptOnceBlock.hidden, !answer.adminPromptOnce, JSON.stringify(answer));
    els.adminPromptOnce.onchange();
    assert.deepStrictEqual(saved, [{ adminPromptOnce: true }], 'ticking it saves it');
  }
});

test('window: a row says what it is waiting for', () => {
  const view = between(html, 'function statusViewOf(s) {', 'function primaryAction(s)');
  const ctx = { datedStatus: () => ({}) };
  vm.runInNewContext(`${view}; this.statusViewOf = statusViewOf;`, ctx);
  assert.strictEqual(ctx.statusViewOf({ ph: 'needsAdmin' }).text, 'Waiting for administrator permission');
  assert.match(ctx.statusViewOf({ ph: 'needsAdmin' }).tip, /Windows will ask once, at the end of this run/);
  assert.strictEqual(ctx.statusViewOf({ ph: 'admin' }).text, 'Installing — approve the Windows prompt');
  assert.match(html, /const WORKING_PHASES = \[[^\]]*'needsAdmin', 'admin'\]/, 'both count as "Working now" in the status filter');
});

// --- Linux: one password prompt (PROJECT-linux-one-password-prompt.md) -------------------------
//
// On Debian and Ubuntu family Linux there is no helper: pkexec raises the desktop's password
// prompt and a fixed script installs each package with apt-get. pkexec is replaced by a
// stand-in here, so nothing can raise a prompt. The script itself runs for real, as root,
// against real packages in test/admin-linux.test.js (CI, Ubuntu).

// A stand-in for pkexec: prints what the test says, exits how the test says, records its argv.
function fakePkexec(answer) {
  const calls = [];
  const spawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    setImmediate(() => {
      if (answer.error) return child.emit('error', new Error(answer.error));
      if (answer.stdout) child.stdout.emit('data', Buffer.from(answer.stdout));
      child.emit('close', answer.exit === undefined ? 0 : answer.exit);
    });
    return child;
  };
  return { spawn, calls };
}

const LINUX = { pkexec: '/usr/bin/pkexec', sh: '/usr/bin/sh' };

function debEntriesIn(stageBase, names) {
  const log = [];
  const entries = names.map((name, i) => {
    const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
    const file = path.join(keepDir, `${name}.deb`);
    fs.writeFileSync(file, '!<arch>\n');
    return {
      key: `acme/${name}#installer`,
      item: { file, sha256: String(i).repeat(64), kind: 'deb' },
      keepDir,
      succeed: () => { log.push(`succeed ${name}`); return { id: `acme/${name}#installer`, status: 'updated' }; },
      ownWindow: () => { log.push(`window ${name}`); return { id: `acme/${name}#installer`, status: 'failed', reason: 'installer window opened — authorize and finish it, then Check' }; },
      fail: (reason) => ({ id: `acme/${name}#installer`, status: 'failed', reason }),
    };
  });
  return { entries, log };
}

test('linux: the tools are looked for in the system folders only, and all three are needed', () => {
  const having = (...files) => (f) => files.includes(f);
  assert.strictEqual(elevate.linuxTools(() => true, 'win32'), null, 'Windows has its helper instead');
  assert.strictEqual(elevate.linuxTools(() => true, 'darwin'), null);
  assert.deepStrictEqual(elevate.linuxTools(() => true, 'linux'), { pkexec: '/usr/bin/pkexec', sh: '/usr/bin/sh' });
  assert.deepStrictEqual(
    elevate.linuxTools(having('/usr/bin/pkexec', '/bin/sh', '/usr/bin/apt-get'), 'linux'),
    { pkexec: '/usr/bin/pkexec', sh: '/bin/sh' }
  );
  assert.strictEqual(elevate.linuxTools(having('/usr/bin/pkexec', '/bin/sh'), 'linux'), null, 'no apt-get: an rpm system');
  assert.strictEqual(elevate.linuxTools(having('/bin/sh', '/usr/bin/apt-get'), 'linux'), null, 'no pkexec');
  assert.strictEqual(elevate.linuxTools(having('/home/me/bin/pkexec', '/bin/sh', '/usr/bin/apt-get'), 'linux'), null, 'a pkexec in a user folder is not used');
});

test('linux: a .deb is set aside with its SHA-256; one with pinned dpkg switches keeps its own route', async () => {
  const dir = tmp();
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const file = path.join(dir, 'widget_2.0_amd64.deb');
    fs.writeFileSync(file, '!<arch>\nwidget');
    const kept = await elevate.setAsideEntry(file, stageBase, { kind: 'deb' });
    assert.ok(kept);
    assert.deepStrictEqual(Object.keys(kept.item).sort(), ['file', 'kind', 'sha256']);
    assert.strictEqual(kept.item.kind, 'deb');
    assert.strictEqual(path.basename(kept.item.file), 'widget_2.0_amd64.deb');
    assert.notStrictEqual(kept.item.file, file, 'a copy: the download folder is removed when the app\'s run ends');
    assert.strictEqual(kept.item.sha256, require('crypto').createHash('sha256').update('!<arch>\nwidget').digest('hex'));
    elevate.discard(kept);

    assert.strictEqual(await elevate.setAsideEntry(file, stageBase, { kind: 'deb', args: ['--force-overwrite', '-i'] }), null, 'apt-get takes no dpkg switches');
    assert.strictEqual(await elevate.setAsideEntry(file, stageBase, { kind: 'rpm' }), null, 'an .rpm is not taken');
    assert.deepStrictEqual(leftIn(stageBase), [], 'nothing is left behind for what was not taken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linux: one pkexec, never a shell of git-updater\'s own, and each package gets its own result', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = debEntriesIn(stageBase, ['good', 'baddep', 'changed', 'unreached']);
    const pk = fakePkexec({
      stdout: [
        'git-updater-admin 1',
        'result 0 exit 0',
        'reason 1  gu-bad : Depends: gu-nope but it is not installable',
        'reason 1 E: Unable to correct problems, you have held broken packages.',
        'result 1 exit 100',
        'result 2 hash',
        '',
      ].join('\n'),
    });
    const out = await elevate.finish(entries, { linux: LINUX, stageBase, spawn: pk.spawn });

    assert.strictEqual(pk.calls.length, 1, 'ONE command: one password prompt');
    const { exe, args, options } = pk.calls[0];
    assert.strictEqual(exe, '/usr/bin/pkexec');
    assert.ok(!options.shell, 'pkexec is started directly');
    assert.deepStrictEqual(args.slice(0, 6), ['--disable-internal-agent', '/usr/bin/sh', '-c', elevate.ADMIN_SCRIPT, 'git-updater-admin', String(elevate.TIMEOUT_SECS)]);
    assert.deepStrictEqual(args.slice(6), entries.flatMap((e) => [e.item.sha256, e.item.file]), 'then one <sha256> <file> pair per package, in order');

    assert.deepStrictEqual(log, ['succeed good']);
    const by = (name) => out.get(`acme/${name}#installer`);
    assert.strictEqual(by('good').status, 'updated');
    assert.strictEqual(by('baddep').reason, 'the package could not be installed: gu-bad : Depends: gu-nope but it is not installable');
    assert.match(by('changed').reason, /changed after it was downloaded, so it was not run/);
    assert.match(by('unreached').reason, /stopped before this installer — Retry/);
    assert.deepStrictEqual(leftIn(stageBase), [], 'every kept file is removed');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('linux: a dismissed password prompt installs nothing and opens nothing', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = debEntriesIn(stageBase, ['a', 'b']);
    const pk = fakePkexec({ exit: elevate.PKEXEC_DISMISSED });
    const out = await elevate.finish(entries, { linux: LINUX, stageBase, spawn: pk.spawn });
    assert.deepStrictEqual(log, []);
    assert.deepStrictEqual([...out.values()].map((r) => r.reason), [elevate.DECLINED, elevate.DECLINED]);
    assert.deepStrictEqual(leftIn(stageBase), []);
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('linux: when no password prompt can be used, every package opens its own window as before', async () => {
  for (const answer of [{ exit: 127 }, { error: 'spawn /usr/bin/pkexec ENOENT' }, { exit: 0, stdout: 'not what the script prints\n' }]) {
    const stageBase = tmp();
    try {
      const { entries, log } = debEntriesIn(stageBase, ['a', 'b']);
      const pk = fakePkexec(answer);
      const out = await elevate.finish(entries, { linux: LINUX, stageBase, spawn: pk.spawn });
      assert.deepStrictEqual(log, ['window a', 'window b'], JSON.stringify(answer));
      assert.ok([...out.values()].every((r) => /^installer window opened/.test(r.reason)));
      assert.strictEqual(leftIn(stageBase).length, 2, 'the windows are using the kept files: they stay');
    } finally {
      fs.rmSync(stageBase, { recursive: true, force: true });
    }
  }
});

test('linux: every app gets an answer, whatever goes wrong', async () => {
  const stageBase = tmp();
  try {
    const { entries } = debEntriesIn(stageBase, ['a', 'b', 'c']);
    entries[0].succeed = () => { throw new Error('could not read the installed version'); };
    entries[1].ownWindow = () => { throw new Error('needs administrator rights'); };
    const ok = fakePkexec({ stdout: 'git-updater-admin 1\nresult 0 exit 0\nresult 1 exit 124\nresult 2 copy\nresult 9 exit 0\n' });
    const out = await elevate.finish(entries, { linux: LINUX, stageBase, spawn: ok.spawn });
    assert.deepStrictEqual([...out.keys()], entries.map((e) => e.key));
    assert.strictEqual(out.get(entries[0].key).reason, 'could not read the installed version');
    assert.match(out.get(entries[1].key).reason, /did not finish in time and was stopped/);
    assert.match(out.get(entries[2].key).reason, /could not be prepared for the administrator run/);

    const again = debEntriesIn(stageBase, ['d']);
    again.entries[0].ownWindow = () => { throw new Error('needs administrator rights'); };
    const none = fakePkexec({ exit: 127 });
    const out2 = await elevate.finish(again.entries, { linux: LINUX, stageBase, spawn: none.spawn });
    assert.strictEqual(out2.get(again.entries[0].key).reason, 'needs administrator rights');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('linux: what the script printed is read strictly', () => {
  assert.strictEqual(elevate.parseAdminOutput('', 2), null, 'the script never started');
  assert.strictEqual(elevate.parseAdminOutput('result 0 exit 0\n', 1), null, 'no first line: not the script');
  assert.deepStrictEqual(
    elevate.parseAdminOutput('git-updater-admin 1\r\nresult 1 exit 100\r\nreason 1 E: broken\r\nresult 0 copy\r\nresult 5 exit 0\r\nresult x exit 0\r\nresult 0 exit\r\n', 3),
    [{ kind: 'copy', reasons: [] }, { kind: 'exit', code: 100, reasons: ['E: broken'] }, null]
  );
  assert.strictEqual(elevate.linuxReason({ kind: 'exit', code: 100, reasons: [] }), 'the package could not be installed (apt-get exit 100)');
  assert.strictEqual(elevate.linuxReason({ kind: 'exit', code: 100, reasons: ['E: Could not get lock /var/lib/dpkg/lock-frontend.'] }), 'the package could not be installed: Could not get lock /var/lib/dpkg/lock-frontend.');
  assert.match(elevate.linuxReason({ kind: 'exit', code: 137, reasons: [] }), /did not finish in time/);
});

test('linux: the root script uses a fixed PATH, the system\'s own tools, and nothing interactive', () => {
  const script = elevate.ADMIN_SCRIPT;
  assert.ok(!script.includes('\r'), 'LF only, whatever line endings this checkout has');
  const lines = script.split('\n');
  assert.strictEqual(lines[0], 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'the first thing it does');
  assert.ok(lines.includes('DEBIAN_FRONTEND=noninteractive'));
  assert.match(script, /apt-get install -y -q [^\n]*"\$copy" <\/dev\/null 2>&1/, 'the root-owned copy is what is installed, with no terminal to ask on');
  assert.match(script, /timeout -k 30 "\$limit" apt-get/, 'each package has its own time limit');
  assert.match(script, /sha256sum < "\$copy"/, 'the copy is what is checked');
  assert.match(script, /trap 'rm -rf "\$dir"' EXIT/, 'nothing is left behind');
  // POSIX sh only (dash on Debian and Ubuntu), and nothing fetched or elevated from inside it.
  for (const banned of ['[[', 'function ', 'local ', 'sudo', 'curl', 'wget', 'eval ', 'source ']) assert.ok(!script.includes(banned), banned);
});

const debWidget = () => ({ portableRoot: '', repos: [{ owner: 'acme', repo: 'widget', type: 'installer', asset: 'payload.deb', install: { kind: 'deb' } }] });

test('linux runner: with the setting on, a .deb that needs root is set aside, not opened', async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  const opened = [];
  const aside = [];
  const real = { getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset };
  try {
    await withRelease(async () => {
      github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: [{ name: 'payload.deb', browser_download_url: 'https://example.invalid/payload.deb' }] });
      github.downloadAsset = async (_url, file) => fs.writeFileSync(file, '!<arch>\nwidget 2.0.0');
      try {
        const { results } = await runner.run(debWidget(), { statePath, openFile: (f) => opened.push(f), setAside: (e) => aside.push(e) });
        assert.strictEqual(results[0].needsAdmin, true, results[0].reason);
        assert.strictEqual(results[0].reason, 'waiting for administrator permission');

        const unattended = await runner.run(debWidget(), { statePath, unattended: true, openFile: (f) => opened.push(f) });
        assert.match(unattended.results[0].reason, /needs administrator permission, so it was not run unattended/);
      } finally {
        Object.assign(github, real);
      }
    });
    assert.deepStrictEqual(opened, [], 'no installer window');
    assert.strictEqual(aside.length, 1);
    assert.strictEqual(aside[0].item.kind, 'deb');
    assert.ok(fs.existsSync(aside[0].item.file), 'the package outlives the download folder');
    const windowed = aside[0].ownWindow();
    assert.deepStrictEqual(opened, [aside[0].item.file], 'the fallback is still the desktop\'s own installer');
    assert.strictEqual(windowed.status, 'failed');
  } finally {
    for (const e of aside) elevate.discard(e);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linux app: what runs the set-aside installers is the helper on Windows, pkexec and apt-get on Linux', () => {
  const src = between(mainSrc, 'function adminRun()', '// Installers set aside during');
  const run = (helperPath, linux) => {
    const ctx = { installerHelperPath: () => helperPath, elevate: { linuxTools: () => linux } };
    vm.runInNewContext(`${src}; this.adminRun = adminRun;`, ctx);
    const got = ctx.adminRun();
    return got && { ...got }; // made in the other context: compare its own keys, not its prototype
  };
  assert.deepStrictEqual(run('C:\\app\\helper.exe', null), { helperPath: 'C:\\app\\helper.exe' });
  assert.deepStrictEqual(run(null, LINUX), { linux: LINUX });
  assert.strictEqual(run(null, null), null, 'neither: the setting is not offered');
  assert.match(mainSrc, /elevate\.finish\(entries, \{ \.\.\.adminRun\(\), stageBase:/);
});

test('linux window: the row and the setting speak of a password prompt, not a Windows one', async () => {
  const view = between(html, 'function statusViewOf(s) {', 'function primaryAction(s)');
  const ctx = { datedStatus: () => ({}) };
  vm.runInNewContext(`${view}; adminPromptKind = 'linux'; this.statusViewOf = statusViewOf;`, ctx);
  assert.strictEqual(ctx.statusViewOf({ ph: 'needsAdmin' }).text, 'Waiting for administrator permission');
  assert.match(ctx.statusViewOf({ ph: 'needsAdmin' }).tip, /asked for your password once, at the end of this run/);
  assert.strictEqual(ctx.statusViewOf({ ph: 'admin' }).text, 'Installing — enter your password in the prompt');

  const block = between(html, "$('adminPromptOnce').onchange", "$('requireChecksum').onchange");
  const els = { ...needsEls(), adminPromptOnce: { checked: false }, adminPromptOnceBlock: { hidden: true }, adminPromptOnceHint: { textContent: 'the Windows wording' } };
  const settings = { $: (id) => els[id], config: {}, saveConfig: async () => {}, msg: () => {}, adminPromptKind: 'windows', window: { addEventListener: () => {}, api: { getPlatform: async () => ({ adminPromptOnce: true, platform: 'linux' }), adminStatus: async () => ({}) } } };
  vm.runInNewContext(block, settings);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(els.adminPromptOnceBlock.hidden, false);
  assert.strictEqual(settings.adminPromptKind, 'linux');
  assert.match(els.adminPromptOnceHint.textContent, /behind one password prompt\. git-updater itself never runs as root\./);
  assert.ok(els.adminPromptOnceHint.textContent.length <= 220, 'as short as every other Settings hint');
  assert.match(html, /<p class="hint" id="adminPromptOnceHint">Installers that need administrator rights run together at the end, behind one Windows prompt\./, 'Windows keeps its wording');
});

// --- Linux: the setting is offered even when pkexec is not installed ---------------------------
//
// It was hidden unless pkexec was already there, which hid the feature from everyone who had
// one thing to install. Now it shows wherever apt-get is; ticked without pkexec, the window
// says so under the box and offers to install it.

// The elements of the "pkexec is not installed" notice, as the window's code sees them.
function needsEls() {
  return {
    adminPromptNeeds: { hidden: true },
    adminNeedsMsg: { textContent: '' },
    adminNeedsInstall: {},
    adminNeedsCopy: {},
    adminNeedsCheck: {},
  };
}

test('linux: the setting is offered wherever apt-get is, and says what is missing', () => {
  const having = (...files) => (f) => files.includes(f);
  assert.strictEqual(elevate.linuxStatus(() => true, 'win32'), null);
  assert.deepStrictEqual(elevate.linuxStatus(() => true, 'linux'), { missing: null });
  assert.deepStrictEqual(elevate.linuxStatus(having('/bin/sh', '/usr/bin/apt-get'), 'linux'), { missing: 'pkexec' }, 'offered, with the one thing it needs named');
  assert.strictEqual(elevate.linuxStatus(having('/bin/sh', '/usr/bin/pkexec'), 'linux'), null, 'no apt-get (an rpm system): nothing to install would make it work');
  assert.strictEqual(elevate.INSTALL_PKEXEC, 'sudo apt install pkexec');
});

test('linux: Install pkexec opens the default terminal on the install command, and nothing else', () => {
  const having = (...files) => (f) => files.includes(f);
  const started = [];
  const spawn = (exe, args, options) => {
    started.push({ exe, args, options });
    return { on: () => {}, unref: () => {} };
  };
  assert.strictEqual(elevate.installPkexecInTerminal(spawn, having('/bin/sh', '/usr/bin/x-terminal-emulator', '/usr/bin/konsole')), true);
  assert.deepStrictEqual(started[0].args, ['-e', '/bin/sh', '-c', elevate.INSTALL_PKEXEC_IN_TERMINAL]);
  assert.strictEqual(started[0].exe, '/usr/bin/x-terminal-emulator', 'the system\'s own choice of terminal comes first');
  assert.strictEqual(started[0].options.detached, true);
  assert.ok(!started[0].options.shell);
  assert.strictEqual(started.length, 1, 'one terminal');

  started.length = 0;
  assert.strictEqual(elevate.installPkexecInTerminal(spawn, having('/usr/bin/sh', '/usr/bin/gnome-terminal')), true);
  assert.deepStrictEqual([started[0].exe, started[0].args[0]], ['/usr/bin/gnome-terminal', '--'], 'each terminal gets its own switch');

  started.length = 0;
  const throwing = (exe, args, options) => { if (exe.endsWith('konsole')) throw new Error('EACCES'); return spawn(exe, args, options); };
  assert.strictEqual(elevate.installPkexecInTerminal(throwing, having('/bin/sh', '/usr/bin/konsole', '/usr/bin/xterm')), true);
  assert.deepStrictEqual(started.map((s) => s.exe), ['/usr/bin/xterm'], 'one that will not start is passed over');

  started.length = 0;
  assert.strictEqual(elevate.installPkexecInTerminal(spawn, having('/bin/sh')), false, 'no terminal: the window shows the command to copy');
  assert.strictEqual(elevate.installPkexecInTerminal(spawn, having('/home/me/bin/konsole', '/bin/sh')), false, 'a terminal in a user folder is not used');
  assert.deepStrictEqual(started, []);

  const line = elevate.INSTALL_PKEXEC_IN_TERMINAL;
  assert.ok(line.startsWith('sudo apt install pkexec && '), 'exactly the command the window shows');
  assert.strictEqual(line.split('sudo').length, 2, 'sudo is used once, for that command');
  assert.match(line, /pkexec was NOT installed/, 'a failure is said in the terminal, which stays open');
  assert.match(line, /read _$/);
});

test('linux app: the window is told the setting is offered, and what it still needs', () => {
  const src = between(mainSrc, 'function adminStatus()', "ipcMain.handle('admin:status'");
  const status = (run, linux) => {
    const ctx = { adminRun: () => run, elevate: { linuxStatus: () => linux, INSTALL_PKEXEC: 'sudo apt install pkexec' } };
    vm.runInNewContext(`${src}; this.adminStatus = adminStatus;`, ctx);
    return { ...ctx.adminStatus() };
  };
  assert.deepStrictEqual(status({ helperPath: 'C:\\h.exe' }, null), { offered: true, missing: null }, 'Windows with its helper');
  assert.deepStrictEqual(status({ linux: LINUX }, { missing: null }), { offered: true, missing: null }, 'Linux, ready');
  assert.deepStrictEqual(status(null, { missing: 'pkexec' }), { offered: true, missing: 'pkexec', installCommand: 'sudo apt install pkexec' }, 'Linux without pkexec: still offered');
  assert.deepStrictEqual(status(null, null), { offered: false, missing: null }, 'nowhere it could work');

  const handlers = {};
  const seen = { opened: 0, copied: [] };
  let missing = 'pkexec';
  const ctx = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    adminStatus: () => ({ offered: true, missing }),
    elevate: { installPkexecInTerminal: () => { seen.opened += 1; return true; }, INSTALL_PKEXEC: 'sudo apt install pkexec' },
    clipboard: { writeText: (text) => seen.copied.push(text) },
  };
  vm.runInNewContext(between(mainSrc, "ipcMain.handle('admin:status'", '// What can run set-aside installers'), ctx);
  assert.strictEqual(handlers['admin:status']().missing, 'pkexec');
  assert.strictEqual(handlers['admin:installPkexec']().opened, true);
  handlers['admin:copyInstallCommand']();
  assert.deepStrictEqual(seen, { opened: 1, copied: ['sudo apt install pkexec'] }, 'the command is the app\'s own, never one the window sends');
  missing = null;
  assert.strictEqual(handlers['admin:installPkexec']().opened, false, 'nothing is opened when pkexec is not what is missing');
  assert.strictEqual(seen.opened, 1);

  for (const name of ['adminStatus', 'adminInstallPkexec', 'adminCopyInstallCommand']) assert.ok(preloadSrc.includes(`  ${name}: () => ipcRenderer.invoke('admin:`), name);
});

test('linux window: ticked without pkexec, the notice appears under the box and offers to install it', async () => {
  const updating = between(html, 'id="sg-updating"', '</section>');
  const notice = between(updating, '<div id="adminPromptNeeds"', '<p class="hint" id="adminNeedsMsg"');
  assert.match(updating, /<div id="adminPromptNeeds" hidden role="status">/, 'not shown until it is needed');
  assert.ok(updating.indexOf('id="adminPromptOnce"') < updating.indexOf('id="adminPromptNeeds"'), 'right under the box it is about');
  assert.match(notice, /<strong>pkexec is not installed<\/strong>, so this cannot work yet\./);
  assert.match(notice, /<code>sudo apt install pkexec<\/code>/, 'the exact command is shown');
  for (const [id, label] of [['adminNeedsInstall', 'Install pkexec'], ['adminNeedsCopy', 'Copy command'], ['adminNeedsCheck', 'Check again']]) {
    assert.match(notice, new RegExp(`<button type="button" id="${id}"[^>]*>${label}</button>`));
  }

  const block = between(html, "$('adminPromptOnce').onchange", "$('requireChecksum').onchange");
  const run = async ({ ticked, status, opened = true }) => {
    const els = { ...needsEls(), adminPromptOnce: { checked: ticked }, adminPromptOnceBlock: { hidden: true }, adminPromptOnceHint: {} };
    const said = [];
    const calls = [];
    const listeners = {};
    const api = {
      getPlatform: async () => ({ adminPromptOnce: true, platform: 'linux' }),
      adminStatus: async () => status(),
      adminInstallPkexec: async () => { calls.push('install'); return { opened }; },
      adminCopyInstallCommand: async () => { calls.push('copy'); return { copied: true }; },
    };
    const ctx = { $: (id) => els[id], config: {}, saveConfig: async () => {}, msg: (text) => said.push(text), adminPromptKind: 'windows', window: { api, addEventListener: (name, fn) => { listeners[name] = fn; } } };
    vm.runInNewContext(block, ctx);
    const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
    await settle();
    return { els, said, calls, listeners, settle };
  };

  let missing = 'pkexec';
  const w = await run({ ticked: true, status: () => ({ offered: true, missing }) });
  assert.strictEqual(w.els.adminPromptOnceBlock.hidden, false, 'the setting itself is shown');
  assert.strictEqual(w.els.adminPromptNeeds.hidden, false, 'ticked and pkexec missing: the notice is up');

  await w.els.adminNeedsInstall.onclick();
  assert.deepStrictEqual(w.calls, ['install']);
  assert.strictEqual(w.els.adminNeedsMsg.textContent, 'A terminal opened. Type your password there, then come back here.');
  await w.els.adminNeedsCopy.onclick();
  assert.strictEqual(w.els.adminNeedsMsg.textContent, 'Copied. Paste it into a terminal and press Enter.');
  await w.els.adminNeedsCheck.onclick();
  assert.strictEqual(w.els.adminNeedsMsg.textContent, 'pkexec is still not installed.');
  assert.strictEqual(w.els.adminPromptNeeds.hidden, false);

  // pkexec gets installed in the terminal; coming back to the window clears the notice by itself.
  missing = null;
  w.listeners.focus();
  await w.settle();
  assert.strictEqual(w.els.adminPromptNeeds.hidden, true);
  assert.strictEqual(w.els.adminNeedsMsg.textContent, '');
  await w.els.adminNeedsCheck.onclick();
  assert.deepStrictEqual(w.said, ['pkexec is installed. The next update run asks for your password once.']);

  // Unticking hides it; ticking it again without pkexec brings it straight back.
  missing = 'pkexec';
  const u = await run({ ticked: false, status: () => ({ offered: true, missing }) });
  assert.strictEqual(u.els.adminPromptNeeds.hidden, true, 'not ticked: nothing to say');
  u.els.adminPromptOnce.checked = true;
  u.els.adminPromptOnce.onchange();
  await u.settle();
  assert.strictEqual(u.els.adminPromptNeeds.hidden, false, 'the moment it is ticked');

  const none = await run({ ticked: true, status: () => ({ offered: true, missing: 'pkexec' }), opened: false });
  await none.els.adminNeedsInstall.onclick();
  assert.strictEqual(none.els.adminNeedsMsg.textContent, 'No terminal could be opened. Click Copy command and run it in a terminal.');

  const old = await run({ ticked: true, status: () => { throw new Error('no handler'); } });
  assert.strictEqual(old.els.adminPromptNeeds.hidden, true, 'an app that cannot answer shows no notice');
});
