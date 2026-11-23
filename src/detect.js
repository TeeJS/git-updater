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
const catalog = require('./catalog');

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

// Words that mark an installed name as something that travels WITH an app, not the app:
// "Claude Code URL Handler" is not Claude Code, "Microsoft Edge Update" is not Edge, and
// git-updater is not Git. When the longer of two loosely matching names carries one of these
// beyond what the shorter one says, they are two different things.
const COMPANION = new Set(['handler', 'helper', 'uninstaller', 'uninstall', 'updater', 'update']);

function companionOnly(name, needle) {
  const a = tokens(name);
  const b = tokens(needle);
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  const said = new Set(short);
  return long.some((t) => COMPANION.has(t) && !said.has(t));
}

// Is the inventory row called `name` the app an entry calls `needle`? nameMatches is the
// lexical half. The other half is what the lexical rule cannot see: a helper that carries the
// app's name, and an installed name that is a DIFFERENT known app outright ("Claude" for the
// entry claude-code) — see ownedByAnother in src/catalog.js. An exact match skips both: an
// entry always matches its own name.
function sameApp(name, needle, plat) {
  if (!nameMatches(name, needle, plat)) return false;
  if (norm(name) === norm(needle)) return true;
  return !companionOnly(name, needle) && !catalog.ownedByAnother(name, needle);
}

