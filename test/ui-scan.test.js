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
        scanReview: async (ids) => { calls.push(['scanReview', ids]); },
      },
      close: () => calls.push('close'),
    },
  };
  vm.runInNewContext(scanHtml.slice(s, e), context);
  return { nodes, calls };
}

test('the scan window lists installed apps by where they come from, and sends the picked ones to review', async () => {
  const { nodes, calls } = runScanWindow([
    { id: 'googlechrome', name: 'Google Chrome', displayName: 'Google Chrome', version: '158.0', sources: ['WinGet'], tracked: false },
    { id: 'zoom', name: 'Zoom', displayName: 'Zoom Workplace (64-bit)', version: '7.2', sources: ['WinGet'], tracked: false },
    { id: 'obsstudio', name: 'OBS Studio', displayName: 'OBS Studio', version: '33.0', sources: ['GitHub', 'WinGet'], tracked: true },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['scanRun']);
  assert.equal(nodes.status.textContent, 'Found 3 known installed apps; 2 not yet in your list.');
  assert.equal(nodes.list.children.length, 3);
  // Each row says where the app would be kept up to date from; a tracked one says so instead.
  const cells = (i) => nodes.list.children[i].children;
  assert.equal(cells(0)[3].textContent, 'WinGet');
  assert.equal(cells(2)[3].textContent, 'in your list');
  assert.match(cells(1)[1].title, /Installed as “Zoom Workplace \(64-bit\)”/, 'the installed name that was matched is shown');
  nodes.selAll.onchange({ target: { checked: true } });
  assert.equal(nodes.count.textContent, '2 selected');
  await nodes.add.onclick();
  // Nothing is added from this window: the ids go to the review step.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ['scanReview', ['googlechrome', 'zoom']]);
});

test('the scan window says so when nothing known is installed', async () => {
  const { nodes } = runScanWindow([]);
  await new Promise((r) => setImmediate(r));
  assert.equal(nodes.status.textContent, 'No known apps found on this PC.');
  assert.equal(nodes.add.disabled, true);
});

// --- the scan covers every app in Popular apps, not only the GitHub catalog ------------------

const catalog = require('../src/catalog');
const I = (...rows) => rows.map(([DisplayName, DisplayVersion = '1.0']) => ({ DisplayName, DisplayVersion }));
const found = (rows, plat) => catalog.scanInstalled(rows, plat).map((r) => r.name);

test('an app that comes from WinGet or Homebrew is found by its installed name', () => {
  // The bug: Chrome was never found, on either system, because it is not a GitHub project.
  assert.deepEqual(found(I(['Google Chrome', '158.0.8127.37']), 'win32'), ['Google Chrome']);
  assert.deepEqual(found(I(['Google Chrome.app', '158.0']), 'darwin'), ['Google Chrome']);
  // Version and architecture noise in the installed name does not get in the way.
  assert.deepEqual(found(I(
    ['Mozilla Firefox (x64 en-US)'], ['GIMP 3.2.8'], ['Krita (x64) 5.3.4'], ['PuTTY release 0.85 (64-bit)'], ['Opera Stable 124.0.5863.44'],
    ['Zoom Workplace (64-bit)'], ['Microsoft Visual Studio Code (User)'], ['Git'], ['VLC media player'], ['1Password'],
  ), 'win32').sort(), ['1Password', 'GIMP', 'Git', 'Krita', 'Mozilla Firefox', 'Opera', 'PuTTY', 'VLC media player', 'Visual Studio Code', 'Zoom'].sort());
  // macOS bundle names, including the ones that are an alias rather than the name.
  assert.deepEqual(found(I(['Firefox.app'], ['zoom.us.app'], ['VLC.app'], ['OBS.app'], ['Docker.app'], ['iTerm.app'], ['Brave Browser.app']), 'darwin').sort(),
    ['Brave', 'Docker Desktop', 'Mozilla Firefox', 'OBS Studio', 'VLC media player', 'Zoom', 'iTerm2'].sort());
});

test('the match is exact: a longer or different name is not the app', () => {
  assert.deepEqual(found(I(['Chrome Remote Desktop Host'], ['Git Extensions'], ['Firefox Developer Edition'], ['Google Chrome Canary'], ['Slack Helper'], ['Steam Link']), 'win32'), []);
  // An app with no source on this system is not offered there, whatever is installed.
  assert.deepEqual(found(I(['Terminal.app'], ['Notepad++.app'], ['Git.app']), 'darwin'), []);
  assert.deepEqual(catalog.installedKey('Windows App'), 'windowsapp', 'a word that is part of the name is kept');
  assert.deepEqual(catalog.installedKey('1Password'), '1password', 'so is a number inside one');
});

test('one release line among several is never guessed from a bare name', () => {
  // "Python" and "Node.js" do not say which line is installed; offering 3.15 or the LTS for
  // them would be a major-version jump. Side-by-side runtimes are left out the same way.
  assert.deepEqual(found(I(['Python 3.12.4 (64-bit)', '3.12.4'], ['Node.js', '22.1.0'], ['Microsoft .NET Desktop Runtime - 8.0.34 (x64)'], ['Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.52']), 'win32'), []);
  for (const s of catalog.SHORTCUTS) if (s.scan !== undefined) assert.equal(s.scan, false, s.name);
  // Java keeps the per-major patterns it always had: the installed major is the one offered.
  assert.deepEqual(found(I(['Eclipse Temurin JRE with Hotspot 21.0.5+11 (x64)']), 'win32'), ['Temurin 21']);
});

test('the GitHub catalog still finds what it found, and nothing is listed twice', () => {
  const rows = I(['7-Zip 26.02 (x64 edition)', '26.02'], ['Notepad++ (64-bit x64)', '8.9'], ['OBS Studio', '33.0.1'], ['OBS Studio', '32.0.0'], ['lazygit', '0.50']);
  const hits = catalog.scanInstalled(rows, 'win32');
  assert.deepEqual(hits.map((r) => [r.id, r.version]), [['obsstudio', '33.0.1'], ['notepad', '8.9'], ['7zip', '26.02'], ['lazygit', '0.50']], 'list order; the highest version of a repeat');
  assert.equal(hits.find((r) => r.id === '7zip').displayName, '7-Zip 26.02 (x64 edition)');
  // Linux keeps exact package identifiers only: no name matching there.
  assert.deepEqual(found(I(['Google Chrome'], ['firefox'], ['7zip'], ['obs-studio']), 'linux').sort(), ['7-Zip', 'OBS Studio']);
});

// Runs the real scan:run / scan:plan / scan:review handlers with fake Electron objects.
function scanHandlers({ platform = 'win32', installed = [], repos = [] } = {}) {
  const a = mainJs.indexOf('let scanWin = null;');
  const b = mainJs.indexOf('// Running check and close for a tracked app.');
  assert.ok(a >= 0 && b > a);
  const handlers = {};
  const calls = [];
  const sources = require('../src/sources');
  const packs = require('../src/packs');
  const scanWin = { closed: false, isDestroyed() { return this.closed; }, close() { this.closed = true; }, focus() {}, loadFile() {} };
  class BrowserWindow { constructor() { return scanWin; } }
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    BrowserWindow, path, __dirname: path.join(root, 'electron'), process: { platform }, win: null,
    catalog, sources, packs, Set, Map,
    detect: { clearCache: () => {}, allInstalled: async () => installed.map((e) => ({ ...e, name: e.DisplayName, version: e.DisplayVersion })) },
    readConfig: () => ({ repos, sourcePreference: [] }),
    knownTypes: () => sources.providerTypes(),
    trackedKeys: (cfg) => new Set(cfg.repos.map((r) => `${r.owner}/${r.repo}`)),
    isTracked: (set, source) => { const k = sources.keyParts(source); return set.has(`${k.owner}/${k.repo}`); },
    alsoTracked: (set, app) => !!(app && app.also) && [...set].some((k) => app.also.map((r) => r.toLowerCase()).includes(k.toLowerCase())),
    planItems: async (items, opts) => { calls.push(['planItems', items.map((i) => i.appId), opts]); return []; },
    openPopular: (query) => calls.push(['openPopular', query]),
  };
  vm.runInNewContext(mainJs.slice(a, b), context);
  const call = async (name, ...args) => JSON.parse(JSON.stringify(await handlers[name]({}, ...args) ?? null));
  return { call, calls, handlers, scanWin, open: () => handlers['scan:open']({}) };
}

