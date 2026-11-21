'use strict';

// The main window's size, position and maximized state, remembered between runs.
//
// It is kept in its own small file, <config dir>/window-state.json, and not in config.json:
// config.json writes a .bak on every save and would collect one per resize.
//
// This file has no Electron import. Reading, checking and fitting a saved state are pure, and
// track() takes the BrowserWindow as an argument, so test/windowstate.test.js drives all of it
// with plain objects and a fake window. Nothing here throws into the app: a missing, unreadable
// or corrupt file is the same as no file, and the window opens at its default size.
//
// Ported from PlayingKarrde/git-updater (MIT), commit ee988da.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'window-state.json';

// How much of the window must still be on a display for its saved position to be used: this
// much of its top edge inside the work area sideways, and the top edge itself no higher than
// TOP_SLACK above it and at least GRAB above its bottom. That is the title bar, the part you
// need to be able to reach to drag the window back.
const GRAB = 40;
const TOP_SLACK = 10;

// See settle(). Bounds within this many pixels of what the window opened with count as untouched.
const CREEP_TOLERANCE = 8;

const SAVE_DELAY_MS = 500;

const SIDES = ['x', 'y', 'width', 'height'];

const isRect = (r) => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

// Whatever was in the file -> { width, height, maximized } plus { x, y } when both are usable,
// or null. Hand-edited and half-written files end up here, so nothing is taken on trust.
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) + 0 : null); // + 0: no -0
  const width = int(raw.width);
  const height = int(raw.height);
  if (!(width > 0 && height > 0)) return null;
  const out = { width, height, maximized: raw.maximized === true };
  const x = int(raw.x);
  const y = int(raw.y);
  if (x != null && y != null) {
    out.x = x;
    out.y = y;
  }
  return out;
}

