'use strict';

// The window side of the scheduled check: showing what a background check found, and the guards
// that the Settings controls are wired to the main process's preview and save.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const begin = html.indexOf('// --- background results');
const end = html.indexOf('// --- end of the background results block ---');
assert.ok(begin > 0 && end > begin, 'background results block found');
const ctx = {};
vm.runInNewContext(html.slice(begin, end), ctx);

test('background results fill in rows that have no status yet, and only those', () => {
  const st = {
    a: { ph: 'idle', present: true, from: '1.0' },
    b: { ph: 'idle', present: true, from: '2.0' },
    c: { ph: 'current', present: true, from: '3.0' }, // already checked in this window: left alone
    d: { ph: 'idle', present: false },
    e: { ph: 'idle', present: true },
  };
  const n = ctx.mergeBackgroundResults(st, [
    { id: 'a', status: 'updated', from: '1.0', to: '1.1' }, // an update found
    { id: 'b', status: 'current', from: '2.0', to: '2.0' },
    { id: 'c', status: 'updated', from: '3.0', to: '3.5' },
    { id: 'd', status: 'updated', to: '9.0' }, // not installed: "Available to install"
    { id: 'e', status: 'failed', reason: 'boom' }, // failures are not shown as a status
    { id: 'zzz', status: 'updated' }, // an app that is no longer tracked
  ]);
  assert.equal(n, 3);
  assert.deepEqual({ ...st.a }, { ph: 'available', present: true, from: '1.0', to: '1.1' });
  assert.equal(st.b.ph, 'current');
  assert.equal(st.c.ph, 'current', 'a row checked in this window is not overwritten by an older result');
  assert.equal(st.c.to, undefined);
  assert.equal(st.d.ph, 'available');
  assert.equal(st.e.ph, 'idle');
  assert.equal(st.zzz, undefined);
  assert.equal(ctx.mergeBackgroundResults(st, null), 0);
});

test('the Settings schedule controls are wired to the main process', () => {
  assert.match(html, /window\.api\.schedulePreview\(expr\)/, 'the preview comes from the same parser that runs the schedule');
  assert.match(html, /\$\(`schedule\${kind}Enabled`\)\.onchange = saveSchedule/, 'both switches save');
  assert.match(html, /box\.addEventListener\('change', saveSchedule\)/, 'both cron boxes save on leaving');
  assert.match(html, /\$\('scheduleCatchUp'\)\.onchange = saveSchedule/);
  assert.match(html, /window\.api\.onScheduleDone\(/, 'a finished background check updates the window');
  assert.match(html, /scheduleCatchUp === true/, 'missed-run catch-up is off unless switched on');
  assert.doesNotMatch(html, /scheduleCatchUp !== false/, 'and never defaults to on');
  // A schedule that is switched on with nothing typed gets a sensible one (not one of the examples in the help text).
  assert.match(html, /SCHEDULE_DEFAULTS = \{ Check: '0 12 \* \* \*', Install: '0 13 \* \* MON' \}/);
  assert.match(html, /expr = SCHEDULE_DEFAULTS\[kind\]/);
  assert.match(html, /id="scheduleCheckCron" placeholder="0 12 \* \* \*"/, 'the grey placeholder shows the default');
  assert.match(html, /id="scheduleInstallCron" placeholder="0 13 \* \* MON"/);
});

test('the Install schedule is off by default and spells out its limits', () => {
  assert.doesNotMatch(html, /id="scheduleInstallEnabled"[^>]*checked/);
  const group = html.slice(html.indexOf('id="sg-schedule"'), html.indexOf('id="sg-background"'));
  assert.match(group, /only ticked, already-installed apps, unattended/);
  assert.match(group, /installers that need permission are skipped and reported/);
  assert.match(group, /nothing is force-closed/);
  assert.match(group, /Automatically close apps and re-open when complete/, 'a running app follows the existing setting');
  assert.match(group, /id="scheduleInstallApps"/, 'it says how many apps are ticked, so an empty list is never a surprise');
});

test('a finished scheduled install re-reads the list; a finished check only fills in blank rows', () => {
  assert.match(html, /d\.kind === 'install'\) \{ if \(!busy\) load\(\); \} else applyBackgroundResults\(\)/);
});

test('the Check schedule is off by default and says what it does and does not do', () => {
  assert.doesNotMatch(html, /id="scheduleCheckEnabled"[^>]*checked/);
  assert.doesNotMatch(html, /id="scheduleCatchUp"[^>]*checked/, 'missed runs are off by default');
  const group = html.slice(html.indexOf('id="sg-schedule"'), html.indexOf('id="sg-background"'));
  assert.match(group, /Only checks and notifies/);
  assert.match(group, /minute hour day-of-month month weekday/, 'the format is spelled out');
  assert.match(group, /Runs only while git-updater is running/);
});

test('every Settings explanation is one or two short sentences', () => {
  const screen = html.slice(html.indexOf('id="settingsScreen"'), html.indexOf('id="settingsScreen"') + 12000);
  const hints = [...screen.matchAll(/<p class="hint"[^>]*>(.*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  assert.ok(hints.length >= 10, 'the hints were found');
  for (const h of hints) assert.ok(h.length <= 220, `too long (${h.length} chars): ${h}`);
});
