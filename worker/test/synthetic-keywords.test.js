// Household keywords (keywords.js) in every KEYWORD_MODE, from the synthetic keyword files: always/usually strengths,
// store-scoped keywords, ties, keywords for excluded, hidden or missing categories, learned keywords with size limits
// (used only with LEARNING=on), and keywords in a budget with emoji and accented category names.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { matchKeyword, normalize } from '../src/keywords.js';
import { budget, excludeFor, fakeActual, fakeDecider, oracle, reply, resetConfig, keywordFile, quiet, checkInvariants, runReceipt, fixture } from './synthetic-harness.js';

const { categorizeReceipt } = await import('../src/receipt.js');
const actual = await import('../src/actual.js');

afterEach(() => {
  mock.reset();
  resetConfig();
});

/**
 * Categorize these item descriptions at `store` with the keyword file, in `mode`. The decider answers every item it is
 * asked about with the budget's first allowed label at 0.55 and the hinted category second at 0.35 (so a x4 hint flips it).
 */
async function categorize(descriptions, { mode, file = 'standard-household', bname = 'standard', store = 'FreshFields Market', payee = 'p-fresh', chargeCents = 1000, settings = {}, prices } = {}) {
  const b = budget(bname);
  resetConfig({ ...excludeFor(b), keywordMode: mode, keywordHintWeight: 4, ...settings });
  mock.reset();
  quiet();
  fs.copyFileSync(keywordFile(file), config.keywordsPath);
  const { labels } = await fakeActual(b, []);
  const seen = fakeDecider((state, ls) => {
    if (state.items_on_receipt) return reply(ls[0], 0.3);
    // the first label at 0.55; the hinted category (or else the second label) is the runner-up at 0.35
    const second = state.household_keyword && ls.includes(state.household_keyword.category) && state.household_keyword.category !== ls[0] ? state.household_keyword.category : ls[1];
    const third = ls.find((l) => l !== ls[0] && l !== second);
    return reply(ls[0], 0.55, { [ls[0]]: 0.55, [second]: 0.35, [third]: 0.1 });
  });
  const receipt = { merchant: store, date: null, total: chargeCents / 100, items: descriptions.map((description, i) => ({ description, amount: prices?.[i] ?? 1 })) };
  const doubts = [];
  await categorizeReceipt(receipt, { id: 't1', payeeName: store, payee, date: '2026-10-01', amount: -chargeCents }, labels, actual.idToLabel(labels), null, doubts, {});
  const asked = seen.filter((s) => s.state.item).map((s) => s.state.item);
  const hinted = Object.fromEntries(seen.filter((s) => s.state.household_keyword).map((s) => [s.state.item, s.state.household_keyword]));
  return { receipt, doubts, asked, hinted, by: Object.fromEntries(receipt.items.map((it) => [it.description, it])) };
}

const GRO = 'Daily Expenses / Groceries';
const GIFT = 'Fun / Gifts';
const PETS = 'Daily Expenses / Pets';

test('KEYWORD_MODE=final: a matched keyword files the item without the model; the longer phrase wins ("gift card" over "card")', async () => {
  const { asked, by } = await categorize(['WHL MILK GAL', 'GIFT CARD', 'BDAY CARD', 'DOG TREATS', 'RICE'], { mode: 'final' });
  assert.deepEqual(asked, ['RICE']);
  assert.deepEqual([by['WHL MILK GAL'].category, by['WHL MILK GAL'].source, by['WHL MILK GAL'].confidence], [GRO, 'keyword', 1]);
  assert.equal(by['GIFT CARD'].keyword, 'gift card');
  assert.equal(by['BDAY CARD'].keyword, 'card');
  assert.equal(by['DOG TREATS'].category, PETS);
});

test('KEYWORD_MODE=mixed: "always" files, "usually" is a hint the decider sees and that reweighs its answer', async () => {
  const { asked, hinted, by } = await categorize(['WHL MILK GAL', 'DOG TREATS', 'BDAY CARD', 'RICE'], { mode: 'mixed' });
  assert.deepEqual(asked, ['DOG TREATS', 'BDAY CARD', 'RICE']);
  assert.deepEqual(hinted['DOG TREATS'], { phrase: 'dog', category: PETS });
  assert.equal(by['WHL MILK GAL'].source, 'keyword');
  assert.equal(by['DOG TREATS'].source, 'keyword-hint');
  assert.equal(by['DOG TREATS'].category, PETS, '0.35 × 4 against 0.55: the hint wins after reweighing');
  assert.equal(by['DOG TREATS'].modelSaid.category, GRO);
  assert.equal(by.RICE.category, GRO);
});

test('keywords: a tie between equally good keywords is reported, not guessed; the decider decides the item', async () => {
  for (const mode of ['final', 'mixed', 'hint']) {
    const { doubts, asked, by } = await categorize(['AA BATTERIES'], { mode });
    assert.deepEqual(by['AA BATTERIES'].keywordTie, ['"batteries" → Daily Expenses / Household Supplies', '"batteries" → Fun / Entertainment'], mode);
    assert.deepEqual(asked, ['AA BATTERIES'], mode);
    assert.match(doubts.join('\n'), /keywords disagree for AA BATTERIES/, mode);
  }
});

