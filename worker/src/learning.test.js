// Learning from corrections: provenance, snapshots and the watch list, the sweep and its lessons, how lessons are used, and
// learned keywords. Actual is a fake (test/support.js swaps the API package); nothing touches the network or /data.
import '../test/support.js';
import test, { mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { shiftDay, today } from './dates.js';
import { setRules } from './rules.js';
const { default: api } = await import('@actual-app/api');
const actual = await import('./actual.js');
const learning = await import('./learning.js');
const memory = await import('./memory.js');
const kw = await import('./keywords.js');
const { allocate, foldDiscounts, mergeSmallParts, partKey, partNote, stripAnnotations, STORE_DEFAULT } = await import('./reconcile.js');
const { storeConsensus, applyPlan } = await import('./receipt.js');
const { similarItems, householdEntries, relevantCorrections } = await import('./item-context.js');
const { categorizeItems } = await import('./categorize.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-test-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const saved = { learning: { ...config.learning }, dryRun: config.dryRun, keywordMode: config.keywordMode, keywordsPath: config.keywordsPath, categoryNotesPath: config.categoryNotesPath, similarItems: config.similarItems, deciderUrl: config.deciderUrl, keywordHintWeight: config.keywordHintWeight };
let dir;
let n = 0;
beforeEach(() => {
  dir = path.join(root, `t${++n}`);
  fs.mkdirSync(dir);
  Object.assign(config, { dryRun: false, keywordsPath: path.join(dir, 'keywords.json'), categoryNotesPath: path.join(dir, 'notes.json') });
  Object.assign(config.learning, { mode: 'on', dir: path.join(dir, 'memory') });
});
afterEach(() => {
  mock.restoreAll();
  Object.assign(config, { dryRun: saved.dryRun, keywordMode: saved.keywordMode, keywordsPath: saved.keywordsPath, categoryNotesPath: saved.categoryNotesPath, similarItems: saved.similarItems, deciderUrl: saved.deciderUrl, keywordHintWeight: saved.keywordHintWeight });
  Object.assign(config.learning, saved.learning);
});

const GRO = 'Daily / Groceries';
const SAM = 'Daily / Sam';
const FUN = 'Fun / Gifts';
const id2label = new Map([['c-gro', GRO], ['c-sam', SAM], ['c-fun', FUN]]);
const labelToId = new Map([...id2label].map(([id, l]) => [l, id]));
const day = (d) => shiftDay(today(), d);

/** A fake budget: one account, one payee "Target", and whatever transactions the test keeps in `txns`. */
function fakeBudget(txns) {
  mock.method(api, 'getAccounts', async () => [{ id: 'a1', name: 'Checking' }]);
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Target' }]);
  mock.method(api, 'getTransactions', async (_id, start, end) => txns.filter((t) => t.date >= start && t.date <= end));
}
const split = (id, children, notes = '#receipt a.jpg', over = {}) => ({ id, date: day(-2), amount: -1000, payee: 'p1', notes, is_parent: true, subtransactions: children, ...over });
const child = (category, amount, notes) => ({ category, amount: -amount, notes });
const single = (id, category, notes = '#receipt a.jpg — items: MILK; GUMDROPS', over = {}) => ({ id, date: day(-2), amount: -1000, payee: 'p1', category, notes, ...over });
const item = (d, src = 'model', over = {}) => ({ d, plain: null, src, conf: 0.9, ...over });
const snapshot = (over = {}) => ({
  txnId: 't1', file: 'a.jpg', date: day(-2), payee: 'Target', store: 'TARGET 1234', amountCents: 1000, action: 'split', review: false,
  parts: [
    { label: GRO, cents: 600, note: 'MILK', items: [item('MILK')] },
    { label: SAM, cents: 400, note: 'GUMDROPS', items: [item('GUMDROPS')] },
  ],
  ...over,
});
const label = (id) => (id == null ? null : id2label.get(id));
const lessonRec = (over = {}) => ({ id: 'aaaaaaaaaaaa', txnId: 't1', file: 'a.jpg', date: day(-2), payee: 'Target', store: 'TARGET 1234', item: 'GUMDROPS', plain: null, said: SAM, saidHow: 'model', filed: FUN, kind: 'item', group: 1, ...over });

// ---- 1. provenance ----

test('provenance: yours, confirmed, corrected, defaulted and the worker\'s own', () => {
  const base = { parentNotes: '#receipt a.jpg', notes: 'MILK', cents: 600, category: GRO };
  assert.equal(actual.provenance({ ...base, parentNotes: 'my own split' }), 'household');
  assert.equal(actual.provenance({ ...base, verified: true }), 'household');
  assert.equal(actual.provenance({ ...base, notes: 'DVD (maybe Child 34%)' }), 'corrected');
  assert.equal(actual.provenance(base), 'pipeline');
  assert.equal(actual.provenance({ ...base, notes: 'MILK (store default)' }), 'pipeline-fallback');
  assert.equal(actual.provenance({ ...base, notes: 'MILK (store default), GUMDROPS' }), 'pipeline'); // only some items were defaults
  const fallbackSnap = snapshot({ parts: [{ label: GRO, cents: 600, note: 'MILK', items: [item('MILK', 'fallback'), item('EGGS', 'unsure')] }] });
  assert.equal(actual.provenance({ ...base, snapshot: fallbackSnap }), 'pipeline-fallback');
  assert.equal(actual.provenance({ ...base, snapshot: snapshot() }), 'pipeline');
  assert.equal(actual.provenance({ ...base, category: FUN, snapshot: snapshot() }), 'corrected'); // you moved it
});

test('itemHistory: each entry says who is behind it, from the note mark, the snapshot or the missing #receipt tag', async () => {
  const txns = [
    split('h1', [child('c-gro', 500, 'whole milk')], 'my split'),
    split('p1', [child('c-sam', 300, 'GUMDROPS (store default)'), child('c-gro', 700, 'EGGS')]),
    split('p2', [child('c-gro', 1000, 'SODA')], '#receipt b.jpg'),
    split('p3', [child('c-gro', 1000, 'RICE')], '#receipt c.jpg'),
    single('s1', 'c-gro', '#receipt d.jpg — items: BREAD (store default)'),
  ];
  fakeBudget(txns);
  await memory.watch(snapshot({ txnId: 'p2', file: 'b.jpg', parts: [{ label: GRO, cents: 1000, note: 'SODA', items: [item('SODA', 'fallback')] }] }));
  await memory.watch(snapshot({ txnId: 'p3', file: 'c.jpg', review: true, verified: true, parts: [] }));
  const got = Object.fromEntries((await actual.itemHistory('none', id2label)).map((h) => [h.items, h.by]));
  assert.deepEqual(got, { 'whole milk': 'household', GUMDROPS: 'pipeline-fallback', EGGS: 'pipeline', SODA: 'pipeline-fallback', RICE: 'household', BREAD: 'pipeline-fallback' });
});

test('storeHistory marks the worker\'s purchases, and storeConsensus ignores them; categoryActivity too', async () => {
  const txns = [
    split('h1', [child('c-gro', 1000, 'milk')], 'my split'),
    split('p1', [child('c-sam', 1000, 'GUMDROPS')], '#receipt a.jpg'),
    split('p2', [child('c-sam', 1000, 'GUMDROPS')], '#receipt b.jpg'),
    split('p3', [child('c-sam', 1000, 'SODA (store default)')], '#receipt c.jpg'),
  ];
  fakeBudget(txns);
  await memory.watch(snapshot({ txnId: 'p2', file: 'b.jpg', review: true, verified: true, parts: [] }));
  const history = await actual.storeHistory('Target', 'none', id2label);
  assert.deepEqual(history.map((h) => [h.by]).flat().sort(), ['household', 'household', 'pipeline', 'pipeline']);
  const purchase = (cat, by) => ({ by, parts: [{ category: cat, amount: '1.00' }] });
  assert.equal(storeConsensus([purchase(GRO, 'pipeline'), purchase(GRO, 'pipeline'), purchase(GRO, 'household')]), null); // only one counts
  assert.deepEqual(storeConsensus([purchase(GRO, 'household'), purchase(GRO, 'household'), purchase(GRO, 'household'), purchase(SAM, 'pipeline')]), { label: GRO, count: 3 });
  const act = await actual.categoryActivity(['c-sam', 'c-gro']);
  assert.equal(act.get('c-sam').count, 2); // the worker's own picks count, and p2 you confirmed; p3 is only a store default
  assert.equal(act.get('c-gro').count, 1);
});

test('similarItems and householdEntries: defaults are no examples, yours come first, the worker\'s fill at most half', () => {
  const h = (items, by, category = GRO, date = '2026-01-01') => ({ items, category, store: 's', by, date });
  const history = [
    h('gumdrops default', 'pipeline-fallback'), h('gumdrops a', 'pipeline'), h('gumdrops b', 'pipeline'), h('gumdrops c', 'pipeline'),
    h('gumdrops yours', 'household', GRO, '2025-01-01'), h('gumdrops fixed', 'corrected', GRO, '2025-01-01'),
  ];
  const got = similarItems({ description: 'GUMDROPS' }, history, 4).map((s) => s.items);
  assert.deepEqual(got, ['gumdrops fixed', 'gumdrops yours', 'gumdrops a', 'gumdrops b']); // corrections first; 2 + 2 (half of 4); the default is gone
  const ents = householdEntries(history, [GRO], 4)[GRO].map((e) => e.items);
  assert.equal(ents.length, 4);
  assert.ok(ents.includes('gumdrops yours') && ents.includes('gumdrops fixed'));
  assert.ok(!ents.includes('gumdrops default'));
  assert.equal(ents.filter((e) => ['gumdrops a', 'gumdrops b', 'gumdrops c'].includes(e)).length, 2);
  // a correction ranks above an equally similar item of yours
  const tied = similarItems({ description: 'GUMDROPS' }, [h('gumdrops mine', 'household'), h('gumdrops fixed', 'corrected')], 8).map((s) => s.items);
  assert.deepEqual(tied, ['gumdrops fixed', 'gumdrops mine']);
});

test('(store default): one mark at the end of a part whose items all fell back; stripAnnotations removes it, and #always still finds its phrase', () => {
  const receipt = { total: 3, subtotal: 3, items: [
    { description: 'GUMDROPS', amount: 1, category: SAM, fellBack: true },
    { description: 'CANDY', amount: 0.5, category: SAM, fellBack: true },
    { description: 'MILK', amount: 1.5, category: GRO, confidence: 0.9 },
  ] };
  const { allocation } = allocate(receipt, labelToId, 300);
  const parts = Object.fromEntries(allocation.map((a) => [a.label, a]));
  assert.deepEqual(parts[SAM].items, ['GUMDROPS', 'CANDY']); // no mark on each item
  assert.equal(partNote(parts[SAM], ', ', 200), `GUMDROPS, CANDY ${STORE_DEFAULT}`);
  assert.equal(partNote(parts[GRO], ', ', 200), 'MILK');
  assert.equal(parts[SAM].refs[0], receipt.items[0]); // the snapshot can find the item behind each text
  // the mark survives a long note: the items are cut, not the mark
  const long = { items: ['X'.repeat(300)], refs: [{ fellBack: true }] };
  assert.equal(partNote(long, ', ', 200).length, 200);
  assert.ok(partNote(long, ', ', 200).endsWith(STORE_DEFAULT));
  assert.equal(actual.provenance({ parentNotes: '#receipt a.jpg', notes: partNote(long, ', ', 200), cents: 1, category: SAM }), 'pipeline-fallback');
  assert.equal(stripAnnotations(`GUMDROPS, MILK ${STORE_DEFAULT}`), 'GUMDROPS, MILK');
  assert.equal(stripAnnotations('GUMDROPS (store default'), 'GUMDROPS');
  // a bare #always after the mark (or after "(maybe …)") still finds the item before it
  assert.deepEqual(kw.tagPhrases(`MILK, GUMDROPS ${STORE_DEFAULT} #always`, null), [{ phrase: 'GUMDROPS', strength: 'always' }]);
  assert.deepEqual(kw.tagPhrases('MILK, DVD (maybe Child 34%) #usually', null), [{ phrase: 'DVD', strength: 'usually' }]);
  // a small part folded into a bigger one keeps the refs in step with the items
  const merged = mergeSmallParts(allocate({ total: 10.5, subtotal: 10.5, items: [
    { description: 'GUMDROPS', amount: 0.5, category: SAM, fellBack: true },
    { description: 'MILK', amount: 10, category: GRO, confidence: 0.9 },
  ] }, labelToId, 1050).allocation, 100, null);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].items, ['MILK', 'GUMDROPS']);
  assert.equal(merged[0].refs.length, 2);
  assert.equal(partNote(merged[0], ', ', 200), 'MILK, GUMDROPS'); // not all of it was a default
});

