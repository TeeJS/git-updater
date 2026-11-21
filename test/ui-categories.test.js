'use strict';

// Categories in the main window (ui/index.html): how rows are grouped, how a drag reorders,
// the browser copies of two engine functions, and the one rule the owner asked for above
// all: with the Settings switch off, none of it is on screen.
//
// The grouping helpers are a pure block in the page (no DOM, no globals), run here on its
// own, the same way test/ui-find.test.js runs the search helpers. What is actually drawn
// was checked by driving the real page; see "Categories" in docs/INTERNALS.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../src/core');
const sources = require('../src/sources');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
const begin = html.indexOf('// --- categories: pure helpers');
const end = html.indexOf('// --- end of the pure category helpers ---');
assert.ok(begin >= 0 && end > begin, 'the pure category helpers block is in the page');
const ctx = {};
vm.runInNewContext(html.slice(begin, end) + '\nthis.api = { findListCat, groupRows, movedNextTo, joinDir, folderNameOf, splitOwnFolder };', ctx);
const ui = ctx.api;
const plain = (v) => JSON.parse(JSON.stringify(v)); // out of the vm's realm

const CATS = [{ name: 'Games', dir: 'C:/Games' }, { name: 'Tools', dir: 'D:\\Tools' }];
const app = (repo, category) => ({ owner: 'acme', repo, type: 'portable', ...(category ? { category } : {}) });
const names = (groups) => plain(groups.map((g) => [g.cat ? g.cat.name : 'No category', g.rows.map((r) => r.repo)]));

// --- grouping ---------------------------------------------------------------------------

test('rows are grouped by category: no category first, then the categories in their saved order', () => {
  const rows = [app('z', 'Tools'), app('a'), app('q', 'Games'), app('b'), app('d', 'games')];
  assert.deepStrictEqual(names(ui.groupRows(rows, CATS)), [['No category', ['a', 'b']], ['Games', ['q', 'd']], ['Tools', ['z']]]);
  assert.deepStrictEqual(plain(ui.groupRows(rows, CATS).map((g) => g.id)), ['', 'games', 'tools']);
});

test('the order inside a group is the order the rows came in, so the column sort applies within it', () => {
  const sorted = [app('zeta', 'Games'), app('yak'), app('alpha', 'Games'), app('bee')];
  assert.deepStrictEqual(names(ui.groupRows(sorted, CATS)), [['No category', ['yak', 'bee']], ['Games', ['zeta', 'alpha']]]);
  assert.deepStrictEqual(names(ui.groupRows(sorted.slice().reverse(), CATS)), [['No category', ['bee', 'yak']], ['Games', ['alpha', 'zeta']]]);
});

test('a category with nothing to show has no header: empty, or all of its apps filtered out', () => {
  assert.deepStrictEqual(names(ui.groupRows([app('q', 'Games')], CATS)), [['Games', ['q']]], 'Tools is empty, and nothing is uncategorised');
  assert.deepStrictEqual(names(ui.groupRows([], CATS)), []);
  assert.deepStrictEqual(names(ui.groupRows([app('a')], CATS)), [['No category', ['a']]]);
});

test('an app naming a category that does not exist is shown with the uncategorised ones, never dropped', () => {
  assert.deepStrictEqual(names(ui.groupRows([app('lost', 'Gone'), app('q', 'Games'), app('odd', 7)], CATS)), [['No category', ['lost', 'odd']], ['Games', ['q']]]);
  assert.deepStrictEqual(names(ui.groupRows([app('a', 'Games')], [])), [['No category', ['a']]]);
});

test('categories are matched the way the engine matches them', () => {
  const cfg = { categories: CATS };
  for (const name of ['Games', 'games', ' GAMES ', 'Tools', 'tools ', 'Nope', '', null, undefined, 7]) {
    const mine = ui.findListCat(CATS, name);
    const theirs = core.findCategory(cfg, name);
    assert.strictEqual(mine ? mine.name : null, theirs ? theirs.name : null, String(name));
  }
});

// --- reordering ---------------------------------------------------------------------------

