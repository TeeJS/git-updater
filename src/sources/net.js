'use strict';

// Network access for source providers. Providers never call fetch themselves: they are
// handed this object as ctx.net, which makes three guarantees on their behalf and lets
// tests swap the whole thing for a stub that reads fixtures.
//
//   1. HTTPS only. A listing read over plain HTTP can be rewritten in transit, and every
//      download URL a provider returns comes out of a listing.
//   2. No redirects. A provider asked for one URL and reasons about the host it named; a
//      response from somewhere else is not the listing it thinks it is reading.
//   3. A size cap. Listings are small. A response that is not small is not a listing.
//
// Requests go through github.doFetch, so the Electron GUI's net.fetch injection (OS
// certificate store, corporate proxy) and the transient-failure retry apply here too.

const github = require('../github');

const DEFAULT_MAX = 2 * 1024 * 1024;

function assertHttps(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new Error(`refusing a non-HTTPS address: ${url}`);
  if (u.username || u.password) throw new Error('refusing a URL that carries credentials');
  return u;
}

// Read a response body with a hard byte cap, whatever Content-Length claims.
async function readCapped(res, maxBytes, url) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
  if (declared && declared > maxBytes) throw new Error(`response too large from ${hostOf(url)}: ${declared} bytes (cap ${maxBytes})`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`response too large from ${hostOf(url)} (cap ${maxBytes} bytes)`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    if (seen > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`response too large from ${hostOf(url)} (cap ${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

async function request(url, opts = {}) {
  assertHttps(url);
  const maxBytes = opts.maxBytes || DEFAULT_MAX;
  const headers = { 'User-Agent': github.UA, ...(opts.accept ? { Accept: opts.accept } : {}) };
  const res = await github.withNetRetry(() => github.doFetch(url, { headers }), url);
  // fetch follows redirects on its own. Rather than depend on every fetch implementation
  // honouring `redirect: 'error'` identically (Node's and Chromium's differ in what a
  // manual redirect looks like), let it follow and then refuse the result if it moved.
  const finalUrl = res.url || url;
  if (res.redirected || finalUrl !== url) {
    // A trailing-slash normalisation by the same host is the listing we asked for.
    const same = stripSlash(finalUrl) === stripSlash(url);
    if (!same) throw Object.assign(new Error(`${hostOf(url)} redirected the request to ${hostOf(finalUrl)}`), { redirected: true, finalUrl });
  }
  if (!res.ok) {
    const e = new Error(`${hostOf(url)} answered ${res.status}`);
    e.status = res.status;
    if (res.status === 404 || res.status === 410) e.unavailable = true;
    throw e;
  }
  const buffer = await readCapped(res, maxBytes, url);
  return { status: res.status, url: finalUrl, buffer };
}

const stripSlash = (u) => String(u).replace(/\/+$/, '');

async function getBuffer(url, opts) {
  return request(url, opts);
}

async function getText(url, opts) {
  const r = await request(url, opts);
  return { status: r.status, url: r.url, text: r.buffer.toString('utf8') };
}

async function getJson(url, opts) {
  const r = await request(url, { accept: 'application/json', ...(opts || {}) });
  let json;
  try {
    json = JSON.parse(r.buffer.toString('utf8'));
  } catch {
    throw new Error(`${hostOf(url)} did not return valid JSON`);
  }
  return { status: r.status, url: r.url, json };
}

module.exports = { getText, getJson, getBuffer, assertHttps, hostOf, DEFAULT_MAX };
