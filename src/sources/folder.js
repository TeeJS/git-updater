'use strict';

// A vendor's download folder as a source provider.
//
// Plenty of projects publish no release feed at all — just a directory on a web server:
// download.blender.org/release/, download.videolan.org/pub/videolan/vlc/,
// download.documentfoundation.org/libreoffice/stable/. This provider reads such a
// listing the way a person would: find the newest version, open it, take the files.
// There is no per-app recipe; the user pastes the folder's address.
//
// What real listings look like (all four shapes are in test/fixtures/sources/folder/):
//
//   nginx autoindex     <a href="Blender5.3/">            relative names (Blender, VLC, GIMP)
//   Apache autoindex    <a href="?C=N;O=D">, <a href="/libreoffice/">, <a href="26.8.3/">
//                       sort links and an absolute parent link mixed in (LibreOffice, Wireshark)
//   mirror front-ends   the same, plus dozens of site-navigation links (KDE)
//   object stores       <a href="/pub/firefox/releases/160.0.1/">   absolute paths (Mozilla)
//
// So a link counts only if it resolves to a DIRECT CHILD of the folder being read, on the
// same origin. Everything else on the page — navigation, sort links, other sites — is
// ignored, which is also the security boundary: a listing can never point this provider
// at a file outside the folder the user named.
//
// Layouts differ too, and none is declared, so the walk is by structure:
//
//   files right here                 Wireshark:   win64/Wireshark-4.6.3-x64.exe
//   one folder per version           Blender:     release/Blender5.3/blender-5.3.0-*.zip
//   version, then platform folders   VLC:         vlc/3.0.24/win64/vlc-3.0.24-win64.exe
//   version, platform, architecture  LibreOffice: stable/26.8.3/win/x86_64/*.msi
//
// The registry does the rest: it picks the file for the machine from the names (with the
// strict-architecture rule) and looks for a published checksum among the assets returned.

const core = require('../core');

const type = 'folder';
const label = 'Vendor site';
const checksum = 'optional';
const fields = ['url'];

const LISTING_MAX = 2 * 1024 * 1024;
const MAX_REQUESTS = 30; // per release lookup, across the whole walk
const MAX_SERIES = 4; // newest version folders to try before giving up
const MAX_SUBDIRS = 12; // platform/architecture folders followed per level
const MAX_DEPTH = 2; // levels below a version folder

const INSTALLABLE = /\.(zip|7z|exe|msi|dmg|pkg|tar\.gz|tgz|tar\.xz|tar\.bz2|appimage|deb|rpm)$/i;
const SUMS = /(sha(256|512)[-_.]?sums?|checksums?)(\.txt)?$|\.(sha256|sha512)$/i;
// Not something to install, whatever its extension.
const NOISE = /(debugsym|debug-?symbols?|symbols|[-_.]pdb[-_.]|[-_.]src[-_.]|[-_.]source[-_.]|[-_.]sdk[-_.]|[-_.]dbg[-_.])/i;
const PRE = /(^|[^a-z])(rc|beta|alpha|pre|preview|nightly|snapshot|test|dev|unstable)([^a-z]|$)/i;
const VERSION = /(\d+(?:\.\d+)+)/;
const GENERIC = new Set(['release', 'releases', 'download', 'downloads', 'pub', 'stable', 'files', 'dist', 'client', 'win32', 'win64', 'windows', 'mac', 'macos', 'macosx', 'osx', 'linux', 'latest', 'current', 'software', 'public', 'archive']);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// https only, no credentials, no query or fragment, and always a directory (trailing "/").
function normalize(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (!p.endsWith('/')) p += '/';
  if (/\/\.\.?\//.test(p)) return null;
  return `https://${u.host.toLowerCase()}${p}`;
}

function urlOf(source) {
  const n = normalize(source && source.url);
  if (!n) throw new Error('a vendor-site source needs an https:// folder address');
  return n;
}
const canonicalRef = (source) => urlOf(source).replace(/^https:\/\//, '');
const pageUrl = (source) => urlOf(source);

// A folder address looks like any other web address, so it is never claimed by shape:
// the registry asks probe() to go and look.
const parseUrl = () => null;

// A name for the app, from the address: the last path segment that actually names
// something ("…/videolan/vlc/" -> "vlc"), else the site ("download.blender.org" -> "blender").
function displayName(source) {
  const u = new URL(urlOf(source));
  const segs = u.pathname.split('/').filter(Boolean).reverse();
  let pick = segs.find((s) => !GENERIC.has(s.toLowerCase()) && !VERSION.test(s) && /[a-z]/i.test(s));
  if (!pick) {
    const labels = u.hostname.split('.').filter((l) => !['www', 'download', 'downloads', 'dl', 'ftp', 'files', 'archive', 'get'].includes(l));
    pick = labels.length > 1 ? labels[labels.length - 2] : labels[0] || u.hostname;
  }
  let name = pick;
  try { name = decodeURIComponent(pick); } catch {}
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------
// Reading a listing
// ---------------------------------------------------------------------------

// -> { dirs: [{ name, url }], files: [{ name, url }] } — direct children only.
function parseListing(html, pageUrlString) {
  const base = new URL(pageUrlString);
  const dirs = new Map();
  const files = new Map();
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const raw = (m[1] != null ? m[1] : m[2]).replace(/&amp;/g, '&').trim();
    if (!raw || raw.startsWith('?') || raw.startsWith('#')) continue;
    let u;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.origin !== base.origin || u.search || u.hash || u.username || u.password) continue;
    if (!u.pathname.startsWith(base.pathname) || u.pathname === base.pathname) continue;
    const rest = u.pathname.slice(base.pathname.length);
    const isDir = rest.endsWith('/');
    const seg = isDir ? rest.slice(0, -1) : rest;
    if (!seg || seg.includes('/')) continue; // a direct child, nothing deeper
    let name;
    try {
      name = decodeURIComponent(seg);
    } catch {
      continue;
    }
    if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) continue;
    const url = `${base.origin}${base.pathname}${seg}${isDir ? '/' : ''}`;
    (isDir ? dirs : files).set(name, { name, url });
  }
  return { dirs: [...dirs.values()], files: [...files.values()] };
}

