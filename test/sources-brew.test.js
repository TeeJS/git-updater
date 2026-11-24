'use strict';

// Homebrew Cask provider, driven from real records trimmed out of
// https://formulae.brew.sh/api/cask.json (captured 2026-11-19). No network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brew = require('../src/sources/brew');
const runner = require('../src/runner');

const CASKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources', 'brew', 'casks.json'), 'utf8'));
const cask = (token) => {
  const c = CASKS.find((x) => x.token === token);
  assert.ok(c, `fixture has ${token}`);
  return c;
};
const arm = (osVersion = '27.0') => ({ arch: 'arm64', platform: 'darwin', osVersion });
const intel = (osVersion = '27.0') => ({ arch: 'x64', platform: 'darwin', osVersion });
const only = (rel) => { assert.equal(rel.assets.length, 1); return rel.assets[0]; };

test('brew identity: token, page URL and URL parsing', () => {
  assert.equal(brew.canonicalRef({ type: 'brew', token: 'vlc' }), 'vlc');
  assert.equal(brew.pageUrl({ type: 'brew', token: 'firefox@esr' }), 'https://formulae.brew.sh/cask/firefox%40esr');
  assert.deepEqual(brew.parseUrl('https://formulae.brew.sh/cask/visual-studio-code'), { type: 'brew', token: 'visual-studio-code' });
  assert.deepEqual(brew.parseUrl('https://formulae.brew.sh/cask/firefox%40esr'), { type: 'brew', token: 'firefox@esr' });
  for (const no of ['https://formulae.brew.sh/formula/wget', 'http://formulae.brew.sh/cask/vlc', 'https://evil.example/cask/vlc', 'https://formulae.brew.sh/cask/a/b', 'vlc']) {
    assert.equal(brew.parseUrl(no), null, no);
  }
  assert.throws(() => brew.canonicalRef({ type: 'brew', token: '../x' }), /valid cask name/);
  assert.throws(() => brew.canonicalRef({ type: 'brew' }), /valid cask name/);
});

test('brew: Apple silicon gets the top-level record, pinned by SHA-256', () => {
  const rel = brew.toRelease(cask('blender'), arm());
  assert.equal(rel.tag_name, '5.3.0');
  assert.equal(rel.provenance.listedBy, 'Homebrew');
  assert.equal(rel.provenance.publisher, 'blender.org');
  const a = only(rel);
  assert.equal(a.name, 'blender-5.3.0-macos-arm64.dmg');
  assert.equal(a.browser_download_url, 'https://download.blender.org/release/Blender5.3/blender-5.3.0-macos-arm64.dmg');
  assert.deepEqual([a.platform, a.arch, a.type, a.kind], ['darwin', 'arm64', 'portable', 'dmg']);
  assert.match(a.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a.redirects, 'https-pinned');
  assert.deepEqual(a.requires, ['macOS 13 or later']);
  assert.equal(a.unsupported, undefined);
});

test('brew: an Intel Mac gets its variation — a different file, hash AND version', () => {
  const rel = brew.toRelease(cask('blender'), intel('27.0'));
  assert.equal(rel.tag_name, '4.5.16', 'Homebrew pins the last Intel release');
  const a = only(rel);
  assert.equal(a.arch, 'x64');
  assert.match(a.name, /^blender-4\.5\.16-macos-x64\.dmg$/);
  assert.notEqual(a.digest, only(brew.toRelease(cask('blender'), arm())).digest);
});

test('brew: a macOS newer than the table knows takes the newest record; an unlisted old one gets none', () => {
  assert.equal(brew.toRelease(cask('blender'), intel('28.3')).tag_name, '4.5.16');
  assert.equal(brew.toRelease(cask('blender'), arm('28.3')).tag_name, '5.3.0');
  // Blender's Intel variations stop at Ventura (13); Monterey (12) has no record.
  const old = only(brew.toRelease(cask('blender'), intel('12.6')));
  assert.match(old.unsupported, /no Intel build for this version of macOS/);
  // A minimum macOS the machine does not meet is stated, not ignored.
  assert.match(only(brew.toRelease(cask('docker-desktop'), arm('13.0'))).unsupported, /needs macOS 14 or later/);
});

test('brew: a download address with no file extension is flagged for sniffing', () => {
  const a = only(brew.toRelease(cask('visual-studio-code'), arm()));
  assert.equal(a.sniff, true);
  assert.equal(a.name, 'visual-studio-code-1.147.0');
  assert.equal(a.kind, undefined);
  assert.equal(a.type, 'portable');
  assert.equal(a.unsupported, undefined);
  const x = only(brew.toRelease(cask('visual-studio-code'), intel()));
  assert.equal(x.browser_download_url, 'https://update.code.visualstudio.com/1.147.0/darwin/stable');
  assert.notEqual(x.digest, a.digest);
});

