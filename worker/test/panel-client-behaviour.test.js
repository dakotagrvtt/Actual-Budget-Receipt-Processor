import './support.js';
// Round 3 fixes (TF3 TF4 TF5 TF6 TF8 SF1 SF2): the shipped client script runs over small DOM stand-ins; synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WORKSPACE_SCRIPT } from '../src/panel-workspace-script.js';
import { SCRIPT, rowVisible } from '../src/panel-script.js';
import { cleanNav, navQuery, orderFor, receiptNav, groupSteps } from '../src/panel-status.js';
import { cleanFrom } from '../src/panel-settings-page.js';
import { ARCHIVE_ORDERING, archivedPage } from '../src/panel-archive-page.js';
import { statusPage } from '../src/panel-pages.js';
import { archiveSearch } from '../src/panel-queue.js';

// ---- client stand-ins ----
function client({ fetchImpl, controls = [], settings = true, rows = [], preview = null } = {}) {
  const listeners = {}, windowListeners = {}, calls = { replaceState: [], alerts: [] };
  const created = [];
  let pageMessage = null;
  const main = {
    querySelector: (sel) => (sel === '[data-page-message]' ? pageMessage : null),
    prepend: (n) => { pageMessage = n; },
    contains: () => true,
  };
  const dialog = { addEventListener() {}, contains: () => false, open: false };
  const el = () => { const n = { attrs: {}, setAttribute(k, v) { n.attrs[k] = v; }, getAttribute: (k) => n.attrs[k], className: '', textContent: '' }; created.push(n); return n; };
  const document = {
    getElementById: (id) => (id === 'workspace-dialog' ? dialog : id === 'settings-page' && settings ? {} : null),
    querySelector: (sel) => (sel === '[data-app-main]' ? main : sel === '[data-preview-fragment]' ? preview : null),
    querySelectorAll: (sel) => (/#settings-page/.test(sel) ? controls : sel === '[data-queue-row]' ? rows : []),
    createElement: el,
    addEventListener: (n, f) => { listeners[n] = f; },
  };
  class FormDataStandIn { constructor(form) { this.rows = form.rows || []; } forEach(fn) { for (const [k, v] of this.rows) fn(v, k); } [Symbol.iterator]() { return this.rows[Symbol.iterator](); } }
  const history = { state: { keep: 1 }, replaceState: (s, t) => { calls.replaceState.push(s); history.state = s; }, pushState() {} };
  const context = vm.createContext({
    document, FormData: FormDataStandIn, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, Array, Object, JSON, Promise, Error, String, Number, Math,
    location: { href: 'http://127.0.0.1/settings?key=k', origin: 'http://127.0.0.1', search: '?key=k' }, history,
    fetch: fetchImpl ?? (async () => ({ ok: false, status: 500 })),
    window: { fetch() {}, DOMParser() {}, addEventListener: (n, f) => { windowListeners[n] = f; }, alert: (t) => calls.alerts.push(t), confirm: () => true, scrollTo() {} },
    matchMedia: () => ({ matches: false }),
  });
  const marker = '  enhance();\n', at = WORKSPACE_SCRIPT.lastIndexOf(marker);
  vm.runInContext(WORKSPACE_SCRIPT.slice(0, at) + '  globalThis.h = { writeForm, message, updateButton, setEditor: function (e) { editor = e; }, backRow: function () { return backRow; } }; return;\n' + WORKSPACE_SCRIPT.slice(at + marker.length), context);
  return { h: context.h, listeners, windowListeners, calls, main, created, pageMessage: () => pageMessage };
}
const control = () => ({ disabled: false });
const settingsForm = (buttons) => ({ rows: [['POLL_SECONDS', '60']], getAttribute: () => 'settings-save?key=k', querySelectorAll: () => buttons });

test('TF3: a Settings save locks every Settings control while it runs and unlocks them if it fails', async () => {
  const buttons = [control()], inputs = [control(), control(), control()];
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = client({ controls: [...inputs, ...buttons], fetchImpl: async () => { await gate; return { ok: false, status: 500 }; } });
  const run = c.h.writeForm(settingsForm(buttons));
  assert.ok([...inputs, ...buttons].every((n) => n.disabled), 'every Settings control is locked in flight');
  release();
  await run;
  assert.ok([...inputs, ...buttons].every((n) => !n.disabled), 'unlocked again after the failure');
});

test('TF4: a failed POST with no editor shows a page-level alert that says it may still have finished', async () => {
  const c = client();
  await c.h.writeForm(settingsForm([control()]));
  const note = c.pageMessage();
  assert.ok(note, 'a visible line was added to the page');
  assert.equal(note.attrs.role, 'alert');
  assert.match(note.className, /\bpage-error\b/);
  assert.match(note.textContent, /may still be finishing\. Refresh before trying again\./);
  assert.equal(note.attrs.style, undefined, 'no inline style');
  await c.h.writeForm(settingsForm([control()]));
  assert.equal(c.created.filter((n) => n.attrs['data-page-message'] !== undefined).length, 1, 'one line, reused');
});

test('TF5: with nothing to save only the save controls hide; Previous and Next stay', () => {
  const preview = { dataset: { previewNone: 'true' }, setAttribute() {}, querySelector: () => null };
  const c = client({ preview });
  const run = (withSteps) => {
    const save = { disabled: false, hidden: false, textContent: '' }, lead = { hidden: false };
    const actions = { hidden: false, querySelector: (s) => (s === '.next-row' && withSteps ? {} : null) };
    const root = { querySelector: (s) => (s === '[data-editor-save]' ? save : null), querySelectorAll: (s) => (s === '.editor-lead' ? [lead] : s === '.editor-actions' ? [actions] : []) };
    const form = { closest: () => root, querySelectorAll: () => [], elements: { namedItem: () => null }, dataset: {} };
    c.h.setEditor({ form, base: {}, ready: null, pending: false, mark: null, status: '' });
    c.h.updateButton();
    return { save, lead, actions };
  };
  const kept = run(true);
  assert.equal(kept.actions.hidden, false, 'the row stays because it holds the step links');
  assert.equal(kept.save.hidden, true, 'the save button hides');
  assert.equal(kept.lead.hidden, true);
  const bare = run(false);
  assert.equal(bare.actions.hidden, true, 'with no step links the whole row hides, as before');
});

test('TF5 (source): the step links are no longer hidden with the save controls', () => {
  assert.doesNotMatch(WORKSPACE_SCRIPT, /all\(root, '\.editor-actions, \.editor-lead'\)/);
  assert.match(WORKSPACE_SCRIPT, /querySelector\('\.next-row'\)/);
});

test('SF2: opening a receipt from a list row saves that row in the entry being left; Back reads it', () => {
  const c = client({ settings: false, fetchImpl: async () => { throw new Error('offline'); } });
  const a = { href: 'http://127.0.0.1/receipt?key=k&id=r1', hasAttribute: (n) => n === 'data-navigate' || n === 'data-queue-row', dataset: { id: 'row-7' }, classList: { contains: () => false }, target: '', download: '' };
  c.listeners.click({ target: { closest: (s) => (s === 'a' ? a : null) }, defaultPrevented: false, button: 0, preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls.replaceState[0])), { keep: 1, row: 'row-7' });
  c.windowListeners.popstate({ state: { row: 'row-7' } });
  assert.equal(c.h.backRow(), 'row-7');
  c.windowListeners.popstate({ state: {} });
  assert.equal(c.h.backRow(), '');
  assert.match(WORKSPACE_SCRIPT, /searchParams\.get\('selected'\) \|\| backRow/);
});

