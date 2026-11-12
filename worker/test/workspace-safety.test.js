import './support.js';
// Execute the shipped draft helpers with only their form-data boundary substituted.
// These checks cover data restoration; real focus/network behavior is checked separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { rememberCategories } from '../src/known-categories.js';
import { commitFix, editorFor, replan, partsOf, undoFix } from '../src/receipt-fix.js';
import { partNote, SPLIT_NOTE_MAX } from '../src/reconcile.js';
import { loadState } from '../src/state.js';
import * as memory from '../src/memory.js';
import { commitCash, lookAtActual } from '../src/cash.js';
const actualChecks = await import('../src/actual.js');
import { WORKSPACE_SCRIPT } from '../src/panel-workspace-script.js';

function draftHelpers() {
  class FormDataBoundary {
    constructor(form) { this.rows = form.elements.map((el) => [el.name, el.value]); }
    forEach(fn) { for (const [key, value] of this.rows) fn(value, key); }
    [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
  }
  const dialog = { addEventListener() {} };
  const document = { getElementById: (id) => id === 'workspace-dialog' ? dialog : null, addEventListener() {} };
  const context = vm.createContext({ document, window: { fetch() {}, DOMParser() {}, addEventListener() {} }, FormData: FormDataBoundary, URL, URLSearchParams, setTimeout, clearTimeout, AbortController });
  const marker = '  enhance();\n';
  assert.ok(WORKSPACE_SCRIPT.includes(marker), 'test hook is installed before the page starts');
  const at = WORKSPACE_SCRIPT.lastIndexOf(marker);
  const source = WORKSPACE_SCRIPT.slice(0, at) + '  globalThis.draftHelpers = { fields, signature, putFields, validate }; return;\n' + WORKSPACE_SCRIPT.slice(at + marker.length);
  vm.runInContext(source, context);
  return context.draftHelpers;
}

function formBoundary(values) {
  const elements = Object.entries(values).map(([name, value]) => ({ name, value, tagName: /^(?:c|nc)/.test(name) ? 'SELECT' : 'INPUT', type: 'text', dataset: {}, setAttribute() {} }));
  elements.namedItem = (name) => elements.find((el) => el.name === name) || null;
  return {
    elements, dataset: { maxAdded: '10' },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === 'input.amt' ? elements.filter((el) => /^(?:a|na)\d+$/.test(el.name)) : elements; },
  };
}

test('Discard returns to the baseline after filling the initially blank added line', () => {
  const h = draftHelpers();
  const form = formBoundary({ a0: '4.18', c0: 'Daily / Groceries', nd0: '', na0: '', nc0: 'Uncategorized', nt0: '' });
  const baseline = h.fields(form);
  form.elements.namedItem('nd0').value = 'Coupon';
  form.elements.namedItem('na0').value = '-1.50';
  form.elements.namedItem('nc0').value = 'Daily / Groceries';
  assert.notEqual(h.signature(h.fields(form)), h.signature(baseline));
  h.putFields(form, baseline);
  assert.equal(h.signature(h.fields(form)), h.signature(baseline), 'a discarded discount must not remain in the next write');
  assert.equal(form.elements.namedItem('nd0').value, '');
  assert.equal(form.elements.namedItem('na0').value, '');
});

test('restoring a shorter draft clears extra added lines while keeping its original edits', () => {
  const h = draftHelpers();
  const form = formBoundary({ a0: '7.00', c0: 'Daily / Gifts', nd0: 'Coupon', na0: '-1.00', nc0: 'Daily / Groceries', nt0: '', nd1: 'Extra item', na1: '12.00', nc1: 'Daily / Gifts', nt1: '*' });
  const target = { a0: '4.18', c0: 'Daily / Groceries', nd0: 'Discount', na0: '-.50', nc0: 'Daily / Groceries', nt0: '' };
  h.putFields(form, target);
  assert.equal(h.signature(h.fields(form)), h.signature(target));
  assert.equal(form.elements.namedItem('nd1').value, '');
  assert.equal(form.elements.namedItem('na1').value, '');
});

