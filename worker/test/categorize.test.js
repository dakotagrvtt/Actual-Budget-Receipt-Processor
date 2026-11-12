// categorize.js: decider answer checks, keyword hints and filing, settling gates, the per-receipt check and the request state.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { applyReceiptCheck, categorizeItems, checkAnswer, householdExamples, receiptLabels, reweigh, stripDepartment } from '../src/categorize.js';

const LABELS = ['A / One', 'B / Two', 'C / Three'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'categorize-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// This file's own keywords file, so it can't collide with other test files running in parallel.
config.keywordsPath = path.join(tmp, 'keywords.json');
config.categoryNotesPath = path.join(tmp, 'category-notes.json');
const writeKeywords = (keywords) => fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords }));

const saved = { receiptCheck: config.receiptCheck, receiptCheckMinConfidence: config.receiptCheckMinConfidence, keywordMode: config.keywordMode, keywordHintWeight: config.keywordHintWeight, similarItems: config.similarItems, excludeGroups: config.excludeGroups, excludeCategories: config.excludeCategories, stripDepartmentPrefixes: config.stripDepartmentPrefixes };
afterEach(() => {
  mock.restoreAll();
  Object.assign(config, saved);
  fs.rmSync(config.keywordsPath, { force: true });
});

/** Replace fetch: /health is up; /v1/systemone answers come from `answer(state)`. Records the systemone request bodies. */
function mockDecider(answer) {
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    assert.ok(String(url).endsWith('/v1/systemone'), `unexpected request to ${url}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    const out = answer(body.state, requests.length - 1);
    return typeof out === 'string' ? new Response(out) : new Response(JSON.stringify(out));
  });
  return requests;
}
const reply = (choice, confidence, probabilities) => ({ answers: { category: { choice, confidence, ...(probabilities ? { probabilities } : {}) } } });
const newReceipt = (...descriptions) => ({ store: 'Target', merchant: 'Target', date: '2026-10-26', total: 10, items: descriptions.map((description) => ({ description, amount: 2 })) });
const run = (receipt) => categorizeItems(receipt, LABELS, [], [], {});

test('receiptLabels: removes excluded groups and categories', () => {
  config.excludeGroups = ['B'];
  config.excludeCategories = ['C / Three'];
  assert.deepEqual(receiptLabels(LABELS), ['A / One']);
});

test('stripDepartment: drops a short all-caps department prefix only', () => {
  assert.equal(stripDepartment('MED-DVD'), 'DVD');
  assert.equal(stripDepartment('BED-SHEETS'), 'SHEETS');
  assert.equal(stripDepartment('Med-DVD'), 'Med-DVD');
  assert.equal(stripDepartment('ABCDE-X'), 'ABCDE-X');
  assert.equal(stripDepartment('A-B'), 'A-B');
  config.stripDepartmentPrefixes = false;
  assert.equal(stripDepartment('MED-DVD'), 'MED-DVD');
});

test('checkAnswer: a valid answer, with and without probabilities', () => {
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0.9 }, LABELS), { category: 'A / One', confidence: 0.9 });
  const p = { 'A / One': 0.9, 'B / Two': 0.1 };
  // with probabilities, confidence is the top probability (not the reported number) and the margin is the lead over the runner-up
  const got = checkAnswer({ choice: 'A / One', confidence: 0.3, probabilities: p }, LABELS);
  assert.deepEqual([got.category, got.confidence, got.probabilities], ['A / One', 0.9, p]);
  assert.ok(Math.abs(got.margin - 0.8) < 1e-12);
  // probabilities that are not all numbers are dropped, the answer stays valid
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: { a: 'x' } }, LABELS), { category: 'A / One', confidence: 0.9 });
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0, probabilities: 'x' }, LABELS), { category: 'A / One', confidence: 0 });
});

test('checkAnswer: a 50/50 tie has a high reported confidence but a zero margin; a clear 70% pick with a long tail is confident', () => {
  const tie = checkAnswer({ choice: 'A / One', confidence: 0.8, probabilities: { 'A / One': 0.5, 'B / Two': 0.5 } }, LABELS);
  assert.deepEqual([tie.confidence, tie.margin], [0.5, 0]);
  const tail = { 'A / One': 0.7, 'B / Two': 0.1, 'C / Three': 0.1, x: 0.05, y: 0.05 };
  const clear = checkAnswer({ choice: 'A / One', confidence: 0.52, probabilities: tail }, LABELS);
  assert.equal(clear.confidence, 0.7);
  assert.ok(Math.abs(clear.margin - 0.6) < 1e-12);
});

test('checkAnswer: without probabilities the reported confidence stands and there is no margin', () => {
  const r = checkAnswer({ choice: 'A / One', confidence: 0.77 }, LABELS);
  assert.equal(r.confidence, 0.77);
  assert.equal('margin' in r, false);
  assert.equal('margin' in checkAnswer({ choice: 'A / One', confidence: 0.77, probabilities: {} }, LABELS), false);
});

test('checkAnswer: confidence and margin are about the chosen label, not the top one', () => {
  const behind = checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: { 'A / One': 0.3, 'B / Two': 0.6 } }, LABELS);
  assert.equal(behind.confidence, 0.3);
  assert.ok(Math.abs(behind.margin - -0.3) < 1e-12); // negative: another category is ahead, so it fails any margin gate
  // only real labels count; one out of [0, 1] throws the probabilities away; none for the chosen label means none at all
  const extra = checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: { 'A / One': 0.5, 'B / Two': 0.2, 'Not a label': 0.9 } }, LABELS);
  assert.deepEqual([extra.confidence, Object.keys(extra.probabilities)], [0.5, ['A / One', 'B / Two']]);
  assert.equal('probabilities' in checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: { 'A / One': 1.2 } }, LABELS), false);
  const missing = checkAnswer({ choice: 'A / One', confidence: 0.77, probabilities: { 'B / Two': 0.9 } }, LABELS);
  assert.deepEqual([missing.confidence, 'margin' in missing, 'probabilities' in missing], [0.77, false, false]);
});

test('checkAnswer: an unknown choice or a bad confidence becomes an invalid, unsure answer', () => {
  const bad = (a, re) => {
    const r = checkAnswer(a, LABELS);
    assert.equal(r.category, null);
    assert.equal(r.confidence, 0);
    assert.match(r.invalid, re);
  };
  bad({ choice: 'a / one', confidence: 0.9 }, /choice "a \/ one" is not one of the categories/);
  bad({ confidence: 0.9 }, /choice nothing is not one of the categories/);
  bad(undefined, /choice nothing/);
  bad({ choice: 'A / One', confidence: 1.5 }, /confidence 1\.5 is not a number from 0 to 1/);
  bad({ choice: 'A / One', confidence: -0.1 }, /confidence -0\.1/);
  bad({ choice: 'A / One', confidence: '0.9' }, /confidence "0\.9"/);
  bad({ choice: 'A / One', confidence: NaN }, /confidence null/);
  bad({ choice: 'A / One' }, /confidence nothing/);
});

test('reweigh: the keyword category is multiplied, then everything renormalized', () => {
  const r = reweigh({ 'A / One': 0.6, 'B / Two': 0.4 }, 'B / Two', 4);
  assert.equal(r.choice, 'B / Two');
  assert.ok(Math.abs(r.confidence - 1.6 / 2.2) < 1e-12); // the top probability after renormalizing
  assert.ok(Math.abs(r.margin - (1.6 - 0.6) / 2.2) < 1e-12);
});

test('reweigh: a weight too small to flip the pick keeps the model choice', () => {
  const r = reweigh({ 'A / One': 0.8, 'B / Two': 0.2 }, 'B / Two', 2);
  assert.equal(r.choice, 'A / One');
  assert.ok(Math.abs(r.confidence - 0.8 / 1.2) < 1e-12);
});

test('reweigh: unknown category or an all-zero sum gives null', () => {
  assert.equal(reweigh({ 'A / One': 1 }, 'B / Two', 4), null);
  assert.equal(reweigh({ 'A / One': 0 }, 'A / One', 4), null);
});

test('categorizeItems (decider): sets category and confidence per item and describes the method', async () => {
  const requests = mockDecider((state) => (state.item === 'MILK' ? reply('A / One', 0.9) : reply('B / Two', 0.4, { 'A / One': 0.3, 'B / Two': 0.6, 'C / Three': 0.1 })));
  const receipt = newReceipt('MILK', 'GUM');
  const how = await run(receipt);
  assert.equal(how, 'd1-2B (GGUF), 3 categories');
  assert.deepEqual(receipt.items.map((i) => [i.category, i.confidence]), [['A / One', 0.9], ['B / Two', 0.6]]); // the second has probabilities: its confidence is the top one, not the reported 0.4
  assert.ok(Math.abs(receipt.items[1].margin - 0.3) < 1e-12);
  assert.equal(receipt.items[0].margin, undefined);
  assert.deepEqual(receipt.items[1].probabilities, { 'A / One': 0.3, 'B / Two': 0.6, 'C / Three': 0.1 });
  assert.equal(requests.length, 2);
  // each request carries the item, its price and the other items
  assert.equal(requests[0].state.item, 'MILK');
  assert.equal(requests[0].state.item_price, 2);
  assert.deepEqual(requests[0].state.other_items_on_receipt, ['GUM']);
  assert.deepEqual(Object.keys(requests[0].questions.category.criteria), LABELS);
});

test('categorizeItems (decider): the department prefix is hidden from the model but the receipt keeps it', async () => {
  const requests = mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('MED-DVD');
  await run(receipt);
  assert.equal(requests[0].state.item, 'DVD');
  assert.equal(receipt.items[0].description, 'MED-DVD');
});

test('categorizeItems (decider): excluded categories are not offered', async () => {
  config.excludeGroups = ['C'];
  const requests = mockDecider(() => reply('A / One', 0.9));
  const how = await run(newReceipt('X'));
  assert.deepEqual(Object.keys(requests[0].questions.category.criteria), ['A / One', 'B / Two']);
  assert.match(how, /2 categories$/);
});

test('categorizeItems (decider): an answer outside the categories is invalid: category null, confidence 0', async () => {
  mockDecider((state) => (state.item === 'X' ? reply('Nope / Nope', 0.9) : reply('A / One', 2)));
  const receipt = newReceipt('X', 'Y');
  await run(receipt);
  assert.equal(receipt.items[0].category, null);
  assert.equal(receipt.items[0].confidence, 0);
  assert.match(receipt.items[0].invalidAnswer, /not one of the categories/);
  assert.match(receipt.items[1].invalidAnswer, /not a number from 0 to 1/);
});

test('categorizeItems (decider): a reply that is not JSON is an invalid answer, and a later valid one clears it', async () => {
  mockDecider(() => 'not json at all');
  const receipt = newReceipt('X');
  await run(receipt);
  assert.match(receipt.items[0].invalidAnswer, /reply is not JSON: "not json at all"/);
  mockDecider(() => reply('A / One', 0.8));
  await run(receipt);
  assert.equal('invalidAnswer' in receipt.items[0], false);
  assert.equal(receipt.items[0].category, 'A / One');
});

test('categorizeItems (decider): a 5xx from the decider is a TransientError, a 4xx a plain error', async () => {
  mock.method(globalThis, 'fetch', async (url) => (String(url).endsWith('/health') ? new Response('ok') : new Response('busy', { status: 503 })));
  await assert.rejects(run(newReceipt('X')), (err) => err.name === 'TransientError' && /HTTP 503/.test(err.message));
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (url) => (String(url).endsWith('/health') ? new Response('ok') : new Response('bad request', { status: 400 })));
  await assert.rejects(run(newReceipt('X')), (err) => err.name === 'Error' && /HTTP 400/.test(err.message));
});

test('categorizeItems (decider): an unreachable server is a TransientError', async () => {
  mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    throw new TypeError('fetch failed');
  });
  await assert.rejects(run(newReceipt('X')), (err) => err.name === 'TransientError');
});

test('categorizeItems: keyword mode final files a matched item without asking the model', async () => {
  writeKeywords([{ phrase: 'Gold Bond', category: 'C / Three' }]);
  config.keywordMode = 'final';
  const requests = mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('GOLD BOND HEALING', 'MILK');
  await run(receipt);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.item, 'MILK');
  assert.deepEqual(
    { category: receipt.items[0].category, confidence: receipt.items[0].confidence, source: receipt.items[0].source, keyword: receipt.items[0].keyword },
    { category: 'C / Three', confidence: 1, source: 'keyword', keyword: 'Gold Bond' },
  );
  assert.equal(receipt.items[1].source, undefined);
});

test('categorizeItems: no call to the model at all when every item is filed by keyword', async () => {
  writeKeywords([{ phrase: 'milk', category: 'A / One' }]);
  config.keywordMode = 'final';
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  const receipt = newReceipt('MILK');
  await run(receipt);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(receipt.items[0].category, 'A / One');
});

test('categorizeItems: mixed mode files "always" keywords and hints "usually" ones', async () => {
  writeKeywords([{ phrase: 'tide', category: 'B / Two', strength: 'always' }, { phrase: 'gum', category: 'C / Three', strength: 'usually' }]);
  config.keywordMode = 'mixed';
  config.keywordHintWeight = 1;
  const requests = mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('TIDE PODS', 'GUM');
  await run(receipt);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].state.household_keyword, { phrase: 'gum', category: 'C / Three' });
  assert.equal(receipt.items[0].source, 'keyword');
  assert.equal(receipt.items[1].source, 'keyword-hint');
  assert.equal(receipt.items[1].keywordCategory, 'C / Three');
  // weight 1: the model keeps its own pick
  assert.deepEqual([receipt.items[1].category, receipt.items[1].confidence], ['A / One', 0.9]);
});

test('categorizeItems: the question mentions the keyword only in hint and mixed modes', async () => {
  const asked = [];
  const capture = () => mockDecider(() => reply('A / One', 0.9));
  config.keywordMode = 'off';
  let requests = capture();
  await run(newReceipt('X'));
  asked.push(requests[0].questions.category.instructions);
  mock.restoreAll();
  config.keywordMode = 'hint';
  requests = capture();
  await run(newReceipt('X'));
  asked.push(requests[0].questions.category.instructions);
  assert.ok(!asked[0].includes('household_keyword'));
  assert.ok(asked[1].includes('household_keyword'));
});

test('categorizeItems: hint mode with a reweigh that flips the pick sets modelSaid and uses the keyword category probability', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two' }]);
  config.keywordMode = 'hint';
  config.keywordHintWeight = 4;
  const probabilities = { 'A / One': 0.6, 'B / Two': 0.4, 'C / Three': 0 };
  mockDecider(() => reply('A / One', 0.6, probabilities));
  const receipt = newReceipt('GUM');
  await run(receipt);
  const [it] = receipt.items;
  const expected = reweigh(probabilities, 'B / Two', 4);
  assert.equal(it.category, 'B / Two');
  assert.equal(it.confidence, expected.confidence);
  assert.equal(it.margin, expected.margin);
  assert.ok(Math.abs(it.modelSaid.margin - 0.2) < 1e-12);
  assert.deepEqual([it.modelSaid.category, it.modelSaid.confidence], ['A / One', 0.6]);
  assert.deepEqual(it.decided.model, { category: 'A / One', confidence: 0.6, margin: it.modelSaid.margin }); // replay keeps the model's own numbers
  assert.equal(it.source, 'keyword-hint');
  assert.equal(it.keyword, 'gum');
});

test('categorizeItems: a keyword hint whose flipped pick would fail the move gate keeps the model answer and says so', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two' }]);
  config.keywordMode = 'hint';
  config.keywordHintWeight = 4;
  const { moveMinConfidence, moveMinMargin } = config;
  config.moveMinConfidence = 0.9;
  try {
    const probabilities = { 'A / One': 0.6, 'B / Two': 0.4, 'C / Three': 0 };
    mockDecider(() => reply('A / One', 0.6, probabilities));
    const receipt = newReceipt('GUM');
    await categorizeItems(receipt, LABELS, [], [], { currentLabel: 'A / One', ruleLabel: 'A / One' }); // B / Two would be a move out
    const [it] = receipt.items;
    assert.equal(it.category, 'A / One');
    assert.equal(it.confidence, 0.6);
    assert.equal(it.modelSaid, undefined);
    assert.equal(it.keywordTooWeak.category, 'B / Two');
    assert.ok(it.keywordTooWeak.confidence > 0.7);
    assert.equal(it.source, 'keyword-hint');
  } finally {
    Object.assign(config, { moveMinConfidence, moveMinMargin });
  }
});

test('categorizeItems: an invalid model answer is not reweighed', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two' }]);
  config.keywordMode = 'hint';
  mockDecider(() => reply('Nope', 0.5, { 'B / Two': 1 }));
  const receipt = newReceipt('GUM');
  await run(receipt);
  assert.equal(receipt.items[0].category, null);
  assert.equal(receipt.items[0].confidence, 0);
  assert.equal(receipt.items[0].source, 'keyword-hint');
});

test('categorizeItems: keywords that disagree set keywordTie and leave the item to the model', async () => {
  writeKeywords([{ phrase: 'tide', category: 'A / One' }, { phrase: 'milk', category: 'B / Two' }]);
  config.keywordMode = 'final';
  const requests = mockDecider(() => reply('C / Three', 0.9));
  const receipt = newReceipt('TIDE MILK');
  await run(receipt);
  assert.equal(requests.length, 1);
  assert.deepEqual(receipt.items[0].keywordTie.sort(), ['"milk" → B / Two', '"tide" → A / One']);
  assert.equal(receipt.items[0].category, 'C / Three');
  assert.equal(receipt.items[0].source, undefined);
});

test('categorizeItems: a keyword whose category is not offered is ignored', async () => {
  writeKeywords([{ phrase: 'gum', category: 'Hidden / Thing' }]);
  config.keywordMode = 'final';
  const requests = mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('GUM');
  await run(receipt);
  assert.equal(requests.length, 1);
  assert.equal(receipt.items[0].keywordCategory, undefined);
});

test('categorizeItems: a store-scoped keyword needs the store, and known.ignoreKeywordsFromTxn hides keywords from one transaction', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two', store: 'Costco' }, { phrase: 'milk', category: 'C / Three', fromTxn: 't9' }]);
  config.keywordMode = 'final';
  mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('GUM', 'MILK');
  await categorizeItems(receipt, LABELS, [], [], { ignoreKeywordsFromTxn: 't9' });
  assert.deepEqual(receipt.items.map((i) => i.category), ['A / One', 'A / One']);
});

test('categorizeItems: amount rules are not evidence: the decider is never told about them', async () => {
  const requests = mockDecider(() => reply('A / One', 0.9));
  const amountRules = [{ upTo: 11, category: 'B / Two' }, { over: 11, category: 'A / One' }];
  await categorizeItems(newReceipt('X'), LABELS, [], [], { ruleLabel: 'A / One', amountRules });
  assert.equal('your_rules_by_charge_amount_at_this_store' in requests[0].state, false);
  assert.equal(requests[0].state.category_your_rules_give_this_store, 'A / One'); // what the rules give this charge is still told
  assert.ok(!JSON.stringify(requests[0].state).includes('11.00'));
});

test('categorizeItems: the occasions, rule category and past purchases reach the decider', async () => {
  config.similarItems = false; // similar items are tested on their own below
  const requests = mockDecider(() => reply('A / One', 0.9));
  const history = [{ date: '2026-09-01', amount: '10.00', parts: [{ category: 'A / One', amount: '10.00', notes: 'milk' }] }];
  await categorizeItems(newReceipt('X'), LABELS, history, [{ items: 'milk', category: 'A / One', store: 'Target' }], { currentLabel: 'B / Two', ruleLabel: 'A / One', occasions: ["Father's Day (US holiday) on 2026-06-21"] });
  const state = requests[0].state;
  assert.equal(state.store, 'Target');
  assert.equal(state.category_your_rules_give_this_store, 'A / One');
  assert.equal(state.current_category_of_the_bank_transaction, 'B / Two');
  assert.deepEqual(state.birthdays_and_holidays_near_this_date, ["Father's Day (US holiday) on 2026-06-21"]);
  assert.deepEqual(state.past_purchases_at_this_store, [{ date: '2026-09-01', amount: '10.00', filed_as: ['A / One 10.00 (milk)'] }]);
  assert.deepEqual(state.items_this_household_filed_before, { 'A / One': ['milk (at Target)'] });
  assert.equal('similar_items_filed_before' in state, false);
});

test('categorizeItems: what the pipeline filed itself and nobody checked is labeled and never tallied', async () => {
  config.similarItems = true;
  const requests = mockDecider(() => reply('A / One', 0.9));
  const history = [
    { date: '2026-09-01', amount: '10.00', by: 'household', parts: [{ category: 'A / One', amount: '6.00', notes: 'milk', by: 'household' }, { category: 'B / Two', amount: '4.00', notes: 'gum', by: 'pipeline' }] },
    { date: '2026-08-01', amount: '8.00', by: 'pipeline', parts: [{ category: 'B / Two', amount: '8.00', notes: null, by: 'pipeline' }] },
  ];
  const itemHistory = [
    { items: 'Whole milk 1 gal', category: 'A / One', store: 'Costco', by: 'household' },
    { items: 'Whole milk 2%', category: 'B / Two', store: 'Costco', by: 'pipeline' },
    { items: 'Whole milk organic', category: 'B / Two', store: 'Costco', by: 'corrected' },
  ];
  await categorizeItems(newReceipt('WHOLE MILK'), LABELS, history, itemHistory, {});
  const s = requests[0].state;
  assert.deepEqual(s.past_purchases_at_this_store, [{ date: '2026-09-01', amount: '10.00', filed_as: ['A / One 6.00 (milk)', 'B / Two 4.00 (gum) [filed by pipeline, unchecked]'] }]);
  assert.deepEqual(s.past_purchases_filed_by_the_pipeline_unchecked, [{ date: '2026-08-01', amount: '8.00', filed_as: ['B / Two 8.00'] }]);
  const marked = s.similar_items_filed_before.filter((x) => x.filed_by);
  assert.deepEqual(marked.map((x) => [x.items, x.filed_by]), [['Whole milk 2%', 'pipeline, unchecked']]);
  assert.deepEqual(s.similar_items_by_category, { 'A / One': 1, 'B / Two': 1 }); // yours and the correction; not the pipeline's
  assert.deepEqual(s.items_this_household_filed_before['B / Two'].filter((t) => t.includes('unchecked')), ['Whole milk 2% (at Costco) [filed by pipeline, unchecked]']);
  assert.equal(s.items_this_household_filed_before['A / One'][0].includes('unchecked'), false);
});

test('categorizeItems: SIMILAR_ITEMS adds similar past items to the request', async () => {
  config.similarItems = true;
  const requests = mockDecider(() => reply('A / One', 0.9));
  await categorizeItems(newReceipt('WHOLE MILK'), LABELS, [], [{ items: 'Whole milk 1 gal', category: 'A / One', store: 'Costco' }], {});
  assert.deepEqual(requests[0].state.similar_items_filed_before, [{ items: 'Whole milk 1 gal', filed_as: 'A / One', store: 'Costco' }]);
  assert.deepEqual(requests[0].state.similar_items_by_category, { 'A / One': 1 });
});

test('householdExamples: the newest 15 per category across all accounts, not per account order', () => {
  const labels = ['A / One', 'B / Two'];
  // account 1 (older notes) comes first in the list, account 2 has the newer ones
  const history = [
    ...Array.from({ length: 20 }, (_, i) => ({ items: `old ${i}`, category: 'A / One', store: null, date: `2025-01-${String(i + 1).padStart(2, '0')}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ items: `new ${i}`, category: 'A / One', store: 'Target', date: `2026-03-0${i + 1}` })),
    { items: 'no date', category: 'A / One', store: null },
    { items: 'tea', category: 'B / Two', store: null, date: '2026-01-01' },
    { items: 'ignored', category: 'C / Three', store: null, date: '2026-01-01' },
  ];
  const got = householdExamples(history, labels);
  assert.equal(got['A / One'].length, 15);
  assert.deepEqual(got['A / One'].slice(0, 5), ['new 4 (at Target)', 'new 3 (at Target)', 'new 2 (at Target)', 'new 1 (at Target)', 'new 0 (at Target)']);
  assert.equal(got['A / One'][5], 'old 19', 'then the newest older ones');
  assert.ok(!got['A / One'].includes('no date'), 'undated notes come last, after the dated ones');
  assert.deepEqual(got['B / Two'], ['tea']);
  assert.equal(got['C / Three'], undefined);
  // same date (or no date at all): the order they came in is kept
  const same = householdExamples([{ items: 'x1', category: 'A / One', date: '2026-01-01' }, { items: 'x2', category: 'A / One', date: '2026-01-01' }, { items: 'u1', category: 'A / One' }, { items: 'u2', category: 'A / One' }], labels);
  assert.deepEqual(same['A / One'], ['x1', 'x2', 'u1', 'u2']);
});

