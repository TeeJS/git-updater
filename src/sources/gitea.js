'use strict';

// Gitea / Forgejo (Codeberg and self-hosted) as a source provider. Their releases API is
// modelled on GitHub's, so a release maps across almost field for field:
//
//   GET https://<host>/api/v1/repos/<owner>/<repo>/releases?limit=N
//   -> [{ tag_name, draft, prerelease, html_url, assets: [{ name, size, browser_download_url }] }]
//
// There is no per-asset digest in the API. Projects that publish checksums do it as
// ordinary release assets (SHA256SUMS, <file>.sha256), which the registry picks up the
// same way it does for a GitHub release.

const type = 'gitea';
const label = 'Gitea';
const checksum = 'optional';
const fields = ['host', 'owner', 'repo']; // the only identity a saved source carries

const core = require('../core');
const newest = (rels) => rels.reduce((best, r) => (core.cmpVersion(r.tag_name, best.tag_name) > 0 ? r : best), rels[0]);

// Hosts recognised without a network probe. Anything else that turns out to speak this
// API is still reachable: the registry probes an unrecognised URL (see probe below).
const KNOWN_HOSTS = new Set(['codeberg.org', 'gitea.com']);
const HOST_HINT = /^(gitea|forgejo|codeberg)\./i;

const SEG = /^[A-Za-z0-9._-]{1,100}$/;

function split(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/i, '');
  if (!SEG.test(owner) || !SEG.test(repo)) return null;
  return { host: u.host.toLowerCase(), owner, repo };
}

function parseUrl(input) {
  const p = split(input);
  if (!p) return null;
  if (!KNOWN_HOSTS.has(p.host) && !HOST_HINT.test(p.host)) return null;
  return { type, ...p };
}

const hostLabel = (host) => (host === 'codeberg.org' ? 'Codeberg' : label);
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;
function canonicalRef(s) {
  if (!s || !HOST.test(String(s.host || '')) || !SEG.test(String(s.owner || '')) || !SEG.test(String(s.repo || ''))) throw new Error('a Gitea source needs a host, an owner and a repository name');
  return `${s.host}/${s.owner}/${s.repo}`.toLowerCase();
}
const pageUrl = (s) => `https://${s.host}/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/releases`;
const apiUrl = (s, limit) =>
  `https://${s.host}/api/v1/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/releases?limit=${limit}`;

function shape(source, rel) {
  return {
    tag_name: rel.tag_name,
    prerelease: !!rel.prerelease,
    html_url: rel.html_url || pageUrl(source),
    assets: (rel.assets || [])
      .filter((a) => a && a.name && /^https:\/\//i.test(String(a.browser_download_url || '')))
      .map((a) => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url })),
    provenance: { listedBy: hostLabel(source.host), listingUrl: rel.html_url || pageUrl(source), publisher: source.owner },
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
  const usable = list.filter((r) => r && !r.draft && (opts.prerelease || !r.prerelease) &&
    (!opts.tagPrefix || String(r.tag_name || '').startsWith(opts.tagPrefix)));
  if (!usable.length) throw Object.assign(new Error('no releases found for this project'), { unavailable: true });
  // The API lists by publication date, and a maintenance release of an OLD series is
  // published after newer ones (Forgejo: v17.0.2, v15.0.12, v17.0.1). Latest means the
  // highest version, not the most recent upload.
  return shape(source, newest(usable));
}

// Does this URL, on a host we do not recognise, belong to a Gitea/Forgejo instance?
// One small request; a host that does not speak the API answers 404 or HTML.
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

module.exports = { type, label, checksum, fields, parseUrl, probe, canonicalRef, pageUrl, getLatestRelease, hostLabel };
