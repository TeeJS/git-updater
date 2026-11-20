'use strict';

// The source registry: keys, selection, checksum policy and the resolver. No network —
// providers are driven through a stub ctx, exactly as the provider contract promises.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sources = require('../src/sources');
const github = require('../src/github');

const fx = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources', ...p), 'utf8'));

// A ctx whose net answers from a URL -> body map. Anything unlisted is a 404.
function stubCtx(routes = {}, over = {}) {
  const hit = (url) => {
    if (!(url in routes)) throw Object.assign(new Error(`unexpected request ${url}`), { status: 404 });
    return routes[url];
  };
  return {
    net: {
      getJson: async (url) => ({ status: 200, url, json: hit(url) }),
      getText: async (url) => ({ status: 200, url, text: String(hit(url)) }),
      getBuffer: async (url) => ({ status: 200, url, buffer: Buffer.from(hit(url)) }),
    },
    platform: 'win32',
    arch: 'x64',
    now: () => 0,
    ...over,
  };
}

// --- keys -------------------------------------------------------------------------

test('keys: a GitHub entry keeps its owner/repo key byte for byte', () => {
  assert.deepEqual(sources.keyParts({ type: 'github', owner: 'ShareX', repo: 'ShareX' }), { owner: 'ShareX', repo: 'ShareX' });
  assert.equal(sources.isGithub({ owner: 'ShareX', repo: 'ShareX', type: 'portable' }), true);
});

