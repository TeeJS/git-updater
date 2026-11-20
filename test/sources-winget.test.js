'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const AdmZip = require('adm-zip');
const winget = require('../src/sources/winget');

const CDN = 'https://cdn.winget.microsoft.com/cache/';
const MICROSOFT_SEARCH = `${CDN}source2.msix`;
const MICROSOFT_MANIFESTS = `${CDN}source.msix`;
const FIXTURES = path.join(__dirname, 'fixtures', 'sources', 'winget');
const { packages } = require('./fixtures/sources/winget/index-rows.json');
const available = winget.available();
let scratch;
let archives;

function packageSource(packageId) {
  return { type: 'winget', packageId };
}

function fixture(row) {
  // The CDN serves CRLF, while Git may normalize line endings on checkout.
  return Buffer.from(fs.readFileSync(path.join(FIXTURES, row.fixture.replace(/\.txt$/, '')), 'utf8').replace(/\r?\n/g, '\r\n'));
}

function createIndex(file, major, seed) {
  const { DatabaseSync } = require('node:sqlite');
  const tempPath = path.join(scratch, file);
  const db = new DatabaseSync(tempPath);
  db.exec('CREATE TABLE metadata(name TEXT, value TEXT);');
  db.prepare("INSERT INTO metadata VALUES ('majorVersion', ?)").run(major);
  try {
    seed(db);
  } finally {
    db.close();
  }
  const zip = new AdmZip();
  zip.addFile('Public/index.db', fs.readFileSync(tempPath));
  fs.unlinkSync(tempPath);
  return zip.toBuffer();
}

function searchIndex() {
  return createIndex('search.db', '2', (db) => {
    db.exec('CREATE TABLE packages (id TEXT, name TEXT, moniker TEXT, latest_version TEXT);');
    const add = db.prepare('INSERT INTO packages VALUES (?, ?, ?, ?)');
    for (const row of packages) add.run(row.id, row.name, row.moniker, row.version);
    add.run('BlenderFoundation.Blender.LTS.4.5', 'Blender LTS', 'blender', '4.5.16');
    add.run('Missing.Package', 'Missing Package', 'missing-package', '3.0');
    // Mozilla publishes one package per language beside the main one, and real editions too.
    for (const locale of ['af', 'an', 'ar', 'en-GB', 'pt-BR', 'zh-CN', 'ast']) add.run(`Mozilla.Firefox.${locale}`, `Mozilla Firefox (${locale})`, null, '160.0.1');
    add.run('Mozilla.Firefox.ESR', 'Mozilla Firefox ESR', 'firefox-esr', '153.7.0');
    add.run('Mozilla.Firefox.DeveloperEdition', 'Firefox Developer Edition', null, '161.0');
  });
}

function manifestIndex(rows = packages) {
  return createIndex('manifests.db', '1', (db) => {
    db.exec(`
      CREATE TABLE ids(id TEXT);
      CREATE TABLE versions(version TEXT);
      CREATE TABLE channels(channel TEXT);
      CREATE TABLE pathparts(parent INTEGER, pathpart TEXT);
      CREATE TABLE manifest(id INTEGER, version INTEGER, channel INTEGER, pathpart INTEGER, hash BLOB);
      INSERT INTO channels VALUES ('');
    `);
    const addId = db.prepare('INSERT INTO ids VALUES (?)');
    const addVersion = db.prepare('INSERT INTO versions VALUES (?)');
    const addPart = db.prepare('INSERT INTO pathparts VALUES (?, ?)');
    const addManifest = db.prepare('INSERT INTO manifest VALUES (?, ?, 1, ?, ?)');
    for (const row of rows) {
      let parent = null;
      for (const part of row.url.slice(CDN.length).split('/')) parent = addPart.run(parent, part).lastInsertRowid;
      addManifest.run(addId.run(row.id).lastInsertRowid, addVersion.run(row.version).lastInsertRowid,
        parent, Buffer.from(row.manifestSha256, 'hex'));
    }
  });
}

function context(options = {}) {
  const requests = [];
  const data = new Map(archives);
  for (const [url, buffer] of options.replacements || []) data.set(url, buffer);
  const net = { getBuffer: async (url, { maxBytes }) => {
    requests.push(url);
    if (options.reject?.(url)) throw new Error('catalog temporarily unavailable');
    const buffer = data.get(url);
    assert.ok(buffer, `unexpected request ${url}`);
    assert.ok(buffer.length <= maxBytes);
    return { status: 200, url, buffer };
  } };
  return { ctx: { net, platform: 'win32', arch: 'x64', cacheDir: options.cacheDir || scratch, now: options.now || (() => Date.now()) }, requests };
}

