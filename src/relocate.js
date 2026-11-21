'use strict';

// IO edge: move portable app folders when the place they belong changes — an app put in
// another category, a category given another folder, an app given a folder of its own
// (core.planRelocations says which). Called from one place, "Categories and app folders"
// in electron/main.js, which saves config.json only after every folder has arrived.
//
// The rules, all of them there so config.json can never point where an app is not:
//
//   All or nothing.  If one folder cannot move, every folder already moved is put back,
//                    and the caller does not save. undo() does the putting back.
//   Never overwrite. A new place that already has anything in it refuses the move. An
//                    empty folder is fine (the folder picker's "New Folder" makes one).
//   Other drives.    A rename cannot cross to another drive (EXDEV). The folder is copied,
//                    the copy is checked file by file against the original, and the
//                    original is deleted only in commit(), after config.json is saved.
//                    Until then undoing is just deleting the copy.
//   macOS bundles.   The copy is made with the tool the Mac extraction uses (ditto, see
//                    platform.copyTree), and a bundle whose signature was valid before must
//                    still be valid after, the same differential check as installPortable.
//
// state.json needs no change after a move: an app's record holds its files as paths
// relative to its folder (the manifest swapDir prunes by) and no folder at all. The folder
// is always worked out from config.json, so the next update lands in the new place and
// compares against the same manifest.

const fs = require('fs');
const path = require('path');
const install = require('./install');
const platform = require('./platform');
const { log } = require('./log');

// What went wrong, already in words for the user. The window shows the message as it is.
const refuse = (message) => Object.assign(new Error(message), { refused: true });
const NOTHING = 'Nothing was changed.';

