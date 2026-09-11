'use strict';

// macOS and Linux asset picking. The Windows table is pinned separately in
// pickwindows.test.js; these assert the other two tables against real-world
// release-asset naming. All calls pass the platform explicitly so the suite gives
// the same result on every host.

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

const A = (...names) => names.map((name) => ({ name }));
const mac = (assets, type, arch, flavor) => core.pickAsset(assets, type, arch, flavor, 'darwin');
const lin = (assets, type, arch, flavor) => core.pickAsset(assets, type, arch, flavor, 'linux');

// --- macOS ------------------------------------------------------------------

test('mac portable: prefers the dmg over the auto-update zip, ignores win/linux', () => {
  const assets = A(
    'App-1.2.3-arm64.dmg',
    'App-1.2.3-arm64-mac.zip',
    'App-Setup-1.2.3-win-x64.exe',
    'App-1.2.3-linux-x86_64.AppImage'
  );
  assert.equal(mac(assets, 'portable', 'arm64').name, 'App-1.2.3-arm64.dmg');
});

test('mac portable: a dedicated arch build beats universal, which beats nothing', () => {
  const both = A('App-1.2.3-universal.dmg', 'App-1.2.3-arm64.dmg', 'App-1.2.3-x64.dmg');
  assert.equal(mac(both, 'portable', 'arm64').name, 'App-1.2.3-arm64.dmg');
  assert.equal(mac(both, 'portable', 'x64').name, 'App-1.2.3-x64.dmg');
  // Universal is the fallback when the vendor ships only that.
  const only = A('App-1.2.3-universal.dmg');
  assert.equal(mac(only, 'portable', 'arm64').name, 'App-1.2.3-universal.dmg');
  assert.equal(mac(only, 'portable', 'x64').name, 'App-1.2.3-universal.dmg');
  // ...and it beats a wrong-arch build that would only run under Rosetta.
  const mixed = A('App-1.2.3-universal.dmg', 'App-1.2.3-x64.dmg');
  assert.equal(mac(mixed, 'portable', 'arm64').name, 'App-1.2.3-universal.dmg');
});

test('mac portable: picks the matching arch when there is no universal build', () => {
  const assets = A('App-1.2.3-arm64.dmg', 'App-1.2.3-x64.dmg');
  assert.equal(mac(assets, 'portable', 'arm64').name, 'App-1.2.3-arm64.dmg');
  assert.equal(mac(assets, 'portable', 'x64').name, 'App-1.2.3-x64.dmg');
});

test('mac portable: apple-silicon and intel spelled out', () => {
  const assets = A('tool-1.0-apple-silicon.dmg', 'tool-1.0-intel.dmg');
  assert.equal(mac(assets, 'portable', 'arm64').name, 'tool-1.0-apple-silicon.dmg');
  assert.equal(mac(assets, 'portable', 'x64').name, 'tool-1.0-intel.dmg');
});

test('mac portable: godot-style osx universal zip', () => {
  const assets = A(
    'Godot_v4.7.2-stable_win64.exe.zip',
    'Godot_v4.7.2-stable_x11.64.zip',
    'Godot_v4.7.2-stable_osx.universal.zip'
  );
  assert.equal(mac(assets, 'portable').name, 'Godot_v4.7.2-stable_osx.universal.zip');
});

test('mac installer: picks the pkg', () => {
  const assets = A('App-1.2.3.pkg', 'App-1.2.3.dmg');
  assert.equal(mac(assets, 'installer').name, 'App-1.2.3.pkg');
});

test('mac: a dmg-only release tells an installer entry to switch to Portable', () => {
  const assets = A('App-1.2.3-universal.dmg');
  assert.throws(() => mac(assets, 'installer'), /change its type to Portable/);
});

test('mac: a Windows-only release throws with the macOS label', () => {
  const assets = A('App-Setup-1.2.3.exe', 'App-1.2.3-win-x64.zip');
  assert.throws(() => mac(assets, 'portable'), /no macOS portable asset/);
});

// --- Linux ------------------------------------------------------------------

