'use strict';

// The favorites file as the app really reads it: the handlers in electron/main.js, run for
// real in a vm with fake Electron objects and a real file in a temporary settings folder.
// (The file's own rules are in favorites.test.js; this is the wiring around them.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const favorites = require('../src/favorites');
const catalog = require('../src/catalog');
const packs = require('../src/packs');
const sources = require('../src/sources');
const core = require('../src/core');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
function slice(start, end) {
  const a = mainJs.indexOf(start);
  const b = mainJs.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} .. ${end}`);
  return mainJs.slice(a, b);
}

function harness(config = { repos: [], sourcePreference: [] }) {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-favorites-'));
  const handlers = {};
  const opened = [];
  const revealed = [];
  const logged = [];
  let clip = null;
  const ctx = {
    fs, path, favorites, catalog, packs, sources, core, DATA_DIR,
    process, Set, Map, JSON, Error, Promise, console,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    shell: { openPath: async (p) => { opened.push(p); return ctx.openError || ''; }, showItemInFolder: (p) => revealed.push(p) },
    clipboard: { writeText: (t) => { clip = t; } },
    dialog: {}, BrowserWindow: class {}, win: null,
    log: (line) => logged.push(line),
    readConfig: () => config,
    detect: {},
  };
  vm.runInNewContext(slice('const PACKS_FILE = ', "// Change an existing app's type"), ctx);
  const file = path.join(DATA_DIR, favorites.FILE_NAME);
  let tick = 0;
  // A rewrite must be seen even within the same millisecond: give each one its own mtime.
  const write = (text) => { fs.writeFileSync(file, text); const t = new Date(Date.now() + 2000 * ++tick); fs.utimesSync(file, t, t); };
  // Results come from another realm (the vm): copy them into this one before comparing.
  const call = async (name, ...args) => { const r = await handlers[name]({}, ...args); return r === undefined ? r : JSON.parse(JSON.stringify(r)); };
  return { call, file, write, opened, revealed, logged, clip: () => clip, ctx, DATA_DIR };
}

test.afterEach(() => catalog.setFavorites(null));

test('with no favorites file there is nothing extra, and nothing to complain about', async () => {
  const h = harness();
  assert.deepEqual(await h.call('favorites:status'), { path: h.file, file: 'favorites.yaml', exists: false, apps: 0, pins: 0, packs: 0, problems: [] });
  const rows = await h.call('popular:list');
  assert.ok(rows.length > 20);
  assert.ok(!rows.some((a) => a.favorite));
  assert.ok((await h.call('packs:list')).mine.length === 0);
});

test('Edit favorites file: creates the commented starter once, opens it, and never overwrites', async () => {
  const h = harness();
  assert.deepEqual(await h.call('favorites:open'), { path: h.file, created: true, revealed: false });
  assert.equal(fs.readFileSync(h.file, 'utf8'), favorites.STARTER);
  assert.deepEqual(h.opened, [h.file]);
  // The untouched starter is not a favorites list and not a problem.
  assert.deepEqual((await h.call('favorites:status')).problems, []);
  assert.ok(!(await h.call('popular:list')).some((a) => a.favorite));

  h.write('apps:\n  - me/my-tool\n');
  assert.deepEqual(await h.call('favorites:open'), { path: h.file, created: false, revealed: false });
  assert.equal(fs.readFileSync(h.file, 'utf8'), 'apps:\n  - me/my-tool\n', 'an existing file is opened as it is');

  // No program set up for .yaml: it is shown in its folder instead of failing.
  h.ctx.openError = 'No application is associated with this file';
  assert.equal((await h.call('favorites:open')).revealed, true);
  assert.deepEqual(h.revealed, [h.file]);
});

test('favorites lead the Popular apps list, and an edit is picked up without a restart', async () => {
  const h = harness();
  h.write(`
apps:
  - OBS Studio
  - me/my-tool
  - name: Filed Elsewhere
    category: Media
    repo: me/filed-elsewhere
  - name: New Category
    category: My tools
    repo: me/new-category
  - Not A Real App