test('a drop moves one item to just before or just after another, and nothing else', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(plain(ui.movedNextTo(list, 'a', 'c', true)), ['b', 'c', 'a', 'd']);
  assert.deepStrictEqual(plain(ui.movedNextTo(list, 'a', 'c', false)), ['b', 'a', 'c', 'd']);
  assert.deepStrictEqual(plain(ui.movedNextTo(list, 'd', 'a', false)), ['d', 'a', 'b', 'c']);
  assert.deepStrictEqual(plain(ui.movedNextTo(list, 'd', 'a', true)), ['a', 'd', 'b', 'c']);
  assert.deepStrictEqual(list, ['a', 'b', 'c', 'd'], 'the list given is not changed');
  // Dropped on itself, or naming something that is no longer in the list: nothing happens.
  assert.strictEqual(ui.movedNextTo(list, 'b', 'b', true), list);
  assert.strictEqual(ui.movedNextTo(list, 'x', 'b', true), list);
  assert.strictEqual(ui.movedNextTo(list, 'b', 'x', true), list);
});

test('reordering within one group keeps every other group\'s apps where they are in config.json', () => {
  const repos = [app('a'), app('q', 'Games'), app('b'), app('r', 'Games'), app('c')];
  const moved = ui.movedNextTo(repos, repos[0], repos[4], true); // a dragged below c, in "No category"
  assert.deepStrictEqual(plain(moved.map((r) => r.repo)), ['q', 'b', 'r', 'c', 'a']);
  assert.deepStrictEqual(names(ui.groupRows(moved, CATS)), [['No category', ['b', 'c', 'a']], ['Games', ['q', 'r']]]);
});

// --- browser copies of engine functions -------------------------------------------------------

test('joinDir is core.resolvePortableDir', () => {
  for (const [root, name] of [
    ['C:/Apps', 'ShareX'], ['C:/Apps/', 'ShareX'], ['C:\\Apps', 'ShareX'], ['E:\\Games\\Recomps\\', 'quiver-launcher'],
    ['\\\\nas\\apps', 'x'], ['/home/me/Apps', 'x'], ['/home/me/My\\Apps/', 'x'], ['/', 'x'], ['c:\\', 'x'], ['Apps\\rel', 'x'],
  ]) assert.strictEqual(ui.joinDir(root, name), core.resolvePortableDir(root, name), root);
});

test('folderNameOf is core.folderName', () => {
  const entries = [
    { owner: 'acme', repo: 'widget', type: 'portable' },
    sources.normalizeEntry({ type: 'portable', name: 'Blender', source: { type: 'folder', url: 'https://download.example.invalid/release/' } }),
    sources.normalizeEntry({ type: 'portable', name: 'A: weird/name? <v2>.  ', source: { type: 'brew', token: 'weird' } }),
    sources.normalizeEntry({ type: 'portable', name: '...', source: { type: 'brew', token: 'dots' } }),
    { owner: 'source.brew', repo: 'x', type: 'portable', source: { type: 'brew', token: 'x' } },
  ];
  for (const r of entries) assert.strictEqual(ui.folderNameOf(r), core.folderName(r), JSON.stringify(r.name || r.repo));
  assert.strictEqual(ui.folderNameOf(null), core.folderName(null));
});

test('the Folder field shows a folder ending in the app\'s name as its parent, with the subfolder box ticked', () => {
  assert.deepStrictEqual(plain(ui.splitOwnFolder('E:\\Games\\quake', 'quake')), { folder: 'E:\\Games', sub: true });
  assert.deepStrictEqual(plain(ui.splitOwnFolder('/home/me/games/Quake/', 'quake')), { folder: '/home/me/games', sub: true });
  assert.deepStrictEqual(plain(ui.splitOwnFolder('E:\\Quake3', 'quake')), { folder: 'E:\\Quake3', sub: false });
  assert.deepStrictEqual(plain(ui.splitOwnFolder('', 'quake')), { folder: '', sub: true }, 'no folder of its own: the box starts ticked');
  assert.deepStrictEqual(plain(ui.splitOwnFolder(undefined, 'quake')), { folder: '', sub: true });
  // Put back together it is the folder it came from.
  const s = ui.splitOwnFolder('E:\\Games\\quake', 'quake');
  assert.strictEqual(ui.joinDir(s.folder, 'quake'), 'E:\\Games\\quake');
});

// --- the switch ---------------------------------------------------------------------------

