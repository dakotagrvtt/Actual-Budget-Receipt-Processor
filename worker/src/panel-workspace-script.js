// Progressive enhancement of the real server forms. Drafts live only in this tab's memory.
// Every write still goes through the existing signed preview and server-side safety checks.
function workspace() {
  'use strict';
  var view = null, drafts = new Map(), metadataDrafts = new Map(), cashAccountChoices = new Map(), resolution = null, settingsBaseline = null, editor = null, navigating = false, modalReturn = null, confirmAction = null;
  var outside = null; // the last page outside Settings ({ url, title }): where Settings' Done goes back to
  var shownUrl = ''; // the address of the page on screen (to stay on it when leaving is cancelled)
  var ruleDialog = false;
  var backRow = ''; // the list row to focus after browser Back (read from the history entry's state)
  var filedOpen = false; // the Filed group as you last left it (open or shut), kept across client navigation and Back
  var dialog = document.getElementById('workspace-dialog');
  if (!dialog || !window.fetch || !window.DOMParser) return;
  var all = function (root, sel) { return Array.from(root.querySelectorAll(sel)); };
  var main = function () { return document.querySelector('[data-app-main]'); };
  var currentId = function () { var n = document.querySelector('[data-receipt-id]'); return n ? n.dataset.receiptId : ''; };
  var isField = function (name) { return /^(?:[ca]\d+|n[datc]\d+|acct)$/.test(name); };
  function fields(form) {
    var out = {};
    new FormData(form).forEach(function (v, k) { if (isField(k)) out[k] = String(v); });
    Object.keys(out).filter(function (k) { return /^nd\d+$/.test(k); }).forEach(function (k) {
      var i = k.slice(2);
      if (!(out[k] || '').trim() && !(out['na' + i] || '').trim()) ['nd', 'na', 'nc', 'nt'].forEach(function (n) { delete out[n + i]; });
    });
    return out;
  }
  function signature(value) {
    return JSON.stringify(Object.keys(value).sort().map(function (k) {
      var v = value[k];
      if (/^(?:a\d+|na\d+|receipt-total)$/.test(k)) {
        var text = String(v).trim();
        if (/^[+-]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text) && Math.abs(Number(text)) <= 100000) v = Math.round(Number(text) * 100);
      } else if (k.indexOf('receipt-') === 0) v = String(v).trim();
      return [k, v];
    }));
  }
  function message(text, alert) {
    var n = editor && editor.form.closest('.workspace-editor').querySelector('[data-editor-message]');
    if (n) { n.setAttribute('role', alert ? 'alert' : 'status'); if (n.textContent !== text) n.textContent = text; return; }
    // No editor message line on this page (Settings, lists): a failure still gets a visible page-level line, never silence.
    if (!alert || !main()) return;
    var page = main().querySelector('[data-page-message]');
    if (!page) { page = document.createElement('p'); page.className = 'banner live page-error'; page.setAttribute('data-page-message', ''); main().prepend(page); }
    page.setAttribute('role', 'alert'); page.textContent = text;
  }
  function metadataFields(form) {
    var out = {};
    new FormData(form).forEach(function (v, k) { if (k.indexOf('receipt-') === 0) out[k] = String(v).trim(); });
    return out;
  }
  function remember() {
    if (resolution && resolution.form.isConnected) {
      var meta = metadataFields(resolution.form);
      if (signature(meta) === signature(resolution.base)) metadataDrafts.delete(resolution.id);
      else metadataDrafts.set(resolution.id, { source: signature(resolution.base), value: meta });
    }
    if (editor && editor.form.isConnected) {
      var value = fields(editor.form), id = editor.form.dataset.id;
      if (signature(value) === signature(editor.base) && !editor.saving) drafts.delete(id);
      else drafts.set(id, { reading: editor.form.dataset.reading, value: value, mark: editor.mark });
    }
    markDrafts();
  }
  function markDrafts() {
    all(document, '[data-draft-for]').forEach(function (n) { n.hidden = !drafts.has(n.dataset.draftFor) && !metadataDrafts.has(n.dataset.draftFor); });
  }
  function dirty() { return editor && signature(fields(editor.form)) !== signature(editor.base); }
  // Settings are pages (settings?section=…), not a dialog: unsaved values on a section page are asked about before leaving it.
  function settingsValues() {
    var values = {};
    all(document, '#settings-page form').forEach(function (form) { new FormData(form).forEach(function (v, k) { if (/^[A-Z][A-Z0-9_]*$/.test(k)) values[k] = String(v); }); });
    return values;
  }
  function settingsDirty() { return settingsBaseline && document.getElementById('settings-page') && signature(settingsValues()) !== signature(settingsBaseline); }
  function canLeaveSettings() { return !settingsDirty() || window.confirm('Discard unsaved settings changes? Changes already saved are kept.'); }
  // A POST from a Settings section page keeps the values typed there but not saved: its own forms, and the notice line's Undo, which sits
  // above #settings-page. (A dialog form is never one.)
  function settingsPost(form) { return Boolean(document.getElementById('settings-page')) && !dialog.contains(form); }
  function closeDialog() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('cancel', function (e) { if (navigating) e.preventDefault(); });
  dialog.addEventListener('close', function () {
    dialog.classList.remove('photo-dialog'); view = null;
    confirmAction = null;
    ruleDialog = false;
    var ret = modalReturn; modalReturn = null;
    if (ret && ret.isConnected) ret.focus();
  });
  // The full-size receipt viewer: zoom (buttons, wheel, + - 0), drag to pan, Fit; the image is moved with a CSSOM transform only.
  function viewApply() {
    var v = view; if (!v) return;
    var minX = Math.min(0, v.stage.clientWidth - v.canvas.offsetWidth * v.s), minY = Math.min(0, v.stage.clientHeight - v.canvas.offsetHeight * v.s);
    v.x = Math.max(minX, Math.min(0, v.x)); v.y = Math.max(minY, Math.min(0, v.y));
    v.canvas.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.s + ')';
    v.readout.textContent = Math.round(v.s * 100) + '%';
    v.stage.classList.toggle('can-pan', minX < 0 || minY < 0);
  }
  function viewZoom(factor, cx, cy) {
    var v = view; if (!v) return;
    var px = cx == null ? v.stage.clientWidth / 2 : cx, py = cy == null ? v.stage.clientHeight / 2 : cy;
    var next = Math.max(1, Math.min(8, Math.round(v.s * factor * 100) / 100));
    v.x = px - (px - v.x) * next / v.s; v.y = py - (py - v.y) * next / v.s; v.s = next; viewApply();
  }
  function viewFit() { if (!view) return; view.s = 1; view.x = 0; view.y = 0; viewApply(); }
  function buildViewer(source) {
    var root = document.createElement('div'), tools = document.createElement('div'), stage = document.createElement('div'), canvas = document.createElement('div'), readout = document.createElement('span');
    root.className = 'photo-viewer'; tools.className = 'photo-tools'; stage.className = 'photo-stage'; canvas.className = 'photo-canvas'; readout.className = 'photo-zoom-readout';
    tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Zoom');
    [['out', '−', 'Zoom out'], ['in', '+', 'Zoom in'], ['fit', 'Fit', 'Fit to window']].forEach(function (b) {
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'small plain'; btn.dataset.zoom = b[0]; btn.textContent = b[1]; btn.setAttribute('aria-label', b[2]); tools.append(btn);
    });
    readout.setAttribute('aria-live', 'polite'); tools.append(readout);
    canvas.append(source.cloneNode(true)); stage.append(canvas); root.append(tools, stage);
    view = { s: 1, x: 0, y: 0, stage: stage, canvas: canvas, readout: readout, drag: null, moved: false };
    stage.addEventListener('wheel', function (e) {
      var v = view; if (!v) return;
      var single = canvas.querySelectorAll('img').length < 2;
      if (!e.ctrlKey && !single) { if (v.s > 1 || canvas.offsetHeight > stage.clientHeight) { e.preventDefault(); v.y -= e.deltaY; viewApply(); } return; }
      e.preventDefault();
      var r = stage.getBoundingClientRect();
      viewZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (view) { view.drag = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y, id: e.pointerId }; view.moved = false; }
    });
    stage.addEventListener('pointermove', function (e) {
      var v = view; if (!v || !v.drag) return;
      var dx = e.clientX - v.drag.x, dy = e.clientY - v.drag.y;
      if (!v.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!v.moved) { v.moved = true; stage.classList.add('panning'); try { stage.setPointerCapture(v.drag.id); } catch (_) {} }
      v.x = v.drag.ox + dx; v.y = v.drag.oy + dy; viewApply();
    });
    var endDrag = function () { if (view) { view.drag = null; stage.classList.remove('panning'); } };
    stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('click', function (e) {
      if (view && view.moved) { view.moved = false; return; }
      if (!e.target.closest('img')) closeDialog();
    });
    viewApply();
    return root;
  }
  function openDialog(title, content, opener) {
    modalReturn = opener || document.activeElement;
    document.getElementById('workspace-dialog-title').textContent = title;
    var body = document.getElementById('workspace-dialog-body');
    body.replaceChildren(content);
    if (!dialog.open) dialog.showModal();
    var safe = body.querySelector('input[name=action][value=split],input[name=action][value=adopt-existing],input[name=action][value=keep-found]');
    var focus = safe ? safe.form.querySelector('button') : body.querySelector('input,select,button');
    (focus || dialog.querySelector('[data-dialog-close]')).focus();
    dialog.scrollTop = 0;
  }
  function ask(text, run, opener) {
    var content = document.createElement('div'), p = document.createElement('p'), b = document.createElement('button');
    p.textContent = text; b.type = 'button'; b.textContent = 'Continue'; b.dataset.clientConfirm = '1';
    content.append(p, b); openDialog('Discard newer edits?', content, opener); confirmAction = run;
  }
  async function readPage(url, options) {
    var request = Object.assign({}, options || {});
    request.headers = Object.assign({ Accept: 'text/html' }, request.headers || {});
    var res = await fetch(url, request);
    if (!res.ok) throw new Error('Could not load the page (' + res.status + '). Your edits are kept.');
    var html = await res.text(), doc = new DOMParser().parseFromString(html, 'text/html');
    var page = doc.querySelector('[data-app-main]');
    if (!page) throw new Error('The server did not return a receipt page. Your edits are kept.');
    var resultUrl = res.url || String(url);
    return { page: page, title: doc.title, url: resultUrl, error: new URL(resultUrl, location.href).searchParams.get('action-error') === '1' || !!(res.headers && res.headers.get('X-Receipt-Action-Error') === '1') };
  }
  function reveal(hash, root) {
    if (!hash) return;
    var id; try { id = decodeURIComponent(hash.slice(1)); } catch (_) { return; }
    var target = document.getElementById(id);
    if (!target || (root && !root.contains(target))) return;
    for (var p = target; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    target.classList.add('revealed');
    target.scrollIntoView({ block: 'nearest' });
    if (target.matches('input,select,button')) target.focus();
  }
  function render(page, url, historyMode, title) {
    if (editor) { clearTimeout(editor.timer); if (editor.abort) editor.abort.abort(); }
    editor = null; resolution = null;
    main().replaceWith(page);
    if (title) document.title = title;
    // The header and bottom tabs are not swapped: the new page's tab, Review count and mode are read from its main element.
    all(document, '[data-page]').forEach(function (link) {
      var active = link.dataset.page === page.dataset.tab;
      link.classList.toggle('on', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    var reviews = Number(page.dataset.reviewCount) || 0;
    all(document, '[data-review-badge]').forEach(function (badge) { badge.querySelector('[data-count]').textContent = reviews ? String(reviews) : ''; badge.hidden = !reviews; });
    all(document, '[data-dry-chip]').forEach(function (chip) { chip.hidden = page.dataset.dry !== 'true'; });
    all(document, '.app-header details[open]').forEach(function (menu) { menu.open = false; });
    if (historyMode !== 'none') history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', url);
    shownUrl = location.href; noteOutside(page);
    window.scrollTo(0, 0);
    document.dispatchEvent(new Event('workspace:render'));
    enhance();
    // Focus goes to the new page: a notice first, then the receipt's title or the page heading. A row that enhance() just focused (coming back to the list) keeps it.
    var focus = page.querySelector('.notice') || page.querySelector('[data-workspace-title]') || page.querySelector('[data-page-heading]'), kept = document.activeElement && document.activeElement !== page && page.contains(document.activeElement);
    if (focus && !(kept && !focus.matches('.notice'))) { focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
    reveal(new URL(url, location.href).hash, page);
  }
  // Where Done on a Settings page goes back to: the last receipt or list you were on (its notice and Undo link left behind).
  function noteOutside(page) {
    if (!page || page.dataset.tab === 'settings') return;
    var u = new URL(location.href); ['notice', 'undo', 'u', 'action-error', 'started'].forEach(function (n) { u.searchParams.delete(n); });
    var title = page.querySelector('[data-workspace-title]');
    outside = { url: u.href, title: title ? title.textContent.trim() : page.dataset.tab === 'archived' ? 'Archive' : 'Inbox' };
  }
  // Settings keeps where Done goes back to in its address (`from`), so it survives a reload; the server cleans it (only the list, the Archive or a receipt).
  var SETTINGS_PATH = /\/(?:settings|categories|keywords|learned|privacy)$/;
  function fromOf(u) {
    var kept = new URLSearchParams();
    u.searchParams.forEach(function (v, k) { if (['key', 'notice', 'undo', 'u', 'action-error', 'started', 'from', 'selected'].indexOf(k) < 0) kept.append(k, v); });
    var seg = u.pathname.split('/').pop(), q = kept.toString();
    return (seg || './') + (q ? '?' + q : '');
  }
  function withFrom(url) {
    if (!SETTINGS_PATH.test(url.pathname) || url.searchParams.has('from')) return url;
    var source = SETTINGS_PATH.test(location.pathname) ? new URL(location.href).searchParams.get('from') : '';
    if (!source && outside) source = fromOf(new URL(outside.url));
    if (source) url.searchParams.set('from', source);
    return url;
  }
  async function navigate(url, mode) {
    if (navigating) return;
    if (!canLeaveSettings()) { if (mode === 'none') history.pushState({}, '', shownUrl); return; }
    remember(); navigating = true;
    try { var data = await readPage(url); render(data.page, data.url, mode, data.title); }
    catch (e) { message(e.message, true); if (!editor) window.alert(e.message); }
    finally { navigating = false; }
  }
  function addedTable(form) { return form.querySelector('[data-added-lines] table'); }
  function addLine(form, index) {
    var table = addedTable(form); if (!table) return;
    var rows = Array.from(table.tBodies[0].rows), row = rows[rows.length - 1];
    if (!row || rows.length >= Number(form.dataset.maxAdded || 10)) return;
    var clone = row.cloneNode(true), next = index == null ? rows.length : index;
    all(clone, 'input,select').forEach(function (c) {
      c.name = c.name.replace(/\d+$/, String(next)); c.value = c.tagName === 'SELECT' && /^nc/.test(c.name) ? row.querySelector('select[name^=nc]').value : '';
      if (c.hasAttribute('aria-label')) c.setAttribute('aria-label', c.getAttribute('aria-label').replace(/\d+/g, String(next + 1)));
    });
    clone.hidden = false; table.tBodies[0].append(clone);
  }
  function putFields(form, value) {
    Array.from(form.elements).filter(function (c) { return c.tagName === 'INPUT' || c.tagName === 'SELECT'; }).forEach(function (c) { if (isField(c.name) && !Object.prototype.hasOwnProperty.call(value, c.name)) c.value = /^nc/.test(c.name) ? 'Uncategorized' : ''; });
    var max = Math.max(-1, ...Object.keys(value).filter(function (k) { return /^nd\d+$/.test(k); }).map(function (k) { return Number(k.slice(2)); }));
    while (addedTable(form) && addedTable(form).tBodies[0].rows.length <= max && addedTable(form).tBodies[0].rows.length < Number(form.dataset.maxAdded || 10)) addLine(form);
    var table = addedTable(form); if (table) while (table.tBodies[0].rows.length > Math.max(1, max + 1)) table.tBodies[0].deleteRow(-1);
    Object.keys(value).forEach(function (name) { var el = form.elements.namedItem(name); if (el && 'value' in el) el.value = value[name]; });
  }
  function validate(form) {
    var valid = true;
    all(form, 'input.amt').forEach(function (c) {
      var value = c.value.trim();
      var added = /^na/.test(c.name), description = added && form.elements.namedItem('nd' + c.name.slice(2));
      var blank = added && !value && !(description && description.value.trim());
      var ok = blank || (/^[+-]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value) && Math.abs(Number(value)) <= 100000);
      c.setAttribute('aria-invalid', ok ? 'false' : 'true'); valid = valid && ok;
      if (!ok) c.setAttribute('aria-describedby', 'receipt-editor-message'); else c.removeAttribute('aria-describedby');
    });
    if (!valid) message('Enter an amount such as 4.18, or -2.50 for a discount.', true);
    return valid;
  }
  function itemHints() {
    if (!editor) return;
    var bulk = editor.form.querySelector('[data-bulk-control]');
    if (bulk) bulk.hidden = !(all(editor.form, '[data-item]').length > 1 || all(editor.form, '[data-added-lines] input').some(function (input) { return /^(?:nd|na)\d+$/.test(input.name) && input.value.trim(); }));
    if (bulk) {
      var categories = all(editor.form, 'select[name]').filter(function (control) {
        if (/^c\d+$/.test(control.name)) return true;
        if (!/^nc\d+$/.test(control.name)) return false;
        var index = control.name.slice(2), description = editor.form.elements.namedItem('nd' + index), amount = editor.form.elements.namedItem('na' + index);
        return (description && description.value.trim()) || (amount && amount.value.trim());
      }).map(function (control) { return control.value; });
      bulk.querySelector('[data-bulk-category]').value = categories.every(function (category) { return category === categories[0]; }) ? categories[0] : '';
    }
    all(editor.form, '[data-item]').forEach(function (row) {
      var i = row.dataset.item, a = row.querySelector('[name=a' + i + ']'), c = row.querySelector('[name=c' + i + ']');
      var changed = signature({ a0: a && a.value, c0: c && c.value }) !== signature({ a0: editor.base['a' + i], c0: editor.base['c' + i] });
      var hint = row.querySelector('[data-item-hint]'); if (hint) hint.hidden = !changed;
      row.classList.toggle('chg', changed);
      var was = row.querySelector('[data-was]');
      if (was && changed) {
        // "Was Pets" for a category change, "Was 4.18" when only the amount changed. Option text is the short category name.
        var before = c && c.value !== editor.base['c' + i] ? Array.prototype.filter.call(c.options, function (o) { return o.value === editor.base['c' + i]; })[0] : null;
        was.textContent = before ? before.textContent : c && c.value !== editor.base['c' + i] ? editor.base['c' + i] : a && a.dataset.original;
      }
      var rule = row.querySelector('[data-rule-link]'); if (rule && c) { var u = new URL(rule.href); u.searchParams.set('category', c.value); rule.href = u.href; }
    });
    editor.form.closest('.workspace-editor').querySelector('[data-editor-discard]').hidden = !dirty();
    var status = document.querySelector('[data-workspace-status]');
    if (status) status.textContent = dirty() ? editor.form.dataset.applied === 'true' ? "Already filed in Actual. Your edits aren't saved yet." : 'Your edits are not saved yet.' : editor.status;
  }
  function previewNode() { return document.querySelector('[data-preview-fragment]'); }
  function updateButton() {
    if (!editor) return;
    var pv = previewNode(), b = editor.form.closest('.workspace-editor').querySelector('[data-editor-save]');
    if (pv) pv.setAttribute('aria-busy', editor.pending ? 'true' : 'false');
    var root = editor.form.closest('.workspace-editor'), consequence = root.querySelector('[data-editor-consequence]');
    if (consequence) {
      consequence.textContent = dirty() ? consequence.dataset.edited : consequence.dataset.clean;
      var lead = consequence.dataset.cashLead, account = editor.form.elements.namedItem('acct');
      if (lead && account) consequence.textContent = lead + (account.value || 'the account you choose') + '.';
    }
    var nothing = !!(pv && pv.dataset.previewNone === 'true' && !dirty());
    // With nothing to save only the save controls hide; Previous and Next (in .next-row) stay.
    all(root, '.editor-lead').forEach(function (n) { n.hidden = nothing; });
    all(root, '.editor-actions').forEach(function (n) { n.hidden = nothing && !n.querySelector('.next-row'); });
    b.hidden = nothing;
    b.disabled = editor.pending || !validate(editor.form) || (editor.ready === signature(fields(editor.form)) && pv && pv.querySelector('[role=alert]') !== null);
    if (pv && pv.dataset.previewConfirm === 'true' && editor.mark === false && !dirty()) b.disabled = true;
    b.textContent = editor.pending ? 'Updating preview…' : editor.form.dataset.dry === 'true' ? 'Preview' : editor.form.dataset.kind === 'cash' ? 'Create cash purchase' : pv && pv.dataset.previewNone === 'true' && !dirty() ? 'Nothing to update' : pv && pv.dataset.previewReview === 'true' && !dirty() ? 'Looks right' : 'Save changes';
    if (pv && pv.dataset.previewNone === 'true' && !dirty()) b.disabled = true;
  }
  async function preview(explicit) {
    var state = editor; if (!state || !validate(state.form)) return null;
    clearTimeout(state.timer); if (state.abort) state.abort.abort();
    var sequence = (state.sequence || 0) + 1; state.sequence = sequence;
    state.abort = new AbortController(); state.pending = true; updateButton();
    var query = new URLSearchParams(new FormData(state.form));
    if (!explicit && state.form.dataset.kind === 'cash') query.set('live', '1');
    var url = new URL(state.form.getAttribute('action'), location.href); url.search = query.toString();
    var sent = signature(fields(state.form));
    try {
      var data = await readPage(url, { signal: state.abort.signal });
      if (editor !== state || state.sequence !== sequence || signature(fields(state.form)) !== sent) return null;
      var fragment = data.page.querySelector('[data-preview-fragment]');
      if (!fragment) throw new Error('The receipt changed. Reload it before saving. Your edits are kept.');
      var old = previewNode(); if (old) old.replaceWith(fragment);
      var mark = fragment.querySelector('[name=mark]'); if (mark && state.mark != null) mark.checked = state.mark;
      state.ready = sent; message('Preview updated.'); return fragment;
    } catch (e) { if (e.name !== 'AbortError') message(e.message, true); return null; }
    finally { if (editor === state && state.sequence === sequence) { state.pending = false; updateButton(); } }
  }
  async function writeForm(form, submitter) {
    if (navigating) return;
    remember(); navigating = true;
    var data = new URLSearchParams(new FormData(form));
    if (submitter && submitter.name) data.append(submitter.name, submitter.value);
    var action = new URL(submitter && submitter.getAttribute('formaction') || form.getAttribute('action'), location.href);
    var buttons = all(form, 'button');
    var actor = data.get('id') || data.get('entry') || currentId();
    var submittedDraft = drafts.get(actor);
    var submittedMetadata = metadataDrafts.get(actor);
    var savingEditor = editor && editor.form.dataset.id === actor && /\/(receipt-fix|receipt-cash)$/.test(action.pathname) ? editor : null;
    if (savingEditor) savingEditor.saving = true;
    var settingsForm = settingsPost(form), beforeSettings = settingsForm ? settingsBaseline : null, stagedSettings = beforeSettings ? settingsValues() : null;
    var inDialog = dialog.contains(form);
    // A Settings save or Undo locks every Settings control on the page, so nothing typed while it runs is lost when the page is replaced.
    var locked = inDialog ? all(dialog, 'input,select,textarea,button') : settingsForm ? buttons.concat(all(document, '#settings-page input,#settings-page select,#settings-page textarea,#settings-page button')) : buttons;
    var blocked = locked.filter(function (control, i) { return locked.indexOf(control) === i; }).map(function (control) { return { control: control, disabled: control.disabled }; });
    blocked.forEach(function (item) { item.control.disabled = true; });
    try {
      var result = await readPage(action, { method: 'POST', body: data });
      if (ruleDialog && inDialog) {
        var notice = result.page.querySelector('.notice');
        if (result.error) {
          var prior = dialog.querySelector('[data-rule-error]'); if (prior) prior.remove();
          var error = document.createElement('p'); error.dataset.ruleError = '1'; error.setAttribute('role', 'alert');
          error.textContent = notice ? notice.textContent : 'The rule was not saved. Check the fields and try again.';
          document.getElementById('workspace-dialog-body').prepend(error);
        } else { closeDialog(); message(notice ? notice.textContent : 'Rule saved. Your receipt edits are still unsaved.'); }
      } else {
        // A successful save owns the submitted draft, even when the server formats its values.
        // Edits made while the request was running belong to the next save and stay in memory.
        var currentDraft = drafts.get(actor), currentMetadata = metadataDrafts.get(actor);
        if (!result.error && /\/(receipt-fix|receipt-cash)$/.test(action.pathname) && submittedDraft && currentDraft && signature(currentDraft.value) === signature(submittedDraft.value)) drafts.delete(actor);
        if (!result.error && /\/receipt-resolve$/.test(action.pathname) && submittedMetadata && currentMetadata && signature(currentMetadata.value) === signature(submittedMetadata.value)) metadataDrafts.delete(actor);
        if (!result.error && /\/receipt-resolve$/.test(action.pathname) && currentDraft && editor && editor.form.dataset.id === actor) {
          var linkedForm = result.page.querySelector('[data-preview-form]');
          if (linkedForm && linkedForm.dataset.reading === currentDraft.reading) {
            // The new charge supplies untouched categories; only deliberate edits carry over.
            var rebased = fields(linkedForm);
            Object.keys(currentDraft.value).forEach(function (name) {
              if (signature({ [name]: currentDraft.value[name] }) !== signature({ [name]: editor.base[name] })) rebased[name] = currentDraft.value[name];
            });
            drafts.set(actor, { reading: currentDraft.reading, value: rebased, mark: currentDraft.mark });
          }
        }
        if (!result.error && /\/(archive|retry|receipt-reread|receipt-reread-restore|undo-receipt-fix)$/.test(action.pathname)) { drafts.delete(actor); metadataDrafts.delete(actor); }
        var openCards = settingsForm ? all(document, '#settings-page details[open][id]').map(function (d) { return d.id; }) : [];
        closeDialog(); render(result.page, result.url, 'replace', result.title);
        if (settingsForm && document.getElementById('settings-page')) keepStagedSettings(action, data, result.error, beforeSettings, stagedSettings, openCards);
      }
    } catch (e) { message(e.message + ' The request may still be finishing. Refresh before trying again.', true); if (dialog.open) window.alert(e.message); }
    finally { navigating = false; if (savingEditor) savingEditor.saving = false; blocked.forEach(function (item) { item.control.disabled = item.disabled; }); }
  }
  // After a Settings save on a section page: values typed in its other forms (not part of this save) are put back, still unsaved.
  function keepStagedSettings(action, data, failed, before, staged, openCards) {
    var written = new Set();
    if (!failed && /\/settings-save$/.test(action.pathname)) data.forEach(function (_, k) { if (/^[A-Z][A-Z0-9_]*$/.test(k)) written.add(k); });
    if (!failed && /\/settings-reset$/.test(action.pathname)) written.add(data.get('reset'));
    if (staged && before && !(!failed && /\/settings-reset-all$/.test(action.pathname))) Object.keys(staged).forEach(function (k) {
      if (staged[k] === before[k] || written.has(k)) return;
      var control = all(document, '#settings-page [name]').find(function (n) { return n.name === k && n.type !== 'hidden'; });
      if (control) { if (control.type === 'checkbox') control.checked = staged[k] === 'true'; else control.value = staged[k]; }
    });
    openCards.forEach(function (id) { var n = document.getElementById(id); if (n && n.tagName === 'DETAILS') n.open = true; });
  }
  async function saveEditor() {
    var state = editor; if (!state) return;
    var pv = state.ready === signature(fields(state.form)) && state.form.dataset.kind !== 'cash' ? previewNode() : await preview(true);
    if (!pv || pv.dataset.previewValid !== 'true') return;
    if (state.form.dataset.kind === 'cash') {
      var choices = pv.querySelector('[data-cash-preview]');
      if (choices && choices.querySelector('form')) {
        if (main().contains(choices)) confirmCash(choices);
        else { var clone = choices.cloneNode(true); clone.querySelectorAll('button').forEach(function (b) { b.removeAttribute('data-commit-button'); }); openDialog('Create a cash purchase?', clone, state.form.closest('.workspace-editor').querySelector('[data-editor-save]')); }
      }
    } else { var form = pv.querySelector('form[data-commit]'); if (form) await writeForm(form); }
  }
  // The cash choices are the server's own signed forms from this preview: they are shown where they are, never copied or rebuilt.
  // The safe choice (use the purchase already there, keep it unchanged) gets the focus. Any edit replaces the preview and hides them again.
  function confirmCash(choices) {
    choices.dataset.confirming = '1';
    var safe = choices.querySelector('input[name=action][value=split],input[name=action][value=adopt-existing],input[name=action][value=keep-found]');
    var focus = (safe ? safe.form : choices.querySelector('form')).querySelector('button');
    choices.scrollIntoView({ block: 'nearest' });
    if (focus) focus.focus();
    message('Choose how to record this cash purchase. Nothing is written until you do.');
  }
  // "Check now" in a waiting receipt's banner: start the check without leaving the receipt (the server answers 202 to a JSON request).
  // Without the script the form posts and the server sends you to the list, as before.
  async function checkNow(form) {
    var button = form.querySelector('button'), status = document.querySelector('[data-check-status]');
    if (!button || button.disabled) return;
    var label = button.textContent;
    button.disabled = true; button.textContent = 'Checking now…';
    try {
      var res = await fetch(new URL(form.getAttribute('action'), location.href), { method: 'POST', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      if (status) status.textContent = 'Checking now. Open this receipt again in a minute to see whether the charge was found.';
    } catch (_) {
      button.disabled = false; button.textContent = label;
      if (status) status.textContent = 'The check could not be started. Try again.';
    }
  }
  function enhance() {
    // The receipt image stays open. Where it sits above the items (under 1024px) only a peek shows, with a button for the whole receipt.
    var photos = document.querySelector('.receipt-photo-toggle'); if (photos) photos.open = true;
    var photoWrap = document.querySelector('[data-photo-wrap]'), photoButton = document.querySelector('[data-photo-toggle]');
    if (photoWrap && photoButton && matchMedia('(max-width:1023px)').matches) { photoWrap.classList.add('peek'); photoButton.hidden = false; }
    var metaForm = document.querySelector('[data-resolution-form]');
    if (metaForm) {
      var original = JSON.parse(metaForm.dataset.source);
      resolution = { form: metaForm, id: metaForm.dataset.id, base: original };
      var cached = metadataDrafts.get(resolution.id);
      if (cached && signature(cached.value) === signature(original)) { metadataDrafts.delete(resolution.id); cached = null; }
      if (cached && cached.source === signature(original)) {
        var serverFields = signature(metadataFields(metaForm));
        Object.keys(cached.value).forEach(function (name) { var c = metaForm.elements.namedItem(name); if (c) c.value = cached.value[name]; });
        if (signature(metadataFields(metaForm)) !== serverFields) {
          var staleResults = document.querySelector('[data-resolution-results]');
          if (staleResults) { staleResults.hidden = true; all(staleResults, 'button').forEach(function (b) { b.disabled = true; }); }
        }
      }
    }
    var search = document.querySelector('[data-queue-search]');
    if (search) { search.value = new URL(location.href).searchParams.get('q') || ''; filterQueue(search); }
    var form = document.querySelector('[data-preview-form]');
    if (form) {
      var initialStatus = document.querySelector('[data-workspace-status]');
      editor = { form: form, base: fields(form), ready: null, pending: false, mark: null, status: initialStatus ? initialStatus.textContent : '' };
      var kept = drafts.get(form.dataset.id);
      if (kept && signature(kept.value) === signature(editor.base)) { drafts.delete(form.dataset.id); kept = null; }
      if (kept && kept.reading === form.dataset.reading) {
        // A cash draft follows a changed "Cash purchases go to" (Settings) unless an account was picked on this receipt.
        var keptValue = kept.value;
        if (form.dataset.kind === 'cash' && !cashAccountChoices.has(form.dataset.id) && Object.prototype.hasOwnProperty.call(editor.base, 'acct')) keptValue = Object.assign({}, keptValue, { acct: editor.base.acct });
        putFields(form, keptValue); editor.mark = kept.mark;
      }
      else if (kept) message('This reading changed. Your earlier draft has not been applied. Check the current items before editing.', true);
      if (form.dataset.kind === 'cash' && cashAccountChoices.has(form.dataset.id)) {
        var account = form.elements.namedItem('acct'); if (account) account.value = cashAccountChoices.get(form.dataset.id);
      }
      var table = addedTable(form);
      if (table) { var add = document.createElement('button'); add.type = 'button'; add.className = 'small plain'; add.textContent = 'Add another line'; add.dataset.editorAdd = '1'; table.parentElement.append(add); }
      itemHints(); updateButton();
      if (kept && kept.reading === form.dataset.reading) preview(false);
    }
    markDrafts();
    settingsBaseline = document.getElementById('settings-page') ? settingsValues() : null;
    if (outside) all(document, '[data-settings-done]').forEach(function (done) { done.href = outside.url; done.textContent = 'Done · back to ' + outside.title; });
    if (filedOpen) all(document, 'details.queue-filed[data-queue-group=filed]').forEach(function (d) { d.open = true; });
    // Opening a receipt after following Back reveals its group before returning focus.
    var selected = new URL(location.href).searchParams.get('selected') || backRow; backRow = '';
    if (selected) { var row = all(document, '[data-queue-row]').find(function (n) { return n.dataset.id === selected; }); if (row) { var group = row.closest('details'); if (group) group.open = true; row.focus(); } }
  }
  function filterQueue(search) {
    var value = search.value.toLowerCase(), rail = search.closest('.queue-rail');
    all(rail, '[data-queue-row]').forEach(function (row) {
      row.parentElement.hidden = row.dataset.search.toLowerCase().indexOf(value) < 0;
      var u = new URL(row.href); if (search.value) u.searchParams.set('q', search.value); else u.searchParams.delete('q'); row.href = u.href;
    });
    // Counts follow the search (and come back when it is cleared); a group with nothing left says "No matches." instead of "All caught up.".
    all(rail, '[data-queue-group]').forEach(function (group) {
      var rows = all(group, '[data-queue-row]'), shown = rows.filter(function (row) { return !row.parentElement.hidden; }).length;
      if (value && shown) group.open = true;
      var count = group.querySelector('.queue-count');
      if (count) { if (count.dataset.total === undefined) count.dataset.total = count.textContent; count.textContent = value ? String(shown) : count.dataset.total; }
      all(group, '.queue-empty').forEach(function (note) { note.hidden = note.hasAttribute('data-no-match') ? !(value && !shown) : !!value; });
    });
  }
  // The Filed and Archive toggles say whether they are open (the browser's own details state, repeated as aria-expanded).
  document.addEventListener('toggle', function (e) {
    var d = e.target, summary = d && d.matches && d.matches('details.queue-filed') && d.querySelector('summary');
    if (summary) summary.setAttribute('aria-expanded', d.open ? 'true' : 'false');
  }, true);
  // Price entry like Actual: digits fill in from the cents (5 -> 0.05, 1234 -> 12.34), Backspace drops the last digit, "." or ","
  // switches that entry to normal typing, "-" flips the sign. The value stays the same plain string the server already accepts.
  var amountState = new WeakMap();
  var isAmount = function (el) { return !!el && !!el.matches && el.matches('input.amt,input[name="receipt-total"]'); };
  var amountOf = function (el) { var st = amountState.get(el); if (!st) { st = { cents: true, fresh: true }; amountState.set(el, st); } return st; };
  function setAmount(el, text) {
    el.value = text;
    try { el.setSelectionRange(text.length, text.length); } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function centsText(neg, digits) {
    var d = digits.replace(/^0+/, '');
    if (!d) return digits ? (neg ? '-' : '') + '0.00' : (neg ? '-' : '');
    d = d.padStart(3, '0');
    return (neg ? '-' : '') + d.slice(0, -2) + '.' + d.slice(-2);
  }
  document.addEventListener('focusin', function (e) { if (isAmount(e.target)) amountState.set(e.target, { cents: true, fresh: true }); });
  document.addEventListener('beforeinput', function (e) {
    var el = e.target; if (!isAmount(el)) return;
    var st = amountOf(el), value = el.value, neg = value.charAt(0) === '-', digits = value.replace(/\D/g, '');
    if (/^insertFrom/.test(e.inputType || '')) { st.cents = false; st.fresh = false; return; }
    if (!st.cents) return;
    if (e.inputType === 'deleteContentBackward') {
      if (el.selectionStart !== el.selectionEnd) return;
      e.preventDefault(); st.fresh = false;
      var left = digits.slice(0, -1).replace(/^0+/, '');
      setAmount(el, left ? centsText(neg, left) : (neg ? '-' : ''));
      return;
    }
    if (e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data.length !== 1) return;
    var ch = e.data;
    if (/\d/.test(ch)) {
      e.preventDefault();
      if (value && el.selectionStart === 0 && el.selectionEnd === value.length) st.fresh = true;
      var next = ((st.fresh ? '' : digits) + ch).replace(/^0+(?=\d)/, '');
      if (next.length > 8 || Number(next) > 10000000) return;
      st.fresh = false; setAmount(el, centsText(neg, next));
    } else if (ch === '.' || ch === ',') {
      e.preventDefault();
      var whole = st.fresh ? '' : digits.replace(/^0+/, '');
      st.cents = false; st.fresh = false; setAmount(el, (neg ? '-' : '') + whole + '.');
    } else if (ch === '-') {
      e.preventDefault(); setAmount(el, digits ? centsText(!neg, digits) : (neg ? '' : '-'));
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-queue-search]')) { filterQueue(e.target); return; }
    if (resolution && resolution.form.contains(e.target) && e.target.name.indexOf('receipt-') === 0) {
      var results = document.querySelector('[data-resolution-results]'); if (results) { results.hidden = true; all(results, 'button').forEach(function (b) { b.disabled = true; }); }
      remember(); return;
    }
    if (!editor || e.target.form !== editor.form || !isField(e.target.name)) return;
    if (e.target.name === 'acct') cashAccountChoices.set(editor.form.dataset.id, e.target.value);
    remember(); itemHints(); editor.ready = null; editor.sequence = (editor.sequence || 0) + 1; editor.pending = false;
    var stale = previewNode(); if (stale) all(stale, 'button').forEach(function (b) { b.disabled = true; });
    clearTimeout(editor.timer); if (editor.abort) editor.abort.abort();
    if (validate(editor.form)) editor.timer = setTimeout(function () { preview(false); }, 450);
    updateButton();
  });
  document.addEventListener('change', function (e) {
    if (editor && e.target.matches('[data-bulk-category]') && e.target.form === editor.form) {
      var category = e.target.value; if (!category) return;
      all(editor.form, 'select[name]').filter(function (control) { return /^(?:c|nc)\d+$/.test(control.name); }).forEach(function (control) { control.value = category; });
      editor.form.querySelector('select[name^=c]').dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (e.target.matches('select[data-jump]')) { var jump = new URL(e.target.form.getAttribute('action'), location.href); jump.search = new URLSearchParams(new FormData(e.target.form)); navigate(jump); return; }
    if (e.target.name === 'mark' && editor) { editor.mark = e.target.checked; remember(); updateButton(); return; }
    if (resolution && resolution.form.contains(e.target) && e.target.name.indexOf('receipt-') === 0) e.target.dispatchEvent(new Event('input', { bubbles: true }));
    if (editor && e.target.form === editor.form && isField(e.target.name)) e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.addEventListener('click', async function (e) {
    all(document, '.app-header details[open],details.receipt-more[open]').forEach(function (menu) { if (!menu.contains(e.target)) menu.open = false; });
    var filedToggle = e.target.closest('details.queue-filed[data-queue-group=filed] > summary');
    if (filedToggle) { filedOpen = !filedToggle.parentElement.open; return; }
    var totalChoice = e.target.closest('[data-use-read-total]');
    if (totalChoice && resolution) { var total = resolution.form.elements.namedItem('receipt-total'); total.value = totalChoice.dataset.useReadTotal; total.dispatchEvent(new Event('input', { bubbles: true })); total.focus(); return; }
    if (e.target.closest('[data-dialog-close]')) { if (!navigating) closeDialog(); return; }
    if (e.target.closest('[data-client-confirm]')) { var run = confirmAction; confirmAction = null; closeDialog(); if (run) run(); return; }
    var revealLink = e.target.closest('[data-reveal]');
    if (revealLink) {
      e.preventDefault(); reveal(revealLink.hash);
      var menu = revealLink.closest('details.receipt-more'); if (menu) menu.open = false;
      var focusName = revealLink.dataset.focus, target = focusName && document.querySelector('[data-resolution-form] [name="' + focusName + '"]');
      if (!target) { var opened = revealLink.hash && document.getElementById(revealLink.hash.slice(1)); target = opened && opened.querySelector('summary,input,select,button'); }
      if (target) target.focus();
      return;
    }
    if (view && e.target === dialog) { closeDialog(); return; }
    var zoomBtn = view && e.target.closest('[data-zoom]');
    if (zoomBtn) { var kind = zoomBtn.dataset.zoom; if (kind === 'fit') viewFit(); else viewZoom(kind === 'in' ? 1.25 : 0.8); return; }
    var fullBtn = e.target.closest('[data-photo-full]');
    if (fullBtn) {
      var images = document.querySelector('[data-photo-wrap]');
      if (images) { dialog.classList.add('photo-dialog'); openDialog('Receipt full size', buildViewer(images), fullBtn); }
      return;
    }
    var peek = e.target.closest('[data-photo-toggle]');
    if (peek) { var wrap = document.querySelector('[data-photo-wrap]'); if (wrap) { var small = wrap.classList.toggle('peek'); peek.textContent = small ? 'Show whole receipt' : 'Show less'; peek.setAttribute('aria-expanded', small ? 'false' : 'true'); } return; }
    var revert = e.target.closest('[data-item-revert]');
    if (revert && editor) { var row = revert.closest('[data-item]'), i = row.dataset.item; ['a', 'c'].forEach(function (n) { var el = editor.form.elements.namedItem(n + i); if (el) el.value = editor.base[n + i]; }); row.querySelector('input').dispatchEvent(new Event('input', { bubbles: true })); return; }
    if (e.target.closest('[data-editor-discard]') && editor) { putFields(editor.form, editor.base); drafts.delete(editor.form.dataset.id); markDrafts(); message('Changes discarded.'); itemHints(); await preview(false); return; }
    var cashCancel = e.target.closest('[data-cash-cancel]');
    if (cashCancel) { var asked = cashCancel.closest('[data-cash-preview]'); if (asked) delete asked.dataset.confirming; var save = document.querySelector('[data-editor-save]'); if (save) save.focus(); message('Nothing was created.'); return; }
    if (e.target.closest('[data-editor-add]') && editor) { addLine(editor.form); var rows = addedTable(editor.form).tBodies[0].rows; if (rows.length) rows[rows.length - 1].querySelector('input').focus(); return; }
    var a = e.target.closest('a'); if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || a.target || a.download) return;
    var url = new URL(a.href, location.href); if (url.origin !== location.origin) return;
    if (a.hasAttribute('data-rule-link')) {
      e.preventDefault(); if (navigating) return; remember(); navigating = true;
      try {
        var rules = await readPage(url), rule = rules.page.querySelector('form[action*="keyword-add"]');
        if (!rule) throw new Error('Could not load the rule form. Your receipt edits are kept.');
        rule.elements.namedItem('phrase').value = url.searchParams.get('word') || '';
        rule.elements.namedItem('category').value = url.searchParams.get('category') || '';
        var hint = document.createElement('p'); hint.textContent = 'Use this phrase for similar items. Usually suggests the category; always assigns it.';
        var ruleContent = document.createElement('div'); ruleContent.append(hint, rule);
        openDialog('Make a category rule', ruleContent, a); ruleDialog = true;
      } catch (err) { message(err.message, true); } finally { navigating = false; }
      return;
    }
    if (dialog.contains(a) && url.hash && url.pathname === location.pathname) { e.preventDefault(); reveal(url.hash, dialog); return; }
    // Leaving a list for a receipt: the row that opened it is saved in the entry being left, so Back can focus it again.
    if (a.hasAttribute('data-navigate') && a.hasAttribute('data-queue-row') && a.dataset.id) { try { history.replaceState(Object.assign({}, history.state, { row: a.dataset.id }), ''); } catch (_) {} }
    if (a.hasAttribute('data-navigate')) { e.preventDefault(); if (a.classList.contains('workspace-back') && currentId()) url.searchParams.set('selected', currentId()); navigate(withFrom(url)); }
  });
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.hasAttribute('data-preview-form')) { e.preventDefault(); saveEditor(); return; }
    if (form.method.toLowerCase() === 'get' && main().contains(form)) { e.preventDefault(); var get = new URL(form.getAttribute('action'), location.href); get.search = new URLSearchParams(new FormData(form)); navigate(get); return; }
    if (form.method.toLowerCase() !== 'post' || form.hasAttribute('data-upload') || (!main().contains(form) && !dialog.contains(form))) return;
    if (form.hasAttribute('data-check-now') && main().contains(form)) { e.preventDefault(); checkNow(form); return; }
    e.preventDefault(); var submitter = e.submitter, action = new URL(submitter && submitter.getAttribute('formaction') || form.getAttribute('action'), location.href);
    var id = new FormData(form).get('id') || currentId();
    if (/\/(undo-receipt-fix|receipt-reread|receipt-reread-restore|archive|retry)$/.test(action.pathname) && (drafts.has(id) || metadataDrafts.has(id))) ask('This action discards the unsaved edits on this receipt. Other receipt drafts are kept.', function () { writeForm(form, submitter); }, submitter);
    else writeForm(form, submitter);
  });
  window.addEventListener('popstate', function (e) { backRow = e.state && typeof e.state.row === 'string' ? e.state.row : ''; navigate(location.href, 'none'); });
  document.addEventListener('keydown', function (e) {
    if (view && dialog.open) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); viewZoom(1.25); } else if (e.key === '-' || e.key === '_') { e.preventDefault(); viewZoom(0.8); } else if (e.key === '0') { e.preventDefault(); viewFit(); }
      return;
    }
    if (e.key !== 'Escape' || dialog.open) return;
    var menus = all(document, '.app-header details[open],details.receipt-more[open]');
    if (!menus.length) return;
    e.preventDefault(); menus.forEach(function (menu) { menu.open = false; });
    menus[menus.length - 1].querySelector('summary').focus();
  });
  window.addEventListener('beforeunload', function (e) { remember(); if (drafts.size || metadataDrafts.size || settingsDirty()) { e.preventDefault(); e.returnValue = ''; } });
  enhance();
  shownUrl = location.href; noteOutside(main());
  document.documentElement.classList.add('workspace-ready');
}

export const WORKSPACE_SCRIPT = `(${workspace.toString()})();`;
