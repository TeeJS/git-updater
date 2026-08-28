'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

const A = (...names) => names.map((name) => ({ name }));

test('portable: picks the Windows x64 zip, not arm/linux/mac', () => {
  const assets = A(
    'ShareX-21.0.0-portable-x64.zip',
    'ShareX-21.0.0-portable-arm64.zip',
    'ShareX-21.0.0-setup-x64.exe',
    'ShareX-21.0.0-linux.tar.gz'
  );
  assert.equal(core.pickWindowsAsset(assets, 'portable').name, 'ShareX-21.0.0-portable-x64.zip');
});

test('portable: deskflow-style windows zip', () => {
  const assets = A('deskflow-1.26.0-windows-x64.zip', 'deskflow-1.26.0-linux-x64.deb', 'deskflow-1.26.0.dmg');
  assert.equal(core.pickWindowsAsset(assets, 'portable').name, 'deskflow-1.26.0-windows-x64.zip');
});

test('portable: accepts a .7z when that is the Windows build', () => {
  const assets = A('app-2.0-win-x64.7z', 'app-2.0-linux.tar.gz');
  assert.equal(core.pickWindowsAsset(assets, 'portable').name, 'app-2.0-win-x64.7z');
});

test('portable: picks the portable .exe over the setup .exe', () => {
  const assets = A('open-quake-0.7.1-portable.exe', 'open-quake-0.7.1-setup.exe');
  assert.equal(core.pickWindowsAsset(assets, 'portable').name, 'open-quake-0.7.1-portable.exe');
});

test('installer: picks the setup .exe over the portable .exe', () => {
  const assets = A('open-quake-0.7.1-portable.exe', 'open-quake-0.7.1-setup.exe');
  assert.equal(core.pickWindowsAsset(assets, 'installer').name, 'open-quake-0.7.1-setup.exe');
});

test('installer: prefers the x64 .msi (silent-installable) over exe/arm', () => {
  const assets = A('7z2602-x64.exe', '7z2602-arm64.exe', '7z2602-x64.msi', '7z2602.exe');
  assert.equal(core.pickWindowsAsset(assets, 'installer').name, '7z2602-x64.msi');
});

test('installer: falls back to .exe when there is no .msi', () => {
  const assets = A('ShareX-21.0.0-setup-x64.exe', 'ShareX-21.0.0-portable-x64.zip');
  assert.equal(core.pickWindowsAsset(assets, 'installer').name, 'ShareX-21.0.0-setup-x64.exe');
});

test('throws when no Windows asset of the requested type exists', () => {
  const assets = A('tool-linux.tar.gz', 'tool-macos.dmg');
  assert.throws(() => core.pickWindowsAsset(assets, 'portable'), /no Windows portable asset/);
});

test('guessKind: msi vs exe', () => {
  assert.equal(core.guessKind('setup-x64.msi'), 'msi');
  assert.equal(core.guessKind('setup-x64.exe'), 'nsis');
});
