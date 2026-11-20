'use strict';

// The "Add an app" window: the results:* handlers in electron/main.js (run for real in a vm
// with fake Electron objects) and the window's own script, ui/add.js (run against a
// minimal DOM). Both sides are exercised as shipped; nothing here re-implements them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');
const realSources = require('../src/sources');

const root = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const addJs = fs.readFileSync(path.join(root, 'ui', 'add.js'), 'utf8');
const uiUrl = (page) => pathToFileURL(path.join(root, 'ui', page)).href;

function slice(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} .. ${end}`);
  return src.slice(a, b);
}

// ---------------------------------------------------------------- main process side

const gh = (repo, extra) => ({ name: repo, listedBy: 'GitHub', curated: true, source: { type: 'github', owner: 'o', repo }, ...extra });
const okFile = (host) => ({ ok: true, file: 'f.zip', host, checksum: 'published' });
const preview = (types) => ({ listedBy: 'GitHub', version: '1.0', types });

function makeWebContents(url) {
  const sent = [];
  const wc = {
    sent,
    mainFrame: { url },
    send: (channel, data) => sent.push([channel, data]),
    on: () => {},
    setWindowOpenHandler: () => {},
  };
  return wc;
}

function mainHarness({ results = {}, previews = {}, cfg, platform = process.platform, p = path, dir = path.join(root, 'electron'), mainUrl } = {}) {
  const config = cfg || { repos: [], sourcePreference: [], typePreference: null, portableRoot: '/tmp/p' };
  const handlers = {};
  const windows = [];
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.webContents = makeWebContents('about:blank');
      this.closedCbs = [];
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() {}
    once(ev, cb) { if (ev === 'closed') this.closedCbs.push(cb); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file, { windows: platform === 'win32' }).href; return Promise.resolve(); }
    close() { this.destroyed = true; this.closedCbs.forEach((cb) => cb()); }
    destroy() { this.close(); }
  }
  const mainWin = { isDestroyed: () => false, webContents: makeWebContents(mainUrl || uiUrl('index.html')) };
  const sources = {
    makeCtx: () => ({}),
    resolve: async (text) => results[text] || { kind: 'name', candidates: [] },
    inspect: async (probe) => {
      const p = previews[probe.repo];
      if (!p) throw new Error('no preview');
      return p;
    },
    autoPick: realSources.autoPick,
    keyParts: realSources.keyParts,
    pageUrl: () => 'https://example.invalid/page',
  };
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    BrowserWindow,
    path: p,
    pathToFileURL,
    fileURLToPath,
    URL,
    process: { platform },
    __dirname: dir,
    win: mainWin,
    popularWin: null,
    sources,
    catalog: { lookup: () => null },
    detect: { osRelease: () => ({}) },
    shell: { openExternal: async () => {} },
    readConfig: () => config,
    log: () => {},
    console,
  };
  const code = slice(mainJs, 'const catalogLookup', '// --- Popular apps and packs')
    + slice(mainJs, 'const trackedKeys', 'let popularWin');
  vm.runInNewContext(code, context);
  const added = [];
  // The commit itself (config write, folder guards) has its own tests; here it records
  // what it was asked to add and answers like the real one.
  const keyOf = (i) => { const k = realSources.keyParts(i.source); return `${k.owner}/${k.repo}#${i.type}`; };
  const setCommit = (answer) => {
    context.addSourceItems = (items) => { added.push(items); return answer(items); };
  };
  setCommit((items) => ({ added: items.length, skipped: 0, conflicts: [], keys: items.map(keyOf) }));
  const ev = (wc) => ({ sender: wc, senderFrame: wc.mainFrame });
  const fromMain = ev(mainWin.webContents);
  const call = (name, e, arg) => handlers[name](e, arg);
  async function openAdd() {
    await call('results:open', fromMain, undefined);
    const w = windows[windows.length - 1];
    return { w, e: ev(w.webContents) };
  }
  const setPopular = (w) => { context.popularWin = w; };
  return { handlers, call, fromMain, openAdd, mainWin, config, added, windows, ev, setCommit, setPopular };
}

