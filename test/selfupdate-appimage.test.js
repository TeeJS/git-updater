'use strict';

// Self-update when git-updater is RUNNING FROM an AppImage.
//
// The launcher model writes app-<version>/ beside the running executable. Run as an
// AppImage that executable is inside /tmp/.mount_*, a read-only squashfs mount, so the
// update failed with EROFS — and the mount is gone when the process exits anyway. The
// image FILE ($APPIMAGE) is what gets replaced instead.
//
// Ported from PlayingKarrde/git-updater 755649b and extended. No AppImage can run on the
// hosts these tests run on, so a run is DESCRIBED rather than performed: every function
// takes { env, platform, execPath, arch }, and the image and its mount are plain files in
// a temp folder.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// selfupdate.js computes its storage root at require-time — point it at an isolated
// temp dir BEFORE requiring so these tests never touch the real one, on any host.
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-selfupdate-appimage-'));
process.env.GITUPDATER_DATA_DIR = path.join(FAKE, 'git-updater');

const { test, after } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');
const github = require('../src/github');
const selfupdate = require('../src/selfupdate');

after(() => fs.rmSync(FAKE, { recursive: true, force: true }));

// Mode bits mean nothing on Windows, and root passes every permission check.
const POSIX = process.platform !== 'win32';
const IS_ROOT = POSIX && typeof process.getuid === 'function' && process.getuid() === 0;

// Every AppImage starts with an ELF header; prepareUpdate refuses a download without one.
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const image = (text) => Buffer.concat([ELF, Buffer.from(text)]);
const OLD = image('git-updater 0.3.0');
const NEW = image('git-updater 9.9.9');
const sha256 = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

// One AppImage run: the image in a folder the user keeps it in, and the mount the
// AppImage runtime would have made for it, with the app's executable inside.
function appImageRun({ arch = 'x64', mode = 0o755 } = {}) {
  const base = fs.mkdtempSync(path.join(FAKE, 'run-'));
  const dir = path.join(base, 'Applications');
  const mount = path.join(base, '.mount_git-upAbC123'); // stands in for /tmp/.mount_git-upXXXXXX
  fs.mkdirSync(dir);
  fs.mkdirSync(mount);
  const img = path.join(dir, 'git-updater-0.3.0-linux-x86_64.AppImage');
  fs.writeFileSync(img, OLD);
  fs.chmodSync(img, mode);
  const execPath = path.join(mount, 'git-updater');
  fs.writeFileSync(execPath, 'electron');
  return { base, dir, mount, img, opts: { platform: 'linux', arch, execPath, env: { APPIMAGE: img, APPDIR: mount } } };
}

// What our Linux release publishes (docs/RELEASING.md), plus the Windows zips beside them.
const RELEASE_ASSETS = [
  'git-updater-9.9.9-linux-x64.tar.gz',
  'git-updater-9.9.9-linux-arm64.tar.gz',
  'git-updater-9.9.9-linux-x86_64.AppImage',
  'git-updater-9.9.9-linux-arm64.AppImage',
  'git-updater-9.9.9-x64.zip',
  'git-updater-9.9.9-arm64.zip',
];
const urlOf = (name) => `https://example.invalid/${name}`;

// Stand in for GitHub: one release, and a download that writes `body`. Everything else in
// prepareUpdate — including the real digest check — runs as shipped.
async function withRelease({ names = RELEASE_ASSETS, body = NEW, digest = sha256(NEW) }, fn) {
  const real = { getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset, fetchChecksumFromRelease: github.fetchChecksumFromRelease };
  const seen = { releaseOpts: null, url: null, maxBytes: undefined, downloads: 0 };
  github.getLatestRelease = async (_owner, _repo, opts) => {
    seen.releaseOpts = opts;
    return { tag_name: 'v9.9.9', assets: names.map((name) => ({ name, browser_download_url: urlOf(name), ...(digest ? { digest } : {}) })) };
  };
  github.downloadAsset = async (url, file, _onProgress, maxBytes) => {
    seen.url = url;
    seen.maxBytes = maxBytes;
    seen.downloads++;
    fs.writeFileSync(file, body);
  };
  github.fetchChecksumFromRelease = async () => null;
  try {
    return await fn(seen);
  } finally {
    Object.assign(github, real);
  }
}