`);
  const rows = await h.call('popular:list');
  assert.deepEqual(rows.slice(0, 2).map((a) => [a.id, a.name, a.category, a.favorite]), [
    ['obsstudio', 'OBS Studio', 'My favorites', true],
    ['favmytool', 'my-tool', 'My favorites', true],
  ]);
  // The pinned app keeps its row in its own category as well.
  const obs = rows.filter((a) => a.id === 'obsstudio');
  assert.deepEqual(obs.map((a) => a.category), ['My favorites', 'Media']);
  // Category order as the window draws it: first appearance.
  const order = [...new Set(rows.map((a) => a.category))];
  assert.equal(order[0], 'My favorites');
  assert.equal(order[order.length - 1] === 'My tools' || order.includes('My tools'), true);
  assert.ok(order.indexOf('My tools') > order.indexOf('Media'), 'a new category comes after the built-in ones');
  assert.equal(rows.find((a) => a.id === 'favfiledelsewhere').category, 'Media', 'an existing category is joined, not duplicated');
  assert.equal(order.filter((c) => c === 'Media').length, 1);
  assert.deepEqual(rows.find((a) => a.id === 'favmytool').sources, ['GitHub']);

  const status = await h.call('favorites:status');
  assert.deepEqual([status.exists, status.apps, status.pins, status.packs], [true, 3, 1, 0]);
  assert.equal(status.problems.length, 1);
  assert.match(status.problems[0], /^app 5 \("Not A Real App"\)/);

  // Edit the file: the next question sees the new contents.
  h.write('apps:\n  - me/only-one\n');
  const again = await h.call('popular:list');
  assert.deepEqual(again.filter((a) => a.favorite).map((a) => a.id), ['favonlyone']);
  assert.deepEqual((await h.call('favorites:status')).problems, []);
  // Delete it: back to the built-in list.
  fs.unlinkSync(h.file);
  assert.ok(!(await h.call('popular:list')).some((a) => a.favorite));
  assert.equal((await h.call('favorites:status')).exists, false);
});

test('a favorite\'s description reaches the window: its own apps, and built-in apps it pins', async () => {
  const h = harness();
  h.write(`
apps:
  - name: OBS Studio
    description: What I record the weekly demo with
  - name: My Tool
    repo: me/my-tool
    description: Syncs my notes between machines
  - me/no-description
`);
  const rows = await h.call('popular:list');
  const mine = rows.filter((a) => a.category === 'My favorites').map((a) => [a.id, a.description]);
  assert.deepEqual(mine, [
    ['obsstudio', 'What I record the weekly demo with'],
    ['favmytool', 'Syncs my notes between machines'],
    ['favnodescription', undefined],
  ]);
  // The pinned app's row in its own category keeps the built-in description.
  assert.equal(rows.find((a) => a.id === 'obsstudio' && a.category === 'Media').description, 'Open-source screen recording and live streaming.');
  // Every built-in row has one; a favorite without one of its own simply has none.
  assert.ok(rows.filter((a) => !a.favorite).every((a) => typeof a.description === 'string' && a.description.length <= 100));

  // A built-in app pinned WITHOUT a note shows the built-in description under My favorites too.
  h.write('apps:\n  - OBS Studio\n');
  const pinned = (await h.call('popular:list')).find((a) => a.id === 'obsstudio' && a.category === 'My favorites');
  assert.equal(pinned.description, 'Open-source screen recording and live streaming.');
});

test('a favorite already in the user\'s list shows as tracked', async () => {
  const h = harness({ repos: [{ owner: 'me', repo: 'my-tool', type: 'portable' }], sourcePreference: [] });
  h.write('apps:\n  - me/my-tool\n  - me/other\n');
  const rows = await h.call('popular:list');
  assert.deepEqual(rows.filter((a) => a.favorite).map((a) => [a.id, a.tracked]), [['favmytool', true], ['favother', false]]);
});

test('packs written in the file sit under My packs and only the file can change them', async () => {
  const h = harness();
  h.write(`
apps:
  - name: My Tool
    repo: me/my-tool
packs:
  - name: Work laptop
    description: Every work machine
    apps: [OBS Studio, My Tool, someone/else]
