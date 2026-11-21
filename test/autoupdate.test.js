'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const au = require('../src/autoupdate');

const app = (owner, repo, type, extra = {}) => ({ owner, repo, type, ...extra });

test('only apps ticked for auto-update are touched, and only if already installed', () => {
  const repos = [
    app('a', 'ticked-installed', 'installer', { autoUpdate: true }),
    app('b', 'ticked-not-installed', 'installer', { autoUpdate: true }),
    app('c', 'unticked', 'installer'),
    app('d', 'explicitly-off', 'portable', { autoUpdate: false }),
    app('e', 'truthy-but-not-true', 'portable', { autoUpdate: 'yes' }),
    app('f', 'ticked-portable', 'portable', { autoUpdate: true }),
  ];
  const installed = {
    'a/ticked-installed#installer': { present: true },
    'b/ticked-not-installed#installer': { present: false },
    'c/unticked#installer': { present: true },
    'f/ticked-portable#portable': { present: true },
  };
  const { targets, skipped } = au.pickTargets(repos, installed);
  assert.deepEqual(targets.map((r) => r.repo), ['ticked-portable', 'ticked-installed'], 'portable first, installers last');
  assert.deepEqual(skipped.map((s) => s.name), ['b/ticked-not-installed'], 'a schedule never installs a new app');
  assert.equal(skipped[0].why, 'not installed');
});

test('order is stable within a kind, and an empty or missing list is fine', () => {
  const repos = [app('x', 'i1', 'installer', { autoUpdate: true }), app('x', 'p1', 'portable', { autoUpdate: true }), app('x', 'i2', 'installer', { autoUpdate: true }), app('x', 'p2', 'portable', { autoUpdate: true })];
  const installed = Object.fromEntries(repos.map((r) => [au.keyOf(r), { present: true }]));
  assert.deepEqual(au.pickTargets(repos, installed).targets.map((r) => r.repo), ['p1', 'p2', 'i1', 'i2']);
  assert.deepEqual(au.pickTargets([], {}), { targets: [], skipped: [] });
  assert.deepEqual(au.pickTargets(undefined, undefined), { targets: [], skipped: [] });
});

test('results are sorted into updated, current, running, needs-you and failed', () => {
  assert.equal(au.classify({ status: 'updated' }), 'updated');
  assert.equal(au.classify({ status: 'current' }), 'current');
  assert.equal(au.classify({ status: 'failed', reason: "needs you: widget's installer needs administrator permission" }), 'needsYou');
  assert.equal(au.classify({ status: 'failed', reason: 'widget is running — close it, then Retry' }), 'running');
  assert.equal(au.classify({ status: 'failed', reason: 'widget did not close gracefully — close it manually, then Retry' }), 'running');
  assert.equal(au.classify({ status: 'failed', reason: 'checksum mismatch' }), 'failed');
  assert.equal(au.classify(undefined), 'failed');
});

test('the summary names what was updated and what needs you, and stays quiet when nothing happened', () => {
  const s = au.summarize([
    { name: 'a/one', result: { status: 'updated' } },
    { name: 'b/two', result: { status: 'updated' } },
    { name: 'c/three', result: { status: 'current' } },
    { name: 'd/four', result: { status: 'failed', reason: "needs you: four's installer needs administrator permission, so it was not run unattended. Update it from the window." } },
    { name: 'e/five', result: { status: 'failed', reason: 'five is running — close it, then Retry' } },
    { name: 'f/six', result: { status: 'failed', reason: 'GitHub rate limit hit' } },
  ]);
  assert.deepEqual(s.updated, ['a/one', 'b/two']);
  assert.equal(s.current, 1);
  assert.equal(s.needsYou[0].name, 'd/four');
  assert.match(s.needsYou[0].reason, /^four's installer needs administrator permission/, 'the "needs you:" prefix is dropped for display');
  assert.deepEqual(s.running, ['e/five']);
  assert.equal(s.failed[0].name, 'f/six');
  assert.equal(au.summaryText(s), 'Updated 2 apps: a/one, b/two. 2 need you: d/four, e/five. 1 could not be updated: f/six. Click to open git-updater.');
  assert.equal(au.summaryText(au.summarize([{ name: 'x/y', result: { status: 'current' } }])), null, 'all current: no notification');
  assert.equal(au.summaryText(au.summarize([])), null);
  assert.equal(au.summaryText(au.summarize([{ name: 'a/one', result: { status: 'updated' } }])), 'Updated 1 app: a/one. Click to open git-updater.');
});

test('a long list of names is shortened', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ name: `o/${n}`, result: { status: 'updated' } }));
  assert.match(au.summaryText(au.summarize(entries)), /^Updated 5 apps: o\/a, o\/b, o\/c and 2 more\./);
});

