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

test('linux portable: the tarball beats the AppImage, ignores win/mac', () => {
  const assets = A(
    'app-1.2.3-x86_64.AppImage',
    'app-1.2.3-linux-x64.tar.gz',
    'App-1.2.3-universal.dmg',
    'App-Setup-1.2.3-win-x64.exe'
  );
  // An AppImage's runtime needs libfuse2, which Ubuntu has not shipped by default since
  // 22.04, so on a current desktop it fails before the app is reached. The tarball runs.
  assert.equal(lin(assets, 'portable').name, 'app-1.2.3-linux-x64.tar.gz');
});

test('linux portable: an AppImage is still chosen when it is the only option', () => {
  // Something that may need libfuse2 beats nothing at all — the preference above is
  // between usable assets, not a rejection.
  const assets = A('app-1.2.3-x86_64.AppImage', 'App-Setup-1.2.3-win-x64.exe');
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

// --- the macOS zip that names no platform ---------------------------------------
// Found in live data, not a fixture: bedrock-panel v0.9.6 publishes bedrock-panel-arm64.dmg
// and bedrock-panel-arm64.zip. The zip is the macOS bundle and its NAME says nothing about
// that, so neither the Windows nor the Linux reject regex catches it — both look for a
// platform word and there is none.
//
// On x64 the correct build wins on architecture and hides the problem. On arm64 the bare
// arm64 token beats a portable .exe carrying no arch token, and beats an x86_64 AppImage
// outright, so an arm64 Windows or Linux machine downloaded a macOS .app bundle.

const BEDROCK = [
  'bedrock-panel-arm64.dmg',
  'bedrock-panel-arm64.zip',
  'bedrock-panel-portable.exe',
  'bedrock-panel-setup.exe',
  'bedrock-panel-x86_64.AppImage',
  'bedrock-panel_amd64.deb',
].map((name) => ({ name }));

test('a .zip paired with a .dmg is never chosen off macOS, even on arm64', () => {
  assert.equal(core.pickAsset(BEDROCK, 'portable', 'arm64', null, 'win32').name, 'bedrock-panel-portable.exe');
  assert.equal(core.pickAsset(BEDROCK, 'portable', 'x64', null, 'win32').name, 'bedrock-panel-portable.exe');
  assert.notEqual(core.pickAsset(BEDROCK, 'portable', 'arm64', null, 'linux').name, 'bedrock-panel-arm64.zip');
});

test('...and on macOS that same pair still resolves to the disk image', () => {
  assert.equal(core.pickAsset(BEDROCK, 'portable', 'arm64', null, 'darwin').name, 'bedrock-panel-arm64.dmg');
});

test('the installer lane is unaffected on every platform', () => {
  assert.equal(core.pickAsset(BEDROCK, 'installer', 'x64', null, 'win32').name, 'bedrock-panel-setup.exe');
  assert.equal(core.pickAsset(BEDROCK, 'installer', 'x64', 'deb', 'linux').name, 'bedrock-panel_amd64.deb');
  // No .pkg is published, so macOS correctly has nothing to offer and says which type works.
  assert.throws(() => core.pickAsset(BEDROCK, 'installer', 'arm64', null, 'darwin'), /change its type to Portable/);
});

test("git-updater's OWN Windows zip has the identical shape and must survive", () => {
  // This is why the rule cannot be a filename pattern. git-updater-0.2.0-arm64.zip names
  // no platform either; what separates the two is that OUR release has no .dmg of that
  // stem — ours is mac-arm64.dmg — and bedrock-panel's does.
  const ours = [
    'git-updater-0.2.0-x64.zip',
    'git-updater-0.2.0-arm64.zip',
    'git-updater-0.2.0-mac-arm64.dmg',
    'git-updater-0.2.0-mac-arm64.zip',
    'git-updater-0.2.0-linux-x64.tar.gz',
    'git-updater-0.2.0-linux-arm64.tar.gz',
  ].map((name) => ({ name }));
  assert.equal(core.pickAsset(ours, 'portable', 'arm64', null, 'win32').name, 'git-updater-0.2.0-arm64.zip');
  assert.equal(core.pickAsset(ours, 'portable', 'x64', null, 'win32').name, 'git-updater-0.2.0-x64.zip');
  assert.equal(core.pickAsset(ours, 'portable', 'arm64', null, 'darwin').name, 'git-updater-0.2.0-mac-arm64.dmg');
  assert.equal(core.pickAsset(ours, 'portable', 'arm64', null, 'linux').name, 'git-updater-0.2.0-linux-arm64.tar.gz');
});

test('macCompanionZips pairs on the stem and nothing else', () => {
  const { macCompanionZips } = require('../src/platform/assets');
  assert.deepEqual([...macCompanionZips(['Foo-arm64.dmg', 'Foo-arm64.zip'])], ['Foo-arm64.zip']);
  // Different stem: not a pair, and our own release depends on this staying true.
  assert.deepEqual([...macCompanionZips(['Foo-mac-arm64.dmg', 'Foo-arm64.zip'])], []);
  assert.deepEqual([...macCompanionZips(['Foo-arm64.zip'])], [], 'a zip with no dmg at all');
  assert.deepEqual([...macCompanionZips([])], []);
});

// --- source tarballs and per-release Linux packages --------------------------
//
// Both bugs below were found on a real Kubuntu 26.04 machine tracking obsproject/
// obs-studio: the entry reported "installed 32.2.2, up to date" while the disk held
// 5,413 files of C++ source and no binary, and switching to installer then offered a
// build for the wrong Ubuntu release.

const OBS = A(
  'OBS-Studio-32.2.2-macOS-Apple-dSYMs.tar.xz',
  'OBS-Studio-32.2.2-macOS-Apple.dmg',
  'OBS-Studio-32.2.2-macOS-Intel-dSYMs.tar.xz',
  'OBS-Studio-32.2.2-macOS-Intel.dmg',
  'OBS-Studio-32.2.2-Sources.tar.gz',
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64-dbsym.ddeb',
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb',
  'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64-dbsym.ddeb',
  'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb',
  'OBS-Studio-32.2.2-Windows-arm64-PDBs.zip',
  'OBS-Studio-32.2.2-Windows-arm64.zip',
  'OBS-Studio-32.2.2-Windows-x64-Installer.exe',
  'OBS-Studio-32.2.2-Windows-x64-PDBs.zip',
  'OBS-Studio-32.2.2-Windows-x64.zip'
);

test('linux portable: a source tarball is never a portable build', () => {
  // "Sources" is plural, which the old reject regex missed — it required source to be
  // followed by a separator or end-of-string. A .tar.gz that unpacks into a folder
  // otherwise scores as a perfectly good portable build.
  assert.throws(() => lin(OBS, 'portable', 'x64', null), /only ships an installer/);
  // Singular and bare forms stay rejected too.
  assert.throws(() => lin(A('App-1.0-source.tar.gz'), 'portable', 'x64', null), /no Linux portable asset/);
  assert.throws(() => lin(A('App-1.0-sources.tar.gz'), 'portable', 'x64', null), /no Linux portable asset/);
});

test('linux installer: debug-symbol companions are never the build', () => {
  // A .ddeb/-dbsym is the symbols for a package, not the package.
  assert.throws(
    () => lin(A('App-1.0-Ubuntu-24.04-x86_64-dbsym.ddeb'), 'installer', 'x64', null),
    /no Linux installer asset/
  );
});

test('linux installer: picks the package built for THIS Ubuntu release', () => {
  const on = (versionId) => core.pickAsset(OBS, 'installer', 'x64', null, 'linux', { id: 'ubuntu', versionId });
  assert.equal(on('26.04').name, 'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb');
  assert.equal(on('24.04').name, 'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb');
  // Newer than anything published: fall back to the newest build that is still older,
  // because glibc is backward compatible in that direction and not the other.
  assert.equal(on('28.04').name, 'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb');
  // Older than anything published: nothing here will really run, but a build is still
  // better than an error, and the closest one is the least bad.
  assert.equal(on('22.04').name, 'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb');
});

test('linux installer: an unknown host changes nothing', () => {
  // No /etc/os-release (container, exotic distro) — scoring just drops the release term
  // and every other project, which ships one package for all of Linux, is unaffected.
  const plain = A('App-1.0-amd64.deb', 'App-1.0-x86_64.rpm');
  assert.equal(core.pickAsset(plain, 'installer', 'x64', null, 'linux', null).name, 'App-1.0-amd64.deb');
  assert.equal(
    core.pickAsset(plain, 'installer', 'x64', null, 'linux', { id: 'ubuntu', versionId: '26.04' }).name,
    'App-1.0-amd64.deb'
  );
});

test('linuxReleaseScore: release tokens, however the vendor spells them', () => {
  const { linuxReleaseScore: score } = require('../src/platform/assets');
  const ubuntu = (v) => ({ id: 'ubuntu', versionId: v });
  assert.equal(score('OBS-32.2.2-Ubuntu-26.04-x86_64.deb', ubuntu('26.04')), 6, 'exact');
  assert.equal(score('App-1.0-ubuntu2404.deb', ubuntu('24.04')), 6, 'no-dot form is the same release');
  assert.ok(score('OBS-32.2.2-Ubuntu-24.04-x86_64.deb', ubuntu('26.04')) > 0, 'older is still usable');
  assert.ok(score('OBS-32.2.2-Ubuntu-26.04-x86_64.deb', ubuntu('24.04')) < 0, 'newer is not');
  // 15.6 and 15.06 are one release written two ways — comparing as a float ranked them
  // apart and cost openSUSE an exact match.
  assert.equal(score('App-1.0-opensuse-15.6.rpm', { id: 'opensuse', versionId: '15.6' }), 6);
  // Silent whenever there is nothing to compare, so non-Linux tables and every project
  // shipping one package for all of Linux score exactly as they did before.
  assert.equal(score('App-1.0-amd64.deb', ubuntu('26.04')), 0, 'no release token');
  assert.equal(score('App-1.0-Ubuntu-26.04.deb', null), 0, 'no /etc/os-release');
  assert.equal(score('App-1.0-Ubuntu-26.04.deb', { id: 'fedora', versionId: '42' }), 0, 'different distro');
});

test('linux portable: a .zip must say Linux somewhere to count', () => {
  // notepad-plus-plus publishes no Linux build at all. Every token in
  // "npp.8.9.8.portable.x64.zip" is version, format or architecture — none is a platform
  // word — so it passed the reject regex and scored as a valid Linux portable. The result
  // was notepad++.exe in the portable folder and a reported successful install.
  const npp = A(
    'npp.8.9.8.Installer.x64.exe',
    'npp.8.9.8.Installer.x64.msi',
    'npp.8.9.8.portable.7z',
    'npp.8.9.8.portable.x64.zip'
  );
  assert.throws(() => lin(npp, 'portable', 'x64', null), /no Linux portable asset/);
  // The same release on Windows is unaffected — that zip IS the Windows portable build.
  assert.equal(core.pickAsset(npp, 'portable', 'x64', null, 'win32').name, 'npp.8.9.8.portable.x64.zip');
});

test('linux portable: a .zip that does say Linux still counts', () => {
  // Godot ships its Linux build as a .zip, which is why the rule is about the NAME rather
  // than banning the format outright.
  const godot = A('Godot_v4.5-stable_linux.x86_64.zip', 'Godot_v4.5-stable_win64.exe.zip');
  assert.equal(lin(godot, 'portable', 'x64', null).name, 'Godot_v4.5-stable_linux.x86_64.zip');
  // x11 is the older spelling of the same marker and stays accepted.
  assert.equal(lin(A('Godot_v3.5_x11.64.zip'), 'portable', 'x64', null).name, 'Godot_v3.5_x11.64.zip');
});

test('linux portable: tarballs never needed a platform word and still do not', () => {
  // .tar.gz is the Linux convention, so it qualifies on format alone — the rule added for
  // .zip must not leak onto it.
  assert.equal(lin(A('app-1.0-x86_64.tar.gz'), 'portable', 'x64', null).name, 'app-1.0-x86_64.tar.gz');
  assert.equal(lin(A('app-1.0.AppImage'), 'portable', 'x64', null).name, 'app-1.0.AppImage');
});
