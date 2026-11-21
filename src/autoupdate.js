'use strict';

// The scheduled install (Settings -> Schedule -> Install): which apps it touches, in what order,
// and how its outcome is reported. Pure functions; electron/main.js does the running.
//
// The rules, all of them narrowing what happens unattended:
//   - only apps ticked in the Auto-update column;
//   - only apps that are already installed (a schedule never installs a new app);
//   - portable apps first, installers last (so the simple swaps are done before the heavier ones);
//   - nothing is force-closed, no installer window or permission prompt is ever opened: an app
//     that is running follows the "Automatically close apps and re-open" setting, and an installer
//     that needs administrator permission is reported as "needs you" and left for the window.

const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;

// repos: the config's app list. installed: { [key]: { present } } (what the window shows as installed).
function pickTargets(repos, installed) {
  const ticked = (repos || []).filter((r) => r && r.autoUpdate === true);
  const targets = [];
  const skipped = [];
  for (const r of ticked) {
    const rec = installed && installed[keyOf(r)];
    if (rec && rec.present) targets.push(r);
    else skipped.push({ key: keyOf(r), name: `${r.owner}/${r.repo}`, why: 'not installed' });
  }
  const rank = (r) => (r.type === 'portable' ? 0 : 1);
  targets.sort((a, b) => rank(a) - rank(b)); // stable: ties keep the list's order
  return { targets, skipped };
}

// One run result -> one of: updated, current, running, needsYou, failed.
function classify(result) {
  if (!result) return 'failed';
  if (result.status === 'updated') return 'updated';
  if (result.status === 'current') return 'current';
  const reason = String(result.reason || '');
  // A file has to be chosen by hand (see sources.selectAsset): nothing went wrong, and an
  // unattended run cannot answer it — so "needs you", not "could not be updated".
  if (result.chooseFile || /^needs you/i.test(reason)) return 'needsYou';
  if (/is running|did not close gracefully/i.test(reason)) return 'running';
  return 'failed';
}

// entries: [{ name, result }]. Returns the lists a notification and the log are made from.
function summarize(entries) {
  const out = { updated: [], current: 0, running: [], needsYou: [], failed: [] };
  for (const { name, result } of entries || []) {
    const kind = classify(result);
    const reason = result && result.reason ? String(result.reason).replace(/^needs you:\s*/i, '') : '';
    if (kind === 'updated') out.updated.push(name);
    else if (kind === 'current') out.current++;
    else if (kind === 'running') out.running.push(name);
    else if (kind === 'needsYou') out.needsYou.push({ name, reason });
    else out.failed.push({ name, reason });
  }
  return out;
}

const list = (names, max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);
const plural = (n, one, many) => (n === 1 ? one : many);

// The notification text, or null when there is nothing worth interrupting for (everything current).
function summaryText(s) {
  const parts = [];
  if (s.updated.length) parts.push(`Updated ${s.updated.length} ${plural(s.updated.length, 'app', 'apps')}: ${list(s.updated)}.`);
  const needs = s.needsYou.length + s.running.length;
  if (needs) parts.push(`${needs} ${plural(needs, 'needs', 'need')} you: ${list([...s.needsYou.map((x) => x.name), ...s.running])}.`);
  if (s.failed.length) parts.push(`${s.failed.length} could not be updated: ${list(s.failed.map((x) => x.name))}.`);
  return parts.length ? `${parts.join(' ')} Click to open git-updater.` : null;
}

// --- at sign-in (Settings -> Background -> "When it starts at sign-in") -----------------
// What a start at sign-in does, beyond opening:
//   'open'    nothing more (the default, and what every install did before this existed)
//   'check'   the same check as the schedule's: every app, and a notification if any has an update
//   'ask'     checks the apps the scheduled install would touch, and asks once before updating them
//   'update'  updates those apps without asking
// 'ask' and 'update' follow every rule at the top of this file. Nothing here runs unless
// "Start git-updater when I sign in" is on and this start really was the sign-in one.
const LOGIN_ACTIONS = ['open', 'check', 'ask', 'update'];
function loginAction(cfg) {
  if (!cfg || !cfg.startAtLogin) return 'open';
  return LOGIN_ACTIONS.includes(cfg.loginAction) && cfg.loginAction !== 'open' ? cfg.loginAction : 'open';
}

// Does anything in a finished install run still wait for the user?
function needsUser(s) {
  return !!s && (s.needsYou.length > 0 || s.running.length > 0 || s.failed.length > 0);
}

// "then quit when finished": only after a sign-in run that left nothing for the user, never
// with "Keep running in the tray" on (staying is that setting's whole point), and never
// once the user has brought the window up, because then they are using it.
//   clean: the run finished and nothing needs the user.  windowInUse: on screen, not minimized.
function quitAfterLogin(cfg, clean, windowInUse) {
  return loginAction(cfg) !== 'open' && !!cfg.loginQuit && !cfg.keepRunning && !!clean && !windowInUse;
}

// The one question 'ask' puts to the user. names: the apps with an update.
function askText(names) {
  return `${names.length} ${plural(names.length, 'update is', 'updates are')} ready: ${list(names)}.`;
}

module.exports = { keyOf, pickTargets, classify, summarize, summaryText, LOGIN_ACTIONS, loginAction, needsUser, quitAfterLogin, askText };
