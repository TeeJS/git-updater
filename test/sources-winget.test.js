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

test('WinGet executables need declared silent arguments that can become argv; a Burn bundle with none gets the standard Burn ones', { skip: !available.ok }, async (t) => {
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
  InstallerType: burn
  InstallerUrl: https://vendor.example/bundle-no-flags.exe
- Architecture: x64
  InstallerType: burn
  InstallerUrl: https://vendor.example/bundle-custom-only.exe
  InstallerSwitches:
    Custom: /install
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/no-flags.exe
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/quoted-flags.exe
  InstallerSwitches:
    Silent: '-quiet -log "C:\\Install Logs\\vendor.log"'
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/DiscordSetup.exe
  InstallModes:
  - interactive
  - silent
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/switchless-custom.exe
  InstallModes:
  - silent
  InstallerSwitches:
    Custom: --no-launch
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/switchless-upgrade.exe
  InstallModes:
  - silentWithProgress
  InstallerSwitches:
    Upgrade: --update
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/interactive-only.exe
  InstallModes:
  - interactive
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
  const [burn, bareBurn, customBurn, missing, complex, discord, switchlessCustom, switchlessUpgrade, interactiveOnly] =
    (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;
  assert.equal(burn.kind, 'exe');
  assert.deepEqual(burn.installArgs, ['-quiet', '-norestart'], 'declared switches win');
  // Microsoft.VCRedist.2015+ is exactly this: a Burn bundle with no InstallerSwitches at all.
  assert.equal(bareBurn.unsupported, undefined);
  assert.deepEqual(bareBurn.installArgs, ['/quiet', '/norestart'], 'the standard Burn switches WinGet itself uses');
  assert.deepEqual(customBurn.installArgs, ['/quiet', '/norestart', '/install'], 'Custom is appended to the default');
  assert.match(missing.unsupported, /did not declare silent switches/);
  // A quoted value cannot be split on spaces, so it is carried whole — never re-tokenised.
  assert.equal(complex.unsupported, undefined);
  assert.equal(complex.installArgs, undefined);
  assert.equal(complex.installArgsRaw, '-quiet -log "C:\\Install Logs\\vendor.log"');
  // Discord.Discord's real shape: an .exe with no switches whose InstallModes say it installs
  // silently. WinGet runs it with nothing added, so git-updater does too.
  assert.equal(discord.unsupported, undefined);
  assert.equal(discord.switchless, true);
  assert.equal(discord.installArgs, undefined);
  assert.equal(discord.installArgsRaw, undefined);
  assert.deepEqual(switchlessCustom.installArgs, ['--no-launch'], 'Custom is all there is to run');
  assert.equal(switchlessCustom.switchless, true);
  assert.equal(switchlessUpgrade.installArgs, undefined, 'a first install still runs with nothing added');
  assert.deepEqual(switchlessUpgrade.upgradeArgs, ['--update'], 'the upgrade set is the Upgrade switches alone');
  assert.equal(switchlessUpgrade.switchless, true);
  assert.equal(missing.switchless, undefined, 'no InstallModes is no statement: still refused');
  assert.match(interactiveOnly.unsupported, /does not support unattended installation/);
  assert.equal(interactiveOnly.switchless, undefined);
});

// The shapes below are taken from real manifests that used to be refused outright: AIMP, Evernote,
// Grammarly and OneDrive (upgrade switches), VirtualBox and NVDA (--double-dash), Cursor
// (/mergetasks=!runcode), OpenOffice (/PARAM1="/norestart"), the VC++ 2005 redistributable (a
// nested command line) and CutePDF Writer (an installer inside a zip).
test('WinGet switch strings: plain words become argv, quoted ones are carried verbatim, upgrade switches are kept apart', { skip: !available.ok }, async (t) => {
  const row = packages[0];
  const buffer = Buffer.from(`PackageIdentifier: ${row.id}
PackageVersion: ${row.version}
ManifestType: merged
Installers:
- Architecture: x64
  InstallerType: nullsoft
  InstallerUrl: https://vendor.example/evernote.exe
  InstallerSwitches:
    Custom: /currentuser
    Upgrade: --updated
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/aimp.exe
  InstallerSwitches:
    Silent: /AUTO /SILENT
    Upgrade: /UPDATE
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/virtualbox.exe
  InstallerSwitches:
    Silent: --silent
    Custom: -msiparams REBOOT=ReallySuppress
- Architecture: x64
  InstallerType: inno
  InstallerUrl: https://vendor.example/cursor.exe
  InstallerSwitches:
    Custom: /mergetasks=!runcode
- Architecture: x64
  InstallerType: nullsoft
  InstallerUrl: https://vendor.example/openoffice.exe
  InstallerSwitches:
    Silent: /S /GUILEVEL=qn /PARAM1="/norestart"
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/vcredist_x64.EXE
  InstallerSwitches:
    Silent: /Q /C:"msiexec /i ""vcredist.msi"" /quiet
    Custom: /norestart"
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/placeholder.exe
  InstallerSwitches:
    Silent: /S /LOG="<LOGPATH>"
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/unbalanced.exe
  InstallerSwitches:
    Silent: /S /D="C:\\Apps
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/piped.exe
  InstallerSwitches:
    Silent: /S "a" & calc
- Architecture: x64
  InstallerType: nullsoft
  InstallerUrl: https://vendor.example/quoted-upgrade.exe
  InstallerSwitches:
    Silent: /S
    Upgrade: /update="yes please"
`);
  const manifestSha256 = createHash('sha256').update(buffer).digest('hex');
  const cacheDir = path.join(scratch, 'switch-test');
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { ctx } = context({ cacheDir, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, manifestIndex([{ ...row, manifestSha256 }])]] });
  const [evernote, aimp, vbox, cursor, openoffice, vc2005, placeholder, unbalanced, piped, quotedUpgrade] =
    (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;

  // Upgrade switches no longer make a package unusable: the first install gets the install
  // switches, and the upgrade set is those plus the listing's own upgrade switch.
  assert.equal(evernote.unsupported, undefined);
  assert.deepEqual(evernote.installArgs, ['/S', '/currentuser']);
  assert.deepEqual(evernote.upgradeArgs, ['/S', '/currentuser', '--updated']);
  assert.deepEqual(aimp.installArgs, ['/AUTO', '/SILENT']);
  assert.deepEqual(aimp.upgradeArgs, ['/AUTO', '/SILENT', '/UPDATE']);

  // --double-dash switches and Inno's "!task" are ordinary words.
  assert.deepEqual(vbox.installArgs, ['--silent', '-msiparams', 'REBOOT=ReallySuppress']);
  assert.equal(vbox.upgradeArgs, undefined, 'no upgrade set unless the listing declares one');
  assert.deepEqual(cursor.installArgs, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/mergetasks=!runcode']);

  // Quoted strings are never split.
  assert.equal(openoffice.installArgs, undefined);
  assert.equal(openoffice.installArgsRaw, '/S /GUILEVEL=qn /PARAM1="/norestart"');
  assert.equal(vc2005.installArgsRaw, '/Q /C:"msiexec /i ""vcredist.msi"" /quiet /norestart"');
  assert.deepEqual(quotedUpgrade.installArgs, ['/S'], 'each set takes the form it needs');
  assert.equal(quotedUpgrade.upgradeArgsRaw, '/S /update="yes please"');

  // Still refused: an unfilled WinGet placeholder, unbalanced quotes, shell metacharacters.
  for (const a of [placeholder, unbalanced, piped]) {
    assert.match(a.unsupported, /switches require manual setup/);
    assert.equal(a.installArgs, undefined);
    assert.equal(a.installArgsRaw, undefined);
  }
});

// Found on a real Windows PC: WinSCP's listing ends in ".../WinSCP-6.7.1-Setup.exe/download".
// The file was saved as "download", and Windows will not start a program whose name has no
// extension: "spawnSync ...\\download ENOENT". The other addresses are the real shapes of
// KeePass, CCleaner and Eclipse.
test('WinGet download name: always carries the extension of the declared installer type', { skip: !available.ok }, async (t) => {
  const row = packages[0];
  const buffer = Buffer.from(`PackageIdentifier: ${row.id}
PackageVersion: ${row.version}
ManifestType: merged
Installers:
- Architecture: x64
  InstallerType: inno
  InstallerUrl: https://sourceforge.net/projects/winscp/files/WinSCP/6.7.1/WinSCP-6.7.1-Setup.exe/download
- Architecture: x64
  InstallerType: exe
  InstallerUrl: https://vendor.example/ccleaner/build_RELEASE
  InstallerSwitches:
    Silent: /S
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: portable
  InstallerUrl: https://www.eclipse.org/downloads/download.php?file=/technology/epp/downloads/release/2026-09/R/eclipse-java-2026-09-R-win32-x86_64.zip&r=1
- Architecture: x64
  InstallerType: wix
  InstallerUrl: https://vendor.example/files/Tool%20Setup.MSI/download
- Architecture: x64
  InstallerType: nullsoft
  InstallerUrl: https://vendor.example/plain.exe
- Architecture: x64
  InstallerType: nullsoft
  InstallerUrl: https://vendor.example/get?file=..%5C..%5Cevil%3F.exe
`);
  const manifestSha256 = createHash('sha256').update(buffer).digest('hex');
  const cacheDir = path.join(scratch, 'name-test');
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { ctx } = context({ cacheDir, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, manifestIndex([{ ...row, manifestSha256 }])]] });
  const [winscp, ccleaner, eclipse, msi, plain, evil] = (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;

  assert.equal(winscp.name, 'WinSCP-6.7.1-Setup.exe', 'the segment that names the file, not "download"');
  assert.equal(winscp.unsupported, undefined);
  assert.equal(ccleaner.name, 'build_RELEASE.exe', 'no segment names it, so the type\'s extension is added');
  assert.equal(eclipse.name, 'eclipse-java-2026-09-R-win32-x86_64.zip', 'a file= value in the query');
  assert.equal(msi.name, 'Tool Setup.MSI');
  assert.equal(plain.name, 'plain.exe', 'an ordinary address is unchanged');
  // The address itself is never rewritten: only the name the file is saved under.
  assert.equal(winscp.browser_download_url, 'https://sourceforge.net/projects/winscp/files/WinSCP/6.7.1/WinSCP-6.7.1-Setup.exe/download');
  // A name taken from the query is still held to the same rules as any other.
  assert.equal(evil.name.includes('..'), false);
  assert.match(evil.unsupported || '', /usable HTTPS download/);
});

