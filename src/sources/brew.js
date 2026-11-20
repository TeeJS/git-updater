'use strict';

// Homebrew Cask as a source provider (macOS).
//
// Homebrew is used here as a LISTING, not as a package manager: git-updater never runs
// `brew`. A cask names a vendor's own download URL, the version, and a SHA-256 for that
// exact file, all reviewed in the open at github.com/Homebrew/homebrew-cask. We read that
// record and fetch the vendor's file ourselves.
//
//   one cask    https://formulae.brew.sh/api/cask/<token>.json   (a few KB)
//   the index   https://formulae.brew.sh/api/cask.json           (~20 MB of JSON, ~7,800 casks)
//
// Things in the data that shape this file (all taken from the real index):
//
//   - The top-level url/version/sha256 describe the newest macOS on Apple silicon.
//     `variations` override them AS A UNIT per macOS release and CPU: "sequoia" is Intel
//     on macOS 15, "arm64_sequoia" is Apple silicon on macOS 15. A variation can carry a
//     different VERSION — Blender's Intel variation pins 4.5.16 while Apple silicon gets
//     5.3.0 — so the answer genuinely depends on the machine. This is the one provider
//     that reads ctx.arch and ctx.osVersion to decide what a release IS.
//   - 2,778 casks have sha256 "no_check" (the vendor replaces the file in place). Those
//     are returned without a digest and labelled as having no checksum.
//   - 2,157 have version "latest": there is nothing to compare, so no update can ever be
//     detected. Those are refused with a reason.
//   - 122 app casks have a download URL with no file extension (VS Code:
//     update.code.visualstudio.com/<v>/darwin-arm64/stable). The asset is marked `sniff`
//     so the runner names the file from its first bytes once it has them.
//   - Fonts, suites, and casks that need scripts or a manual installer are not apps
//     git-updater can place, and are returned as unsupported.

const type = 'brew';
const label = 'Homebrew';
const platforms = ['darwin'];
const checksum = 'pinned';

const API = 'https://formulae.brew.sh/api/cask';
const TOKEN = /^[a-z0-9][a-z0-9+@._-]{0,99}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const INDEX_MAX_BYTES = 96 * 1024 * 1024;
const INDEX_MAX_AGE = 6 * 60 * 60 * 1000;
const CASK_MAX_BYTES = 2 * 1024 * 1024;

// macOS release names as Homebrew spells them, by major version, newest last.
const MACOS = [
  ['big_sur', 11], ['monterey', 12], ['ventura', 13], ['sonoma', 14], ['sequoia', 15], ['tahoe', 26], ['golden_gate', 27],
];
const CODENAME = new Map(MACOS.map(([name, major]) => [major, name]));
const MAJOR = new Map(MACOS);

function token(source) {
  const t = source && source.token;
  if (typeof t !== 'string' || !TOKEN.test(t)) throw new Error('Homebrew needs a valid cask name, such as vlc');
  return t;
}
const canonicalRef = (source) => token(source).toLowerCase();
const pageUrl = (source) => `https://formulae.brew.sh/cask/${encodeURIComponent(token(source))}`;

