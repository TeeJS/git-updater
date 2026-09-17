'use strict';

// Linux: there is no single registry. An app can arrive as a .deb, an .rpm, a Flatpak
// or a Snap, and each format keeps its own inventory — so all four are queried in
// parallel, exactly as the three uninstall hives are on Windows, and the ones that
// aren't installed simply return nothing.
//
// AppImages are deliberately absent: they register nowhere by design. Those are
// tracked as portable apps, where the engine's own install manifest is the record.

const path = require('path');
const { run, runStatus, spawnDetached } = require('./exec');

// --- version cleaning --------------------------------------------------------

// Debian versions carry packaging metadata a GitHub tag never has. Per the Debian
// policy format `[epoch:]upstream_version[-debian_revision]`:
//   "2:1.2.3-1ubuntu2" -> "1.2.3"     epoch and revision are packaging, not upstream
//   "1.2.3~rc1-1"      -> "1.2.3-rc1"  "~" is Debian's prerelease marker, "-" is ours
//   "1.2.3"            -> "1.2.3"      a native package has no revision at all
// Pure; exported for tests.
function cleanDebVersion(v) {
  return String(v || '')
    .replace(/^\d+:/, '') // epoch
    .replace(/-[^-]*$/, '') // debian revision: everything after the LAST hyphen
    .replace(/~/g, '-') // Debian sorts "~" below everything, same role as semver "-"
    .trim();
}

// --- dpkg --------------------------------------------------------------------

// Parse `dpkg-query -W -f=${db:Status-Abbrev}\t${Package}\t${Version}\n`.
// Only fully installed packages count. dpkg also lists ones that were removed with their
// configuration retained, and offering to "update" something the user uninstalled is
// worse than not listing it at all. Status "ii" is installed; everything else is skipped.
function parseDpkg(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [status, name, version] = line.split('\t');
    if (!status || !name || !version) continue;
    if (status.trim() !== 'ii') continue;
    const v = cleanDebVersion(version);
    if (v) out.push({ name: name.trim(), version: v, flavor: 'deb' });
  }
  return out;
}

// --- rpm ---------------------------------------------------------------------

// Parse `rpm -qa --qf %{NAME}\t%{VERSION}\n`. RPM keeps the release in a separate
// field, so %{VERSION} is already the upstream version.
function parseRpm(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, version] = line.split('\t');
    if (!name || !version || version === '(none)') continue;
    out.push({ name: name.trim(), version: version.trim(), flavor: 'rpm' });
  }
  return out;
}

// --- flatpak -----------------------------------------------------------------

// Parse `flatpak list --app --columns=name,version` (tab separated). Flatpaks with no
// declared version are skipped — there is nothing to compare a release tag against.
function parseFlatpak(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [name, version] = line.split('\t');
    if (!name || !version) continue;
    out.push({ name: name.trim(), version: version.trim(), flavor: 'flatpak' });
  }
  return out;
}

// --- snap --------------------------------------------------------------------

// Parse `snap list`: a header row, then whitespace-aligned columns
// (Name Version Rev Tracking Publisher Notes).
function parseSnap(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    if (cols[0] === 'Name') continue; // header
    // Any prose line splits into columns too, and would otherwise become a package:
    // "No snaps are installed yet." yields one named "No" at version "snaps". A version
    // column has to contain a digit.
    if (!/\d/.test(cols[1])) continue;
    out.push({ name: cols[0], version: cols[1], flavor: 'snap' });
  }
  return out;
}

// --- inventory ---------------------------------------------------------------

