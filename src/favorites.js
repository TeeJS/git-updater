'use strict';

// The favorites file: a person's own apps and packs, hand-written, slipped into the Popular
// apps window beside the built-in list.
//
//   <config dir>/favorites.yaml      (YAML; JSON is valid YAML, so that works too)
//
//   apps:
//     - VLC media player              an app already in Popular apps: pins it to "My favorites"
//     - sharkdp/fd                    any GitHub project, as owner/repo
//     - name: My Tool                 anything else: a name and at least one source
//       category: My tools            (optional; "My favorites" when left out)
//       description: What it is for   (optional; one line, shown when the app is hovered over)
//       repo: someone/my-tool         GitHub
//       winget: Vendor.MyTool         Windows
//       brew: my-tool                 macOS
//       site: https://example.org/downloads/my-tool/     a vendor's download folder
//   packs:
//     - name: Work laptop
//       description: What goes on every work machine
//       apps: [VLC media player, 7-Zip, My Tool, someone/other-tool]
//
// git-updater READS this file and never writes it (it only creates the commented starter the
// first time it is opened from Settings), so the same file can be copied between machines or
// kept under version control without the app fighting anyone's edits.
//
// It is the user's own file, but it is still parsed as data and nothing more. A row can name
// an app and where it comes from — the same identity fields the built-in list has — and
// nothing else: no install switches, no paths, no commands. Every app it names still goes
// through the picker's review step before it is added.
//
// Nothing here throws on a bad file. A row that cannot be used is skipped and explained in
// `problems`, in words a person can act on; the rest of the file still loads.

const yaml = require('js-yaml');

const FILE_NAME = 'favorites.yaml';
const MAX_BYTES = 256 * 1024;
const MAX_APPS = 500;
const MAX_PACKS = 100;
const MAX_PACK_APPS = 200;
const DEFAULT_CATEGORY = 'My favorites';
const MAX_DESCRIPTION = 100; // one line, shown as the app's tooltip in Popular apps
const PLATFORMS = ['win32', 'darwin', 'linux'];
// The names people use for a platform, to the one the app uses.
const PLATFORM_NAMES = new Map([
  ['win32', 'win32'], ['windows', 'win32'], ['win', 'win32'],
  ['darwin', 'darwin'], ['mac', 'darwin'], ['macos', 'darwin'], ['osx', 'darwin'],
  ['linux', 'linux'],
]);

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/.*)?$/i;
const WINGET = /^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)+$/;
const BREW = /^[a-z0-9][a-z0-9+@._-]*$/;
const APP_FIELDS = new Set(['name', 'category', 'description', 'aliases', 'repo', 'winget', 'brew', 'site', 'platforms', 'type']);
const PACK_FIELDS = new Set(['name', 'description', 'apps']);

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One line about an app, at most MAX_DESCRIPTION characters. A longer one is cut (and said
// so) rather than dropped: the person wrote it to be seen.
function descriptionOf(raw, at, problem) {
  if (raw == null) return '';
  if (typeof raw !== 'string' && typeof raw !== 'number') return problem(at, 'description must be one line of text — it was ignored'), '';
  const text = clean(raw, 2000).replace(/\s+/g, ' ');
  if (text.length <= MAX_DESCRIPTION) return text;
  problem(at, `description is longer than ${MAX_DESCRIPTION} characters and was shortened`);
  return `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

// "owner/repo" or a github.com address -> "owner/repo", else null.
function repoOf(text) {
  const s = String(text || '').trim();
  if (REPO.test(s)) return s;
  const m = GITHUB_URL.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}

// A vendor download folder: https only, no credentials, no query — the same rule the
// "Vendor site" source applies when it is used.
function siteOf(text) {
  try {
    const u = new URL(String(text || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return `https://${u.host.toLowerCase()}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`;
  } catch {
    return null;
  }
}

