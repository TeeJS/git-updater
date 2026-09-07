'use strict';

// Self-update, Squirrel.Windows style: a new version is a brand-new sibling folder
// (<root>\app-<version>\), created by plain extraction — nothing a process is running from
// is ever renamed or deleted. The exe at <root> acts as the launcher: on start it hands off
// to the newest app-* folder that is newer than itself. Old app-* folders are removed on a
// later start, once nothing runs from them. The only binary ever executed is this same
// signed exe (no helper, no shell, no script).
//
// Layout (the flat unzip-and-run install simply becomes the launcher on the first update):
//   <root>\git-updater.exe          launcher (the original flat install, never touched again)
//   <root>\app-0.1.6\git-updater.exe  the version actually running

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const core = require('./core');
const github = require('./github');
const install = require('./install');
const state = require('./state');
const { log } = require('./log');

// Overridable for testing against a repo other than the real one.
const REPO_OWNER = process.env.GITUPDATER_SELFUPDATE_OWNER || 'TeeJS';
const REPO_NAME = process.env.GITUPDATER_SELFUPDATE_REPO || 'git-updater';

const EXE = 'git-updater.exe';
const VERSION_DIR = /^app-(\d.*)$/;
const STAGE_PREFIX = '.git-updater-selfupdate-stage-';
const SELF_ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'git-updater', 'self-update');
const APPLY_MARKER = path.join(SELF_ROOT, 'last-apply.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- layout -------------------------------------------------------------------

// Where the install root is, given the running exe: either the launcher itself
// (<root>\git-updater.exe) or a versioned copy (<root>\app-x.y.z\git-updater.exe).
function layout(execPath) {
  const dir = path.dirname(execPath);
  const m = VERSION_DIR.exec(path.basename(dir));
  return m ? { root: path.dirname(dir), versionDir: dir } : { root: dir, versionDir: null };
}

// app-* folders under root that contain the exe, newest first.
function listVersions(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = VERSION_DIR.exec(name);
    if (!m) continue;
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, EXE))) out.push({ version: m[1], dir });
  }
  return out.sort((a, b) => core.cmpVersion(b.version, a.version));
}

// The version folder the launcher should hand off to, or null to run itself.
function newestNewerThan(root, currentVersion) {
  const top = listVersions(root)[0];
  return top && core.cmpVersion(top.version, currentVersion) > 0 ? top : null;
}

// Hand-off decision for the running exe. Never hands off to the folder it is already running
// from — a folder whose name overstates the build inside would otherwise relaunch forever.
function handoffTarget(execPath, currentVersion) {
  const { root, versionDir } = layout(execPath);
  const target = newestNewerThan(root, currentVersion);
  return target && target.dir !== versionDir ? target : null;
}

function launch(dir, args = []) {
  spawn(path.join(dir, EXE), args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

// `--wait-pid <pid>`: the relaunch after an update — wait for the updating process to exit
// (it still holds the single-instance lock) before handing off to the new version.
function waitPidArg(argv) {
  const i = argv.indexOf('--wait-pid');
  const pid = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function waitForExit(pid, deps = {}) {
  const alive = deps.pidAlive || state.pidAlive;
  const sleep = deps.wait || wait;
  for (let i = 0; i < 150 && alive(pid); i++) await sleep(200); // ~30s ceiling
  return !alive(pid);
}

// --- check --------------------------------------------------------------------

async function checkForUpdate(currentVersion) {
  const rel = await github.getLatestRelease(REPO_OWNER, REPO_NAME);
  const tag = core.normTag(rel.tag_name || '');
  return core.cmpVersion(tag, currentVersion) > 0 ? { rel, version: tag } : null;
}

// --- prepare: download + verify + extract into <root>\app-<tag> -----------------

// Runs in the running process. Extracts into a stage dir under root, then renames it to
// its final app-<tag> name — a rename of a fresh, unreferenced folder into a path that
// never existed, the same operation every tracked-app fresh install already does. A
// failure anywhere leaves the running version and the launcher completely untouched.
async function prepareUpdate(root, currentVersion, onProgress = () => {}) {
  const found = await checkForUpdate(currentVersion);
  if (!found) throw new Error('no newer release found');
  const { rel, version: tag } = found;

  const asset = core.pickWindowsAsset(rel.assets, 'portable');

  const downloadDir = path.join(SELF_ROOT, tag);
  fs.mkdirSync(downloadDir, { recursive: true });
  const file = path.join(downloadDir, asset.name);

  onProgress('downloading', 0);
  await github.downloadAsset(asset.browser_download_url, file, (pct) => onProgress('downloading', pct));

  onProgress('verifying');
  let digest = asset.digest;
  if (!digest) {
    const sums = await github.fetchChecksumFromRelease(rel, asset.name);
    if (sums) digest = `${sums.algo}:${sums.expected}`;
  }
  const v = github.verifyDigest(file, digest);
  if (v && v.skipped) log(`  WARN self-update: ${v.note}`);

  onProgress('installing');
  const target = path.join(root, `app-${tag}`);
  fs.rmSync(target, { recursive: true, force: true }); // a previous partial attempt
  const stage = fs.mkdtempSync(path.join(root, STAGE_PREFIX));
  try {
    const { srcDir } = await install.extractArchive(file, stage);
    if (!fs.existsSync(path.join(srcDir, EXE))) throw new Error(`downloaded build has no ${EXE}`);
    fs.renameSync(srcDir, target);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });
  return { tag, dir: target };
}

// The launcher restarts the app into the newest version once this process is gone.
function relaunchViaLauncher(root, pid) {
  launch(root, ['--wait-pid', String(pid)]);
}

// --- post-relaunch version check ----------------------------------------------

function writeApplyMarker({ expectVersion }) {
  try {
    fs.mkdirSync(SELF_ROOT, { recursive: true });
    fs.writeFileSync(APPLY_MARKER, JSON.stringify({ expectVersion, appliedAt: new Date().toISOString() }));
  } catch {}
}

// Reads + deletes the marker once. null when none is present (the normal case).
function consumeApplyMarker(actualVersion) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(APPLY_MARKER, 'utf8'));
  } catch {
    return null;
  }
  try {
    fs.rmSync(APPLY_MARKER, { force: true });
  } catch {}
  if (!data || !data.expectVersion) return null;
  return {
    ok: core.normTag(actualVersion) === core.normTag(data.expectVersion),
    expectVersion: data.expectVersion,
    actualVersion,
  };
}

// --- startup cleanup -----------------------------------------------------------

// Best-effort, never throws. Removes app-* folders OLDER than the running version (nothing
// runs from them any more — a still-exiting one just fails with EBUSY and is retried next
// start), stale stage dirs, and day-old downloads.
function cleanupLeftovers(root, currentVersion) {
  for (const v of listVersions(root)) {
    if (core.cmpVersion(v.version, currentVersion) >= 0) continue;
    try {
      fs.rmSync(v.dir, { recursive: true, force: true });
    } catch {}
  }
  const dayAgo = Date.now() - DAY_MS;
  const sweep = (dir, matches) => {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!matches(name)) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  };
  sweep(root, (name) => name.startsWith(STAGE_PREFIX));
  sweep(SELF_ROOT, (name) => name !== path.basename(APPLY_MARKER));
}

module.exports = {
  layout,
  listVersions,
  newestNewerThan,
  handoffTarget,
  launch,
  waitPidArg,
  waitForExit,
  checkForUpdate,
  prepareUpdate,
  relaunchViaLauncher,
  writeApplyMarker,
  consumeApplyMarker,
  cleanupLeftovers,
};