// ---- 2. snapshot and watch ----

// applyPlan reads the transaction again before writing: a budget that still has it as matched.
const stubUnchangedTxn = () => {
  mock.method(api, 'getAccounts', async () => [{ id: 'a1', name: 'Checking' }]);
  mock.method(api, 'getPayees', async () => []);
  mock.method(api, 'getTransactions', async () => [{ id: 't1', date: day(-1), amount: -1000, notes: '' }]);
};

function plan(items, action = 'split') {
  const receipt = { payee: 'Target', store: 'TARGET 1234', total: 10, subtotal: 10, items };
  const { allocation } = allocate(receipt, labelToId, 1000);
  return { receipt, allocation, args: { item: { basename: 'a.jpg' }, txn: { id: 't1', date: day(-1), amount: -1000, notes: '' }, allocation, action, flags: [], currentLabel: null, summary: {}, receipt } };
}

test('a discount folded into its item: the snapshot lists the real items and the note says what was taken off', async () => {
  mock.method(api, 'updateTransaction', async () => {});
  stubUnchangedTxn();
  const receipt = { payee: 'Target', store: 'TARGET 1234', total: 10, subtotal: 10, items: [
    { description: 'MILK', amount: 6, category: GRO, confidence: 0.9 },
    { description: 'GUMDROPS', amount: 5, category: SAM, confidence: 0.9 },
    { description: 'COUPON', amount: -1 },
  ] };
  foldDiscounts(receipt);
  const { allocation } = allocate(receipt, labelToId, 1000);
  const out = await applyPlan({ item: { basename: 'a.jpg' }, txn: { id: 't1', date: day(-1), amount: -1000, notes: '' }, allocation, action: 'split', flags: [], currentLabel: null, summary: {}, receipt });
  assert.deepEqual(out.snapshot.parts.map((p) => [p.label, p.cents, p.note, p.items.map((i) => i.d)]), [[GRO, 600, 'MILK', ['MILK']], [SAM, 400, 'GUMDROPS (pipeline: after 1.00 off)', ['GUMDROPS']]]);
  // the sweep still finds the part: its note with and without the annotation is one part, and the item is still named in it
  assert.equal(partKey('GUMDROPS (pipeline: after 1.00 off)'), 'GUMDROPS');
});

test('applyPlan returns a snapshot in live mode only', async () => {
  mock.method(api, 'updateTransaction', async () => {});
  stubUnchangedTxn();
  const { args } = plan([
    { description: 'MILK', amount: 6, category: GRO, confidence: 0.9, keyword: 'milk', keywordCategory: GRO, source: 'keyword' },
    { description: 'GUMDROPS', plain: 'chewing gum', amount: 4, category: SAM, fellBack: true },
  ]);
  const out = await applyPlan({ ...args, flags: ['check it'] });
  const s = out.snapshot;
  assert.deepEqual({ ...s, parts: undefined }, { txnId: 't1', file: 'a.jpg', date: day(-1), payee: 'Target', store: 'TARGET 1234', amountCents: 1000, action: 'split', review: true, parts: undefined });
  assert.deepEqual(s.parts, [
    { label: GRO, cents: 600, note: 'MILK', items: [{ d: 'MILK', plain: null, src: 'keyword', cents: 600, conf: 0.9, kw: 'milk', kwCat: GRO }] }, // cents: the item's own price
    { label: SAM, cents: 400, note: `GUMDROPS (chewing gum) ${STORE_DEFAULT}`, items: [{ d: 'GUMDROPS', plain: 'chewing gum', src: 'fallback', cents: 400, conf: null }] },
  ]);
  config.dryRun = true;
  assert.equal((await applyPlan(args)).snapshot, undefined);
});

test('buildSnapshot: nothing to learn from a note-only change or a forced single category', () => {
  const { args, allocation } = plan([{ description: 'MILK', amount: 6, category: GRO }, { description: 'GUMDROPS', amount: 4, category: SAM }]);
  assert.equal(learning.buildSnapshot({ ...args, action: 'note' }), null);
  assert.equal(learning.buildSnapshot({ ...args, action: 'categorize' }), null); // several parts, splits off
  const one = plan([{ description: 'MILK', amount: 10, category: GRO, confidence: 0.9 }], 'confirm');
  const s = learning.buildSnapshot({ ...one.args, action: 'confirm' });
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].note, 'MILK');
  assert.ok(allocation.length === 2);
});

test('watch: 400 at most, 60 days at most, one entry per charge; LEARNING=off watches nothing', async () => {
  for (let i = 0; i < 402; i++) await memory.watch(snapshot({ txnId: `x${i}` }));
  let entries = await memory.loadWatch();
  assert.equal(entries.length, 400);
  assert.deepEqual([entries[0].txnId, entries.at(-1).txnId], ['x2', 'x401']); // the oldest went
  await memory.watch(snapshot({ txnId: 'x401', review: true }));
  entries = await memory.loadWatch();
  assert.equal(entries.length, 400);
  assert.equal(entries.filter((e) => e.txnId === 'x401').length, 1);
  assert.equal(entries.at(-1).review, true);
  // expiry: an entry from 61 days ago is gone at the next write and never read
  const old = Date.now() - 61 * 86400000;
  await memory.watch(snapshot({ txnId: 'old' }), old);
  assert.equal((await memory.loadWatch()).some((e) => e.txnId === 'old'), false);
  assert.equal((await memory.loadWatch(old + 1000)).some((e) => e.txnId === 'old'), true);
  config.learning.mode = 'off';
  await learning.watch(snapshot({ txnId: 'never' }));
  assert.equal((await memory.loadWatch()).some((e) => e.txnId === 'never'), false);
});

// ---- 3. what the sweep makes of each charge ----

const t = (over) => ({ id: 't1', date: day(-2), amount: -1000, notes: '#receipt a.jpg', ...over });
const summarize = (r) => (r.drop ? r.drop : r.fixes.map((f) => [f.item.d, f.said, f.filed, f.kind, f.group]));

test('judge: untouched charges teach nothing', () => {
  const snap = snapshot();
  const same = t({ is_parent: true, subtransactions: [child('c-gro', 600, 'MILK'), child('c-sam', 400, 'GUMDROPS')] });
  assert.deepEqual(summarize(learning.judge(snap, same, label)), []);
  // a single category that stayed
  const one = snapshot({ action: 'categorize', parts: [{ label: GRO, cents: 1000, note: 'MILK; GUMDROPS', items: [item('MILK'), item('GUMDROPS')] }] });
  assert.deepEqual(summarize(learning.judge(one, t({ category: 'c-gro' }), label)), []);
  // taking the category away says nothing, and neither does a category we can't name
  assert.deepEqual(summarize(learning.judge(one, t({ category: null }), label)), []);
  assert.deepEqual(summarize(learning.judge(one, t({ category: 'c-hidden' }), label)), []);
});

test('judge: a lone item or a split collapsed to one category; several items moved together are whole-receipt lessons, not item evidence', () => {
  const lone = snapshot({ action: 'categorize', parts: [{ label: GRO, cents: 1000, note: 'MILK', items: [item('MILK')] }] });
  const r = learning.judge(lone, t({ category: 'c-fun' }), label);
  assert.deepEqual(summarize(r), [['MILK', GRO, FUN, 'item', 0]]);
  assert.equal(r.fixes[0].solo, true);
  const one = snapshot({ action: 'categorize', parts: [{ label: GRO, cents: 1000, note: 'MILK; GUMDROPS', items: [item('MILK'), item('GUMDROPS')] }] });
  const many = learning.judge(one, t({ category: 'c-fun' }), label);
  assert.deepEqual(summarize(many), [['MILK', GRO, FUN, 'receipt', 0], ['GUMDROPS', GRO, FUN, 'receipt', 0]]);
  assert.ok(many.fixes.every((f) => f.solo === false));
  const got = learning.judge(snapshot(), t({ category: 'c-fun' }), label);
  assert.deepEqual(summarize(got), [['MILK', GRO, FUN, 'receipt', 0], ['GUMDROPS', SAM, FUN, 'receipt', 0]]);
  assert.ok(got.fixes.every((f) => f.solo === false));
  // collapsed into a category the split already had: only the other parts' items are corrections
  assert.deepEqual(summarize(learning.judge(snapshot(), t({ category: 'c-gro' }), label)), [['GUMDROPS', SAM, GRO, 'receipt', 0]]);
});

test('judge: a child you changed, an uncategorized part you filled, and a split you restructured', () => {
  const snap = snapshot({
    parts: [
      { label: GRO, cents: 500, note: 'MILK', items: [item('MILK')] },
      { label: SAM, cents: 300, note: 'GUMDROPS', items: [item('GUMDROPS')] },
      { label: null, cents: 200, note: 'DVD (maybe Child 34%)', items: [item('DVD', 'unsure', { conf: null })] },
    ],
  });
  const edited = t({ is_parent: true, subtransactions: [child('c-gro', 500, 'MILK'), child('c-fun', 300, 'GUMDROPS'), child('c-sam', 200, 'DVD (maybe Child 34%)')] });
  assert.deepEqual(summarize(learning.judge(snap, edited, label)), [['GUMDROPS', SAM, FUN, 'item', 1], ['DVD', null, SAM, 'filled', 2]]);
  // restructured: the amounts and notes no longer match; a child whose short note is that item takes it; others are skipped
  const redone = t({ is_parent: true, subtransactions: [child('c-fun', 450, 'milk'), child('c-sam', 550, 'misc stuff')] });
  assert.deepEqual(summarize(learning.judge(snap, redone, label)), [['MILK', GRO, FUN, 'item', 0]]);
  // you split a single-category charge yourself
  const one = snapshot({ action: 'categorize', parts: [{ label: GRO, cents: 1000, note: 'MILK; GUMDROPS', items: [item('MILK'), item('GUMDROPS')] }] });
  const byHand = t({ is_parent: true, subtransactions: [child('c-gro', 600, 'milk'), child('c-sam', 400, 'gumdrops')] });
  assert.deepEqual(summarize(learning.judge(one, byHand, label)), [['GUMDROPS', GRO, SAM, 'item', 1]]);
});

