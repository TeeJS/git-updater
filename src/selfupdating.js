'use strict';

// Apps that keep themselves up to date are left alone (PROJECT-self-updating-apps.md).
//
// Why: on 2026-11-23 git-updater installed Discord 1.0.9270 from WinGet. Discord's own updater
// asked Discord's server, was told this PC must stay on 1.0.9269, and rolled itself back while
// the 1.0.9270 installer was still deleting the old folder. Discord came back without its core
// module and would not start. Two updaters working on one app clash; an app that has its own
// updater is that updater's job.
//
// ONE rule on every platform: if the installed copy carries its own updater, it is not updated
// here. The rule follows the installed COPY, not the platform, so an app that updates itself on
// one system but not on another is treated correctly on each. Every marker below is looked for
// everywhere; each simply only exists where its updater does.
//
//   squirrel          Update.exe beside app-<version> folders (Discord, GitHub Desktop, Slack)
//   electron-updater  app-update.yml in the app's resources (electron-builder apps, all platforms)
//   sparkle           the Sparkle framework inside an app bundle
//   listing           the listing says so (Homebrew's `auto_updates`)
//   you               the user ticked "Updates itself" in the row's menu
//
// The user's tick wins in both directions: `updatesItself: false` on the config entry means
// "update it anyway", `true` means "leave it alone" even when no marker was found.
//
// Only an app that is already on this machine is ever skipped: a first install goes ahead.

const fs = require('fs');
const path = require('path');

const KINDS = ['squirrel', 'electron-updater', 'sparkle', 'listing', 'you'];

// Every marker is looked for in a FOLDER the app lives in. `fsx` is injectable for tests.
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

// The marker in one folder or app bundle -> a kind, or null.
function markerIn(dir, fsx = fs) {
  if (!dir || typeof dir !== 'string') return null;
  if (/\.app[\\/]?$/i.test(dir)) {
    if (exists(fsx, dir, 'Contents', 'Resources', 'app-update.yml')) return 'electron-updater';
    if (exists(fsx, dir, 'Contents', 'Frameworks', 'Sparkle.framework')) return 'sparkle';
    return null;
  }
  if (exists(fsx, dir, 'Update.exe') && hasAppVersionDir(fsx, dir)) return 'squirrel';
  if (exists(fsx, dir, 'resources', 'app-update.yml')) return 'electron-updater';
  return null;
}

// A folder and what sits directly inside it: an unpacked download often keeps the app one
// folder down (App-1.2.3/…), and a folder of app bundles keeps each bundle there.
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

// A package's own file list (dpkg -L, rpm -ql): the marker is a file in it.
function markerInFiles(files) {
  for (const f of files || []) {
    const p = String(f || '').trim().replace(/\\/g, '/');
    if (/\/resources\/app-update\.yml$/i.test(p) || /\.app\/Contents\/Resources\/app-update\.yml$/i.test(p)) return 'electron-updater';
    if (/\.app\/Contents\/Frameworks\/Sparkle\.framework(\/|$)/i.test(p)) return 'sparkle';
  }
  return null;
}

// Does this app keep itself up to date? -> { by: <kind> } or null.
//   repo       the config entry (its `updatesItself` tick wins)
//   listing    true when the app's listing says it updates itself
//   copies     inventory records of the installed app (any platform)
//   folder     the folder git-updater keeps the app in (portable apps)
//   listFiles  async (record) -> the files a package owns, for records that name no folder
async function check(repo, { listing = false, copies = [], folder = null, listFiles = null, fsx = fs } = {}) {
  if (repo && repo.updatesItself === false) return null;
  if (repo && repo.updatesItself === true) return { by: 'you' };
  if (listing) return { by: 'listing' };
  if (folder) {
    const hit = markerInTree(folder, fsx);
    if (hit) return { by: hit };
  }
  for (const rec of copies || []) {
    for (const dir of foldersOf(rec)) {
      const hit = markerIn(dir, fsx);
      if (hit) return { by: hit };
    }
    if (!foldersOf(rec).length && listFiles) {
      let files = [];
      try {
        files = await listFiles(rec);
      } catch {}
      const hit = markerInFiles(files);
      if (hit) return { by: hit };
    }
  }
  return null;
}

module.exports = { check, markerIn, markerInTree, markerInFiles, squirrelRoot, foldersOf, KINDS };
