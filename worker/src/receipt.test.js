// Per-receipt decisions from receipt.js. The Actual API and webdav are replaced by empty stand-ins (see test/support.js).
import '../test/support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { setRules } from './rules.js';

const { chooseAction, storeConsensus, categorizeReceipt } = await import('./receipt.js');

const DAY = 86400000;
const saved = JSON.parse(JSON.stringify({ splits: config.splits, match: config.match, ruleFallback: config.ruleFallback, applyThenReview: config.applyThenReview, categoryMinConfidence: config.categoryMinConfidence, moveMinConfidence: config.moveMinConfidence, keywordMode: config.keywordMode, occasions: config.occasions, excludeGroups: config.excludeGroups }));
afterEach(() => {
  mock.restoreAll();
  Object.assign(config, JSON.parse(JSON.stringify(saved)));
});

// ---- chooseAction ----
const part = (label, categoryId = label ? `id-${label}` : null) => ({ label, categoryId, cents: 100, items: [] });
const sure = (category, confidence = 0.9) => ({ category, confidence });
const receiptOf = (...items) => ({ items });

test('chooseAction: nothing placed gives no action and a problem', () => {
  const problems = [];
  assert.equal(chooseAction([part('Uncategorized', null)], receiptOf(), null, null, problems), null);
  assert.deepEqual(problems, ['no item could be categorized with enough confidence']);
});

test('chooseAction: several parts split, unless splits are off', () => {
  const two = [part('A'), part('B')];
  assert.equal(chooseAction(two, receiptOf(), 'id-A', 'A', []), 'split');
  assert.equal(chooseAction(two, receiptOf(), null, null, []), 'split');
  config.splits = false;
  assert.equal(chooseAction(two, receiptOf(), 'id-A', 'A', []), 'note'); // keep the category, note the breakdown
  assert.equal(chooseAction(two, receiptOf(), null, null, []), 'categorize'); // nothing to keep: largest category
});

test('chooseAction: a placed part plus an Uncategorized one still counts as a split', () => {
  assert.equal(chooseAction([part('A'), part('Uncategorized', null)], receiptOf(), null, null, []), 'split');
});

test('chooseAction: one part on an uncategorized charge categorizes it', () => {
  assert.equal(chooseAction([part('A')], receiptOf(), null, null, []), 'categorize');
});

test('chooseAction: one part equal to the current category confirms', () => {
  assert.equal(chooseAction([part('A')], receiptOf(), 'id-A', 'A', []), 'confirm');
});

test('chooseAction: moving a whole charge needs an item that is confident of the new category', () => {
  const problems = [];
  const unsure = receiptOf({ category: 'B', confidence: 0.3 });
  assert.equal(chooseAction([part('B')], unsure, 'id-A', 'A', problems), null);
  assert.deepEqual(problems, ['the receipt reads as "B", but no item is at least 50% sure of it, so the charge stays "A"']);
  assert.equal(chooseAction([part('B')], receiptOf(sure('B', 0.5)), 'id-A', 'A', []), 'categorize'); // at the bar counts
});

test('chooseAction: a fallback or confidence-less item is not a reason to move the charge', () => {
  assert.equal(chooseAction([part('B')], receiptOf({ ...sure('B'), fellBack: true }), 'id-A', 'A', []), null);
  assert.equal(chooseAction([part('B')], receiptOf({ category: 'B', confidence: null }), 'id-A', 'A', []), null);
});

test('chooseAction: MOVE_MIN_CONFIDENCE is the bar for moving', () => {
  config.moveMinConfidence = 0.8;
  assert.equal(chooseAction([part('B')], receiptOf(sure('B', 0.7)), 'id-A', 'A', []), null);
  assert.equal(chooseAction([part('B')], receiptOf(sure('B', 0.8)), 'id-A', 'A', []), 'categorize');
});

test('chooseAction: with OVERWRITE_CATEGORIZED off a confident move goes to review instead', () => {
  config.match.overwrite = false;
  const problems = [];
  assert.equal(chooseAction([part('B')], receiptOf(sure('B')), 'id-A', 'A', problems), null);
  assert.deepEqual(problems, ['your rules filed this under "A", but the receipt reads as "B"']);
});

// ---- storeConsensus ----
const purchase = (...categories) => ({ parts: categories.map((category) => ({ category, amount: '1.00' })) });

