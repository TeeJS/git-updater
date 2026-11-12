'use strict';

// The search box and the Type / Status filters in the main window. The matching rules live in a
// pure block of ui/index.html (between two marker comments) so they can run here on their own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const begin = html.indexOf('// --- find and filter');
const end = html.indexOf('// --- end of the pure find helpers ---');
assert.ok(begin > 0 && end > begin, 'pure find helpers found');
const source = html.slice(begin, end);
const ctx = {};
vm.runInNewContext(source, ctx);
const lists = vm.runInNewContext(`${source}; [TYPE_FILTERS, STATUS_FILTERS]`, {});
const TYPE_FILTERS = Array.from(lists[0]);
const STATUS_FILTERS = Array.from(lists[1]);

const repo = (owner, name, type = 'portable') => ({ owner, repo: name, type });
const tee = repo('TeeJS', 'bedrock-panel', 'installer');
const brave = repo('brave', 'brave-browser');

test('search: matches the owner, the app name, or owner/app, ignoring case', () => {
  assert.equal(ctx.matchesSearch(tee, 'teejs'), true, 'owner');
  assert.equal(ctx.matchesSearch(tee, 'BEDROCK'), true, 'app name, upper case');
  assert.equal(ctx.matchesSearch(tee, 'rock-pa'), true, 'middle of a name');
  assert.equal(ctx.matchesSearch(tee, 'teejs/bedrock'), true, 'owner/app typed together');
  assert.equal(ctx.matchesSearch(tee, '  teejs  '), true, 'surrounding spaces are ignored');
  assert.equal(ctx.matchesSearch(tee, 'brave'), false);
  assert.equal(ctx.matchesSearch(tee, 'installer'), false, 'the type is not searched');
  assert.equal(ctx.matchesSearch(tee, ''), true, 'empty search matches everything');
  assert.equal(ctx.matchesSearch(tee, undefined), true);
});

test('status filter: each choice picks exactly the rows it names', () => {
  const rows = {
    unchecked: { ph: 'idle', present: true },
    notInstalled: { ph: 'idle', present: false },
    current: { ph: 'current', present: true },
    installed: { ph: 'installed', present: true },
    updated: { ph: 'updated', present: true },
    update: { ph: 'available', present: true },
    installable: { ph: 'available', present: false },
    failed: { ph: 'failed', present: true },
    checking: { ph: 'checking', present: true },
    downloading: { ph: 'downloading', present: true },
    loading: { ph: 'loading' },
  };
  const pick = (choice) => Object.keys(rows).filter((k) => ctx.matchesStatus(rows[k], choice)).sort();
  assert.deepEqual(pick('all'), Object.keys(rows).sort());
  assert.deepEqual(pick('unchecked'), ['notInstalled', 'unchecked']);
  assert.deepEqual(pick('uptodate'), ['current', 'installed', 'updated']);
  assert.deepEqual(pick('available'), ['installable', 'update'], 'what the toolbar counts');
  assert.deepEqual(pick('update'), ['update']);
  assert.deepEqual(pick('installable'), ['installable']);
  assert.deepEqual(pick('failed'), ['failed']);
  assert.deepEqual(pick('working'), ['checking', 'downloading', 'loading']);
  assert.deepEqual(pick('present'), ['checking', 'current', 'downloading', 'failed', 'installed', 'unchecked', 'update', 'updated']);
  assert.deepEqual(pick('absent'), ['installable', 'loading', 'notInstalled']);
  assert.equal(ctx.matchesStatus(undefined, 'unchecked'), true, 'an app with no status yet counts as not checked');
});

test('a row has to match the search, the type and the status together', () => {
  const s = { ph: 'available', present: true };
  const all = { text: '', type: 'all', status: 'all' };
  assert.equal(ctx.matchesFilters(tee, s, all), true);
  assert.equal(ctx.matchesFilters(tee, s, { ...all, text: 'tee', type: 'installer', status: 'update' }), true);
  assert.equal(ctx.matchesFilters(tee, s, { ...all, text: 'tee', type: 'portable' }), false, 'wrong type');
  assert.equal(ctx.matchesFilters(tee, s, { ...all, text: 'brave' }), false, 'wrong text');
  assert.equal(ctx.matchesFilters(tee, s, { ...all, status: 'failed' }), false, 'wrong status');
  assert.equal(ctx.matchesFilters(brave, { ph: 'idle' }, { ...all, type: 'portable', status: 'unchecked' }), true);
});

test('filtersActive: only a real choice counts, not blank search text', () => {
  assert.equal(ctx.filtersActive({ text: '', type: 'all', status: 'all' }), false);
  assert.equal(ctx.filtersActive({ text: '   ', type: 'all', status: 'all' }), false);
  assert.equal(ctx.filtersActive({ text: 'a', type: 'all', status: 'all' }), true);
  assert.equal(ctx.filtersActive({ text: '', type: 'installer', status: 'all' }), true);
  assert.equal(ctx.filtersActive({ text: '', type: 'all', status: 'failed' }), true);
});

test('remember filters: off starts from All; on restores the saved choices; junk falls back to All', () => {
  assert.deepEqual({ ...ctx.savedFilters({ filterType: 'installer', filterStatus: 'failed' }) }, { type: 'all', status: 'all' });
  assert.deepEqual({ ...ctx.savedFilters({ rememberFilters: true, filterType: 'installer', filterStatus: 'failed' }) }, { type: 'installer', status: 'failed' });
  assert.deepEqual({ ...ctx.savedFilters({ rememberFilters: true, filterType: 'bogus', filterStatus: 'nope' }) }, { type: 'all', status: 'all' });
  assert.deepEqual({ ...ctx.savedFilters({ rememberFilters: true }) }, { type: 'all', status: 'all' });
});

test('the dropdowns offer exactly the choices the rules know, All first', () => {
  const options = (id) => {
    const from = html.indexOf(`id="${id}"`);
    const block = html.slice(from, html.indexOf('</select>', from));
    return [...block.matchAll(/value="(\w+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual(options('filterType'), TYPE_FILTERS);
  assert.deepEqual(options('filterStatus'), STATUS_FILTERS);
  assert.equal(TYPE_FILTERS[0], 'all');
  assert.equal(STATUS_FILTERS[0], 'all');
});

test('every status choice other than All really filters something (none silently shows everything)', () => {
  const sample = [
    { ph: 'idle', present: true }, { ph: 'idle', present: false }, { ph: 'current', present: true },
    { ph: 'available', present: true }, { ph: 'available', present: false }, { ph: 'failed', present: true },
    { ph: 'checking', present: true },
  ];
  for (const choice of STATUS_FILTERS.filter((c) => c !== 'all')) {
    const hits = sample.filter((s) => ctx.matchesStatus(s, choice)).length;
    assert.ok(hits > 0 && hits < sample.length, `${choice} matches some rows and not others (${hits} of ${sample.length})`);
  }
});

test('the toolbar buttons act on the rows on screen while filtering', () => {
  assert.match(html, /\$\('checkAll'\)\.onclick = \(\) => \{[^}]*checkApps\(targetKeys\(\)\)/);
  assert.match(html, /\$\('updateAll'\)\.onclick = \(\) => runBatch\(targetKeys\(\)/);
  assert.match(html, /\$\('updateSel'\)\.onclick = \(\) => runBatch\(selectedTargets\(\)\)/);
  assert.match(html, /const shown = visibleRepos\(sortedRepos\(\)\)/, 'the list is rendered from the filtered rows');
});
