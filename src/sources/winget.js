'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const { installerCmd } = require('../core');

const CDN = 'https://cdn.winget.microsoft.com/cache/';
const REPOSITORY = 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/';
const SEARCH_INDEX = { name: 'source2.msix', major: '2', maxBytes: 16 * 1024 * 1024 };
const MANIFEST_INDEX = { name: 'source.msix', major: '1', maxBytes: 64 * 1024 * 1024 };
const INDEX_DB_LIMIT = 128 * 1024 * 1024;
const INDEX_MAX_AGE = 6 * 60 * 60 * 1000;
const MANIFEST_LIMIT = 1024 * 1024;
const ID_SEGMENT = /^[a-z0-9_+-]+$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
// msix/appx: a packaged app. It has no silent switches of any kind — Windows installs it through
// its own App Installer window — so the runner opens it there rather than running it.
const KIND = new Map([['msi', 'msi'], ['wix', 'msi'], ['nullsoft', 'nsis'], ['inno', 'inno'], ['exe', 'exe'], ['burn', 'exe'], ['msix', 'msix'], ['appx', 'msix']]);
const ARCH = new Map([['x86', 'ia32'], ['x64', 'x64'], ['arm64', 'arm64'], ['neutral', 'universal']]);
const indexDownloads = new Map();

function validPackageId(id) {
  if (typeof id !== 'string' || id.length > 128) return false;
  const parts = id.split('.');
  return parts.length > 1 && parts.every((part) => ID_SEGMENT.test(part));
}

function packageId(source) {
  const id = source?.packageId;
  if (!validPackageId(id)) throw new Error('WinGet needs a valid package ID, such as VideoLAN.VLC');
  return id;
}

function canonicalRef(source) {
  return packageId(source).toLowerCase();
}

function pageUrl(source) {
  const id = packageId(source);
  return REPOSITORY + [id[0].toLowerCase(), ...id.split('.')].map(encodeURIComponent).join('/');
}

function parseUrl(input) {
  try {
    const url = new URL(input);
    if (url.origin !== 'https://github.com' || url.username || url.password || !url.href.startsWith(REPOSITORY)) return null;
    const parts = url.pathname.split('/').slice(6);
    if (!parts.at(-1)) parts.pop();
    const [firstLetter, ...idParts] = parts.map(decodeURIComponent);
    if (!idParts.every((part) => ID_SEGMENT.test(part))) return null;
    const source = { type: 'winget', packageId: idParts.join('.') };
    return packageId(source)[0].toLowerCase() === firstLetter ? source : null;
  } catch {
    return null;
  }
}

function available(ctx) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (ctx && !ctx.cacheDir && typeof DatabaseSync.prototype.deserialize !== 'function') {
      return { ok: false, reason: 'WinGet lookup on this Node.js version needs an index cache directory' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'WinGet lookup needs Node.js 22.13 or later' };
  }
}

function queryDatabase(spec, database, query) {
  const { DatabaseSync } = require('node:sqlite');
  const inMemory = Buffer.isBuffer(database);
  const db = new DatabaseSync(inMemory ? ':memory:' : database, { readOnly: !inMemory });
  try {
    if (inMemory) db.deserialize(database);
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const metadata = db.prepare("SELECT value FROM metadata WHERE name = 'majorVersion'").get();
    if (!metadata || metadata.value !== spec.major) throw new Error(`unsupported WinGet index format in ${spec.name}`);
    return query(db);
  } finally {
    db.close();
  }
}

async function downloadIndex(spec, ctx) {
  const { buffer } = await ctx.net.getBuffer(CDN + spec.name, { maxBytes: spec.maxBytes });
  if (!Buffer.isBuffer(buffer) || buffer.length > spec.maxBytes) throw new Error(`invalid WinGet archive ${spec.name}`);
  const archive = new AdmZip(buffer);
  const entry = archive.getEntry('Public/index.db');
  if (!entry || entry.header.size <= 0 || entry.header.size > INDEX_DB_LIMIT) {
    throw new Error(`missing or oversized WinGet database in ${spec.name}`);
  }
  const database = archive.readFile(entry);
  if (!database || database.length !== entry.header.size || database.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    throw new Error(`invalid WinGet database in ${spec.name}`);
  }
  return database;
}