function parseUrl(input) {
  try {
    const u = new URL(String(input || '').trim());
    if (u.protocol !== 'https:' || u.host !== 'formulae.brew.sh' || u.username || u.password) return null;
    const m = /^\/cask\/([^/]+)\/?$/.exec(u.pathname);
    if (!m) return null;
    const t = decodeURIComponent(m[1]).toLowerCase();
    return TOKEN.test(t) ? { type, token: t } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which record applies to this machine
// ---------------------------------------------------------------------------

// ctx.osVersion is the macOS version ("15.3"); absent means "assume the newest".
function hostMajor(ctx) {
  const m = /^(\d+)/.exec(String((ctx && ctx.osVersion) || ''));
  return m ? Number(m[1]) : null;
}

// Returns the effective { url, version, sha256, arch } for this machine, or
// { unsupported } when the cask has nothing for it.
function resolveVariation(cask, ctx) {
  const arch = (ctx && ctx.arch) === 'x64' ? 'x64' : 'arm64';
  const major = hostMajor(ctx);
  const vars = cask.variations && typeof cask.variations === 'object' ? cask.variations : {};
  const base = { url: cask.url, version: cask.version, sha256: cask.sha256 };
  const merge = (key) => ({ ...base, ...vars[key] });
  const intelKeys = Object.keys(vars).filter((k) => MAJOR.has(k));
  const armKeys = Object.keys(vars).filter((k) => /^arm64_/.test(k) && MAJOR.has(k.slice(6)));
  const name = major != null ? CODENAME.get(major) : null;

  if (arch === 'arm64') {
    // An arm64_<release> key exists only for OLDER releases that need a different file.
    if (name && vars[`arm64_${name}`]) return { ...merge(`arm64_${name}`), arch: 'arm64' };
    if (major != null && armKeys.length) {
      // Older than the oldest override Homebrew lists: nothing is offered for it.
      const oldest = Math.min(...armKeys.map((k) => MAJOR.get(k.slice(6))));
      if (major < oldest && !name) return { unsupported: 'Homebrew lists no build for this version of macOS' };
    }
    return { ...base, arch: intelKeys.length ? 'arm64' : guessArch(base.url) };
  }

  // Intel.
  if (!intelKeys.length) {
    // One file for every Mac — unless its own name says it is Apple-silicon only.
    const a = guessArch(base.url);
    if (a === 'arm64') return { unsupported: 'Homebrew lists only an Apple silicon build' };
    return { ...base, arch: a };
  }
  if (name && vars[name]) return { ...merge(name), arch: 'x64' };
  const majors = intelKeys.map((k) => MAJOR.get(k));
  if (major == null || major > Math.max(...majors)) {
    // A macOS newer than Homebrew's table knows by name: the newest Intel record applies.
    const newest = intelKeys.reduce((a, b) => (MAJOR.get(b) > MAJOR.get(a) ? b : a));
    return { ...merge(newest), arch: 'x64' };
  }
  return { unsupported: 'Homebrew lists no Intel build for this version of macOS' };
}

function guessArch(url) {
  const s = String(url || '').toLowerCase();
  if (/(arm64|aarch64|apple[-_]?silicon)/.test(s)) return 'arm64';
  if (/(x86[-_]?64|x64|intel|amd64)/.test(s)) return 'x64';
  return 'universal';
}

// ---------------------------------------------------------------------------
// From a cask record to a release
// ---------------------------------------------------------------------------

const EXT = /\.(dmg|zip|pkg)$/i;
const OTHER_ARCHIVE = /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tbz|7z|xz)$/i;

// The file name a download will be saved under. The URL's last path segment when it
// carries a recognised extension; else a `file=`-style query value; else a neutral name
// with no extension, flagged for sniffing.
function fileName(url, cask) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { name: null };
  }
  const tidy = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  let last = '';
  try { last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch {}
  if (EXT.test(last) || OTHER_ARCHIVE.test(last)) return { name: tidy(last) };
  for (const v of u.searchParams.values()) {
    const base = String(v).split('/').pop();
    if (EXT.test(base) || OTHER_ARCHIVE.test(base)) return { name: tidy(base) };
  }
  return { name: tidy(`${cask.token}-${String(cask.version).split(',')[0]}`), sniff: true };
}

const artifactKinds = (cask) => new Set((cask.artifacts || []).flatMap((a) => (a && typeof a === 'object' ? Object.keys(a) : [])));

