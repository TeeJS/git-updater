'use strict';

// A mechanical guard against the most repeated mistake in this suite.
//
// Three times in one session a test defaulted a platform to the host: twice by omitting
// the argument, once by passing it in the architecture slot. Each passed on the machine
// that wrote it and failed — or worse, asserted against an empty array — on the other.
// Two were written by whoever had just fixed the previous one.
//
// Care did not catch any of them. What caught them was a machine on the other platform
// running the suite. That is not a mechanism anyone has while writing the test, so this
// is: the platform-sensitive functions must be given their platform EXPLICITLY in tests,
// checked by reading the source rather than by hoping.
//
// Production code deliberately defaults to the host. Only tests are held to this, which
// is why it is a source check and not a runtime assertion.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const PLATFORMS = new Set(["'win32'", "'darwin'", "'linux'", '"win32"', '"darwin"', '"linux"']);

// Split a call's argument text on top-level commas, ignoring those inside nested
// brackets or string literals.
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

// Every call to `name(` in `src`, with its argument list already split.
function callsTo(src, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let quote = null;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === quote && src[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    }
    out.push({ args: splitArgs(src.slice(start, i - 1)), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

const testFiles = () =>
  fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(TEST_DIR, f), 'utf8') }));

test('tests must pass the platform explicitly, never inherit the host', () => {
  // name -> the argument index that carries the platform, and how many args that needs.
  const RULES = [
    { name: 'pickAsset', index: 4 },
    { name: 'parseSystemProfiler', index: 1 },
    { name: 'matchInstalled', index: 2 },
  ];
  const bad = [];
  for (const { file, src } of testFiles()) {
    for (const { name, index } of RULES) {
      for (const call of callsTo(src, name)) {
        if (call.args.length <= index || !call.args[index]) {
          bad.push(`${file}:${call.line} ${name}() has no platform argument (slot ${index})`);
        }
      }
    }
  }
  assert.deepEqual(bad, [], `platform-inheriting calls:\n${bad.join('\n')}`);
});

test('tests must not put the platform in the architecture slot', () => {
  // pickAsset(assets, type, arch, flavor, platform). 'darwin' passed third is read as an
  // architecture, the platform silently falls back to the host, and the assertion then
  // checks the wrong table. That is not a missing argument, so the check above misses it.
  const bad = [];
  for (const { file, src } of testFiles()) {
    for (const call of callsTo(src, 'pickAsset')) {
      if (call.args.length > 2 && PLATFORMS.has(call.args[2])) {
        bad.push(`${file}:${call.line} pickAsset() has ${call.args[2]} in the arch slot`);
      }
    }
  }
  assert.deepEqual(bad, [], `platform in the wrong parameter:\n${bad.join('\n')}`);
});

test('the guard can actually see a violation', () => {
  // A guard that never fires is indistinguishable from one that cannot. Prove the parser
  // finds both shapes in text it has never been run against.
  const sample = [
    "core.pickAsset(assets, 'portable');",
    "core.pickAsset(assets, 'installer', 'darwin');",
    "mac.parseSystemProfiler(json);",
    "matchInstalled(rows, new Set());",
  ].join('\n');

  assert.equal(callsTo(sample, 'pickAsset')[0].args.length, 2, 'sees a two-argument call');
  assert.ok(PLATFORMS.has(callsTo(sample, 'pickAsset')[1].args[2]), 'sees a platform in the arch slot');
  assert.equal(callsTo(sample, 'parseSystemProfiler')[0].args.length, 1);
  assert.equal(callsTo(sample, 'matchInstalled')[0].args.length, 2);

  // ...and that it does not fire on correct calls, or the suite becomes noise.
  const ok = "core.pickAsset(assets, 'portable', 'x64', null, 'linux');";
  const c = callsTo(ok, 'pickAsset')[0];
  assert.equal(c.args.length, 5);
  assert.ok(!PLATFORMS.has(c.args[2]));
});
