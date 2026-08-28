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

async function handleRepo(repo, id, st, opts) {
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease });
  const latest = rel.tag_name;
  const seen = st[id] && st[id].tag;
  const isNew = core.cmpVersion(latest, seen || '') > 0;

  if (!isNew && !opts.force) return { repo: id, status: 'current', to: core.normTag(latest) };

  const base = { repo: id, from: seen && core.normTag(seen), to: core.normTag(latest) };

  if (opts.mode === 'check') return { ...base, status: 'updated' };

  // Manual `asset` pattern overrides; otherwise auto-pick the Windows asset from the type.
  const asset = repo.asset
    ? core.matchAsset(rel.assets, repo.asset)
    : core.pickWindowsAsset(rel.assets, repo.type);

  // Installer needs a kind for its silent switches; auto-guess from the file unless set.
  const installCfg =
    repo.type === 'installer'
      ? { ...repo.install, kind: (repo.install && repo.install.kind) || core.guessKind(asset.name) }
      : repo.install;

  if (opts.dryRun) {
    const plan =
      repo.type === 'installer'
        ? install.installInstaller(asset.name, installCfg, { dryRun: true }).command
        : `extract ${asset.name} -> swap into ${installCfg.dir}`;
    return { ...base, status: 'updated', note: plan };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-dl-'));
  try {
    const file = path.join(tmp, asset.name);
    await github.downloadAsset(asset.browser_download_url, file);
    const v = github.verifyDigest(file, asset.digest);

    if (repo.type === 'installer') install.installInstaller(file, installCfg);
    else await install.installPortable(file, installCfg);

    st[id] = {
      tag: latest,
      version: core.normTag(latest),
      assetName: asset.name,
      installedAt: new Date().toISOString(),
    };
    state.save(st, opts.statePath);
    return { ...base, status: 'updated', note: v && v.note };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run };
