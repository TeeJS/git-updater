'use strict';

// Every call passes the platform explicitly, so the decision table is exercised the
// same way on every host rather than only the one the suite happens to run on.
//
// Scan adds every discovered app as an installer. For a project that publishes no .deb,
// .rpm, .msi or setup .exe that entry can never succeed, so the first check corrects it
// to portable using the release payload it already holds.

const { test } = require('node:test');
const assert = require('node:assert');
const runner = require('../src/runner');

const rel = (...names) => ({ tag_name: 'v1.2.3', assets: names.map((name) => ({ name })) });
const entry = (over = {}) => ({ owner: 'acme', repo: 'widget', type: 'installer', ...over });

test('retype: an installer entry whose repo ships only portable builds becomes portable', () => {
  const repo = entry();
  const out = runner.retypeIfUnavailable(repo, rel('widget-1.2.3-linux-x86_64.AppImage'), '/home/tj/Apps', 'linux');
  assert.equal(out.to, 'portable');
  assert.equal(repo.type, 'portable');
  assert.equal(repo.install.dir, '/home/tj/Apps/widget');
});

test('retype: the disclosure names the consequence, not just the new type', () => {
  const out = runner.retypeIfUnavailable(entry(), rel('widget-1.2.3-linux-x86_64.AppImage'), '/apps', 'linux');
  // The user has to be told the portable copy installs BESIDE a package-managed one,
  // because untracking is a legitimate response and they cannot choose it otherwise.
  assert.match(out.note, /Portable/);
  assert.match(out.note, /alongside/);
});

test('retype: an entry whose repo does ship a package is left alone', () => {
  const repo = entry();
  assert.equal(runner.retypeIfUnavailable(repo, rel('widget_1.2.3_amd64.deb'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: a release with nothing usable at all stays an error, it is not retyped', () => {
  const repo = entry();
  assert.equal(runner.retypeIfUnavailable(repo, rel('Source code (tar.gz)'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: a portable entry whose repo does ship a portable build is left alone', () => {
  const repo = entry({ type: 'portable', install: { dir: '/apps/widget' } });
  assert.equal(runner.retypeIfUnavailable(repo, rel('widget-x86_64.AppImage'), '/apps'), null);
  assert.equal(repo.type, 'portable');
});

test('retype: a hand-pinned asset pattern is respected rather than overridden', () => {
  const repo = entry({ asset: '*.AppImage' });
  assert.equal(runner.retypeIfUnavailable(repo, rel('widget-x86_64.AppImage'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: with no portable folder configured the existing clear error stands', () => {
  const repo = entry();
  assert.equal(runner.retypeIfUnavailable(repo, rel('widget-x86_64.AppImage'), ''), null);
  assert.equal(repo.type, 'installer');
});

test('retype: an explicit install.dir is preferred over the portable root', () => {
  const repo = entry({ install: { dir: '/custom/place' } });
  const out = runner.retypeIfUnavailable(repo, rel('widget-x86_64.AppImage'), '/apps', 'linux');
  assert.equal(out.dir, '/custom/place');
  assert.equal(repo.install.dir, '/custom/place');
});

// --- the other direction -----------------------------------------------------
//
// Found on Kubuntu 26.04 tracking obsproject/obs-studio as portable. OBS publishes
// Ubuntu .debs, macOS .dmgs and Windows .zips; the only Linux-shaped .tar.gz in the
// release is the SOURCE tarball. The entry reported "installed, up to date" over a
// directory of C++ that had never been built.

const OBS = rel(
  'OBS-Studio-32.2.2-macOS-Apple.dmg',
  'OBS-Studio-32.2.2-Sources.tar.gz',
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb',
  'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb',
  'OBS-Studio-32.2.2-Windows-x64.zip'
);

test('retype: a portable entry whose repo ships only a package becomes an installer', () => {
  const repo = entry({ type: 'portable', install: { dir: '/apps/obs' } });
  const out = runner.retypeIfUnavailable(repo, OBS, '/apps', 'linux');
  assert.equal(out.from, 'portable');
  assert.equal(out.to, 'installer');
  assert.equal(repo.type, 'installer');
});

test('retype: switching to Installer discloses root and system-wide, not just the type', () => {
  const repo = entry({ type: 'portable', install: { dir: '/apps/obs' } });
  const out = runner.retypeIfUnavailable(repo, OBS, '/apps', 'linux');
  assert.match(out.note, /system-wide/);
  assert.match(out.note, /authorization/);
});

test('retype: the portable folder survives the switch to installer', () => {
  // Unused while the entry is an installer, but switching back by hand should not make
  // the user pick the folder again.
  const repo = entry({ type: 'portable', install: { dir: '/apps/obs' } });
  runner.retypeIfUnavailable(repo, OBS, '/apps', 'linux');
  assert.equal(repo.install.dir, '/apps/obs');
});

test('retype: a source tarball does not count as a portable build', () => {
  // The whole point: if Sources.tar.gz scored as portable there would be nothing to
  // correct, and the entry would go on reporting a successful install of source code.
  const repo = entry({ type: 'portable', install: { dir: '/apps/obs' } });
  assert.equal(runner.retypeIfUnavailable(repo, OBS, '/apps', 'linux').to, 'installer');
});

test('retype: on Windows the same entry needs no correction', () => {
  // OBS ships a Windows .zip, so the portable entry is already right there. The rule is
  // about what a release actually contains, not about Linux.
  const repo = entry({ type: 'portable', install: { dir: 'C:\\Apps\\obs' } });
  assert.equal(runner.retypeIfUnavailable(repo, OBS, 'C:\\Apps', 'win32'), null);
  assert.equal(repo.type, 'portable');
});

test('retype: a hand-pinned asset pattern is respected in this direction too', () => {
  const repo = entry({ type: 'portable', asset: '*.tar.gz', install: { dir: '/apps/obs' } });
  assert.equal(runner.retypeIfUnavailable(repo, OBS, '/apps', 'linux'), null);
  assert.equal(repo.type, 'portable');
});

test('retype: a release with no Linux build at all stays an error', () => {
  const winOnly = rel('App-1.0-Windows-x64.zip', 'App-1.0-Windows-x64-Installer.exe');
  const repo = entry({ type: 'portable', install: { dir: '/apps/app' } });
  assert.equal(runner.retypeIfUnavailable(repo, winOnly, '/apps', 'linux'), null);
  assert.equal(repo.type, 'portable');
});