test('judge: the same note and amount in two parts is matched by unchanged category first; if it cannot be told, it is skipped', () => {
  const dup = (a, b) => snapshot({ parts: [{ label: a, cents: 500, note: 'GIFT CARD', items: [item('GIFT CARD')] }, { label: b, cents: 500, note: 'GIFT CARD', items: [item('GIFT CARD')] }] });
  const now = t({ is_parent: true, subtransactions: [child('c-fun', 500, 'GIFT CARD'), child('c-sam', 500, 'GIFT CARD')] });
  assert.deepEqual(summarize(learning.judge(dup(GRO, FUN), now, label)), [['GIFT CARD', GRO, SAM, 'item', 0]]); // the Gifts one is unchanged
  // both changed to the same two other categories: which is which cannot be known
  assert.deepEqual(summarize(learning.judge(dup(GRO, GRO), now, label)), []);
  // a short note that two children mention is not evidence for either
  const snap = snapshot({ parts: [{ label: GRO, cents: 600, note: 'MILK, BREAD', items: [item('MILK'), item('BREAD')] }, { label: SAM, cents: 400, note: 'SOAP', items: [item('SOAP')] }] });
  const sevenish = t({ is_parent: true, subtransactions: [child('c-fun', 300, 'milk chocolate for Sam'), child('c-gro', 300, 'bread'), child('c-sam', 400, 'SOAP')] });
  assert.deepEqual(summarize(learning.judge(snap, sevenish, label)), []); // "milk" is a small part of a long note; bread stayed
  const two = t({ is_parent: true, subtransactions: [child('c-fun', 150, 'milk'), child('c-gro', 150, 'milk'), child('c-gro', 300, 'bread'), child('c-sam', 400, 'SOAP')] });
  assert.deepEqual(summarize(learning.judge(snap, two, label)), []); // two children say milk
});

test('judge: an item folded into another part is judged by the category it was given, and agreeing with that is no correction', () => {
  const snap = snapshot({ parts: [{ label: GRO, cents: 1000, note: 'MILK, GUMDROPS', items: [item('MILK'), item('GUMDROPS', 'model', { cat: SAM, merged: true })] }] });
  const now = (c) => t({ is_parent: true, subtransactions: [child('c-gro', 600, 'MILK'), child(c, 400, 'GUMDROPS')] });
  // the parts do not match any more (amounts), so they are read as a restructure
  const r = learning.judge(snap, now('c-sam'), label);
  assert.deepEqual(summarize(r), []); // you filed it where the worker said Sam
  const moved = learning.judge(snap, now('c-fun'), label);
  assert.deepEqual(summarize(moved), [['GUMDROPS', SAM, FUN, 'item', 1]]);
  assert.equal(moved.fixes[0].mergedInto, GRO);
});

test('judge: a gone charge, a changed amount or a removed #receipt tag are dropped and teach nothing', () => {
  const snap = snapshot();
  assert.match(learning.judge(snap, undefined, label).drop, /gone/);
  assert.match(learning.judge(snap, t({ amount: -1100, category: 'c-fun' }), label).drop, /amount/);
  assert.match(learning.judge(snap, t({ notes: 'no tag', category: 'c-fun' }), label).drop, /tag/);
  assert.match(learning.judge(snap, t({ notes: '#receipt a.jpg2', category: 'c-fun' }), label).drop, /tag/);
});

test('judge: removing #review without changing anything confirms the charge; with a change it is only a lesson', () => {
  const snap = snapshot({ review: true });
  const children = [child('c-gro', 600, 'MILK'), child('c-sam', 400, 'GUMDROPS')];
  assert.equal(learning.judge(snap, t({ is_parent: true, subtransactions: children }), label).verified, true);
  assert.equal(learning.judge(snap, t({ is_parent: true, notes: '#receipt a.jpg #review', subtransactions: children }), label).verified, false);
  const moved = [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')];
  assert.equal(learning.judge(snap, t({ is_parent: true, subtransactions: moved }), label).verified, false);
  assert.equal(learning.judge(snapshot(), t({ is_parent: true, subtransactions: children }), label).verified, false); // never reviewed: silence
});

// ---- the sweep itself ----

const runSweep = (now = new Date()) => learning.sweep({ id2label, now });

test('sweep: lessons are made, replaced by a re-edit, and deleted by a revert; confirmation is remembered', async () => {
  const txns = [split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])];
  fakeBudget(txns);
  await memory.watch(snapshot({ review: true }));
  let r = await runSweep();
  assert.equal(r.lessons, 1);
  let { lessons } = await memory.loadLessonFile();
  assert.deepEqual(lessons.map((l) => [l.item, l.said, l.saidHow, l.filed, l.kind, l.group, l.payee, l.file]), [['GUMDROPS', SAM, 'model', FUN, 'item', 1, 'Target', 'a.jpg']]);
  assert.match(lessons[0].id, /^[0-9a-f]{12}$/);
  // you re-file it somewhere else: replaces, not adds
  txns[0] = split('t1', [child('c-gro', 600, 'MILK'), child('c-gro', 400, 'GUMDROPS')]);
  await runSweep();
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((l) => [l.item, l.filed]), [['GUMDROPS', GRO]]);
  // you put it back the way the worker had it: no lesson
  txns[0] = split('t1', [child('c-gro', 600, 'MILK'), child('c-sam', 400, 'GUMDROPS')]);
  await runSweep();
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
  // removing #review on an untouched charge verifies it
  txns[0] = split('t1', [child('c-gro', 600, 'MILK'), child('c-sam', 400, 'GUMDROPS')], '#receipt a.jpg');
  r = await runSweep();
  assert.equal(r.verified, 1);
  assert.equal((await memory.loadWatch())[0].verified, true);
  assert.ok((await memory.loadSweepInfo()).lastSweep);
});

test('sweep: a dropped charge leaves the watch list and earlier lessons stay; other charges are untouched', async () => {
  const txns = [split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')]), split('t2', [child('c-gro', 1000, 'RICE')], '#receipt b.jpg')];
  fakeBudget(txns);
  await memory.watch(snapshot());
  await memory.watch(snapshot({ txnId: 't2', file: 'b.jpg', parts: [{ label: GRO, cents: 1000, note: 'RICE', items: [item('RICE')] }] }));
  await runSweep();
  txns[0] = split('t1', [child('c-fun', 1000, 'x')], 'tag removed by hand');
  const r = await runSweep();
  assert.equal(r.dropped, 1);
  assert.deepEqual((await memory.loadWatch()).map((e) => e.txnId), ['t2']);
  assert.equal((await memory.loadLessonFile()).lessons.length, 1);
});

test('sweep: Forget tombstones a lesson so it is not made again, and Undo brings it back', async () => {
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])]);
  await memory.watch(snapshot());
  await runSweep();
  const [l] = (await memory.loadLessonFile()).lessons;
  assert.equal((await memory.forgetLesson(l.id)).item, 'GUMDROPS');
  assert.equal(await memory.forgetLesson(l.id), null);
  await runSweep();
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
  assert.equal((await memory.restoreLesson(l.id)).id, l.id);
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((x) => x.id), [l.id]);
  assert.equal(await memory.restoreLesson(l.id), null);
});

test('sweep is due: live only, something watched, over 6 hours since the last, never with LEARNING=off', async () => {
  const now = new Date();
  assert.equal(await learning.isDue(now), false, 'nothing watched');
  await memory.watch(snapshot());
  assert.equal(await learning.isDue(now), true);
  await memory.saveSweepInfo({ lastSweep: new Date(now - 5 * 3600000).toISOString() });
  assert.equal(await learning.isDue(now), false);
  await memory.saveSweepInfo({ lastSweep: new Date(now - 7 * 3600000).toISOString() });
  assert.equal(await learning.isDue(now), true);
  config.dryRun = true;
  assert.equal(await learning.isDue(now), false);
  config.dryRun = false;
  config.learning.mode = 'off';
  assert.equal(await learning.isDue(now), false);
});

test('lessons are capped at 1000: same item at the same payee merge with a count, then the oldest go', () => {
  const many = Array.from({ length: 1200 }, (_, i) => lessonRec({ id: String(i), txnId: `t${i}`, item: `ITEM ${i % 1100}`, date: shiftDay('2026-01-01', i % 300) }));
  const out = learning.compact(many);
  assert.equal(out.length, 1000);
  const dup = out.find((l) => l.item === 'ITEM 5');
  assert.equal(dup.count, 2);
  assert.deepEqual(learning.compact(many.slice(0, 10)), many.slice(0, 10));
});

// ---- 4. using lessons ----

test('withLessons: a correction replaces the worker\'s entry for that item and ranks above yours', () => {
  const history = Object.assign([
    { items: 'GUMDROPS, MILK', category: SAM, store: 'Target', payee: 'Target', date: day(-2), txnId: 't1', by: 'pipeline' },
    { items: 'gum drops', category: GRO, store: 'x', payee: null, date: day(-9), by: 'household' },
  ], { always: [] });
  const merged = learning.withLessons(history, [lessonRec(), lessonRec({ filed: 'Gone / Category', item: 'OTHER' })], new Map([[FUN, 'x'], [SAM, 'x'], [GRO, 'x']]));
  assert.deepEqual(merged.map((h) => [h.items, h.category, h.by]), [['gum drops', GRO, 'household'], ['GUMDROPS', FUN, 'corrected']]);
  assert.ok(Array.isArray(merged.always));
  assert.equal(similarItems({ description: 'GUMDROPS' }, merged)[0].filed_as, FUN);
});

test('relevantCorrections: the 3 best by shared words, a same-payee bonus, the item cut to 80 characters', () => {
  const l = (item, over = {}) => lessonRec({ item, txnId: item, ...over });
  const lessons = [
    l('GUMDROPS'), l('GUMDROPS MINT', { payee: 'Other' }), l('MINT GUMDROPS SUGAR FREE', { payee: 'Other', date: day(-1) }), l('GUMDROPS SUGAR', { payee: 'Target', date: day(-30) }),
    l('SOCKS'), l(`GUMDROPS ${'x'.repeat(200)}`),
  ];
  const got = relevantCorrections({ description: 'GUMDROPS' }, lessons, { payee: 'Target', labels: [GRO, SAM, FUN] });
  assert.equal(got.length, 3);
  assert.ok(!got.some((g) => g.item === 'SOCKS'));
  assert.equal(got[0].payee, 'Target'); // same payee first among equals
  assert.ok(got.every((g) => g.item.length <= 80));
  const all = relevantCorrections({ description: 'GUMDROPS' }, [l(`GUMDROPS ${'x'.repeat(200)}`)], { labels: [GRO, SAM, FUN] });
  assert.equal(all[0].item.length, 80);
  assert.deepEqual(relevantCorrections({ description: 'GUMDROPS' }, [l('GUMDROPS', { filed: 'Gone / Category' })], { labels: [GRO] }), []); // category no longer exists
  assert.equal(relevantCorrections({ description: 'GUMDROPS' }, [l('GUMDROPS', { said: 'Gone / Category' })], { labels: [GRO, SAM, FUN] })[0].said, null);
});

