'use strict';

// The text git-updater and its Windows installer helper exchange. Pure: no IO here.
//
// The helper (helper/, a small signed program) runs installers that need administrator
// rights behind ONE Windows prompt, so git-updater itself never runs elevated. The format is
// documented at the other end, helper/src/job.rs; the two are tested against each other in
// test/helper.test.js. It is plain lines rather than JSON so the helper needs no parser
// library.
//
// Everything written here is checked as strictly as the helper checks it, so git-updater
// never asks for permission to run a job the helper would then refuse.

const JOB_HEADER = 'git-updater-helper-job 1';
const RESULTS_HEADER = 'git-updater-helper-results 1';
const MAX_ITEMS = 64;
const MAX_ARGS = 64;
const MAX_LINE = 8192;
const MAX_TIMEOUT_SECS = 3600;

// The helper's own codes. As its exit code they describe the whole run; in a results line
// they describe one installer that was never started. Any other number in a results line is
// that installer's own exit code.
const CODES = Object.freeze({
  ok: 0,
  declined: 1223, // the Windows prompt was answered No, or it timed out
  badJob: 64001,
  elevationFailed: 64002,
  notElevated: 64003,
  noSafeFolder: 64004,
  copyFailed: 64005,
  hashMismatch: 64006,
  notSigned: 64007,
  couldNotStart: 64008,
  timedOut: 64009,
  noResults: 64010,
  notAnInstaller: 64011,
});

const hasControl = (s) => /[\u0000-\u001f\u007f-\u009f]/.test(s);

// A full path on a lettered drive, with no "." or ".." parts: the only kind the helper takes.
function isPlainLocalPath(file) {
  if (typeof file !== 'string' || !/^[A-Za-z]:[\\/]/.test(file) || hasControl(file)) return false;
  const parts = file.slice(3).split(/[\\/]/);
  return parts.length > 0 && parts.every((p) => p !== '' && p !== '.' && p !== '..' && !/[<>:"|?*]/.test(p));
}

function line(key, value, what) {
  const text = value === '' ? key : `${key} ${value}`;
  if (typeof value !== 'string' || hasControl(value)) throw new Error(`${what} cannot be written into a helper job`);
  if (Buffer.byteLength(text, 'utf8') > MAX_LINE) throw new Error(`${what} is too long for a helper job`);
  return text;
}

// items: [{ file, sha256, kind: 'msi' | 'exe', args?: string[], raw?: string }]
//   args  the switches that follow the installer (for an MSI: what follows `msiexec /i <file>`)
//   raw   instead of args: one switch string passed exactly as written
// Returns the job file's text. Throws on anything the helper would refuse.
function jobText(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('a helper job needs at least one installer');
  if (items.length > MAX_ITEMS) throw new Error(`a helper job takes at most ${MAX_ITEMS} installers`);
  const out = [JOB_HEADER];
  if (opts.timeoutSecs !== undefined) {
    const t = opts.timeoutSecs;
    if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_SECS) throw new Error('the time allowed per installer must be 1 to 3600 seconds');
    out.push(`timeout ${t}`);
  }
  for (const item of items) {
    const { file, sha256, kind, args, raw } = item || {};
    if (!isPlainLocalPath(file)) throw new Error(`not a full path on a local drive: ${file}`);
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) throw new Error(`not a SHA-256 for ${file}`);
    if (kind !== 'msi' && kind !== 'exe') throw new Error(`the helper runs "msi" and "exe" installers, not "${kind}"`);
    const hasArgs = Array.isArray(args) && args.length > 0;
    const hasRaw = raw !== undefined && raw !== null;
    if (hasArgs && hasRaw) throw new Error('an installer takes separate switches or one verbatim string, not both');
    if (args !== undefined && !Array.isArray(args)) throw new Error('installer switches must be a list');
    out.push('item', line('file', file, 'this installer path'), `sha256 ${sha256.toLowerCase()}`, `kind ${kind}`);
    if (hasRaw) {
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('a verbatim switch string cannot be empty');
      out.push(line('raw', raw, 'this switch string'));
    } else if (hasArgs) {
      if (args.length > MAX_ARGS) throw new Error(`an installer takes at most ${MAX_ARGS} switches`);
      for (const arg of args) out.push(line('arg', arg, 'this switch'));
    }
  }
  return out.join('\n') + '\n';
}

// The helper's results text -> one entry per installer in the job, in job order: its code,
// or null for an installer the helper never reached. Throws when the text is not results.
function parseResults(text, count) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.shift() !== RESULTS_HEADER) throw new Error('the helper did not return results');
  const codes = new Array(count).fill(null);
  for (const l of lines) {
    const m = /^(\d{1,3}) (\d{1,10})$/.exec(l);
    const index = m ? Number(m[1]) : -1;
    if (!m || index >= count || codes[index] !== null) throw new Error('the helper returned results that do not match the job');
    codes[index] = Number(m[2]);
  }
  return codes;
}

// 0, and 3010 (done, restart needed), are an installer saying it succeeded.
const succeeded = (code) => code === 0 || code === 3010;

module.exports = { JOB_HEADER, RESULTS_HEADER, CODES, jobText, parseResults, succeeded, isPlainLocalPath };