test('brew: file names come from the path, a query value, or a decoded segment', () => {
  assert.equal(only(brew.toRelease(cask('handbrake-app'), arm())).name, 'HandBrake-1.11.2.dmg');
  assert.equal(only(brew.toRelease(cask('firefox'), arm())).name, 'Firefox 160.0.1.dmg');
  // One file for every Mac when there are no per-CPU variations.
  assert.equal(only(brew.toRelease(cask('firefox'), intel())).arch, 'universal');
});

test('brew: no_check has no digest but is still installable; a pkg is an installer', () => {
  const chrome = only(brew.toRelease(cask('google-chrome'), arm()));
  assert.equal(chrome.digest, undefined);
  assert.equal(chrome.redirects, undefined);
  assert.equal(chrome.unsupported, undefined);
  const zoom = only(brew.toRelease(cask('zoom'), arm()));
  assert.deepEqual([zoom.type, zoom.kind], ['installer', 'pkg']);
  assert.match(zoom.digest, /^sha256:/);
  assert.equal(brew.toRelease(cask('docker-desktop'), arm('27.0')).tag_name, '4.99.0', 'the build id after the comma is not part of the version');
});

test('brew: what cannot be installed or updated says why', () => {
  assert.throws(() => brew.toRelease(cask('1password@nightly'), arm()), (e) => e.unavailable && /does not track a version/.test(e.message));
  assert.throws(() => brew.toRelease(cask('1kc-razer'), arm()), (e) => e.unavailable && /disabled this cask/.test(e.message));
  assert.match(only(brew.toRelease(cask('font-0xproto'), arm())).unsupported, /fonts are not apps/);
  assert.match(only(brew.toRelease(cask('kicad'), arm())).unsupported, /not a single app or installer package/);
  assert.match(brew.toRelease(cask('active-trader-pro'), arm()).provenance.note, /deprecated in Homebrew/);
  assert.match(brew.toRelease(cask('vlc'), arm()).provenance.note, /also updates itself/);
});

// Homebrew's own marker for an app with its own updater: the engine leaves such an app alone
// (src/selfupdating.js), the way `brew upgrade` does by default.
test('brew: a cask marked auto_updates says so on the release, and one that is not does not', () => {
  assert.equal(brew.toRelease(cask('vlc'), arm()).updatesItself, true);
  assert.equal(brew.toRelease(cask('kicad'), arm()).updatesItself, undefined);
});

// Three real casks from Sol's review: a variation overrides far more than the file.
test('brew: a variation that DISABLES the cask is honoured (adrive on Intel)', () => {
  assert.equal(only(brew.toRelease(cask('adrive'), arm())).unsupported, undefined, 'Apple silicon is fine');
  assert.throws(() => brew.toRelease(cask('adrive'), intel('15.0')), (e) => e.unavailable && /disabled this cask \(fails gatekeeper check\)/.test(e.message));
});

test('brew: a variation that changes the macOS requirement is used, not the base one (artisan)', () => {
  // Base (Apple silicon) needs macOS 14; the Intel variations need only 13.
  assert.match(only(brew.toRelease(cask('artisan'), arm('13.5'))).unsupported, /needs macOS 14 or later/);
  const intel13 = only(brew.toRelease(cask('artisan'), intel('13.5')));
  assert.equal(intel13.unsupported, undefined);
  assert.deepEqual(intel13.requires, ['macOS 13 or later']);
});

test('brew: a stated architecture beats a neutral file name (agentiloop-agent is Apple silicon only)', () => {
  const armAsset = only(brew.toRelease(cask('agentiloop-agent'), arm('27.0')));
  assert.equal(armAsset.unsupported, undefined);
  assert.equal(armAsset.arch, 'arm64');
  assert.match(only(brew.toRelease(cask('agentiloop-agent'), intel('27.0'))).unsupported, /only an Apple silicon build/);
});

test('brew: an invalid published hash is an error, not "no checksum"', () => {
  assert.throws(() => brew.toRelease({ ...cask('qgis'), sha256: 'deadbeef' }, arm()), /invalid SHA-256/);
});

// --- network-shaped behaviour, through a stub ctx ----------------------------------

function ctxWith(routes, over = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      net: {
        getJson: async (url) => {
          calls.push(url);
          if (!(url in routes)) throw Object.assign(new Error('formulae.brew.sh answered 404'), { status: 404, unavailable: true });
          return { status: 200, url, json: routes[url] };
        },
      },
      platform: 'darwin', arch: 'arm64', osVersion: '27.0',
      cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gu-brew-')),
      now: () => 1_000_000,
      ...over,
    },
  };
}
const INDEX = 'https://formulae.brew.sh/api/cask.json';

