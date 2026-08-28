#!/usr/bin/env node
'use strict';

// CLI: parse args -> run -> print summary -> set exit code.
// Owns Windows self-elevation: repos that need admin are re-run in an elevated
// child (one UAC prompt per such app); the child returns its result via a temp file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const core = require('../src/core');
const github = require('../src/github');
const install = require('../src/install');
const runner = require('../src/runner');

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

// Re-run one repo in an elevated child; return its structured result.
function relaunchElevated(repo, ctx) {
  const id = `${repo.owner}/${repo.repo}`;
  const resultFile = path.join(os.tmpdir(), `rw-result-${repo.repo}-${process.pid}.json`);
  const nodeArgs = [
    path.resolve(__filename),
    'update',
    '--only',
    id,
    '--_elevated',
    '--_result',
    resultFile,
    '--config',
    path.resolve(ctx.configPath),
  ];
  if (ctx.statePath) nodeArgs.push('--state', path.resolve(ctx.statePath));
  if (ctx.force) nodeArgs.push('--force');

  const quoted = nodeArgs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
  const ps = `Start-Process -Verb RunAs -Wait -FilePath '${process.execPath}' -ArgumentList ${quoted}`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  try {
    const out = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    fs.unlinkSync(resultFile);
    return out[0] || { repo: id, status: 'failed', reason: 'elevated run produced no result' };
  } catch {
    return { repo: id, status: 'failed', reason: `elevated run failed (exit ${r.status})` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const configPath = args.flags.config || './repos.json';
  const statePath = typeof args.flags.state === 'string' ? args.flags.state : undefined;

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
    const { summary } = await runner.run(config, { mode: 'check', only: args.flags.only, statePath });
    console.log(summary.text);
    return 0;
  }

  // update
  const opts = {
    only: typeof args.flags.only === 'string' ? args.flags.only : undefined,
    statePath,
    force: !!args.flags.force,
    dryRun: !!args.flags['dry-run'],
  };
  const isChild = !!args.flags._elevated;
  const elevated = isChild || install.isElevated();

  const targets = config.repos.filter(
    (r) => !opts.only || `${r.owner}/${r.repo}`.toLowerCase() === opts.only.toLowerCase()
  );

  const results = [];
  if (!opts.dryRun && !elevated) {
    const inline = [];
    for (const r of targets) {
      if (install.needsElevation(r, elevated)) {
        console.error(`  … ${r.owner}/${r.repo} needs admin — requesting elevation`);
        results.push(relaunchElevated(r, { configPath, statePath, force: opts.force }));
      } else {
        inline.push(r);
      }
    }
    const { results: inlineRes } = await runner.run({ repos: inline }, opts);
    results.push(...inlineRes);
  } else {
    const { results: res } = await runner.run({ repos: targets }, opts);
    results.push(...res);
  }

  // elevated child hands its result back through the temp file, no printing
  if (isChild && typeof args.flags._result === 'string') {
    fs.writeFileSync(args.flags._result, JSON.stringify(results));
    return 0;
  }

  const summary = core.buildSummary(results);
  console.log(summary.text);
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