async function refreshIndex(spec, ctx, file) {
  if (indexDownloads.has(file)) return indexDownloads.get(file);
  const pending = (async () => {
    const data = await downloadIndex(spec, ctx);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const staging = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(staging, data, { flag: 'wx' });
      queryDatabase(spec, staging, () => {});
      const fetchedAt = new Date(ctx.now?.() ?? Date.now());
      await fs.utimes(staging, fetchedAt, fetchedAt);
      await fs.rename(staging, file);
    } finally {
      await fs.unlink(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  })();
  indexDownloads.set(file, pending);
  try {
    await pending;
  } finally {
    indexDownloads.delete(file);
  }
}

async function useIndex(spec, ctx, query, force = false) {
  const runtime = available(ctx);
  if (!runtime.ok) throw new Error(runtime.reason);
  if (!ctx.cacheDir) return { value: queryDatabase(spec, await downloadIndex(spec, ctx), query) };
  const file = path.join(ctx.cacheDir, `winget-${spec.major}-index.db`);
  const info = await fs.stat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const cached = info?.isFile() && info.size <= INDEX_DB_LIMIT;
  const age = (ctx.now?.() ?? Date.now()) - (info?.mtimeMs || 0);
  if (!force && cached && age >= 0 && age < INDEX_MAX_AGE) {
    try {
      return { value: queryDatabase(spec, file, query) };
    } catch (error) {
      if (!error.code?.startsWith('ERR_SQLITE') && !error.message.startsWith('unsupported WinGet index format')) throw error;
    }
  }
  try {
    await refreshIndex(spec, ctx, file);
  } catch (error) {
    if (cached) {
      try {
        const value = queryDatabase(spec, file, query);
        return { value, note: 'Using the cached WinGet catalog because the refresh failed' };
      } catch {}
    }
    throw error;
  }
  return { value: queryDatabase(spec, file, query) };
}

async function search(name, ctx) {
  const term = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!term || term.length > 128) return [];
  const contains = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
  const { value: rows, note } = await useIndex(SEARCH_INDEX, ctx, (db) => db.prepare(`
    SELECT id, name, moniker, latest_version,
      (SELECT COUNT(*) FROM packages WHERE lower(moniker) = ?) AS moniker_matches
    FROM packages
    WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(moniker) LIKE ? ESCAPE '\\'
    ORDER BY CASE
      WHEN lower(id) = ? THEN 0 WHEN lower(moniker) = ? THEN 1 WHEN lower(name) = ? THEN 2 ELSE 3
    END, length(name), id
    LIMIT 400
  `).all(term, contains, contains, contains, term, term, term));
  return narrow(rows.filter((row) => validPackageId(row.id)), term).map((row) => {
    const source = { type: 'winget', packageId: row.id };
    return {
      source, name: row.name, version: row.latest_version, listingUrl: pageUrl(source),
      exact: row.id.toLowerCase() === term || (row.moniker_matches === 1 && row.moniker?.toLowerCase() === term), ...(note && { note }),
    };
  });
}

// What a person searching by name wants to see, from up to 400 raw matches down to 25.
// Found by running the packaged app on Windows: "firefox" filled every slot with
// per-language packages (Mozilla.Firefox.af, .an, .ar…) and pushed the real editions off
// the list, and typing the exact id "Mozilla.Firefox" still listed 25 neighbours.
//   - A full package id typed exactly means that package and nothing else.
//   - "<Id>.<locale>" is a translation of <Id>, not another app: when <Id> itself is in
//     the results, its language variants are left out. The locale test is deliberately
//     strict about case (af, pt-BR) so an edition like ".ESR" is never mistaken for one.
const LOCALE_SEGMENT = /^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/;
function narrow(rows, term) {
  const exact = rows.find((row) => row.id.toLowerCase() === term);
  if (exact) return [exact];
  const ids = new Set(rows.map((row) => row.id.toLowerCase()));
  return rows.filter((row) => {
    const dot = row.id.lastIndexOf('.');
    return !(LOCALE_SEGMENT.test(row.id.slice(dot + 1)) && ids.has(row.id.slice(0, dot).toLowerCase()));
  }).slice(0, 25);
}

