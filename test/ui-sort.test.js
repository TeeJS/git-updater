'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../src/core');
const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const browser = { window: {} };
vm.runInNewContext(html.slice(html.indexOf('// Browser copy of core.cmpVersion'), html.indexOf('let config =')), browser);
const start = html.indexOf('function sortedRepos()');
const end = html.indexOf('function renderSortHeaders()', start);
assert.ok(start > 0 && end > start);
const source = html.slice(start, end);
const dateSource = html.slice(html.indexOf('function statusDate('), html.indexOf('function primaryAction('));
const repos = [
  { owner: 'x', repo: 'older', type: 'portable' },
  { owner: 'x', repo: 'newer', type: 'installer' },
];
const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;

// Settings -> "Sort the list at startup by": the helpers sit just above sortedRepos().
const startupSource = html.slice(html.indexOf('const SORT_COLUMNS'), start);
assert.ok(startupSource.includes('function applyStartupSort'), 'startup sort helpers found');

test('startup sort: off leaves the remembered sort alone', () => {
  const context = {};
  vm.runInNewContext(startupSource, context);
  const cfg = { sortColumn: 'status', sortDirection: 'desc', startupSortColumn: 'owner', startupSortDirection: 'asc' };
  assert.equal(context.applyStartupSort(cfg), false);
  assert.equal(cfg.sortColumn, 'status');
  assert.equal(cfg.sortDirection, 'desc');
});

test('startup sort: on replaces the remembered sort with the chosen column and direction', () => {
  const context = {};
  vm.runInNewContext(startupSource, context);
  for (const column of ['owner', 'app', 'type', 'current', 'available', 'status']) {
    for (const direction of ['asc', 'desc']) {
      const cfg = { sortColumn: 'type', sortDirection: 'asc', startupSortEnabled: true, startupSortColumn: column, startupSortDirection: direction };
      assert.equal(context.applyStartupSort(cfg), true);
      assert.deepEqual([cfg.sortColumn, cfg.sortDirection], [column, direction]);
    }
  }
});

test('startup sort: a hand-edited bad column or direction falls back instead of breaking the list', () => {
  const context = {};
  vm.runInNewContext(startupSource, context);
  const bad = { sortColumn: 'status', sortDirection: 'desc', startupSortEnabled: true, startupSortColumn: 'bogus', startupSortDirection: 'sideways' };
  context.applyStartupSort(bad);
  assert.deepEqual([bad.sortColumn, bad.sortDirection], ['status', 'asc']); // bad column -> the remembered one; bad direction -> asc
  const nothing = { startupSortEnabled: true };
  context.applyStartupSort(nothing);
  assert.deepEqual([nothing.sortColumn, nothing.sortDirection], ['app', 'asc']);
  // Never set before: the controls start on the sort that is already in effect.
  const first = { sortColumn: 'current', sortDirection: 'desc' };
  assert.deepEqual({ ...context.startupSortChoice(first) }, { column: 'current', direction: 'desc' });
});

test('startup sort: the list really opens in the chosen order', () => {
  const rows = [
    { owner: 'aaa', repo: 'alpha', type: 'portable' },
    { owner: 'zzz', repo: 'zed', type: 'portable' },
  ];
  const config = { repos: [...rows], sortColumn: 'app', sortDirection: 'asc', startupSortEnabled: true, startupSortColumn: 'owner', startupSortDirection: 'desc' };
  const context = { config, st: {}, busy: false, displayOrder: null, keyOf, window: browser.window, statusView: () => ({ text: '' }) };
  vm.runInNewContext(startupSource + source, context);
  assert.equal(context.sortedRepos()[0].owner, 'aaa'); // the remembered sort (App, ascending) puts aaa/alpha first...
  context.applyStartupSort(config);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.owner), ['zzz', 'aaa']); // ...the startup sort (Owner, descending) puts zzz first
  assert.deepEqual(config.repos.map((r) => r.owner), ['aaa', 'zzz'], 'the saved list order is untouched');
});

