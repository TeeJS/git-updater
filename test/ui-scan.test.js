'use strict';

// "Scan this PC" has one mode, Installed on this PC. The "All known apps" mode was removed
// because every one of its entries is already offered by Popular apps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scanHtml = fs.readFileSync(path.join(root, 'ui', 'scan.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');

test('the scan window has no "All known apps" mode', () => {
  assert.doesNotMatch(scanHtml, /All known apps/);
  assert.doesNotMatch(scanHtml, /id="mode"/);
  assert.doesNotMatch(scanHtml, /catalogAll|showAll|catalogRows|mode=all/);
  assert.match(scanHtml, /Installed on this PC/);
});

test('main and preload no longer expose the whole catalog to the scan window', () => {
  assert.doesNotMatch(mainJs, /'catalog:all'/);
  assert.doesNotMatch(preloadJs, /catalogAll|catalog:all/);
  assert.match(preloadJs, /openScan: \(\) => ipcRenderer\.invoke\('scan:open'\)/);
});

// Runs the real scan:open handler with a fake BrowserWindow, on each platform.
function scanOpen(platform) {
  const a = mainJs.indexOf("let scanWin = null;");
  const b = mainJs.indexOf("ipcMain.handle('app:platform'");
  assert.ok(a >= 0 && b > a);
  const handlers = {};
  const opened = [];
  class BrowserWindow {
    constructor() { opened.push(this); this.loaded = null; }
    isDestroyed() { return false; }
    focus() {}
    loadFile(file, opts) { this.loaded = { file, opts }; }
  }
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    BrowserWindow,
    path,
    __dirname: path.join(root, 'electron'),
    process: { platform },
    win: null,
  };
  vm.runInNewContext(mainJs.slice(a, b), context);
  return { open: () => handlers['scan:open']({}), opened };
}

test('scan:open refuses with a clear error on Linux instead of opening an empty window', () => {
  const { open, opened } = scanOpen('linux');
  assert.throws(open, /Scan this PC is not available on linux; use Popular apps/);
  assert.equal(opened.length, 0);
});

for (const platform of ['win32', 'darwin']) {
  test(`scan:open on ${platform} opens scan.html with no mode argument, and reuses the window`, () => {
    const { open, opened } = scanOpen(platform);
    open();
    assert.equal(opened.length, 1);
    assert.equal(path.basename(opened[0].loaded.file), 'scan.html');
    assert.equal(opened[0].loaded.opts, undefined);
    open();
    assert.equal(opened.length, 1);
  });
}

// Runs the window's script against a minimal DOM.
function runScanWindow(rows) {
  const s = scanHtml.indexOf('<script>') + '<script>'.length;
  const e = scanHtml.indexOf('</script>');
  const nodes = {};
  const mk = (tag) => ({
    tag, children: [], style: {}, textContent: '', className: '', checked: false, disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(_v) { this.children = []; },
  });
  for (const id of ['status', 'list', 'selAll', 'count', 'close', 'add']) nodes[id] = mk('div');
  const calls = [];
  const context = {
    document: { getElementById: (id) => nodes[id], createElement: mk },
    window: {
      api: {
        scanRun: async () => { calls.push('scanRun'); return rows; },
        scanAdd: async (items) => { calls.push(['scanAdd', items]); },
      },
      close: () => calls.push('close'),
    },
  };
  vm.runInNewContext(scanHtml.slice(s, e), context);
  return { nodes, calls };
}

test('the scan window loads installed apps, adds the picked ones as Installer', async () => {
  const { nodes, calls } = runScanWindow([
    { name: 'App One', repo: 'o/one', version: '1.0', tracked: false },
    { name: 'App Two', repo: 'o/two', version: '2.0', tracked: true },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['scanRun']);
  assert.equal(nodes.status.textContent, 'Found 2 known installed apps; 1 not yet tracked.');
  assert.equal(nodes.list.children.length, 2);
  nodes.selAll.onchange({ target: { checked: true } });
  assert.equal(nodes.count.textContent, '1 selected');
  await nodes.add.onclick();
  assert.equal(JSON.stringify(calls[1]), JSON.stringify(['scanAdd', [{ repo: 'o/one', type: 'installer' }]]));
});

test('the scan window says so when nothing known is installed', async () => {
  const { nodes } = runScanWindow([]);
  await new Promise((r) => setImmediate(r));
  assert.equal(nodes.status.textContent, 'No known apps found on this PC.');
  assert.equal(nodes.add.disabled, true);
});