test('linux portable: AppImage beats the tarball, ignores win/mac', () => {
  const assets = A(
    'app-1.2.3-x86_64.AppImage',
    'app-1.2.3-linux-x64.tar.gz',
    'App-1.2.3-universal.dmg',
    'App-Setup-1.2.3-win-x64.exe'
  );
  assert.equal(lin(assets, 'portable').name, 'app-1.2.3-x86_64.AppImage');
});

test('linux portable: matches the machine architecture', () => {
  const assets = A('app-1.2.3-x86_64.AppImage', 'app-1.2.3-aarch64.AppImage');
  assert.equal(lin(assets, 'portable', 'x64').name, 'app-1.2.3-x86_64.AppImage');
  assert.equal(lin(assets, 'portable', 'arm64').name, 'app-1.2.3-aarch64.AppImage');
});

test('linux portable: falls back to a tarball when there is no AppImage', () => {
  const assets = A('app-1.2.3-linux-x86_64.tar.xz', 'app_1.2.3_amd64.deb');
  assert.equal(lin(assets, 'portable').name, 'app-1.2.3-linux-x86_64.tar.xz');
});

test('linux installer: never crosses package formats', () => {
  const assets = A('app_1.2.3_amd64.deb', 'app-1.2.3-1.x86_64.rpm');
  assert.equal(lin(assets, 'installer', 'x64', 'deb').name, 'app_1.2.3_amd64.deb');
  assert.equal(lin(assets, 'installer', 'x64', 'rpm').name, 'app-1.2.3-1.x86_64.rpm');
  assert.equal(lin(assets, 'installer', 'x64', null).name, 'app_1.2.3_amd64.deb'); // fresh -> deb
});

test('linux: an AppImage-only release tells an installer entry to switch to Portable', () => {
  const assets = A('app-1.2.3-x86_64.AppImage');
  assert.throws(() => lin(assets, 'installer'), /change its type to Portable/);
});

test('linux: a Windows-only release throws with the Linux label', () => {
  const assets = A('App-Setup-1.2.3.exe', 'App-1.2.3-win-x64.zip');
  assert.throws(() => lin(assets, 'portable'), /no Linux portable asset/);
});

test('linux: an x64 build is never picked on arm64 (no transparent emulation)', () => {
  const assets = A('app-1.2.3-x86_64.AppImage');
  // Still the only candidate, but it must score as a mismatch rather than a match.
  const table = require('../src/platform/assets').assetTable('linux');
  assert.ok(table.archScore(table.archTokens('app-1.2.3-x86_64.AppImage'), 'arm64') < 0);
});

// --- guessKind --------------------------------------------------------------

test('guessKind covers the mac and linux package formats', () => {
  assert.equal(core.guessKind('App-1.2.3.pkg'), 'pkg');
  assert.equal(core.guessKind('app_1.2.3_amd64.deb'), 'deb');
  assert.equal(core.guessKind('app-1.2.3-1.x86_64.rpm'), 'rpm');
});

test('installerCmd: mac and linux kinds, with and without overrides', () => {
  assert.deepEqual(core.installerCmd('pkg', '/tmp/App.pkg'), {
    exe: 'installer',
    args: ['-pkg', '/tmp/App.pkg', '-target', '/'],
  });
  assert.deepEqual(core.installerCmd('pkg', '/tmp/App.pkg', ['-target', 'CurrentUserHomeDirectory']), {
    exe: 'installer',
    args: ['-pkg', '/tmp/App.pkg', '-target', 'CurrentUserHomeDirectory'],
  });
  assert.deepEqual(core.installerCmd('deb', '/tmp/app.deb'), { exe: 'dpkg', args: ['-i', '/tmp/app.deb'] });
  assert.deepEqual(core.installerCmd('deb', '/tmp/app.deb', ['--force-confold', '-i']), {
    exe: 'dpkg',
    args: ['--force-confold', '-i', '/tmp/app.deb'],
  });
  assert.deepEqual(core.installerCmd('rpm', '/tmp/app.rpm'), { exe: 'rpm', args: ['-U', '--quiet', '/tmp/app.rpm'] });
});
