'use strict';

// Builds the Windows installer helper (helper/, a small Rust program) for each Windows
// architecture git-updater ships, signs it, and puts it where electron-builder picks it up:
//
//   helper/dist/x64/git-updater-helper.exe
//   helper/dist/arm64/git-updater-helper.exe
//
// package.json's build.win.extraResources copies helper/dist/<arch>/ into the packaged app's
// resources/helper/ folder. Run this BEFORE electron-builder --win:
//
//   node build/build-helper.js            both architectures
//   node build/build-helper.js x64        one
//
// Needs Rust (rustup, cargo) with the MSVC toolchain. The arm64 target is added on demand.
// Signing goes through the same sign.js hook as the app itself, so it needs the same setup;
// like that hook, a missing setup leaves the file unsigned with a warning. The release
// workflow then refuses to go on: it checks the signature on the packaged file.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'helper');
const TARGETS = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
const EXE = 'git-updater-helper.exe';

async function main() {
  if (process.platform !== 'win32') {
    console.log('build-helper: the installer helper is a Windows program; nothing to build on this platform.');
    return;
  }
  const wanted = process.argv.slice(2);
  const archs = wanted.length ? wanted : Object.keys(TARGETS);
  const sign = require(path.join(ROOT, 'sign.js')).default;
  for (const arch of archs) {
    const target = TARGETS[arch];
    if (!target) throw new Error(`unknown architecture "${arch}" (known: ${Object.keys(TARGETS).join(', ')})`);
    console.log(`build-helper: ${arch} (${target})`);
    execFileSync('rustup', ['target', 'add', target], { cwd: HELPER, stdio: 'inherit' });
    // --locked: exactly the dependency versions in helper/Cargo.lock, or the build fails.
    execFileSync('cargo', ['build', '--release', '--locked', '--target', target], { cwd: HELPER, stdio: 'inherit' });
    const built = path.join(HELPER, 'target', target, 'release', EXE);
    const out = path.join(HELPER, 'dist', arch, EXE);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(built, out);
    await sign({ path: out });
    console.log(`build-helper: ${out} (${fs.statSync(out).size} bytes)`);
  }
}

main().catch((e) => {
  console.error(`build-helper failed: ${e.message}`);
  process.exit(1);
});
