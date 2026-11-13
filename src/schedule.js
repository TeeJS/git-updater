'use strict';

// The schedule engine: when is a scheduled job due, and did it already run. It is a timer inside
// the one running app (no scheduled task, no helper process); the app calls tick() every half
// minute and when the computer wakes. Everything it needs is passed in, so tests run it with a fake
// clock and an in-memory state.
//
// There are two jobs, each with its own switch, cron line and last-run time:
//   check    looks for updates and tells you
//   install  updates the apps ticked for auto-update
// A job named "check" reads scheduleCheckEnabled / scheduleCheckCron from the config and keeps
// checkLastRun / checkCron in the state file; "install" is the same with install in place of check.
//
// What "due" means is in src/cron.js (isDue). The state remembers when each job last ran, in a small
// file next to config.json, so a restart does not forget and a missed time can be caught up.

const fs = require('fs');
const path = require('path');
const cron = require('./cron');

const TICK_MS = 30 * 1000;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// deps: { readConfig, loadState, saveState, jobs: [{ name, run }], canRun?, now?, log? }
function createScheduler(deps) {
  const { readConfig, loadState, saveState, jobs } = deps;
  const now = deps.now || (() => new Date());
  const log = deps.log || (() => {});
  const canRun = deps.canRun || (() => true);
  let running = false;

  async function tickJob(job) {
    const enabledKey = `schedule${cap(job.name)}Enabled`;
    const cronKey = `schedule${cap(job.name)}Cron`;
    const lastKey = `${job.name}LastRun`;
    const cronStateKey = `${job.name}Cron`;
    const cfg = readConfig() || {};
    const st = loadState() || {};
    const t = now();

    if (!cfg[enabledKey]) {
      // Switched off: forget the last run, so switching it on later starts counting from then
      // instead of "catching up" a time from long ago.
      if (st[lastKey]) { delete st[lastKey]; delete st[cronStateKey]; saveState(st); }
      return { ran: false, why: 'off' };
    }

    let parsed;
    try {
      parsed = cron.parse(cfg[cronKey]);
    } catch (e) {
      log(`scheduled ${job.name}: the schedule is not valid (${e.message})`);
      return { ran: false, why: 'invalid' };
    }

    // Just switched on, or the schedule was edited: start counting from now. A past time is never run.
    if (!st[lastKey] || st[cronStateKey] !== parsed.expr) {
      st[lastKey] = t.toISOString();
      st[cronStateKey] = parsed.expr;
      saveState(st);
      return { ran: false, why: 'baseline' };
    }

    const due = cron.isDue(parsed, new Date(st[lastKey]), t, { catchUp: cfg.scheduleCatchUp !== false });
    if (!due.due) {
      if (due.dropped) {
        log(`scheduled ${job.name}: the ${due.at.toISOString()} run was missed and catching up is off`);
        st[lastKey] = t.toISOString();
        saveState(st);
      }
      return { ran: false, why: due.dropped ? 'dropped' : 'not due' };
    }

    // Something else (an update the user started) is running: leave it for the next tick.
    if (!canRun(job.name)) return { ran: false, why: 'blocked' };

    // Marked before it runs: a crash or a slow job must never make the same time run twice.
    st[lastKey] = t.toISOString();
    saveState(st);
    const lateMs = t - due.at;
    const caughtUp = lateMs > 2 * 60 * 1000;
    log(`scheduled ${job.name}: running (due ${due.at.toISOString()}${caughtUp ? ', caught up' : ''})`);
    try {
      await job.run({ scheduledFor: due.at, caughtUp });
    } catch (e) {
      log(`scheduled ${job.name} failed: ${e && e.message ? e.message : e}`);
    }
    return { ran: true, at: due.at };
  }

  // Runs each job in turn, never two at once. Returns the check job's result when there is one job
  // (what the tests read), otherwise an object keyed by job name.
  async function tick() {
    if (running) return { ran: false, why: 'busy' };
    running = true;
    try {
      const results = {};
      for (const job of jobs) results[job.name] = await tickJob(job);
      return jobs.length === 1 ? results[jobs[0].name] : results;
    } finally {
      running = false;
    }
  }

  return { tick, TICK_MS };
}

// The state file, next to config.json.
function fileState(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
    },
    save(st) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

module.exports = { createScheduler, fileState, TICK_MS };
