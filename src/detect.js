'use strict';

// Installed-version and running-process detection, over whatever inventory the
// running platform actually has: the uninstall registry on Windows, .app bundles on
// macOS, the package managers on Linux. All of that lives in src/platform/; this file
// is the matching logic on top, and is identical everywhere.
//
// Everything here is ASYNC: the inventory calls take seconds, and a sync version would
// freeze the Electron main process (window paint, IPC) for that whole time.

const fs = require('fs');
const platform = require('./platform');
const { cmpVersion } = require('./core');

const norm = (s) => String(s || '').toLowerCase().replace(/\.(exe|app)$/, '').replace(/[^a-z0-9]/g, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- name matching -----------------------------------------------------------
//
// A repo name and an inventory name are never spelled the same way: "brave-browser" is
// "Brave" in the uninstall registry, "notepad-plus-plus" is "Notepad++", "obs-studio" is
// "OBS Studio 32.2.2". So the match has to be loose. It was loose by raw substring, and
// that is wrong in a way no Windows or macOS inventory could show:
//
//   needle "bedrock-panel" -> "bedrockpanel", which CONTAINS "ed", and dpkg has a package
//   named `ed` (GNU ed, 1.22.4-1). Bedrock Panel reported itself installed at 1.22.4,
//   which is above every release it has, so it read as up to date and the real update was
//   never offered. An updater that silently declines to update is worse than one that errors.
//
// Two things were wrong, and both had to be fixed to clear that row.
//
// 1. Letters, not tokens. Matching now runs on TOKEN boundaries: one name must be the
//    other's whole normalized form, or a contiguous RUN of its tokens. "brave" is a token
//    of "brave-browser", "7zip" is the run 7+zip inside "7-Zip 26.02 (x64 edition)",
//    "firefox" is a token of "Mozilla Firefox". "ed" is two letters in the middle of one
//    token of "bedrock-panel", so it is no longer a match; neither is libtesseract5
//    against "tesseract", a pair src/catalog.js documents for its own regexes.
//
// 2. Direction, on Linux. A token rule alone still matched the `git` package to the
//    needle "git-updater" — a leading token is no proof, and nothing lexical separates
//    git/git-updater from Brave/brave-browser. What separates them is the namespace.
//    Windows and macOS names are HUMAN-FACING, a few hundred of them, and the extra words
//    land on either side ("Brave" for brave-browser, "OBS Studio 32.2.2" for obs-studio),
//    so both directions have to stay open there. A Linux name is a MACHINE identifier the
//    upstream chose: the Brave package IS "brave-browser". So Linux accepts only the
//    needle being the shorter side — "joplin" matches the joplin-desktop package, `git`
//    never matches git-updater. This is the conclusion src/catalog.js reached about its
//    regexes against the same namespace, for the same reason: 2825 rows of short machine
//    identifiers, many of them ordinary English words (`ed`, `bc`, `dc`, `at`, `jq`, `iw`).
//
// A name this cannot bridge (microsoft/vscode vs the `code` package) is what the per-app
// `detect` override is for. A missed row costs the user one manual field; a wrong row
// costs them an update they never learn about.

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\.(exe|app)$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Every contiguous run of a name's tokens, joined: "obs-studio" -> obs, obsstudio, studio.
function tokenRuns(name) {
  const t = tokens(name);
  const out = new Set();
  for (let i = 0; i < t.length; i++) {
    let run = '';
    for (let j = i; j < t.length; j++) {
      run += t[j];
      out.add(run);
    }
  }
  return out;
}

// Do these two names refer to the same app? Pure, so the whole table is unit-testable
// from any host — which is why the platform is a parameter and not process.platform.
// `plat`, not `platform`: the module of that name is this file's IO layer, and shadowing
// it inside the one pure function here is how that stops being obvious.
function nameMatches(name, needle, plat) {
  const n = norm(name);
  const t = norm(needle);
  if (n.length < 2 || t.length < 2) return false;
  if (n === t) return true;
  // Linux: the inventory name is the upstream's own identifier, so only the needle may be
  // the shorter side. Elsewhere the names are human-facing and either side may carry the
  // extra words, so a run in either direction counts.
  const needleInName = tokenRuns(name).has(t);
  if ((plat || process.platform) === 'linux') return needleInName;
  return needleInName || tokenRuns(needle).has(n);
}

let cache = null; // cleared after installs so fresh versions show
function clearCache() {
  cache = null;
}

// Every installed app: [{ name, version, flavor }]. One inventory pass per run.
// DisplayName/DisplayVersion are kept as aliases because src/catalog.js and the
// open-quake drop-in read the records under those names.
async function allInstalled() {
  if (cache) return cache;
  const rows = await platform.installedApps();
  cache = rows
    .filter((e) => e && e.name && e.version)
    .map((e) => ({ ...e, DisplayName: e.name, DisplayVersion: e.version }));
  return cache;
}

async function matchEntries(needle) {
  return (await allInstalled()).filter((e) => nameMatches(e.name, needle));
}

// Best version for an app whose inventory name matches `needle`. An app can have
// several entries (e.g. an old EXE install alongside a newer MSI install, or a deb
// and a flatpak) — report the highest version. null = not installed.
async function installedVersion(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  return hits.map((h) => h.version).sort(cmpVersion).pop();
}

// How is the app currently installed — 'msi'/'exe' on Windows, 'deb'/'rpm'/'flatpak'/
// 'snap' on Linux, 'app' on macOS? null when not installed. Used to pick the SAME
// package format on update, so a second copy never lands beside the first.
async function installedFlavor(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVersion(a.version, b.version));
  return hits[hits.length - 1].flavor || null;
}

