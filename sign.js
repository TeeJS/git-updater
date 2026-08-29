'use strict';
/*
 * electron-builder custom Windows sign hook → Azure Trusted Signing (Artifact Signing).
 * electron-builder calls this once per file it wants signed (app exe, portable exe, NSIS
 * installer + uninstaller). Each call signs configuration.path with SignTool + the Trusted
 * Signing dlib, authenticating SILENTLY through the local `Connect-AzAccount` login.
 *
 * Auth note: the dlib's AzurePowerShellCredential needs PowerShell 7 to unwrap the Az.Accounts
 * 5.x SecureString token (Windows PowerShell 5.1 lacks `ConvertFrom-SecureString -AsPlainText`),
 * so we put the per-user pwsh on PATH for the SignTool process. AZURE_TENANT_ID pins the right
 * tenant (a personal MS account otherwise defaults to its consumer tenant). metadata.json excludes
 * every non-pwsh credential so it never falls back to an interactive browser.
 *
 * Machine setup required to actually sign (otherwise the hook logs a warning and leaves files
 * UNSIGNED so a plain checkout still builds):
 *   - .signing/dlib-x64/Azure.CodeSigning.Dlib.dll   (Microsoft.Trusted.Signing.Client NuGet)
 *   - .signing/metadata.json                          (endpoint/account/profile, BOM-less UTF-8)
 *   - SignTool (Windows SDK) · .NET 8 runtime · per-user PowerShell 7 at %LOCALAPPDATA%\pwsh7
 *   - a current `Connect-AzAccount` session for an account with the cert-profile-signer role
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SIGNING_DIR = path.join(__dirname, '.signing');
const DLIB = path.join(SIGNING_DIR, 'dlib-x64', 'Azure.CodeSigning.Dlib.dll');
const META = path.join(SIGNING_DIR, 'metadata.json');
const TENANT = 'a4ae2122-9515-4f85-abc8-71c29ccc261f';                       // Default Directory tenant (not a secret)
const PWSH_DIR = path.join(process.env.LOCALAPPDATA || '', 'pwsh7');         // per-user PowerShell 7
const TIMESTAMP = 'http://timestamp.acs.microsoft.com';

function findSignTool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  try {
    const versions = fs.readdirSync(base).filter(d => /^10\./.test(d)).sort().reverse();
    for (const v of versions) { const p = path.join(base, v, 'x64', 'signtool.exe'); if (fs.existsSync(p)) return p; }
  } catch (e) {}
  const direct = path.join(base, 'x64', 'signtool.exe');
  return fs.existsSync(direct) ? direct : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitUnlocked(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); return; } catch (e) {}
    await sleep(500);
  }
}

exports.default = async function (configuration) {
  const file = configuration.path;
  if (!file) return;
  const signtool = findSignTool();
  if (!signtool || !fs.existsSync(DLIB) || !fs.existsSync(META)) {
    console.warn('  ⚠ Trusted Signing setup missing (.signing/ or SignTool) — leaving UNSIGNED:', file);
    return;
  }
  console.log('  • Trusted Signing →', file);
  const env = Object.assign({}, process.env, {
    AZURE_TENANT_ID: TENANT,
    PATH: PWSH_DIR + path.delimiter + (process.env.PATH || ''),
  });
  await waitUnlocked(file);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(signtool, ['sign', '/v', '/fd', 'SHA256', '/tr', TIMESTAMP, '/td', 'SHA256', '/dlib', DLIB, '/dmdf', META, file], { stdio: 'inherit', env });
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.warn(`  ⚠ signtool failed (attempt ${attempt}), retrying in 2s…`);
      await sleep(2000);
    }
  }
};
