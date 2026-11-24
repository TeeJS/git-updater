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
// The asset's name has to be one the RUNNING platform's picker accepts, because these
// tests go through the real selection. A bare "payload.zip" is fine on Windows and macOS,
// but on Linux a .zip only counts when its name says Linux (see src/platform/assets.js) —
// the first Linux run of this file failed ten tests for exactly that reason.
const FILE = process.platform === 'linux' ? 'payload_linux.zip' : 'payload.zip';
const API = 'https://codeberg.org/api/v1/repos/team/tool/releases?limit=20';
const FILE_URL = `https://codeberg.org/team/tool/releases/download/v2.0.0/${FILE}`;
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
  const assets = [{ name: FILE, size: bytes.length, browser_download_url: FILE_URL }];
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
    return { status: 200, url, text: `${opts.sums === 'mismatch' ? 'f'.repeat(64) : sha}  ${FILE}\n` };
  };
  // (url, destPath, onProgress, maxBytes, policy) — the size cap comes before the policy.
  github.downloadAsset = async (url, file, _progress, maxBytes, policy = {}) => {
    calls.download.push({ url, maxBytes, policy: { httpsOnly: policy.httpsOnly, noRedirect: policy.noRedirect } });
    fs.writeFileSync(file, bytes);
    if (policy.onFinalUrl) policy.onFinalUrl(opts.servedFrom || url);
  };
  github.getLatestRelease = async () => ({ tag_name: 'v2.0.0', assets: [{ name: FILE, browser_download_url: `https://github.invalid/${FILE}` }] });
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
    assert.equal(r.file, FILE);
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
    assert.deepEqual(calls.download, [{ url: FILE_URL, maxBytes: 500 * 1024 * 1024, policy: { httpsOnly: true, noRedirect: false } }]);
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
    // Nothing is recorded as installed. Only the failure is kept, so the row stays red after a restart.
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))[KEY];
    assert.equal(saved.tag, undefined);
    assert.equal(saved.version, undefined);
    assert.match(saved.lastFailure.reason, /checksum mismatch/);
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

// --- shared preflight (Sol's review) ----------------------------------------------

// A release whose assets state what they are, for THIS host, so the test is the same on
// every platform the suite runs on.
const manifestRel = (over) => ({
  tag_name: '9.0.0',
  html_url: 'https://codeberg.org/team/tool/releases',
  provenance: { listedBy: 'Codeberg', listingUrl: 'https://codeberg.org/team/tool/releases' },
  assets: [{
    name: FILE, browser_download_url: FILE_URL,
    platform: process.platform, arch: process.arch, type: 'portable', kind: 'zip', ...over,
  }],
});
async function withRelease(rel, opts, fn) {
  const real = sources.getLatestRelease;
  sources.getLatestRelease = async () => rel;
  try {
    return await withWorld(opts, fn);
  } finally {
    sources.getLatestRelease = real;
  }
}

test('preflight: an upgrade the listing forbids is blocked in check, dry-run AND update; a fresh install is not', async () => {
  for (const upgradeBehavior of ['deny', 'uninstallPrevious']) {
    const rel = manifestRel({ upgradeBehavior });
    await withRelease(rel, {}, async ({ entry, statePath, calls }) => {
      // Fresh: nothing installed, nothing recorded.
      const fresh = await runner.run({ repos: [entry] }, { mode: 'check', statePath });
      assert.equal(fresh.results[0].status, 'updated', `${upgradeBehavior}: a fresh install is allowed`);
      // Installed at an older version: every mode gives the same refusal.
      fs.writeFileSync(statePath, JSON.stringify({ [KEY]: { tag: '8.0.0', version: '8.0.0' } }));
      fs.writeFileSync(path.join(entry.install.dir, 'old.txt'), 'v8');
      const want = upgradeBehavior === 'deny' ? /cannot be upgraded in place/ : /must be uninstalled first/;
      for (const o of [{ mode: 'check' }, { dryRun: true }, {}]) {
        const { results } = await runner.run({ repos: [entry] }, { ...o, statePath });
        assert.equal(results[0].status, 'failed', JSON.stringify(o));
        assert.match(results[0].reason, want);
        assert.match(results[0].reason, /^Codeberg says/);
        assert.equal(results[0].file, FILE, 'a blocked result still names the file');
      }
      assert.equal(calls.download.length, 0);
    });
  }
});

