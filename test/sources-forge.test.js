'use strict';

// GitLab and Gitea/Forgejo providers, driven from trimmed captures of the real APIs
// (gitlab.com gitlab-org/gitlab-runner, codeberg.org forgejo/forgejo). No network.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gitlab = require('../src/sources/gitlab');
const gitea = require('../src/sources/gitea');
const sources = require('../src/sources');
const core = require('../src/core');

const fx = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sources', ...p), 'utf8'));
const ctxFor = (routes) => ({
  net: {
    getJson: async (url) => {
      if (!(url in routes)) throw Object.assign(new Error('404'), { status: 404 });
      return { status: 200, url, json: routes[url] };
    },
  },
});

// --- GitLab -----------------------------------------------------------------------

const RUNNER = { type: 'gitlab', host: 'gitlab.com', project: 'gitlab-org/gitlab-runner' };
const RUNNER_API = 'https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/releases?per_page=20';

test('gitlab.parseUrl: claims gitlab hosts, keeps nested paths, drops page routes', () => {
  assert.deepEqual(gitlab.parseUrl('https://gitlab.com/gitlab-org/gitlab-runner'), RUNNER);
  assert.deepEqual(gitlab.parseUrl('https://gitlab.com/gitlab-org/gitlab-runner/-/releases/v19.6.0'), RUNNER);
  assert.deepEqual(gitlab.parseUrl('https://gitlab.com/gitlab-org/gitlab-runner.git'), RUNNER);
  assert.equal(gitlab.parseUrl('https://gitlab.com/kicad/code/kicad').project, 'kicad/code/kicad');
  assert.equal(gitlab.parseUrl('https://invent.kde.org/graphics/krita').host, 'invent.kde.org');
  assert.equal(gitlab.parseUrl('https://gitlab.gnome.org/GNOME/gimp').host, 'gitlab.gnome.org');
  // Not ours: other hosts, a bare group, plain http, credentials, junk.
  assert.equal(gitlab.parseUrl('https://github.com/a/b'), null);
  assert.equal(gitlab.parseUrl('https://gitlab.com/onlygroup'), null);
  assert.equal(gitlab.parseUrl('http://gitlab.com/a/b'), null);
  assert.equal(gitlab.parseUrl('https://user:pw@gitlab.com/a/b'), null);
  assert.equal(gitlab.parseUrl('not a url'), null);
});

test('gitlab: identity and page URL', () => {
  assert.equal(gitlab.canonicalRef(RUNNER), 'gitlab.com/gitlab-org/gitlab-runner');
  assert.equal(gitlab.pageUrl(RUNNER), 'https://gitlab.com/gitlab-org/gitlab-runner/-/releases');
});

test('gitlab.getLatestRelease: highest version, attached links only, real file URLs', async () => {
  const list = fx('gitlab', 'gitlab-runner-releases.json');
  // Put the backport first: "latest" must be the highest version, not the first row.
  const rel = await gitlab.getLatestRelease(RUNNER, ctxFor({ [RUNNER_API]: [list[1], list[0]] }));
  assert.equal(rel.tag_name, 'v19.6.0');
  assert.equal(rel.provenance.listedBy, 'GitLab');
  assert.equal(rel.provenance.publisher, 'gitlab-org');
  const names = rel.assets.map((a) => a.name);
  assert.ok(names.includes('gitlab-runner-windows-amd64.zip'));
  assert.ok(names.includes('release.sha256'), 'the checksums link is kept so the registry can find it');
  // Auto-generated source archives are never offered.
  assert.ok(!names.some((n) => /^gitlab-runner-v19\.6\.0\.(zip|tar)/.test(n)));
  assert.ok(rel.assets.every((a) => a.browser_download_url.startsWith('https://')));
  // The real location, not the permalink that redirects to it.
  const win = rel.assets.find((a) => a.name === 'gitlab-runner-windows-amd64.zip');
  assert.equal(new URL(win.browser_download_url).host, 'gitlab-runner-downloads.s3.amazonaws.com');
});

test('gitlab.getLatestRelease: upcoming releases are skipped; nothing usable is "unavailable"', async () => {
  const list = fx('gitlab', 'gitlab-runner-releases.json');
  const future = { ...list[0], tag_name: 'v99.0.0', upcoming_release: true };
  const rel = await gitlab.getLatestRelease(RUNNER, ctxFor({ [RUNNER_API]: [future, list[1]] }));
  assert.equal(rel.tag_name, 'v19.3.6');
  await assert.rejects(gitlab.getLatestRelease(RUNNER, ctxFor({ [RUNNER_API]: [] })), (e) => e.unavailable === true);
  await assert.rejects(gitlab.getLatestRelease(RUNNER, ctxFor({})), /project not found/);
});

test('gitlab: non-https links are dropped', async () => {
  const rel = await gitlab.getLatestRelease(RUNNER, ctxFor({
    [RUNNER_API]: [{ tag_name: 'v1', assets: { links: [{ name: 'a', url: 'http://plain.example/a.zip' }, { name: 'b', url: 'https://ok.example/b.zip' }] } }],
  }));
  assert.deepEqual(rel.assets.map((a) => a.name), ['b.zip']);
});

