'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/core');
const install = require('../src/install');
const state = require('../src/state');

// --- version compare (#9) ---------------------------------------------------

test('cmpVersion: prerelease numbers compare naturally (rc10 > rc2)', () => {
  assert.ok(core.cmpVersion('1.2.0-rc10', '1.2.0-rc2') > 0);
  assert.ok(core.cmpVersion('1.2.0-rc2', '1.2.0-rc10') < 0);
});

test('cmpVersion: build metadata does not affect precedence', () => {
  assert.equal(core.cmpVersion('1.2.0+build.5', '1.2.0'), 0);
  assert.equal(core.cmpVersion('1.2.0+a', '1.2.0+b'), 0);
});

// --- arch-aware asset pick (#8) ---------------------------------------------

test('pickWindowsAsset: on arm64 machine prefers the arm64 build', () => {
  const assets = [{ name: 'app-1.0-win-x64.zip' }, { name: 'app-1.0-win-arm64.zip' }];
  assert.equal(core.pickWindowsAsset(assets, 'portable', 'arm64').name, 'app-1.0-win-arm64.zip');
  assert.equal(core.pickWindowsAsset(assets, 'portable', 'x64').name, 'app-1.0-win-x64.zip');
});

// --- installer kind detection (#4) ------------------------------------------

test('detectInstallerKind: recognizes MSI, Inno, NSIS from bytes; null when unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-det-'));
  try {
    const msi = path.join(dir, 'a.msi');
    fs.writeFileSync(msi, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0]));
    assert.equal(install.detectInstallerKind(msi), 'msi');

    const inno = path.join(dir, 'b.exe');
    fs.writeFileSync(inno, Buffer.concat([Buffer.from('MZ junk '), Buffer.from('Inno Setup Setup Data'), Buffer.alloc(20)]));
    assert.equal(install.detectInstallerKind(inno), 'inno');

    const nsis = path.join(dir, 'c.exe');
    fs.writeFileSync(nsis, Buffer.concat([Buffer.from('MZ '), Buffer.from('Nullsoft Install System'), Buffer.alloc(20)]));
    assert.equal(install.detectInstallerKind(nsis), 'nsis');

    const unknown = path.join(dir, 'd.exe');
    fs.writeFileSync(unknown, Buffer.from('MZ nothing special here'));
    assert.equal(install.detectInstallerKind(unknown), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- transactional portable install (#6) -------------------------------------

const AdmZip = require('adm-zip');
function makeZip(dir, entries) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(entries)) z.addFile(name, Buffer.from(content));
  const p = path.join(dir, 'pkg.zip');
  z.writeZip(p);
  return p;
}

test('installPortable: dir-swap upgrade drops stale files, keeps user files, no leftovers', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-txn-'));
  try {
    const dest = path.join(base, 'app');
    fs.mkdirSync(path.join(dest, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep.dll'), 'old-version');
    fs.writeFileSync(path.join(dest, 'stale.dll'), 'gone in new version');
    fs.writeFileSync(path.join(dest, 'settings', 'user.cfg'), 'my settings'); // runtime file

    const zip = makeZip(base, { 'keep.dll': 'new-version', 'extra.txt': 'new' });
    const manifest = await install.installPortable(zip, { dir: dest }, ['keep.dll', 'stale.dll']);

    assert.deepEqual(manifest.sort(), ['extra.txt', 'keep.dll']);
    assert.equal(fs.readFileSync(path.join(dest, 'keep.dll'), 'utf8'), 'new-version');
    assert.ok(!fs.existsSync(path.join(dest, 'stale.dll')), 'stale file gone with the old dir');
    assert.equal(fs.readFileSync(path.join(dest, 'settings', 'user.cfg'), 'utf8'), 'my settings');
    assert.ok(!fs.existsSync(dest + '.git-updater-old'), 'old dir removed on commit');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installPortable: a bad archive leaves the current install completely untouched', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-txn2-'));
  try {
    const dest = path.join(base, 'app');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'app.exe'), 'v1');
    const empty = makeZip(base, {}); // extracts to zero files
    await assert.rejects(() => install.installPortable(empty, { dir: dest }), /no files/);
    assert.equal(fs.readFileSync(path.join(dest, 'app.exe'), 'utf8'), 'v1');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('installPortable: recovers a crashed swap (parked old dir, missing dest)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-txn3-'));
  try {
    const dest = path.join(base, 'app');
    // Simulate a crash after the old dir was parked but before the new one moved in.
    fs.mkdirSync(dest + '.git-updater-old', { recursive: true });
    fs.writeFileSync(path.join(dest + '.git-updater-old', 'app.exe'), 'v1');
    const zip = makeZip(base, { 'app.exe': 'v2' });
    await install.installPortable(zip, { dir: dest });
    assert.equal(fs.readFileSync(path.join(dest, 'app.exe'), 'utf8'), 'v2');
    assert.ok(!fs.existsSync(dest + '.git-updater-old'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- checksum-file fallback (#2) ----------------------------------------------

test('verifyDigest: sha512 digests verify too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-sum-'));
  try {
    const f = path.join(dir, 'x.bin');
    fs.writeFileSync(f, 'hello');
    const crypto = require('crypto');
    const h = crypto.createHash('sha512').update('hello').digest('hex');
    assert.deepEqual(require('../src/github').verifyDigest(f, `sha512:${h}`), { verified: true });
    assert.throws(() => require('../src/github').verifyDigest(f, `sha512:${'0'.repeat(128)}`), /mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock: serializes update runs, steals nothing while held', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-lock-'));
  const sp = path.join(dir, 'state.json');
  try {
    const tok = state.acquireLock(sp);
    assert.throws(() => state.acquireLock(sp), /in progress/);
    state.releaseLock(tok);
    const tok2 = state.acquireLock(sp); // free again after release
    state.releaseLock(tok2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