/** The bodies the local decider receives for one receipt item. */
async function localBodies(known, itemHistory = []) {
  Object.assign(config, { keywordMode: 'off', similarItems: true, excludeGroups: [], excludeCategories: [], deciderUrl: 'http://decider.test:8080' });
  const bodies = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ answers: { category: { choice: GRO, confidence: 0.9 } } }));
  });
  const receipt = { store: 'Target', payee: 'Target', merchant: 'Target', date: '2026-10-26', total: 2, items: [{ description: 'GUMDROPS', amount: 2 }] };
  await categorizeItems(receipt, [GRO, SAM, FUN], [], itemHistory, known);
  mock.restoreAll();
  return bodies;
}

test('the decider is told your corrections: at most 3, trimmed, and the field is absent without any', async () => {
  const none = (await localBodies({ lessons: [] }))[0].state;
  assert.ok(!('household_corrected_the_pipeline' in none));
  assert.ok(!('household_corrected_the_pipeline' in (await localBodies({}))[0].state));
  const lessons = ['GUMDROPS', 'GUMDROPS MINT', 'SUGAR GUMDROPS', 'GUMDROPS BALLS', 'SOCKS'].map((i) => lessonRec({ item: i, txnId: i }));
  const field = (await localBodies({ lessons }))[0].state.household_corrected_the_pipeline;
  assert.equal(field.length, 3);
  assert.deepEqual(Object.keys(field[0]), ['item', 'pipeline_said', 'household_filed', 'store']);
  assert.deepEqual([field[0].pipeline_said, field[0].household_filed, field[0].store], [SAM, FUN, 'TARGET 1234']);
});

// ---- 5. learned keywords ----

test('keywordCandidates: usually after 2 corrections on different receipts at one store, always after 3 without a contradiction', () => {
  const l = (txnId, over = {}) => lessonRec({ txnId, item: 'MED-GUMDROPS', filed: FUN, ...over });
  assert.deepEqual(learning.keywordCandidates([l('t1')]), []);
  assert.deepEqual(learning.keywordCandidates([l('t1'), l('t1')]), []); // the same receipt twice is one correction
  assert.deepEqual(learning.keywordCandidates([l('t1'), l('t2')]), [{ phrase: 'gumdrops', category: FUN, store: 'Target', strength: 'usually', fromTxn: 't2' }]);
  assert.equal(learning.keywordCandidates([l('t1'), l('t2'), l('t3')])[0].strength, 'always');
  const contradicted = learning.keywordCandidates([l('t1'), l('t2'), l('t3'), l('t4', { filed: GRO })]);
  assert.deepEqual(contradicted.map((k) => [k.category, k.strength]), [[FUN, 'usually']]);
  // another store is another group
  assert.deepEqual(learning.keywordCandidates([l('t1'), l('t2', { payee: 'Walmart' })]), []);
  // phrases follow tagPhrases: 1-4 words, 40 characters
  assert.deepEqual(learning.keywordCandidates(['a', 'b'].map((t0) => l(t0, { item: 'ONE TWO THREE FOUR FIVE' }))), []);
  assert.deepEqual(learning.keywordCandidates(['a', 'b'].map((t0) => l(t0, { item: 'W'.repeat(41) }))), []);
  assert.equal(learning.keywordCandidates(['a', 'b'].map((t0) => l(t0, { item: 'ONE TWO THREE FOUR' })))[0].phrase, 'one two three four');
});

test('keywordCandidates: items moved together never make a keyword alone, except on a small receipt; they never promote alone', () => {
  const w = (txnId, item, over = {}) => lessonRec({ txnId, item, kind: 'receipt', solo: false, said: GRO, filed: FUN, receiptItems: 20, amountCents: 20000, ...over });
  const big = (txnId) => ['MILK', 'EGGS', 'BREAD', 'OZ', '12 OZ', 'EA 2', 'TP'].map((i) => w(txnId, i));
  assert.deepEqual(learning.keywordCandidates(big('t1')), []); // one big receipt: nothing
  assert.deepEqual(learning.keywordCandidates([...big('t1'), ...big('t2'), ...big('t3'), ...big('t4')]), []); // at any count
  // they only add to a phrase that has a lone item behind it
  const solo = lessonRec({ txnId: 't5', item: 'MILK', filed: FUN, solo: true });
  assert.deepEqual(learning.keywordCandidates([...big('t1'), solo]).map((k) => [k.phrase, k.strength]), [['milk', 'usually']]);
  assert.equal(learning.keywordCandidates([...big('t1'), ...big('t2'), solo]).find((k) => k.phrase === 'milk').strength, 'always');
  assert.deepEqual(learning.keywordCandidates([...big('t1'), solo]).filter((k) => k.phrase !== 'milk'), []);
  // the food court: 3 items, $30 or less, one correction is enough
  const small = (item) => w('t9', item, { receiptItems: 2, amountCents: 1500 });
  assert.deepEqual(learning.keywordCandidates([small('PRETZEL'), small('LEMONADE')]).map((k) => [k.phrase, k.store, k.strength]), [['pretzel', 'Target', 'usually'], ['lemonade', 'Target', 'usually']]);
  assert.deepEqual(learning.keywordCandidates([small('PRETZEL')].map((l) => ({ ...l, amountCents: 3001 }))), []);
  assert.deepEqual(learning.keywordCandidates([small('PRETZEL')].map((l) => ({ ...l, receiptItems: 4 }))), []);
});

test('keywordCandidates: the real payee only, real words only, and the majority wins a contradiction', () => {
  const l = (txnId, over = {}) => lessonRec({ txnId, item: 'LEMONADE', filed: FUN, ...over });
  assert.deepEqual(learning.keywordCandidates([l('a', { payee: null }), l('b', { payee: null })]), []); // raw bank text is never used
  for (const item of ['BAGS', 'BOXES', 'BAG', 'OZ', '12 OZ', 'EA 2', 'TP', 'MISC', '2 @ 3.99', 'BTL DEP', 'SALE', 'GROCERY', 'TAX', 'INSTANT SAVINGS', 'COUPON', 'MED-DVD', 'ICE']) assert.equal(learning.keywordPhrase(item), null, item);
  assert.equal(learning.keywordPhrase('KS WATER 24PK'), 'ks water 24 pk');
  assert.equal(learning.keywordPhrase('TIDE'), 'tide');
  assert.deepEqual(learning.keywordCandidates([l('a'), l('b', { filed: GRO })]), []); // 1-1: nothing
  assert.deepEqual(learning.keywordCandidates([l('a'), l('b'), l('c', { filed: GRO })]).map((k) => [k.category, k.strength]), [[FUN, 'usually']]);
  assert.deepEqual(learning.keywordCandidates([l('a'), l('b'), l('c'), l('d', { filed: GRO }), l('e', { filed: GRO }), l('f', { filed: GRO }), l('g', { filed: GRO })]).map((k) => k.category), [GRO]);
});

test('learned keywords are made by the sweep, store-scoped, and yours always win', async () => {
  config.keywordMode = 'mixed';
  const txns = [
    split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')]),
    split('t2', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')], '#receipt b.jpg'),
  ];
  fakeBudget(txns);
  await memory.watch(snapshot());
  await runSweep();
  // one correction of a small receipt (2 items, $10) is enough for a "usually" keyword; a second one changes nothing
  assert.deepEqual((await kw.loadKeywords()).map((k) => [k.phrase, k.strength]), [['gumdrops', 'usually']]);
  await memory.watch(snapshot({ txnId: 't2', file: 'b.jpg' }));
  await runSweep();
  const [k] = await kw.loadKeywords();
  assert.deepEqual([k.phrase, k.category, k.store, k.strength, k.from], ['gumdrops', FUN, 'Target', 'usually', 'learned']);
  // matching: store-scoped, and a keyword of yours for the same words beats it even when global
  assert.equal(kw.matchKeyword(['GUMDROPS'], 'TARGET 1234', [k]).category, FUN);
  assert.equal(kw.matchKeyword(['GUMDROPS'], 'Walmart', [k]), null);
  const mine = { phrase: 'gumdrops', category: SAM, store: null, strength: 'usually', from: 'cli' };
  assert.equal(kw.matchKeyword(['GUMDROPS'], 'TARGET 1234', [k, mine]).category, SAM);
  // a third correction on a third receipt promotes it
  txns.push(split('t3', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')], '#receipt c.jpg'));
  await memory.watch(snapshot({ txnId: 't3', file: 'c.jpg' }));
  await runSweep();
  assert.equal((await kw.loadKeywords())[0].strength, 'always');
});

test('learnKeyword never overrides a keyword of yours, and respects removed phrases', async () => {
  const cand = { phrase: 'gumdrops', category: FUN, store: 'Target', strength: 'usually' };
  await kw.addKeyword({ phrase: 'gumdrops', category: SAM, store: null, from: 'cli' });
  assert.equal(await kw.learnKeyword(cand), 'blocked'); // a global keyword of yours exists for the phrase
  await kw.removeKeyword('gumdrops', null);
  assert.equal(await kw.learnKeyword(cand), 'blocked'); // removed on purpose
  await kw.addKeyword({ phrase: 'gumdrops', category: SAM, store: null, from: 'actual' });
  await kw.removeKeyword('gumdrops', null);
  assert.equal(await kw.learnKeyword({ ...cand, phrase: 'soda' }), 'added');
  assert.equal(await kw.learnKeyword({ ...cand, phrase: 'soda' }), 'kept');
  assert.equal(await kw.learnKeyword({ ...cand, phrase: 'soda', strength: 'always' }), 'promoted');
  await kw.removeKeyword('soda', 'Target');
  assert.equal(await kw.learnKeyword({ ...cand, phrase: 'soda' }), 'blocked');
});

// Lessons that taught a keyword: the same item filed `filed` at Target, on different receipts, each a lone item.
const taught = (filed, ...ids) => ids.map((id) => lessonRec({ id: id.padEnd(12, '0'), txnId: id, item: 'GUMDROPS', filed }));
const against = (filed, ...ids) => ids.map((id) => lessonRec({ id: id.padEnd(12, '0'), txnId: id, item: 'GUMDROPS BULK BAG', said: FUN, saidHow: 'keyword', filed, kw: 'gumdrops', kwCat: FUN }));
const resync = async (lessons) => {
  await memory.updateLessons(() => ({ lessons, forgotten: [] }));
  return kw.syncLearned(learning.keywordCandidates(lessons));
};
const learned = async () => (await kw.loadKeywords()).map((k) => [k.phrase, k.category, k.strength]);

test('correcting an item a learned keyword filed is a vote against it: one exception weakens it, a tie removes it, nothing is tombstoned, more agreement brings it back', async () => {
  const agree = taught(FUN, 'a1', 'a2', 'a3');
  await resync(agree);
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'always']]);
  // the keyword filed GUMDROPS in Gifts on t1 and you moved it: that lesson carries the keyword it went against
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-gro', 400, 'GUMDROPS')])]);
  await memory.watch(snapshot({ parts: [{ label: GRO, cents: 600, note: 'MILK', items: [item('MILK')] }, { label: FUN, cents: 400, note: 'GUMDROPS', items: [item('GUMDROPS', 'keyword', { kw: 'gumdrops', kwCat: FUN })] }] }));
  await runSweep();
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'usually']], '3 receipts for, 1 against: weaker, not gone (always needs more than 3 times as many)');
  const lesson = (await memory.loadLessonFile()).lessons.find((l) => l.txnId === 't1');
  assert.deepEqual([lesson.kw, lesson.kwCat, lesson.filed], ['gumdrops', FUN, GRO]);
  // as many against as for (the exceptions word the item differently, "GUMDROPS BULK BAG"): the keyword goes, because the evidence says so
  const mixed = [...agree, ...against(GRO, 'b1', 'b2', 'b3')];
  assert.deepEqual(await resync(mixed), { added: 1, removed: 1 }); // (the exceptions teach a keyword of their own)
  assert.deepEqual(await learned(), [['gumdrops bulk bag', GRO, 'always']]);
  assert.equal(JSON.parse(fs.readFileSync(config.keywordsPath, 'utf8')).removed, undefined, 'nothing was tombstoned');
  // more receipts agreeing bring it back
  await resync([...mixed, ...taught(FUN, 'a4', 'a5')]);
  assert.deepEqual(await learned(), [['gumdrops bulk bag', GRO, 'always'], ['gumdrops', FUN, 'usually']], '5 for, 3 against');
  // and with enough agreeing fixes it is "always" again: 10 for, 3 against
  await resync([...mixed, ...taught(FUN, 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10')]);
  assert.deepEqual((await learned()).find(([p]) => p === 'gumdrops'), ['gumdrops', FUN, 'always']);
});

test('a learned keyword outvoted the other way flips to the other category; your own removal stays permanent', async () => {
  await resync([...taught(FUN, 'a1', 'a2'), ...against(GRO, 'b1', 'b2', 'b3')]);
  assert.deepEqual((await learned()).find(([p]) => p === 'gumdrops'), ['gumdrops', GRO, 'usually']);
  await kw.removeKeyword('gumdrops', 'Target');
  await resync(taught(GRO, 'c1', 'c2', 'c3', 'c4'));
  assert.deepEqual(await learned(), [], 'removed by you: never learned again, however many corrections');
});

test('only a lone item or a small receipt counts against a keyword: a big receipt moved whole does not', async () => {
  const agree = taught(FUN, 'a1', 'a2', 'a3');
  const bigReceipt = against(GRO, 'b1', 'b2', 'b3').map((l) => ({ ...l, solo: false, kind: 'receipt', receiptItems: 9, amountCents: 20000 }));
  await resync([...agree, ...bigReceipt]);
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'always']]);
});

