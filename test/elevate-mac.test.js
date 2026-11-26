'use strict';

// One password box for Mac installer packages (PROJECT-no-installer-windows.md).
//
// With "Ask for administrator permission once per update run" on, a .pkg that needs the
// password is SET ASIDE, and when the window's run ends AppleScript's administrator password
// box is shown once and a fixed script installs every package with Apple's own `installer`.
// Here osascript, pkgutil and spctl are replaced by stand-ins, so nothing can show a password
// box; these tests run on every platform. The script itself runs for real, as root, in
// test/admin-mac.test.js (CI, macOS), and so does taking a package out of a disk image below.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const elevate = require('../src/elevate');
const github = require('../src/github');
const detect = require('../src/detect');
const install = require('../src/install');
const runner = require('../src/runner');
const brew = require('../src/sources/brew');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-elevate-mac-'));
const leftIn = (dir) => fs.readdirSync(dir);
const MAC = { osascript: '/usr/bin/osascript', sh: '/bin/sh' };
const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

function between(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} ... ${end}`);
  return src.slice(a, b);
}

// A stand-in for osascript: prints what the test says, exits how the test says, records its argv.
function fakeOsascript(answer) {
  const calls = [];
  const spawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    setImmediate(() => {
      if (answer.error) return child.emit('error', new Error(answer.error));
      if (answer.stdout) child.stdout.emit('data', Buffer.from(answer.stdout));
      child.emit('close', answer.exit === undefined ? 0 : answer.exit);
    });
    return child;
  };
  return { spawn, calls };
}

function pkgEntriesIn(stageBase, names) {
  const log = [];
  const entries = names.map((name, i) => {
    const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
    const file = path.join(keepDir, `${name}.pkg`);
    fs.writeFileSync(file, 'xar!');
    return {
      key: `acme/${name}#installer`,
      name: name[0].toUpperCase() + name.slice(1),
      item: { file, sha256: String(i).repeat(64), kind: 'pkg' },
      keepDir,
      succeed: () => { log.push(`succeed ${name}`); return { id: `acme/${name}#installer`, status: 'updated' }; },
      ownWindow: () => { log.push(`window ${name}`); return { id: `acme/${name}#installer`, status: 'failed', reason: 'installer window opened — authorize and finish it, then Check' }; },
      fail: (reason) => ({ id: `acme/${name}#installer`, status: 'failed', reason }),
    };
  });
  return { entries, log };
}

// What the root script prints back through AppleScript.
const printed = (...lines) => ['git-updater-admin 1', ...lines, 'git-updater-admin done', ''].join('\n');

// --- the tools, and which packages are taken --------------------------------------------------

test('mac: the tools are Apple\'s own, at their fixed paths, and all are needed', () => {
  assert.strictEqual(elevate.macTools(() => true, 'win32'), null, 'Windows has its helper instead');
  assert.strictEqual(elevate.macTools(() => true, 'linux'), null, 'Linux has pkexec instead');
  assert.deepStrictEqual(elevate.macTools(() => true, 'darwin'), MAC);
  const all = Object.values(elevate.MAC_TOOLS);
  assert.deepStrictEqual(all, ['/usr/bin/osascript', '/bin/sh', '/usr/sbin/installer', '/usr/sbin/pkgutil', '/usr/sbin/spctl']);
  for (const missing of all) {
    assert.strictEqual(elevate.macTools((f) => f !== missing, 'darwin'), null, `no ${missing}`);
  }
});

// pkgutil's and spctl's answers, as the stand-in prints them.
const SIGNED = [
  'Package "zoomusInstallerFull.pkg":',
  '   Status: signed by a developer certificate issued by Apple for distribution',
  '   Notarization: trusted by the Apple notary service',
  '   Certificate Chain:',
  '    1. Developer ID Installer: Zoom Video Communications, Inc. (BJ4HAAB9B3)',
  '    2. Developer ID Certification Authority',
  '    3. Apple Root CA',
].join('\n');
function fakeTools(answers) {
  const calls = [];
  const run = async (exe, args) => {
    calls.push([exe, ...args]);
    return answers[path.basename(exe)];
  };
  return { run, calls };
}

