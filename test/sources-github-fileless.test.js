'use strict';

// A GitHub project that attaches its files to only SOME releases. The real case is
// tesseract-ocr/tesseract: of 37 releases, only 5.5.0 and 5.5.3 carry the Windows installer;
// 5.5.4, the latest, has no files at all. Taking the latest release alone, the row offered an
// update that could never install ("no Windows installer asset in release. Assets: (none)").
//
// The newest release that HAS a file for this machine is used instead, and the release that
// was passed over is named so the row can say so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../src/sources');
const github = require('../src/github');

const exe = (v, stamp) => ({
  name: `tesseract-ocr-w64-setup-${v}.${stamp}.exe`,
  browser_download_url: `https://github.com/tesseract-ocr/tesseract/releases/download/${v}/tesseract-ocr-w64-setup-${v}.${stamp}.exe`,
});
const release = (tag, assets = [], more = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets, html_url: `https://github.com/tesseract-ocr/tesseract/releases/tag/${tag}`, ...more });

// The shape of the real repository on 2026-11-23, newest first.
const TESSERACT = [
  release('5.5.4'),
  release('5.5.3', [exe('5.5.3', '20260724')]),
  release('5.5.2'),
  release('5.5.1'),
  release('5.5.0', [exe('5.5.0', '20241111')]),
];

// Serves /releases/latest and the /releases list from `list`, and records every request.
async function withReleases(list, fn, { latest } = {}) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const body = /\/releases\/latest$/.test(url) ? (latest || list.find((r) => !r.draft && !r.prerelease)) : list;
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = orig;
  }
}

const entry = { owner: 'tesseract-ocr', repo: 'tesseract', type: 'installer' };
const win = () => sources.makeCtx({ platform: 'win32', arch: 'x64' });

test('tesseract: the latest release has no files, so the newest release with an installer is used', async () => {
  await withReleases(TESSERACT, async (calls) => {
    const rel = await sources.getLatestRelease(entry, win());
    assert.equal(rel.tag_name, '5.5.3');
    assert.deepEqual(rel.skipped, { tag: '5.5.4', url: 'https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.4' });
    assert.equal(calls.length, 2, 'the latest release, then ONE look further back');
    // And it is the release an install would really use.
    assert.equal(sources.selectAsset(entry, rel, { platform: 'win32', arch: 'x64' }).name, 'tesseract-ocr-w64-setup-5.5.3.20260724.exe');
    assert.equal(rel.provenance.listingUrl, 'https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3', 'the row links to the release it uses');
  });
});

test('a latest release that has a file is used as before: no second request, nothing passed over', async () => {
  await withReleases(TESSERACT.slice(1), async (calls) => {
    const rel = await sources.getLatestRelease(entry, win());
    assert.equal(rel.tag_name, '5.5.3');
    assert.equal(rel.skipped, undefined);
    assert.equal(calls.length, 1);
  });
});

test('no recent release has a file: the latest stands and fails with the message it always gave', async () => {
  await withReleases([release('5.5.4'), release('5.5.2'), release('5.5.1')], async () => {
    const rel = await sources.getLatestRelease(entry, win());
    assert.equal(rel.tag_name, '5.5.4');
    assert.equal(rel.skipped, undefined);
    assert.throws(() => sources.selectAsset(entry, rel, { platform: 'win32', arch: 'x64' }), /no Windows installer asset in release/);
  });
});

test('a release that ships only the OTHER package type is kept: the "change its type" path is untouched', async () => {
  const zip = { name: 'tool-win-x64.zip', browser_download_url: 'https://github.com/o/r/releases/download/2.0/tool-win-x64.zip' };
  await withReleases([release('2.0', [zip]), release('1.0', [exe('1.0', '1')])], async (calls) => {
    const rel = await sources.getLatestRelease({ owner: 'o', repo: 'r', type: 'installer' }, win());
    assert.equal(rel.tag_name, '2.0', 'not sent back to 1.0 for its installer');
    assert.equal(rel.skipped, undefined);
    assert.equal(calls.length, 1);
  });
});

test('a pinned file pattern that stopped matching is kept too: that is "Choose a download", not an old release', async () => {
  const renamed = { name: 'tool-setup-x64.exe', browser_download_url: 'https://github.com/o/r/releases/download/2.0/tool-setup-x64.exe' };
  const pinned = { owner: 'o', repo: 'r', type: 'installer', asset: 'tool-installer-*.exe' };
  await withReleases([release('2.0', [renamed]), release('1.0', [{ ...renamed, name: 'tool-installer-1.0.exe' }])], async (calls) => {
    const rel = await sources.getLatestRelease(pinned, win());
    assert.equal(rel.tag_name, '2.0');
    assert.equal(calls.length, 1);
  });
  // With a pattern AND a latest release that has nothing at all, the earlier release is still found.
  await withReleases([release('2.0'), release('1.0', [{ ...renamed, name: 'tool-installer-1.0.exe' }])], async () => {
    const rel = await sources.getLatestRelease(pinned, win());
    assert.equal(rel.tag_name, '1.0');
    assert.equal(rel.skipped.tag, '2.0');
  });
});

