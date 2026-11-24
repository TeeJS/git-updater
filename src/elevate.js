'use strict';

// IO edge: installers that need administrator rights, run together behind ONE Windows
// prompt by the installer helper (helper/, PROJECT-one-admin-prompt.md).
//
// git-updater never runs as administrator. With the setting on, an installer whose silent
// run failed for lack of administrator rights is not opened in its own window; the runner
// SETS IT ASIDE (setAsideEntry below) and carries on. When the run is over, finish() hands
// everything set aside to the helper in one go: the helper asks Windows for permission
// once and runs them all.
//
// Whatever goes wrong, today's route is never lost: an installer the helper cannot take
// (no publisher's signature, or the helper itself failing) is opened in its own window,
// exactly as it would have been with the setting off.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const helper = require('./helper');
const { installerCmd } = require('./core');
const { log } = require('./log');

const { CODES } = helper;

// The helper runs two kinds: an .msi (through Windows' msiexec) and an .exe (run itself).
const HELPER_KIND = { msi: 'msi', nsis: 'exe', inno: 'exe', exe: 'exe' };
const PLACEHOLDER = 'C:\\installer';

// The silent switches git-updater would use for this installer (installerCmd decides, as it
// does for a normal run), in the form the helper's job list takes. null when the installer
// is not a kind the helper runs.
function switchesFor(spec) {
  const kind = HELPER_KIND[spec && spec.kind];
  if (!kind) return null;
  const { args, verbatim } = installerCmd(spec.kind, PLACEHOLDER, spec.args, spec.rawArgs, spec.switchless === true);
  // A verbatim switch string goes through untouched; the helper puts `/i "<file>"` in front
  // of it for an MSI itself.
  if (verbatim) return { kind, raw: String(spec.rawArgs).trim() };
  if (kind !== 'msi') return { kind, args };
  // msiexec's arguments are `/i <file> <switches...>`: the helper supplies the first two.
  if (args[0] !== '/i' || args[1] !== PLACEHOLDER) return null;
  return { kind, args: args.slice(2) };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Keep a copy of a downloaded installer for the administrator run (the download folder is
// removed when the app's own run ends) and describe it for the helper. Returns
// { item, file, keepDir }, or null when this installer is not one the helper can take.
async function setAsideEntry(file, stageBase, spec) {
  const switches = switchesFor(spec);
  if (!switches) return null;
  const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
  const keep = path.join(keepDir, path.basename(file));
  try {
    fs.copyFileSync(file, keep);
    const item = { file: keep, sha256: await sha256(keep), ...switches };
    helper.jobText([item]); // throws now, not at the prompt, if the helper would refuse the job
    return { item, file: keep, keepDir };
  } catch (e) {
    discard({ keepDir });
    log(`  could not set the installer aside for the administrator run (${e.message})`);
    return null;
  }
}

function discard(entry) {
  if (!entry || !entry.keepDir) return;
  try {
    fs.rmSync(entry.keepDir, { recursive: true, force: true });
  } catch {}
}

// Start the helper and collect what it prints. Never through a shell.
function runHelper(exe, args, spawn = childProcess.spawn) {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      resolve({ code: null, stdout, error: e });
      return;
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (error) => resolve({ code: null, stdout, error }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

// Why an installer was not run, or how it ended, in the words a row shows.
const REFUSED = {
  [CODES.hashMismatch]: 'the installer changed after it was downloaded, so it was not run — Retry',
  [CODES.notAnInstaller]: 'the download is not an installer that can be run with administrator permission',
  [CODES.copyFailed]: 'the installer could not be prepared for the administrator run — Retry',
  [CODES.couldNotStart]: 'the installer could not be started',
  [CODES.timedOut]: 'the installer did not finish in time and was stopped',
};
const DECLINED = 'administrator permission was not given — Retry';
// Elevated, so 1603 no longer means "needs administrator rights": it is a real failure.
const INSTALLER_EXIT = {
  1602: 'installer was cancelled',
  1618: 'another installer is already running — wait for it to finish, then Retry',
  1619: 'installer package could not be opened',
  1620: 'installer package is invalid',
};
const exitReason = (code) => REFUSED[code] || INSTALLER_EXIT[code] || `installer failed (exit ${code}) — if the app is open, close it and Retry`;

const TIMEOUT_SECS = 600; // per installer: the same ten minutes a normal silent run gets

// Run everything that was set aside. `entries` are what the runner made:
//   { key, item, keepDir, succeed(), ownWindow(), fail(reason) }
//     succeed()    record the install and return the app's result
//     ownWindow()  open the installer in its own window (today's route) and return that result
//     fail(reason) return a failed result
// Returns a Map of key -> result. Never throws: every entry gets a result.
async function finish(entries, opts = {}) {
  const out = new Map();
  if (!entries.length) return out;
  const { helperPath, stageBase, spawn } = opts;
  const handedOver = new Set(); // opened in their own window: that window is using the file
  const ownWindow = (e, why) => {
    log(`  ${e.key}: ${why}; opening its own installer window instead`);
    try {
      out.set(e.key, e.ownWindow());
      handedOver.add(e);
    } catch (err) {
      out.set(e.key, e.fail(err.message));
    }
  };
  let jobDir = null;
  try {
    jobDir = fs.mkdtempSync(path.join(stageBase, 'admin-job-'));
    const writeJob = (list, name) => {
      const file = path.join(jobDir, name);
      fs.writeFileSync(file, helper.jobText(list.map((e) => e.item), { timeoutSecs: TIMEOUT_SECS }));
      return file;
    };
    const read = (r, count) => {
      if (r.code !== CODES.ok) return null;
      try {
        return helper.parseResults(r.stdout, count);
      } catch {
        return null;
      }
    };
    const problem = (r) => (r.error ? r.error.message : `exit ${r.code}`);

    // 1. Before asking for anything: which of these will the helper take? One it refuses
    //    for having no publisher's signature opens its own window, as it always has.
    const checked = await runHelper(helperPath, ['--verify', '--job', writeJob(entries, 'verify.txt')], spawn);
    const verdicts = read(checked, entries.length);
    if (!verdicts) {
      for (const e of entries) ownWindow(e, `the installer helper could not be used (${problem(checked)})`);
      return out;
    }
    const accepted = [];
    entries.forEach((e, i) => {
      if (verdicts[i] === CODES.ok) accepted.push(e);
      else if (verdicts[i] === CODES.notSigned) ownWindow(e, 'the installer has no valid publisher signature');
      else out.set(e.key, e.fail(exitReason(verdicts[i])));
    });
    if (!accepted.length) return out;

    // 2. The one prompt, then every accepted installer in turn.
    log(`administrator run: ${accepted.length} installer(s) — ${accepted.map((e) => e.key).join(', ')}`);
    const ran = await runHelper(helperPath, ['--install', '--job', writeJob(accepted, 'install.txt')], spawn);
    if (ran.code === CODES.declined) {
      log('administrator run: permission was not given');
      for (const e of accepted) out.set(e.key, e.fail(DECLINED));
      return out;
    }
    const codes = read(ran, accepted.length);
    if (!codes) {
      for (const e of accepted) ownWindow(e, `the administrator run failed (${problem(ran)})`);
      return out;
    }
    accepted.forEach((e, i) => {
      const code = codes[i];
      log(`  ${e.key}: ${code === null ? 'not reached' : `exit ${code}`}`);
      if (helper.succeeded(code)) {
        try {
          out.set(e.key, e.succeed());
        } catch (err) {
          out.set(e.key, e.fail(err.message));
        }
      } else if (code === CODES.notSigned) ownWindow(e, 'the installer has no valid publisher signature');
      else if (code === null) out.set(e.key, e.fail('the administrator run stopped before this installer — Retry'));
      else out.set(e.key, e.fail(exitReason(code)));
    });
    return out;
  } catch (err) {
    // Nothing above should throw; if it does, no app is left without an answer.
    for (const e of entries) if (!out.has(e.key)) ownWindow(e, `the administrator run could not be prepared (${err.message})`);
    return out;
  } finally {
    if (jobDir) discard({ keepDir: jobDir });
    for (const e of entries) if (!handedOver.has(e)) discard(e);
  }
}

module.exports = { switchesFor, setAsideEntry, discard, finish, runHelper, exitReason, DECLINED, TIMEOUT_SECS };
