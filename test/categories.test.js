'use strict';

// Categories: the user's own groups in the main list, each with its own folder (Settings →
// "Group apps into categories"). This file is the pure half, in src/core.js: where a
// categorised app lives, what a config may say, and which folders have to move when it
// changes. The moves themselves are in test/relocate.test.js, the IPC handlers in
// test/categories-main.test.js, and the window's grouping in test/ui-categories.test.js.
//
// Ported from PlayingKarrde/git-updater ee988da and 473bd94 and adapted: ours has several
// kinds of source (a non-GitHub app's folder is named after the app, not its key), and one
// Settings switch that hides the feature without ever changing where anything is.

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../src/core');
const sources = require('../src/sources');

const base = () => ({
  portableRoot: 'C:/Apps',
  categories: [{ name: 'Games', dir: 'C:/Games' }],
  repos: [],
});
const app = (extra) => ({ owner: 'TeeJS', repo: 'open-quake', type: 'portable', ...extra });
const KEY = 'TeeJS/open-quake#portable';

// --- where a categorised app lives ---------------------------------------------------

test('a portable app in a category installs under that category folder', () => {
  const cfg = { ...base(), repos: [app({ category: 'Games' }), { owner: 'ShareX', repo: 'ShareX', type: 'portable' }] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/Games/open-quake');
  assert.strictEqual(cfg.repos[1].install.dir, 'C:/Apps/ShareX');
});

test('category names match case-insensitively', () => {
  const cfg = { ...base(), repos: [app({ category: ' games ' })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/Games/open-quake');
  assert.strictEqual(core.findCategory(cfg, 'GAMES').dir, 'C:/Games');
  assert.strictEqual(core.findCategory(cfg, 'Tools'), null);
  assert.strictEqual(core.findCategory(cfg, undefined), null);
  assert.strictEqual(core.findCategory({}, 'Games'), null);
});

test('a category folder works without a portableRoot', () => {
  const cfg = { categories: [{ name: 'Games', dir: 'D:/Games/' }], repos: [app({ category: 'Games' })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'D:/Games/open-quake');
  // ...and an app with no category still needs one, with the message it always had.
  assert.throws(() => core.validateConfig({ categories: cfg.categories, repos: [app()] }), /portable requires install\.dir or a top-level portableRoot/);
});

test('explicit install.dir still wins over a category', () => {
  const cfg = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'E:/Quake');
  assert.strictEqual(core.portableDirOf(base(), app({ category: 'Games', install: { dir: 'E:/Quake' } })), 'E:/Quake');
});

test('one rule for every caller: own folder, then the category, then portableRoot', () => {
  const cfg = base();
  assert.strictEqual(core.portableRootFor(cfg, app({ category: 'Games' })), 'C:/Games');
  assert.strictEqual(core.portableRootFor(cfg, app()), 'C:/Apps');
  assert.strictEqual(core.defaultPortableDir(cfg, app({ category: 'Games' })), 'C:/Games/open-quake');
  assert.strictEqual(core.portableDirOf(cfg, app({ category: 'Games' })), 'C:/Games/open-quake');
  assert.strictEqual(core.portableDirOf(cfg, app()), 'C:/Apps/open-quake');
  assert.strictEqual(core.portableDirOf({ repos: [] }, app()), null, 'nowhere to put it');
  // What validateConfig fills in (the window, the scheduled install and the CLI all go
  // through it) is the same folder portableDirOf answers for the raw config.
  const raw = { ...base(), repos: [app({ category: 'Games' }), app({ repo: 'other' }), app({ repo: 'pinned', install: { dir: 'E:/P' } })] };
  const want = raw.repos.map((r) => core.portableDirOf(raw, r));
  assert.deepStrictEqual(core.validateConfig(JSON.parse(JSON.stringify(raw))).repos.map((r) => r.install.dir), want);
});

test('any kind of app can be in a category; only a portable one has a folder there', () => {
  const zoom = sources.normalizeEntry({ type: 'installer', name: 'Zoom', category: 'Games', source: { type: 'brew', token: 'zoom' } });
  const blender = sources.normalizeEntry({ type: 'portable', name: 'Blender: 5/3', category: 'Games', source: { type: 'folder', url: 'https://download.example.invalid/release/' } });
  const cfg = { ...base(), repos: [{ owner: 'o', repo: 'setup', type: 'installer', category: 'Games' }, zoom, blender] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install, undefined, 'an installer app is given no folder');
  assert.strictEqual(cfg.repos[1].install, undefined);
  // A non-GitHub app's folder is named after the app (made safe as a folder name), never
  // after its key, which is an encoded address.
  assert.strictEqual(cfg.repos[2].install.dir, 'C:/Games/Blender 5 3');
});

// --- the switch -----------------------------------------------------------------------

test('the Settings switch never decides where an app is: off, on and absent all resolve the same', () => {
  const make = (flag) => {
    const cfg = { ...base(), repos: [app({ category: 'Games' }), app({ repo: 'plain' }), app({ repo: 'own', category: 'Games', install: { dir: 'E:/Own' } })] };
    if (flag !== undefined) cfg.categoriesEnabled = flag;
    return cfg;
  };
  const dirs = (cfg) => core.validateConfig(cfg).repos.map((r) => r.install.dir);
  const expected = ['C:/Games/open-quake', 'C:/Apps/plain', 'E:/Own'];
  assert.deepStrictEqual(dirs(make(undefined)), expected);
  assert.deepStrictEqual(dirs(make(false)), expected);
  assert.deepStrictEqual(dirs(make(true)), expected);
  // Turning it off (or on) is not a change that moves anything.
  assert.deepStrictEqual(core.planRelocations(make(true), make(false), 'win32'), []);
  assert.deepStrictEqual(core.planRelocations(make(undefined), make(true), 'win32'), []);
});

test('a config that never used categories validates and resolves exactly as before', () => {
  const cfg = { portableRoot: 'C:/PortableApps', repos: [{ owner: 'ShareX', repo: 'ShareX', type: 'portable' }, { owner: 'o', repo: 'r', type: 'installer' }] };
  core.validateConfig(cfg);
  assert.strictEqual(cfg.repos[0].install.dir, 'C:/PortableApps/ShareX');
  assert.strictEqual('categories' in cfg, false, 'nothing is added to it');
  assert.strictEqual('category' in cfg.repos[0], false);
  assert.deepStrictEqual(core.planRelocations(cfg, { ...cfg, portableRoot: 'D:/Elsewhere' }, 'win32'), []);
});

// --- what a config may say -------------------------------------------------------------

test('an undefined category is rejected', () => {
  const cfg = { ...base(), repos: [app({ category: 'Tools' })] };
  assert.throws(() => core.validateConfig(cfg), /category "Tools" is not defined/);
  // ...for any kind of app, not only a portable one.
  assert.throws(() => core.validateConfig({ ...base(), repos: [{ owner: 'o', repo: 'r', type: 'installer', category: 'Tools' }] }), /repos\[0\]: category "Tools" is not defined/);
});

test('categories need a name, a folder, and unique names', () => {
  assert.throws(() => core.validateCategories({ categories: [{ name: 'Games' }], repos: [] }), /needs a folder/);
  assert.throws(() => core.validateCategories({ categories: [{ name: 'Games', dir: '   ' }], repos: [] }), /needs a folder/);
  assert.throws(() => core.validateCategories({ categories: [{ dir: 'C:/x' }], repos: [] }), /"name" is required/);
  assert.throws(() => core.validateCategories({ categories: [{ name: '  ', dir: 'C:/x' }], repos: [] }), /"name" is required/);
  assert.throws(() => core.validateCategories({ categories: [null], repos: [] }), /"name" is required/);
  assert.throws(() => core.validateCategories({ categories: { Games: 'C:/x' }, repos: [] }), /"categories" must be an array/);
  assert.throws(
    () => core.validateCategories({ categories: [{ name: 'Games', dir: 'C:/a' }, { name: 'GAMES', dir: 'C:/b' }], repos: [] }),
    /category "GAMES" is defined twice/
  );
  assert.throws(
    () => core.validateCategories({ categories: [{ name: 'Games', dir: 'C:/a' }, { name: ' games ', dir: 'C:/b' }], repos: [] }),
    /defined twice/
  );
});

test('a category folder must be a full path', () => {
  const ok = (dir) => core.validateCategories({ categories: [{ name: 'Games', dir }], repos: [] });
  for (const dir of ['C:/Games', 'C:\\Games', 'c:\\', '/home/me/Games', '/', '\\\\server\\share\\Games']) assert.doesNotThrow(() => ok(dir), dir);
  // A relative folder would be resolved against wherever git-updater was started from.
  for (const dir of ['Games', './Games', '../Games', '~/Games', 'C:Games', 'games\\sub']) {
    assert.throws(() => ok(dir), /its folder must be a full path/, dir);
  }
  assert.throws(() => ok('/home/me/Ga\u0000mes'), /full path/);
  assert.throws(() => ok(7), /needs a folder/);
});

// --- which folders have to move ---------------------------------------------------------

test('moving an app into a category plans a folder move', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), [
    { key: KEY, from: 'C:/Apps/open-quake', to: 'C:/Games/open-quake' },
  ]);
});