test('brew.getLatestRelease: one small request for one cask', async () => {
  const { ctx, calls } = ctxWith({ 'https://formulae.brew.sh/api/cask/vlc.json': cask('vlc') });
  const rel = await brew.getLatestRelease({ type: 'brew', token: 'vlc' }, ctx);
  assert.equal(rel.tag_name, '3.0.24');
  assert.deepEqual(calls, ['https://formulae.brew.sh/api/cask/vlc.json']);
  await assert.rejects(brew.getLatestRelease({ type: 'brew', token: 'nope' }, ctx), (e) => e.unavailable && /no cask named nope/.test(e.message));
  // A record for a different cask than the one asked for is refused.
  const wrong = ctxWith({ 'https://formulae.brew.sh/api/cask/vlc.json': cask('firefox') });
  await assert.rejects(brew.getLatestRelease({ type: 'brew', token: 'vlc' }, wrong.ctx), /different cask/);
});

test('brew.search: exact tokens and unique names are exact; editions are labelled, never exact by accident', async () => {
  const { ctx } = ctxWith({ [INDEX]: CASKS });
  const ff = await brew.search('firefox', ctx);
  assert.deepEqual(ff.slice(0, 2).map((c) => [c.source.token, c.exact, c.channel]), [['firefox', true, undefined], ['firefox@esr', false, 'esr']]);
  const code = await brew.search('VS Code', ctx);
  assert.deepEqual([code[0].source.token, code[0].exact, code[0].name], ['visual-studio-code', true, 'Microsoft Visual Studio Code']);
  const lo = await brew.search('libreoffice', ctx);
  assert.deepEqual(lo.map((c) => [c.source.token, c.exact]), [['libreoffice', true], ['libreoffice-still', false]]);
  assert.equal(lo[0].version, '26.8.3');
  assert.equal(lo[0].listingUrl, 'https://formulae.brew.sh/cask/libreoffice');
  assert.deepEqual(await brew.search('zz-not-a-thing', ctx), []);
  assert.deepEqual(await brew.search('   ', ctx), []);
});

test('brew.search: fonts, version-less, disabled and suite-only casks are never offered', async () => {
  const { ctx } = ctxWith({ [INDEX]: CASKS });
  for (const q of ['0xproto', '1password', 'razer', 'kicad']) {
    assert.deepEqual((await brew.search(q, ctx)).map((c) => c.source.token), [], q);
  }
  const slim = brew.slim(CASKS).map((c) => c.t);
  assert.ok(slim.includes('zoom') && slim.includes('google-chrome'));
  assert.ok(!slim.some((t) => t.startsWith('font-')));
});

test('brew.search: the index is fetched once, cached on disk, and survives a failed refresh', async () => {
  const { ctx, calls } = ctxWith({ [INDEX]: CASKS });
  await brew.search('vlc', ctx);
  await brew.search('zoom', ctx);
  assert.equal(calls.length, 1, 'second search is served from memory');
  const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.cacheDir, 'brew-casks.json'), 'utf8'));
  assert.ok(Array.isArray(onDisk.list) && onDisk.list.length > 5);
  assert.ok(fs.statSync(path.join(ctx.cacheDir, 'brew-casks.json')).size < 20000, 'only the slim index is stored');
  // Seven hours later the list is stale; the refresh fails; the cached copy still answers.
  const later = { ...ctx, now: () => 1_000_000 + 7 * 3600 * 1000, net: { getJson: async () => { throw new Error('network error reaching formulae.brew.sh: ECONNRESET'); } } };
  const res = await brew.search('vlc', later);
  assert.equal(res[0].source.token, 'vlc');
  assert.match(res[0].note, /cached Homebrew list/);
});

test('runner.sniffExtension: names a file from its own bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-sniff-'));
  const write = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };
  assert.equal(runner.sniffExtension(write('z', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))), '.zip');
  assert.equal(runner.sniffExtension(write('p', Buffer.from('xar!\0\0\0\0'))), '.pkg');
  const dmg = Buffer.alloc(2048); dmg.write('koly', 2048 - 512, 'latin1');
  assert.equal(runner.sniffExtension(write('d', dmg)), '.dmg');
  assert.equal(runner.sniffExtension(write('u', Buffer.from('<!doctype html><html>not a download</html>'))), null);
  assert.equal(runner.sniffExtension(path.join(dir, 'missing')), null);
});
