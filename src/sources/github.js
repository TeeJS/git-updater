'use strict';

// GitHub as a source provider. This is a thin adapter: the real work — the REST calls,
// rate-limit handling, tag-prefix trains, prerelease selection — stays in src/github.js,
// unchanged, so every existing GitHub-tracked app behaves exactly as it did before
// sources existed. A config entry with no `source` field IS a GitHub entry.

const github = require('../github');

const type = 'github';
const label = 'GitHub';
const checksum = 'optional';
const fields = ['owner', 'repo']; // the only identity a saved source carries

// GitHub owner and repository names: letters, digits, hyphen, underscore, dot. An owner
// can never contain a dot, which is what lets non-GitHub keys reserve "source.<type>".
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function parseUrl(input) {
  const s = String(input || '').trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) m = /^([^/\s:.]+)\/([^/\s]+)$/.exec(s); // bare owner/repo
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  return { type, owner, repo };
}

function canonicalRef(source) {
  if (!source || !OWNER.test(String(source.owner || '')) || !REPO.test(String(source.repo || ''))) throw new Error('GitHub needs an owner and a repository name');
  return `${source.owner}/${source.repo}`;
}
const pageUrl = (source) =>
  `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/releases`;

// opts carries the per-entry release-selection settings (prerelease, tagPrefix), and
// `usable(release)`: does this release have a file this entry could install on this machine?
// With it, a latest release that has no such file is passed over for the newest one that does
// (tesseract-ocr/tesseract: an installer on 5.5.3, nothing on 5.5.4) and the result carries
// `skipped`, naming the release passed over. See getLatestRelease in src/github.js.
async function getLatestRelease(source, ctx, opts = {}) {
  const rel = await github.getLatestRelease(source.owner, source.repo, { prerelease: opts.prerelease, tagPrefix: opts.tagPrefix, usable: opts.usable });
  return {
    ...rel,
    html_url: rel.html_url || pageUrl(source),
    provenance: { listedBy: label, listingUrl: rel.html_url || pageUrl(source), publisher: source.owner },
  };
}

module.exports = { type, label, checksum, fields, parseUrl, canonicalRef, pageUrl, getLatestRelease };
