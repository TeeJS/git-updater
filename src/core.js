'use strict';

// Pure logic, no IO. Every unit test lives against this file.

// ---------------------------------------------------------------------------
// Version compare — ported from open-quake app/appRepo.js cmpVersion(), plus
// leading-"v" strip and prerelease handling.
// ---------------------------------------------------------------------------

// Strip the leading "v" AND any word prefix before the first digit ("Audacity-3.7.8",
// "release/v2.6.2" -> "3.7.8", "2.6.2") — otherwise such tags parse as version 0 and
// updates are never detected. Tags with no digits at all are left untouched.
function normTag(t) {
  const s = String(t == null ? '' : t).trim();
  return /\d/.test(s) ? s.replace(/^[^0-9]*(?=[0-9])/, '') : s;
}

// { nums:[1,2,0], pre:'rc1' } from "v1.2.0-rc1". Build metadata ("+abc") is
// dropped: per semver it does not affect precedence.
const nums = (s) => s.split('.').map((x) => parseInt(x, 10) || 0);

function splitVer(t) {
  let s = normTag(t);
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  // A trailing "(build)" is Apple's own display convention — CFBundleShortVersionString
  // followed by CFBundleVersion, e.g. Zoom reports "7.1.5 (84650)". It is metadata, not
  // precedence, exactly like the "+build" above, and it is stripped for the same reason.
  // Doing it BEFORE the match rather than in the fallback below keeps any prerelease:
  // "1.2.3-rc1 (build 5)" still parses as 1.2.3-rc1.
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  const m = s.match(/^(\d+(?:\.\d+)*)(?:-(.*))?$/);
  if (m) return { nums: nums(m[1]), pre: m[2] || '' };
  // Anything still unparseable. Returning zero here — which is what this used to do —
  // reads as "older than every release", so the row says an update is available, the
  // user installs it, the version string does not change, and the row never clears.
  // That is the permanent update-available state 67c8c9e fixed once already, reachable
  // through any unrecognised shape. The leading numeric run is a far better guess:
  // "1.2.3 build 9" is version 1.2.3, not version 0.
  const lead = s.match(/^(\d+(?:\.\d+)*)/);
  return lead ? { nums: nums(lead[1]), pre: '' } : { nums: [0], pre: '' };
}

function cmpNums(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Natural compare so "rc10" > "rc2" (digit runs compared numerically, not lexically).
function naturalCmp(a, b) {
  const ax = a.match(/\d+|\D+/g) || [];
  const bx = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i];
    const bs = bx[i];
    if (as === undefined) return -1;
    if (bs === undefined) return 1;
    if (/^\d+$/.test(as) && /^\d+$/.test(bs)) {
      const d = parseInt(as, 10) - parseInt(bs, 10);
      if (d) return d < 0 ? -1 : 1;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return 0;
}

// Some apps pad the registry DisplayVersion with extra parts that the release tag lacks —
// a PREFIX (Brave: "152.1.94.117" = Chromium 152 + Brave 1.94.117, tag "1.94.117") or a
// SUFFIX (Tesseract: "5.5.3.20260724" = 5.5.3 + build date, tag "5.5.3"). When the
// installed version has MORE numeric parts than the tag scheme, return the leading or
// trailing parts in the tag's scheme — whichever matches the tag best (exact match, then
// longest shared prefix; tie -> trailing); else null.
function alignInstalledVersion(installed, latest) {
  const i = splitVer(installed);
  const l = splitVer(latest);
  if (l.nums.length < 2 || i.nums.length <= l.nums.length) return null;
  const leading = i.nums.slice(0, l.nums.length);
  const trailing = i.nums.slice(-l.nums.length);
  const shared = (nums) => {
    let n = 0;
    while (n < nums.length && nums[n] === l.nums[n]) n++;
    return n;
  };
  return (shared(leading) > shared(trailing) ? leading : trailing).join('.');
}

// >0 if a is newer than b. Handles "1.2" == "1.2.0" and prerelease < release.
function cmpVersion(a, b) {
  const va = splitVer(a);
  const vb = splitVer(b);
  const c = cmpNums(va.nums, vb.nums);
  if (c !== 0) return c;
  if (va.pre && !vb.pre) return -1; // a is a prerelease of b's version -> older
  if (!va.pre && vb.pre) return 1;
  if (va.pre === vb.pre) return 0;
  return naturalCmp(va.pre, vb.pre);
}

// ---------------------------------------------------------------------------
// Asset matching — glob ("*-win-x64.zip") or "/regex/".
// ---------------------------------------------------------------------------

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('asset pattern is required');
  if (pattern.length > 1 && pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
    const re = new RegExp(pattern.slice(1, -1));
    return (name) => re.test(name);
  }
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const re = new RegExp('^' + body + '$', 'i');
  return (name) => re.test(name);
}

