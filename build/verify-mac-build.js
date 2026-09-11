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

// electron-builder hook. Runs once every artifact exists, which is after its own
// notarization step, so the ticket is there by now if it is coming.
exports.default = async function verifyMacBuild(context) {
  // This hook is global, so it runs for Windows and Linux builds too. The absence of a
  // .app is what makes it a no-op there — cheaper and more honest than trying to read
  // the platform out of a context shape that differs between hook types.
  const appOutDir = context.appOutDir || (context.outDir && path.join(context.outDir, 'mac-arm64'));
  if (!appOutDir) return;
  const appPath = path.join(appOutDir, 'git-updater.app');
  if (!fs.existsSync(appPath)) return;
  if (process.platform !== 'darwin') return; // codesign only exists here

  const allow = process.env.GITUPDATER_ALLOW_UNNOTARIZED === '1';
  const creds = credentialState();

  if (isNotarized(appPath)) {
    console.log('  • notarization verified against the artifact, not the build log');
    return;
  }

  const why = creds.ok
    ? 'credentials were present, so notarization was attempted and did not take'
    : explain(creds);
  const message =
    `macOS build is NOT notarized: ${why}.\n` +
    `  ${appPath}\n` +
    '  Gatekeeper refuses an unnotarized app on Apple Silicon exactly as it refuses an unsigned one,\n' +
    '  so this artifact would not launch for anyone who downloaded it.\n' +
    '  Set GITUPDATER_ALLOW_UNNOTARIZED=1 for a local build you are not shipping.';

  if (allow) {
    console.warn(`  ! ${message}`);
    return;
  }
  throw new Error(message);
};

module.exports.credentialState = credentialState;
module.exports.isNotarized = isNotarized;