test('storeConsensus: three or more purchases that all went to one category', () => {
  assert.deepEqual(storeConsensus([purchase('A'), purchase('A'), purchase('A')]), { label: 'A', count: 3 });
  assert.deepEqual(storeConsensus([purchase('A', 'A'), purchase('A'), purchase('A'), purchase('A')]), { label: 'A', count: 4 });
});

test('storeConsensus: fewer than three purchases, or any other category, means no consensus', () => {
  assert.equal(storeConsensus([purchase('A'), purchase('A')]), null);
  assert.equal(storeConsensus([purchase('A'), purchase('A'), purchase('B')]), null);
  assert.equal(storeConsensus([]), null);
});

test('storeConsensus: Uncategorized parts say nothing about the store', () => {
  assert.deepEqual(storeConsensus([purchase('A', 'Uncategorized'), purchase('A'), purchase('A')]), { label: 'A', count: 3 });
  // a purchase made only of Uncategorized parts is not counted at all
  assert.equal(storeConsensus([purchase('A'), purchase('A'), purchase('Uncategorized')]), null);
});

// ---- categorizeReceipt: the fallback / unsure settling ----
const LABELS = new Map([['A / One', 'a'], ['B / Two', 'b'], ['C / Three', 'c']]);
const ID2LABEL = new Map([...LABELS].map(([label, id]) => [id, label]));
const TXN = { id: 't1', payeeName: 'Target', date: '2026-10-26', amount: -1000 };

