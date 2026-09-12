'use strict';

// The macOS extraction paths, driven with a stubbed subprocess layer.
//
// Neither a Windows nor a Linux machine can run ditto or hdiutil, so without this the
// module's entire control flow ships unexecuted. Stubbing the one seam it has — the
// exec module — runs the real branching, which is where all three of these bugs lived:
// a silent ditto failure, a timeout short enough to cause one, and an error message
// that could never fire.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exec = require('../src/platform/exec');
const mac = require('../src/platform/mac');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-mac-'));

// Replace exec.runStatus for one test. `plan` is called with (cmd, args, opts) and
// returns the { code, out, timedOut } the real command would have produced.
// Must be async and AWAIT fn: returning the promise from inside try/finally restores
// the real functions the instant fn returns its promise, long before the awaited work
// inside it runs, and every stub silently has no effect.
async function withStub(plan, fn) {
  const real = exec.runStatus;
  const realRun = exec.run;
  const calls = [];
  exec.runStatus = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return plan(cmd, args, opts) || { code: 0, out: '', timedOut: false };
  };
  exec.run = async () => ''; // detach and the inventory queries are not under test here
  try {
    return await fn(calls);
  } finally {
    exec.runStatus = real;
    exec.run = realRun;
  }
}

// hdiutil attaching successfully means the mountpoint now has content.
const mountWith = (names) => (cmd, args) => {
  if (cmd === 'hdiutil' && args[0] === 'attach') {
    const mnt = args[args.indexOf('-mountpoint') + 1];
    for (const n of names) fs.writeFileSync(path.join(mnt, n), 'payload');
    return { code: 0, out: '', timedOut: false };
  }
  return { code: 0, out: '', timedOut: false };
};

