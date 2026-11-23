'use strict';

// IO edge: GitHub REST + asset download + digest verify. Uses Node 18+ global fetch.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://api.github.com';
const UA = 'release-watcher';
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // default download cap; callers pass the configured one (null = no cap)
const LIMIT_HINT = 'raise the download limit (Settings, or downloadLimitMiB in config.json)';

// Unauthenticated API calls get 60/hour per IP address — shared with every other tool and
// machine behind the same public IP (a corporate VPN egress, a household NAT). A token raises
// that to 5,000/hour for the account. The GUI sets one from Settings (setToken); the headless
// CLI falls back to GITHUB_TOKEN. Sent to api.github.com only, never to asset downloads —
// which holds for a private repository's files too: see openPrivateAsset below.
let _token = null;
function setToken(t) { _token = typeof t === 'string' && t.trim() ? t.trim() : null; }
function currentToken() { return _token || process.env.GITHUB_TOKEN || null; }

function apiHeaders(token = currentToken()) {
  const h = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// The Electron GUI injects Electron's net.fetch here (see electron/main.js) so requests go
// through Chromium's network stack, which trusts the OS/Windows certificate store — including
// a corporate VPN/proxy's root CA that Node's own bundled CA list rejects with
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Left unset (headless CLI, tests) we fall back to the
// global fetch; globalThis.fetch is read at call time so tests can still stub it.
let _fetchImpl = null;
function setFetch(fn) { _fetchImpl = typeof fn === 'function' ? fn : null; }
function doFetch(url, init) { return (_fetchImpl || globalThis.fetch)(url, init); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

// A URL for messages and logs: no credentials, no query string (either can carry a token).
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(invalid address)';
  }
}

function assertHttpsUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error('not a valid address');
  }
  if (u.protocol !== 'https:') throw new Error(`refusing a non-HTTPS address (${u.host || 'invalid'})`);
  if (u.username || u.password) throw new Error('refusing an address that carries credentials');
  return u;
}

const MAX_REDIRECTS = 5;
const isRedirect = (res) => res && res.status >= 300 && res.status < 400;

// fetch for sources that restrict where a request may go. The restriction is applied by
// the TRANSPORT, not checked afterwards: a redirect is never followed implicitly, so no
// request reaches a host that was not approved first.
//
//   redirects: 'none'   the server must answer directly. `redirect: 'error'` makes fetch
//                       itself reject a 3xx before requesting its target.
//   redirects: 'https'  each hop is read with `redirect: 'manual'`, its Location is
//                       validated as https, and only then requested — at most
//                       MAX_REDIRECTS times.
//
// Returns { res, finalUrl }. Errors name hosts only, never a full URL.
async function fetchWithPolicy(url, init, policy = {}) {
  assertHttpsUrl(url);
  if (policy.redirects !== 'https') {
    let res;
    try {
      res = await doFetch(url, { ...init, redirect: 'error' });
    } catch (e) {
      if (isRedirectError(e)) throw redirectRefused(url);
      throw e;
    }
    // Belt and braces for a fetch implementation that ignores the option.
    if (isRedirect(res) || res.redirected || (res.url && stripSlash(res.url) !== stripSlash(url))) throw redirectRefused(url, res.url);
    return { res, finalUrl: url };
  }
  // Electron's net.fetch cannot do the manual loop below: with `redirect: 'manual'` it
  // cancels the request and exposes no Location. There the GUI injects a resolver built
  // on net.request, which raises an event per hop BEFORE following it. Each hop is
  // validated by checkHop; the address that finally answers is then fetched with
  // redirects refused, so it is requested directly and cannot move again.
  if (_redirectResolver) {
    const finalUrl = await _redirectResolver(String(url), { checkHop, maxHops: MAX_REDIRECTS });
    assertHttpsUrl(finalUrl);
    let res;
    try {
      res = await doFetch(finalUrl, { ...init, redirect: 'error' });
    } catch (e) {
      if (isRedirectError(e)) throw redirectRefused(finalUrl);
      throw e;
    }
    return { res, finalUrl };
  }
  let current = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await doFetch(current, { ...init, redirect: 'manual' });
    if (res.type === 'opaqueredirect' || res.status === 0) {
      // A browser-style fetch hides the Location of a manual redirect, so the next hop
      // cannot be validated before it is requested. Refuse rather than follow blind.
      throw Object.assign(new Error(`${hostOf(current)} redirected the download and the next address could not be checked first`), { redirectRefused: true });
    }
    if (!isRedirect(res)) return { res, finalUrl: current };
    const loc = res.headers && res.headers.get && res.headers.get('location');
    const next = checkHop(current, loc);
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch {}
    current = next;
  }
  throw Object.assign(new Error(`too many redirects starting at ${hostOf(url)}`), { redirectRefused: true });
}