// --- at sign-in -------------------------------------------------------------------------

test('sign-in: does nothing more than open unless start-at-sign-in is on and an action is chosen', () => {
  const { loginAction } = au;
  assert.strictEqual(loginAction(null), 'open');
  assert.strictEqual(loginAction({}), 'open');
  assert.strictEqual(loginAction({ startAtLogin: true }), 'open', 'an install from before this setting existed');
  assert.strictEqual(loginAction({ startAtLogin: false, loginAction: 'update' }), 'open', 'the setting is kept, but unused while start-at-sign-in is off');
  assert.strictEqual(loginAction({ startAtLogin: true, loginAction: 'nonsense' }), 'open');
  for (const a of ['check', 'ask', 'update']) assert.strictEqual(loginAction({ startAtLogin: true, loginAction: a }), a);
});

test('sign-in: "then quit" only when nothing needs the user, never with the tray on, never under a window in use', () => {
  const { quitAfterLogin, needsUser, summarize } = au;
  const cfg = { startAtLogin: true, loginAction: 'update', loginQuit: true };
  assert.strictEqual(quitAfterLogin(cfg, true, false), true);
  assert.strictEqual(quitAfterLogin(cfg, false, false), false, 'something needs the user');
  assert.strictEqual(quitAfterLogin(cfg, true, true), false, 'the user has the window up');
  assert.strictEqual(quitAfterLogin({ ...cfg, keepRunning: true }, true, false), false, 'keep running in the tray wins');
  assert.strictEqual(quitAfterLogin({ ...cfg, loginQuit: false }, true, false), false);
  assert.strictEqual(quitAfterLogin({ ...cfg, loginAction: 'open' }, true, false), false, 'just opening never quits');
  assert.strictEqual(needsUser(null), false, 'no ticked apps: nothing ran, nothing is waiting');
  assert.strictEqual(needsUser(summarize([{ name: 'a', result: { status: 'updated' } }, { name: 'b', result: { status: 'current' } }])), false);
  assert.strictEqual(needsUser(summarize([{ name: 'a', result: { status: 'failed', reason: 'needs you: administrator permission' } }])), true);
  assert.strictEqual(needsUser(summarize([{ name: 'a', result: { status: 'failed', reason: 'a is running — close it, then Retry' } }])), true);
  assert.strictEqual(needsUser(summarize([{ name: 'a', result: { status: 'failed', reason: 'download failed' } }])), true);
});

test('sign-in: the question names the apps in plain words', () => {
  assert.strictEqual(au.askText(['a/one']), '1 update is ready: a/one.');
  assert.strictEqual(au.askText(['a', 'b', 'c', 'd', 'e']), '5 updates are ready: a, b, c and 2 more.');
});

test('sign-in: main runs it once, only on a real sign-in start, and Settings has the one line', () => {
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.strictEqual(main.split('signInRun()').length - 1, 2, 'defined once, called once');
  assert.match(main, /if \(signedIn && !quietRestart\) signInRun\(\);/);
  assert.match(main, /backgroundInstall\('sign-in update'\)/, 'the update is the scheduled install, with its rules');
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const row = html.slice(html.indexOf('id="loginRow"'), html.indexOf('id="keepRunning"'));
  assert.ok(html.indexOf('id="startAtLogin"') < html.indexOf('id="loginRow"'), 'directly under the start-at-sign-in box');
  for (const text of ['When it starts at sign-in:', 'Just open', 'Check', 'Check and ask me', 'Check and update', 'then quit when finished']) assert.ok(row.includes(text), text);
});
