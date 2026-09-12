'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

test('cmpVersion: basic ordering', () => {
  assert.ok(core.cmpVersion('1.2.1', '1.2.0') > 0);
  assert.ok(core.cmpVersion('1.2.0', '1.2.1') < 0);
  assert.equal(core.cmpVersion('1.2.0', '1.2.0'), 0);
});

test('cmpVersion: leading v is stripped', () => {
  assert.equal(core.cmpVersion('v1.2.0', '1.2.0'), 0);
  assert.ok(core.cmpVersion('v2.0.0', 'v1.9.9') > 0);
});

test('cmpVersion: 1.2 equals 1.2.0', () => {
  assert.equal(core.cmpVersion('1.2', '1.2.0'), 0);
});

test('cmpVersion: prerelease is older than release', () => {
  assert.ok(core.cmpVersion('1.2.0-rc1', '1.2.0') < 0);
  assert.ok(core.cmpVersion('1.2.0', '1.2.0-rc1') > 0);
  assert.ok(core.cmpVersion('1.2.0-rc2', '1.2.0-rc1') > 0);
});

test('cmpVersion: unseen (empty) is always older', () => {
  assert.ok(core.cmpVersion('0.0.1', '') > 0);
});

test('matchAsset: glob single hit', () => {
  const assets = [{ name: 'tool-win-x64.zip' }, { name: 'tool-linux.tar.gz' }];
  assert.equal(core.matchAsset(assets, '*-win-x64.zip').name, 'tool-win-x64.zip');
});

test('matchAsset: regex single hit', () => {
  const assets = [{ name: 'app-1.2.3-setup.exe' }, { name: 'app-1.2.3.zip' }];
  assert.equal(core.matchAsset(assets, '/setup\\.exe$/').name, 'app-1.2.3-setup.exe');
});

test('matchAsset: zero matches throws with available names', () => {
  const assets = [{ name: 'a.zip' }, { name: 'b.zip' }];
  assert.throws(() => core.matchAsset(assets, '*.exe'), /Available: a\.zip, b\.zip/);
});

test('matchAsset: many matches asks to tighten', () => {
  const assets = [{ name: 'x-win.zip' }, { name: 'y-win.zip' }];
  assert.throws(() => core.matchAsset(assets, '*-win.zip'), /matched 2 assets/);
});

test('installerCmd: defaults per kind', () => {
  assert.deepEqual(core.installerCmd('nsis', 'S.exe'), { exe: 'S.exe', args: ['/S'] });
  assert.deepEqual(core.installerCmd('inno', 'S.exe'), {
    exe: 'S.exe',
    args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
  });
  assert.deepEqual(core.installerCmd('msi', 'P.msi'), {
    exe: 'msiexec',
    args: ['/i', 'P.msi', '/qn', '/norestart'],
  });
});

test('installerCmd: override args', () => {
  assert.deepEqual(core.installerCmd('nsis', 'S.exe', ['/S', '/D=C:\\X']), {
    exe: 'S.exe',
    args: ['/S', '/D=C:\\X'],
  });
  assert.deepEqual(core.installerCmd('msi', 'P.msi', ['/quiet']), {
    exe: 'msiexec',
    args: ['/i', 'P.msi', '/quiet'],
  });
});

test('installerCmd: unknown kind throws', () => {
  assert.throws(() => core.installerCmd('wix', 'x.exe'), /unknown installer kind/);
});

test('validateConfig: accepts a good config', () => {
  const cfg = {
    repos: [
      { owner: 'o', repo: 'r', type: 'portable', asset: '*.zip', install: { dir: 'C:/x' } },
      { owner: 'o', repo: 's', type: 'installer', asset: '*.exe', install: { kind: 'nsis' } },
    ],
  };
  assert.equal(core.validateConfig(cfg), cfg);
});

test('validateConfig: rejects bad type / missing fields / bad kind', () => {
  assert.throws(() => core.validateConfig({}), /"repos" array is required/);
  assert.throws(
    () => core.validateConfig({ repos: [{ owner: 'o', repo: 'r', type: 'weird', asset: '*', install: {} }] }),
    /type/
  );
  assert.throws(
    () => core.validateConfig({ repos: [{ owner: 'o', repo: 'r', type: 'portable', asset: '*', install: {} }] }),
    /install\.dir/
  );
  assert.throws(
    () =>
      core.validateConfig({
        repos: [{ owner: 'o', repo: 'r', type: 'installer', asset: '*', install: { kind: 'wix' } }],
      }),
    /install\.kind/
  );
  assert.throws(
    () =>
      core.validateConfig({
        repos: [{ owner: 'o', repo: 'r', type: 'installer', asset: '*', tagPrefix: '' }],
      }),
    /tagPrefix/
  );
});