/** The decider says what `answers` has for each item description: [category, confidence], or a raw reply. */
function mockDecider(answers) {
  mock.method(console, 'log', () => {});
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    const { state } = JSON.parse(init.body);
    const a = answers[state.item];
    const choice = a?.[0];
    return new Response(JSON.stringify({ answers: { category: { choice, confidence: a?.[1] } } }));
  });
}
async function settle(answers, { currentLabel = 'A / One', ruleCategory = null, items = Object.keys(answers) } = {}) {
  setRules(ruleCategory ? [{ id: 'r', stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p-target' }], actions: [{ op: 'set', field: 'category', value: ruleCategory }] }] : [], { payees: [{ id: 'p-target', name: 'Target' }] });
  mockDecider(answers);
  config.occasions.enabled = false;
  const receipt = { merchant: 'Target', date: '2026-10-26', total: 10, items: items.map((description) => ({ description, amount: 2 })) };
  const itemDoubts = [];
  const txn = ruleCategory ? { ...TXN, payee: 'p-target' } : TXN;
  const out = await categorizeReceipt(receipt, txn, LABELS, ID2LABEL, currentLabel, itemDoubts, {});
  return { receipt, itemDoubts, out };
}
const summarize = (receipt) => receipt.items.map((i) => [i.category, i.confidence, i.fellBack ?? false]);

test('settling: confident items keep their pick, in or out of the store category', async () => {
  const { receipt, itemDoubts, out } = await settle({ X: ['A / One', 0.9], Y: ['B / Two', 0.9] });
  assert.deepEqual(summarize(receipt), [['A / One', 0.9, false], ['B / Two', 0.9, false]]);
  assert.deepEqual(itemDoubts, []);
  assert.equal(out.fallback, 'A / One');
  assert.equal(receipt.store, 'Target');
});

test("settling: an unsure item falls back to the store's category and the doubt says what the model said", async () => {
  const { receipt, itemDoubts } = await settle({ X: ['B / Two', 0.3] });
  const [it] = receipt.items;
  assert.deepEqual([it.category, it.confidence, it.fellBack, it.fellBackFrom, it.originalConfidence], ['A / One', null, true, 'B / Two', 0.3]);
  assert.deepEqual(itemDoubts, ['the categorizer wasn\'t sure, so these went to the store\'s category "One": X (model said Two 30%)']);
});

test('settling: staying in the store category uses CATEGORY_MIN_CONFIDENCE, moving out uses MOVE_MIN_CONFIDENCE', async () => {
  config.categoryMinConfidence = 0.4;
  config.moveMinConfidence = 0.7;
  const { receipt } = await settle({ X: ['A / One', 0.45], Y: ['B / Two', 0.6], Z: ['B / Two', 0.7] });
  assert.deepEqual(receipt.items.map((i) => [i.category, i.fellBack ?? false]), [['A / One', false], ['A / One', true], ['B / Two', false]]);
});

test('settling: an invalid answer falls back too, and the doubt shows the bad answer', async () => {
  const { receipt, itemDoubts } = await settle({ X: ['Nope', 0.9] });
  assert.equal(receipt.items[0].category, 'A / One');
  assert.equal(receipt.items[0].fellBack, true);
  assert.equal(receipt.items[0].fellBackFrom, null);
  assert.ok(itemDoubts[0].includes('X (model said invalid answer "choice "Nope" is not one of the categori")'), itemDoubts[0]);
});

test('settling: the rule category is the fallback when the charge has no category', async () => {
  const { receipt, out } = await settle({ X: ['B / Two', 0.2] }, { currentLabel: null, ruleCategory: 'b' });
  assert.equal(out.ruleLabel, 'B / Two');
  assert.equal(out.fallback, 'B / Two');
  assert.deepEqual(summarize(receipt), [['B / Two', null, true]]);
});

test("settling: the charge's current category comes before the rule's", async () => {
  const { out } = await settle({ X: ['A / One', 0.9] }, { currentLabel: 'A / One', ruleCategory: 'b' });
  assert.equal(out.fallback, 'A / One');
});

test('settling: a current category receipts may not use is not a fallback', async () => {
  config.excludeGroups = ['A'];
  const { out, receipt } = await settle({ X: ['B / Two', 0.9] }, { currentLabel: 'A / One' });
  assert.equal(out.fallback, null);
  assert.equal(receipt.items[0].category, 'B / Two');
});

test('settling: with no store category, an unsure item becomes an Uncategorized part with its guess', async () => {
  const { receipt, itemDoubts } = await settle({ X: ['B / Two', 0.3], Y: ['A / One', 0.9] }, { currentLabel: null });
  assert.deepEqual(receipt.items.map((i) => [i.category, i.unsureGuess ?? null]), [['Uncategorized', 'Two 30%'], ['A / One', null]]);
  assert.deepEqual(itemDoubts, ['not sure about: X → Two 30%']);
});

test('settling: an invalid answer always becomes Uncategorized, even with APPLY_THEN_REVIEW off', async () => {
  config.applyThenReview = false;
  const { receipt } = await settle({ X: ['Nope', 0.9] }, { currentLabel: null });
  assert.equal(receipt.items[0].category, 'Uncategorized');
  assert.equal(receipt.items[0].unsureGuess, null);
});

test('settling: with APPLY_THEN_REVIEW off an unsure but categorized item keeps its pick (the receipt goes to review)', async () => {
  config.applyThenReview = false;
  const { receipt, itemDoubts } = await settle({ X: ['B / Two', 0.3] }, { currentLabel: null });
  assert.equal(receipt.items[0].category, 'B / Two');
  assert.equal(receipt.items[0].unsureGuess, undefined);
  assert.equal(itemDoubts.length, 1);
});

test('settling: UNSURE_ITEMS_USE_STORE_CATEGORY off treats unsure items like having no store category', async () => {
  config.ruleFallback = false;
  const { receipt } = await settle({ X: ['B / Two', 0.3] }, { currentLabel: 'A / One' });
  assert.deepEqual([receipt.items[0].category, receipt.items[0].unsureGuess, receipt.items[0].fellBack], ['Uncategorized', 'Two 30%', undefined]);
});

test('settling: the store name comes from the bank payee, then the imported payee, then the receipt', async () => {
  const { receipt } = await settle({ X: ['A / One', 0.9] });
  assert.equal(receipt.store, 'Target');
  mockDecider({ X: ['A / One', 0.9] });
  const r2 = { merchant: 'Receipt Name', date: '2026-10-26', total: 1, items: [{ description: 'X', amount: 1 }] };
  await categorizeReceipt(r2, { id: 't', imported_payee: 'BANK NAME 123', date: '2026-10-26', amount: -100 }, LABELS, ID2LABEL, null, [], {});
  assert.equal(r2.store, 'BANK NAME 123');
  mockDecider({ X: ['A / One', 0.9] });
  const r3 = { merchant: 'Receipt Name', date: '2026-10-26', total: 1, items: [{ description: 'X', amount: 1 }] };
  await categorizeReceipt(r3, { id: 't', date: '2026-10-26', amount: -100 }, LABELS, ID2LABEL, null, [], {});
  assert.equal(r3.store, 'Receipt Name');
});