test('keywords: one for an excluded, a hidden or a missing category is never used', async () => {
  for (const mode of ['final', 'mixed', 'hint']) {
    const { asked, hinted, by } = await categorize(['INTERNET BILL', 'HOBBY KIT', 'LEMONADE'], { mode });
    for (const d of ['INTERNET BILL', 'HOBBY KIT', 'LEMONADE']) {
      assert.equal(by[d].keywordCategory, undefined, `${mode}: ${d}`);
      assert.ok(asked.includes(d) && !(d in hinted), `${mode}: ${d}`);
    }
  }
});

test('keywords: a keyword for a category receipts cannot use does not hide a usable one that also matches', async () => {
  const { by } = await categorize(['INTERNET CARD TOPUP'], { mode: 'final' });
  assert.equal(by['INTERNET CARD TOPUP'].keywordCategory, GIFT);
});

test('keywords: a store-scoped keyword applies only at that store (whole words of the payee name)', async () => {
  const at = await categorize(['CHILD SOCKS 3PK'], { mode: 'final', store: 'HomeMart', payee: 'p-hmart' });
  assert.equal(at.by['CHILD SOCKS 3PK'].category, 'Kids / Kid');
  const elsewhere = await categorize(['CHILD SOCKS 3PK'], { mode: 'final' });
  assert.equal(elsewhere.by['CHILD SOCKS 3PK'].source, undefined);
  const bag = await categorize(['BAG FEE'], { mode: 'final' }); // "FreshFields" is a whole word of "FreshFields Market"
  assert.equal(bag.by['BAG FEE'].category, 'Daily Expenses / Household Supplies');
});

test('learned keywords: only with LEARNING=on, only as a hint in final mode, and only within their size limits', async () => {
  // chips: learned, max charge $20.00, max item $5.00
  const small = await categorize(['CHIPS'], { mode: 'final', chargeCents: 1500, prices: [3] });
  assert.equal(small.by.CHIPS.source, 'keyword-hint', 'a learned keyword is never final');
  for (const [what, opts] of Object.entries({
    'charge over the limit': { chargeCents: 2500, prices: [3] },
    'item over the limit': { chargeCents: 1500, prices: [6] },
    'LEARNING=record': { chargeCents: 1500, prices: [3], settings: { learning: { mode: 'record' } } },
    'LEARNING=off': { chargeCents: 1500, prices: [3], settings: { learning: { mode: 'off' } } },
  })) {
    const r = await categorize(['CHIPS'], { mode: 'final', ...opts });
    assert.equal(r.by.CHIPS.keywordCategory, undefined, what);
  }
});

test('keywords in a budget with emoji and accented category names, and a keyword for an EXCLUDE_CATEGORIES label', async () => {
  const opts = { mode: 'mixed', file: 'large-unicode', bname: 'large', store: 'Marché Lumière', payee: 'p-euro' };
  const { by, asked } = await categorize(['UNLEADED 10 GAL', 'FROMAGE COMTÉ', 'LOTTERY TICKET', 'MISC ITEM', 'TOY CAR'], opts);
  assert.equal(by['UNLEADED 10 GAL'].category, 'Transport / Gas / Fuel');
  assert.equal(by['FROMAGE COMTÉ'].category, 'Food / Dairy & Eggs');
  assert.equal(by['MISC ITEM'].category, 'Fun & Hobbies / Misc 🤷');
  assert.equal(by['LOTTERY TICKET'].keywordCategory, undefined, 'Lottery is excluded by EXCLUDE_CATEGORIES');
  assert.ok(asked.includes('LOTTERY TICKET') && asked.includes('TOY CAR'));
  assert.equal(by['TOY CAR'].source, 'keyword-hint');
});

test('keywords end to end: every mode on the standard household keeps the pipeline invariants and never files into a banned category', async () => {
  const b = budget('standard');
  for (const mode of ['off', 'final', 'hint', 'mixed']) {
    for (const name of ['grocery-basic', 'gift-card', 'deposits-fees', 'grocery-60-items', 'duplicates-qty', 'electronics-big', 'f-coded-food']) {
      resetConfig({ ...excludeFor(b), keywordMode: mode });
      const run = await runReceipt(fixture(name), b, { keywords: keywordFile('standard-household'), answer: oracle });
      checkInvariants(run, b, `${mode}/${name}`);
    }
  }
});

test('keywords match accented and non-Latin text as words, without matching stray letters', () => {
  const kw = (phrase) => [{ phrase, category: 'X', store: null }];
  assert.equal(matchKeyword(['MILK 1 L'], 'Store', kw('øl')), null, '"øl" (beer) is not the litre mark');
  assert.equal(matchKeyword(['CAF FEE'], 'Store', kw('café')), null);
  assert.ok(matchKeyword(['CREME FRAICHE'], 'Store', kw('crème fraîche')), 'receipts often print without accents');
  assert.ok(matchKeyword(['牛乳 1L'], 'Store', kw('牛乳')));
  assert.ok(matchKeyword(['МОЛОКО 1Л'], 'Store', kw('молоко')));
  assert.notEqual(normalize('Müsli'), 'm sli');
});
