'use strict';

// Categories and app folders, main-process side: the IPC handlers run for real out of
// electron/main.js in a vm with fake Electron objects (the same technique as
// test/assetchoice.test.js), against a real config.json and real app folders in a temp
// directory. src/relocate.js does the moving for real; only "is it running" and, where a
// test says so, the rename are supplied.
//
//   grouping:change   the one call that can change where an app's files live
//   config:save       can never change it (and so can never strand an app)
//   the switch        categoriesEnabled hides the screens; it never changes a folder
//   pick-folder, app:edit, installed:get, folder:open, applyRetypes: all resolve a
//                     categorised app's folder the same way

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL, fileURLToPath } = require('url');

const core = require('../src/core');
const sources = require('../src/sources');
const relocate = require('../src/relocate');

const root = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
function slice(start, end) {
  const a = mainJs.indexOf(start);
  const b = mainJs.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} .. ${end}`);
  return mainJs.slice(a, b);
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-categories-')));
const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;
const says = (pattern) => (e) => { assert.match(e.message, pattern); return true; };

// A sandbox with a portable apps folder, two category folders, and three installed apps.
//   <dir>/apps/{quake,doom,tool}   <dir>/games   <dir>/tools
function mainHarness(make) {
  const dir = tmp();
  const P = (...a) => path.join(dir, ...a);
  const CONFIG_PATH = P('settings', 'config.json');
  const STATE_PATH = P('settings', 'state.json');
  const base = {
    portableRoot: P('apps'),
    categories: [{ name: 'Games', dir: P('games') }, { name: 'Tools', dir: P('tools') }],
    repos: [
      { owner: 'acme', repo: 'quake', type: 'portable', asset: 'quake-*-win64.zip', tagPrefix: 'v', autoUpdate: true },
      { owner: 'acme', repo: 'doom', type: 'portable' },
      { owner: 'acme', repo: 'tool', type: 'portable' },
      { owner: 'acme', repo: 'setup', type: 'installer', install: { kind: 'msi' } },
      { type: 'installer', name: 'Zoom', source: { type: 'brew', token: 'zoom' } },
      { type: 'portable', name: 'Blender', source: { type: 'folder', url: 'https://download.example.invalid/release/' } },
    ],
  };
  const config = make ? make(base, P) || base : base;
  config.repos.forEach((r) => sources.normalizeEntry(r));
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  const stateNow = {};
  for (const name of ['quake', 'doom', 'tool', 'Blender']) {
    const r = config.repos.find((x) => core.appName(x) === name && x.type === 'portable');
    if (!r) continue;
    const at = core.portableDirOf(config, r);
    fs.mkdirSync(path.join(at, 'data'), { recursive: true });
    fs.writeFileSync(path.join(at, `${name}.exe`), name);
    fs.writeFileSync(path.join(at, 'data', 'save.dat'), `${name} save`);
    stateNow[keyOf(r)] = { repo: core.displayId(r), type: 'portable', tag: 'v1.0.0', version: '1.0.0', installedAt: '2026-10-02T10:00:00.000Z', lastAction: 'installed', files: [`${name}.exe`] };
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(stateNow, null, 2));

  const mainPage = path.join(root, 'ui', 'index.html');
  const wc = (url) => ({ mainFrame: { url }, sent: [], send(channel) { this.sent.push(channel); } });
  const win = { isDestroyed: () => false, webContents: wc(pathToFileURL(mainPage).href) };
  const handlers = {};
  const hooks = { running: new Set(), moveOpts: undefined, locks: [], dialogs: [], pick: null, opened: [], logged: [] };
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    fs, path, core, sources, URL, fileURLToPath, console, process, Object, JSON, Set, Map, Error, Promise, String,
    CONFIG_PATH, mainPage, win,
    relocate: { ...relocate, run: (moves) => relocate.run(moves, hooks.moveOpts) },
    detect: { clearCache: () => {}, installedVersion: async () => null, installedDate: async () => null, isRunning: async (name) => hooks.running.has(name) },
    state: {
      load: () => JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')),
      acquireLock: () => { if (hooks.lockBusy) throw new Error('another update is already in progress'); hooks.locks.push('taken'); return 'lock'; },
      releaseLock: (l) => { if (l) hooks.locks.push('released'); },
    },
    dialog: { showOpenDialog: async (_w, o) => { hooks.dialogs.push(o); return hooks.pick ? { canceled: false, filePaths: [hooks.pick] } : { canceled: true, filePaths: [] }; } },
    shell: { openPath: async (p) => { hooks.opened.push(p); return ''; } },
    cron: { validate: () => ({ ok: true }) },
    background: { setStartAtLogin: () => {} },
    app: {}, bg: { syncTray: () => {} }, loginLauncher: () => null,
    log: (line) => hooks.logged.push(line),
  };
  const code = 'let updating = false; this.setUpdating = (v) => { updating = v; }; this.isUpdating = () => updating;\n'
    + slice('function dirHasFiles(dir)', '// Config lives with state')
    + slice('function readConfig()', '// GitHub access token')
    + slice('async function computeInstalled(cfg)', '// The renderer calls this only after')
    + slice("ipcMain.handle('folder:open'", "// Collect this dir's files")
    + slice("ipcMain.handle('config:save'", "ipcMain.handle('config:open'")
    + slice('function fromWindow', 'function requireMainWindow')
    + slice("// Change an existing app's type", '// --- Self-update (portable')
    + slice('const PICK_TITLES', '// A check can discover')
    + slice('function applyRetypes', "ipcMain.handle('check'")
    + '\nthis.applyRetypes = applyRetypes;';
  vm.runInNewContext(code, context);
  const fromMain = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  // Results come from another realm (the vm): copy them into this one before comparing.
  const here = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const call = async (name, ...args) => here(await handlers[name](fromMain, ...args));
  const change = (c, confirmed) => call('grouping:change', { change: c, confirmed });
  // Ask, and if folders would move, say yes to exactly that list.
  const changeYes = async (c) => { const first = await change(c); return first.needsConfirm ? change(c, first.token) : first; };
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const find = (name) => saved().repos.find((r) => core.appName(r) === name);
  const key = (name, type = 'portable') => keyOf(config.repos.find((r) => core.appName(r) === name && r.type === type));
  const ls = (...a) => (fs.existsSync(P(...a)) ? fs.readdirSync(P(...a)).sort() : null);
  const stateText = () => fs.readFileSync(STATE_PATH, 'utf8');
  const backups = () => fs.readdirSync(path.dirname(CONFIG_PATH)).filter((f) => /config\.json\..*\.bak$/.test(f)).length;
  return { dir, P, call, change, changeYes, saved, find, key, ls, stateText, backups, win, wc, handlers, hooks, context, fromMain, CONFIG_PATH };
}

// --- who may call it -------------------------------------------------------------------

test('grouping:change is accepted from the main window\'s own page only', async () => {
  const h = mainHarness();
  const before = fs.readFileSync(h.CONFIG_PATH, 'utf8');
  const other = h.wc(h.win.webContents.mainFrame.url); // another window showing the same file
  const strangers = [
    { sender: other, senderFrame: other.mainFrame },
    { sender: h.win.webContents, senderFrame: { url: h.win.webContents.mainFrame.url } }, // a subframe
  ];
  const req = { change: { op: 'move-app', key: h.key('quake'), category: 'Games' } };
  for (const e of strangers) {
    await assert.rejects(async () => h.handlers['grouping:change'](e, req), /Only the main window can change categories and app folders/);
  }
  h.win.webContents.mainFrame.url = 'https://evil.invalid/'; // the main window after navigating away
  await assert.rejects(async () => h.handlers['grouping:change'](h.fromMain, req), /Only the main window/);
  assert.strictEqual(fs.readFileSync(h.CONFIG_PATH, 'utf8'), before);
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
});

test('grouping:change refuses a request it does not understand, and changes nothing', async () => {
  const h = mainHarness();
  const before = fs.readFileSync(h.CONFIG_PATH, 'utf8');
  for (const req of [undefined, null, 'x', {}, { change: null }, { change: { op: 'delete-everything' } }, { change: { op: 'constructor' } }]) {
    await assert.rejects(async () => h.call('grouping:change', req), /That change is not one git-updater knows/);
  }
  for (const k of [undefined, 7, {}, 'nobody/home#portable', 'acme/quake#installer']) {
    await assert.rejects(async () => h.change({ op: 'move-app', key: k, category: 'Games' }), /That app is not in your list any more/);
  }
  await assert.rejects(async () => h.change({ op: 'move-app', key: h.key('quake'), category: 'Nowhere' }), /That category is not in your list any more/);
  await assert.rejects(async () => h.change({ op: 'move-app', key: h.key('quake'), category: { name: 'Games' } }), /That category is not in your list any more/);
  assert.strictEqual(fs.readFileSync(h.CONFIG_PATH, 'utf8'), before);
  assert.strictEqual(h.backups(), 0);
});

// --- categories themselves --------------------------------------------------------------

test('add-category: a name and a full folder path, checked here whatever the window sent', async () => {
  const h = mainHarness((c) => { delete c.categories; });
  const add = (name, dir) => h.change({ op: 'add-category', name, dir });
  await assert.rejects(async () => add('', h.P('x')), /Give the category a name/);
  await assert.rejects(async () => add('   ', h.P('x')), /Give the category a name/);
  await assert.rejects(async () => add(7, h.P('x')), /Give the category a name/);
  await assert.rejects(async () => add('x'.repeat(41), h.P('x')), /up to 40 characters/);
  await assert.rejects(async () => add('Games', ''), /Choose a folder for Games/);
  await assert.rejects(async () => add('Games', undefined), /Choose a folder for Games/);
  await assert.rejects(async () => add('Games', ['/x']), /Choose a folder for Games/);
  // A folder that is not a full path would be resolved against wherever the app was started.
  for (const dir of ['games', './games', '../games', '~/games']) await assert.rejects(async () => add('Games', dir), /The folder for Games must be a full path/, dir);
  await assert.rejects(async () => add('Games', h.P('ga\u0000mes')), /That folder cannot be used for Games/);
  await assert.rejects(async () => add('Games', path.sep + 'x'.repeat(1100)), /That folder cannot be used for Games/);
  assert.strictEqual('categories' in h.saved(), false, 'nothing was saved by any refusal');

  assert.deepStrictEqual(await add('  Games  ', ` ${h.P('games')} `), { ok: true, text: 'Added Games.', moved: [], notes: [] });
  assert.deepStrictEqual(h.saved().categories, [{ name: 'Games', dir: h.P('games') }]);
  assert.strictEqual(h.backups(), 1, 'saved the way every config change is, with a backup');
  // Names that differ only by letter case are the same category.
  await assert.rejects(async () => add('GAMES', h.P('other')), /There is already a category called Games/);
  await assert.rejects(async () => add(' games ', h.P('other')), /There is already a category called Games/);
  await add('Tools', h.P('tools'));
  assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Games', 'Tools']);
  assert.strictEqual(fs.existsSync(h.P('games')), false, 'adding a category creates no folder until an app goes in it');
});

test('remove-category only when it is empty; order-categories reorders and loses none', async () => {
  const h = mainHarness((c) => { c.repos[0].category = 'Games'; c.repos[1].category = 'games'; c.categories.push({ name: 'Music', dir: path.join(os.tmpdir(), 'music') }); });
  await assert.rejects(async () => h.change({ op: 'remove-category', name: 'Games' }), /Games still has 2 apps in it\. Move them to another category first\./);
  await assert.rejects(async () => h.change({ op: 'remove-category', name: 'Nope' }), /not in your list any more/);
  assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Games', 'Tools', 'Music']);

  assert.strictEqual((await h.change({ op: 'order-categories', names: ['music', 'Games'] })).ok, true);
  assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Music', 'Games', 'Tools'], 'one the window did not name keeps its place at the end');
  await h.change({ op: 'order-categories', names: ['Tools', 'Tools', 'Ghost', 7, 'Music'] });
  assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Tools', 'Music', 'Games'], 'no duplicate, nothing invented');
  await assert.rejects(async () => h.change({ op: 'order-categories', names: 'Games' }), /That order cannot be saved/);
  assert.deepStrictEqual(h.saved().categories.find((c) => c.name === 'Games').dir, h.P('games'), 'folders are untouched by a reorder');

  assert.strictEqual((await h.change({ op: 'remove-category', name: 'tools' })).text, 'Removed Tools.');
  assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Music', 'Games']);
  assert.deepStrictEqual(h.saved().repos.map((r) => r.category).filter(Boolean), ['Games', 'games'], 'no app was touched');
});

// --- moving an app -----------------------------------------------------------------------

test('move-app: asks first with the exact folders, moves nothing until the same list is confirmed', async () => {
  const h = mainHarness();
  const state = h.stateText();
  const c = { op: 'move-app', key: h.key('quake'), category: 'games' };
  const asked = await h.change(c);
  assert.deepStrictEqual(asked.moves, [{ name: 'quake', from: h.P('apps', 'quake'), to: h.P('games', 'quake') }]);
  assert.strictEqual(asked.needsConfirm, true);
  assert.strictEqual(h.find('quake').category, undefined, 'nothing saved yet');
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
  assert.strictEqual(h.ls('games'), null);
  // A yes to some other list (or a made-up one) is not a yes to this one.
  for (const confirmed of ['yes', true, JSON.stringify([[h.P('apps', 'quake'), h.P('elsewhere')]]), '']) {
    assert.strictEqual((await h.change(c, confirmed)).needsConfirm, true);
    assert.strictEqual(h.ls('games'), null);
  }
  const done = await h.change(c, asked.token);
  assert.deepStrictEqual(done, { ok: true, text: 'quake is now in Games.', moved: [{ name: 'quake', from: h.P('apps', 'quake'), to: h.P('games', 'quake') }], notes: [] });
  assert.deepStrictEqual(h.ls('games', 'quake'), ['data', 'quake.exe']);
  assert.strictEqual(fs.readFileSync(h.P('games', 'quake', 'data', 'save.dat'), 'utf8'), 'quake save');
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'tool']);
  // In place: same position, the category's own spelling, every hand-set override kept.
  assert.deepStrictEqual(h.saved().repos[0], { owner: 'acme', repo: 'quake', type: 'portable', asset: 'quake-*-win64.zip', tagPrefix: 'v', autoUpdate: true, category: 'Games' });
  assert.strictEqual(h.backups(), 1);
  assert.deepStrictEqual(h.hooks.locks, ['taken', 'released'], 'held the update lock for the move, and let it go');
  assert.strictEqual(h.context.isUpdating(), false);
  assert.strictEqual(h.stateText(), state, 'state.json holds no folder, so a move changes nothing in it');
  // What the engine resolves next (window, scheduled install and CLI alike) is the new place.
  const resolved = core.validateConfig(h.saved()).repos[0].install.dir;
  assert.strictEqual(resolved, h.P('games', 'quake'));
  assert.strictEqual((await h.call('installed:get'))[h.key('quake')].present, true, 'and the window sees it installed there');
});

test('move-app out of a category, and between categories', async () => {
  const h = mainHarness((c) => { c.repos[0].category = 'Games'; });
  assert.deepStrictEqual(h.ls('games'), ['quake']);
  const toTools = await h.changeYes({ op: 'move-app', key: h.key('quake'), category: 'Tools' });
  assert.deepStrictEqual(toTools.moved, [{ name: 'quake', from: h.P('games', 'quake'), to: h.P('tools', 'quake') }]);
  assert.strictEqual(h.find('quake').category, 'Tools');
  const out = await h.changeYes({ op: 'move-app', key: h.key('quake'), category: null });
  assert.strictEqual(out.text, 'quake is no longer in a category.');
  assert.deepStrictEqual(out.moved, [{ name: 'quake', from: h.P('tools', 'quake'), to: h.P('apps', 'quake') }]);
  assert.strictEqual('category' in h.find('quake'), false);
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
});

test('apps with no folder of their own go in a category without anything moving', async () => {
  const h = mainHarness();
  fs.rmSync(h.P('apps', 'doom'), { recursive: true }); // tracked but not installed yet
  for (const [name, type] of [['setup', 'installer'], ['Zoom', 'installer'], ['doom', 'portable']]) {
    const r = await h.change({ op: 'move-app', key: h.key(name, type), category: 'Games' });
    assert.deepStrictEqual(r, { ok: true, text: `${name} is now in Games.`, moved: [], notes: [] }, name);
    assert.strictEqual(h.find(name).category, 'Games');
  }
  assert.strictEqual(h.ls('games'), null, 'no folder was created for any of them');
  assert.deepStrictEqual(h.find('setup').install, { kind: 'msi' }, 'an installer app\'s settings are untouched');
  assert.deepStrictEqual(h.find('Zoom').source, { type: 'brew', token: 'zoom' });
  assert.deepStrictEqual(h.hooks.locks, [], 'and nothing was locked');
  // The one not installed yet will install into the category's folder.
  assert.strictEqual(core.validateConfig(h.saved()).repos[1].install.dir, h.P('games', 'doom'));
});

test('a non-GitHub portable app moves too, by its folder name', async () => {
  const h = mainHarness();
  const done = await h.changeYes({ op: 'move-app', key: h.key('Blender'), category: 'Tools' });
  assert.deepStrictEqual(done.moved, [{ name: 'Blender', from: h.P('apps', 'Blender'), to: h.P('tools', 'Blender') }]);
  assert.deepStrictEqual(h.ls('tools', 'Blender'), ['Blender.exe', 'data']);
  const entry = h.find('Blender');
  assert.strictEqual(entry.category, 'Tools');
  assert.deepStrictEqual(entry.source, { type: 'folder', url: 'https://download.example.invalid/release/' });
  assert.match(entry.owner, /^source\.folder$/);
});

test('an app with a folder of its own keeps it when it is put in a category', async () => {
  const h = mainHarness((c, P) => { c.repos[0].install = { dir: P('mine', 'quake') }; });
  assert.deepStrictEqual(h.ls('mine'), ['quake']);
  const r = await h.change({ op: 'move-app', key: h.key('quake'), category: 'Games' });
  assert.deepStrictEqual(r.moved, []);
  assert.strictEqual(h.find('quake').category, 'Games');
  assert.strictEqual(h.find('quake').install.dir, h.P('mine', 'quake'));
  assert.strictEqual(h.ls('games'), null);
});

// --- refusals: nothing is changed, and the message says which app and why -------------------

test('refused while the app is running', async () => {
  const h = mainHarness();
  const before = fs.readFileSync(h.CONFIG_PATH, 'utf8');
  h.hooks.running.add('quake');
  const c = { op: 'move-app', key: h.key('quake'), category: 'Games' };
  const asked = await h.change(c);
  await assert.rejects(async () => h.change(c, asked.token), says(/^quake is running\. Close it, then try again\. Nothing was changed\.$/));
  assert.strictEqual(fs.readFileSync(h.CONFIG_PATH, 'utf8'), before);
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
  assert.strictEqual(h.ls('games'), null);
  assert.deepStrictEqual(h.hooks.locks, ['taken', 'released'], 'the lock is let go after a refusal too');
  assert.strictEqual(h.context.isUpdating(), false);
  // The entry's `process` override is what is looked for, as it is before an update.
  const g = mainHarness((cfg) => { cfg.repos[0].process = 'glquake'; });
  g.hooks.running.add('glquake');
  const again = await g.change({ op: 'move-app', key: g.key('quake'), category: 'Games' });
  await assert.rejects(async () => g.change({ op: 'move-app', key: g.key('quake'), category: 'Games' }, again.token), /quake is running/);
});

test('refused while an update is running, here or from the command line', async () => {
  const h = mainHarness();
  const c = { op: 'move-app', key: h.key('quake'), category: 'Games' };
  const asked = await h.change(c);
  h.context.setUpdating(true);
  await assert.rejects(async () => h.change(c, asked.token), says(/^An update is running\. Wait for it to finish, then try again\. Nothing was changed\.$/));
  assert.strictEqual(h.context.isUpdating(), true, 'the running update\'s own flag is left alone');
  h.context.setUpdating(false);
  h.hooks.lockBusy = true;
  await assert.rejects(async () => h.change(c, asked.token), /another update is already in progress/);
  assert.strictEqual(h.context.isUpdating(), false);
  assert.strictEqual(h.find('quake').category, undefined);
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
});

test('refused when the new place already has files, before the user is asked anything', async () => {
  const h = mainHarness();
  fs.mkdirSync(h.P('games', 'quake'), { recursive: true });
  fs.writeFileSync(h.P('games', 'quake', 'theirs.txt'), 'not ours');
  await assert.rejects(async () => h.change({ op: 'move-app', key: h.key('quake'), category: 'Games' }), says(/^quake was not moved: .*games.quake already exists and is not empty\. Nothing was changed\.$/));
  assert.strictEqual(h.find('quake').category, undefined);
  assert.strictEqual(fs.readFileSync(h.P('games', 'quake', 'theirs.txt'), 'utf8'), 'not ours');
  assert.deepStrictEqual(h.ls('apps', 'quake'), ['data', 'quake.exe']);
});

test('a category\'s folder changed: all of its apps move, or none', async () => {
  const h = mainHarness((c) => { c.repos[0].category = 'Games'; c.repos[1].category = 'Games'; c.repos[3].category = 'Games'; });
  assert.deepStrictEqual(h.ls('games'), ['doom', 'quake']);
  const before = fs.readFileSync(h.CONFIG_PATH, 'utf8');
  const c = { op: 'set-category-folder', name: 'games', dir: h.P('big-disk') };
  const asked = await h.change(c);
  assert.deepStrictEqual(asked.moves.map((m) => [m.name, m.to]), [['quake', h.P('big-disk', 'quake')], ['doom', h.P('big-disk', 'doom')]], 'only the portable apps in it');

  // The second folder cannot be renamed (a file in it is open). The first is put back.
  h.hooks.moveOpts = { rename: (from, to) => { if (path.basename(from) === 'doom' && to.includes('big-disk')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); fs.renameSync(from, to); } };
  await assert.rejects(async () => h.change(c, asked.token), says(/^doom was not moved: its files are in use or cannot be moved\. If it is running, close it, then try again\. Nothing was changed\.$/));
  assert.strictEqual(fs.readFileSync(h.CONFIG_PATH, 'utf8'), before, 'config.json was not saved');
  assert.deepStrictEqual(h.ls('games'), ['doom', 'quake']);
  assert.strictEqual(h.ls('big-disk'), null);
  assert.strictEqual(h.backups(), 0);

  h.hooks.moveOpts = undefined;
  const done = await h.change(c, asked.token);
  assert.strictEqual(done.text, `Games now uses ${h.P('big-disk')}.`);
  assert.deepStrictEqual(done.moved.map((m) => m.name), ['quake', 'doom']);
  assert.deepStrictEqual(h.ls('big-disk'), ['doom', 'quake']);
  assert.deepStrictEqual(h.ls('games'), []);
  assert.deepStrictEqual(h.saved().categories[0], { name: 'Games', dir: h.P('big-disk') });
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'tool'], 'apps in no category stay where they are');
});

test('if config.json cannot be saved after the folders moved, every folder is put back', async () => {
  const h = mainHarness();
  const c = { op: 'move-app', key: h.key('quake'), category: 'Games' };
  const asked = await h.change(c);
  const realSave = h.context.saveConfigFile;
  h.context.saveConfigFile = () => { throw new Error('ENOSPC: no space left on device'); };
  await assert.rejects(async () => h.change(c, asked.token), says(/^Your settings could not be saved \(ENOSPC: no space left on device\), so every folder was put back\. Nothing was changed\.$/));
  h.context.saveConfigFile = realSave;
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
  assert.strictEqual(h.ls('games'), null);
  assert.strictEqual(h.find('quake').category, undefined);
});

test('across drives through the handler: copied, config saved, then the original removed', async () => {
  const h = mainHarness();
  h.hooks.moveOpts = { rename: () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); } };
  const done = await h.changeYes({ op: 'move-app', key: h.key('quake'), category: 'Games' });
  assert.deepStrictEqual(done.notes, []);
  assert.deepStrictEqual(h.ls('games', 'quake'), ['data', 'quake.exe']);
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'tool']);
  assert.strictEqual(h.find('quake').category, 'Games');
  // And when the copy fails, nothing is saved and the original is whole.
  h.hooks.moveOpts.copyTree = async () => { throw new Error('the disk went away'); };
  const c = { op: 'move-app', key: h.key('doom'), category: 'Games' };
  const asked = await h.change(c);
  await assert.rejects(async () => h.change(c, asked.token), /doom was not moved: copying it to .* did not work \(the disk went away\)\. Nothing was changed\./);
  assert.strictEqual(h.find('doom').category, undefined);
  assert.deepStrictEqual(h.ls('apps', 'doom'), ['data', 'doom.exe']);
  assert.deepStrictEqual(h.ls('games'), ['quake']);
});

// --- the Edit form ------------------------------------------------------------------------

test('edit-app: category and folder in one save, in place, with every override kept', async () => {
  const h = mainHarness();
  const k = h.key('quake');
  const edit = (extra) => ({ op: 'edit-app', key: k, type: 'portable', prerelease: false, category: null, ...extra });
  // A folder of its own.
  const own = await h.changeYes(edit({ folder: h.P('elsewhere', 'quake') }));
  assert.deepStrictEqual(own, { ok: true, text: 'Saved.', key: k, moved: [{ name: 'quake', from: h.P('apps', 'quake'), to: h.P('elsewhere', 'quake') }], notes: [] });
  assert.deepStrictEqual(h.saved().repos[0], { owner: 'acme', repo: 'quake', type: 'portable', asset: 'quake-*-win64.zip', tagPrefix: 'v', autoUpdate: true, install: { dir: h.P('elsewhere', 'quake') } });
  // Category and beta changed, folder left out: the files stay, since its own folder wins.
  const cat = await h.change(edit({ category: 'Games', prerelease: true }));
  assert.deepStrictEqual(cat.moved, []);
  assert.strictEqual(h.find('quake').category, 'Games');
  assert.strictEqual(h.find('quake').prerelease, true);
  assert.deepStrictEqual(h.ls('elsewhere'), ['quake']);
  // The folder cleared: back to the default, which is now the category's.
  const cleared = await h.changeYes(edit({ category: 'Games', folder: '' }));
  assert.deepStrictEqual(cleared.moved, [{ name: 'quake', from: h.P('elsewhere', 'quake'), to: h.P('games', 'quake') }]);
  assert.strictEqual('install' in h.find('quake'), false);
  assert.strictEqual('prerelease' in h.find('quake'), false);
  assert.strictEqual(h.saved().repos[0].asset, 'quake-*-win64.zip');
  assert.strictEqual(h.saved().repos.length, 6);
  // A folder picked that IS the default is kept as the user's choice, and nothing moves.
  const same = await h.change(edit({ category: 'Games', folder: h.P('games', 'quake') }));
  assert.deepStrictEqual(same.moved, []);
  assert.strictEqual(h.find('quake').install.dir, h.P('games', 'quake'));
});

test('edit-app: the folder is validated here, and two apps never end up sharing or nesting', async () => {
  const h = mainHarness();
  const edit = (name, extra) => ({ op: 'edit-app', key: h.key(name), type: 'portable', prerelease: false, category: null, ...extra });
  await assert.rejects(async () => h.change(edit('quake', { folder: 'relative/quake' })), /The folder for quake must be a full path/);
  await assert.rejects(async () => h.change(edit('quake', { folder: 7 })), /Choose a folder for quake/);
  await assert.rejects(async () => h.change(edit('quake', { folder: h.P('apps', 'doom') })), says(/^quake and doom would share the folder .*apps.doom\. Give each its own folder\.$/));
  // Straight into the portable apps folder, which holds the other apps' folders.
  await assert.rejects(async () => h.change(edit('quake', { folder: h.P('apps') })), /is inside .*apps, so quake cannot use that folder itself\. Put quake in a subfolder, or pick another folder\./);
  await assert.rejects(async () => h.change(edit('quake', { folder: h.P('apps', 'doom', 'inner') })), /is inside doom's folder/);
  await assert.rejects(async () => h.change(edit('quake', { category: 'Nope' })), /That category is not in your list any more/);
  await assert.rejects(async () => h.change({ ...edit('quake'), type: 'both' }), /The type must be Portable or Installer/);
  assert.deepStrictEqual(h.saved().repos[0], { owner: 'acme', repo: 'quake', type: 'portable', asset: 'quake-*-win64.zip', tagPrefix: 'v', autoUpdate: true });
  assert.deepStrictEqual(h.ls('apps'), ['Blender', 'doom', 'quake', 'tool']);
  assert.strictEqual(h.backups(), 0);
});

test('edit-app: changing the type changes the entry in place and moves nothing', async () => {
  const h = mainHarness((c) => { c.repos[0].category = 'Games'; });
  const r = await h.change({ op: 'edit-app', key: h.key('quake'), type: 'installer', prerelease: false, category: 'Games' });
  assert.deepStrictEqual(r, { ok: true, text: 'Saved.', key: 'acme/quake#installer', moved: [], notes: [] });
  assert.deepStrictEqual(h.saved().repos[0], { owner: 'acme', repo: 'quake', type: 'installer', asset: 'quake-*-win64.zip', tagPrefix: 'v', autoUpdate: true, category: 'Games' });
  assert.deepStrictEqual(h.ls('games'), ['quake'], 'the portable copy is left where it was, as before');
  // Already tracked as the other type: refused.
  const g = mainHarness((c) => { c.repos.push({ owner: 'acme', repo: 'quake', type: 'installer' }); });
  await assert.rejects(async () => g.change({ op: 'edit-app', key: g.key('quake'), type: 'installer', prerelease: false, category: null }), /acme\/quake is already in your list as Installer/);
  // Portable needs somewhere to go: its own folder, a category, or the portable apps folder.
  const n = mainHarness((c) => { delete c.portableRoot; c.repos = [{ owner: 'acme', repo: 'setup', type: 'installer' }]; });
  const k = 'acme/setup#installer';
  await assert.rejects(async () => n.change({ op: 'edit-app', key: k, type: 'portable', prerelease: false, category: null }), /Set the portable apps folder first/);
  assert.strictEqual((await n.change({ op: 'edit-app', key: k, type: 'portable', prerelease: false, category: 'Tools' })).key, 'acme/setup#portable');
});

test('edit-app: pointing a GitHub app at another repository keeps its place, category and Auto-update tick', async () => {
  const h = mainHarness((c) => { c.repos[1].category = 'Games'; c.repos[1].autoUpdate = true; c.repos[1].asset = 'doom-*.zip'; });
  const before = h.ls('games');
  const edit = (retarget, extra) => ({ op: 'edit-app', key: h.key('doom'), type: 'portable', prerelease: false, category: 'Games', retarget, ...extra });
  for (const bad of [{ owner: 'a/b', repo: 'x' }, { owner: 'source.brew', repo: 'x' }, { owner: 'ok', repo: 'x#portable' }, { owner: 'ok', repo: '' }, { owner: 7, repo: 'x' }, {}]) {
    await assert.rejects(async () => h.change(edit(bad)), /That is not a GitHub owner\/repo/, JSON.stringify(bad));
  }
  await assert.rejects(async () => h.change(edit({ owner: 'acme', repo: 'quake' })), /acme\/quake is already in your list as Portable/);
  const r = await h.change(edit({ owner: 'idsoft', repo: 'doom3' }));
  assert.deepStrictEqual(r, { ok: true, text: 'Saved.', key: 'idsoft/doom3#portable', moved: [], notes: [] });
  // Another repository is another app: its download choice is not carried over, nothing moves.
  assert.deepStrictEqual(h.saved().repos[1], { owner: 'idsoft', repo: 'doom3', type: 'portable', autoUpdate: true, category: 'Games' });
  assert.deepStrictEqual(h.saved().repos.map((x) => core.appName(x)), ['quake', 'doom3', 'tool', 'setup', 'Zoom', 'Blender']);
  assert.deepStrictEqual(h.ls('games'), before);
  // An app from any other source has no address to retype.
  await assert.rejects(async () => h.change({ op: 'edit-app', key: h.key('Blender'), type: 'portable', prerelease: false, category: null, retarget: { owner: 'a', repo: 'b' } }), /Only an app from GitHub can be pointed at another address/);
});

// --- config:save, and the switch ------------------------------------------------------------

test('config:save can never change where an app lives, whatever the window sends', async () => {
  const h = mainHarness((c) => { c.repos[0].category = 'Games'; c.repos[2].install = { dir: path.join(os.tmpdir(), 'own-tool') }; });
  const cfg = h.saved();
  cfg.categories = [{ name: 'Games', dir: h.P('hijacked') }];
  delete cfg.repos[0].category;
  cfg.repos[1].category = 'Games';
  cfg.repos[1].install = { dir: h.P('hijacked', 'doom') };
  delete cfg.repos[2].install;
  cfg.checkOnOpen = true; // an ordinary setting, saved in the same call
  cfg.repos.reverse(); // and a new order
  assert.strictEqual((await h.call('config:save', cfg)).ok, true);
  const after = h.saved();
  assert.strictEqual(after.checkOnOpen, true);
  assert.deepStrictEqual(after.repos.map((r) => core.appName(r)), ['Blender', 'Zoom', 'setup', 'tool', 'doom', 'quake'], 'the order is the window\'s to save');
  assert.deepStrictEqual(after.categories, [{ name: 'Games', dir: h.P('games') }, { name: 'Tools', dir: h.P('tools') }]);
  assert.strictEqual(h.find('quake').category, 'Games');
  assert.strictEqual('category' in h.find('doom'), false);
  assert.strictEqual('install' in h.find('doom'), false);
  assert.strictEqual(h.find('tool').install.dir, path.join(os.tmpdir(), 'own-tool'));
  assert.deepStrictEqual(h.ls('games'), ['quake'], 'and no folder moved');
  assert.strictEqual(h.ls('hijacked'), null);
});

test('the switch is an ordinary setting: saving it moves nothing and keeps every category', async () => {
  const h = mainHarness((c) => { c.categoriesEnabled = true; c.repos[0].category = 'Games'; });
  const tree = () => JSON.stringify([h.ls('apps'), h.ls('games'), h.ls('tools')]);
  const before = tree();
  for (const value of [false, true, 'yes', 0]) {
    const cfg = h.saved();
    cfg.categoriesEnabled = value;
    await h.call('config:save', cfg);
    assert.strictEqual(h.saved().categoriesEnabled, !!value, 'kept as a plain true or false');
    assert.strictEqual(tree(), before);
    assert.deepStrictEqual(h.saved().categories.map((c) => c.name), ['Games', 'Tools']);
    assert.strictEqual(h.find('quake').category, 'Games');
  }
  // A config that never had the switch does not get one from a save.
  const plain = mainHarness((c) => { delete c.categories; });
  const cfg = plain.saved();
  cfg.checkOnOpen = true;
  await plain.call('config:save', cfg);
  assert.strictEqual('categoriesEnabled' in plain.saved(), false);
  assert.strictEqual('categories' in plain.saved(), false);
});

test('with the switch off, folders resolve exactly as with it on', async () => {
  for (const flag of [undefined, false, true]) {
    const h = mainHarness((c) => { if (flag !== undefined) c.categoriesEnabled = flag; c.repos[0].category = 'Games'; });
    const installed = await h.call('installed:get');
    assert.strictEqual(installed[h.key('quake')].present, true, `found in its category's folder (switch ${flag})`);
    assert.strictEqual(installed[h.key('quake')].current, '1.0.0');
    await h.call('folder:open', h.key('quake'));
    await h.call('folder:open', h.key('doom'));
    assert.deepStrictEqual(h.hooks.opened, [h.P('games', 'quake'), h.P('apps', 'doom')]);
    assert.strictEqual(core.validateConfig(h.saved()).repos[0].install.dir, h.P('games', 'quake'), 'what an update, the scheduled install and the CLI resolve');
    // The main-process call works the same either way: the switch is only what the window shows.
    const done = await h.changeYes({ op: 'move-app', key: h.key('quake'), category: null });
    assert.deepStrictEqual(done.moved.map((m) => m.to), [h.P('apps', 'quake')]);
  }
});