// The rule for one redirect hop, shared by both transports: the destination must exist,
// parse, be https, and carry no credentials. Returns the absolute next URL or throws.
function checkHop(current, location) {
  if (!location) throw Object.assign(new Error(`${hostOf(current)} sent a redirect with no destination`), { redirectRefused: true });
  let next;
  try {
    next = new URL(location, current);
  } catch {
    throw Object.assign(new Error(`${hostOf(current)} sent a redirect to an invalid address`), { redirectRefused: true });
  }
  if (next.protocol !== 'https:') throw Object.assign(new Error(`${hostOf(current)} redirected to a non-HTTPS address (${next.host})`), { redirectRefused: true });
  if (next.username || next.password) throw Object.assign(new Error(`${hostOf(current)} redirected to an address that carries credentials`), { redirectRefused: true });
  return next.toString();
}

// See fetchWithPolicy. fn(url, { checkHop, maxHops }) -> Promise<final https URL>.
let _redirectResolver = null;
function setRedirectResolver(fn) { _redirectResolver = typeof fn === 'function' ? fn : null; }

const stripSlash = (u) => String(u).replace(/\/+$/, '');
function isRedirectError(e) {
  const text = `${(e && e.message) || ''} ${(e && e.cause && e.cause.message) || ''} ${(e && e.cause && e.cause.code) || ''}`;
  return /redirect/i.test(text);
}
function redirectRefused(url, to) {
  const e = new Error(`${hostOf(url)} redirected the request${to ? ' to ' + hostOf(to) : ''}, which this source does not allow`);
  e.redirectRefused = true; // not a network failure: never retried
  return e;
}

// TLS trust failures never recover on retry, and almost always mean a corporate VPN/proxy is
// doing SSL inspection with a root CA the app doesn't trust.
const TLS_CERT_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
]);

// Node's global fetch reports EVERY network-level failure (DNS, TLS, a reset or refused
// connection, a timeout, a blocking proxy) as a generic TypeError whose message is just
// "fetch failed" — the real reason sits in err.cause. A connection reset mid-download
// instead surfaces a Node system-error code directly (err.code). Recognize both so we can
// retry them and report something the user can act on.
function isNetworkError(err) {
  if (!err) return false;
  if (err.redirectRefused) return false; // a policy decision, not a network failure
  if (err instanceof TypeError && err.cause) return true; // "fetch failed" / "terminated"
  const code = err.code || (err.cause && err.cause.code);
  return typeof code === 'string' && /^(E[A-Z]+|UND_ERR_)/.test(code);
}

// Turn a bare "fetch failed" into an actionable message that names the host that was
// unreachable and the underlying cause, e.g.
// "network error reaching objects.githubusercontent.com: ECONNRESET".
function describeNetworkError(err, url) {
  let host = url;
  try { host = new URL(url).host; } catch {}
  const cause = err && err.cause;
  const code = (cause && cause.code) || (err && err.code) || null;
  const detail = code || (cause && cause.message) || (err && err.message) || String(err);
  let msg = `network error reaching ${host}: ${detail}`;
  if (code && TLS_CERT_CODES.has(code)) {
    msg += " — the network's TLS certificate isn't trusted (common on a corporate VPN/proxy; works off it)";
  }
  const e = new Error(msg);
  e.networkError = true;
  e.code = code;
  return e;
}

// Transient network failures are common on release downloads and usually clear on a second
// try — that's exactly why the Retry button works. Retry them automatically with a short
// exponential backoff. HTTP error *statuses* (404, 403, …) and any other non-network error
// are NOT retried: fn throws them and we rethrow unchanged so the caller decides what they
// mean. Only real network failures are retried, and if they exhaust we throw a described one.
const NET_TRIES = 3;
const NET_BASE_DELAY_MS = 400; // 400ms, then 800ms