function minMacos(cask) {
  const req = cask.depends_on && cask.depends_on.macos && cask.depends_on.macos['>='];
  const n = Array.isArray(req) ? Number(req[0]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function toRelease(cask, ctx) {
  if (!cask || typeof cask !== 'object' || !TOKEN.test(String(cask.token || ''))) throw new Error('Homebrew returned an invalid cask record');
  const source = { type, token: cask.token };
  if (cask.disabled) {
    throw Object.assign(new Error(`Homebrew has disabled this cask${cask.disable_reason ? ` (${String(cask.disable_reason).replace(/_/g, ' ')})` : ''}`), { unavailable: true });
  }
  const eff = resolveVariation(cask, ctx);
  const version = String(eff.version || cask.version || '');
  if (!version || version === 'latest') {
    throw Object.assign(new Error('Homebrew does not track a version for this app, so updates cannot be detected'), { unavailable: true });
  }
  const kinds = artifactKinds(cask);
  const listingUrl = pageUrl(source);
  const notes = [];
  if (cask.deprecated) notes.push(`deprecated in Homebrew${cask.deprecation_reason ? ` (${String(cask.deprecation_reason).replace(/_/g, ' ')})` : ''}`);
  if (cask.auto_updates) notes.push('this app also updates itself');
  const release = {
    // "4.99.0,245822": the part after the comma is a build id used only to form the URL.
    tag_name: version.split(',')[0],
    html_url: listingUrl,
    assets: [],
    provenance: {
      listedBy: label,
      listingUrl,
      publisher: publisherOf(cask),
      ...(notes.length ? { note: notes.join('; ') } : {}),
    },
  };

  if (eff.unsupported) {
    release.assets.push({ name: cask.token, browser_download_url: String(cask.url || ''), platform: 'darwin', unsupported: eff.unsupported });
    return release;
  }

  const { name, sniff } = fileName(eff.url, cask);
  const hasApp = kinds.has('app');
  const hasPkg = kinds.has('pkg');
  const asset = {
    name: name || cask.token,
    browser_download_url: String(eff.url || ''),
    platform: 'darwin',
    arch: eff.arch,
    // A .app is placed, a .pkg is installed — the same split git-updater already uses.
    type: hasApp ? 'portable' : 'installer',
    kind: hasPkg && !hasApp ? 'pkg' : (EXT.exec(name || '') || [])[1] ? EXT.exec(name)[1].toLowerCase() : undefined,
  };
  if (sniff) asset.sniff = true;
  if (typeof eff.sha256 === 'string' && SHA256.test(eff.sha256)) {
    asset.digest = `sha256:${eff.sha256.toLowerCase()}`;
    asset.redirects = 'https-pinned'; // vendor mirrors redirect; the pinned hash makes that safe
  } else if (eff.sha256 !== 'no_check' && eff.sha256 != null) {
    throw new Error(`Homebrew published an invalid SHA-256 for ${cask.token}`);
  }
  const need = minMacos(cask);
  const major = hostMajor(ctx);
  if (need) asset.requires = [`macOS ${need} or later`];

  let u = null;
  try { u = new URL(asset.browser_download_url); } catch {}
  const specs = cask.url_specs && typeof cask.url_specs === 'object' ? cask.url_specs : {};
  if (!u || u.protocol !== 'https:' || u.username || u.password) asset.unsupported = 'Homebrew did not list a usable HTTPS download';
  else if (!hasApp && !hasPkg) asset.unsupported = kinds.has('font') ? 'fonts are not apps git-updater installs' : 'this cask is not a single app or installer package';
  else if (kinds.has('installer')) asset.unsupported = 'this cask needs its own setup program run by hand';
  else if (cask.container && cask.container.nested) asset.unsupported = 'the app is nested inside another archive';
  else if (specs.cookies || specs.referer || specs.data || specs.using) asset.unsupported = 'the download needs special request headers';
  else if (OTHER_ARCHIVE.test(asset.name)) asset.unsupported = 'this archive format is not supported on macOS';
  else if (need && major != null && major < need) asset.unsupported = `needs macOS ${need} or later`;
  release.assets.push(asset);
  return release;
}

// "Mozilla Firefox" has no publisher field; the homepage's host is the honest answer.
function publisherOf(cask) {
  try {
    return new URL(cask.homepage).host.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

async function getLatestRelease(source, ctx) {
  const t = token(source);
  let cask;
  try {
    ({ json: cask } = await ctx.net.getJson(`${API}/${encodeURIComponent(t)}.json`, { maxBytes: CASK_MAX_BYTES }));
  } catch (e) {
    if (e.status === 404) throw Object.assign(new Error(`Homebrew has no cask named ${t}`), { unavailable: true });
    throw e;
  }
  if (!cask || String(cask.token).toLowerCase() !== t.toLowerCase()) throw new Error('Homebrew returned a different cask than the one asked for');
  return toRelease(cask, ctx);
}

// ---------------------------------------------------------------------------
// Name search
// ---------------------------------------------------------------------------

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Keep only what search needs: the full index is ~20 MB, this is a few hundred KB.
function slim(casks) {
  const out = [];
  for (const c of casks) {
    if (!c || !TOKEN.test(String(c.token || '')) || c.disabled) continue;
    const kinds = artifactKinds(c);
    if (!kinds.has('app') && !kinds.has('pkg')) continue; // fonts, CLIs, suites: not installable here
    if (c.version === 'latest') continue; // cannot be updated, so never offered
    out.push({ t: c.token, n: Array.isArray(c.name) ? c.name.filter((x) => typeof x === 'string').slice(0, 4) : [], v: String(c.version).split(',')[0], d: c.deprecated ? 1 : 0 });
  }
  return out;
}

const memo = new Map(); // cacheDir|'' -> { at, list }
async function loadIndex(ctx) {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const now = ctx.now ? ctx.now() : Date.now();
  const key = ctx.cacheDir || '';
  const held = memo.get(key);
  if (held && now - held.at >= 0 && now - held.at < INDEX_MAX_AGE) return held;
  const file = ctx.cacheDir ? path.join(ctx.cacheDir, 'brew-casks.json') : null;
  let cached = null;
  if (file) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (parsed && Array.isArray(parsed.list) && typeof parsed.at === 'number') cached = parsed;
    } catch {}
  }
  if (cached && now - cached.at >= 0 && now - cached.at < INDEX_MAX_AGE) {
    memo.set(key, cached);
    return cached;
  }
  try {
    const { json } = await ctx.net.getJson(`${API}.json`, { maxBytes: INDEX_MAX_BYTES });
    if (!Array.isArray(json)) throw new Error('Homebrew did not return a cask list');
    const fresh = { at: now, list: slim(json) };
    if (file) {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(fresh));
        await fsp.rename(tmp, file);
      } catch {}
    }
    memo.set(key, fresh);
    return fresh;
  } catch (e) {
    if (cached) return { ...cached, note: 'Using the cached Homebrew list because the refresh failed' };
    throw e;
  }
}