// --- everything else that resolves a folder ---------------------------------------------------

test('app:edit: Portable is allowed when the app\'s category gives it a folder', async () => {
  const h = mainHarness((c) => { delete c.portableRoot; c.repos = [{ owner: 'acme', repo: 'setup', type: 'installer', category: 'Tools' }, { owner: 'acme', repo: 'loose', type: 'installer' }]; });
  assert.deepStrictEqual(await h.call('app:edit', { appKey: 'acme/setup#installer', type: 'portable', prerelease: false }), { key: 'acme/setup#portable' });
  await assert.rejects(async () => h.call('app:edit', { appKey: 'acme/loose#installer', type: 'portable', prerelease: false }), /set the portable apps folder first/);
});

test('an automatic type correction does not give a categorised app a folder of its own', () => {
  const h = mainHarness((c) => {
    c.repos = [
      { owner: 'acme', repo: 'grouped', type: 'installer', category: 'Games' },
      { owner: 'acme', repo: 'loose', type: 'installer' },
      { owner: 'acme', repo: 'moved', type: 'installer', category: 'Games' },
    ];
  });
  h.context.applyRetypes([
    { id: 'acme/grouped#installer', retyped: { to: 'portable', dir: core.resolvePortableDir(h.P('games'), 'grouped') } },
    { id: 'acme/loose#installer', retyped: { to: 'portable', dir: core.resolvePortableDir(h.P('apps'), 'loose') } },
    { id: 'acme/moved#installer', retyped: { to: 'portable', dir: h.P('somewhere', 'else') } },
  ]);
  const [grouped, loose, moved] = h.saved().repos;
  assert.deepStrictEqual(grouped, { owner: 'acme', repo: 'grouped', type: 'portable', category: 'Games' }, 'it keeps following its category');
  assert.deepStrictEqual(loose.install, { dir: core.resolvePortableDir(h.P('apps'), 'loose') }, 'an app in no category is written as it always was');
  assert.deepStrictEqual(moved.install, { dir: h.P('somewhere', 'else') }, 'a folder that is not the default is kept');
  assert.deepStrictEqual(h.win.webContents.sent, ['config-changed']);
});

