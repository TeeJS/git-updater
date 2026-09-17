'use strict';

// The running-app check around a portable install.
//
// This is the ONLY protection on macOS and Linux. On Windows the directory swap itself
// fails with EBUSY or EPERM when files are open, and install.js turns that into "close
// the app and Retry". A POSIX rename of a running application's directory SUCCEEDS, so
// that backstop does not exist there: measured on macOS, the process stays alive on the
// old inode while its bundle path now resolves to a different version, and everything it
// lazy-loads afterwards comes from the new one. It does not crash at the swap. It
// crosses versions silently.
//
// The check therefore has to run immediately before the swap, not only before the
// download — a download takes seconds to minutes, and that is ample time for the user to
// launch the app.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const github = require('../src/github');
const detect = require('../src/detect');
const runner = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-runner-'));

// `running` is consulted per call, so a test can say "idle at download time, launched by
// install time" — which is the race the second check exists for.
async function withStubs({ running }, fn) {
  const real = {
    getLatestRelease: github.getLatestRelease,
    downloadAsset: github.downloadAsset,
    verifyDigest: github.verifyDigest,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning,
    clearCache: detect.clearCache,
  };
  let call = 0;
  github.getLatestRelease = async () => ({
    tag_name: 'v2.0.0',
    assets: [{ name: 'payload.zip', browser_download_url: 'https://example.invalid/payload.zip' }],
  });
  github.downloadAsset = async (_url, file) => {
    const zip = new AdmZip();
    zip.addFile('app.txt', Buffer.from('v2'));
    zip.writeZip(file);
  };
  github.verifyDigest = () => ({ skipped: true, note: 'no digest in test' });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => running[Math.min(call++, running.length - 1)];
  try {
    return await fn(() => call);
  } finally {
    Object.assign(github, {
      getLatestRelease: real.getLatestRelease,
      downloadAsset: real.downloadAsset,
      verifyDigest: real.verifyDigest,
      fetchChecksumFromRelease: real.fetchChecksumFromRelease,
    });
    detect.isRunning = real.isRunning;
    detect.clearCache = real.clearCache;
  }
}

const configFor = (dir) => ({
  portableRoot: dir,
  // `asset` is pinned so the test exercises the runner rather than the per-platform
  // asset table, which has its own suites.
  repos: [{ owner: 'acme', repo: 'widget', type: 'portable', asset: 'payload.zip', install: { dir: path.join(dir, 'widget') } }],
});

test('runner: an app launched DURING the download is not overwritten', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'widget');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'app.txt'), 'v1'); // the version being used right now

    // Idle when we checked before downloading, running by the time we would swap.
    await withStubs({ running: [false, true] }, async (calls) => {
      const { results } = await runner.run(configFor(dir), { statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'failed');
      assert.match(results[0].reason, /is running — close it, then Retry/);
      assert.equal(calls(), 2, 'checked again immediately before the swap, not just once');
    });

    // The running app still has the version it was launched from.
    assert.equal(fs.readFileSync(path.join(dest, 'app.txt'), 'utf8'), 'v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an app that stays closed throughout is updated normally', async () => {
  const dir = tmp();
  try {
    const dest = path.join(dir, 'widget');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'app.txt'), 'v1');

    await withStubs({ running: [false, false] }, async () => {
      const { results } = await runner.run(configFor(dir), { statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'updated', results[0].reason);
    });

    assert.equal(fs.readFileSync(path.join(dest, 'app.txt'), 'utf8'), 'v2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: an app already running is refused before anything is downloaded', async () => {
  const dir = tmp();
  try {
    await withStubs({ running: [true] }, async (calls) => {
      const { results } = await runner.run(configFor(dir), { statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'failed');
      assert.equal(calls(), 1, 'no point downloading what cannot be installed');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A .dmg guarded by a click-through licence agreement can't be unpacked unattended.
// Rather than dead-end, the runner hands the image to macOS (opts.openFile) so its own
// dialog shows the licence for the user to accept, then they install by hand. The licence
// error is identified by the `licenceAgreement` flag extractDmg sets, so this drives the
// runner branch without needing a real hdiutil-mounted image.
const install = require('../src/install');

test('runner: a licence-agreement dmg is opened for the user to accept, not dead-ended', async () => {
  const dir = tmp();
  const realInstallPortable = install.installPortable;
  install.installPortable = async () => {
    const e = new Error('this disk image requires agreeing to a licence agreement before it can be opened');
    e.licenceAgreement = true;
    throw e;
  };
  try {
    const opened = [];
    await withStubs({ running: [false, false] }, async () => {
      const { results } = await runner.run(configFor(dir), {
        statePath: path.join(dir, 'state.json'),
        openFile: (f) => opened.push(f),
      });
      assert.equal(results[0].status, 'failed');
      assert.match(results[0].reason, /disk image opened — accept the licence/);
      assert.equal(opened.length, 1, 'the image was handed to macOS to open');
      assert.match(opened[0], /payload\.zip$/, 'opened the downloaded image, from a stable path');
    });
  } finally {
    install.installPortable = realInstallPortable;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: a licence-agreement dmg still dead-ends cleanly when there is no way to open it', async () => {
  const dir = tmp();
  const realInstallPortable = install.installPortable;
  install.installPortable = async () => {
    const e = new Error('this disk image requires agreeing to a licence agreement before it can be opened');
    e.licenceAgreement = true;
    throw e;
  };
  try {
    await withStubs({ running: [false, false] }, async () => {
      // No openFile in opts (e.g. a headless run): the original licence error stands.
      const { results } = await runner.run(configFor(dir), { statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'failed');
      assert.match(results[0].reason, /requires agreeing to a licence agreement/);
    });
  } finally {
    install.installPortable = realInstallPortable;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A portable entry for an app the user installed by hand (found in the OS inventory, not in
// git-updater's folder). At the latest version it must read as CURRENT — not as "not
// installed", and not as a broken managed install to redo, which the empty folder would
// otherwise trigger. This is the Deskflow case: a dmg with a licence gate can only be
// installed by hand, so it never lands in the portable folder.
test('runner: a hand-installed portable (OS inventory) at latest reads as current, not a reinstall', async () => {
  const dir = tmp();
  const realInstalledVersion = detect.installedVersion;
  detect.installedVersion = async () => '2.0.0'; // present in the OS inventory, matches latest
  try {
    // Deliberately DO NOT create dir/widget: git-updater manages no copy, its folder is empty.
    await withStubs({ running: [false] }, async () => {
      const { results } = await runner.run(configFor(dir), { statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'current', results[0].reason);
      assert.match(String(results[0].from), /2\.0\.0/, 'reports the OS-detected version as installed');
    });
  } finally {
    detect.installedVersion = realInstalledVersion;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
