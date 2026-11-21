'use strict';

// A private repository's release files. The public download address answers 404 for them, so
// the file is fetched through GitHub's API with the token — and the whole point of these tests
// is WHERE the token goes: to api.github.com, once, and never to the signed address that
// request hands back, never to github.com, never anywhere a release listing points.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const github = require('../src/github');

const PUBLIC = 'https://github.com/me/private-tool/releases/download/v1.0.0/tool.zip';
const API = 'https://api.github.com/repos/me/private-tool/releases/assets/123456';
const SIGNED = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=SECRETSIGNATURE&se=2026';
const TOKEN = 'github_pat_TESTTOKEN';

const body = (bytes) => new ReadableStream({ start(c) { c.enqueue(Uint8Array.from(bytes)); c.close(); } });
const reply = (status, { location, bytes, text } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url: '',
  redirected: false,
  headers: { get: (h) => (String(h).toLowerCase() === 'location' ? location || null : null) },
  body: bytes ? body(bytes) : null,
  text: async () => text || '',
});

// Runs fn with fetch replaced by `routes` (url -> reply, or a function) and a token set.
// Returns every request made: [{ url, auth, accept, redirect }].
async function world(routes, fn, { token = TOKEN } = {}) {
  const realFetch = global.fetch;
  const envTok = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const h = init.headers || {};
    calls.push({ url: String(url), auth: h.Authorization || null, accept: h.Accept || null, redirect: init.redirect || 'follow' });
    const r = routes[String(url)];
    if (!r) throw new Error(`unexpected request to ${url}`);
    return typeof r === 'function' ? r(init) : r;
  };
  github.setToken(token);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-private-'));
  try {
    await fn({ calls, dir, file: path.join(dir, 'tool.zip') });
  } finally {
    global.fetch = realFetch;
    github.setToken(null);
    if (envTok === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = envTok;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return calls;
}

test('a private file is fetched through the API, and the token goes to api.github.com only', async () => {
  let finalUrl = null;
  const calls = await world({
    [PUBLIC]: reply(404),
    [API]: reply(302, { location: SIGNED }),
    [SIGNED]: reply(200, { bytes: [9, 8, 7] }),
  }, async ({ file }) => {
    await github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API, onFinalUrl: (u) => { finalUrl = u; } });
    assert.deepEqual([...fs.readFileSync(file)], [9, 8, 7]);
  });
  assert.deepEqual(calls.map((c) => c.url), [PUBLIC, API, SIGNED], 'the public address first, then the API, then the signed address');
  assert.equal(calls[0].auth, null, 'no token to github.com');
  assert.equal(calls[1].auth, `Bearer ${TOKEN}`);
  assert.equal(calls[1].accept, 'application/octet-stream');
  assert.equal(calls[1].redirect, 'manual', 'the API\'s redirect is read, never followed with the token attached');
  assert.equal(calls[2].auth, null, 'no token to the signed address');
  // The signature never reaches a log or the saved state.
  assert.equal(finalUrl, 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?…');
  assert.ok(!finalUrl.includes('SECRETSIGNATURE'));
});

test('a public file never touches the API, token or not', async () => {
  const calls = await world({ [PUBLIC]: reply(200, { bytes: [1] }) }, async ({ file }) => {
    await github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API });
  });
  assert.deepEqual(calls.map((c) => [c.url, c.auth]), [[PUBLIC, null]]);
});

test('without a token a 404 stays a 404: the API is not asked', async () => {
  const calls = await world({ [PUBLIC]: reply(404) }, async ({ file }) => {
    await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API }), /download 404/);
  }, { token: null });
  assert.deepEqual(calls.map((c) => c.url), [PUBLIC]);
});

test('the token is only ever sent to an api.github.com release-asset address', async () => {
  // A listing that named some other host as the asset's API address must not get the token.
  for (const evil of [
    'https://api.github.com.evil.example/repos/me/private-tool/releases/assets/1',
    'https://evil.example/repos/me/private-tool/releases/assets/1',
    'http://api.github.com/repos/me/private-tool/releases/assets/1',
    'https://api.github.com/repos/me/private-tool/releases/assets/1/../../../../user',
    'https://api.github.com/user',
    'https://user:pw@api.github.com/repos/me/private-tool/releases/assets/1',
  ]) {
    const calls = await world({ [PUBLIC]: reply(404) }, async ({ file }) => {
      await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, null, { apiUrl: evil }), /download 404/);
      assert.equal(await github.openPrivateAsset(evil), null);
    });
    assert.deepEqual(calls.map((c) => c.url), [PUBLIC], evil);
  }
});

