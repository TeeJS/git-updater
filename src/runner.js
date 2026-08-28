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

// Display id ("owner/repo") vs storage/identity key (adds the type, so the same repo
// tracked as both portable AND installed keeps separate state instead of colliding).
const displayId = (repo) => `${repo.owner}/${repo.repo}`;
const appKey = (repo) => `${repo.owner}/${repo.repo}#${repo.type}`;

async function run(config, opts = {}) {
  const st = state.load(opts.statePath);
  const only = opts.only ? opts.only.toLowerCase() : null;
  const results = [];
  for (const repo of config.repos) {
    const id = displayId(repo);
    if (only && id.toLowerCase() !== only && appKey(repo).toLowerCase() !== only) continue;
    try {
      results.push(await handleRepo(repo, id, st, opts));
    } catch (e) {
      results.push({ repo: id, id: appKey(repo), status: 'failed', reason: e.message });
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
  const key = appKey(repo);
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease });
  const latest = rel.tag_name;
  const prev = st[key] || {};
  const seen = prev.tag;

  const cmp = core.cmpVersion(latest, seen || '');
  let isNew = cmp > 0;
  // Non-semantic tags (e.g. "release-2026-08") both parse to version 0, so cmp is 0 —
  // fall back to tag identity: a changed tag (including first install vs empty) is an update.
  if (!isNew && cmp === 0 && core.normTag(latest) !== core.normTag(seen || '')) isNew = true;

  // If we recorded a portable app as installed but its folder is now missing/empty
  // (user deleted it, or a prior run half-failed), reinstall instead of reporting "current".
  if (!isNew && !opts.force && seen && repo.type === 'portable' && repo.install && !dirHasFiles(repo.install.dir)) {
    isNew = true;
  }

  if (!isNew && !opts.force) return { repo: id, id: key, status: 'current', to: core.normTag(latest) };

  const base = { repo: id, id: key, from: seen && core.normTag(seen), to: core.normTag(latest) };

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
      // Detect the installer's silent-install technology from its bytes. If it can't be
      // identified, FAIL rather than blindly running an unknown .exe with NSIS's /S switch.
      const kind = (repo.install && repo.install.kind) || install.detectInstallerKind(file);
      if (!kind) {
        throw new Error(
          `could not identify the installer type for ${asset.name} — add "install":{"kind":"nsis|inno|msi"} for ${id} in config.json`
        );
      }
      install.installInstaller(file, { ...repo.install, kind });
    } else {
      const installed = await install.installPortable(file, repo.install);
      const stale = install.pruneStale(repo.install.dir, prev.files || [], installed);
      files = [...installed, ...stale]; // keep un-pruned stale files so they're retried next time
    }

    st[key] = {
      repo: id,
      type: repo.type,
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