function manifestReference(db, id, version) {
  const rows = db.prepare(`
    SELECT m.pathpart, m.hash, c.channel
    FROM manifest m JOIN ids i ON i.rowid = m.id JOIN versions v ON v.rowid = m.version
    JOIN channels c ON c.rowid = m.channel
    WHERE i.id = ? COLLATE NOCASE AND v.version = ?
  `).all(id, version);
  if (!rows.length) return null;
  const unchanneled = rows.filter((row) => row.channel === '');
  const row = rows.length === 1 ? rows[0] : (unchanneled.length === 1 ? unchanneled[0] : null);
  if (!row) throw new Error(`ambiguous WinGet manifest for ${id} ${version}`);

  const parents = db.prepare(`
    WITH RECURSIVE ancestry(parent, part, depth) AS (
      SELECT parent, pathpart, 1 FROM pathparts WHERE rowid = ?
      UNION ALL
      SELECT p.parent, p.pathpart, a.depth + 1 FROM pathparts p JOIN ancestry a ON p.rowid = a.parent
      WHERE a.depth < 32
    )
    SELECT parent, part FROM ancestry ORDER BY depth DESC
  `).all(row.pathpart);
  const segments = parents.map(({ part }) => part);
  if (parents[0]?.parent !== null || segments[0] !== 'manifests' || segments.length < 5 ||
      segments.some((part) => !part || part === '.' || part === '..' || /[\\/\u0000-\u001f]/.test(part))) {
    throw new Error(`invalid WinGet manifest reference for ${id}`);
  }
  if (!row.hash || row.hash.length !== 32) throw new Error(`WinGet manifest for ${id} has no valid indexed SHA-256`);
  return { url: CDN + segments.map(encodeURIComponent).join('/'), sha256: Buffer.from(row.hash).toString('hex') };
}

// A Burn bundle (WiX's bootstrapper: the VC++ 2015+ redistributables, among others) that declares
// no switches is not a guess the way a bare vendor .exe is: every Burn bundle takes the same
// standard switches, and these are the ones WinGet itself runs for the type when a manifest
// declares none. Anything the manifest does declare still wins.
const BURN_SILENT = '/quiet /norestart';

