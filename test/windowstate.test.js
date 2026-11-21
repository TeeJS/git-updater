'use strict';

// The main window remembers its size, position and maximized state (src/windowstate.js).
// Everything here runs without Electron: saved states are plain objects, displays are plain
// work-area rectangles, and track() is driven with a fake window that emits the same events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ws = require('../src/windowstate');

const LAPTOP = { x: 0, y: 25, width: 1440, height: 875 }; // a work area below a menu bar
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 }; // a second monitor to the left
const LIMITS = { minWidth: 720, minHeight: 480, primary: LAPTOP };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'git-updater-winstate-')), 'sub', ws.FILE_NAME);
}

// What track() uses of a BrowserWindow. `round` stands in for the OS reporting bounds that are
// not quite the ones it was given.
function fakeWindow(bounds, o = {}) {
  const w = new EventEmitter();
  Object.assign(w, {
    normal: { x: 100, y: 100, ...bounds },
    maximized: false,
    minimized: false,
    visible: true,
    destroyed: false,
    getNormalBounds: () => (o.round ? o.round(w.normal) : { ...w.normal }),
    getBounds: () => (w.maximized ? { ...LAPTOP } : w.getNormalBounds()),
    isMaximized: () => w.maximized,
    isMinimized: () => w.minimized,
    isVisible: () => w.visible,
    isDestroyed: () => w.destroyed,
  });
  return w;
}

// --- reading a saved state ------------------------------------------------------

test('a saved state is read back as whole numbers, with a position only when both halves are there', () => {
  assert.deepEqual(ws.normalize({ x: 10, y: 20, width: 900, height: 700, maximized: true }), { width: 900, height: 700, maximized: true, x: 10, y: 20 });
  assert.deepEqual(ws.normalize({ x: 10.4, y: -0.2, width: 900.6, height: 700 }), { width: 901, height: 700, maximized: false, x: 10, y: 0 });
  assert.deepEqual(ws.normalize({ x: 10, width: 900, height: 700 }), { width: 900, height: 700, maximized: false }, 'half a position is no position');
  assert.deepEqual(ws.normalize({ x: '10', y: null, width: 900, height: 700, maximized: 'yes' }), { width: 900, height: 700, maximized: false });
});

test('anything that is not a usable size is no saved state at all', () => {
  for (const bad of [null, undefined, 7, 'x', [], [900, 700], {}, { width: 900 }, { width: 0, height: 700 }, { width: -900, height: 700 },
    { width: '900', height: '700' }, { width: NaN, height: 700 }, { width: Infinity, height: 700 }]) {
    assert.equal(ws.normalize(bad), null, JSON.stringify(bad));
  }
});

test('a missing, corrupt or unreadable file means default size, and never throws', () => {
  const file = tmpFile();
  assert.equal(ws.read(file), null, 'no file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"x":10,"y":20,"width":900,"hei'); // cut off mid-write
  assert.equal(ws.read(file), null, 'half a file');
  fs.writeFileSync(file, '');
  assert.equal(ws.read(file), null, 'an empty file');
  fs.writeFileSync(file, 'null');
  assert.equal(ws.read(file), null);
  fs.rmSync(file);
  fs.mkdirSync(file); // a folder where the file should be
  assert.equal(ws.read(file), null, 'unreadable');
  assert.equal(ws.fit(ws.read(file), [LAPTOP], LIMITS), null, 'and the window is then opened at its default size');
});