function hasFiles(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// One folder reached by two spellings: letter case on Windows and macOS, or a link. Then
// there is nothing to move, and treating it as a move would refuse it as "already exists".
function sameFolder(a, b) {
  try {
    if (fs.realpathSync.native(a) === fs.realpathSync.native(b)) return true;
    const x = fs.statSync(a), y = fs.statSync(b);
    return !!x.ino && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}
const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
const inside = (child, parent) => fold(child).startsWith(fold(parent) + path.sep);

// What each planned move would really do on this disk. Nothing is touched.
//   moves: [{ key, name, from, to }]  (from/to as config.json spells them)
//   -> the same, each with fromPath/toPath (absolute) and action:
//        'move'  the folder is there and its new place is free
//        'none'  nothing to move: the app is not installed yet, or it is already there
// Throws (refused) for a new place that cannot be used, naming the app and why.
function inspect(moves) {
  return (moves || []).map((m) => {
    const fromPath = path.resolve(String(m.from));
    const toPath = path.resolve(String(m.to));
    const out = { ...m, fromPath, toPath, action: 'none' };
    // An update that died between parking the old version and moving the new one in leaves
    // the app in "<folder>.git-updater-old" (see installPortable's crash recovery). That is
    // still the app, and it moves too.
    const parked = !exists(fromPath) && hasFiles(fromPath + install.OLD_SUFFIX);
    if (!hasFiles(fromPath) && !parked) return out;
    if (sameFolder(fromPath, toPath)) return out;
    if (inside(toPath, fromPath)) throw refuse(`${m.name} was not moved: ${m.to} is inside the folder it is in now. ${NOTHING}`);
    if (exists(toPath)) {
      let empty = false;
      try {
        empty = fs.statSync(toPath).isDirectory() && fs.readdirSync(toPath).length === 0;
      } catch {}
      if (!empty) throw refuse(`${m.name} was not moved: ${m.to} already exists and is not empty. ${NOTHING}`);
    }
    return { ...out, action: 'move', parked };
  });
}

// The copy must be the original: the same files, each the same size, links still links to
// the same place. Throws with what differs.
function sameTree(a, b) {
  const list = (root) => install.walk(root).map((f) => f.split(path.sep).join('/')).sort();
  const fa = list(a);
  const fb = list(b);
  if (fa.length !== fb.length) throw new Error(`the copy has ${fb.length} files and the original has ${fa.length}`);
  for (let i = 0; i < fa.length; i++) {
    if (fa[i] !== fb[i]) throw new Error(`the copy is missing ${fa[i]}`);
    const sa = fs.lstatSync(path.join(a, fa[i]));
    const sb = fs.lstatSync(path.join(b, fa[i]));
    if (sa.isSymbolicLink() !== sb.isSymbolicLink()) throw new Error(`${fa[i]} was not copied as it is`);
    if (sa.isSymbolicLink()) {
      if (fs.readlinkSync(path.join(a, fa[i])) !== fs.readlinkSync(path.join(b, fa[i]))) throw new Error(`the link ${fa[i]} points somewhere else in the copy`);
    } else if (sa.size !== sb.size) throw new Error(`${fa[i]} is a different size in the copy`);
  }
}

// Why one move failed, in plain words. `step` is what was being done when it did.
function reason(m, step, e) {
  const code = e && e.code;
  if (step === 'place') {
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `git-updater is not allowed to write to ${path.dirname(m.to)}`;
    return `the folder ${path.dirname(m.to)} could not be made ready (${e.message})`;
  }
  if (step === 'copy') {
    if (code === 'ENOSPC') return `there is not enough free space for it at ${m.to}`;
    return `copying it to ${m.to} did not work (${e.message})`;
  }
  // The rename. On Windows a folder with a file open cannot be renamed, and that nearly
  // always means the app (or a window showing its folder) is open.
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return 'its files are in use or cannot be moved. If it is running, close it, then try again';
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return `${m.to} already exists and is not empty`;
  return e && e.message ? e.message : String(e);
}

// Carry the moves out. opts (all optional, for tests): rename, copyTree, verifyPayload.
//   -> { moved: [{ key, name, from, to, copied }], undo(), commit() }
//   undo()    puts every moved folder back. -> the ones that could not be put back.
//   commit()  call after config.json is saved: deletes the originals of folders that were
//             copied to another drive. -> notes about anything that could not be deleted.
// Throws (refused) on the first move that fails, after undoing the ones before it.
async function run(moves, opts = {}) {
  const rename = opts.rename || install.renameWithRetry;
  const copyTree = opts.copyTree || platform.copyTree;
  const verifyPayload = opts.verifyPayload || platform.verifyPayload;
  const todo = inspect(moves).filter((m) => m.action === 'move');
  const done = [];
  const made = []; // folders created to hold a moved app; removed again on undo if still empty

  const undo = () => {
    const stuck = [];
    for (const m of done.slice().reverse()) {
      if (m.copied) {
        // The original was never touched, so the app is where config.json says either way.
        // A copy that cannot be deleted is only clutter, and is logged as that.
        try {
          fs.rmSync(m.toPath, { recursive: true, force: true });
        } catch (e) {
          log(`move undo: the unused copy of ${m.name} in ${m.toPath} could not be deleted: ${e.message}`);
          continue;
        }
      } else {
        try {
          rename(m.toPath, m.fromPath);
        } catch (e) {
          stuck.push(m);
          log(`move undo FAILED: ${m.name} is in ${m.toPath}, not ${m.fromPath}: ${e.message}`);
          continue;
        }
      }
      if (m.hadEmpty) try { fs.mkdirSync(m.toPath); } catch {} // the empty folder that was there before
      log(`move undone: ${m.name} is back in ${m.fromPath}`);
    }
    done.length = 0;
    // Deepest first, and rmdir only: a folder something else has started using is left alone.
    for (const dir of made.sort((a, b) => b.length - a.length)) {
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
    made.length = 0;
    return stuck;
  };

  for (const m of todo) {
    let step = 'place';
    try {
      // Finish the interrupted update first, exactly as the next install would have.
      if (m.parked) fs.renameSync(m.fromPath + install.OLD_SUFFIX, m.fromPath);
      const first = fs.mkdirSync(path.dirname(m.toPath), { recursive: true });
      // Every folder that call created, so an undone move leaves no empty folders behind.
      if (first) {
        const top = path.resolve(first);
        for (let d = path.dirname(m.toPath); fold(d) === fold(top) || inside(d, top); d = path.dirname(d)) made.push(d);
      }
      if (exists(m.toPath)) {
        fs.rmdirSync(m.toPath); // empty (inspect checked); it would block the rename on Windows
        m.hadEmpty = true;
      }
      step = 'rename';
      try {
        rename(m.fromPath, m.toPath);
        m.copied = false;
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // Another drive. Copy now; the original stays until commit().
        step = 'copy';
        const before = await verifyPayload(m.fromPath);
        try {
          await copyTree(m.fromPath, m.toPath);
          sameTree(m.fromPath, m.toPath);
          if (before && before.valid) {
            const after = await verifyPayload(m.toPath);
            if (after && !after.valid) throw new Error(`the copied app no longer passes its signature check: ${after.reason}`);
          }
        } catch (ce) {
          fs.rmSync(m.toPath, { recursive: true, force: true });
          if (m.hadEmpty) try { fs.mkdirSync(m.toPath); } catch {}
          throw ce;
        }
        m.copied = true;
      }
      done.push(m);
      log(`moved ${m.name}: ${m.fromPath} -> ${m.toPath}${m.copied ? ' (copied to another drive)' : ''}`);
    } catch (e) {
      const why = reason(m, step, e);
      log(`move FAILED for ${m.name} (${m.fromPath} -> ${m.toPath}): ${e.message}`);
      const stuck = undo();
      if (!stuck.length) throw refuse(`${m.name} was not moved: ${why}. ${NOTHING}`);
      // The one case where "nothing was changed" would be a lie, so it is not said.
      throw refuse(
        `${m.name} was not moved: ${why}. ${stuck.map((s) => `${s.name} had already been moved and could not be put back: it is now in ${s.to}, but your settings still say ${s.from}.`).join(' ')} Move ${stuck.length === 1 ? 'it' : 'them'} back by hand.`
      );
    }
  }

  return {
    moved: done.map(({ key, name, from, to, copied }) => ({ key, name, from, to, copied: !!copied })),
    undo,
    commit() {
      const notes = [];
      for (const m of done) {
        // What an interrupted update left parked beside the old folder is disposable (the
        // next install would have deleted it), and nothing would ever look there again.
        try { fs.rmSync(m.fromPath + install.OLD_SUFFIX, { recursive: true, force: true }); } catch {}
        if (!m.copied) continue;
        try {
          fs.rmSync(m.fromPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        } catch (e) {
          notes.push(`${m.name} is now in ${m.to}, but the old copy in ${m.from} could not be deleted (${e.code || e.message}). Delete it by hand.`);
          log(`move: old copy of ${m.name} left in ${m.fromPath}: ${e.message}`);
        }
      }
      return notes;
    },
  };
}

module.exports = { inspect, run, sameTree, sameFolder, NOTHING };