// Where to launch an installed app from — the highest-versioned matching entry's own
// path (a Windows exe from DisplayIcon, or a macOS .app bundle) and its install directory
// (Windows InstallLocation). null when nothing matches. The Electron side confirms the
// path exists and, failing that, hunts the directory (see electron/main.js). Used by
// "Open App"; installer apps only (portables launch from their own file manifest).
async function launchTarget(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVersion(a.version, b.version));
  const best = hits[hits.length - 1];
  if (best.path || best.location) return { path: best.path || null, location: best.location || null };
  // Nothing launchable on the row itself. Windows puts a program path in the uninstall
  // registry, but dpkg, rpm, flatpak and snap all inventory PACKAGES, so the platform
  // layer has to go and find the program. Asked only for the one app being opened,
  // because it costs a subprocess.
  return (await platform.launchTargetFor(best.name, best.flavor)) || { path: null, location: null };
}

// --- running-process detection (for a proactive "close the app" warning) ------

// Process names carry the same hazard as inventory names — /usr/bin/ed is a running
// process too — so they go through the same token match. One extra clause: Linux `comm`
// is truncated by the kernel at 15 characters, which chops a longer name mid-token and
// no token rule can bridge that. A 15-character prefix of the needle is accepted as the
// truncation it is.
function procMatches(procName, needle) {
  if (nameMatches(procName, needle)) return true;
  const pn = norm(procName);
  const t = norm(needle);
  return pn.length >= 15 && t.startsWith(pn);
}

async function matchProcs(needle) {
  if (norm(needle).length < 3) return [];
  return (await platform.runningProcesses()).filter((p) => procMatches(p.name, needle));
}

// Is a process whose name looks like `needle` running? Loose token match (so
// "notepad-plus-plus" matches "notepad++.exe"); override per app with `process`.
async function isRunning(needle) {
  return (await matchProcs(needle)).length > 0;
}

// Close the running processes for `needle` — graceful by default (WM_CLOSE on Windows,
// SIGTERM elsewhere), or forced. Waits briefly for exit.
// ponytail: kill by PID; force can lose unsaved work, so the UI double-confirms it.
async function closeApp(needle, opts = {}) {
  const procs = await matchProcs(needle);
  for (const p of procs) platform.killProcess(p.pid, !!opts.force);
  for (let i = 0; i < 15 && (await isRunning(needle)); i++) await wait(200); // up to ~3s to exit
  return { closed: procs.length, stillRunning: await isRunning(needle) };
}

// --- host distro --------------------------------------------------------------
//
// The running Linux release, for projects that ship one package per distro release
// (OBS ships an Ubuntu-24.04 .deb and an Ubuntu-26.04 .deb in the same release).
// core.pickAsset takes this as data so it stays IO-free. Kubuntu, Xubuntu and the rest
// all report ID=ubuntu, which is what the package filenames say, so no flavour mapping
// is needed. Cached: /etc/os-release cannot change while the process runs.
let _osRelease;
function osRelease() {
  if (_osRelease !== undefined) return _osRelease;
  _osRelease = null;
  if (process.platform === 'linux') {
    try {
      const txt = fs.readFileSync('/etc/os-release', 'utf8');
      const get = (k) => {
        const m = new RegExp(`^${k}=(.*)$`, 'm').exec(txt);
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
      };
      const id = get('ID');
      const versionId = get('VERSION_ID');
      if (id && versionId) _osRelease = { id, versionId };
    } catch {
      // No /etc/os-release (container, exotic distro) — scoring just skips the release term.
    }
  }
  return _osRelease;
}

module.exports = {
  nameMatches,
  osRelease,
  installedVersion,
  installedFlavor,
  launchTarget,
  isRunning,
  closeApp,
  clearCache,
  allInstalled,
  // Former name, kept so the vendored open-quake drop-in keeps working.
  registryVersion: installedVersion,
};