test('validateConfig: accepts a tagPrefix override', () => {
  const cfg = {
    repos: [{ owner: 'bitwarden', repo: 'clients', type: 'installer', asset: '*.exe', tagPrefix: 'desktop-v' }],
  };
  assert.equal(core.validateConfig(cfg), cfg);
});

test('buildSummary: counts and lines', () => {
  const s = core.buildSummary([
    { repo: 'o/a', status: 'updated', from: '1.0.0', to: '1.1.0' },
    { repo: 'o/b', status: 'current', to: '2.0.0' },
    { repo: 'o/c', status: 'failed', reason: 'boom' },
  ]);
  assert.deepEqual(s.counts, { updated: 1, current: 1, failed: 1 });
  assert.match(s.text, /updated 1, current 1, failed 1/);
  assert.match(s.text, /o\/a  1\.0\.0 → 1\.1\.0/);
  assert.match(s.text, /o\/c  boom/);
});

// --- version strings that used to collapse to zero ----------------------------
// splitVer's regex is anchored at both ends, and the no-match branch returned zero.
// Zero reads as "older than every release", so the row says an update is available, the
// user installs it, the version string does not change, and the row never clears.

test('cmpVersion: a trailing build number in parentheses is metadata, not precedence', () => {
  // Apple's own display convention: CFBundleShortVersionString then CFBundleVersion.
  // Measured on a real Mac: Zoom reports exactly "7.1.5 (84650)".
  assert.equal(core.cmpVersion('7.1.5 (84650)', '7.1.5'), 0, 'no phantom update');
  assert.equal(core.cmpVersion('7.1.5 (84650)', 'v7.1.5'), 0);
  assert.ok(core.cmpVersion('7.1.5 (84650)', '7.1.6') < 0, 'a real update is still offered');
  assert.ok(core.cmpVersion('7.1.6 (84651)', '7.1.5') > 0);
  // Before the fix these were all EQUAL, because both sides collapsed to zero.
  assert.ok(core.cmpVersion('7.1.5 (84650)', '99.0.0 (1)') < 0);
});

test('cmpVersion: a prerelease survives a parenthesised build suffix', () => {
  // This case was NOT broken before: the hyphen let the anchored regex match, with
  // "rc1 (build 5)" landing in the prerelease group. So this guards the new paren strip
  // against BREAKING it, rather than catching the old bug — stripping the parens before
  // the match is what keeps rc1, where a leading-run fallback alone would discard it.
  // Stated plainly because a test that cannot fail either way is worth nothing, and this
  // one only fails if the strip is done in the wrong place.
  assert.ok(core.cmpVersion('1.2.3-rc1 (build 5)', '1.2.2') > 0, 'rc1 of 1.2.3 beats 1.2.2');
  assert.ok(core.cmpVersion('1.2.3-rc1 (build 5)', '1.2.3') < 0, 'but is older than final');
  assert.ok(core.cmpVersion('1.2.3-rc2 (build 9)', '1.2.3-rc1 (build 5)') > 0, 'rc2 beats rc1');
});

test('cmpVersion: an unparseable tail falls back to the leading run, not to zero', () => {
  assert.equal(core.cmpVersion('1.2.3 build 9', '1.2.3'), 0);
  assert.ok(core.cmpVersion('1.2.3 build 9', '1.2.4') < 0);
  // Genuinely numberless strings still have nothing to compare and stay at zero.
  assert.equal(core.cmpVersion('nightly', 'nightly'), 0);
});

test('cmpVersion: the shapes that already worked still work', () => {
  // Real strings measured off a Mac's inventory, plus the two suffix cases that
  // 67c8c9e and alignInstalledVersion were written for.
  assert.equal(core.cmpVersion('26246.1702.5102.8942', '26246.1702.5102.8942'), 0);
  assert.equal(core.cmpVersion('26.032.0217', '26.032.0217'), 0);
  assert.ok(core.cmpVersion('1.2', '1.2.0') === 0);
  assert.ok(core.cmpVersion('1.2.0-rc1', '1.2.0') < 0);
  assert.ok(core.cmpVersion('1.2.0+abc', '1.2.0') === 0);
  assert.equal(core.alignInstalledVersion('5.5.3.20260724', '5.5.3'), '5.5.3');
  assert.equal(core.alignInstalledVersion('152.1.94.117', '1.94.117'), '1.94.117');
});
