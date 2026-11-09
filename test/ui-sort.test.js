'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../src/core');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
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

test('version sort uses version precedence and leaves saved config order intact', () => {
  const config = { repos: [...repos], sortColumn: 'current', sortDirection: 'asc' };
  const st = { [keyOf(repos[0])]: { from: '1.10' }, [keyOf(repos[1])]: { from: '1.2' } };
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: { api: { cmpVersion: core.cmpVersion } }, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  assert.equal(context.sortedRepos()[0].repo, 'newer');
  assert.deepEqual(config.repos.map((r) => r.repo), ['older', 'newer']);
  config.sortDirection = 'desc';
  assert.equal(context.sortedRepos()[0].repo, 'older');
  assert.deepEqual(config.repos.map((r) => r.repo), ['older', 'newer']);
});

test('rows keep their displayed order while busy', () => {
  const config = { repos: [...repos], sortColumn: 'app', sortDirection: 'asc' };
  const context = { config, st: {}, busy: false, displayOrder: null, keyOf, window: { api: { cmpVersion: core.cmpVersion } }, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['newer', 'older']);
  context.busy = true;
  config.sortDirection = 'desc';
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['newer', 'older']);
  context.busy = false;
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['older', 'newer']);
});

test('status dates format both ways and old records remain Installed', () => {
  const context = { config: { dateFormat: 'MM/DD' } };
  vm.runInNewContext(dateSource, context);
  assert.equal(context.datedStatus({ date: '2026-12-31T23:30:00.000Z' }).text, 'Installed 12/31');
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
  const context = { config, st, busy: false, displayOrder: null, keyOf, window: { api: { cmpVersion: core.cmpVersion } } };
  vm.runInNewContext(dateSource + source, context);
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['dated', 'later', 'undated']);
  config.sortDirection = 'desc';
  assert.deepEqual(Array.from(context.sortedRepos(), (r) => r.repo), ['later', 'dated', 'undated']);
});
