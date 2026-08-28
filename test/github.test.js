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

test('verifyDigest: skips with a note when no digest', () => {
  const r = github.verifyDigest('/any/path', undefined);
  assert.ok(r.skipped);
  assert.match(r.note, /skipped/);
});
