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
  const envTok = process.env.GITHUB_TOKEN; // the token hint only appears when unauthenticated
  delete process.env.GITHUB_TOKEN;
  global.fetch = stubFetch({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' });
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.rateLimited, 'should flag rateLimited');
      assert.match(e.message, /GITHUB_TOKEN/);
      return true;
    });
  } finally {
    if (envTok !== undefined) process.env.GITHUB_TOKEN = envTok;
    global.fetch = orig;
  }
});

// Secondary limit: quota left, but GitHub says slow down. Must still stop the run.
test('getLatestRelease: 403 with retry-after -> flagged rateLimited (secondary limit)', async () => {
  const orig = global.fetch;
  global.fetch = stubFetch({ 'x-ratelimit-remaining': '42', 'retry-after': '60' });
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.rateLimited);
      assert.match(e.message, /60s/);
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

// bitwarden/clients-style repo: several release trains interleaved, newest overall is NOT
// the one we want. tagPrefix must skip past it to the first matching tag.
test('getLatestRelease: tagPrefix picks the first matching release, skipping other trains', async () => {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => [
        { tag_name: 'web-v2026.8.1', draft: false, prerelease: false },
        { tag_name: 'cli-v2026.8.0', draft: false, prerelease: false },
        { tag_name: 'desktop-v2026.8.0', draft: false, prerelease: false },
        { tag_name: 'browser-v2026.8.0', draft: false, prerelease: false },
      ],
    };
  };
  try {
    const rel = await github.getLatestRelease('bitwarden', 'clients', { tagPrefix: 'desktop-v' });
    assert.equal(rel.tag_name, 'desktop-v2026.8.0');
    assert.ok(!calls.some((u) => /releases\/latest/.test(u)), 'must use the list endpoint, not /releases/latest');
  } finally {
    global.fetch = orig;
  }
});

test('getLatestRelease: tagPrefix skips drafts and prereleases by default', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => [
      { tag_name: 'desktop-v2026.9.0', draft: true, prerelease: false },
      { tag_name: 'desktop-v2026.8.1', draft: false, prerelease: true },
      { tag_name: 'desktop-v2026.8.0', draft: false, prerelease: false },
    ],
  });
  try {
    const rel = await github.getLatestRelease('bitwarden', 'clients', { tagPrefix: 'desktop-v' });
    assert.equal(rel.tag_name, 'desktop-v2026.8.0');
  } finally {
    global.fetch = orig;
  }
});

test('getLatestRelease: tagPrefix + prerelease includes prereleases', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => [
      { tag_name: 'desktop-v2026.8.1-beta1', draft: false, prerelease: true },
      { tag_name: 'desktop-v2026.8.0', draft: false, prerelease: false },
    ],
  });
  try {
    const rel = await github.getLatestRelease('bitwarden', 'clients', { tagPrefix: 'desktop-v', prerelease: true });
    assert.equal(rel.tag_name, 'desktop-v2026.8.1-beta1');
  } finally {
    global.fetch = orig;
  }
});

test('getLatestRelease: tagPrefix with no match gives a clear error, not a generic 404', async () => {
  const orig = global.fetch;
  global.fetch = async (url) => {
    if (/\/releases\?/.test(url)) return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; // repo-exists probe: repo IS there
  };
  try {
    await assert.rejects(() => github.getLatestRelease('bitwarden', 'clients', { tagPrefix: 'nope-v' }), (e) => {
      assert.match(e.message, /no releases found with tag prefix "nope-v"/);
      return true;
    });
  } finally {
    global.fetch = orig;
  }
});

test('verifyDigest: skips with a note when no digest', () => {
  const r = github.verifyDigest('/any/path', undefined);
  assert.ok(r.skipped);
  assert.match(r.note, /skipped/);
});

// A token set from Settings is sent to the API (and only to the API).
test('setToken: token is sent as a Bearer header on API calls', async () => {
  const orig = global.fetch;
  let seen;
  global.fetch = async (_url, init) => {
    seen = init.headers;
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ tag_name: 'v1' }) };
  };
  github.setToken('  tok123  ');
  try {
    await github.getLatestRelease('o', 'r');
    assert.strictEqual(seen.Authorization, 'Bearer tok123');
  } finally {
    github.setToken(null);
    global.fetch = orig;
  }
});

test('getLatestRelease: 401 with a token -> clear bad-token error, flagged to stop the run', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) });
  github.setToken('expired');
  try {
    await assert.rejects(() => github.getLatestRelease('o', 'r'), (e) => {
      assert.ok(e.badToken);
      assert.match(e.message, /Settings/);
      return true;
    });
  } finally {
    github.setToken(null);
    global.fetch = orig;
  }
});

// Settings tests a pasted token before saving it, without making it the active one.
test('rateLimit: tests a candidate token and reports the core quota', async () => {
  const orig = global.fetch;
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ resources: { core: { limit: 5000, remaining: 4999, reset: 1 } } }) };
  };
  try {
    const q = await github.rateLimit('candidate');
    assert.match(seen.url, /\/rate_limit$/);
    assert.strictEqual(seen.auth, 'Bearer candidate');
    assert.deepStrictEqual(q, { limit: 5000, remaining: 4999, reset: 1 });
  } finally {
    global.fetch = orig;
  }
});
