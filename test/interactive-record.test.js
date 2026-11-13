'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const runner = require('../src/runner');
const github = require('../src/github');
const detect = require('../src/detect');

test('interactive completion records a date without a tag that masks later uninstall', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-interactive-record-'));
  const statePath = path.join(dir, 'state.json');
  const repo = { owner: 'acme', repo: 'widget', type: 'installer' };
  const key = 'acme/widget#installer';
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const a = main.indexOf("ipcMain.handle('installed:record-completion'");
  const b = main.indexOf("ipcMain.handle('folder:open'", a);
  assert.ok(a >= 0 && b > a);
  let handler;
  const context = {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    readConfig: () => ({ repos: [repo] }),
    detect: { clearCache: () => {}, installedVersion: async () => '152.1.94.117' },
    state: { load: () => ({}), save: (value) => fs.writeFileSync(statePath, JSON.stringify(value)) },
  };
  vm.runInNewContext(main.slice(a, b), context);
  try {
    const result = await handler(null, { appKey: key, fromVersion: '151.1.93.1', wasInstall: false });
    assert.equal(result.lastAction, 'updated');
    const record = JSON.parse(fs.readFileSync(statePath, 'utf8'))[key];
    assert.equal(record.tag, undefined);
    assert.equal(record.version, undefined);
    assert.ok(record.installedAt);

    const realRelease = github.getLatestRelease;
    const realVersion = detect.installedVersion;
    const realClear = detect.clearCache;
    github.getLatestRelease = async () => ({ tag_name: 'v1.94.117', assets: [] });
    detect.installedVersion = async () => null; // app uninstalled outside git-updater
    detect.clearCache = () => {};
    try {
      const { results } = await runner.run({ portableRoot: '', repos: [repo] }, { mode: 'check', statePath });
      assert.equal(results[0].status, 'updated', 'an absent installer still needs installation');
    } finally {
      github.getLatestRelease = realRelease;
      detect.installedVersion = realVersion;
      detect.clearCache = realClear;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