test('SF1: Appearance keeps its choices in memory when storage is blocked, and the pressed states match what is applied', () => {
  const attrs = {}, pressed = new Map();
  const button = (pref, value) => ({ getAttribute: (k) => (k === 'data-pref' ? pref : value), setAttribute: (k, v) => { if (k === 'aria-pressed') pressed.set(`${pref}:${value}`, v); } });
  const all = [button('theme', 'system'), button('theme', 'dark'), button('accent', 'blue'), button('accent', 'teal')];
  const listeners = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, className: '' };
  const document = { documentElement: root, readyState: 'complete', addEventListener: (n, f) => { listeners[n] = f; }, querySelectorAll: (s) => (s === 'button[data-pref]' ? all : []), getElementById: () => null };
  const window = { get localStorage() { throw new Error('blocked'); } };
  vm.runInNewContext(SCRIPT, { document, window, Array, JSON, Object, parseFloat, Date, String, isNaN, URLSearchParams, location: { search: '', hash: '' } });
  const click = (b) => listeners.click({ target: { closest: () => b } });
  click(all[1]);
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(pressed.get('theme:dark'), 'true');
  assert.equal(pressed.get('theme:system'), 'false');
  click(all[3]);
  assert.equal(attrs['data-theme'], 'dark', 'the earlier theme survives the next choice');
  assert.equal(attrs['data-accent'], 'teal');
  assert.equal(pressed.get('theme:dark'), 'true');
  assert.equal(pressed.get('accent:teal'), 'true');
  assert.equal(pressed.get('accent:blue'), 'false');
});

