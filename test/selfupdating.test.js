'use strict';

// Apps that keep themselves up to date are left alone (PROJECT-self-updating-apps.md,
// src/selfupdating.js). Only Squirrel is recognised; an app that merely has an updater
// (electron-updater, Sparkle, Homebrew's `auto_updates`) is updated as usual. These tests build
// each layout as a real folder on whatever system runs them, because the marker is looked for
// everywhere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const selfupdating = require('../src/selfupdating');
const win = require('../src/platform/win');
const github = require('../src/github');
const detect = require('../src/detect');
const runner = require('../src/runner');
const autoupdate = require('../src/autoupdate');
const core = require('../src/core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-selfupd-'));
const touch = (...parts) => {
  const f = path.join(...parts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
  return f;
};

// An install folder laid out the way each updater lays out its app.
function squirrelApp(root) {
  touch(root, 'Update.exe');
  touch(root, 'app-1.0.9269', 'Discord.exe');
  return root;
}
function electronUpdaterApp(root) {
  touch(root, 'resources', 'app-update.yml');
  touch(root, 'Thing.exe');
  return root;
}

// --- the markers --------------------------------------------------------------------

test('markerIn: Squirrel is Update.exe beside an app-<version> folder', () => {
  const dir = tmp();
  try {
    assert.equal(selfupdating.markerIn(squirrelApp(path.join(dir, 'Discord'))), 'squirrel');
    touch(dir, 'Lonely', 'Update.exe');
    assert.equal(selfupdating.markerIn(path.join(dir, 'Lonely')), null, 'an Update.exe alone is not enough');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-11-24: these marked most apps on a Mac (Chrome, Bitwarden, OBS, Zoom) as "Updates itself",
// apps git-updater had always updated without trouble. Having an updater is not a clash.
test('markerIn: an app that merely has an updater (electron-updater, Sparkle) is not recognised', () => {
  const dir = tmp();
  try {
    assert.equal(selfupdating.markerIn(electronUpdaterApp(path.join(dir, 'Bitwarden'))), null, 'app-update.yml in resources');
    touch(dir, 'One.app', 'Contents', 'Resources', 'app-update.yml');
    touch(dir, 'Two.app', 'Contents', 'Frameworks', 'Sparkle.framework', 'Sparkle');
    assert.equal(selfupdating.markerIn(path.join(dir, 'One.app')), null, 'app-update.yml in an app bundle');
    assert.equal(selfupdating.markerIn(path.join(dir, 'Two.app')), null, 'the Sparkle framework');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markerInTree: an unpacked download that keeps the app one folder down', () => {
  const dir = tmp();
  try {
    squirrelApp(path.join(dir, 'Chatty-1.2.3'));
    assert.equal(selfupdating.markerInTree(dir), 'squirrel');
    electronUpdaterApp(path.join(dir, 'Other', 'Thing-1.2.3'));
    assert.equal(selfupdating.markerInTree(path.join(dir, 'Other')), null);
    assert.equal(selfupdating.markerInTree(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('squirrelRoot: the folder of an uninstaller that is Squirrel\'s own updater', () => {
  assert.equal(selfupdating.squirrelRoot('C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --uninstall'), 'C:\\Users\\me\\AppData\\Local\\Discord');
  assert.equal(selfupdating.squirrelRoot('"C:\\Users\\me\\AppData\\Local\\GitHubDesktop\\Update.exe" --uninstall'), 'C:\\Users\\me\\AppData\\Local\\GitHubDesktop');
  assert.equal(selfupdating.squirrelRoot('"C:\\Program Files\\Thing\\Uninstall Thing.exe" /currentuser'), null);
  assert.equal(selfupdating.squirrelRoot('MsiExec.exe /X{BA4E4F4C-50DF-4E33-9E54-59DF54B18A9C}'), null);
  assert.equal(selfupdating.squirrelRoot(undefined), null);
});

test('foldersOf: where an inventory record says the app is', () => {
  // Built with this system's separators: a record always carries its own system's paths.
  const root = path.join(os.tmpdir(), 'gu-folders');
  const rec = {
    location: path.join(root, 'A'),
    path: path.join(root, 'B', 'app-1.2.3', 'B.exe'),
    uninstall: `"${path.join(root, 'C', 'Update.exe')}" --uninstall`,
  };
  assert.deepEqual(selfupdating.foldersOf(rec), [path.join(root, 'A'), path.join(root, 'B', 'app-1.2.3'), path.join(root, 'B'), path.join(root, 'C')]);
  const bundle = path.join(root, 'Applications', 'Two.app');
  assert.deepEqual(selfupdating.foldersOf({ path: bundle }), [bundle], 'an app bundle is its own folder');
  assert.deepEqual(selfupdating.foldersOf({ name: 'pkg', flavor: 'deb' }), [], 'a Linux package names no folder');
});

// --- the decision ---------------------------------------------------------------------

test('check: the tick wins both ways, then the installed copy', async () => {
  const dir = tmp();
  try {
    const app = squirrelApp(path.join(dir, 'Discord'));
    const copies = [{ name: 'Discord', version: '1.0.9269', uninstall: `"${path.join(app, 'Update.exe')}" --uninstall` }];
    assert.equal(await selfupdating.check({ updatesItself: false }, { copies }), null, '"update it anyway"');
    assert.deepEqual(await selfupdating.check({ updatesItself: true }, {}), { by: 'you' }, 'marked by hand, nothing found');
    assert.deepEqual(await selfupdating.check({}, { copies }), { by: 'squirrel' });
    assert.deepEqual(await selfupdating.check({}, { folder: path.join(dir) }), { by: 'squirrel' }, 'a kept folder, one level down');
    assert.equal(await selfupdating.check({}, { copies: [{ name: 'X', version: '1', location: path.join(dir, 'nowhere') }] }), null);
    const bitwarden = electronUpdaterApp(path.join(dir, 'Bitwarden'));
    assert.equal(await selfupdating.check({}, { copies: [{ name: 'Bitwarden', version: '1', location: bitwarden }] }), null, 'having an updater is not enough');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseHive: keeps a Squirrel uninstaller, and only that kind', () => {
  const reg = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Discord',
    '    DisplayName    REG_SZ    Discord',
    '    DisplayVersion    REG_SZ    1.0.9269',
    '    UninstallString    REG_SZ    C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --uninstall',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\7-Zip',
    '    DisplayName    REG_SZ    7-Zip 26.06 (x64)',
    '    DisplayVersion    REG_SZ    26.06',
    '    UninstallString    REG_SZ    "C:\\Program Files\\7-Zip\\Uninstall.exe"',
  ].join('\r\n');
  const [discord, zip] = win.parseHive(reg);
  assert.equal(discord.uninstall, 'C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe --uninstall');
  assert.equal(zip.uninstall, undefined);
});

// --- the runner: every run takes the same answer ------------------------------------

async function withWorld({ installed, copies = [], listing = false }, fn) {
  const real = {
    getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning, clearCache: detect.clearCache,
    installedVersion: detect.installedVersion, installedFlavor: detect.installedFlavor, installedCopies: detect.installedCopies,
  };
  const calls = { download: 0, copies: 0 };
  github.getLatestRelease = async () => ({
    tag_name: 'v2.0.0',
    assets: [{ name: 'payload.zip', browser_download_url: 'https://example.invalid/payload.zip' }],
    ...(listing ? { updatesItself: true } : {}),
  });
  github.downloadAsset = async () => { calls.download++; throw new Error('nothing may be downloaded in this test'); };
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => installed || null;
  detect.installedFlavor = async () => null;
  detect.installedCopies = async () => { calls.copies++; return copies; };
  try {
    return await fn(calls);
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, {
      isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion,
      installedFlavor: real.installedFlavor, installedCopies: real.installedCopies,
    });
  }
}

const installerEntry = (extra = {}) => ({ owner: 'acme', repo: 'chatty', type: 'installer', asset: 'payload.zip', install: { kind: 'nsis' }, ...extra });

test('runner: an installed app that updates itself reads "self" in a check and in every update run', async () => {
  const dir = tmp();
  try {
    const app = squirrelApp(path.join(dir, 'Chatty'));
    await withWorld({ installed: '1.0.0', copies: [{ name: 'chatty', version: '1.0.0', location: app }] }, async (calls) => {
      const statePath = path.join(dir, 'state.json');
      const check = (await runner.run({ repos: [installerEntry()] }, { mode: 'check', statePath })).results[0];
      assert.equal(check.status, 'self');
      assert.equal(check.updatesItself, 'squirrel');
      assert.equal(check.selfFound, 'squirrel');
      assert.equal(check.from, '1.0.0');
      assert.equal(check.to, '2.0.0', 'the newer version is still reported, as information');
      for (const opts of [{}, { force: true }, { unattended: true }, { autoClose: true }]) {
        const r = (await runner.run({ repos: [installerEntry()] }, { ...opts, statePath })).results[0];
        assert.equal(r.status, 'self', JSON.stringify(opts));
        assert.match(r.reason, /chatty updates itself/);
      }
      assert.equal(calls.download, 0, 'nothing was downloaded');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: unticked ("update it anyway"), the app is offered as an update and the find is still reported', async () => {
  const dir = tmp();
  try {
    const app = squirrelApp(path.join(dir, 'Chatty'));
    await withWorld({ installed: '1.0.0', copies: [{ name: 'chatty', version: '1.0.0', location: app }] }, async () => {
      const r = (await runner.run({ repos: [installerEntry({ updatesItself: false })] }, { mode: 'check', statePath: path.join(dir, 's.json') })).results[0];
      assert.equal(r.status, 'updated');
      assert.equal(r.updatesItself, undefined);
      assert.equal(r.selfFound, 'squirrel', 'so the tick can go back to "decided by what was found"');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: ticked by hand, an app with no marker is left alone', async () => {
  const dir = tmp();
  try {
    await withWorld({ installed: '1.0.0', copies: [{ name: 'chatty', version: '1.0.0', location: dir }] }, async () => {
      const r = (await runner.run({ repos: [installerEntry({ updatesItself: true })] }, { mode: 'check', statePath: path.join(dir, 's.json') })).results[0];
      assert.equal(r.status, 'self');
      assert.equal(r.updatesItself, 'you');
      assert.equal(r.selfFound, undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a first install is never skipped, and the installed copy is not even looked for', async () => {
  const dir = tmp();
  try {
    await withWorld({ installed: null, listing: true }, async (calls) => {
      const r = (await runner.run({ repos: [installerEntry({ updatesItself: true })] }, { mode: 'check', statePath: path.join(dir, 's.json') })).results[0];
      assert.equal(r.status, 'updated', 'Install is offered');
      assert.equal(calls.copies, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: up to date, the row still learns that the app updates itself', async () => {
  const dir = tmp();
  try {
    const app = squirrelApp(path.join(dir, 'Chatty'));
    await withWorld({ installed: '2.0.0', copies: [{ name: 'chatty', version: '2.0.0', location: app }] }, async () => {
      const r = (await runner.run({ repos: [installerEntry()] }, { mode: 'check', statePath: path.join(dir, 's.json') })).results[0];
      assert.equal(r.status, 'current');
      assert.equal(r.updatesItself, 'squirrel');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Mac on 2026-11-24: Bitwarden (electron-updater, Homebrew `auto_updates`) read "Updates itself".
test('runner: an app that merely has an updater, and whose listing says so, is offered its update as usual', async () => {
  const dir = tmp();
  try {
    const app = electronUpdaterApp(path.join(dir, 'Bitwarden'));
    await withWorld({ installed: '1.0.0', copies: [{ name: 'chatty', version: '1.0.0', location: app }], listing: true }, async () => {
      const r = (await runner.run({ repos: [installerEntry()] }, { mode: 'check', statePath: path.join(dir, 's.json') })).results[0];
      assert.equal(r.status, 'updated');
      assert.equal(r.updatesItself, undefined);
      assert.equal(r.selfFound, undefined);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a portable app is judged by the folder git-updater keeps it in', async () => {
  const dir = tmp();
  try {
    const folder = path.join(dir, 'thing');
    squirrelApp(path.join(folder, 'Thing-1.0.0'));
    const key = 'acme/thing#portable';
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ [key]: { tag: 'v1.0.0', version: '1.0.0', files: ['Thing-1.0.0/Thing.exe'] } }));
    await withWorld({}, async (calls) => {
      const entry = { owner: 'acme', repo: 'thing', type: 'portable', asset: 'payload.zip', install: { dir: folder } };
      const r = (await runner.run({ portableRoot: dir, repos: [entry] }, { mode: 'check', statePath })).results[0];
      assert.equal(r.status, 'self');
      assert.equal(r.updatesItself, 'squirrel');
      assert.equal(calls.copies, 0, 'its own folder is the record; the system inventory is not asked');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- what the runs and the window make of it -----------------------------------------

test('the scheduled install and the CLI summary count a skipped app as neither failed nor "needs you"', () => {
  assert.equal(autoupdate.classify({ status: 'self', reason: 'chatty updates itself' }), 'current');
  const s = autoupdate.summarize([{ name: 'chatty', result: { status: 'self' } }, { name: 'tool', result: { status: 'updated' } }]);
  assert.deepEqual([s.updated, s.current, s.needsYou.length, s.failed.length], [['tool'], 1, 0, 0]);
  assert.equal(autoupdate.needsUser(s), false);
  const sum = core.buildSummary([{ repo: 'acme/chatty', status: 'self', from: '1.0.0', to: '2.0.0' }]);
  assert.equal(sum.counts.failed, 0);
  assert.match(sum.text, /^updated 0, current 0, failed 0, update themselves 1/);
  assert.match(sum.text, /acme\/chatty {2}1\.0\.0 \(updates itself; 2\.0\.0 is out/);
});

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const between = (from, to) => {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to} found`);
  return html.slice(a, b);
};

test('window: the row reads "Updates itself", in purple, and its tooltip says why and how to undo it', () => {
  const ctx = {};
  vm.runInNewContext(`${between('const SELF_WHY', 'const selfOf')} ${between('function statusViewOf(s) {', 'function primaryAction(s)')}; this.statusViewOf = statusViewOf;`, ctx);
  const v = ctx.statusViewOf({ ph: 'self', selfBy: 'squirrel', selfName: 'Discord', from: '1.0.9269', to: '1.0.9270' });
  assert.equal(v.text, 'Updates itself');
  assert.equal(v.cls, 'c-self', 'purple: not red, not an update to take, not grey "not checked"');
  assert.match(v.tip, /^Discord keeps itself up to date\. git-updater leaves it alone so the two updaters don't clash\./);
  assert.match(v.tip, /It has its own updater built in\./);
  assert.match(v.tip, /Version 1\.0\.9270 is out; Discord installs it itself\./);
  assert.match(v.tip, /untick "Updates itself" in its ⋯ menu/);
  assert.match(ctx.statusViewOf({ ph: 'self', selfBy: 'you' }).tip, /^This app keeps itself up to date[\s\S]*You marked it as updating itself\./);
});

test('window: a scheduled check\'s "self" result fills the row as "self", not as an update', () => {
  const ctx = {};
  vm.runInNewContext(`${between('// --- background results', '// --- end of the background results block ---')}; this.merge = mergeBackgroundResults;`, ctx);
  const st = { a: { ph: 'idle' } };
  ctx.merge(st, [{ id: 'a', status: 'self', from: '1', to: '2', updatesItself: 'squirrel' }]);
  assert.equal(st.a.ph, 'self');
  assert.equal(st.a.selfBy, 'squirrel');
});

test('window: the ⋯ menu carries the "Updates itself" tick on installed rows, and Update all is not changed', () => {
  assert.match(html, /item\(`\$\{on \? '☑' : '☐'\} Updates itself`/);
  assert.match(html, /if \(next === found\) delete r\.updatesItself; else r\.updatesItself = next;/);
  // Update all still sends every row to the engine; the engine is what leaves these alone.
  assert.match(html, /\$\('updateAll'\)\.onclick = \(\) => runBatch\(targetKeys\(\)/);
  assert.match(html, /left alone because \$\{leftAlone === 1 \? 'it updates itself' : 'they update themselves'\}/);
});

test('window: in the compact list the words "Updates itself" are purple too, not the grey other states get', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.match(html, /\.c-self \{ color: var\(--purple\); \} \.c-self \.dot \{ background: var\(--purple\);/);
  assert.match(html, /\.cv\.say\.c-self \{ color: var\(--purple\); \}/);
  assert.ok(html.indexOf('.cv.say.c-self') > html.indexOf('.cv { min-width'), 'after the grey .cv rule, so it wins');
});