test('draft signatures compare valid receipt and added amounts as cents, preserve invalid input and trim metadata', () => {
  const { signature } = draftHelpers();
  assert.equal(signature({ a0: '5', na0: '-.50', 'receipt-total': ' 10.8 ', 'receipt-merchant': ' Sample shop ' }), signature({ a0: '+5.00', na0: '-0.50', 'receipt-total': '10.80', 'receipt-merchant': 'Sample shop' }));
  for (const value of ['5', '+5', ' 5 ', '5.0', '5.00']) assert.equal(signature({ a0: value }), signature({ a0: '5.00' }), value);
  for (const value of ['abc', '5.000', '5,00', '1e2', '100000.01', '']) {
    assert.notEqual(signature({ a0: value }), signature({ a0: '5.00' }), `${value} must not become a valid amount`);
    assert.notEqual(signature({ na0: value }), signature({ na0: '5.00' }), `${value} must not normalize an invalid added amount`);
  }
  assert.notEqual(signature({ a0: '5.00' }), signature({ a0: '5.01' }), 'a real cent change remains a draft');
  assert.notEqual(signature({ c0: '5' }), signature({ c0: '5.00' }), 'category names remain exact strings');
  assert.notEqual(signature({ acct: '' }), signature({ acct: 'Cash wallet' }), 'an explicit missing cash account remains distinct');
});

// O3: the shipped Settings helpers, run over a minimal stand-in of a Settings section page (the notice line sits above #settings-page).
function settingsHelpers({ onSettings = true, controls = [] } = {}) {
  const page = { id: 'settings-page' };
  const dialog = { addEventListener() {}, contains: (node) => Boolean(node?.inDialog) };
  const document = {
    getElementById: (id) => (id === 'workspace-dialog' ? dialog : id === 'settings-page' && onSettings ? page : null),
    querySelectorAll: (sel) => (sel === '#settings-page [name]' && onSettings ? controls : []),
    addEventListener() {},
  };
  const context = vm.createContext({ document, window: { fetch() {}, DOMParser() {}, addEventListener() {} }, URL, URLSearchParams, setTimeout, clearTimeout, AbortController });
  const marker = '  enhance();\n';
  const at = WORKSPACE_SCRIPT.lastIndexOf(marker);
  vm.runInContext(WORKSPACE_SCRIPT.slice(0, at) + '  globalThis.settingsHelpers = { settingsPost, keepStagedSettings }; return;\n' + WORKSPACE_SCRIPT.slice(at + marker.length), context);
  return { ...context.settingsHelpers, page };
}

test('O3: a POST from a Settings section page counts as a Settings post, also the notice line\'s Undo above #settings-page; a dialog form does not', () => {
  const { settingsPost, page } = settingsHelpers();
  const inside = { closest: (sel) => (sel === '#settings-page' ? page : null) };
  const notice = { closest: () => null }; // the notice line's Undo form: rendered by layout() before <div id="settings-page">
  assert.equal(settingsPost(inside), true);
  assert.equal(settingsPost(notice), true, 'its Undo keeps the values typed but not saved');
  assert.equal(settingsPost({ closest: () => null, inDialog: true }), false);
  assert.equal(settingsHelpers({ onSettings: false }).settingsPost(notice), false, 'not on a Settings page');
  assert.match(WORKSPACE_SCRIPT, /var settingsForm = settingsPost\(form\),/, 'writeForm uses it');
});

test('O3: after a Settings Undo the values typed but not saved in other groups are put back, unsaved; the undone group shows its restored values', () => {
  // On screen after the Undo: group A restored to its old values, group B as saved (its typed values were lost in the new page).
  const controls = [
    { name: 'POLL_SECONDS', type: 'text', value: '60' },
    { name: 'MATCH_DAYS', type: 'text', value: '3' },
    { name: 'SPLITS', type: 'checkbox', checked: true },
    { name: 'section', type: 'hidden', value: 'advanced' },
  ];
  const { keepStagedSettings } = settingsHelpers({ controls });
  const before = { POLL_SECONDS: '120', MATCH_DAYS: '3', SPLITS: 'true' }; // the page as it was after saving A (POLL_SECONDS = 120)
  const staged = { POLL_SECONDS: '120', MATCH_DAYS: '7', SPLITS: 'false' }; // B typed, not saved, when Undo was pressed
  keepStagedSettings(new URL('http://127.0.0.1/undo-settings?key=k'), new URLSearchParams({ section: 'advanced' }), false, before, staged, []);
  assert.equal(controls[0].value, '60', 'the undone setting shows its restored value');
  assert.equal(controls[1].value, '7', 'typed value kept');
  assert.equal(controls[2].checked, false, 'typed checkbox kept');
  assert.equal(controls[3].value, 'advanced');
});

