'use strict';

// IO edge: GitHub REST + asset download + digest verify. Uses Node 18+ global fetch.

const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://api.github.com';
const UA = 'release-watcher';
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB download cap

function apiHeaders() {
  const h = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghJson(url) {
  const res = await fetch(url, { headers: apiHeaders() });
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
    const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
    const e = new Error(`GitHub rate limit hit (resets ~${when}). Set GITHUB_TOKEN to raise the limit.`);
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

// True if the repo itself is gone (deleted/renamed/private) rather than just release-less.
async function repoMissing(owner, repo) {
  try {
    await ghJson(`${API}/repos/${owner}/${repo}`);
    return false;
  } catch (e) {
    return e.status === 404;
  }
}

// /releases/latest excludes prereleases + drafts; opts.prerelease uses /releases[0] (first non-draft).
// On 404, distinguish a missing repo (deleted/renamed) from a repo with no releases.
async function getLatestRelease(owner, repo, opts = {}) {
  try {
    if (opts.prerelease) {
      const list = await ghJson(`${API}/repos/${owner}/${repo}/releases?per_page=10`);
      const rel = (list || []).find((r) => !r.draft);
      if (!rel) throw Object.assign(new Error('x'), { status: 404 });
      return rel;
    }
    return await ghJson(`${API}/repos/${owner}/${repo}/releases/latest`);
  } catch (e) {
    if (e.status === 404) {
      throw new Error((await repoMissing(owner, repo)) ? 'repository not found (deleted, renamed, or private)' : 'no releases found for this repository');
    }
    throw e;
  }
}

async function listAssets(owner, repo, opts = {}) {
  const rel = await getLatestRelease(owner, repo, opts);
  return { tag: rel.tag_name, assets: (rel.assets || []).map((a) => a.name) };
}

// fetch follows redirects by default; enforce the size cap while streaming.
// onProgress(pct 0-100) is called as bytes arrive (throttled) when a size is known.
async function downloadAsset(url, destPath, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > MAX_BYTES) throw new Error(`asset too large: ${declared} bytes (cap ${MAX_BYTES})`);
  let seen = 0;
  let lastPct = -1;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        seen += chunk.length;
        if (seen > MAX_BYTES) throw new Error(`asset exceeded size cap ${MAX_BYTES} bytes`);
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
}

// digest: GitHub asset.digest like "sha256:abc..." . Missing/unsupported -> skip with a note.
function verifyDigest(filePath, digest) {
  if (!digest) return { skipped: true, note: 'no digest from GitHub; checksum skipped' };
  const [algo, expected] = String(digest).split(':');
  if (algo !== 'sha256' || !expected) return { skipped: true, note: `unsupported digest "${digest}"; skipped` };
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath)); // ponytail: whole-file read; stream if assets get very large
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
  }
  return { verified: true };
}

module.exports = { getLatestRelease, listAssets, downloadAsset, verifyDigest };
