'use strict';

// The Auto-update column: one checkbox per app, saved per app, sortable, filterable, and the thing
// the Install schedule reads. These guard the markup, the grid, the sort and that editing an app
// does not quietly drop its tick.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

test('the header has an Auto-update column, sortable like the others, between Status and the buttons', () => {
  const header = html.slice(html.indexOf('class="table-header"'), html.indexOf('id="rows"'));
  const order = [...header.matchAll(/data-sort="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['owner', 'app', 'type', 'current', 'available', 'status', 'auto']);
  assert.match(header, /data-sort="auto"[^>]*>\s*<button class="sort-button" type="button">Auto-update</);
});

test('the grid has a column for it in both layouts, and a row cell is built for every app', () => {
  // Header and rows share one grid template: 8 columns wide (with Type), 7 narrow (Type hidden).
  const wide = html.slice(html.indexOf('grid-template-columns:\n'), html.indexOf('column-gap: 10px;'));
  assert.equal((wide.match(/\d+px|minmax\(0, 1fr\)/g) || []).length, 8, 'wide grid: checkbox, app, type, current, available, status, auto-update, actions');
  assert.match(wide, /64px\s+\/\* auto-update \*\//);
  assert.match(html, /grid-template-columns: 24px minmax\(0, 1fr\) 88px 88px 160px 64px 100px; column-gap: 8px;/, 'narrow grid has it too');
  assert.match(html, /const autoCell = el\('span', 'auto-cell'\)/);
  assert.match(html, /ac\.title = 'Include this app in the Install schedule'/);
});

test('the window is no narrower than the list needs now that it has another column', () => {
  assert.match(mainJs, /minWidth: 720/);
});

test('ticking saves per app, and unticking removes the key rather than storing false', () => {
  assert.match(html, /if \(ac\.checked\) r\.autoUpdate = true; else delete r\.autoUpdate;/);
});

test('editing an app keeps its Auto-update tick', () => {
  assert.match(html, /const wasAutoUpdate = !!\(editingKey && config\.repos\.find\(\(r\) => keyOf\(r\) === editingKey\)\?\.autoUpdate\)/);
  assert.match(html, /if \(wasAutoUpdate\) entry\.autoUpdate = true;/);
});

test('sorting by Auto-update puts ticked apps first (ascending), then owner/app', () => {
  const start = html.indexOf('function sortedRepos()');
  const end = html.indexOf('function renderSortHeaders()', start);
  const source = html.slice(start, end);
  const repos = [
    { owner: 'b', repo: 'two', type: 'portable' },
    { owner: 'a', repo: 'one', type: 'portable', autoUpdate: true },
    { owner: 'c', repo: 'three', type: 'portable', autoUpdate: true },
    { owner: 'a', repo: 'zero', type: 'portable' },
  ];
  const config = { repos: [...repos], sortColumn: 'auto', sortDirection: 'asc' };
  const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;
  const context = { config, st: {}, busy: false, displayOrder: null, keyOf, window: {}, statusView: () => ({ text: '' }) };
  vm.runInNewContext(source, context);
  const names = () => Array.from(context.sortedRepos(), (r) => r.repo);
  assert.deepEqual(names(), ['one', 'three', 'zero', 'two'], 'ticked first, each group by owner/app');
  config.sortDirection = 'desc';
  assert.deepEqual(names(), ['zero', 'two', 'one', 'three'], 'descending puts unticked first; ties stay in owner/app order, as for every column');
  assert.deepEqual(config.repos.map((r) => r.repo), repos.map((r) => r.repo), 'the saved list order is untouched');
});

test('the startup sort can choose Auto-update, and the filter dropdown exists with the remembered choice', () => {
  assert.match(html, /const SORT_COLUMNS = \['owner', 'app', 'type', 'current', 'available', 'status', 'auto'\]/);
  assert.match(html, /<option value="auto">Auto-update<\/option>/);
  assert.match(html, /config\.filterAuto = filter\.auto;/, 'remembered with the other filters when that is on');
  assert.match(html, /id="filterAuto"/);
});
