'use strict';

// Self-update, Squirrel.Windows style: a new version is a brand-new sibling folder
// (<root>/app-<version>/), created by plain extraction — nothing a process is running from
// is ever renamed or deleted. The launcher at <root> hands off on start to the newest app-*
// folder that is newer than itself. Old app-* folders are removed on a later start, once
// nothing runs from them. The only binary ever executed is this same signed build (no
// helper, no shell, no script).
//
// Layout (the flat unzip-and-run install simply becomes the launcher on the first update):
//   <root>/git-updater[.exe]            launcher (the original flat install, never touched)
//   <root>/app-0.1.6/git-updater[.exe]  the version actually running
//
// Windows and Linux both work this way, and the reason it is safe is the INDIRECTION: the
// running process reads from app-x.y.z, and an update writes a NEW sibling directory and
// repoints the launcher. Nothing ever replaces the directory being read from.
//
// The one Linux exception is a copy run from an AppImage, which has no folder to put a
// sibling in and replaces its own image file instead: see "running from an AppImage" below.
//
// macOS has no equivalent, because the .app bundle IS the unit the system launches. There
// is nowhere to put a launcher that is not itself inside the thing being replaced. So
// canApply() is false there and the UI offers the release page instead.
//
// An earlier version of this comment said the swap breaks signature continuity. That was
// measured on hardware and is FALSE: a swapped-in bundle verifies as valid, the running
// process survives, and a relaunch picks up the new version correctly. A real signed
// Electron app also survived the swap outright — four processes, 30 seconds, old
// directory deleted underneath it, no crash.
//
// So the case against an in-place macOS self-update rests on the indirection argument
// above, which needs no hardware, and NOT on a crash nobody has observed. What is left is
// a version mismatch — the running process keeps executing code it loaded before the
// swap, while its own bundle path now serves different files — that we could not provoke
// a failure from. checkForUpdate() still reports new versions on every platform.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const github = require('./github');
const { assetTable } = require('./platform/assets');
const install = require('./install');
const state = require('./state');
const paths = require('./paths');
const { log } = require('./log');

// Overridable for testing against a repo other than the real one.
const REPO_OWNER = process.env.GITUPDATER_SELFUPDATE_OWNER || 'TeeJS';
const REPO_NAME = process.env.GITUPDATER_SELFUPDATE_REPO || 'git-updater';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'git-updater.exe' : 'git-updater';

// --- running from an AppImage ---------------------------------------------------
//
// The launcher model below has nowhere to work when git-updater is run as an AppImage.
// process.execPath is then inside the image's own mount (/tmp/.mount_git-upXXXXXX/), which
// is a read-only squashfs: staging the new version beside it failed with EROFS on the
// mkdtemp, and even a writable mount would be gone the moment this process exits. The unit
// to update is the image FILE, whose path the AppImage runtime exports as $APPIMAGE. The
// new image is written beside it and renamed over it: a rename never disturbs the running
// copy (its mount holds the old inode open), and the desktop entry, the login entry
// (background.launcherPath) and the user's own shortcut all keep pointing at one path.
//
// Every function here takes the environment as an argument (env, platform, execPath, arch)
// so the tests can describe a Linux AppImage run from any host.
const runCtx = (o = {}) => ({
  env: o.env || process.env,
  platform: o.platform || process.platform,
  execPath: o.execPath || process.execPath,
  arch: o.arch || process.arch,
});

const realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

