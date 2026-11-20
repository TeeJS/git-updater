'use strict';

// Fail a macOS build at second one, not minute four, when the machine cannot sign.
//
// The failure this exists for: a locked login keychain. codesign can still SEE the
// Developer ID — `security find-identity` lists it — but it cannot reach the private
// key, and it reports that as `errSecInternalComponent` against whichever file it
// happened to reach first, typically a locale.pak buried in the Electron framework.
// Measured: that error names a resource file, mentions neither the keychain nor the
// key, and arrives only after @electron/rebuild and a full packaging pass. Every
// property of it points away from the cause.
//
// The cost of that is not the wasted minutes. It is that the error invites a theory —
// resource forks, entitlements, hardenedRuntime — and each of those theories suggests
// an edit to the signing config, which is correct as written. Wrong error, plausible
// wrong fix, working config edited to be broken.
//
// So: probe the actual operation before the build starts, and say the true cause.
// A live codesign against a throwaway file is the only check that covers the whole
// path — a present certificate, an unlocked keychain, and an ACL that lets codesign
// use the key without a UI prompt. The first two can pass while signing still fails.
//
// Same posture as build/verify-mac-build.js, at the other end of the build: check the
// operation, not the log. Set GITUPDATER_ALLOW_UNNOTARIZED=1 to skip, consistent with
// that file — a deliberate local build you are not shipping.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { notarytoolAuth, developerIdentity } = require('./notarize-dmg');

function fail(lines) {
  throw new Error(['macOS build preflight failed.', '', ...lines, ''].join('\n'));
}

// The keychain the Developer ID lives in. APPLE_KEYCHAIN wins because notarytoolAuth
// already honours it, and a build pointed at one keychain must not be checked against
// another.
function signingKeychain() {
  if (process.env.APPLE_KEYCHAIN && process.env.APPLE_KEYCHAIN.trim()) {
    return process.env.APPLE_KEYCHAIN.trim();
  }
  const r = spawnSync('security', ['default-keychain'], { encoding: 'utf8' });
  const m = /"([^"]+)"/.exec(r.stdout || '');
  return m ? m[1] : path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
}

// Locked keychains answer every query with "User interaction is not allowed." — the
// same string whether the keychain is locked or merely unreachable from this session,
// which is why the codesign probe below is the check that decides.
function keychainLocked(keychain) {
  const r = spawnSync('security', ['show-keychain-info', keychain], { encoding: 'utf8' });
  return /User interaction is not allowed/i.test(r.stderr || '');
}

// Sign a throwaway file with the real identity. Cheap (milliseconds), and it exercises
// the exact path the build will take.
function codesignProbe(identity) {
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-preflight-')), 'probe');
  try {
    fs.writeFileSync(probe, 'probe');
    const r = spawnSync('codesign', ['--force', '--sign', identity, probe], { encoding: 'utf8' });
    return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  } finally {
    fs.rmSync(path.dirname(probe), { recursive: true, force: true });
  }
}

function preflightMac() {
  const keychain = signingKeychain();

  const identity = developerIdentity();
  if (!identity) {
    fail([
      'No "Developer ID Application" certificate found in the codesigning identities.',
      '',
      `  security find-identity -v -p codesigning   # inspect ${keychain}`,
    ]);
  }

  const probe = codesignProbe(identity);
  if (!probe.ok) {
    const locked = keychainLocked(keychain);
    fail([
      `codesign could not sign with "${identity}".`,
      probe.output ? `  ${probe.output}` : '',
      '',
      locked
        ? `The keychain is locked: ${keychain}`
        : `The certificate is present but its private key is unusable: ${keychain}`,
      '',
      'Unlock it in a shell with a real terminal — over SSH that means your own',
      'session, not a command run through an agent, because `security` prompts on',
      '/dev/tty and a prompt with nowhere to go hangs silently:',
      '',
      `  security unlock-keychain ${keychain}`,
      `  security show-keychain-info ${keychain}   # "no-timeout" means usable`,
      '',
      'Do not change build/entitlements.mac.plist, hardenedRuntime, or the signing',
      'identity in response to this — none of them cause it.',
    ].filter((l) => l !== ''));
  }

  if (!notarytoolAuth()) {
    fail([
      'Signing works, but no notarization credentials are configured, so the build',
      'would produce artifacts Gatekeeper refuses on Apple Silicon.',
      '',
      '  APPLE_KEYCHAIN_PROFILE=git-updater npm run dist:mac',
      '',
      'Or set GITUPDATER_ALLOW_UNNOTARIZED=1 for a local build you are not shipping.',
    ]);
  }
}

// electron-builder beforePack hook. Runs for every platform, so it has to opt in to
// darwin itself; a Windows or Linux build on this machine must not be blocked by the
// state of a keychain it never touches.
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.GITUPDATER_ALLOW_UNNOTARIZED === '1') return;
  preflightMac();
};

module.exports.preflightMac = preflightMac;
