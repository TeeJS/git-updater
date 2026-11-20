'use strict';

// Network access for source providers. Providers never call fetch themselves: they are
// handed this object as ctx.net, which makes three guarantees on their behalf and lets
// tests swap the whole thing for a stub that reads fixtures.
//
//   1. HTTPS only. A listing read over plain HTTP can be rewritten in transit, and every
//      download URL a provider returns comes out of a listing.
//   2. No redirects, enforced before the fact. A provider asked for one URL and reasons
//      about the host it named; the transport refuses a redirect rather than following it
//      and inspecting the result, so nothing is requested from anywhere else.
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
  // Redirects are refused by the transport itself (see github.fetchWithPolicy): no request
  // is ever made to a host the provider did not name.
  const { res } = await github.withNetRetry(() => github.fetchWithPolicy(url, { headers }, { redirects: 'none' }), url);
  if (!res.ok) {
    const e = new Error(`${hostOf(url)} answered ${res.status}`);
    e.status = res.status;
    if (res.status === 404 || res.status === 410) e.unavailable = true;
    throw e;
  }
  const buffer = await readCapped(res, maxBytes, url);
  return { status: res.status, url, buffer };
}

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
