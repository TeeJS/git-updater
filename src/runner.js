'use strict';

// Orchestrate the pipeline over the repo list. Calls the IO modules directly.
// Elevation routing lives in bin/watch.js; here we assume we have the rights to apply.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const paths = require('./paths');
const github = require('./github');
const install = require('./install');
const state = require('./state');
const detect = require('./detect');
const sources = require('./sources');
const { log } = require('./log');

// Display id ("owner/repo") vs storage/identity key (adds the type, so the same repo
// tracked as both portable AND installed keeps separate state instead of colliding).
const isWin = process.platform === 'win32';

// A non-GitHub entry has an opaque key, so it is displayed by its name instead.
const displayId = (repo) => core.displayId(repo);
const appKey = (repo) => `${repo.owner}/${repo.repo}#${repo.type}`;

// A tracked entry can name a package type the project does not publish, and then every
// check fails — or worse, quietly installs the wrong thing. Both directions happen:
//
//   installer -> portable  "Scan this PC" adds every discovered app as an installer. On
//                          Linux that is wrong for most repos: of the catalog entries
//                          with Linux identifiers, 20 of 40 publish only a portable
//                          archive and 3 publish no binary at all.
//   portable  -> installer Projects that ship a distro package and no Linux archive.
//                          obsproject/obs-studio publishes Ubuntu .debs, macOS .dmgs and
//                          Windows .zips — the only Linux-shaped .tar.gz in the release
//                          is the SOURCE tarball, which is why this direction was found
//                          the hard way: the entry sat on "installed, up to date" over a
//                          directory of C++ that had never been built.
//
// The first check already holds the release payload, so the correction costs nothing
// here — deciding it when the user ticks the app would cost one API call each, against
// an anonymous budget of 60 an hour that this app already exhausts in practice.
//
// The correction is REPORTED, never silent, and each direction has its own consequence
// to disclose. Switching to portable installs ALONGSIDE a package-managed copy rather
// than replacing it. Switching to installer is the bigger change of the two: it writes
// system-wide instead of into the portable folder, and it needs authorization, so the
// user has to be told before an update asks for their password out of nowhere.
//
// Mutates `repo` in place and returns the disclosure, or null when nothing changed.
// `platform` defaults to the running OS; it is explicit so the whole decision table is
// testable from any host rather than only the one the suite happens to run on.
function retypeIfUnavailable(repo, rel, portableRoot, platform) {
  // A hand-pinned asset pattern means the user has already said exactly what they want.
  if (repo.asset) return null;
  if (repo.type !== 'installer' && repo.type !== 'portable') return null;
  const to = repo.type === 'installer' ? 'portable' : 'installer';
  try {
    core.pickAsset(rel.assets, repo.type, null, null, platform);
    return null; // the project does publish this type — leave the entry alone
  } catch (e) {
    // Only the specific "ships the OTHER type" case. "no <platform> <type> asset" means
    // the release has nothing usable at all, which stays an error the user should see.
    if (!/only ships (portable builds|an installer)/.test(e.message)) return null;
  }
  const from = repo.type;
  if (to === 'portable') {
    const dir =
      (repo.install && repo.install.dir) || (portableRoot && core.resolvePortableDir(portableRoot, core.folderName(repo)));
    if (!dir) return null; // no portable folder set — the existing clear error stands
    repo.type = 'portable';
    repo.install = { ...(repo.install || {}), dir };
    return {
      from,
      to,
      dir,
      note: 'switched to Portable — this app publishes no installer, so the portable copy installs alongside any existing one',
    };
  }
  // install.dir is kept rather than dropped: it is unused while the entry is an
  // installer, and it means switching back by hand does not lose the chosen folder.
  repo.type = 'installer';
  return {
    from,
    to,
    dir: (repo.install && repo.install.dir) || null,
    note: 'switched to Installer — this app publishes no portable build for this platform, so updates install system-wide and will ask for authorization',
  };
}

