'use strict';

// The vendor-folder provider, driven from raw listings captured byte for byte from real
// servers on 2026-11-19 (test/fixtures/sources/folder/). No network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const folder = require('../src/sources/folder');
const sources = require('../src/sources');

const FX = path.join(__dirname, 'fixtures', 'sources', 'folder');
const fx = (name) => fs.readFileSync(path.join(FX, name), 'utf8');

// A ctx whose listings come from a URL -> fixture map. Anything else is a 404.
function ctxWith(routes) {
  const calls = [];
  return {
    calls,
    ctx: {
      net: {
        getText: async (url) => {
          calls.push(url);
          if (!(url in routes)) throw Object.assign(new Error('answered 404'), { status: 404, unavailable: true });
          const v = routes[url];
          if (v instanceof Error) throw v;
          return { status: 200, url, text: v };
        },
      },
    },
  };
}

const BLENDER = 'https://download.blender.org/release/';
const VLC = 'https://download.videolan.org/pub/videolan/vlc/';
const WIRESHARK = 'https://www.wireshark.org/download/win64/';
const FIREFOX = 'https://archive.mozilla.org/pub/firefox/releases/';

test('folder identity: https folders only, normalised, never claimed by shape alone', () => {
  assert.equal(folder.normalize('https://Download.Blender.org/release'), BLENDER);
  assert.equal(folder.normalize('https://download.blender.org//release/?C=N;O=D#x'), BLENDER);
  for (const no of ['http://download.blender.org/release/', 'https://u:p@h.example/x/', 'not a url']) {
    assert.equal(folder.normalize(no), null, no);
  }
  // Dot segments are resolved by the URL parser itself, so they cannot survive into a key.
  assert.equal(folder.normalize('https://h.example/a/../b/'), 'https://h.example/b/');
  assert.equal(folder.canonicalRef({ type: 'folder', url: BLENDER }), 'download.blender.org/release/');
  assert.equal(folder.pageUrl({ type: 'folder', url: 'https://download.blender.org/release' }), BLENDER);
  assert.equal(folder.parseUrl(BLENDER), null);
  assert.throws(() => folder.canonicalRef({ type: 'folder', url: 'ftp://x/' }), /https:\/\/ folder address/);
});

test('folder.displayName: the path segment that names something, else the site', () => {
  const n = (url) => folder.displayName({ type: 'folder', url });
  assert.equal(n(BLENDER), 'Blender');
  assert.equal(n(VLC), 'Vlc');
  assert.equal(n('https://download.documentfoundation.org/libreoffice/stable/'), 'Libreoffice');
  assert.equal(n('https://download.kde.org/stable/krita/'), 'Krita');
  assert.equal(n(WIRESHARK), 'Wireshark');
  assert.equal(n('https://download.gimp.org/gimp/'), 'Gimp');
});

test('parseListing: only direct children on the same origin count, in every listing dialect', () => {
  // nginx autoindex
  const b = folder.parseListing(fx('blender-release.html'), BLENDER);
  assert.ok(b.dirs.some((d) => d.name === 'Blender5.3' && d.url === `${BLENDER}Blender5.3/`));
  assert.ok(!b.dirs.some((d) => d.name === '..' || d.name === ''));
  // Apache autoindex: sort links (?C=N;O=D), an absolute parent link and off-site links.
  const lo = folder.parseListing(fx('libreoffice-stable.html'), 'https://download.documentfoundation.org/libreoffice/stable/');
  assert.deepEqual(lo.dirs.map((d) => d.name), ['25.8.7', '26.2.7', '26.8.2', '26.8.3']);
  assert.deepEqual(lo.files, []);
  // A mirror front-end with dozens of navigation links.
  const k = folder.parseListing(fx('krita.html'), 'https://download.kde.org/stable/krita/');
  assert.ok(k.dirs.length > 5 && k.dirs.every((d) => d.url.startsWith('https://download.kde.org/stable/krita/')));
  // Object-store style: absolute paths under the folder.
  const f = folder.parseListing(fx('firefox-releases.html'), FIREFOX);
  assert.ok(f.dirs.some((d) => d.name === '160.0.1' && d.url === `${FIREFOX}160.0.1/`));
  assert.ok(!f.dirs.some((d) => d.url === 'https://archive.mozilla.org/pub/firefox/'), 'the parent is not a child');
});

