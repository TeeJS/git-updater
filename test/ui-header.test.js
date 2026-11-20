'use strict';

// The main screen's header shows the running version to the right of the name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