let cache = null; // cleared after installs so fresh versions show
function clearCache() {
  cache = null;
  registered = null;
  folderPrograms.clear();
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

// A packaged (MSIX) app is inventoried under its package IDENTITY — "MicrosoftCorporationII.
// Windows365" for Windows App — a machine identifier with hundreds of system packages beside
// it. Like a Linux package name, it is never matched loosely: only a needle that IS that
// identity matches, which is what an entry's `detect` field carries for such an app.
const sameIdentity = (name, needle) => String(name || '').toLowerCase() === String(needle || '').trim().toLowerCase();

async function matchEntries(needle) {
  return (await allInstalled()).filter((e) => (e.packaged ? sameIdentity(e.name, needle) : sameApp(e.name, needle)));
}

// Best version for an app whose inventory name matches `needle`. An app can have
// several entries (e.g. an old EXE install alongside a newer MSI install, or a deb
// and a flatpak) — report the highest version. null = not installed.
async function installedVersion(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  return hits.map((h) => h.version).sort(cmpVersion).pop();
}

// Date of the highest-versioned matching OS install, when its inventory provides one.
async function installedDate(needle) {
  const hits = await matchEntries(needle);
  if (!hits.length) return null;
  hits.sort((a, b) => cmpVersion(a.version, b.version));
  return hits[hits.length - 1].installDate || null;
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

// Which running processes are an app's? What is decided here is what gets CLOSED — and, with
// force, killed — so the rule is strict, not loose like the inventory match above. That loose
// match was used here too, and it accepted a process named after any ONE WORD of an app's name:
//
//   the entry `git` (git-for-windows/git) matched git-updater.exe. The Git row always read
//   "git is running", and its Force close killed git-updater itself.
//   `notepad-plus-plus` matched Windows' own notepad.exe; "Bambu Studio" would match any
//   Studio.exe, "Google Chrome" any Google.exe, "faction-wars-editor" any Editor.exe.
//
// A process is an app's only when:
//   1. its name IS the app's name                        Joplin.exe for joplin
//   2. its name STARTS WITH the app's name, on a word    PowerToys.Awake.exe, deskflow-core.exe,
//      boundary — the app's own helpers                  "Claude Helper" for Claude
//      (and, where the app's folder is known, only a     git-bash.exe yes, git-town.exe no:
//      program that exists in it — see helperPrograms)   it is not in C:/Program Files/Git
//   3. it is the app's main program, as the operating    brave.exe for brave-browser, obs64.exe for
//      system records it (see mainPrograms)              obs-studio, msedge.exe for Microsoft Edge
// and never when it is git-updater itself (see isSelf), nor when its name is a different known
// app outright ("Claude" for the entry claude-code — ownedByAnother in src/catalog.js).
//
// A process that is merely one word OF the app's name no longer counts. A name these rules
// cannot bridge is what the per-app `process` override is for: a process missed costs a
// "close it first" message, a wrong one costs somebody their unsaved work.
//
// One extra clause, unchanged: Linux `comm` is truncated by the kernel at 15 characters, which
// chops a longer name mid-token. A 15-character prefix of the needle is the truncation it is.
const bare = (s) => String(s || '').trim().toLowerCase().replace(/\.(exe|app)$/, '');

// Which of the rules above makes this process the app's: 'name', 'helper', 'program',
// 'truncated' — or null when none does. Pure.
function procMatchKind(procName, needle, programs = []) {
  const pn = norm(procName);
  const t = norm(needle);
  if (pn.length < 2 || t.length < 2) return null;
  if (pn !== t && catalog.ownedByAnother(procName, needle)) return null;
  if (pn === t) return 'name';
  // The main program, by its exact file name: "notepad++" is not "notepad".
  const raw = bare(procName);
  if (programs.some((name) => bare(name) === raw)) return 'program';
  // The app's name, then more words: a leading run of the process's tokens spells the name.
  const p = tokens(procName);
  let lead = '';
  for (let i = 0; i < p.length - 1; i++) {
    lead += p[i];
    if (lead === t) return 'helper';
    if (lead.length >= t.length) break;
  }
  return pn.length >= 15 && t.startsWith(pn) ? 'truncated' : null;
}

const procMatches = (procName, needle, programs) => procMatchKind(procName, needle, programs) !== null;

// The program an installed app is started from, as the operating system records it: the exe
// named by the uninstall registry's DisplayIcon on Windows, the .app bundle on macOS, whatever
// the package's launcher runs on Linux. -> file names (no folder), possibly none.
//
// A recorded program that is really a shared host or an installer is left out: an app whose
// icon is javaw.exe must not make closing it close every Java program on the machine.
//
// And only an inventory row that is THE APP ITSELF supplies it — the loose inventory match is
// not enough here. "Microsoft Edge WebView2 Runtime" matches the entry Microsoft Edge loosely,
// and its program is msedgewebview2.exe: the shared runtime inside Teams, Outlook and a dozen
// other apps. So the row's name must be the app's name with nothing added but decoration (a
// version, an architecture: "OBS Studio 32.2.2", "7-Zip 26.06 (x64)"), or the leading words of
// it ("Brave" for brave-browser).
const INSTALLER_PROGRAM = /^(?:unins|setup|install|update)/i;
const SHARED_PROGRAM = /^(?:javaw?|pythonw?|node|electron|dotnet|cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|msiexec|explorer|conhost|svchost|bash|sh)[\d.]*$/i;
const DECORATION = /^(?:\d+|v\d+|x64|x86|x32|arm64|amd64|win64|win32|64bit|32bit|bit|edition|version)$/;

function isTheApp(rowName, needle) {
  const t = norm(needle);
  const r = tokens(rowName);
  if (norm(rowName) === t) return true;
  // The row says more than the app's name: everything else must be decoration.
  for (let i = 0; i < r.length; i++) {
    let run = '';
    for (let j = i; j < r.length; j++) {
      run += r[j];
      if (run === t) return [...r.slice(0, i), ...r.slice(j + 1)].every((word) => DECORATION.test(word));
      if (run.length >= t.length) break;
    }
  }
  // The row says less: it must be how the app's name begins.
  const n = tokens(needle);
  let lead = '';
  for (let k = 0; k < n.length - 1; k++) {
    lead += n[k];
    if (lead === norm(rowName)) return true;
  }
  return false;
}

// The inventory does not always name a program: an MSI install of Google Chrome records
// neither an icon nor a folder. Windows has a second record, "App Paths", where programs
// register their own exe (see src/platform/win.js). A registered program is the app's when it
// lives in the app's OWN folder — the path ends with the app's whole name, once the generic
// last folders and any version are set aside:
//
//   C:\Program Files\Google\Chrome\Application\chrome.exe   -> "Google Chrome"   yes
//   C:\Program Files\Audacity 4\bin\Audacity4.exe           -> "audacity"        yes
//   C:\Program Files\Google\Chrome\Application\chrome.exe   -> "Google"          no: the folder
//                                                              is Chrome's, not all of Google's
const GENERIC_FOLDER = /^(?:application|app|bin|binaries|x64|x86|win64|win32|64bit|32bit)$/i;

// The app's own folder, from a folder path the system recorded for it — or null when that path
// is not the app's own. "Own" is the test above: the path ends with the app's whole name once
// the generic last folders and a version are set aside. What comes back is that folder, so
// ...\Google\Chrome\Application gives ...\Google\Chrome.
function ownFolder(dir, needle) {
  const t = norm(needle);
  if (t.length < 3) return null;
  const text = String(dir || '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  while (parts.length && GENERIC_FOLDER.test(parts[parts.length - 1])) parts.pop();
  const words = parts.filter((part) => !/^[a-z]:$/i.test(part)).flatMap((part) => tokens(part));
  while (words.length && DECORATION.test(words[words.length - 1])) words.pop();
  let run = '';
  for (let i = words.length - 1; i >= 0; i--) {
    run = words[i] + run;
    if (run === t) {
      const sep = text.includes('\\') ? '\\' : '/';
      return (/^[\\/]/.test(text) ? sep : '') + parts.join(sep);
    }
    if (run.length >= t.length) return null;
  }
  return null;
}
const folderOf = (file) => String(file || '').replace(/[\\/]+[^\\/]*$/, '');
const inOwnFolder = (file, needle) => ownFolder(folderOf(file), needle) !== null;

let registered = null; // App Paths, read once per run like the inventory (see clearCache)
async function registeredPrograms() {
  if (!registered) registered = await platform.registeredPrograms();
  return registered;
}

// What the system has on record about an installed app, for telling its processes apart:
//   programs  the file names of its main program(s)        ['chrome.exe']
//   folders   its own install folder(s), where one is known ['C:\\Program Files\\Git']
async function appRecord(needle) {
  const paths = [];
  const folders = new Set();
  const own = (dir) => { const folder = ownFolder(dir, needle); if (folder) folders.add(folder); };
  try {
    for (const file of await registeredPrograms()) {
      if (!inOwnFolder(file, needle)) continue;
      paths.push(file);
      own(folderOf(file));
    }
  } catch {
    // No such record here (or it failed): the inventory and the name rules still apply.
  }
  try {
    const rows = (await matchEntries(needle)).filter((row) => row.packaged || isTheApp(row.name, needle));
    for (const row of rows) {
      if (row.path) paths.push(row.path);
      if (row.path) own(folderOf(row.path));
      // InstallLocation is a folder — except when an installer wrote its exe there instead.
      if (row.location) own(/\.exe$/i.test(row.location) ? folderOf(row.location) : row.location);
    }
    if (!paths.length && rows.length) {
      // Nothing launchable on the rows themselves (a Linux package): ask the platform.
      rows.sort((a, b) => cmpVersion(a.version, b.version));
      const best = rows[rows.length - 1];
      const target = await platform.launchTargetFor(best.name, best.flavor);
      if (target && target.path) paths.push(target.path);
    }
  } catch {
    // No inventory (or it failed): the name rules still apply.
  }
  const names = paths
    .map((file) => String(file).split(/[\\/]/).pop())
    // A Linux launcher is often a .desktop entry: that is not a program, so it names no process.
    .filter((name) => name && !/\.desktop$/i.test(name) && !INSTALLER_PROGRAM.test(bare(name)) && !SHARED_PROGRAM.test(bare(name)));
  return { programs: [...new Set(names)], folders: [...folders] };
}
const mainPrograms = async (needle) => (await appRecord(needle)).programs;

// A "helper" match rests on the name alone, and a name can be someone else's: `git-town.exe`
// starts with "git" and is no part of Git for Windows. Where the app's own folder is known, a
// helper must also be a program that EXISTS in that folder: git-bash.exe is in
// C:\Program Files\Git, git-town.exe is not.
//
// -> the program names found in the folders (lower case, no .exe), or null when that cannot
// be said: no folder on record, a folder that cannot be read, or one too large to list. null
// leaves the name rule as it is; it never turns a helper away.
const FOLDER_DEPTH = 6; // Git keeps git-remote-https.exe at mingw64\libexec\git-core
const FOLDER_BUDGET = 60000; // entries looked at, across one app's folders
const folderPrograms = new Map(); // folder -> Set | null, for this run (see clearCache)

async function programsIn(folder) {
  if (folderPrograms.has(folder)) return folderPrograms.get(folder);
  const names = new Set();
  let budget = FOLDER_BUDGET;
  let complete = true;
  const walk = async (dir, depth) => {
    let list;
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      if (depth === 0) complete = false; // the folder itself is gone or unreadable
      return;
    }
    for (const entry of list) {
      if (--budget < 0) { complete = false; return; }
      if (entry.isDirectory()) {
        if (depth < FOLDER_DEPTH) await walk(`${dir}/${entry.name}`, depth + 1);
      } else if (/\.exe$/i.test(entry.name) || !entry.name.includes('.')) {
        names.add(bare(entry.name));
      }
    }
  };
  await walk(folder, 0);
  const result = complete && names.size ? names : null;
  folderPrograms.set(folder, result);
  return result;
}

async function helperPrograms(folders) {
  let all = null;
  for (const folder of folders || []) {
    const names = await programsIn(folder);
    if (!names) continue;
    all = all || new Set();
    for (const name of names) all.add(name);
  }
  return all;
}

// git-updater's own processes are never an app's, whatever the app is called. Its program
// file (every Electron process of the running app shares it, and so does the launcher that
// started it), its own process, and anything named git-updater.
const SELF_PROGRAM = bare(String(process.execPath || '').split(/[\\/]/).pop());
function isSelf(proc) {
  if (String(proc.pid) === String(process.pid)) return true;
  if (SELF_PROGRAM && bare(proc.name) === SELF_PROGRAM) return true;
  const t = tokens(proc.name);
  return t[0] === 'git' && t[1] === 'updater';
}

// The processes in `procs` that are the app's: the name rules, minus git-updater itself, minus
// any helper that is not a program in the app's own folder (where that folder is known).
// `record` is appRecord(needle); it is passed in so one close asks the system once.
async function ownProcesses(procs, needle, record) {
  if (norm(needle).length < 3) return [];
  const known = record || (await appRecord(needle));
  const hits = [];
  for (const proc of procs) {
    if (isSelf(proc)) continue;
    const kind = procMatchKind(proc.name, needle, known.programs);
    if (kind) hits.push({ proc, kind });
  }
  if (!hits.some((hit) => hit.kind === 'helper')) return hits.map((hit) => hit.proc);
  const inFolder = await helperPrograms(known.folders);
  return hits.filter((hit) => hit.kind !== 'helper' || !inFolder || inFolder.has(bare(hit.proc.name))).map((hit) => hit.proc);
}

async function matchProcs(needle, record) {
  if (norm(needle).length < 3) return [];
  return ownProcesses(await platform.runningProcesses(), needle, record || (await appRecord(needle)));
}

// Is one of the app's processes running? See procMatchKind for what counts; override per app
// with `process`.
async function isRunning(needle, record) {
  return (await matchProcs(needle, record)).length > 0;
}

// Close the running processes for `needle` — graceful by default (WM_CLOSE on Windows,
// SIGTERM elsewhere), or forced. Waits briefly for exit.
// ponytail: kill by PID; force can lose unsaved work, so the UI double-confirms it.
async function closeApp(needle, opts = {}) {
  const record = await appRecord(needle); // once: the wait below asks several times
  const procs = await matchProcs(needle, record);
  for (const p of procs) platform.killProcess(p.pid, !!opts.force);
  for (let i = 0; i < 15 && (await isRunning(needle, record)); i++) await wait(200); // up to ~3s to exit
  return { closed: procs.length, stillRunning: await isRunning(needle, record) };
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
  sameApp,
  procMatches,
  procMatchKind,
  mainPrograms,
  appRecord,
  ownProcesses,
  isSelf,
  osRelease,
  installedVersion,
  installedDate,
  installedFlavor,
  launchTarget,
  isRunning,
  closeApp,
  clearCache,
  allInstalled,
  // Former name, kept so the vendored open-quake drop-in keeps working.
  registryVersion: installedVersion,
};