test('parseListing: a listing cannot point outside its own folder', () => {
  const html = [
    '<a href="https://evil.example/app-9.9.9.exe">app</a>',
    '<a href="//evil.example/x/">x</a>',
    '<a href="/other/app-9.9.9.exe">elsewhere on this host</a>',
    '<a href="../../app-9.9.9.exe">up</a>',
    '<a href="deep/er/app-9.9.9.exe">too deep</a>',
    '<a href="app-1.0.0.exe?token=1">query</a>',
    '<a href="%2e%2e/app-9.9.9.exe">encoded up</a>',
    '<a href="app-1.2.3.exe">ok</a>',
    "<a class='x' href='v1.2/'>dir</a>",
  ].join('\n');
  const got = folder.parseListing(html, 'https://v.example/dl/');
  assert.deepEqual(got.files, [{ name: 'app-1.2.3.exe', url: 'https://v.example/dl/app-1.2.3.exe' }]);
  assert.deepEqual(got.dirs, [{ name: 'v1.2', url: 'https://v.example/dl/v1.2/' }]);
});

test('series: the biggest family of version folders wins; leftovers and prereleases do not', () => {
  const b = folder.series(folder.parseListing(fx('blender-release.html'), BLENDER).dirs);
  assert.equal(b[0].name, 'Blender5.3', 'not yafray.0.0.7, which sorts last by name');
  assert.ok(b.every((d) => /^Blender\d/.test(d.name)));
  const f = folder.parseListing(fx('firefox-releases.html'), FIREFOX).dirs;
  assert.ok(f.some((d) => /^161\.0b\d/.test(d.name)), 'the fixture does contain newer betas');
  const stable = folder.series(f);
  assert.ok(!stable.some((d) => folder.isPrerelease(d.name)));
  assert.match(stable[0].name, /^160\./, 'newest STABLE, not 161.0b5');
  assert.match(folder.series(f, { prerelease: true })[0].name, /^161\.0b/);
  for (const [name, pre] of [['5.0.0rc2', true], ['161.0b5', true], ['gimp-3.3.2-beta.exe', true], ['Blender5.3', false], ['3.0.24', false], ['abiword-2.8.6.exe', false]]) {
    assert.equal(folder.isPrerelease(name), pre, name);
  }
});

test('Blender: release/ -> Blender5.3/ -> the files, with the shared checksum file', async () => {
  const { ctx, calls } = ctxWith({ [BLENDER]: fx('blender-release.html'), [`${BLENDER}Blender5.3/`]: fx('blender-5.3.html') });
  const rel = await folder.getLatestRelease({ type: 'folder', url: BLENDER }, ctx);
  assert.equal(rel.tag_name, '5.3.0');
  assert.equal(rel.html_url, `${BLENDER}Blender5.3/`);
  assert.deepEqual(rel.provenance, { listedBy: 'Vendor site', listingUrl: `${BLENDER}Blender5.3/`, publisher: 'download.blender.org' });
  const names = rel.assets.map((a) => a.name).sort();
  assert.deepEqual(names, [
    'blender-5.3.0-linux-x64.tar.xz', 'blender-5.3.0-macos-arm64.dmg',
    'blender-5.3.0-windows-arm64.msi', 'blender-5.3.0-windows-arm64.zip',
    'blender-5.3.0-windows-x64.msi', 'blender-5.3.0-windows-x64.zip',
    'blender-5.3.0.sha256',
  ], 'installable files plus the sums file; no .md5, no .msix');
  assert.ok(rel.assets.every((a) => a.browser_download_url.startsWith(`${BLENDER}Blender5.3/`)));
  assert.deepEqual(calls, [BLENDER, `${BLENDER}Blender5.3/`], 'two requests');
});

