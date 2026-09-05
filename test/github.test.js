'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const github = require('../src/github');

// Minimal Response-ish stub for the rate-limit branch.
function stubFetch(headers) {
  return async () => ({
    status: 403,
    ok: false,
    headers: { get: (k) => headers[k.toLowerCase()] },
    json: async () => ({}),
  });
}

test('getLatestRelease: 403 with remaining 0 -> clear rate-limit error', async () => {
  const orig = global.fetch;
  global.fetch = stubFetch({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.rateLimited, 'should flag rateLimited');
      assert.match(e.message, /GITHUB_TOKEN/);
      return true;
    });
  } finally {
    global.fetch = orig;
  }
});

// A network-level failure (the global fetch throws "fetch failed" with the real reason in
// err.cause) must surface an actionable message — naming the host and cause — instead of
// the bare "fetch failed" the UI used to show.
test('getLatestRelease: network failure surfaces host + cause, not bare "fetch failed"', async () => {
  const orig = global.fetch;
  global.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' } });
  };
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.networkError, 'should flag networkError');
      assert.match(e.message, /api\.github\.com/, 'names the unreachable host');
      assert.match(e.message, /ETIMEDOUT/, 'includes the underlying cause');
      assert.notStrictEqual(e.message, 'fetch failed', 'not the bare message');
      return true;
    });
  } finally {
    global.fetch = orig;
  }
});

// Transient network blips are the common case (that's why Retry works); they should be
// retried automatically so the user never sees them.
test('getLatestRelease: retries a transient network error, then succeeds', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ tag_name: 'v1.2.3' }) };
  };
  try {
    const rel = await github.getLatestRelease('o', 'r');
    assert.equal(rel.tag_name, 'v1.2.3');
    assert.ok(calls >= 2, 'should have retried at least once');
  } finally {
    global.fetch = orig;
  }
});

// A real HTTP status (e.g. 404) is NOT a network error: it must not be retried away, and it
// keeps its own meaning rather than being reported as a connectivity problem.
test('getLatestRelease: an HTTP 404 is not treated as a retryable network error', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
  };
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(!e.networkError, 'a 404 is not a network error');
      return true;
    });
    assert.equal(calls, 2, 'one call for /releases/latest, one for the repo-exists probe — no retries');
  } finally {
    global.fetch = orig;
  }
});

// A TLS trust failure is the corporate-VPN case: it must be explained (not shown as a bare
// code), flagged, and — since it never recovers — NOT retried.
test('getLatestRelease: a TLS certificate error is explained and not retried', async () => {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } });
  };
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.networkError, 'flagged as networkError');
      assert.match(e.message, /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
      assert.match(e.message, /certificate|VPN|proxy/i, 'explains the likely cause');
      return true;
    });
    assert.equal(calls, 1, 'a cert error must not be retried');
  } finally {
    global.fetch = orig;
  }
});

// The GUI injects Electron's net.fetch (which trusts the Windows cert store) via setFetch;
// when set, it must be used in place of the global fetch. Restoring null falls back again.
test('setFetch: an injected fetch is used instead of the global fetch', async () => {
  let usedInjected = false;
  github.setFetch(async () => {
    usedInjected = true;
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ tag_name: 'v2.0.0' }) };
  });
  try {
    const rel = await github.getLatestRelease('o', 'r');
    assert.equal(rel.tag_name, 'v2.0.0');
    assert.ok(usedInjected, 'the injected fetch should be called');
  } finally {
    github.setFetch(null); // restore default so later tests use their global.fetch stubs
  }
});

test('verifyDigest: skips with a note when no digest', () => {
  const r = github.verifyDigest('/any/path', undefined);
  assert.ok(r.skipped);
  assert.match(r.note, /skipped/);
});