// --- is this an AppImage run at all? ---------------------------------------------

test('appImageFile: only on Linux, only with $APPIMAGE, only when our own executable is inside $APPDIR', () => {
  const run = appImageRun();
  assert.equal(selfupdate.appImageFile(run.opts), run.img);

  // No $APPIMAGE: the tarball install, which keeps the launcher model.
  assert.equal(selfupdate.appImageFile({ ...run.opts, env: {} }), null);
  assert.equal(selfupdate.appImageFile({ ...run.opts, env: { APPDIR: run.mount } }), null);
  // The variable means nothing off Linux.
  assert.equal(selfupdate.appImageFile({ ...run.opts, platform: 'win32' }), null);
  assert.equal(selfupdate.appImageFile({ ...run.opts, platform: 'darwin' }), null);
  // Not a path the runtime would have written.
  assert.equal(selfupdate.appImageFile({ ...run.opts, env: { APPIMAGE: 'git-updater.AppImage', APPDIR: run.mount } }), null);
});

test('appImageFile: an $APPIMAGE inherited from ANOTHER app is not ours to replace', () => {
  // git-updater installed from the tarball, started from the terminal of an editor that is
  // itself an AppImage: the editor's runtime variables are in our environment.
  const editor = appImageRun();
  const ours = path.join(editor.base, 'git-updater', 'app-0.3.0', 'git-updater');
  fs.mkdirSync(path.dirname(ours), { recursive: true });
  fs.writeFileSync(ours, 'electron');
  const leaked = { ...editor.opts, execPath: ours };

  assert.equal(selfupdate.appImageFile(leaked), null);
  assert.equal(selfupdate.canApply(leaked), true, 'still an ordinary launcher-model install');
  // And without $APPDIR there is nothing to prove it with, so it is not trusted either.
  assert.equal(selfupdate.appImageFile({ ...editor.opts, env: { APPIMAGE: editor.img } }), null);
});

test('canApply: an AppImage in a writable folder updates; other platforms are exactly as before', () => {
  const run = appImageRun();
  assert.equal(selfupdate.canApply(run.opts), true);
  assert.equal(selfupdate.canApply({ platform: 'linux', env: {} }), true, 'tarball install on Linux');
  assert.equal(selfupdate.canApply({ platform: 'win32', env: {} }), true);
  assert.equal(selfupdate.canApply({ platform: 'win32', env: run.opts.env, execPath: run.opts.execPath }), true, '$APPIMAGE is ignored on Windows');
  assert.equal(selfupdate.canApply({ platform: 'darwin', env: {} }), false);
  assert.equal(selfupdate.canApply({ platform: 'darwin', env: run.opts.env, execPath: run.opts.execPath }), false);
});

// --- which file ------------------------------------------------------------------

test('appImageAsset: the AppImage for this architecture, never a tarball', () => {
  const assets = RELEASE_ASSETS.map((name) => ({ name }));
  assert.equal(selfupdate.appImageAsset(assets, 'x64').name, 'git-updater-9.9.9-linux-x86_64.AppImage');
  assert.equal(selfupdate.appImageAsset(assets, 'arm64').name, 'git-updater-9.9.9-linux-arm64.AppImage');
});

test('appImageAsset: the tarball install still gets the tarball from the same release', () => {
  // The two choices are opposites and must stay so: this is the line prepareUpdate uses
  // when $APPIMAGE is not set.
  const assets = RELEASE_ASSETS.map((name) => ({ name }));
  assert.equal(core.pickAsset(selfupdate.selfUpdateAssets(assets), 'portable', 'x64', null, 'linux').name, 'git-updater-9.9.9-linux-x64.tar.gz');
  assert.equal(core.pickAsset(selfupdate.selfUpdateAssets(assets), 'portable', 'arm64', null, 'linux').name, 'git-updater-9.9.9-linux-arm64.tar.gz');
});

