'use strict';

// Fail a macOS build that produced an app macOS will not run.
//
// electron-builder's `mac.notarize: true` is a request, not a guarantee. With no
// credentials in the environment it logs a "skipped macOS notarization" line whose
// reason is that the notarize options could not be generated — and EXITS 0. (Paraphrased
// deliberately: the verbatim line contains a backtick-quoted token, and a quote that
// cannot be reproduced exactly is better not presented as one.)
// Measured: the build then produces a .dmg
// and .zip that are correctly signed with the Developer ID, carry the hardened runtime
// and all four entitlements — and that Gatekeeper rejects outright, because on Apple
// Silicon a Developer ID signature without a notarization ticket is refused exactly
// like no signature at all.
//
// That is the same shape as every other bug on this branch: a success report and an
// artifact that does not work. A release built this way would be discovered broken by
// whoever downloaded it first.
//
// So: check the ticket against the artifact rather than trusting the log, and fail.
//
// Deliberately NOT modelled on sign.js, which degrades to an unsigned Windows build
// with a warning. An unsigned Windows app still runs, behind a SmartScreen prompt. An
// unnotarized mac app does not run at all, so a warning is not a proportionate response.
//
// Set GITUPDATER_ALLOW_UNNOTARIZED=1 for a deliberate local build you are not shipping.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The three credential sets electron-builder accepts. Any one is enough; a partial set
// is worse than none, because it is what a misconfigured CI looks like.
const CREDENTIAL_SETS = [
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_KEYCHAIN_PROFILE'],
];

function credentialState(env = process.env) {
  const present = (k) => !!(env[k] && String(env[k]).trim());
  for (const set of CREDENTIAL_SETS) {
    const have = set.filter(present);
    if (have.length === set.length) return { ok: true, using: set[0] };
    if (have.length) return { ok: false, partial: set, missing: set.filter((k) => !present(k)) };
  }
  return { ok: false };
}

// `codesign --test-requirement="=notarized"` is the only check that asks the question we
// actually care about. `codesign -v` passes on a signed-but-unnotarized app, and
// `stapler validate` speaks only to the staple rather than to acceptance.
function isNotarized(appPath) {
  try {
    execFileSync('codesign', ['--test-requirement==notarized', '--verify', '--strict', appPath], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function explain(state) {
  if (state.partial) {
    return `only part of a credential set is set (${state.partial.join(', ')}); missing: ${state.missing.join(', ')}`;
  }
  return 'no notarization credentials in the environment — set one of: ' + CREDENTIAL_SETS.map((s) => s.join(' + ')).join('  |  ');
}

// Was this a macOS build at all? The hook is TOLD, so there is no need to infer it from
// what happens to be on disk. Measured: electron-builder hands afterAllArtifactBuild
// { outDir, artifactPaths, platformToTargets, configuration } — no appOutDir — and
// platformToTargets is keyed by platform name.
//
// This distinction is the whole point. "Not a macOS build, correctly do nothing" and
// "this IS a macOS build and the app could not be found, so something is wrong" must not
// collapse into the same silent return. They did, and the guard then protected nothing
// while still reporting success — the exact failure it exists to prevent, reproduced
// inside it.
function builtForMac(context) {
  const keys = context && context.platformToTargets ? [...context.platformToTargets.keys()] : [];
  if (keys.some((k) => String((k && k.name) || k).toLowerCase() === 'mac')) return true;
  const artifacts = (context && context.artifactPaths) || [];
  return artifacts.some((a) => /\.dmg$/i.test(String(a)));
}

// Every .app under outDir, one and two levels down. Scanning rather than assuming means
// neither the product name nor the architecture directory is hard-coded: a productName
// change or an added target used to turn the guard into a no-op.
function findApps(outDir) {
  const out = [];
  const list = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const e of list(outDir)) {
    const p = path.join(outDir, e.name);
    if (/\.app$/i.test(e.name)) {
      out.push(p);
      continue;
    }
    if (!e.isDirectory()) continue;
    for (const inner of list(p)) {
      if (/\.app$/i.test(inner.name)) out.push(path.join(p, inner.name));
    }
  }
  return out;
}

// electron-builder hook. Runs once every artifact exists, which is after its own
// notarization step, so the ticket is there by now if it is coming.
exports.default = async function verifyMacBuild(context) {
  if (!builtForMac(context)) return; // genuinely not our business

  const outDir = context && context.outDir;
  if (!outDir) throw new Error('macOS build: no outDir in the hook context, so nothing could be verified');

  if (process.platform !== 'darwin') {
    // codesign does not exist here, so the artifact cannot be checked. Saying so is the
    // only honest option: silently passing would claim a guarantee we did not make.
    throw new Error(
      `macOS build produced on ${process.platform}, where its notarization cannot be verified. ` +
        'Build it on macOS, or set GITUPDATER_ALLOW_UNNOTARIZED=1 to accept an unverified artifact.'
    );
  }

  const apps = findApps(outDir);
  if (!apps.length) {
    throw new Error(
      `macOS build: no .app found under ${outDir}, so notarization could not be verified. ` +
        'This is a guard failure, not a build failure — the layout changed.'
    );
  }

  const creds = credentialState();
  const bad = apps.filter((a) => !isNotarized(a));
  if (!bad.length) {
    console.log(`  • notarization verified against ${apps.length} artifact(s), not the build log`);
    return;
  }

  const why = creds.ok
    ? 'credentials were present, so notarization was attempted and did not take'
    : explain(creds);
  const nl = String.fromCharCode(10);
  const message =
    `macOS build is NOT notarized: ${why}.` + nl +
    bad.map((a) => `  ${a}`).join(nl) + nl +
    '  Gatekeeper refuses an unnotarized app on Apple Silicon exactly as it refuses an unsigned one,' + nl +
    '  so this artifact would not launch for anyone who downloaded it.' + nl +
    '  Set GITUPDATER_ALLOW_UNNOTARIZED=1 for a local build you are not shipping.';

  if (process.env.GITUPDATER_ALLOW_UNNOTARIZED === '1') {
    console.warn(`  ! ${message}`);
    return;
  }
  throw new Error(message);
};

module.exports.credentialState = credentialState;
module.exports.isNotarized = isNotarized;
module.exports.builtForMac = builtForMac;
module.exports.findApps = findApps;