test('a hint the model ignored but you corrected away from counts against the learned keyword; agreeing with it does not', async () => {
  const agree = taught(FUN, 'a1', 'a2', 'a3');
  await resync(agree);
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])]);
  // you agree with the keyword (the model said Sam, you filed Gifts): nothing against it
  await memory.watch(snapshot({ parts: [{ label: GRO, cents: 600, note: 'MILK', items: [item('MILK')] }, { label: SAM, cents: 400, note: 'GUMDROPS', items: [item('GUMDROPS', 'model', { kw: 'gumdrops', kwCat: FUN })] }] }));
  await runSweep();
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'always']]);
  // the model said Sam although the keyword said Gifts, and you filed Groceries
  fakeBudget([split('t2', [child('c-gro', 600, 'MILK'), child('c-gro', 400, 'GUMDROPS')], '#receipt b.jpg')]);
  await memory.watch(snapshot({ txnId: 't2', file: 'b.jpg', parts: [{ label: GRO, cents: 600, note: 'MILK', items: [item('MILK')] }, { label: SAM, cents: 400, note: 'GUMDROPS', items: [item('GUMDROPS', 'model', { kw: 'gumdrops', kwCat: FUN })] }] }));
  await runSweep();
  // (agreeing with it above was a correction too: 4 for, 1 against, so still "always")
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'always']]);
  fakeBudget([split('t3', [child('c-gro', 600, 'MILK'), child('c-gro', 400, 'GUMDROPS')], '#receipt c.jpg')]);
  await memory.watch(snapshot({ txnId: 't3', file: 'c.jpg', parts: [{ label: GRO, cents: 600, note: 'MILK', items: [item('MILK')] }, { label: SAM, cents: 400, note: 'GUMDROPS', items: [item('GUMDROPS', 'model', { kw: 'gumdrops', kwCat: FUN })] }] }));
  await runSweep();
  assert.deepEqual(await learned(), [['gumdrops', FUN, 'usually']], '4 for, 2 against: not more than three times');
  // a keyword of yours that filed an item you then corrected stays (it is a lesson only)
  await kw.addKeyword({ phrase: 'milk', category: GRO, store: null, from: 'cli' });
  fakeBudget([split('t5', [child('c-fun', 1000, 'MILK')], '#receipt e.jpg')]);
  await memory.watch(snapshot({ txnId: 't5', file: 'e.jpg', parts: [{ label: GRO, cents: 1000, note: 'MILK', items: [item('MILK', 'keyword', { kw: 'milk' })] }] }));
  await runSweep();
  assert.ok((await kw.loadKeywords()).some((k) => k.phrase === 'milk' && k.from === 'cli'));
});

test('a whole receipt recategorized makes a store keyword per item after one correction', async () => {
  fakeBudget([single('t1', 'c-fun', '#receipt a.jpg')]);
  await memory.watch(snapshot({ parts: [
    { label: GRO, cents: 500, note: 'PRETZEL', items: [item('PRETZEL')] },
    { label: SAM, cents: 500, note: 'LEMONADE', items: [item('LEMONADE')] },
  ] }));
  const r = await runSweep();
  assert.equal(r.keywords, 2);
  assert.deepEqual((await kw.loadKeywords()).map((k) => [k.phrase, k.store, k.category, k.from]), [['pretzel', 'Target', FUN, 'learned'], ['lemonade', 'Target', FUN, 'learned']]);
  assert.ok((await memory.loadLessonFile()).lessons.every((l) => l.kind === 'receipt'));
});

test('LEARNING=record learns but does not use; LEARNING=off keeps learned keywords out of the decider too', async () => {
  config.learning.mode = 'record';
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])]);
  await memory.watch(snapshot());
  await runSweep();
  assert.equal((await memory.loadLessonFile()).lessons.length, 1); // learned
  assert.deepEqual(await learning.usableLessons(), []); // not used
  await kw.learnKeyword({ phrase: 'gumdrops', category: FUN, store: 'Target' });
  config.keywordMode = 'final';
  const picked = async () => {
    mock.method(globalThis, 'fetch', async (url) => (String(url).endsWith('/health') ? new Response('ok') : new Response(JSON.stringify({ answers: { category: { choice: GRO, confidence: 0.9 } } }))));
    config.deciderUrl = 'http://decider.test:8080';
    const receipt = { store: 'Target', merchant: 'Target', date: '2026-10-26', total: 2, items: [{ description: 'GUMDROPS', amount: 2 }] };
    await categorizeItems(receipt, [GRO, SAM, FUN], [], [], { chargeCents: 1000 }); // the sweep's own keyword has a size limit
    mock.restoreAll();
    return receipt.items[0].source ?? 'model';
  };
  assert.equal(await picked(), 'model');
  config.learning.mode = 'off';
  assert.equal(await picked(), 'model');
  config.learning.mode = 'on';
  assert.equal(await picked(), 'keyword-hint'); // in final mode a learned keyword is only a hint
  await kw.addKeyword({ phrase: 'gumdrops', category: FUN, store: 'Target', strength: 'always', from: 'cli' });
  assert.equal(await picked(), 'keyword'); // yours is filed without the model
});

// ---- review fixes ----

const COSTCO_ITEMS = ['MILK', 'EGGS', 'KS PAPER TOWEL', 'BANANAS', 'ROTISSERIE CHICKEN', 'KS WATER', 'OZ', '12 OZ', 'EA 2', 'TP', 'BREAD', 'BUTTER', 'CHEESE', 'APPLES', 'SALAD', 'TIDE PODS', 'DAWN', 'BATTERIES', 'SOCKS', 'DIAPERS'];
const costco = (txnId) => snapshot({ txnId, file: `${txnId}.jpg`, payee: 'Costco', store: 'COSTCO #12', amountCents: 20000, parts: [
  { label: GRO, cents: 15000, note: COSTCO_ITEMS.slice(0, 15).join(', '), items: COSTCO_ITEMS.slice(0, 15).map((d) => item(d)) },
  { label: SAM, cents: 5000, note: COSTCO_ITEMS.slice(15).join(', '), items: COSTCO_ITEMS.slice(15).map((d) => item(d)) },
] });
const collapsed = (txnId) => t({ id: txnId, amount: -20000, notes: `#receipt ${txnId}.jpg`, category: 'c-fun' });
const lessonsOf = (entry, j) => j.fixes.map((f) => learning.lessonOf(entry, f));

test('one collapsed 20-item split is whole-receipt evidence: no keywords alone, one line in the examples and the corrections', () => {
  const entry = costco('c1');
  const lessons = lessonsOf(entry, learning.judge(entry, collapsed('c1'), label));
  assert.equal(lessons.length, 20);
  assert.ok(lessons.every((l) => l.kind === 'receipt' && l.solo === false && l.receiptItems === 20 && l.amountCents === 20000));
  assert.deepEqual(learning.keywordCandidates(lessons), []);
  // a second collapsed receipt: ordinary words only (no units, no "tp"), usually, never always, even after a third
  const more = (id) => lessonsOf(costco(id), learning.judge(costco(id), collapsed(id), label));
  assert.deepEqual(learning.keywordCandidates([...lessons, ...more('c2'), ...more('c3')]), []); // two or three big collapses: still nothing
  // the examples: ONE corrected line, not 20, and it does not outrank what is really known about milk
  const history = Object.assign([{ items: 'milk', category: GRO, store: 'Costco', payee: 'Costco', date: day(-30), by: 'household' }], { always: [] });
  const merged = learning.withLessons(history, lessons, labelToId);
  assert.equal(merged.filter((h) => h.by === 'corrected').length, 0); // not an example of anything
  // the decider hears one line, and only at the same store
  const lines = relevantCorrections({ description: 'MILK' }, lessons, { payee: 'Costco', labels: [GRO, SAM, FUN] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].item, /^whole receipt: /);
  assert.deepEqual(relevantCorrections({ description: 'MILK' }, lessons, { payee: 'Target', labels: [GRO, SAM, FUN] }), []);
  // and a lesson about this very item moved alone ranks above the whole-receipt line
  const alone = lessonRec({ item: 'MILK', txnId: 'z', filed: GRO, solo: true, payee: 'Costco' });
  assert.equal(relevantCorrections({ description: 'MILK' }, [...lessons, alone], { payee: 'Costco', labels: [GRO, SAM, FUN] })[0].item, 'MILK');
});