// opts.find(name) -> the built-in app that name means ({ id, name }), or null. It is how
// "VLC" in this file comes to mean the app already in the list instead of a new one.
//
// -> { apps, pins, packs, problems }
//    apps      new apps:   [{ id, name, category, description?, aliases, repo?, winget?, brew?, site?, platforms?, type? }]
//    pins      ids of built-in apps the file lists, in order — shown under "My favorites" too
//    notes     { id: description } for the pinned apps that were given one
//    packs     [{ name, description, apps: [{ id } | { name, source }] }]
//    problems  [string], one per thing that was skipped or ignored
function parse(text, opts = {}) {
  const find = typeof opts.find === 'function' ? opts.find : () => null;
  const out = { apps: [], pins: [], notes: {}, packs: [], problems: [] };
  const problem = (where, what) => out.problems.push(`${where}: ${what}`);

  if (typeof text !== 'string' || !text.trim()) return out;
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    out.problems.push(`${FILE_NAME} is too large to read (limit ${MAX_BYTES / 1024} KB)`);
    return out;
  }
  let doc;
  try {
    doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    const line = e && e.mark && Number.isInteger(e.mark.line) ? `line ${e.mark.line + 1}: ` : '';
    out.problems.push(`${FILE_NAME} could not be read — ${line}${String((e && e.reason) || (e && e.message) || e).split('\n')[0]}`);
    return out;
  }
  if (doc == null) return out; // comments only: the untouched starter file
  if (!isMap(doc)) {
    out.problems.push(`${FILE_NAME} must start with "apps:" and/or "packs:"`);
    return out;
  }
  for (const key of Object.keys(doc)) if (key !== 'apps' && key !== 'packs') problem(FILE_NAME, `"${key}:" is not something this file can hold — only "apps:" and "packs:" are read`);

  // --- apps ---------------------------------------------------------------------
  const byId = new Map(); // every app this file can name, built-in or its own: id -> { id, name }
  const ownIds = new Set();
  const rawApps = doc.apps == null ? [] : doc.apps;
  if (!Array.isArray(rawApps)) problem('apps', 'must be a list (each entry on its own line starting with "- ")');
  (Array.isArray(rawApps) ? rawApps : []).slice(0, MAX_APPS).forEach((raw, i) => {
    const where = `app ${i + 1}`;
    const app = appRow(raw, where, find, problem);
    if (!app) return;
    if (app.pin) {
      if (!out.pins.includes(app.pin.id)) out.pins.push(app.pin.id);
      if (app.pin.description) out.notes[app.pin.id] = app.pin.description;
      byId.set(app.pin.id, app.pin);
      return;
    }
    if (ownIds.has(app.id)) return problem(`${where} ("${app.name}")`, 'is listed twice — the second one was skipped');
    ownIds.add(app.id);
    byId.set(app.id, { id: app.id, name: app.name });
    out.apps.push(app);
  });
  if (Array.isArray(rawApps) && rawApps.length > MAX_APPS) problem('apps', `only the first ${MAX_APPS} are read`);

  // --- packs --------------------------------------------------------------------
  // A pack names an app the way the "apps:" list does: by name or alias, or by its repository.
  const own = new Map(out.apps.flatMap((a) => [a.name, ...a.aliases].map((n) => [squash(n), a])));
  const ownByRepo = new Map(out.apps.filter((a) => a.repo).map((a) => [a.repo.toLowerCase(), a]));
  const rawPacks = doc.packs == null ? [] : doc.packs;
  if (!Array.isArray(rawPacks)) problem('packs', 'must be a list (each entry on its own line starting with "- ")');
  const packNames = new Set();
  (Array.isArray(rawPacks) ? rawPacks : []).slice(0, MAX_PACKS).forEach((raw, i) => {
    const where = `pack ${i + 1}`;
    if (!isMap(raw)) return problem(where, 'needs a "name:" and an "apps:" list');
    const name = clean(raw.name, 80);
    if (!name) return problem(where, 'has no "name:"');
    const at = `${where} ("${name}")`;
    for (const key of Object.keys(raw)) if (!PACK_FIELDS.has(key)) problem(at, `"${key}:" is not a pack field and was ignored`);
    if (packNames.has(name.toLowerCase())) return problem(at, 'has the same name as an earlier pack — it was skipped');
    if (!Array.isArray(raw.apps) || !raw.apps.length) return problem(at, 'needs an "apps:" list');
    const refs = [];
    const seen = new Set();
    raw.apps.slice(0, MAX_PACK_APPS).forEach((item) => {
      const label = clean(item, 120);
      if (!label || isMap(item) || Array.isArray(item)) return problem(at, 'lists something that is not an app name or owner/repo — it was skipped');
      const named = repoOf(label);
      const mine = own.get(squash(label)) || (named && ownByRepo.get(named.toLowerCase()));
      const builtin = mine ? null : find(label) || (named && find(named));
      const repo = mine || builtin ? null : named;
      let ref;
      if (mine) ref = { id: mine.id };
      else if (builtin) ref = { id: builtin.id };
      else if (repo) ref = { name: repo.split('/')[1], source: { type: 'github', owner: repo.split('/')[0], repo: repo.split('/')[1] } };
      else return problem(at, `"${label}" is not an app in Popular apps or in this file, and not an owner/repo — it was skipped`);
      const key = JSON.stringify(ref);
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(ref);
    });
    if (raw.apps.length > MAX_PACK_APPS) problem(at, `only the first ${MAX_PACK_APPS} apps are read`);
    if (!refs.length) return problem(at, 'lists no app that could be read — it was skipped');
    packNames.add(name.toLowerCase());
    out.packs.push({ name, description: clean(raw.description, 300), apps: refs });
  });
  if (Array.isArray(rawPacks) && rawPacks.length > MAX_PACKS) problem('packs', `only the first ${MAX_PACKS} are read`);
  return out;
}