// --- a listing's switches reach the installer (WinGet's install / upgrade / verbatim sets) ----

const install = require('../src/install');
// Runs one update of an installer-type entry against `over` (extra asset fields) and returns
// what install.installInstaller was asked to run.
async function installedWith(over, opts = {}) {
  const seen = [];
  const real = install.installInstaller;
  install.installInstaller = (file, how) => { seen.push({ file, how, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.readFileSync(file) : null }); return { status: 0 }; };
  try {
    await withRelease(manifestRel({ type: 'installer', kind: 'nsis', ...over }), opts, async ({ entry, statePath }) => {
      entry.type = 'installer';
      delete entry.install;
      if (opts.pinned) entry.install = { args: opts.pinned };
      if (opts.bytes) github.downloadAsset = async (url, file) => { fs.writeFileSync(file, opts.bytes); };
      const { results } = await runner.run({ repos: [entry] }, { statePath });
      seen.result = results[0];
    });
  } finally {
    install.installInstaller = real;
  }
  return seen;
}

test('installer switches: a first install gets the install set; an upgrade gets the listing\'s upgrade set', async () => {
  const sets = { installArgs: ['/S', '/currentuser'], upgradeArgs: ['/S', '/currentuser', '--updated'] };
  const fresh = await installedWith(sets);
  assert.equal(fresh.length, 1, JSON.stringify(fresh.result));
  assert.deepEqual(fresh[0].how.args, ['/S', '/currentuser']);
  assert.equal(fresh[0].how.rawArgs, undefined);

  const upgrade = await installedWith(sets, { installed: '8.0.0' });
  assert.deepEqual(upgrade[0].how.args, ['/S', '/currentuser', '--updated'], 'an older version is on the machine');

  // A listing with no upgrade set uses its install set both times.
  const plain = await installedWith({ installArgs: ['/S'] }, { installed: '8.0.0' });
  assert.deepEqual(plain[0].how.args, ['/S']);
});

test('installer switches: a verbatim string is handed over whole; switches pinned in config beat any listing', async () => {
  const vc2005 = '/Q /C:"msiexec /i ""vcredist.msi"" /quiet /norestart"';
  const raw = await installedWith({ kind: 'exe', installArgsRaw: vc2005 });
  assert.equal(raw.length, 1, 'an .exe with a verbatim string runs silently instead of opening its window');
  assert.equal(raw[0].how.kind, 'exe');
  assert.equal(raw[0].how.args, undefined);
  assert.equal(raw[0].how.rawArgs, vc2005);

  const upgraded = await installedWith({ installArgs: ['/S'], upgradeArgsRaw: '/S /update="yes please"' }, { installed: '8.0.0' });
  assert.equal(upgraded[0].how.rawArgs, '/S /update="yes please"');
  assert.equal(upgraded[0].how.args, undefined);

  const pinned = await installedWith({ installArgsRaw: vc2005, upgradeArgs: ['/S', '/update'] }, { installed: '8.0.0', pinned: ['/S', '/D=C:\\Mine'] });
  assert.deepEqual(pinned[0].how.args, ['/S', '/D=C:\\Mine']);
  assert.equal(pinned[0].how.rawArgs, undefined);
});