test('categorizeItems: a learned keyword with maxCents only applies to charges up to that size; household keywords always apply', async () => {
  const learnedOn = config.learning.mode;
  config.learning.mode = 'on';
  config.keywordMode = 'mixed';
  try {
    const learned = { phrase: 'chicken strp', category: 'B / Two', store: 'Costco', strength: 'always', from: 'learned', maxCents: 3000 };
    const category = async (keywords, known) => {
      writeKeywords(keywords);
      mock.restoreAll();
      mockDecider(() => reply('A / One', 0.9));
      const receipt = { ...newReceipt('CHICKEN STRP'), store: 'Costco' };
      await categorizeItems(receipt, LABELS, [], [], known);
      return receipt.items[0].category;
    };
    assert.equal(await category([learned], { chargeCents: 1378 }), 'B / Two');
    assert.equal(await category([learned], { chargeCents: 3000 }), 'B / Two');
    assert.equal(await category([learned], { chargeCents: 5063 }), 'A / One');
    assert.equal(await category([learned], {}), 'A / One'); // size unknown: be careful
    assert.equal(await category([{ ...learned, maxCents: undefined }], {}), 'B / Two'); // no limit stored (older keyword)
    assert.equal(await category([{ ...learned, from: 'cli' }], { chargeCents: 5063 }), 'B / Two');
  } finally {
    config.learning.mode = learnedOn;
  }
});

