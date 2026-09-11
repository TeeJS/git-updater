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
