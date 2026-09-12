'use strict';

// Sign, notarize and staple the DISK IMAGE.
//
// electron-builder notarizes and staples the .app only. The .dmg is packaged around it
// afterwards and is left untouched — and the .dmg is what a user downloads and what
// Gatekeeper assesses first. Measured on macOS 26.6.2 arm64, a build that produced a
// perfectly notarized app also produced this:
//
//   codesign -dv <dmg>    code object is not signed at all
//   spctl --type open     rejected, source=no usable signature
//
// Not an online-check-that-might-work. An outright rejection, every time.
//
// A NOTARIZATION TICKET ALONE DOES NOT FIX IT. Submitting the image and stapling it, which
// is what the sibling project's build script does, still measured:
//
//   stapler staple        The staple and validate action worked
//   spctl --type open     STILL rejected, source=no usable signature
//
// The control that settled it — two known-good shipped disk images from other vendors
// against two of ours, all four stapled:
//
//   ours, unsigned                       spctl REJECTED
//   the sibling project's, unsigned      spctl REJECTED   (a shipped release)
//   Claude.dmg, signed                   spctl accepted, Notarized Developer ID
//   oMLX.dmg, signed                     spctl accepted, Notarized Developer ID
//
// So the image needs its own signature AND its own ticket.
//
// THE ORDER IS LOAD-BEARING. Signing invalidates an existing staple: after signing, a
// previously-valid ticket reads "does not have a ticket stapled to it". So it is sign,
// then submit, then staple — never submit then sign. electron-builder's own dmg.sign
// documentation warns that signing "will lead to unwanted errors in combination with
// notarization requirements", which is this, and which is why we do all three ourselves
// after electron-builder has finished rather than trusting its ordering.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// notarytool arguments for whichever credential source is configured. Mirrors the sets
// build/verify-mac-build.js accepts, so a build that can notarize the app can notarize
// the image. null when none is available — the caller then leaves the image alone and the
// guard reports the artifact as unnotarized, which is the honest outcome.
function notarytoolAuth(env = process.env) {
  const has = (k) => !!(env[k] && String(env[k]).trim());
  if (has('APPLE_KEYCHAIN_PROFILE')) {
    return [
      '--keychain-profile',
      env.APPLE_KEYCHAIN_PROFILE,
      ...(has('APPLE_KEYCHAIN') ? ['--keychain', env.APPLE_KEYCHAIN] : []),
    ];
  }
  if (has('APPLE_ID') && has('APPLE_APP_SPECIFIC_PASSWORD') && has('APPLE_TEAM_ID')) {
    return ['--apple-id', env.APPLE_ID, '--team-id', env.APPLE_TEAM_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD];
  }
  if (has('APPLE_API_KEY') && has('APPLE_API_KEY_ID') && has('APPLE_API_ISSUER')) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  return null;
}

// The Developer ID in the login keychain. Read from the keychain rather than configured,
// because the certificate is the thing that actually exists on the build machine and a
// second place to name it is a second place for it to be wrong.
function developerIdentity() {
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const m = /"(Developer ID Application:[^"]+)"/.exec(r.stdout || '');
  return m ? m[1] : null;
}

function dmgsIn(artifactPaths, outDir) {
  const fromArtifacts = (artifactPaths || []).filter((p) => /\.dmg$/i.test(p));
  if (fromArtifacts.length) return fromArtifacts;
  // artifactPaths is the normal source; fall back to reading outDir so a change in the
  // hook contract cannot silently leave every image unsigned.
  try {
    return fs
      .readdirSync(outDir)
      .filter((n) => /\.dmg$/i.test(n))
      .map((n) => path.join(outDir, n));
  } catch {
    return [];
  }
}

// Returns what it did, so the caller can report it. Throws on a failure part-way through:
// a half-processed image is worse than an untouched one, because the app inside is already
// notarized and the image would look deliberate.
function signNotarizeStaple(dmg, identity, auth) {
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' });
  const name = path.basename(dmg);

  const signed = run('codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
  if (signed.status !== 0) throw new Error(`signing ${name} failed (codesign exit ${signed.status})`);

  const sub = run('xcrun', ['notarytool', 'submit', dmg, '--wait', ...auth]);
  if (sub.status !== 0) {
    throw new Error(
      `notarizing ${name} failed (notarytool exit ${sub.status}) — the app inside is still notarized; see the output above`
    );
  }

  const stapled = run('xcrun', ['stapler', 'staple', dmg]);
  if (stapled.status !== 0) throw new Error(`stapling ${name} failed (stapler exit ${stapled.status})`);
}

// Process every .dmg the build produced. A no-op, quietly, when there is nothing to do or
// no credentials — the guard in verify-mac-build.js is what refuses to ship an
// unnotarized artifact, and it checks the files rather than trusting this.
function notarizeDmgs(context) {
  if (process.platform !== 'darwin') return [];
  const dmgs = dmgsIn(context && context.artifactPaths, context && context.outDir);
  if (!dmgs.length) return [];

  const auth = notarytoolAuth();
  const identity = developerIdentity();
  if (!auth || !identity) return [];

  for (const dmg of dmgs) signNotarizeStaple(dmg, identity, auth);
  return dmgs;
}

module.exports = { notarizeDmgs, notarytoolAuth, developerIdentity, dmgsIn };