test('Settings has one checkbox for it, off unless config.json says true', () => {
  assert.match(html, /<input type="checkbox" id="categoriesEnabled"> Group apps into categories<\/label>/);
  assert.match(html, /const catsOn = \(\) => config\.categoriesEnabled === true;/);
  assert.match(html, /\$\('categoriesEnabled'\)\.checked = on;/);
  assert.match(html, /config\.categoriesEnabled = \$\('categoriesEnabled'\)\.checked;/);
  // The row is in "Apps and display", and has no explanation line of its own while it is off.
  const group = html.slice(html.indexOf('id="sg-apps"'), html.indexOf('id="sg-updating"'));
  assert.match(group, /id="categoriesEnabled"/);
  assert.match(group, /<p class="hint" id="catHint" hidden>/);
});

test('everything the feature adds to the page starts hidden, and is shown only by the switch', () => {
  for (const id of ['editCat', 'editDirRow', 'editSubRow', 'catEditor', 'catHint']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, id);
    const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
    assert.match(tag, /\shidden[\s>]/, `${id} is hidden in the markup: ${tag}`);
  }
  // A closed <dialog> is not displayed; the move dialog is only ever opened by a move.
  assert.match(html, /<dialog id="moveAsk"/);
  assert.strictEqual((html.match(/\$\('moveAsk'\)\.showModal\(\)/g) || []).length, 1);
  assert.match(html, /\$\('catEditor'\)\.hidden = !on;/);
  assert.match(html, /\$\('catHint'\)\.hidden = !on;/);
  // The Edit form's extra controls need the switch AND an app being edited.
  assert.match(html, /const r = catsOn\(\) \? editedEntry\(\) : null;/);
  assert.match(html, /\$\('editDirRow'\)\.hidden = !portable;/);
});