// ---- the per-receipt check ----
const picked = (category, confidence, margin, probabilities, extra = {}) => ({ description: 'X', category, confidence, margin, ...(probabilities ? { probabilities } : {}), ...extra });
const whole = (category, confidence, margin = 0.5) => ({ category, confidence, margin });

test('applyReceiptCheck: a confident receipt answer pulls in the items that do not clearly beat it; the rest keep their pick', () => {
  const unclear = picked('A / One', 0.5, 0.1, { 'A / One': 0.5, 'B / Two': 0.4 });
  const clear = picked('C / Three', 0.8, 0.6, { 'C / Three': 0.8, 'B / Two': 0.1 });
  const same = picked('B / Two', 0.4, 0.0);
  const moved = applyReceiptCheck([unclear, clear, same], whole('B / Two', 0.7, 0.45));
  assert.deepEqual(moved, [unclear]);
  assert.deepEqual([unclear.category, unclear.confidence, unclear.margin], ['B / Two', 0.7, 0.45]);
  assert.deepEqual(unclear.receiptSaid, { category: 'A / One', confidence: 0.5, margin: 0.1 });
  assert.deepEqual([clear.category, clear.receiptSaid], ['C / Three', undefined]);
  assert.deepEqual([same.category, same.confidence, same.receiptSaid], ['B / Two', 0.4, undefined]);
});

