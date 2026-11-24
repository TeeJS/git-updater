'use strict';

// The REAL root step of "one password prompt on Linux" (PROJECT-linux-one-password-prompt.md),
// run as root against real packages with the system's own apt-get.
//
// elevate.test.js covers everything around it with pkexec replaced by a stand-in that prints
// what a test says. Here nothing is pretended except the password prompt itself: `sudo -n`
// stands in for `pkexec`, so the script in src/elevate.js (ADMIN_SCRIPT) really runs as root
// under /bin/sh (dash on Debian and Ubuntu), really copies and checks each package, and really
// installs it.
//
// It INSTALLS AND REMOVES packages on the machine it runs on (named gu-test-*), so it runs only
// where it is asked to: on Linux, with GIT_UPDATER_ROOT_TESTS=1, where `sudo -n` needs no
// password. That is the Ubuntu runner in .github/workflows/linux-admin.yml and release.yml;
// never a plain `node --test` on someone's own machine.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const elevate = require('../src/elevate');

const enabled = process.platform === 'linux' && process.env.GIT_UPDATER_ROOT_TESTS === '1';
const skip = enabled ? false : 'installs test packages as root: runs only on Linux with GIT_UPDATER_ROOT_TESTS=1';

const NAMES = ['gu-test-good', 'gu-test-second', 'gu-test-baddep', 'gu-test-changed', 'gu-test-slow'];

// `sudo -n` in place of `pkexec --disable-internal-agent`: the same program and arguments
// after it, as root, with no prompt.
const viaSudo = (_exe, args, options) => spawn('sudo', ['-n', ...args.slice(1)], options);
const TOOLS = { pkexec: 'pkexec (sudo -n stands in)', sh: '/bin/sh' };

function buildDeb(dir, name, version, extra = {}) {
  const root = path.join(dir, `${name}-${version}`);
  fs.mkdirSync(path.join(root, 'DEBIAN'), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(root, 'DEBIAN'), 0o755);
  fs.mkdirSync(path.join(root, 'usr', 'share', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'share', name, 'version.txt'), `${version}\n`);
  fs.writeFileSync(
    path.join(root, 'DEBIAN', 'control'),
    [
      `Package: ${name}`,
      `Version: ${version}`,
      'Architecture: all',
      'Maintainer: git-updater tests <noreply@example.invalid>',
      ...(extra.depends ? [`Depends: ${extra.depends}`] : []),
      'Description: git-updater test package',
      '',
    ].join('\n')
  );
  if (extra.postinst) fs.writeFileSync(path.join(root, 'DEBIAN', 'postinst'), extra.postinst, { mode: 0o755 });
  const out = path.join(dir, `${name}_${version}_all.deb`);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', root, out], { stdio: 'pipe' });
  return out;
}

// The entries the runner would make, from a real setAsideEntry, recording what each is told.
async function entriesFor(stageBase, debs) {
  const log = [];
  const entries = [];
  for (const [name, file] of debs) {
    const kept = await elevate.setAsideEntry(file, stageBase, { kind: 'deb' });
    assert.ok(kept, name);
    entries.push({
      key: name,
      ...kept,
      succeed: () => { log.push(`succeed ${name}`); return { id: name, status: 'updated' }; },
      ownWindow: () => { log.push(`window ${name}`); return { id: name, status: 'failed', reason: 'installer window opened' }; },
      fail: (reason) => ({ id: name, status: 'failed', reason }),
    });
  }
  return { entries, log };
}