test('a failed sweep backs off from its attempt instead of retrying every poll; an Actual that will not open counts too', async () => {
  fakeBudget([]);
  mock.method(api, 'getTransactions', async () => { throw new Error('boom'); });
  await memory.watch(snapshot());
  const now = new Date();
  assert.equal(await learning.isDue(now), true);
  await assert.rejects(learning.sweep({ id2label, now }), /boom/);
  assert.equal(await learning.isDue(new Date(now.getTime() + 3600000)), false, '1 hour after a failed attempt');
  assert.equal(await learning.isDue(new Date(now.getTime() + 13 * 3600000)), true, 'after 12 hours');
  await learning.recordFailedAttempt(now); // a second failure (Actual would not open): 24 hours
  assert.equal(await learning.isDue(new Date(now.getTime() + 13 * 3600000)), false);
  assert.equal(await learning.isDue(new Date(now.getTime() + 25 * 3600000)), true);
  assert.equal((await memory.loadSweepInfo()).failures, 2);
  mock.restoreAll();
  fakeBudget([]);
  await learning.sweep({ id2label, now: new Date(now.getTime() + 26 * 3600000) }); // a finished sweep clears the count
  assert.equal((await memory.loadSweepInfo()).failures, 0);
});

test('a charge dated more than 60 days back is still found (the watch expires by when it was watched, not by the charge date)', async () => {
  const old = day(-75);
  const asked = [];
  mock.method(api, 'getAccounts', async () => [{ id: 'a1', name: 'Checking' }]);
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Target' }]);
  const txns = [single('t1', 'c-fun', '#receipt a.jpg — items: MILK', { date: old })];
  mock.method(api, 'getTransactions', async (_i, s, e) => { asked.push(s); return txns.filter((x) => x.date >= s && x.date <= e); });
  await memory.watch(snapshot({ date: old, action: 'categorize', parts: [{ label: GRO, cents: 1000, note: 'MILK', items: [item('MILK')] }] }));
  const r = await runSweep();
  assert.equal(r.dropped, 0);
  assert.ok(asked[0] <= shiftDay(old, -7));
  assert.equal(r.lessons, 1);
});

test('what you confirmed or corrected outlives the 60-day watch, and counts as yours in the store history', async () => {
  const txns = [
    split('p1', [child('c-fun', 1000, 'GUMDROPS')], '#receipt a.jpg'),
    split('p2', [child('c-gro', 1000, 'RICE')], '#receipt b.jpg'),
    split('p3', [child('c-gro', 1000, 'SODA')], '#receipt c.jpg'),
  ];
  fakeBudget(txns);
  await memory.recordMarks({ confirmed: ['p2'], corrected: { p1: ['GUMDROPS'] } });
  // no watch entries at all: the marks alone decide
  const h = Object.fromEntries((await actual.itemHistory('none', id2label)).map((x) => [x.items, x.by]));
  assert.deepEqual(h, { GUMDROPS: 'corrected', RICE: 'household', SODA: 'pipeline' });
  const hist = await actual.storeHistory('Target', 'none', id2label);
  assert.deepEqual(hist.map((x) => x.by).sort(), ['household', 'household', 'pipeline']);
  assert.equal(storeConsensus([{ by: 'household', parts: [{ category: GRO }] }, { by: 'household', parts: [{ category: GRO }] }, { by: 'household', parts: [{ category: GRO }] }]).count, 3);
  // a later sweep records a correction that is then reverted: the mark is cleared
  txns[0] = split('p1', [child('c-sam', 1000, 'GUMDROPS')], '#receipt a.jpg');
  await memory.watch(snapshot({ txnId: 'p1', file: 'a.jpg', amountCents: 1000, parts: [{ label: SAM, cents: 1000, note: 'GUMDROPS', items: [item('GUMDROPS')] }] }));
  await runSweep();
  assert.equal((await memory.loadMarks()).corrected.p1, undefined);
});

test('verified is not sticky: a later correction clears it; patchWatch keeps a charge watched meanwhile; marks are bounded', async () => {
  const txns = [split('t1', [child('c-gro', 600, 'MILK'), child('c-sam', 400, 'GUMDROPS')])];
  fakeBudget(txns);
  await memory.watch(snapshot({ review: true }));
  await runSweep();
  assert.equal((await memory.loadWatch())[0].verified, true);
  assert.deepEqual((await memory.loadMarks()).confirmed, ['t1']);
  txns[0] = split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')]);
  await runSweep();
  assert.equal((await memory.loadWatch())[0].verified, undefined);
  assert.deepEqual((await memory.loadMarks()).confirmed, []);
  assert.deepEqual((await memory.loadMarks()).corrected, { t1: ['GUMDROPS'] });
  await memory.watch(snapshot({ txnId: 'later' }));
  await memory.patchWatch({ drop: ['t1'] });
  assert.deepEqual((await memory.loadWatch()).map((e) => e.txnId), ['later']);
  await memory.recordMarks({ confirmed: Array.from({ length: 5100 }, (_, i) => `m${i}`) });
  assert.equal((await memory.loadMarks()).confirmed.length, 5000);
});

test('a damaged memory file is never written over: reads throw, receipts carry on, the sweep backs off', async () => {
  fs.mkdirSync(config.learning.dir, { recursive: true });
  const bad = path.join(config.learning.dir, 'lessons.json');
  fs.writeFileSync(bad, '{oops');
  await assert.rejects(memory.loadLessonFile(), memory.MemoryError);
  await assert.rejects(memory.updateLessons((x) => x), memory.MemoryError);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{oops');
  assert.deepEqual(await learning.usableLessons(), []); // a receipt does not stop
  fs.writeFileSync(path.join(config.learning.dir, 'watch.json'), '[1]');
  assert.deepEqual([...(await memory.watchIndex()).byTxn], []);
  assert.equal(await learning.isDue(), false); // says so once and waits
  assert.equal(fs.readFileSync(path.join(config.learning.dir, 'watch.json'), 'utf8'), '[1]');
  assert.equal((await memory.learnedData()).error.includes('damaged'), true);
});

test('replay and item-test use none of the learned keywords unless asked', async () => {
  await kw.learnKeyword({ phrase: 'gumdrops', category: FUN, store: 'Target' });
  config.keywordMode = 'hint';
  const run = async (known) => {
    mock.method(globalThis, 'fetch', async (url) => (String(url).endsWith('/health') ? new Response('ok') : new Response(JSON.stringify({ answers: { category: { choice: GRO, confidence: 0.9 } } }))));
    config.deciderUrl = 'http://decider.test:8080';
    const receipt = { store: 'Target', merchant: 'Target', date: '2026-10-26', total: 2, items: [{ description: 'GUMDROPS', amount: 2 }] };
    await categorizeItems(receipt, [GRO, SAM, FUN], [], [], known);
    mock.restoreAll();
    return receipt.items[0].keyword ?? null;
  };
  assert.equal(await run({}), 'gumdrops');
  assert.equal(await run({ ignoreLearned: true }), null);
});

test('compaction keeps the count of a merged lesson when one of its receipts is re-judged; withLessons matches items exactly', () => {
  const many = Array.from({ length: 1005 }, (_, i) => lessonRec({ id: String(i).padStart(12, '0'), txnId: `t${i}`, item: i < 4 ? 'SAME ITEM' : `ITEM ${i}`, date: shiftDay('2026-01-01', i % 300) }));
  const out = learning.compact(many);
  const merged = out.find((l) => l.item === 'SAME ITEM');
  assert.equal(merged.count, 4);
  assert.deepEqual([...merged.txnIds].sort(), ['t0', 't1', 't2', 't3']);
  assert.equal(learning.keywordCandidates([{ ...merged, item: 'SOMETHING TASTY' }]).length, 1); // the count is evidence: 4 receipts
  const h = Object.assign([{ items: 'GUMDROPS DELUXE, MILK', category: SAM, store: 's', txnId: 't1', by: 'pipeline' }, { items: 'MILK, GUMDROPS', category: SAM, store: 's', txnId: 't1', by: 'pipeline' }], { always: [] });
  const out2 = learning.withLessons(h, [lessonRec({ txnId: 't1', item: 'GUMDROPS' })], labelToId);
  assert.deepEqual(out2.map((x) => x.items), ['GUMDROPS DELUXE, MILK', 'GUMDROPS']); // "GUMDROPS DELUXE" is not "GUMDROPS"
});

test('lessons for the same description in two parts get different ids', () => {
  const e = snapshot({ parts: [{ label: GRO, cents: 500, note: 'GIFT CARD', items: [item('GIFT CARD')] }, { label: SAM, cents: 500, note: 'GIFT CARD x', items: [item('GIFT CARD')] }] });
  const ids = e.parts.map((p, g) => learning.lessonOf(e, { item: p.items[0], said: p.label, filed: FUN, kind: 'item', group: g, solo: true, partNote: p.note }).id);
  assert.notEqual(ids[0], ids[1]);
});

test('re-judging one receipt of a merged lesson gives up only its share of the count', async () => {
  await memory.updateLessons(() => ({ lessons: [lessonRec({ id: 'mmmmmmmmmmmm'.replace(/m/g, 'a'), txnId: 't1', txnIds: ['t1', 'x', 'y'], count: 3 })], forgotten: [] }));
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])]);
  await memory.watch(snapshot());
  await runSweep();
  const { lessons } = await memory.loadLessonFile();
  assert.equal(lessons.length, 2);
  const old = lessons.find((l) => l.count === 2);
  assert.deepEqual([old.txnId, old.txnIds], ['x', ['x', 'y']]);
  assert.ok(lessons.some((l) => l.txnId === 't1' && (l.count ?? 1) === 1));
});

test('only the parts you did not touch stay the worker\'s in the store history', async () => {
  fakeBudget([split('p1', [child('c-gro', 500, 'MILK'), child('c-fun', 500, 'TOYS')], '#receipt a.jpg')]);
  await memory.recordMarks({ corrected: { p1: ['TOYS'] } });
  const [h] = await actual.storeHistory('Target', 'none', id2label);
  assert.deepEqual(h.parts.map((p) => [p.category, p.by]), [[GRO, 'pipeline'], [FUN, 'household']]);
  const purchase = (cat) => ({ by: 'household', parts: [{ category: cat, amount: '1', by: 'pipeline' }, { category: GRO, amount: '1', by: 'household' }] });
  assert.deepEqual(storeConsensus([purchase(SAM), purchase(SAM), purchase(SAM)]), { label: GRO, count: 3 }); // the pipeline parts do not count
});

