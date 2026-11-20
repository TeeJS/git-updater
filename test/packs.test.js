'use strict';

// Packs and the curated shortcut list. A pack file is untrusted input, so most of this
// file is about what validatePack refuses to carry.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packs = require('../src/packs');
const catalog = require('../src/catalog');

const sources = require('../src/sources');

const TYPES = ['github', 'gitlab', 'gitea', 'winget', 'brew'];
// The same gate the app uses: a source is reduced to its provider's identity fields.
const OPTS = { cleanSource: (src) => sources.cleanSource(src) };
const good = (over = {}) => ({ format: 'git-updater-pack', version: 1, name: 'Work laptop', description: 'd', apps: [{ id: 'vlcmediaplayer' }], ...over });

// --- the shortcut list ---------------------------------------------------------------

test('shortcuts: every row is well-formed and names at least one source', () => {
  const ids = new Set();
  for (const s of catalog.SHORTCUTS) {
    assert.ok(typeof s.name === 'string' && s.name.trim(), JSON.stringify(s));
    assert.ok(typeof s.category === 'string' && s.category.trim(), s.name);
    assert.ok(s.winget || s.brew || s.repo, `${s.name} has a source`);
    if (s.winget) assert.match(s.winget, /^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)+$/, `${s.name} winget id`);
    if (s.brew) assert.match(s.brew, /^[a-z0-9][a-z0-9+@._-]*$/, `${s.name} brew token`);
    if (s.repo) assert.match(s.repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, `${s.name} repo`);
    for (const a of s.aliases || []) assert.ok(typeof a === 'string' && a.trim());
    const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    assert.ok(!ids.has(id), `duplicate shortcut ${s.name}`);
    ids.add(id);
  }
  assert.ok(catalog.SHORTCUTS.length >= 60);
});

test('shortcuts: sources are offered per platform, first-party first', () => {
  const hb = catalog.appById('handbrake');
  assert.deepEqual(catalog.sourcesFor(hb, 'win32').map((s) => s.type), ['github', 'winget']);
  assert.deepEqual(catalog.sourcesFor(hb, 'darwin').map((s) => s.type), ['github', 'brew']);
  assert.deepEqual(catalog.sourcesFor(hb, 'linux').map((s) => s.type), ['github']);
  // A preference reorders; an unavailable preferred type falls back to the default order.
  assert.equal(catalog.preferredSource(hb, 'win32', ['winget']).type, 'winget');
  assert.equal(catalog.preferredSource(hb, 'win32', ['brew']).type, 'github');
  assert.equal(catalog.preferredSource(hb, 'linux', ['winget', 'brew']).type, 'github');
  // A Windows-only GitHub project is not offered from GitHub elsewhere.
  assert.deepEqual(catalog.sourcesFor(catalog.appById('notepad'), 'darwin'), []);
  // No source on this OS -> not in the picker at all.
  assert.ok(!catalog.popular('linux').some((a) => a.id === 'googlechrome'));
  assert.ok(catalog.popular('win32').some((a) => a.id === 'googlechrome'));
});

test('lookup: the names people type reach the right identity', () => {
  const first = (q, plat) => catalog.lookup(q, plat)[0];
  assert.deepEqual(first('vs code', 'darwin').source, { type: 'brew', token: 'visual-studio-code' });
  assert.deepEqual(first('VLC', 'win32').source, { type: 'winget', packageId: 'VideoLAN.VLC' });
  assert.deepEqual(first('acrobat reader', 'win32').source, { type: 'winget', packageId: 'Adobe.Acrobat.Reader.64-bit' });
  assert.deepEqual(first('Paint.NET', 'win32').source, { type: 'github', owner: 'paintdotnet', repo: 'release' });
  assert.equal(first('libre office', 'darwin').exact, true);
  // Partial names are offered but never "exact", so they are never added unprompted.
  assert.ok(catalog.lookup('libre', 'darwin').every((c) => c.exact === false));
  assert.deepEqual(catalog.lookup('ab', 'win32'), [], 'two letters match nothing');
  assert.ok(catalog.lookup('vlc', 'win32').every((c) => c.curated));
});

test('built-in packs refer only to shortcuts that exist', () => {
  for (const b of packs.BUILTIN) {
    assert.ok(b.name && b.description && b.apps.length, b.id);
    for (const id of b.apps) assert.ok(catalog.appById(id), `${b.id}: unknown shortcut "${id}"`);
  }
  assert.ok(packs.builtin().every((p) => p.builtin && p.apps.every((a) => a.id)));
});