async function withNetRetry(fn, url) {
  let lastErr;
  for (let attempt = 1; attempt <= NET_TRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isNetworkError(err)) throw err; // not a network problem: bubble up unchanged
      lastErr = err;
      const code = err.code || (err.cause && err.cause.code) || '';
      if (TLS_CERT_CODES.has(code) || attempt === NET_TRIES) break; // cert errors never recover
      await sleep(NET_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw describeNetworkError(lastErr, url);
}

async function ghJson(url, token) {
  const res = await withNetRetry(() => doFetch(url, { headers: apiHeaders(token) }), url);
  const authed = !!(token || currentToken());
  if (res.status === 401 && authed) {
    const where = token || _token ? 'replace or remove it in Settings' : 'check the GITHUB_TOKEN environment variable';
    const e = new Error(`GitHub rejected the access token (expired or revoked?) — ${where}.`);
    e.status = 401;
    e.badToken = true;
    throw e;
  }
  // Primary limit: quota exhausted (remaining 0, resets at x-ratelimit-reset). Secondary limit:
  // too many requests too fast — 429, or 403 with retry-after, while quota is still left.
  const retryAfter = Number(res.headers.get('retry-after') || 0);
  const primary = res.headers.get('x-ratelimit-remaining') === '0';
  if ((res.status === 403 || res.status === 429) && (primary || retryAfter || res.status === 429)) {
    let msg;
    if (primary) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
      const hint = authed ? '' : ' Add a GitHub access token in Settings (or set GITHUB_TOKEN) to raise the limit from 60 to 5,000 an hour.';
      msg = `GitHub rate limit hit (resets ~${when}).${hint}`;
    } else {
      msg = `GitHub is throttling requests — wait ${retryAfter ? `${retryAfter}s` : 'a minute'} and try again.`;
    }
    const e = new Error(msg);
    e.rateLimited = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`GitHub ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// GitHub answers 404 for a private repository the caller may not see, exactly as for one that
// does not exist. So the message says what to do in the case the user can fix.
function repoNotFound() {
  return currentToken()
    ? 'repository not found — it was deleted or renamed, or it is private and your GitHub token cannot read it (the token needs Contents: Read-only access to that repository)'
    : 'repository not found — it was deleted or renamed, or it is private (a private repository needs a GitHub token that can read it: Settings → GitHub)';
}

// True if the repo itself is gone (deleted/renamed/private) rather than just release-less.
async function repoMissing(owner, repo) {
  try {
    await ghJson(`${API}/repos/${owner}/${repo}`);
    return false;
  } catch (e) {
    return e.status === 404;
  }
}

// Some repos (bitwarden/clients, and other monorepos) publish several independent release
// trains under one repo — desktop-vX, web-vX, browser-vX... — interleaved by publish date.
// /releases/latest just returns whichever train published most recently, which is often the
// WRONG product. tagPrefix pins detection to releases whose tag starts with a given prefix.
const TAG_PREFIX_MAX_PAGES = 5; // 500 releases; well past any repo's realistic per-train gap

async function findByTagPrefix(owner, repo, prefix, includePrerelease) {
  for (let page = 1; page <= TAG_PREFIX_MAX_PAGES; page++) {
    const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`);
    if (!list || list.length === 0) break;
    const hit = list.find((r) => !r.draft && (includePrerelease || !r.prerelease) && String(r.tag_name || '').startsWith(prefix));
    if (hit) return hit;
    if (list.length < 100) break; // last page reached
  }
  throw Object.assign(new Error('x'), { status: 404 });
}