test('results:* refuse every caller except the live Add window\'s own page', async () => {
  const h = mainHarness({ results: { vlc: { kind: 'name', candidates: [gh('vlc')] } } });
  // Before any window exists, and from the main window itself.
  await assert.rejects(async () => h.call('results:search', h.fromMain, { text: 'vlc', prerelease: false }), /not the Add an app window/);
  const { w, e } = await h.openAdd();
  assert.equal(w.opts.webPreferences.sandbox, true);
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.nodeIntegration, false);
  // A subframe of the Add window.
  const sub = { sender: w.webContents, senderFrame: { url: e.senderFrame.url } };
  await assert.rejects(async () => h.call('results:search', sub, { text: 'vlc', prerelease: false }), /not the Add an app window/);
  // The Add window after navigating away from add.html.
  w.webContents.mainFrame.url = 'https://evil.invalid/';
  await assert.rejects(async () => h.call('results:data', e), /not the Add an app window/);
  w.webContents.mainFrame.url = uiUrl('add.html');
  assert.equal(h.call('results:data', e), null);
  // A closed window.
  w.close();
  await assert.rejects(async () => h.call('results:data', e), /not the Add an app window/);
  // The main-window-only handlers refuse the Add window.
  const again = await h.openAdd();
  await assert.rejects(async () => h.call('results:open', again.e, undefined), /only the main window/);
  await assert.rejects(async () => h.call('source:resolve', again.e, { text: 'vlc', prerelease: false }), /only the main window/);
});

// Measured by opus on Windows: launched from a lower-case drive path, __dirname keeps
// 'd:' while Chromium reports the page as file:///D:/... . The check must still accept
// the main window there (and the Add window loaded the same way), and refuse other pages.
test('on Windows the window check ignores drive-letter case', async () => {
  const h = mainHarness({
    platform: 'win32',
    p: path.win32,
    dir: 'd:\\Github\\gu-integ-b\\electron',
    mainUrl: 'file:///D:/Github/gu-integ-b/ui/index.html',
    results: { vlc: { kind: 'name', candidates: [gh('vlc')] } },
  });
  const r = await h.call('source:resolve', h.fromMain, { text: 'vlc', prerelease: false });
  assert.equal(r.candidates.length, 1);
  const { w, e } = await h.openAdd();
  w.webContents.mainFrame.url = 'file:///D:/Github/gu-integ-b/ui/add.html';
  assert.equal(h.call('results:data', e), null);
  w.webContents.mainFrame.url = 'file:///D:/Github/gu-integ-b/ui/popular.html';
  await assert.rejects(async () => h.call('results:data', e), /not the Add an app window/);
  // Popular apps opened on its Packs tab carries a query and must still be able to add.
  const popular = { isDestroyed: () => false, webContents: makeWebContents('file:///D:/Github/gu-integ-b/ui/popular.html?tab=packs') };
  h.setPopular(popular);
  const fromPopular = h.ev(popular.webContents);
  const item = [{ source: { type: 'github', owner: 'o', repo: 'vlc' }, name: 'vlc', type: 'installer' }];
  assert.equal(h.call('source:add', fromPopular, item).added, 1);
  assert.equal(h.mainWin.webContents.sent.filter(([ch]) => ch === 'config-changed').length, 1);
  // ...but not when that window shows some other page.
  popular.webContents.mainFrame.url = 'file:///D:/Github/gu-integ-b/ui/add.html?tab=packs';
  assert.throws(() => h.call('source:add', fromPopular, item), /only the main or Popular apps window/);
  h.mainWin.webContents.mainFrame.url = 'file:///E:/Github/gu-integ-b/ui/index.html';
  await assert.rejects(async () => h.call('source:resolve', h.fromMain, { text: 'vlc', prerelease: false }), /only the main window/);
});

test('results:search validates its input', async () => {
  const h = mainHarness();
  const { e } = await h.openAdd();
  for (const bad of [null, { text: '', prerelease: false }, { text: '  ', prerelease: false }, { text: 'x'.repeat(2049), prerelease: false }, { text: 'vlc', prerelease: 'yes' }, { text: 42, prerelease: false }]) {
    await assert.rejects(async () => h.call('results:search', e, bad), /up to 2048 characters/);
  }
});

