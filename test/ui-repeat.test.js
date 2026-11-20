'use strict';

// The "Repeat every" dropdowns above each cron line: the pure builder (unit + number -> cron line), its
// reverse, and that every line it can write is one the real cron parser accepts and means what it says.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cron = require('../src/cron');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const begin = html.indexOf('// --- cron builder');
const end = html.indexOf('// --- end of the cron builder block ---');
assert.ok(begin > 0 && end > begin, 'cron builder block found');
const ctx = {};
vm.runInNewContext(html.slice(begin, end), ctx);
const { REPEAT_VALUES, REPEAT_UNITS, REPEAT_TIME } = ctx;
const NONE = { hours: 0, days: 0, weeks: 0, months: 0 };
const only = (unit, n) => ({ ...NONE, [unit]: n });
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const runs = (expr, from, n) => cron.nextRuns(expr, from, n).map(fmt);

test('there is no minutes dropdown: schedules are never faster than hourly', () => {
  assert.deepEqual([...REPEAT_UNITS], ['hours', 'days', 'weeks', 'months']);
  assert.doesNotMatch(html.slice(html.indexOf('id="sg-schedule"'), html.indexOf('id="sg-background"')), />Mins</);
});

test('each unit writes the cron line it says, at the time already in the line', () => {
  const c = REPEAT_TIME.Check;
  assert.equal(ctx.buildCron('hours', 6, '', c), '0 */6 * * *');
  assert.equal(ctx.buildCron('hours', 1, '', c), '0 * * * *');
  assert.equal(ctx.buildCron('days', 1, '', c), '0 12 * * *');
  assert.equal(ctx.buildCron('days', 3, '', c), '0 12 */3 * *');
  assert.equal(ctx.buildCron('weeks', 1, '', REPEAT_TIME.Install), '0 13 * * MON');
  assert.equal(ctx.buildCron('weeks', 2, '', c), '0 12 * * MON#1,MON#3');
  assert.equal(ctx.buildCron('months', 1, '', c), '0 12 1 * *');
  assert.equal(ctx.buildCron('months', 3, '', c), '0 12 1 */3 *');
  // The minute, hour, weekday and day of the month already typed are kept, not reset.
  assert.equal(ctx.buildCron('days', 1, '30 9 * * FRI', c), '30 9 * * *');
  assert.equal(ctx.buildCron('weeks', 1, '30 9 * * 5', c), '30 9 * * FRI');
  assert.equal(ctx.buildCron('weeks', 2, '30 9 * * FRI', c), '30 9 * * FRI#1,FRI#3');
  assert.equal(ctx.buildCron('months', 3, '15 8 5 * *', c), '15 8 5 */3 *');
  assert.equal(ctx.buildCron('hours', 4, '47 2 * * 2#1', c), '47 */4 * * *', 'the minute survives; a line it cannot read falls back to the defaults');
  assert.equal(ctx.buildCron('days', 1, '47 */4 * * *', c), '47 12 * * *', 'an hour written as */4 is not a time of day');
});

test('nothing is written for 0 or for a number that is not offered', () => {
  assert.equal(ctx.buildCron('days', 0, '0 12 * * *', REPEAT_TIME.Check), null);
  assert.equal(ctx.buildCron('hours', 5, '', REPEAT_TIME.Check), null, '5 hours would not divide the day evenly');
  assert.equal(ctx.buildCron('minutes', 5, '', REPEAT_TIME.Check), null);
});

test('every line the dropdowns can write is accepted by the real cron parser', () => {
  for (const unit of REPEAT_UNITS) {
    for (const n of REPEAT_VALUES[unit].filter(Boolean)) {
      for (const kind of ['Check', 'Install']) {
        const expr = ctx.buildCron(unit, n, '', REPEAT_TIME[kind]);
        const v = cron.validate(expr, at(2026, 11, 12, 10));
        assert.equal(v.ok, true, `${unit} ${n} -> ${expr}: ${v.error}`);
      }
    }
  }
});