// /releases/latest excludes prereleases + drafts; opts.prerelease uses /releases[0] (first non-draft).
// opts.tagPrefix restricts either mode to one release train within a multi-product repo.
// On 404, distinguish a missing repo (deleted/renamed) from a repo with no matching releases.
//
// opts.usable(release) — optional: does this release have a file the caller could install?
// The latest release is the answer whenever it does, or when no test is given: exactly as
// before, with no extra request. When it does not, the newest earlier release that does is
// returned instead, carrying `skipped` (the release passed over) so the caller can say so.
// When no recent release has one either, the latest is returned and the caller fails on it
// with the message it always gave.
async function getLatestRelease(owner, repo, opts = {}) {
  const latest = await newestRelease(owner, repo, opts);
  if (typeof opts.usable !== 'function' || opts.usable(latest)) return latest;
  // Looking further back is a courtesy: if that request fails, the latest release stands. A
  // rate limit is the exception — it ends the whole run, so it must be heard.
  let earlier = null;
  try {
    earlier = await findRecentRelease(owner, repo, opts, opts.usable);
  } catch (e) {
    if (e.rateLimited) throw e;
  }
  if (!earlier || earlier.tag_name === latest.tag_name) return latest;
  return { ...earlier, skipped: { tag: latest.tag_name, url: latest.html_url } };
}

