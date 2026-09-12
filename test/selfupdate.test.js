'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// selfupdate.js computes its storage root at require-time — point it at an isolated
// temp dir BEFORE requiring so these tests never touch the real one, on any host.
const FAKE_LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-selfupdate-env-'));
process.env.GITUPDATER_DATA_DIR = path.join(FAKE_LOCALAPPDATA, 'git-updater');

const { test } = require('node:test');
const assert = require('node:assert');
const selfupdate = require('../src/selfupdate');

// The launcher filename is platform-dependent (src/selfupdate.js), and listVersions
// only counts a folder as a version when it contains THAT name — so the fixtures must
// use the same one, or every assertion here silently finds nothing off Windows.
const EXE = process.platform === 'win32' ? 'git-updater.exe' : 'git-updater';
function versionDir(root, v) {
  const dir = path.join(root, `app-${v}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, EXE), v);
  return dir;
}

test('layout: launcher at root vs a versioned copy', () => {
  // Built with path.join rather than literals: path parsing is platform-specific, so a
  // hardcoded "D:\apps\..." is one long filename to Linux and the test fails for a
  // reason that has nothing to do with the code under test.
  const root = path.join(path.sep === '\\' ? 'D:\\apps' : '/opt', 'git-updater');
  const versionDir = path.join(root, 'app-0.1.6');
  assert.deepEqual(selfupdate.layout(path.join(root, EXE)), { root, versionDir: null });
  assert.deepEqual(selfupdate.layout(path.join(versionDir, EXE)), { root, versionDir });
});

test('listVersions / newestNewerThan: app-* folders with the exe, newest first, only newer wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-layout-'));
  try {
    versionDir(root, '0.1.6');
    versionDir(root, '0.1.10'); // numeric compare: 0.1.10 > 0.1.6
    fs.mkdirSync(path.join(root, 'app-9.9.9')); // no exe inside -> ignored
    fs.mkdirSync(path.join(root, 'resources')); // not a version folder
    assert.deepEqual(selfupdate.listVersions(root).map((v) => v.version), ['0.1.10', '0.1.6']);
    assert.equal(selfupdate.newestNewerThan(root, '0.1.5').version, '0.1.10');
    assert.equal(selfupdate.newestNewerThan(root, '0.1.10'), null, 'nothing newer than the running version');
    assert.equal(selfupdate.newestNewerThan(root, '0.2.0'), null, 'running version is newest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('handoffTarget: launcher hands off; a version folder never hands off to itself', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-handoff-'));
  try {
    const v9 = versionDir(root, '9.9.9');
    // The flat launcher (reports 0.1.4) -> hand off to app-9.9.9
    assert.equal(selfupdate.handoffTarget(path.join(root, EXE), '0.1.4').dir, v9);
    // The build inside app-9.9.9 actually reports 0.1.4 (folder name overstates it): it must
    // run itself rather than relaunch into its own folder forever.
    assert.equal(selfupdate.handoffTarget(path.join(v9, EXE), '0.1.4'), null);
    // An older version folder defers to the newer one.
    const v5 = versionDir(root, '0.1.5');
    assert.equal(selfupdate.handoffTarget(path.join(v5, EXE), '0.1.5').dir, v9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitPidArg: parses --wait-pid, null otherwise', () => {
  assert.equal(selfupdate.waitPidArg(['x', '--wait-pid', '4242']), 4242);
  assert.equal(selfupdate.waitPidArg(['x']), null);
  assert.equal(selfupdate.waitPidArg(['x', '--wait-pid', 'nope']), null);
});

test('waitForExit: polls until the pid is gone; gives up after the ceiling', async () => {
  let polls = 0;
  assert.equal(await selfupdate.waitForExit(1, { pidAlive: () => polls++ < 3, wait: async () => {} }), true);
  assert.equal(await selfupdate.waitForExit(1, { pidAlive: () => true, wait: async () => {} }), false);
});

test('writeApplyMarker/consumeApplyMarker: round-trips, is consumed once, detects a mismatch', () => {
  assert.equal(selfupdate.consumeApplyMarker('9.9.9'), null, 'no marker yet -> null');

  selfupdate.writeApplyMarker({ expectVersion: '1.2.3' });
  assert.deepEqual(selfupdate.consumeApplyMarker('1.2.3'), { ok: true, expectVersion: '1.2.3', actualVersion: '1.2.3' });
  assert.equal(selfupdate.consumeApplyMarker('1.2.3'), null, 'consumed once -> gone');

  selfupdate.writeApplyMarker({ expectVersion: '2.0.0' });
  assert.equal(selfupdate.consumeApplyMarker('1.9.9').ok, false);
});

test('cleanupLeftovers: removes older app-* folders and stale stage/download dirs, keeps current+newer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-cleanup-'));
  try {
    const older = versionDir(root, '0.1.5');
    const current = versionDir(root, '0.1.6');
    const newer = versionDir(root, '0.1.7');

    const staleAt = Date.now() - 36 * 60 * 60 * 1000;
    const touch = (p, mtimeMs) => {
      fs.mkdirSync(p, { recursive: true });
      fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    };
    const staleStage = path.join(root, '.git-updater-selfupdate-stage-abc');
    const freshStage = path.join(root, '.git-updater-selfupdate-stage-def');
    touch(staleStage, staleAt);
    touch(freshStage, Date.now());
    const staleDownload = path.join(process.env.GITUPDATER_DATA_DIR, 'self-update', 'v0.1.5');
    const freshDownload = path.join(process.env.GITUPDATER_DATA_DIR, 'self-update', 'v0.1.7');
    touch(staleDownload, staleAt);
    touch(freshDownload, Date.now());

    await selfupdate.cleanupLeftovers(root, '0.1.6');

    assert.ok(!fs.existsSync(older), 'older version folder removed');
    assert.ok(fs.existsSync(current), 'running version kept');
    assert.ok(fs.existsSync(newer), 'newer version kept');
    assert.ok(!fs.existsSync(staleStage), 'stage dirs removed regardless of age (only live during an update in-process)');
    assert.ok(!fs.existsSync(freshStage), 'stage dirs removed regardless of age (only live during an update in-process)');
    assert.ok(!fs.existsSync(staleDownload), 'stale download removed');
    assert.ok(fs.existsSync(freshDownload), 'fresh download kept');
    assert.ok(fs.existsSync(path.join(root, EXE)) === false, 'sanity: no launcher exe in this fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- self-update asset choice --------------------------------------------------
// The launcher model needs a DIRECTORY: app-<version>/ holding an executable named
// git-updater, beside the launcher. An AppImage is a single self-contained file, so
// there is nowhere to put a versioned sibling and nothing to hand off to.
//
// The generic picker prefers an AppImage on Linux, which is right for every tracked app
// and wrong for this one caller.

const core = require('../src/core');

test('selfupdate: its own Linux release picks the tarball, never the AppImage', () => {
  // Exactly what package.json's linux targets produce.
  const assets = [
    'git-updater-0.1.7-linux-x64.AppImage',
    'git-updater-0.1.7-linux-arm64.AppImage',
    'git-updater-0.1.7-linux-x64.tar.gz',
    'git-updater-0.1.7-linux-arm64.tar.gz',
  ].map((name) => ({ name }));

  // The generic picker, used for tracked apps, chooses the AppImage — correctly.
  assert.match(core.pickAsset(assets, 'portable', 'x64', null, 'linux').name, /\.AppImage$/);

  // Self-update must not, or prepareUpdate downloads the whole thing and then fails on
  // "downloaded build has no git-updater".
  const picked = core.pickAsset(selfupdate.selfUpdateAssets(assets), 'portable', 'x64', null, 'linux');
  assert.equal(picked.name, 'git-updater-0.1.7-linux-x64.tar.gz');
});

test('selfupdate: Windows and macOS asset choice is unaffected', () => {
  const win = ['git-updater-0.1.7-x64.zip', 'git-updater-0.1.7-arm64.zip'].map((name) => ({ name }));
  assert.equal(
    core.pickAsset(selfupdate.selfUpdateAssets(win), 'portable', 'x64', null, 'win32').name,
    'git-updater-0.1.7-x64.zip'
  );
});

test('selfupdate: a release with nothing but AppImages is left to the picker to report', () => {
  // Better a clear "no Linux portable asset" from the picker than an empty list here.
  const only = [{ name: 'git-updater-9.9.9-linux-x64.AppImage' }];
  assert.deepEqual(selfupdate.selfUpdateAssets(only), only);
});
