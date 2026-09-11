'use strict';

// Shared subprocess helper for the platform modules. Everything is ASYNC on purpose:
// these inventory commands take seconds, and a spawnSync would freeze the Electron
// main process (window paint, IPC) for that whole time.
//
// No shell is ever used — the command and its arguments are passed as an argv array,
// so nothing is parsed or expanded by an intermediate shell.

const { spawn } = require('child_process');

// Run a command without blocking; resolve its stdout ('' on any failure, including
// the command not existing at all). Callers treat '' as "this source has nothing".
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve('');
    }
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // A hung inventory command must not hang the whole scan.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish('');
    }, opts.timeout || 60_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Some inventory tools exit nonzero with partial-but-usable output; callers that
      // care pass acceptAnyExit. The default stays strict, as the registry reader was.
      finish(code === 0 || opts.acceptAnyExit ? out : '');
    });
  });
}

module.exports = { run };
