'use strict';

// Redirect policy is enforced by the transport BEFORE a request is made, not inspected
// afterwards: a host that was not approved is never contacted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const github = require('../src/github');
const core = require('../src/core');
const net = require('../src/sources/net');

// A scripted fetch: url -> response description. Records every request it receives.
function scripted(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect });
    const r = routes[String(url)];
    if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } });
    if (r.throwRedirect) throw Object.assign(new TypeError('fetch failed'), { cause: { message: 'unexpected redirect' } });
    const headers = new Map(Object.entries(r.headers || {}));
    return {
      ok: (r.status || 200) >= 200 && (r.status || 200) < 300,
      status: r.status == null ? 200 : r.status,
      type: r.type || 'basic',
      url: r.url || String(url),
      redirected: !!r.redirected,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(r.body || '').buffer,
      text: async () => r.body || '',
    };
  };
  return { calls, fetchImpl };
}
async function withFetch(routes, fn) {
  const s = scripted(routes);
  github.setFetch(s.fetchImpl);
  try {
    return await fn(s.calls);
  } finally {
    github.setFetch(null);
  }
}

test('no-redirect: fetch is told to refuse redirects, and a redirect is an error', async () => {
  await withFetch({ 'https://list.example/dir/': { throwRedirect: true } }, async (calls) => {
    await assert.rejects(github.fetchWithPolicy('https://list.example/dir/', {}, { redirects: 'none' }), /list\.example redirected the request, which this source does not allow/);
    assert.deepEqual(calls, [{ url: 'https://list.example/dir/', redirect: 'error' }], 'one request, never retried, nothing sent elsewhere');
  });
});

test('no-redirect: a fetch that ignores the option is still caught', async () => {
  await withFetch({ 'https://list.example/a': { status: 200, url: 'https://elsewhere.example/a', redirected: true } }, async () => {
    await assert.rejects(github.fetchWithPolicy('https://list.example/a', {}, { redirects: 'none' }), /redirected the request to elsewhere\.example/);
  });
  await withFetch({ 'https://list.example/a': { status: 302, headers: { location: 'https://elsewhere.example/a' } } }, async () => {
    await assert.rejects(github.fetchWithPolicy('https://list.example/a', {}, { redirects: 'none' }), /does not allow/);
  });
});

test('https-redirects: each hop is validated before it is requested', async () => {
  await withFetch({
    'https://a.example/f': { status: 302, headers: { location: 'https://b.example/f' } },
    'https://b.example/f': { status: 301, headers: { location: '/final' } },
    'https://b.example/final': { status: 200, body: 'ok' },
  }, async (calls) => {
    const { res, finalUrl } = await github.fetchWithPolicy('https://a.example/f', {}, { redirects: 'https' });
    assert.equal(res.status, 200);
    assert.equal(finalUrl, 'https://b.example/final');
    assert.deepEqual(calls.map((c) => c.redirect), ['manual', 'manual', 'manual'], 'never an implicit follow');
  });
});

test('https-redirects: a hop to plain http is refused and never requested', async () => {
  await withFetch({
    'https://a.example/f': { status: 302, headers: { location: 'http://plain.example/f' } },
    'http://plain.example/f': { status: 200, body: 'should never be fetched' },
  }, async (calls) => {
    await assert.rejects(github.fetchWithPolicy('https://a.example/f', {}, { redirects: 'https' }), /redirected to a non-HTTPS address \(plain\.example\)/);
    assert.deepEqual(calls.map((c) => c.url), ['https://a.example/f']);
  });
});

test('https-redirects: an unreadable (opaque) redirect is refused rather than followed blind', async () => {
  await withFetch({ 'https://a.example/f': { status: 0, type: 'opaqueredirect' } }, async (calls) => {
    await assert.rejects(github.fetchWithPolicy('https://a.example/f', {}, { redirects: 'https' }), /could not be checked first/);
    assert.equal(calls.length, 1);
  });
});

test('https-redirects: bounded, credential-free, and with a destination', async () => {
  const loop = {};
  for (let i = 0; i < 10; i++) loop[`https://a.example/${i}`] = { status: 302, headers: { location: `https://a.example/${i + 1}` } };
  await withFetch(loop, async (calls) => {
    await assert.rejects(github.fetchWithPolicy('https://a.example/0', {}, { redirects: 'https' }), /too many redirects/);
    assert.equal(calls.length, 6);
  });
  await withFetch({ 'https://a.example/f': { status: 302, headers: { location: 'https://user:pw@b.example/f' } } }, async () => {
    await assert.rejects(github.fetchWithPolicy('https://a.example/f', {}, { redirects: 'https' }), /carries credentials/);
  });
  await withFetch({ 'https://a.example/f': { status: 302 } }, async () => {
    await assert.rejects(github.fetchWithPolicy('https://a.example/f', {}, { redirects: 'https' }), /redirect with no destination/);
  });
});

test('the first address must itself be https and credential-free', async () => {
  await assert.rejects(github.fetchWithPolicy('http://a.example/f', {}, { redirects: 'https' }), /non-HTTPS address \(a\.example\)/);
  await assert.rejects(github.fetchWithPolicy('https://u:p@a.example/f', {}, { redirects: 'none' }), /carries credentials/);
});