const installedVersion = (name) => {
  const r = spawnSync('dpkg-query', ['-W', '-f=${db:Status-Abbrev}|${Version}', name], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.startsWith('ii') ? r.stdout.split('|')[1] : null;
};
const leftInVarTmp = () => fs.readdirSync('/var/tmp').filter((n) => n.startsWith('git-updater-admin.'));
const purge = () => spawnSync('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'dpkg', '--purge', '--force-remove-reinstreq', ...NAMES], { stdio: 'ignore' });

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
      ['gu-test-good', buildDeb(dir, 'gu-test-good', '1.0')],
      ['gu-test-baddep', buildDeb(dir, 'gu-test-baddep', '1.0', { depends: 'gu-test-no-such-package' })],
      ['gu-test-changed', buildDeb(dir, 'gu-test-changed', '1.0')],
      ['gu-test-second', buildDeb(dir, 'gu-test-second', '1.0')],
    ]);
    // Swapped after git-updater checked it: another valid package under the same name.
    fs.copyFileSync(buildDeb(dir, 'gu-test-changed', '6.6.6'), entries[2].item.file);

    const out = await elevate.finish(entries, { linux: TOOLS, stageBase, spawn: viaSudo });

    assert.deepStrictEqual(log, ['succeed gu-test-good', 'succeed gu-test-second']);
    assert.strictEqual(installedVersion('gu-test-good'), '1.0');
    assert.strictEqual(installedVersion('gu-test-second'), '1.0', 'the package after the two bad ones is still installed');

    const bad = out.get('gu-test-baddep');
    assert.strictEqual(bad.status, 'failed');
    assert.match(bad.reason, /^the package could not be installed: /);
    assert.match(bad.reason, /gu-test-no-such-package|unmet|held broken/, `apt's own reason is shown: ${bad.reason}`);
    assert.strictEqual(installedVersion('gu-test-baddep'), null);

    assert.match(out.get('gu-test-changed').reason, /changed after it was downloaded, so it was not run/);
    assert.strictEqual(installedVersion('gu-test-changed'), null, 'the swapped file was never installed');

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
    assert.strictEqual(installedVersion('gu-test-good'), '1.0', 'left by the test before');
    const { entries, log } = await entriesFor(stageBase, [['gu-test-good', buildDeb(dir, 'gu-test-good', '2.0')]]);
    await elevate.finish(entries, { linux: TOOLS, stageBase, spawn: viaSudo });
    assert.deepStrictEqual(log, ['succeed gu-test-good']);
    assert.strictEqual(installedVersion('gu-test-good'), '2.0');
    assert.strictEqual(fs.readFileSync('/usr/share/gu-test-good/version.txt', 'utf8'), '2.0\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('root step: a package that hangs is stopped at the time limit, and the run goes on', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const { entries, log } = await entriesFor(stageBase, [
      ['gu-test-slow', buildDeb(dir, 'gu-test-slow', '1.0', { postinst: '#!/bin/sh\nsleep 20\n' })],
    ]);
    const started = Date.now();
    const out = await elevate.finish(entries, { linux: TOOLS, stageBase, spawn: viaSudo, timeoutSecs: 3 });
    const took = (Date.now() - started) / 1000;
    assert.deepStrictEqual(log, [], 'not reported as installed');
    assert.match(out.get('gu-test-slow').reason, /did not finish in time and was stopped/);
    assert.ok(took < 50, `the run came back (${took.toFixed(1)}s), it did not wait on the package for ever`);
    assert.deepStrictEqual(leftInVarTmp(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('root step: without permission nothing runs, and the answer is the dismissed-prompt one', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-admin-'));
  try {
    const stageBase = path.join(dir, 'staging');
    fs.mkdirSync(stageBase);
    const { entries, log } = await entriesFor(stageBase, [['gu-test-second', buildDeb(dir, 'gu-test-second', '9.0')]]);
    // What pkexec does when the prompt is dismissed: the program is never started, exit 126.
    const dismissed = (_exe, _args, options) => spawn('/bin/sh', ['-c', 'exit 126'], options);
    const out = await elevate.finish(entries, { linux: TOOLS, stageBase, spawn: dismissed });
    assert.deepStrictEqual(log, []);
    assert.strictEqual(out.get('gu-test-second').reason, elevate.DECLINED);
    assert.strictEqual(installedVersion('gu-test-second'), '1.0', 'unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