before(() => {
  if (!available.ok) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-winget-test-'));
  archives = new Map([[MICROSOFT_SEARCH, searchIndex()], [MICROSOFT_MANIFESTS, manifestIndex()]]);
  for (const row of packages) archives.set(row.url, fixture(row));
});

after(() => {
  if (!scratch) return;
  for (const filename of fs.readdirSync(scratch)) fs.unlinkSync(path.join(scratch, filename));
  fs.rmdirSync(scratch);
});

test('WinGet identity is case-insensitive and round trips official package page URLs', () => {
  const source = packageSource('Microsoft.VCRedist.2015+.x64');
  assert.equal(winget.canonicalRef(source), 'microsoft.vcredist.2015+.x64');
  assert.deepEqual(winget.parseUrl(winget.pageUrl(source)), source);
  assert.equal(winget.parseUrl('https://github.com/microsoft/winget-pkgs'), null);
  assert.equal(winget.parseUrl('https://github.com/microsoft/winget-pkgs/tree/master/manifests/m/Microsoft/%2f'), null);
  assert.throws(() => winget.canonicalRef(packageSource('../anything')), /valid package ID/);
});

test('WinGet search uses the small index and never treats ambiguous monikers as exact', { skip: !available.ok }, async () => {
  const { ctx, requests } = context();
  const results = await winget.search('Blender', ctx);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => !result.exact));
  assert.equal((await winget.search('BlenderFoundation.Blender', ctx))[0].exact, true);
  assert.equal((await winget.search('vlc', ctx))[0].exact, true);
  assert.deepEqual(await winget.search('%_', ctx), []);
  assert.deepEqual(requests, [MICROSOFT_SEARCH]);
});

test('WinGet search leaves out per-language packages, keeps real editions, and an exact id means only that package', { skip: !available.ok }, async () => {
  const { ctx } = context();
  const ids = (await winget.search('firefox', ctx)).map((c) => c.source.packageId);
  assert.ok(ids.includes('Mozilla.Firefox'));
  assert.ok(ids.includes('Mozilla.Firefox.ESR'), 'an edition is not a language');
  assert.ok(ids.includes('Mozilla.Firefox.DeveloperEdition'));
  assert.ok(!ids.some((id) => /\.(af|an|ar|en-GB|pt-BR|zh-CN|ast)$/.test(id)), `no locale packages: ${ids.join(', ')}`);
  // A full id typed exactly: that package, marked exact, and none of its neighbours.
  const exact = await winget.search('mozilla.firefox', ctx);
  assert.deepEqual(exact.map((c) => [c.source.packageId, c.exact]), [['Mozilla.Firefox', true]]);
  // A language package is still reachable by its own exact id.
  assert.deepEqual((await winget.search('Mozilla.Firefox.pt-BR', ctx)).map((c) => c.source.packageId), ['Mozilla.Firefox.pt-BR']);
});