// One entry of "apps:" -> { pin: { id, name } } | a new app row | null (skipped, explained).
function appRow(raw, where, find, problem) {
  // A bare line: the name of an app already in the list, or a GitHub owner/repo.
  if (typeof raw === 'string' || typeof raw === 'number') {
    const label = clean(raw, 120);
    if (!label) return null;
    const known = find(label);
    if (known) return { pin: { id: known.id, name: known.name } };
    const repo = repoOf(label);
    const sameRepo = repo && find(repo); // a github.com address of a built-in app is that app
    if (sameRepo) return { pin: { id: sameRepo.id, name: sameRepo.name } };
    if (repo) return newApp({ name: repo.split('/')[1], repo }, where, find, problem);
    problem(`${where} ("${label}")`, 'is not an app in Popular apps and not a GitHub owner/repo — to add something new, give it "name:" and a source (repo, winget, brew or site)');
    return null;
  }
  if (!isMap(raw)) {
    problem(where, 'is not an app — write a name, an owner/repo, or "name:" with a source');
    return null;
  }
  return newApp(raw, where, find, problem);
}

function newApp(raw, where, find, problem) {
  const repo = raw.repo == null ? null : repoOf(raw.repo);
  const name = clean(raw.name, 120) || (repo ? repo.split('/')[1] : '');
  const at = name ? `${where} ("${name}")` : where;
  if (!name) return problem(at, 'has no "name:"'), null;
  for (const key of Object.keys(raw)) if (!APP_FIELDS.has(key)) problem(at, `"${key}:" is not an app field and was ignored`);

  // Each source is checked on its own: one bad field costs that source, not the whole app.
  const app = { name };
  if (raw.repo != null) {
    if (repo) app.repo = repo;
    else problem(at, `repo "${clean(raw.repo, 80)}" is not a GitHub owner/repo`);
  }
  if (raw.winget != null) {
    const id = clean(raw.winget, 128);
    if (WINGET.test(id)) app.winget = id;
    else problem(at, `winget "${id}" is not a WinGet package id (they look like VideoLAN.VLC)`);
  }
  if (raw.brew != null) {
    const token = clean(raw.brew, 100);
    if (BREW.test(token)) app.brew = token;
    else problem(at, `brew "${token}" is not a Homebrew cask name (they look like visual-studio-code)`);
  }
  if (raw.site != null) {
    const url = siteOf(raw.site);
    if (url) app.site = url;
    else problem(at, 'site must be an https:// address of a download folder, with no ? or # in it');
  }
  const description = descriptionOf(raw.description, at, problem);
  if (!app.repo && !app.winget && !app.brew && !app.site) {
    // A name with no source of its own that IS a built-in app: the person meant to pin it
    // (and may be giving it their own description).
    const known = Object.keys(raw).some((k) => k !== 'name' && k !== 'category' && k !== 'description') ? null : find(name);
    if (known) return { pin: { id: known.id, name: known.name, description } };
    return problem(at, 'needs a source — add repo, winget, brew or site'), null;
  }
  const taken = find(name);
  if (taken) {
    problem(at, `is already in Popular apps as "${taken.name}", so it was pinned to My favorites and the sources written here were not used`);
    return { pin: { id: taken.id, name: taken.name, description } };
  }
  if (description) app.description = description;

  app.id = `fav${squash(name)}`;
  if (app.id === 'fav') return problem(at, 'needs a name with at least one letter or digit'), null;
  app.category = clean(raw.category, 60) || DEFAULT_CATEGORY;
  app.aliases = (Array.isArray(raw.aliases) ? raw.aliases : []).map((a) => clean(a, 80)).filter(Boolean).slice(0, 12);
  if (raw.aliases != null && !Array.isArray(raw.aliases)) problem(at, 'aliases must be a list and was ignored');
  if (raw.platforms != null) {
    const list = (Array.isArray(raw.platforms) ? raw.platforms : [raw.platforms]).map((p) => PLATFORM_NAMES.get(clean(p, 20).toLowerCase()));
    if (list.length && list.every(Boolean)) app.platforms = PLATFORMS.filter((p) => list.includes(p));
    else problem(at, 'platforms can list windows, mac and linux — it was ignored');
  }
  if (raw.type != null) {
    const type = clean(raw.type, 20).toLowerCase();
    if (type === 'installer' || type === 'portable') app.type = type;
    else problem(at, 'type can be installer or portable — it was ignored');
  }
  return app;
}