test('a stale search id or a bad index is refused', async () => {
  const h = mainHarness({
    results: { a: { kind: 'name', candidates: [gh('a')] }, b: { kind: 'name', candidates: [gh('b'), { error: 'provider down' }] } },
    previews: { a: preview({ portable: okFile('a.host'), installer: { ok: false, reason: 'none' } }), b: preview({ portable: okFile('b.host'), installer: { ok: false, reason: 'none' } }) },
  });
  const { e } = await h.openAdd();
  const first = await h.call('results:search', e, { text: 'a', prerelease: false });
  const second = await h.call('results:search', e, { text: 'b', prerelease: false });
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.stringify(second.notes), JSON.stringify(['provider down']));
  await assert.rejects(async () => h.call('results:inspect', e, { id: first.id, index: 0 }), /no longer available/);
  for (const index of [-1, 1.5, '0', 1, 99, undefined]) {
    await assert.rejects(async () => h.call('results:inspect', e, { id: second.id, index }), /no longer available/, `index ${index}`);
  }
  await assert.rejects(async () => h.call('results:open-source', e, { id: first.id, index: 0 }), /no longer available/);
  const info = await h.call('results:inspect', e, { id: second.id, index: 0 });
  assert.equal(info.types.portable.host, 'b.host');
});

test('an add needs a type main has previewed as available', async () => {
  const h = mainHarness({
    results: { a: { kind: 'name', candidates: [gh('a')] } },
    previews: { a: preview({ portable: okFile('a.host'), installer: { ok: false, reason: 'no installer' } }) },
  });
  const { e } = await h.openAdd();
  const s = await h.call('results:search', e, { text: 'a', prerelease: false });
  // Not inspected yet.
  assert.throws(() => h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: false }), /not available/);
  await h.call('results:inspect', e, { id: s.id, index: 0 });
  assert.throws(() => h.call('results:add', e, { id: s.id, index: 0, type: 'installer', automatic: false }), /not available/);
  assert.throws(() => h.call('results:add', e, { id: s.id, index: 0, type: 'exe', automatic: false }), /invalid package type/);
  assert.throws(() => h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: 'no' }), /invalid package type or add mode/);
  assert.equal(h.added.length, 0);
});

test('an automatic add falls back to a choice when the saved defaults no longer decide it', async () => {
  const cfg = { repos: [], sourcePreference: ['github'], typePreference: 'portable', portableRoot: '/tmp/p' };
  const h = mainHarness({
    cfg,
    results: { a: { kind: 'name', candidates: [gh('a')] }, two: { kind: 'name', candidates: [gh('a'), gh('b')] } },
    previews: {
      a: preview({ portable: okFile('a.host'), installer: okFile('a.host') }),
      b: preview({ portable: okFile('b.host'), installer: okFile('b.host') }),
    },
  });
  const { e } = await h.openAdd();
  const s = await h.call('results:search', e, { text: 'a', prerelease: false });
  assert.equal(s.autoPick, 0);
  assert.equal(s.typePreference, 'portable');
  await h.call('results:inspect', e, { id: s.id, index: 0 });
  // The type preference changed since the search.
  cfg.typePreference = 'installer';
  assert.deepEqual(JSON.parse(JSON.stringify(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: true }))), { needsChoice: true });
  // The source preference no longer picks it.
  cfg.typePreference = 'portable';
  cfg.sourcePreference = ['brew'];
  assert.equal(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: true }).needsChoice, true);
  // It became tracked meanwhile.
  cfg.sourcePreference = ['github'];
  cfg.repos = [{ owner: 'o', repo: 'a', type: 'installer' }];
  assert.equal(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: true }).needsChoice, true);
  cfg.repos = [];
  // A candidate that is not the auto-pick is never added automatically.
  const s2 = await h.call('results:search', e, { text: 'two', prerelease: false });
  await h.call('results:inspect', e, { id: s2.id, index: 1 });
  assert.equal(h.call('results:add', e, { id: s2.id, index: 1, type: 'portable', automatic: true }).needsChoice, true);
  assert.equal(h.added.length, 0);
  assert.equal(h.mainWin.webContents.sent.length, 0);
});