async function search(name, ctx) {
  const q = squash(name);
  if (!q || q.length > 128) return [];
  const raw = String(name).trim().toLowerCase();
  const { list, note } = await loadIndex(ctx);
  const hits = [];
  for (const c of list) {
    const tok = squash(c.t);
    const names = c.n.map(squash);
    let rank;
    if (c.t === raw || tok === q) rank = 0;
    else if (names.includes(q)) rank = 1;
    else if (tok.startsWith(q) || names.some((n) => n.startsWith(q))) rank = 2;
    else if (q.length >= 3 && (tok.includes(q) || names.some((n) => n.includes(q)))) rank = 3;
    else continue;
    hits.push({ c, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.c.t.length - b.c.t.length || a.c.t.localeCompare(b.c.t));
  // Exact means: this query IS the cask's own token, or it equals the name of exactly one
  // cask. "firefox" is the token of one cask even though firefox@esr also matches.
  const byName = hits.filter((h) => h.rank === 1).length;
  return hits.slice(0, 25).map(({ c, rank }) => {
    const source = { type, token: c.t };
    const channel = /@(.+)$/.exec(c.t);
    return {
      source,
      name: c.n[0] || c.t,
      version: c.v,
      listingUrl: pageUrl(source),
      exact: rank === 0 || (rank === 1 && byName === 1),
      ...(channel ? { channel: channel[1] } : {}),
      ...(c.d ? { note: 'deprecated in Homebrew' } : note ? { note } : {}),
    };
  });
}

module.exports = {
  type, label, platforms, checksum,
  canonicalRef, pageUrl, parseUrl, search, getLatestRelease,
  // exported for tests
  toRelease, resolveVariation, slim, fileName,
};
