// Per-receipt decisions from receipt.js. The Actual API and webdav are replaced by empty stand-ins (see test/support.js).
import '../test/support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { setRules } from './rules.js';

const { chooseAction, storeConsensus, categorizeReceipt, handleReceipt } = await import('./receipt.js');

const saved = JSON.parse(JSON.stringify({ dryRun: config.dryRun, receiptCheck: config.receiptCheck, receiptCheckMinConfidence: config.receiptCheckMinConfidence, splits: config.splits, match: config.match, ruleFallback: config.ruleFallback, applyThenReview: config.applyThenReview, categoryMinConfidence: config.categoryMinConfidence, moveMinConfidence: config.moveMinConfidence, moveMinMargin: config.moveMinMargin, keywordMode: config.keywordMode, occasions: config.occasions, excludeGroups: config.excludeGroups }));
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
  assert.deepEqual(problems, ['the receipt reads as "B", but no item is at least 60% sure of it with a clear lead over the next category, so the charge stays "A"']);
  assert.equal(chooseAction([part('B')], receiptOf(sure('B', 0.6)), 'id-A', 'A', []), 'categorize'); // at the bar counts
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

test('chooseAction: a confident but near-tied item does not move the charge (MOVE_MIN_MARGIN)', () => {
  config.moveMinMargin = 0.2;
  const tied = { category: 'B', confidence: 0.65, margin: 0.1 };
  assert.equal(chooseAction([part('B')], receiptOf(tied), 'id-A', 'A', []), null);
  assert.equal(chooseAction([part('B')], receiptOf({ ...tied, margin: 0.2 }), 'id-A', 'A', []), 'categorize'); // at the bar counts
  assert.equal(chooseAction([part('B')], receiptOf(sure('B', 0.9)), 'id-A', 'A', []), 'categorize'); // unknown margin passes
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

/** The decider says what `answers` has for each item description: [category, confidence, probabilities?], or a raw reply. */
function mockDecider(answers) {
  mock.method(console, 'log', () => {});
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    const { state } = JSON.parse(init.body);
    const a = answers[state.item];
    const choice = a?.[0];
    return new Response(JSON.stringify({ answers: { category: { choice, confidence: a?.[1], ...(a?.[2] ? { probabilities: a[2] } : {}) } } }));
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

test('settling: moving out needs a clear lead (MOVE_MIN_MARGIN); staying does not; an unknown margin passes', async () => {
  config.categoryMinConfidence = 0.5;
  config.moveMinConfidence = 0.4;
  config.moveMinMargin = 0.2;
  const clear = { 'A / One': 0.1, 'B / Two': 0.7, 'C / Three': 0.2 };
  const close = { 'A / One': 0.2, 'B / Two': 0.45, 'C / Three': 0.35 }; // confident enough, but only 0.10 ahead
  const stay = { 'A / One': 0.52, 'B / Two': 0.48 };
  const { receipt } = await settle({ X: ['B / Two', 0.9, clear], Y: ['B / Two', 0.9, close], Z: ['A / One', 0.9, stay], W: ['B / Two', 0.9] });
  assert.deepEqual(receipt.items.map((i) => [i.category, i.fellBack ?? false]), [['B / Two', false], ['A / One', true], ['A / One', false], ['B / Two', false]]);
});

test('settling: the decider\'s own numbers stay on item.decided after the item fell back', async () => {
  const { receipt } = await settle({ X: ['B / Two', 0.9, { 'B / Two': 0.45, 'C / Three': 0.4, 'A / One': 0.15 }] });
  const [it] = receipt.items;
  assert.equal(it.fellBack, true);
  assert.deepEqual([it.decided.category, it.decided.confidence], ['B / Two', 0.45]);
  assert.ok(Math.abs(it.decided.margin - 0.05) < 1e-12);
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

// ---- categorizeReceipt with the remote decider ----
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { default: actualApi } = await import('@actual-app/api');

async function remoteWorld({ names = [], seedWords = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-remote-test-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const before = { decider: { ...config.decider }, privacy: { ...config.privacy }, deciderUrl: config.deciderUrl, llmUrl: config.llmUrl, categoryNotesPath: config.categoryNotesPath };
  Object.assign(config, { deciderUrl: 'https://api.typesafe.test', llmUrl: 'http://reader.test', categoryNotesPath: path.join(dir, 'notes.json') });
  Object.assign(config.decider, { provider: 'remote', apiKey: 'k', remoteModel: 'jev-latest', preview: null });
  Object.assign(config.privacy, { wordsPath: path.join(dir, 'pw.json'), scanCachePath: path.join(dir, 'sc.json'), seedWords });
  config.occasions.enabled = false;
  mock.method(console, 'log', () => {});
  mock.method(actualApi, 'getPayees', async () => [{ id: 'p1', name: 'Target' }, { id: 'p2', name: "Alex's Checking", transfer_acct: 'acct-1' }]);
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('reader.test')) {
      const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
      const results = list.map((e) => ({ id: e.id, names: names.filter((n) => e.text.toLowerCase().includes(n.toLowerCase())) }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
    }
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ answers: { category: { choice: 'C01', confidence: 0.9 } } }));
  });
  return { sent, restore: () => { Object.assign(config.decider, before.decider); Object.assign(config.privacy, before.privacy); Object.assign(config, { deciderUrl: before.deciderUrl, llmUrl: before.llmUrl, categoryNotesPath: before.categoryNotesPath }); } };
}

test('remote: the store sent is the Actual payee, never the bank text; a transfer payee is no business, so its first name is still hidden', async () => {
  const world = await remoteWorld({ names: ['Alex'] });
  try {
    const receipt = { merchant: 'Target', date: '2026-10-26', total: 10, items: [{ description: 'GIFT CARD FOR ALEX', amount: 2 }] };
    const txn = { ...TXN, imported_payee: 'POS 4242 TARGET 1234 SPRINGFIELD IL' };
    await categorizeReceipt(receipt, txn, LABELS, ID2LABEL, 'A / One', [], {});
    assert.equal(receipt.payee, 'Target');
    assert.equal(world.sent[0].state.store, 'Target');
    assert.equal(world.sent[0].state.item, 'GIFT CARD FOR Person A');
    assert.ok(!JSON.stringify(world.sent).includes('4242'));
    // a charge whose payee is a transfer account gets no store at all
    world.sent.length = 0;
    const r2 = { merchant: 'Target', date: '2026-10-26', total: 10, items: [{ description: 'TOWELS', amount: 2 }] };
    await categorizeReceipt(r2, { ...TXN, payeeName: "Alex's Checking", payeeIsTransfer: true }, LABELS, ID2LABEL, 'A / One', [], {});
    assert.equal(r2.payee, null);
    assert.equal(world.sent[0].state.store, null);
  } finally {
    world.restore();
  }
});

test('remote: an item the privacy check holds back is reported as such in the review reasons, not as an invalid answer', async () => {
  const world = await remoteWorld({ seedWords: ['budget'] }); // "budget" is in the fixed question text: everything is held back
  try {
    const receipt = { merchant: 'Target', date: '2026-10-26', total: 10, items: [{ description: 'TOWELS', amount: 2 }] };
    const doubts = [];
    await categorizeReceipt(receipt, TXN, LABELS, ID2LABEL, 'A / One', doubts, {});
    assert.equal(world.sent.length, 0);
    const text = doubts.join('\n');
    assert.match(text, /held back from the hosted decider \(privacy check\)/);
    assert.ok(!/invalid answer/.test(text), text);
  } finally {
    world.restore();
  }
});

test('handleReceipt: discount lines are folded into their items before anything else, live and in replay alike', async () => {
  mock.method(console, 'log', () => {});
  const read = () => ({ merchant: 'Target', date: '2026-10-26', total: 9, subtotal: 9, payment_method: 'cash', items: [{ description: 'MILK', amount: 5 }, { description: 'GUM', amount: 5 }, { description: 'INSTANT SAVINGS', amount: -1 }] });
  for (const opts of [{}, { replay: true }]) {
    const { summary } = await handleReceipt({ basename: 'a.jpg' }, read(), 'test', LABELS, opts);
    assert.deepEqual(summary.receipt.items.map((i) => [i.description, i.amount]), [['MILK', 5], ['GUM', 4]]);
    assert.equal(summary.receipt.total, 9); // the receipt's own totals are untouched
  }
});

// ---- the per-receipt check (RECEIPT_CHECK): "is this all one kind of purchase?" ----

/** The decider answers each item from `items` ([choice, probabilities]) and the whole-purchase question from `whole`. Returns the requests seen. */
function mockWholeDecider({ items, whole }) {
  const requests = [];
  mock.method(console, 'log', () => {});
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    const { state } = JSON.parse(init.body);
    requests.push(state);
    const [choice, probabilities] = state.items_on_receipt ? whole : items[state.item];
    return new Response(JSON.stringify({ answers: { category: { choice, confidence: 0.5, probabilities } } }));
  });
  return requests;
}
const FOOD = 'A / One';
const REST = 'B / Two';
const costco = (...rows) => ({ merchant: 'Costco', date: '2026-10-26', total: 13.78, items: rows.map(([description, amount]) => ({ description, amount })) });

