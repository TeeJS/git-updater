'use strict';

// Which programs have an app's files open, so an installer that failed can say what to close.
//
// OBS's installer failed with exit 6 while OBS itself was closed. Chrome and the Claude app had
// OBS's virtual-camera file loaded (any Chromium app that lists the cameras loads it), so the
// row's "if the app is open, close it" pointed at the wrong thing. Now the row names them.
//
// Windows only, because it is the one system here that refuses to replace a file another
// program has open. On macOS and Linux a file in use is replaced without complaint, so there
// is nothing to ask and nobody to name. The answer comes from Windows' Restart Manager (the
// list an installer's own "close these apps" page shows), through the signed helper's
// read-only --who-uses. No shell, nothing elevated.

const path = require('path');

// The app's install folder, from its record in the OS inventory: the folder it names, else the
// folder its uninstaller sits in (OBS names none: "C:\Program Files\obs-studio\uninstall.exe"),
// else the folder of its program.
function folderOf(rec) {
  if (!rec) return null;
  const unquote = (s) => String(s || '').trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  if (rec.location) return unquote(rec.location) || null;
  if (rec.uninstallDir) return unquote(rec.uninstallDir) || null;
  if (rec.path && /\.exe$/i.test(rec.path)) return path.win32.dirname(unquote(rec.path));
  return null;
}

// What the helper printed: "<pid>\t<name>" lines. Distinct names, in the order given. A line
// with no name is skipped: there is nothing to tell the user to close.
function parseUsers(stdout) {
  const names = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\t(.+)$/);
    const name = m && m[2].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// "Google Chrome", "Google Chrome and Claude", "Google Chrome, Claude and Zoom".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The app as its installed record names it, without a trailing version or bracketed note.
function appLabel(rec, fallback) {
  const name = String((rec && rec.name) || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+v?\d+(\.\d+)+\S*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name || fallback;
}

// The row's reason. null when nobody has the files open: the installer's own exit then stands.
function reason(app, names, code) {
  if (!names || !names.length) return null;
  const many = names.length > 1;
  return `${joinNames(names)} ${many ? 'are' : 'is'} using ${app}'s files — close ${many ? 'them' : 'it'}, then Retry (installer exit ${code})`;
}

// Ask the helper. [] wherever it cannot be asked or does not answer.
async function namesUsing(folder, { helperPath, runHelper, platform = process.platform } = {}) {
  if (platform !== 'win32' || !helperPath || !folder || !runHelper) return [];
  const r = await runHelper(helperPath, ['--who-uses', '--folder', folder]);
  return r && r.code === 0 ? parseUsers(r.stdout) : [];
}

module.exports = { folderOf, parseUsers, joinNames, appLabel, reason, namesUsing };
