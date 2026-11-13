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
  assert.match(html, /\$\('scheduleCheckEnabled'\)\.onchange = saveSchedule/);
  assert.match(html, /\$\('scheduleCatchUp'\)\.onchange = saveSchedule/);
  assert.match(html, /\$\('scheduleCheckCron'\)\.addEventListener\('change', saveSchedule\)/);
  assert.match(html, /window\.api\.onScheduleDone\(/, 'a finished background check updates the window');
  assert.match(html, /scheduleCatchUp !== false/, 'missed-run catch-up is on unless switched off');
  // A schedule that is switched on with nothing typed gets a sensible one.
  assert.match(html, /expr = '0 9 \* \* \*'/);
});

test('the Check schedule is off by default and says what it does and does not do', () => {
  assert.doesNotMatch(html, /id="scheduleCheckEnabled"[^>]*checked/);
  const group = html.slice(html.indexOf('id="sg-schedule"'), html.indexOf('id="sg-background"'));
  assert.match(group, /never downloads or installs anything/);
  assert.match(group, /47 2 \* \* 2#1/, 'the 1st Tuesday example is on the screen');
  assert.match(group, /at most once an hour/);
  assert.match(group, /only while git-updater is running/);
});