test('a successful add reports only the committed keys, from main, and cannot be replayed', async () => {
  const h = mainHarness({
    results: { a: { kind: 'name', candidates: [gh('a')] } },
    previews: { a: { ...preview({ portable: { ...okFile('dl.example'), checksum: 'none' }, installer: { ok: false, reason: 'none' } }), } },
  });
  const { w, e } = await h.openAdd();
  const s = await h.call('results:search', e, { text: 'a', prerelease: true });
  await h.call('results:inspect', e, { id: s.id, index: 0 });
  const res = h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: false });
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { added: 1 });
  // The candidate added is main's own, with the search's pre-release flag.
  assert.equal(JSON.stringify(h.added), JSON.stringify([[{ source: { type: 'github', owner: 'o', repo: 'a' }, name: 'a', type: 'portable', prerelease: true }]]));
  const notes = h.mainWin.webContents.sent.filter(([ch]) => ch === 'results:added');
  assert.equal(notes.length, 1);
  assert.equal(JSON.stringify(notes[0][1].keys), JSON.stringify(['o/a#portable']));
  assert.equal(notes[0][1].message, 'Added a from GitHub — file from dl.example, no checksum published.');
  assert.equal(w.isDestroyed(), true);
  // The same selection again (window already gone) is refused.
  assert.throws(() => h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: false }), /not the Add an app window/);
});

test('an add that commits nothing reports an error, keeps the window and tells the main window nothing', async () => {
  const h = mainHarness({
    results: { a: { kind: 'name', candidates: [gh('a')] } },
    previews: { a: preview({ portable: okFile('a.host'), installer: { ok: false, reason: 'none' } }) },
  });
  const { w, e } = await h.openAdd();
  const s = await h.call('results:search', e, { text: 'a', prerelease: false });
  await h.call('results:inspect', e, { id: s.id, index: 0 });
  h.setCommit(() => ({ added: 0, skipped: 1, conflicts: [], keys: [] }));
  assert.equal(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: false }).error, 'a (Portable) is already in your list.');
  h.setCommit(() => ({ added: 0, skipped: 0, conflicts: [{ name: 'a', with: 'Other' }], keys: [] }));
  assert.match(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: false }).error, /same folder as Other/);
  assert.equal(h.mainWin.webContents.sent.length, 0);
  assert.equal(w.isDestroyed(), false);
});

test('an emulated preview is never added automatically', async () => {
  const cfg = { repos: [], sourcePreference: ['github'], typePreference: 'portable', portableRoot: '/tmp/p' };
  const h = mainHarness({
    cfg,
    results: { a: { kind: 'name', candidates: [gh('a')] } },
    previews: { a: preview({ portable: { ...okFile('a.host'), emulated: true }, installer: { ok: false, reason: 'none' } }) },
  });
  const { e } = await h.openAdd();
  const s = await h.call('results:search', e, { text: 'a', prerelease: false });
  await h.call('results:inspect', e, { id: s.id, index: 0 });
  assert.equal(h.call('results:add', e, { id: s.id, index: 0, type: 'portable', automatic: true }).needsChoice, true);
  assert.equal(h.added.length, 0);
});

// ---------------------------------------------------------------- renderer side

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function makeNode(tag) {
  return {
    tag,
    children: [],
    className: '',
    disabled: false,
    checked: false,
    value: '',
    _text: '',
    listeners: {},
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    replaceChildren(...cs) { this._text = ''; this.children = cs; },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    focus() {},
  };
}

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}

async function settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

function addWindow({ initial = null } = {}) {
  const nodes = {};
  for (const id of ['search', 'query', 'find', 'prerelease', 'status', 'list', 'count', 'close']) nodes[id] = makeNode(id);
  const docListeners = {};
  const calls = { search: [], inspect: [], add: [], close: 0 };
  const pending = { search: [], inspect: [], add: [] };
  let onSearch = null;
  const api = {
    getSearch: async () => initial,
    onSearch: (cb) => { onSearch = cb; },
    search: (text, prerelease) => { calls.search.push([text, prerelease]); const d = deferred(); pending.search.push(d); return d.promise; },
    inspectResult: (id, index) => { calls.inspect.push([id, index]); const d = deferred(); pending.inspect.push(d); return d.promise; },
    openSourcePage: async () => {},
    addResult: (id, index, type, automatic) => { calls.add.push([id, index, type, automatic]); const d = deferred(); pending.add.push(d); return d.promise; },
    close: async () => { calls.close++; },
  };
  const context = {
    document: {
      getElementById: (id) => nodes[id],
      createElement: makeNode,
      addEventListener: (ev, fn) => { docListeners[ev] = fn; },
    },
    window: { api },
  };
  vm.runInNewContext(addJs, context);
  const submit = (text, prerelease = false) => {
    nodes.query.value = text;
    nodes.prerelease.checked = prerelease;
    return nodes.search.listeners.submit({ preventDefault() {} });
  };
  const names = () => findAll(nodes.list, (n) => n.className === 'opt-name').map((n) => n.textContent);
  return { nodes, calls, pending, submit, names, docListeners, handoff: (d) => onSearch(d) };
}

