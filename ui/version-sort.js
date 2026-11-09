'use strict';

// Browser copy of core.cmpVersion. Kept in sync by the parity test in ui-sort.test.js.
(function () {
  const normTag = (t) => {
    const s = String(t == null ? '' : t).trim();
    return /\d/.test(s) ? s.replace(/^[^0-9]*(?=[0-9])/, '') : s;
  };
  const nums = (s) => s.split('.').map((x) => parseInt(x, 10) || 0);
  function splitVer(t) {
    let s = normTag(t);
    const plus = s.indexOf('+');
    if (plus >= 0) s = s.slice(0, plus);
    s = s.replace(/\s*\([^)]*\)\s*$/, '');
    const m = s.match(/^(\d+(?:\.\d+)*)(?:-(.*))?$/);
    if (m) return { nums: nums(m[1]), pre: m[2] || '' };
    const lead = s.match(/^(\d+(?:\.\d+)*)/);
    return lead ? { nums: nums(lead[1]), pre: '' } : { nums: [0], pre: '' };
  }
  function cmpNums(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }
  function naturalCmp(a, b) {
    const ax = a.match(/\d+|\D+/g) || [], bx = b.match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      const as = ax[i], bs = bx[i];
      if (as === undefined) return -1;
      if (bs === undefined) return 1;
      if (/^\d+$/.test(as) && /^\d+$/.test(bs)) {
        const d = parseInt(as, 10) - parseInt(bs, 10);
        if (d) return d < 0 ? -1 : 1;
      } else if (as !== bs) return as < bs ? -1 : 1;
    }
    return 0;
  }
  window.compareVersions = (a, b) => {
    const va = splitVer(a), vb = splitVer(b);
    const c = cmpNums(va.nums, vb.nums);
    if (c !== 0) return c;
    if (va.pre && !vb.pre) return -1;
    if (!va.pre && vb.pre) return 1;
    if (va.pre === vb.pre) return 0;
    return naturalCmp(va.pre, vb.pre);
  };
})();