test('installer switches: a listing that states its .exe needs none runs it with nothing added (Discord)', async () => {
  const bare = await installedWith({ kind: 'exe', switchless: true });
  assert.equal(bare.length, 1, `runs silently instead of opening its window: ${JSON.stringify(bare.result)}`);
  assert.equal(bare[0].how.kind, 'exe');
  assert.equal(bare[0].how.switchless, true);
  assert.equal(bare[0].how.args, undefined);
  assert.equal(bare[0].how.rawArgs, undefined);

  // Switches pinned in config still win, and the flag no longer applies.
  const pinned = await installedWith({ kind: 'exe', switchless: true }, { pinned: ['-s'] });
  assert.deepEqual(pinned[0].how.args, ['-s']);
  assert.equal(pinned[0].how.switchless, false);

  // The flag means nothing for a kind that has switches of its own.
  const nsis = await installedWith({ kind: 'nsis', switchless: true });
  assert.equal(nsis[0].how.kind, 'nsis');
  assert.equal(nsis[0].how.switchless, false);
});

test('an installer delivered inside a zip: the named setup program is unpacked and that is what runs', async () => {
  const zip = new AdmZip();
  zip.addFile('CuteWriter.exe', Buffer.from('the-setup-program'));
  zip.addFile('readme.txt', Buffer.from('hello'));
  const seen = await installedWith({ kind: 'inno', nested: 'CuteWriter.exe' }, { bytes: zip.toBuffer() });
  assert.equal(seen.length, 1, JSON.stringify(seen.result));
  assert.equal(path.basename(seen[0].file), 'CuteWriter.exe', 'not the zip');
  assert.equal(seen[0].exists, true);
  assert.equal(seen[0].bytes.toString(), 'the-setup-program');
  assert.equal(seen[0].how.kind, 'inno');

  // A zip that does not hold the file it names fails that row instead of running anything.
  const missing = await installedWith({ kind: 'inno', nested: 'Other.exe' }, { bytes: zip.toBuffer() });
  assert.equal(missing.length, 0);
  assert.equal(missing.result.status, 'failed');
  assert.match(missing.result.reason, /does not contain the installer it names/);
});

test('a packaged app (MSIX) is never run: it is opened in Windows\' own App Installer window', async () => {
  const seen = [];
  const opened = [];
  const real = install.installInstaller;
  install.installInstaller = (...a) => { seen.push(a); return { status: 0 }; };
  try {
    await withRelease(manifestRel({ name: 'WindowsApp_x64.msix', type: 'installer', kind: 'msix' }), {}, async ({ entry, statePath }) => {
      entry.type = 'installer';
      delete entry.install;
      const { results } = await runner.run({ repos: [entry] }, { statePath, openFile: (f) => opened.push(f) });
      assert.equal(results[0].status, 'failed');
      assert.match(results[0].reason, /^installer window opened — choose Install in the App Installer window/, 'the wording the window waits on');
      assert.equal(opened.length, 1);
      assert.equal(path.basename(opened[0]), 'WindowsApp_x64.msix');
      assert.ok(fs.existsSync(opened[0]), 'the file outlives the staging cleanup');
      // A scheduled run opens nothing and says why.
      const again = await runner.run({ repos: [entry] }, { statePath, unattended: true, openFile: (f) => opened.push(f) });
      assert.match(again.results[0].reason, /App Installer window, so it was not run unattended/);
      assert.equal(opened.length, 1);
    });
    assert.equal(seen.length, 0, 'no installer process is ever started for it');
  } finally {
    install.installInstaller = real;
  }
});

test('preflight: dry-run honours "only install files that have a checksum"', async () => {
  await withWorld({}, async ({ entry, statePath, calls }) => {
    const { results } = await runner.run({ requireChecksum: true, repos: [entry] }, { dryRun: true, statePath });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /no checksum is published/);
    assert.equal(calls.download.length, 0);
  });
});

test('preflight: a GitHub CHECK honours the checksum setting; with it off the check makes no selection', async () => {
  await withWorld({}, async ({ dir, statePath }) => {
    const gh = { owner: 'acme', repo: 'tool', type: 'portable', install: { dir } };
    const on = await runner.run({ requireChecksum: true, repos: [gh] }, { mode: 'check', statePath });
    assert.equal(on.results[0].status, 'failed');
    assert.match(on.results[0].reason, /no checksum is published/);
    const off = await runner.run({ repos: [gh] }, { mode: 'check', statePath });
    assert.equal(off.results[0].status, 'updated');
    assert.equal(off.results[0].file, undefined, 'the legacy check stays a version comparison only');
  });
});