test('receipt check: a food-court visit that the items split two ways ends up whole in Restaurants', async () => {
  config.receiptCheck = true;
  setRules([{ id: 'r', stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: 'p-costco' }], actions: [{ op: 'set', field: 'category', value: 'a' }] }], { payees: [{ id: 'p-costco', name: 'Costco' }] });
  const requests = mockWholeDecider({
    // the coke reads as a grocery by itself (not clearly), the chicken as a restaurant meal
    items: { '20 OZ COKE': [FOOD, { [FOOD]: 0.5, [REST]: 0.4, 'C / Three': 0.1 }], 'CHICKEN BAKE': [REST, { [REST]: 0.6, [FOOD]: 0.3, 'C / Three': 0.1 }], 'CHICKEN STRP': [FOOD, { [FOOD]: 0.45, [REST]: 0.4, 'C / Three': 0.15 }] },
    whole: [REST, { [REST]: 0.75, [FOOD]: 0.2, 'C / Three': 0.05 }],
  });
  const receipt = costco(['20 OZ COKE', 1.58], ['CHICKEN BAKE', 3.99], ['CHICKEN STRP', 6.99]);
  const doubts = [];
  await categorizeReceipt(receipt, { ...TXN, payeeName: 'Costco', payee: 'p-costco', amount: -1378 }, LABELS, ID2LABEL, FOOD, doubts, {});
  assert.equal(requests.length, 4, 'one question per item and one for the whole purchase');
  assert.deepEqual(receipt.items.map((i) => [i.category, i.fellBack ?? false]), [[REST, false], [REST, false], [REST, false]]);
  assert.deepEqual(receipt.items.map((i) => Boolean(i.receiptSaid)), [true, false, true]);
  assert.equal(receipt.receiptCheck.category, REST);
  assert.deepEqual(receipt.receiptCheck.moved, ['20 OZ COKE', 'CHICKEN STRP']);
  assert.deepEqual(doubts, []);
  // the whole charge is one category: the transaction (filed under Groceries by the rule) moves, since an item is confident of Restaurants
  const { allocate } = await import('./reconcile.js');
  const { allocation } = allocate(receipt, LABELS, 1378);
  assert.deepEqual(allocation.map((a) => [a.label, a.cents]), [[REST, 1378]]);
  assert.equal(chooseAction(allocation, receipt, 'a', FOOD, []), 'categorize');
});