test('Blender end to end through the registry: right file per machine, checksum from the shared file', async () => {
  const { ctx } = ctxWith({
    [BLENDER]: fx('blender-release.html'),
    [`${BLENDER}Blender5.3/`]: fx('blender-5.3.html'),
    [`${BLENDER}Blender5.3/blender-5.3.0.sha256`]: fx('blender-5.3.0.sha256'),
  });
  const entry = (t) => sources.normalizeEntry({ type: t, name: 'Blender', source: { type: 'folder', url: BLENDER } });
  assert.equal(sources.appKey(entry('portable')), 'source.folder/download.blender.org%2Frelease%2F#portable');
  const rel = await sources.getLatestRelease(entry('portable'), { ...ctx, platform: 'win32', arch: 'x64' });
  const pick = (platform, arch, t) => sources.selectAsset(entry(t), rel, { platform, arch }).name;
  assert.equal(pick('win32', 'x64', 'portable'), 'blender-5.3.0-windows-x64.zip');
  assert.equal(pick('win32', 'arm64', 'installer'), 'blender-5.3.0-windows-arm64.msi');
  assert.equal(pick('darwin', 'arm64', 'portable'), 'blender-5.3.0-macos-arm64.dmg');
  assert.equal(pick('linux', 'x64', 'portable'), 'blender-5.3.0-linux-x64.tar.xz');
  assert.throws(() => pick('darwin', 'x64', 'portable'), /no build for this machine \(macOS x64\) in 5\.3\.0/);
  const asset = sources.selectAsset(entry('portable'), rel, { platform: 'win32', arch: 'x64' });
  const sum = await sources.resolveChecksum(entry('portable'), rel, asset, ctx);
  assert.equal(sum.state, 'published');
  assert.match(sum.digest, /^sha256:[a-f0-9]{64}$/);
  // The hash really is the line for THIS file in Blender's own sums file.
  // \r?\n: a Windows checkout with core.autocrlf rewrites text fixtures to CRLF.
  const line = fx('blender-5.3.0.sha256').split(/\r?\n/).find((l) => l.endsWith('blender-5.3.0-windows-x64.zip'));
  assert.equal(sum.digest, `sha256:${line.split(/\s+/)[0]}`);
  // HTTPS on every hop; mirror redirects are followed only after each hop is validated.
  assert.deepEqual(sources.downloadPolicy(entry('portable'), asset, sum), { httpsOnly: true, noRedirect: false });
});

test('checksums by convention: "<file>.sha256" from the origin, as mirror networks serve it', async () => {
  // KDE lists krita-x64-6.0.4.1.zip but not its .sha256 — the origin answers it anyway.
  const base = 'https://download.kde.org/stable/krita/6.0.4.1/';
  const file = { name: 'krita-x64-6.0.4.1.zip', browser_download_url: `${base}krita-x64-6.0.4.1.zip` };
  const entry = sources.normalizeEntry({ type: 'portable', name: 'Krita', source: { type: 'folder', url: 'https://download.kde.org/stable/krita/' } });
  const rel = { tag_name: '6.0.4.1', assets: [file] };
  const hex = 'ab'.repeat(32);
  const hit = ctxWith({ [`${file.browser_download_url}.sha256`]: `${hex}  krita-x64-6.0.4.1.zip\n` });
  assert.deepEqual(await sources.resolveChecksum(entry, rel, file, hit.ctx), { digest: `sha256:${hex}`, state: 'published', note: 'verified via release checksums file' });
  // No such file (the usual case): simply no checksum — never an error.
  assert.equal((await sources.resolveChecksum(entry, rel, file, ctxWith({}).ctx)).state, 'none');
  const flaky = ctxWith({});
  flaky.ctx.net.getText = async () => { throw new Error('network error reaching download.kde.org: ECONNRESET'); };
  assert.equal((await sources.resolveChecksum(entry, rel, file, flaky.ctx)).state, 'none', 'a guessed address failing is not "unreadable"');
});

