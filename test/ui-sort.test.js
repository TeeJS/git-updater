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