// ---- server ----
test('TF8: navigation text is clipped by code point, never leaving half an emoji', () => {
  const q = `${'a'.repeat(99)}😀tail`;
  const nav = cleanNav(new URLSearchParams({ q }));
  assert.equal(nav.q, `${'a'.repeat(99)}😀`, '100 code points, the emoji kept whole');
  assert.doesNotThrow(() => navQuery(nav));
  assert.equal(nav.q.isWellFormed(), true);
  const result = cleanNav(new URLSearchParams({ result: `${'b'.repeat(59)}😀😀` })).result;
  assert.equal(result, `${'b'.repeat(59)}😀`);
  assert.equal(result.isWellFormed(), true);
  const from = cleanFrom(`/?q=${encodeURIComponent(q)}`);
  assert.ok(from && from.qs.includes(encodeURIComponent(`${'a'.repeat(99)}😀`)));
  assert.doesNotThrow(() => cleanFrom(`/receipt?id=x&q=${encodeURIComponent(`${'a'.repeat(99)}😀`)}`));
  assert.doesNotThrow(() => navQuery({ q: `x\ud83d` }), 'a lone half already in the nav is made well formed');
});

const at = '2026-11-07T10:00:00Z';
const entry = (key, store, total) => ({ key, file: `${key}.jpg`, done: true, result: 'review', at, card: { store, total, date: '2026-11-06' } });

test('TF6: a $ amount search keeps the receipt in the filter and Next stays inside the matches (Receipts list)', () => {
  const recent = [entry('k1', 'Alpha Market', 4.25), entry('k2', 'Beta Foods', 32.15), entry('k3', 'Gamma Shop', 32.15)];
  const html = statusPage({ heartbeat: 'now', alert: null, recent }, 'k');
  const searchOf = (id) => html.match(new RegExp(`data-id="${id}"[^>]*data-search="([^"]*)"`))[1];
  for (const q of ['$32.15', '32.15', 'beta', '$4.25']) {
    const browser = recent.filter((r) => rowVisible(searchOf(r.key), {}, q, [])).map((r) => r.key);
    const server = orderFor(recent, cleanNav(new URLSearchParams({ q }))).map((r) => r.key);
    assert.deepEqual(server, browser, q);
  }
  const where = receiptNav(recent, 'k2', cleanNav(new URLSearchParams({ q: '$32.15' })));
  assert.equal(where.relaxed, false, 'the search is kept');
  assert.equal(groupSteps(where, 'k2', 'review').next.key, 'k3');
  assert.equal(groupSteps(where, 'k2', 'review').prev, null, 'the $4.25 receipt is not a neighbour');
});

test('TF6: the Archive list and its server navigation use the same text, $ amounts included', () => {
  const archived = ['k1', 'k2'].map((key, i) => ({ key, file: `${key}.jpg`, done: true, result: 'review', at, card: { store: `Shop ${i}`, total: i ? 32.15 : 4.25, date: '2026-02-01' }, archived: { at } }));
  const html = archivedPage({ archived, dryRun: false }, 'k', '');
  const searchOf = (id) => html.match(new RegExp(`data-id="${id}"[^>]*data-search="([^"]*)"`))[1].replaceAll('&#38;', '&');
  assert.equal(ARCHIVE_ORDERING.words(archived[1]), archiveSearch(archived[1]));
  for (const q of ['$32.15', '32.15', 'shop 1', '$4.25']) {
    const browser = archived.filter((r) => rowVisible(searchOf(r.key), {}, q, [])).map((r) => r.key);
    const server = orderFor(archived, cleanNav(new URLSearchParams({ q })), ARCHIVE_ORDERING).map((r) => r.key);
    assert.deepEqual(server, browser, q);
  }
});