test('appImageAsset: a release without an AppImage for this machine is refused, not approximated', () => {
  assert.throws(() => selfupdate.appImageAsset([{ name: 'git-updater-9.9.9-linux-x64.tar.gz' }], 'x64'), /no AppImage/);
  // The picker alone would return the x86_64 image here (it only penalises the wrong
  // architecture), and it would then be renamed over the user's only copy.
  const x64Only = [{ name: 'git-updater-9.9.9-linux-x86_64.AppImage' }];
  assert.equal(core.pickAsset(x64Only, 'portable', 'arm64', null, 'linux').name, 'git-updater-9.9.9-linux-x86_64.AppImage');
  assert.throws(() => selfupdate.appImageAsset(x64Only, 'arm64'), /no AppImage for arm64/);
  assert.throws(() => selfupdate.appImageAsset([{ name: 'git-updater-9.9.9-linux-arm64.AppImage' }], 'x64'), /no AppImage for x64/);
});

// --- replacing the file ----------------------------------------------------------

test('replaceAppImage: written beside the image, then renamed over it — never written in place', () => {
  const run = appImageRun();
  const src = path.join(run.base, 'download.AppImage');
  fs.writeFileSync(src, NEW); // a download has no execute bit
  let renamed = null;
  const rename = (from, to) => {
    // The moment of the swap: the new image is complete and executable under a temporary
    // name in the SAME folder (so the rename cannot cross filesystems), and the name the
    // user starts git-updater by still holds the whole old image.
    renamed = { from, to };
    assert.equal(path.dirname(from), run.dir);
    assert.notEqual(from, run.img);
    assert.deepEqual(fs.readFileSync(from), NEW);
    assert.deepEqual(fs.readFileSync(run.img), OLD);
    if (POSIX) assert.equal(fs.statSync(from).mode & 0o111, 0o111, 'executable before it takes the name');
    fs.renameSync(from, to);
  };
  selfupdate.replaceAppImage(src, run.img, { rename });

  assert.equal(renamed.to, run.img);
  assert.deepEqual(fs.readFileSync(run.img), NEW);
  assert.deepEqual(fs.readdirSync(run.dir), [path.basename(run.img)], 'no temporary file left beside it');
  assert.ok(fs.existsSync(src), 'the download is copied, not moved; the caller removes it');
});

test('replaceAppImage: the new image keeps the old one\'s mode, and is always executable', { skip: !POSIX }, () => {
  const priv = appImageRun({ mode: 0o700 });
  const src = path.join(priv.base, 'download.AppImage');
  fs.writeFileSync(src, NEW, { mode: 0o644 });
  selfupdate.replaceAppImage(src, priv.img);
  assert.equal(fs.statSync(priv.img).mode & 0o777, 0o700, 'not widened to 755');

  const usual = appImageRun({ mode: 0o755 });
  selfupdate.replaceAppImage(src, usual.img);
  assert.equal(fs.statSync(usual.img).mode & 0o777, 0o755);

  // A read-only image is still replaced (that needs the folder, not the file), and stays read-only.
  const readOnly = appImageRun({ mode: 0o555 });
  selfupdate.replaceAppImage(src, readOnly.img);
  assert.deepEqual(fs.readFileSync(readOnly.img), NEW);
  assert.equal(fs.statSync(readOnly.img).mode & 0o777, 0o555);

  // An image somebody chmod -x'd while it was running must still come back startable.
  const odd = appImageRun({ mode: 0o644 });
  selfupdate.replaceAppImage(src, odd.img);
  assert.equal(fs.statSync(odd.img).mode & 0o777, 0o744);
});