test('looking back obeys the entry: drafts never, prereleases only when asked for, and only its tag prefix', async () => {
  const list = [
    release('3.0'),
    release('3.0-rc1', [exe('3.0-rc1', '1')], { prerelease: true }),
    release('2.9', [exe('2.9', '1')], { draft: true }),
    release('other-2.8', [exe('2.8', '1')]),
    release('2.7', [exe('2.7', '1')]),
  ];
  await withReleases(list, async () => {
    assert.equal((await sources.getLatestRelease(entry, win())).tag_name, 'other-2.8', 'stable only: the rc and the draft are passed');
    assert.equal((await sources.getLatestRelease({ ...entry, prerelease: true }, win())).tag_name, '3.0-rc1');
  });
  await withReleases(list.map((r) => ({ ...r, tag_name: r.tag_name.startsWith('other-') ? r.tag_name : `app-${r.tag_name}` })), async () => {
    assert.equal((await sources.getLatestRelease({ ...entry, tagPrefix: 'app-' }, win())).tag_name, 'app-2.7');
  });
});

test('if the look back fails, the latest release stands; a rate limit is still heard', async () => {
  const orig = global.fetch;
  const answer = (body, status = 200, headers = {}) => ({ status, ok: status === 200, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body });
  try {
    global.fetch = async (url) => (/\/releases\/latest$/.test(url) ? answer(release('5.5.4')) : answer({}, 500));
    assert.equal((await sources.getLatestRelease(entry, win())).tag_name, '5.5.4');
    global.fetch = async (url) => (/\/releases\/latest$/.test(url) ? answer(release('5.5.4')) : answer({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }));
    await assert.rejects(() => sources.getLatestRelease(entry, win()), (e) => e.rateLimited === true);
  } finally {
    global.fetch = orig;
  }
});

test('findRecentRelease asks GitHub once, for the 30 most recent releases', async () => {
  await withReleases(TESSERACT, async (calls) => {
    const hit = await github.findRecentRelease('tesseract-ocr', 'tesseract', {}, (r) => r.assets.length > 0);
    assert.equal(hit.tag_name, '5.5.3');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/repos\/tesseract-ocr\/tesseract\/releases\?per_page=30$/);
  });
});

// --- the row is told ---------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const detect = require('../src/detect');
const runner = require('../src/runner');

test('a check says which release was passed over, whether the app is up to date or not installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-fileless-'));
  const real = { installedVersion: detect.installedVersion, clearCache: detect.clearCache };
  detect.clearCache = () => {};
  try {
    await withReleases(TESSERACT, async () => {
      // Installed from the 5.5.3 file (the registry adds the build date): up to date, not "Update".
      detect.installedVersion = async () => '5.5.3.20260724';
      let { results } = await runner.run({ repos: [{ ...entry }] }, { mode: 'check', statePath: path.join(dir, 'state.json') });
      assert.equal(results[0].status, 'current', JSON.stringify(results[0]));
      assert.equal(results[0].to, '5.5.3');
      assert.equal(results[0].newerWithoutFile, '5.5.4');

      // Not installed: 5.5.3 is offered, and the row still knows about 5.5.4.
      detect.installedVersion = async () => null;
      ({ results } = await runner.run({ repos: [{ ...entry }] }, { mode: 'check', statePath: path.join(dir, 'state.json') }));
      assert.equal(results[0].status, 'updated', JSON.stringify(results[0]));
      assert.equal(results[0].to, '5.5.3');
      assert.equal(results[0].newerWithoutFile, '5.5.4');
    });
    // An ordinary app carries no such field.
    await withReleases(TESSERACT.slice(1), async () => {
      const { results } = await runner.run({ repos: [{ ...entry }] }, { mode: 'check', statePath: path.join(dir, 'state.json') });
      assert.equal('newerWithoutFile' in results[0], false);
    });
  } finally {
    Object.assign(detect, real);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the window says it: in the check summary, on the status, and on both version tooltips', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.match(html, /const passedOverNote = \(s\) => \(s\.newerWithoutFile && s\.to/);
  assert.match(html, /passedOver\.push\(`\$\{nameOfKey\(k\)\} \$\{r\.newerWithoutFile\} has no file for this computer, so \$\{r\.to\} is the newest version that can be installed\.`\)/);
  assert.match(html, /const parts = \[\.\.\.passedOver\];/);
  assert.match(html, /if \(s\.to\) av\.title = passedOverNote\(s\) \|\| s\.to;/);
  assert.ok(html.includes('out.title = `${sv.tip || sv.text}\\nCurrent:'), 'the compact line\'s tooltip carries the note');
  assert.ok(html.includes('present: s.present, newerWithoutFile: r.newerWithoutFile || null };'), 'a check sets it, and clears it once the newest release has a file again');
  assert.ok(html.includes('to: r.to, ...(r.newerWithoutFile ? { newerWithoutFile: r.newerWithoutFile } : {}) };'), 'a background result keeps it');
});
