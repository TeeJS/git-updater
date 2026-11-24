'use strict';

// A failed update stays red after git-updater restarts, until it succeeds or a newer version
// comes out. Found on OBS: its installer failed (exit 6), git-updater then updated itself and
// restarted, and the row came back grey with nothing to say the update had never happened.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const github = require('../src/github');
const detect = require('../src/detect');
const runner = require('../src/runner');
const core = require('../src/core');
const state = require('../src/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-failmem-'));

async function withWorld({ tag = 'v2.0.0', installed = '1.0.0', download }, fn) {
  const real = {
    getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning, clearCache: detect.clearCache,
    installedVersion: detect.installedVersion, installedFlavor: detect.installedFlavor, installedCopies: detect.installedCopies,
  };
  const world = { tag };
  github.getLatestRelease = async () => ({
    tag_name: world.tag,
    assets: [{ name: 'payload.zip', browser_download_url: 'https://example.invalid/payload.zip' }],
  });
  github.downloadAsset = download || (async () => { throw new Error('the download was cut short — try again later'); });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => installed;
  detect.installedFlavor = async () => null;
  detect.installedCopies = async () => [];
  try {
    return await fn(world);
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, {
      isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion,
      installedFlavor: real.installedFlavor, installedCopies: real.installedCopies,
    });
  }
}

const entry = { owner: 'acme', repo: 'studio', type: 'installer', asset: 'payload.zip', install: { kind: 'nsis' } };
const KEY = 'acme/studio#installer';

test('a failed update is saved with the version it was for, and a check keeps the row red', async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  try {
    await withWorld({}, async (world) => {
      const run = (await runner.run({ repos: [entry] }, { statePath })).results[0];
      assert.equal(run.status, 'failed');
      const lf = state.load(statePath)[KEY].lastFailure;
      assert.equal(lf.to, '2.0.0');
      assert.match(lf.reason, /cut short/);

      // After a restart a check reads the same: red, with the same reason. Not blue, as if never tried.
      const check = (await runner.run({ repos: [entry] }, { mode: 'check', statePath })).results[0];
      assert.equal(check.status, 'failed');
      assert.match(check.reason, /cut short/);
      assert.equal(check.to, '2.0.0');

      // A newer version is out: that one has not failed, so it is offered as usual.
      world.tag = 'v2.1.0';
      const newer = (await runner.run({ repos: [entry] }, { mode: 'check', statePath })).results[0];
      assert.equal(newer.status, 'updated');
      assert.equal(newer.to, '2.1.0');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a check and a dry run never save a failure', async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  try {
    await withWorld({}, async () => {
      await runner.run({ repos: [entry] }, { mode: 'check', statePath });
      await runner.run({ repos: [entry] }, { dryRun: true, statePath });
      assert.equal(fs.existsSync(statePath) && state.load(statePath)[KEY] && state.load(statePath)[KEY].lastFailure, false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure before the release was read (rate limit) is not saved: there is no version to hold it to', async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  const real = github.getLatestRelease;
  github.getLatestRelease = async () => { const e = new Error('GitHub rate limit hit'); e.rateLimited = true; throw e; };
  try {
    const r = (await runner.run({ repos: [entry] }, { statePath })).results[0];
    assert.equal(r.status, 'failed');
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    github.getLatestRelease = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failureOf: the window opens the row red until that version or a newer one is installed', () => {
  const rec = { tag: '1.0.0', lastFailure: { to: '2.0.0', reason: 'installer failed (exit 6)' } };
  assert.equal(core.failureOf(rec, '1.0.0').reason, 'installer failed (exit 6)');
  assert.equal(core.failureOf(rec, null).to, '2.0.0', 'a first install that failed is red too');
  assert.equal(core.failureOf(rec, '2.0.0'), null, 'installed since, by hand or by its own window');
  assert.equal(core.failureOf(rec, '2.1.0'), null);
  assert.equal(core.failureOf({ tag: '1.0.0' }, '1.0.0'), null);
  assert.equal(core.failureOf(undefined, '1.0.0'), null);
});

test('a successful install replaces the record, so the failure is gone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner.js'), 'utf8');
  // recordInstalled writes a fresh record (into[key] = { ... }), never a merge that would keep lastFailure.
  assert.match(src, /into\[key\] = \{\s*repo: id,/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /delete stt\[appKey\]\.lastFailure/, 'an install finished in the app\'s own window clears it too');
});

test('window: a row with a saved failure opens red, with its reason', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.match(html, /if \(i\.failed && s\.ph === 'idle'\) \{ s\.ph = 'failed'; s\.reason = i\.failed\.reason;/);
});
