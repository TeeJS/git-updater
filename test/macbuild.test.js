'use strict';

// The build guard. electron-builder's mac.notarize is a request, not a guarantee: with
// no credentials it logs a skip and exits 0, producing a correctly signed app that
// Gatekeeper refuses outright. Measured on real hardware.
//
// Only the credential table is testable from here — the artifact check needs codesign
// and a real bundle. That half is exercised on the Mac.

const { test } = require('node:test');
const assert = require('node:assert');
const guard = require('../build/verify-mac-build');

test('build guard: each complete credential set is accepted', () => {
  assert.deepEqual(guard.credentialState({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }), {
    ok: true,
    using: 'APPLE_API_KEY',
  });
  assert.deepEqual(guard.credentialState({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }), {
    ok: true,
    using: 'APPLE_ID',
  });
  assert.deepEqual(guard.credentialState({ APPLE_KEYCHAIN_PROFILE: 'p' }), {
    ok: true,
    using: 'APPLE_KEYCHAIN_PROFILE',
  });
});

test('build guard: an empty environment is reported as having none', () => {
  assert.deepEqual(guard.credentialState({}), { ok: false });
});

test('build guard: a HALF-set is called out by name, not silently ignored', () => {
  // This is what a misconfigured CI looks like, and it is worse than nothing: the build
  // would otherwise skip notarization for a reason nobody reads and still exit 0.
  const s = guard.credentialState({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b' });
  assert.equal(s.ok, false);
  assert.deepEqual(s.missing, ['APPLE_TEAM_ID']);
});

test('build guard: whitespace is not a credential', () => {
  assert.equal(guard.credentialState({ APPLE_KEYCHAIN_PROFILE: '   ' }).ok, false);
});

// --- the four silent-pass paths -----------------------------------------------
// Probing the hook with the contexts electron-builder really produces found four ways
// it returned quietly while guarding nothing: a renamed app, a different architecture
// directory, a missing outDir, and an appOutDir pointing nowhere. Each printed no
// failure, and the only signal was the ABSENCE of a line.
//
// The root cause was a single false premise — that "no .app on disk" means "not a macOS
// build". The hook is TOLD the platform, so those two cases can and must be separated.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-macbuild-'));
const ctx = (over = {}) => ({ outDir: '/dist', artifactPaths: [], platformToTargets: new Map(), ...over });

test('build guard: a macOS build is recognised from what the hook is told', () => {
  assert.equal(guard.builtForMac(ctx({ platformToTargets: new Map([['mac', {}]]) })), true);
  assert.equal(guard.builtForMac(ctx({ platformToTargets: new Map([[{ name: 'mac' }, {}]]) })), true);
  // ...and from the artifacts, when the map is keyed by something unexpected.
  assert.equal(guard.builtForMac(ctx({ artifactPaths: ['/dist/git-updater-0.1.7-mac-arm64.dmg'] })), true);
});

test('build guard: a Windows or Linux build is genuinely not its business', () => {
  assert.equal(guard.builtForMac(ctx({ platformToTargets: new Map([['windows', {}]]) })), false);
  assert.equal(guard.builtForMac(ctx({ artifactPaths: ['/dist/git-updater-0.1.7-x64.zip'] })), false);
  assert.equal(guard.builtForMac(ctx()), false);
  assert.equal(guard.builtForMac(undefined), false);
});

test('build guard: the app is found by scanning, not by assuming its name or arch dir', () => {
  const d = tmpdir();
  try {
    // A productName change and an added target each used to defeat the old hard-coded
    // path, silently. Both are found now.
    fs.mkdirSync(path.join(d, 'mac-universal', 'Renamed Product.app'), { recursive: true });
    fs.mkdirSync(path.join(d, 'Top Level.app'), { recursive: true });
    fs.mkdirSync(path.join(d, 'mac-arm64', 'git-updater.app'), { recursive: true });
    fs.writeFileSync(path.join(d, 'builder-debug.yml'), '');
    const found = guard.findApps(d).map((p) => path.basename(p)).sort();
    assert.deepEqual(found, ['Renamed Product.app', 'Top Level.app', 'git-updater.app']);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('build guard: a macOS build with no .app found is an error, not a quiet pass', async () => {
  const d = tmpdir();
  try {
    // This is the case that used to return silently. "Not a macOS build" and "a macOS
    // build whose app I cannot find" are different answers and must not look the same.
    await assert.rejects(
      () => guard.default(ctx({ outDir: d, platformToTargets: new Map([['mac', {}]]) })),
      /no \.app found/ // the SPECIFIC diagnosis: an alternation here matched the
      // platform error instead and the test passed with the guard removed entirely
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('build guard: a macOS build with no outDir is an error too', async () => {
  await assert.rejects(
    () => guard.default(ctx({ outDir: undefined, platformToTargets: new Map([['mac', {}]]) })),
    /no outDir/
  );
});

test('build guard: a non-macOS build returns quietly and asserts nothing', async () => {
  await guard.default(ctx({ platformToTargets: new Map([['windows', {}]]) }));
});