test('scan:run reports each found app with its sources and whether it is already in the list', async () => {
  const h = scanHandlers({
    platform: 'win32',
    installed: [
      { DisplayName: 'Google Chrome', DisplayVersion: '158.0' },
      { DisplayName: 'Bitwarden', DisplayVersion: '2026.11.0' },
      { DisplayName: 'OBS Studio', DisplayVersion: '33.0.1' },
      { DisplayName: 'MicrosoftCorporationII.Windows365', DisplayVersion: '2.0', packaged: true },
      { DisplayName: 'Some Unknown App', DisplayVersion: '1' },
    ],
    repos: [{ owner: 'bitwarden', repo: 'clients', type: 'portable' }, { owner: 'obsproject', repo: 'obs-studio', type: 'installer' }],
  });
  const rows = await h.call('scan:run');
  assert.deepEqual(rows.map((r) => [r.id, r.version, r.sources, r.tracked]), [
    ['googlechrome', '158.0', ['WinGet'], false],
    ['obsstudio', '33.0.1', ['GitHub', 'WinGet'], true],
    ['bitwarden', '2026.11.0', ['WinGet'], true], // tracked from bitwarden/clients: still Bitwarden
  ]);
  assert.match(rows[0].description, /^Google's web browser/);
  assert.deepEqual(await scanHandlers({ platform: 'linux', installed: [{ DisplayName: 'obs-studio', DisplayVersion: '33' }] }).call('scan:run'), [], 'no scan on Linux');
});

test('Review and add hands the ticked apps to the Popular apps review, installer first on Windows', async () => {
  const h = scanHandlers({ platform: 'win32' });
  h.open();
  assert.deepEqual(await h.call('scan:review', ['googlechrome', 'zoom']), { opened: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['openPopular', { scan: 'googlechrome,zoom' }]]);
  assert.equal(h.scanWin.closed, true, 'the scan window closes: the review continues in the other one');
  for (const bad of [[], 'googlechrome', ['Google Chrome'], ['../x'], [1], Array(300).fill('a')]) {
    await assert.rejects(async () => h.handlers['scan:review']({}, bad), /choose the apps to add first/);
  }
  await h.call('scan:plan', ['googlechrome', 'zoom']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), ['planItems', ['googlechrome', 'zoom'], { typeFirst: 'installer' }]);
  // On macOS an installed app is an app bundle: the saved preference decides, as elsewhere.
  const mac = scanHandlers({ platform: 'darwin' });
  await mac.call('scan:plan', ['googlechrome']);
  assert.deepEqual(JSON.parse(JSON.stringify(mac.calls[0])), ['planItems', ['googlechrome'], { typeFirst: null }]);
});

