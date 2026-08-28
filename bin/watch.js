#!/usr/bin/env node
'use strict';

// CLI: parse args -> run -> print summary -> set exit code. No shell/PowerShell use.
// Installers that need admin fail with a clear "run as administrator" message.

const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const github = require('../src/github');
const runner = require('../src/runner');
const state = require('../src/state');

// Are we running as the packaged single-exe (SEA)? Then process.execPath IS the
// app exe and there is no script file to pass as an argument.
let IS_SEA = false;
try {
  IS_SEA = require('node:sea').isSea();
} catch {}

// Config resolved next to the app (exe dir when packaged, repo root in dev) — NOT the
// launch cwd, so shortcuts / different working dirs all see the same config.
const APP_DIR = IS_SEA ? path.dirname(process.execPath) : path.join(__dirname, '..');
const DEFAULT_CONFIG = path.join(APP_DIR, 'config.json');

function parseArgs(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        a.flags[key] = next;
        i++;
      } else {
        a.flags[key] = true;
      }
    } else {
      a._.push(t);
    }
  }
  return a;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function usage() {
  console.error(
    [
      'usage:',
      '  watch check [--config p] [--only owner/repo] [--state p]',
      '  watch update [--config p] [--only owner/repo] [--dry-run] [--force] [--state p]',
      '  watch list-assets owner/repo',
    ].join('\n')
  );
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const configPath = args.flags.config || DEFAULT_CONFIG; // app-dir default, aligned with the web UI
  const statePath = typeof args.flags.state === 'string' ? args.flags.state : undefined;
  const asJson = !!args.flags.json; // emit machine-readable output (used by the web server)

  if (cmd === 'list-assets') {
    const [owner, repo] = String(args._[1] || '').split('/');
    if (!owner || !repo) usage();
    const { tag, assets } = await github.listAssets(owner, repo);
    console.log(`${owner}/${repo} @ ${tag}`);
    if (!assets.length) console.log('  (no assets)');
    assets.forEach((n) => console.log('  ' + n));
    return 0;
  }

  if (cmd !== 'check' && cmd !== 'update') usage();

  const config = core.validateConfig(readJson(configPath));

  if (cmd === 'check') {
    const { results, summary } = await runner.run(config, { mode: 'check', only: args.flags.only, statePath });
    console.log(asJson ? JSON.stringify({ results, summary }) : summary.text);
    return 0;
  }

  // update
  const opts = {
    only: typeof args.flags.only === 'string' ? args.flags.only : undefined,
    statePath,
    force: !!args.flags.force,
    dryRun: !!args.flags['dry-run'],
  };

  // No PowerShell / self-relaunch elevation (an EDR trigger). Installers that need admin
  // fail with a clear "run as administrator" message; run git-updater elevated for those.
  // Portable apps under a user-writable folder never need admin.
  let lock = null;
  if (!opts.dryRun) lock = state.acquireLock(statePath);
  const results = [];
  try {
    const { results: res } = await runner.run(config, opts);
    results.push(...res);
  } finally {
    state.releaseLock(lock);
  }

  const summary = core.buildSummary(results);
  console.log(asJson ? JSON.stringify({ results, summary }) : summary.text);
  return summary.counts.failed > 0 ? 1 : 0;
}

// Set exitCode and let the event loop drain rather than process.exit() — a hard
// exit while global fetch (undici) sockets are still closing trips a libuv
// assertion on Windows. Idle keep-alive sockets are unref'd, so exit stays prompt.
main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exitCode = 1;
  });
