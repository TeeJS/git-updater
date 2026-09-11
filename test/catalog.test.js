'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CATALOG, matchInstalled } = require('../src/catalog');

test('catalog: no duplicate repos', () => {
  const repos = CATALOG.map((e) => e.repo.toLowerCase());
  assert.deepEqual([...new Set(repos)].length, repos.length);
});

test('catalog: generic names stay exact-anchored (no false positives)', () => {
  const rows = matchInstalled(
    [{ DisplayName: 'Bunch of Tools' }, { DisplayName: 'uvex Driver' }, { DisplayName: 'action runner' }, { DisplayName: 'pilot' }].map((e) => ({ ...e, DisplayVersion: '1' })),
    new Set()
  );
  assert.deepEqual(rows, []);
});

const I = (...names) => names.map((DisplayName) => ({ DisplayName, DisplayVersion: '1.0' }));

test('matchInstalled: finds known apps by registry DisplayName', () => {
  const rows = matchInstalled(
    I('7-Zip 26.02 (x64 edition)', 'Notepad++ (64-bit x64)', 'Git version 2.47.0', 'Some Random App'),
    new Set()
  );
  assert.deepEqual(rows.map((r) => r.repo).sort(), ['git-for-windows/git', 'ip7z/7zip', 'notepad-plus-plus/notepad-plus-plus']);
});

test('matchInstalled: marks already-tracked repos', () => {
  const rows = matchInstalled(I('7-Zip 26.02 (x64 edition)'), new Set(['ip7z/7zip']));
  assert.equal(rows[0].tracked, true);
});

test('matchInstalled: Temurin maps per major version', () => {
  const rows = matchInstalled(I('Eclipse Temurin JRE with Hotspot 21.0.5+11 (x64)'), new Set());
  assert.deepEqual(rows.map((r) => r.repo), ['adoptium/temurin21-binaries']);
});

test('catalog: Windows-only entries are never offered on macOS or Linux', () => {
  const winOnly = I('ShareX', 'Notepad++ (64-bit x64)', 'PowerToys (Preview)');
  assert.ok(matchInstalled(winOnly, new Set(), 'win32').length > 0);
  assert.deepEqual(matchInstalled(winOnly, new Set(), 'darwin'), []);
  assert.deepEqual(matchInstalled(winOnly, new Set(), 'linux'), []);
});

test('catalog: an entry with no platforms field is offered everywhere', () => {
  const cross = I('OBS Studio');
  for (const p of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(matchInstalled(cross, new Set(), p).map((r) => r.repo), ['obsproject/obs-studio'], p);
  }
});

test('catalog: every platforms field names only real platform keys', () => {
  const valid = new Set(['win32', 'darwin', 'linux']);
  for (const e of CATALOG) {
    if (!e.platforms) continue;
    assert.ok(Array.isArray(e.platforms) && e.platforms.length, e.name);
    for (const p of e.platforms) assert.ok(valid.has(p), `${e.name}: ${p}`);
  }
});
