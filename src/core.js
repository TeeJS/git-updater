'use strict';

// Pure logic, no IO. Every unit test lives against this file.

// ---------------------------------------------------------------------------
// Version compare — ported from open-quake app/appRepo.js cmpVersion(), plus
// leading-"v" strip and prerelease handling.
// ---------------------------------------------------------------------------

function normTag(t) {
  return String(t == null ? '' : t).trim().replace(/^[vV]/, '');
}

// { nums:[1,2,0], pre:'rc1' } from "v1.2.0-rc1"
function splitVer(t) {
  const s = normTag(t);
  const m = s.match(/^(\d+(?:\.\d+)*)(?:[-+](.*))?$/);
  if (!m) return { nums: [0], pre: '' };
  return { nums: m[1].split('.').map((x) => parseInt(x, 10) || 0), pre: m[2] || '' };
}

function cmpNums(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// >0 if a is newer than b. Handles "1.2" == "1.2.0" and prerelease < release.
function cmpVersion(a, b) {
  const va = splitVer(a);
  const vb = splitVer(b);
  const c = cmpNums(va.nums, vb.nums);
  if (c !== 0) return c;
  if (va.pre && !vb.pre) return -1; // a is a prerelease of b's version -> older
  if (!va.pre && vb.pre) return 1;
  if (va.pre === vb.pre) return 0;
  return va.pre < vb.pre ? -1 : 1; // ponytail: lexical prerelease compare, fine for a short curated list
}

// ---------------------------------------------------------------------------
// Asset matching — glob ("*-win-x64.zip") or "/regex/".
// ---------------------------------------------------------------------------

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('asset pattern is required');
  if (pattern.length > 1 && pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
    const re = new RegExp(pattern.slice(1, -1));
    return (name) => re.test(name);
  }
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const re = new RegExp('^' + body + '$', 'i');
  return (name) => re.test(name);
}

function matchAsset(assets, pattern) {
  const list = assets || [];
  const test = compilePattern(pattern);
  const hits = list.filter((a) => test(a.name));
  if (hits.length === 0) {
    const names = list.map((a) => a.name).join(', ') || '(none)';
    throw new Error(`no asset matched "${pattern}". Available: ${names}`);
  }
  if (hits.length > 1) {
    throw new Error(
      `pattern "${pattern}" matched ${hits.length} assets (${hits.map((h) => h.name).join(', ')}); tighten it`
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// Installer silent-switch table. Only the kinds we actually use; extend freely.
// ---------------------------------------------------------------------------

const INSTALLER_SWITCHES = {
  msi: (file) => ['msiexec', ['/i', file, '/qn', '/norestart']],
  nsis: (file) => [file, ['/S']],
  inno: (file) => [file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']],
};

// Returns { exe, args } to spawn. Per-repo install.args overrides the switches.
function installerCmd(kind, file, argsOverride) {
  const fn = INSTALLER_SWITCHES[kind];
  if (!fn) {
    throw new Error(`unknown installer kind "${kind}" (known: ${Object.keys(INSTALLER_SWITCHES).join(', ')})`);
  }
  const [exe, defaultArgs] = fn(file);
  if (Array.isArray(argsOverride) && argsOverride.length) {
    // msi keeps "/i <file>"; other kinds run the file directly, override is the full switch list.
    const args = kind === 'msi' ? ['/i', file, ...argsOverride] : argsOverride;
    return { exe, args };
  }
  return { exe, args: defaultArgs };
}

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

// "C:/PortableApps" + "ShareX" -> "C:/PortableApps/ShareX"
function resolvePortableDir(portableRoot, repoName) {
  return `${String(portableRoot).replace(/[\\/]+$/, '')}/${repoName}`;
}

// Validates, and fills each portable entry's install.dir from a top-level
// portableRoot when omitted. Mutates json in place so callers get resolved dirs.
function validateConfig(json) {
  if (!json || !Array.isArray(json.repos)) throw new Error('config: "repos" array is required');
  json.repos.forEach((r, i) => {
    const at = `repos[${i}]`;
    if (!r.owner || !r.repo) throw new Error(`${at}: "owner" and "repo" are required`);
    if (r.type !== 'portable' && r.type !== 'installer') {
      throw new Error(`${at}: "type" must be "portable" or "installer"`);
    }
    if (!r.asset) throw new Error(`${at}: "asset" pattern is required`);
    if (r.type === 'portable') {
      if (!r.install) r.install = {};
      if (!r.install.dir) {
        if (!json.portableRoot) throw new Error(`${at}: portable requires install.dir or a top-level portableRoot`);
        r.install.dir = resolvePortableDir(json.portableRoot, r.repo);
      }
    } else {
      if (!r.install) throw new Error(`${at}: "install" is required`);
      if (!INSTALLER_SWITCHES[r.install.kind]) {
        throw new Error(`${at}: installer requires install.kind one of ${Object.keys(INSTALLER_SWITCHES).join(', ')}`);
      }
    }
  });
  return json;
}

// ---------------------------------------------------------------------------
// Run summary.
// ---------------------------------------------------------------------------

// results: [{ repo, status:'updated'|'current'|'failed', from?, to?, reason?, note? }]
function buildSummary(results) {
  const counts = { updated: 0, current: 0, failed: 0 };
  const lines = [];
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'updated') {
      lines.push(`  ✓ ${r.repo}  ${r.from || '—'} → ${r.to}${r.note ? '  (' + r.note + ')' : ''}`);
    } else if (r.status === 'current') {
      lines.push(`  · ${r.repo}  ${r.to} (already current)`);
    } else {
      lines.push(`  ✗ ${r.repo}  ${r.reason}`);
    }
  }
  const header = `updated ${counts.updated}, current ${counts.current}, failed ${counts.failed}`;
  return { text: [header, ...lines].join('\n'), counts };
}

module.exports = {
  normTag,
  cmpVersion,
  compilePattern,
  matchAsset,
  installerCmd,
  validateConfig,
  resolvePortableDir,
  buildSummary,
  INSTALLER_SWITCHES,
};
