'use strict';

// The runner driving a NON-GitHub entry end to end: check-time eligibility, the checksum
// policy (and the "only install files that have a checksum" setting), the download
// policy, and the provenance written to results and state.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const github = require('../src/github');
const detect = require('../src/detect');
const net = require('../src/sources/net');
const sources = require('../src/sources');
const runner = require('../src/runner');
const core = require('../src/core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-src-runner-'));

const SOURCE = { type: 'gitea', host: 'codeberg.org', owner: 'team', repo: 'tool' };
const API = 'https://codeberg.org/api/v1/repos/team/tool/releases?limit=20';
const FILE_URL = 'https://codeberg.org/team/tool/releases/download/v2.0.0/payload.zip';
const SUMS_URL = 'https://codeberg.org/team/tool/releases/download/v2.0.0/SHA256SUMS';

function zipBytes() {
  const zip = new AdmZip();
  zip.addFile('app.txt', Buffer.from('v2'));
  return zip.toBuffer();
}

// Stubs every IO edge the runner touches. `opts.sums`: 'match' | 'mismatch' | undefined.
async function withWorld(opts, fn) {
  const bytes = zipBytes();
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const assets = [{ name: 'payload.zip', size: bytes.length, browser_download_url: FILE_URL }];
  if (opts.sums) assets.push({ name: 'SHA256SUMS', size: 80, browser_download_url: SUMS_URL });
  const real = {
    getJson: net.getJson, getText: net.getText,
    downloadAsset: github.downloadAsset, getLatestRelease: github.getLatestRelease,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    isRunning: detect.isRunning, clearCache: detect.clearCache,
    installedVersion: detect.installedVersion, installedFlavor: detect.installedFlavor,
  };
  const calls = { download: [], text: [] };
  net.getJson = async (url) => {
    assert.equal(url, API);
    return { status: 200, url, json: [{ tag_name: 'v2.0.0', html_url: 'https://codeberg.org/team/tool/releases/tag/v2.0.0', assets: opts.assets || assets }] };
  };
  net.getText = async (url) => {
    calls.text.push(url);
    return { status: 200, url, text: `${opts.sums === 'mismatch' ? 'f'.repeat(64) : sha}  payload.zip\n` };
  };
  github.downloadAsset = async (url, file, _progress, policy) => {
    calls.download.push({ url, policy: { httpsOnly: policy.httpsOnly, noRedirect: policy.noRedirect } });
    fs.writeFileSync(file, bytes);
    if (policy.onFinalUrl) policy.onFinalUrl(opts.servedFrom || url);
  };
  github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: [{ name: 'payload.zip', browser_download_url: 'https://github.invalid/payload.zip' }] });
  github.fetchChecksumFromRelease = async () => null;
  detect.clearCache = () => {};
  detect.isRunning = async () => false;
  detect.installedVersion = async () => opts.installed || null;
  detect.installedFlavor = async () => null;
  const dir = tmp();
  const statePath = path.join(tmp(), 'state.json');
  const entry = { owner: 'will-be-derived', repo: 'x', type: 'portable', name: 'Tool', source: { ...SOURCE }, install: { dir } };
  try {
    return await fn({ entry, dir, statePath, calls, sha });
  } finally {
    Object.assign(net, { getJson: real.getJson, getText: real.getText });
    Object.assign(github, { downloadAsset: real.downloadAsset, getLatestRelease: real.getLatestRelease, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, { isRunning: real.isRunning, clearCache: real.clearCache, installedVersion: real.installedVersion, installedFlavor: real.installedFlavor });
  }
}

const KEY = 'source.gitea/codeberg.org%2Fteam%2Ftool#portable';

test('check: a sourced app reports its source, the chosen file, its host and checksum state', async () => {
  await withWorld({ sums: 'match' }, async ({ entry, statePath }) => {
    const { results } = await runner.run({ repos: [entry] }, { mode: 'check', statePath });
    const r = results[0];
    assert.equal(r.status, 'updated');
    assert.equal(r.id, KEY, 'the key is derived from the source, not the stored owner/repo');
    assert.equal(r.repo, 'Tool', 'displayed by name, never by its opaque key');
    assert.deepEqual(r.source, { type: 'gitea', label: 'Codeberg', host: 'codeberg.org', pageUrl: 'https://codeberg.org/team/tool/releases' });
    assert.equal(r.file, 'payload.zip');
    assert.equal(r.fileHost, 'codeberg.org');
    assert.equal(r.checksum, 'published');
    assert.equal(r.to, '2.0.0');
  });
});

test('check: an app with no installable file fails the CHECK, not later at install', async () => {
  await withWorld({ assets: [{ name: 'tool-source.tar.gz', browser_download_url: 'https://codeberg.org/x/tool-source.tar.gz' }, { name: 'notes.txt', browser_download_url: 'https://codeberg.org/x/notes.txt' }] }, async ({ entry, statePath }) => {
    const { results } = await runner.run({ repos: [entry] }, { mode: 'check', statePath });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /no .* asset in release|only ships/);
    assert.equal(results[0].source.label, 'Codeberg', 'a failed row still says where it comes from');
  });
});