test('a LISTED checksum file that redirects to a mirror is not used, and is not an error', async () => {
  // GIMP lists SHA256SUMS, but the server redirects that request to a mirror.
  const base = 'https://download.gimp.org/gimp/v3.2/windows/';
  const file = { name: 'gimp-3.2.8-setup.exe', browser_download_url: `${base}gimp-3.2.8-setup.exe` };
  const sums = { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` };
  const entry = sources.normalizeEntry({ type: 'installer', name: 'GIMP', source: { type: 'folder', url: 'https://download.gimp.org/gimp/' } });
  const c = ctxWith({});
  c.ctx.net.getText = async (url) => {
    if (url === sums.browser_download_url) throw Object.assign(new Error('download.gimp.org redirected the request, which this source does not allow'), { redirectRefused: true });
    throw Object.assign(new Error('answered 404'), { status: 404, unavailable: true });
  };
  assert.deepEqual(await sources.resolveChecksum(entry, { tag_name: '3.2.8', assets: [file, sums] }, file, c.ctx),
    { digest: null, state: 'none', note: 'no publisher checksum verified — the checksum file is served from a mirror' });
});

test('the same file name in two sub-folders is ambiguous and is not offered', async () => {
  const base = 'https://v.example/dl/';
  const v = `${base}2.0/`;
  const { ctx } = ctxWith({
    [base]: '<a href="2.0/">2.0/</a>',
    [v]: '<a href="win/">win/</a><a href="mac/">mac/</a><a href="linux/">linux/</a>',
    [`${v}win/`]: '<a href="app-2.0.0.zip">z</a><a href="SHA256SUMS">s</a><a href="app-2.0.0-setup.exe">e</a>',
    [`${v}mac/`]: '<a href="app-2.0.0.zip">z</a><a href="SHA256SUMS">s</a><a href="app-2.0.0.dmg">d</a>',
    [`${v}linux/`]: '<a href="app-2.0.0-x86_64.AppImage">a</a><a href="SHA256SUMS">s</a>',
  });
  const rel = await folder.getLatestRelease({ type: 'folder', url: base }, ctx);
  const names = rel.assets.map((a) => a.name);
  assert.ok(!names.includes('app-2.0.0.zip'), 'neither copy of the repeated name is offered');
  assert.ok(names.includes('app-2.0.0-setup.exe') && names.includes('app-2.0.0.dmg') && names.includes('app-2.0.0-x86_64.AppImage'));
  // Each folder's own SHA256SUMS is kept, with its own address.
  assert.deepEqual(rel.assets.filter((a) => a.name === 'SHA256SUMS').map((a) => a.browser_download_url).sort(), [`${v}linux/SHA256SUMS`, `${v}mac/SHA256SUMS`, `${v}win/SHA256SUMS`]);
});

test('a checksum file only vouches for files in its own folder', async () => {
  const v = 'https://v.example/dl/2.0/';
  const exe = { name: 'app-2.0.0-setup.exe', browser_download_url: `${v}win/app-2.0.0-setup.exe` };
  const assets = [exe, { name: 'SHA256SUMS', browser_download_url: `${v}mac/SHA256SUMS` }, { name: 'SHA256SUMS', browser_download_url: `${v}win/SHA256SUMS` }];
  const entry = sources.normalizeEntry({ type: 'installer', name: 'App', source: { type: 'folder', url: 'https://v.example/dl/' } });
  const good = 'aa'.repeat(32);
  const c = ctxWith({
    // The sibling folder's file lists the same name with a DIFFERENT hash; it must never be consulted.
    [`${v}mac/SHA256SUMS`]: `${'bb'.repeat(32)}  app-2.0.0-setup.exe\n`,
    [`${v}win/SHA256SUMS`]: `${good}  app-2.0.0-setup.exe\n`,
  });
  const sum = await sources.resolveChecksum(entry, { tag_name: '2.0.0', assets }, exe, c.ctx);
  assert.equal(sum.digest, `sha256:${good}`);
  assert.ok(!c.calls.includes(`${v}mac/SHA256SUMS`), 'the other folder was not even asked');
});

test('VLC: version folder, then platform folders, per-file checksums', async () => {
  const v = `${VLC}3.0.24/`;
  const { ctx } = ctxWith({ [VLC]: fx('vlc.html'), [v]: fx('vlc-3.0.24.html'), [`${v}win64/`]: fx('vlc-3.0.24-win64.html'), [`${v}macosx/`]: fx('vlc-3.0.24-macosx.html') });
  const rel = await folder.getLatestRelease({ type: 'folder', url: VLC }, ctx);
  assert.equal(rel.tag_name, '3.0.24', 'not "last/" and not the 0.x folders');
  const names = rel.assets.map((a) => a.name);
  for (const want of ['vlc-3.0.24-win64.exe', 'vlc-3.0.24-win64.msi', 'vlc-3.0.24-win64.zip', 'vlc-3.0.24-win64.exe.sha256', 'vlc-3.0.24-arm64.dmg']) {
    assert.ok(names.includes(want), want);
  }
  assert.ok(!names.some((n) => /debugsym|\.md5$|\.sha1$|\.asc$/.test(n)), 'no debug symbols or weak hashes');
  // win32/ and winarm64/ are listed but have no fixture: unreadable sub-folders are skipped.
  assert.ok(rel.assets.find((a) => a.name === 'vlc-3.0.24-win64.exe').browser_download_url.startsWith(`${v}win64/`));
});

test('Wireshark: files right here; the newest stable build, not an rc or "latest"', async () => {
  const { ctx, calls } = ctxWith({ [WIRESHARK]: fx('wireshark-win64.html') });
  const rel = await folder.getLatestRelease({ type: 'folder', url: WIRESHARK }, ctx);
  assert.ok(!/rc/i.test(rel.tag_name));
  assert.ok(rel.assets.length >= 1 && rel.assets.every((a) => a.name.includes(rel.tag_name)));
  assert.ok(rel.assets.every((a) => !/rc\d|latest/i.test(a.name)));
  assert.deepEqual(calls, [WIRESHARK], 'one request');
  // The beta setting is NOT applied to folders: an rc would be recorded as "5.0.0" and
  // hide the real 5.0.0 later. Stable only, and the release says so.
  const pre = await folder.getLatestRelease({ type: 'folder', url: WIRESHARK }, ctx, { prerelease: true });
  assert.equal(pre.tag_name, rel.tag_name);
  assert.match(pre.provenance.note, /stable releases only/);
  assert.equal(rel.provenance.note, undefined);
});

test('a version folder that was listed but cannot be read is an error, never an older version', async () => {
  const { ctx } = ctxWith({ [BLENDER]: fx('blender-release.html'), [`${BLENDER}Blender5.3/`]: new Error('network error reaching download.blender.org: ECONNRESET') });
  await assert.rejects(folder.getLatestRelease({ type: 'folder', url: BLENDER }, ctx), /ECONNRESET/);
});

test('an empty newest folder falls back to the next one; nothing anywhere is "unavailable"', async () => {
  const top = '<a href="App2.0/">App2.0/</a><a href="App1.9/">App1.9/</a>';
  const base = 'https://v.example/dl/';
  const ok = ctxWith({ [base]: top, [`${base}App2.0/`]: '<a href="notes.txt">notes</a><a href="app-2.0.0-rc1-win64.zip">rc</a>', [`${base}App1.9/`]: '<a href="app-1.9.4-win64.zip">z</a>' });
  assert.equal((await folder.getLatestRelease({ type: 'folder', url: base }, ok.ctx)).tag_name, '1.9.4');
  const none = ctxWith({ [base]: top, [`${base}App2.0/`]: '', [`${base}App1.9/`]: '' });
  await assert.rejects(folder.getLatestRelease({ type: 'folder', url: base }, none.ctx), (e) => e.unavailable && /hold no downloadable files/.test(e.message));
  const blank = ctxWith({ [base]: '<a href="readme.txt">r</a>' });
  await assert.rejects(folder.getLatestRelease({ type: 'folder', url: base }, blank.ctx), (e) => e.unavailable && /no downloadable files or version folders/.test(e.message));
});

test('probe: recognises a download folder with one request, and only a real one', async () => {
  const yes = ctxWith({ [BLENDER]: fx('blender-release.html') });
  assert.deepEqual(await folder.probe('https://download.blender.org/release', yes.ctx), { type: 'folder', url: BLENDER });
  assert.equal(yes.calls.length, 1);
  const page = ctxWith({ 'https://site.example/about/': '<a href="/contact">contact</a><a href="team/">team</a>' });
  assert.equal(await folder.probe('https://site.example/about/', page.ctx), null, 'an ordinary web page is not a source');
  assert.equal(await folder.probe('http://download.blender.org/release/', yes.ctx), null);
  assert.equal(await folder.probe('https://gone.example/x/', ctxWith({}).ctx), null);
});

test('resolve: a pasted folder address becomes one explicit candidate named for the app', async () => {
  const { ctx } = ctxWith({ [BLENDER]: fx('blender-release.html') });
  ctx.net.getJson = async () => { throw Object.assign(new Error('404'), { status: 404 }); }; // not a forge
  const r = await sources.resolve('download.blender.org/release/', { ...ctx, platform: 'linux', arch: 'x64' });
  assert.equal(r.kind, 'url');
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0].source, { type: 'folder', url: BLENDER });
  assert.equal(r.candidates[0].name, 'Blender');
  assert.equal(r.candidates[0].listedBy, 'Vendor site');
  assert.equal(r.candidates[0].explicit, true);
});