test('off, the list is drawn by the same code as before: no headers, no dragging, no extra menu items', () => {
  // Headers only with the switch on and at least one category; otherwise the plain loop.
  assert.match(html, /if \(catsOn\(\) && listCats\(\)\.length\) renderGroups\(tb, shown, renderRow\);\s*else shown\.forEach\(\(r\) => renderRow\(r, ''\)\);/);
  assert.match(html, /const dragApps = catsOn\(\) && !busy && !SORT_COLUMNS\.includes\(config\.sortColumn\);/);
  assert.match(html, /if \(dragApps\) makeDraggable\(row,/);
  // The only callers that make anything draggable are behind the switch.
  const uses = [...html.matchAll(/makeDraggable\(/g)].length;
  assert.strictEqual(uses, 4, 'the definition, an app row, a category header, a Settings row');
  assert.match(html, /function renderCatEditor\(\) \{\s*const list = \$\('catList'\);\s*list\.replaceChildren\(\);\s*if \(!catsOn\(\)\) return;/);
  // The row menu.
  const menu = html.slice(html.indexOf('function openMenu('), html.indexOf('// --- choose download ---'));
  assert.match(menu, /if \(catsOn\(\)\) \{[^}]*Move to \$\{c\.name\}[^}]*\}/s);
  assert.strictEqual((menu.match(/Move to|Remove from category/g) || []).length, 2, 'both items are inside that one block');
  // The Edit form saves the old way unless the switch is on.
  assert.match(html, /async function saveEdit\(\) \{\s*if \(catsOn\(\)\) return saveEditGrouped\(\);/);
  assert.match(html, /if \(catsOn\(\)\) startEditFolder\(r\);/);
  // The row tooltip gains its Folder line only with the switch on.
  assert.match(html, /if \(catsOn\(\) && r\.type === 'portable' && dirOf\(r\)\) appSpan\.title \+=/);
});

test('sorting: the third click that clears a column sort exists only with the switch on', () => {
  const handler = html.slice(html.indexOf("header.querySelector('button').onclick = async () => {"), html.indexOf('function renderRepos()'));
  assert.match(handler, /if \(catsOn\(\) && config\.sortColumn === col && config\.sortDirection === 'desc'\) \{\s*delete config\.sortColumn;\s*delete config\.sortDirection;/);
  // The original two-state toggle is still there, unchanged, for everyone else.
  assert.match(handler, /config\.sortDirection = config\.sortColumn === col && config\.sortDirection !== 'desc' \? 'desc' : 'asc';\s*config\.sortColumn = col;/);
  assert.match(html, /if \(catsOn\(\) && active && config\.sortDirection === 'desc'\) button\.title = /);
});

test('the list is still rendered from the sorted, filtered rows, and grouping comes after both', () => {
  const render = html.slice(html.indexOf('function renderRepos()'), html.indexOf('function targetKeys()'));
  assert.ok(render.indexOf('const shown = visibleRepos(sortedRepos())') < render.indexOf('renderGroups(tb, shown, renderRow)'));
  // Collapsing only folds rows away: what the toolbar acts on is decided before grouping.
  assert.ok(render.indexOf('shownKeys = new Set(shown.map(keyOf))') < render.indexOf('renderGroups('));
});

test('collapsed groups are remembered in the window, never in config.json', () => {
  assert.match(html, /localStorage\.getItem\('collapsedGroups'\)/);
  assert.match(html, /localStorage\.setItem\('collapsedGroups', JSON\.stringify\(\[\.\.\.collapsed\]\)\)/);
  assert.doesNotMatch(html, /config\.collapsed/);
  const toggle = html.slice(html.indexOf('function toggleGroup('), html.indexOf('// The list, one thin header line'));
  assert.doesNotMatch(toggle, /saveConfig|changeGrouping/);
});

// --- where changes go -------------------------------------------------------------------------

test('every change to a category or a folder goes to the main process; the window never saves one itself', () => {
  assert.match(preloadJs, /changeGrouping: \(change, confirmed\) => ipcRenderer\.invoke\('grouping:change', \{ change, confirmed \}\)/);
  assert.match(preloadJs, /pickFolder: \(kind, startDir\) => ipcRenderer\.invoke\('pick-folder', kind, startDir\)/);
  const block = html.slice(html.indexOf('// --- categories ---'), html.indexOf('// --- end of the categories block ---'));
  // The only thing saved with saveConfig in the whole block is the switch and the apps' order.
  const saves = [...block.matchAll(/saveConfig\(\)/g)].length;
  assert.strictEqual(saves, 2, 'the order of the apps, and the switch');
  assert.doesNotMatch(block, /\.category = |install\.dir = |\.install = /, 'the window never writes a category or a folder into its config');
  for (const op of ['add-category', 'set-category-folder', 'remove-category', 'order-categories', 'move-app', 'edit-app']) {
    assert.match(block, new RegExp(`op: '${op}'`), op);
  }
});

test('folders are never moved without the user seeing the exact list first, and Cancel is the default', () => {
  const flow = html.slice(html.indexOf('async function groupingChange('), html.indexOf('// What was done, and every folder that moved'));
  assert.match(flow, /while \(res && res\.needsConfirm\) \{\s*if \(!\(await askMove\(res\.moves\)\)\) return null;/);
  assert.match(flow, /res = await window\.api\.changeGrouping\(change, res\.token\);/);
  assert.match(html, /<button type="button" id="moveAskNo" autofocus>Cancel<\/button>/);
  assert.match(html, /\$\('moveAsk'\)\.addEventListener\('close', \(\) => answerMove\(false\)\);/, 'Esc is a no');
  // What moved is always said afterwards.
  assert.match(html, /parts\.push\(`Moved \$\{moved\[0\]\.name\}'s folder to \$\{moved\[0\]\.to\}\.`\);/);
});

test('the words on screen are plain: no config names, and "category" means one thing in this window', () => {
  const block = html.slice(html.indexOf('// --- categories ---'), html.indexOf('// --- end of the categories block ---'));
  const shown = [...block.matchAll(/(?:msg\(|textContent = |title = |placeholder = |el\('[a-z]+', [^,]+, )[`']([^`']+)[`']/g)].map((m) => m[1]).join('\n');
  assert.ok(shown.length > 200, 'the strings were found');
  assert.doesNotMatch(shown, /install\.dir|relocat|portableRoot|categoriesEnabled|\bpattern\b|\bglob\b|\bIPC\b/i);
  const settings = html.slice(html.indexOf('id="catEditor"'), html.indexOf('id="srcPref"'));
  assert.doesNotMatch(settings.replace(/<[^>]+>/g, ' '), /install\.dir|relocat|<repo>/i);
  // Popular apps sorts its apps under headings it also calls categories. With the switch on
  // the main window has categories of its own, so its button stops using the word.
  assert.match(html, /\$\('browseAll'\)\.title = on \? 'Pick apps from a list of well-known apps' : POPULAR_TIP;/);
});
