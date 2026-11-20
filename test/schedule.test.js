'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduler, fileState } = require('../src/schedule');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

function setup(cfg) {
  const env = { cfg: { scheduleCheckEnabled: true, scheduleCheckCron: '0 9 * * *', ...cfg }, state: {}, clock: at(2026, 11, 12, 10), runs: [], logs: [], fail: false };
  const s = createScheduler({
    readConfig: () => env.cfg,
    loadState: () => JSON.parse(JSON.stringify(env.state)),
    saveState: (st) => { env.state = JSON.parse(JSON.stringify(st)); },
    now: () => env.clock,
    log: (m) => env.logs.push(m),
    jobs: [{ name: 'check', run: async (info) => { env.runs.push(info); if (env.fail) throw new Error('boom'); } }],
  });
  return { env, s };
}

test('switching a schedule on starts counting from now: no run for a time that is already past', async () => {
  const { env, s } = setup();
  assert.equal((await s.tick()).why, 'baseline');
  assert.equal(env.runs.length, 0);
  env.clock = at(2026, 11, 12, 11); // later the same day: 9:00 today was before it was switched on
  assert.equal((await s.tick()).ran, false);
  env.clock = at(2026, 11, 13, 9, 0);
  assert.equal((await s.tick()).ran, true, 'tomorrow at 9:00 it runs');
  assert.equal(env.runs.length, 1);
});

test('it runs once per scheduled time, not on every tick', async () => {
  const { env, s } = setup();
  await s.tick();
  env.clock = at(2026, 11, 13, 9, 0);
  await s.tick();
  env.clock = at(2026, 11, 13, 9, 1);
  await s.tick();
  env.clock = at(2026, 11, 13, 9, 30);
  await s.tick();
  assert.equal(env.runs.length, 1);
  env.clock = at(2026, 11, 14, 9, 0);
  await s.tick();
  assert.equal(env.runs.length, 2);
});

test('with catch-up switched on, a missed run is caught up once when noticed (the app was off), and says so', async () => {
  const { env, s } = setup({ scheduleCatchUp: true });
  await s.tick(); // baseline Nov 12 10:00
  env.clock = at(2026, 11, 16, 14, 0); // off for days
  const r = await s.tick();
  assert.equal(r.ran, true);
  assert.equal(env.runs.length, 1, 'once, not once per missed day');
  assert.equal(env.runs[0].caughtUp, true);
  env.clock = at(2026, 11, 16, 14, 1);
  await s.tick();
  assert.equal(env.runs.length, 1);
});

test('catch-up is off unless switched on: a run missed long ago is dropped, not run', async () => {
  const { env, s } = setup(); // no scheduleCatchUp in the config
  await s.tick();
  env.clock = at(2026, 11, 16, 14, 0);
  const r = await s.tick();
  assert.equal(r.ran, false);
  assert.equal(r.why, 'dropped');
  assert.equal(env.runs.length, 0);
  env.clock = at(2026, 11, 17, 9, 0);
  assert.equal((await s.tick()).ran, true, 'the next one still runs on time');
});

test('turning it off forgets the last run, so turning it on later does not catch up an old time', async () => {
  const { env, s } = setup();
  await s.tick();
  env.cfg.scheduleCheckEnabled = false;
  assert.equal((await s.tick()).why, 'off');
  assert.equal(env.state.checkLastRun, undefined);
  env.clock = at(2026, 12, 20, 12);
  env.cfg.scheduleCheckEnabled = true;
  assert.equal((await s.tick()).why, 'baseline');
  assert.equal(env.runs.length, 0);
});

test('editing the schedule starts counting again instead of firing a slot from the old one', async () => {
  const { env, s } = setup();
  await s.tick();
  env.clock = at(2026, 11, 20, 12);
  env.cfg.scheduleCheckCron = '47 2 * * 2#1'; // daily -> first Tuesday
  assert.equal((await s.tick()).why, 'baseline');
  assert.equal(env.runs.length, 0);
});

test('an invalid schedule never runs and does not crash the timer', async () => {
  const { env, s } = setup({ scheduleCheckCron: 'not a schedule' });
  assert.equal((await s.tick()).why, 'invalid');
  assert.match(env.logs.join('\n'), /not valid/);
});

test('a failing check is logged, and the time is not retried on the next tick', async () => {
  const { env, s } = setup();
  await s.tick();
  env.fail = true;
  env.clock = at(2026, 11, 13, 9, 0);
  await s.tick();
  assert.match(env.logs.join('\n'), /scheduled check failed: boom/);
  env.clock = at(2026, 11, 13, 9, 1);
  await s.tick();
  assert.equal(env.runs.length, 1, 'not run again');
});