test('write then read round-trips, and creates the folder', () => {
  const file = tmpFile();
  ws.write(file, JSON.stringify({ x: 5, y: 30, width: 800, height: 600, maximized: false }));
  assert.deepEqual(ws.read(file), { width: 800, height: 600, maximized: false, x: 5, y: 30 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [ws.FILE_NAME], 'no temp file left behind');
});

// --- fitting it to the displays that are connected now ---------------------------

test('a state that is still on a display comes back exactly as it was saved', () => {
  const s = { x: 200, y: 120, width: 1000, height: 700, maximized: false };
  assert.deepEqual(ws.fit(s, [LAPTOP], LIMITS), { bounds: { width: 1000, height: 700, x: 200, y: 120 }, maximized: false });
  // On a second monitor, whose coordinates are negative.
  const onLeft = { x: -1800, y: 40, width: 1000, height: 700, maximized: true };
  assert.deepEqual(ws.fit(onLeft, [LAPTOP, LEFT], LIMITS), { bounds: { width: 1000, height: 700, x: -1800, y: 40 }, maximized: true });
  // Hanging off the right edge is where the user left it: the title bar can still be reached.
  const offEdge = { x: 1000, y: 300, width: 900, height: 700 };
  assert.deepEqual(ws.fit(offEdge, [LAPTOP], LIMITS).bounds, { width: 900, height: 700, x: 1000, y: 300 });
});

test('a position on a monitor that is no longer connected is not used; the size is kept', () => {
  const onLeft = { x: -1800, y: 40, width: 1000, height: 700, maximized: false };
  assert.deepEqual(ws.fit(onLeft, [LAPTOP], LIMITS), { bounds: { width: 1000, height: 700 }, maximized: false });
  // Maximized on the missing monitor: it opens maximized on a display that exists.
  assert.deepEqual(ws.fit({ ...onLeft, maximized: true }, [LAPTOP], LIMITS), { bounds: { width: 1000, height: 700 }, maximized: true });
});

test('a position the window could not be dragged back from is not used', () => {
  const size = { width: 1000, height: 700 };
  const placed = (x, y) => 'x' in ws.fit({ x, y, ...size }, [LAPTOP], LIMITS).bounds;
  assert.equal(placed(5000, 5000), false, 'far off every display');
  assert.equal(placed(1430, 100), false, 'only a sliver left at the right edge');
  assert.equal(placed(-990, 100), false, 'only a sliver left at the left edge');
  assert.equal(placed(200, -200), false, 'title bar above the top of the display');
  assert.equal(placed(200, 890), false, 'title bar below the bottom of the work area');
  assert.equal(placed(1390, 100), true, 'enough of the title bar to grab');
  assert.equal(placed(200, 20), true, 'a few pixels above the work area is still reachable');
});

test('a window that no longer fits is shrunk to the work area and pulled inside it', () => {
  // Saved on a big monitor, opened after the resolution dropped.
  const big = { x: 600, y: 300, width: 1800, height: 1200, maximized: false };
  assert.deepEqual(ws.fit(big, [LAPTOP], LIMITS).bounds, { width: 1440, height: 875, x: 0, y: 25 });
  // Too tall only: the width and the x it was left at are kept.
  const tall = { x: 300, y: 100, width: 900, height: 1200 };
  assert.deepEqual(ws.fit(tall, [LAPTOP], LIMITS).bounds, { width: 900, height: 875, x: 300, y: 25 });
  // Off every display AND too big for the primary one: no position, size capped.
  const gone = { x: -1900, y: 0, width: 1900, height: 1000 };
  assert.deepEqual(ws.fit(gone, [LAPTOP], LIMITS).bounds, { width: 1440, height: 875 });
});

test('never smaller than the minimum size', () => {
  const tiny = { x: 200, y: 120, width: 300, height: 200 };
  assert.deepEqual(ws.fit(tiny, [LAPTOP], LIMITS).bounds, { width: 720, height: 480, x: 200, y: 120 });
  // A work area smaller than the minimum: the minimum wins, as it does on a first run.
  const small = { x: 0, y: 0, width: 640, height: 400 };
  assert.deepEqual(ws.fit({ width: 900, height: 700 }, [small], { ...LIMITS, primary: small }).bounds, { width: 720, height: 480 });
});

test('with two displays the one holding most of the window decides the fit', () => {
  // Straddling the join, mostly on the left monitor.
  const s = { x: -1500, y: 60, width: 1900, height: 1030 };
  assert.deepEqual(ws.fit(s, [LAPTOP, LEFT], LIMITS).bounds, { width: 1900, height: 1030, x: -1500, y: 60 });
  // Mostly on the laptop, and taller than it: fitted to the laptop.
  const t = { x: -200, y: 60, width: 1400, height: 1030 };
  assert.deepEqual(ws.fit(t, [LAPTOP, LEFT], LIMITS).bounds, { width: 1400, height: 875, x: 0, y: 25 });
});

test('fit copes with no saved state, no position, and a display list that is missing or wrong', () => {
  assert.equal(ws.fit(null, [LAPTOP], LIMITS), null);
  assert.deepEqual(ws.fit({ width: 900, height: 700, maximized: true }, [LAPTOP], LIMITS), { bounds: { width: 900, height: 700 }, maximized: true });
  const s = { x: 200, y: 120, width: 900, height: 700 };
  assert.deepEqual(ws.fit(s, undefined, {}), { bounds: { width: 900, height: 700 }, maximized: false });
  assert.deepEqual(ws.fit(s, [null, { x: 0, y: 0, width: 0, height: 0 }, {}], { minWidth: 720, minHeight: 480 }).bounds, { width: 900, height: 700 });
});

// --- what gets written -----------------------------------------------------------

test('settle: an untouched window is saved as what it was asked for, not what the OS rounded it to', () => {
  const asked = { x: 200, y: 120, width: 1000, height: 700 };
  const opened = { x: 200, y: 120, width: 1002, height: 701 }; // 150% scaling
  assert.deepEqual(ws.settle(opened, opened, asked), asked);
  assert.deepEqual(ws.settle({ ...opened, width: 1003 }, opened, asked), asked, 'a pixel of jitter after a maximize and back is still untouched');
});

test('settle: a real resize or move is saved as the window reports it', () => {
  const asked = { x: 200, y: 120, width: 1000, height: 700 };
  const opened = { x: 200, y: 120, width: 1002, height: 701 };
  // Resized from the right edge: new size, and the position (which did not change) stays as asked.
  assert.deepEqual(ws.settle({ x: 200, y: 120, width: 1200, height: 701 }, opened, asked), { x: 200, y: 120, width: 1200, height: 701 });
  // Dragged somewhere else without resizing: new position, and the size does not pick up the rounding.
  assert.deepEqual(ws.settle({ x: 640, y: 300, width: 1002, height: 701 }, opened, asked), { x: 640, y: 300, width: 1000, height: 700 });
  // Resized from the top-left corner: everything is new.
  const corner = { x: 150, y: 90, width: 1052, height: 731 };
  assert.deepEqual(ws.settle(corner, opened, asked), corner);
});

test('settle: a window opened without a position (first run, or its monitor is gone) saves the position it has', () => {
  const asked = { width: 920, height: 875 };
  const opened = { x: 260, y: 25, width: 921, height: 876 };
  assert.deepEqual(ws.settle(opened, opened, asked), { x: 260, y: 25, width: 920, height: 875 });
});

test('no creep: twenty runs at fractional scaling, never touched, and the saved state does not change', () => {
  const file = tmpFile();
  ws.write(file, JSON.stringify({ x: 201, y: 121, width: 1001, height: 701, maximized: false }));
  const before = fs.readFileSync(file, 'utf8');
  // The OS hands back bounds a little larger and a little lower-right than it was asked for.
  const round = (b) => ({ x: b.x + 1, y: b.y + 1, width: b.width + 2, height: b.height + 3 });
  for (let run = 0; run < 20; run++) {
    const saved = ws.fit(ws.read(file), [LAPTOP], LIMITS);
    const w = fakeWindow(saved.bounds, { round });
    ws.track(w, { file, asked: saved.bounds });
    w.emit('close');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // The same loop writing what the window reports is the bug: it grows on every run.
  let b = { x: 201, y: 121, width: 1001, height: 701 };
  for (let run = 0; run < 20; run++) b = round(b);
  assert.deepEqual(b, { x: 221, y: 141, width: 1041, height: 761 });
});

test('no creep on a first run either: the default size is what is saved', () => {
  const file = tmpFile();
  const round = (b) => ({ ...b, width: b.width + 2, height: b.height + 3 });
  const first = { width: 920, height: 875 };
  const w = fakeWindow(first, { round });
  ws.track(w, { file, asked: first });
  w.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 100, y: 100, width: 920, height: 875, maximized: false });
});