test('lessons from before the solo field: a whole-receipt one is not solo, and a 1-item recategorized receipt is a solo lesson', () => {
  const old = (txnId) => lessonRec({ txnId, item: 'LEMONADE', kind: 'receipt', filed: FUN });
  delete old('a').solo;
  assert.deepEqual(learning.keywordCandidates([old('a'), old('b'), old('c')]), []);
  assert.equal(relevantCorrections({ description: 'LEMONADE' }, [old('a')], { payee: 'Target', labels: [GRO, SAM, FUN] })[0].item, 'whole receipt: LEMONADE');
  const one = snapshot({ action: 'categorize', amountCents: 500, parts: [{ label: GRO, cents: 500, note: 'HOT DOG', items: [item('HOT DOG')] }] });
  const r = learning.judge(one, t({ amount: -500, category: 'c-fun' }), label);
  assert.deepEqual([r.fixes[0].kind, r.fixes[0].solo], ['item', true]);
  const l = (id) => lessonsOf({ ...one, txnId: id }, r);
  assert.equal(learning.keywordCandidates([...l('a'), ...l('b')]).length, 1); // solo rules: two receipts
});

test('the attempt is written down once: a sweep told it was recorded does not count again', async () => {
  fakeBudget([]);
  await memory.watch(snapshot());
  await learning.recordFailedAttempt(); // what index.js does the moment a sweep is due
  await learning.sweep({ id2label, recorded: true });
  assert.equal((await memory.loadSweepInfo()).failures, 0);
  await learning.recordFailedAttempt(); // then Actual cannot be reached: nothing else happens, the failure stands
  assert.equal((await memory.loadSweepInfo()).failures, 1);
});

test('keywordCandidates: one small split part teaches like a small receipt; a big part, or a lesson from before the fields existed, does not', () => {
  const part = (txnId, item, over = {}) => lessonRec({ txnId, payee: 'Costco', item, kind: 'item', solo: false, said: GRO, filed: FUN, receiptItems: 3, amountCents: 1378, partItems: 2, partCents: 940, ...over });
  const two = (over) => [part('t1', 'CHICKEN STRP', over), part('t1', '20 OZ COKE', over)];
  assert.deepEqual(learning.keywordCandidates(two()).map((k) => [k.phrase, k.strength, k.maxCents]), [['chicken strp', 'usually', 3000], ['20 oz coke', 'usually', 3000]]);
  assert.deepEqual(learning.keywordCandidates(two({ partItems: 4 })), []);
  assert.deepEqual(learning.keywordCandidates(two({ partCents: 3001 })), []);
  const { partItems, partCents, ...old } = two()[0];
  assert.deepEqual(learning.keywordCandidates([old]), []);
  // a whole-receipt lesson still goes by the receipt, whatever part it came from
  assert.deepEqual(learning.keywordCandidates(two({ kind: 'receipt', receiptItems: 5 })), []);
});

test('keywordCandidates: a lone item on a big receipt still needs two corrections, and "always" still needs three with a lone item', () => {
  const big = (txnId, over = {}) => lessonRec({ txnId, payee: 'Costco', item: 'PRETZEL', kind: 'receipt', solo: true, said: GRO, filed: FUN, receiptItems: 1, amountCents: 5000, ...over });
  assert.deepEqual(learning.keywordCandidates([big('t1')]), []); // $50: not small, one correction
  assert.deepEqual(learning.keywordCandidates([big('t1'), big('t2')]).map((k) => [k.strength, k.maxCents]), [['usually', 10000]]);
  const small = (txnId) => big(txnId, { amountCents: 500 });
  assert.equal(learning.keywordCandidates([small('t1'), small('t2')])[0].strength, 'usually'); // small does not promote
  assert.equal(learning.keywordCandidates([small('t1'), small('t2'), small('t3')])[0].strength, 'always');
  // three small receipts of several items each, none a lone item: usually, never always
  const group = (txnId) => lessonRec({ txnId, payee: 'Costco', item: 'PRETZEL', kind: 'receipt', solo: false, said: GRO, filed: FUN, receiptItems: 2, amountCents: 900 });
  assert.equal(learning.keywordCandidates([group('t1'), group('t2'), group('t3')])[0].strength, 'usually');
  // maxCents follows the evidence's size, small or not
  assert.equal(learning.keywordCandidates([small('t1'), big('t2', { amountCents: 4000 })])[0].maxCents, 8000);
});

test('syncLearned: writes maxCents, updates it (also on promotion), and leaves household keywords alone', async () => {
  const cand = (over = {}) => ({ phrase: 'chicken strp', category: FUN, store: 'Costco', strength: 'usually', fromTxn: 't1', maxCents: 3000, ...over });
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'milk', category: GRO, store: 'Costco', from: 'cli', added: '2026-01-01' }] }));
  await kw.syncLearned([cand(), cand({ phrase: 'milk', category: FUN })]);
  const read = () => JSON.parse(fs.readFileSync(config.keywordsPath, 'utf8')).keywords;
  assert.equal(read().find((k) => k.phrase === 'chicken strp').maxCents, 3000);
  assert.deepEqual(read().find((k) => k.phrase === 'milk'), { phrase: 'milk', category: GRO, store: 'Costco', from: 'cli', added: '2026-01-01' });
  await kw.syncLearned([cand({ maxCents: 5000 })]);
  assert.equal(read().find((k) => k.phrase === 'chicken strp').maxCents, 5000);
  await kw.syncLearned([cand({ maxCents: 6000, strength: 'always' })]);
  assert.equal(read().find((k) => k.phrase === 'chicken strp').maxCents, 6000);
  assert.equal(read().find((k) => k.phrase === 'chicken strp').strength, 'always');
  await kw.syncLearned([cand({ maxCents: undefined })]);
  assert.equal('maxCents' in read().find((k) => k.phrase === 'chicken strp'), false);
});

test('keywordCandidates: maxCents follows the size of the evidence, not the whole charge; big collapsed lessons and filled parts add nothing', () => {
  const part = (txnId, item, over = {}) => lessonRec({ txnId, payee: 'Costco', item, kind: 'item', solo: false, said: GRO, filed: FUN, receiptItems: 9, amountCents: 20000, partItems: 2, partCents: 940, ...over });
  // a 2-item $9.40 part inside a $200 run: limit from the part
  assert.equal(learning.keywordCandidates([part('t1', 'CHICKEN STRP')])[0].maxCents, 3000);
  assert.equal(learning.keywordCandidates([part('t1', 'CHICKEN STRP'), part('t2', 'CHICKEN STRP', { partCents: 2400 })])[0].maxCents, 4800);
  // a lone item: its charge
  const solo = (txnId, amountCents) => lessonRec({ txnId, payee: 'Costco', item: 'CHICKEN STRP', filed: FUN, solo: true, amountCents });
  assert.equal(learning.keywordCandidates([solo('t1', 2000), solo('t2', 2500)])[0].maxCents, 5000);
  // a big collapsed receipt backing a lone item does not raise it
  const big = lessonRec({ txnId: 't3', payee: 'Costco', item: 'CHICKEN STRP', filed: FUN, kind: 'receipt', solo: false, receiptItems: 20, amountCents: 90000 });
  assert.equal(learning.keywordCandidates([solo('t1', 2000), solo('t2', 2500), big])[0].maxCents, 5000);
  // a filled-in Uncategorized small part is not a small part
  assert.deepEqual(learning.keywordCandidates([part('t1', 'CHICKEN STRP', { kind: 'filled' })]), []);
});

test('compact keeps the evidence of the lessons it merges', () => {
  const mk = (txnId, over = {}) => lessonRec({ txnId, payee: 'Costco', item: 'CHICKEN STRP', filed: FUN, date: day(-2), ...over });
  const soloOld = mk('t1', { solo: true, amountCents: 4000, date: day(-5) });
  const bigNew = mk('t2', { kind: 'receipt', solo: false, receiptItems: 20, amountCents: 90000 });
  const smallNew = mk('t3', { kind: 'item', solo: false, partItems: 2, partCents: 940, amountCents: 20000, date: day(-1) });
  const [m] = learning.compact([soloOld, bigNew, smallNew], 2);
  assert.equal(m.evidenceCents, 4000);
  assert.equal(m.evidence, true);
  // the merged lesson still reads as a lone item and keeps the limit; a second receipt makes a keyword
  const other = mk('t4', { solo: true, amountCents: 1000 });
  const got = learning.keywordCandidates([m, other]);
  assert.deepEqual(got.map((k) => [k.phrase, k.maxCents]), [['chicken strp', 8000]]);
  // merging only big collapsed lessons leaves no evidence
  const [b] = learning.compact([bigNew, { ...bigNew, txnId: 't5' }], 1);
  assert.equal(b.evidence, false);
  assert.equal('evidenceCents' in b, false);
});

test('keywordFits: only a positive finite charge size passes a limited learned keyword', () => {
  const k = { phrase: 'x', from: 'learned', maxCents: 3000 };
  assert.deepEqual([1378, 3000, 3001, 0, -0, -500, null, undefined, NaN].map((c) => kw.keywordFits(k, c)), [true, true, false, false, false, false, false, false, false]);
  assert.equal(kw.keywordFits({ ...k, from: 'cli' }, null), true);
  assert.equal(kw.keywordFits({ ...k, maxCents: undefined }, null), true);
});

// ---- learned keywords: the item-price limit ----

// The food court: three items, one split part, a $13.78 charge, learned as Restaurants (FUN here).
const foodCourt = () => [['COKE', 158], ['CHICKEN BAKE', 399], ['CHICKEN STRP', 699]].map(([item, itemCents]) => lessonRec({ txnId: 'fc', payee: 'Costco', item, kind: 'item', solo: false, said: GRO, filed: FUN, receiptItems: 3, amountCents: 1378, partItems: 3, partCents: 1378, itemCents }));

test('keywordCandidates: maxItemCents is twice the largest evidence item price, at least $5, next to the charge limit', () => {
  const got = Object.fromEntries(learning.keywordCandidates(foodCourt()).map((k) => [k.phrase, [k.maxCents, k.maxItemCents]]));
  assert.deepEqual(got, { coke: [3000, 500], 'chicken bake': [3000, 798], 'chicken strp': [3000, 1398] });
  // the largest evidence price counts, from any lesson; one that is not evidence (a big receipt moved whole) does not
  const solo = (txnId, itemCents, over = {}) => lessonRec({ txnId, payee: 'Costco', item: 'CHICKEN STRP', filed: FUN, solo: true, amountCents: 2000, itemCents, ...over });
  assert.equal(learning.keywordCandidates([solo('t1', 699), solo('t2', 1200)])[0].maxItemCents, 2400);
  const big = solo('t3', 9999, { kind: 'receipt', solo: false, receiptItems: 20, amountCents: 90000 });
  assert.equal(learning.keywordCandidates([solo('t1', 699), solo('t2', 800), big])[0].maxItemCents, 1600);
});

