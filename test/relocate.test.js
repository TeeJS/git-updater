'use strict';

// Moving a portable app's folder (src/relocate.js), on real folders in a temp directory.
// The rules under test are the ones that keep config.json from ever pointing where an app
// is not: all or nothing, never over something that is already there, a copy-and-check
// across drives, and an honest message when anything is refused.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const relocate = require('../src/relocate');
const install = require('../src/install');

// realpath: on macOS the temp dir is a link (/var -> /private/var).
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gu-relocate-')));
function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return dir;
}
const read = (dir) => Object.fromEntries(install.walk(dir).map((f) => [f.split(path.sep).join('/'), fs.readFileSync(path.join(dir, f), 'utf8')]).sort());
const FILES = { 'app.exe': 'program', 'data/level1.dat': 'level one', 'data/deep/x.bin': 'x' };
const move = (root, name, to) => ({ key: `acme/${name}#portable`, name, from: path.join(root, 'apps', name), to });
// A rename that behaves as if the two folders were on different drives.
const otherDrive = () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); };
// assert.rejects matches a pattern against "Error: …"; these messages are checked whole.
const says = (pattern) => (e) => { assert.match(e.message, pattern); assert.strictEqual(e.refused, true); return true; };
const fsCopy = (src, dest) => fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });

test('a folder is moved whole, into a place whose parents do not exist yet', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  const to = path.join(d, 'games', 'fps', 'quake');
  const job = await relocate.run([move(d, 'quake', to)]);
  assert.deepStrictEqual(job.moved, [{ key: 'acme/quake#portable', name: 'quake', from: path.join(d, 'apps', 'quake'), to, copied: false }]);
  assert.deepStrictEqual(read(to), FILES);
  assert.strictEqual(fs.existsSync(path.join(d, 'apps', 'quake')), false);
  assert.deepStrictEqual(job.commit(), [], 'a rename leaves nothing to clean up');
});

test('undo puts every folder back and removes the folders it had created', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  put(path.join(d, 'apps', 'doom'), { 'doom.exe': 'd' });
  fs.mkdirSync(path.join(d, 'games')); // was there before: must still be there after
  const job = await relocate.run([move(d, 'quake', path.join(d, 'games', 'fps', 'quake')), move(d, 'doom', path.join(d, 'games', 'doom'))]);
  assert.strictEqual(job.moved.length, 2);
  assert.deepStrictEqual(job.undo(), []);
  assert.deepStrictEqual(read(path.join(d, 'apps', 'quake')), FILES);
  assert.deepStrictEqual(read(path.join(d, 'apps', 'doom')), { 'doom.exe': 'd' });
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'games')), [], 'nothing of the attempt is left, and the folder that was there is kept');
});

test('all or nothing: a failure in the middle puts back the folders already moved', async () => {
  const d = tmp();
  for (const name of ['one', 'two', 'three']) put(path.join(d, 'apps', name), { [`${name}.txt`]: name });
  const calls = [];
  // The second folder cannot be renamed, the way a folder with an open file cannot on Windows.
  const rename = (from, to) => {
    calls.push(path.basename(from));
    if (path.basename(from) === 'two' && to.includes('games')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    fs.renameSync(from, to);
  };
  const moves = ['one', 'two', 'three'].map((n) => move(d, n, path.join(d, 'games', n)));
  await assert.rejects(relocate.run(moves, { rename }), (e) => {
    assert.strictEqual(e.refused, true);
    assert.match(e.message, /^two was not moved: its files are in use or cannot be moved\. If it is running, close it, then try again\. Nothing was changed\.$/);
    return true;
  });
  assert.deepStrictEqual(calls, ['one', 'two', 'one'], 'the third was never touched, and the first was renamed back');
  for (const name of ['one', 'two', 'three']) assert.deepStrictEqual(read(path.join(d, 'apps', name)), { [`${name}.txt`]: name });
  assert.strictEqual(fs.existsSync(path.join(d, 'games')), false, 'the folder made for the move is gone again');
});

test('never overwrite: a new place that already has files refuses the move, before anything is touched', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'one'), { 'one.txt': '1' });
  put(path.join(d, 'apps', 'two'), { 'two.txt': '2' });
  put(path.join(d, 'games', 'two'), { 'someone-elses.txt': 'not ours' });
  const moves = [move(d, 'one', path.join(d, 'games', 'one')), move(d, 'two', path.join(d, 'games', 'two'))];
  const said = new RegExp(`^two was not moved: ${path.join(d, 'games', 'two').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} already exists and is not empty\\. Nothing was changed\\.$`);
  assert.throws(() => relocate.inspect(moves), says(said));
  await assert.rejects(relocate.run(moves), says(said));
  assert.deepStrictEqual(read(path.join(d, 'apps', 'one')), { 'one.txt': '1' }, 'the first app was not moved either');
  assert.deepStrictEqual(read(path.join(d, 'games', 'two')), { 'someone-elses.txt': 'not ours' });
  assert.strictEqual(fs.existsSync(path.join(d, 'games', 'one')), false);
  // A file with the folder's name is in the way just the same.
  fs.writeFileSync(path.join(d, 'games', 'one'), 'a file');
  assert.throws(() => relocate.inspect([moves[0]]), /one was not moved: .* already exists and is not empty/);
});