test('pick-folder: the title is chosen here, and the dialog opens at the nearest folder that exists', async () => {
  const h = mainHarness();
  const lastAsked = () => JSON.parse(JSON.stringify(h.hooks.dialogs.pop())); // made in the vm's realm
  h.hooks.pick = h.P('picked');
  assert.deepStrictEqual(await h.call('pick-folder'), { path: h.P('picked') });
  assert.deepStrictEqual(lastAsked(), { title: 'Select the portable apps folder', properties: ['openDirectory', 'createDirectory'] }, 'called the old way it asks exactly what it always asked');
  await h.call('pick-folder', 'category', h.P('apps', 'quake'));
  assert.deepStrictEqual(lastAsked(), { title: 'Select the folder for this category', defaultPath: h.P('apps', 'quake'), properties: ['openDirectory', 'createDirectory'] });
  await h.call('pick-folder', 'app', h.P('apps', 'not', 'there', 'yet'));
  assert.deepStrictEqual(lastAsked(), { title: 'Select the folder for this app', defaultPath: h.P('apps'), properties: ['openDirectory', 'createDirectory'] });
  // Nothing the window sends becomes the title, and a start folder that is not a full path is ignored.
  for (const [kind, start] of [['<b>Format C:</b>', 'relative/dir'], ['constructor', 7], ['__proto__', ''], [{ title: 'x' }, ['/']], ['app', 'x'.repeat(2000)]]) {
    await h.call('pick-folder', kind, start);
    const asked = lastAsked();
    assert.ok(['Select the portable apps folder', 'Select the folder for this app'].includes(asked.title), String(kind));
    assert.strictEqual('defaultPath' in asked, false);
  }
  h.hooks.pick = null;
  assert.deepStrictEqual(await h.call('pick-folder', 'app'), { path: '' });
});
