'use strict';

// The schedule engine: when is a scheduled check due, and did it already run. It is a timer inside
// the one running app (no scheduled task, no helper process); the app calls tick() every half
// minute and when the computer wakes. Everything it needs is passed in, so tests run it with a fake
// clock and an in-memory state.
//
// What "due" means is in src/cron.js (isDue). The state remembers when each schedule last ran, in
// a small file next to config.json, so a restart does not forget and a missed time can be caught up.

const fs = require('fs');
const path = require('path');
const cron = require('./cron');

const TICK_MS = 30 * 1000;

// deps: { readConfig, loadState, saveState, runCheck, now?, log? }
function createScheduler(deps) {
  const { readConfig, loadState, saveState, runCheck } = deps;
  const now = deps.now || (() => new Date());
  const log = deps.log || (() => {});
  let running = false;

  async function tick() {
    if (running) return { ran: false, why: 'busy' };
    const cfg = readConfig() || {};
    const st = loadState() || {};
    const t = now();

    if (!cfg.scheduleCheckEnabled) {
      // Switched off: forget the last run, so switching it on later starts counting from then
      // instead of "catching up" a time from long ago.
      if (st.checkLastRun) { delete st.checkLastRun; delete st.checkCron; saveState(st); }
      return { ran: false, why: 'off' };
    }

    let parsed;
    try {
      parsed = cron.parse(cfg.scheduleCheckCron);
    } catch (e) {
      log(`scheduled check: the schedule is not valid (${e.message})`);
      return { ran: false, why: 'invalid' };
    }

    // Just switched on, or the schedule was edited: start counting from now. A past time is never run.
    if (!st.checkLastRun || st.checkCron !== parsed.expr) {
      st.checkLastRun = t.toISOString();
      st.checkCron = parsed.expr;
      saveState(st);
      return { ran: false, why: 'baseline' };
    }

    const due = cron.isDue(parsed, new Date(st.checkLastRun), t, { catchUp: cfg.scheduleCatchUp !== false });
    if (!due.due) {
      if (due.dropped) {
        log(`scheduled check: the ${due.at.toISOString()} run was missed and catching up is off`);
        st.checkLastRun = t.toISOString();
        saveState(st);
      }
      return { ran: false, why: due.dropped ? 'dropped' : 'not due' };
    }

    running = true;
    // Marked before it runs: a crash or a slow check must never make the same time run twice.
    st.checkLastRun = t.toISOString();
    saveState(st);
    const lateMs = t - due.at;
    log(`scheduled check: running (due ${due.at.toISOString()}${lateMs > 2 * 60 * 1000 ? ', caught up' : ''})`);
    try {
      await runCheck({ scheduledFor: due.at, caughtUp: lateMs > 2 * 60 * 1000 });
    } catch (e) {
      log(`scheduled check failed: ${e && e.message ? e.message : e}`);
    } finally {
      running = false;
    }
    return { ran: true, at: due.at };
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