test('mac: a package is trusted only with a Developer ID Installer signature AND Gatekeeper\'s yes', async () => {
  const ok = fakeTools({ pkgutil: { code: 0, out: SIGNED }, spctl: { code: 0, out: 'zoom.pkg: accepted\nsource=Notarized Developer ID\n' } });
  assert.strictEqual(await elevate.checkPackage('/s/zoom.pkg', ok.run), null);
  assert.deepStrictEqual(ok.calls, [
    ['/usr/sbin/pkgutil', '--check-signature', '/s/zoom.pkg'],
    ['/usr/sbin/spctl', '--assess', '--type', 'install', '/s/zoom.pkg'],
  ], 'Apple\'s tools at their fixed paths, each given the file as one argument');

  const unsigned = fakeTools({ pkgutil: { code: 1, out: 'Package "x.pkg":\n   Status: no signature\n' } });
  assert.match(await elevate.checkPackage('/s/x.pkg', unsigned.run), /no Developer ID Installer signature/);
  assert.strictEqual(unsigned.calls.length, 1, 'no signature: Gatekeeper is not even asked');

  const appCert = fakeTools({ pkgutil: { code: 0, out: SIGNED.replace('Developer ID Installer', 'Developer ID Application') } });
  assert.match(await elevate.checkPackage('/s/x.pkg', appCert.run), /no Developer ID Installer signature/, 'an app certificate is not an installer one');

  const rejected = fakeTools({ pkgutil: { code: 0, out: SIGNED }, spctl: { code: 3, out: 'x.pkg: rejected\n' } });
  assert.match(await elevate.checkPackage('/s/x.pkg', rejected.run), /Gatekeeper did not accept/);

  const noTool = fakeTools({ pkgutil: { code: null, out: 'spawn /usr/sbin/pkgutil ENOENT' } });
  assert.match(await elevate.checkPackage('/s/x.pkg', noTool.run), /no Developer ID Installer signature/, 'a check that cannot run is a no');
});

