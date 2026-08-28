'use strict';

// Orchestrate the pipeline over the repo list. Calls the IO modules directly.
// Elevation routing lives in bin/watch.js; here we assume we have the rights to apply.

const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('./core');
const github = require('./github');
const install = require('./install');
const state = require('./state');

async function run(config, opts = {}) {
  const st = state.load(opts.statePath);
  const only = opts.only ? opts.only.toLowerCase() : null;
  const results = [];
  for (const repo of config.repos) {
    const id = `${repo.owner}/${repo.repo}`;
    if (only && id.toLowerCase() !== only) continue;
    try {
      results.push(await handleRepo(repo, id, st, opts));
    } catch (e) {
      results.push({ repo: id, status: 'failed', reason: e.message });
      if (e.rateLimited) break; // no point hammering a rate-limited API
    }
  }
  return { results, summary: core.buildSummary(results) };
}

function dirHasFiles(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

async function handleRepo(repo, id, st, opts) {
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease });
  const latest = rel.tag_name;
  const prev = st[id] || {};
  const seen = prev.tag;
  let isNew = core.cmpVersion(latest, seen || '') > 0;

  // If we recorded a portable app as installed but its folder is now missing/empty
  // (user deleted it, or a prior run half-failed), reinstall instead of reporting "current".
  if (!isNew && !opts.force && seen && repo.type === 'portable' && repo.install && !dirHasFiles(repo.install.dir)) {
    isNew = true;
  }

  if (!isNew && !opts.force) return { repo: id, status: 'current', to: core.normTag(latest) };

  const base = { repo: id, from: seen && core.normTag(seen), to: core.normTag(latest) };

  if (opts.mode === 'check') return { ...base, status: 'updated' };

  // Manual `asset` pattern overrides; otherwise auto-pick the Windows asset from the type.
  const asset = repo.asset
    ? core.matchAsset(rel.assets, repo.asset)
    : core.pickWindowsAsset(rel.assets, repo.type);

  if (opts.dryRun) {
    const plan =
      repo.type === 'installer'
        ? `install ${asset.name} silently`
        : `extract ${asset.name} -> ${repo.install.dir}`;
    return { ...base, status: 'updated', note: plan };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-dl-'));
  try {
    const file = path.join(tmp, asset.name);
    await github.downloadAsset(asset.browser_download_url, file);
    const v = github.verifyDigest(file, asset.digest);

    let files; // portable manifest, for stale-file pruning
    if (repo.type === 'installer') {
      // Detect the installer's silent-install technology from its bytes (safer than
      // assuming NSIS); explicit install.kind still wins.
      const kind = (repo.install && repo.install.kind) || install.detectInstallerKind(file) || core.guessKind(asset.name);
      install.installInstaller(file, { ...repo.install, kind });
    } else {
      files = await install.installPortable(file, repo.install);
      install.pruneStale(repo.install.dir, prev.files || [], files);
    }

    st[id] = {
      tag: latest,
      version: core.normTag(latest),
      assetName: asset.name,
      installedAt: new Date().toISOString(),
      ...(files ? { files } : {}),
    };
    state.save(st, opts.statePath);
    return { ...base, status: 'updated', note: v && v.note };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run };
