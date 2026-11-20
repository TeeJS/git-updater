'use strict';

// The main screen's header: the running version right after the name, then the Scan this PC /
// Packs / Popular apps group and Settings at the right.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('the version sits right after the git-updater name, before the Settings button', () => {
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  const name = header.indexOf('<h1><span class="g">git</span>-updater</h1>');
  const ver = header.indexOf('id="headerVersion"');
  const settings = header.indexOf('id="openSettings"');
  assert.ok(name >= 0 && ver > name && settings > ver, 'name, then version, then the Settings button');
});

test('the version is filled in from the running app, with a leading v', () => {
  assert.match(html, /\$\('headerVersion'\)\.textContent = v \? `v\$\{v\}` : ''/);
  assert.match(html, /\.ver:empty \{ display: none; \}/, 'nothing is shown until the version is known');
});

// Scan this PC, Packs and Popular apps moved from a "Known apps" row at the bottom of the list
// (easy to miss under a long list) to the top right, immediately left of Settings.
const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));

test('Scan this PC, Packs and Popular apps sit in the header, in that order, immediately left of Settings', () => {
  const group = header.slice(header.indexOf('<div class="top-actions">'));
  assert.ok(header.indexOf('<div class="top-actions">') > header.indexOf('id="headerVersion"'), 'the group follows the version');
  const at = (id) => group.indexOf(`id="${id}"`);
  assert.ok(at('scanPc') >= 0 && at('packsBtn') > at('scanPc') && at('browseAll') > at('packsBtn') && at('openSettings') > at('browseAll'),
    'scanPc, packsBtn, browseAll, then openSettings, all inside .top-actions');
  const between = group.slice(at('browseAll'), at('openSettings'));
  assert.equal((between.match(/<button/g) || []).length, 1, 'nothing else sits between Popular apps and Settings');
});

test('the Known apps row at the bottom is gone, and each button exists exactly once', () => {
  for (const gone of ['class="scan-row"', 'id="knownHelp"', '>Known apps<', '.scan-row', "$('knownHelp')"]) {
    assert.ok(!html.includes(gone), `${gone} is removed`);
  }
  for (const id of ['scanPc', 'packsBtn', 'browseAll', 'openSettings']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} appears once`);
  }
  assert.match(html, /\.scan-label \{/, '.scan-label stays: the Settings checkboxes still use it');
});

test('the group never splits across lines; on a narrow window it moves below the name as a whole, right-aligned', () => {
  const rule = (html.match(/\.top-actions \{([^}]*)\}/) || [])[1] || '';
  assert.match(rule, /margin-left: auto/);
  assert.match(rule, /flex-wrap: nowrap/);
  assert.match(rule, /white-space: nowrap/);
  assert.match(html, /\.topbar \{ flex-wrap: wrap; \}/, 'the header itself may wrap, moving the whole group');
});

function sourceBetween(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `found ${start}`);
  return html.slice(a, b);
}

test('Scan this PC is hidden where the platform cannot scan, and kept where it can', async () => {
  const block = sourceBetween("$('scanPc').onclick", "$('browseAll').onclick");
  for (const canScan of [false, true]) {
    const els = { scanPc: { style: {} } };
    const ctx = { $: (id) => els[id], msg: () => {}, clean: String, window: { api: { getPlatform: async () => ({ canScan }), openScan: async () => {} } } };
    vm.runInNewContext(block, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(els.scanPc.style.display, canScan ? undefined : 'none', `canScan ${canScan}`);
  }
});

test('Scan this PC shows main\'s refusal in the status line instead of an unhandled rejection', async () => {
  const block = sourceBetween("$('scanPc').onclick", '// "Scan this PC" offers');
  const shown = [];
  const els = { scanPc: { style: {} } };
  const ctx = {
    $: (id) => els[id],
    msg: (t, cls) => shown.push([t, cls]),
    clean: (e) => String(e && e.message ? e.message : e).replace(/^Error:\s*/, ''),
    window: { api: { openScan: async () => { throw new Error('Scan this PC is not available on linux; use Popular apps to add known apps'); } } },
  };
  vm.runInNewContext(block, ctx);
  await els.scanPc.onclick();
  assert.deepEqual(shown, [['Scan this PC is not available on linux; use Popular apps to add known apps', 'bad']]);
});
