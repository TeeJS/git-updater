'use strict';

// Packs: a named set of apps added in one go.
//
// A pack stores WHICH apps, never which files. Each entry is either a shortcut id from the
// curated list ({ id }) or, for something outside it, a source reference ({ name, source }).
// Versions, URLs and hashes are deliberately absent: applying a pack resolves every app on
// the machine it is applied to, with that user's preferred source and type, so one pack
// sets up Windows, macOS and Linux alike and never goes stale.
//
// Three kinds share this shape:
//   built-in   shipped with the app (BUILTIN below)
//   mine       saved by the user, in <config dir>/packs.json
//   imported   read from a file someone exported — UNTRUSTED. validatePack is the gate:
//              it rebuilds the pack from the fields it recognises and discards the rest,
//              so a pack file can name apps and nothing else. It cannot carry install
//              switches, paths, preferences, URLs to fetch, or code.

const fs = require('fs');
const catalog = require('./catalog');

const FORMAT = 'git-updater-pack';
const MAX_BYTES = 256 * 1024;
const MAX_APPS = 200;

// Ids here must exist in src/shortcuts.json; test/packs.test.js enforces it. An app with
// no source on the current platform simply shows as unavailable when the pack is applied.
const BUILTIN = [
  {
    id: 'essentials',
    name: 'Essentials',
    description: 'A browser, an archiver, a media player, an office suite and a password manager.',
    apps: ['mozillafirefox', 'googlechrome', '7zip', 'theunarchiver', 'vlcmediaplayer', 'libreoffice', 'keepassxc', 'notepad', 'everything'],
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'An editor, Git, a terminal, containers and API tooling.',
    apps: ['visualstudiocode', 'git', 'githubdesktop', 'dockerdesktop', 'postman', 'powershell', 'windowsterminal', 'iterm2', 'notepad', 'putty', 'winscp', 'wireshark'],
  },
  {
    id: 'media',
    name: 'Media and creative',
    description: 'Playback, recording, transcoding, and image, vector and 3D tools.',
    apps: ['vlcmediaplayer', 'obsstudio', 'handbrake', 'audacity', 'blender', 'gimp', 'inkscape', 'krita', 'spotify'],
  },
  {
    id: 'communication',
    name: 'Communication',
    description: 'Meetings, chat and mail.',
    apps: ['zoom', 'discord', 'slack', 'microsoftteams', 'signal', 'telegram', 'thunderbird'],
  },
  {
    id: 'security',
    name: 'Security and privacy',
    description: 'Password managers, a malware scanner and VPN clients.',
    apps: ['keepassxc', 'bitwarden', '1password', 'malwarebytes', 'wireguard', 'tailscale'],
  },
  {
    id: 'ai',
    name: 'AI tools',
    description: 'Desktop assistants and local model runners.',
    apps: ['claude', 'chatgpt', 'ollama', 'lmstudio'],
  },
];

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

// One app reference -> its clean form, or null if it is not one.
// cleanSource(source) -> the source reduced to its provider's own identity fields, or a
// throw if it is not a valid identity (see sources.cleanSource). A pack can therefore
// carry a package id, a cask token, a repository or a project address — and nothing
// beside them.
function cleanRef(ref, cleanSource) {
  if (typeof ref === 'string') ref = { id: ref };
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  if (typeof ref.id === 'string' && /^[a-z0-9]{1,80}$/.test(ref.id)) return { id: ref.id };
  const src = ref.source;
  if (!src || typeof src !== 'object' || Array.isArray(src) || typeof src.type !== 'string') return null;
  const name = text(ref.name, 120);
  if (!name || typeof cleanSource !== 'function') return null;
  try {
    return { name, source: cleanSource(src) };
  } catch {
    return null; // unknown provider, or not a valid identity for it
  }
}