// --- Gitea / Forgejo --------------------------------------------------------------

const FORGEJO = { type: 'gitea', host: 'codeberg.org', owner: 'forgejo', repo: 'forgejo' };
const FORGEJO_API = 'https://codeberg.org/api/v1/repos/forgejo/forgejo/releases?limit=20';

test('gitea.parseUrl: Codeberg and gitea-named hosts only', () => {
  assert.deepEqual(gitea.parseUrl('https://codeberg.org/forgejo/forgejo'), FORGEJO);
  assert.deepEqual(gitea.parseUrl('https://codeberg.org/forgejo/forgejo/releases/tag/v17.0.2'), FORGEJO);
  assert.equal(gitea.parseUrl('https://gitea.example.org/a/b').host, 'gitea.example.org');
  assert.equal(gitea.parseUrl('https://example.org/a/b'), null);
  assert.equal(gitea.parseUrl('http://codeberg.org/a/b'), null);
  assert.equal(gitea.parseUrl('https://codeberg.org/onlyowner'), null);
});

test('gitea.getLatestRelease: highest version wins over publication order', async () => {
  const list = fx('gitea', 'codeberg-forgejo-releases.json');
  assert.deepEqual(list.map((r) => r.tag_name), ['v17.0.2', 'v15.0.12', 'v17.0.1'], 'fixture is in the real, non-version order');
  const rel = await gitea.getLatestRelease(FORGEJO, ctxFor({ [FORGEJO_API]: [list[1], list[2], list[0]] }));
  assert.equal(rel.tag_name, 'v17.0.2');
  assert.equal(rel.provenance.listedBy, 'Codeberg');
  assert.ok(rel.assets.some((a) => a.name === 'forgejo-17.0.2-linux-amd64.sha256'));
  assert.ok(rel.assets.every((a) => typeof a.size === 'number'));
});

test('gitea.getLatestRelease: drafts never; prereleases only when asked', async () => {
  const list = fx('gitea', 'codeberg-forgejo-releases.json');
  const rc = { ...list[0], tag_name: 'v18.0.0-rc1', prerelease: true };
  const draft = { ...list[0], tag_name: 'v19.0.0', draft: true };
  const routes = { [FORGEJO_API]: [draft, rc, ...list] };
  assert.equal((await gitea.getLatestRelease(FORGEJO, ctxFor(routes))).tag_name, 'v17.0.2');
  assert.equal((await gitea.getLatestRelease(FORGEJO, ctxFor(routes), { prerelease: true })).tag_name, 'v18.0.0-rc1');
});

test('gitea.probe: recognises an unknown host that speaks the API, and only then', async () => {
  const url = 'https://git.example.org/team/tool';
  assert.deepEqual(
    await gitea.probe(url, ctxFor({ 'https://git.example.org/api/v1/repos/team/tool/releases?limit=1': [] })),
    { type: 'gitea', host: 'git.example.org', owner: 'team', repo: 'tool' }
  );
  assert.equal(await gitea.probe(url, ctxFor({})), null);
  assert.equal(await gitea.probe(url, ctxFor({ 'https://git.example.org/api/v1/repos/team/tool/releases?limit=1': { message: 'nope' } })), null);
});

test('Forgejo on Linux: the source tarball is never taken for the app', async () => {
  // Real release: bare binaries (forgejo-17.0.2-linux-amd64), their .xz, and
  // forgejo-src-17.0.2.tar.gz. Nothing there is an unpackable Linux build, so the honest
  // answer is "no Linux portable asset" — not a folder full of source code.
  const list = fx('gitea', 'codeberg-forgejo-releases.json');
  const rel = await gitea.getLatestRelease(FORGEJO, ctxFor({ [FORGEJO_API]: list }));
  assert.ok(rel.assets.some((a) => a.name === 'forgejo-src-17.0.2.tar.gz'), 'the fixture does contain the source tarball');
  const entry = sources.normalizeEntry({ type: 'portable', name: 'Forgejo', source: { ...FORGEJO } });
  for (const arch of ['x64', 'arm64']) {
    assert.throws(() => sources.selectAsset(entry, rel, { platform: 'linux', arch }), /no Linux portable asset/, arch);
  }
  // The rule lives in the shared picker, so a GitHub release shaped the same way is covered too.
  assert.throws(() => core.pickAsset([{ name: 'tool-src-1.2.3.tar.gz' }, { name: 'tool_src.tar.xz' }], 'portable', 'x64', null, 'linux'), /no Linux portable asset/);
  // ...without catching real builds that merely contain those letters.
  assert.equal(core.pickAsset([{ name: 'srcery-1.0-linux-x86_64.tar.gz' }], 'portable', 'x64', null, 'linux').name, 'srcery-1.0-linux-x86_64.tar.gz');
});
