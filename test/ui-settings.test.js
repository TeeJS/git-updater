'use strict';

// Settings is its own screen, not a collapsed box under the list. These tests guard the
// structure (what lives on which screen, no control lost in the move) and run showScreen()
// against a tiny fake page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// The two screens, as slices of the markup.
const mainStart = html.indexOf('<div id="mainScreen">');
const settingsStart = html.indexOf('<div id="settingsScreen"');
const scriptStart = html.indexOf('<script>');
assert.ok(mainStart > 0 && settingsStart > mainStart && scriptStart > settingsStart, 'both screens found, main first');
const mainScreen = html.slice(mainStart, settingsStart);
const settingsScreen = html.slice(settingsStart, scriptStart);

const SETTINGS_IDS = [
  'portableRoot', 'browse', 'saveRoot', 'dateFormat',
  'startupSortEnabled', 'startupSortColumn', 'startupSortDirection', 'rememberFilters',
  'checkOnOpen', 'autoCloseReopen', 'downloadLimitEnabled', 'downloadLimitMiB', 'saveDownloadLimit',
  'selfCheckOnOpen', 'selfAutoUpdate', 'selfPreRel',
  'startAtLogin', 'keepRunning',
  'scheduleCheckEnabled', 'scheduleCheckCron', 'scheduleCheckPreview', 'scheduleCatchUp',
  'repeatCheckHours', 'repeatCheckDays', 'repeatCheckWeeks', 'repeatCheckMonths', 'repeatCheckNote',
  'scheduleInstallEnabled', 'scheduleInstallCron', 'scheduleInstallPreview', 'scheduleInstallApps',
  'repeatInstallHours', 'repeatInstallDays', 'repeatInstallWeeks', 'repeatInstallMonths', 'repeatInstallNote',
  'ghToken', 'saveToken', 'clearToken', 'createToken', 'tokenHint',
  'editJson', 'openLog', 'appVersion',
];

const count = (s, needle) => s.split(needle).length - 1;

test('every Settings control moved to the Settings screen, once, and none was lost', () => {
  for (const id of SETTINGS_IDS) {
    assert.equal(count(html, `id="${id}"`), 1, `${id} appears exactly once`);
    assert.ok(settingsScreen.includes(`id="${id}"`), `${id} is on the Settings screen`);
    assert.ok(!mainScreen.includes(`id="${id}"`), `${id} is not on the list screen`);
  }
});

test('the list screen keeps the list, the search, Add an app and Known apps', () => {
  for (const id of ['rows', 'search', 'filterType', 'filterStatus', 'checkAll', 'updateAll', 'newRepo', 'scanPc', 'browseAll', 'msg', 'openSettings']) {
    assert.ok(mainScreen.includes(`id="${id}"`), `${id} is on the list screen`);
  }
  assert.ok(settingsScreen.includes('id="settingsBack"'), 'Back is on the Settings screen');
  assert.ok(settingsScreen.includes('class="msg-slot"'), 'a place for the status line to land');
  assert.ok(mainScreen.includes('id="msgHome"'), 'and a home for it on the list screen');
  assert.ok(!html.includes('<details class="settings"'), 'the collapsed box is gone');
});

test('Settings is grouped under headings so it scales', () => {
  for (const heading of ['Apps and display', 'Updating', 'Schedule', 'Background', 'GitHub', 'Advanced']) {
    assert.match(settingsScreen, new RegExp(`<h2 class="sec-h" id="sg-[a-z]+">${heading}</h2>`), heading);
  }
});

test('every id the script looks up exists in the page (no control lost in a move)', () => {
  const script = html.slice(scriptStart);
  const wanted = new Set([...script.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

// --- showScreen against a fake page -------------------------------------------------
const begin = html.indexOf('// --- screens:');
const end = html.indexOf('// --- end of the screens block ---');
assert.ok(begin > 0 && end > begin, 'screens block found');
const screensSource = html.slice(begin, end);

function fakePage() {
  const log = [];
  const el = (name, hidden = false) => ({ name, hidden, children: [], appendChild(c) { this.children.push(c.name); c.parent = this.name; log.push(`${c.name} -> ${this.name}`); }, focus(o) { log.push(`focus ${name}${o && o.preventScroll ? ' (no scroll)' : ''}`); } });
  const els = { mainScreen: el('mainScreen'), settingsScreen: el('settingsScreen', true), msg: el('msg'), msgHome: el('msgHome'), settingsBack: el('settingsBack'), openSettings: el('openSettings') };
  const slot = el('slot');
  els.settingsScreen.querySelector = (sel) => (sel === '.msg-slot' ? slot : null);
  let scrollY = 0;
  const calls = { refreshToken: 0 };
  const ctx = {
    $: (id) => els[id],
    window: { get scrollY() { return scrollY; }, scrollTo: (x, y) => { log.push(`scrollTo ${y}`); scrollY = y; } },
    refreshToken: () => { calls.refreshToken++; },
  };
  vm.runInNewContext(screensSource, ctx);
  return { ctx, els, slot, log, calls, setScroll: (y) => { scrollY = y; } };
}

test('showScreen: opening Settings hides the list, takes the status line with it, starts at the top and refreshes the quota', () => {
  const p = fakePage();
  p.setScroll(420);
  p.ctx.showScreen('settings');
  assert.equal(p.els.mainScreen.hidden, true);
  assert.equal(p.els.settingsScreen.hidden, false);
  assert.deepEqual(p.slot.children, ['msg'], 'the status line is on the Settings screen');
  assert.equal(p.calls.refreshToken, 1);
  assert.ok(p.log.includes('scrollTo 0') && p.log.includes('focus settingsBack (no scroll)'));
});

test('showScreen: Back returns to the list as it was left (scroll position, status line, focus)', () => {
  const p = fakePage();
  p.setScroll(420);
  p.ctx.showScreen('settings');
  p.ctx.showScreen('main');
  assert.equal(p.els.mainScreen.hidden, false);
  assert.equal(p.els.settingsScreen.hidden, true);
  assert.ok(p.els.msgHome.children.includes('msg'), 'the status line is home again');
  assert.ok(p.log.includes('scrollTo 420'), 'scroll position restored');
  // Focus must not scroll the page: focusing the button at the top would undo the restore above.
  assert.ok(p.log.indexOf('focus openSettings (no scroll)') > p.log.indexOf('scrollTo 420'), 'focus goes back to the Settings button without scrolling');
});

test('showScreen: asking for the screen you are already on does nothing', () => {
  const p = fakePage();
  p.ctx.showScreen('main');
  assert.deepEqual(p.log, []);
  p.ctx.showScreen('settings');
  const before = p.log.length;
  p.ctx.showScreen('settings');
  assert.equal(p.log.length, before);
  assert.equal(p.calls.refreshToken, 1, 'the quota is fetched once per visit');
});

test('Esc and the buttons are wired; adding a portable app with no folder opens Settings', () => {
  assert.match(html, /\$\('openSettings'\)\.onclick = \(\) => showScreen\('settings'\)/);
  assert.match(html, /\$\('settingsBack'\)\.onclick = \(\) => showScreen\('main'\)/);
  assert.match(html, /e\.key === 'Escape' && !\$\('settingsScreen'\)\.hidden/);
  assert.match(html, /showScreen\('settings'\); \$\('portableRoot'\)\.focus\(\)/);
});