test('replaceAppImage: a rename that fails leaves the old image whole and no temporary file', () => {
  const run = appImageRun();
  const src = path.join(run.base, 'download.AppImage');
  fs.writeFileSync(src, NEW);
  const rename = () => { throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' }); };
  assert.throws(() => selfupdate.replaceAppImage(src, run.img, { rename }), /EACCES/);
  assert.deepEqual(fs.readFileSync(run.img), OLD);
  assert.deepEqual(fs.readdirSync(run.dir), [path.basename(run.img)]);
});

// --- starting it again -------------------------------------------------------------

test('relaunchEnv: the runtime\'s four variables are dropped, and only the old mount leaves the path lists', () => {
  const mount = '/tmp/.mount_git-upAbC123';
  const env = selfupdate.relaunchEnv({
    // Set by the AppImage runtime for the image being replaced.
    APPIMAGE: '/home/u/Applications/git-updater-0.3.0-linux-x86_64.AppImage',
    APPDIR: mount,
    ARGV0: './git-updater-0.3.0-linux-x86_64.AppImage',
    OWD: '/home/u/Applications',
    // Prepended to by electron-builder's AppRun.
    PATH: `${mount}:${mount}/usr/sbin:/usr/local/bin:/usr/bin`,
    LD_LIBRARY_PATH: `${mount}/usr/lib`,
    XDG_DATA_DIRS: `${mount}/usr/share/:/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/`,
    GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas:/home/u/.local/share/glib-2.0/schemas`,
    // The user's own, including a folder that merely starts with the same characters.
    HOME: '/home/u',
    DISPLAY: ':0',
    PYTHONPATH: `${mount}X/lib`,
    APPIMAGE_EXTRACT_AND_RUN: '1',
  });
  assert.deepEqual(env, {
    PATH: '/usr/local/bin:/usr/bin',
    // LD_LIBRARY_PATH held nothing but the mount, so it is unset rather than left empty:
    // an empty entry there means "the current directory".
    XDG_DATA_DIRS: '/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/',
    GSETTINGS_SCHEMA_DIR: '/home/u/.local/share/glib-2.0/schemas',
    HOME: '/home/u',
    DISPLAY: ':0',
    PYTHONPATH: `${mount}X/lib`,
    // Without libfuse2 this is the only way the image runs at all; losing it would mean
    // the update applies and the app never comes back.
    APPIMAGE_EXTRACT_AND_RUN: '1',
  });
});

test('relaunchEnv: a sibling mount with a longer name is not mistaken for ours', () => {
  const env = selfupdate.relaunchEnv({ APPDIR: '/tmp/.mount_abc', PATH: '/tmp/.mount_abc:/tmp/.mount_abcdef/bin:/usr/bin' });
  assert.deepEqual(env, { PATH: '/tmp/.mount_abcdef/bin:/usr/bin' });
});

test('relaunchEnv: a run started with --appimage-extract-and-run comes back the same way', () => {
  // The flag is consumed by the runtime and is not in our argv; the extracted folder's
  // name is the only trace of it. A mounted run must NOT get the variable.
  const extracted = selfupdate.relaunchEnv({ APPIMAGE: '/home/u/gu.AppImage', APPDIR: '/tmp/appimage_extracted_0123abcd', PATH: '/tmp/appimage_extracted_0123abcd:/usr/bin' });
  assert.deepEqual(extracted, { PATH: '/usr/bin', APPIMAGE_EXTRACT_AND_RUN: '1' });
  const mounted = selfupdate.relaunchEnv({ APPIMAGE: '/home/u/gu.AppImage', APPDIR: '/tmp/.mount_git-upAbC123', PATH: '/usr/bin' });
  assert.equal('APPIMAGE_EXTRACT_AND_RUN' in mounted, false);
});

test('relaunchEnv: outside an AppImage nothing is touched', () => {
  const env = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/lib', HOME: '/home/u' };
  assert.deepEqual(selfupdate.relaunchEnv(env), env);
});

test('relaunchViaLauncher: an AppImage restarts its own file, detached, with the cleaned environment', () => {
  // Literal Linux paths, not temp files: the lists are split on ':', and a Windows temp
  // path has one after its drive letter. Nothing here needs the files to exist.
  const img = '/home/u/Applications/git-updater-0.3.0-linux-x86_64.AppImage';
  const mount = '/tmp/.mount_git-upAbC123';
  const env = { APPIMAGE: img, APPDIR: mount, ARGV0: 'gu', OWD: '/home/u', PATH: `${mount}:/usr/bin`, HOME: '/home/u' };
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { unref() { calls[calls.length - 1].unref = true; } };
  };
  selfupdate.relaunchViaLauncher(mount, 4242, { platform: 'linux', execPath: `${mount}/git-updater`, env, spawn });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, img, 'the image file, not the executable inside the mount that is about to vanish');
  assert.deepEqual(calls[0].args, ['--wait-pid', '4242']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].unref, true);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin', HOME: '/home/u' });
});

// --- the whole update ----------------------------------------------------------------

test('prepareUpdate: from an AppImage, the image file is replaced and the mount is never written to', async () => {
  const run = appImageRun();
  await withRelease({}, async (seen) => {
    const phases = [];
    const r = await selfupdate.prepareUpdate(run.mount, '0.3.0', (phase) => phases.push(phase), { ...run.opts, prerelease: true, maxBytes: 1234 });

    assert.equal(seen.url, urlOf('git-updater-9.9.9-linux-x86_64.AppImage'));
    assert.deepEqual(r, { tag: '9.9.9', dir: run.dir, appImage: run.img });
    assert.deepEqual(fs.readFileSync(run.img), NEW);
    if (POSIX) assert.equal(fs.statSync(run.img).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(run.dir), [path.basename(run.img)], 'same path, nothing left beside it');
    assert.deepEqual(fs.readdirSync(run.mount), ['git-updater'], 'nothing staged in the mount');
    assert.deepEqual(phases.filter((p, i) => phases.indexOf(p) === i), ['downloading', 'verifying', 'installing']);
    // The settings that guard every other self-update guard this one too.
    assert.deepEqual(seen.releaseOpts, { prerelease: true }, 'the beta channel setting reaches the release lookup');
    assert.equal(seen.maxBytes, 1234, 'the download size limit reaches the download');
    assert.equal(fs.existsSync(path.join(process.env.GITUPDATER_DATA_DIR, 'self-update', '9.9.9')), false, 'the download is cleaned up');
  });
});

test('prepareUpdate: an arm64 AppImage gets the arm64 image', async () => {
  const run = appImageRun({ arch: 'arm64' });
  await withRelease({}, async (seen) => {
    await selfupdate.prepareUpdate(run.mount, '0.3.0', () => {}, run.opts);
    assert.equal(seen.url, urlOf('git-updater-9.9.9-linux-arm64.AppImage'));
  });
});

test('prepareUpdate: without $APPIMAGE the AppImage is never the file downloaded', async () => {
  // The tarball install. Its own path is unchanged and extracts a real archive, which this
  // does not attempt: the download is made to stop the run once the choice is visible.
  // (Which archive the picker takes depends on the host the suite runs on; that it is not
  // the AppImage, and that a stray image nearby is not touched, does not.)
  const run = appImageRun();
  const root = path.join(run.base, 'install');
  fs.mkdirSync(root);
  await withRelease({}, async (seen) => {
    github.downloadAsset = async (url) => { seen.url = url; throw new Error('stop here'); };
    await assert.rejects(selfupdate.prepareUpdate(root, '0.3.0', () => {}, { platform: 'linux', arch: 'x64', env: {}, execPath: path.join(root, 'git-updater') }));
    assert.doesNotMatch(String(seen.url), /\.AppImage$/i);
    if (process.platform === 'linux') assert.match(String(seen.url), /-linux-(x64|arm64)\.tar\.gz$/);
    assert.deepEqual(fs.readFileSync(run.img), OLD);
  });
});

test('prepareUpdate: a checksum mismatch leaves the old AppImage exactly as it was', async () => {
  const run = appImageRun({ mode: 0o750 });
  const before = fs.statSync(run.img);
  await withRelease({ digest: sha256(image('what the release says it should be')) }, async (seen) => {
    await assert.rejects(selfupdate.prepareUpdate(run.mount, '0.3.0', () => {}, run.opts), /checksum mismatch/);
    assert.equal(seen.downloads, 1, 'it was downloaded, and then refused');
  });
  const now = fs.statSync(run.img);
  assert.deepEqual(fs.readFileSync(run.img), OLD);
  assert.equal(now.ino, before.ino, 'the same file, not a replacement with the same bytes');
  assert.equal(now.mode, before.mode);
  assert.deepEqual(fs.readdirSync(run.dir), [path.basename(run.img)], 'nothing was written beside it');
});

test('prepareUpdate: a download that is not an executable image never replaces the AppImage', async () => {
  // A release with no digest and no checksums file is only warned about, so this is what
  // stands between an error page saved under the asset's name and the user's only copy.
  const run = appImageRun();
  await withRelease({ body: Buffer.from('<html>Bad gateway</html>'), digest: null }, async () => {
    await assert.rejects(selfupdate.prepareUpdate(run.mount, '0.3.0', () => {}, run.opts), /not an AppImage/);
  });
  assert.deepEqual(fs.readFileSync(run.img), OLD);
  assert.deepEqual(fs.readdirSync(run.dir), [path.basename(run.img)]);
});

test('prepareUpdate: a release with no AppImage for this architecture is refused before anything is downloaded', async () => {
  const run = appImageRun({ arch: 'arm64' });
  const names = RELEASE_ASSETS.filter((n) => n !== 'git-updater-9.9.9-linux-arm64.AppImage');
  await withRelease({ names }, async (seen) => {
    await assert.rejects(selfupdate.prepareUpdate(run.mount, '0.3.0', () => {}, run.opts), /no AppImage for arm64/);
    assert.equal(seen.downloads, 0);
  });
  assert.deepEqual(fs.readFileSync(run.img), OLD);
});

// --- an AppImage that cannot be replaced where it is -----------------------------------

// The folder check goes through fs.accessSync, so refusing it there describes a folder the
// user cannot write on any host, including Windows and a suite run as root.
async function withUnwritable(dir, fn) {
  const real = fs.accessSync;
  fs.accessSync = (p, mode) => {
    if (path.resolve(String(p)) === path.resolve(dir)) throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: 'EACCES' });
    return real(p, mode);
  };
  try {
    return await fn();
  } finally {
    fs.accessSync = real;
  }
}

test('unwritable folder: the update is reported (canApply false), not applied and not attempted', async () => {
  const run = appImageRun();
  await withUnwritable(run.dir, async () => {
    assert.equal(selfupdate.appImageFile(run.opts), run.img, 'still recognised as an AppImage run');
    // electron/main.js sends this to the window as { version, canApply: false }, which is
    // what turns the header button into "Download <version>" (the release page).
    assert.equal(selfupdate.canApply(run.opts), false);
    await withRelease({}, async (seen) => {
      await assert.rejects(selfupdate.prepareUpdate(run.mount, '0.3.0', () => {}, run.opts), /cannot be replaced where it is.*release page/);
      assert.equal(seen.releaseOpts, null, 'refused before any network request');
      assert.equal(seen.downloads, 0);
    });
  });
  assert.deepEqual(fs.readFileSync(run.img), OLD);
});

test('unwritable folder: a real read-only directory is detected', { skip: !POSIX || IS_ROOT }, () => {
  const run = appImageRun();
  fs.chmodSync(run.dir, 0o555);
  try {
    assert.equal(selfupdate.appImageReplaceable(run.img), false);
    assert.equal(selfupdate.canApply(run.opts), false);
  } finally {
    fs.chmodSync(run.dir, 0o755);
  }
  assert.equal(selfupdate.canApply(run.opts), true);
});

test('an AppImage that was moved or deleted while running is reported, not recreated at the old path', () => {
  const run = appImageRun();
  fs.rmSync(run.img);
  assert.equal(selfupdate.appImageFile(run.opts), run.img, 'still an AppImage run, so never the launcher model');
  assert.equal(selfupdate.canApply(run.opts), false);
});

// --- startup cleanup ---------------------------------------------------------------------

test('cleanupLeftovers: a half-written image from an interrupted update is removed; the user\'s files are not', async () => {
  const run = appImageRun();
  const stale = path.join(run.dir, '.git-updater-selfupdate-appimage-4242');
  const other = path.join(run.dir, 'Some-Other-App.AppImage');
  fs.writeFileSync(stale, 'half an image');
  fs.writeFileSync(other, 'not ours');
  await selfupdate.cleanupLeftovers(run.mount, '0.3.0', run.opts);
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(fs.readFileSync(run.img), OLD);
  assert.ok(fs.existsSync(other));
  assert.deepEqual(fs.readdirSync(run.mount), ['git-updater']);
});
