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

// Reported on Notepad++: the row said "Not installed" with Notepad++ installed, offered Install,
// and Windows refused the repeat install with exit 1625. Both names are that PC's own rows.
test('nameMatches: a bracketed note on an installed name is not part of the name', () => {
  assert.ok(nameMatches('Notepad++ (x64)', 'notepad-plus-plus', 'win32'), 'the MSI install');
  assert.ok(nameMatches('Notepad++ (64-bit x64)', 'notepad-plus-plus', 'win32'), 'the EXE install');
  assert.ok(nameMatches('Notepad++', 'notepad-plus-plus', 'win32'), 'as it always did without the note');
  assert.ok(nameMatches('Brave (Nightly) (x64)', 'brave-browser', 'win32'), 'however many notes');
  // A name that already matched as written is not touched by this.
  assert.ok(nameMatches('7-Zip 26.02 (x64 edition)', '7zip', 'win32'));
  assert.ok(nameMatches('PowerToys (Preview) x64', 'PowerToys', 'win32'));
  // Removing a note never makes a different app match, and what is left must still be a name.
  assert.equal(nameMatches('Some Viewer (Notepad++ plugin)', 'notepad-plus-plus', 'win32'), false);
  assert.equal(nameMatches('Paint (x64)', 'notepad-plus-plus', 'win32'), false);
  assert.equal(nameMatches('N (x64)', 'notepad-plus-plus', 'win32'), false, 'one character never identifies an app');
  // The other rules still apply to what is left: tokens, and on Linux the direction.
  assert.equal(nameMatches('ed (GNU)', 'bedrock-panel', 'linux'), false);
  assert.equal(nameMatches('git (snap)', 'git-updater', 'linux'), false);
  assert.ok(nameMatches('joplin (snap)', 'joplin', 'linux'));
});

test('sameApp: a helper is still judged by its whole name, brackets included', () => {
  const { sameApp } = require('../src/detect');
  assert.ok(sameApp('Notepad++ (x64)', 'notepad-plus-plus', 'win32'));
  assert.equal(sameApp('Brave (Updater)', 'brave-browser', 'win32'), false, 'the note says it is not the app');
  assert.equal(sameApp('Claude (URL Handler)', 'claude-code', 'win32'), false);
});

test('installedVersion: Notepad++ is found, and its newest install decides the installer type', { skip: process.platform === 'linux' && 'a Windows inventory name: on Linux names are matched one way only, by design (see nameMatches)' }, async () => {
  const detect = require('../src/detect');
  const platform = require('../src/platform');
  const real = platform.installedApps;
  platform.installedApps = async () => [
    { name: 'Notepad++ (64-bit x64)', version: '8.9.8', flavor: 'exe', path: 'C:\\Program Files\\Notepad++\\notepad++.exe' },
    { name: 'Notepad++ (x64)', version: '8.9.9.1', flavor: 'msi' },
  ];
  detect.clearCache();
  try {
    assert.equal(await detect.installedVersion('notepad-plus-plus'), '8.9.9.1', 'not "Not installed"');
    assert.equal(await detect.installedFlavor('notepad-plus-plus'), 'msi', 'so an update does not land a third copy beside these');
  } finally {
    platform.installedApps = real;
    detect.clearCache();
  }
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
  // One word of the app's name is no longer enough (test/detect-processes.test.js): `obs` is
  // OBS Studio's process only when the system records it as the app's main program.
  assert.equal(procMatches('obs', 'obs-studio'), false);
  assert.ok(procMatches('obs', 'obs-studio', ['obs']));
});

// music-assistant/desktop-app installs as "Music Assistant": its OWNER's name. Nothing on the
// PC is called "desktop-app", so the row read "Not installed" until a check filled in the
// version git-updater had recorded, and its button still said Install.
test('lookupNames: an app installed under its owner\'s name is found, on every platform', async () => {
  const detect = require('../src/detect');
  const platform = require('../src/platform');
  const core = require('../src/core');
  const real = platform.installedApps;
  const entry = { owner: 'music-assistant', repo: 'desktop-app', type: 'installer' };
  const inventories = {
    win32: [{ name: 'Music Assistant', version: '0.7.4', flavor: 'exe', location: 'C:/Users/u/AppData/Local/Music Assistant' }],
    darwin: [{ name: 'Music Assistant', version: '0.7.4', flavor: 'app', path: '/Applications/Music Assistant.app' }],
    linux: [{ name: 'music-assistant', version: '0.7.4', flavor: 'deb' }],
  };
  try {
    for (const [plat, rows] of Object.entries(inventories)) {
      platform.installedApps = async () => rows;
      detect.clearCache();
      assert.equal(await detect.installedVersion(...core.lookupNames(entry)), '0.7.4', `${plat}: found by its owner's name`);
      assert.equal(await detect.installedFlavor(...core.lookupNames(entry)), rows[0].flavor, `${plat}: and its install type with it`);
    }
  } finally {
    platform.installedApps = real;
    detect.clearCache();
  }
});

test('lookupNames: the owner is tried only when the name finds nothing, and only exactly', async () => {
  const detect = require('../src/detect');
  const platform = require('../src/platform');
  const core = require('../src/core');
  const real = platform.installedApps;
  platform.installedApps = async () => [
    { name: 'Google Chrome', version: '158.0.8127.88', flavor: 'msi' },
    { name: 'Microsoft Edge', version: '158.0.4370.33', flavor: 'msi' },
    { name: 'OBS Studio', version: '32.1.2', flavor: 'exe' },
    { name: 'Obsproject Tools', version: '9.9.9', flavor: 'exe' },
  ];
  detect.clearCache();
  try {
    // Loosely, "google" is Google Chrome. An app google publishes that is not installed stays not installed.
    assert.equal(await detect.installedVersion(...core.lookupNames({ owner: 'google', repo: 'not-installed', type: 'installer' })), null);
    assert.equal(await detect.installedVersion(...core.lookupNames({ owner: 'microsoft', repo: 'not-installed', type: 'installer' })), null);
    // The name finds the app, so the owner is never asked.
    assert.equal(await detect.installedVersion(...core.lookupNames({ owner: 'obsproject', repo: 'obs-studio', type: 'installer' })), '32.1.2');
  } finally {
    platform.installedApps = real;
    detect.clearCache();
  }
});

test('lookupNames: no alias for an entry that says what to look for, or one from another source', () => {
  const core = require('../src/core');
  assert.deepEqual(core.lookupNames({ owner: 'music-assistant', repo: 'desktop-app' }), ['desktop-app', 'music-assistant']);
  assert.deepEqual(core.lookupNames({ owner: 'microsoft', repo: 'vscode', detect: 'Microsoft Visual Studio Code' }), ['Microsoft Visual Studio Code', null]);
  assert.deepEqual(core.lookupNames({ owner: 'source.winget', repo: 'obsidian.obsidian', source: 'winget', name: 'Obsidian' }), ['Obsidian', null]);
});
