'use strict';

// The favorites file: a person's own apps and packs, hand-written. Nearly all of this file is
// about what a hand-written file gets wrong, because every mistake has to end in a sentence
// the person can act on — never a crash, and never a silently missing app.

const { test } = require('node:test');
const assert = require('node:assert');

const favorites = require('../src/favorites');
const catalog = require('../src/catalog');
const packs = require('../src/packs');
const sources = require('../src/sources');

const read = (text) => favorites.parse(text, { find: catalog.findBuiltin });

test('an empty, missing or comments-only file is simply no favorites', () => {
  for (const text of ['', '   \n', '# just a comment\n', undefined, null]) {
    assert.deepEqual(read(text), { apps: [], pins: [], notes: {}, packs: [], problems: [] });
  }
});

test('the starter file changes nothing until it is edited, and its examples are valid once uncommented', () => {
  assert.deepEqual(read(favorites.STARTER), { apps: [], pins: [], notes: {}, packs: [], problems: [] });
  // Uncomment every example line (the ones indented under apps: / packs:).
  const live = favorites.STARTER.replace(/^ {2}# (-| {2})/gm, '  $1');
  const f = read(live);
  assert.deepEqual(f.problems, [], 'every example in the starter is something the reader accepts');
  assert.deepEqual(f.pins, ['vlcmediaplayer', '7zip']);
  assert.deepEqual(f.notes, { '7zip': 'Opens every archive anyone sends me' });
  assert.deepEqual(f.apps.map((a) => a.name), ['fd', 'My Tool']);
  assert.equal(f.apps[1].description, 'What it is for');
  const tool = f.apps[1];
  assert.deepEqual(
    { category: tool.category, repo: tool.repo, winget: tool.winget, brew: tool.brew, site: tool.site, platforms: tool.platforms, type: tool.type },
    { category: 'My tools', repo: 'someone/my-tool', winget: 'Vendor.MyTool', brew: 'my-tool', site: 'https://example.org/downloads/my-tool/', platforms: ['win32', 'darwin', 'linux'], type: 'installer' },
  );
  assert.equal(f.packs.length, 1);
  assert.deepEqual(f.packs[0].apps.map((r) => r.id || `${r.source.owner}/${r.source.repo}`), ['vlcmediaplayer', '7zip', 'favmytool', 'favfd']);
});

test('apps: a known name pins it, an owner/repo adds it, a mapping spells it out', () => {
  const f = read(`
apps:
  - vlc
  - 7-Zip
  - someone/cool-tool
  - https://github.com/Other/Thing.git
  - name: Bedrock Panel
    repo: TeeJS/bedrock-panel
    category: My tools
    aliases: [bedrock, panel]
  - name: Brew Only
    brew: brew-only
`);
  assert.deepEqual(f.problems, []);
  assert.deepEqual(f.pins, ['vlcmediaplayer', '7zip'], 'an alias and a display name both find the built-in app');
  // A built-in app can be named by its repository as well: it is that app, so it is pinned.
  assert.deepEqual(read('apps:\n  - storytold/photocraft\n  - https://github.com/obsproject/obs-studio\n'), { apps: [], pins: ['photocraft', 'obsstudio'], notes: {}, packs: [], problems: [] });
  assert.deepEqual(f.apps.map((a) => [a.id, a.name, a.category, a.repo || a.brew]), [
    ['favcooltool', 'cool-tool', 'My favorites', 'someone/cool-tool'],
    ['favthing', 'Thing', 'My favorites', 'Other/Thing'],
    ['favbedrockpanel', 'Bedrock Panel', 'My tools', 'TeeJS/bedrock-panel'],
    ['favbrewonly', 'Brew Only', 'My favorites', 'brew-only'],
  ]);
  assert.deepEqual(f.apps[2].aliases, ['bedrock', 'panel']);
});

test('JSON works too: it is valid YAML', () => {
  const f = read(JSON.stringify({ apps: ['vlc', { name: 'My Tool', winget: 'Vendor.MyTool' }], packs: [{ name: 'P', apps: ['vlc', 'My Tool'] }] }));
  assert.deepEqual(f.problems, []);
  assert.deepEqual(f.pins, ['vlcmediaplayer']);
  assert.equal(f.apps[0].winget, 'Vendor.MyTool');
  assert.deepEqual(f.packs[0].apps, [{ id: 'vlcmediaplayer' }, { id: 'favmytool' }]);
});

test('every mistake is skipped with a sentence that says which entry and what to do', () => {
  const f = read(`
apps:
  - Not A Real App
  - name: No Source
  - name: Bad Ids
    winget: nodots
    brew: Has Spaces
    repo: not a repo
  - name: Half Good
    winget: not valid
    brew: half-good
  - name: Typo Field
    repo: a/b
    wingt: Vendor.Tool
  - name: Twice
    repo: a/twice
  - name: twice
    repo: a/twice-again
  - name: Mozilla Firefox
    repo: mozilla/firefox
  - name: Bad Site
    site: http://example.org/files/
  - name: Bad Extras
    repo: a/extras
    platforms: [windows, amiga]
    type: msi
  - [a, list]
other: 1
`);
  const has = (re) => assert.ok(f.problems.some((p) => re.test(p)), `${re} in:\n  ${f.problems.join('\n  ')}`);
  has(/^app 1 \("Not A Real App"\): is not an app in Popular apps and not a GitHub owner\/repo/);
  has(/^app 2 \("No Source"\): needs a source — add repo, winget, brew or site$/);
  has(/^app 3 \("Bad Ids"\): winget "nodots" is not a WinGet package id/);
  has(/^app 3 \("Bad Ids"\): brew "Has Spaces" is not a Homebrew cask name/);
  has(/^app 3 \("Bad Ids"\): repo "not a repo" is not a GitHub owner\/repo$/);
  has(/^app 3 \("Bad Ids"\): needs a source/);
  has(/^app 4 \("Half Good"\): winget "not valid"/);
  has(/^app 5 \("Typo Field"\): "wingt:" is not an app field and was ignored$/);
  has(/^app 7 \("twice"\): is listed twice/);
  has(/^app 8 \("Mozilla Firefox"\): is already in Popular apps as "Mozilla Firefox", so it was pinned/);
  has(/^app 9 \("Bad Site"\): site must be an https:\/\/ address/);
  has(/^app 10 \("Bad Extras"\): platforms can list windows, mac and linux/);
  has(/^app 10 \("Bad Extras"\): type can be installer or portable/);
  has(/^app 11: is not an app/);
  has(/"other:" is not something this file can hold/);

  // What survives: one bad field costs that source or that option, not the app.
  assert.deepEqual(f.apps.map((a) => a.name), ['Half Good', 'Typo Field', 'Twice', 'Bad Extras']);
  assert.deepEqual([f.apps[0].winget, f.apps[0].brew], [undefined, 'half-good']);
  assert.deepEqual([f.apps[3].platforms, f.apps[3].type], [undefined, undefined]);
  assert.deepEqual(f.pins, ['mozillafirefox']);
});

test('a YAML mistake is reported with its line, and nothing half-read is used', () => {
  const f = read('apps:\n  - name: Good\n    repo: a/b\n  - name: "unclosed\n');
  assert.deepEqual([f.apps, f.pins, f.packs], [[], [], []]);
  assert.equal(f.problems.length, 1);
  assert.match(f.problems[0], /^favorites\.yaml could not be read — line \d+: /);
  // The wrong shape altogether.
  assert.match(read('- vlc\n- 7-zip\n').problems[0], /must start with "apps:" and\/or "packs:"/);
  assert.match(read('apps: vlc\n').problems[0], /^apps: must be a list/);
  assert.match(read(`apps:\n${'  - a/b\n'.repeat(3)}# ${'x'.repeat(300 * 1024)}\n`).problems[0], /too large to read/);
});

test('a row can name an app and where it comes from, and nothing else', () => {
  const f = read(`
apps:
  - name: Sneaky
    repo: a/sneaky
    install: { args: ["/S", "/D=C:\\\\Windows"] }
    asset: "*.exe"
    url: https://evil.example/payload.exe
    command: calc.exe
`);
  assert.deepEqual(Object.keys(f.apps[0]).sort(), ['aliases', 'category', 'id', 'name', 'repo']);
  assert.equal(f.problems.length, 4, 'and each ignored field is named');
  // No YAML trickery either: a tagged value is not a function, a date is not a Date.
  const odd = read('apps:\n  - name: !!js/function "function(){}"\n    repo: a/b\n');
  assert.equal(odd.apps.length, 0);
  assert.match(odd.problems[0], /could not be read/);
});

test('packs: apps are named the way a person names them', () => {
  const f = read(`
apps:
  - name: My Tool
    aliases: [mt]
    repo: me/my-tool
packs:
  - name: Work laptop
    description: Every work machine
    apps: [VLC, 7-zip, My Tool, mt, someone/else, vlc, Not An App, 12345]
  - name: Work laptop
    apps: [vlc]
  - name: Empty
    apps: [Nothing Real]
  - apps: [vlc]
  - name: No Apps
  - name: Extra
    apps: [vlc]
    auto: true
`);
  assert.deepEqual(f.packs.map((p) => p.name), ['Work laptop', 'Extra']);
  assert.deepEqual(f.packs[0], {
    name: 'Work laptop',
    description: 'Every work machine',
    // A repeat (vlc twice, My Tool by name and by alias) appears once.
    apps: [{ id: 'vlcmediaplayer' }, { id: '7zip' }, { id: 'favmytool' }, { name: 'else', source: { type: 'github', owner: 'someone', repo: 'else' } }],
  });
  const has = (re) => assert.ok(f.problems.some((p) => re.test(p)), `${re} in:\n  ${f.problems.join('\n  ')}`);
  has(/^pack 1 \("Work laptop"\): "Not An App" is not an app in Popular apps or in this file, and not an owner\/repo/);
  has(/^pack 1 \("Work laptop"\): "12345" is not an app/);
  has(/^pack 2 \("Work laptop"\): has the same name as an earlier pack/);
  has(/^pack 3 \("Empty"\): lists no app that could be read/);
  has(/^pack 4: has no "name:"/);
  has(/^pack 5 \("No Apps"\): needs an "apps:" list/);
  has(/^pack 6 \("Extra"\): "auto:" is not a pack field and was ignored/);
});

// --- into the catalog ------------------------------------------------------------------

test('favorites join the picker and name lookup; built-in apps and their ids are untouched', () => {
  const before = catalog.apps().map((a) => a.id);
  const f = read(`
apps:
  - vlc
  - name: My Tool
    category: My tools
    repo: me/my-tool
    winget: Vendor.MyTool
    brew: my-tool
    site: https://example.org/dl/my-tool/
  - name: Mac Only
    repo: me/mac-only
    platforms: mac
  - name: Installer Only
    repo: me/installer-only
    type: installer
`);
  catalog.setFavorites(f);
  try {
    assert.deepEqual(catalog.apps().slice(0, before.length).map((a) => a.id), before, 'the built-in list comes first, unchanged');
    assert.deepEqual(catalog.favoritePins(), ['vlcmediaplayer']);

    const tool = catalog.appById('favmytool');
    assert.equal(tool.favorite, true);
    assert.deepEqual(catalog.sourcesFor(tool, 'win32').map((s) => s.type), ['github', 'winget', 'folder']);
    assert.deepEqual(catalog.sourcesFor(tool, 'darwin').map((s) => s.type), ['github', 'brew', 'folder']);
    assert.deepEqual(catalog.sourcesFor(tool, 'linux').map((s) => s.type), ['github', 'folder']);
    // Every source it names is one the app's own gate accepts as an identity.
    for (const s of catalog.sourcesFor(tool, 'win32')) assert.doesNotThrow(() => sources.cleanSource(s), s.type);

    assert.equal(catalog.popular('darwin').find((a) => a.id === 'favmytool').category, 'My tools');
    assert.ok(catalog.popular('darwin').some((a) => a.id === 'favmaconly'));
    assert.ok(!catalog.popular('win32').some((a) => a.id === 'favmaconly'), 'platforms limits the whole app');
    assert.deepEqual(catalog.lookup('mac only', 'win32'), []);
    assert.equal(catalog.appById('favinstalleronly').only, 'installer');

    // Typed into the Add box, a favorite is found by name like any built-in app.
    const hit = catalog.lookup('My Tool', 'linux')[0];
    assert.deepEqual([hit.name, hit.exact, hit.source.type], ['My Tool', true, 'github']);
  } finally {
    catalog.setFavorites(null);
  }
  assert.deepEqual(catalog.apps().map((a) => a.id), before, 'and they are gone again when the file is');
  assert.deepEqual(catalog.favoritePins(), []);
});

test('a favorite can never replace or shadow a built-in app', () => {
  // The reader already turns a same-named row into a pin; the catalog refuses a clashing id too.
  catalog.setFavorites({ apps: [{ id: 'vlcmediaplayer', name: 'VLC media player', category: 'My favorites', aliases: [], repo: 'evil/vlc' }], pins: ['nosuchapp'] });
  try {
    const vlc = catalog.appById('vlcmediaplayer');
    assert.notEqual(vlc.repo, 'evil/vlc');
    assert.equal(vlc.favorite, undefined);
    assert.deepEqual(catalog.favoritePins(), [], 'a pin for an app that does not exist is dropped');
  } finally {
    catalog.setFavorites(null);
  }
});

test('packs from the file pass the same gate as an imported pack and resolve per platform', () => {
  const f = read(`
apps:
  - name: My Tool
    repo: me/my-tool
    brew: my-tool
packs:
  - name: Work laptop
    apps: [vlc, My Tool, someone/else]
`);
  catalog.setFavorites(f);
  try {
    const pack = packs.validatePack({ format: packs.FORMAT, version: 1, ...f.packs[0] }, { cleanSource: (s) => sources.cleanSource(s), id: 'favorites-work-laptop' });
    assert.equal(pack.dropped, undefined);
    const rows = packs.resolveRefs(pack, 'darwin', ['brew'], ['github', 'brew', 'winget', 'folder']);
    assert.deepEqual(rows.map((r) => [r.name, r.sources.map((s) => s.type)]), [
      ['VLC media player', ['brew']],
      ['My Tool', ['brew', 'github']],
      ['else', ['github']],
    ]);
    // A pack saved from the apps on this machine never stores a favorite by id: another
    // machine may not have this file.
    const entry = { owner: 'me', repo: 'my-tool', type: 'portable' };
    const saved = packs.fromEntries('Saved', '', [entry], sources.sourceOf, (s) => `${s.type}:${sources.provider(s.type).canonicalRef(s)}`);
    assert.deepEqual(saved.apps, [{ name: 'my-tool', source: { type: 'github', owner: 'me', repo: 'my-tool' } }]);
  } finally {
    catalog.setFavorites(null);
  }
});

test('Copy as favorite: the line to paste, for every source the file can name', () => {
  assert.equal(favorites.rowFor({ owner: 'x', repo: 'y', type: 'portable' }, { name: 'VLC media player' }), '  - VLC media player\n');
  assert.equal(favorites.rowFor({ owner: 'TeeJS', repo: 'bedrock-panel', type: 'portable' }), '  - TeeJS/bedrock-panel\n');
  assert.equal(favorites.rowFor({ name: 'Blender', owner: 'k', repo: 'k', source: { type: 'brew', token: 'blender' } }), '  - name: Blender\n    brew: blender\n');
  assert.equal(favorites.rowFor({ name: 'Some: Tool #1', owner: 'k', repo: 'k', source: { type: 'winget', packageId: 'Vendor.SomeTool' } }), '  - name: "Some: Tool #1"\n    winget: Vendor.SomeTool\n');
  assert.equal(favorites.rowFor({ name: 'Wireshark', owner: 'k', repo: 'k', source: { type: 'folder', url: 'https://www.wireshark.org/download/win64/' } }), '  - name: Wireshark\n    site: "https://www.wireshark.org/download/win64/"\n');
  assert.equal(favorites.rowFor({ name: 'Runner', owner: 'k', repo: 'k', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' } }), null, 'a source it cannot name is refused, not guessed');

  // What it writes, it can read back.
  const text = `apps:\n${[
    favorites.rowFor({ owner: 'TeeJS', repo: 'bedrock-panel' }),
    favorites.rowFor({ name: 'Some: Tool #1', owner: 'k', repo: 'k', source: { type: 'winget', packageId: 'Vendor.SomeTool' } }),
    favorites.rowFor({ name: 'Wireshark 2', owner: 'k', repo: 'k', source: { type: 'folder', url: 'https://www.wireshark.org/download/win64/' } }),
    favorites.rowFor({ name: 'true', owner: 'k', repo: 'k', source: { type: 'brew', token: 'true-app' } }),
  ].join('')}`;
  const f = read(text);
  assert.deepEqual(f.problems, []);
  assert.deepEqual(f.apps.map((a) => [a.name, a.repo || a.winget || a.site || a.brew]), [
    ['bedrock-panel', 'TeeJS/bedrock-panel'], ['Some: Tool #1', 'Vendor.SomeTool'], ['Wireshark 2', 'https://www.wireshark.org/download/win64/'], ['true', 'true-app'],
  ]);
});

// --- a one-line description, shown when the app is hovered over --------------------------

test('description: one line of at most 100 characters, for a new app or a pinned one', () => {
  const long = 'A very long description that goes on well past the limit, because the person kept typing after the point was made.';
  const f = read(`
apps:
  - name: My Tool
    repo: me/my-tool
    description: Syncs my notes between machines
  - name: 7-Zip
    description: Opens every archive anyone sends me
  - name: Long
    repo: me/long
    description: ${long}
  - name: Two Lines
    repo: me/two-lines
    description: |
      first line
      second line
  - name: Wrong Type
    repo: me/wrong-type
    description: [a, list]
  - name: None
    repo: me/none
`);
  const by = Object.fromEntries(f.apps.map((a) => [a.name, a.description]));
  assert.equal(by['My Tool'], 'Syncs my notes between machines');
  assert.equal(by.None, undefined, 'left out, there is simply no description');
  assert.equal(by['Two Lines'], 'first line second line', 'always one line');
  assert.equal(by['Wrong Type'], undefined);
  // Too long: shortened to the limit and said so, not dropped.
  assert.ok(by.Long.length <= favorites.MAX_DESCRIPTION && by.Long.length >= favorites.MAX_DESCRIPTION - 1, `length ${by.Long.length}`);
  assert.equal(favorites.MAX_DESCRIPTION, 100);
  assert.ok(by.Long.endsWith('…') && long.startsWith(by.Long.slice(0, -1).trimEnd()));
  // A built-in app can be pinned with the user's own description of it.
  assert.deepEqual(f.pins, ['7zip']);
  assert.deepEqual(f.notes, { '7zip': 'Opens every archive anyone sends me' });
  assert.deepEqual(f.problems, [
    'app 3 ("Long"): description is longer than 100 characters and was shortened',
    'app 5 ("Wrong Type"): description must be one line of text — it was ignored',
  ]);

  catalog.setFavorites(f);
  try {
    assert.equal(catalog.appById('favmytool').description, 'Syncs my notes between machines');
    assert.equal(catalog.favoriteNote('7zip'), 'Opens every archive anyone sends me');
    assert.equal(catalog.favoriteNote('vlcmediaplayer'), undefined);
    assert.match(catalog.appById('7zip').description, /^Open-source file archiver/, 'the built-in row itself is not changed');
  } finally {
    catalog.setFavorites(null);
  }
  assert.equal(catalog.favoriteNote('7zip'), undefined);
});