async function run(config, opts = {}) {
  detect.clearCache(); // fresh registry scan each run — an install may have just changed versions
  const st = state.load(opts.statePath);
  const only = opts.only ? opts.only.toLowerCase() : null;
  const results = [];
  // Normalise every entry first, so identities are final before anything is compared.
  const badEntry = new Map();
  for (const repo of config.repos) {
    try {
      sources.normalizeEntry(repo);
    } catch (e) {
      badEntry.set(repo, e);
    }
  }
  // Two apps must never share one portable folder: installing either swaps the whole
  // directory, so one would delete the other. Config order says nothing about which app
  // owns the files already there, so EVERY entry in a shared folder is blocked — computed
  // over the whole list, before any --only filter — until the user gives them separate
  // folders. Two plain GitHub entries keep their old behaviour; this applies as soon as
  // either comes from another source, whose folder is derived from a display name that
  // two different sources can share.
  const sharers = new Map();
  for (const repo of config.repos) {
    if (badEntry.has(repo) || repo.type !== 'portable' || !repo.install || !repo.install.dir) continue;
    const k = path.resolve(String(repo.install.dir)).toLowerCase();
    if (!sharers.has(k)) sharers.set(k, []);
    sharers.get(k).push(repo);
  }
  const clashOf = new Map();
  for (const group of sharers.values()) {
    if (group.length < 2 || !group.some((r) => r.source)) continue;
    for (const r of group) clashOf.set(r, group.filter((x) => x !== r).map(displayId).join(', '));
  }
  for (const repo of config.repos) {
    // A non-GitHub entry's key was derived from its source above, so a hand-edited
    // config cannot claim one identity while pointing at another. An entry naming a
    // source this build does not know fails on its own row, not the whole run.
    const bad = badEntry.get(repo) || null;
    const id = displayId(repo);
    const key = appKey(repo);
    const clash = clashOf.get(repo) || null;
    if (only) {
      // GitHub ids keep their case-folded match. A non-GitHub key encodes a URL path,
      // where case can be significant, so it is matched exactly (as is its name).
      const hit = repo.source ? key === opts.only || id === opts.only : id.toLowerCase() === only || key.toLowerCase() === only;
      if (!hit) continue;
    }
    let closed = false;
    const markClosed = () => { closed = true; };
    try {
      if (bad) throw bad;
      if (clash) throw new Error(`its portable folder (${repo.install.dir}) is also used by ${clash} — give each its own install.dir in config.json`);
      const result = await handleRepo(repo, id, st, {
        ...opts,
        portableRoot: core.portableRootFor(config, repo), // its category's folder, else portableRoot
        requireChecksum: !!config.requireChecksum,
        maxBytes: core.downloadLimitBytes(config),
        markClosed,
      });
      results.push(closed ? { ...result, closed: true } : result);
    } catch (e) {
      results.push({ repo: id, id: appKey(repo), status: 'failed', reason: e.message, stopRun: !!e.rateLimited || !!e.badToken, ...where(repo), ...(closed ? { closed: true } : {}) });
      log(`FAIL ${appKey(repo)}: ${e.message}`);
      if (e.rateLimited || e.badToken) break; // every later call would fail the same way and burn more quota
    }
  }
  return { results, summary: core.buildSummary(results) };
}

// Where an app comes from, attached to every result so the UI and the CLI can always
// show it. No network: this is read off the config entry alone.
function where(repo) {
  try {
    const d = sources.describe(repo);
    return { source: { type: d.type, label: d.label, host: d.listingHost, pageUrl: d.pageUrl } };
  } catch {
    return {};
  }
}

// The file this machine would get, chosen the same way for Check, Preview, dry-run and
// Update. Installers match the flavor ALREADY installed (msi vs exe on Windows, deb vs rpm
// on Linux) so an update upgrades in place instead of installing a duplicate side by side.
async function pickFor(repo, rel) {
  const flavor = repo.type === 'installer' ? await detect.installedFlavor(core.detectName(repo)) : null;
  return sources.selectAsset(repo, rel, { flavor, osRelease: detect.osRelease() });
}

