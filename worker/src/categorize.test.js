import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { categorizeItems, checkAnswer, entropyConfidence, receiptLabels, reweigh, stripDepartment } from './categorize.js';

const LABELS = ['A / One', 'B / Two', 'C / Three'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'categorize-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// This file's own keywords file, so it can't collide with other test files running in parallel.
config.keywordsPath = path.join(tmp, 'keywords.json');
config.categoryNotesPath = path.join(tmp, 'category-notes.json');
const writeKeywords = (keywords) => fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords }));

const saved = { keywordMode: config.keywordMode, keywordHintWeight: config.keywordHintWeight, similarItems: config.similarItems, excludeGroups: config.excludeGroups, excludeCategories: config.excludeCategories, stripDepartmentPrefixes: config.stripDepartmentPrefixes };
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

test('entropyConfidence: 1 for a sure answer, 0 for an even spread', () => {
  assert.equal(entropyConfidence({ a: 1, b: 0 }), 1);
  assert.ok(Math.abs(entropyConfidence({ a: 0.5, b: 0.5 })) < 1e-12);
  assert.equal(entropyConfidence({ a: 0.3 }), 1); // one category: nothing to be unsure about
  const mid = entropyConfidence({ a: 0.8, b: 0.1, c: 0.1 });
  assert.ok(mid > 0 && mid < 1);
});

test('checkAnswer: a valid answer, with and without probabilities', () => {
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0.9 }, LABELS), { category: 'A / One', confidence: 0.9 });
  const p = { 'A / One': 0.9, 'B / Two': 0.1 };
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: p }, LABELS), { category: 'A / One', confidence: 0.9, probabilities: p });
  // probabilities that are not all numbers are dropped, the answer stays valid
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0.9, probabilities: { a: 'x' } }, LABELS), { category: 'A / One', confidence: 0.9 });
  assert.deepEqual(checkAnswer({ choice: 'A / One', confidence: 0, probabilities: 'x' }, LABELS), { category: 'A / One', confidence: 0 });
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
  assert.ok(Math.abs(r.pChoice - 1.6 / 2.2) < 1e-12);
  assert.equal(r.pCategory, r.pChoice);
  assert.ok(Math.abs(r.confidence - entropyConfidence({ a: 0.6 / 2.2, b: 1.6 / 2.2 })) < 1e-12);
});

test('reweigh: a weight too small to flip the pick keeps the model choice', () => {
  const r = reweigh({ 'A / One': 0.8, 'B / Two': 0.2 }, 'B / Two', 2);
  assert.equal(r.choice, 'A / One');
  assert.ok(Math.abs(r.pCategory - 0.4 / 1.2) < 1e-12);
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
  assert.deepEqual(receipt.items.map((i) => [i.category, i.confidence]), [['A / One', 0.9], ['B / Two', 0.4]]);
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

test('categorizeItems (decider): a bare answer without the "answers" wrapper is accepted', async () => {
  mockDecider(() => ({ category: { choice: 'C / Three', confidence: 0.7 } }));
  const receipt = newReceipt('X');
  await run(receipt);
  assert.deepEqual([receipt.items[0].category, receipt.items[0].confidence], ['C / Three', 0.7]);
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
  assert.equal(it.confidence, expected.pCategory);
  assert.deepEqual(it.modelSaid, { category: 'A / One', confidence: 0.6 });
  assert.equal(it.source, 'keyword-hint');
  assert.equal(it.keyword, 'gum');
});

test('categorizeItems: a reweigh that agrees with the model raises confidence without setting modelSaid', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two' }]);
  config.keywordMode = 'hint';
  config.keywordHintWeight = 4;
  const probabilities = { 'A / One': 0.2, 'B / Two': 0.5, 'C / Three': 0.3 };
  mockDecider(() => reply('B / Two', 0.1, probabilities));
  const receipt = newReceipt('GUM');
  await run(receipt);
  const expected = reweigh(probabilities, 'B / Two', 4);
  assert.equal(receipt.items[0].category, 'B / Two');
  assert.equal(receipt.items[0].confidence, expected.confidence);
  assert.equal(receipt.items[0].modelSaid, undefined);
});

test('categorizeItems: a reweigh that cannot make the keyword category win leaves the model pick', async () => {
  writeKeywords([{ phrase: 'gum', category: 'B / Two' }]);
  config.keywordMode = 'hint';
  config.keywordHintWeight = 2;
  mockDecider(() => reply('A / One', 0.8, { 'A / One': 0.9, 'B / Two': 0.1, 'C / Three': 0 }));
  const receipt = newReceipt('GUM');
  await run(receipt);
  assert.deepEqual([receipt.items[0].category, receipt.items[0].confidence, receipt.items[0].modelSaid], ['A / One', 0.8, undefined]);
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

test('categorizeItems: results of an earlier run are cleared first', async () => {
  mockDecider(() => reply('A / One', 0.9));
  const receipt = newReceipt('X');
  Object.assign(receipt.items[0], { source: 'keyword', keyword: 'k', keywordTie: ['x'], keywordCategory: 'B / Two', modelSaid: {}, probabilities: { a: 1 } });
  await run(receipt);
  for (const k of ['source', 'keyword', 'keywordTie', 'keywordCategory', 'modelSaid', 'probabilities']) assert.equal(k in receipt.items[0], false, k);
});

test('categorizeItems: the occasions, rule category and past purchases reach the decider', async () => {
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

test('categorizeItems: SIMILAR_ITEMS adds similar past items to the request', async () => {
  config.similarItems = true;
  const requests = mockDecider(() => reply('A / One', 0.9));
  await categorizeItems(newReceipt('WHOLE MILK'), LABELS, [], [{ items: 'Whole milk 1 gal', category: 'A / One', store: 'Costco' }], {});
  assert.deepEqual(requests[0].state.similar_items_filed_before, [{ items: 'Whole milk 1 gal', filed_as: 'A / One', store: 'Costco' }]);
  assert.deepEqual(requests[0].state.similar_items_by_category, { 'A / One': 1 });
});
