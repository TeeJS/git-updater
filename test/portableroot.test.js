'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');

test('portable entry with no install.dir defaults to portableRoot/<repo>', () => {
  const cfg = {
    portableRoot: 'C:/PortableApps',
    repos: [{ owner: 'ShareX', repo: 'ShareX', type: 'portable', asset: '*.zip' }],
  };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/PortableApps/ShareX');
});

test('trailing slash on portableRoot is not doubled', () => {
  assert.strictEqual(core.resolvePortableDir('C:/Apps/', 'fd'), 'C:/Apps/fd');
  assert.strictEqual(core.resolvePortableDir('C:\\Apps\\', 'fd'), 'C:\\Apps/fd');
});

test('explicit install.dir is preserved over portableRoot', () => {
  const cfg = {
    portableRoot: 'C:/PortableApps',
    repos: [{ owner: 'o', repo: 'r', type: 'portable', asset: '*.zip', install: { dir: 'D:/Custom' } }],
  };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'D:/Custom');
});

test('portable with neither install.dir nor portableRoot throws', () => {
  const cfg = { repos: [{ owner: 'o', repo: 'r', type: 'portable', asset: '*.zip' }] };
  assert.throws(() => core.validateConfig(cfg), /portableRoot/);
});