// The file git-updater creates the first time Favorites is opened from Settings. Everything
// in it is a comment, so it changes nothing until it is edited.
const STARTER = `# git-updater favorites
#
# Your own apps and packs, added to the Popular apps window beside the built-in list.
# Lines starting with # are ignored. Remove the "# " in front of an example to use it,
# keeping the spaces that are left: the indentation matters.
#
# git-updater only reads this file. Copy it to another computer and your favorites are there too.
# Full reference: https://github.com/TeeJS/git-updater#favorites

apps:
  # An app that is already in Popular apps: just its name. It is pinned to "My favorites".
  # - VLC media player

  # The same, with your own one-line description for it.
  # - name: 7-Zip
  #   description: Opens every archive anyone sends me

  # Any GitHub project: owner/repo.
  # - sharkdp/fd

  # Anything else: give it a name and at least one place it comes from.
  # - name: My Tool
  #   category: My tools                 # optional. Left out, the app goes in "My favorites".
  #   description: What it is for        # optional. One line, up to 100 characters, shown when you hover over the app.
  #   repo: someone/my-tool              # a GitHub project
  #   winget: Vendor.MyTool              # a WinGet package id (Windows)
  #   brew: my-tool                      # a Homebrew cask name (Mac)
  #   site: https://example.org/downloads/my-tool/     # a vendor's download folder
  #   platforms: [windows, mac, linux]   # optional. Left out, it is offered wherever it has a source.
  #   type: installer                    # optional: installer or portable. Left out, your setting decides.

packs:
  # A named set of apps, added in one go from the Packs tab. Name each app the way it is
  # named above or in Popular apps, or give an owner/repo.
  # - name: Work laptop
  #   description: What goes on every work computer
  #   apps: [VLC media player, 7-Zip, My Tool, sharkdp/fd]
`;

// The line to paste under "apps:" for an app already being tracked.
//   entry: { name?, owner, repo, source? } as stored in config.json
//   known: the built-in app this entry is, if any ({ name })
// -> YAML text, or null when the entry's source is one this file cannot name.
function rowFor(entry, known) {
  const q = (s) => (/^[A-Za-z0-9][A-Za-z0-9 ._+()/-]*$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s) && !/^[\d.+-]+$/.test(s) ? s : JSON.stringify(s));
  if (known && known.name) return `  - ${q(known.name)}\n`;
  const src = entry && entry.source;
  if (!src) return entry && entry.owner && entry.repo && REPO.test(`${entry.owner}/${entry.repo}`) ? `  - ${entry.owner}/${entry.repo}\n` : null;
  const name = clean(entry.name, 120);
  if (!name) return null;
  const field = src.type === 'winget' && src.packageId ? ['winget', src.packageId]
    : src.type === 'brew' && src.token ? ['brew', src.token]
      : src.type === 'folder' && src.url ? ['site', src.url]
        : null;
  return field ? `  - name: ${q(name)}\n    ${field[0]}: ${q(String(field[1]))}\n` : null;
}

module.exports = { FILE_NAME, DEFAULT_CATEGORY, MAX_BYTES, MAX_DESCRIPTION, STARTER, parse, rowFor, repoOf, siteOf };