test('a tick while a check is still running does not start a second one', async () => {
  const { env, s } = setup();
  await s.tick();
  let release;
  env.runs.length = 0;
  const gate = new Promise((r) => { release = r; });
  const s2 = createScheduler({
    readConfig: () => env.cfg, loadState: () => JSON.parse(JSON.stringify(env.state)), saveState: (st) => { env.state = JSON.parse(JSON.stringify(st)); },
    now: () => env.clock, jobs: [{ name: 'check', run: async () => { env.runs.push(1); await gate; } }],
  });
  env.clock = at(2026, 11, 13, 9, 0);
  const first = s2.tick();
  const second = await s2.tick();
  assert.equal(second.why, 'busy');
  release();
  await first;
  assert.equal(env.runs.length, 1);
});

test('the state file survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-sched-'));
  try {
    const f = fileState(path.join(dir, 'sub', 'schedule-state.json'));
    assert.deepEqual(f.load(), {}, 'no file yet');
    f.save({ checkLastRun: '2026-11-12T10:00:00.000Z', checkCron: '0 9 * * *' });
    assert.deepEqual(fileState(path.join(dir, 'sub', 'schedule-state.json')).load(), { checkLastRun: '2026-11-12T10:00:00.000Z', checkCron: '0 9 * * *' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- two jobs: check and install ------------------------------------------------

function setupTwo(cfg) {
  const env = {
    cfg: { scheduleCheckEnabled: true, scheduleCheckCron: '0 9 * * *', scheduleInstallEnabled: true, scheduleInstallCron: '47 2 * * 2#1', ...cfg },
    state: {}, clock: at(2026, 11, 12, 10), order: [], busy: false, logs: [],
  };
  const s = createScheduler({
    readConfig: () => env.cfg,
    loadState: () => JSON.parse(JSON.stringify(env.state)),
    saveState: (st) => { env.state = JSON.parse(JSON.stringify(st)); },
    now: () => env.clock,
    log: (m) => env.logs.push(m),
    canRun: (name) => !(env.busy && name === 'install'),
    jobs: [
      { name: 'check', run: async () => { env.order.push('check'); } },
      { name: 'install', run: async () => { env.order.push('install'); } },
    ],
  });
  return { env, s };
}

test('two jobs keep their own last-run times and run independently', async () => {
  const { env, s } = setupTwo({ scheduleCatchUp: true });
  const r0 = await s.tick();
  assert.equal(r0.check.why, 'baseline');
  assert.equal(r0.install.why, 'baseline');
  assert.ok(env.state.checkLastRun && env.state.installLastRun, 'separate keys');
  assert.equal(env.state.installCron, '47 2 * * 2#1');
  env.clock = at(2026, 11, 13, 9, 0); // the daily check is due; the monthly install is not
  const r1 = await s.tick();
  assert.equal(r1.check.ran, true);
  assert.equal(r1.install.ran, false);
  assert.deepEqual(env.order, ['check']);
  env.clock = at(2026, 12, 1, 2, 47); // the first Tuesday of December
  const r2 = await s.tick();
  assert.equal(r2.install.ran, true, 'the 1st Tuesday at 2:47 AM');
  // (the daily check had also been missed since Nov 13 and is caught up first; the install comes last)
  assert.deepEqual(env.order, ['check', 'check', 'install']);
});

test('when both are due in the same tick the check runs first, then the install, never at the same time', async () => {
  const { env, s } = setupTwo({ scheduleCheckCron: '47 2 * * 2#1' });
  await s.tick();
  env.clock = at(2026, 12, 1, 2, 47);
  await s.tick();
  assert.deepEqual(env.order, ['check', 'install']);
});

test('an install that is blocked (an update is in progress) is not marked as run and goes on the next tick', async () => {
  const { env, s } = setupTwo();
  await s.tick();
  env.clock = at(2026, 12, 1, 2, 47);
  env.busy = true;
  const r = await s.tick();
  assert.equal(r.install.why, 'blocked');
  assert.deepEqual(env.order.filter((x) => x === 'install'), []);
  env.busy = false;
  env.clock = at(2026, 12, 1, 2, 48);
  const r2 = await s.tick();
  assert.equal(r2.install.ran, true, 'retried once the other update finished');
});

test('switching the install schedule off does not touch the check schedule', async () => {
  const { env, s } = setupTwo();
  await s.tick();
  env.cfg.scheduleInstallEnabled = false;
  const r = await s.tick();
  assert.equal(r.install.why, 'off');
  assert.equal(env.state.installLastRun, undefined);
  assert.ok(env.state.checkLastRun, 'the check keeps its place');
});
