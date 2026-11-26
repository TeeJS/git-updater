'use strict';

// The REAL root step of "one password box for Mac installer packages"
// (PROJECT-no-installer-windows.md), run as root against real packages with Apple's own
// `installer`.
//
// elevate-mac.test.js covers everything around it with osascript replaced by a stand-in. Here
// nothing is pretended except the password box itself: `sudo -n` stands in for AppleScript's
// administrator privileges, so the script in src/elevate.js (MAC_ADMIN_SCRIPT) really runs as
// root under /bin/sh, really copies and checks each package, and really installs it. One test
// also runs the real AppleScript (MAC_RUNNER) as root, to prove every argument reaches the
// script intact through AppleScript's own quoting.
//
// It INSTALLS packages on the machine it runs on (com.gitupdater.test.*, into
// /usr/local/gu-test), so it runs only where it is asked to: on macOS, with
// GIT_UPDATER_ROOT_TESTS=1, where `sudo -n` needs no password. That is the macOS runner in
// .github/workflows/mac-admin.yml and release.yml; never a plain `node --test` on someone's Mac.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const elevate = require('../src/elevate');

const enabled = process.platform === 'darwin' && process.env.GIT_UPDATER_ROOT_TESTS === '1';
const skip = enabled ? false : 'installs test packages as root: runs only on macOS with GIT_UPDATER_ROOT_TESTS=1';

const ROOT = '/usr/local/gu-test';
const NAMES = ['good', 'second', 'bad', 'changed', 'slow'];
const TOOLS = { osascript: 'osascript (sudo -n stands in)', sh: '/bin/sh' };

// `sudo -n /bin/sh -c <script> git-updater-admin <limit> <pairs…>` in place of the AppleScript:
// the same script and arguments, as root, with no box. Taken from the osascript argv finishMac built.
const viaSudo = (_exe, args, options) => {
  const at = args.indexOf(elevate.MAC_ADMIN_SCRIPT);
  assert.ok(at > 0, 'the script is in the argv');
  return spawn('sudo', ['-n', '/bin/sh', '-c', args[at], 'git-updater-admin', ...args.slice(at + 2)], options);
};

function buildPkg(dir, name, version, extra = {}) {
  const root = path.join(dir, `${name}-${version}-root`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'version.txt'), `${version}\n`);
  const args = ['--root', root, '--identifier', `com.gitupdater.test.${name}`, '--version', version, '--install-location', `${ROOT}/${name}`];
  if (extra.postinstall) {
    const scripts = path.join(dir, `${name}-${version}-scripts`);
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'postinstall'), extra.postinstall, { mode: 0o755 });
    args.push('--scripts', scripts);
  }
  const out = path.join(dir, `${name}-${version}.pkg`);
  execFileSync('pkgbuild', [...args, out], { stdio: 'pipe' });
  return out;
}

// The entries the runner would make, from a real setAsideEntry, recording what each is told.
// The test packages are unsigned, so the signature check is answered "trusted" here; the real
// check is run against one of them in its own test below.
async function entriesFor(stageBase, pkgs) {
  const log = [];
  const entries = [];
  for (const [name, file] of pkgs) {
    const kept = await elevate.setAsideEntry(file, stageBase, { kind: 'pkg' }, { checkPackage: async () => null });
    assert.ok(kept, name);
    entries.push({
      key: name,
      name,
      ...kept,
      succeed: () => { log.push(`succeed ${name}`); return { id: name, status: 'updated' }; },
      ownWindow: () => { log.push(`window ${name}`); return { id: name, status: 'failed', reason: 'installer window opened' }; },
      fail: (reason) => ({ id: name, status: 'failed', reason }),
    });
  }
  return { entries, log };
}

const installedVersion = (name) => {
  try {
    return fs.readFileSync(`${ROOT}/${name}/version.txt`, 'utf8').trim();
  } catch {
    return null;
  }
};
const leftInVarTmp = () => fs.readdirSync('/var/tmp').filter((n) => n.startsWith('git-updater-admin.'));
const purge = () => {
  spawnSync('sudo', ['-n', 'rm', '-rf', ROOT], { stdio: 'ignore' });
  for (const n of NAMES) spawnSync('sudo', ['-n', 'pkgutil', '--forget', `com.gitupdater.test.${n}`], { stdio: 'ignore' });
};

