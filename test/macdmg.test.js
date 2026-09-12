'use strict';

// build/notarize-dmg.js — signing, notarizing and stapling the DISK IMAGE.
//
// electron-builder notarizes the .app only. Measured on macOS 26.6.2 arm64, a build whose
// app was perfectly notarized still produced a .dmg that was "code object is not signed at
// all" and that Gatekeeper rejected outright with "no usable signature". Submitting and
// stapling the image was NOT enough on its own; the control was four stapled images, two
// unsigned and rejected (ours and a shipped sibling release), two signed and accepted
// (Claude.dmg, oMLX.dmg).
//
// These tests cover the pure parts: which credential set is chosen, and which files get
// processed. The three subprocesses cannot be unit-tested without Apple, so the guard in
// verify-mac-build.js checks the resulting artifact instead — a file check rather than a
// claim about what the build did.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dmg = require('../build/notarize-dmg');

// --- credential selection -----------------------------------------------------

test('notarize-dmg: a keychain profile is the first credential source', () => {
  assert.deepEqual(dmg.notarytoolAuth({ APPLE_KEYCHAIN_PROFILE: 'p' }), ['--keychain-profile', 'p']);
  // APPLE_KEYCHAIN narrows which keychain holds it, and only applies alongside the profile
  assert.deepEqual(dmg.notarytoolAuth({ APPLE_KEYCHAIN_PROFILE: 'p', APPLE_KEYCHAIN: 'k' }), [
    '--keychain-profile',
    'p',
    '--keychain',
    'k',
  ]);
});

test('notarize-dmg: the Apple ID trio and the API key trio are both accepted', () => {
  assert.deepEqual(
    dmg.notarytoolAuth({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }),
    ['--apple-id', 'a', '--team-id', 'c', '--password', 'b']
  );
  assert.deepEqual(dmg.notarytoolAuth({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }), [
    '--key',
    'k',
    '--key-id',
    'i',
    '--issuer',
    's',
  ]);
});

test('notarize-dmg: a PARTIAL credential set is refused, never half-used', () => {
  // Two of three is what a misconfigured CI looks like. Sending it to notarytool would
  // fail obscurely; returning null makes the caller leave the image alone and lets the
  // artifact guard report it as unnotarized, which names the real problem.
  assert.equal(dmg.notarytoolAuth({ APPLE_ID: 'a', APPLE_TEAM_ID: 'c' }), null);
  assert.equal(dmg.notarytoolAuth({ APPLE_API_KEY: 'k' }), null);
  assert.equal(dmg.notarytoolAuth({}), null);
  assert.equal(dmg.notarytoolAuth({ APPLE_KEYCHAIN_PROFILE: '   ' }), null, 'whitespace is not a credential');
});

// --- which files get processed ------------------------------------------------

test('notarize-dmg: every .dmg is processed, and nothing else is', () => {
  const arts = [
    '/d/app-1.0-mac-arm64.dmg',
    '/d/app-1.0-mac-arm64.dmg.blockmap',
    '/d/app-1.0-mac-arm64.zip',
    '/d/app-1.0-mac-arm64.zip.blockmap',
  ];
  assert.deepEqual(dmg.dmgsIn(arts, '/nope'), ['/d/app-1.0-mac-arm64.dmg']);
  // .blockmap must not be mistaken for the image it describes
  assert.ok(!dmg.dmgsIn(arts, '/nope').some((p) => p.endsWith('.blockmap')));
});

test('notarize-dmg: more than one disk image is handled, not just the first', () => {
  const arts = ['/d/a-arm64.dmg', '/d/a-x64.dmg'];
  assert.deepEqual(dmg.dmgsIn(arts, '/nope'), ['/d/a-arm64.dmg', '/d/a-x64.dmg']);
});

test('notarize-dmg: falls back to reading outDir when artifactPaths is absent', () => {
  // The hook contract gave us no appOutDir once already. If artifactPaths ever goes the
  // same way, every image would silently ship unsigned — so scan the directory instead.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-dmgscan-'));
  try {
    fs.writeFileSync(path.join(out, 'app-1.0.dmg'), '');
    fs.writeFileSync(path.join(out, 'app-1.0.dmg.blockmap'), '');
    fs.writeFileSync(path.join(out, 'app-1.0.zip'), '');
    assert.deepEqual(dmg.dmgsIn([], out), [path.join(out, 'app-1.0.dmg')]);
    assert.deepEqual(dmg.dmgsIn(undefined, out), [path.join(out, 'app-1.0.dmg')]);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('notarize-dmg: no disk images and no credentials are both quiet no-ops', () => {
  assert.deepEqual(dmg.dmgsIn([], '/definitely/not/here'), []);
  // notarizeDmgs must not throw when there is nothing to do — a Windows or Linux build
  // reaches the same hook.
  assert.deepEqual(dmg.notarizeDmgs({ artifactPaths: [], outDir: '/definitely/not/here' }), []);
});