// All four package managers at once. Any that isn't installed exits nonzero or not at
// all, which run() turns into '' — so an Ubuntu box simply contributes dpkg + snap and
// a Fedora box rpm + flatpak, with no per-distro branching anywhere.
async function installedApps() {
  const [deb, rpm, flatpak, snap] = await Promise.all([
    run('dpkg-query', ['-W', '-f=${db:Status-Abbrev}\\t${Package}\\t${Version}\\n']),
    run('rpm', ['-qa', '--qf', '%{NAME}\\t%{VERSION}\\n']),
    run('flatpak', ['list', '--app', '--columns=name,version']),
    run('snap', ['list']),
  ]);
  return [...parseDpkg(deb), ...parseRpm(rpm), ...parseFlatpak(flatpak), ...parseSnap(snap)];
}

// --- processes ---------------------------------------------------------------

// Parse `ps -eo pid=,comm=` into [{ name, pid }]. comm is the executable name, already
// truncated to 15 characters by the kernel on Linux — fine for the loose alphanumeric
// match the caller does, and it is what pgrep matches against too.
function parsePs(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    out.push({ name: path.posix.basename(m[2]), pid: m[1] });
  }
  return out;
}

async function runningProcesses() {
  return parsePs(await run('ps', ['-eo', 'pid=,comm=']));
}

// --- launch targets ----------------------------------------------------------
//
// "Open App" needs a program to hand to the desktop, and the Linux inventories cannot
// supply one: dpkg, rpm, flatpak and snap all list PACKAGES, not programs, so every row
// arrives with no path — which is why Open App failed on Linux for anything not tracked
// as portable.
//
// Resolved on demand for the ONE app being opened rather than at scan time: `dpkg -L`
// costs a subprocess per package, and a scan lists hundreds.
//
// The .desktop entry is preferred over the binary, and not as a cosmetic choice. It is
// the only thing that carries how the app is meant to START — OBS's Exec is plain `obs`,
// but an app whose entry passes flags, sets a working directory or runs through a
// wrapper gets none of that from its bare executable. Handing the desktop file to
// xdg-open also means the user's own default association decides, which is what every
// other launcher on the system does.
const DESKTOP_DIR = /(^|\/)share\/applications\/[^/]+\.desktop$/;
const BIN_DIR = /(^|\/)s?bin\/[^/]+$/;

// files: absolute paths owned by the package. Pure; exported for tests.
function pickLaunchPath(files, name) {
  const list = (files || []).filter(Boolean);
  const desktops = list.filter((f) => DESKTOP_DIR.test(f));
  const bins = list.filter((f) => BIN_DIR.test(f));
  const base = (f) => f.slice(f.lastIndexOf('/') + 1).replace(/\.desktop$/, '');
  // A package can own several of each — OBS ships obs, obs-ffmpeg-mux and obs-nvenc-test,
  // and only the first is the app. Prefer the one whose name matches the package, then
  // the shortest, which is reliably the app rather than its helpers.
  const score = (f) => {
    const b = base(f).toLowerCase();
    const n = String(name || '').toLowerCase();
    // A reverse-DNS desktop id ("com.obsproject.Studio") never equals the package name,
    // so match on containment in either direction before falling back to length.
    if (b === n) return 0;
    if (b.includes(n) || n.includes(b)) return 1;
    return 2;
  };
  const best = (arr) => arr.slice().sort((a, b) => score(a) - score(b) || base(a).length - base(b).length)[0] || null;
  return best(desktops) || best(bins) || null;
}

// Returns { path, location } the way the Windows registry reader does, or null when the
// package owns nothing launchable (a library, a font, a -data package).
async function launchTargetFor(name, flavor) {
  let files = [];
  if (flavor === 'deb') {
    files = (await run('dpkg', ['-L', name])).split('\n');
  } else if (flavor === 'rpm') {
    files = (await run('rpm', ['-ql', name])).split('\n');
  } else if (flavor === 'flatpak' || flavor === 'snap') {
    // Both keep their own launcher on PATH and their own .desktop in a well-known place;
    // the exported desktop entry is the supported way in and handles the sandbox setup
    // that running the binary directly would skip.
    const dirs =
      flavor === 'flatpak'
        ? ['/var/lib/flatpak/exports/share/applications', `${process.env.HOME || ''}/.local/share/flatpak/exports/share/applications`]
        : ['/var/lib/snapd/desktop/applications'];
    const fs = require('fs');
    for (const d of dirs) {
      try {
        for (const f of fs.readdirSync(d)) files.push(`${d}/${f}`);
      } catch {}
    }
  }
  const hit = pickLaunchPath(files.map((f) => f.trim()), name);
  if (!hit) return null;
  return { path: hit, location: hit.slice(0, hit.lastIndexOf('/')) };
}

