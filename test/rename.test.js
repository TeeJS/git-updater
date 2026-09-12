'use strict';

// Retrying a directory rename through a transient lock.
//
// Reported from a real machine, updating to 0.2.0:
//   EPERM: operation not permitted, rename '...\.git-updater-selfupdate-stage-b8IR51'
//          -> '...\app-0.2.0'
//
// Nothing could legitimately have been holding that path: the staging directory had been
// created by the same process moments earlier. Windows keeps transient handles on files
// that were just written, and antivirus scanning 150MB of fresh executables is the usual
// cause. docs/INTERNALS already called this a known class; it had no mitigation.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const install = require('../src/install');

const err = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('rename: a lock that clears is retried, not reported as a failure', () => {
  let calls = 0;
  const slept = [];
  const out = install.renameWithRetry('from', 'to', {
    rename: () => {
      if (++calls < 3) throw err('EPERM');
      return 'renamed';
    },
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(out, 'renamed');
  assert.equal(calls, 3, 'failed twice, succeeded on the third attempt');
  assert.deepEqual(slept, [100, 200], 'backed off between attempts rather than spinning');
});

test('rename: a lock that never clears still fails, so "close it and Retry" survives', () => {
  // A rename blocked because the app is genuinely running must NOT be retried forever —
  // the user gets the same message, a moment later.
  let calls = 0;
  assert.throws(
    () =>
      install.renameWithRetry('from', 'to', {
        rename: () => {
          calls++;
          throw err('EPERM');
        },
        sleep: () => {},
      }),
    /EPERM/
  );
  assert.equal(calls, 5, 'four backoffs then one final attempt');
});

test('rename: every lock-shaped error is retried', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
    let calls = 0;
    install.renameWithRetry('from', 'to', {
      rename: () => {
        if (++calls < 2) throw err(code);
        return true;
      },
      sleep: () => {},
    });
    assert.equal(calls, 2, code);
  }
});

test('rename: a real error is raised immediately, not retried', () => {
  // A missing source is not going to appear if we wait, and retrying would turn a clear
  // failure into a slow one.
  let calls = 0;
  assert.throws(
    () =>
      install.renameWithRetry('from', 'to', {
        rename: () => {
          calls++;
          throw err('ENOENT');
        },
        sleep: () => assert.fail('must not sleep on a non-transient error'),
      }),
    /ENOENT/
  );
  assert.equal(calls, 1);
});

test('rename: it really does rename, with the default implementation', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-rename-'));
  try {
    const from = path.join(base, 'stage');
    const to = path.join(base, 'app-0.2.0');
    fs.mkdirSync(path.join(from, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(from, 'inner', 'git-updater.exe'), 'payload');
    install.renameWithRetry(from, to);
    assert.equal(fs.readFileSync(path.join(to, 'inner', 'git-updater.exe'), 'utf8'), 'payload');
    assert.equal(fs.existsSync(from), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