// --- following the window --------------------------------------------------------

test('moves and resizes are written once, a moment after they stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = tmpFile();
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  for (let i = 1; i <= 50; i++) {
    w.normal = { x: 100 + i * 10, y: 100, width: 900, height: 700 };
    w.emit('move');
    t.mock.timers.tick(20);
  }
  assert.equal(fs.existsSync(file), false, 'nothing written while it is still being dragged');
  t.mock.timers.tick(ws.SAVE_DELAY_MS);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 600, y: 100, width: 900, height: 700, maximized: false });
});

test('closing writes at once, without waiting for the delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = tmpFile();
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  w.normal = { x: 100, y: 100, width: 1100, height: 800 };
  w.emit('resize');
  w.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 100, y: 100, width: 1100, height: 800, maximized: false });
  // The window is gone by the time the pending timer would have fired.
  w.destroyed = true;
  w.emit('closed');
  t.mock.timers.tick(ws.SAVE_DELAY_MS * 2);
});

test('hide to the tray, then Quit from the tray: saved at the hide, and the hidden window changes nothing', () => {
  const file = tmpFile();
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  // main.js registers its own close handler after track(), and that one hides the window.
  w.on('close', () => { w.visible = false; });
  w.normal = { x: 300, y: 200, width: 1100, height: 800 };
  w.emit('close'); // the user closes the window; it hides
  const atHide = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(atHide), { x: 300, y: 200, width: 1100, height: 800, maximized: false });
  // Quit from the tray closes the hidden window. Whatever a hidden window reports is not trusted.
  w.normal = { x: -32000, y: -32000, width: 160, height: 28 };
  w.emit('close');
  assert.equal(fs.readFileSync(file, 'utf8'), atHide);
});

