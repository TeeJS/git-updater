'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
const status = (text, cls) => {
  $('status').textContent = text || '';
  $('status').className = cls || '';
};
const SUM_TEXT = { pinned: 'checksum pinned by the listing', published: 'checksum published', none: 'no checksum published' };
const typeLabel = (type) => type === 'portable' ? 'Portable' : 'Installer';
const MAX_SHOWN = 8;

let generation = 0;
let adding = false;
let addButtons = [];

function lockAdd(on) {
  adding = on;
  // Searches can supersede each other, but fields must stay fixed during a commit.
  for (const id of ['query', 'find', 'prerelease', 'close']) $(id).disabled = on;
  for (const { button, available } of addButtons) button.disabled = on || !available;
}

function resetResults() {
  addButtons = [];
  $('list').replaceChildren();
  $('count').textContent = '';
  return ++generation;
}

async function add(c, id, type, automatic, version) {
  if (adding) return false;
  lockAdd(true);
  status(`Adding ${c.name}…`);
  try {
    const result = await window.api.addResult(id, c.index, type, automatic);
    if (result.added) return true; // Main notifies the parent and closes this window.
    if (version === generation && result.error) status(result.error, 'bad');
    else if (version === generation) status('Choose a source and package type.');
  } catch (e) {
    if (version === generation) status(`Can't add ${c.name} — ${clean(e)}`, 'bad');
  }
  lockAdd(false);
  return false;
}

function card(c, id, version) {
  const box = el('article', 'opt');
  const head = el('div', 'opt-head');
  head.appendChild(el('span', 'opt-name', c.name));
  head.appendChild(el('span', 'src-badge s-' + c.sourceType, c.listedBy));
  if (c.curated) head.appendChild(el('span', 'src-badge', 'Curated'));
  if (c.channel) head.appendChild(el('span', 'src-badge', c.channel));
  if (c.tracked) head.appendChild(el('span', 'src-badge', 'Already tracked'));
  box.appendChild(head);

  const meta = el('div', 'opt-meta', 'Checking what this computer would get…');
  const actions = el('div', 'opt-actions');
  box.append(meta, actions);

  const view = el('button', 'ghost', 'View source ↗');
  view.onclick = async () => {
    if (version !== generation) return;
    try { await window.api.openSourcePage(id, c.index); }
    catch (e) { if (version === generation) status(clean(e), 'bad'); }
  };
  const line = (label, text, cls) => {
    const row = el('span');
    row.append(el('b', null, label + ' '), el('span', cls, text));
    meta.appendChild(row);
  };

  const inspect = async (preview) => {
    try {
      const info = await (preview || window.api.inspectResult(id, c.index));
      if (version !== generation) return;
      meta.replaceChildren();
      line('Listed by', `${info.listedBy}${info.publisher ? ' · publisher ' + info.publisher : ''}`);
      line('Version', info.version);
      if (info.note) line('Note', info.note);
      for (const type of ['installer', 'portable']) {
        const file = info.types[type];
        if (file.ok) {
          line(typeLabel(type), `${file.file} — from ${file.host} — ${SUM_TEXT[file.checksum] || ''}${file.emulated ? ' — not native to this computer, runs under emulation' : ''}`, 'mono');
          if (file.requires?.length) line('Needs', file.requires.join(', '));
        } else {
          line(typeLabel(type), `not available — ${file.reason}`);
        }
        const button = el('button', file.ok ? 'primary' : null, `Add as ${typeLabel(type)}`);
        button.disabled = !file.ok || adding;
        button.onclick = () => { if (version === generation) void add(c, id, type, false, version); };
        addButtons.push({ button, available: file.ok });
        actions.appendChild(button);
      }
    } catch (e) {
      if (version !== generation) return;
      meta.textContent = `Could not read this source — ${clean(e)}`;
    }
    actions.appendChild(view);
  };
  return { box, inspect };
}

async function show(data, version, allowAutoAdd) {
  if (!data || version !== generation) return;
  const { id, text, prerelease, candidates, notes, autoPick, typePreference } = data;
  const list = $('list');
  if (!candidates.length) {
    const empty = el('div', 'empty');
    empty.append(el('b', null, `Nothing found for “${text}”.`),
      el('span', null, "Try the app's exact name, or paste its GitHub or HTTPS download address."));
    list.appendChild(empty);
    notes.forEach((note) => list.appendChild(el('div', 'note', note)));
    status('');
    return;
  }

  status('Choose a source and package type.');
  const preferred = allowAutoAdd && typePreference
    ? candidates.find((c) => c.index === autoPick && !c.tracked) : null;
  let preview;
  if (preferred) {
    status(`Checking ${preferred.name} at ${preferred.listedBy}…`);
    preview = window.api.inspectResult(id, preferred.index);
    const info = await preview.catch(() => null);
    if (version !== generation) return;
    const file = info?.types[typePreference];
    if (file?.ok && !file.emulated) {
      if (await add(preferred, id, typePreference, true, version)) return;
      if (version !== generation) return;
    } else {
      status('Choose a source and package type.');
    }
  }

  const shown = candidates.slice(0, MAX_SHOWN);
  const cards = shown.map((c) => {
    const result = card(c, id, version);
    list.appendChild(result.box);
    return { ...result, candidate: c };
  });
  if (candidates.length > shown.length) {
    list.appendChild(el('div', 'note', `${candidates.length - shown.length} more match. Type more of the name to narrow the results.`));
  }
  notes.forEach((note) => list.appendChild(el('div', 'note', note)));
  $('count').textContent = `${candidates.length} source${candidates.length === 1 ? '' : 's'} found${prerelease ? ' · including beta (pre-release) versions' : ''}`;
  for (const { inspect, candidate } of cards) {
    if (version !== generation) return;
    await inspect(candidate === preferred ? preview : null);
  }
}

function showHandoff(data) {
  const version = resetResults();
  $('query').value = data?.text || '';
  $('prerelease').checked = !!data?.prerelease;
  $('query').focus();
  status('');
  void show(data, version, false);
}

$('search').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (adding) return;
  const text = $('query').value.trim();
  if (!text) {
    status('Enter an app name or address.', 'bad');
    return;
  }
  const version = resetResults();
  status(`Looking for ${text}…`);
  try {
    const data = await window.api.search(text, $('prerelease').checked);
    if (data && version === generation) await show(data, version, true);
  } catch (e) {
    if (version === generation) status(clean(e), 'bad');
  }
});

async function close() {
  if (adding) return;
  try { await window.api.close(); }
  catch (e) { status(clean(e), 'bad'); }
}

$('close').onclick = close;
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') void close(); });
window.api.onSearch(showHandoff);
window.api.getSearch().then((data) => {
  if (!generation) showHandoff(data);
}, (e) => { if (!generation) status(clean(e), 'bad'); });