test('WinGet installer inside a zip: the one named setup program is the installer; anything else is refused', { skip: !available.ok }, async (t) => {
  const row = packages[0];
  const buffer = Buffer.from(`PackageIdentifier: ${row.id}
PackageVersion: ${row.version}
ManifestType: merged
Installers:
- Architecture: x86
  InstallerType: zip
  NestedInstallerType: inno
  NestedInstallerFiles:
  - RelativeFilePath: CuteWriter.exe
  InstallerUrl: https://vendor.example/CuteWriter.zip
  InstallerSha256: ${'a'.repeat(64)}
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: msi
  NestedInstallerFiles:
  - RelativeFilePath: setup\\app-x64.msi
  InstallerUrl: https://vendor.example/app.zip
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: nullsoft
  NestedInstallerFiles:
  - RelativeFilePath: ..\\outside.exe
  InstallerUrl: https://vendor.example/traversal.zip
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: nullsoft
  NestedInstallerFiles:
  - RelativeFilePath: one.exe
  - RelativeFilePath: two.exe
  InstallerUrl: https://vendor.example/two.zip
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: exe
  NestedInstallerFiles:
  - RelativeFilePath: setup.exe
  InstallerUrl: https://vendor.example/bare.zip
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: portable
  NestedInstallerFiles:
  - RelativeFilePath: tool.exe
  InstallerUrl: https://vendor.example/portable.zip
`);
  const manifestSha256 = createHash('sha256').update(buffer).digest('hex');
  const cacheDir = path.join(scratch, 'nested-test');
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { ctx } = context({ cacheDir, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, manifestIndex([{ ...row, manifestSha256 }])]] });
  const [cute, msi, traversal, two, bare, portable] = (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;

  assert.equal(cute.unsupported, undefined);
  assert.deepEqual([cute.type, cute.kind, cute.nested, cute.name], ['installer', 'inno', 'CuteWriter.exe', 'CuteWriter.zip']);
  assert.equal(cute.digest, `sha256:${'a'.repeat(64)}`, 'the checksum is the zip\'s: that is the file downloaded');
  assert.deepEqual([msi.kind, msi.nested], ['msi', 'setup/app-x64.msi']);
  assert.match(traversal.unsupported, /zip \(nullsoft\) is unsupported/);
  assert.equal(traversal.nested, undefined);
  assert.match(two.unsupported, /is unsupported/);
  assert.match(bare.unsupported, /did not declare silent switches/, 'a bare .exe in a zip still needs declared switches');
  assert.deepEqual([portable.type, portable.kind, portable.nested], ['portable', 'zip', undefined], 'a zipped portable app is unchanged');
});