// The real command, state journal, preview signature and Undo operate over fictional service boundaries.
async function confirmationWorld(t, { previewSplits = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-confirm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  Object.assign(config, { statePath: path.join(dir, 'state.json'), settingsPath: path.join(dir, 'settings.json'), categoryNotesPath: path.join(dir, 'category-notes.json'), dryRun: false, envDryRun: false, splits: true, taxByItem: true });
  config.learning.dir = path.join(dir, 'memory'); config.learning.mode = 'off'; config.match.accounts = [];
  config.trigger.token = 'synthetic-workspace-key';
  const labels = new Map([['Daily / Groceries', 'cg'], ['Daily / Gifts', 'cf']]);
  await rememberCategories([...labels.keys()].map((label) => ({ group: 'Daily', label })));
  const summary = { file: 'sample.jpg', receipt: { merchant: 'Sample shop', date: '2026-11-08', subtotal: 10, tax: 0, total: 10, items: [
    { description: 'Milk', amount: 4, category: 'Daily / Groceries' }, { description: 'Card', amount: 6, category: 'Daily / Gifts' },
  ] }, transaction: { id: 't1', date: '2026-11-08', amount: '10.00', account: 'Checking' }, problems: ['Check the card category.'] };
  const allocation = replan({ summary, picks: summary.receipt.items.map((i) => i.category), labelToId: labels, targetCents: 1000 }).allocation;
  summary.plan = { applied: true, action: 'split', parts: partsOf(allocation) };
  const id = `${config.nextcloud.inbox}/sample.jpg@test`;
  const entry = { done: true, result: 'split+review', at: '2026-11-08T10:00:00.000Z', filedAs: `${config.nextcloud.review}/sample.jpg`, applied: { txnId: 't1', action: 'split', at: '2026-11-08T10:00:00.000Z' } };
  await fs.writeFile(config.statePath, JSON.stringify({ [id]: entry }));
  let txn = { id: 't1', account: 'a1', date: '2026-11-08', payee: 'p1', amount: -1000, cleared: true, category: null, is_parent: true, notes: 'Personal note | #receipt sample.jpg #review | Other note', subtransactions: allocation.map((a, i) => ({ id: `s${i}`, amount: -a.cents, category: a.categoryId, notes: partNote(a, ', ', SPLIT_NOTE_MAX) })) };
  const original = structuredClone(txn);
  const files = new Map([[entry.filedAs, structuredClone(summary)]]);
  const nextcloud = {
    async readSummary(at) { return structuredClone(files.get(at) ?? null); },
    async refile(from, to, value) { assert.ok(files.has(from)); files.delete(from); files.set(to, structuredClone(value)); return to; },
  };
  const calls = { open: 0, notes: 0, rewrite: 0 };
  const actual = {
    ...actualChecks,
    async open() { calls.open++; }, async close() {}, async syncNow() {}, async categoryLabels() { return labels; },
    async findById() { return { t: structuredClone(txn), account: { name: 'Checking' } }; },
    async rewriteNotes(_old, notes) { calls.notes++; txn.notes = notes; },
    async rewrite(_old, want) { calls.rewrite++; txn.notes = want.notes; if (want.children) { txn.is_parent = true; txn.category = null; txn.subtransactions = structuredClone(want.children); } else { txn.is_parent = false; txn.category = want.category; txn.subtransactions = []; } },
  };
  config.splits = previewSplits;
  const preview = editorFor({ id, entry, summary, query: new URLSearchParams({ preview: '1' }) });
  assert.ok(preview.preview.token);
  const form = new URLSearchParams({ id, intent: 'confirm', token: preview.preview.token, state: preview.preview.state, mark: 'yes' });
  summary.receipt.items.forEach((it, i) => { form.set(`c${i}`, it.category); form.set(`a${i}`, it.amount.toFixed(2)); });
  return { id, entry, summary, original, calls, files, form, deps: { actual, nextcloud }, txn: () => structuredClone(txn), changeTxn: (change) => Object.assign(txn, change) };
}

test('Looks right preserves an existing split after split settings change, and offers no Undo (a signed one is refused)', async (t) => {
  const w = await confirmationWorld(t, { previewSplits: false });
  const out = {};
  assert.match(await commitFix(w.form, out, w.deps), /Marked sample.jpg as checked/);
  assert.deepEqual(w.txn(), { ...w.original, notes: 'Personal note | #receipt sample.jpg | Other note' });
  assert.equal(w.calls.notes, 1);
  assert.equal(w.calls.rewrite, 0, 'confirmation must never enter the full transaction rewrite');
  const saved = (await loadState())[w.id];
  assert.equal(saved.fixedOnPage.markOnly, true);
  assert.equal(saved.result, 'split');
  assert.deepEqual(w.files.get(saved.filedAs).plan, w.summary.plan, 'the summary must retain the filed split too');
  assert.equal(out.undo, undefined, 'Looks right hands out no Undo');
  const { signUndo } = await import('../src/panel-actions.js');
  const confirmed = w.txn();
  assert.match(await undoFix(new URLSearchParams(signUndo('undo-receipt-fix', { id: w.id, at: saved.fixedOnPage.at })), {}, w.deps), /"Looks right" can't be undone/);
  assert.deepEqual(w.txn(), confirmed, 'Actual is not touched');
  assert.equal(w.calls.notes, 1);
  assert.equal(w.calls.rewrite, 0);
  assert.equal((await loadState())[w.id].result, 'split');
});

test('Save still offers its Undo, and the Undo puts the charge and the receipt back', async (t) => {
  const w = await confirmationWorld(t);
  w.form.delete('intent'); // the same unchanged items, sent as a normal Save
  const out = {};
  assert.match(await commitFix(w.form, out, w.deps), /^Saved sample\.jpg/);
  const saved = (await loadState())[w.id];
  assert.equal(saved.fixedOnPage.markOnly, undefined);
  assert.equal(out.undo.route, 'undo-receipt-fix');
  const { undoOpen } = await import('../src/archive-rules.js');
  assert.equal(undoOpen(saved), true);
  assert.match(await undoFix(new URLSearchParams(out.undo.fields), {}, w.deps), /^Undone/);
  assert.equal(w.txn().notes, w.original.notes);
  assert.deepEqual(actualChecks.shapeOf(w.txn()), actualChecks.shapeOf(w.original));
  assert.equal((await loadState())[w.id].result, 'split+review');
});

test('confirmation refuses edited amounts, categories or added lines, stale state, bad signatures and unchecked mark before opening Actual', async (t) => {
  const w = await confirmationWorld(t);
  const mutations = [
    (f) => f.set('a0', '5.00'), (f) => f.set('c0', 'Daily / Gifts'),
    (f) => { f.set('nd0', 'Discount'); f.set('na0', '-1.00'); f.set('nc0', 'Daily / Groceries'); },
    (f) => f.set('state', 'stale'), (f) => f.set('token', 'invalid'), (f) => f.delete('mark'),
  ];
  for (const change of mutations) {
    const form = new URLSearchParams(w.form); change(form);
    await assert.rejects(commitFix(form, {}, w.deps), /Nothing was changed/i);
    assert.deepEqual(w.txn(), w.original);
  }
  assert.equal(w.calls.open, 0);
  assert.equal((await loadState())[w.id].result, 'split+review');
});

test('confirmation rechecks Actual and refuses changed monetary amounts or a removed receipt tag', async (t) => {
  const w = await confirmationWorld(t);
  w.changeTxn({ amount: -1100 });
  await assert.rejects(commitFix(w.form, {}, w.deps), /amount changed/);
  w.changeTxn({ amount: -1000, notes: 'Personal note' });
  await assert.rejects(commitFix(w.form, {}, w.deps), /receipt note was removed/);
  assert.equal(w.calls.notes, 0);
  assert.equal(w.calls.rewrite, 0);
});

test('a repeated confirmation cannot clear or rewrite the charge twice', async (t) => {
  const w = await confirmationWorld(t);
  const results = await Promise.allSettled([commitFix(w.form, {}, w.deps), commitFix(w.form, {}, w.deps)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(w.calls.notes, 1);
  assert.equal(w.calls.rewrite, 0);
});

test('confirmation cannot be used to apply an unmatched review or reconfirm a finished receipt', async (t) => {
  const w = await confirmationWorld(t);
  for (const change of [
    { result: 'review', applied: undefined },
    { result: 'split' },
    { reviewed: true },
  ]) {
    const entry = { ...w.entry, ...change };
    await fs.writeFile(config.statePath, JSON.stringify({ [w.id]: entry }));
    const summary = { ...w.summary, plan: { ...w.summary.plan, applied: Boolean(entry.applied) } };
    w.files.set(entry.filedAs, summary);
    // A fresh, otherwise valid editor signature cannot grant a non-review confirmation.
    const pv = editorFor({ id: w.id, entry, summary, query: new URLSearchParams({ preview: '1' }) }).preview;
    const form = new URLSearchParams(w.form); form.set('state', pv.state); form.set('token', pv.token);
    await assert.rejects(commitFix(form, {}, w.deps), /no longer needs confirmation/);
  }
  assert.equal(w.calls.open, 0);
  assert.deepEqual(w.txn(), w.original);
});


test('Looks right records its confirmation mark (the learning signal), leaves unrelated marks alone, and the mark is kept: there is no Undo', async (t) => {
  const w = await confirmationWorld(t);
  config.learning.mode = 'on';
  await memory.recordMarks({ confirmed: ['other-txn'], corrected: { t1: ['previous-part'] } });
  const out = {};
  await commitFix(w.form, out, w.deps);
  assert.deepEqual(await memory.loadMarks(), { confirmed: ['other-txn', 't1'], corrected: {} });
  assert.equal(out.undo, undefined);
  assert.equal((await loadState())[w.id].fixedOnPage.marks, undefined, 'no marks snapshot is kept for an Undo');
  const { signUndo } = await import('../src/panel-actions.js');
  await undoFix(new URLSearchParams(signUndo('undo-receipt-fix', { id: w.id, at: (await loadState())[w.id].fixedOnPage.at })), {}, w.deps);
  assert.deepEqual(await memory.loadMarks(), { confirmed: ['other-txn', 't1'], corrected: {} }, 'a refused Undo does not take the mark back');
});


test('a normal Save preview is refused when Split charges changes after preview', async (t) => {
  const w = await confirmationWorld(t);
  w.form.delete('intent');
  config.splits = false;
  await assert.rejects(commitFix(w.form, {}, w.deps), /changed since the preview/);
  assert.deepEqual(w.txn(), w.original);
  assert.equal(w.calls.notes, 0);
  assert.equal(w.calls.rewrite, 0);
});

test('a cash Create preview is refused before journaling or creating when Split charges changes', async (t) => {
  const w = await confirmationWorld(t);
  delete w.summary.transaction;
  w.summary.receipt.payment_method = 'cash';
  w.summary.plan = { applied: false, action: null, parts: [] };
  delete w.entry.applied;
  w.entry.result = 'review';
  await fs.writeFile(config.statePath, JSON.stringify({ [w.id]: w.entry }));
  w.files.set(w.entry.filedAs, structuredClone(w.summary));
  const accountName = 'Cash wallet';
  let attemptedCreate = false;
  w.deps.actual.cashLookup = async () => ({ accounts: [{ id: 'cash', name: accountName }], account: { id: 'cash', name: accountName }, duplicates: [], payee: { id: 'p1', name: 'Sample shop' } });
  w.deps.actual.findTaggedTransactions = async () => { attemptedCreate = true; throw new Error('must not start creating'); };
  const cashLook = await lookAtActual({ entry: w.entry, summary: w.summary, accountName }, w.deps);
  const query = new URLSearchParams({ preview: '1', acct: accountName });
  const preview = editorFor({ id: w.id, entry: w.entry, summary: w.summary, query, cashLook }).preview;
  assert.ok(preview.token);
  const form = new URLSearchParams(w.form);
  form.delete('intent'); form.set('action', 'create'); form.set('acct', accountName); form.set('token', preview.token); form.set('state', preview.state);
  config.splits = false;
  await assert.rejects(commitCash(form, {}, w.deps), /changed since the preview/);
  assert.equal(attemptedCreate, false);
  assert.equal((await loadState())[w.id].creating, undefined);
  assert.deepEqual(w.txn(), w.original);
});
