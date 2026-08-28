'use strict';

// IO edge (tiny): last-seen-version store, a flat JSON map keyed by "owner/repo".

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultStatePath() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'git-updater', 'state.json');
}

function load(statePath) {
  const p = statePath || defaultStatePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {}; // corrupt -> start fresh (everything re-updates)
  }
}

function save(state, statePath) {
  const p = statePath || defaultStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

module.exports = { load, save, defaultStatePath };
