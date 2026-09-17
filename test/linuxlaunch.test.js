'use strict';

// Launching an installed package on Linux. "Open App" worked on Windows from the start,
// where the uninstall registry hands over a program path; the Linux inventories list
// PACKAGES, so both halves — finding the program, and starting it — had to be built.
//
// Everything here is the pure half. The parts that shell out (gio launch, gtk-launch)
// are exercised by hand against a real desktop session; what is pinned here is the
// decision-making around them, which is where the bugs were.

const { test } = require('node:test');
const assert = require('node:assert');
const linux = require('../src/platform/linux');

// What `dpkg -L obs-studio` actually lists, trimmed to the launchable candidates.
const OBS_FILES = [
  '/usr/local/bin/obs',
  '/usr/local/bin/obs-ffmpeg-mux',
  '/usr/local/bin/obs-nvenc-test',
  '/usr/local/share/applications/com.obsproject.Studio.desktop',
  '/usr/local/lib/obs-plugins/obs-x264.so',
  '/usr/local/share/obs/obs-studio/themes/Yami.ovt',
];

test('launch path: the desktop entry wins over the bare executable', () => {
  // Not cosmetic. The entry carries HOW the app is meant to start — working directory,
  // flags, DBus activation — none of which the executable knows about.
  assert.equal(
    linux.pickLaunchPath(OBS_FILES, 'obs-studio'),
    '/usr/local/share/applications/com.obsproject.Studio.desktop'
  );
});

test('launch path: helper binaries never win over the app', () => {
  // OBS ships obs-ffmpeg-mux and obs-nvenc-test beside obs. With no desktop entry the
  // shortest name is the app and the rest are its tools.
  const noDesktop = OBS_FILES.filter((f) => !f.endsWith('.desktop'));
  assert.equal(linux.pickLaunchPath(noDesktop, 'obs-studio'), '/usr/local/bin/obs');
});

test('launch path: a reverse-DNS desktop id still matches its package', () => {
  // "com.obsproject.Studio" never equals "obs-studio", so an equality-only match would
  // fall through to the binary and lose the entry.
  assert.match(linux.pickLaunchPath(OBS_FILES, 'obs-studio'), /com\.obsproject\.Studio\.desktop$/);
});

test('launch path: a package owning nothing launchable resolves to nothing', () => {
  // A library or -data package must report no target so the caller can say so, rather
  // than launching some arbitrary file it happens to own.
  assert.equal(linux.pickLaunchPath(['/usr/lib/x86_64-linux-gnu/libobs.so.0', '/usr/share/doc/libobs/NEWS'], 'libobs'), null);
  assert.equal(linux.pickLaunchPath([], 'anything'), null);
});

test('exec: field codes are dropped, not passed to the program', () => {
  // %U and friends are placeholders for files to open with. Launching the app plain
  // leaves nothing to substitute, and the spec says to remove them — passing "%U" through
  // would hand the app a literal argument it never expects.
  assert.deepEqual(linux.parseExec('obs'), ['obs']);
  assert.deepEqual(linux.parseExec('obs --startstreaming %U'), ['obs', '--startstreaming']);
  assert.deepEqual(linux.parseExec('gimp-2.10 %F'), ['gimp-2.10']);
});

test('exec: a quoted path with spaces stays one argument', () => {
  assert.deepEqual(linux.parseExec('"/opt/my app/run" --safe %f'), ['/opt/my app/run', '--safe']);
});

test('exec: an empty or missing Exec line yields nothing to run', () => {
  assert.equal(linux.parseExec(''), null);
  assert.equal(linux.parseExec('%U'), null, 'field codes alone are not a command');
  assert.equal(linux.parseExec(undefined), null);
});
