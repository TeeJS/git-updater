'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { CATALOG, matchInstalled } = require('../src/catalog');

test('catalog: no duplicate repos', () => {
  const repos = CATALOG.map((e) => e.repo.toLowerCase());
  assert.deepEqual([...new Set(repos)].length, repos.length);
});

// Every fixture below is a Windows uninstall-registry DisplayName, so each call pins 'win32'.
// Without it the platform defaults to the host and the Windows-only catalog entries are
// filtered out before matching, which makes these assertions vacuous anywhere else.
test('catalog: generic names stay exact-anchored (no false positives)', () => {
  const rows = matchInstalled(
    [{ DisplayName: 'Bunch of Tools' }, { DisplayName: 'uvex Driver' }, { DisplayName: 'action runner' }, { DisplayName: 'pilot' }].map((e) => ({ ...e, DisplayVersion: '1' })),
    new Set(),
    'win32'
  );
  assert.deepEqual(rows, []);
});

const I = (...names) => names.map((DisplayName) => ({ DisplayName, DisplayVersion: '1.0' }));

test('matchInstalled: finds known apps by registry DisplayName', () => {
  const rows = matchInstalled(
    I('7-Zip 26.02 (x64 edition)', 'Notepad++ (64-bit x64)', 'Git version 2.47.0', 'Some Random App'),
    new Set(),
    'win32'
  );
  assert.deepEqual(rows.map((r) => r.repo).sort(), ['git-for-windows/git', 'ip7z/7zip', 'notepad-plus-plus/notepad-plus-plus']);
});

test('matchInstalled: marks already-tracked repos', () => {
  const rows = matchInstalled(I('7-Zip 26.02 (x64 edition)'), new Set(['ip7z/7zip']), 'win32');
  assert.equal(rows[0].tracked, true);
});

test('matchInstalled: Temurin maps per major version', () => {
  const rows = matchInstalled(I('Eclipse Temurin JRE with Hotspot 21.0.5+11 (x64)'), new Set(), 'win32');
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

// --- Linux matching -----------------------------------------------------------
// A Linux inventory is thousands of short machine identifiers, not a hundred human
// names. These three cases are real: they came off an ordinary Debian desktop whose
// 2825 package names were run through the catalog.

test('catalog: Linux does not match a shared library for the application', () => {
  const rows = matchInstalled(I('libtesseract5', 'libtesseract-dev'), new Set(), 'linux');
  assert.deepEqual(rows, [], 'libtesseract5 is a library, not tesseract-ocr/tesseract');
});

test('catalog: Linux does not match an unrelated package that shares a name', () => {
  // "orca" on Linux is the GNOME screen reader; the catalog entry is stablyai/orca.
  const rows = matchInstalled(I('orca'), new Set(), 'linux');
  assert.deepEqual(rows, []);
});

test('catalog: Linux matches the real package name, which the display regex misses', () => {
  // The deb is "7zip"; the Windows DisplayName pattern is /^7-Zip/i and never matches it.
  const rows = matchInstalled(I('7zip'), new Set(), 'linux');
  assert.deepEqual(rows.map((r) => r.repo), ['ip7z/7zip']);
});

test('catalog: Linux matches flatpak and snap human names as well as package names', () => {
  assert.deepEqual(matchInstalled(I('obs-studio'), new Set(), 'linux').map((r) => r.repo), ['obsproject/obs-studio']);
  assert.deepEqual(matchInstalled(I('OBS Studio'), new Set(), 'linux').map((r) => r.repo), ['obsproject/obs-studio']);
});

test('catalog: an entry with no linux identifiers is not offered on Linux at all', () => {
  const noIds = CATALOG.filter((e) => !e.linux && (!e.platforms || e.platforms.includes('linux')));
  assert.ok(noIds.length, 'fixture assumes some entries are still unannotated');
  // Feed every such entry its own name and confirm none of them produce a row.
  const rows = matchInstalled(I(...noIds.map((e) => e.name)), new Set(), 'linux');
  assert.deepEqual(rows, []);
});

test('catalog: every linux identifier list is a non-empty array of non-empty strings', () => {
  for (const e of CATALOG) {
    if (!e.linux) continue;
    assert.ok(Array.isArray(e.linux) && e.linux.length, e.name);
    for (const id of e.linux) assert.ok(typeof id === 'string' && id.trim(), `${e.name}: ${id}`);
  }
});

test('catalog: Windows and macOS still use the display-name regex', () => {
  assert.deepEqual(matchInstalled(I('7-Zip 26.02 (x64 edition)'), new Set(), 'win32').map((r) => r.repo), ['ip7z/7zip']);
  assert.deepEqual(matchInstalled(I('OBS Studio'), new Set(), 'darwin').map((r) => r.repo), ['obsproject/obs-studio']);
});

test('catalog: p7zip-full is not treated as 7-Zip', () => {
  // A separate POSIX fork frozen at 16.02, and a transitional stub in current Debian.
  // Matching it to ip7z/7zip (26.x) would report an update against a version line that
  // is not the installed project's, and the row could never clear.
  assert.deepEqual(matchInstalled(I('p7zip-full'), new Set(), 'linux'), []);
  assert.deepEqual(matchInstalled(I('7zip'), new Set(), 'linux').map((r) => r.repo), ['ip7z/7zip']);
});

test('catalog: no linux identifier is claimed by two different repos', () => {
  // Exact matching means a shared identifier silently offers the user two different
  // projects for one installed package.
  const owner = new Map();
  for (const e of CATALOG) {
    for (const id of e.linux || []) {
      const key = id.toLowerCase();
      const prev = owner.get(key);
      assert.ok(!prev || prev === e.repo, `"${id}" claimed by both ${prev} and ${e.repo}`);
      owner.set(key, e.repo);
    }
  }
});