test('startup sort: the Settings dropdown offers exactly the columns the header can sort by', () => {
  const context = {};
  const columns = vm.runInNewContext(`${startupSource}; SORT_COLUMNS`, context);
  const select = html.slice(html.indexOf('id="startupSortColumn"'), html.indexOf('</select>', html.indexOf('id="startupSortColumn"')));
  const offered = [...select.matchAll(/value="(\w+)"/g)].map((m) => m[1]);
  const header = html.slice(html.indexOf('class="table-header"'), html.indexOf('id="rows"'));
  const sortable = [...header.matchAll(/data-sort="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, Array.from(columns));
  assert.deepEqual([...offered].sort(), [...sortable].sort());
});

test('version sort uses version precedence and leaves saved config order intact', () => {
  const config = { repos: [...repos], sortColumn: 'current', sortDirection: 'asc' };
  const st = { [keyOf(repos[0])]: { from: '1.10' }, [keyOf(repos[1])]: { from: '1.2' } };
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: browser.window, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  assert.equal(context.sortedRepos()[0].repo, 'newer');
  assert.deepEqual(config.repos.map((r) => r.repo), ['older', 'newer']);
  config.sortDirection = 'desc';
  assert.equal(context.sortedRepos()[0].repo, 'older');
  assert.deepEqual(config.repos.map((r) => r.repo), ['older', 'newer']);
});

test('rows keep their displayed order while busy', () => {
  const config = { repos: [...repos], sortColumn: 'app', sortDirection: 'asc' };
  const context = { config, st: {}, busy: false, displayOrder: null, keyOf, window: browser.window, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['newer', 'older']);
  context.busy = true;
  config.sortDirection = 'desc';
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['newer', 'older']);
  context.busy = false;
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['older', 'newer']);
});

test('Owner sorts by owner then name; App sorts by repo name alone', () => {
  const list = [
    { owner: 'TeeJS', repo: 'bedrock-panel', type: 'installer' },
    { owner: 'anomalyco', repo: 'opencode', type: 'installer' },
    { owner: 'can1357', repo: 'oh-my-pi', type: 'portable' },
    { owner: 'anomalyco', repo: 'another', type: 'portable' },
  ];
  const config = { repos: [...list], sortColumn: 'app', sortDirection: 'asc' };
  const context = { config, st: {}, busy: false, displayOrder: null, keyOf, window: browser.window, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  const names = () => Array.from(context.sortedRepos(), (r) => `${r.owner}/${r.repo}`);
  assert.deepEqual(names(), ['anomalyco/another', 'TeeJS/bedrock-panel', 'can1357/oh-my-pi', 'anomalyco/opencode']);
  config.sortDirection = 'desc';
  assert.deepEqual(names(), ['anomalyco/opencode', 'can1357/oh-my-pi', 'TeeJS/bedrock-panel', 'anomalyco/another']);
  config.sortColumn = 'owner';
  config.sortDirection = 'asc';
  assert.deepEqual(names(), ['anomalyco/another', 'anomalyco/opencode', 'can1357/oh-my-pi', 'TeeJS/bedrock-panel']);
  config.sortDirection = 'desc';
  assert.deepEqual(names(), ['TeeJS/bedrock-panel', 'can1357/oh-my-pi', 'anomalyco/opencode', 'anomalyco/another']);
  assert.deepEqual(config.repos.map((r) => r.repo), list.map((r) => r.repo), 'saved order untouched');
});

test('header has separate Owner and App sort buttons in the name column', () => {
  assert.match(html, /data-sort="owner"><button class="sort-button" type="button">Owner</);
  assert.match(html, /data-sort="app"><button class="sort-button" type="button">App</);
});

test('status dates format both ways and old records remain Installed', () => {
  const context = { config: { dateFormat: 'MM/DD' } };
  vm.runInNewContext(dateSource, context);
  assert.equal(context.datedStatus({ date: '2026-12-31T23:30:00.000Z' }).text, 'Installed 12/31');
  assert.equal(context.datedStatus({ date: new Date(2026, 10, 9, 18).toISOString(), lastAction: 'updated' }).text, 'Updated 11/09');
  assert.equal(context.datedStatus({ date: '2026-12-31', lastAction: 'updated' }).text, 'Updated 12/31');
  context.config.dateFormat = 'DD/MM';
  assert.equal(context.datedStatus({ date: '2026-12-31' }).text, 'Installed 31/12');
  assert.equal(context.datedStatus({}).text, 'Installed');
});

test('status sort compares full dates across years, with undated rows last', () => {
  const dated = { owner: 'x', repo: 'dated', type: 'portable' };
  const later = { owner: 'x', repo: 'later', type: 'portable' };
  const undated = { owner: 'x', repo: 'undated', type: 'portable' };
  const config = { repos: [dated, undated, later], sortColumn: 'status', sortDirection: 'asc', dateFormat: 'MM/DD' };
  const st = { [keyOf(dated)]: { ph: 'current', date: '2026-12-31' }, [keyOf(later)]: { ph: 'current', date: '2027-01-02' }, [keyOf(undated)]: { ph: 'current' } };
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: browser.window };
  vm.runInNewContext(dateSource + source, context);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['dated', 'later', 'undated']);
  config.sortDirection = 'desc';
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['later', 'dated', 'undated']);
});