test('an empty folder at the new place is fine (the folder picker\'s "New Folder" makes one)', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  fs.mkdirSync(path.join(d, 'picked'));
  const job = await relocate.run([move(d, 'quake', path.join(d, 'picked'))]);
  assert.deepStrictEqual(read(path.join(d, 'picked')), FILES);
  // Undone, the empty folder is back as it was.
  job.undo();
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'picked')), []);
  assert.deepStrictEqual(read(path.join(d, 'apps', 'quake')), FILES);
});

test('nothing to move: an app that is not installed yet, and a folder that is already the same place', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'here'), { 'a.txt': 'a' });
  fs.mkdirSync(path.join(d, 'apps', 'empty'));
  const seen = relocate.inspect([
    move(d, 'missing', path.join(d, 'games', 'missing')),
    move(d, 'empty', path.join(d, 'games', 'empty')),
    move(d, 'here', path.join(d, 'apps', 'sub', '..', 'here')),
  ]);
  assert.deepStrictEqual(seen.map((m) => m.action), ['none', 'none', 'none']);
  const job = await relocate.run(seen);
  assert.deepStrictEqual(job.moved, []);
  assert.strictEqual(fs.existsSync(path.join(d, 'games')), false, 'no folder is created for an app with nothing to move');
  // A link to the folder is the same folder, not a place that "already exists".
  let linked = true;
  try { fs.symlinkSync(path.join(d, 'apps', 'here'), path.join(d, 'alias'), 'junction'); } catch { linked = false; }
  if (linked) assert.strictEqual(relocate.inspect([move(d, 'here', path.join(d, 'alias'))])[0].action, 'none');
});

test('a new place inside the folder being moved is refused', () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  assert.throws(() => relocate.inspect([move(d, 'quake', path.join(d, 'apps', 'quake', 'inner'))]), /quake was not moved: .* is inside the folder it is in now\. Nothing was changed\./);
  // A sibling whose name merely starts the same is not "inside".
  assert.strictEqual(relocate.inspect([move(d, 'quake', path.join(d, 'apps', 'quake2'))])[0].action, 'move');
});

test('another drive: copied, checked, and the original deleted only on commit', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  let linked = true;
  try { fs.symlinkSync('app.exe', path.join(d, 'apps', 'quake', 'run')); } catch { linked = false; } // a link must arrive as a link
  const to = path.join(d, 'other-drive', 'quake');
  const job = await relocate.run([move(d, 'quake', to)], { rename: otherDrive });
  assert.strictEqual(job.moved[0].copied, true);
  assert.strictEqual(fs.readFileSync(path.join(to, 'data', 'deep', 'x.bin'), 'utf8'), 'x');
  if (linked) assert.strictEqual(fs.readlinkSync(path.join(to, 'run')), 'app.exe');
  assert.strictEqual(fs.existsSync(path.join(d, 'apps', 'quake', 'app.exe')), true, 'the original is untouched until the config is saved');
  assert.deepStrictEqual(job.commit(), []);
  assert.strictEqual(fs.existsSync(path.join(d, 'apps', 'quake')), false);
  assert.strictEqual(fs.readFileSync(path.join(to, 'app.exe'), 'utf8'), 'program');
});

test('another drive, undone: the copy is deleted and the original was never touched', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  const job = await relocate.run([move(d, 'quake', path.join(d, 'other-drive', 'quake'))], { rename: otherDrive });
  assert.deepStrictEqual(job.undo(), []);
  assert.deepStrictEqual(read(path.join(d, 'apps', 'quake')), FILES);
  assert.strictEqual(fs.existsSync(path.join(d, 'other-drive')), false);
});