test('taking an app out of a category moves it back to portableRoot', () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), repos: [app()] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Apps/open-quake']);
});

test('moving an app from one category to another', () => {
  const two = () => ({ ...base(), categories: [{ name: 'Games', dir: 'C:/Games' }, { name: 'Tools', dir: 'D:\\Tools' }] });
  const before = { ...two(), repos: [app({ category: 'Games' })] };
  const after = { ...two(), repos: [app({ category: 'tools' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), [{ key: KEY, from: 'C:/Games/open-quake', to: 'D:\\Tools\\open-quake' }]);
});

test("changing a category's folder moves its apps, and only its apps", () => {
  const before = { ...base(), repos: [app({ category: 'Games' }), app({ repo: 'other' }), app({ repo: 'second', category: 'Games' })] };
  const after = { ...base(), categories: [{ name: 'Games', dir: 'D:/Games' }], repos: before.repos.map((r) => ({ ...r })) };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => [m.from, m.to]), [
    ['C:/Games/open-quake', 'D:/Games/open-quake'],
    ['C:/Games/second', 'D:/Games/second'],
  ]);
});

test('a plain portableRoot change moves nothing', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), portableRoot: 'D:/Apps', repos: [app()] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  // ...even with categories defined and other apps in them.
  const mixed = (root) => ({ ...base(), portableRoot: root, repos: [app(), app({ repo: 'g', category: 'Games' })] });
  assert.deepStrictEqual(core.planRelocations(mixed('C:/Apps'), mixed('D:/Apps'), 'win32'), []);
});