// --- validation: a pack names apps and nothing else ------------------------------------

test('validatePack: keeps only recognised fields', () => {
  const p = packs.validatePack(good({
    apps: [
      { id: 'vlcmediaplayer', install: { args: ['/evil'] }, type: 'installer' },
      { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner', nested: { x: 1 }, list: [1], 'bad key': 'x', asset: '*.exe', url: 'https://evil.example/x' }, asset: '*', process: 'explorer' },
      'blender',
    ],
    sourcePreference: ['github'], requireChecksum: false, portableRoot: 'C:/Windows', repos: [{ owner: 'a', repo: 'b' }],
  }), OPTS);
  assert.deepEqual(Object.keys(p).sort(), ['apps', 'description', 'format', 'id', 'name', 'version']);
  assert.deepEqual(p.apps, [
    { id: 'vlcmediaplayer' },
    { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' } },
    { id: 'blender' },
  ]);
});

test('validatePack: refuses what is not a pack', () => {
  const bad = (input, re) => assert.throws(() => packs.validatePack(input, OPTS), re);
  bad(null, /not a git-updater pack/);
  bad([], /not a git-updater pack/);
  bad(good({ format: 'something-else' }), /not a git-updater pack/);
  bad(good({ version: 2 }), /newer git-updater/);
  bad(good({ name: '   ' }), /no name/);
  bad(good({ apps: 'vlc' }), /lists no apps/);
  bad(good({ apps: new Array(201).fill({ id: 'vlcmediaplayer' }) }), /at most 200/);
  bad(good({ apps: [{ id: '../../etc' }, { source: { type: 'teleport' }, name: 'x' }, 42, null, { name: 'no source' }] }), /lists no apps this version/);
  // A source that is not a valid identity for its provider is not a reference at all.
  bad(good({ apps: [
    { name: 'x', source: { type: 'brew', token: '../../etc/passwd' } },
    { name: 'x', source: { type: 'winget', packageId: 'no-dots' } },
    { name: 'x', source: { type: 'gitlab', host: 'evil host', project: 'a/b' } },
    { name: 'x', source: { type: 'github', owner: 'has.dot', repo: 'r' } },
    { name: 'x', source: { type: 'gitea', host: 'codeberg.org', owner: 'only-owner' } },
  ] }), /lists no apps this version/);
});

test('validatePack: unrecognised entries are dropped and counted, duplicates collapse, text is bounded', () => {
  const p = packs.validatePack(good({
    name: 'N'.repeat(500) + '\u0000',
    description: 'D'.repeat(900),
    apps: [{ id: 'blender' }, { id: 'blender' }, { id: 'UPPER' }, { source: { type: 'ftp', host: 'x' }, name: 'y' }],
  }), OPTS);
  assert.equal(p.name.length, 80);
  assert.equal(p.description.length, 300);
  assert.deepEqual(p.apps, [{ id: 'blender' }]);
  assert.equal(p.dropped, 2);
});

test('parsePackFile: size cap and JSON errors', () => {
  assert.throws(() => packs.parsePackFile('{not json', OPTS), /not a git-updater pack/);
  assert.throws(() => packs.parsePackFile('x'.repeat(packs.MAX_BYTES + 1), OPTS), /too large/);
  const round = packs.parsePackFile(packs.exportPack(packs.validatePack(good(), OPTS)), OPTS);
  assert.deepEqual(round.apps, [{ id: 'vlcmediaplayer' }]);
  assert.equal(round.name, 'Work laptop');
});

// --- resolution ----------------------------------------------------------------------

test('resolveRefs: one pack serves every platform with that platform\'s source', () => {
  const pack = packs.validatePack(good({ apps: [{ id: 'vlcmediaplayer' }, { id: 'handbrake' }, { id: 'iterm2' }, { id: 'gone' }, { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'a/b' } }] }), OPTS);
  const on = (plat, pref = []) => packs.resolveRefs(pack, plat, pref, TYPES).map((r) => (r.sources.length ? r.sources.map((x) => x.type).join('>') : r.reason));
  // Every source an app has here, in the order to TRY them — so a provider with no build
  // for this machine can fall through to the next one.
  assert.deepEqual(on('win32'), ['winget', 'github>winget', 'not available for this operating system', "not in this version's app list", 'gitlab']);
  assert.deepEqual(on('darwin'), ['brew', 'github>brew', 'brew', "not in this version's app list", 'gitlab']);
  assert.deepEqual(on('win32', ['winget']), ['winget', 'winget>github', 'not available for this operating system', "not in this version's app list", 'gitlab']);
  // An explicit reference stays pinned to exactly its source.
  assert.equal(packs.resolveRefs(pack, 'win32', ['winget', 'github'], TYPES)[4].pinned, true);
  // A build without a provider says so instead of guessing another source.
  assert.equal(packs.resolveRefs(pack, 'win32', [], ['github'])[0].reason, 'needs a source this build does not have');
});

test('fromEntries: tracked apps become shortcut ids where one matches, source refs otherwise', () => {
  const sourceOf = (e) => e.source || { type: 'github', owner: e.owner, repo: e.repo };
  const canonical = (s) => `${s.type}:${(s.packageId || s.token || `${s.owner}/${s.repo}` || s.project || '').toLowerCase()}`;
  const pack = packs.fromEntries('This PC', 'x', [
    { owner: 'HandBrake', repo: 'HandBrake', type: 'portable' },
    { owner: 'source.winget', repo: 'videolan.vlc', type: 'installer', name: 'VLC media player', source: { type: 'winget', packageId: 'VideoLAN.VLC' } },
    { owner: 'TeeJS', repo: 'open-quake', type: 'portable' },
    { owner: 'HandBrake', repo: 'HandBrake', type: 'installer' },
  ], sourceOf, canonical);
  assert.deepEqual(pack.apps, [
    { id: 'handbrake' },
    { id: 'vlcmediaplayer' },
    { name: 'open-quake', source: { type: 'github', owner: 'TeeJS', repo: 'open-quake' } },
  ]);
  // ...so on a Mac the same pack resolves VLC through Homebrew.
  assert.equal(packs.resolveRefs(pack, 'darwin', [], TYPES)[1].sources[0].type, 'brew');
});

test('add: an import is always a new pack and never replaces a saved one', () => {
  const mk = (name) => packs.validatePack(good({ name }), OPTS);
  let r = packs.add([], mk('Essentials'));
  assert.equal(r.saved.id, 'essentials-2', 'never shadows a built-in pack id');
  r = packs.add(r.packs, mk('Essentials'));
  assert.deepEqual(r.packs.map((p) => p.id), ['essentials-2', 'essentials-3']);
  assert.equal(r.saved.id, 'essentials-3', 'the entry reported is the one actually stored');
  // Different names that reduce to the same id are different packs.
  r = packs.add([], mk('Work PC'));
  r = packs.add(r.packs, mk('work-pc'));
  assert.deepEqual(r.packs.map((p) => [p.id, p.name]), [['work-pc', 'Work PC'], ['work-pc-2', 'work-pc']]);
});

test('saveNamed: replaces only a pack with exactly that name', () => {
  const mk = (name, apps) => packs.validatePack(good({ name, apps }), OPTS);
  let r = packs.saveNamed([], mk('Work PC', [{ id: 'blender' }]));
  r = packs.saveNamed(r.packs, mk('work-pc', [{ id: 'gimp' }]));
  assert.equal(r.packs.length, 2, 'same id, different name: kept apart');
  r = packs.saveNamed(r.packs, mk('WORK PC', [{ id: 'krita' }]));
  assert.equal(r.packs.length, 2);
  assert.deepEqual(r.packs[0].apps, [{ id: 'krita' }], 'saving again under the same name updates it');
  assert.equal(r.saved.id, 'work-pc', '...and keeps its id');
  assert.deepEqual(r.packs[1].apps, [{ id: 'gimp' }]);
});

test('storage: saved packs round-trip and damaged entries are skipped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-packs-')), 'packs.json');
  assert.deepEqual(packs.loadMine(file, OPTS), []);
  let mine = packs.add([], packs.validatePack(good({ name: 'One' }), OPTS)).packs;
  mine = packs.add(mine, packs.validatePack(good({ name: 'Two', apps: [{ name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'a/b' } }] }), OPTS)).packs;
  packs.saveMine(file, mine);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.push({ format: 'nope' }, 'junk');
  fs.writeFileSync(file, JSON.stringify(raw));
  const back = packs.loadMine(file, OPTS);
  assert.deepEqual(back.map((p) => p.id), ['one', 'two']);
  assert.deepEqual(back[1].apps, [{ name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'a/b' } }]);
});