test('applyReceiptCheck: the bar is RECEIPT_CHECK_MIN_CONFIDENCE; below it nothing changes', () => {
  const it = picked('A / One', 0.5, 0.1);
  assert.deepEqual(applyReceiptCheck([it], whole('B / Two', 0.49)), []);
  assert.equal(it.category, 'A / One');
  config.receiptCheckMinConfidence = 0.4;
  assert.equal(applyReceiptCheck([it], whole('B / Two', 0.49)).length, 1);
  assert.deepEqual(applyReceiptCheck([picked('A / One', 0.5, 0.1)], { category: null, confidence: 0, invalid: 'x' }), []);
});

test('applyReceiptCheck: an item must also lead the receipt category by MOVE_MIN_MARGIN (it can pass the move gate on reweighed numbers and still not)', () => {
  // a keyword hint lifted the item to 0.7 with a 0.5 margin, but its own probability for the receipt's category is 0.6
  const hinted = picked('A / One', 0.7, 0.5, { 'A / One': 0.3, 'B / Two': 0.6 }, { source: 'keyword-hint' });
  assert.equal(applyReceiptCheck([hinted], whole('B / Two', 0.7)).length, 1);
  const ahead = picked('A / One', 0.7, 0.5, { 'A / One': 0.7, 'B / Two': 0.4 });
  assert.equal(applyReceiptCheck([ahead], whole('B / Two', 0.7)).length, 0, '0.3 ahead of the receipt category, and clear: it stays');
  const nothing = picked('A / One', 0.7, null); // no probabilities: the move gate alone decides
  assert.equal(applyReceiptCheck([nothing], whole('B / Two', 0.7)).length, 0);
});

