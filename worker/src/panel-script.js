// The one inline script shared by the panel pages: click a column header to sort a table, and filter rows by text,
// dropdown or checkbox. Without JavaScript nothing changes (the filter bars are rendered `hidden`).
// The pure helpers are exported for tests and pasted into the script with toString(), so the tested code is the shipped code.
import crypto from 'node:crypto';
import { WORKSPACE_SCRIPT } from './panel-workspace-script.js';

/** Compare two cell values. type: 'num' | 'date' | 'text'. Empty or unreadable values sort last (ascending). */
export function compareValues(a, b, type) {
  if (type === 'num' || type === 'date') {
    const x = type === 'num' ? parseFloat(a) : Date.parse(a);
    const y = type === 'num' ? parseFloat(b) : Date.parse(b);
    if (isNaN(x) || isNaN(y)) return isNaN(x) === isNaN(y) ? 0 : isNaN(x) ? 1 : -1;
    return x - y;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Should a row show? text = its words, fields = its data-* values, q = typed text, wants = [{ field, value }] ('' = no choice). */
export function rowVisible(text, fields, q, wants) {
  if (q && text.toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
  return wants.every((w) => !w.value || fields[w.field] === w.value);
}

/**
 * Sort [{ v, i }] (value, original position) by v: empty values last in both directions, ties in their original order
 * (newest first, as the server lists them) whatever the direction. The server (orderFor) and the browser share this.
 */
export function sortItems(items, dir, type) {
  return items.slice().sort(function (a, b) {
    var ea = a.v === '', eb = b.v === '';
    var c = ea || eb ? (ea === eb ? 0 : ea ? 1 : -1) : dir * compareValues(a.v, b.v, type);
    return c || a.i - b.i;
  });
}

const MAIN = `
(function () {
  function cellValue(row, i) {
    var c = row.cells[i];
    if (!c) return '';
    var s = c.getAttribute('data-sort');
    return s !== null ? s : c.textContent.trim();
  }
  function rowText(row) {
    if (row.dataset.search !== undefined) return row.dataset.search;
    var out = [];
    for (var i = 0; i < row.children.length; i++) {
      if (!row.children[i].hasAttribute('data-act')) out.push(row.children[i].textContent);
    }
    return out.join(' ');
  }
  document.documentElement.className += ' js'; // the CSS shows what needs JavaScript (sort pills, the styled upload button) only when this is set
  function list(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  function setupFilter(tools) {
    var target = document.getElementById(tools.getAttribute('data-tools'));
    if (!target) return;
    var rows = list(target, '[data-row]');
    var box = tools.querySelector('[data-q]');
    var controls = list(tools, '[data-field]');
    function apply() {
      var wants = controls.map(function (c) {
        return { field: c.getAttribute('data-field'), value: c.type === 'checkbox' ? (c.checked ? '1' : '') : c.value };
      });
      rows.forEach(function (row) { row.hidden = !rowVisible(rowText(row), row.dataset, box ? box.value : '', wants); });
      // a group heading (Categories tab) goes when none of its rows shows
      list(target, '[data-group]').forEach(function (g) { g.hidden = !g.querySelector('[data-row]:not([hidden])'); });
    }
    if (box) box.addEventListener('input', function () { apply(); navSync(); });
    controls.forEach(function (c) { c.addEventListener('change', function () { apply(); navSync(); }); });
    tools.hidden = false;
  }

  function setupSort(table) {
    var body = table.tBodies[0];
    var heads = list(table, 'thead th');
    // The server's order (newest first), kept so equal values always fall back to it, however often you click.
    var original = list(body, '[data-row]');
    heads.forEach(function (th, i) {
      if (!th.textContent.trim()) return;
      var arrow = document.createElement('span');
      th.className += ' sortable';
      th.tabIndex = 0;
      th.appendChild(arrow);
      function sort() {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        heads.forEach(function (h) { h.removeAttribute('aria-sort'); if (h.lastChild && h.lastChild.nodeName === 'SPAN') h.lastChild.textContent = ''; });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        arrow.textContent = dir === 1 ? ' \\u25B2' : ' \\u25BC';
        var type = th.getAttribute('data-type') || 'text';
        var items = original.map(function (r, n) { return { r: r, v: cellValue(r, i), i: n }; });
        sortItems(items, dir, type).forEach(function (it) { body.appendChild(it.r); });
        navSync();
      }
      th.addEventListener('click', sort);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  }

  // The status list's View links carry its filter and sort, so a receipt's Previous / Next follow what is on screen.
  var NAV = ['result', 'cause', 'q', 'sort', 'dir'];
  function recentTools() { return list(document, '[data-tools]').filter(function (t) { var id = t.getAttribute('data-tools'); return id === 'recent' || id === 'archived'; })[0]; }
  function navSync() {
    var tools = recentTools();
    var table = tools && document.getElementById(tools.getAttribute('data-tools'));
    if (!tools || !table) return;
    var box = tools.querySelector('[data-q]');
    var sel = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'result'; })[0]; // the Archived tab has none
    var th = list(table, 'thead th').filter(function (h) { return h.getAttribute('aria-sort'); })[0];
    var cause = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'cause'; })[0];
    var want = { result: sel ? sel.value : '', cause: cause ? cause.value : '', q: box ? box.value : '', sort: th ? th.getAttribute('data-key') || '' : '', dir: th ? (th.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc') : '' };
    list(table, 'a[data-view]').forEach(function (a) {
      var href = a.getAttribute('href');
      var u = new URL(href, location.href);
      NAV.forEach(function (n) { if (want[n]) u.searchParams.set(n, want[n]); else u.searchParams.delete(n); });
      a.setAttribute('href', href.split('?')[0] + u.search);
    });
  }
  // Coming back from a receipt (?result=review&sort=when&dir=asc#r3): show the list as it was left.
  function restoreList() {
    var tools = recentTools();
    var table = tools && document.getElementById(tools.getAttribute('data-tools'));
    if (!tools || !table) return;
    var p = new URLSearchParams(location.search);
    var box = tools.querySelector('[data-q]');
    var sel = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'result'; })[0]; // the Archived tab has none
    if (box && p.get('q')) { box.value = p.get('q'); box.dispatchEvent(new Event('input')); }
    if (sel && p.get('result')) { sel.value = p.get('result'); sel.dispatchEvent(new Event('change')); }
    var cause = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'cause'; })[0];
    if (cause && p.get('cause')) { cause.value = p.get('cause'); cause.dispatchEvent(new Event('change')); }
    var th = list(table, 'thead th').filter(function (h) { return h.getAttribute('data-key') === p.get('sort'); })[0];
    if (th) { th.click(); if (p.get('dir') === 'desc') th.click(); }
    navSync();
    var here = location.hash && document.getElementById(location.hash.slice(1));
    if (here) here.scrollIntoView({ block: 'center' });
  }

  function enhanceTables() {
    list(document, '[data-tools]').forEach(function (n) { if (!n.getAttribute('data-filter-bound')) { n.setAttribute('data-filter-bound', '1'); setupFilter(n); } });
    list(document, 'table[data-sortable]').forEach(function (n) { if (!n.getAttribute('data-sort-bound')) { n.setAttribute('data-sort-bound', '1'); setupSort(n); } });
    restoreList();
  }
  enhanceTables();
  document.addEventListener('workspace:render', enhanceTables);

  // Settings shortcuts reveal all enclosing disclosures before scrolling to a section or field.
  if (document.getElementById('settings-page')) {
    function revealSetting() {
      var id;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { return; }
      var target = id && document.getElementById(id);
      if (!target || !document.getElementById('settings-page').contains(target)) return;
      var node = target;
      while (node) { if (node.tagName === 'DETAILS') node.open = true; node = node.parentElement; }
      target.scrollIntoView({ block: 'start' });
    }
    window.addEventListener('hashchange', revealSetting);
    revealSetting();
  }

  // The upload box: with JavaScript each chosen file is sent in its own request (one slow or bad file does not hold up or sink the rest), with
  // progress; the check starts once at the end. Without JavaScript the form posts all the files together.
  list(document, 'form[data-upload]').forEach(function (form) {
    var input = form.querySelector('input[type=file]');
    var status = document.querySelector('[data-upload-status]'); // under the buttons, full width
    var button = form.querySelector('label.btn');
    var MAX = 25 * 1024 * 1024;
    var busy = false; // one upload at a time: a second choice or submit while one runs does nothing
    // Choosing files is the whole gesture: the upload starts at once (the Send button below is for browsers without JavaScript).
    input.addEventListener('change', function () {
      if (busy || !input.files || !input.files.length) return;
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    });
    form.addEventListener('submit', function (e) {
      var files = input.files ? Array.prototype.slice.call(input.files) : [];
      if (!window.fetch || !window.FormData || !files.length) return;
      e.preventDefault();
      if (busy) return;
      busy = true;
      input.disabled = true;
      button.setAttribute('aria-busy', 'true');
      var saved = [], skipped = [], bad = [], i = 0;
      function finish() {
        var parts = [];
        if (bad.length) parts.push('Not uploaded: ' + bad.join('; ') + '.');
        if (skipped.length) parts.push('Already in the Inbox, skipped: ' + skipped.join(', ') + '.');
        if (saved.length) parts.push('Uploaded ' + saved.length + ' to the Inbox: ' + saved.join(', ') + '. The worker is reading them now; refresh in a minute.');
        else if (!bad.length && !skipped.length) parts.push('Nothing was uploaded.');
        function done() { status.textContent = parts.join(' '); busy = false; input.disabled = false; button.removeAttribute('aria-busy'); input.value = ''; }
        if (saved.length) fetch(form.getAttribute('data-run'), { method: 'POST' }).then(done, done); else done();
      }
      function next() {
        if (i >= files.length) return finish();
        var f = files[i++];
        status.textContent = 'Uploading ' + i + ' of ' + files.length + ': ' + f.name + '...';
        if (f.size > MAX) { bad.push(f.name + ' (larger than 25 MB)'); return next(); }
        var fd = new FormData();
        fd.append('receipts', f, f.name);
        fetch(form.getAttribute('data-send'), { method: 'POST', body: fd, headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            (j.saved || []).forEach(function (s) { saved.push(s.from === s.as ? s.as : s.from + ' as ' + s.as); });
            (j.skipped || []).forEach(function (n) { skipped.push(n); });
            (j.refused || []).forEach(function (r) { bad.push(r.name + ' (' + r.why + ')'); });
            if (j.message) bad.push(f.name + ' (' + j.message + ')');
          })
          .catch(function () { bad.push(f.name + ' (the upload failed; check the connection)'); })
          .then(next);
      }
      next();
    });
  });

  // A receipt's page: the menu jumps on change (the Go button is for no-JavaScript), and the arrow keys step.
  list(document, '[data-nojs]').forEach(function (b) { b.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var t = e.target;
    var tag = t && t.tagName;
    if (document.querySelector('dialog[open]') || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A') return;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    var a = document.querySelector('a[rel="' + (e.key === 'ArrowLeft' ? 'prev' : 'next') + '"]');
    if (a) { e.preventDefault(); a.click(); }
  });
})();
`;

// ---- Appearance (per device, in localStorage). Pure helpers, pasted into the script with toString() like the table helpers. ----
export const PREF_KEY = 'rx-prefs';
export const THEMES = ['system', 'light', 'dark'];
export const ACCENTS = ['blue', 'teal', 'violet', 'rose', 'graphite'];

/** The stored text -> { theme, accent }. Anything missing, unreadable or unknown falls back to System and Blue. */
export function readPrefs(raw) {
  var out = { theme: 'system', accent: 'blue' }, p = null;
  try { p = JSON.parse(raw); } catch (_) { return out; }
  if (p && typeof p === 'object') {
    if (['system', 'light', 'dark'].indexOf(p.theme) >= 0) out.theme = p.theme;
    if (['blue', 'teal', 'violet', 'rose', 'graphite'].indexOf(p.accent) >= 0) out.accent = p.accent;
  }
  return out;
}

/** Put the prefs on <html>: data-theme (absent for System, so prefers-color-scheme decides) and data-accent. */
export function applyPrefs(root, prefs) {
  if (prefs.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-accent', prefs.accent);
}

// Runs at once, in <head>, before the body is parsed: the stored theme is on <html> before first paint. Storage may be missing or throw.
const PREFS_NOW = `
(function () {
  var raw = null;
  try { raw = window.localStorage.getItem('${PREF_KEY}'); } catch (_) { raw = null; }
  try { applyPrefs(document.documentElement, readPrefs(raw)); } catch (_) {}
})();
`;

// The Appearance buttons (Settings): outside every settings form, never posted. Marks the stored choice and saves a new one.
const PREFS_UI = `
(function () {
  // The choices live in memory for the life of the page: storage is read once at the start and written best-effort, so the pressed
  // buttons always match what is applied even when storage is blocked.
  var prefs = (function () {
    var raw = null;
    try { raw = window.localStorage.getItem('${PREF_KEY}'); } catch (_) { raw = null; }
    return readPrefs(raw);
  })();
  function mark() {
    Array.prototype.slice.call(document.querySelectorAll('button[data-pref]')).forEach(function (b) {
      b.setAttribute('aria-pressed', prefs[b.getAttribute('data-pref')] === b.getAttribute('data-value') ? 'true' : 'false');
    });
  }
  mark();
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-pref]') : null;
    if (!b) return;
    var p = Object.assign({}, prefs);
    p[b.getAttribute('data-pref')] = b.getAttribute('data-value');
    prefs = readPrefs(JSON.stringify(p));
    try { window.localStorage.setItem('${PREF_KEY}', JSON.stringify(prefs)); } catch (_) {}
    try { applyPrefs(document.documentElement, prefs); } catch (_) {}
    mark();
  });
  document.addEventListener('workspace:render', mark);
})();
`;

// The prefs run immediately (this script sits in <head>); the rest waits for the document. Without readyState (a test document) it runs at once.
export const SCRIPT = `${compareValues}\n${rowVisible}\n${sortItems}\n${readPrefs}\n${applyPrefs}\n${PREFS_NOW}
(function () {
  function boot() {
${PREFS_UI}
${MAIN}
${WORKSPACE_SCRIPT}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();`;
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
export { sha as hashOf };
