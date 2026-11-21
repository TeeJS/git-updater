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

// --- packaged (MSIX) apps: found by package identity only ------------------------------------

test('a packaged app matches only a needle that is its package identity', async () => {
  const detect = require('../src/detect');
  const platform = require('../src/platform');
  const real = platform.installedApps;
  platform.installedApps = async () => [
    { name: 'MicrosoftCorporationII.Windows365', version: '2.0.1601.0', flavor: 'msix', packaged: true },
    { name: 'Microsoft.WindowsTerminal', version: '1.23.12811.0', flavor: 'msix', packaged: true },
    { name: 'Windows Terminal Preview', version: '1.24.0', flavor: 'exe' },
  ];
  detect.clearCache();
  try {
    assert.equal(await detect.installedVersion('MicrosoftCorporationII.Windows365'), '2.0.1601.0');
    assert.equal(await detect.installedVersion('microsoftcorporationii.windows365'), '2.0.1601.0', 'case does not matter');
    assert.equal(await detect.installedFlavor('MicrosoftCorporationII.Windows365'), 'msix');
    // Never loosely: these needles would token-match the identity if it were a display name.
    assert.equal(await detect.installedVersion('Windows365'), null);
    assert.equal(await detect.installedVersion('Windows App'), null);
    // "terminal" still finds the ordinary registry row, and only that one.
    assert.equal(await detect.installedVersion('terminal'), '1.24.0', 'not the packaged 1.23 beside it');
    assert.equal(await detect.installedVersion('Microsoft.WindowsTerminal'), '1.23.12811.0');
  } finally {
    platform.installedApps = real;
    detect.clearCache();
  }
});

// --- one known app is never read as another ---------------------------------------------------
//
// Found on a real Mac: the entry anthropics/claude-code showed "Current 6.28899.2, Available
// 2.1.330". 6.28899.2 is the Claude DESKTOP app. Its installed name, "Claude", is one word of
// "claude-code", which the loose rule accepts — it has to, for Brave and brave-browser.

test('sameApp: an installed name that is a different known app is not a match', () => {
  const { sameApp } = require('../src/detect');
  assert.ok(nameMatches('Claude', 'claude-code', 'darwin'), 'the lexical rule alone still says yes');
  assert.equal(sameApp('Claude', 'claude-code', 'darwin'), false, 'Claude is the desktop app, not Claude Code');
  assert.equal(sameApp('Claude.app', 'Claude Code', 'darwin'), false);
  assert.equal(sameApp('Claude Code', 'Claude', 'win32'), false, 'and not the other way round');
  assert.equal(sameApp('XnView MP', 'XnView', 'win32'), false);
  // Each app still matches itself, by any of its own names.
  assert.ok(sameApp('Claude', 'Claude', 'darwin'));
  assert.ok(sameApp('Claude.app', 'claude', 'darwin'));
  assert.ok(sameApp('Claude Code', 'claude-code', 'win32'));
  assert.ok(sameApp('Brave', 'brave-browser', 'win32'), 'the repository is one of Brave\'s own names');
  assert.ok(sameApp('Obsidian', 'obsidian-releases', 'darwin'));
  assert.ok(sameApp('Mozilla Firefox', 'firefox', 'win32'));
});

test('sameApp: an entry the list has never heard of keeps the loose match', () => {
  const { sameApp } = require('../src/detect');
  assert.ok(sameApp('OBS Studio', 'obs-studio-portable', 'darwin'), 'nothing says this is not OBS Studio');
  assert.ok(sameApp('Python 3.14.2 (64-bit)', 'Python 3.14', 'win32'), 'a release-line row owns no bare name');
});

test('sameApp: a helper that carries the app\'s name is not the app', () => {
  const { sameApp } = require('../src/detect');
  assert.equal(sameApp('Claude Code URL Handler', 'claude-code', 'darwin'), false);
  assert.equal(sameApp('Microsoft Edge Update', 'edge', 'win32'), false);
  assert.equal(sameApp('git-updater', 'git', 'darwin'), false, 'git-updater is not Git');
  assert.equal(sameApp('Git', 'git-updater', 'darwin'), false, 'and Git is not git-updater');
  // The word is fine when both names say it.
  assert.ok(sameApp('git-updater', 'git-updater', 'darwin'));
  assert.ok(sameApp('Revo Uninstaller Pro', 'Revo Uninstaller', 'win32'));
});

test('installedVersion: the Claude desktop app is not the installed version of Claude Code', async () => {
  const detect = require('../src/detect');
  const platform = require('../src/platform');
  const real = platform.installedApps;
  platform.installedApps = async () => [
    { name: 'Claude', version: '6.28899.2', flavor: 'app', path: '/Applications/Claude.app' },
    { name: 'Claude Code URL Handler', version: '1.0', flavor: 'app' },
  ];
  detect.clearCache();
  try {
    assert.equal(await detect.installedVersion('claude-code'), null, 'neither row is Claude Code');
    assert.equal(await detect.installedVersion('Claude'), '6.28899.2');
    assert.equal(await detect.launchTarget('claude-code'), null, 'so Open App cannot open the wrong one either');
  } finally {
    platform.installedApps = real;
    detect.clearCache();
  }
});

test('procMatches: closing one app never closes a different known app', () => {
  const { procMatches } = require('../src/detect');
  assert.equal(procMatches('Claude', 'claude-code'), false, 'the desktop app keeps running');
  assert.ok(procMatches('Claude', 'Claude'));
  assert.ok(procMatches('Claude Helper', 'Claude'), 'its helper processes are still part of it');
  assert.ok(procMatches('obs', 'obs-studio'));
});
