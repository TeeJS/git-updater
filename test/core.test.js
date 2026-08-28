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