test('another drive is still all or nothing: a copy that fails puts back what was moved before it', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'one'), { 'one.txt': '1' });
  put(path.join(d, 'apps', 'two'), FILES);
  const copyTree = async (src, dest) => {
    if (path.basename(src) === 'two') {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'app.exe'), 'half'); // died part way through
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return fsCopy(src, dest);
  };
  const moves = [move(d, 'one', path.join(d, 'far', 'one')), move(d, 'two', path.join(d, 'far', 'two'))];
  await assert.rejects(relocate.run(moves, { rename: otherDrive, copyTree }), says(/^two was not moved: there is not enough free space for it at .*two\. Nothing was changed\.$/));
  assert.deepStrictEqual(read(path.join(d, 'apps', 'one')), { 'one.txt': '1' });
  assert.deepStrictEqual(read(path.join(d, 'apps', 'two')), FILES);
  assert.strictEqual(fs.existsSync(path.join(d, 'far')), false, 'the finished copy and the half copy are both gone');
});

test('another drive: a copy that is not the original is refused, and the original stays', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  const to = path.join(d, 'far', 'quake');
  const faulty = [
    [async (src, dest) => { await fsCopy(src, dest); fs.rmSync(path.join(dest, 'data', 'deep', 'x.bin')); }, /the copy has 2 files and the original has 3/],
    [async (src, dest) => { await fsCopy(src, dest); fs.writeFileSync(path.join(dest, 'app.exe'), 'prog'); }, /app\.exe is a different size in the copy/],
    [async (src, dest) => { await fsCopy(src, dest); fs.renameSync(path.join(dest, 'app.exe'), path.join(dest, 'app2.exe')); }, /the copy is missing app\.exe/],
  ];
  for (const [copyTree, why] of faulty) {
    await assert.rejects(relocate.run([move(d, 'quake', to)], { rename: otherDrive, copyTree }), (e) => {
      assert.match(e.message, /^quake was not moved: copying it to .* did not work/);
      assert.match(e.message, why);
      assert.match(e.message, /Nothing was changed\.$/);
      return true;
    });
    assert.deepStrictEqual(read(path.join(d, 'apps', 'quake')), FILES);
    assert.strictEqual(fs.existsSync(to), false);
  }
});

test('macOS bundles: a signature that was valid before the copy must be valid after it', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'Thing'), { 'Thing.app/Contents/MacOS/Thing': 'binary', 'Thing.app/Contents/Info.plist': '<plist/>' });
  const to = path.join(d, 'far', 'Thing');
  const checked = [];
  // Valid where it is, broken where it lands: the move is refused and nothing is left behind.
  const broke = async (dir) => { checked.push(path.basename(path.dirname(dir)) + '/' + path.basename(dir)); return dir === to ? { valid: false, reason: 'a sealed resource is missing or invalid' } : { valid: true }; };
  await assert.rejects(
    relocate.run([move(d, 'Thing', to)], { rename: otherDrive, copyTree: fsCopy, verifyPayload: broke }),
    says(/^Thing was not moved: copying it to .* did not work \(the copied app no longer passes its signature check: a sealed resource is missing or invalid\)\. Nothing was changed\.$/)
  );
  assert.deepStrictEqual(checked, ['apps/Thing', 'far/Thing']);
  assert.strictEqual(fs.existsSync(to), false);
  assert.strictEqual(fs.existsSync(path.join(d, 'apps', 'Thing', 'Thing.app', 'Contents', 'Info.plist')), true);
  // An app that never verified (unsigned, ad-hoc) is not held to it: only valid-then-invalid is damage.
  const unsigned = async () => ({ valid: false, reason: 'code object is not signed at all' });
  const job = await relocate.run([move(d, 'Thing', to)], { rename: otherDrive, copyTree: fsCopy, verifyPayload: unsigned });
  assert.strictEqual(job.moved.length, 1);
  // A plain rename on the same drive changes nothing inside the bundle and is not checked.
  job.undo();
  let asked = 0;
  await relocate.run([move(d, 'Thing', to)], { verifyPayload: async () => { asked++; return { valid: true }; } });
  assert.strictEqual(asked, 0);
});

test('this machine\'s own copy tool keeps a folder intact across "drives"', async () => {
  // The real platform.copyTree (ditto on macOS, Node's copy elsewhere), with only the rename
  // made to fail the way it does between drives.
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  if (process.platform !== 'win32') fs.chmodSync(path.join(d, 'apps', 'quake', 'app.exe'), 0o755);
  const to = path.join(d, 'far', 'quake');
  const job = await relocate.run([move(d, 'quake', to)], { rename: otherDrive });
  job.commit();
  assert.deepStrictEqual(read(to), FILES);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(to, 'app.exe')).mode & 0o777, 0o755, 'the program is still executable');
  assert.strictEqual(fs.existsSync(path.join(d, 'apps', 'quake')), false);
});

