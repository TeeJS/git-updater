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

const TYPES = ['github', 'gitlab', 'gitea', 'winget', 'brew'];
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
      { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner', nested: { x: 1 }, list: [1], 'bad key': 'x' }, asset: '*', process: 'explorer' },
      'blender',
    ],
    sourcePreference: ['github'], requireChecksum: false, portableRoot: 'C:/Windows', repos: [{ owner: 'a', repo: 'b' }],
  }), { knownTypes: TYPES });
  assert.deepEqual(Object.keys(p).sort(), ['apps', 'description', 'format', 'id', 'name', 'version']);
  assert.deepEqual(p.apps, [
    { id: 'vlcmediaplayer' },
    { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' } },
    { id: 'blender' },
  ]);
});

test('validatePack: refuses what is not a pack', () => {
  const bad = (input, re) => assert.throws(() => packs.validatePack(input, { knownTypes: TYPES }), re);
  bad(null, /not a git-updater pack/);
  bad([], /not a git-updater pack/);
  bad(good({ format: 'something-else' }), /not a git-updater pack/);
  bad(good({ version: 2 }), /newer git-updater/);
  bad(good({ name: '   ' }), /no name/);
  bad(good({ apps: 'vlc' }), /lists no apps/);
  bad(good({ apps: new Array(201).fill({ id: 'vlcmediaplayer' }) }), /at most 200/);
  bad(good({ apps: [{ id: '../../etc' }, { source: { type: 'teleport' }, name: 'x' }, 42, null, { name: 'no source' }] }), /lists no apps this version/);
});

test('validatePack: unrecognised entries are dropped and counted, duplicates collapse, text is bounded', () => {
  const p = packs.validatePack(good({
    name: 'N'.repeat(500) + '\u0000',
    description: 'D'.repeat(900),
    apps: [{ id: 'blender' }, { id: 'blender' }, { id: 'UPPER' }, { source: { type: 'ftp', host: 'x' }, name: 'y' }],
  }), { knownTypes: TYPES });
  assert.equal(p.name.length, 80);
  assert.equal(p.description.length, 300);
  assert.deepEqual(p.apps, [{ id: 'blender' }]);
  assert.equal(p.dropped, 2);
});

test('parsePackFile: size cap and JSON errors', () => {
  assert.throws(() => packs.parsePackFile('{not json', { knownTypes: TYPES }), /not a git-updater pack/);
  assert.throws(() => packs.parsePackFile('x'.repeat(packs.MAX_BYTES + 1), { knownTypes: TYPES }), /too large/);
  const round = packs.parsePackFile(packs.exportPack(packs.validatePack(good(), { knownTypes: TYPES })), { knownTypes: TYPES });
  assert.deepEqual(round.apps, [{ id: 'vlcmediaplayer' }]);
  assert.equal(round.name, 'Work laptop');
});

// --- resolution ----------------------------------------------------------------------

test('resolveRefs: one pack serves every platform with that platform\'s source', () => {
  const pack = packs.validatePack(good({ apps: [{ id: 'vlcmediaplayer' }, { id: 'handbrake' }, { id: 'iterm2' }, { id: 'gone' }, { name: 'Runner', source: { type: 'gitlab', host: 'gitlab.com', project: 'a/b' } }] }), { knownTypes: TYPES });
  const on = (plat, pref = []) => packs.resolveRefs(pack, plat, pref, TYPES).map((r) => (r.source ? r.source.type : r.reason));
  assert.deepEqual(on('win32'), ['winget', 'github', 'not available for this operating system', "not in this version's app list", 'gitlab']);
  assert.deepEqual(on('darwin'), ['brew', 'github', 'brew', "not in this version's app list", 'gitlab']);
  assert.deepEqual(on('win32', ['winget']), ['winget', 'winget', 'not available for this operating system', "not in this version's app list", 'gitlab']);
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
  assert.equal(packs.resolveRefs(pack, 'darwin', [], TYPES)[1].source.type, 'brew');
});

test('storage: saved packs round-trip, damaged entries are skipped, ids stay unique', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-packs-')), 'packs.json');
  assert.deepEqual(packs.loadMine(file, { knownTypes: TYPES }), []);
  let mine = packs.upsert([], packs.validatePack(good({ name: 'Essentials' }), { knownTypes: TYPES }));
  assert.equal(mine[0].id, 'essentials-2', 'never shadows a built-in pack id');
  mine = packs.upsert(mine, packs.validatePack(good({ name: 'Essentials' }), { knownTypes: TYPES }));
  assert.deepEqual(mine.map((p) => p.id), ['essentials-2', 'essentials-3']);
  packs.saveMine(file, mine);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.push({ format: 'nope' }, 'junk');
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(packs.loadMine(file, { knownTypes: TYPES }).map((p) => p.id), ['essentials-2', 'essentials-3']);
});