// How a manifest's switch string reaches the installer. Nothing here ever goes through a shell.
//
// WORDS — the usual case: every space-separated piece is one plain switch (/S, -q, --silent,
// /mergetasks=!runcode, REBOOT=ReallySuppress). The string becomes an argv array.
//
// RAW — the string quotes a value or nests a second command line, e.g. the VC++ 2005
// redistributable's  /Q /C:"msiexec /i ""vcredist.msi"" /quiet /norestart"  or OpenOffice's
// /PARAM1="/norestart". Splitting that on spaces would change what it means, so it is handed
// to the installer exactly as written (see installerCmd's verbatim form in src/core.js),
// which is also what WinGet does with it. It must still be plain printable text with balanced
// quotes, and carry none of WinGet's unfilled placeholders (<INSTALLPATH>, <LOGPATH>).
//
// Anything else is refused: the app is then installed from its own window, not unattended.
const WORD = /^(?:(?:\/|--?)[a-z0-9][a-z0-9_./=:+,!-]*|[a-z_][a-z0-9_]*=[a-z0-9_./:+,!-]+)$/i;
const RAW = /^[\x20-\x7e]+$/;
const RAW_REFUSED = /[<>|&^%`]/;

function switchForm(text) {
  const words = text.split(/\s+/);
  if (words.every((word) => WORD.test(word))) return { words };
  if (text.length <= 512 && RAW.test(text) && !RAW_REFUSED.test(text) && (text.match(/"/g) || []).length % 2 === 0) return { raw: text };
  return null;
}

// A plain .exe whose listing declares no silent switches but states, in InstallModes, that it
// installs silently is one that needs no switches to do so: Discord's Squirrel setup is the
// common case. WinGet itself has no default switches for the exe type, so it runs exactly these
// with nothing added; `switchless` tells the runner to do the same. A bare .exe that does not
// state silent mode is still refused: there the missing switches are a gap, not a statement.
const SILENT_MODES = ['silent', 'silentWithProgress'];
const statesSilentMode = (info) => Array.isArray(info.InstallModes) && info.InstallModes.some((mode) => SILENT_MODES.includes(mode));

// -> { installArgs | installArgsRaw, upgradeArgs? | upgradeArgsRaw?, switchless? } | { unsupported } | {}
// `Upgrade` switches are WinGet's: they are added to the install switches when a version of the
// app is already on the machine (the runner decides that), never on a first install.
function installerArguments(info, kind) {
  const switches = info.InstallerSwitches || {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const burn = info.InstallerType === 'burn' || (info.InstallerType === 'zip' && info.NestedInstallerType === 'burn');
  const silent = text(switches.Silent) || text(switches.SilentWithProgress) || (burn ? BURN_SILENT : '');
  const custom = text(switches.Custom);
  const upgrade = text(switches.Upgrade);
  const switchless = kind === 'exe' && !silent && statesSilentMode(info);
  if (kind === 'exe' && !silent && !switchless) return { unsupported: 'WinGet did not declare silent switches for this executable' };
  if (!silent && !custom && !upgrade) return switchless ? { switchless: true } : {};
  const defaults = silent || switchless ? [] : installerCmd(kind, '').args;
  const defaultSwitches = kind === 'msi' ? defaults.slice(2) : defaults;
  const base = [silent || defaultSwitches.join(' '), custom].filter(Boolean).join(' ').trim();
  const out = switchless ? { switchless: true } : {};
  // A switchless installer has no base, so an upgrade line is the Upgrade switches alone.
  for (const [key, line] of [['install', base], ['upgrade', upgrade && [base, upgrade].filter(Boolean).join(' ')]]) {
    if (!line) continue;
    const form = switchForm(line);
    if (!form) return { unsupported: 'WinGet installer switches require manual setup' };
    if (form.words) out[`${key}Args`] = form.words;
    else out[`${key}ArgsRaw`] = form.raw;
  }
  return out;
}

function dependencies(value) {
  if (!value) return [];
  return [
    ...(value.PackageDependencies || []).filter((entry) => entry?.PackageIdentifier).map((entry) =>
      entry.MinimumVersion ? `${entry.PackageIdentifier} ${entry.MinimumVersion} or later` : entry.PackageIdentifier),
    ...(value.WindowsFeatures || []), ...(value.WindowsLibraries || []), ...(value.ExternalDependencies || []),
  ].filter((item) => typeof item === 'string');
}

// The extensions a download of each WinGet installer type may carry. The first is the one
// given to a file whose address names none.
const FILE_EXT = new Map([
  ['msi', ['msi']], ['wix', ['msi']],
  ['nullsoft', ['exe']], ['inno', ['exe']], ['exe', ['exe']], ['burn', ['exe']], ['portable', ['exe']],
  ['msix', ['msix', 'msixbundle', 'appx', 'appxbundle']], ['appx', ['appx', 'appxbundle', 'msix', 'msixbundle']],
  ['zip', ['zip']],
]);

// The name a download is saved under. Usually the address's last segment — but not always:
//
//   https://sourceforge.net/projects/winscp/files/WinSCP/6.7.1/WinSCP-6.7.1-Setup.exe/download
//
// ends in "download". The file was saved under that name, and Windows will not start a
// program whose name has no extension: the install failed with "spawnSync ...\download
// ENOENT" (WinSCP, on a real PC; KeePass, Pidgin, InfraRecorder, CCleaner and Eclipse are
// listed the same way). WinGet says what the file IS, so its name can always be made to say
// so too: the nearest segment that carries the type's extension, else a `file=`-style query
// value that does, else the last segment with the extension added.
function downloadName(url, installerType) {
  const exts = FILE_EXT.get(installerType);
  const decode = (text) => { try { return decodeURIComponent(text); } catch { return ''; } };
  const segments = url.pathname.split('/').filter(Boolean).map(decode);
  const last = segments.at(-1) || '';
  if (!exts) return last;
  const fits = (name) => exts.some((ext) => name.toLowerCase().endsWith(`.${ext}`) && name.length > ext.length + 1);
  const inPath = [...segments].reverse().find(fits);
  if (inPath) return inPath;
  for (const value of url.searchParams.values()) {
    const base = String(value).split(/[\\/]/).pop();
    if (fits(base)) return base;
  }
  return last ? `${last}.${exts[0]}` : '';
}

function installerAsset(installer, common) {
  if (!installer || typeof installer !== 'object' || Array.isArray(installer)) throw new Error('WinGet returned an invalid installer row');
  const info = { ...common, ...installer };
  info.InstallerSwitches = { ...common.InstallerSwitches, ...installer.InstallerSwitches };
  const type = info.InstallerType === 'portable' || (info.InstallerType === 'zip' && info.NestedInstallerType === 'portable')
    ? 'portable' : 'installer';
  // An installer delivered inside a zip (CutePDF Writer): the zip is what is downloaded and
  // checksummed, and the one setup program it names is what is run. Exactly one, by a plain
  // relative path — anything else is not a shape git-updater unpacks.
  const wrapped = type === 'installer' && info.InstallerType === 'zip';
  const nestedFiles = Array.isArray(info.NestedInstallerFiles) ? info.NestedInstallerFiles : [];
  const nestedPath = wrapped && nestedFiles.length === 1 && typeof nestedFiles[0]?.RelativeFilePath === 'string'
    ? nestedFiles[0].RelativeFilePath.replace(/\\/g, '/') : undefined;
  const nested = nestedPath && /^[a-z0-9][a-z0-9 ._()+-]*(?:\/[a-z0-9][a-z0-9 ._()+-]*)*\.(?:exe|msi)$/i.test(nestedPath) && !/(?:^|\/)\.\.?(?:\/|$)/.test(nestedPath)
    ? nestedPath : undefined;
  const kind = type === 'portable' && info.InstallerType === 'zip' ? 'zip'
    : wrapped ? (nested ? KIND.get(info.NestedInstallerType) : undefined)
      : KIND.get(info.InstallerType);
  const arch = ARCH.get(info.Architecture);
  const digest = typeof info.InstallerSha256 === 'string' && SHA256.test(info.InstallerSha256) ? `sha256:${info.InstallerSha256.toLowerCase()}` : undefined;
  if (info.InstallerSha256 !== undefined && !digest) throw new Error('WinGet published an invalid installer SHA-256');
  let downloadUrl;
  let name;
  try {
    downloadUrl = new URL(installer.InstallerUrl);
    name = downloadName(downloadUrl, info.InstallerType);
  } catch {}
  const safeName = name && !/[\\/:*?"<>|\u0000-\u001f]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  const args = kind && kind !== 'msix' && type === 'installer' ? installerArguments(info, kind) : {};
  const locale = info.InstallerLocale;
  const asset = {
    name: safeName ? name : `${info.InstallerType || 'Unknown'} ${info.Architecture || ''}`.trim(),
    browser_download_url: downloadUrl?.href || '', platform: 'win32', arch, type, kind, digest,
    redirects: digest ? 'https-pinned' : 'none',
    scope: ['user', 'machine'].includes(info.Scope) ? info.Scope : undefined,
    locale: typeof locale === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(locale) ? locale : undefined,
    requires: dependencies(info.Dependencies), productCode: info.ProductCode,
    upgradeBehavior: ['install', 'uninstallPrevious', 'deny'].includes(info.UpgradeBehavior) ? info.UpgradeBehavior : undefined,
    ...(wrapped && nested && kind ? { nested } : {}),
    ...args,
  };
  if (!kind) asset.unsupported = `WinGet installer type ${wrapped && info.NestedInstallerType ? `zip (${info.NestedInstallerType})` : info.InstallerType || 'unknown'} is unsupported`;
  else if (!arch) asset.unsupported = `WinGet architecture ${info.Architecture || 'unknown'} is unsupported`;
  else if (!safeName || downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password) asset.unsupported = 'WinGet did not publish a usable HTTPS download';
  else if (info.InstallModes?.length && !statesSilentMode(info)) {
    asset.unsupported = 'WinGet installer does not support unattended installation';
  }
  return asset;
}

async function getLatestRelease(source, ctx) {
  const id = packageId(source);
  const { value: record, note: discoveryNote } = await useIndex(SEARCH_INDEX, ctx, (db) =>
    db.prepare('SELECT id, latest_version FROM packages WHERE id = ? COLLATE NOCASE').get(id));
  if (!record) {
    const error = new Error(`WinGet package ${id} was not found`);
    error.unavailable = true;
    throw error;
  }
  const version = record.latest_version;
  const findReference = (db) => manifestReference(db, record.id, version);
  let index = await useIndex(MANIFEST_INDEX, ctx, findReference);
  if (!index.value && ctx.cacheDir) index = await useIndex(MANIFEST_INDEX, ctx, findReference, true);
  const reference = index.value;
  if (!reference) throw new Error(`WinGet indexes disagree about ${record.id} ${version}; try again after the catalogs refresh`);

  const { buffer } = await ctx.net.getBuffer(reference.url, { maxBytes: MANIFEST_LIMIT });
  if (!Buffer.isBuffer(buffer) || buffer.length > MANIFEST_LIMIT || createHash('sha256').update(buffer).digest('hex') !== reference.sha256) {
    throw new Error(`WinGet manifest SHA-256 does not match the index for ${record.id} ${version}`);
  }
  const { PackageIdentifier, PackageVersion, ManifestType, Publisher, Installers, ...common } =
    yaml.load(buffer.toString('utf8'), { schema: yaml.FAILSAFE_SCHEMA, maxDepth: 24 }) || {};
  if (PackageIdentifier !== record.id || PackageVersion !== version || ManifestType !== 'merged' ||
      !Array.isArray(Installers) || !Installers.length || Installers.length > 256) {
    throw new Error(`WinGet returned an invalid manifest for ${record.id} ${version}`);
  }
  const listingUrl = pageUrl({ packageId: record.id });
  const note = discoveryNote || index.note;
  return {
    tag_name: version, html_url: listingUrl,
    assets: Installers.map((installer) => installerAsset(installer, common)),
    provenance: { listedBy: 'WinGet', listingUrl, publisher: Publisher, ...(note && { note }) },
  };
}

module.exports = { type: 'winget', label: 'WinGet', platforms: ['win32'], checksum: 'pinned', fields: ['packageId'], canonicalRef, pageUrl, parseUrl, available, search, getLatestRelease };
