'use strict';

// "Choose download…": choosing by hand which file of a release an app uses.
//
//   - the override remembered from a pick (the file name with its version as "*")
//   - the list the chooser shows: every file ranked for a machine, with why it does or does
//     not suit it, for Windows, macOS and Linux
//   - the "needs a choice" signal a failed pick carries, at Check as well as on Update
//   - the two IPC handlers, run for real out of electron/main.js in a vm with fake Electron
//     objects (the same technique as test/ui-add-window.test.js)
//
// Ported from PlayingKarrde/git-updater 12043aa and adapted: ours has several kinds of
// source, and the choice is saved by the main process from a position in a list rather
// than typed as a pattern in the window.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL, fileURLToPath } = require('url');
const AdmZip = require('adm-zip');

const core = require('../src/core');
const github = require('../src/github');
const detect = require('../src/detect');
const runner = require('../src/runner');
const sources = require('../src/sources');

const A = (names) => names.map((name) => ({ name, size: 1000, browser_download_url: `https://files.example/${name}` }));
const gh = (type, asset) => ({ owner: 'o', repo: 'App', type, ...(asset ? { asset } : {}) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gu-assetchoice-'));

// --- the remembered override ------------------------------------------------------

test('pattern: the version becomes *, so the next release matches the same file', () => {
  const p = core.assetPatternFor('OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb', '32.2.2');
  assert.equal(p, 'OBS-Studio-*-Ubuntu-24.04-x86_64.deb');
  const next = A(['OBS-Studio-32.3.0-Ubuntu-24.04-x86_64.deb', 'OBS-Studio-32.3.0-Ubuntu-26.04-x86_64.deb']);
  assert.equal(core.matchAsset(next, p).name, 'OBS-Studio-32.3.0-Ubuntu-24.04-x86_64.deb');
});

test('pattern: a "v" in both tag and name is replaced with the version', () => {
  assert.equal(core.assetPatternFor('tool-v1.2.3-linux.tar.gz', 'v1.2.3'), 'tool-*-linux.tar.gz');
  // Tag without the v: the v in the file name stays literal.
  assert.equal(core.assetPatternFor('Godot_v4.5-stable_linux.x86_64.zip', '4.5-stable'), 'Godot_v*_linux.x86_64.zip');
});

test('pattern: a version written with another separator in the file name is still found', () => {
  // Without this the file is pinned by its exact name and stops matching at the next release.
  const p = core.assetPatternFor('app_1_2_3_win64.zip', 'v1.2.3');
  assert.equal(p, 'app_*_win64.zip');
  assert.equal(core.matchAsset(A(['app_1_3_0_win64.zip', 'app_1_3_0_linux.zip']), p).name, 'app_1_3_0_win64.zip');
});

test('pattern: a name without the version is kept exactly', () => {
  assert.equal(core.assetPatternFor('app-linux-x64.tar.gz', 'v1.0.0'), 'app-linux-x64.tar.gz');
});

test('pattern: a too-short version is not wildcarded', () => {
  assert.equal(core.assetPatternFor('app1-x64-1.tar.gz', '1'), 'app1-x64-1.tar.gz');
});

test('pattern: falls back to the exact name when * would also match a sibling', () => {
  const names = ['app-1.0-x64.tar.gz', 'app-1.0-x64.tar.gz.part2', 'app-1.0.1-x64.tar.gz'];
  // "app-*-x64.tar.gz" would hit 1.0 and 1.0.1 both.
  assert.equal(core.assetPatternFor('app-1.0-x64.tar.gz', '1.0', names), 'app-1.0-x64.tar.gz');
});

test('pattern: special characters in a name are escaped, never read as a glob or a regex', () => {
  // A name that reads as a glob is pinned with an escaped, anchored regex.
  const p = core.assetPatternFor('weird*name.zip', 'v1.0.0');
  assert.match(p, /^\/.*\/$/);
  assert.equal(core.matchAsset(A(['weird*name.zip', 'weirdXname.zip']), p).name, 'weird*name.zip');
  // Regex metacharacters in an ordinary name stay literal: "+" and "(" are not operators.
  const q = core.assetPatternFor('app+plus (x64)-2.0.0.zip', '2.0.0');
  assert.equal(q, 'app+plus (x64)-*.zip');
  assert.equal(core.matchAsset(A(['app+plus (x64)-2.1.0.zip', 'appplus x64-2.1.0.zip']), q).name, 'app+plus (x64)-2.1.0.zip');
  // A name wrapped in slashes would be read as a regex; it is pinned exactly instead.
  const r = core.assetPatternFor('/odd/', '1.0.0');
  assert.equal(core.matchAsset(A(['/odd/', 'odd']), r).name, '/odd/');
});

test('pattern: two names that differ only by letter case are told apart', () => {
  // A glob compares case-insensitively, so the exact name would match both.
  const names = ['Tool.zip', 'tool.zip'];
  const p = core.assetPatternFor('Tool.zip', 'v3.0.0', names);
  assert.equal(core.matchAsset(A(names), p).name, 'Tool.zip');
});

// --- the list the chooser shows ---------------------------------------------------

const by = (r) => Object.fromEntries(r.files.map((f) => [f.name, f]));
const WIN = A([
  'App-1.2.3-win-x64.zip', 'App-1.2.3-win-arm64.zip', 'App-Setup-1.2.3.exe', 'App-1.2.3.msi',
  'App-1.2.3.dmg', 'App-1.2.3-linux-x86_64.AppImage', 'SHA256SUMS.txt', 'latest.yml',
]);
const MAC = A(['App-1.2.3-arm64.dmg', 'App-1.2.3-x64.dmg', 'App-1.2.3-universal.dmg', 'App-1.2.3.pkg', 'App-Setup-1.2.3.exe']);
const OBS = A([
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb',
  'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb',
  'OBS-Studio-32.2.2-Sources.tar.gz',
  'OBS-Studio-32.2.2-Windows.zip',
  'SHA256SUMS',
  'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb.sha256',
]);

test('choices on Windows: ranked for the machine, each file says why it does or does not suit it', () => {
  const r = sources.fileChoices(gh('portable'), { tag_name: 'v1.2.3', assets: WIN }, { platform: 'win32', arch: 'x64' });
  const f = by(r);
  assert.equal(r.system, 'Windows');
  assert.equal(r.version, '1.2.3');
  assert.ok(!f['SHA256SUMS.txt'] && !f['latest.yml'], 'checksums and update feeds are not listed');
  assert.equal(r.auto, 'App-1.2.3-win-x64.zip');
  assert.equal(r.files[0].name, r.auto, 'the best fit is listed first');
  assert.equal(f[r.auto].auto, true);
  assert.match(f[r.auto].note, /^Fits this computer: Windows, Intel\/AMD \(x64\)\.$/);
  // Another architecture: listed, warned about, still the user's call on GitHub.
  assert.equal(f['App-1.2.3-win-arm64.zip'].status, 'other-arch');
  assert.match(f['App-1.2.3-win-arm64.zip'].note, /ARM \(arm64\) processors, and this computer is Intel\/AMD \(x64\)/);
  assert.equal(f['App-1.2.3-win-arm64.zip'].tone, 'off');
  assert.deepEqual(r.files.map((x) => x.tone), ['', 'off', 'off', 'off', 'off', 'off'], 'what fits stands out; the rest is quiet');
  assert.equal(f['App-1.2.3-win-arm64.zip'].choosable, true);
  // Installer vs portable: said in words, with the way to use it, and not choosable.
  for (const name of ['App-1.2.3.msi', 'App-Setup-1.2.3.exe']) {
    assert.equal(f[name].status, 'other-type', name);
    assert.match(f[name].note, /^An installer, and this app is tracked as Portable\. To use it, Edit the app and change its type to Installer\.$/);
    assert.equal(f[name].choosable, false);
  }
  // Another system, named.
  assert.match(f['App-1.2.3.dmg'].note, /^Made for macOS, not Windows\./);
  assert.match(f['App-1.2.3-linux-x86_64.AppImage'].note, /^Made for Linux, not Windows\./);
  assert.deepEqual(r.files.map((x) => x.status), ['ok', 'other-arch', 'rejected', 'rejected', 'other-type', 'other-type']);
});

test('choices on Windows: the same release as an Installer turns the two types around', () => {
  const f = by(sources.fileChoices(gh('installer'), { tag_name: 'v1.2.3', assets: WIN }, { platform: 'win32', arch: 'x64' }));
  assert.equal(f['App-Setup-1.2.3.exe'].status, 'ok');
  assert.equal(f['App-1.2.3.msi'].status, 'ok');
  assert.match(f['App-1.2.3.msi'].note, /^Fits Windows\. The name does not say which processor it is for\.$/);
  assert.match(f['App-1.2.3-win-x64.zip'].note, /^A portable build, and this app is tracked as an Installer\./);
});

test('choices on macOS: native first, emulated flagged, the installer kept apart', () => {
  const r = sources.fileChoices(gh('portable'), { tag_name: 'v1.2.3', assets: MAC }, { platform: 'darwin', arch: 'arm64' });
  const f = by(r);
  assert.equal(r.system, 'macOS');
  assert.equal(r.auto, 'App-1.2.3-arm64.dmg');
  assert.deepEqual(r.files.map((x) => x.name), ['App-1.2.3-arm64.dmg', 'App-1.2.3-universal.dmg', 'App-1.2.3-x64.dmg', 'App-Setup-1.2.3.exe', 'App-1.2.3.pkg']);
  assert.match(f['App-1.2.3-arm64.dmg'].note, /macOS, ARM \(arm64\)/);
  assert.match(f['App-1.2.3-universal.dmg'].note, /macOS, any processor/);
  assert.equal(f['App-1.2.3-x64.dmg'].status, 'emulated');
  assert.match(f['App-1.2.3-x64.dmg'].note, /Intel\/AMD \(x64\) processors, not native to this computer: it runs under emulation/);
  assert.equal(f['App-1.2.3-x64.dmg'].choosable, true);
  assert.match(f['App-Setup-1.2.3.exe'].note, /^Made for Windows, not macOS\./);
  assert.equal(f['App-1.2.3.pkg'].status, 'other-type');
  // On an Intel Mac the arm64 image cannot run at all.
  const intel = by(sources.fileChoices(gh('portable'), { tag_name: 'v1.2.3', assets: MAC }, { platform: 'darwin', arch: 'x64' }));
  assert.equal(intel['App-1.2.3-arm64.dmg'].status, 'other-arch');
  assert.equal(intel['App-1.2.3-x64.dmg'].status, 'ok');
});

test('choices on Linux: metadata is hidden, builds are classified, the automatic pick is marked', () => {
  const r = sources.fileChoices(gh('installer'), { tag_name: '32.2.2', assets: OBS }, { platform: 'linux', arch: 'x64', osRelease: { id: 'ubuntu', versionId: '26.04' } });
  const f = by(r);
  assert.ok(!f.SHA256SUMS && !f['OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb.sha256']);
  assert.equal(r.auto, 'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb');
  assert.equal(f[r.auto].auto, true);
  assert.equal(r.files[0].name, r.auto, 'best match is listed first');
  assert.equal(f['OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb'].status, 'ok');
  assert.equal(f['OBS-Studio-32.2.2-Sources.tar.gz'].status, 'rejected');
  assert.match(f['OBS-Studio-32.2.2-Sources.tar.gz'].note, /^Not a Linux app: source code, debug files, or made for another system\./);
  assert.match(f['OBS-Studio-32.2.2-Windows.zip'].note, /^Made for Windows, not Linux\./);
  assert.equal(r.tie, false, 'the distro release settles it');
});

test('choices: a tie is said out loud, because the automatic pick is then a coin flip', () => {
  // Neither Ubuntu release is this machine's: the two .debs score the same.
  const r = sources.fileChoices(gh('installer'), { tag_name: '32.2.2', assets: OBS }, { platform: 'linux', arch: 'x64' });
  assert.equal(r.tie, true);
  const clear = A(['app-1.0-linux-x86_64.tar.gz', 'app-1.0-linux-arm64.tar.gz']);
  assert.equal(sources.fileChoices(gh('portable'), { tag_name: '1.0', assets: clear }, { platform: 'linux', arch: 'x64' }).tie, false);
});

test('choices: a build of the other type is marked, not offered', () => {
  const r = sources.fileChoices(gh('portable'), { tag_name: '32.2.2', assets: OBS }, { platform: 'linux', arch: 'x64' });
  const deb = r.files.find((c) => c.name.endsWith('24.04-x86_64.deb'));
  assert.equal(deb.status, 'other-type');
  assert.equal(deb.choosable, false);
  assert.equal(r.auto, null);
});

test('choices: a file with no platform marker is unknown, still listed and still the user\'s call on GitHub', () => {
  const r = sources.fileChoices(gh('portable'), { tag_name: 'v1', assets: A(['thing.bin']) }, { platform: 'linux', arch: 'x64' });
  assert.equal(r.files[0].status, 'unknown');
  assert.equal(r.files[0].choosable, true);
  assert.match(r.files[0].note, /^Nothing in the name says this is a Linux portable build\. Choose it only if you know it is\.$/);
});

test('choices: a saved choice is shown as the user\'s, beside what would be picked automatically', () => {
  const r = sources.fileChoices(gh('installer', 'OBS-Studio-*-Ubuntu-24.04-x86_64.deb'), { tag_name: '32.2.2', assets: OBS }, { platform: 'linux', arch: 'x64', osRelease: { id: 'ubuntu', versionId: '26.04' } });
  assert.equal(r.saved, true);
  assert.equal(r.current, 'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb');
  assert.equal(r.auto, 'OBS-Studio-32.2.2-Ubuntu-26.04-x86_64.deb');
  assert.equal(by(r)[r.current].current, true);
});

test('choices: every file\'s saved form selects that file and only that file', () => {
  for (const [entry, rel, host] of [
    [gh('portable'), { tag_name: 'v1.2.3', assets: WIN }, { platform: 'win32', arch: 'x64' }],
    [gh('portable'), { tag_name: 'v1.2.3', assets: MAC }, { platform: 'darwin', arch: 'arm64' }],
    [gh('installer'), { tag_name: '32.2.2', assets: OBS }, { platform: 'linux', arch: 'x64' }],
  ]) {
    for (const f of sources.fileChoices(entry, rel, host).files.filter((x) => x.choosable)) {
      assert.equal(sources.selectAsset({ ...entry, asset: f.pattern }, rel, host).name, f.name, f.pattern);
      assert.ok(f.pattern.includes('*'), `${f.name} is remembered without its version`);
    }
  }
});

test('choices: nothing the user reads says "asset" or "pattern"', () => {
  const all = [
    ...sources.fileChoices(gh('portable'), { tag_name: 'v1.2.3', assets: WIN }, { platform: 'win32', arch: 'arm64' }).files,
    ...sources.fileChoices(gh('installer'), { tag_name: 'v1.2.3', assets: MAC }, { platform: 'darwin', arch: 'x64' }).files,
    ...sources.fileChoices(gh('portable'), { tag_name: '32.2.2', assets: [...OBS, ...A(['thing.bin'])] }, { platform: 'linux', arch: 'arm64' }).files,
  ];
  for (const f of all) assert.doesNotMatch(f.note, /asset|pattern|regex|glob/i, f.note);
});

// --- which sources get it ---------------------------------------------------------

const BLENDER = A([
  'blender-5.3.0-linux-x64.tar.xz', 'blender-5.3.0-macos-arm64.dmg',
  'blender-5.3.0-windows-arm64.msi', 'blender-5.3.0-windows-arm64.zip',
  'blender-5.3.0-windows-x64.msi', 'blender-5.3.0-windows-x64.zip',
]);
const sourced = (source, type = 'portable', asset) => ({ type, name: 'Blender', owner: 'x', repo: 'y', source, ...(asset ? { asset } : {}) });
const FOLDER = { type: 'folder', url: 'https://download.blender.org/release/' };
const GITEA = { type: 'gitea', host: 'codeberg.org', owner: 'a', repo: 'b' };
const GITLAB = { type: 'gitlab', host: 'gitlab.com', project: 'a/b' };

test('sources: releases and vendor folders can be chosen from; WinGet and Homebrew cannot', () => {
  assert.equal(sources.canChooseFile(gh('portable')), true);
  for (const s of [FOLDER, GITEA, GITLAB]) assert.equal(sources.canChooseFile(sourced(s)), true, s.type);
  for (const s of [{ type: 'winget', packageId: 'VideoLAN.VLC' }, { type: 'brew', token: 'vlc' }]) {
    assert.equal(sources.canChooseFile(sourced(s)), false, s.type);
    assert.throws(() => sources.fileChoices(sourced(s), { tag_name: '1.0', assets: BLENDER }, { platform: 'win32', arch: 'x64' }), /names the one file for this app itself, so there is no list to choose from/);
    assert.throws(() => sources.requireFileList(sourced(s)), /no list to choose from/);
  }
});

test('sources: off GitHub a choice only narrows — a build this machine cannot use is listed but never choosable', () => {
  for (const s of [FOLDER, GITEA, GITLAB]) {
    const rel = { tag_name: '5.3.0', assets: BLENDER };
    const host = { platform: 'win32', arch: 'arm64' };
    const r = sources.fileChoices(sourced(s), rel, host);
    const f = by(r);
    assert.equal(r.auto, 'blender-5.3.0-windows-arm64.zip', s.type);
    assert.deepEqual(r.files.filter((x) => x.choosable).map((x) => x.name), ['blender-5.3.0-windows-arm64.zip', 'blender-5.3.0-windows-x64.zip']);
    assert.equal(f['blender-5.3.0-windows-x64.zip'].status, 'emulated');
    assert.equal(f['blender-5.3.0-windows-x64.zip'].pattern, 'blender-*-windows-x64.zip');
    assert.equal(f['blender-5.3.0-linux-x64.tar.xz'].choosable, false);
    assert.equal(f['blender-5.3.0-linux-x64.tar.xz'].note, 'Made for Linux, not Windows.', 'no "choose it if you know" where it cannot be chosen');
    // The saved form works through the real selection, and still does for the next version.
    const pinned = sourced(s, 'portable', f['blender-5.3.0-windows-x64.zip'].pattern);
    assert.equal(sources.selectAsset(pinned, rel, host).name, 'blender-5.3.0-windows-x64.zip');
    const next = { tag_name: '5.4.0', assets: A(BLENDER.map((a) => a.name.replace('5.3.0', '5.4.0'))) };
    assert.equal(sources.selectAsset(pinned, next, host).name, 'blender-5.4.0-windows-x64.zip');
  }
  // An x64 Linux machine cannot run the arm64 build, and off GitHub cannot choose it.
  const lin = by(sources.fileChoices(sourced(GITEA), { tag_name: '1.0', assets: A(['t-1.0-linux-arm64.tar.gz', 't-1.0-linux-x86_64.tar.gz']) }, { platform: 'linux', arch: 'x64' }));
  assert.equal(lin['t-1.0-linux-arm64.tar.gz'].status, 'other-arch');
  assert.equal(lin['t-1.0-linux-arm64.tar.gz'].choosable, false);
  assert.match(lin['t-1.0-linux-arm64.tar.gz'].note, /This computer is Intel\/AMD \(x64\) and cannot run it\.$/);
});

test('sources: two files with one name cannot be told apart, so neither can be chosen', () => {
  const twins = [...A(['tool-2.0-win64.zip']), { name: 'tool-2.0-win64.zip', browser_download_url: 'https://files.example/other/tool-2.0-win64.zip' }];
  const r = sources.fileChoices(gh('portable'), { tag_name: '2.0', assets: twins }, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(r.files.map((f) => f.choosable), [false, false]);
  assert.match(r.files[0].note, /has the same name/);
});

// --- the "needs a choice" signal --------------------------------------------------

const LIN = { platform: 'linux', arch: 'x64' };

test('resolve: a saved choice wins over the automatic pick', () => {
  const repo = gh('installer', 'OBS-Studio-*-Ubuntu-24.04-x86_64.deb');
  const got = sources.selectAsset(repo, { tag_name: '32.2.2', assets: OBS }, { ...LIN, osRelease: { id: 'ubuntu', versionId: '26.04' } });
  assert.equal(got.name, 'OBS-Studio-32.2.2-Ubuntu-24.04-x86_64.deb');
});

test('resolve: a saved choice that stopped matching asks for a new one instead of erroring', () => {
  const repo = gh('installer', 'obs-*-noble.deb');
  assert.throws(() => sources.selectAsset(repo, { tag_name: '32.2.2', assets: OBS }, LIN), (e) => {
    assert.equal(e.chooseFile, true);
    assert.match(e.chooseWhy, /^your saved download choice fits no file in 32\.2\.2; the files may have been renamed\. Choose again$/);
    assert.match(e.message, /no asset matched/, 'the original message is kept for the log');
    return true;
  });
});

test('resolve: a saved choice that now matches several files asks for a new one', () => {
  const repo = gh('installer', 'OBS-Studio-*.deb');
  assert.throws(() => sources.selectAsset(repo, { tag_name: '32.2.2', assets: OBS }, LIN), (e) => e.chooseFile === true && /now fits 2 files in 32\.2\.2/.test(e.chooseWhy));
});

test('resolve: a saved choice that cannot be read asks for a new one', () => {
  for (const asset of ['/(/', 5]) {
    assert.throws(() => sources.selectAsset({ ...gh('installer'), asset }, { tag_name: '32.2.2', assets: OBS }, LIN), (e) => e.chooseFile === true && /cannot be read\. Choose again$/.test(e.chooseWhy));
  }
});

test('resolve: nothing usable for this platform asks for a choice', () => {
  assert.throws(() => sources.selectAsset(gh('portable'), { tag_name: 'v2', assets: A(['thing.bin']) }, LIN), (e) => {
    assert.equal(e.chooseFile, true);
    assert.match(e.chooseWhy, /^no file in 2 clearly fits this computer \(Linux portable\), so none is picked automatically\. Choose the one to use$/);
    return true;
  });
});

test('resolve: "ships the other type" keeps its own fix, not the chooser', () => {
  assert.throws(
    () => sources.selectAsset(gh('portable'), { tag_name: '1.0', assets: A(['app_1.0_amd64.deb']) }, LIN),
    (e) => /change its type to Installer/.test(e.message) && !e.chooseFile
  );
});

test('resolve: a failure the chooser could not fix is left as the error it is', () => {
  // An empty release: nothing to choose from.
  assert.throws(() => sources.selectAsset(gh('portable'), { tag_name: '1.0', assets: [] }, LIN), (e) => !e.chooseFile);
  // Only checksums: nothing the chooser would list.
  assert.throws(() => sources.selectAsset(gh('portable'), { tag_name: '1.0', assets: A(['SHA256SUMS']) }, LIN), (e) => !e.chooseFile);
  // Off GitHub, nothing this machine can use means nothing choosable either.
  assert.throws(() => sources.selectAsset(sourced(GITEA), { tag_name: '5.3.0', assets: BLENDER }, { platform: 'darwin', arch: 'x64' }), (e) => /no build for this machine/.test(e.message) && !e.chooseFile);
  // ...but a stale choice there, with usable files still on offer, asks again.
  assert.throws(() => sources.selectAsset(sourced(GITEA, 'portable', '*-win64-old.zip'), { tag_name: '5.3.0', assets: BLENDER }, { platform: 'win32', arch: 'x64' }), (e) => e.chooseFile === true);
});

test('resolve: WinGet and Homebrew failures never ask for a choice', () => {
  const assets = [{ name: 'a.msi', browser_download_url: 'https://v.example/a.msi', platform: 'win32', arch: 'x64', type: 'installer', kind: 'msi' }];
  const e = sourced({ type: 'winget', packageId: 'Vendor.App' }, 'installer', '*.nothing');
  assert.throws(() => sources.selectAsset(e, { tag_name: '1.0', assets }, { platform: 'win32', arch: 'x64' }), (err) => /no asset matched/.test(err.message) && !err.chooseFile);
});

// --- runner: said at Check, before the user hits Update ----------------------------

async function withGithub(release, fn) {
  const real = {
    getLatestRelease: github.getLatestRelease, downloadAsset: github.downloadAsset,
    fetchChecksumFromRelease: github.fetchChecksumFromRelease,
    installedVersion: detect.installedVersion, installedFlavor: detect.installedFlavor,
    clearCache: detect.clearCache, osRelease: detect.osRelease, isRunning: detect.isRunning,
  };
  const downloads = [];
  github.getLatestRelease = async () => release;
  github.fetchChecksumFromRelease = async () => null;
  github.downloadAsset = async (url, file, _progress, _maxBytes, policy = {}) => {
    downloads.push({ url, apiUrl: policy.apiUrl });
    const zip = new AdmZip();
    zip.addFile('app.txt', Buffer.from('v2'));
    zip.writeZip(file);
  };
  detect.installedVersion = async () => null;
  detect.installedFlavor = async () => null;
  detect.clearCache = () => {};
  detect.osRelease = () => null;
  detect.isRunning = async () => false;
  const dir = tmp();
  try {
    return await fn({ dir, statePath: path.join(dir, 'state.json'), downloads });
  } finally {
    Object.assign(github, { getLatestRelease: real.getLatestRelease, downloadAsset: real.downloadAsset, fetchChecksumFromRelease: real.fetchChecksumFromRelease });
    Object.assign(detect, { installedVersion: real.installedVersion, installedFlavor: real.installedFlavor, clearCache: real.clearCache, osRelease: real.osRelease, isRunning: real.isRunning });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('check: an update with no usable download comes back flagged, with its versions', async () => {
  await withGithub({ tag_name: 'v2.0.0', assets: A(['thing.bin']) }, async ({ statePath }) => {
    const cfg = { repos: [{ owner: 'o', repo: 'r', type: 'installer' }] };
    const { results } = await runner.run(cfg, { mode: 'check', statePath });
    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].chooseFile, true);
    assert.equal(results[0].to, '2.0.0', 'the row still shows the version on offer');
    assert.match(results[0].reason, /^no file in 2\.0\.0 clearly fits this computer/);
    assert.doesNotMatch(results[0].reason, /asset|pattern/i);
  });
});

test('check and update: a saved choice that stopped matching flags the row rather than erroring', async () => {
  await withGithub({ tag_name: 'v2.0.0', assets: A(['tool-2.0.0-x64.zip', 'tool-2.0.0-arm64.zip']) }, async ({ dir, statePath, downloads }) => {
    const cfg = { repos: [{ owner: 'o', repo: 'r', type: 'portable', asset: 'tool-*-amd64.zip', install: { dir: path.join(dir, 'app') } }] };
    for (const opts of [{ mode: 'check' }, { dryRun: true }, {}]) {
      const { results } = await runner.run(cfg, { ...opts, statePath });
      assert.equal(results[0].status, 'failed', JSON.stringify(opts));
      assert.equal(results[0].chooseFile, true);
      assert.match(results[0].reason, /^your saved download choice fits no file in 2\.0\.0/);
      assert.equal(results[0].to, '2.0.0');
    }
    assert.equal(downloads.length, 0, 'nothing is downloaded on a guess');
  });
});

test('check: a failure that is not about the choice is still left to the update, as before', async () => {
  // Only checksums in the release: the chooser could not help, so Check says "available".
  await withGithub({ tag_name: 'v2.0.0', assets: A(['SHA256SUMS']) }, async ({ statePath }) => {
    const { results } = await runner.run({ repos: [{ owner: 'o', repo: 'r', type: 'installer' }] }, { mode: 'check', statePath });
    assert.equal(results[0].status, 'updated');
    assert.equal(results[0].chooseFile, undefined);
  });
});

test('scheduled install: an app that needs a file chosen "needs you", it has not failed', async () => {
  const autoupdate = require('../src/autoupdate');
  await withGithub({ tag_name: 'v2.0.0', assets: A(['thing.bin']) }, async ({ statePath }) => {
    const { results } = await runner.run({ repos: [{ owner: 'o', repo: 'r', type: 'installer' }] }, { unattended: true, statePath });
    assert.equal(results[0].chooseFile, true);
    assert.equal(autoupdate.classify(results[0]), 'needsYou');
    const s = autoupdate.summarize([{ name: 'o/r', result: results[0] }]);
    assert.match(autoupdate.summaryText(s), /^1 needs you: o\/r\./);
  });
});

test('update: a chosen file in a private GitHub repo is still fetched through its API address', async () => {
  const assets = ['tool-2.0.0-x64.zip', 'tool-2.0.0-arm64.zip'].map((name, i) => ({
    name,
    url: `https://api.github.com/repos/me/private-tool/releases/assets/${i + 1}`,
    browser_download_url: `https://github.com/me/private-tool/releases/download/v2.0.0/${name}`,
  }));
  await withGithub({ tag_name: 'v2.0.0', assets }, async ({ dir, statePath, downloads }) => {
    // What the chooser would have saved for the arm64 file.
    const entry = { owner: 'me', repo: 'private-tool', type: 'portable', install: { dir: path.join(dir, 'app') } };
    const listed = sources.fileChoices(entry, { tag_name: 'v2.0.0', assets }, { platform: 'win32', arch: 'x64' });
    entry.asset = listed.files.find((f) => f.name === 'tool-2.0.0-arm64.zip').pattern;
    assert.equal(entry.asset, 'tool-*-arm64.zip');
    const { results } = await runner.run({ repos: [entry] }, { statePath });
    assert.equal(results[0].status, 'updated', results[0].reason);
    assert.deepEqual(downloads, [{
      url: 'https://github.com/me/private-tool/releases/download/v2.0.0/tool-2.0.0-arm64.zip',
      apiUrl: 'https://api.github.com/repos/me/private-tool/releases/assets/2',
    }]);
    assert.equal(fs.readFileSync(path.join(dir, 'app', 'app.txt'), 'utf8'), 'v2');
  });
});

// --- the IPC handlers, out of the real electron/main.js ----------------------------

const root = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
function slice(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} .. ${end}`);
  return src.slice(a, b);
}

// The handlers run against a real config file in a temp folder, with the real registry —
// only the network (the release) and the machine (always Windows x64 here, so the test
// reads the same on every host) are supplied.
function mainHarness({ repos, release }) {
  const dir = tmp();
  const CONFIG_PATH = path.join(dir, 'config.json');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ portableRoot: path.join(dir, 'apps'), repos }));
  const mainPage = path.join(root, 'ui', 'index.html');
  const wc = (url) => { const w = { mainFrame: { url } }; return w; };
  const win = { isDestroyed: () => false, webContents: wc(pathToFileURL(mainPage).href) };
  const machine = { platform: 'win32', arch: 'x64' };
  const fetched = [];
  const handlers = {};
  const hooks = { select: null }; // a test can stand in for the selection at save time
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    fs, path, core, URL, fileURLToPath, console,
    process: { platform: process.platform },
    CONFIG_PATH, mainPage, win,
    sources: {
      ...sources,
      getLatestRelease: async (entry) => { fetched.push(core.displayId(entry)); return typeof release === 'function' ? release() : release; },
      fileChoices: (entry, rel, host) => sources.fileChoices(entry, rel, { ...host, ...machine }),
      selectAsset: (entry, rel, host) => (hooks.select || sources.selectAsset)(entry, rel, { ...host, ...machine }),
      resolveChecksum: async () => ({ state: 'none' }),
    },
    detect: { installedFlavor: async () => null, osRelease: () => null },
    state: { load: () => ({}) },
    cron: { validate: () => ({ ok: true }) },
    background: { setStartAtLogin: () => {} },
    app: {}, bg: { syncTray: () => {} }, loginLauncher: () => null,
    log: () => {},
  };
  const code = slice(mainJs, 'function readConfig()', '// GitHub access token')
    + slice(mainJs, "ipcMain.handle('config:save'", "ipcMain.handle('config:open'")
    + slice(mainJs, 'const findEntry', '// Validate a GitHub repo')
    + slice(mainJs, "ipcMain.handle('sources:describe'", '// Preview exactly what')
    + slice(mainJs, "ipcMain.handle('asset:preview'", '// The source types this build knows')
    + slice(mainJs, 'function fromWindow', 'function requireMainWindow');
  vm.runInNewContext(code, context);
  const fromMain = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const call = (name, arg, e = fromMain) => handlers[name](e, arg);
  const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return { call, saved, win, wc, fetched, handlers, dir, hooks };
}

const KEY = 'o/App#portable';
const WIN_REL = { tag_name: 'v1.2.3', assets: WIN, provenance: { listedBy: 'GitHub' } };

test('asset:choices and asset:choose refuse every caller except the main window\'s own page', async () => {
  const h = mainHarness({ repos: [gh('portable')], release: WIN_REL });
  const other = h.wc(h.win.webContents.mainFrame.url); // another window showing the same file
  const strangers = [
    { sender: other, senderFrame: other.mainFrame },
    { sender: h.win.webContents, senderFrame: { url: h.win.webContents.mainFrame.url } }, // a subframe
  ];
  for (const e of strangers) {
    await assert.rejects(async () => h.call('asset:choices', KEY, e), /only the main window can choose a download/);
    await assert.rejects(async () => h.call('asset:choose', { listId: 1, index: 0 }, e), /only the main window can choose a download/);
  }
  // The main window after navigating away from its page.
  const { listId } = await h.call('asset:choices', KEY);
  h.win.webContents.mainFrame.url = 'https://evil.invalid/';
  await assert.rejects(async () => h.call('asset:choose', { listId, index: 0 }), /only the main window/);
  assert.equal(h.saved().repos[0].asset, undefined);
  assert.deepEqual(h.fetched, ['o/App'], 'a refused caller never causes a request');
});

test('asset:choices: the ranked list, in plain words, and nothing that could be sent back but a position', async () => {
  const h = mainHarness({ repos: [gh('portable')], release: WIN_REL });
  const r = await h.call('asset:choices', KEY);
  assert.equal(r.name, 'o/App');
  assert.equal(r.type, 'portable');
  assert.equal(r.system, 'Windows');
  assert.equal(r.version, '1.2.3');
  assert.equal(r.saved, false);
  assert.equal(r.hasAuto, true);
  assert.equal(r.files[0].name, 'App-1.2.3-win-x64.zip');
  assert.equal(r.files[0].auto, true);
  assert.deepEqual(r.files.map((f) => f.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(r.files[0]).sort(), ['auto', 'choosable', 'current', 'index', 'name', 'note', 'size', 'tone']);
  assert.doesNotMatch(JSON.stringify(r), /asset|pattern/i);
  await assert.rejects(async () => h.call('asset:choices', 'nobody/home#portable'), /app not found/);
  await assert.rejects(async () => h.call('asset:choices', { owner: 'o' }), /app not found/);
});

test('asset:choose: saves the picked file with its version as *, and the next release still matches it', async () => {
  const h = mainHarness({ repos: [gh('portable'), { owner: 'other', repo: 'thing', type: 'installer' }], release: WIN_REL });
  const r = await h.call('asset:choices', KEY);
  const arm = r.files.find((f) => f.name === 'App-1.2.3-win-arm64.zip');
  assert.equal(arm.choosable, true);
  const done = await h.call('asset:choose', { listId: r.listId, index: arm.index });
  assert.equal(done.file, 'App-1.2.3-win-arm64.zip');
  const cfg = h.saved();
  assert.equal(cfg.repos[0].asset, 'App-*-win-arm64.zip');
  assert.equal(cfg.repos[1].asset, undefined, 'no other app is touched');
  assert.ok(fs.readdirSync(h.dir).some((f) => /config\.json\..*\.bak$/.test(f)), 'saved the way every config change is, with a backup');
  const next = { tag_name: 'v1.3.0', assets: A(WIN.map((a) => a.name.replace('1.2.3', '1.3.0'))) };
  assert.equal(sources.selectAsset(cfg.repos[0], next, { platform: 'win32', arch: 'x64' }).name, 'App-1.3.0-win-arm64.zip');
  // Opening the chooser again shows it as the user's choice, beside the automatic pick.
  const again = await h.call('asset:choices', KEY);
  assert.equal(again.saved, true);
  assert.equal(again.files.find((f) => f.current).name, 'App-1.2.3-win-arm64.zip');
  assert.equal(again.files.find((f) => f.auto).name, 'App-1.2.3-win-x64.zip');
});

test('asset:choose: takes a position in the list main is holding, and nothing else', async () => {
  const h = mainHarness({ repos: [gh('portable')], release: WIN_REL });
  await assert.rejects(async () => h.call('asset:choose', { listId: 1, index: 0 }), /no longer current/, 'before any list exists');
  const first = await h.call('asset:choices', KEY);
  const second = await h.call('asset:choices', KEY);
  await assert.rejects(async () => h.call('asset:choose', { listId: first.listId, index: 0 }), /no longer current/, 'an older list');
  for (const index of [-1, 99, 1.5, '0', 'App-1.2.3.dmg', undefined, { name: 'x' }]) {
    await assert.rejects(async () => h.call('asset:choose', { listId: second.listId, index }), /that file is not in the list/, String(index));
  }
  await assert.rejects(async () => h.call('asset:choose', undefined), /no longer current/);
  // A file of the other package type is listed but cannot be chosen; the refusal says why.
  const msi = second.files.find((f) => f.name === 'App-1.2.3.msi');
  await assert.rejects(async () => h.call('asset:choose', { listId: second.listId, index: msi.index }), /An installer, and this app is tracked as Portable/);
  assert.equal(h.saved().repos[0].asset, undefined, 'nothing was saved by any refusal');
  // One list, one choice: a second use of the same list is refused.
  await h.call('asset:choose', { listId: second.listId, index: 0 });
  await assert.rejects(async () => h.call('asset:choose', { listId: second.listId, index: 1 }), /no longer current/);
  assert.equal(h.saved().repos[0].asset, 'App-*-win-x64.zip');
});

test('asset:choose: a choice that would match no file, or more than one, is refused rather than saved', async () => {
  // Two files with one name: no saved form can select just one of them.
  const twins = [...A(['tool-2.0-win64.zip']), { name: 'tool-2.0-win64.zip', size: 5, browser_download_url: 'https://files.example/other/tool-2.0-win64.zip' }];
  const h = mainHarness({ repos: [gh('portable')], release: { tag_name: '2.0', assets: twins } });
  const r = await h.call('asset:choices', KEY);
  assert.deepEqual(r.files.map((f) => f.choosable), [false, false]);
  await assert.rejects(async () => h.call('asset:choose', { listId: r.listId, index: 0 }), /has the same name/);
  assert.equal(h.saved().repos[0].asset, undefined);
  // The save itself proves the choice once more. If, at that moment, what would be saved
  // matched no file, several files, or a different file, it is refused and nothing is written.
  const p = mainHarness({ repos: [gh('portable')], release: WIN_REL });
  for (const select of [
    (entry) => core.matchAsset(WIN, `${entry.asset}.nothing`), // matches no file
    () => core.matchAsset(WIN, '*.zip'), // matches two
    () => WIN[4], // some other file
  ]) {
    const list = await p.call('asset:choices', KEY);
    p.hooks.select = select;
    await assert.rejects(async () => p.call('asset:choose', { listId: list.listId, index: 0 }), /that file can no longer be chosen — open Choose download again/);
    p.hooks.select = null;
    assert.equal(p.saved().repos[0].asset, undefined);
  }
  // The app was removed (or its type changed) while the list was open.
  const g = mainHarness({ repos: [gh('portable')], release: WIN_REL });
  const list = await g.call('asset:choices', KEY);
  fs.writeFileSync(path.join(g.dir, 'config.json'), JSON.stringify({ repos: [gh('installer')] }));
  await assert.rejects(async () => g.call('asset:choose', { listId: list.listId, index: 0 }), /app not found/);
  assert.equal(g.saved().repos[0].asset, undefined);
});

test('asset:choose: index null goes back to the automatic pick', async () => {
  const h = mainHarness({ repos: [gh('portable', 'App-*-win-arm64.zip')], release: WIN_REL });
  const r = await h.call('asset:choices', KEY);
  assert.equal(r.saved, true);
  assert.equal((await h.call('asset:choose', { listId: r.listId, index: null })).file, null);
  assert.equal('asset' in h.saved().repos[0], false);
});

test('asset:choices: WinGet and Homebrew are refused before any request; the row is told not to offer it', async () => {
  const repos = [
    gh('portable'),
    { type: 'installer', name: 'VLC', source: { type: 'winget', packageId: 'VideoLAN.VLC' } },
    { type: 'portable', name: 'VLC', source: { type: 'brew', token: 'vlc' } },
    { type: 'portable', name: 'Forgejo', source: GITEA },
    { type: 'portable', name: 'Inkscape', source: GITLAB },
    { type: 'portable', name: 'Blender', source: FOLDER },
  ].map((r) => sources.normalizeEntry(r));
  const h = mainHarness({ repos, release: WIN_REL });
  const keyOf = (r) => `${r.owner}/${r.repo}#${r.type}`;
  await assert.rejects(async () => h.call('asset:choices', keyOf(repos[1])), /WinGet names the one file for this app itself, so there is no list to choose from/);
  await assert.rejects(async () => h.call('asset:choices', keyOf(repos[2])), /Homebrew names the one file for this app itself/);
  assert.deepEqual(h.fetched, []);
  const described = h.handlers['sources:describe']();
  assert.deepEqual(repos.map((r) => described[keyOf(r)].canChoose), [true, false, false, true, true, true]);
  // A vendor folder goes all the way through.
  const key = keyOf(repos[5]);
  const g = mainHarness({ repos, release: { tag_name: '5.3.0', assets: BLENDER } });
  const r = await g.call('asset:choices', key);
  assert.equal(r.name, 'Blender');
  assert.deepEqual(r.files.filter((f) => f.choosable).map((f) => f.name), ['blender-5.3.0-windows-x64.zip']);
  await g.call('asset:choose', { listId: r.listId, index: 0 });
  assert.equal(g.saved().repos[5].asset, 'blender-*-windows-x64.zip');
});

test('asset:preview: says whose pick it is, and answers "needs a choice" instead of rejecting', async () => {
  const h = mainHarness({ repos: [gh('portable'), { owner: 'o', repo: 'Pinned', type: 'portable', asset: 'App-*-win-arm64.zip' }, { owner: 'o', repo: 'Stale', type: 'portable', asset: 'App-*-win-ia32.zip' }], release: WIN_REL });
  const auto = await h.call('asset:preview', KEY);
  assert.equal(auto.asset, 'App-1.2.3-win-x64.zip');
  assert.equal(auto.chosen, false);
  const pinned = await h.call('asset:preview', 'o/Pinned#portable');
  assert.equal(pinned.asset, 'App-1.2.3-win-arm64.zip');
  assert.equal(pinned.chosen, true);
  const stale = await h.call('asset:preview', 'o/Stale#portable');
  assert.equal(stale.needsChoice, true);
  assert.match(stale.reason, /^your saved download choice fits no file in 1\.2\.3/);
});

test('config:save: a new or edited invalid download choice is rejected; an untouched one does not block other settings', () => {
  const h = mainHarness({ repos: [gh('portable'), { owner: 'o', repo: 'Old', type: 'portable', asset: '/(/' }], release: WIN_REL });
  const cfg = () => h.saved();
  // Newly set to something unreadable.
  const bad = cfg();
  bad.repos[0].asset = '/[/';
  assert.throws(() => h.call('config:save', bad), /app 1: its download choice \("asset"\) is not valid/);
  assert.equal(h.saved().repos[0].asset, undefined);
  for (const asset of ['', 7, {}]) {
    const c = cfg();
    c.repos[0].asset = asset;
    assert.throws(() => h.call('config:save', c), /app 1: its download choice/);
  }
  // The hand-edited bad value already on disk rides along untouched: other settings save.
  const other = cfg();
  other.checkOnOpen = true;
  assert.equal(h.call('config:save', other).ok, true);
  assert.equal(h.saved().checkOnOpen, true);
  // Editing that bad value to another bad value is rejected; to a good one, accepted.
  const worse = cfg();
  worse.repos[1].asset = '/(()/';
  assert.throws(() => h.call('config:save', worse), /app 2: its download choice/);
  const good = cfg();
  good.repos[0].asset = '*-win-x64.zip';
  good.repos[1].asset = '/^App-.*\\.zip$/';
  assert.equal(h.call('config:save', good).ok, true);
  assert.equal(h.saved().repos[0].asset, '*-win-x64.zip');
});