// --- launching ---------------------------------------------------------------
//
// A .desktop file cannot be opened the way a folder or a document is. xdg-open consults
// the user's association for application/x-desktop, and on a KDE session that is the
// TEXT EDITOR — clicking "Open App" showed the user the desktop entry's source instead
// of starting the program. The file is a launch DESCRIPTOR, not a document, and needs a
// launcher that knows it.
//
// Tried in order, most desktop-integrated first:
//   gio launch     GLib's own launcher. Present wherever GLib is, which on a desktop
//                  system is everywhere, KDE included. Honours DBus activation, the
//                  entry's working directory and its Terminal= setting.
//   gtk-launch     Same job, addressed by desktop ID rather than path. Kept because a
//                  minimal install can carry GTK's tools without gio.
//   Exec=          Last resort: run what the entry says to run. Loses DBus activation
//                  and Terminal= handling, so it is the fallback rather than the plan.
const EXEC_FIELD_CODES = /%[fFuUdDnNickvm]/g;

// Parse the Exec= line of a desktop entry into [cmd, ...args]. Pure; exported for tests.
// Field codes are the entry's placeholders for files and URLs to open with; launching the
// app plain means there is nothing to substitute, and the spec says to drop them.
function parseExec(line) {
  const raw = String(line || '').replace(EXEC_FIELD_CODES, ' ').trim();
  // Desktop entries quote any argument containing spaces, and escape quotes with a
  // backslash. Anything fancier than that is not something a launcher should be running.
  const parts = raw.match(/"(?:\\.|[^"\\])*"|\S+/g) || [];
  const clean = parts.map((t) => (t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t));
  return clean.length ? clean : null;
}

function readDesktopExec(file) {
  const fs = require('fs');
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Only the [Desktop Entry] group. An entry can carry extra action groups further down,
  // each with its own Exec=, and those are alternate actions ("New Window"), not the app.
  const body = txt.split(/^\[/m).find((sec) => sec.startsWith('Desktop Entry]'));
  const m = /^Exec=(.*)$/m.exec(body || txt);
  return m ? parseExec(m[1]) : null;
}

// target: the .desktop path or a plain executable, as resolved by launchTargetFor.
// Returns true when something was started.
async function launchApp(target) {
  const file = String(target || '');
  if (!/\.desktop$/i.test(file)) return spawnDetached(file, []);

  // gio and gtk-launch report failure by exit status, so a missing tool and a refusing
  // one both fall through to the next option rather than silently doing nothing.
  const gio = await runStatus('gio', ['launch', file], { timeout: 10_000 });
  if (gio.code === 0) return true;

  const id = file.slice(file.lastIndexOf('/') + 1).replace(/\.desktop$/i, '');
  const gtk = await runStatus('gtk-launch', [id], { timeout: 10_000 });
  if (gtk.code === 0) return true;

  const argv = readDesktopExec(file);
  return argv ? spawnDetached(argv[0], argv.slice(1)) : false;
}

function killProcess(pid, force) {
  try {
    process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

module.exports = {
  installedApps,
  runningProcesses,
  killProcess,
  launchTargetFor,
  launchApp,
  pickLaunchPath,
  parseExec,
  // exported for tests
  cleanDebVersion,
  parseDpkg,
  parseRpm,
  parseFlatpak,
  parseSnap,
  parsePs,
};
