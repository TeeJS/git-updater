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
    holdVisible: () => {}, // runBatch freezes which rows are shown while it runs (search and filters)
    msg: () => {},
    clean: String,
    window: { api: {
      update: async (body) => { calls.push(['update', body.autoClose]); return { results: [{ status: 'failed', reason: 'download failed', closed: true }] }; },
      openApp: async () => { calls.push('reopen'); },
    } },
  };
  vm.runInNewContext(sourceBetween('async function runBatch(', 'window.api.onProgress('), context);
  await context.runBatch([key], false, true);
  assert.deepEqual(calls, [['update', true], 'reopen']);
  assert.equal(context.st[key].ph, 'failed');
});

test('Update all does not reopen an app when the runner could not close it', async () => {
  const key = 'owner/Example#installer';
  let updates = 0;
  const context = {
    busy: false,
    st: { [key]: { present: true } },
    renderRepos: () => {},
    holdVisible: () => {}, // runBatch freezes which rows are shown while it runs (search and filters)
    msg: () => {},
    clean: String,
    window: { api: {
      update: async () => { updates++; return { results: [{ status: 'failed', reason: 'app did not close gracefully', closed: false }] }; },
      openApp: async () => { throw new Error('unexpected reopen'); },
    } },
  };
  vm.runInNewContext(sourceBetween('async function runBatch(', 'window.api.onProgress('), context);
  await context.runBatch([key], false, true);
  assert.equal(updates, 1);
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
    holdVisible: () => {}, // runBatch freezes which rows are shown while it runs (search and filters)
    msg: () => {},
    clean: String,
    watchInstall: (_key, _from, _wasInstall, callback) => { completion = callback; },
    window: { api: {
      update: async () => ({ results: [{ status: 'failed', reason: 'installer window opened', closed: true }] }),
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