test('WinGet packaged apps (MSIX) are offered as installers with no switches at all', { skip: !available.ok }, async (t) => {
  const row = packages[0];
  const buffer = Buffer.from(`PackageIdentifier: ${row.id}
PackageVersion: ${row.version}
ManifestType: merged
InstallerType: msix
PackageFamilyName: MicrosoftCorporationII.Windows365_8wekyb3d8bbwe
InstallerSwitches:
  Silent: /quiet
Installers:
- Architecture: x64
  InstallerUrl: https://res.cdn.example/WindowsApp_x64_Release_2.0.1601.0.msix
- Architecture: arm64
  InstallerType: appx
  InstallerUrl: https://res.cdn.example/WindowsApp_arm64.appx
- Architecture: x64
  InstallerType: pwa
  InstallerUrl: https://res.cdn.example/app.pwa
`);
  const manifestSha256 = createHash('sha256').update(buffer).digest('hex');
  const cacheDir = path.join(scratch, 'msix-test');
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const { ctx } = context({ cacheDir, replacements: [[row.url, buffer], [MICROSOFT_MANIFESTS, manifestIndex([{ ...row, manifestSha256 }])]] });
  const [msix, appx, pwa] = (await winget.getLatestRelease(packageSource(row.id), ctx)).assets;
  assert.equal(msix.unsupported, undefined);
  assert.deepEqual([msix.type, msix.kind, msix.arch, msix.name], ['installer', 'msix', 'x64', 'WindowsApp_x64_Release_2.0.1601.0.msix']);
  assert.equal(msix.installArgs, undefined, 'a packaged app is never run with switches');
  assert.equal(msix.installArgsRaw, undefined);
  assert.deepEqual([appx.kind, appx.arch], ['msix', 'arm64']);
  assert.match(pwa.unsupported, /installer type pwa is unsupported/);
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