test('downloadAsset: strict downloads go through the policy; GitHub downloads are untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-transport-'));
  await withFetch({
    'https://a.example/f.zip?sig=SECRET': { status: 302, headers: { location: 'http://plain.example/f.zip' } },
    'https://gh.example/f.zip': { status: 404 },
  }, async (calls) => {
    await assert.rejects(
      github.downloadAsset('https://a.example/f.zip?sig=SECRET', path.join(dir, 'f.zip'), null, undefined, { httpsOnly: true }),
      (e) => /non-HTTPS/.test(e.message) && !e.message.includes('SECRET')
    );
    await assert.rejects(github.downloadAsset('https://gh.example/f.zip', path.join(dir, 'g.zip')), /download 404/);
    assert.equal(calls[calls.length - 1].redirect, undefined, 'a GitHub download passes no redirect option');
  });
  await withFetch({ 'https://a.example/f.zip?sig=SECRET': { status: 500 } }, async () => {
    await assert.rejects(
      github.downloadAsset('https://a.example/f.zip?sig=SECRET', path.join(dir, 'f.zip'), null, undefined, { httpsOnly: true, noRedirect: true }),
      (e) => /download 500 for https:\/\/a\.example\/f\.zip\?…/.test(e.message) && !e.message.includes('SECRET')
    );
  });
});

test('ctx.net: listings are https, redirect-free and size-capped', async () => {
  await withFetch({
    'https://api.example/x': { status: 200, body: '{"a":1}' },
    'https://api.example/moved': { throwRedirect: true },
    'https://api.example/big': { status: 200, body: 'x'.repeat(5000) },
    'https://api.example/gone': { status: 404 },
  }, async (calls) => {
    assert.deepEqual((await net.getJson('https://api.example/x')).json, { a: 1 });
    assert.equal(calls[0].redirect, 'error');
    await assert.rejects(net.getText('https://api.example/moved'), /does not allow/);
    await assert.rejects(net.getText('https://api.example/big', { maxBytes: 1000 }), /too large/);
    await assert.rejects(net.getText('https://api.example/gone'), (e) => e.status === 404 && e.unavailable === true);
    await assert.rejects(net.getText('http://api.example/x'), /non-HTTPS/);
  });
});

test('core: the exe installer kind never runs without explicit switches', () => {
  assert.throws(() => core.installerCmd('exe', 'S.exe'), /needs explicit ones/);
  assert.throws(() => core.installerCmd('exe', 'S.exe', []), /needs explicit ones/);
  assert.deepEqual(core.installerCmd('exe', 'S.exe', ['/S']), { exe: 'S.exe', args: ['/S'] });
  assert.deepEqual(core.installerCmd('exe', 'B.exe', ['-quiet', '-norestart']), { exe: 'B.exe', args: ['-quiet', '-norestart'] });
  // Only a listing's explicit "needs no switches" statement runs a plain .exe with none.
  assert.deepEqual(core.installerCmd('exe', 'DiscordSetup.exe', undefined, undefined, true), { exe: 'DiscordSetup.exe', args: [] });
  assert.deepEqual(core.installerCmd('exe', 'S.exe', ['/S'], undefined, true), { exe: 'S.exe', args: ['/S'] }, 'declared switches still win');
  assert.throws(() => core.installerCmd('exe', 'S.exe', undefined, undefined, 'yes'), /needs explicit ones/, 'only a real true counts');
  assert.deepEqual(core.installerCmd('nsis', 'S.exe', undefined, undefined, true), { exe: 'S.exe', args: ['/S'] }, 'a kind with its own switches keeps them');
});

test('https-redirects with an injected resolver (the Electron path): hops validated, final address fetched directly', async () => {
  const seenHops = [];
  github.setRedirectResolver(async (url, { checkHop, maxHops }) => {
    assert.equal(maxHops, 5);
    let cur = url;
    for (const loc of ['https://mirror.example/a', '/b']) { cur = checkHop(cur, loc); seenHops.push(cur); }
    return cur;
  });
  try {
    await withFetch({ 'https://mirror.example/b': { status: 200, body: 'ok' } }, async (calls) => {
      const { res, finalUrl } = await github.fetchWithPolicy('https://vendor.example/dl', {}, { redirects: 'https' });
      assert.equal(res.status, 200);
      assert.equal(finalUrl, 'https://mirror.example/b');
      assert.deepEqual(seenHops, ['https://mirror.example/a', 'https://mirror.example/b']);
      assert.deepEqual(calls, [{ url: 'https://mirror.example/b', redirect: 'error' }], 'the final address is requested directly and may not move again');
    });
    // The hop rule is the engine's: a resolver cannot wave a plain-http hop through.
    github.setRedirectResolver(async (url, { checkHop }) => checkHop(url, 'http://plain.example/x'));
    await assert.rejects(github.fetchWithPolicy('https://vendor.example/dl', {}, { redirects: 'https' }), /non-HTTPS address \(plain\.example\)/);
    // Nor can it return a non-https final address.
    github.setRedirectResolver(async () => 'http://plain.example/x');
    await assert.rejects(github.fetchWithPolicy('https://vendor.example/dl', {}, { redirects: 'https' }), /non-HTTPS/);
  } finally {
    github.setRedirectResolver(null);
  }
});
