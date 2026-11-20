'use strict';

// The source registry: the one place that knows there is more than one kind of place an
// app can come from. Everything else — the runner, the Electron main process, the CLI —
// asks the registry and never a provider directly.
//
// What lives here, and why here rather than in a provider:
//
//   keys          A non-GitHub app needs an identity that cannot collide with a real
//                 repository and that the renderer cannot forge. Derived, never stored
//                 on trust: see keyParts and normalizeEntry.
//   selection     Which file a given machine gets. Add, Check, Preview, dry-run and Update
//                 all call selectAsset, so a check can never promise an update that the
//                 install then refuses.
//   checksums     One policy for every provider: verify whenever a hash exists, say so
//                 plainly when none does, and block only if the user asked for that.
//   provenance    Who lists the file, and which host it is actually fetched from. The
//                 user must always be able to see both.
//
// Providers stay small and host-independent: they turn a listing into a release and
// return EVERY asset in it. They do not look at the running machine.

const path = require('path');
const core = require('../core');
const github = require('../github');
const net = require('./net');
const { assetTable } = require('../platform/assets');

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Built-in providers are always present. The rest are optional so that each one can land
// (and be removed) as a single file without the registry changing.
const PROVIDERS = new Map();
function register(p) {
  if (!p || !p.type || PROVIDERS.has(p.type)) return;
  PROVIDERS.set(p.type, p);
}
register(require('./github'));
register(require('./gitea'));
register(require('./gitlab'));
for (const name of ['winget', 'brew', 'folder']) {
  try {
    register(require(`./${name}`));
  } catch (e) {
    // Absent is fine. Present but broken is not: surface that rather than hide a provider.
    if (!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`./${name}`))) throw e;
  }
}

function provider(type) {
  const p = PROVIDERS.get(type);
  if (!p) throw new Error(`unknown source type "${type}"`);
  return p;
}
const providerTypes = () => [...PROVIDERS.keys()];

// A config entry with no `source` is a GitHub entry — every config written before sources
// existed loads unchanged.
function sourceOf(entry) {
  if (entry && entry.source && entry.source.type) return entry.source;
  return { type: 'github', owner: entry.owner, repo: entry.repo };
}
const isGithub = (entry) => sourceOf(entry).type === 'github';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

// GitHub keys stay byte-for-byte what they always were: owner/repo. Every other source
// gets "source.<type>/<encoded ref>". A GitHub owner cannot contain a dot, so the two
// namespaces cannot collide, and percent-encoding keeps "/" and "#" out of the second
// segment, where the rest of the app splits on them.
function keyParts(source) {
  if (source.type === 'github') return { owner: source.owner, repo: source.repo };
  const p = provider(source.type);
  return { owner: `source.${source.type}`, repo: encodeURIComponent(p.canonicalRef(source)) };
}
const appKey = (entry) => `${entry.owner}/${entry.repo}#${entry.type}`;

// Recompute owner/repo from `source` so a hand-edited or imported entry cannot claim one
// identity while pointing at another. Returns the entry (mutated) for chaining.
function normalizeEntry(entry) {
  if (!entry || !entry.source) return entry;
  const p = provider(entry.source.type);
  if (entry.source.type === 'github') {
    // An explicit github source is just the long spelling of a plain entry.
    entry.owner = entry.source.owner;
    entry.repo = entry.source.repo;
    delete entry.source;
    return entry;
  }
  const k = keyParts(entry.source);
  entry.owner = k.owner;
  entry.repo = k.repo;
  if (!entry.name) entry.name = defaultName(entry.source, p);
  return entry;
}

function defaultName(source, p) {
  const ref = String((p || provider(source.type)).canonicalRef(source));
  const last = ref.split('/').filter(Boolean).pop() || ref;
  return last.split('.').pop() || last;
}

// Build a config entry from a resolver candidate. The renderer supplies the candidate's
// `source` object and a type; everything that forms the identity is derived here.
function entryFromCandidate(candidate, type, extra = {}) {
  if (type !== 'portable' && type !== 'installer') throw new Error('type must be portable or installer');
  const source = candidate.source;
  const p = provider(source.type);
  // Round-trip through the provider so only fields it understands survive.
  const clean = cleanSource(source, p);
  const entry = { ...keyParts(clean), type };
  if (clean.type !== 'github') {
    entry.name = String(candidate.name || defaultName(clean, p)).slice(0, 120);
    entry.source = clean;
  }
  if (extra.prerelease) entry.prerelease = true;
  return entry;
}

