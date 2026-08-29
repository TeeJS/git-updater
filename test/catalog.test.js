'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { matchInstalled } = require('../src/catalog');

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