const data = (id, text, names, extra) => ({
  id, text, prerelease: false, notes: [], autoPick: -1, typePreference: null,
  candidates: names.map((name, index) => ({ index, name, sourceType: 'github', listedBy: 'GitHub' })),
  ...extra,
});
const info = { listedBy: 'GitHub', version: '1.0', types: { installer: { ok: false, reason: 'none' }, portable: { ok: true, file: 'a.zip', host: 'h', checksum: 'published' } } };

test('add window: an older search that finishes last is not painted', async () => {
  const win = addWindow();
  await settle();
  win.submit('first');
  win.submit('second');
  assert.deepEqual(win.calls.search.map((c) => c[0]), ['first', 'second']);
  win.pending.search[1].resolve(data(2, 'second', ['Second App']));
  await settle();
  assert.deepEqual(win.names(), ['Second App']);
  win.pending.search[0].resolve(data(1, 'first', ['First App']));
  await settle();
  assert.deepEqual(win.names(), ['Second App']);
  // A late inspection for a replaced search does not touch its (now detached) card, nor
  // paint into the new list.
  const [oldMeta] = findAll(win.nodes.list, (n) => n.className === 'opt-meta');
  const [oldActions] = findAll(win.nodes.list, (n) => n.className === 'opt-actions');
  assert.equal(oldMeta.textContent, 'Checking what this computer would get…');
  assert.equal(oldActions.children.length, 0);
  win.submit('third');
  win.pending.inspect[0].resolve(info);
  await settle();
  assert.equal(oldActions.children.length, 0, 'no Add buttons added to the replaced card');
  assert.equal(oldMeta.textContent, 'Checking what this computer would get…');
  assert.deepEqual(win.names(), []);
});

test('add window: searching and closing are locked while an add is in flight', async () => {
  const win = addWindow();
  await settle();
  win.submit('app');
  win.pending.search[0].resolve(data(7, 'app', ['App']));
  await settle();
  win.pending.inspect[0].resolve(info);
  await settle();
  const buttons = findAll(win.nodes.list, (n) => n.tag === 'button' && n.textContent.startsWith('Add as '));
  assert.equal(buttons.length, 2);
  const portable = buttons.find((b) => b.textContent === 'Add as Portable');
  assert.equal(portable.disabled, false);
  portable.onclick();
  assert.deepEqual(win.calls.add, [[7, 0, 'portable', false]]);
  for (const id of ['query', 'find', 'prerelease', 'close']) assert.equal(win.nodes[id].disabled, true, id);
  assert.ok(buttons.every((b) => b.disabled));
  await win.submit('other');
  assert.equal(win.calls.search.length, 1, 'no search while adding');
  win.docListeners.keydown({ key: 'Escape' });
  portable.onclick();
  await settle();
  assert.equal(win.calls.close, 0, 'Escape does not close mid-add');
  assert.equal(win.calls.add.length, 1, 'no second add while adding');
  win.pending.add[0].resolve({ error: 'App (Portable) is already in your list.' });
  await settle();
  assert.equal(win.nodes.status.textContent, 'App (Portable) is already in your list.');
  assert.equal(win.nodes.status.className, 'bad');
  for (const id of ['query', 'find', 'prerelease', 'close']) assert.equal(win.nodes[id].disabled, false, id);
  assert.equal(portable.disabled, false);
});

test('add window: a handoff with no results shows the empty state with the text filled in', async () => {
  const win = addWindow({ initial: data(3, 'zzqxnotanapp', [], { notes: ['Homebrew is not available on this operating system'] }) });
  await settle();
  assert.equal(win.nodes.query.value, 'zzqxnotanapp');
  const text = win.nodes.list.textContent;
  assert.match(text, /Nothing found for “zzqxnotanapp”\./);
  assert.match(text, /Homebrew is not available/);
  assert.equal(win.calls.search.length, 0, 'a handoff is not resolved a second time');
  assert.equal(win.calls.add.length, 0);
});

test('add window: an empty search box is refused without a request', async () => {
  const win = addWindow();
  await settle();
  await win.submit('   ');
  assert.equal(win.calls.search.length, 0);
  assert.equal(win.nodes.status.textContent, 'Enter an app name or address.');
});