test('receipt check: a real mixed run still splits, because the clear items beat the whole-purchase answer', async () => {
  config.receiptCheck = true;
  mockWholeDecider({
    items: { MILK: [FOOD, { [FOOD]: 0.85, [REST]: 0.05, 'C / Three': 0.1 }], SPONGES: ['C / Three', { 'C / Three': 0.8, [FOOD]: 0.15, [REST]: 0.05 }], EGGS: [FOOD, { [FOOD]: 0.9, 'C / Three': 0.1 }] },
    whole: [FOOD, { [FOOD]: 0.6, 'C / Three': 0.35, [REST]: 0.05 }],
  });
  const receipt = costco(['MILK', 4], ['SPONGES', 5], ['EGGS', 4]);
  await categorizeReceipt(receipt, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.deepEqual(receipt.items.map((i) => i.category), [FOOD, 'C / Three', FOOD]);
  assert.deepEqual(receipt.items.map((i) => Boolean(i.receiptSaid)), [false, false, false]);
  assert.deepEqual(receipt.receiptCheck.moved, []);
});

test('receipt check: an unclear whole-purchase answer changes nothing, and an unclear one against the store category leaves items there', async () => {
  config.receiptCheck = true;
  // Restaurants wins the whole purchase with 0.45: under the bar, so the items stand (and the unsure one falls back as before)
  mockWholeDecider({
    items: { X: [FOOD, { [FOOD]: 0.52, [REST]: 0.48 }], Y: [REST, { [REST]: 0.5, [FOOD]: 0.45, 'C / Three': 0.05 }] },
    whole: [REST, { [REST]: 0.45, [FOOD]: 0.4, 'C / Three': 0.15 }],
  });
  const a = costco(['X', 2], ['Y', 2]);
  await categorizeReceipt(a, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.deepEqual(a.items.map((i) => [i.category, Boolean(i.receiptSaid), i.fellBack ?? false]), [[FOOD, false, false], [FOOD, false, true]]);
  // Restaurants wins the whole purchase with 0.55, only 0.1 ahead of Groceries: confident enough to pull the unclear items in,
  // but not clear enough to move them out of the store's Groceries, so they end up there (as unsure items always did)
  mockWholeDecider({
    items: { X: [FOOD, { [FOOD]: 0.5, [REST]: 0.4, 'C / Three': 0.1 }], Y: ['C / Three', { 'C / Three': 0.4, [REST]: 0.35, [FOOD]: 0.25 }] },
    whole: [REST, { [REST]: 0.55, [FOOD]: 0.45 }],
  });
  const b = costco(['X', 2], ['Y', 2]);
  await categorizeReceipt(b, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.deepEqual(b.items.map((i) => [i.category, Boolean(i.receiptSaid), i.fellBack ?? false]), [[FOOD, true, true], [FOOD, true, true]]);
});

test('receipt check: off, a one-item receipt, and a receipt the keywords filed completely ask no whole-purchase question', async () => {
  config.receiptCheck = false;
  let requests = mockWholeDecider({ items: { X: [FOOD, { [FOOD]: 0.9 }], Y: [REST, { [REST]: 0.9 }] }, whole: [REST, { [REST]: 0.9 }] });
  const off = costco(['X', 2], ['Y', 2]);
  await categorizeReceipt(off, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.equal(requests.length, 2);
  assert.equal(off.receiptCheck, undefined);
  config.receiptCheck = true;
  requests = mockWholeDecider({ items: { X: [FOOD, { [FOOD]: 0.9 }] }, whole: [REST, { [REST]: 0.9 }] });
  const one = costco(['X', 2]);
  await categorizeReceipt(one, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.equal(requests.length, 1);
  assert.equal(one.receiptCheck, undefined);
});

test('receipt check: the whole-purchase request holds every item with its price and no single item; a settled receipt logs the answer', async () => {
  config.receiptCheck = true;
  const requests = mockWholeDecider({ items: { X: [FOOD, { [FOOD]: 0.9 }], Y: [FOOD, { [FOOD]: 0.9 }] }, whole: [FOOD, { [FOOD]: 0.9 }] });
  const receipt = costco(['X', 2], ['Y', 3.5]);
  await categorizeReceipt(receipt, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  const whole = requests.at(-1);
  assert.deepEqual(whole.items_on_receipt, [{ item: 'X', price: 2 }, { item: 'Y', price: 3.5 }]);
  for (const k of ['item', 'item_price', 'other_items_on_receipt']) assert.equal(k in whole, false, k);
  const { receiptCheckLine } = await import('./receipt.js');
  assert.match(receiptCheckLine({ category: REST, confidence: 0.75, margin: 0.55, moved: ['COKE'] }), /^whole purchase: Two 75%, 55% ahead of the next; pulled into it: COKE$/);
  assert.match(receiptCheckLine({ category: REST, confidence: 0.4, margin: null, moved: [] }), /under 50%; items unchanged/);
  assert.match(receiptCheckLine({ category: null, invalid: 'reply is not JSON', moved: [] }), /no usable answer/);
});

test('history: it ends the day before the purchase date, live, replay and item-test alike; undated means today', async () => {
  const { historyEnd } = await import('./receipt.js');
  assert.equal(historyEnd('2026-10-26'), '2026-10-25');
  assert.equal(historyEnd(null), null);
  assert.equal(historyEnd('2026-03-01'), '2026-02-28');
});

test('receipt check: an item that settling would keep where it is is not pulled (the gate it will face, not always the move gate)', async () => {
  config.receiptCheck = true;
  config.moveMinConfidence = 0.6; // as in .env.example: moving out of the store's category is harder than staying
  // Groceries is the store's category. SNACKS stays there at 58% (30 ahead of Home), the TV is clearly Home; the receipt answer says Home 62%
  mockWholeDecider({
    items: { SNACKS: [FOOD, { [FOOD]: 0.58, 'C / Three': 0.28, [REST]: 0.14 }], TV: ['C / Three', { 'C / Three': 0.9, [FOOD]: 0.06, [REST]: 0.04 }] },
    whole: ['C / Three', { 'C / Three': 0.62, [FOOD]: 0.37, [REST]: 0.01 }],
  });
  const receipt = costco(['SNACKS', 5], ['TV', 300]);
  await categorizeReceipt(receipt, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.deepEqual(receipt.items.map((i) => [i.category, Boolean(i.receiptSaid)]), [[FOOD, false], ['C / Three', false]]);
  // the food-court case still pulls: COKE is only 15 ahead of Restaurants
  mockWholeDecider({
    items: { COKE: [FOOD, { [FOOD]: 0.55, [REST]: 0.4, 'C / Three': 0.05 }], BAKE: [REST, { [REST]: 0.7, [FOOD]: 0.2, 'C / Three': 0.1 }] },
    whole: [REST, { [REST]: 0.75, [FOOD]: 0.2, 'C / Three': 0.05 }],
  });
  const court = costco(['COKE', 1.58], ['BAKE', 3.99]);
  await categorizeReceipt(court, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, FOOD, [], {});
  assert.deepEqual(court.items.map((i) => [i.category, Boolean(i.receiptSaid)]), [[REST, true], [REST, false]]);
});

test('receipt check: items pulled into the store\'s own category are store defaults (fellBack, noted as such), not picks', async () => {
  config.receiptCheck = true;
  const { allocate, partNote } = await import('./reconcile.js');
  mockWholeDecider({
    items: { COKE: [FOOD, { [FOOD]: 0.5, [REST]: 0.4, 'C / Three': 0.1 }], STRP: ['C / Three', { 'C / Three': 0.45, [REST]: 0.4, [FOOD]: 0.15 }] },
    whole: [REST, { [REST]: 0.8, [FOOD]: 0.15, 'C / Three': 0.05 }],
  });
  const receipt = costco(['COKE', 2], ['STRP', 3]);
  const doubts = [];
  // Restaurants is the store's category here
  await categorizeReceipt(receipt, { ...TXN, payeeName: 'Costco' }, LABELS, ID2LABEL, REST, doubts, {});
  assert.deepEqual(receipt.items.map((i) => [i.category, i.fellBack, i.fellBackFrom, i.originalConfidence]), [[REST, true, FOOD, 0.5], [REST, true, 'C / Three', 0.45]]);
  assert.match(doubts.join('\n'), /wasn't sure, so these went to the store's category "Two": COKE \(model said One 50%\), STRP/);
  const { allocation } = allocate({ ...receipt, subtotal: 5 }, LABELS, 500);
  assert.match(partNote(allocation[0], ', ', 200), /\(store default\)$/);
});

test('receipt check: moving a whole charge on the receipt answer alone raises a doubt; one item\'s own pick stops it', async () => {
  const { receiptAnswerDoubt } = await import('./receipt.js');
  const a = [{ label: REST, categoryId: 'b' }];
  const pulled = (over = {}) => ({ category: REST, receiptSaid: { category: FOOD }, ...over });
  assert.match(receiptAnswerDoubt('categorize', a, { items: [pulled(), pulled()] }, 'a', FOOD), /moved from "A \/ One" to "B \/ Two" on the whole-purchase answer alone/);
  assert.equal(receiptAnswerDoubt('categorize', a, { items: [pulled(), pulled({ receiptSaid: undefined })] }, 'a', FOOD), null);
  assert.equal(receiptAnswerDoubt('categorize', a, { items: [pulled()] }, null, null), null, 'an uncategorized charge is filled, not moved');
  assert.equal(receiptAnswerDoubt('confirm', a, { items: [pulled()] }, 'b', REST), null);
});

// ---- an undated receipt matched to an older charge ----
test('handleReceipt: an undated receipt waits for the real charge, then the lone older match is applied and flagged #review even when it only confirms', async () => {
  mockDecider({ MILK: ['A / One', 0.95] });
  config.occasions.enabled = false;
  config.dryRun = true;
  config.applyThenReview = true;
  config.match.noDateExtendedDays = 120;
  mock.method(actualApi, 'getAccounts', async () => [{ id: 'a1', name: 'Checking' }]);
  mock.method(actualApi, 'getPayees', async () => [{ id: 'p1', name: 'Target' }]);
  const txns = [{ id: 'old1', date: '2026-10-01', amount: -1000, payee: 'p1', category: 'a' }];
  mock.method(actualApi, 'getTransactions', async (id, start, end) => txns.filter((t) => t.date >= start && t.date <= end));
  const read = () => ({ merchant: 'Target', total: 10, subtotal: 10, payment_method: 'visa', items: [{ description: 'MILK', amount: 10 }] });
  const lastmod = new Date('2026-11-07T10:00:00Z');
  const item = { basename: 'receipt.jpg', lastmod };
  const early = await handleReceipt(item, read(), 'test', LABELS, { now: new Date('2026-11-08T00:00:00Z') });
  assert.equal(early.result, 'waiting');
  const late = await handleReceipt(item, read(), 'test', LABELS, { now: new Date('2026-11-13T00:00:00Z') });
  assert.equal(late.result, 'dry-run:confirm+review');
  assert.equal(late.summary.plan.gapLabel, 'A / One'); // the store's category (cat.fallback): where unread money goes; it is unread money goes to is saved with the plan (the receipt page divides the charge again with it)
  assert.match(late.summary.problems.join(), /using the only exact-amount charge at this store/);
  // a charge near the photo date appearing blocks it
  txns.push({ id: 'new1', date: '2026-11-08', amount: -1000, payee: 'p1', category: 'a' });
  const near = await handleReceipt(item, read(), 'test', LABELS, { now: new Date('2026-11-13T00:00:00Z') });
  assert.equal(near.summary.transaction.id, 'new1');
});
