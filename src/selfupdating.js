'use strict';

// Apps that keep themselves up to date are left alone (PROJECT-self-updating-apps.md).
//
// Why: on 2026-11-23 git-updater installed Discord 1.0.9270 from WinGet. Discord's own updater
// asked Discord's server, was told this PC must stay on 1.0.9269, and rolled itself back while
// the 1.0.9270 installer was still deleting the old folder. Discord came back without its core
// module and would not start. Two updaters working on one app clash.
//
// What is recognised: Squirrel, the one layout that has actually clashed. Its updater
// (Update.exe) owns the install and swaps app-<version> folders itself, so an installer run over
// it races that updater for the same folders. Squirrel apps: Discord, GitHub Desktop, Slack.
//
//   squirrel   Update.exe beside app-<version> folders
//   you        the user ticked "Updates itself" in the row's menu
//
// NOT recognised, on purpose (2026-11-24): an app merely HAVING an updater. Homebrew's
// `auto_updates`, electron-updater's app-update.yml and the Sparkle framework mark most popular
// apps (Chrome, Bitwarden, Zoom, OBS, Obsidian), which git-updater updates without trouble.
// Treating them as "updates itself" (beta.14, beta.15) turned half the rows on a Mac purple and
// stopped updates the user wanted. The row's tick covers any other app that does clash.
//
// The rule follows the installed COPY, not the platform: the marker is looked for everywhere and
// simply only exists where Squirrel does (Windows).
//
// The user's tick wins in both directions: `updatesItself: false` on the config entry means
// "update it anyway", `true` means "leave it alone" even when no marker was found.
//
// Only an app that is already on this machine is ever skipped: a first install goes ahead.

const fs = require('fs');
const path = require('path');

const KINDS = ['squirrel', 'you'];

// The marker is looked for in a FOLDER the app lives in. `fsx` is injectable for tests.
function exists(fsx, ...parts) {
  try {
    return fsx.existsSync(path.join(...parts));
  } catch {
    return false;
  }
}

function hasAppVersionDir(fsx, dir) {
  try {
    return fsx.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && /^app-\d/i.test(e.name));
  } catch {
    return false;
  }
}

// The marker in one folder -> a kind, or null.
function markerIn(dir, fsx = fs) {
  if (!dir || typeof dir !== 'string') return null;
  if (exists(fsx, dir, 'Update.exe') && hasAppVersionDir(fsx, dir)) return 'squirrel';
  return null;
}

// A folder and what sits directly inside it: an unpacked download often keeps the app one
// folder down (App-1.2.3/…).
function markerInTree(dir, fsx = fs) {
  const own = markerIn(dir, fsx);
  if (own) return own;
  let entries = [];
  try {
    entries = fsx.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = markerIn(path.join(dir, e.name), fsx);
    if (hit) return hit;
  }
  return null;
}

// Squirrel registers its own updater as the uninstaller: "C:\…\Discord\Update.exe" --uninstall.
// -> that folder, or null.
function squirrelRoot(uninstall) {
  const m = /^\s*"?([^"]*?)[\\/]Update\.exe"?\s+--uninstall\b/i.exec(String(uninstall || ''));
  return m && m[1] ? m[1] : null;
}

// The folders an inventory record points at: where it is installed, the folder of its program
// (and that folder's parent when the program sits in an app-<version> folder), and the folder
// of a Squirrel uninstaller.
function foldersOf(rec) {
  const out = [];
  const add = (d) => {
    if (d && typeof d === 'string' && !out.includes(d)) out.push(d);
  };
  if (!rec) return out;
  add(rec.location);
  if (rec.path) {
    if (/\.app[\\/]?$/i.test(rec.path)) add(rec.path);
    else {
      const dir = path.dirname(rec.path);
      add(dir);
      if (/^app-\d/i.test(path.basename(dir))) add(path.dirname(dir));
    }
  }
  add(squirrelRoot(rec.uninstall));
  return out;
}

// Does this app keep itself up to date? -> { by: <kind> } or null.
//   repo     the config entry (its `updatesItself` tick wins)
//   copies   inventory records of the installed app (any platform)
//   folder   the folder git-updater keeps the app in (portable apps)
async function check(repo, { copies = [], folder = null, fsx = fs } = {}) {
  if (repo && repo.updatesItself === false) return null;
  if (repo && repo.updatesItself === true) return { by: 'you' };
  if (folder) {
    const hit = markerInTree(folder, fsx);
    if (hit) return { by: hit };
  }
  for (const rec of copies || []) {
    for (const dir of foldersOf(rec)) {
      const hit = markerIn(dir, fsx);
      if (hit) return { by: hit };
    }
  }
  return null;
}

module.exports = { check, markerIn, markerInTree, squirrelRoot, foldersOf, KINDS };