test('status sort groups labels before comparing displayed dates', () => {
  const available = { owner: 'x', repo: 'available', type: 'portable' };
  const installed = { owner: 'x', repo: 'installed', type: 'portable' };
  const failed = { owner: 'x', repo: 'failed', type: 'portable' };
  const config = { repos: [installed, failed, available], sortColumn: 'status', sortDirection: 'asc', dateFormat: 'MM/DD' };
  const st = {
    [keyOf(available)]: { ph: 'available', present: true, date: '2025-01-01' },
    [keyOf(installed)]: { ph: 'current', present: true, date: '2026-12-31' },
    [keyOf(failed)]: { ph: 'failed', reason: 'Failed', date: '2024-01-01' },
  };
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: browser.window };
  vm.runInNewContext(dateSource + source, context);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['failed', 'installed', 'available']);
});

test('browser version comparator matches core version precedence', () => {
  const versions = ['', 'v1.2', '1.2.0', '1.10', '1.2.3-rc2', '1.2.3-rc10', '1.2.3', 'Zoom 7.1.5 (84650)', 'release/v2.6.2', '3.0+build5', '1.2.3 build 9'];
  for (const a of versions) for (const b of versions) {
    assert.equal(Math.sign(browser.window.compareVersions(a, b)), Math.sign(core.cmpVersion(a, b)), `${a} versus ${b}`);
  }
});

test('missing versions stay at the bottom in either direction', () => {
  const config = { repos: [...repos], sortColumn: 'current', sortDirection: 'asc' };
  const st = { [keyOf(repos[0])]: { from: null }, [keyOf(repos[1])]: { from: '1.0' } };
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: browser.window, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  assert.equal(context.sortedRepos()[0].repo, 'newer');
  config.sortDirection = 'desc';
  assert.equal(context.sortedRepos()[0].repo, 'newer');
});

test('interactive installer completion records Updated provenance', async () => {
  const a = html.indexOf('async function watchInstall(');
  const b = html.indexOf('// Close the running app', a);
  const key = 'x/app#installer';
  const calls = [];
  let waits = 0;
  const context = {
    st: { [key]: { ph: 'waiting', present: true } },
    busy: true,
    setTimeout: (fn) => { waits++; if (waits > 1) context.busy = false; fn(); },
    checkApps: async () => { calls.push('check'); },
    renderRepos: () => {},
    msg: () => {},
    clean: String,
    window: { api: {
      getInstalled: async () => ({ [key]: { current: '2.0.0' } }),
      recordInstall: async (_key, from, wasInstall) => {
        assert.equal(context.busy, false, 'recording waits for the batch to release state');
        calls.push([from, wasInstall]);
        return { installedAt: '2026-11-09T20:00:00Z', lastAction: 'updated' };
      },
    } },
  };
  vm.runInNewContext(html.slice(a, b), context);
  await context.watchInstall(key, '1.0.0', false);
  assert.equal(context.st[key].lastAction, 'updated');
  assert.equal(context.st[key].date, '2026-11-09T20:00:00Z');
  assert.deepEqual(calls, [['1.0.0', false], 'check']);
  assert.equal(waits, 2);
});
