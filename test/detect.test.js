'use strict';

// Name matching between a tracked repo and an installed-app inventory.
//
// Every "rejects" case below is a row from a real inventory, and the headline one is the
// bug this table was written for: dpkg's `ed` (GNU ed, 1.22.4-1) matched the needle
// "bedrock-panel" because "bedrockpanel" contains the letters e-d. installedVersion()
// reports the HIGHEST match, so Bedrock Panel read as installed at 1.22.4 — above every
// release it has — and the update was never offered. Windows and macOS were unaffected:
// their inventories are a few hundred human-facing names with nothing two letters long.
//
// The platform is passed to every call on purpose — see hostindependence.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { nameMatches } = require('../src/detect');

test('nameMatches: a human-facing name rarely spells the repo name', () => {
  // Windows uninstall registry DisplayNames.
  assert.ok(nameMatches('Brave', 'brave-browser', 'win32'));
  assert.ok(nameMatches('Notepad++', 'notepad-plus-plus', 'win32'));
  assert.ok(nameMatches('7-Zip 26.02 (x64 edition)', '7zip', 'win32'));
  assert.ok(nameMatches('Mozilla Firefox', 'firefox', 'win32'), 'a vendor prefix is a token, not noise');
  assert.ok(nameMatches('Git version 2.53.0', 'git', 'win32'));
  // macOS .app bundles.
  assert.ok(nameMatches('OBS Studio.app', 'obs-studio', 'darwin'));
  assert.ok(nameMatches('Claude.app', 'claude', 'darwin'));
});

test('nameMatches: a Linux package name matches itself, or carries a packaging suffix', () => {
  assert.ok(nameMatches('bedrock-panel', 'bedrock-panel', 'linux'));
  assert.ok(nameMatches('obs-studio', 'obs-studio', 'linux'));
  assert.ok(nameMatches('7zip', '7zip', 'linux'), 'the package is 7zip, not 7-Zip');
  assert.ok(nameMatches('joplin-desktop', 'joplin', 'linux'), 'a packaging suffix is its own token');
  assert.ok(nameMatches('OBS Studio', 'obs-studio', 'linux'), 'flatpak and snap report a human name');
});

test('nameMatches: a letter run that is not a token is not a match', () => {
  // The reported bug, exactly: GNU ed vs Bedrock Panel.
  assert.equal(nameMatches('ed', 'bedrock-panel', 'linux'), false);
  assert.equal(nameMatches('ed', 'bedrock-panel', 'win32'), false, 'and not on any other host either');
  // The same shape, from the same 2825-row inventory.
  assert.equal(nameMatches('bc', 'libbcrypt', 'linux'), false);
  assert.equal(nameMatches('at', 'catalina', 'linux'), false);
  assert.equal(nameMatches('iw', 'kiwix', 'linux'), false);
  // catalog.js documents this pair for its own regexes; detect had it too.
  assert.equal(nameMatches('libtesseract5', 'tesseract', 'linux'), false, 'a shared library is not the app');
});

test('nameMatches: on Linux only the NEEDLE may be the shorter side', () => {
  // A leading token is no proof of identity, and nothing lexical separates these two
  // pairs. The namespace does: upstream names the package, so the package is the full
  // name and the repo may be the abbreviation — never the other way round.
  assert.equal(nameMatches('git', 'git-updater', 'linux'), false, 'the git package is not git-updater');
  assert.equal(nameMatches('code', 'vscode-insiders', 'linux'), false);
  // The same shape on Windows stays open, because there the extra words are edition and
  // vendor noise that lands on whichever side the installer felt like.
  assert.ok(nameMatches('Brave', 'brave-browser', 'win32'));
  assert.ok(nameMatches('OBS Studio', 'obs-studio-portable', 'darwin'));
});

test('nameMatches: a token match must be CONTIGUOUS and cover the whole other name', () => {
  assert.ok(nameMatches('obs-studio-32.2.2', 'obs-studio', 'linux'), 'obs+studio is a run');
  assert.equal(nameMatches('obs-tools-studio', 'obs-studio', 'linux'), false, 'obs+studio is not a run here');
  assert.equal(nameMatches('brave-studio', 'obs-studio', 'linux'), false, 'a shared token is not a match');
});

test('nameMatches: two-letter names still match themselves', () => {
  // astral-sh/uv, nektos/act and friends are real tracked repos with tiny names.
  assert.ok(nameMatches('uv', 'uv', 'linux'));
  assert.ok(nameMatches('act', 'act', 'linux'));
  assert.equal(nameMatches('e', 'ed', 'linux'), false, 'one character never identifies an app');
});

test('nameMatches: survives empty and junk input', () => {
  assert.equal(nameMatches('', 'bedrock-panel', 'linux'), false);
  assert.equal(nameMatches(null, 'bedrock-panel', 'linux'), false);
  assert.equal(nameMatches('bedrock-panel', undefined, 'linux'), false);
  assert.equal(nameMatches('---', 'bedrock-panel', 'linux'), false);
});