test('applyReceiptCheck: items an "always" keyword filed, and items with no category, are never pulled in', () => {
  const kw = picked('A / One', 1, null, undefined, { source: 'keyword', keyword: 'coke' });
  const none = picked(null, 0, null);
  assert.deepEqual(applyReceiptCheck([kw, none], whole('B / Two', 0.9)), []);
  assert.deepEqual([kw.category, none.category], ['A / One', null]);
});

test('categorizeItems: the whole-purchase answer is asked after the items, kept on receipt.receiptCheck, and cleared on the next run', async () => {
  config.receiptCheck = true;
  const requests = mockDecider((state) => (state.items_on_receipt ? reply('B / Two', 0.5, { 'B / Two': 0.7, 'A / One': 0.2, 'C / Three': 0.1 }) : reply('A / One', 0.5, { 'A / One': 0.5, 'B / Two': 0.4, 'C / Three': 0.1 })));
  const receipt = newReceipt('COKE', 'CHICKEN');
  await run(receipt);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].questions.category.instructions.startsWith('If this whole purchase'), true);
  assert.deepEqual(Object.keys(requests[2].questions.category.criteria), LABELS, 'the same category list as the item questions');
  assert.deepEqual(receipt.items.map((i) => i.category), ['B / Two', 'B / Two']);
  assert.equal(receipt.receiptCheck.category, 'B / Two');
  assert.ok(Math.abs(receipt.receiptCheck.margin - 0.5) < 1e-12);
  // the model's own answers stay on item.decided, for replay
  assert.deepEqual(receipt.items.map((i) => i.decided.category), ['A / One', 'A / One']);
  config.receiptCheck = false;
  await run(receipt);
  assert.equal('receiptCheck' in receipt, false);
  assert.equal(receipt.items.some((i) => i.receiptSaid), false);
});

