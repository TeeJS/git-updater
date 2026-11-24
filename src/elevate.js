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
//
// A Linux .deb is taken too (kind 'deb'): there is no helper there, the system's own apt-get
// installs it (finishLinux below). apt-get takes no installer switches, so a .deb the user
// pinned dpkg switches for keeps its own route.
async function setAsideEntry(file, stageBase, spec) {
  const deb = !!spec && spec.kind === 'deb';
  if (deb && ((spec.args && spec.args.length) || spec.rawArgs)) return null;
  const switches = deb ? { kind: 'deb' } : switchesFor(spec);
  if (!switches) return null;
  const keepDir = fs.mkdtempSync(path.join(stageBase, 'admin-'));
  const keep = path.join(keepDir, path.basename(file));
  try {
    fs.copyFileSync(file, keep);
    const item = { file: keep, sha256: await sha256(keep), ...switches };
    if (!deb) helper.jobText([item]); // throws now, not at the prompt, if the helper would refuse the job
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
  if (opts.linux) return finishLinux(entries, opts);
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

// ---------------------------------------------------------------------------------------------
// Linux (Debian and Ubuntu family): one password prompt, through polkit's pkexec.
// PROJECT-linux-one-password-prompt.md.
//
// There is no helper program here. git-updater starts ONE command,
//
//     pkexec --disable-internal-agent /bin/sh -c <ADMIN_SCRIPT> git-updater-admin <limit> <sha256> <file> ...
//
// and the desktop shows its normal password prompt. As root, the script below installs each
// package in turn with the system's own apt-get. git-updater never sees the password, and
// nothing is installed on the system to make this work: no polkit rule, no service, no
// root-owned file.
//
// Why a script and not `pkexec apt-get install a.deb b.deb`: that is one transaction, so one
// package with a missing dependency fails every other one; apt cannot be told not to ask
// questions (that is an environment variable, and pkexec clears the environment); and a hung
// install could never be stopped, because git-updater cannot signal a root process. The
// script gives each package its own run, its own time limit and its own result.
//
// What the copy and the hash check are worth, plainly: they narrow the window in which
// another program running as this user could swap a file between the download check and the
// install. They do not close it — on Linux git-updater lives in a folder the user can write
// and is not signed, so such a program could change git-updater itself. The password prompt
// is the real gate, as with sudo.
// ---------------------------------------------------------------------------------------------

// POSIX sh (dash on Debian and Ubuntu): no bashisms. Runs as root, so it uses a fixed PATH and
// only the system's own tools. Arguments: <limit seconds> then one <sha256> <file> pair per
// package. Prints, for each package by position:
//     result <n> exit <code>     apt-get's exit status (0 = installed; 124/137 = time limit)
//     result <n> copy            the file could not be copied
//     result <n> hash            the copy is not the file that was downloaded
//     reason <n> <text>          up to three lines of apt's own explanation, on failure
// between the lines "git-updater-admin 1" and "git-updater-admin done".
const ADMIN_SCRIPT = String.raw`PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
umask 022
limit=$1
shift
dir=$(mktemp -d /var/tmp/git-updater-admin.XXXXXXXX) || exit 70
trap 'rm -rf "$dir"' EXIT
chmod 755 "$dir"
echo "git-updater-admin 1"
i=0
while [ "$#" -ge 2 ]; do
  sum=$1
  src=$2
  shift 2
  copy="$dir/$i.deb"
  if ! cp -- "$src" "$copy" 2>/dev/null; then
    echo "result $i copy"
  elif [ "$(sha256sum < "$copy" | cut -c1-64)" != "$sum" ]; then
    echo "result $i hash"
  else
    out=$(timeout -k 30 "$limit" apt-get install -y -q -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$copy" </dev/null 2>&1)
    code=$?
    if [ "$code" -ne 0 ]; then
      printf '%s\n' "$out" | grep -E '^(E:|dpkg: error| .*(Depends|Conflicts|Breaks):)' | head -n 3 | while IFS= read -r line; do
        echo "reason $i $line"
      done
    fi
    echo "result $i exit $code"
  fi
  rm -f "$copy"
  i=$((i+1))
done
echo "git-updater-admin done"
exit 0
`;

// pkexec(1): 126 = the user dismissed the password prompt. 127 = not authorized, the password
// was not accepted, or no prompt could be shown at all.
const PKEXEC_DISMISSED = 126;

// Where the tools live. Fixed system folders only, never the user's PATH: what runs as root
// is the system's own pkexec, sh and apt-get. null when this is not Linux or one is missing
// (an rpm system has no apt-get) — the setting is then not offered and nothing is set aside.
const LINUX_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
function linuxTools(exists = fs.existsSync, platform = process.platform) {
  if (platform !== 'linux') return null;
  const find = (name) => LINUX_DIRS.map((d) => `${d}/${name}`).find((f) => exists(f)) || null;
  const pkexec = find('pkexec');
  const sh = find('sh');
  return pkexec && sh && find('apt-get') ? { pkexec, sh } : null;
}

// What the script printed, as one answer per package: { kind: 'exit', code } | { kind: 'copy' }
// | { kind: 'hash' }, each with `reasons`, or null for a package it never reached. Returns null
// when the script never started (its first line is missing): no permission, or no prompt.
function parseAdminOutput(text, count) {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.includes('git-updater-admin 1')) return null;
  const results = new Array(count).fill(null);
  const reasons = new Map();
  for (const line of lines) {
    const why = /^reason (\d+) (.*)$/.exec(line);
    if (why) {
      const n = Number(why[1]);
      reasons.set(n, [...(reasons.get(n) || []), why[2].trim()]);
      continue;
    }
    const m = /^result (\d+) (copy|hash|exit (\d+))$/.exec(line);
    if (!m || Number(m[1]) >= count) continue;
    results[Number(m[1])] = m[3] === undefined ? { kind: m[2] } : { kind: 'exit', code: Number(m[3]) };
  }
  results.forEach((r, n) => { if (r) r.reasons = reasons.get(n) || []; });
  return results;
}

// A package apt-get would not install, in the words a row shows. apt's own explanation is the
// useful part ("Depends: libfoo but it is not installable"), so a dependency line is preferred
// over its closing summary.
function linuxReason(r) {
  if (r.kind === 'copy') return REFUSED[CODES.copyFailed];
  if (r.kind === 'hash') return REFUSED[CODES.hashMismatch];
  if (r.code === 124 || r.code === 137) return REFUSED[CODES.timedOut];
  const line = r.reasons.find((l) => /(Depends|Conflicts|Breaks):/.test(l)) || r.reasons[0];
  if (!line) return `the package could not be installed (apt-get exit ${r.code})`;
  return `the package could not be installed: ${line.replace(/^E:\s*/, '').slice(0, 200)}`;
}

// finish() for Linux. Same contract: every entry gets a result, and nothing throws.
async function finishLinux(entries, opts) {
  const out = new Map();
  const { linux, spawn } = opts;
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
  try {
    const args = ['--disable-internal-agent', linux.sh, '-c', ADMIN_SCRIPT, 'git-updater-admin', String(opts.timeoutSecs || TIMEOUT_SECS)];
    for (const e of entries) args.push(e.item.sha256, e.item.file);
    log(`administrator run: ${entries.length} package(s) — ${entries.map((e) => e.key).join(', ')}`);
    const ran = await runHelper(linux.pkexec, args, spawn);
    const results = parseAdminOutput(ran.stdout, entries.length);
    if (!results) {
      if (ran.code === PKEXEC_DISMISSED) {
        log('administrator run: the password prompt was dismissed');
        for (const e of entries) out.set(e.key, e.fail(DECLINED));
      } else {
        // No prompt could be shown (no polkit agent in this session), or the password was not
        // accepted. Either way today's route still works: the desktop's own package installer.
        const problem = ran.error ? ran.error.message : `pkexec exit ${ran.code}`;
        for (const e of entries) ownWindow(e, `the one password prompt could not be used (${problem})`);
      }
      return out;
    }
    entries.forEach((e, i) => {
      const r = results[i];
      log(`  ${e.key}: ${!r ? 'not reached' : r.kind === 'exit' ? `apt-get exit ${r.code}` : r.kind}`);
      if (!r) out.set(e.key, e.fail('the administrator run stopped before this installer — Retry'));
      else if (r.kind === 'exit' && r.code === 0) {
        try {
          out.set(e.key, e.succeed());
        } catch (err) {
          out.set(e.key, e.fail(err.message));
        }
      } else out.set(e.key, e.fail(linuxReason(r)));
    });
    return out;
  } catch (err) {
    for (const e of entries) if (!out.has(e.key)) ownWindow(e, `the administrator run could not be prepared (${err.message})`);
    return out;
  } finally {
    for (const e of entries) if (!handedOver.has(e)) discard(e);
  }
}

module.exports = {
  switchesFor, setAsideEntry, discard, finish, runHelper, exitReason, DECLINED, TIMEOUT_SECS,
  linuxTools, parseAdminOutput, linuxReason, ADMIN_SCRIPT, PKEXEC_DISMISSED,
};