function matchAsset(assets, pattern) {
  const list = assets || [];
  const test = compilePattern(pattern);
  const hits = list.filter((a) => test(a.name));
  if (hits.length === 0) {
    const names = list.map((a) => a.name).join(', ') || '(none)';
    throw new Error(`no asset matched "${pattern}". Available: ${names}`);
  }
  if (hits.length > 1) {
    throw new Error(
      `pattern "${pattern}" matched ${hits.length} assets (${hits.map((h) => h.name).join(', ')}); tighten it`
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// Auto-pick the right asset for THIS platform from a release, given only
// "portable" or "installer". This is the app doing the work so the user never
// picks files. The per-platform extension sets, reject regexes, architecture
// tokens and scoring bonuses all live in src/platform/assets.js — that module is
// pure data, so this file keeps its "no IO" guarantee.
// ---------------------------------------------------------------------------

const { assetTable, macCompanionZips } = require('./platform/assets');

// arch: machine architecture ('x64' | 'arm64' | 'ia32'). flavor: how the app is
// ALREADY installed (Windows 'msi' | 'exe', Linux 'deb' | 'rpm', or null) — strongly
// prefer the same flavor so an update upgrades in place instead of installing a
// duplicate side-by-side. table: from assetTable(), defaults to the running platform.
// host: the running distro as { id, versionId } from /etc/os-release (Linux only; null
// elsewhere or when unknown). Read by the caller — this module does no IO.
function scoreAsset(name, type, arch, flavor, table, host) {
  const t = table || assetTable();
  if (t.reject.test(name)) return -Infinity;
  if (!(type === 'installer' ? t.ext.installer : t.ext.portable).test(name)) return -Infinity;
  // Reward naming this platform, then how well the architecture matches the running
  // machine, then the format/flavor preferences that separate portable from installer,
  // and finally the distro release when the filename names one.
  return (
    t.osBonus(name) +
    t.archScore(t.archTokens(name), arch) +
    t.typeScore(name, type, flavor) +
    (t.releaseScore ? t.releaseScore(name, host) : 0)
  );
}

// Returns the best-matching asset object, or throws if the release has none for the
// platform. arch defaults to the running machine's architecture, platform to the
// running OS ('win32' | 'darwin' | 'linux').
function pickAsset(assets, type, arch, flavor, platform, host) {
  const table = assetTable(platform);
  // Off macOS, drop a .zip that is the companion of a .dmg — it is the macOS bundle, and
  // nothing in its NAME says so. See macCompanionZips for why this cannot be a reject
  // pattern. Windows and Linux only: on macOS that zip is a legitimate candidate.
  const all = assets || [];
  const drop = table.id === 'darwin' ? new Set() : macCompanionZips(all.map((a) => a.name));
  const list = drop.size ? all.filter((a) => !drop.has(a.name)) : all;
  const a4 = arch || (typeof process !== 'undefined' && process.arch) || 'x64';
  let best = null;
  let bestScore = -Infinity;
  for (const a of list) {
    const sc = scoreAsset(a.name, type, a4, flavor, table, host);
    if (sc === -Infinity) continue;
    if (sc > bestScore || (sc === bestScore && best && a.name.length < best.name.length)) {
      best = a;
      bestScore = sc;
    }
  }
  if (!best) {
    // If the OTHER package type would match, the app just isn't shipped this way —
    // point the user at the fix instead of a dead end.
    const other = type === 'installer' ? 'portable' : 'installer';
    const otherHit = list.some((a) => scoreAsset(a.name, other, a4, null, table, host) !== -Infinity);
    if (otherHit) {
      throw new Error(
        type === 'installer'
          ? 'this app only ships portable builds — Edit the app and change its type to Portable'
          : 'this app only ships an installer — Edit the app and change its type to Installer'
      );
    }
    throw new Error(
      `no ${table.label} ${type} asset in release. Assets: ${list.map((a) => a.name).join(', ') || '(none)'}`
    );
  }
  return best;
}

// ---------------------------------------------------------------------------
// Choosing a file by hand ("Choose download…").
//
// Auto-pick is a score, and some releases have no right answer to score: two .debs for
// two Ubuntu releases, a tarball beside an AppImage, or nothing that names this platform
// at all. The user picks once; what is saved is the per-entry `asset` override that
// matchAsset already serves — the picked file's name with the version swapped for "*", so
// the next release's equivalent file matches with no prompt. Nothing here is a second
// mechanism: it only writes, and explains, the override that was hand-edited before.
// ---------------------------------------------------------------------------

// Files in a release that are never the build itself: checksums, signatures, update
// feeds, SBOMs. Left out of the chooser so the list is only things that could install.
const METADATA_ASSET =
  /\.(sha\d*|sha\d*sum|md5|sig|asc|minisig|pem|crt|cert|blockmap|ya?ml|json|txt|sbom|spdx|intoto\.jsonl|sigstore)$|^(sha\d*sums|checksums|md5sums)\b/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The override that pins exactly this name and nothing else: an anchored, escaped regex.
// Needed when the name itself would be read as a glob ("weird*name.zip") or as a regex
// ("/odd/"), and when two files differ only by letter case — a glob compares
// case-insensitively, a /regex/ does not.
const exactPattern = (name) => `/^${escapeRe(name)}$/`;

// The override to remember for a chosen file: every occurrence of the release's version
// in the name becomes "*". Falls back to the exact name when the version does not appear
// (an unversioned file name stays stable on its own) or is too short to replace safely —
// a bare "1" would turn half the name into wildcards.
// names: every file name in the same release, so a wildcard that would also catch a
// sibling is never returned.
function assetPatternFor(name, tag, names) {
  const n = String(name || '');
  if (/[*?]/.test(n) || (n.length > 1 && n[0] === '/' && n[n.length - 1] === '/')) return exactPattern(n);
  const only = (pattern) => !names || names.filter(compilePattern(pattern)).length === 1;
  const raw = String(tag == null ? '' : tag).trim();
  const ver = normTag(raw);
  // Longest form first: "v1.2.3" before "1.2.3", so the "v" is not left stranded. Some
  // projects write the version into file names with another separator than the tag uses
  // (tag 1.2.3, file app_1_2_3.zip); without those forms such a file is pinned by its
  // exact name and stops matching at the very next release.
  const forms = [...new Set([raw, ver, ver.replace(/\./g, '_'), ver.replace(/\./g, '-')])].filter(
    (v) => v && /\d/.test(v) && (v.length >= 3 || /\d\.\d/.test(v))
  );
  forms.sort((a, b) => b.length - a.length);
  for (const v of forms) {
    if (!n.toLowerCase().includes(v.toLowerCase())) continue;
    const pattern = n.replace(new RegExp(escapeRe(v), 'gi'), '*');
    // The wildcard must not swallow a sibling: if it matches more than the chosen file in
    // THIS release, it would be ambiguous next release too. The exact name is the safe pin.
    if (only(pattern)) return pattern;
  }
  return only(n) ? n : exactPattern(n);
}

// Every installable-looking file in a release, sorted into what the chooser needs to say
// about it for one platform and package type. status:
//   'ok'         this platform and package type would accept it (score is its rank)
//   'other-type' fits the OTHER type (an installer while the app is portable, or vice versa)
//   'unknown'    nothing marks it as a build for this platform
//   'rejected'   named for another platform, or source/debug files
// Whether a row may actually be chosen depends on where the app comes from, and whether
// this machine's processor can run it is the registry's rule — both are added by
// fileChoices in src/sources/index.js. This stays a pure reading of the names.
function classifyAssets(assets, type, arch, flavor, platform, host) {
  const table = assetTable(platform);
  const all = (assets || []).filter((a) => a && a.name && !METADATA_ASSET.test(a.name));
  const drop = table.id === 'darwin' ? new Set() : macCompanionZips(all.map((a) => a.name));
  const a4 = arch || (typeof process !== 'undefined' && process.arch) || 'x64';
  const other = type === 'installer' ? 'portable' : 'installer';
  return all.map((a) => {
    const score = drop.has(a.name) ? -Infinity : scoreAsset(a.name, type, a4, flavor, table, host);
    const asOther = scoreAsset(a.name, other, a4, null, table, host) !== -Infinity;
    let status = 'ok';
    if (score === -Infinity) {
      if (drop.has(a.name) || table.reject.test(a.name)) status = 'rejected';
      else status = asOther ? 'other-type' : 'unknown';
    } else if (asOther && table.typeScore(a.name, type, null) < 0 && table.typeScore(a.name, other, null) >= 0) {
      // One extension serves both types on Windows (.exe), and there only the words in the
      // name tell them apart: "App-Setup.exe" passes as a portable file with a penalty, and
      // the chooser would have called it a fit. The name says which it is; believe it.
      status = 'other-type';
    }
    return { asset: a, name: a.name, size: a.size || 0, score: score === -Infinity ? null : score, status };
  });
}

// Always picks a WINDOWS asset regardless of the running OS. Kept so the Windows
// behaviour (and its test suite) stays pinned and platform-independent.
function pickWindowsAsset(assets, type, arch, flavor) {
  return pickAsset(assets, type, arch, flavor, 'win32');
}

// Fallback silent-install kind when the file's bytes can't identify it.
// Windows: .msi -> msi, else nsis. macOS: .pkg. Linux: by extension.
function guessKind(assetName) {
  if (/\.msi$/i.test(assetName)) return 'msi';
  if (/\.pkg$/i.test(assetName)) return 'pkg';
  if (/\.deb$/i.test(assetName)) return 'deb';
  if (/\.rpm$/i.test(assetName)) return 'rpm';
  return 'nsis';
}

// ---------------------------------------------------------------------------
// Installer silent-switch table. Only the kinds we actually use; extend freely.
// ---------------------------------------------------------------------------

// Each kind says what to spawn: `cmd(file)` -> [exe, args] for a silent install, and
// `override(file, args)` -> args when the user pins their own switches in config.json.
// Kinds that run the downloaded file itself take the override as the WHOLE switch list;
// kinds that hand the file to a system tool must keep the file argument in place.
const INSTALLER_SWITCHES = {
  // Windows
  msi: {
    cmd: (file) => ['msiexec', ['/i', file, '/qn', '/norestart']],
    override: (file, args) => ['/i', file, ...args],
    raw: (file, line) => `/i "${file}" ${line}`,
  },
  nsis: { cmd: (file) => [file, ['/S']], override: (file, args) => args, raw: (file, line) => line },
  inno: {
    cmd: (file) => [file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']],
    override: (file, args) => args,
    raw: (file, line) => line,
  },
  // A vendor executable built with no installer framework git-updater recognises. It has
  // NO default switches: it runs only with switches a listing declared for this exact
  // file, or ones the user pinned in config.json — never a guess. installerCmd refuses it
  // outright when there are none.
  exe: { cmd: (file) => [file, null], override: (file, args) => args, raw: (file, line) => line },
  // macOS — installer(8) writes into /Library and needs root, so this only succeeds
  // when git-updater itself is running elevated; otherwise the caller falls back to
  // opening the .pkg in Installer.app, which prompts for authorization normally.
  pkg: {
    cmd: (file) => ['installer', ['-pkg', file, '-target', '/']],
    override: (file, args) => ['-pkg', file, ...args],
  },
  // Linux — both need root for the same reason.
  deb: {
    cmd: (file) => ['dpkg', ['-i', file]],
    override: (file, args) => [...args, file],
  },
  rpm: {
    cmd: (file) => ['rpm', ['-U', '--quiet', file]],
    override: (file, args) => [...args, file],
  },
};

// Returns { exe, args } to spawn. Per-repo install.args overrides the switches.
// `rawSwitches` is the verbatim form: a switch string a listing declared that cannot be split
// into separate arguments without changing its meaning — it quotes a value, or nests a second
// command line, as the VC++ 2005 redistributable does:
//     /Q /C:"msiexec /i ""vcredist.msi"" /quiet /norestart"
// It comes back as ONE argument with `verbatim: true`, and the caller must then start the
// process with the arguments passed through untouched (no re-quoting) and the program path
// quoted. Windows only: the kinds that have a `raw` form are the Windows ones. An argv array
// (the user's own pinned switches, or a listing's plain ones) always wins over it.
function installerCmd(kind, file, argsOverride, rawSwitches) {
  const spec = INSTALLER_SWITCHES[kind];
  if (!spec) {
    throw new Error(`unknown installer kind "${kind}" (known: ${Object.keys(INSTALLER_SWITCHES).join(', ')})`);
  }
  const [exe, defaultArgs] = spec.cmd(file);
  if (Array.isArray(argsOverride) && argsOverride.length) {
    return { exe, args: spec.override(file, argsOverride) };
  }
  if (typeof rawSwitches === 'string' && rawSwitches.trim()) {
    if (!spec.raw) throw new Error(`installer kind "${kind}" cannot take a verbatim switch string`);
    if (/"/.test(file)) throw new Error('the installer path cannot be quoted safely');
    return { exe, args: [spec.raw(file, rawSwitches.trim())], verbatim: true };
  }
  if (!defaultArgs) throw new Error(`installer kind "${kind}" has no silent switches of its own — it needs explicit ones`);
  return { exe, args: defaultArgs };
}

// ---------------------------------------------------------------------------
// Names.
//
// For a GitHub entry the repository name does four jobs at once: it is what the user
// sees, the needle used to find the installed app, the process filter, and the folder a
// portable copy unpacks into. An entry from any other source has an opaque, encoded
// `repo` (it is only a key — see src/sources/index.js), so those four jobs are done by
// `name` instead. Every caller goes through these helpers rather than reading `repo`.
// ---------------------------------------------------------------------------

function appName(r) {
  if (!r) return '';
  if (r.source) return String(r.name || r.repo || '');
  return String(r.repo || '');
}
const detectName = (r) => (r && r.detect) || appName(r);
const processName = (r) => (r && r.process) || appName(r);

// What a row is called in results, logs and the CLI: "owner/repo" for GitHub (unchanged),
// the app's name for everything else.
function displayId(r) {
  return r && r.source ? appName(r) : `${r.owner}/${r.repo}`;
}

// A folder name that is legal on every platform this app runs on. Windows is the strict
// one: no <>:"/\|?* or control characters, and no trailing dot or space.
function folderName(r) {
  if (!r || !r.source) return r ? r.repo : '';
  const cleaned = appName(r)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || 'app';
}

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

// "C:/PortableApps"  + "ShareX" -> "C:/PortableApps/ShareX"
// "/home/tj/Apps"     + "ShareX" -> "/home/tj/Apps/ShareX"
// "E:\Games"          + "ShareX" -> "E:\Games\ShareX"
// Not path.join: the separator follows what the user typed, so a folder reads the way it
// was entered (E:\Games/quiver-launcher was what a Windows user saw before this). A
// backslash is used only for a Windows-style folder, one that starts with a drive letter
// or \\server: on macOS and Linux a backslash is an ordinary character in a name, and
// joining with one there would name a different folder than the one already in use.
function resolvePortableDir(portableRoot, repoName) {
  const root = String(portableRoot);
  const sep = /^(?:[a-zA-Z]:\\|\\\\)/.test(root) ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${repoName}`;
}

// ---------------------------------------------------------------------------
// Categories: the user's own groups in the main list (Settings -> "Group apps into
// categories"). Each has a folder, and a portable app in one unpacks into
// <category folder>/<app> instead of <portableRoot>/<app>.
//
//   "categories": [{ "name": "Games", "dir": "C:/Games" }]
//   { "owner": "TeeJS", "repo": "open-quake", "type": "portable", "category": "Games" }
//
// NOT the sections of Popular apps, which src/catalog.js and the favorites file also call
// a "category". The two never meet: these live in config.json and are read only here.
//
// Where an app's files are is decided by what config.json says and nothing else. The
// Settings switch (categoriesEnabled) only shows or hides the screens that change it, so
// turning it off can never make an app look for its files somewhere else.
// ---------------------------------------------------------------------------

// Matched by name, ignoring letter case and surrounding spaces.
function findCategory(json, name) {
  if (!name || typeof name !== 'string') return null;
  const k = name.trim().toLowerCase();
  const list = json && Array.isArray(json.categories) ? json.categories : [];
  return list.find((c) => c && typeof c.name === 'string' && c.name.trim().toLowerCase() === k) || null;
}

// The folder a portable app's own folder goes in: its category's, else portableRoot.
function portableRootFor(json, r) {
  const c = findCategory(json, r && r.category);
  if (c && typeof c.dir === 'string' && c.dir.trim()) return c.dir;
  return (json && json.portableRoot) || null;
}

// Where a portable app lives when it has no folder of its own (install.dir).
function defaultPortableDir(json, r) {
  const root = portableRootFor(json, r);
  return root ? resolvePortableDir(root, folderName(r)) : null;
}

// Where a portable app lives: its own folder wins, then its category's, then portableRoot.
// The one rule the window, the scheduled install and the CLI all resolve a folder by.
function portableDirOf(json, r) {
  return (r && r.install && r.install.dir) || defaultPortableDir(json, r);
}

// A full path on either kind of system: "/home/me/Games", "C:\Games", "C:/Games",
// "\\server\share". Anything else ("Games", "~/Games") would be resolved against
// whatever folder git-updater happened to be started from.
function isFullPath(dir) {
  return typeof dir === 'string' && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(dir.trim()) && !/[\u0000-\u001f]/.test(dir);
}

function validateCategories(json) {
  if (json.categories != null) {
    if (!Array.isArray(json.categories)) throw new Error('config: "categories" must be an array');
    const seen = new Set();
    json.categories.forEach((c, i) => {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error(`categories[${i}]: "name" is required`);
      if (typeof c.dir !== 'string' || !c.dir.trim()) throw new Error(`category "${c.name}" needs a folder ("dir")`);
      if (!isFullPath(c.dir)) throw new Error(`category "${c.name}": its folder must be a full path, and "${c.dir}" is not`);
      const k = c.name.trim().toLowerCase();
      if (seen.has(k)) throw new Error(`category "${c.name}" is defined twice`);
      seen.add(k);
    });
  }
  (json.repos || []).forEach((r, i) => {
    if (r && r.category != null && !findCategory(json, r.category)) {
      throw new Error(`repos[${i}]: category "${r.category}" is not defined in "categories"`);
    }
  });
}

// Comparable form of a user-typed folder: one separator, no trailing slash, and
// case-folded on Windows, where C:/Games and c:\games are the same place.
function normDir(d, platform = process.platform) {
  const s = String(d).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

// Which portable app folders have to move when the config goes from oldCfg to newCfg:
// an app put in (or taken out of) a category, a category whose folder changed, or an
// app whose own folder (install.dir) was set, changed or cleared. [{ key, from, to }].
// A plain portableRoot change moves nothing: that has always just pointed git-updater
// at a different folder, and still does. Installer apps have no folder, an app that is
// new in newCfg has nothing to move, and an app whose type changed is a different entry.
//
// An install.dir that is unchanged is left alone. One that was already there, unchanged,
// and merely equals the old default while a category is involved (an automatic type
// correction writes it that way, see applyRetypes in electron/main.js) is NOT a choice
// anyone made, so it is dropped from newCfg here and the app follows its category like any
// other. One just set is a choice, even when it names the default folder, and is kept.
function planRelocations(oldCfg, newCfg, platform = process.platform) {
  const moves = [];
  const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;
  const same = (a, b) => normDir(a, platform) === normDir(b, platform);
  const oldByKey = new Map(((oldCfg && oldCfg.repos) || []).filter(Boolean).map((r) => [keyOf(r), r]));
  for (const r of (newCfg && newCfg.repos) || []) {
    if (!r || r.type !== 'portable') continue;
    const prev = oldByKey.get(keyOf(r));
    if (!prev) continue;
    const oldDefault = defaultPortableDir(oldCfg, prev);
    const oldPin = (prev.install && prev.install.dir) || null;
    let pin = (r.install && r.install.dir) || null;
    const inCategory = !!(findCategory(oldCfg, prev.category) || findCategory(newCfg, r.category));
    if (pin && oldPin && same(pin, oldPin) && inCategory && oldDefault && same(pin, oldDefault)) {
      delete r.install.dir;
      if (!Object.keys(r.install).length) delete r.install;
      pin = null;
    }
    // Neither end has a folder of its own and no category: only portableRoot can differ,
    // which moves nothing.
    if (!pin && !oldPin && !inCategory) continue;
    const from = oldPin || oldDefault;
    const to = pin || defaultPortableDir(newCfg, r);
    if (!from || !to || same(from, to)) continue;
    moves.push({ key: keyOf(r), from, to });
  }
  return moves;
}

// config:save takes a whole config from a window, and a window's copy can be out of date
// (config.json edited by hand while the app is open, or changed by the main process a
// moment ago). If that copy decided where apps live, saving any unrelated setting could
// quietly point an app at a folder its files are not in. So the three things that decide
// it are always kept as they are on disk: the categories, each app's category, and each
// app's own folder. They change only through the one call that also moves the files
// ("Categories and app folders" in electron/main.js). An app that is new in `next` has
// nothing on disk to protect and keeps what it came with.
function holdFolders(saved, next) {
  if (!next || !Array.isArray(next.repos)) return next;
  const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;
  const was = new Map((saved && Array.isArray(saved.repos) ? saved.repos : []).filter(Boolean).map((r) => [keyOf(r), r]));
  if (saved && saved.categories !== undefined) next.categories = saved.categories;
  else delete next.categories;
  for (const r of next.repos) {
    if (!r) continue;
    const prev = was.get(keyOf(r));
    if (!prev) {
      if (r.category != null && !findCategory(next, r.category)) delete r.category;
      continue;
    }
    if (prev.category !== undefined) r.category = prev.category;
    else delete r.category;
    const dir = prev.install && prev.install.dir;
    if (dir) r.install = { ...(r.install || {}), dir };
    else if (r.install && r.install.dir !== undefined) {
      delete r.install.dir;
      if (!Object.keys(r.install).length) delete r.install;
    }
  }
  return next;
}

// Per-download size cap, in bytes; null means no cap. Configs that never set it keep the
// original 500 MiB. Explicitly disabling it (downloadLimitEnabled: false) removes the cap.
// Hand-ported from EstusFlask/git-updater-background (flash201524), commit 4d89769.
function downloadLimitBytes(config) {
  if (config.downloadLimitEnabled != null && typeof config.downloadLimitEnabled !== 'boolean') {
    throw new Error('downloadLimitEnabled must be a boolean');
  }
  const mib = config.downloadLimitMiB == null ? 500 : config.downloadLimitMiB;
  if (!Number.isSafeInteger(mib) || mib < 1 || mib > 1048576) {
    throw new Error('downloadLimitMiB must be a whole number from 1 to 1048576');
  }
  return config.downloadLimitEnabled === false ? null : mib * 1024 * 1024;
}

// Validates, and fills each portable entry's install.dir from its category's folder, or
// the top-level portableRoot, when omitted. Mutates json in place so callers get resolved
// dirs. The window, the scheduled install and the CLI all come through here, so a
// categorised app resolves to the same folder for all three.
function validateConfig(json) {
  if (!json || !Array.isArray(json.repos)) throw new Error('config: "repos" array is required');
  downloadLimitBytes(json);
  validateCategories(json);
  json.repos.forEach((r, i) => {
    const at = `repos[${i}]`;
    if (!r.owner || !r.repo) throw new Error(`${at}: "owner" and "repo" are required`);
    // A non-GitHub entry says where it comes from. Only the shape is checked here (this
    // module does no IO and knows no providers); src/sources/index.js validates the rest
    // and derives owner/repo from it.
    if (r.source != null) {
      if (typeof r.source !== 'object' || typeof r.source.type !== 'string' || !r.source.type) {
        throw new Error(`${at}: "source" must be an object with a "type"`);
      }
      if (typeof r.name !== 'string' || !r.name.trim()) throw new Error(`${at}: a "name" is required for an app with a "source"`);
    }
    if (r.type !== 'portable' && r.type !== 'installer') {
      throw new Error(`${at}: "type" must be "portable" or "installer"`);
    }
    // tagPrefix pins release lookup to one train in a multi-product repo (e.g. "desktop-v"
    // for bitwarden/clients, which also publishes web-v*/browser-v*/cli-v* under one repo).
    if (r.tagPrefix != null && (typeof r.tagPrefix !== 'string' || !r.tagPrefix)) {
      throw new Error(`${at}: "tagPrefix" must be a non-empty string`);
    }
    // asset is optional: omitted -> engine auto-picks this platform's asset from `type`.
    if (r.type === 'portable') {
      if (!r.install) r.install = {};
      if (!r.install.dir) {
        const dir = defaultPortableDir(json, r);
        if (!dir) throw new Error(`${at}: portable requires install.dir or a top-level portableRoot`);
        r.install.dir = dir;
      }
    } else {
      // installer: kind is optional (auto-guessed from the picked file); if set, it must be valid.
      if (r.install && r.install.kind && !INSTALLER_SWITCHES[r.install.kind]) {
        throw new Error(`${at}: install.kind must be one of ${Object.keys(INSTALLER_SWITCHES).join(', ')}`);
      }
    }
  });
  return json;
}

// ---------------------------------------------------------------------------
// Run summary.
// ---------------------------------------------------------------------------

// results: [{ repo, status:'updated'|'current'|'failed', from?, to?, reason?, note? }]
function buildSummary(results) {
  const counts = { updated: 0, current: 0, failed: 0 };
  const lines = [];
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'updated') {
      lines.push(`  ✓ ${r.repo}  ${r.from || '—'} → ${r.to}${r.note ? '  (' + r.note + ')' : ''}`);
    } else if (r.status === 'current') {
      // A type correction lands here whenever the app turns out to be installed already,
      // which is the common case for one the user tracked with the wrong type. Dropping
      // the note would make the CLI the one path where that change happens silently.
      lines.push(`  · ${r.repo}  ${r.to} (already current)${r.note ? '  (' + r.note + ')' : ''}`);
    } else {
      lines.push(`  ✗ ${r.repo}  ${r.reason}`);
    }
  }
  const header = `updated ${counts.updated}, current ${counts.current}, failed ${counts.failed}`;
  return { text: [header, ...lines].join('\n'), counts };
}

// Pick which file to launch for a PORTABLE app from its install manifest. `files` are
// manifest-relative paths (any separator), `repoName` biases the choice toward the app's
// own binary, `platform` is process.platform. Returns the chosen relative path, or null
// when nothing launchable is present. Pure — no IO; the caller joins it to the install dir
// and confirms it exists.
//
// isExec: optional predicate, given a manifest-relative path, answering "does this have
// the execute bit". On Unix that is the only real evidence a file is a program, and this
// module may not stat, so the caller supplies it. Without it the name alone decides,
// which is how Windows works anyway (there, .exe IS the evidence).
function pickLaunchFile(files, repoName, platform, isExec) {
  const list = (files || []).map((f) => String(f).replace(/\\/g, '/')).filter(Boolean);
  if (!list.length) return null;
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const depth = (p) => p.split('/').length;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(repoName);
  const named = (arr, key) => arr.find((p) => { const n = norm(key(p)); return want && (n === want || n.includes(want) || want.includes(n)); });

  if (platform === 'darwin') {
    // A .app bundle is many manifest entries under Foo.app/…; the launch target is the
    // bundle directory itself. Take the shallowest .app prefix, name-matched if possible.
    const apps = [...new Set(list.map((p) => { const m = /^(.*?\.app)(\/|$)/i.exec(p); return m ? m[1] : null; }).filter(Boolean))]
      .sort((a, b) => depth(a) - depth(b) || a.length - b.length);
    if (!apps.length) return null;
    return named(apps, (p) => base(p).replace(/\.app$/i, '')) || apps[0];
  }

  if (platform === 'win32') {
    // Drop the executables that ship ALONGSIDE the app but are not it: uninstallers,
    // bundled redistributables, crash/updater helpers. If that leaves nothing, fall back
    // to the unfiltered set rather than refuse to launch.
    const NOISE = ['unins', 'setup', 'install', 'update', 'vcredist', 'dxsetup', 'dotnet', 'crashpad', 'crashhandler', 'crashreporter', 'reporter', 'helper', 'updater'];
    const isNoise = (p) => { const b = norm(base(p).replace(/\.exe$/i, '')); return NOISE.some((n) => b.includes(n)); };
    let exes = list.filter((p) => /\.exe$/i.test(p));
    const kept = exes.filter((p) => !isNoise(p));
    if (kept.length) exes = kept;
    if (!exes.length) return null;
    const score = (p) => {
      const nb = norm(base(p).replace(/\.exe$/i, ''));
      let s = -depth(p) - p.length / 1000; // prefer shallow, then shorter, as a stable tie-break
      if (want && nb === want) s += 100;
      else if (want && (nb.includes(want) || want.includes(nb))) s += 50;
      return s;
    };
    return exes.slice().sort((a, b) => score(b) - score(a))[0];
  }

  // linux: an AppImage if present, else the top-level extension-less binary.
  const appimg = list.filter((p) => /\.appimage$/i.test(p)).sort((a, b) => depth(a) - depth(b) || a.length - b.length);
  if (appimg.length) return named(appimg, base) || appimg[0];
  // "No extension" is a weak signal on its own: LICENSE, README, CHANGELOG, AUTHORS and
  // COPYING all pass it, and a tarball that carries no Linux binary at all — a Windows app
  // tracked as portable — has nothing BUT those. notepad-plus-plus resolved to
  // updater/LICENSE this way. The execute bit is the real evidence, so use it when the
  // caller can supply it, and fall back to excluding the usual documents by name.
  const DOCS = /^(license|licence|readme|changelog|changes|authors|copying|notice|install|news|todo|version|manifest|makefile|dockerfile)$/i;
  let bins = list.filter((p) => !/\.[a-z0-9]{1,5}$/i.test(base(p)) && !DOCS.test(base(p)));
  if (typeof isExec === 'function') {
    const runnable = bins.filter((p) => { try { return isExec(p); } catch { return false; } });
    // Only narrow when the check actually found something. A manifest whose modes were
    // lost (a .zip carries none) would otherwise go from "wrong file" to "no file".
    if (runnable.length) bins = runnable;
  }
  bins.sort((a, b) => depth(a) - depth(b) || a.length - b.length);
  if (!bins.length) return null;
  return named(bins, base) || bins[0];
}

module.exports = {
  normTag,
  cmpVersion,
  pickLaunchFile,
  alignInstalledVersion,
  compilePattern,
  matchAsset,
  pickAsset,
  pickWindowsAsset,
  assetPatternFor,
  classifyAssets,
  guessKind,
  installerCmd,
  validateConfig,
  downloadLimitBytes,
  resolvePortableDir,
  findCategory,
  portableRootFor,
  defaultPortableDir,
  portableDirOf,
  validateCategories,
  normDir,
  planRelocations,
  holdFolders,
  appName,
  detectName,
  processName,
  displayId,
  folderName,
  buildSummary,
  INSTALLER_SWITCHES,
};