// Keep only plain JSON scalars one level deep — a source is ids and URLs, nothing else.
function cleanSource(source, p) {
  const out = { type: p.type };
  for (const [k, v] of Object.entries(source || {})) {
    if (k === 'type') continue;
    if (typeof v === 'string' && v.length <= 2048) out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  p.canonicalRef(out); // throws if the provider cannot make sense of it
  return out;
}

// ---------------------------------------------------------------------------
// Description (no network) — what the UI shows on every row
// ---------------------------------------------------------------------------

function describe(entry) {
  const source = sourceOf(entry);
  const p = provider(source.type);
  const pageUrl = p.pageUrl(source);
  const label = typeof p.hostLabel === 'function' && source.host ? p.hostLabel(source.host) : p.label;
  return {
    type: source.type,
    label,
    ref: p.canonicalRef(source),
    pageUrl,
    listingHost: net.hostOf(pageUrl),
    checksum: p.checksum || 'optional',
  };
}

function pageUrl(entry) {
  const url = describe(entry).pageUrl;
  net.assertHttps(url);
  return url;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

let _cacheDir;
function setCacheDir(dir) { _cacheDir = dir; }
function setFetch(fn) { github.setFetch(fn); }

function makeCtx(over = {}) {
  return {
    net,
    platform: process.platform,
    arch: process.arch,
    cacheDir: _cacheDir,
    now: () => Date.now(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

async function getLatestRelease(entry, ctx) {
  const source = sourceOf(entry);
  const p = provider(source.type);
  if (typeof p.available === 'function') {
    const a = p.available(ctx || makeCtx());
    if (a && a.ok === false) throw new Error(`${p.label} is not available here: ${a.reason}`);
  }
  const rel = await p.getLatestRelease(source, ctx || makeCtx(), { prerelease: entry.prerelease, tagPrefix: entry.tagPrefix });
  if (!rel || !rel.tag_name) throw new Error(`${p.label} returned no version for this app`);
  if (source.type !== 'github') {
    // Nothing from a non-GitHub listing is fetched over plain HTTP — the hard limit.
    rel.assets = (rel.assets || []).filter((a) => a && a.name && /^https:\/\//i.test(String(a.browser_download_url || '')));
  }
  if (!rel.provenance) rel.provenance = { listedBy: p.label, listingUrl: p.pageUrl(source) };
  return rel;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

// Can this machine run a build made for `assetArch`? Exact and universal builds always;
// x64 under emulation on arm64 Windows and arm64 macOS (a fallback, ranked below native).
// Everything else — arm64 on an Intel machine, anything foreign on Linux — cannot run and
// is never offered.
function archRank(assetArch, hostArch, platform) {
  if (!assetArch || assetArch === 'any') return 2;
  if (assetArch === hostArch) return 3;
  if (assetArch === 'universal') return 2;
  if (hostArch === 'arm64' && assetArch === 'x64' && (platform === 'win32' || platform === 'darwin')) return 1;
  if (hostArch === 'x64' && assetArch === 'ia32' && platform === 'win32') return 1;
  if (hostArch === 'arm64' && assetArch === 'ia32' && platform === 'win32') return 1;
  return 0;
}

const KIND_FLAVOR = { msi: 'msi', nsis: 'exe', inno: 'exe', deb: 'deb', rpm: 'rpm' };

// Assets from a manifest provider say what they are. Choose on the stated facts.
function selectExplicit(entry, rel, host) {
  const all = rel.assets || [];
  const here = all.filter((a) => !a.platform || a.platform === host.platform);
  const runnable = here.filter((a) => archRank(a.arch, host.arch, host.platform) > 0);
  const typed = runnable.filter((a) => !a.type || a.type === entry.type);
  const usable = typed.filter((a) => !a.unsupported);
  if (!usable.length) {
    const os = assetTable(host.platform).label;
    if (typed.length) throw new Error(`not installable by git-updater: ${typed[0].unsupported}`);
    if (runnable.length) {
      const other = entry.type === 'installer' ? 'Portable' : 'Installer';
      throw new Error(`this source only lists ${other.toLowerCase()} builds for ${os} — Edit the app and change its type to ${other}`);
    }
    if (here.length) throw new Error(`no build for this machine (${os} ${host.arch}) in ${core.normTag(rel.tag_name)}`);
    throw new Error(`this source lists nothing for ${os}`);
  }
  const want = entry.install || {};
  const score = (a) => {
    let s = archRank(a.arch, host.arch, host.platform) * 1000;
    if (host.flavor && KIND_FLAVOR[a.kind] === host.flavor) s += 100;
    if (want.scope ? a.scope === want.scope : a.scope === 'machine') s += 20;
    else if (!a.scope) s += 10;
    if (want.locale ? a.locale === want.locale : !a.locale) s += 6;
    else if (/^en(-US)?$/i.test(String(a.locale || ''))) s += 4;
    return s;
  };
  return usable.slice().sort((a, b) => score(b) - score(a))[0];
}

// A filename is all a forge or a folder gives us. Reuse the existing picker, but first
// remove builds this machine cannot run at all — its scoring only penalises them, and a
// penalty still wins when the wrong build is the only candidate.
function strictArchFilter(assets, host) {
  const t = assetTable(host.platform);
  return (assets || []).filter((a) => {
    const k = t.archTokens(a.name);
    if (k.isUniversal) return true;
    const named = k.isX64 || k.isArm || k.isX86;
    if (!named) return true;
    const builtFor = [k.isX64 && 'x64', k.isArm && 'arm64', k.isX86 && 'ia32'].filter(Boolean);
    return builtFor.some((arch) => archRank(arch, host.arch, host.platform) > 0);
  });
}

// host: { platform, arch, flavor, osRelease }. Defaults to the running machine.
function selectAsset(entry, rel, host = {}) {
  const h = {
    platform: host.platform || process.platform,
    arch: host.arch || process.arch,
    flavor: host.flavor || null,
    osRelease: host.osRelease || null,
  };
  if (entry.asset) return core.matchAsset(rel.assets, entry.asset); // a hand-pinned pattern always wins
  if (isGithub(entry)) return core.pickAsset(rel.assets, entry.type, h.arch, h.flavor, h.platform, h.osRelease);
  const explicit = (rel.assets || []).some((a) => a.platform || a.type || a.kind);
  if (explicit) return selectExplicit(entry, rel, h);
  const runnable = strictArchFilter(rel.assets, h);
  if (!runnable.length && (rel.assets || []).length) {
    // Does the listing have a build for this OS at all, just not this architecture?
    try {
      core.pickAsset(rel.assets, entry.type, h.arch, h.flavor, h.platform, h.osRelease);
      throw Object.assign(new Error(`no build for this machine (${assetTable(h.platform).label} ${h.arch}) in ${core.normTag(rel.tag_name)}`), { noArch: true });
    } catch (e) {
      if (e.noArch) throw e;
    }
  }
  try {
    return core.pickAsset(runnable, entry.type, h.arch, h.flavor, h.platform, h.osRelease);
  } catch (e) {
    // The picker's "no asset" message lists what it saw; if it saw nothing only because
    // the architecture filter removed everything for this OS, say that instead.
    if (runnable.length < (rel.assets || []).length && /^no .* asset in release/.test(e.message)) {
      let otherArch = false;
      try { core.pickAsset(rel.assets, entry.type, h.arch, h.flavor, h.platform, h.osRelease); otherArch = true; } catch {}
      if (otherArch) throw new Error(`no build for this machine (${assetTable(h.platform).label} ${h.arch}) in ${core.normTag(rel.tag_name)}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const MAX_SUMS_BYTES = 1024 * 1024;

// Pull the hash for assetName out of a sums file's text. Lines are "<hex>  <name>" (or
// "<hex> *<name>"); a per-file ".sha256" may hold a bare hash.
function parseSums(text, assetName, sumsFileName) {
  const want = String(assetName).toLowerCase();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\s+\*?(.+)$/i);
    if (m && path.posix.basename(m[2].trim().replace(/\\/g, '/')).toLowerCase() === want) {
      return { algo: m[1].length === 64 ? 'sha256' : 'sha512', expected: m[1].toLowerCase() };
    }
  }
  const bare = String(text).trim().match(/^([a-f0-9]{64}|[a-f0-9]{128})\b/i);
  if (bare && /\.(sha256|sha512)$/i.test(sumsFileName || '') && String(sumsFileName).toLowerCase().startsWith(want)) {
    return { algo: bare[1].length === 64 ? 'sha256' : 'sha512', expected: bare[1].toLowerCase() };
  }
  return null;
}

// Find a published checksum for `asset` among the release's own files.
async function findPublishedChecksum(rel, asset, ctx) {
  const name = String(asset.name).toLowerCase();
  const candidates = (rel.assets || []).filter((a) => a !== asset && github.SUMS_FILE.test(a.name) &&
    (a.size == null || a.size <= MAX_SUMS_BYTES) &&
    // "<name>.sha256" must belong to OUR file; a shared sums file is matched by its lines.
    (!/\.(sha256|sha512)$/i.test(a.name) || a.name.toLowerCase().startsWith(name) || !/\.(zip|7z|exe|msi|dmg|pkg|deb|rpm|appimage|tar\.[a-z0-9]+|tgz)\.(sha256|sha512)$/i.test(a.name)));
  for (const c of candidates) {
    try {
      const { text } = await ctx.net.getText(c.browser_download_url, { maxBytes: MAX_SUMS_BYTES });
      const hit = parseSums(text, asset.name, c.name);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

// -> { digest: 'sha256:<hex>' | null, state: 'pinned' | 'published' | 'none', note }
//   pinned     the listing itself states the hash of this exact file (winget, Homebrew)
//   published  the publisher ships a hash beside the file (asset digest or a sums file)
//   none       nothing to verify against
async function resolveChecksum(entry, rel, asset, ctx) {
  const p = provider(sourceOf(entry).type);
  if (asset.digest) {
    return p.checksum === 'pinned'
      ? { digest: asset.digest, state: 'pinned', note: `verified against the ${p.label} listing` }
      : { digest: asset.digest, state: 'published', note: null };
  }
  const found = isGithub(entry)
    ? await github.fetchChecksumFromRelease(rel, asset.name)
    : await findPublishedChecksum(rel, asset, ctx || makeCtx());
  if (found) return { digest: `${found.algo}:${found.expected}`, state: 'published', note: 'verified via release checksums file' };
  return { digest: null, state: 'none', note: 'no checksum published' };
}

// How the bytes may be fetched for this entry's source.
function downloadPolicy(entry, asset, checksum) {
  if (isGithub(entry)) return {}; // unchanged: GitHub's own redirect to its CDN is how it serves assets
  const pinned = checksum && checksum.digest && asset.redirects === 'https-pinned';
  const forge = ['gitlab', 'gitea'].includes(sourceOf(entry).type); // forges redirect to their object storage
  return { httpsOnly: true, noRedirect: !(pinned || forge) };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function looksLikeUrl(s) {
  if (/^https?:\/\//i.test(s)) return true;
  return /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s) && !/\s/.test(s);
}

function candidateOf(p, source, extra = {}) {
  return {
    source,
    name: extra.name || defaultName(source, p),
    listedBy: (typeof p.hostLabel === 'function' && source.host ? p.hostLabel(source.host) : p.label),
    listingUrl: p.pageUrl(source),
    exact: true,
    ...extra,
  };
}

// text: whatever the user typed — a GitHub URL, any other URL, owner/repo, or a name.
// lookups: { catalog(name, platform) -> Candidate[] } supplied by the caller so this
// module does not depend on the catalog (and stays testable without it).
// Returns { kind: 'url' | 'name', candidates }.
async function resolve(text, ctx, lookups = {}) {
  const c = ctx || makeCtx();
  const input = String(text || '').trim();
  if (!input) return { kind: 'name', candidates: [] };
  if (input.length > 2048) throw new Error('that is too long to be an app name or address');

  if (looksLikeUrl(input) || /^[^/\s]+\/[^/\s]+$/.test(input)) {
    if (/^http:\/\//i.test(input)) throw new Error('only https:// addresses are accepted');
    const url = /^https:\/\//i.test(input) ? input : looksLikeUrl(input) ? `https://${input}` : input;
    const out = [];
    for (const p of PROVIDERS.values()) {
      if (typeof p.parseUrl !== 'function') continue;
      const s = p.parseUrl(url);
      if (s) out.push(candidateOf(p, s, { explicit: true }));
    }
    if (!out.length && /^https:\/\//i.test(url)) {
      for (const type of ['gitea', 'gitlab', 'folder']) {
        const p = PROVIDERS.get(type);
        if (!p || typeof p.probe !== 'function') continue;
        const s = await p.probe(url, c);
        if (s) {
          out.push(candidateOf(p, s, { explicit: true }));
          break;
        }
      }
    }
    if (!out.length) throw new Error('no supported source found at that address');
    return { kind: 'url', candidates: out };
  }

  // A name. Curated places only: the built-in list first, then providers that keep an
  // index for this platform. There is deliberately no free-text search of GitHub.
  const candidates = [];
  if (typeof lookups.catalog === 'function') candidates.push(...(await lookups.catalog(input, c.platform)));
  for (const p of PROVIDERS.values()) {
    if (typeof p.search !== 'function') continue;
    if (p.platforms && !p.platforms.includes(c.platform)) continue;
    if (typeof p.available === 'function') {
      const a = p.available(c);
      if (a && a.ok === false) continue;
    }
    try {
      const found = await p.search(input, c);
      for (const f of found || []) candidates.push({ listedBy: p.label, listingUrl: p.pageUrl(f.source), ...f });
    } catch (e) {
      candidates.push({ error: `${p.label}: ${e.message}`, listedBy: p.label });
    }
  }
  return { kind: 'name', candidates: dedupe(candidates) };
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (c.error) { out.push(c); continue; }
    const k = `${c.source.type}:${provider(c.source.type).canonicalRef(c.source)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// Which candidate, if any, may be added without asking? Only when the user set a
// preference AND the first preferred provider that has the app offers exactly one
// candidate whose identity is established (a curated shortcut or an exact provider id).
function autoPick(candidates, preference) {
  const order = Array.isArray(preference) ? preference : [];
  if (!order.length) return null;
  const ok = (candidates || []).filter((c) => !c.error && !c.explicit);
  for (const type of order) {
    const hits = ok.filter((c) => c.source.type === type);
    if (!hits.length) continue;
    const sure = hits.filter((c) => c.curated || c.exact);
    return sure.length === 1 && hits.length === 1 ? sure[0] : sure.length === 1 && hits.every((c) => c === sure[0] || !c.exact) && sure[0].curated ? sure[0] : null;
  }
  return null;
}

// Everything the options list shows for one candidate, per package type, without
// downloading the file: version, the file this machine would get, where it is fetched
// from, and whether a checksum exists.
async function inspect(candidateOrEntry, ctx, host = {}) {
  const c = ctx || makeCtx();
  const base = candidateOrEntry.source && !candidateOrEntry.owner
    ? { ...keyParts(candidateOrEntry.source), source: candidateOrEntry.source.type === 'github' ? undefined : candidateOrEntry.source, prerelease: candidateOrEntry.prerelease }
    : candidateOrEntry;
  const rel = await getLatestRelease(base, c);
  const out = {
    version: core.normTag(rel.tag_name),
    listedBy: rel.provenance.listedBy,
    listingUrl: rel.provenance.listingUrl || rel.html_url,
    publisher: rel.provenance.publisher || null,
    note: rel.provenance.note || null,
    types: {},
  };
  for (const type of ['installer', 'portable']) {
    try {
      const asset = selectAsset({ ...base, type }, rel, host);
      const sum = await resolveChecksum({ ...base, type }, rel, asset, c);
      out.types[type] = {
        ok: true,
        file: asset.name,
        url: redact(asset.browser_download_url),
        host: net.hostOf(asset.browser_download_url),
        size: asset.size || null,
        checksum: sum.state,
        requires: asset.requires || null,
      };
    } catch (e) {
      out.types[type] = { ok: false, reason: e.message };
    }
  }
  return out;
}

// Query strings can carry tokens. What is shown and logged never includes them.
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return String(url);
  }
}

module.exports = {
  provider,
  providerTypes,
  sourceOf,
  isGithub,
  keyParts,
  appKey,
  normalizeEntry,
  entryFromCandidate,
  describe,
  pageUrl,
  setFetch,
  setCacheDir,
  makeCtx,
  getLatestRelease,
  selectAsset,
  archRank,
  strictArchFilter,
  parseSums,
  resolveChecksum,
  downloadPolicy,
  resolve,
  autoPick,
  inspect,
  redact,
  looksLikeUrl,
};