test('categorizeItems: an item filed by an "always" keyword stays, and with every item filed that way no whole-purchase question is asked', async () => {
  config.receiptCheck = true;
  config.keywordMode = 'mixed';
  writeKeywords([{ phrase: 'coke', category: 'C / Three', strength: 'always' }]);
  const requests = mockDecider((state) => (state.items_on_receipt ? reply('B / Two', 0.9, { 'B / Two': 0.9 }) : reply('A / One', 0.5, { 'A / One': 0.5, 'B / Two': 0.4 })));
  const receipt = newReceipt('COKE', 'CHICKEN');
  await run(receipt);
  assert.deepEqual(receipt.items.map((i) => i.category), ['C / Three', 'B / Two']);
  assert.equal(requests.length, 2, 'the other item and the whole purchase');
  requests.length = 0;
  const all = newReceipt('COKE', 'COKE ZERO');
  await run(all);
  assert.equal(requests.length, 0);
  assert.equal(all.receiptCheck, undefined);
});

test('categorizeItems: a learned keyword also has an item-price limit: the same words at a bigger price are left to the model', async () => {
  config.keywordMode = 'hint';
  writeKeywords([{ phrase: 'coke', category: 'B / Two', store: 'Target', from: 'learned', added: '2026-10-01', maxCents: 3000, maxItemCents: 500 }]);
  mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('20 OZ COKE', 'COKE 35PK');
  receipt.items[0].amount = 1.58;
  receipt.items[1].amount = 15.49;
  await categorizeItems(receipt, LABELS, [], [], { chargeCents: 1378 });
  assert.deepEqual(receipt.items.map((i) => i.keywordCategory), ['B / Two', undefined]);
  // an unknown item price skips a limited keyword, like an unknown charge
  const unknown = { ...newReceipt('20 OZ COKE'), items: [{ description: '20 OZ COKE' }] };
  await categorizeItems(unknown, LABELS, [], [], { chargeCents: 1378 });
  assert.equal(unknown.items[0].keywordCategory, undefined);
  // the charge limit still applies on its own
  const big = newReceipt('20 OZ COKE');
  big.items[0].amount = 1.58;
  await categorizeItems(big, LABELS, [], [], { chargeCents: 5000 });
  assert.equal(big.items[0].keywordCategory, undefined);
});