test('WinGet joins the announced version to its hash-pinned manifest and maps installer rows', { skip: !available.ok }, async () => {
  const { ctx } = context();
  const blender = await winget.getLatestRelease(packageSource('blenderfoundation.blender'), ctx);
  assert.equal(blender.tag_name, '5.3.0');
  assert.equal(blender.provenance.publisher, 'Blender Foundation');
  assert.deepEqual(blender.assets.map((asset) => [asset.arch, asset.kind, asset.upgradeBehavior]),
    [['x64', 'msi', 'uninstallPrevious'], ['arm64', 'msi', 'uninstallPrevious']]);
  for (const asset of blender.assets) {
    assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(asset.scope, 'machine');
    assert.match(asset.productCode, /^\{[\w-]+\}$/);
    assert.equal(asset.redirects, 'https-pinned');
  }

  const vlc = await winget.getLatestRelease(packageSource('VideoLAN.VLC'), ctx);
  assert.equal(vlc.assets.length, 9);
  assert.deepEqual(vlc.assets.filter((asset) => asset.arch === 'ia32').map((asset) => asset.kind), ['nsis', 'msi', 'zip']);

  const firefox = await winget.getLatestRelease(packageSource('Mozilla.Firefox'), ctx);
  assert.equal(firefox.assets[0].locale, undefined, 'the localized display metadata does not set installer locale');
  assert.deepEqual(firefox.assets[0].installArgs, ['/S', '/PreventRebootRequired=true']);
  assert.match(firefox.assets[0].name, /Firefox Setup/);

  const office = await winget.getLatestRelease(packageSource('TheDocumentFoundation.LibreOffice'), ctx);
  assert.deepEqual(office.assets.find((asset) => asset.arch === 'x64').requires, ['Microsoft.VCRedist.2015+.x64']);

  const sevenZip = await winget.getLatestRelease(packageSource('7zip.7zip'), ctx);
  assert.equal(sevenZip.tag_name, '26.06');
  const executable = sevenZip.assets.find((asset) => asset.arch === 'x64' && asset.kind === 'exe');
  assert.deepEqual(executable.installArgs, ['/S']);
  assert.equal(executable.unsupported, undefined);
  assert.ok(sevenZip.assets.some((asset) => asset.kind === 'msi' && !asset.unsupported));

  const git = await winget.getLatestRelease(packageSource('Git.Git'), ctx);
  assert.deepEqual(git.assets.filter((asset) => asset.arch === 'x64').map((asset) => asset.scope), ['user', 'machine']);
  assert.deepEqual(git.assets[0].installArgs, ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
});

test('WinGet refuses a modified or missing indexed manifest', { skip: !available.ok }, async () => {
  const row = packages[0];
  const { ctx } = context({ replacements: [[row.url, Buffer.from('wrong manifest')]] });
  await assert.rejects(winget.getLatestRelease(packageSource(row.id), ctx), /SHA-256 does not match/);
  await assert.rejects(winget.getLatestRelease(packageSource('Missing.Package'), ctx), /indexes disagree/);
  await assert.rejects(winget.getLatestRelease(packageSource('Unlisted.Package'), ctx), { unavailable: true });
});

test('WinGet executable and Burn installers require explicitly declared silent arguments that can become argv', { skip: !available.ok }, async (t) => {
  const row = packages[0];
  const buffer = Buffer.from(`PackageIdentifier: ${row.id}
PackageVersion: ${row.version}
ManifestType: merged
Installers:
- Architecture: x64
  InstallerType: burn
  InstallerUrl: https://vendor.example/bundle.exe
  InstallerSwitches:
    SilentWithProgress: -quiet -norestart
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/no-flags.exe
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/quoted-flags.exe
  InstallerSwitches:
    Silent: '-quiet -log "C:\\Install Logs\\vendor.log"'
`);
  const manifestSha256 = createHash('sha256').update(buffer).digest('hex');
  const index = manifestIndex([{ ...row, manifestSha256 }]);
  const cacheDir = path.join(scratch, 'exe-test');
  t.after(() => {
    if (!fs.existsSync(cacheDir)) return;
    for (const file of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, file));
    fs.rmdirSync(cacheDir);
  });
  const { ctx } = context({ cacheDir, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, index]] });
  const [burn, missing, complex] = (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;
  assert.equal(burn.kind, 'exe');
  assert.deepEqual(burn.installArgs, ['-quiet', '-norestart']);
  assert.match(missing.unsupported, /did not declare silent switches/);
  assert.match(complex.unsupported, /switches require manual setup/);
});

test('WinGet distinguishes missing installer digests from invalid published digests', { skip: !available.ok }, async () => {
  const row = packages[0];
  const run = (buffer, now) => {
    const digest = createHash('sha256').update(buffer).digest('hex');
    const index = manifestIndex([{ ...row, manifestSha256: digest }]);
    const { ctx } = context({ now: () => now, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, index]] });
    return winget.getLatestRelease(packageSource(row.id), ctx);
  };
  const text = fixture(row).toString('utf8');
  const checksums = /^ +InstallerSha256: .*\r?\n/gm;
  const now = Date.now() + 7 * 60 * 60 * 1000;
  try {
    const release = await run(Buffer.from(text.replace(checksums, '')), now);
    assert.ok(release.assets.every((asset) => !asset.digest && !asset.unsupported && asset.redirects === 'none'));
    await assert.rejects(run(Buffer.from(text.replace(checksums, '  InstallerSha256: invalid\n')), now + 7 * 60 * 60 * 1000),
      /invalid installer SHA-256/);
  } finally {
    for (const name of ['winget-1-index.db', 'winget-2-index.db']) fs.unlinkSync(path.join(scratch, name));
  }
});

test('WinGet keeps a cached catalog after a refresh failure and reports the fallback', { skip: !available.ok }, async () => {
  const row = packages[0];
  const now = Date.now();
  await winget.getLatestRelease(packageSource(row.id), context({ now: () => now }).ctx);
  const reject = (url) => url === MICROSOFT_SEARCH || url === MICROSOFT_MANIFESTS;
  const stale = context({ now: () => now + 7 * 60 * 60 * 1000, reject });
  const [candidate] = await winget.search('BlenderFoundation.Blender', stale.ctx);
  assert.match(candidate.note, /cached WinGet catalog/);
  const release = await winget.getLatestRelease(packageSource(row.id), stale.ctx);
  assert.match(release.provenance.note, /cached WinGet catalog/);
  assert.deepEqual(stale.requests, [MICROSOFT_SEARCH, MICROSOFT_SEARCH, MICROSOFT_MANIFESTS, row.url]);
});
