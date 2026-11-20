'use strict';

// Settings -> GitHub -> "Create token" opens GitHub's new-token page with the form filled in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const github = require('../src/github');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('the link is the fine-grained new-token page, pre-filled, with no permissions asked for', () => {
  const u = new URL(github.TOKEN_CREATE_URL);
  assert.equal(u.origin + u.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['description', 'expires_in', 'name'], 'only the three documented fill-in parameters');
  assert.equal(u.searchParams.get('name'), 'git-updater');
  assert.equal(u.searchParams.get('expires_in'), 'none');
  assert.ok(u.searchParams.get('name').length <= 40, 'GitHub allows 40 characters for the name');
  assert.ok(u.searchParams.get('description').length <= 1024);
});

test('the main process builds the URL; the window only asks to open it', () => {
  const main = read('electron', 'main.js');
  const preload = read('electron', 'preload.js');
  const html = read('ui', 'index.html');
  assert.match(main, /ipcMain\.handle\('token:openCreate', \(\) => shell\.openExternal\(github\.TOKEN_CREATE_URL\)\)/);
  assert.match(preload, /tokenOpenCreate: \(\) => ipcRenderer\.invoke\('token:openCreate'\)/, 'no argument: the window never passes a URL');
  assert.match(html, /\$\('createToken'\)\.onclick = \(\) => window\.api\.tokenOpenCreate\(\)/);
});

test('the button sits in the GitHub token row and the hint explains the one step', () => {
  const html = read('ui', 'index.html');
  const row = html.slice(html.indexOf('id="ghToken"'), html.indexOf('id="tokenHint"'));
  assert.match(row, /id="createToken"/, 'next to the token box');
  assert.match(html, /<b>Create token<\/b> opens GitHub with the form filled in: leave every permission off/);
});