test('and each one runs when it says it does', () => {
  const from = at(2026, 11, 12, 10);
  assert.deepEqual(runs(ctx.buildCron('hours', 6, '', REPEAT_TIME.Check), from, 3), ['2026-11-12 12:00', '2026-11-12 18:00', '2026-11-13 00:00']);
  assert.deepEqual(runs(ctx.buildCron('days', 1, '', REPEAT_TIME.Check), from, 2), ['2026-11-12 12:00', '2026-11-13 12:00']);
  assert.deepEqual(runs(ctx.buildCron('weeks', 1, '', REPEAT_TIME.Install), from, 2), ['2026-11-16 13:00', '2026-11-23 13:00']);
  assert.deepEqual(runs(ctx.buildCron('weeks', 2, '', REPEAT_TIME.Install), from, 3), ['2026-11-16 13:00', '2026-12-07 13:00', '2026-12-21 13:00'], 'the 1st and 3rd Monday of each month');
  assert.deepEqual(runs(ctx.buildCron('months', 1, '', REPEAT_TIME.Check), from, 2), ['2026-12-01 12:00', '2027-01-01 12:00']);
  assert.deepEqual(runs(ctx.buildCron('months', 3, '', REPEAT_TIME.Check), from, 3), ['2027-01-01 12:00', '2027-04-01 12:00', '2027-07-01 12:00']);
});

test('describeCron is the reverse: every offered choice round-trips, anything else shows zeros', () => {
  for (const unit of REPEAT_UNITS) {
    for (const n of REPEAT_VALUES[unit].filter(Boolean)) {
      const expr = ctx.buildCron(unit, n, '30 9 8 * FRI', REPEAT_TIME.Check);
      assert.deepEqual({ ...ctx.describeCron(expr) }, only(unit, n), `${unit} ${n}: ${expr}`);
    }
  }
  for (const odd of ['', '0 8 * * MON-FRI', '47 2 * * 2#1', '*/5 * * * *', '0 12 * * MON#1', '0 0 L * *', 'not a schedule', '0 */5 * * *', '0 12 */9 * *']) {
    assert.deepEqual({ ...ctx.describeCron(odd) }, NONE, `"${odd}" is not one of the dropdown shapes`);
  }
  assert.deepEqual({ ...ctx.describeCron('0 12 * * *') }, only('days', 1), 'the default Check line reads as every 1 day');
  assert.deepEqual({ ...ctx.describeCron('0 13 * * MON') }, only('weeks', 1), 'the default Install line reads as every 1 week');
});

test('the two choices cron cannot repeat evenly say so', () => {
  const c = REPEAT_TIME.Check;
  assert.match(ctx.repeatNote('days', 3, '', c), /starts over on the 1st/);
  assert.equal(ctx.repeatNote('days', 1, '', c), '');
  assert.equal(ctx.repeatNote('weeks', 2, '0 9 * * FRI#1,FRI#3', c), 'Twice a month: the 1st and 3rd Friday.');
  assert.equal(ctx.repeatNote('weeks', 1, '', c), '');
  assert.equal(ctx.repeatNote('hours', 6, '', c), '');
});

test('the dropdowns sit above each cron line and are wired to it', () => {
  for (const kind of ['Check', 'Install']) {
    const group = html.indexOf(`aria-label="${kind}: repeat every"`);
    const line = html.indexOf(`id="schedule${kind}Cron"`);
    assert.ok(group > 0 && line > group, `${kind}: Repeat every comes before the cron line`);
    for (const unit of ['Hours', 'Days', 'Weeks', 'Months']) {
      assert.equal(html.split(`id="repeat${kind}${unit}"`).length - 1, 1, `repeat${kind}${unit} exists once`);
    }
    assert.match(html, new RegExp(`id="repeat${kind}Note"`));
  }
  assert.match(html, /s\.onchange = \(\) => repeatChanged\(kind, unit\)/, 'using a dropdown writes the line');
  assert.match(html, /box\.addEventListener\('input', \(\) => \{ syncRepeat\(kind\)/, 'typing a line moves the dropdowns');
  assert.match(html, /SCHEDULE_KINDS\.forEach\(syncRepeat\)/, 'opening Settings shows the saved line in the dropdowns');
  assert.match(html, /<span class="repeat-title">Repeat every:<\/span>/);
});
