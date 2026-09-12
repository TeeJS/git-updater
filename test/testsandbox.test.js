'use strict';

// The test suite must never touch the user's real files.
//
// It did. Before this guard, running npm test appended 189 lines to a real machine's log
// claiming installs that never happened — "OK acme/widget#portable: installed 2.0.0" —
// in the one file a user opens to find out what actually went wrong. The runner tests
// redirected config and state and not the logger, and nothing made that omission visible.
//
// The fix is structural rather than a reminder: under the test runner the paths module
// resolves into a per-process temp sandbox, so a test cannot reach real data by
// forgetting. These assertions are what stop that guarantee being quietly removed.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const paths = require('../src/paths');
const { LOG_DIR } = require('../src/log');

const tmpRoot = path.resolve(os.tmpdir());
const inTemp = (p) => path.resolve(p).startsWith(tmpRoot + path.sep);

test('paths: the suite is running inside a sandbox, not the user home', () => {
  assert.ok(paths.underTest(), 'NODE_TEST_CONTEXT should be set by node --test');
  assert.ok(inTemp(paths.configDir()), `config dir escaped the sandbox: ${paths.configDir()}`);
  assert.ok(inTemp(paths.dataDir()), `data dir escaped the sandbox: ${paths.dataDir()}`);
});

test('paths: the log — the file this actually polluted — is inside the sandbox too', () => {
  // log.js computes its directory at require time, so this asserts the real resolved
  // value rather than what paths.js would return if asked again now.
  assert.ok(inTemp(LOG_DIR), `log dir escaped the sandbox: ${LOG_DIR}`);
});

test('paths: neither directory is the real one for this platform', () => {
  const real = {
    config: path.join(paths.configRoot(), paths.APP),
    data: path.join(paths.dataRoot(), paths.APP),
  };
  assert.notEqual(path.resolve(paths.configDir()), path.resolve(real.config));
  assert.notEqual(path.resolve(paths.dataDir()), path.resolve(real.data));
});

test('paths: the sandbox is stable within a run, so state survives a test', () => {
  // A test that writes state early and reads it later must see the same directory.
  assert.equal(paths.configDir(), paths.configDir());
  assert.equal(paths.dataDir(), paths.dataDir());
});

test('paths: an explicit override still wins, so a test can aim somewhere on purpose', () => {
  const before = process.env.GITUPDATER_CONFIG_DIR;
  const aim = path.join(os.tmpdir(), 'deliberate-target');
  process.env.GITUPDATER_CONFIG_DIR = aim;
  try {
    assert.equal(paths.configDir(), aim);
  } finally {
    if (before === undefined) delete process.env.GITUPDATER_CONFIG_DIR;
    else process.env.GITUPDATER_CONFIG_DIR = before;
  }
});
