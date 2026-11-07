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
    }
    if (box) box.addEventListener('input', apply);
    controls.forEach(function (c) { c.addEventListener('change', apply); });
    tools.hidden = false;
  }

  function setupSort(table) {
    var body = table.tBodies[0];
    var heads = list(table, 'thead th');
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
        var items = list(body, '[data-row]').map(function (r) { return { r: r, v: cellValue(r, i) }; });
        items.sort(function (a, b) {
          var ea = a.v === '', eb = b.v === '';
          if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1; // empty cells stay last in both directions
          return dir * compareValues(a.v, b.v, type);
        });
        items.forEach(function (it) { body.appendChild(it.r); });
      }
      th.addEventListener('click', sort);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  }

  list(document, '[data-tools]').forEach(setupFilter);
  list(document, 'table[data-sortable]').forEach(setupSort);
})();
`;

export const SCRIPT = `${compareValues}\n${rowVisible}\n${MAIN}`;
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
export { sha as hashOf };