test('update: verifies a published checksum, installs, and records provenance', async () => {
  await withWorld({ sums: 'match', servedFrom: 'https://objects.codeberg.example/store/abc?sig=SECRET' }, async ({ entry, dir, statePath, calls }) => {
    const { results } = await runner.run({ repos: [entry] }, { statePath });
    const r = results[0];
    assert.equal(r.status, 'updated', r.reason);
    assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), 'v2');
    // The checksum was resolved BEFORE the download, and the download was HTTPS-only.
    assert.deepEqual(calls.text, [SUMS_URL]);
    assert.deepEqual(calls.download, [{ url: FILE_URL, policy: { httpsOnly: true, noRedirect: false } }]);
    assert.equal(r.checksum, 'published');
    assert.equal(r.fileHost, 'codeberg.org');
    assert.equal(r.servedFrom, 'objects.codeberg.example', 'a different final host is surfaced');
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'))[KEY];
    assert.equal(st.source, 'gitea');
    assert.equal(st.url, FILE_URL);
    assert.equal(st.fileHost, 'objects.codeberg.example');
    assert.equal(st.checksum, 'published');
    assert.ok(!JSON.stringify(st).includes('SECRET'), 'query strings are never stored');
  });
});

test('update: a checksum that does not match stops the install', async () => {
  await withWorld({ sums: 'mismatch' }, async ({ entry, dir, statePath }) => {
    const { results } = await runner.run({ repos: [entry] }, { statePath });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /checksum mismatch/);
    assert.equal(fs.existsSync(path.join(dir, 'app.txt')), false);
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('update: with no checksum published the file still installs, and says so', async () => {
  await withWorld({}, async ({ entry, dir, statePath }) => {
    const { results } = await runner.run({ repos: [entry] }, { statePath });
    assert.equal(results[0].status, 'updated', results[0].reason);
    assert.equal(results[0].checksum, 'none');
    assert.equal(results[0].note, 'no checksum published');
    assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), 'v2');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8'))[KEY].checksum, 'none');
  });
});

test('requireChecksum: on, a file with no checksum is refused BEFORE download — check and update', async () => {
  await withWorld({}, async ({ entry, dir, statePath, calls }) => {
    const cfg = { requireChecksum: true, repos: [entry] };
    const check = await runner.run(cfg, { mode: 'check', statePath });
    assert.equal(check.results[0].status, 'failed');
    assert.match(check.results[0].reason, /no checksum is published/);
    const upd = await runner.run(cfg, { statePath });
    assert.equal(upd.results[0].status, 'failed');
    assert.match(upd.results[0].reason, /Only install files that have a checksum/);
    assert.equal(calls.download.length, 0, 'nothing was downloaded');
    assert.equal(fs.existsSync(path.join(dir, 'app.txt')), false);
  });
});

test('requireChecksum: on, it applies to GitHub entries too', async () => {
  await withWorld({}, async ({ dir, statePath, calls }) => {
    const gh = { owner: 'acme', repo: 'tool', type: 'portable', install: { dir } };
    const upd = await runner.run({ requireChecksum: true, repos: [gh] }, { statePath });
    assert.equal(upd.results[0].status, 'failed');
    assert.match(upd.results[0].reason, /no checksum is published/);
    assert.equal(calls.download.length, 0);
    // Off (the default): the same GitHub entry installs exactly as it always has.
    const ok = await runner.run({ repos: [gh] }, { statePath });
    assert.equal(ok.results[0].status, 'updated', ok.results[0].reason);
    assert.deepEqual(calls.download[0].policy, { httpsOnly: undefined, noRedirect: undefined }, 'GitHub downloads carry no new restrictions');
  });
});

test('requireChecksum: on, a file WITH a checksum installs normally', async () => {
  await withWorld({ sums: 'match' }, async ({ entry, dir, statePath }) => {
    const { results } = await runner.run({ requireChecksum: true, repos: [entry] }, { statePath });
    assert.equal(results[0].status, 'updated', results[0].reason);
    assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), 'v2');
  });
});

test('an entry naming an unknown source fails on its own row and does not stop the run', async () => {
  await withWorld({ sums: 'match' }, async ({ entry, statePath }) => {
    const broken = { owner: 'a', repo: 'b', type: 'portable', name: 'Ghost', source: { type: 'teleport' }, install: { dir: tmp() } };
    const { results } = await runner.run({ repos: [broken, entry] }, { mode: 'check', statePath });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /unknown source type "teleport"/);
    assert.equal(results[1].status, 'updated');
  });
});

test('validateConfig: a sourced portable app unpacks into a folder named for the app', () => {
  const cfg = core.validateConfig({
    portableRoot: '/apps',
    repos: [{ owner: 'source.gitea', repo: 'codeberg.org%2Fteam%2Ftool', type: 'portable', name: 'Tool: Pro/Edition.', source: { ...SOURCE } }],
  });
  assert.equal(cfg.repos[0].install.dir, '/apps/Tool Pro Edition');
  assert.throws(() => core.validateConfig({ repos: [{ owner: 'a', repo: 'b', type: 'installer', source: { type: 'gitea' } }] }), /a "name" is required/);
  assert.throws(() => core.validateConfig({ repos: [{ owner: 'a', repo: 'b', type: 'installer', name: 'X', source: 'gitea' }] }), /"source" must be an object/);
  // Sanity: the registry agrees on the key the runner will use.
  assert.equal(sources.appKey(sources.normalizeEntry({ type: 'portable', name: 'Tool', source: { ...SOURCE } })), KEY);
});
