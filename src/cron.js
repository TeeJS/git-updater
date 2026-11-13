'use strict';

// A small cron-style schedule parser, with no dependency. Five fields, in this computer's local time:
//
//   minute  hour  day-of-month  month  day-of-week
//   0-59    0-23  1-31          1-12   0-7 (0 and 7 are Sunday)
//
// Each field takes  *  a number  a-b  a-b/n  */n  and comma lists of those. Months and weekdays take
// names (JAN..DEC, SUN..SAT). Two extensions to the classic syntax, both needed for things people
// actually ask for:
//
//   weekday#n     "the nth weekday of the month":  2#1 or TUE#1 is the first Tuesday.
//   L             in the day-of-month field: the last day of the month.
//
// The classic rule is kept on purpose: when BOTH day-of-month and day-of-week are restricted (do not
// start with *), a day matches when EITHER does. That is what cron has always done, and it is why
// "the first Tuesday" cannot be written the classic way (47 2 1-7 * 2 would also run every Tuesday);
// use 47 2 * * 2#1. The Settings screen shows the next run times so the meaning is never a guess.
//
// A time that does not exist on a daylight-saving day (2:47 AM on the spring-forward day) is skipped.

const NAMES = {
  month: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  dow: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
};

const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dom', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12, names: NAMES.month, nameBase: 1 },
  { key: 'dow', min: 0, max: 7, names: NAMES.dow, nameBase: 0 },
];

function num(text, field) {
  const t = String(text).trim();
  if (field.names) {
    const i = field.names.indexOf(t.toUpperCase());
    if (i >= 0) return i + field.nameBase;
  }
  if (!/^\d+$/.test(t)) throw new Error(`"${text}" is not a valid ${field.key.replace('dom', 'day-of-month').replace('dow', 'day-of-week')} value`);
  const n = Number(t);
  if (n < field.min || n > field.max) throw new Error(`${field.key.replace('dom', 'day-of-month').replace('dow', 'day-of-week')} must be ${field.min} to ${field.max} (got ${n})`);
  return n;
}

// One field -> { set, nth, last }. nth is a Map weekday -> Set of occurrences (dow field only).
function parseField(text, field) {
  const set = new Set();
  const nth = new Map();
  let last = false;
  for (const part of String(text).split(',')) {
    if (part === '') throw new Error(`empty entry in the ${field.key} field`);
    if (field.key === 'dom' && part.toUpperCase() === 'L') { last = true; continue; }
    if (field.key === 'dow' && part.includes('#')) {
      const [d, n] = part.split('#');
      const day = num(d, field) % 7;
      if (!/^[1-5]$/.test(n)) throw new Error(`"${part}": the number after # must be 1 to 5`);
      if (!nth.has(day)) nth.set(day, new Set());
      nth.get(day).add(Number(n));
      continue;
    }
    const [range, stepText] = part.split('/');
    if (part.split('/').length > 2) throw new Error(`"${part}" has more than one /`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`"${part}": the step after / must be 1 or more`);
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (range === '*') { lo = field.min; hi = field.key === 'dow' ? 6 : field.max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = num(a, field);
      hi = num(b, field);
      if (lo > hi) throw new Error(`"${part}": ${lo} is after ${hi}`);
    } else {
      lo = num(range, field);
      hi = stepText !== undefined ? (field.key === 'dow' ? 6 : field.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(field.key === 'dow' ? v % 7 : v);
  }
  return { set, nth, last };
}

// Parse a schedule. Throws an Error with a message fit to show the user.
function parse(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('enter a schedule, for example 0 9 * * *');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a schedule has 5 fields (minute hour day-of-month month day-of-week), this has ${parts.length}`);
  const out = { expr: parts.join(' ') };
  FIELDS.forEach((f, i) => {
    out[f.key] = parseField(parts[i], f);
    out[`${f.key}Text`] = parts[i];
  });
  // Classic cron: a day field counts as "restricted" unless it starts with *.
  out.domRestricted = !out.domText.startsWith('*');
  out.dowRestricted = !out.dowText.startsWith('*');
  return out;
}

const daysIn = (y, m0) => new Date(y, m0 + 1, 0).getDate();

function dayMatches(p, date) {
  const dom = date.getDate();
  const dow = date.getDay();
  const domOk = p.dom.set.has(dom) || (p.dom.last && dom === daysIn(date.getFullYear(), date.getMonth()));
  const occurrence = Math.ceil(dom / 7);
  const dowOk = p.dow.set.has(dow) || (p.dow.nth.has(dow) && p.dow.nth.get(dow).has(occurrence));
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

// The first run strictly after `after` (a Date), or null if there is none within about 8 years.
function next(parsed, after) {
  const p = typeof parsed === 'string' ? parse(parsed) : parsed;
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getFullYear() + 8;
  for (let guard = 0; guard < 200000 && t.getFullYear() <= limit; guard++) {
    if (!p.month.set.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(p, t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!p.hour.set.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!p.minute.set.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return t;
  }
  return null;
}

function nextRuns(parsed, from, count) {
  const p = typeof parsed === 'string' ? parse(parsed) : parsed;
  const out = [];
  let at = from;
  for (let i = 0; i < count; i++) {
    const n = next(p, at);
    if (!n) break;
    out.push(n);
    at = n;
  }
  return out;
}

const HOUR_MS = 60 * 60 * 1000;

// Parse and check a schedule: it must be valid and must not fire more often than once an hour (the
// GitHub rate limit is 60 requests an hour without a token). Returns { ok, error, runs }.
function validate(expr, now = new Date(), count = 3) {
  let p;
  try { p = parse(expr); } catch (e) { return { ok: false, error: e.message, runs: [] }; }
  const probe = nextRuns(p, now, 12);
  if (!probe.length) return { ok: false, error: 'this schedule never runs', runs: [] };
  for (let i = 1; i < probe.length; i++) {
    if (probe[i] - probe[i - 1] < HOUR_MS) return { ok: false, error: 'this runs more often than once an hour, which is not allowed', runs: [] };
  }
  return { ok: true, error: null, runs: probe.slice(0, count) };
}

// Is a run due? `lastRun` is when the schedule last ran (or when it was switched on). The first
// scheduled time after it that has already passed is due. With catchUp the run happens whenever
// that is noticed (the app was off or the computer asleep at the time); without it, only if the
// time just passed (within `graceMs`), and a run that was missed is dropped.
function isDue(parsed, lastRun, now, opts = {}) {
  const grace = opts.graceMs == null ? 2 * 60 * 1000 : opts.graceMs;
  const at = next(parsed, lastRun);
  if (!at || at > now) return { due: false, at };
  if (opts.catchUp !== false) return { due: true, at };
  return { due: now - at <= grace, at, dropped: now - at > grace };
}

module.exports = { parse, next, nextRuns, validate, isDue, HOUR_MS };
