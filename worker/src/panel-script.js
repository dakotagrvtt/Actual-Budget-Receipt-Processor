// The one inline script shared by the panel pages: click a column header to sort a table, and filter rows by text,
// dropdown or checkbox. Without JavaScript nothing changes (the filter bars are rendered `hidden`).
// The pure helpers are exported for tests and pasted into the script with toString(), so the tested code is the shipped code.
import crypto from 'node:crypto';

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
    var out = [];
    for (var i = 0; i < row.children.length; i++) {
      if (!row.children[i].hasAttribute('data-act')) out.push(row.children[i].textContent);
    }
    return out.join(' ');
  }
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
  var NAV = ['result', 'q', 'sort', 'dir'];
  function recentTools() { return list(document, '[data-tools]').filter(function (t) { return t.getAttribute('data-tools') === 'recent'; })[0]; }
  function navSync() {
    var tools = recentTools();
    var table = tools && document.getElementById('recent');
    if (!tools || !table) return;
    var box = tools.querySelector('[data-q]');
    var sel = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'result'; })[0];
    var th = list(table, 'thead th').filter(function (h) { return h.getAttribute('aria-sort'); })[0];
    var want = { result: sel ? sel.value : '', q: box ? box.value : '', sort: th ? th.getAttribute('data-key') || '' : '', dir: th ? (th.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc') : '' };
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
    var table = tools && document.getElementById('recent');
    if (!tools || !table) return;
    var p = new URLSearchParams(location.search);
    var box = tools.querySelector('[data-q]');
    var sel = list(tools, '[data-field]').filter(function (c) { return c.getAttribute('data-field') === 'result'; })[0];
    if (box && p.get('q')) { box.value = p.get('q'); box.dispatchEvent(new Event('input')); }
    if (sel && p.get('result')) { sel.value = p.get('result'); sel.dispatchEvent(new Event('change')); }
    var th = list(table, 'thead th').filter(function (h) { return h.getAttribute('data-key') === p.get('sort'); })[0];
    if (th) { th.click(); if (p.get('dir') === 'desc') th.click(); }
    navSync();
    var here = location.hash && document.getElementById(location.hash.slice(1));
    if (here) here.scrollIntoView({ block: 'center' });
  }

  list(document, '[data-tools]').forEach(setupFilter);
  list(document, 'table[data-sortable]').forEach(setupSort);
  restoreList();

  // A receipt's page: the menu jumps on change (the Go button is for no-JavaScript), and the arrow keys step.
  list(document, 'select[data-jump]').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });
  list(document, '[data-nojs]').forEach(function (b) { b.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var t = e.target;
    var tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    var a = document.querySelector('a[rel="' + (e.key === 'ArrowLeft' ? 'prev' : 'next') + '"]');
    if (a) { e.preventDefault(); location.href = a.href; }
  });
})();
`;

export const SCRIPT = `${compareValues}\n${rowVisible}\n${sortItems}\n${MAIN}`;
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
export { sha as hashOf };
