'use strict';

// GitLab (gitlab.com and self-hosted) as a source provider.
//
//   GET https://<host>/api/v4/projects/<url-encoded full path>/releases?per_page=N
//   -> [{ tag_name, upcoming_release, _links: { self }, assets: { links: [{ name, url, direct_asset_url }], sources: [...] } }]
//
// Two things differ from GitHub and shape this file:
//
//   - A project path can be nested (group/subgroup/project), so the identity is the whole
//     path, not an owner/repo pair.
//   - `assets.sources` are auto-generated source archives. They are never what a user
//     wants installed and they are dropped here. Only `assets.links` — files the project
//     deliberately attached — are offered. A release with no links has nothing to install.
//
// The API gives no size and no digest for a link. A project that publishes checksums
// attaches them as links too, and the registry finds them by name.

const type = 'gitlab';
const label = 'GitLab';
const checksum = 'optional';
const fields = ['host', 'project']; // the only identity a saved source carries

const core = require('../core');
const newest = (rels) => rels.reduce((best, r) => (core.cmpVersion(r.tag_name, best.tag_name) > 0 ? r : best), rels[0]);

const KNOWN_HOSTS = new Set(['gitlab.com', 'invent.kde.org', 'salsa.debian.org', 'framagit.org']);
const HOST_HINT = /^gitlab\./i;
const SEG = /^[A-Za-z0-9._-]{1,255}$/;

function split(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  // Everything after "/-/" is a GitLab page route (releases, tags, tree...), not the path.
  const raw = u.pathname.split('/-/')[0];
  const parts = raw.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  if (!parts.every((p) => SEG.test(p))) return null;
  return { host: u.host.toLowerCase(), project: parts.join('/') };
}

function parseUrl(input) {
  const p = split(input);
  if (!p) return null;
  if (!KNOWN_HOSTS.has(p.host) && !HOST_HINT.test(p.host)) return null;
  return { type, ...p };
}

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;
function canonicalRef(s) {
  const parts = String((s && s.project) || '').split('/');
  if (!s || !HOST.test(String(s.host || '')) || parts.length < 2 || !parts.every((p) => SEG.test(p))) throw new Error('a GitLab source needs a host and a project path');
  return `${s.host}/${s.project}`.toLowerCase();
}
const pageUrl = (s) => `https://${s.host}/${s.project.split('/').map(encodeURIComponent).join('/')}/-/releases`;
const apiUrl = (s, n) => `https://${s.host}/api/v4/projects/${encodeURIComponent(s.project)}/releases?per_page=${n}`;

// A link's display name is free text ("Windows installer"); the file name lives in the
// URL. Prefer the URL's last path segment when it looks like a file, else the name.
function fileName(link) {
  for (const url of [link.url, link.direct_asset_url]) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      if (last && !/^index\.html?$/i.test(last)) return last;
    } catch {}
  }
  return String(link.name || '').trim();
}

function shape(source, rel) {
  const page = (rel._links && rel._links.self) || pageUrl(source);
  const links = (rel.assets && rel.assets.links) || [];
  return {
    tag_name: rel.tag_name,
    html_url: page,
    assets: links
      // `url` is where the file actually lives; `direct_asset_url` is a GitLab permalink
      // that only redirects to it. Fetching the real location keeps the origin the user
      // is shown the same as the origin the bytes come from.
      .map((l) => ({ name: fileName(l), browser_download_url: l.url || l.direct_asset_url }))
      .filter((a) => a.name && /^https:\/\//i.test(String(a.browser_download_url || ''))),
    provenance: { listedBy: label, listingUrl: page, publisher: source.project.split('/')[0] },
  };
}

async function getLatestRelease(source, ctx, opts = {}) {
  let list;
  try {
    ({ json: list } = await ctx.net.getJson(apiUrl(source, 20), { maxBytes: 4 * 1024 * 1024 }));
  } catch (e) {
    if (e.status === 404) throw Object.assign(new Error('project not found (deleted, renamed, or private)'), { unavailable: true });
    throw e;
  }
  if (!Array.isArray(list)) throw new Error(`${source.host} did not return a release list`);
  // GitLab has no prerelease flag. `upcoming_release` marks a release dated in the future.
  const usable = list.filter((r) => r && r.tag_name && !r.upcoming_release &&
    (!opts.tagPrefix || String(r.tag_name).startsWith(opts.tagPrefix)));
  if (!usable.length) throw Object.assign(new Error('no releases found for this project'), { unavailable: true });
  // Listed by release date, so a backport to an old series can sit above the real
  // latest (gitlab-runner: v19.6.0, v19.3.6). Latest means the highest version.
  return shape(source, newest(usable));
}

async function probe(input, ctx) {
  const p = split(input);
  if (!p) return null;
  const source = { type, ...p };
  try {
    const { json } = await ctx.net.getJson(apiUrl(source, 1), { maxBytes: 1024 * 1024 });
    return Array.isArray(json) ? source : null;
  } catch {
    return null;
  }
}

module.exports = { type, label, checksum, fields, parseUrl, probe, canonicalRef, pageUrl, getLatestRelease, fileName };