test('a maximized window saves the size to come back to, and that it was maximized', () => {
  const file = tmpFile();
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  w.maximized = true; // getNormalBounds still reports the un-maximized bounds
  w.emit('maximize');
  w.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 100, y: 100, width: 900, height: 700, maximized: true });
  w.maximized = false;
  w.emit('unmaximize');
  w.emit('close');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).maximized, false);
});

test('a maximized window that has forgotten its earlier size does not overwrite it with the screen', () => {
  // macOS, Electron 44, for real: maximize, minimize, restore. From then on getNormalBounds
  // answers with the maximized bounds, and quitting saved the whole screen as the normal size.
  const file = tmpFile();
  const asked = { x: 300, y: 200, width: 1100, height: 720 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  w.normal = { x: 340, y: 220, width: 1000, height: 700 }; // the user's own size, then maximize
  w.emit('resize');
  w.maximized = true;
  w.emit('maximize');
  w.emit('close');
  const good = { x: 340, y: 220, width: 1000, height: 700, maximized: true };
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), good);
  w.minimized = true;
  w.emit('close'); // nothing is taken from a minimized window
  w.minimized = false;
  w.normal = { ...LAPTOP }; // restored: "normal" is now the maximized frame
  w.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), good);
  // Un-maximized, the window is believed again.
  w.maximized = false;
  w.normal = { x: 360, y: 240, width: 1000, height: 700 };
  w.emit('unmaximize');
  w.emit('close');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 360, y: 240, width: 1000, height: 700, maximized: false });
});

test('a minimized window keeps what was saved: it cannot say whether it was maximized', () => {
  const file = tmpFile();
  ws.write(file, JSON.stringify({ x: 100, y: 100, width: 900, height: 700, maximized: true }));
  const before = fs.readFileSync(file, 'utf8');
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  w.minimized = true;
  w.emit('close');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('an unchanged window is not written again on every close', () => {
  const file = tmpFile();
  ws.write(file, JSON.stringify({ x: 100, y: 100, width: 900, height: 700, maximized: false }));
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked });
  fs.rmSync(file); // a write would bring it back
  w.emit('close');
  w.emit('session-end');
  assert.equal(fs.existsSync(file), false);
});

test('a state that cannot be written is logged once and never throws into the app', () => {
  const file = tmpFile();
  fs.mkdirSync(file, { recursive: true }); // a folder where the file should be: the rename fails
  const logs = [];
  const asked = { x: 100, y: 100, width: 900, height: 700 };
  const w = fakeWindow(asked);
  ws.track(w, { file, asked, log: (m) => logs.push(m) });
  assert.doesNotThrow(() => { w.emit('close'); w.emit('close'); w.emit('session-end'); });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /window size and position not saved/);
  // A window that throws when asked (it was destroyed underneath us) is caught the same way.
  const broken = fakeWindow(asked);
  ws.track(broken, { file: tmpFile(), asked });
  broken.getNormalBounds = () => { throw new Error('Object has been destroyed'); };
  assert.doesNotThrow(() => broken.emit('close'));
});

// --- the wiring in electron/main.js ----------------------------------------------

test('main.js keeps the state next to config.json, through the paths helper, and only for the main window', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /const WINDOW_STATE_PATH = path\.join\(DATA_DIR, windowstate\.FILE_NAME\);/);
  assert.equal(ws.FILE_NAME, 'window-state.json');
  assert.equal(main.match(/windowstate\.track\(/g).length, 1, 'tracked once: the main window, not Add an app, Popular apps or Scan');
  // track() must be registered before the close handler that hides the window (see the tray test above).
  assert.ok(main.indexOf('windowstate.track(win') < main.indexOf("win.on('close'"), 'the state is written before the window is hidden');
});