async function newestRelease(owner, repo, opts) {
  try {
    if (opts.tagPrefix) {
      return await findByTagPrefix(owner, repo, opts.tagPrefix, opts.prerelease);
    }
    if (opts.prerelease) {
      const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=10`);
      const rel = (list || []).find((r) => !r.draft);
      if (!rel) throw Object.assign(new Error('x'), { status: 404 });
      return rel;
    }
    return await ghJson(`${API}/repos/${owner}/${repo}/releases/latest`);
  } catch (e) {
    if (e.status === 404) {
      if (await repoMissing(owner, repo)) throw new Error(repoNotFound());
      throw new Error(opts.tagPrefix ? `no releases found with tag prefix "${opts.tagPrefix}"` : 'no releases found for this repository');
    }
    throw e;
  }
}

// Some projects attach their files to only SOME releases. tesseract-ocr/tesseract puts its
// Windows installer on 5.5.0 and 5.5.3, and nothing at all on 5.5.1, 5.5.2 or 5.5.4. Taking
// /releases/latest alone, such an app shows "Update" for a release there is nothing to install
// from, and every update fails. This finds the newest release, within the same rules as
// newestRelease (prerelease, tag prefix), that `accept` says has something usable. One API
// call, made only when the latest release had nothing. -> the release, or null.
const RECENT_RELEASES = 30;
async function findRecentRelease(owner, repo, opts, accept) {
  const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=${RECENT_RELEASES}`);
  return (list || []).find((r) =>
    !r.draft && (opts.prerelease || !r.prerelease) &&
    (!opts.tagPrefix || String(r.tag_name || '').startsWith(opts.tagPrefix)) &&
    accept(r)) || null;
}

// Current core API quota. /rate_limit itself does not count against the limit. Pass a token
// to test a candidate before saving it; omitted, it reports whatever the app is using now.
async function rateLimit(token) {
  const body = await ghJson(`${API}/rate_limit`, token);
  const core = (body && body.resources && body.resources.core) || (body && body.rate) || {};
  return { limit: core.limit, remaining: core.remaining, reset: core.reset };
}

async function listAssets(owner, repo, opts = {}) {
  const rel = await getLatestRelease(owner, repo, opts);
  return { tag: rel.tag_name, assets: (rel.assets || []).map((a) => a.name) };
}

// --- a private repository's release files -----------------------------------------------
//
// A release file has two addresses. The public one (browser_download_url, on github.com) is
// what every download uses, with no token. For a PRIVATE repository that address answers 404
// to anyone not signed in to the website, token or not. GitHub serves the same file from its
// API (the asset's `url`): asked for with the token and `Accept: application/octet-stream`,
// api.github.com answers with a redirect to a short-lived signed address on GitHub's storage.
//
// So the token still goes to api.github.com and nowhere else:
//   1. ONE request to api.github.com, with the token, not following its redirect;
//   2. the signed address it names is then fetched WITHOUT the token (the signature in that
//      address is the permission; storage hosts reject a request that carries both).
// The address must be exactly an api.github.com release-asset URL, so a release listing can
// never direct the token to another host. Used only after the public address said 404.
const API_ASSET = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/releases\/assets\/\d+$/;
const isApiAsset = (url) => typeof url === 'string' && API_ASSET.test(url);

// -> { res, finalUrl }, or null when there is no token or the address is not an API asset.
async function openPrivateAsset(apiUrl) {
  const token = currentToken();
  if (!token || !isApiAsset(apiUrl)) return null;
  const headers = { ...apiHeaders(token), Accept: 'application/octet-stream' };
  let signed = null;
  if (_redirectResolver) {
    // Electron: net.fetch cannot show a redirect's destination, so the GUI's resolver reads
    // the first hop and stops there (firstHopOnly) — it never carries the token onwards.
    const next = await _redirectResolver(apiUrl, { checkHop, maxHops: 1, headers, firstHopOnly: true });
    if (stripSlash(next) !== stripSlash(apiUrl)) signed = next;
  } else {
    const first = await doFetch(apiUrl, { headers, redirect: 'manual' });
    if (first.type === 'opaqueredirect' || first.status === 0) {
      throw Object.assign(new Error('api.github.com redirected the download and the next address could not be checked first'), { redirectRefused: true });
    }
    if (!isRedirect(first)) return { res: first, finalUrl: apiUrl }; // served directly, or an error status
    signed = checkHop(apiUrl, first.headers && first.headers.get && first.headers.get('location'));
    try { if (first.body && first.body.cancel) await first.body.cancel(); } catch {}
  }
  if (!signed) {
    // No redirect: api.github.com serves the bytes itself. Ask again, refusing any redirect,
    // so the token cannot leave this host on the second request either.
    const { res } = await fetchWithPolicy(apiUrl, { headers }, { redirects: 'none' });
    return { res, finalUrl: apiUrl };
  }
  if (new URL(signed).host === 'api.github.com') throw Object.assign(new Error('api.github.com redirected the download to itself'), { redirectRefused: true });
  // From here on there is no token: only the signed address, every hop https.
  return fetchWithPolicy(signed, { headers: { 'User-Agent': UA } }, { redirects: 'https' });
}

// fetch follows redirects by default; enforce the size cap while streaming.
// onProgress(pct 0-100) is called as bytes arrive (throttled) when a size is known.
//
// maxBytes: the cap in bytes (default 500 MiB when omitted); pass null for no cap.
// opts (all optional, used by non-GitHub sources — see src/sources/index.js):
//   httpsOnly   every address touched, including each redirect hop, must be https
//   noRedirect  the server must answer directly; a redirect is refused IN THE TRANSPORT,
//               before any request is made to wherever it points
//   onFinalUrl  called with the URL the bytes actually came from, so the caller can show
//               and log the real origin rather than only the declared one
//   apiUrl      a GitHub asset's API address. Tried only when `url` answers 404 and a token
//               is set: that is a private repository's file (see openPrivateAsset)
// With neither policy flag (every GitHub download) the request is exactly what it was.
async function downloadAsset(url, destPath, onProgress, maxBytes = DEFAULT_MAX_BYTES, opts = {}) {
  const strict = !!(opts.httpsOnly || opts.noRedirect);
  if (opts.httpsOnly) assertHttpsUrl(url);
  // Retry the whole download: a reset can hit either the initial connection (fetch rejects)
  // or the body stream (pipeline rejects). Each attempt re-fetches and overwrites destPath,
  // so a partial file from a failed try is never left behind.
  return withNetRetry(async () => {
    const init = { headers: { 'User-Agent': UA } };
    let { res, finalUrl } = strict
      ? await fetchWithPolicy(url, init, { redirects: opts.noRedirect ? 'none' : 'https' })
      : { res: await doFetch(url, init), finalUrl: url };
    let viaApi = false;
    if (res.status === 404 && isApiAsset(opts.apiUrl) && currentToken()) {
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch {}
      ({ res, finalUrl } = await openPrivateAsset(opts.apiUrl));
      viaApi = true;
    }
    if (!res.ok) {
      const hint = viaApi && (res.status === 404 || res.status === 403 || res.status === 401)
        ? ' — if this repository is private, your GitHub token needs Contents: Read-only access to it'
        : '';
      throw new Error(`download ${res.status} for ${strict || viaApi ? safeUrl(url) : url}${hint}`);
    }
    // A signed address carries its signature in the query: it is reported without it.
    if (typeof opts.onFinalUrl === 'function') opts.onFinalUrl(viaApi ? safeUrl(finalUrl) : strict ? finalUrl : res.url || url);
    const declared = Number(res.headers.get('content-length') || 0);
    if (maxBytes != null && declared && declared > maxBytes) throw new Error(`asset too large: ${declared} bytes (cap ${maxBytes}) — ${LIMIT_HINT}`);
    let seen = 0;
    let lastPct = -1;
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (maxBytes != null && seen > maxBytes) throw new Error(`asset exceeded size cap ${maxBytes} bytes — ${LIMIT_HINT}`);
          if (onProgress && declared) {
            const pct = Math.floor((seen / declared) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress(pct);
            }
          }
          yield chunk;
        }
      },
      fs.createWriteStream(destPath)
    );
    return destPath;
  }, url);
}