test('applyReceiptCheck: a keyword-hinted item is compared with the receipt category on the same (reweighed) distribution', () => {
  const answer = whole('C / Three', 0.7);
  const hinted = (extra) => picked('A / One', 0.6, 0.4, { 'A / One': 0.3, 'C / Three': 0.5 }, extra); // raw: the receipt category is at 0.5
  assert.equal(applyReceiptCheck([hinted()], answer).length, 1, 'by the raw numbers it leads by only 0.1');
  assert.equal(applyReceiptCheck([hinted({ reweighed: { 'A / One': 0.6, 'C / Three': 0.2 } })], answer).length, 0, 'by the numbers its confidence came from, 0.4 ahead');
});

test('categorizeItems: a hint that reweighs keeps the new distribution on the item, and it adds up to 1', async () => {
  config.keywordMode = 'hint';
  config.keywordHintWeight = 4;
  writeKeywords([{ phrase: 'gum', category: 'B / Two', store: null, strength: 'usually' }]);
  mockDecider(() => reply('A / One', 0.5, { 'A / One': 0.5, 'B / Two': 0.2, 'C / Three': 0.3 }));
  const receipt = newReceipt('GUM');
  await run(receipt);
  const [it] = receipt.items;
  assert.equal(it.category, 'B / Two');
  assert.ok(Math.abs(Object.values(it.reweighed).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(it.reweighed['B / Two'] - it.confidence) < 1e-12);
  assert.deepEqual(it.probabilities, { 'A / One': 0.5, 'B / Two': 0.2, 'C / Three': 0.3 }, 'the decider\'s own numbers are untouched');
  await run(receipt); // the next run clears it
  assert.equal('reweighed' in it, true);
  mock.restoreAll();
  mockDecider(() => reply('A / One', 0.9));
  await run(receipt);
  assert.equal('reweighed' in receipt.items[0], false);
});

test('categorizeItems: with known.learnedKeywords the stored learned keywords are replaced by those, yours stay', async () => {
  config.keywordMode = 'hint';
  writeKeywords([{ phrase: 'gum', category: 'B / Two', store: null, from: 'learned', strength: 'usually' }, { phrase: 'milk', category: 'C / Three', store: null, from: 'cli' }]);
  const category = async (known) => {
    mock.restoreAll();
    mockDecider(() => reply('A / One', 0.9));
    const receipt = newReceipt('GUM', 'MILK');
    await categorizeItems(receipt, LABELS, [], [], known);
    return receipt.items.map((i) => i.keywordCategory);
  };
  assert.deepEqual(await category({}), ['B / Two', 'C / Three']);
  assert.deepEqual(await category({ learnedKeywords: [] }), [undefined, 'C / Three'], 'the stored learned one is not used');
  assert.deepEqual(await category({ learnedKeywords: [{ phrase: 'gum', category: 'A / One', store: null, strength: 'usually' }, { phrase: 'milk', category: 'A / One', store: null }] }), ['A / One', 'C / Three'], 'rebuilt one used; yours beat a learned one');
});