test('the food court scenario: Coke and chicken strips learned there are not applied to a $50 grocery run', () => {
  const learnedKw = learning.keywordCandidates(foodCourt()).map((k) => ({ ...k, from: 'learned' }));
  const fits = (phrase, charge, itemPrice) => kw.keywordFits(learnedKw.find((k) => k.phrase === phrase), charge, itemPrice);
  assert.equal(fits('coke', 1378, 158), true);
  assert.equal(fits('chicken strp', 1378, 699), true);
  assert.equal(fits('coke', 2500, 1549), false, 'the item limit: a $15.49 case of coke, on a charge the charge limit allows');
  assert.equal(fits('chicken strp', 5000, 659), false, 'the charge limit: strips cheap enough, on a $50 run');
  assert.equal(fits('coke', 5000, 1549), false);
  // an unknown price fails a limit that is set, exactly like an unknown charge; yours and older learned keywords are not limited
  assert.equal(fits('coke', 1378, undefined), false);
  assert.equal(fits('coke', undefined, 158), false);
  assert.equal(kw.keywordFits({ ...learnedKw[0], from: 'cli' }, 5000, 99999), true);
  assert.equal(kw.keywordFits({ phrase: 'coke', from: 'learned', maxCents: 3000 }, 1378, undefined), true, 'no item limit stored');
  assert.equal(kw.keywordFits({ phrase: 'coke', from: 'learned', maxItemCents: 500 }, undefined, 158), true, 'no charge limit stored');
});

test('item prices travel: snapshot item -> lesson -> compact -> candidate -> syncLearned', async () => {
  const { args } = (() => {
    const receipt = { payee: 'Costco', store: 'COSTCO WHSE' };
    const allocation = [{ label: GRO, categoryId: 'c-gro', cents: 940, items: ['COKE'], refs: [{ description: 'COKE', amount: 1.58, category: GRO, confidence: 0.9 }] }, { label: SAM, categoryId: 'c-sam', cents: 438, items: ['CHICKEN BAKE'], refs: [{ description: 'CHICKEN BAKE', amount: 3.99, category: SAM, confidence: 0.9 }] }];
    return { args: { txn: { id: 't7', date: day(-1), amount: -1378 }, item: { basename: 'a.jpg' }, receipt, allocation, action: 'split', review: false } };
  })();
  const snap = learning.buildSnapshot(args);
  assert.deepEqual(snap.parts.map((p) => p.items[0].cents), [158, 399]);
  const f = { item: snap.parts[0].items[0], said: GRO, filed: FUN, kind: 'item', group: 0, solo: true };
  const lesson = learning.lessonOf(snap, f);
  assert.equal(lesson.itemCents, 158);
  assert.equal('itemCents' in learning.lessonOf(snap, { ...f, item: { d: 'COKE' } }), false, 'an item with no price (an old snapshot) has none');
  // merged by compact(): the largest evidence price is kept
  const many = Array.from({ length: 1003 }, (_, i) => lessonRec({ id: String(i).padStart(12, '0'), txnId: `t${i}`, payee: 'Costco', item: i < 3 ? 'COKE' : `ITEM ${i}`, filed: FUN, solo: true, amountCents: 1000, itemCents: 100 + i * 100, date: shiftDay('2026-01-01', i % 300) }));
  const merged = learning.compact(many).find((l) => l.item === 'COKE');
  assert.equal(merged.evidenceItemCents, 300);
  const cand = learning.keywordCandidates([merged]).find((k) => k.phrase === 'coke');
  assert.equal(cand.maxItemCents, 600);
  await kw.syncLearned([cand]);
  assert.equal((await kw.loadKeywords()).find((k) => k.phrase === 'coke').maxItemCents, 600);
  await kw.syncLearned([{ ...cand, maxItemCents: 900 }]);
  assert.equal((await kw.loadKeywords()).find((k) => k.phrase === 'coke').maxItemCents, 900);
  await kw.syncLearned([{ ...cand, maxItemCents: undefined }]);
  assert.equal('maxItemCents' in (await kw.loadKeywords()).find((k) => k.phrase === 'coke'), false);
});

// ---- replay and item-test must not see the future ----

test('storeHistory and itemHistory: `until` ends the window, and HISTORY_DAYS counts back from it, not from today', async () => {
  const old = (id, date, cat, notes) => split(id, [child(cat, 1000, notes)], 'my split', { date });
  const txns = [old('h1', day(-300), 'c-gro', 'oldest'), old('h2', day(-200), 'c-sam', 'before'), old('h3', day(-100), 'c-gro', 'same day'), old('h4', day(-50), 'c-fun', 'after')];
  fakeBudget(txns);
  const until = day(-101); // the day before h3
  assert.deepEqual((await actual.storeHistory('Target', 'none', id2label, until)).map((h) => h.parts[0].category), [SAM, GRO]);
  assert.deepEqual((await actual.itemHistory('none', id2label, until)).map((h) => h.items).sort(), ['before', 'oldest']);
  // no `until`: everything up to today within HISTORY_DAYS (365 here)
  assert.equal((await actual.storeHistory('Target', 'none', id2label)).length, 4);
  // the year is counted back from `until`: a txn 300 days before it is still inside, one 400 days before is not
  const early = [old('e1', day(-400), 'c-gro', 'inside'), old('e2', day(-500), 'c-gro', 'outside')];
  fakeBudget(early);
  assert.deepEqual((await actual.itemHistory('none', id2label, day(-100))).map((h) => h.items), ['inside']);
  assert.deepEqual(actual.historyWindow(day(10)), { start: shiftDay(today(), -config.history.days), end: today() }); // the future means today
  assert.deepEqual(actual.historyWindow(null).end, today());
});

test('item-test and replay: with memory, a lesson from after the purchase is not used for it', async () => {
  const { categorizeReceipt } = await import('./receipt.js');
  mock.method(console, 'log', () => {});
  const LABELS = new Map([[GRO, 'c-gro'], [SAM, 'c-sam'], [FUN, 'c-fun']]);
  await memory.updateLessons(() => ({ lessons: [lessonRec({ id: 'earlier00000', txnId: 'x1', date: '2026-10-01', item: 'GUMDROPS' }), lessonRec({ id: 'later0000000', txnId: 'x2', date: '2026-11-03', item: 'GUMDROPS' })], forgotten: [] }));
  fakeBudget([]);
  setRules([], { payees: [] });
  const seen = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    seen.push(JSON.parse(init.body).state);
    return new Response(JSON.stringify({ answers: { category: { choice: GRO, confidence: 0.9 } } }));
  });
  config.deciderUrl = 'http://decider.test:8080';
  const run = async (opts) => {
    seen.length = 0;
    const receipt = { merchant: 'Target', date: '2026-10-26', total: 2, items: [{ description: 'GUMDROPS', amount: 2 }] };
    await categorizeReceipt(receipt, { id: 't9', payeeName: 'Target', date: '2026-10-26', amount: -200 }, LABELS, id2label, null, [], opts);
    return (seen[0].household_corrected_the_pipeline ?? []).length;
  };
  config.occasions.enabled = false;
  assert.equal(await run({ replay: true, withMemory: true }), 1, 'only the lesson from before the receipt');
  assert.equal(await run({}), 2, 'the live worker uses everything it has learned');
});

// ---- the history cut, learned keywords as of a day, votes that survive compaction ----

test('lessonOf stores learnedAt (the sweep day) and lessonsUpTo cuts on it, falling back to the transaction date', async () => {
  const snap = snapshot();
  const f = { item: snap.parts[1].items[0], said: SAM, filed: FUN, kind: 'item', group: 1, solo: true };
  assert.equal(learning.lessonOf(snap, f, '2026-11-01').learnedAt, '2026-11-01');
  assert.equal('learnedAt' in learning.lessonOf(snap, f), false);
  // a purchase on 10-01 corrected on 10-02 but only seen by the sweep on 11-03: not known on 10-20
  const late = lessonRec({ date: '2026-10-01', learnedAt: '2026-11-03' });
  const early = lessonRec({ date: '2026-10-01', learnedAt: '2026-10-02' });
  const old = lessonRec({ date: '2026-10-01' });
  assert.deepEqual(learning.lessonsUpTo([late, early, old], '2026-10-20'), [early, old]);
  // and a sweep writes it
  fakeBudget([split('t1', [child('c-gro', 600, 'MILK'), child('c-fun', 400, 'GUMDROPS')])]);
  await memory.watch(snapshot());
  await runSweep(new Date('2026-11-05T10:00:00Z'));
  assert.equal((await memory.loadLessonFile()).lessons[0].learnedAt, '2026-11-05');
  // the next sweeps re-judge the still-watched charge: the lesson keeps the day it was first learned
  await runSweep(new Date('2026-11-20T10:00:00Z'));
  assert.equal((await memory.loadLessonFile()).lessons[0].learnedAt, '2026-11-05');
});

test('keywordsWithLearned: yours as they are, learned ones only from the given candidates, none you removed or already have', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({
    keywords: [{ phrase: 'milk', category: GRO, store: null, from: 'cli', added: '2026-01-01' }, { phrase: 'stored', category: FUN, store: 'Target', from: 'learned', added: '2026-01-01' }],
    removed: [{ phrase: 'banned', store: null }],
  }));
  const cand = (phrase) => ({ phrase, category: SAM, store: 'Target', strength: 'usually', fromTxn: 't1', maxItemCents: 500 });
  const got = await kw.keywordsWithLearned([cand('fresh'), cand('milk'), cand('banned')]);
  assert.deepEqual(got.map((k) => [k.phrase, k.from]), [['milk', 'cli'], ['fresh', 'learned']]);
  assert.equal(got[1].maxItemCents, 500);
  assert.equal(JSON.parse(fs.readFileSync(config.keywordsPath, 'utf8')).keywords.length, 2, 'nothing is written');
});

test('compact keeps every keyword a merged lesson went against, and keywordCandidates counts them all', () => {
  const mk = (txnId, kwName, over = {}) => lessonRec({ id: txnId.padEnd(12, '0'), txnId, payee: 'Costco', item: 'COKE ZERO', filed: GRO, said: FUN, kw: kwName, kwCat: FUN, solo: true, amountCents: 500, ...over });
  const lessons = [mk('t1', 'coke'), mk('t2', 'zero')];
  const filler = Array.from({ length: 1003 }, (_, i) => lessonRec({ id: `f${i}`.padEnd(12, '0'), txnId: `f${i}`, item: `ITEM ${i}`, date: shiftDay('2026-01-01', i % 300) }));
  const [m] = learning.compact([...lessons, ...filler]).filter((l) => l.item === 'COKE ZERO');
  assert.deepEqual(m.kwVotes.map((v) => v.kw).sort(), ['coke', 'zero']);
  // three fixes for "zero" -> Gifts and "coke" -> Gifts exist; the merged lesson still goes against both
  const base = [...taught(FUN, 'a1', 'a2', 'a3')].map((l) => ({ ...l, item: 'ZERO', payee: 'Costco' }));
  const cands = learning.keywordCandidates([...base, m]);
  assert.equal(cands.find((c) => c.phrase === 'zero').strength, 'usually', 'one against 3: not "always" any more');
});

test('"always" can return: more than three times as many fixes agree as disagree', () => {
  const agree = (n) => taught(FUN, ...Array.from({ length: n }, (_, i) => `a${i}`)).map((l) => ({ ...l, payee: 'Costco' }));
  const against1 = against(GRO, 'x1').map((l) => ({ ...l, payee: 'Costco' }));
  const strength = (n) => learning.keywordCandidates([...agree(n), ...against1]).find((c) => c.phrase === 'gumdrops')?.strength;
  assert.deepEqual([strength(3), strength(4)], ['usually', 'always']);
  assert.equal(learning.keywordCandidates(agree(3))[0].strength, 'always');
});