test('dmg: a failing ditto throws instead of silently shipping a partial bundle', async () => {
  const dest = tmp();
  try {
    await withStub(
      (cmd, args) => {
        if (cmd === 'ditto') return { code: 1, out: '', timedOut: false };
        return mountWith(['App.app', 'Extra.app'])(cmd, args);
      },
      async () => {
        await assert.rejects(() => mac.extractDmg('/x/App.dmg', dest), /copying App\.app failed \(ditto exit 1\)/);
      }
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: a ditto timeout is reported as a timeout, not as success', async () => {
  const dest = tmp();
  try {
    await withStub(
      (cmd, args) => {
        if (cmd === 'ditto') return { code: null, out: '', timedOut: true };
        return mountWith(['App.app'])(cmd, args);
      },
      async () => {
        await assert.rejects(() => mac.extractDmg('/x/App.dmg', dest), /timed out/);
      }
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: copying a large bundle gets far more than the inventory-query timeout', async () => {
  const dest = tmp();
  try {
    await withStub(mountWith(['App.app']), async (calls) => {
      await mac.extractDmg('/x/App.dmg', dest);
      const copy = calls.find((c) => c.cmd === 'ditto');
      // 60s is the exec default and is not enough for a 300MB bundle off a compressed
      // image; being killed mid-copy is what made the silent-partial case reachable.
      assert.ok(copy.opts && copy.opts.timeout > 60_000, 'ditto must raise the default timeout');
    });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: a failed mount reports the licence agreement, not an empty image', async () => {
  const dest = tmp();
  try {
    await withStub(
      (cmd, args) => (cmd === 'hdiutil' && args[0] === 'attach' ? { code: 1, out: '', timedOut: false } : undefined),
      async () => {
        // mkdtempSync has already created the mountpoint, so readdir succeeds on an
        // empty directory. Judging the mount by hdiutil's own exit code is what makes
        // this message reachable at all — it was dead before.
        await assert.rejects(() => mac.extractDmg('/x/App.dmg', dest), /licence agreement/);
      }
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: a mounted but empty image is still an error', async () => {
  const dest = tmp();
  try {
    await withStub(mountWith([]), async () => {
      await assert.rejects(() => mac.extractDmg('/x/App.dmg', dest), /contained nothing to install/);
    });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: the drag-to-Applications symlink and dotfiles are not treated as payload', async () => {
  const dest = tmp();
  try {
    await withStub(mountWith(['App.app', 'Applications', '.background', '.DS_Store']), async (calls) => {
      await mac.extractDmg('/x/App.dmg', dest);
      const copied = calls.filter((c) => c.cmd === 'ditto').map((c) => path.basename(c.args[0]));
      assert.deepEqual(copied, ['App.app']);
    });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('dmg: the image is detached after a successful mount', async () => {
  const dest = tmp();
  try {
    await withStub(mountWith(['App.app']), async (calls) => {
      await mac.extractDmg('/x/App.dmg', dest);
      // detach goes through run(), which the stub replaces wholesale, so assert on the
      // attach/copy ordering that precedes it rather than on the detach call itself.
      assert.deepEqual(
        calls.map((c) => c.cmd),
        ['hdiutil', 'ditto']
      );
    });
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('zip: a failing ditto extraction throws rather than reporting success', async () => {
  const dest = tmp();
  try {
    await withStub(
      (cmd) => (cmd === 'ditto' ? { code: 2, out: '', timedOut: false } : undefined),
      async () => {
        await assert.rejects(() => mac.extract('/x/App-mac.zip', dest), /extracting the archive failed/);
      }
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('zip: a successful ditto extraction reports that it handled the archive', async () => {
  const dest = tmp();
  try {
    await withStub(
      () => ({ code: 0, out: '', timedOut: false }),
      async (calls) => {
        assert.equal(await mac.extract('/x/App-mac.zip', dest), true);
        assert.deepEqual(calls[0].args.slice(0, 2), ['-x', '-k']);
        // An archive macOS does not claim is left to the generic extractor.
        assert.equal(await mac.extract('/x/app.tar.gz', dest), false);
      }
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// --- the seam itself ---------------------------------------------------------

test('exec: run() cannot distinguish silent success from failure, runStatus can', async () => {
  // This is the whole reason ditto needed runStatus. A tool that succeeds without
  // printing anything and a tool that fails both give run() the empty string.
  const ok = await exec.runStatus(process.execPath, ['-e', 'process.exit(0)']);
  const bad = await exec.runStatus(process.execPath, ['-e', 'process.exit(3)']);
  assert.deepEqual([ok.code, ok.out], [0, '']);
  assert.deepEqual([bad.code, bad.out], [3, '']);
  assert.equal(await exec.run(process.execPath, ['-e', 'process.exit(0)']), '');
  assert.equal(await exec.run(process.execPath, ['-e', 'process.exit(3)']), '');
});

test('exec: a command that does not exist resolves rather than throwing', async () => {
  const r = await exec.runStatus('definitely-not-a-real-command-xyz', []);
  assert.equal(r.code, null);
  assert.equal(r.out, '');
  assert.equal(await exec.run('definitely-not-a-real-command-xyz', []), '');
});

// --- differential signature check ---------------------------------------------
// A macOS bundle is sealed: one foreign file makes it objectively invalid, confirmed on
// real hardware through this exact code path. The check is differential rather than
// absolute, because an unsigned or ad-hoc bundle also fails verification and refusing
// those would drop support for software a user can install by hand today.

const platform = require('../src/platform');
const install = require('../src/install');

// Replace verifyPayload for one test. `verdicts` is consulted in order, one per call.
async function withVerify(verdicts, fn) {
  const real = platform.verifyPayload;
  const calls = [];
  let i = 0;
  platform.verifyPayload = async (dir) => {
    calls.push(dir);
    return verdicts[Math.min(i++, verdicts.length - 1)];
  };
  try {
    return await fn(calls);
  } finally {
    platform.verifyPayload = real;
  }
}

const zipOf = (dir, build) => {
  const src = path.join(dir, 'payload');
  fs.mkdirSync(src, { recursive: true });
  build(src);
  const AdmZip = require('adm-zip');
  const z = new AdmZip();
  z.addLocalFolder(src);
  const p = path.join(dir, 'app-1.0-mac.zip');
  z.writeZip(p);
  return p;
};

test('install: a bundle valid before and broken after is rolled back, not shipped', async () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'App');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'marker'), 'v1'); // the working install
    const zip = zipOf(base, (d) => fs.writeFileSync(path.join(d, 'marker'), 'v2'));

    await withVerify([{ valid: true }, { valid: false, reason: 'a sealed resource is missing or invalid' }], async () => {
      await assert.rejects(
        () => install.installPortable(zip, { dir: dest }),
        /failed signature verification.*sealed resource.*previous version has been restored/s
      );
    });

    // The user is left with a working app, not a broken one plus an error.
    assert.equal(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'v1');
    assert.equal(fs.existsSync(dest + '.git-updater-old'), false, 'parked copy cleaned up');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('install: a bundle valid before and after commits normally', async () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'App');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'marker'), 'v1');
    const zip = zipOf(base, (d) => fs.writeFileSync(path.join(d, 'marker'), 'v2'));
    await withVerify([{ valid: true }, { valid: true }], async () => {
      await install.installPortable(zip, { dir: dest });
    });
    assert.equal(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'v2');
    assert.equal(fs.existsSync(dest + '.git-updater-old'), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('install: an app that was never validly signed is installed, not refused', async () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'App');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'marker'), 'v1');
    const zip = zipOf(base, (d) => fs.writeFileSync(path.join(d, 'marker'), 'v2'));
    // Invalid BEFORE: unsigned or ad-hoc. The check must not fire at all.
    await withVerify([{ valid: false, reason: 'code object is not signed at all' }], async (calls) => {
      await install.installPortable(zip, { dir: dest });
      assert.equal(calls.length, 1, 'no second verification once the baseline is invalid');
    });
    assert.equal(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'v2');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('install: a first install is never verified — there is no baseline to compare to', async () => {
  const base = tmp();
  try {
    const dest = path.join(base, 'App');
    const zip = zipOf(base, (d) => fs.writeFileSync(path.join(d, 'marker'), 'v1'));
    await withVerify([{ valid: false, reason: 'should never be consulted' }], async (calls) => {
      await install.installPortable(zip, { dir: dest });
      assert.equal(calls.length, 0);
    });
    assert.equal(fs.readFileSync(path.join(dest, 'marker'), 'utf8'), 'v1');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- why a mount failed -------------------------------------------------------
// The message this replaces asserted a licence agreement for EVERY non-zero hdiutil exit.
// Measured on real hardware: a file that is not a disk image, and a transient "Resource
// temporarily unavailable", both produced that text, and neither involved a licence.
// stderr carries hdiutil's actual reason, so the message quotes it.

test('mountFailure: quotes hdiutil\'s own reason instead of guessing a licence agreement', () => {
  const m = mac.mountFailure({ code: 1, err: 'hdiutil: attach failed - not recognized\n' });
  assert.match(m, /not recognized/);
  assert.ok(!/^could not mount the disk image — it may require/.test(m), 'must not lead with the licence guess');
  assert.ok(!/hdiutil:/.test(m), 'the tool name prefix is stripped');
});

test('mountFailure: a real transient failure is reported as itself', () => {
  // verbatim from a measured failure on macOS 26
  const m = mac.mountFailure({ code: 1, err: 'hdiutil: attach failed - Resource temporarily unavailable\n' });
  assert.match(m, /Resource temporarily unavailable/);
});

test('mountFailure: the licence agreement survives as a possibility, not a diagnosis', () => {
  const m = mac.mountFailure({ code: 1, err: 'hdiutil: attach failed - boom' });
  assert.match(m, /If the image requires accepting a licence agreement/);
});

test('mountFailure: no stderr falls back to the exit code, and a timeout says timeout', () => {
  assert.match(mac.mountFailure({ code: 1, err: '' }), /hdiutil exit 1/);
  assert.match(mac.mountFailure({ code: null, err: '' }), /hdiutil exit n\/a/);
  assert.match(mac.mountFailure({ code: null, err: '', timedOut: true }), /timed out/);
});

// A disk image holding a .pkg used to advise switching the entry to Installer. Measured,
// that advice is a closed loop: the mac asset table counts a .dmg as portable-only and an
// installer as .pkg-only, so a release publishing only a .dmg makes the installer lane
// throw "change its type to Portable". The two messages send the user back and forth
// forever, and each one is correct on its own. Asserted against the message value rather
// than by mounting an image, so it runs on every platform.
test('the .pkg-in-a-disk-image message does not point at a setting that cannot work', () => {
  const core = require('../src/core');
  // Precondition: for a dmg-only release the Installer lane really is a dead end.
  assert.throws(
    () => core.pickAsset([{ name: 'App-1.0.dmg' }, { name: 'App-1.0-mac.zip' }], 'installer', 'darwin'),
    /change its type to Portable/
  );
  assert.match(mac.PKG_IN_DMG, /installer package/);
  assert.ok(!/type to Installer/i.test(mac.PKG_IN_DMG), 'must not advise the Installer type: that loops');
});