// Rebuild a pack from untrusted input. Throws with a reason a person can act on.
// opts.cleanSource: see cleanRef; opts.id: keep a stored pack's id.
function validatePack(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('that file is not a git-updater pack');
  if (input.format !== FORMAT) throw new Error('that file is not a git-updater pack');
  if (input.version !== 1) throw new Error('this pack was made by a newer git-updater');
  const name = text(input.name, 80);
  if (!name) throw new Error('the pack has no name');
  if (!Array.isArray(input.apps)) throw new Error('the pack lists no apps');
  if (input.apps.length > MAX_APPS) throw new Error(`a pack can hold at most ${MAX_APPS} apps`);
  const apps = [];
  const seen = new Set();
  let dropped = 0;
  for (const raw of input.apps) {
    const ref = cleanRef(raw, opts.cleanSource);
    if (!ref) { dropped++; continue; }
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(ref);
  }
  if (!apps.length) throw new Error('the pack lists no apps this version of git-updater recognises');
  return { format: FORMAT, version: 1, id: opts.id || slug(name), name, description: text(input.description, 300), apps, ...(dropped ? { dropped } : {}) };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'pack';

// Parse the text of an exported pack file.
function parsePackFile(textContent, opts) {
  if (typeof textContent !== 'string' || Buffer.byteLength(textContent, 'utf8') > MAX_BYTES) throw new Error('that file is too large to be a pack');
  let json;
  try {
    json = JSON.parse(textContent);
  } catch {
    throw new Error('that file is not a git-updater pack');
  }
  return validatePack(json, opts);
}

// The exported form: only the fields validatePack reads.
function exportPack(pack) {
  return JSON.stringify({ format: FORMAT, version: 1, name: pack.name, description: pack.description || '', apps: pack.apps }, null, 2) + '\n';
}

// Turn tracked config entries into a pack. An entry whose source is one of a shortcut's
// own sources is stored by shortcut id — so on another platform the pack picks that
// platform's source for the same app — and anything else by its source reference.
function fromEntries(name, description, entries, sourceOf, canonical) {
  const index = new Map();
  for (const app of catalog.apps()) {
    for (const plat of ['win32', 'darwin', 'linux']) {
      for (const s of catalog.sourcesFor(app, plat)) index.set(canonical(s), app.id);
    }
  }
  const apps = [];
  const seen = new Set();
  for (const e of entries) {
    const source = sourceOf(e);
    let ref;
    const id = index.get(canonical(source));
    if (id) ref = { id };
    else ref = { name: e.name || e.repo, source };
    const k = JSON.stringify(ref);
    if (seen.has(k)) continue;
    seen.add(k);
    apps.push(ref);
  }
  return { format: FORMAT, version: 1, id: slug(name), name: text(name, 80), description: text(description, 300), apps };
}

// What each reference means on this machine. No network.
// -> [{ ref, name, appId?, sources: [...], reason? }]
// A shortcut id expands to EVERY source the app has here, ordered (the user's preferred
// source types first, then the default order), so the caller can fall through to the next
// when the first has no build for this machine. An explicit source reference stays pinned
// to exactly that source.
function resolveRefs(pack, platform, preference, knownTypes) {
  return pack.apps.map((ref) => {
    if (ref.id) {
      const app = catalog.appById(ref.id);
      if (!app) return { ref, name: ref.id, sources: [], reason: "not in this version's app list" };
      const all = catalog.orderedSources(app, platform, preference);
      if (!all.length) return { ref, name: app.name, appId: app.id, sources: [], reason: 'not available for this operating system' };
      const usable = all.filter((s) => knownTypes.includes(s.type));
      if (!usable.length) return { ref, name: app.name, appId: app.id, sources: [], reason: 'needs a source this build does not have' };
      return { ref, name: app.name, appId: app.id, sources: usable };
    }
    if (!knownTypes.includes(ref.source.type)) return { ref, name: ref.name, sources: [], reason: 'needs a source this build does not have' };
    return { ref, name: ref.name, sources: [ref.source], pinned: true };
  });
}

function builtin() {
  return BUILTIN.map((p) => ({ format: FORMAT, version: 1, builtin: true, id: p.id, name: p.name, description: p.description, apps: p.apps.map((id) => ({ id })) }));
}

// --- storage: <config dir>/packs.json -------------------------------------------

function loadMine(file, opts) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    try {
      out.push(validatePack(p, { ...opts, id: typeof p.id === 'string' ? slug(p.id) : undefined }));
    } catch {} // a damaged entry is skipped, not fatal
  }
  return out;
}

function saveMine(file, packs) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(packs.map((p) => ({ format: FORMAT, version: 1, id: p.id, name: p.name, description: p.description || '', apps: p.apps })), null, 2));
  fs.renameSync(tmp, file);
}

// Add a pack, ALWAYS as a new entry with an id no other pack has. Nothing is ever
// replaced by this: two different names can reduce to the same id ("Work PC", "work-pc"),
// and an imported file must never overwrite something the user saved. Returns
// { packs, saved } so the caller reports the entry that was actually stored.
function add(packs, pack) {
  const taken = new Set([...BUILTIN.map((b) => b.id), ...packs.map((p) => p.id)]);
  let id = pack.id;
  for (let n = 2; taken.has(id); n++) id = `${pack.id}-${n}`;
  const saved = { ...pack, id };
  return { packs: [...packs, saved], saved };
}

// Save under a name: replaces ONLY a pack with exactly that name (case-insensitively) —
// which is what saving again under the same name means — keeping its id.
function saveNamed(packs, pack) {
  const i = packs.findIndex((p) => p.name.toLowerCase() === pack.name.toLowerCase());
  if (i < 0) return add(packs, pack);
  const saved = { ...pack, id: packs[i].id };
  const next = packs.slice();
  next[i] = saved;
  return { packs: next, saved };
}

module.exports = { FORMAT, BUILTIN, MAX_APPS, MAX_BYTES, validatePack, parsePackFile, exportPack, fromEntries, resolveRefs, builtin, loadMine, saveMine, add, saveNamed, slug };
