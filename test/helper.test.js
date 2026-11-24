'use strict';

// The installer helper (helper/, PROJECT-one-admin-prompt.md): the job text git-updater
// writes, the results text it reads, and - when the helper has been built on this machine -
// the real program run WITHOUT administrator rights. Nothing here installs anything, and
// nothing here can make Windows show a permission prompt: `--install` is only ever given a
// job the helper refuses before it asks.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const helper = require('../src/helper');
const { CODES, jobText, parseResults } = helper;

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const msi = (extra = {}) => ({ file: 'C:\\stage\\app.msi', sha256: SHA, kind: 'msi', ...extra });

test('jobText writes one field per line, in the form the helper reads', () => {
  const text = jobText(
    [
      msi({ sha256: SHA.toUpperCase(), args: ['/qn', '/norestart'] }),
      { file: 'D:\\x y\\setup.exe', sha256: SHA, kind: 'exe', raw: '/Q /C:"msiexec /i ""x.msi"" /quiet"' },
      { file: 'C:/stage/plain.exe', sha256: SHA, kind: 'exe' },
    ],
    { timeoutSecs: 90 }
  );
  assert.strictEqual(
    text,
    [
      'git-updater-helper-job 1',
      'timeout 90',
      'item',
      'file C:\\stage\\app.msi',
      `sha256 ${SHA}`,
      'kind msi',
      'arg /qn',
      'arg /norestart',
      'item',
      'file D:\\x y\\setup.exe',
      `sha256 ${SHA}`,
      'kind exe',
      'raw /Q /C:"msiexec /i ""x.msi"" /quiet"',
      'item',
      'file C:/stage/plain.exe',
      `sha256 ${SHA}`,
      'kind exe',
      '',
    ].join('\n')
  );
  assert.ok(!jobText([msi()]).includes('timeout'), 'no limit line unless one is given');
  assert.ok(jobText([msi({ args: ['', ' /S '] })]).includes('\narg\narg  /S \n'), 'an empty switch and a spaced one survive as written');
});

test('jobText refuses anything the helper would refuse', () => {
  const bad = (items, opts) => assert.throws(() => jobText(items, opts));
  bad([]);
  bad(null);
  bad(new Array(65).fill(msi()));
  for (const file of ['app.msi', '\\stage\\app.msi', 'C:app.msi', '\\\\server\\share\\app.msi', '\\\\?\\C:\\stage\\app.msi', 'C:\\stage\\..\\app.msi', 'C:\\', 'C:\\a\nb.msi', 'C:\\a"b.msi', undefined]) {
    bad([msi({ file })]);
  }
  bad([msi({ sha256: 'abc' })]);
  bad([msi({ sha256: undefined })]);
  bad([msi({ kind: 'nsis' })]);
  bad([msi({ kind: undefined })]);
  bad([msi({ args: ['/qn'], raw: '/qn' })]);
  bad([msi({ args: '/qn' })]);
  bad([msi({ args: ['/qn\nitem'] })]);
  bad([msi({ args: [7] })]);
  bad([msi({ args: new Array(65).fill('/x') })]);
  bad([msi({ args: ['x'.repeat(9000)] })]);
  bad([msi({ raw: '   ' })]);
  bad([msi({ raw: 'a\rb' })]);
  bad([msi()], { timeoutSecs: 0 });
  bad([msi()], { timeoutSecs: 3601 });
  bad([msi()], { timeoutSecs: 1.5 });
});

test('parseResults gives one code per installer, in job order', () => {
  assert.deepStrictEqual(parseResults('git-updater-helper-results 1\n0 0\n1 3010\n2 64007\n', 3), [0, 3010, 64007]);
  assert.deepStrictEqual(parseResults('git-updater-helper-results 1\r\n2 1603\r\n', 3), [null, null, 1603], 'an installer never reached is null');
  assert.deepStrictEqual(parseResults('git-updater-helper-results 1\n', 2), [null, null]);
  for (const text of ['', 'nonsense', 'git-updater-helper-results 2\n0 0\n', 'git-updater-helper-results 1\n3 0\n', 'git-updater-helper-results 1\n0 0\n0 0\n', 'git-updater-helper-results 1\n0 -1\n', 'git-updater-helper-results 1\nzero 0\n']) {
    assert.throws(() => parseResults(text, 3), JSON.stringify(text));
  }
  assert.ok(helper.succeeded(0) && helper.succeeded(3010));
  assert.ok(!helper.succeeded(1603) && !helper.succeeded(CODES.notSigned) && !helper.succeeded(null));
});

// --- the real program ---------------------------------------------------------------------

const EXE = path.join(__dirname, '..', 'helper', 'target', 'release', 'git-updater-helper.exe');
const built = os.platform() === 'win32' && fs.existsSync(EXE);
const skip = built ? false : 'the helper is a Windows program and has not been built here (cargo build --release in helper/)';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (args, exe = EXE) => spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jobFile(dir, items, opts) {
  const file = path.join(dir, 'job.txt');
  fs.writeFileSync(file, jobText(items, opts));
  return file;
}