if (enabled) {
  purge();
  after(purge);
}

test('root step: each package is installed on its own, and a bad one does not stop the others', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const { entries, log } = await entriesFor(stageBase, [
      ['good', buildPkg(dir, 'good', '1.0')],
      ['bad', buildPkg(dir, 'bad', '1.0', { postinstall: '#!/bin/sh\necho "gu-test refuses to install" >&2\nexit 1\n' })],
      ['changed', buildPkg(dir, 'changed', '1.0')],
      ['second', buildPkg(dir, 'second', '1.0')],
    ]);
    // Swapped after git-updater checked it: another valid package under the same name.
    fs.copyFileSync(buildPkg(dir, 'changed', '6.6.6'), entries[2].item.file);

    const out = await elevate.finish(entries, { mac: TOOLS, stageBase, spawn: viaSudo });

    assert.deepStrictEqual(log, ['succeed good', 'succeed second']);
    assert.strictEqual(installedVersion('good'), '1.0');
    assert.strictEqual(installedVersion('second'), '1.0', 'the package after the two bad ones is still installed');

    const bad = out.get('bad');
    assert.strictEqual(bad.status, 'failed');
    assert.match(bad.reason, /^the package could not be installed/, bad.reason);

    assert.match(out.get('changed').reason, /changed after it was downloaded, so it was not run/);
    assert.strictEqual(installedVersion('changed'), null, 'the swapped file was never installed');

    assert.deepStrictEqual(leftInVarTmp(), [], 'the root-owned folder is removed');
    assert.deepStrictEqual(fs.readdirSync(stageBase), [], 'every kept file is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('root step: an update installs over the version already there', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    assert.strictEqual(installedVersion('good'), '1.0', 'left by the test before');
    const { entries, log } = await entriesFor(stageBase, [['good', buildPkg(dir, 'good', '2.0')]]);
    await elevate.finish(entries, { mac: TOOLS, stageBase, spawn: viaSudo });
    assert.deepStrictEqual(log, ['succeed good']);
    assert.strictEqual(installedVersion('good'), '2.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('root step: a package that hangs is stopped at the time limit, and the run goes on', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const { entries, log } = await entriesFor(stageBase, [['slow', buildPkg(dir, 'slow', '1.0', { postinstall: '#!/bin/sh\nsleep 20\n' })]]);
    const started = Date.now();
    const out = await elevate.finish(entries, { mac: TOOLS, stageBase, spawn: viaSudo, timeoutSecs: 3 });
    const took = (Date.now() - started) / 1000;
    assert.deepStrictEqual(log, [], 'not reported as installed');
    assert.match(out.get('slow').reason, /did not finish in time and was stopped/);
    assert.ok(took < 15, `the run came back (${took.toFixed(1)}s): the time limit, not the package, ended it`);
    assert.deepStrictEqual(leftInVarTmp(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the signature check: a real unsigned package is not trusted', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const unsigned = buildPkg(dir, 'second', '9.0');
    assert.match(await elevate.checkPackage(unsigned), /no Developer ID Installer signature/);
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    assert.strictEqual(await elevate.setAsideEntry(unsigned, stageBase, { kind: 'pkg' }), null, 'so it is not set aside: it opens in Installer');
    assert.deepStrictEqual(fs.readdirSync(stageBase), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the AppleScript, run for real as root: every argument reaches the script exactly as given', { skip }, async () => {
  const awkward = ['/Users/Shared/My Apps/it\'s "here".pkg', '$(touch /tmp/gu-injected)', 'a;b|c&d', '`id`', 'line\nbreak'];
  const show = 'for a in "$@"; do printf "[%s]\\n" "$a"; done';
  const args = [...elevate.MAC_RUNNER.flatMap((l) => ['-e', l]), show, 'git-updater test', ...awkward];
  const r = spawnSync('sudo', ['-n', '/usr/bin/osascript', ...args], { encoding: 'utf8', timeout: 60_000 });
  assert.strictEqual(r.status, 0, `osascript: ${r.stderr || r.error}`);
  assert.ok(!/git-updater-admin error/.test(r.stdout), `as root, no password box is needed: ${r.stdout}`);
  assert.strictEqual(r.stdout.trimEnd(), awkward.map((a) => `[${a}]`).join('\n'));
  assert.ok(!fs.existsSync('/tmp/gu-injected'), 'nothing in an argument was run');
});
