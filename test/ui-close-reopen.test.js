'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
function sourceBetween(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
}

test('Retry skips both close prompts when the app is no longer running', async () => {
  const calls = [];
  const context = {
    busy: false,
    confirm: () => { throw new Error('unexpected prompt'); },
    msg: () => {},
    clean: String,
    runBatch: async (keys) => calls.push(['update', keys]),
    window: { api: { isAppRunning: async () => false, closeApp: async () => { throw new Error('unexpected close'); } } },
  };
  vm.runInNewContext(sourceBetween('async function closeAndRetry(', '// --- check / update ---'), context);
  await context.closeAndRetry({ repo: 'Example' }, 'owner/Example#installer');
  assert.equal(JSON.stringify(calls), JSON.stringify([['update', ['owner/Example#installer']]]));
});

test('Update all closes and reopens only running apps, including after update failure', async () => {
  const calls = [];
  const key = 'owner/Example#installer';
  const context = {
    busy: false,
    st: { [key]: { present: true } },
    renderRepos: () => {},
    msg: () => {},
    clean: String,
    window: { api: {
      isAppRunning: async () => { calls.push('running'); return true; },
      closeApp: async (_, force) => { calls.push(['close', force]); return { closed: 1, stillRunning: false }; },
      update: async () => { calls.push('update'); return { results: [{ status: 'failed', reason: 'download failed' }] }; },
      openApp: async () => { calls.push('reopen'); },
    } },
  };
  vm.runInNewContext(sourceBetween('async function runBatch(', 'window.api.onProgress('), context);
  await context.runBatch([key], false, true);
  assert.deepEqual(calls, ['running', ['close', false], 'update', 'reopen']);
  assert.equal(context.st[key].ph, 'failed');
});

test('Update all skips an app that refuses graceful close', async () => {
  const key = 'owner/Example#installer';
  let updates = 0;
  const context = {
    busy: false,
    st: { [key]: { present: true } },
    renderRepos: () => {},
    msg: () => {},
    clean: String,
    window: { api: {
      isAppRunning: async () => true,
      closeApp: async (_, force) => { assert.equal(force, false); return { closed: 0, stillRunning: true }; },
      update: async () => { updates++; },
      openApp: async () => { throw new Error('unexpected reopen'); },
    } },
  };
  vm.runInNewContext(sourceBetween('async function runBatch(', 'window.api.onProgress('), context);
  await context.runBatch([key], false, true);
  assert.equal(updates, 0);
  assert.match(context.st[key].reason, /did not close gracefully/);
});

test('interactive installer reopens only after completion callback', async () => {
  const key = 'owner/Example#installer';
  let completion;
  let reopened = 0;
  const context = {
    busy: false,
    st: { [key]: { present: true, from: '1.0' } },
    renderRepos: () => {},
    msg: () => {},
    clean: String,
    watchInstall: (_key, _from, callback) => { completion = callback; },
    window: { api: {
      isAppRunning: async () => true,
      closeApp: async () => ({ closed: 1, stillRunning: false }),
      update: async () => ({ results: [{ status: 'failed', reason: 'installer window opened' }] }),
      openApp: async () => { reopened++; },
    } },
  };
  vm.runInNewContext(sourceBetween('async function runBatch(', 'window.api.onProgress('), context);
  await context.runBatch([key], false, true);
  assert.equal(reopened, 0);
  assert.equal(typeof completion, 'function');
  await completion();
  assert.equal(reopened, 1);
});