`);
  const { mine, builtin } = await h.call('packs:list');
  assert.ok(builtin.length >= 6);
  assert.deepEqual(mine.map((p) => [p.id, p.name, p.description, p.fromFile, p.count, p.apps]), [
    ['favorites-work-laptop', 'Work laptop', 'Every work machine', true, 3, ['OBS Studio', 'My Tool', 'else']],
  ]);
  await assert.rejects(async () => h.call('packs:delete', 'favorites-work-laptop'), /written in favorites\.yaml — remove it there/);
  assert.equal((await h.call('packs:list')).mine.length, 1);

  // A pack saved in the app with the same name is a separate pack; the file's is untouched.
  const saved = await h.call('packs:save', { name: 'Work laptop', description: 'd', ids: ['obsstudio'] });
  assert.notEqual(saved.id, 'favorites-work-laptop');
  assert.deepEqual((await h.call('packs:list')).mine.map((p) => [p.name, p.fromFile, p.count]), [['Work laptop', true, 3], ['Work laptop', false, 1]]);
});

test('Save as pack: a favorite is stored by where it comes from, so the pack works without the file', async () => {
  const h = harness();
  h.write('apps:\n  - name: My Tool\n    repo: me/my-tool\n');
  await h.call('popular:list');
  const saved = await h.call('packs:save', { name: 'Picked', description: 'Picked in Popular apps.', ids: ['obsstudio', 'favmytool'] });
  assert.deepEqual([saved.name, saved.count, saved.fromFile], ['Picked', 2, false]);
  const stored = JSON.parse(fs.readFileSync(path.join(h.DATA_DIR, 'packs.json'), 'utf8'));
  assert.deepEqual(stored[0].apps, [{ id: 'obsstudio' }, { name: 'My Tool', source: { type: 'github', owner: 'me', repo: 'my-tool' } }]);

  // Without the favorites file the pack still names both apps.
  fs.unlinkSync(h.file);
  assert.deepEqual((await h.call('packs:list')).mine[0].apps, ['OBS Studio', 'My Tool']);
});

test('Copy as favorite puts the ready-made line on the clipboard', async () => {
  const h = harness({ sourcePreference: [], repos: [
    { owner: 'TeeJS', repo: 'bedrock-panel', type: 'portable' },
    { owner: 'obsproject', repo: 'obs-studio', type: 'portable' },
    { ...sources.keyParts({ type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' }), type: 'portable', name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' } },
  ] });
  assert.deepEqual(await h.call('favorites:copy-row', 'TeeJS/bedrock-panel#portable'), { text: '  - TeeJS/bedrock-panel\n', file: 'favorites.yaml' });
  assert.equal(h.clip(), '  - TeeJS/bedrock-panel\n');
  // An app that is in Popular apps is copied by its name there.
  assert.equal((await h.call('favorites:copy-row', 'obsproject/obs-studio#portable')).text, '  - OBS Studio\n');
  const runner = h.ctx.readConfig().repos[2];
  await assert.rejects(async () => h.call('favorites:copy-row', `${runner.owner}/${runner.repo}#portable`), /comes from a source the favorites file cannot name yet/);
  await assert.rejects(async () => h.call('favorites:copy-row', 'no/such#portable'), /app not found/);
});

// --- the same app, tracked from a repository that is not one of the row's own sources -----

test('an app tracked from another repository of the same project shows as in your list', async () => {
  // Bitwarden's desktop app ships from bitwarden/clients; the Popular apps row knows it by its
  // WinGet id and Homebrew cask. Tracking the repository is still tracking Bitwarden.
  const h = harness({ repos: [{ owner: 'Bitwarden', repo: 'Clients', type: 'portable' }], sourcePreference: [] });
  const rows = await h.call('popular:list');
  const bitwarden = rows.find((a) => a.id === 'bitwarden');
  if (process.platform === 'linux') return assert.equal(bitwarden, undefined, 'the row has no source on Linux at all');
  assert.equal(bitwarden.tracked, true, 'matched whatever the letter case');
  assert.equal(rows.find((a) => a.id === 'obsidian').tracked, false, 'and only that app');
  // Without it in the list, the row is not marked.
  const none = await harness().call('popular:list');
  assert.equal(none.find((a) => a.id === 'bitwarden').tracked, false);
});

test('`also` names real GitHub repositories and never doubles as a source', () => {
  const rows = catalog.SHORTCUTS.filter((s) => s.also);
  assert.ok(rows.some((s) => s.name === 'Bitwarden' && s.also.includes('bitwarden/clients')));
  for (const s of rows) {
    assert.ok(Array.isArray(s.also) && s.also.length, s.name);
    for (const repo of s.also) assert.match(repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, `${s.name}: ${repo}`);
    const app = catalog.appById(s.name.toLowerCase().replace(/[^a-z0-9]+/g, ''));
    for (const plat of ['win32', 'darwin', 'linux']) {
      assert.ok(!catalog.sourcesFor(app, plat).some((src) => src.type === 'github' && s.also.includes(`${src.owner}/${src.repo}`)), `${s.name} on ${plat}`);
    }
  }
});
