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
  if (/^needs you/i.test(reason)) return 'needsYou';
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

module.exports = { keyOf, pickTargets, classify, summarize, summaryText };