test('when a folder cannot be put back, the message says where it is instead of "nothing was changed"', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'one'), { 'one.txt': '1' });
  put(path.join(d, 'apps', 'two'), { 'two.txt': '2' });
  const rename = (from, to) => {
    if (path.basename(from) === 'two') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    if (to.includes(`${path.sep}apps${path.sep}`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); // the way back is shut
    fs.renameSync(from, to);
  };
  const moves = [move(d, 'one', path.join(d, 'games', 'one')), move(d, 'two', path.join(d, 'games', 'two'))];
  await assert.rejects(relocate.run(moves, { rename }), (e) => {
    assert.match(e.message, /^two was not moved: its files are in use/);
    assert.match(e.message, /one had already been moved and could not be put back: it is now in .*games.one, but your settings still say .*apps.one\. Move it back by hand\.$/);
    assert.doesNotMatch(e.message, /Nothing was changed/);
    return true;
  });
  assert.deepStrictEqual(read(path.join(d, 'games', 'one')), { 'one.txt': '1' }, 'and it really is there');
});

test('commit reports an original it could not delete, and what it leaves behind is named', async () => {
  const d = tmp();
  put(path.join(d, 'apps', 'quake'), FILES);
  const to = path.join(d, 'far', 'quake');
  const job = await relocate.run([move(d, 'quake', to)], { rename: otherDrive, copyTree: fsCopy });
  const real = fs.rmSync;
  fs.rmSync = (p, o) => { if (p === path.join(d, 'apps', 'quake')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return real(p, o); };
  let notes;
  try { notes = job.commit(); } finally { fs.rmSync = real; }
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /^quake is now in .*far.quake, but the old copy in .*apps.quake could not be deleted \(EBUSY\)\. Delete it by hand\.$/);
  assert.deepStrictEqual(read(to), FILES);
});

test('an app left parked by an interrupted update is still the app, and moves', async () => {
  const d = tmp();
  // What installPortable leaves if it dies between parking the old version and moving the new one in.
  put(path.join(d, 'apps', 'quake' + install.OLD_SUFFIX), FILES);
  const to = path.join(d, 'games', 'quake');
  const seen = relocate.inspect([move(d, 'quake', to)]);
  assert.strictEqual(seen[0].action, 'move');
  const job = await relocate.run(seen);
  job.commit();
  assert.deepStrictEqual(read(to), FILES);
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'apps')), []);
});

test('after a move the next update lands in the new place and prunes by the same manifest', async () => {
  // state.json records an app's files relative to its folder and no folder at all, so a move
  // changes nothing in it. This is the proof: install v1, move the folder, install v2 into
  // the new place with the manifest recorded for v1.
  const d = tmp();
  const zip = (name, files) => { const z = new AdmZip(); for (const [rel, body] of Object.entries(files)) z.addFile(rel, Buffer.from(body)); const f = path.join(d, name); z.writeZip(f); return f; };
  const from = path.join(d, 'apps', 'tool');
  const to = path.join(d, 'games', 'tool');
  const v1 = await install.installPortable(zip('v1.zip', { 'tool.exe': 'v1', 'old-only.dll': 'gone in v2', 'docs/readme.txt': 'r1' }), { dir: from }, undefined);
  fs.writeFileSync(path.join(from, 'settings.ini'), 'mine'); // made by the app while it ran
  const job = await relocate.run([{ key: 'acme/tool#portable', name: 'tool', from, to }]);
  job.commit();
  const v2 = await install.installPortable(zip('v2.zip', { 'tool.exe': 'v2', 'docs/readme.txt': 'r2', 'new.dll': 'n' }), { dir: to }, v1);
  assert.deepStrictEqual(read(to), { 'docs/readme.txt': 'r2', 'new.dll': 'n', 'settings.ini': 'mine', 'tool.exe': 'v2' }, 'the stale file is pruned, the user\'s file is carried over');
  assert.deepStrictEqual(v2.map((f) => f.split(path.sep).join('/')).sort(), ['docs/readme.txt', 'new.dll', 'tool.exe']);
  assert.strictEqual(fs.existsSync(from), false, 'nothing is installed back into the old place');
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'games')), ['tool'], 'and no staging or parked folder is left beside the new one');
});