test('mac: a trusted .pkg is set aside with its SHA-256; an untrusted one, or one with switches, is not', async () => {
  const dir = tmp();
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const file = path.join(dir, 'zoomusInstallerFull.pkg');
    fs.writeFileSync(file, 'xar!zoom');
    const checked = [];
    const trusted = async (f) => { checked.push(f); return null; };
    const kept = await elevate.setAsideEntry(file, stageBase, { kind: 'pkg' }, { checkPackage: trusted });
    assert.ok(kept);
    assert.deepStrictEqual(Object.keys(kept.item).sort(), ['file', 'kind', 'sha256']);
    assert.strictEqual(kept.item.kind, 'pkg');
    assert.notStrictEqual(kept.item.file, file, 'a copy: the download folder is removed when the app\'s run ends');
    assert.deepStrictEqual(checked, [kept.item.file], 'the COPY is what is checked, the same file the hash was taken of');
    assert.strictEqual(kept.item.sha256, require('crypto').createHash('sha256').update('xar!zoom').digest('hex'));
    elevate.discard(kept);

    const untrusted = async () => 'the package has no Developer ID Installer signature';
    assert.strictEqual(await elevate.setAsideEntry(file, stageBase, { kind: 'pkg' }, { checkPackage: untrusted }), null);
    assert.strictEqual(await elevate.setAsideEntry(file, stageBase, { kind: 'pkg', args: ['-verbose'] }, { checkPackage: trusted }), null, 'installer switches the user pinned keep their own route');
    assert.deepStrictEqual(leftIn(stageBase), [], 'nothing is left behind for what was not taken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the one password box ----------------------------------------------------------------------

test('mac: one osascript, never a shell of git-updater\'s own, and each package gets its own result', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = pkgEntriesIn(stageBase, ['zoom', 'teams', 'changed', 'unreached']);
    const osa = fakeOsascript({
      stdout: printed(
        'result 0 exit 0',
        'reason 1 installer: The install failed. (The Installer encountered an error that caused the installation to fail.)',
        'result 1 exit 1',
        'result 2 hash'
      ),
    });
    const out = await elevate.finish(entries, { mac: MAC, stageBase, spawn: osa.spawn });

    assert.strictEqual(osa.calls.length, 1, 'ONE command: one password box');
    const { exe, args, options } = osa.calls[0];
    assert.strictEqual(exe, '/usr/bin/osascript');
    assert.ok(!options.shell, 'osascript is started directly');
    const n = elevate.MAC_RUNNER.length * 2;
    assert.deepStrictEqual(args.slice(0, n), elevate.MAC_RUNNER.flatMap((l) => ['-e', l]), 'the AppleScript, one -e per line');
    assert.strictEqual(args[n], elevate.MAC_ADMIN_SCRIPT, 'then the root script');
    assert.strictEqual(args[n + 1], 'git-updater is installing updates for Zoom, Teams, Changed and 1 more.', 'then the line the password box shows, naming the apps');
    assert.strictEqual(args[n + 2], String(elevate.TIMEOUT_SECS));
    assert.deepStrictEqual(args.slice(n + 3), entries.flatMap((e) => [e.item.sha256, e.item.file]), 'then one <sha256> <file> pair per package, in order');

    assert.deepStrictEqual(log, ['succeed zoom']);
    const by = (name) => out.get(`acme/${name}#installer`);
    assert.strictEqual(by('zoom').status, 'updated');
    assert.match(by('teams').reason, /^the package could not be installed: The install failed\./);
    assert.match(by('changed').reason, /changed after it was downloaded, so it was not run/);
    assert.match(by('unreached').reason, /stopped before this installer — Retry/);
    assert.deepStrictEqual(leftIn(stageBase), [], 'every kept file is removed');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('mac: a cancelled password box installs nothing and opens nothing', async () => {
  const stageBase = tmp();
  try {
    const { entries, log } = pkgEntriesIn(stageBase, ['a', 'b']);
    const osa = fakeOsascript({ stdout: `git-updater-admin error ${elevate.MAC_CANCELLED}\n` });
    const out = await elevate.finish(entries, { mac: MAC, stageBase, spawn: osa.spawn });
    assert.deepStrictEqual(log, []);
    assert.deepStrictEqual([...out.values()].map((r) => r.reason), [elevate.DECLINED, elevate.DECLINED]);
    assert.deepStrictEqual(leftIn(stageBase), []);
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('mac: when the password box cannot be used, every package opens in Installer as before', async () => {
  const answers = [
    { stdout: 'git-updater-admin error -60007\n' }, // the password was not accepted
    { stdout: 'git-updater-admin error 70\n' }, // the script could not start
    { exit: 1 },
    { error: 'spawn /usr/bin/osascript ENOENT' },
    { stdout: 'not what the script prints\n' },
  ];
  for (const answer of answers) {
    const stageBase = tmp();
    try {
      const { entries, log } = pkgEntriesIn(stageBase, ['a', 'b']);
      const out = await elevate.finish(entries, { mac: MAC, stageBase, spawn: fakeOsascript(answer).spawn });
      assert.deepStrictEqual(log, ['window a', 'window b'], JSON.stringify(answer));
      assert.ok([...out.values()].every((r) => /^installer window opened/.test(r.reason)));
      assert.strictEqual(leftIn(stageBase).length, 2, 'Installer is using the kept files: they stay');
    } finally {
      fs.rmSync(stageBase, { recursive: true, force: true });
    }
  }
});

test('mac: every app gets an answer, whatever goes wrong', async () => {
  const stageBase = tmp();
  try {
    const { entries } = pkgEntriesIn(stageBase, ['a', 'b', 'c']);
    entries[0].succeed = () => { throw new Error('could not read the installed version'); };
    const osa = fakeOsascript({ stdout: printed('result 0 exit 0', 'result 1 exit 143', 'result 2 copy', 'result 9 exit 0') });
    const out = await elevate.finish(entries, { mac: MAC, stageBase, spawn: osa.spawn });
    assert.deepStrictEqual([...out.keys()], entries.map((e) => e.key));
    assert.strictEqual(out.get(entries[0].key).reason, 'could not read the installed version');
    assert.match(out.get(entries[1].key).reason, /did not finish in time and was stopped/);
    assert.match(out.get(entries[2].key).reason, /could not be prepared for the administrator run/);

    const again = pkgEntriesIn(stageBase, ['d']);
    again.entries[0].ownWindow = () => { throw new Error('needs administrator rights'); };
    const out2 = await elevate.finish(again.entries, { mac: MAC, stageBase, spawn: fakeOsascript({ exit: 1 }).spawn });
    assert.strictEqual(out2.get(again.entries[0].key).reason, 'needs administrator rights');
  } finally {
    fs.rmSync(stageBase, { recursive: true, force: true });
  }
});

test('mac: the password box names up to three apps, and the reasons read plainly', () => {
  const e = (...names) => names.map((name) => ({ key: `k/${name}`, name }));
  assert.strictEqual(elevate.macPrompt(e('Zoom')), 'git-updater is installing updates for Zoom.');
  assert.strictEqual(elevate.macPrompt(e('Zoom', 'Microsoft Teams', 'Google Drive')), 'git-updater is installing updates for Zoom, Microsoft Teams, Google Drive.');
  assert.strictEqual(elevate.macPrompt(e('A', 'B', 'C', 'D', 'E')), 'git-updater is installing updates for A, B, C and 2 more.');
  assert.strictEqual(elevate.macPrompt([{ key: 'acme/widget#installer' }]), 'git-updater is installing updates for acme/widget#installer.');

  assert.strictEqual(elevate.macReason({ kind: 'exit', code: 1, reasons: [] }), 'the package could not be installed (installer exit 1)');
  assert.strictEqual(elevate.macReason({ kind: 'exit', code: 1, reasons: ['installer: Error - the package path specified was invalid'] }), 'the package could not be installed: Error - the package path specified was invalid');
  assert.match(elevate.macReason({ kind: 'exit', code: 137, reasons: [] }), /did not finish in time/);
  assert.match(elevate.macReason({ kind: 'hash', reasons: [] }), /changed after it was downloaded/);
});

test('mac: the root script uses a fixed PATH, Apple\'s own tools, and installs the checked copy', () => {
  const script = elevate.MAC_ADMIN_SCRIPT;
  assert.ok(!script.includes('\r'), 'LF only, whatever line endings this checkout has');
  const lines = script.split('\n');
  assert.strictEqual(lines[0], 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'the first thing it does');
  assert.ok(lines.includes('umask 077'), 'the copies are root\'s alone');
  assert.match(script, /installer -pkg "\$copy" -target \/ <\/dev\/null/, 'the root-owned copy is what is installed, with no terminal to ask on');
  assert.match(script, /shasum -a 256 < "\$copy"/, 'the copy is what is checked');
  assert.match(script, /\( sleep "\$limit"; : > "\$dir\/\$i\.late"; kill -TERM "\$pid"; sleep 30; kill -KILL "\$pid" \) <\/dev\/null >\/dev\/null 2>&1 &/, 'each package has its own time limit, and the watchdog holds no output open');
  assert.match(script, /if \[ -e "\$dir\/\$i\.late" \]; then\n\s+code=143/, 'stopped at the limit reads as the time limit, whatever installer exited with');
  assert.match(script, /trap 'rm -rf "\$dir"' EXIT/, 'nothing is left behind');
  for (const banned of ['[[', 'function ', 'local ', 'sudo', 'curl', 'eval ', 'source ', 'osascript']) assert.ok(!script.includes(banned), banned);
});

test('mac: the AppleScript quotes every argument itself and always answers on stdout', () => {
  const as = elevate.MAC_RUNNER.join('\n');
  assert.match(as, /^on run argv\n/);
  assert.match(as, /"\/bin\/sh -c " & quoted form of \(item 1 of argv\)/, 'the script, quoted by AppleScript');
  assert.match(as, /set cmd to cmd & " " & quoted form of \(item i of argv\)/, 'every other argument, quoted by AppleScript');
  assert.match(as, /do shell script cmd with prompt \(item 2 of argv\) with administrator privileges without altering line endings/);
  assert.match(as, /on error errText number errNum\nreturn "git-updater-admin error " & errNum/, 'a cancelled box comes back as a line, not a failure');
  assert.ok(!/do shell script "/.test(as), 'no command text of its own: only what it was given, quoted');
});

// --- the runner, the app and the window ----------------------------------------------------------

async function withPkgRelease(fn) {
  const real = {
    getLatestRelease: github.getLatestRelease,
    downloadAsset: github.downloadAsset,
    verifyDigest: github.verifyDigest,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning,
    clearCache: detect.clearCache,
    installedVersion: detect.installedVersion,
    installInstaller: install.installInstaller,
    checkPackage: elevate.checkPackage,
  };
  github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: [{ name: 'payload.pkg', browser_download_url: 'https://example.invalid/payload.pkg' }] });
  github.downloadAsset = async (_url, file) => fs.writeFileSync(file, 'xar!widget 2.0.0');
  github.verifyDigest = () => ({ skipped: true, note: 'no digest in test' });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => '1.0.0';
  // What `installer -pkg … -target /` does without the password: it refuses (src/install.js).
  install.installInstaller = () => { throw Object.assign(new Error('installing a .pkg needs administrator rights'), { elevation: true }); };
  try {
    return await fn();
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, verifyDigest: real.verifyDigest, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, { isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion });
    install.installInstaller = real.installInstaller;
    elevate.checkPackage = real.checkPackage;
  }
}

const pkgWidget = () => ({ portableRoot: '', repos: [{ owner: 'acme', repo: 'widget', type: 'installer', asset: 'payload.pkg', install: { kind: 'pkg' } }] });

test('mac runner: with the setting on, a trusted .pkg is set aside; an untrusted one opens in Installer', async () => {
  const dir = tmp();
  const statePath = path.join(dir, 'state.json');
  const opened = [];
  const aside = [];
  try {
    await withPkgRelease(async () => {
      elevate.checkPackage = async () => null;
      const { results } = await runner.run(pkgWidget(), { statePath, openFile: (f) => opened.push(f), setAside: (e) => aside.push(e) });
      assert.strictEqual(results[0].needsAdmin, true, results[0].reason);
      assert.deepStrictEqual(opened, [], 'no Installer window');
      assert.strictEqual(aside.length, 1);
      assert.strictEqual(aside[0].item.kind, 'pkg');
      assert.strictEqual(aside[0].name, 'widget', 'the password box can name the app');
      assert.ok(fs.existsSync(aside[0].item.file), 'the package outlives the download folder');
      aside[0].ownWindow();
      assert.deepStrictEqual(opened, [aside[0].item.file], 'the fallback is still Installer');

      opened.length = 0;
      elevate.checkPackage = async () => 'Gatekeeper did not accept the package';
      const second = await runner.run(pkgWidget(), { statePath, openFile: (f) => opened.push(f), setAside: (e) => aside.push(e) });
      assert.match(second.results[0].reason, /^installer window opened/);
      assert.strictEqual(opened.length, 1, 'opened in Installer right away, as with the setting off');
      assert.strictEqual(aside.length, 1, 'and not set aside');
    });
  } finally {
    for (const e of aside) elevate.discard(e);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mac runner: a disk image holding a .pkg is opened as that .pkg (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner.js'), 'utf8');
  assert.match(
    src,
    /if \(repo\.type === 'installer' && process\.platform === 'darwin' && sniffExtension\(file\) === '\.dmg'\) \{[\s\S]{0,400}?file = await require\('\.\/platform\/mac'\)\.pkgFromDiskImage\(file, tmp, asset\.pkgName\);\s*stagedName = path\.basename\(file\);/,
    'before the installer kind is decided, so the package is what is set aside or opened'
  );
  assert.ok(src.indexOf('pkgFromDiskImage(file, tmp') < src.indexOf('const kind = (repo.install && repo.install.kind)'));
});

test('brew: a cask\'s installer package is named, so the right one is taken out of its disk image', () => {
  const zoomCask = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources', 'brew', 'casks.json'), 'utf8')).find((c) => c.token === 'zoom');
  const zoom = brew.toRelease(zoomCask, { arch: 'arm64', platform: 'darwin', osVersion: '27.0' }).assets[0];
  assert.strictEqual(zoom.pkgName, 'zoomusInstallerFull.pkg');
  const sneaky = { ...zoomCask, artifacts: zoomCask.artifacts.map((a) => (a && Array.isArray(a.pkg) ? { pkg: ['../../evil.pkg'] } : a)) };
  assert.strictEqual(brew.toRelease(sneaky, { arch: 'arm64', platform: 'darwin', osVersion: '27.0' }).assets[0].pkgName, undefined, 'only a plain file name');
});

test('mac app: the window is told the setting is offered on a Mac', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const src = between(mainSrc, 'function adminStatus()', "ipcMain.handle('admin:status'");
  const ctx = { adminRun: () => ({ mac: MAC }), elevate: { linuxStatus: () => null } };
  vm.runInNewContext(`${src}; this.adminStatus = adminStatus;`, ctx);
  assert.deepStrictEqual({ ...ctx.adminStatus() }, { offered: true, missing: null });
});

test('mac window: the row and the setting speak of macOS\'s password box', async () => {
  const view = between(html, 'function statusViewOf(s) {', 'function primaryAction(s)');
  const ctx = { datedStatus: () => ({}) };
  vm.runInNewContext(`${view}; adminPromptKind = 'mac'; this.statusViewOf = statusViewOf;`, ctx);
  assert.strictEqual(ctx.statusViewOf({ ph: 'needsAdmin' }).text, 'Waiting for administrator permission');
  assert.match(ctx.statusViewOf({ ph: 'needsAdmin' }).tip, /macOS asks once, at the end of this run/);
  assert.strictEqual(ctx.statusViewOf({ ph: 'admin' }).text, 'Installing — enter your password in the prompt');

  const block = between(html, "$('adminPromptOnce').onchange", "$('requireChecksum').onchange");
  const els = {
    adminPromptNeeds: { hidden: true }, adminNeedsMsg: { textContent: '' }, adminNeedsInstall: {}, adminNeedsCopy: {}, adminNeedsCheck: {},
    adminPromptOnce: { checked: false }, adminPromptOnceBlock: { hidden: true }, adminPromptOnceHint: { textContent: 'the Windows wording' },
  };
  const settings = { $: (id) => els[id], config: {}, saveConfig: async () => {}, msg: () => {}, adminPromptKind: 'windows', window: { addEventListener: () => {}, api: { getPlatform: async () => ({ adminPromptOnce: true, platform: 'darwin' }), adminStatus: async () => ({}) } } };
  vm.runInNewContext(block, settings);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(els.adminPromptOnceBlock.hidden, false, 'offered on a Mac');
  assert.strictEqual(settings.adminPromptKind, 'mac');
  assert.match(els.adminPromptOnceHint.textContent, /behind one macOS password box\. git-updater itself never runs as root/);
  assert.ok(els.adminPromptOnceHint.textContent.length <= 220, 'as short as every other Settings hint');
});

// --- a real disk image (macOS only: hdiutil) ------------------------------------------------------

const macOnly = process.platform === 'darwin' ? false : 'builds a real disk image with hdiutil: macOS only';

test('mac: the .pkg inside a disk image is taken out; the named one when there are several', { skip: macOnly }, async () => {
  const mac = require('../src/platform/mac');
  const dir = tmp();
  try {
    const makePkg = (out, id) => {
      const root = path.join(dir, `root-${id}`);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'hello.txt'), id);
      execFileSync('pkgbuild', ['--root', root, '--identifier', `com.gitupdater.test.${id}`, '--version', '1.0', '--install-location', '/tmp/gu-never-installed', out], { stdio: 'pipe' });
    };
    const makeDmg = (name, pkgs) => {
      const src = path.join(dir, `src-${name}`);
      fs.mkdirSync(src);
      for (const p of pkgs) makePkg(path.join(src, p), p.replace(/\W/g, ''));
      fs.symlinkSync('/Applications', path.join(src, 'Applications'));
      const out = path.join(dir, `${name}.dmg`);
      execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', src, '-format', 'UDZO', '-volname', name, out], { stdio: 'pipe' });
      return out;
    };
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(dest);

    const one = await mac.pkgFromDiskImage(makeDmg('one', ['GoogleDrive.pkg']), dest);
    assert.strictEqual(one, path.join(dest, 'GoogleDrive.pkg'));
    assert.strictEqual(runner.sniffExtension(one), '.pkg', 'a real flat package came out');

    const two = makeDmg('two', ['Main.pkg', 'Extra.pkg']);
    assert.strictEqual(await mac.pkgFromDiskImage(two, dest, 'Main.pkg'), path.join(dest, 'Main.pkg'));
    await assert.rejects(mac.pkgFromDiskImage(two, dest), /holds 2 installer packages and the listing does not say which/);
    await assert.rejects(mac.pkgFromDiskImage(makeDmg('none', []), dest), /holds no installer package/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
