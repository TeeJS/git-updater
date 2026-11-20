'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cron = require('../src/cron');

// Local-time dates, the same way the schedule reads them.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const runs = (expr, from, n) => cron.nextRuns(expr, from, n).map(fmt);

test('the first Tuesday of the month at 2:47 AM: 47 2 * * 2#1', () => {
  // Nov 12 2026 is a Thursday. The first Tuesdays that follow are Dec 1, Jan 5 and Feb 2.
  assert.deepEqual(runs('47 2 * * 2#1', at(2026, 11, 12, 10), 3), ['2026-12-01 02:47', '2027-01-05 02:47', '2027-02-02 02:47']);
  assert.deepEqual(runs('47 2 * * TUE#1', at(2026, 11, 12, 10), 1), ['2026-12-01 02:47'], 'weekday names work with #');
  // Right on the run time, the next one is a month later (strictly after).
  assert.equal(fmt(cron.next(cron.parse('47 2 * * 2#1'), at(2026, 12, 1, 2, 47))), '2027-01-05 02:47');
});

test('the classic cron rule is kept: with both day fields set, either matches', () => {
  // 47 2 1-7 * 2 means "days 1 to 7, OR any Tuesday", not "the first Tuesday".
  const got = runs('47 2 1-7 * 2', at(2026, 11, 8), 4);
  assert.deepEqual(got, ['2026-11-10 02:47', '2026-11-17 02:47', '2026-11-24 02:47', '2026-12-01 02:47']);
  // The 14th is a Saturday and not a Tuesday, so it is NOT in the list; the 17th (a Tuesday) is.
  assert.ok(!got.includes('2026-11-14 02:47'));
});

test('everyday forms: daily, every N hours, weekdays, month and day lists', () => {
  assert.deepEqual(runs('0 9 * * *', at(2026, 11, 12, 10), 2), ['2026-11-13 09:00', '2026-11-14 09:00']);
  assert.deepEqual(runs('0 */6 * * *', at(2026, 11, 12, 10, 30), 3), ['2026-11-12 12:00', '2026-11-12 18:00', '2026-11-13 00:00']);
  assert.deepEqual(runs('30 8 * * MON-FRI', at(2026, 11, 13, 9), 2), ['2026-11-16 08:30', '2026-11-17 08:30'], 'Friday after 8:30 -> Monday');
  assert.deepEqual(runs('15 3 1,15 * *', at(2026, 11, 2), 3), ['2026-11-15 03:15', '2026-12-01 03:15', '2026-12-15 03:15']);
  assert.deepEqual(runs('0 12 1 JAN,JUL *', at(2026, 11, 12), 2), ['2027-01-01 12:00', '2027-07-01 12:00']);
  assert.deepEqual(runs('5 4 * * 0', at(2026, 11, 12), 1), ['2026-11-15 04:05'], '0 is Sunday');
  assert.deepEqual(runs('5 4 * * 7', at(2026, 11, 12), 1), ['2026-11-15 04:05'], '7 is Sunday too');
});

test('L in the day-of-month field is the last day of the month', () => {
  assert.deepEqual(runs('0 23 L * *', at(2027, 1, 1), 3), ['2027-01-31 23:00', '2027-02-28 23:00', '2027-03-31 23:00']);
});

test('steps and ranges', () => {
  assert.deepEqual(runs('0 8-17/3 * * *', at(2026, 11, 12, 0, 1), 4), ['2026-11-12 08:00', '2026-11-12 11:00', '2026-11-12 14:00', '2026-11-12 17:00']);
  assert.deepEqual(runs('10-50/20 5 * * *', at(2026, 11, 12, 6), 3), ['2026-11-13 05:10', '2026-11-13 05:30', '2026-11-13 05:50']);
});

test('bad schedules are refused with a message that says what is wrong', () => {
  const bad = (expr) => cron.validate(expr, at(2026, 11, 12));
  assert.match(bad('').error, /enter a schedule/);
  assert.match(bad('0 9 * *').error, /5 fields.*has 4/);
  assert.match(bad('61 9 * * *').error, /minute must be 0 to 59/);
  assert.match(bad('0 24 * * *').error, /hour must be 0 to 23/);
  assert.match(bad('0 9 32 * *').error, /day-of-month must be 1 to 31/);
  assert.match(bad('0 9 * 13 *').error, /month must be 1 to 12/);
  assert.match(bad('0 9 * * 8').error, /day-of-week must be 0 to 7/);
  assert.match(bad('0 9 * * 2#6').error, /1 to 5/);
  assert.match(bad('0 9 * * FOO').error, /not a valid day-of-week/);
  assert.match(bad('5-1 9 * * *').error, /after/);
  assert.match(bad('0 9 */0 * *').error, /step/);
  assert.match(bad('0,,5 9 * * *').error, /empty/);
  assert.equal(bad('0 9 * * *').ok, true);
});

test('a schedule that fires more often than hourly is refused; hourly itself is fine', () => {
  const v = (e) => cron.validate(e, at(2026, 11, 12));
  assert.match(v('* * * * *').error, /more often than once an hour/);
  assert.match(v('*/30 * * * *').error, /more often than once an hour/);
  assert.match(v('0,30 * * * *').error, /more often than once an hour/);
  assert.equal(v('0 * * * *').ok, true);
  assert.equal(v('15 */2 * * *').ok, true);
  assert.equal(v('47 2 * * 2#1').ok, true);
});

test('a schedule that can never run is refused', () => {
  assert.match(cron.validate('0 0 31 2 *', at(2026, 11, 12)).error, /never runs/);
});

test('validate returns the next few run times for the preview', () => {
  const v = cron.validate('47 2 * * 2#1', at(2026, 11, 12, 10), 3);
  assert.equal(v.ok, true);
  assert.deepEqual(v.runs.map(fmt), ['2026-12-01 02:47', '2027-01-05 02:47', '2027-02-02 02:47']);
});

test('isDue: not before the time, once after it, and what catch-up means', () => {
  const p = cron.parse('0 9 * * *');
  const last = at(2026, 11, 12, 9, 0); // last ran at 9:00 today
  assert.equal(cron.isDue(p, last, at(2026, 11, 13, 8, 59)).due, false, 'tomorrow 9:00 has not come');
  assert.equal(cron.isDue(p, last, at(2026, 11, 13, 9, 0)).due, true, 'at 9:00 it is due');
  // The computer was off over several days: with catch-up it runs once when noticed.
  assert.equal(cron.isDue(p, last, at(2026, 11, 17, 14, 0), { catchUp: true }).due, true);
  // Without catch-up, a time that passed long ago is dropped, a time that just passed still runs.
  const stale = cron.isDue(p, last, at(2026, 11, 17, 14, 0), { catchUp: false });
  assert.equal(stale.due, false);
  assert.equal(stale.dropped, true);
  assert.equal(cron.isDue(p, last, at(2026, 11, 13, 9, 1), { catchUp: false }).due, true, 'one minute late is still on time');
});

test('a monthly schedule missed while off runs when noticed (the 1st Tuesday case)', () => {
  const p = cron.parse('47 2 * * 2#1');
  const last = at(2026, 12, 1, 2, 47); // ran on Dec 1
  assert.equal(cron.isDue(p, last, at(2027, 1, 4, 12), { catchUp: true }).due, false, 'Jan 5 has not come yet');
  assert.equal(cron.isDue(p, last, at(2027, 1, 7, 12), { catchUp: true }).due, true, 'off on Jan 5, noticed on Jan 7');
});