// Fallback when GitHub provides no asset.digest: many releases ship a checksums file
// (SHA256SUMS, <name>.sha256, SHA512-SUMS.txt, checksums.txt...). Find one in the same
// release, download it (small), and pull the hash for assetName from it.
// Returns { algo, expected } or null when the release has nothing usable.
const SUMS_FILE = /(sha(256|512)[-_.]?sums?|checksums?)(\.txt)?$|\.(sha256|sha512)$/i;
const MAX_SUMS_BYTES = 1024 * 1024;

async function fetchChecksumFromRelease(rel, assetName) {
  const candidates = (rel.assets || []).filter(
    (a) => SUMS_FILE.test(a.name) && a.size <= MAX_SUMS_BYTES &&
      // "<name>.sha256"-style files must belong to OUR asset
      (!/\.(sha256|sha512)$/i.test(a.name) || a.name.toLowerCase().startsWith(assetName.toLowerCase()))
  );
  for (const c of candidates) {
    try {
      let res = await doFetch(c.browser_download_url, { headers: { 'User-Agent': UA } });
      // A private repository's checksum file, like its other files, is only served by the API.
      if (res.status === 404 && isApiAsset(c.url) && currentToken()) ({ res } = await openPrivateAsset(c.url));
      if (!res.ok) continue;
      const text = await res.text();
      // Lines look like "<hex>  <filename>" (or "<hex> *<filename>"), or a bare hex
      // for per-asset .sha256 files.
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\s+\*?(.+)$/i);
        if (m && path.basename(m[2].trim()).toLowerCase() === assetName.toLowerCase()) {
          return { algo: m[1].length === 64 ? 'sha256' : 'sha512', expected: m[1] };
        }
      }
      const bare = text.trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\b/i);
      if (bare && /\.(sha256|sha512)$/i.test(c.name)) {
        return { algo: bare[1].length === 64 ? 'sha256' : 'sha512', expected: bare[1] };
      }
    } catch {}
  }
  return null;
}

// digest: GitHub asset.digest like "sha256:abc..." . Missing/unsupported -> skip with a note.
function verifyDigest(filePath, digest) {
  if (!digest) return { skipped: true, note: 'no digest from GitHub; checksum skipped' };
  const [algo, expected] = String(digest).split(':');
  if (!['sha256', 'sha512'].includes(algo) || !expected) return { skipped: true, note: `unsupported digest "${digest}"; skipped` };
  const hash = crypto.createHash(algo);
  // Hash in bounded chunks rather than reading the whole file: with the download cap raised
  // or off, an installer can be several GiB, and a whole-file read both needs that much
  // memory and fails outright past what one Buffer can hold.
  // Hand-ported from EstusFlask/git-updater-background (flash201524), commit 4d89769.
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
  return { verified: true };
}

// The GitHub page where Settings sends you to create the token, with the form pre-filled (GitHub documents
// these URL parameters for fine-grained tokens): a name, a description and no expiry. There is deliberately no
// permission parameter: a fine-grained token with none can still read public repositories, which is all
// git-updater needs. The Electron main process opens this; the window never passes a URL across the bridge.
const TOKEN_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'git-updater',
  description: 'Read public release info for git-updater',
  expires_in: 'none',
}).toString();

module.exports = {
  getLatestRelease, findRecentRelease, listAssets, downloadAsset, verifyDigest, fetchChecksumFromRelease, setFetch, setToken, rateLimit, TOKEN_CREATE_URL, openPrivateAsset,
  // shared with the source providers (src/sources/)
  doFetch, withNetRetry, fetchWithPolicy, checkHop, setRedirectResolver, assertHttpsUrl, safeUrl, UA, SUMS_FILE, DEFAULT_MAX_BYTES,
};
