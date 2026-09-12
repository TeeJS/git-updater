'use strict';

// Which .app paths count as an installed application.
//
// Every case here is a real path from a real Mac's system_profiler output, or the
// ground truth read off that machine's disk. The predicate is pure and takes its
// directories as a parameter, so the whole table runs on any host.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { isInstalledAppPath, APP_DIRS } = require('../src/platform/appfilter');

// POSIX roots, passed explicitly so the suite does not depend on the host's home dir.
const DIRS = ['/Applications', '/Users/teej/Applications'];
const ok = (p) => isInstalledAppPath(p, DIRS);

test('appfilter: accepts an app installed where apps are installed', () => {
  assert.ok(ok('/Applications/Docker.app'));
  assert.ok(ok('/Users/teej/Applications/Some Tool.app'));
});

test('appfilter: accepts one level of vendor subfolder, and only one', () => {
  assert.ok(ok('/Applications/Utilities/Terminal.app'), 'Utilities is this shape');
  assert.ok(ok('/Applications/Setapp/CleanShot X.app'), 'grouped installers are too');
  assert.equal(ok('/Applications/Vendor/Suite/Thing.app'), false, 'two levels is not');
});

test('appfilter: rejects bundles that are not installed applications', () => {
  // Every one of these was really reported by system_profiler on a developer machine.
  assert.equal(ok('/Users/teej/github/bedrock-panel/node_modules/electron/dist/Electron.app'), false);
  assert.equal(ok('/Users/teej/github/bedrock-panel/dist/mac-arm64/Bedrock Panel.app'), false);
  assert.equal(ok('/Users/teej/Library/Application Support/Claude/claude-code/2.1.266/Claude.app'), false);
  assert.equal(ok('/Library/Application Support/Script Editor/Templates/Droplets/Droplet.app'), false);
});

test('appfilter: rejects a path that merely looks like a bundle', () => {
  // A template, not an application. Nothing else checked the suffix exactly.
  assert.equal(ok('/Applications/TestGUI.app.in'), false);
  assert.equal(ok('/Applications/NotAnApp'), false);
  assert.equal(ok(''), false);
  assert.equal(ok(null), false);
});

test('appfilter: rejects a helper nested inside another bundle, at any depth', () => {
  assert.equal(ok('/Applications/Foo.app/Contents/Library/LoginItems/FooHelper.app'), false);
  assert.equal(ok('/System/Library/CoreServices/Finder.app/Contents/Applications/AirDrop.app'), false);
  // ...including when the outer bundle sits in a legitimate location.
  assert.equal(ok('/Applications/Utilities/Foo.app/Contents/XPCServices/Bar.app'), false);
});

test('appfilter: the version pinned by a stale copy is exactly what this prevents', () => {
  // installedVersion() reports the HIGHEST match. A cached 2.1.266 beside an installed
  // 2.1.260 would report the newer one and the update would never be offered.
  const real = '/Applications/Claude.app';
  const cached = '/Users/teej/Library/Application Support/Claude/claude-code/2.1.266/Claude.app';
  assert.ok(ok(real));
  assert.equal(ok(cached), false);
});

test('appfilter: the default directories are the two real ones', () => {
  const dirs = APP_DIRS();
  assert.equal(dirs.length, 2);
  assert.ok(dirs[0].endsWith('Applications'));
  assert.ok(dirs[1].endsWith(path.join('Applications')));
  // Utilities is NOT listed: it is reached as a vendor subfolder of /Applications, so
  // listing it separately would be a second way to say the same thing.
  assert.ok(!dirs.some((d) => /Utilities/.test(d)));
});
