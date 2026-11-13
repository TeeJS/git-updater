'use strict';

// The grey text colours must stay readable on the dark surfaces they sit on (WCAG AA, 4.5:1 for
// normal-size text). --faint was #6e7681 (3.5:1 on the panel's lower edge); this keeps it from
// drifting back, and keeps it visibly dimmer than --muted so the hierarchy survives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
const vars = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the colour variables were found', () => {
  for (const name of ['bg', 'panel', 'panel-2', 'muted', 'faint']) assert.ok(vars[name], `--${name} parsed`);
});

for (const grey of ['muted', 'faint']) {
  for (const surface of ['bg', 'panel', 'panel-2']) {
    test(`--${grey} is at least 4.5:1 on --${surface}`, () => {
      const ratio = contrast(vars[grey], vars[surface]);
      assert.ok(ratio >= 4.5, `--${grey} ${vars[grey]} on --${surface} ${vars[surface]} is ${ratio.toFixed(2)}:1`);
    });
  }
}

test('--faint stays dimmer than --muted, which stays dimmer than --text', () => {
  assert.ok(luminance(vars.faint) < luminance(vars.muted));
  assert.ok(luminance(vars.muted) < luminance(vars.text));
});