test('a redirect from the API is checked before it is used', async () => {
  // Not https: refused, and never requested.
  let calls = await world({ [PUBLIC]: reply(404), [API]: reply(302, { location: 'http://storage.example/file' }) }, async ({ file }) => {
    await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API }), /redirected to a non-HTTPS address/);
  });
  assert.deepEqual(calls.map((c) => c.url), [PUBLIC, API]);
  // Back to the API itself: refused rather than looped with or without the token.
  calls = await world({ [PUBLIC]: reply(404), [API]: reply(302, { location: 'https://api.github.com/repos/me/private-tool/releases/assets/999' }) }, async ({ file }) => {
    await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API }), /redirected the download to itself/);
  });
  assert.deepEqual(calls.map((c) => c.url), [PUBLIC, API]);
  // A further hop from the signed address is followed, still without the token.
  const SECOND = 'https://objects.githubusercontent.com/final?sig=x';
  calls = await world({
    [PUBLIC]: reply(404), [API]: reply(302, { location: SIGNED }), [SIGNED]: reply(302, { location: SECOND }), [SECOND]: reply(200, { bytes: [5] }),
  }, async ({ file }) => {
    await github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API });
    assert.deepEqual([...fs.readFileSync(file)], [5]);
  });
  assert.deepEqual(calls.map((c) => [c.url, c.auth]), [[PUBLIC, null], [API, `Bearer ${TOKEN}`], [SIGNED, null], [SECOND, null]]);
});

test('the API may serve the file itself, with no redirect', async () => {
  const calls = await world({ [PUBLIC]: reply(404), [API]: reply(200, { bytes: [4, 2] }) }, async ({ file }) => {
    await github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API });
    assert.deepEqual([...fs.readFileSync(file)], [4, 2]);
  });
  assert.deepEqual(calls.map((c) => c.url), [PUBLIC, API]);
});

test('a token that cannot read the repository gets a message that says so', async () => {
  await world({ [PUBLIC]: reply(404), [API]: reply(404) }, async ({ file }) => {
    await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, null, { apiUrl: API }), (e) => {
      assert.match(e.message, /download 404 for https:\/\/github\.com\/me\/private-tool\/releases\/download\/v1\.0\.0\/tool\.zip/);
      assert.match(e.message, /if this repository is private, your GitHub token needs Contents: Read-only access to it/);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
  });
});

test('the size cap applies to a private download too', async () => {
  await world({ [PUBLIC]: reply(404), [API]: reply(302, { location: SIGNED }), [SIGNED]: reply(200, { bytes: [1, 2, 3, 4] }) }, async ({ file }) => {
    await assert.rejects(() => github.downloadAsset(PUBLIC, file, null, 3, { apiUrl: API }), /size cap 3/);
  });
});

test('a private release\'s checksum file is read the same way', async () => {
  const SUMS_PUBLIC = 'https://github.com/me/private-tool/releases/download/v1.0.0/SHA256SUMS';
  const SUMS_API = 'https://api.github.com/repos/me/private-tool/releases/assets/777';
  const SUMS_SIGNED = 'https://release-assets.githubusercontent.com/sums?sig=y';
  const hex = 'a'.repeat(64);
  const rel = { assets: [
    { name: 'tool.zip', size: 10, browser_download_url: PUBLIC, url: API },
    { name: 'SHA256SUMS', size: 80, browser_download_url: SUMS_PUBLIC, url: SUMS_API },
  ] };
  const calls = await world({
    [SUMS_PUBLIC]: reply(404), [SUMS_API]: reply(302, { location: SUMS_SIGNED }), [SUMS_SIGNED]: reply(200, { text: `${hex}  tool.zip\n` }),
  }, async () => {
    assert.deepEqual(await github.fetchChecksumFromRelease(rel, 'tool.zip'), { algo: 'sha256', expected: hex });
  });
  assert.deepEqual(calls.map((c) => [c.url, c.auth]), [[SUMS_PUBLIC, null], [SUMS_API, `Bearer ${TOKEN}`], [SUMS_SIGNED, null]]);
});

test('a repository that is not found says what to do about a private one', async () => {
  const notFound = { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  const routes = {
    'https://api.github.com/repos/me/private-tool/releases/latest': notFound,
    'https://api.github.com/repos/me/private-tool': notFound,
  };
  await world(routes, async () => {
    await assert.rejects(() => github.getLatestRelease('me', 'private-tool'), /it is private and your GitHub token cannot read it \(the token needs Contents: Read-only access/);
  });
  await world(routes, async () => {
    await assert.rejects(() => github.getLatestRelease('me', 'private-tool'), /a private repository needs a GitHub token that can read it: Settings → GitHub/);
  }, { token: null });
});