test('the Popular apps window opens straight on the review when it is given scanned apps', () => {
  const pop = fs.readFileSync(path.join(root, 'ui', 'popular.html'), 'utf8');
  assert.match(pop, /const scanIds = \(new URLSearchParams\(location\.search\)\.get\('scan'\) \|\| ''\)/);
  assert.match(pop, /review\(\(\) => window\.api\.scanPlan\(scanIds\), 'scan',/);
  // A scan review ends on the MAIN window: adding closes this one, and so does leaving it.
  // It used to fall back to the Popular apps list, a page the user never opened.
  assert.match(pop, /window\.api\.addSources\(items, fromScan \? \{ scan: true \} : undefined\)/);
  assert.match(pop, /if \(res\.closing\) return window\.close\(\);/);
  assert.match(pop, /if \(planFrom === 'scan'\) return window\.close\(\);/);
  assert.match(pop, /\$\('back'\)\.textContent = planFrom === 'scan' \? 'Cancel' : 'Back';/);
  assert.match(preloadJs, /addSources: \(items, opts\) => ipcRenderer\.invoke\('source:add', items, opts\)/);
  assert.match(preloadJs, /scanPlan: \(ids\) => ipcRenderer\.invoke\('scan:plan', ids\)/);
  assert.match(preloadJs, /scanReview: \(ids\) => ipcRenderer\.invoke\('scan:review', ids\)/);
  assert.doesNotMatch(preloadJs, /scanAdd|scan:add/, 'the old add-without-review path is gone');
  assert.doesNotMatch(mainJs, /'scan:add'/);
});
