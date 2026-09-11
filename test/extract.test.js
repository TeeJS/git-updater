'use strict';

// Archive extraction across formats, and the thing that silently breaks a port:
// Unix permission bits. A Linux or macOS build that extracts without its executable
// bit reports a successful update and then refuses to launch, so these assert the
// modes explicitly rather than just the file list.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const tar = require('../src/tar');
const install = require('../src/install');

const isWin = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-test-'));

// Windows only allows symlink creation with Developer Mode or elevation, so the
// symlink-containment tests probe for it rather than assuming either way.
const canSymlink = (() => {
  const d = tmp();
  try {
    fs.symlinkSync(os.tmpdir(), path.join(d, 'probe'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

// --- a minimal tar writer, so the fixtures are real archives ------------------

const BLOCK = 512;

function tarHeader({ name, size = 0, mode = 0o644, type = '0', linkname = '' }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'latin1');
  h.write('0000000\0', 108, 8, 'latin1'); // uid
  h.write('0000000\0', 116, 8, 'latin1'); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  h.write('00000000000\0', 136, 12, 'latin1'); // mtime
  h.write('        ', 148, 8, 'latin1'); // checksum field is spaces while summing
  h.write(type, 156, 1, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const body = e.body == null ? Buffer.alloc(0) : Buffer.from(e.body);
    parts.push(tarHeader({ ...e, size: body.length }));
    if (body.length) {
      parts.push(body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  return Buffer.concat(parts);
}

// --- tar ---------------------------------------------------------------------

test('tar: extracts files and directories with their contents', () => {
  const dir = tmp();
  try {
    const buf = makeTar([
      { name: 'app/', type: '5', mode: 0o755 },
      { name: 'app/README', body: 'hello', mode: 0o644 },
      { name: 'app/bin/run', body: '#!/bin/sh\n', mode: 0o755 },
    ]);
    const written = tar.extractTarBuffer(buf, dir);
    assert.equal(fs.readFileSync(path.join(dir, 'app/README'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dir, 'app/bin/run'), 'utf8'), '#!/bin/sh\n');
    assert.deepEqual(written.map((e) => e.path.replace(/\\/g, '/')).sort(), ['app/README', 'app/bin/run']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: the executable bit is read off the header, and applied where the OS has one', () => {
  const dir = tmp();
  try {
    const written = tar.extractTarBuffer(
      makeTar([
        { name: 'run.sh', body: '#!/bin/sh\n', mode: 0o755 },
        { name: 'data.txt', body: 'x', mode: 0o644 },
      ]),
      dir
    );
    // Header parsing is platform-independent, so it is asserted on EVERY host; only
    // applying the bits is POSIX-only. Gating the whole test on the OS is exactly what
    // let the other fixtures in this suite go unnoticed while verifying nothing.
    assert.deepEqual(
      written.map((e) => [e.path, e.mode.toString(8)]).sort(),
      [['data.txt', '644'], ['run.sh', '755']]
    );
    if (isWin) return; // no mode bits on the filesystem to check against
    assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(dir, 'data.txt')).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: path traversal entries are dropped, the rest still extract', () => {
  const dir = tmp();
  const outside = path.join(dir, 'outside.txt');
  try {
    const inner = path.join(dir, 'inner');
    fs.mkdirSync(inner);
    tar.extractTarBuffer(
      makeTar([
        { name: '../outside.txt', body: 'pwned' },
        { name: '/etc/passwd', body: 'pwned' },
        { name: 'safe.txt', body: 'ok' },
      ]),
      inner
    );
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.readFileSync(path.join(inner, 'safe.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: GNU long names are applied to the entry that follows', () => {
  const dir = tmp();
  const long = 'a-very/deeply/nested/' + 'x'.repeat(120) + '/file.txt';
  try {
    tar.extractTarBuffer(
      makeTar([
        { name: '././@LongLink', type: 'L', body: long + '\0' },
        { name: 'truncated-placeholder', body: 'content' },
      ]),
      dir
    );
    assert.equal(fs.readFileSync(path.join(dir, long), 'utf8'), 'content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: symlinks are recreated, not flattened into copies', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const dir = tmp();
  try {
    tar.extractTarBuffer(
      makeTar([
        { name: 'Versions/A/', type: '5', mode: 0o755 },
        { name: 'Versions/A/lib', body: 'real', mode: 0o644 },
        { name: 'Versions/Current', type: '2', linkname: 'A' },
      ]),
      dir
    );
    const st = fs.lstatSync(path.join(dir, 'Versions/Current'));
    assert.ok(st.isSymbolicLink());
    assert.equal(fs.readlinkSync(path.join(dir, 'Versions/Current')), 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: a .tar.gz on disk is gunzipped transparently', () => {
  const dir = tmp();
  try {
    const gz = path.join(dir, 'app-1.0-linux-x86_64.tar.gz');
    fs.writeFileSync(gz, zlib.gzipSync(makeTar([{ name: 'app/run', body: 'go', mode: 0o755 }])));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    tar.extractTar(gz, out);
    assert.equal(fs.readFileSync(path.join(out, 'app/run'), 'utf8'), 'go');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- extractArchive dispatch -------------------------------------------------

test('extractArchive: a tarball flattens its wrapper folder like a zip does', async () => {
  const dir = tmp();
  try {
    const tgz = path.join(dir, 'deskflow-1.26.0-linux.tar.gz');
    fs.writeFileSync(
      tgz,
      zlib.gzipSync(
        makeTar([
          { name: 'deskflow-1.26.0/', type: '5', mode: 0o755 },
          { name: 'deskflow-1.26.0/deskflow', body: 'bin', mode: 0o755 },
          { name: 'deskflow-1.26.0/README', body: 'doc', mode: 0o644 },
        ])
      )
    );
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    const { files, srcDir } = await install.extractArchive(tgz, stage);
    assert.deepEqual(files.map((f) => f.replace(/\\/g, '/')).sort(), ['README', 'deskflow']);
    assert.equal(fs.readFileSync(path.join(srcDir, 'deskflow'), 'utf8'), 'bin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractArchive: a bare AppImage is placed AND made executable', async () => {
  const dir = tmp();
  try {
    const img = path.join(dir, 'app-1.0-x86_64.AppImage');
    fs.writeFileSync(img, 'ELF-ish payload', { mode: 0o644 });
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    const { files, srcDir } = await install.extractArchive(img, stage);
    assert.deepEqual(files, ['app-1.0-x86_64.AppImage']);
    if (!isWin) {
      assert.equal(fs.statSync(path.join(srcDir, files[0])).mode & 0o111, 0o111);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractArchive: zip entries keep the executable bit recorded in the archive', async () => {
  const dir = tmp();
  try {
    // addFile's 4th argument does NOT reach the external-attributes field, so a fixture
    // built that way records mode 0 and this test passes vacuously. Set the field itself.
    const zip = new AdmZip();
    zip.addFile('bin/run', Buffer.from('#!/bin/sh\n'));
    zip.addFile('data.txt', Buffer.from('x'));
    // The 0o100000 regular-file type bits are what a real archiver writes, so include them
    // rather than the bare permission bits: same masked result, faithful raw field.
    zip.getEntry('bin/run').header.attr = (0o100755 << 16) >>> 0;
    zip.getEntry('data.txt').header.attr = (0o100644 << 16) >>> 0;
    const zipPath = path.join(dir, 'app-linux.zip');
    zip.writeZip(zipPath);
    // Guard the fixture: if a future adm-zip drops the bits again, fail here rather than
    // silently asserting nothing further down.
    assert.equal((new AdmZip(zipPath).getEntry('bin/run').header.attr >>> 16) & 0o7777, 0o755);
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    const { srcDir } = await install.extractArchive(zipPath, stage);

    // Resolution is platform-independent and is asserted on EVERY host; only applying the
    // bits is POSIX-only. restoreZipModes reports what it resolved precisely so this test
    // cannot go quiet on Windows the way it did before.
    const resolved = install.restoreZipModes(zipPath, srcDir);
    assert.deepEqual(
      resolved.map((r) => [r.path.replace(/\\/g, '/'), r.mode.toString(8)]).sort(),
      [['bin/run', '755'], ['data.txt', '644']]
    );
    if (isWin) return; // no mode bits on the filesystem to check against
    assert.equal(fs.statSync(path.join(srcDir, 'bin/run')).mode & 0o111, 0o111);
    assert.equal(fs.statSync(path.join(srcDir, 'data.txt')).mode & 0o111, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- installer sniffing ------------------------------------------------------

test('detectInstallerKind: recognizes the macOS and Linux package formats by magic', () => {
  const dir = tmp();
  try {
    const write = (name, head) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(64, 0)]));
      return p;
    };
    assert.equal(install.detectInstallerKind(write('App.pkg', 'xar!')), 'pkg');
    assert.equal(install.detectInstallerKind(write('app.deb', '!<arch>\n')), 'deb');
    const rpmPath = path.join(dir, 'app.rpm');
    fs.writeFileSync(rpmPath, Buffer.concat([Buffer.from([0xed, 0xab, 0xee, 0xdb]), Buffer.alloc(64, 0)]));
    assert.equal(install.detectInstallerKind(rpmPath), 'rpm');
    // An unrecognizable file is still never guessed at.
    assert.equal(install.detectInstallerKind(write('mystery.exe', 'not a known installer')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- symlink containment (CVE-2026-76845 shape) -------------------------------
// Lexical path checks alone are not enough. If a path component at the destination
// already exists as a symlink pointing outside the extraction root, an archive with
// no "..", no absolute path and nothing else suspicious writes straight through it.

test('tar: never writes through a pre-existing symlinked path component', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'stage');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(dest);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'ORIGINAL');
    fs.symlinkSync(outside, path.join(dest, 'cfg'), 'dir');

    // Innocent-looking entry name — the escape is entirely in the planted symlink.
    tar.extractTarBuffer(makeTar([{ name: 'cfg/keep.txt', body: 'PWNED', mode: 0o644 }]), dest);

    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'ORIGINAL');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('tar: a symlinked component does not let a directory entry escape either', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'stage');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(dest);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, 'cfg'), 'dir');
    tar.extractTarBuffer(makeTar([{ name: 'cfg/sub/', type: '5', mode: 0o755 }]), dest);
    assert.equal(fs.existsSync(path.join(outside, 'sub')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('realContained: accepts paths inside the root and rejects ones reached via a symlink', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'stage');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(dest);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, 'cfg'), 'dir');
    assert.ok(tar.realContained(dest, path.join(dest, 'ok.txt')));
    assert.ok(tar.realContained(dest, path.join(dest, 'new', 'deep', 'ok.txt'))); // not created yet
    assert.equal(tar.realContained(dest, path.join(dest, 'cfg', 'keep.txt')), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('containmentChecker: memoizing one directory does not let a sibling escape', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'stage');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(dest, 'good'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, 'evil'), 'dir');

    const contained = tar.containmentChecker(dest);
    // Warm the cache with a legitimate directory first — the escape must still be
    // rejected afterwards, i.e. the memo is per directory and never a blanket verdict.
    assert.ok(contained(path.join(dest, 'good', 'a.txt')));
    assert.equal(contained(path.join(dest, 'evil', 'a.txt')), null);
    assert.ok(contained(path.join(dest, 'good', 'b.txt'))); // cache hit, still allowed
    assert.equal(contained(path.join(dest, 'evil', 'b.txt')), null); // cache hit, still denied
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- link targets -------------------------------------------------------------
// A .app bundle and every framework inside it is held together by relative symlinks,
// most of them upward. Validating a target against the LINK'S OWN directory rather
// than the extraction root rejects anything containing "..", which drops those links
// and produces a bundle that extracts clean and then fails at first launch.

test('tar: link targets may point upward inside the root, but never out of it', { skip: isWin && !canSymlink && 'needs symlink privilege' }, () => {
  const dir = tmp();
  try {
    tar.extractTarBuffer(
      makeTar([
        { name: 'Contents/Frameworks/', type: '5', mode: 0o755 },
        { name: 'Contents/Frameworks/libfoo.dylib', body: 'REAL', mode: 0o755 },
        { name: 'Contents/MacOS/', type: '5', mode: 0o755 },
        { name: 'Contents/Frameworks/Current', type: '2', linkname: 'libfoo.dylib' },
        { name: 'Contents/MacOS/libfoo.dylib', type: '2', linkname: '../Frameworks/libfoo.dylib' },
        { name: 'Contents/MacOS/deep', type: '2', linkname: '../Frameworks' },
        { name: 'Contents/MacOS/escape', type: '2', linkname: '../../../../../../etc/passwd' },
        { name: 'Contents/MacOS/absolute', type: '2', linkname: '/etc/passwd' },
      ]),
      dir
    );
    const has = (p) => fs.existsSync(path.join(dir, p)) || (() => { try { return !!fs.lstatSync(path.join(dir, p)); } catch { return false; } })();
    assert.ok(has('Contents/Frameworks/Current'), 'same-directory target kept');
    assert.ok(has('Contents/MacOS/libfoo.dylib'), 'upward target inside the root kept');
    assert.ok(has('Contents/MacOS/deep'), 'upward target to a directory kept');
    assert.equal(has('Contents/MacOS/escape'), false, 'target leaving the root dropped');
    assert.equal(has('Contents/MacOS/absolute'), false, 'absolute target dropped');
    // The link is written verbatim so the bundle keeps its own relative form. Windows
    // stores the separators as backslashes, so compare on the normalized form.
    assert.equal(
      fs.readlinkSync(path.join(dir, 'Contents/MacOS/libfoo.dylib')).replace(/\\/g, '/'),
      '../Frameworks/libfoo.dylib'
    );
    assert.equal(fs.readFileSync(path.join(dir, 'Contents/MacOS/libfoo.dylib'), 'utf8'), 'REAL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tar: a hardlink target is resolved against the archive root, not the entry directory', () => {
  const dir = tmp();
  try {
    tar.extractTarBuffer(
      makeTar([
        { name: 'lib/', type: '5', mode: 0o755 },
        { name: 'lib/real.so', body: 'PAYLOAD', mode: 0o755 },
        { name: 'bin/', type: '5', mode: 0o755 },
        { name: 'bin/linked.so', type: '1', linkname: 'lib/real.so' },
      ]),
      dir
    );
    assert.equal(fs.readFileSync(path.join(dir, 'bin/linked.so'), 'utf8'), 'PAYLOAD');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeLinkTarget: upward inside the root resolves, escaping and absolute do not', () => {
  const root = path.resolve('/tmp/stage');
  const linkDir = path.join(root, 'Contents', 'MacOS');
  assert.equal(
    tar.safeLinkTarget(root, linkDir, '../Frameworks/libfoo.dylib'),
    path.join(root, 'Contents', 'Frameworks', 'libfoo.dylib')
  );
  assert.equal(tar.safeLinkTarget(root, linkDir, 'sibling.dylib'), path.join(linkDir, 'sibling.dylib'));
  assert.equal(tar.safeLinkTarget(root, linkDir, '../../../../etc/passwd'), null);
  assert.equal(tar.safeLinkTarget(root, linkDir, '/etc/passwd'), null);
  assert.equal(tar.safeLinkTarget(root, linkDir, ''), null);
});

// --- bundle preservation -------------------------------------------------------
// A macOS application is a DIRECTORY, so the wrapper-folder flattening walks into it
// unless stopped: stage/Foo.app becomes stage/Foo.app/Contents, and what gets installed
// is a Contents folder with no bundle around it. Not a damaged app — no app at all.

const mkbundle = (root, name) => {
  const app = path.join(root, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Foo'), 'bin');
  return app;
};

test('stripDirs: never descends into an .app bundle', () => {
  const dir = tmp();
  try {
    mkbundle(dir, 'Foo.app');
    // The stage holds exactly one directory, which is the payload. Flattening must stop
    // here, so the bundle itself is what gets installed.
    assert.equal(install.stripDirs(dir, Infinity), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripDirs: still flattens a wrapper folder, and stops at the bundle inside it', () => {
  const dir = tmp();
  try {
    const wrapper = path.join(dir, 'Foo-1.2.3-mac');
    fs.mkdirSync(wrapper);
    mkbundle(wrapper, 'Foo.app');
    // One real wrapper level is removed; the bundle beneath it is not.
    assert.equal(install.stripDirs(dir, Infinity), wrapper);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripDirs: the guard covers frameworks and the other bundle kinds too', () => {
  for (const name of ['Foo.framework', 'Foo.bundle', 'Foo.plugin', 'Foo.appex', 'Foo.kext', 'Foo.xpc']) {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, name, 'Versions'), { recursive: true });
      assert.equal(install.stripDirs(dir, Infinity), dir, name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('stripDirs: ordinary nested wrappers are still collapsed', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'x.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'y.txt'), 'y');
    assert.equal(install.stripDirs(dir, Infinity), path.join(dir, 'a', 'b', 'c'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractArchive: a zip holding one .app installs the bundle, not its Contents', async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    mkbundle(src, 'Foo.app');
    const zip = new AdmZip();
    zip.addLocalFolder(src);
    const zipPath = path.join(dir, 'Foo-1.2.3-mac.zip');
    zip.writeZip(zipPath);

    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    const { files, srcDir } = await install.extractArchive(zipPath, stage);
    const rel = files.map((f) => f.replace(/\\/g, '/')).sort();
    assert.ok(rel.every((f) => f.startsWith('Foo.app/')), `bundle was flattened away: ${rel.join(', ')}`);
    assert.ok(fs.existsSync(path.join(srcDir, 'Foo.app', 'Contents', 'Info.plist')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('swapDir: carry-over never writes inside a bundle, even with no previous manifest', () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'App');
    const next = path.join(base, 'next');

    // The installed version: a bundle plus a genuine sibling settings file.
    mkbundle(dest, 'Foo.app');
    fs.writeFileSync(path.join(dest, 'settings.ini'), 'keep me');
    // Something that only exists in the OLD bundle — a leftover framework, or a file the
    // app wrote into itself at runtime.
    fs.writeFileSync(path.join(dest, 'Foo.app', 'Contents', 'stale.dylib'), 'old');

    // The new version, staged. Note prevManifest is omitted entirely, which is the
    // corrupt-state case: without the guard every old bundle file is carried forward.
    mkbundle(next, 'Foo.app');
    const files = install.walk(next);
    install.swapDir(dest, next, { files, carryOver: true });

    assert.equal(fs.readFileSync(path.join(dest, 'settings.ini'), 'utf8'), 'keep me', 'sibling user file still carried over');
    assert.equal(
      fs.existsSync(path.join(dest, 'Foo.app', 'Contents', 'stale.dylib')),
      false,
      'a foreign file inside the bundle would break its signature'
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