function isInside(dir, p) {
  const rel = path.relative(realPath(dir), realPath(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The AppImage this process is running from, or null.
//
// $APPIMAGE alone is not proof. The runtime exports it into the app's environment and every
// child inherits it, so a git-updater started from another AppImage — a terminal emulator,
// an editor's built-in terminal, a launcher — sees THAT app's image path. Trusting it would
// download our release and rename it over somebody else's program. $APPDIR (the mount, set
// by the same runtime) settles it: the image is ours only if our own executable is inside.
// A leaked pair names a mount that a tarball install's executable is never in.
function appImageFile(opts = {}) {
  const { env, platform, execPath } = runCtx(opts);
  if (platform !== 'linux') return null;
  const img = env.APPIMAGE;
  const appDir = env.APPDIR;
  if (!img || !appDir || !path.isAbsolute(img) || !path.isAbsolute(appDir)) return null;
  return isInside(appDir, execPath) ? img : null;
}

// Replacing the image means creating a file beside it and renaming over it, which needs
// write and search permission on the FOLDER; the image's own mode is beside the point. An
// AppImage that root installed under /opt fails this, and so does one on a read-only
// mount. So does one that was moved or deleted while running: writing a new file at the
// path it used to have would leave the user with two.
function appImageReplaceable(img) {
  try {
    if (!fs.statSync(img).isFile()) return false;
    fs.accessSync(path.dirname(img), fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Whether a found update can be APPLIED in place here, or only reported. False on macOS
// through this module (see the top of the file), and false for an AppImage that cannot be
// replaced where it sits; the UI then offers the release page ("Download <version>").
function canApply(opts = {}) {
  if (runCtx(opts).platform === 'darwin') return false;
  const img = appImageFile(opts);
  return img ? appImageReplaceable(img) : true;
}
const VERSION_DIR = /^app-(\d.*)$/;
const STAGE_PREFIX = '.git-updater-selfupdate-stage-';
// The new image while it is being written beside the old one (see replaceAppImage).
const APPIMAGE_NEW_PREFIX = '.git-updater-selfupdate-appimage-';
const SELF_ROOT = path.join(paths.dataDir(), 'self-update');
const APPLY_MARKER = path.join(SELF_ROOT, 'last-apply.json');
const DAY_MS = 24 * 60 * 60 * 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Inside Electron, Node's fs is patched to treat any path containing ".asar" as an archive —
// so writing, chmod-ing, or deleting the new build's resources\app.asar fails (ENOENT/ENOTDIR).
// process.noAsar turns that patch off; a no-op under plain Node.
async function withoutAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return await fn();
  } finally {
    process.noAsar = prev;
  }
}

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

// A freshly extracted Electron build needs its launcher marked executable, and on Linux
// its bundled chrome-sandbox too — without them the new version refuses to start, which
// looks exactly like a corrupt update. The archive normally carries these bits and
// extractArchive preserves them; this is the belt-and-braces pass for an archive built
// without Unix attributes.
function makeExecutable(dir) {
  if (IS_WIN) return;
  for (const rel of [EXE, 'chrome-sandbox']) {
    const p = path.join(dir, rel);
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, rel === 'chrome-sandbox' ? 0o4755 : 0o755);
    } catch {}
  }
}

// Errors that mean "another process is holding a handle" — a real-time scanner mid-scan,
// not a genuine conflict — so a copy that only needs read access can still get through.
const RENAME_LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

// Move the freshly extracted build to its final app-<tag> folder. The self-update payload
// is ~150 MB of just-written executables, and on an EDR-managed machine a real-time scan
// can hold handles on them for many seconds — well past install.js's default ~1.5 s retry
// budget — so an exclusive directory rename (MoveFileEx) keeps failing with EPERM even
// though nothing legitimately owns the folder. Give the rename a much longer window here,
// then fall back to a plain recursive copy: a copy only needs READ access, which the
// scanner allows concurrently, whereas the move demands exclusive access it will not yield.
function moveIntoPlace(srcDir, target, opts = {}) {
  const waits = opts.waits || [200, 400, 800, 1600, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]; // ~19 s
  try {
    install.renameWithRetry(srcDir, target, { ...opts, waits });
  } catch (e) {
    if (!RENAME_LOCKED.has(e.code)) throw e;
    log(`  self-update: rename blocked (${e.code}) after retries; copying into place instead`);
    fs.rmSync(target, { recursive: true, force: true }); // clear any partial the failed move left
    fs.cpSync(srcDir, target, { recursive: true });
    makeExecutable(target); // cpSync should carry the mode, but re-assert it to be safe
  }
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

// The assets this updater can update ITSELF from, which is a narrower set than the ones
// it can install for other apps.
//
// The launcher model needs a DIRECTORY: app-<version>/ containing an executable named
// git-updater, sitting beside the launcher. An AppImage is a single self-contained file,
// so there is nothing to put a versioned sibling inside and nothing at app-<version>/
// git-updater to hand off to. The generic asset picker prefers an AppImage on Linux —
// correctly, for a tracked app — so our own release would have been picked as the one
// shape this mechanism cannot use, and prepareUpdate would fail at the "downloaded build
// has no git-updater" check after downloading the whole thing.
//
// Dropping it here rather than teaching the picker about it: preferring an AppImage is
// right for every OTHER app, and this is the only caller with a layout requirement.
//
// This is the choice for an install that follows the launcher model. A copy that is itself
// RUNNING from an AppImage is the opposite case and takes appImageAsset below.
function selfUpdateAssets(assets) {
  const list = assets || [];
  const usable = list.filter((a) => !/\.appimage$/i.test(a.name || ''));
  // If a release somehow ships nothing else, let the picker report that rather than
  // throwing "no assets" from here with less context.
  return usable.length ? usable : list;
}

// The mirror image of selfUpdateAssets, for a copy running from an AppImage: ONLY the
// AppImages, and of those the one for this machine's architecture. Our release names them
// git-updater-<v>-linux-x86_64.AppImage and -arm64.AppImage (electron-builder forces
// AppImage's own "x86_64" label; see docs/RELEASING.md), and the picker reads both.
//
// The picker only PENALISES the wrong architecture, it does not exclude it, so a release
// whose arm64 image is missing (an upload that stalled, a build that failed) would hand an
// arm64 machine the x86_64 one. For a tracked app that is a bad install; here it would be
// renamed over the only copy of git-updater the user has, leaving a file that cannot
// execute and nothing to update from. Refuse instead: the running image stays as it is.
function appImageAsset(assets, arch = process.arch) {
  const list = (assets || []).filter((a) => /\.appimage$/i.test(a.name || ''));
  if (!list.length) throw new Error('this release has no AppImage; download the new version from the release page');
  const asset = core.pickAsset(list, 'portable', arch, null, 'linux');
  const table = assetTable('linux');
  if (table.archScore(table.archTokens(asset.name), arch) < 0) {
    throw new Error(`this release has no AppImage for ${arch} (it has ${list.map((a) => a.name).join(', ')})`);
  }
  return asset;
}

// opts.prerelease: when true, the newest release INCLUDING betas/prereleases is considered
// (the self-update beta channel); otherwise only the latest stable release, GitHub's default.
async function checkForUpdate(currentVersion, opts = {}) {
  const rel = await github.getLatestRelease(REPO_OWNER, REPO_NAME, opts.prerelease ? { prerelease: true } : {});
  const tag = core.normTag(rel.tag_name || '');
  return core.cmpVersion(tag, currentVersion) > 0 ? { rel, version: tag } : null;
}

// --- prepare: download + verify + extract into <root>\app-<tag> -----------------

// Runs in the running process. Extracts into a stage dir under root, then renames it to
// its final app-<tag> name — a rename of a fresh, unreferenced folder into a path that
// never existed, the same operation every tracked-app fresh install already does. A
// failure anywhere leaves the running version and the launcher completely untouched.
//
// Run from an AppImage, the same download and the same verification end in
// replaceAppImage instead, and `root` (the image's read-only mount) is never written to.
// opts.env / platform / execPath / arch describe the run and default to this process.
async function prepareUpdate(root, currentVersion, onProgress = () => {}, opts = {}) {
  const img = appImageFile(opts);
  if (!canApply(opts)) {
    throw new Error(
      img
        ? `this AppImage cannot be replaced where it is (${path.dirname(img)} is not writable, or the file has moved); download the new version from the release page`
        : 'applying an update in place is not supported on this platform'
    );
  }
  const found = await checkForUpdate(currentVersion, opts);
  if (!found) throw new Error('no newer release found');
  const { rel, version: tag } = found;

  const asset = img
    ? appImageAsset(rel.assets, runCtx(opts).arch)
    : core.pickAsset(selfUpdateAssets(rel.assets), 'portable');

  const downloadDir = path.join(SELF_ROOT, tag);
  fs.mkdirSync(downloadDir, { recursive: true });
  const file = path.join(downloadDir, asset.name);

  onProgress('downloading', 0);
  await github.downloadAsset(asset.browser_download_url, file, (pct) => onProgress('downloading', pct), opts.maxBytes);

  onProgress('verifying');
  let digest = asset.digest;
  if (!digest) {
    const sums = await github.fetchChecksumFromRelease(rel, asset.name);
    if (sums) digest = `${sums.algo}:${sums.expected}`;
  }
  const v = github.verifyDigest(file, digest);
  if (v && v.skipped) log(`  WARN self-update: ${v.note}`);

  onProgress('installing');
  if (img) {
    assertExecutableImage(file);
    replaceAppImage(file, img);
    fs.rmSync(downloadDir, { recursive: true, force: true });
    log(`self-update: ${tag} written over ${img}`);
    return { tag, dir: path.dirname(img), appImage: img };
  }
  const target = path.join(root, `app-${tag}`);
  await withoutAsar(async () => {
    fs.rmSync(target, { recursive: true, force: true }); // a previous partial attempt
    const stage = fs.mkdtempSync(path.join(root, STAGE_PREFIX));
    try {
      const { srcDir } = await install.extractArchive(file, stage);
      if (!fs.existsSync(path.join(srcDir, EXE))) throw new Error(`downloaded build has no ${EXE}`);
      makeExecutable(srcDir);
      moveIntoPlace(srcDir, target);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
  fs.rmSync(downloadDir, { recursive: true, force: true });
  log(`self-update: ${tag} extracted to ${target}`);
  return { tag, dir: target };
}

// --- AppImage: replace the file, start it again ---------------------------------

// The AppImage counterpart of the "downloaded build has no git-updater" check above: the
// file about to replace the user's only copy must at least be something the kernel can
// start. Every AppImage begins with an ELF header (the runtime is an ELF executable with
// the squashfs appended). A digest normally proves far more than this, but a release with
// no digest and no checksums file is only warned about, and then this is all there is.
function assertExecutableImage(file) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('downloaded file is not an AppImage');
}

// Put the verified download where the running image is.
//
// The copy goes BESIDE the target first, never straight onto it. The download lives in the
// data dir, which can be a different filesystem from the folder the user keeps the image
// in, and a rename is atomic only within one. Written in place, a copy that stopped half
// way (disk full, a kill) would leave a truncated image under the only name the user
// starts git-updater by. With the rename last, that name always holds a complete image:
// the old one until the instant it holds the new one.
//
// The mode is taken from the old image rather than set to 755. A downloaded file arrives
// with no execute bit at all, and an image that is not executable does not start; but the
// user's own choice (700 in a private folder) should survive too. Owner-execute is forced
// on regardless, since the file was running a moment ago.
//
// The fsync is there because this is the one self-update path with no second copy: the
// launcher model keeps the old version on disk, this replaces it. Without it a power cut
// shortly after the rename can leave the name pointing at data that never reached the
// disk. That is the general zero-length-file-after-rename hazard, not a failure seen here.
function replaceAppImage(src, target, opts = {}) {
  const rename = opts.rename || fs.renameSync;
  const tmp = path.join(path.dirname(target), `${APPIMAGE_NEW_PREFIX}${process.pid}`);
  try {
    const mode = (fs.statSync(target).mode & 0o777) | 0o100;
    fs.copyFileSync(src, tmp);
    // Opened before the mode is applied: an image the user keeps read-only (555) would
    // otherwise make its own replacement unopenable for the flush.
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    rename(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// What the AppImage runtime and electron-builder's AppRun script add to the environment,
// taken out again before the replaced image is started. Checked against the runtime binary
// electron-builder embeds and the AppRun it generates (app-builder-lib, appImageUtil.js).
//
// Set by the runtime, each describing the image that is about to go away:
//   APPIMAGE  path of the image file
//   APPDIR    where it is mounted (/tmp/.mount_*) or extracted (/tmp/appimage_extracted_*)
//   ARGV0     the name it was started by
//   OWD       the working directory it was started from
// The new image's runtime sets all four again for itself, so dropping them changes nothing
// when all goes well. It is there so the new process can never be pointed at the OLD mount
// by them: AppRun trusts an inherited $APPDIR and execs the binary inside it.
//
// Prepended to by AppRun, with entries inside $APPDIR:
//   PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS, GSETTINGS_SCHEMA_DIR
// AppRun only ever prepends, so without this every self-update would leave one more dead
// /tmp/.mount_* entry in each list, inherited by the new git-updater and by every app it
// opens afterwards. Only the entries inside the old mount are removed; the user's own stay.
//
// One variable is ADDED. The runtime needs libfuse2 to mount the image, which current
// Ubuntu does not install (see the note in src/platform/assets.js); without it the image
// only runs when told to extract itself, by APPIMAGE_EXTRACT_AND_RUN=1 or by the
// --appimage-extract-and-run flag. The variable is inherited by the relaunch, but the flag
// is consumed by the runtime and never reaches this process, so a run started with the
// flag would update, exit and then fail to come back, on a libfuse error nobody sees. An
// extracted run is recognisable by where $APPDIR is, and gets the variable so it returns
// the same way it was started.
const APPIMAGE_RUNTIME_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'];
const APPRUN_PATH_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

function relaunchEnv(env = process.env) {
  const out = { ...env };
  const appDir = env.APPDIR ? String(env.APPDIR).replace(/\/+$/, '') : '';
  for (const k of APPIMAGE_RUNTIME_VARS) delete out[k];
  if (!appDir) return out;
  for (const k of APPRUN_PATH_LISTS) {
    if (out[k] == null) continue;
    const kept = String(out[k]).split(':').filter((p) => p && p !== appDir && !p.startsWith(`${appDir}/`));
    if (kept.length) out[k] = kept.join(':');
    else delete out[k];
  }
  if (/^appimage_extracted_/.test(path.posix.basename(appDir)) && !out.APPIMAGE_EXTRACT_AND_RUN) out.APPIMAGE_EXTRACT_AND_RUN = '1';
  return out;
}

// The launcher restarts the app into the newest version once this process is gone. An
// AppImage has no launcher folder: the image file, already replaced, is started again at
// the same path, and --wait-pid makes it wait for this process exactly as the launcher does.
function relaunchViaLauncher(root, pid, opts = {}) {
  const img = appImageFile(opts);
  if (img) {
    const start = opts.spawn || spawn;
    start(img, ['--wait-pid', String(pid)], { detached: true, stdio: 'ignore', env: relaunchEnv(runCtx(opts).env) }).unref();
    return;
  }
  launch(root, ['--wait-pid', String(pid)]);
}

// --- post-relaunch version check ----------------------------------------------

// `quiet` marks an unattended (scheduled) update: the new process should come back the way the old
// one was (hidden in the tray, or minimized) instead of putting a window on screen. See takeQuietRestart.
function writeApplyMarker({ expectVersion, quiet = false }) {
  try {
    fs.mkdirSync(SELF_ROOT, { recursive: true });
    fs.writeFileSync(APPLY_MARKER, JSON.stringify({ expectVersion, appliedAt: new Date().toISOString(), quiet: !!quiet }));
  } catch {}
}

// How long after an update a quiet restart still counts. A later, manual launch is never one.
const QUIET_RESTART_MS = 5 * 60 * 1000;

// Called once at startup by the NEW process. Returns { expectVersion, ok } when this start follows a
// quiet self-update, otherwise null. One-shot: it clears the quiet flag but leaves the rest of the
// marker for consumeApplyMarker (the window's own version check) to read later.
function takeQuietRestart(actualVersion, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(APPLY_MARKER, 'utf8'));
  } catch {
    return null;
  }
  if (!data || !data.quiet || !data.expectVersion) return null;
  try {
    fs.writeFileSync(APPLY_MARKER, JSON.stringify({ ...data, quiet: false }));
  } catch {}
  const age = now - Date.parse(data.appliedAt);
  if (!(age >= 0 && age <= QUIET_RESTART_MS)) return null;
  return { expectVersion: data.expectVersion, ok: core.normTag(actualVersion) === core.normTag(data.expectVersion) };
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
// start), any stage dir (only ever live during an update in THIS process), and day-old
// downloads. Run from an AppImage there are no app-* folders; what an interrupted update
// can leave is the half-written new image beside the real one (replaceAppImage), about
// 150 MB in whatever folder the user keeps the image in, so that is removed here too.
async function cleanupLeftovers(root, currentVersion, opts = {}) {
  const dayAgo = Date.now() - DAY_MS;
  const sweep = (dir, matches, minAgeMs) => {
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
        if (!minAgeMs || fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  };
  await withoutAsar(async () => {
    for (const v of listVersions(root)) {
      if (core.cmpVersion(v.version, currentVersion) >= 0) continue;
      try {
        fs.rmSync(v.dir, { recursive: true, force: true });
      } catch {}
    }
    sweep(root, (name) => name.startsWith(STAGE_PREFIX), 0);
  });
  sweep(SELF_ROOT, (name) => name !== path.basename(APPLY_MARKER), DAY_MS);
  const img = appImageFile(opts);
  if (img) sweep(path.dirname(img), (name) => name.startsWith(APPIMAGE_NEW_PREFIX), 0);
}

module.exports = {
  selfUpdateAssets,
  appImageFile,
  appImageReplaceable,
  appImageAsset,
  replaceAppImage,
  relaunchEnv,
  REPO: { owner: REPO_OWNER, repo: REPO_NAME },
  canApply,
  makeExecutable,
  moveIntoPlace,
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
  takeQuietRestart,
  QUIET_RESTART_MS,
  cleanupLeftovers,
};
