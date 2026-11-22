'use strict';

// Compact view: the Compact switch in the header. One line per app, flowing into columns.
// These guard the structure (everything is behind body.compact, the ordinary list is not
// touched) and run the two pure pieces that decide what a compact line says.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const block = html.slice(html.indexOf('// --- compact view ---'), html.indexOf('// --- end of the compact view block ---'));

test('the switch is in the header, before the buttons, and is remembered in config.json', () => {
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.ok(header.indexOf('id="compactView"') > header.indexOf('<div class="top-actions">'));
  assert.ok(header.indexOf('id="compactView"') < header.indexOf('id="scanPc"'));
  assert.match(block, /const compactOn = \(\) => config\.compactView === true;/);
  assert.match(block, /if \(\$\('compactView'\)\.checked\) config\.compactView = true; else delete config\.compactView;\s*syncCompact\(\);\s*renderRepos\(\);\s*saveConfig\(\);/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(main.includes('if (cfg.compactView != null) cfg.compactView = !!cfg.compactView;'));
});

test('every compact style needs body.compact, so the ordinary list is drawn as before', () => {
  const css = html.slice(html.indexOf('/* Compact view (the Compact switch'), html.indexOf('.hint { font-size: .84rem;'));
  const rules = css.split('\n').filter((l) => /\{/.test(l) && !/^\s*\/\*/.test(l) && !/^\s*@media/.test(l)); // the one @media line only hides the switch's own word
  assert.ok(rules.length >= 10);
  for (const rule of rules) {
    const selector = rule.slice(0, rule.indexOf('{'));
    // Classes that exist only on compact rows, the switch itself, and the menu line need no guard.
    if (/^\s*\.(cv|compact-switch|menu \.menu-info)\b/.test(selector) || /\.compact-switch span\s*$/.test(selector)) continue;
    for (const part of selector.split(',')) assert.match(part, /body\.compact /, rule.trim());
  }
  assert.match(css, /body\.compact \.wrap \{ max-width: none; \}/, 'the full window width');
  assert.match(css, /body\.compact #rows \{ columns: 400px;/, 'as many columns of 400px or more as fit: two at the first-run width, one when narrow');
  assert.match(css, /body\.compact \.group-h \{ column-span: all; \}/, 'a category keeps its header, with its apps in columns under it');
  assert.match(html, /\.wrap \{ max-width: 900px; margin: 0 auto; \}/, 'the ordinary list does not fill the window');
});

test('"no checksum" can neither wrap (a taller row) nor run over the column beside it', () => {
  assert.match(html, /\.app-src \{ white-space: nowrap; \}/);
  assert.match(html, /\.app-src \.where \{ flex-shrink: 100; \}/, 'the host gives way first');
  assert.match(html, /\.sum-none \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
});

test('a compact line shows the versions, and says what is happening instead while it is', () => {
  const made = [];
  const el = (tag, cls, text) => { const n = { tag, cls, text: text || '', kids: [], title: '', append(...a) { this.kids.push(...a); } }; made.push(n); return n; };
  const ctx = { el, config: {}, $: () => ({ onchange: null, classList: { toggle() {} } }), document: { body: { classList: { toggle() {} } } } };
  vm.runInNewContext(block + '\nthis.api = { compactVersions };', ctx);
  const text = (n) => n.text + n.kids.map((k) => (typeof k === 'string' ? k : k.text)).join('');
  const { compactVersions } = ctx.api;
  assert.equal(text(compactVersions({ ph: 'available', from: '1.2.0', to: '1.3.0', present: true }, { cls: 'c-up', text: 'Update available' })), '1.2.0 → 1.3.0');
  assert.equal(text(compactVersions({ ph: 'current', from: '1.3.0', to: '1.3.0', present: true }, { cls: 'c-ok', text: 'Up to date' })), '1.3.0', 'no arrow when there is nothing newer');
  assert.equal(text(compactVersions({ ph: 'available', to: '2.0' }, { cls: 'c-up', text: 'Available to install' })), '2.0', 'not installed yet: just the version its Install button would install');
  assert.equal(text(compactVersions({ ph: 'idle' }, { cls: 'c-warn', text: 'Not installed' })), 'Not installed');
  assert.equal(text(compactVersions({ ph: 'idle', present: true }, { cls: 'c-muted', text: 'Not checked' })), 'Unknown');
  assert.equal(text(compactVersions({ ph: 'downloading', from: '1.2.0', to: '1.3.0' }, { cls: 'c-work', text: 'Downloading 40%' })), 'Downloading 40%');
  const failed = compactVersions({ ph: 'failed', reason: 'download failed', from: '1.2.0' }, { cls: 'c-bad', text: 'download failed' });
  assert.equal(text(failed), 'download failed');
  assert.match(failed.cls, /c-bad/);
});

test('what the compact line leaves out is in the tooltip and the menu: type, source, auto-update', () => {
  assert.match(block, /`Type: \$\{typeLabelOf\(r\)\}`, sourceLine\(r, key, s\)\.title/);
  const menu = html.slice(html.indexOf('function openMenu('), html.indexOf('// --- choose download ---'));
  assert.match(menu, /if \(compactOn\(\)\) \{\s*const src = sourceLine\(r, key, s\);\s*menuEl\.appendChild\(el\('div', 'menu-info'/);
  assert.match(menu, /if \(compactOn\(\)\) item\(r\.autoUpdate \? 'Turn auto-update off' : 'Turn auto-update on'/);
  assert.equal((menu.match(/compactOn\(\)/g) || []).length, 2, 'nothing else in the menu changes');
});