function read(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// Through a temp file and a rename, so a crash mid-write leaves the old state and not half a file.
function write(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
}

function reachable(b, a) {
  return b.x < a.x + a.width - GRAB && b.x + b.width > a.x + GRAB && b.y >= a.y - TOP_SLACK && b.y < a.y + a.height - GRAB;
}

function overlap(b, a) {
  const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
  const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

// A saved state -> what to open the window with: { bounds: { width, height[, x, y] }, maximized },
// or null when there is nothing saved.
//
//   areas    the work area of every connected display
//   limits   { minWidth, minHeight, primary } where primary is the primary display's work area
//
// The position is used only while it still lands on a connected display. A monitor that has been
// unplugged, or a resolution that has dropped, would otherwise open the window where nobody can
// see it or reach it. Then the position is left out, and the window is placed the way a first run
// places it (centred on the primary display), keeping its size if that fits there.
// The size is never larger than the work area of the display it opens on and never smaller than
// the window's minimum. A window that had to shrink is also pulled fully inside that work area.
function fit(state, areas, limits = {}) {
  if (!state) return null;
  const list = (Array.isArray(areas) ? areas : []).filter(isRect);
  const placed = state.x != null && state.y != null;
  const home = placed
    ? list.filter((a) => reachable(state, a)).sort((p, q) => overlap(state, q) - overlap(state, p))[0]
    : null;
  const area = home || (isRect(limits.primary) ? limits.primary : list[0]) || null;
  const minWidth = limits.minWidth > 0 ? limits.minWidth : 1;
  const minHeight = limits.minHeight > 0 ? limits.minHeight : 1;
  // The minimum wins over a work area smaller than it, as it does on a first run.
  const width = Math.max(minWidth, area ? Math.min(state.width, area.width) : state.width);
  const height = Math.max(minHeight, area ? Math.min(state.height, area.height) : state.height);
  const bounds = { width, height };
  if (home) {
    const shrunk = width < state.width || height < state.height;
    bounds.x = shrunk ? clamp(state.x, home.x, Math.max(home.x, home.x + home.width - width)) : state.x;
    bounds.y = shrunk ? clamp(state.y, home.y, Math.max(home.y, home.y + home.height - height)) : state.y;
  }
  return { bounds, maximized: !!state.maximized };
}

// The bounds to write, given what the window reports now, what it reported when it opened, and
// what it was asked to open with.
//
// At fractional display scaling (125%, 150%) Windows rounds a new window a few pixels away from
// what was asked for. Writing what the window reports would feed that rounding back in at the next
// start, and the window would grow or drift a little on every run. So until the window has really
// been resized, the size it was ASKED to open with is what gets written, and the same for the
// position until it has really been moved. "Really" is more than CREEP_TOLERANCE pixels away from
// what it opened with.
// Size and position are judged separately: moving a window does not resize it, so a window that
// was only dragged somewhere else keeps the size it was asked for and does not pick up the
// rounding either.
function settle(now, opened, asked) {
  const same = (k) => Math.abs(now[k] - opened[k]) <= CREEP_TOLERANCE;
  const out = Object.fromEntries(SIDES.map((k) => [k, now[k]]));
  if (asked && asked.x != null && asked.y != null && same('x') && same('y')) {
    out.x = asked.x;
    out.y = asked.y;
  }
  if (asked && asked.width > 0 && asked.height > 0 && same('width') && same('height')) {
    out.width = asked.width;
    out.height = asked.height;
  }
  return out;
}

// Keep `file` in step with the window from now on.
//
//   win      the BrowserWindow, just created
//   o.file   where the state is written
//   o.asked  the bounds the window was created with (see settle)
//   o.log    told once if the state cannot be written
//
// Moves and resizes are written a moment after they stop, not on every event: dragging a window
// fires dozens a second. Closing writes at once, and that covers hiding to the tray too, because
// a window that is hidden on close still gets the close event first.
function track(win, o) {
  const { file, asked, log = () => {}, delay = SAVE_DELAY_MS } = o;
  const opened = win.getNormalBounds();
  let timer = null;
  let warned = false;
  let written = null; // what is in the file, so an unchanged window is not written again on every close
  try {
    written = JSON.stringify(normalizeForFile(JSON.parse(fs.readFileSync(file, 'utf8'))));
  } catch {}
  let normal = settle(opened, opened, asked); // the un-maximized bounds as last known here

  const bounds = () => {
    // getNormalBounds, not getBounds: for a maximized window it is the size to come back to
    // when it is un-maximized, not the size of the screen.
    const reported = win.getNormalBounds();
    // Except when it is not. On macOS a maximized window that is minimized and brought back
    // reports its maximized bounds as its normal ones from then on (Electron 44: maximize,
    // minimize, restore, quit saved the whole screen as the size to come back to, and the earlier
    // size was gone). A maximized window whose normal bounds are just its current ones has
    // forgotten them, so the ones last known here are kept.
    const shown = win.getBounds();
    if (win.isMaximized() && SIDES.every((k) => reported[k] === shown[k])) return normal;
    return settle(reported, opened, asked);
  };

  const save = () => {
    clearTimeout(timer);
    timer = null;
    try {
      // A minimized window does not say whether it was maximized, and a hidden one (in the tray)
      // cannot have been moved since it was hidden, which was written then. Both keep what is saved.
      if (win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      normal = bounds();
      const json = JSON.stringify({ ...normal, maximized: !!win.isMaximized() });
      if (json === written) return;
      write(file, json);
      written = json;
    } catch (e) {
      if (!warned) log(`window size and position not saved: ${e && e.message ? e.message : e}`);
      warned = true;
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, delay);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later);
  win.on('close', save);
  win.on('session-end', save); // Windows shutting down or signing out: there may be no close event
  win.on('closed', () => clearTimeout(timer));
  return { save };
}

// The saved state in the exact shape and key order save() writes, for the comparison in track().
function normalizeForFile(raw) {
  const s = normalize(raw);
  if (!s || s.x == null) return null;
  return { x: s.x, y: s.y, width: s.width, height: s.height, maximized: s.maximized };
}

module.exports = { FILE_NAME, CREEP_TOLERANCE, SAVE_DELAY_MS, normalize, read, write, fit, settle, track };