test('keys: other sources live under source.<type>/ with the ref percent-encoded', () => {
  const k = sources.keyParts({ type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' });
  assert.equal(k.owner, 'source.gitlab');
  assert.equal(k.repo, 'gitlab.com%2Fgitlab-org%2Fgitlab-runner');
  // The rest of the app splits keys on "/" and "#": neither may survive in the ref.
  assert.ok(!/[/#]/.test(k.repo));
  // A GitHub owner cannot contain a dot, so this namespace can never be a real repo.
  assert.equal(require('../src/sources/github').parseUrl(`${k.owner}/${k.repo}`), null);
});

test('normalizeEntry: owner/repo are derived from source, never trusted', () => {
  const forged = {
    owner: 'microsoft', repo: 'PowerToys', type: 'installer', name: 'Runner',
    source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' },
  };
  sources.normalizeEntry(forged);
  assert.equal(forged.owner, 'source.gitlab');
  assert.equal(forged.repo, 'gitlab.com%2Fgitlab-org%2Fgitlab-runner');
});

test('normalizeEntry: an unknown source type is an error, not a silent GitHub lookup', () => {
  assert.throws(() => sources.normalizeEntry({ owner: 'a', repo: 'b', type: 'portable', name: 'X', source: { type: 'nope' } }), /unknown source type "nope"/);
});

test('normalizeEntry: an explicit github source collapses to a plain entry', () => {
  const e = sources.normalizeEntry({ owner: 'x', repo: 'y', type: 'portable', source: { type: 'github', owner: 'ShareX', repo: 'ShareX' } });
  assert.deepEqual(e, { owner: 'ShareX', repo: 'ShareX', type: 'portable' });
});

test('entryFromCandidate: only scalar source fields survive, and the name is bounded', () => {
  const e = sources.entryFromCandidate(
    { name: 'x'.repeat(500), source: { type: 'gitea', host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo', evil: { nested: true }, list: [1] } },
    'portable'
  );
  assert.deepEqual(e.source, { type: 'gitea', host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo' });
  assert.equal(e.name.length, 120);
  assert.equal(e.owner, 'source.gitea');
  assert.throws(() => sources.entryFromCandidate({ source: { type: 'gitea', host: 'codeberg.org', owner: 'a', repo: 'b' } }, 'bogus'), /type must be/);
});

test('describe: every entry can say where it comes from without a network call', () => {
  assert.deepEqual(
    (({ type, label, listingHost }) => ({ type, label, listingHost }))(sources.describe({ owner: 'ShareX', repo: 'ShareX', type: 'portable' })),
    { type: 'github', label: 'GitHub', listingHost: 'github.com' }
  );
  const d = sources.describe({ type: 'portable', name: 'Forgejo', source: { type: 'gitea', host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo' } });
  assert.equal(d.label, 'Codeberg');
  assert.equal(d.pageUrl, 'https://codeberg.org/forgejo/forgejo/releases');
});

// --- selection --------------------------------------------------------------------

const BLENDER = [
  'blender-5.3.0-linux-x64.tar.xz', 'blender-5.3.0-macos-arm64.dmg',
  'blender-5.3.0-windows-arm64.msi', 'blender-5.3.0-windows-arm64.zip',
  'blender-5.3.0-windows-x64.msi', 'blender-5.3.0-windows-x64.zip',
].map((name) => ({ name, browser_download_url: `https://download.blender.org/release/Blender5.3/${name}` }));
const folderEntry = (type) => ({ type, name: 'Blender', owner: 'source.gitea', repo: 'x', source: { type: 'gitea', host: 'codeberg.org', owner: 'a', repo: 'b' } });
const rel = (assets) => ({ tag_name: '5.3.0', assets });

test('selectAsset: a filename-only source never hands a machine a build it cannot run', () => {
  const pick = (platform, arch, type) => sources.selectAsset(folderEntry(type), rel(BLENDER), { platform, arch }).name;
  assert.equal(pick('win32', 'x64', 'portable'), 'blender-5.3.0-windows-x64.zip');
  assert.equal(pick('win32', 'x64', 'installer'), 'blender-5.3.0-windows-x64.msi');
  assert.equal(pick('win32', 'arm64', 'portable'), 'blender-5.3.0-windows-arm64.zip');
  assert.equal(pick('darwin', 'arm64', 'portable'), 'blender-5.3.0-macos-arm64.dmg');
  assert.equal(pick('linux', 'x64', 'portable'), 'blender-5.3.0-linux-x64.tar.xz');
  // The three wrong picks the unfiltered picker makes today:
  assert.throws(() => pick('darwin', 'x64', 'portable'), /no build for this machine \(macOS x64\) in 5\.3\.0/);
  assert.throws(() => pick('linux', 'arm64', 'portable'), /no build for this machine \(Linux arm64\)/);
  assert.throws(() => pick('win32', 'ia32', 'portable'), /no build for this machine \(Windows ia32\)/);
});

test('selectAsset: GitHub entries still use the original picker, unchanged', () => {
  const gh = { owner: 'blender', repo: 'blender', type: 'portable' };
  // Deliberately the old behaviour: an Intel Mac is offered the arm64 image. Tightening
  // this for GitHub is a separate decision; this test pins that sources did not change it.
  assert.equal(sources.selectAsset(gh, rel(BLENDER), { platform: 'darwin', arch: 'x64' }).name, 'blender-5.3.0-macos-arm64.dmg');
});

test('selectAsset: a hand-pinned asset pattern always wins', () => {
  const e = { ...folderEntry('portable'), asset: '*linux-x64*' };
  assert.equal(sources.selectAsset(e, rel(BLENDER), { platform: 'win32', arch: 'x64' }).name, 'blender-5.3.0-linux-x64.tar.xz');
});

const explicit = (over) => ({ name: 'a.msi', browser_download_url: 'https://v.example/a.msi', platform: 'win32', arch: 'x64', type: 'installer', kind: 'msi', ...over });

test('selectAsset: manifest assets are chosen on stated facts, native before emulated', () => {
  const assets = [
    explicit({ name: 'x64.msi', arch: 'x64' }),
    explicit({ name: 'arm64.msi', arch: 'arm64' }),
    explicit({ name: 'x86.msi', arch: 'ia32' }),
    explicit({ name: 'mac.dmg', platform: 'darwin', arch: 'arm64', type: 'portable', kind: 'dmg' }),
  ];
  const e = folderEntry('installer');
  const pick = (platform, arch) => sources.selectAsset(e, rel(assets), { platform, arch }).name;
  assert.equal(pick('win32', 'x64'), 'x64.msi');
  assert.equal(pick('win32', 'arm64'), 'arm64.msi');
  assert.equal(pick('win32', 'ia32'), 'x86.msi');
  // arm64 Windows may fall back to x64 under emulation, but only when no native build exists.
  assert.equal(sources.selectAsset(e, rel(assets.filter((a) => a.arch !== 'arm64')), { platform: 'win32', arch: 'arm64' }).name, 'x64.msi');
  // An Intel Mac cannot run arm64 at all.
  assert.throws(() => sources.selectAsset(folderEntry('portable'), rel(assets), { platform: 'darwin', arch: 'x64' }), /no build for this machine \(macOS x64\)/);
});

test('selectAsset: unsupported rows are reported with their reason, never installed', () => {
  const assets = [explicit({ name: 'a.msix', kind: undefined, unsupported: 'MSIX packages are not supported' })];
  assert.throws(() => sources.selectAsset(folderEntry('installer'), rel(assets), { platform: 'win32', arch: 'x64' }), /not installable by git-updater: MSIX packages are not supported/);
});

test('selectAsset: the wrong package type points at the type that exists', () => {
  const assets = [explicit({ name: 'p.zip', type: 'portable', kind: 'zip' })];
  assert.throws(() => sources.selectAsset(folderEntry('installer'), rel(assets), { platform: 'win32', arch: 'x64' }), /only lists portable builds for Windows.*change its type to Portable/);
});

test('selectAsset: flavor, scope and locale break ties in that order', () => {
  const assets = [
    explicit({ name: 'user-exe', kind: 'nsis', scope: 'user' }),
    explicit({ name: 'machine-exe', kind: 'nsis', scope: 'machine' }),
    explicit({ name: 'machine-msi', kind: 'msi', scope: 'machine' }),
    explicit({ name: 'machine-msi-de', kind: 'msi', scope: 'machine', locale: 'de-DE' }),
  ];
  const e = folderEntry('installer');
  const host = { platform: 'win32', arch: 'x64' };
  assert.equal(sources.selectAsset(e, rel(assets), { ...host, flavor: 'exe' }).name, 'machine-exe');
  assert.equal(sources.selectAsset(e, rel(assets), { ...host, flavor: 'msi' }).name, 'machine-msi');
  assert.equal(sources.selectAsset({ ...e, install: { scope: 'user' } }, rel(assets), { ...host, flavor: 'exe' }).name, 'user-exe');
  assert.equal(sources.selectAsset({ ...e, install: { locale: 'de-DE' } }, rel(assets), { ...host, flavor: 'msi' }).name, 'machine-msi-de');
});

// --- checksums --------------------------------------------------------------------

const HEX = 'a'.repeat(64);

test('parseSums: shared sums files, starred names, paths, and bare per-file hashes', () => {
  assert.deepEqual(sources.parseSums(`${HEX}  blender-5.3.0-windows-x64.zip\n${'b'.repeat(64)}  other.zip\n`, 'blender-5.3.0-windows-x64.zip', 'blender-5.3.0.sha256'), { algo: 'sha256', expected: HEX });
  assert.deepEqual(sources.parseSums(`${HEX} *dir/file.exe\n`, 'file.exe', 'SHA256SUMS'), { algo: 'sha256', expected: HEX });
  assert.deepEqual(sources.parseSums(`${'c'.repeat(128)}  f.zip`, 'f.zip', 'sha512sums.txt'), { algo: 'sha512', expected: 'c'.repeat(128) });
  assert.deepEqual(sources.parseSums(`${HEX}\n`, 'f.zip', 'f.zip.sha256'), { algo: 'sha256', expected: HEX });
  // A bare hash in a file that does not belong to this asset proves nothing about it.
  assert.equal(sources.parseSums(`${HEX}\n`, 'f.zip', 'other.zip.sha256'), null);
  assert.equal(sources.parseSums(`${HEX}  other.zip\n`, 'f.zip', 'SHA256SUMS'), null);
});

test('resolveChecksum: pinned vs published vs none', async () => {
  const e = folderEntry('portable');
  const a = { name: 'f.zip', browser_download_url: 'https://h.example/f.zip' };
  // gitea is an 'optional' provider: an asset digest is "published".
  assert.deepEqual(await sources.resolveChecksum(e, rel([{ ...a, digest: `sha256:${HEX}` }]), { ...a, digest: `sha256:${HEX}` }, stubCtx()),
    { digest: `sha256:${HEX}`, state: 'published', note: null });
  // A shared sums file beside the asset.
  const sums = { name: 'release.sha256', browser_download_url: 'https://h.example/release.sha256' };
  const got = await sources.resolveChecksum(e, rel([a, sums]), a, stubCtx({ 'https://h.example/release.sha256': `${HEX}  f.zip\n` }));
  assert.equal(got.state, 'published');
  assert.equal(got.digest, `sha256:${HEX}`);
  // Nothing published.
  assert.deepEqual(await sources.resolveChecksum(e, rel([a]), a, stubCtx()), { digest: null, state: 'none', note: 'no checksum published' });
});

test('resolveChecksum: a per-file hash for a DIFFERENT file is never borrowed', async () => {
  const e = folderEntry('portable');
  const a = { name: 'f.zip', browser_download_url: 'https://h.example/f.zip' };
  const wrong = { name: 'g.zip.sha256', browser_download_url: 'https://h.example/g.zip.sha256' };
  let asked = 0;
  const ctx = stubCtx({ 'https://h.example/g.zip.sha256': `${HEX}\n` });
  const real = ctx.net.getText;
  ctx.net.getText = async (u) => { asked++; return real(u); };
  assert.equal((await sources.resolveChecksum(e, rel([a, wrong]), a, ctx)).state, 'none');
  assert.equal(asked, 0);
});

test('resolveChecksum: GitHub entries use the existing sums lookup', async () => {
  const real = github.fetchChecksumFromRelease;
  github.fetchChecksumFromRelease = async () => ({ algo: 'sha256', expected: HEX });
  try {
    const got = await sources.resolveChecksum({ owner: 'a', repo: 'b', type: 'portable' }, rel([]), { name: 'f.zip' }, stubCtx());
    assert.deepEqual(got, { digest: `sha256:${HEX}`, state: 'published', note: 'verified via release checksums file' });
  } finally {
    github.fetchChecksumFromRelease = real;
  }
});

test('downloadPolicy: GitHub untouched; forges HTTPS; pinned mirrors HTTPS; the rest no redirects', () => {
  assert.deepEqual(sources.downloadPolicy({ owner: 'a', repo: 'b', type: 'portable' }, {}, null), {});
  assert.deepEqual(sources.downloadPolicy(folderEntry('portable'), {}, { digest: null }), { httpsOnly: true, noRedirect: false });
});

// --- resolver ---------------------------------------------------------------------

test('resolve: GitHub URLs and bare owner/repo', async () => {
  for (const input of ['https://github.com/ShareX/ShareX/releases', 'github.com/ShareX/ShareX', 'ShareX/ShareX']) {
    const r = await sources.resolve(input, stubCtx());
    assert.equal(r.kind, 'url');
    assert.deepEqual(r.candidates.map((c) => c.source), [{ type: 'github', owner: 'ShareX', repo: 'ShareX' }], input);
  }
});

test('resolve: GitLab and Codeberg URLs, including nested groups and page routes', async () => {
  const gl = await sources.resolve('https://gitlab.com/gitlab-org/gitlab-runner/-/releases', stubCtx());
  assert.deepEqual(gl.candidates[0].source, { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' });
  assert.equal(gl.candidates[0].listedBy, 'GitLab');
  const nested = await sources.resolve('gitlab.com/kicad/code/kicad', stubCtx());
  assert.equal(nested.candidates[0].source.project, 'kicad/code/kicad');
  const cb = await sources.resolve('https://codeberg.org/forgejo/forgejo', stubCtx());
  assert.deepEqual(cb.candidates[0].source, { type: 'gitea', host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo' });
  assert.equal(cb.candidates[0].listedBy, 'Codeberg');
});

test('resolve: plain http is refused outright', async () => {
  await assert.rejects(sources.resolve('http://codeberg.org/forgejo/forgejo', stubCtx()), /only https/);
});

test('resolve: an unrecognised host is probed for a forge API before giving up', async () => {
  const ctx = stubCtx({ 'https://git.example.org/api/v1/repos/team/tool/releases?limit=1': [] });
  const r = await sources.resolve('https://git.example.org/team/tool', ctx);
  assert.deepEqual(r.candidates[0].source, { type: 'gitea', host: 'git.example.org', owner: 'team', repo: 'tool' });
  await assert.rejects(sources.resolve('https://nothing.example.org/a/b', stubCtx()), /no supported source found/);
});

test('resolve: a name consults only the curated lookups it is given', async () => {
  const seen = [];
  const r = await sources.resolve('handbrake', stubCtx(), {
    catalog: async (name, platform) => { seen.push([name, platform]); return [{ source: { type: 'github', owner: 'HandBrake', repo: 'HandBrake' }, name: 'HandBrake', curated: true, exact: true }]; },
  });
  assert.equal(r.kind, 'name');
  assert.deepEqual(seen, [['handbrake', 'win32']]);
  assert.equal(r.candidates.length, 1);
  assert.equal((await sources.resolve('   ', stubCtx())).candidates.length, 0);
});

test('autoPick: only with a preference, and only for one established identity', () => {
  const gh = { source: { type: 'github', owner: 'a', repo: 'b' }, curated: true, exact: true };
  const gl = { source: { type: 'gitlab', host: 'gitlab.com', project: 'a/b' }, exact: true };
  const fuzzy = { source: { type: 'gitlab', host: 'gitlab.com', project: 'c/d' }, exact: false };
  assert.equal(sources.autoPick([gh, gl], []), null, 'no preference -> always ask');
  assert.equal(sources.autoPick([gh, gl], ['gitlab', 'github']), gl);
  assert.equal(sources.autoPick([gh, gl], ['github']), gh);
  assert.equal(sources.autoPick([fuzzy], ['gitlab']), null, 'a fuzzy match is never added unprompted');
  assert.equal(sources.autoPick([gl, { ...gl, source: { ...gl.source, project: 'a/b-esr' } }], ['gitlab']), null, 'two exact editions -> ask');
  assert.equal(sources.autoPick([{ ...gl, explicit: true }], ['gitlab']), null, 'a pasted URL is always explicit');
});

// --- inspect ----------------------------------------------------------------------

test('inspect: per-type availability with file, host and checksum state, no download', async () => {
  const list = fx('gitlab', 'gitlab-runner-releases.json');
  const ctx = stubCtx({
    'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/releases?per_page=20': list,
    'https://gitlab-runner-downloads.s3.amazonaws.com/v19.6.0/release.sha256': `${HEX}  binaries/gitlab-runner-windows-amd64.zip\n`,
  });
  const info = await sources.inspect({ source: { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' } }, ctx, { platform: 'win32', arch: 'x64' });
  assert.equal(info.version, '19.6.0');
  assert.equal(info.listedBy, 'GitLab');
  assert.equal(info.types.portable.ok, true);
  assert.equal(info.types.portable.file, 'gitlab-runner-windows-amd64.zip');
  assert.equal(info.types.portable.host, 'gitlab-runner-downloads.s3.amazonaws.com');
  assert.equal(info.types.portable.checksum, 'published');
  assert.equal(info.types.installer.ok, false);
});

test('redact: query strings and credentials never reach the screen or the log', () => {
  assert.equal(sources.redact('https://h.example/f.zip?token=SECRET&x=1'), 'https://h.example/f.zip?…');
  assert.equal(sources.redact('https://u:p@h.example/f.zip'), 'https://h.example/f.zip');
});