const versionOf = (name) => {
  const m = VERSION.exec(name);
  return m ? m[1] : null;
};
// A prerelease by its own name: "5.0.0rc2", "161.0b5", "gimp-3.3.2-beta".
function isPrerelease(name) {
  if (PRE.test(name)) return true;
  const m = VERSION.exec(name);
  if (!m) return false;
  return /^(rc|b|a|beta|alpha)\d*/i.test(name.slice(m.index + m[0].length));
}
const isSums = (name) => SUMS.test(name);
const isInstallable = (name) => INSTALLABLE.test(name) && !NOISE.test(name) && !isSums(name);

// Version folders come in families ("Blender5.3/", "yafray.0.0.7/", "plugin/"). The family
// with the most members is the product's release line; the rest are leftovers.
function series(dirs, opts = {}) {
  const groups = new Map();
  for (const d of dirs) {
    const v = versionOf(d.name);
    if (!v) continue;
    if (!opts.prerelease && isPrerelease(d.name)) continue;
    // "161.0b5" and "160.0.1" are the same family: the prerelease suffix is not shape.
    const shape = d.name.replace(new RegExp(`${v.replace(/\./g, '\\.')}((rc|beta|alpha|b|a)\\d*)?`, 'i'), '#').toLowerCase();
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push({ ...d, version: v });
  }
  let best = null;
  for (const g of groups.values()) {
    g.sort((a, b) => core.cmpVersion(b.version, a.version));
    if (!best || g.length > best.length || (g.length === best.length && core.cmpVersion(g[0].version, best[0].version) > 0)) best = g;
  }
  return best || [];
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function budgeted(ctx) {
  let left = MAX_REQUESTS;
  return async (url) => {
    if (left-- <= 0) throw new Error('this folder has too many levels to read');
    const { text } = await ctx.net.getText(url, { maxBytes: LISTING_MAX });
    return parseListing(text, url);
  };
}

// Every file at or below `url`, to MAX_DEPTH levels of sub-folders. A sub-folder that
// cannot be read is skipped (a version folder often has odd extras); the folder itself
// failing is the caller's problem.
async function collect(list, url, depth, first) {
  const here = first || (await list(url));
  const out = [...here.files];
  if (depth >= MAX_DEPTH) return out;
  const subs = here.dirs.filter((d) => !NOISE.test(`-${d.name}-`) && !/^(src|source|sources|debug|doc|docs)$/i.test(d.name)).slice(0, MAX_SUBDIRS);
  // Sibling folders are independent, so they are read together: LibreOffice's layout is
  // a dozen small listings, and reading them one after another took 24 seconds.
  const found = await Promise.all(subs.map((d) => collect(list, d.url, depth + 1).catch((e) => {
    if (/too many levels/.test(e.message)) throw e;
    return [];
  })));
  for (const f of found) out.push(...f);
  return out;
}

// Mirror networks (MirrorBrain, MirrorBits — KDE, The Document Foundation and others)
// redirect the big files to mirrors but answer "<file>.sha256" from the ORIGIN, without
// listing it. The registry asks for these after the listed checksum files turn up nothing.
function checksumUrls(asset) {
  return [`${asset.browser_download_url}.sha256`];
}

// From a pile of files, the newest stable version that has something installable, and
// every file belonging to it (its checksum files included).
function releaseFrom(files, opts = {}) {
  const usable = files.filter((f) => isInstallable(f.name) && versionOf(f.name) && (opts.prerelease || !isPrerelease(f.name)));
  if (!usable.length) return null;
  const version = usable.map((f) => versionOf(f.name)).reduce((a, b) => (core.cmpVersion(b, a) > 0 ? b : a));
  const mine = (f) => versionOf(f.name) === version;
  // The same file name under two different sub-folders (win/app-1.2.zip and
  // mac/app-1.2.zip) cannot be told apart once only the name is left — and the name is
  // all the registry selects on. Rather than let whichever was read first win, such a
  // name is not offered at all.
  const urlsByName = new Map();
  for (const f of files) {
    if (!urlsByName.has(f.name)) urlsByName.set(f.name, new Set());
    urlsByName.get(f.name).add(f.url);
  }
  const ambiguous = (f) => urlsByName.get(f.name).size > 1;
  const assets = [];
  const seen = new Set();
  for (const f of files) {
    const installable = isInstallable(f.name) && mine(f) && (opts.prerelease || !isPrerelease(f.name));
    // Checksum files for this version (or unversioned, like SHA256SUMS) — but not the
    // per-file hash of something that was itself left out (debug symbols and the like).
    // Every one is kept, even several of the same name: each belongs to its own folder,
    // and the registry only consults the one beside the file it is checking.
    const sums = isSums(f.name) && !NOISE.test(f.name) && (mine(f) || !versionOf(f.name));
    if (!(installable && !ambiguous(f)) && !sums) continue;
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    assets.push({ name: f.name, browser_download_url: f.url });
  }
  if (!assets.some((x) => isInstallable(x.name))) return null;
  return { version, assets };
}

async function getLatestRelease(source, ctx, opts = {}) {
  const base = urlOf(source);
  const list = budgeted(ctx);
  const provenance = { listedBy: label, listingUrl: base, publisher: new URL(base).host };
  const top = await list(base);

  // Files right here — unless the folder ALSO has version folders that go newer, in which
  // case a file at the top is a leftover (Blender's release/ still holds
  // blender2.04-ipaq.zip beside Blender5.3/).
  const flat = releaseFrom(top.files, opts);
  const line = series(top.dirs, opts);
  if (flat && (!line.length || core.cmpVersion(flat.version, line[0].version) >= 0)) {
    return { tag_name: flat.version, html_url: base, assets: flat.assets, provenance };
  }

  // One folder per version: newest first, skipping folders with nothing installable.
  if (!line.length) throw Object.assign(new Error('no downloadable files or version folders found at this address'), { unavailable: true });
  for (const dir of line.slice(0, MAX_SERIES)) {
    // A version folder that was listed but cannot be read is an error, not a reason to
    // quietly offer an older version instead.
    const first = await list(dir.url);
    const found = releaseFrom(await collect(list, dir.url, 0, first), opts);
    if (found) {
      return { tag_name: found.version, html_url: dir.url, assets: found.assets, provenance: { ...provenance, listingUrl: dir.url } };
    }
  }
  throw Object.assign(new Error('the newest version folders at this address hold no downloadable files'), { unavailable: true });
}

// Is this address a download folder? One request. It is, if the page links to version
// folders or to installable files of its own.
async function probe(input, ctx) {
  const url = normalize(input);
  if (!url) return null;
  let top;
  try {
    const { text } = await ctx.net.getText(url, { maxBytes: LISTING_MAX });
    top = parseListing(text, url);
  } catch {
    return null;
  }
  if (releaseFrom(top.files) || series(top.dirs).length) return { type, url };
  return null;
}

module.exports = {
  type, label, checksum, fields,
  canonicalRef, pageUrl, parseUrl, probe, displayName, getLatestRelease, checksumUrls,
  // exported for tests
  normalize, parseListing, series, releaseFrom, isPrerelease,
};
