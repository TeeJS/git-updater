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
const detect = require('./detect');

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
  const emit = (phase, pct) => opts.onProgress && opts.onProgress(key, phase, pct);
  emit('checking');
  const rel = await github.getLatestRelease(repo.owner, repo.repo, { prerelease: repo.prerelease });
  const latest = rel.tag_name;
  const prev = st[key] || {};

  // Compare against the ACTUAL installed version, not just our update history:
  // installer -> uninstall-registry DisplayVersion; portable -> our install manifest.
  let installed = null;
  if (repo.type === 'installer') {
    try {
      installed = detect.registryVersion(repo.detect || repo.repo);
    } catch {}
  } else {
    installed = prev.version || null;
  }
  const baseline = installed || prev.tag || '';
  const tracked = installed || prev.tag; // do we believe it's installed at all?

  const cmp = core.cmpVersion(latest, baseline);
  let isNew = cmp > 0 || !tracked; // newer than installed, or not installed yet
  // Only NON-numeric tags (e.g. "release-2026-08", which collapse to version 0) fall back
  // to tag identity — otherwise 1.26.0 vs 1.26.0.0 would look like an update.
  if (!isNew && !/^\d/.test(core.normTag(latest)) && prev.tag && core.normTag(latest) !== core.normTag(prev.tag)) {
    isNew = true;
  }
  // Portable recorded as installed but its folder is gone/empty -> reinstall.
  if (!isNew && !opts.force && tracked && repo.type === 'portable' && repo.install && !dirHasFiles(repo.install.dir)) {
    isNew = true;
  }

  const fromV = installed ? core.normTag(installed) : prev.tag && core.normTag(prev.tag);
  if (!isNew && !opts.force) return { repo: id, id: key, status: 'current', from: fromV, to: core.normTag(latest) };

  const base = { repo: id, id: key, from: fromV, to: core.normTag(latest) };

  if (opts.mode === 'check') return { ...base, status: 'updated' };

  // Manual `asset` pattern overrides; otherwise auto-pick the Windows asset from the type.
  const asset = repo.asset
    ? core.matchAsset(rel.assets, repo.asset)
    : core.pickWindowsAsset(rel.assets, repo.type);

  if (opts.dryRun) {
    const verb = /\.(zip|7z)$/i.test(asset.name) ? 'extract' : 'place';
    const plan =
      repo.type === 'installer'
        ? `install ${asset.name} silently`
        : `${verb} ${asset.name} -> ${repo.install.dir}`;
    return { ...base, status: 'updated', note: plan };
  }

  // Proactive check: a running app blocks both installers (in-use files) and portable
  // swaps (locked files). Tell the user up front instead of failing mid-download.
  if (detect.isRunning(repo.process || repo.repo)) {
    return { ...base, status: 'failed', reason: `${repo.repo} is running — close it, then Retry` };
  }

  // Stage under %LOCALAPPDATA%, NOT %TEMP% — EDR/ASR rules flag executables run from Temp.
  const stageBase = path.join(process.env.LOCALAPPDATA || os.homedir(), 'git-updater', 'staging');
  fs.mkdirSync(stageBase, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(stageBase, 'dl-'));
  try {
    const file = path.join(tmp, asset.name);
    emit('downloading', 0);
    await github.downloadAsset(asset.browser_download_url, file, (pct) => emit('downloading', pct));
    emit('verifying');
    const v = github.verifyDigest(file, asset.digest);

    emit('installing');
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
