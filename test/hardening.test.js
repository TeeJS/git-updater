'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/core');
const install = require('../src/install');

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

// --- stale-file pruning (#6) ------------------------------------------------

test('pruneStale: removes files gone from the new version, keeps the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-prune-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep.dll'), 'x');
    fs.writeFileSync(path.join(dir, 'old.dll'), 'x'); // was installed before, gone now
    fs.mkdirSync(path.join(dir, 'settings'));
    fs.writeFileSync(path.join(dir, 'settings', 'user.cfg'), 'x'); // runtime file, not in any manifest

    install.pruneStale(dir, ['keep.dll', 'old.dll'], ['keep.dll']);

    assert.ok(fs.existsSync(path.join(dir, 'keep.dll')), 'keep.dll stays');
    assert.ok(!fs.existsSync(path.join(dir, 'old.dll')), 'old.dll removed');
    assert.ok(fs.existsSync(path.join(dir, 'settings', 'user.cfg')), 'user settings preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- swapInPlace returns a manifest and clears stale .bak (#6) ---------------

test('swapInPlace: installs files, returns manifest, cleans backups', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-src-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-dst-'));
  try {
    fs.writeFileSync(path.join(src, 'a.txt'), 'new');
    fs.writeFileSync(path.join(dst, 'a.txt'), 'old'); // existing -> backed up then replaced
    const manifest = install.swapInPlace(src, dst);
    assert.deepEqual(manifest, ['a.txt']);
    assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'new');
    assert.ok(!fs.existsSync(path.join(dst, 'a.txt.git-updater.bak')), 'backup cleaned on success');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  }
});