test('helper --verify: a job written by jobText is read, and each file gets its verdict', { skip }, (t) => {
  const dir = scratch(t);
  const write = (name, bytes) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const unsigned = write('unsigned.exe', 'MZ not a real program');
  const swapped = write('swapped.exe', 'MZ what was downloaded');
  const swappedSha = sha256(swapped);
  fs.writeFileSync(swapped, 'MZ what someone put there afterwards');
  const script = write('script.exe', 'echo hi');
  const fakeMsi = write('fake.msi', 'PK not an installer database');
  const signed = process.execPath; // node.exe carries the OpenJS Foundation's signature

  const r = run([
    '--verify',
    '--job',
    jobFile(dir, [
      { file: signed, sha256: sha256(signed), kind: 'exe', args: ['--version'] },
      { file: unsigned, sha256: sha256(unsigned), kind: 'exe' },
      { file: swapped, sha256: swappedSha, kind: 'exe', raw: '/S' },
      { file: script, sha256: sha256(script), kind: 'exe' },
      { file: fakeMsi, sha256: sha256(fakeMsi), kind: 'msi', args: ['/qn'] },
      { file: path.join(dir, 'missing.msi'), sha256: SHA, kind: 'msi' },
      { file: signed, sha256: sha256(signed), kind: 'msi' },
    ]),
  ]);
  assert.strictEqual(r.status, CODES.ok, r.stderr);
  assert.deepStrictEqual(parseResults(r.stdout, 7), [
    CODES.ok,
    CODES.notSigned,
    CODES.hashMismatch,
    CODES.notAnInstaller,
    CODES.notAnInstaller,
    CODES.notAnInstaller,
    CODES.notAnInstaller,
  ]);
});

test('helper: a job or command line that is not as specified is refused, without asking for anything', { skip }, (t) => {
  const dir = scratch(t);
  const good = jobFile(dir, [{ file: process.execPath, sha256: SHA, kind: 'exe' }]);
  const broken = path.join(dir, 'broken.txt');
  fs.writeFileSync(broken, `${helper.JOB_HEADER}\nitem\nfile C:\\a.msi\nsha256 ${SHA}\nkind zip\n`);
  const huge = path.join(dir, 'huge.txt');
  fs.writeFileSync(huge, fs.readFileSync(good, 'utf8') + '\n'.repeat(1024 * 1024 + 1));

  const refused = (args) => {
    const r = run(args);
    assert.strictEqual(r.status, CODES.badJob, args.join(' '));
    assert.strictEqual(r.stdout, '', args.join(' '));
  };
  refused([]);
  refused(['--verify']);
  refused(['--verify', '--job', good, '--more']);
  refused(['--verify', '--job', broken]);
  refused(['--verify', '--job', huge]);
  refused(['--verify', '--job', path.join(dir, 'missing.txt')]);
  // --install with a job the helper refuses: it stops BEFORE asking Windows for permission.
  refused(['--install', '--job', broken]);
  refused(['--install', '--job', path.join(dir, 'missing.txt')]);
  // The elevated half takes only a token this program makes: 32 lower-case hex digits.
  refused(['--elevated-run', '--job', good]);
  refused(['--elevated-run', '--job', good, '--token', '..\\..\\Windows']);
  refused(['--elevated-run', '--job', good, '--token', 'A'.repeat(32)]);
});

test('helper: the elevated half refuses to work when it has no administrator rights', { skip }, (t) => {
  const dir = scratch(t);
  const good = jobFile(dir, [{ file: process.execPath, sha256: SHA, kind: 'exe' }]);
  const r = run(['--elevated-run', '--job', good, '--token', 'a'.repeat(32)]);
  // 64003 on a normal account. A test run that is itself elevated would get further, so it
  // is given a job whose only file fails its hash: nothing can run either way.
  assert.ok(r.status === CODES.notElevated || r.status === CODES.ok, `exit ${r.status}`);
  assert.ok(!fs.existsSync(path.join(process.env.ProgramData || 'C:\\ProgramData', `git-updater-helper-${'a'.repeat(32)}`)), 'no folder left behind');
});

test('helper: a library planted beside it is not loaded', { skip }, (t) => {
  // The app folder can be written by the user account, so a file named like a Windows
  // library must not be picked up from there by a program that is about to be elevated.
  const dir = scratch(t);
  const copy = path.join(dir, 'git-updater-helper.exe');
  fs.copyFileSync(EXE, copy);
  for (const name of ['wintrust.dll', 'bcrypt.dll', 'crypt32.dll', 'shell32.dll', 'ole32.dll', 'combase.dll', 'version.dll']) {
    fs.writeFileSync(path.join(dir, name), 'not a library');
  }
  const unsigned = path.join(dir, 'unsigned.exe');
  fs.writeFileSync(unsigned, 'MZ not a real program');
  const r = run(['--verify', '--job', jobFile(dir, [{ file: unsigned, sha256: sha256(unsigned), kind: 'exe' }])], copy);
  assert.strictEqual(r.status, CODES.ok, `exit ${r.status}: the planted files were loaded`);
  assert.deepStrictEqual(parseResults(r.stdout, 1), [CODES.notSigned]);
});
