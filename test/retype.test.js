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
  const out = runner.retypeIfNoInstaller(repo, rel('widget-1.2.3-linux-x86_64.AppImage'), '/home/tj/Apps', 'linux');
  assert.equal(out.to, 'portable');
  assert.equal(repo.type, 'portable');
  assert.equal(repo.install.dir, '/home/tj/Apps/widget');
});

test('retype: the disclosure names the consequence, not just the new type', () => {
  const out = runner.retypeIfNoInstaller(entry(), rel('widget-1.2.3-linux-x86_64.AppImage'), '/apps', 'linux');
  // The user has to be told the portable copy installs BESIDE a package-managed one,
  // because untracking is a legitimate response and they cannot choose it otherwise.
  assert.match(out.note, /Portable/);
  assert.match(out.note, /alongside/);
});

test('retype: an entry whose repo does ship a package is left alone', () => {
  const repo = entry();
  assert.equal(runner.retypeIfNoInstaller(repo, rel('widget_1.2.3_amd64.deb'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: a release with nothing usable at all stays an error, it is not retyped', () => {
  const repo = entry();
  assert.equal(runner.retypeIfNoInstaller(repo, rel('Source code (tar.gz)'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: a portable entry is never touched', () => {
  const repo = entry({ type: 'portable', install: { dir: '/apps/widget' } });
  assert.equal(runner.retypeIfNoInstaller(repo, rel('widget-x86_64.AppImage'), '/apps'), null);
  assert.equal(repo.type, 'portable');
});

test('retype: a hand-pinned asset pattern is respected rather than overridden', () => {
  const repo = entry({ asset: '*.AppImage' });
  assert.equal(runner.retypeIfNoInstaller(repo, rel('widget-x86_64.AppImage'), '/apps'), null);
  assert.equal(repo.type, 'installer');
});

test('retype: with no portable folder configured the existing clear error stands', () => {
  const repo = entry();
  assert.equal(runner.retypeIfNoInstaller(repo, rel('widget-x86_64.AppImage'), ''), null);
  assert.equal(repo.type, 'installer');
});

test('retype: an explicit install.dir is preferred over the portable root', () => {
  const repo = entry({ install: { dir: '/custom/place' } });
  const out = runner.retypeIfNoInstaller(repo, rel('widget-x86_64.AppImage'), '/apps', 'linux');
  assert.equal(out.dir, '/custom/place');
  assert.equal(repo.install.dir, '/custom/place');
});