test('a listing cannot stage a file outside the staging directory', async () => {
  for (const name of ['../../evil.zip', 'sub/evil.zip', 'C:evil.zip']) {
    const rel = manifestRel({ name });
    await withRelease(rel, {}, async ({ entry, dir, statePath, calls }) => {
      const { results } = await runner.run({ repos: [entry] }, { statePath });
      assert.equal(results[0].status, 'failed', name);
      assert.match(results[0].reason, /not safe to save/);
      assert.equal(calls.download.length, 0, 'refused before any write');
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  }
});

test('a declared but malformed checksum blocks the install', async () => {
  await withRelease(manifestRel({ digest: 'sha256:nothex' }), {}, async ({ entry, statePath, calls }) => {
    const { results } = await runner.run({ repos: [entry] }, { statePath });
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /malformed checksum/);
    assert.equal(calls.download.length, 0);
  });
});

test('an emulated pick is reported as such', async () => {
  // Only meaningful where emulation exists; elsewhere the foreign build is simply absent.
  const emulable = process.arch === 'arm64' && (process.platform === 'win32' || process.platform === 'darwin');
  await withRelease(manifestRel({ arch: 'x64' }), {}, async ({ entry, statePath }) => {
    const { results } = await runner.run({ repos: [entry] }, { mode: 'check', statePath });
    if (emulable) {
      assert.equal(results[0].status, 'updated');
      assert.equal(results[0].emulated, true);
    } else if (process.arch !== 'x64') {
      assert.equal(results[0].status, 'failed');
      assert.match(results[0].reason, /no build for this machine/);
    } else {
      assert.equal(results[0].emulated, undefined);
    }
  });
});

test('two apps can never share one portable folder when either comes from a source', async () => {
  await withWorld({ sums: 'match' }, async ({ entry, dir, statePath }) => {
    const twin = { owner: 'x', repo: 'y', type: 'portable', name: 'Tool', source: { type: 'gitea', host: 'codeberg.org', owner: 'other', repo: 'tool' }, install: { dir } };
    // BOTH are blocked: config order does not say which app owns the files already there.
    const { results } = await runner.run({ repos: [entry, twin] }, { mode: 'check', statePath });
    assert.deepEqual(results.map((r) => r.status), ['failed', 'failed']);
    for (const r of results) assert.match(r.reason, /portable folder .* is also used by Tool .*give each its own install\.dir/);
    // ...and that holds when the run is narrowed to just one of them.
    const one = await runner.run({ repos: [entry, twin] }, { mode: 'check', statePath, only: KEY });
    assert.equal(one.results.length, 1);
    assert.equal(one.results[0].status, 'failed');
    // Two plain GitHub entries sharing a folder keep their old behaviour.
    const a = { owner: 'acme', repo: 'tool', type: 'portable', install: { dir } };
    const b = { owner: 'other', repo: 'tool', type: 'portable', install: { dir } };
    const gh = await runner.run({ repos: [a, b] }, { mode: 'check', statePath });
    assert.deepEqual(gh.results.map((r) => r.status), ['updated', 'updated']);
  });
});

test('--only matches a sourced app by its exact key or exact name, never case-folded', async () => {
  await withWorld({ sums: 'match' }, async ({ entry, statePath }) => {
    const run = (only) => runner.run({ repos: [entry] }, { mode: 'check', statePath, only });
    assert.equal((await run(KEY)).results.length, 1);
    assert.equal((await run('Tool')).results.length, 1);
    assert.equal((await run(KEY.toUpperCase())).results.length, 0);
    assert.equal((await run('tool')).results.length, 0);
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