test('the same folder spelled differently on Windows is not a move', () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), categories: [{ name: 'Games', dir: 'c:\\games\\' }], repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  // Where letter case matters, a different case is a different folder.
  assert.strictEqual(core.planRelocations(before, { ...after, categories: [{ name: 'Games', dir: 'C:/games' }] }, 'linux').length, 1);
  assert.strictEqual(core.normDir('C:\\Games\\', 'win32'), 'c:/games');
  assert.strictEqual(core.normDir('/home/Me/Games/', 'linux'), '/home/Me/Games');
});

test('installer apps and new apps never move', () => {
  const inst = { owner: 'o', repo: 'r', type: 'installer' };
  const before = { ...base(), repos: [inst] };
  const after = { ...base(), repos: [{ ...inst, category: 'Games' }, app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
});

test('an app whose type changed is a different entry, and an app that is gone has nothing to plan', () => {
  const before = { ...base(), repos: [app({ category: 'Games' }), app({ repo: 'gone', category: 'Games' })] };
  const after = { ...base(), repos: [app({ type: 'installer', category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  assert.deepStrictEqual(core.planRelocations({}, after, 'win32'), []);
  assert.deepStrictEqual(core.planRelocations(before, {}, 'win32'), []);
});

test('a non-GitHub portable app moves by its folder name, not its key', () => {
  const blender = (extra) => sources.normalizeEntry({ type: 'portable', name: 'Blender', source: { type: 'folder', url: 'https://download.example.invalid/release/' }, ...extra });
  const before = { ...base(), repos: [blender()] };
  const after = { ...base(), repos: [blender({ category: 'Games' })] };
  const moves = core.planRelocations(before, after, 'win32');
  assert.deepStrictEqual(moves.map((m) => [m.from, m.to]), [['C:/Apps/Blender', 'C:/Games/Blender']]);
  assert.match(moves[0].key, /^source\.folder\/.+#portable$/);
});

test('a hand-set install.dir is left alone', () => {
  const before = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  assert.strictEqual(after.repos[0].install.dir, 'E:/Quake');
});

test('an install.dir that only repeats the old default is dropped and the app follows its category', () => {
  // An automatic type correction writes the default folder into install.dir. Nobody chose
  // it, so it must not hold the app back when it is put in a category.
  const before = { ...base(), repos: [app({ install: { dir: 'C:/Apps/open-quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games', install: { dir: 'C:/Apps/open-quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Games/open-quake']);
  assert.strictEqual(after.repos[0].install, undefined);
  // Other install settings beside it are kept.
  const kept = { ...base(), repos: [app({ category: 'Games', install: { dir: 'C:\\apps\\open-quake', strip: 1 } })] };
  core.planRelocations({ ...base(), repos: [app({ install: { dir: 'C:/Apps/open-quake', strip: 1 } })] }, kept, 'win32');
  assert.deepStrictEqual(kept.repos[0].install, { strip: 1 });
  // With no category involved it is left exactly as it is.
  const plain = { ...base(), repos: [app({ install: { dir: 'C:/Apps/open-quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, plain, 'win32'), []);
  assert.strictEqual(plain.repos[0].install.dir, 'C:/Apps/open-quake');
});

test('setting an app its own folder moves it there', () => {
  const before = { ...base(), repos: [app()] };
  const after = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), [
    { key: KEY, from: 'C:/Apps/open-quake', to: 'E:/Quake' },
  ]);
});

test("changing an app's own folder moves it from the old one", () => {
  const before = { ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ install: { dir: 'F:/Quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => [m.from, m.to]), [['E:/Quake', 'F:/Quake']]);
});

test("clearing an app's own folder moves it back to the default", () => {
  const before = { ...base(), repos: [app({ category: 'Games', install: { dir: 'E:/Quake' } })] };
  const after = { ...base(), repos: [app({ category: 'Games' })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32').map((m) => m.to), ['C:/Games/open-quake']);
  // With no category either, the default is portableRoot.
  assert.deepStrictEqual(
    core.planRelocations({ ...base(), repos: [app({ install: { dir: 'E:/Quake' } })] }, { ...base(), repos: [app()] }, 'win32').map((m) => m.to),
    ['C:/Apps/open-quake']
  );
});

test('a folder just set to the default location is kept, and nothing moves', () => {
  const before = { ...base(), repos: [app({ category: 'Games' })] };
  const after = { ...base(), repos: [app({ category: 'Games', install: { dir: 'C:/Games/open-quake' } })] };
  assert.deepStrictEqual(core.planRelocations(before, after, 'win32'), []);
  assert.strictEqual(after.repos[0].install.dir, 'C:/Games/open-quake');
});

test('a Windows folder gets a backslash before the app name; nothing else does', () => {
  assert.strictEqual(core.resolvePortableDir('E:\\Games\\Recomps\\', 'quiver-launcher'), 'E:\\Games\\Recomps\\quiver-launcher');
  assert.strictEqual(core.resolvePortableDir('\\\\nas\\apps', 'ShareX'), '\\\\nas\\apps\\ShareX');
  assert.strictEqual(core.resolvePortableDir('/home/me/Apps', 'ShareX'), '/home/me/Apps/ShareX');
  assert.strictEqual(core.resolvePortableDir('C:/Apps', 'ShareX'), 'C:/Apps/ShareX');
  // On macOS and Linux a backslash is part of a name. Joining with one would point at a
  // different folder than the one such a setup already uses.
  assert.strictEqual(core.resolvePortableDir('/home/me/My\\Apps', 'ShareX'), '/home/me/My\\Apps/ShareX');
});

// --- config:save never decides where an app is --------------------------------------------

test('holdFolders: a save from a window cannot change categories, an app\'s category, or its own folder', () => {
  const onDisk = { ...base(), repos: [app({ category: 'Games' }), app({ repo: 'own', install: { dir: 'E:/Own', strip: 1 } }), app({ repo: 'plain' })] };
  // The window's copy is out of date in every way that matters, and changes real settings too.
  const fromWindow = {
    portableRoot: 'C:/Apps',
    checkOnOpen: true,
    categories: [{ name: 'Games', dir: 'Z:/Elsewhere' }, { name: 'New', dir: 'Z:/New' }],
    repos: [
      app({ repo: 'plain', category: 'New', install: { dir: 'Z:/Plain' }, autoUpdate: true }),
      app({ repo: 'own', install: { strip: 2 } }),
      app(),
    ],
  };
  const out = core.holdFolders(onDisk, JSON.parse(JSON.stringify(fromWindow)));
  assert.deepStrictEqual(out.categories, onDisk.categories);
  assert.deepStrictEqual(out.repos, [
    app({ repo: 'plain', autoUpdate: true }),
    app({ repo: 'own', install: { strip: 2, dir: 'E:/Own' } }),
    app({ category: 'Games' }),
  ], 'the order and every other setting come from the window');
  assert.strictEqual(out.checkOnOpen, true);
  assert.deepStrictEqual(core.planRelocations(onDisk, out, 'win32'), [], 'so a save can never leave an app stranded');
});

test('holdFolders: an app that is new in the save keeps what it came with, and nothing is invented', () => {
  const onDisk = { portableRoot: 'C:/Apps', repos: [app()] };
  const next = { portableRoot: 'C:/Apps', categories: [{ name: 'Ghost', dir: 'Z:/G' }], repos: [app(), app({ repo: 'new', category: 'Ghost', install: { dir: 'D:/New' } })] };
  core.holdFolders(onDisk, next);
  assert.strictEqual('categories' in next, false, 'categories that are not on disk are not created by a save');
  assert.deepStrictEqual(next.repos[1], app({ repo: 'new', install: { dir: 'D:/New' } }), 'and the new app cannot name one');
  // A config with no categories at all is passed through untouched.
  const plain = { portableRoot: 'C:/Apps', sortColumn: 'app', repos: [app({ autoUpdate: true }), { owner: 'o', repo: 'r', type: 'installer', install: { kind: 'msi' } }] };
  assert.deepStrictEqual(core.holdFolders(JSON.parse(JSON.stringify(plain)), JSON.parse(JSON.stringify(plain))), plain);
  assert.strictEqual(core.holdFolders(onDisk, null), null);
});