const NO_SUM_REASON = 'no checksum is published for this file, and "Only install files that have a checksum" is on';

// Everything that decides whether THIS file may be installed on THIS machine, in one
// place, so Check, dry-run and Update cannot disagree: the selection, the listing's
// upgrade rule, and the checksum policy. Nothing is downloaded.
//   -> { asset, sum }                      go ahead
//   -> { asset, sum, blocked: reason }     the same answer for every mode
// `sum` is null only for a plain GitHub entry with the checksum setting off — that path
// keeps its original order (download, then look for a sums file).
async function preflight(repo, rel, ctx, o) {
  const asset = await pickFor(repo, rel);
  if (o.tracked && (asset.upgradeBehavior === 'uninstallPrevious' || asset.upgradeBehavior === 'deny')) {
    const who = o.label || 'the listing';
    return {
      asset,
      sum: null,
      blocked:
        asset.upgradeBehavior === 'deny'
          ? `${who} says this app cannot be upgraded in place — update it from the app itself`
          : `${who} says the old version must be uninstalled first — uninstall it, then Install`,
    };
  }
  let sum = null;
  if (!o.gh || o.requireChecksum) {
    sum = await sources.resolveChecksum(repo, rel, asset, ctx);
    if (!sum.digest && o.requireChecksum) return { asset, sum, blocked: NO_SUM_REASON };
  }
  return { asset, sum };
}

function dirHasFiles(dir) {
  try {
    return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Close a running app so its update can go ahead ("Automatically close apps and re-open").
// It is always ASKED to close first. Only with "Force close apps that do not close" on
// (opts.forceClose) is one that stays open then stopped outright, which can lose unsaved
// work in it; that is why the setting is off by default and says so next to it.
// before: 'update' or 'swap', for the log. -> { stillRunning, reason? }
async function closeForUpdate(repo, key, opts, before) {
  const name = core.processName(repo);
  let result = await detect.closeApp(name);
  let forced = false;
  if (result.stillRunning && opts.forceClose) {
    log(`FORCE-CLOSE ${key}: ${core.appName(repo)} did not close when asked; closing it by force before ${before}`);
    const again = await detect.closeApp(name, { force: true });
    result = { closed: Math.max(result.closed, again.closed), stillRunning: again.stillRunning };
    forced = true;
  }
  if (result.stillRunning) {
    log(`SKIP ${key}: auto-close could not stop ${core.appName(repo)} before ${before}${forced ? ', even by force' : ''}`);
    return { stillRunning: true, reason: `${core.appName(repo)} did not close ${forced ? 'even when forced' : 'gracefully'} — close it manually, then Retry` };
  }
  if (result.closed > 0) {
    opts.markClosed();
    log(`AUTO-CLOSE ${key}: closed ${result.closed} process(es) before ${before}${forced ? ' (forced)' : ''}`);
  }
  return { stillRunning: false };
}

async function handleRepo(repo, id, st, opts) {
  const key = appKey(repo);
  const emit = (phase, pct) => opts.onProgress && opts.onProgress(key, phase, pct);
  emit('checking');
  const gh = sources.isGithub(repo);
  const ctx = sources.makeCtx();
  const rel = await sources.getLatestRelease(repo, ctx);
  const src = where(repo);
  // Correct the type before anything reads it. Check-time only: an update run installs,
  // and changing what gets installed mid-run is worse than the clear error it replaces.
  // It has to happen ahead of the comparison below, or an entry whose installed version
  // already matches the latest tag returns "current" and is never corrected at all.
  // GitHub entries only. Any other source states what it offers, and the options list
  // showed the user the type before they added it, so nothing is switched behind them.
  const retyped = opts.mode === 'check' && gh ? retypeIfUnavailable(repo, rel, opts.portableRoot) : null;

  const latest = rel.tag_name;
  const prev = st[key] || {};

  // Compare against the ACTUAL installed version, not just our update history:
  // installer -> uninstall-registry DisplayVersion; portable -> our install manifest.
  let installed = null;
  let externallyInstalled = false; // portable app found in the OS inventory, not one we manage
  if (repo.type === 'installer') {
    try {
      installed = await detect.installedVersion(core.detectName(repo));
    } catch {}
    // Scheme mismatch (e.g. Brave: registry 152.1.94.117 vs tag 1.94.117): the install
    // looks "newer" than any release, so updates would never be detected. Align the
    // installed version to the tag's scheme; Current then displays comparably too.
    if (installed && core.cmpVersion(latest, installed) < 0) {
      const aligned = core.alignInstalledVersion(installed, latest);
      if (aligned) installed = aligned;
    }
  } else {
    installed = prev.version || null;
    // No git-updater-managed record: fall back to the OS inventory. The user may have
    // installed this app by hand (e.g. dragged a dmg into /Applications) — it then reads as
    // installed even though git-updater does not own the copy. For an SLA-guarded dmg like
    // Deskflow's, which cannot be unpacked unattended, this is the ONLY way it ever shows
    // installed. Aligned to the tag scheme like the installer path above.
    if (!installed) {
      let detected = null;
      try {
        detected = await detect.installedVersion(core.detectName(repo));
      } catch {}
      if (detected) {
        installed = detected;
        externallyInstalled = true;
        if (core.cmpVersion(latest, installed) < 0) {
          const aligned = core.alignInstalledVersion(installed, latest);
          if (aligned) installed = aligned;
        }
      }
    }
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
  // Portable recorded as installed but its folder is gone/empty -> reinstall. Skipped when
  // the version came from the OS inventory rather than our own manifest: an externally
  // installed app (e.g. Deskflow in /Applications) is genuinely present, just not in our
  // folder, so it is up to date, not a broken install to redo.
  if (!isNew && !opts.force && tracked && repo.type === 'portable' && repo.install && !externallyInstalled && !dirHasFiles(repo.install.dir)) {
    isNew = true;
  }

  const fromV = installed ? core.normTag(installed) : prev.tag && core.normTag(prev.tag);
  if (!isNew && !opts.force) {
    return { repo: id, id: key, status: 'current', from: fromV, to: core.normTag(latest), ...src, ...(retyped ? { retyped, note: retyped.note } : {}) };
  }

  const base = { repo: id, id: key, from: fromV, to: core.normTag(latest), ...src };

  // A selection failure that choosing a file by hand would fix (nothing fits automatically,
  // or a saved choice stopped matching — see sources.selectAsset) is a row state, not an
  // error: the row keeps its versions and the window offers "Choose…" on it. The reason is
  // the plain-words one; the log keeps the original.
  const needsChoice = (e) => {
    if (opts.mode !== 'check' && !opts.dryRun) log(`SKIP ${key}: ${e.message}`);
    return { ...base, status: 'failed', reason: e.chooseWhy, chooseFile: true };
  };

  // A plain GitHub check with the checksum setting off stays what it was: the version
  // comparison, and no extra request. The one addition costs nothing — the release is
  // already in hand: try the selection, so "needs a choice" is said at Check rather than
  // discovered when the user presses Update. No installed flavor is looked up for it:
  // flavor only re-ranks files, it never decides whether there is one. Any other selection
  // failure stays the update's to raise, exactly as before.
  if (opts.mode === 'check' && gh && !opts.requireChecksum) {
    try {
      sources.selectAsset(repo, rel);
    } catch (e) {
      if (e.chooseFile) return needsChoice(e);
    }
    return { ...base, status: 'updated', ...(retyped ? { retyped, note: retyped.note } : {}) };
  }

  let pre;
  try {
    pre = await preflight(repo, rel, ctx, {
      gh,
      tracked: !!tracked,
      requireChecksum: !!opts.requireChecksum,
      label: src.source && src.source.label,
    });
  } catch (e) {
    if (e.chooseFile) return needsChoice(e);
    throw e;
  }
  const asset = pre.asset;
  let sum = pre.sum;
  if (pre.blocked) {
    if (opts.mode !== 'check' && !opts.dryRun) log(`SKIP ${key}: ${pre.blocked}`);
    return { ...base, status: 'failed', reason: pre.blocked, ...fileInfo(asset, sum) };
  }

  if (opts.mode === 'check') {
    return { ...base, status: 'updated', ...fileInfo(asset, sum), ...(retyped ? { retyped, note: retyped.note } : {}) };
  }

  if (opts.dryRun) {
    const verb = /\.(zip|7z|tar\.gz|tgz|tar\.xz|tar\.bz2|tar|dmg)$/i.test(asset.name) ? 'extract' : 'place';
    const plan =
      repo.type === 'installer'
        ? `install ${asset.name} silently`
        : `${verb} ${asset.name} -> ${repo.install.dir}`;
    return { ...base, status: 'updated', note: plan, ...fileInfo(asset, sum) };
  }

  // Proactive check: a running app blocks both installers (in-use files) and portable
  // swaps (locked files). Tell the user up front instead of failing mid-download.
  if (await detect.isRunning(core.processName(repo))) {
    if (opts.autoClose) {
      const result = await closeForUpdate(repo, key, opts, 'update');
      if (result.stillRunning) return { ...base, status: 'failed', reason: result.reason };
    } else {
      log(`SKIP ${key}: ${core.appName(repo)} is running`);
      return { ...base, status: 'failed', reason: `${core.appName(repo)} is running — close it, then Retry` };
    }
  }

  log(`update ${key}: installed=${installed || '(none)'} -> latest=${core.normTag(latest)}, asset=${asset.name}`);

  // Stage under git-updater's own data dir, NOT the system temp dir — EDR/ASR rules on
  // Windows flag executables run from %TEMP%, and macOS Gatekeeper treats a quarantined
  // bundle there differently. src/paths.js picks the right location per platform.
  const stageBase = path.join(paths.dataDir(), 'staging');
  fs.mkdirSync(stageBase, { recursive: true });
  // Best-effort cleanup of leftovers older than a day (kept interactive installers, crashed runs).
  try {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(stageBase)) {
      const p = path.join(stageBase, name);
      try {
        if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
  const tmp = fs.mkdtempSync(path.join(stageBase, 'dl-'));
  try {
    // The name comes from a remote listing. One safe path segment, and the resolved path
    // must still be inside the staging directory before anything is written to it.
    let stagedName = gh ? asset.name : sources.safeFileName(asset.name);
    let file = path.join(tmp, stagedName);
    if (!gh && path.dirname(path.resolve(file)) !== path.resolve(tmp)) throw new Error('the source listed a file whose name is not safe to save');
    emit('downloading', 0);
    // Where the bytes really came from. Every non-GitHub download is HTTPS on every hop,
    // and a redirect (vendors front their files with mirrors) is followed only after the
    // next address has been validated. The host that finally served the file is recorded
    // and logged beside the declared one — the declared URL is not the whole story.
    let finalUrl = asset.browser_download_url;
    const policy = sources.downloadPolicy(repo, asset, sum);
    await github.downloadAsset(asset.browser_download_url, file, (pct) => emit('downloading', pct), opts.maxBytes, {
      ...policy,
      // A private GitHub repository's file is only served through the API (with the token).
      ...(gh && asset.url ? { apiUrl: asset.url } : {}),
      onFinalUrl: (u) => { finalUrl = u; },
    });
    if (!gh) log(`  ${key}: ${src.source ? src.source.label : 'source'} -> ${sources.redact(finalUrl)}`);
    // Some listings name a download address with no file extension (an update endpoint
    // rather than a file). Everything downstream decides by extension, so the file is
    // named from what it actually is — its first and last bytes — never from a guess.
    if (asset.sniff) {
      const ext = sniffExtension(file);
      if (!ext) throw new Error('could not tell what kind of file was downloaded');
      stagedName += ext;
      const named = path.join(tmp, stagedName);
      fs.renameSync(file, named);
      file = named;
    }
    emit('verifying');
    let v;
    if (sum) {
      // Resolved up front (see preflight). A hash that exists is always enforced: if one
      // was found and the file was not positively verified against it, nothing installs.
      v = github.verifyDigest(file, sum.digest);
      if (sum.digest && !(v && v.verified)) throw new Error('the checksum could not be verified');
      if (v && v.verified && sum.note) v.note = sum.note;
      if (v && v.skipped) v.note = 'no checksum published';
    } else {
      // Prefer GitHub's own digest; fall back to a checksums file shipped in the release
      // (SHA256SUMS, <asset>.sha256, ...). Only truly digest-less releases skip.
      let digest = asset.digest;
      let digestNote = null;
      if (!digest) {
        const found = await github.fetchChecksumFromRelease(rel, asset.name);
        if (found) {
          digest = `${found.algo}:${found.expected}`;
          digestNote = 'verified via release checksums file';
        }
      }
      v = github.verifyDigest(file, digest);
      if (v && v.verified && digestNote) v.note = digestNote;
      sum = { digest: digest || null, state: digest ? 'published' : 'none' };
    }
    if (v && v.skipped) log(`  WARN ${key}: ${v.note}`);

    emit('installing');
    let files; // portable manifest, for stale-file pruning
    if (repo.type === 'installer' && asset.nested) {
      // The listing delivers the setup program inside a zip. The zip is what was downloaded
      // and verified; the one file it names is taken out and becomes the installer.
      file = install.extractNestedInstaller(file, asset.nested, tmp);
      stagedName = path.basename(file);
    }
    if (repo.type === 'installer') {
      // Detect the installer's silent-install technology from its bytes. If it can't be
      // identified, FAIL rather than blindly running an unknown .exe with NSIS's /S switch.
      // Open the downloaded package in its OWN installer window, where the user gets the
      // platform's normal authorization prompt. git-updater never self-elevates.
      //   Windows MSI: msiexec with UI (msiexec.exe itself needs no manifest elevation).
      //   Windows EXE: opts.openFile (ShellExecute via Electron) so the setup's UAC manifest works.
      //   macOS .pkg:  opts.openFile hands it to Installer.app, which prompts for admin.
      //   Linux .deb/.rpm: opts.openFile hands it to the desktop's package installer.
      const interactive = (keepName) => {
        // An unattended (scheduled) run never opens an installer window or an authorization
        // prompt: nobody is there to answer it. Such an installer is reported as "needs you".
        if (opts.unattended) return false;
        const keep = path.join(stageBase, keepName); // outlives the tmp cleanup below
        fs.copyFileSync(file, keep);
        log(`  -> opening interactive installer: ${keep}`);
        if (isWin && /\.msi$/i.test(keep)) spawn('msiexec', ['/i', keep], { detached: true, stdio: 'ignore' }).unref();
        else if (opts.openFile) opts.openFile(keep);
        else return false;
        return true;
      };
      // A packaged app (MSIX) is never run by git-updater: Windows installs it through its own
      // App Installer window, which is where the user confirms it.
      const packaged = asset.kind === 'msix' || (!asset.kind && /\.(msix|msixbundle|appx|appxbundle)$/i.test(stagedName));
      const interactiveResult = {
        ...base,
        status: 'failed',
        reason: packaged
          ? 'installer window opened — choose Install in the App Installer window, then Check'
          : isWin
            ? 'installer window opened — approve the UAC prompt and finish it, then Check'
            : 'installer window opened — authorize and finish it, then Check',
      };
      if (packaged) {
        if (interactive(stagedName)) return interactiveResult;
        if (opts.unattended) throw new Error(`needs you: ${core.appName(repo)} is installed through Windows' own App Installer window, so it was not run unattended. Update it from the window.`);
        throw new Error(`${asset.name} is a packaged Windows app — open it to install it with App Installer`);
      }

      // A manifest that states the installer technology beats sniffing the file's bytes.
      const stated = asset.kind && core.INSTALLER_SWITCHES[asset.kind] ? asset.kind : null;
      const kind = (repo.install && repo.install.kind) || stated || install.detectInstallerKind(file);
      // The switches the listing declares. Its upgrade set (the install switches plus the
      // ones it reserves for upgrades) applies only when a version is really on this machine
      // — found in the OS inventory just now, not merely remembered from an earlier run.
      const listed = installed && (asset.upgradeArgs || asset.upgradeArgsRaw)
        ? { args: asset.upgradeArgs, raw: asset.upgradeArgsRaw }
        : { args: asset.installArgs, raw: asset.installArgsRaw };
      const pinnedArgs = repo.install && repo.install.args;
      const declaredArgs = pinnedArgs || (Array.isArray(listed.args) && listed.args.length ? listed.args : undefined);
      // A switch string that must reach the installer exactly as written (see installerCmd).
      const rawArgs = !declaredArgs && typeof listed.raw === 'string' && listed.raw ? listed.raw : undefined;
      if (!kind || (kind === 'exe' && !declaredArgs && !rawArgs)) {
        // Unidentifiable installer, or one with no silent switches declared for it: never
        // guess — run its own window instead.
        if (interactive(stagedName)) return interactiveResult;
        if (opts.unattended) throw new Error(`needs you: ${core.appName(repo)}'s installer cannot run silently, so it was not run unattended. Update it from the window.`);
        throw new Error(
          `could not identify the installer type for ${asset.name} — add "install":{"kind":"nsis|inno|msi"} for ${id} in config.json`
        );
      }
      try {
        // Silent switches the listing declares are an argv array, used only when the user
        // has not pinned their own. Never a shell string.
        install.installInstaller(file, { ...repo.install, kind, ...(declaredArgs ? { args: declaredArgs } : {}), rawArgs });
      } catch (e) {
        // Silent installs can't show a UAC prompt, so unelevated they fail — MSI with
        // exit 1603, EXE installers with an elevation spawn error. Fall back to the
        // installer's own window in both cases. (No PowerShell, no self-elevation.)
        if ((e.status === 1603 || e.elevation) && opts.unattended) {
          throw new Error(`needs you: ${core.appName(repo)}'s installer needs administrator permission, so it was not run unattended. Update it from the window.`);
        }
        if ((e.status === 1603 || e.elevation) && interactive(stagedName)) return interactiveResult;
        throw e;
      }
    } else {
      // Re-check immediately before the swap, not just before the download. The download
      // takes seconds to minutes, and the user may well have launched the app during it.
      //
      // This is the ONLY protection on macOS and Linux. On Windows the swap itself fails
      // with EBUSY or EPERM when files are open, and install.js turns that into "close
      // the app and Retry" — but a POSIX rename of a running application's directory
      // SUCCEEDS. Measured on macOS with a real signed Electron app: it survived the
      // swap for at least 30 seconds — including having its old directory DELETED
      // underneath it — across four processes, with no crash and no crash report. A
      // fresh read at the live path returns the new version while the process keeps
      // executing code loaded before the swap.
      //
      // So this is not "it crashes". It is old code, new files, one path, and nobody
      // has managed to provoke a failure from that mismatch. Unprovoked is not safe:
      // whatever the app loads next comes from a version it did not start with.
      if (await detect.isRunning(core.processName(repo))) {
        if (opts.autoClose) {
          const result = await closeForUpdate(repo, key, opts, 'swap');
          if (result.stillRunning) return { ...base, status: 'failed', reason: result.reason };
        } else {
          log(`SKIP ${key}: ${core.appName(repo)} started during the download`);
          return { ...base, status: 'failed', reason: `${core.appName(repo)} is running — close it, then Retry` };
        }
      }
      // Transactional dir swap: stale files vanish with the old dir, user files carry over.
      try {
        files = await install.installPortable(file, repo.install, prev.files);
      } catch (e) {
        // A .dmg gated by a click-through licence agreement cannot be unpacked unattended,
        // and git-updater will not agree to a licence for the user (see extractDmg). Rather
        // than dead-end, hand the image to macOS so ITS OWN dialog shows the licence — the
        // legal act stays with the human — and the user installs the app by hand from the
        // mounted image. Mirrors the interactive-installer fallback above. Copy the image
        // out of the tmp dir first so it survives the cleanup in `finally`.
        if (e.licenceAgreement && opts.openFile) {
          const keep = path.join(stageBase, stagedName);
          fs.copyFileSync(file, keep);
          log(`  -> opening disk image for licence acceptance: ${keep}`);
          opts.openFile(keep);
          return {
            ...base,
            status: 'failed',
            reason: 'disk image opened — accept the licence, then install the app by hand from it',
          };
        }
        throw e;
      }
    }

    const installedAt = new Date().toISOString();
    const lastAction = tracked ? 'updated' : 'installed';
    st[key] = {
      repo: id,
      type: repo.type,
      tag: latest,
      version: core.normTag(latest),
      assetName: asset.name,
      installedAt,
      lastAction,
      // Provenance of what is on disk: who listed it, where it was fetched from, and
      // whether its checksum was verified. Query strings are never stored.
      ...(src.source ? { source: src.source.type } : {}),
      url: sources.redact(asset.browser_download_url),
      fileHost: hostOf(finalUrl),
      checksum: v && v.verified ? (sum && sum.state) || 'published' : 'none',
      ...(files ? { files } : {}),
    };
    state.save(st, opts.statePath);
    log(`OK ${key}: installed ${core.normTag(latest)}`);
    return { ...base, status: 'updated', installedAt, lastAction, note: v && v.note, ...fileInfo(asset, { state: v && v.verified ? (sum && sum.state) || 'published' : 'none' }, finalUrl) };
  } finally {
    try {
      await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      log(`WARN ${key}: could not remove staging folder ${tmp} (${e.code || e.message})`);
    }
  }
}

// '.zip' | '.dmg' | '.pkg' | null, from the file's own bytes.
function sniffExtension(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return '.zip';
    if (head.toString('latin1', 0, 4) === 'xar!') return '.pkg';
    if (size >= 512) {
      // A UDIF disk image ends with a 512-byte trailer that starts "koly".
      const tail = Buffer.alloc(4);
      fs.readSync(fd, tail, 0, 4, size - 512);
      if (tail.toString('latin1') === 'koly') return '.dmg';
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// The chosen file and its origin, for results. `finalUrl` is known only after a download.
function fileInfo(asset, sum, finalUrl) {
  const declared = hostOf(asset.browser_download_url);
  const out = { file: asset.name, fileHost: declared, fileUrl: sources.redact(asset.browser_download_url) };
  const fin = finalUrl ? hostOf(finalUrl) : '';
  if (fin && fin !== declared) out.servedFrom = fin;
  if (sum && sum.state) out.checksum = sum.state;
  if (asset.emulated) out.emulated = true; // not native to this machine; runs under emulation
  if (Array.isArray(asset.requires) && asset.requires.length) out.requires = asset.requires;
  return out;
}

// retypeIfNoInstaller: former name, kept so the vendored drop-in keeps working.
module.exports = { run, retypeIfUnavailable, retypeIfNoInstaller: retypeIfUnavailable, sniffExtension };
