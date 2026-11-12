// End to end through handleReceipt (receipt.js), on synthetic households: every reading in test-fixtures/synthetic/readings
// against every budget and a matrix of settings and bank-charge situations. Actual and the decider are fakes
// (test/synthetic-harness.js); nothing touches the network or /data. Each case checks the invariants in checkInvariants.
import './support.js';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  BUDGET_NAMES, READING_NAMES, budget, fixture, readingOf, resetConfig, runReceipt, checkInvariants, chargeFor, allowedLabels,
  excludeFor, payeeRule, reply, spread, oracle, day, keywordFile, idOf, api,
} from './synthetic-harness.js';

afterEach(() => {
  mock.reset();
  resetConfig();
});

/** Run one case and check the invariants; a throw is a failure that names the case. */
async function check(name, b, settings, opts = {}, where = '') {
  resetConfig({ ...excludeFor(b), ...settings });
  const fx = fixture(name);
  let run;
  try {
    run = await runReceipt(fx, b, opts);
  } catch (err) {
    assert.fail(`${where || name}: threw ${err.stack}`);
  }
  checkInvariants(run, b, where || name);
  return run;
}

// ---- 1. every reading against every budget, default settings, live ----

for (const bname of BUDGET_NAMES) {
  test(`matrix: every synthetic reading against the "${bname}" budget keeps the invariants (live, defaults)`, async () => {
    const results = {};
    for (const name of READING_NAMES) {
      const { out } = await check(name, budget(bname), {}, {}, `${bname}/${name}`);
      results[name] = out.result;
    }
    // What can't be matched never is: a return, a cash purchase, a fixture with no bank charge to find.
    assert.equal(results['return-receipt'], 'review');
    assert.equal(results['cash-paid-tendered'], 'review');
    // An unprinted tip makes the charge bigger than the receipt: without MATCH_TOLERANCE_PERCENT there is no match yet.
    assert.equal(results['restaurant-tip-handwritten'], 'waiting');
  });
}

// ---- 2. settings matrix on the standard household ----

const SETTINGS = {
  defaults: {},
  dryRun: { dryRun: true },
  noSplits: { splits: false },
  splitMin5: { splitMinCents: 500 },
  noFallback: { ruleFallback: false },
  holdForReview: { applyThenReview: false },
  holdNoFallback: { applyThenReview: false, ruleFallback: false },
  receiptCheckOn: { receiptCheck: true },
  taxByItemOff: { taxByItem: false },
  keywordsMixed: { keywordMode: 'mixed' },
  noOverwrite: { match: { overwrite: false } },
  strictMove: { moveMinConfidence: 0.9, moveMinMargin: 0.5, categoryMinConfidence: 0.8 },
};

for (const [sname, settings] of Object.entries(SETTINGS)) {
  test(`settings "${sname}": every reading keeps the invariants, uncategorized charge and charge filed by a rule alike`, async () => {
    const b = budget('standard');
    const keywords = /keyword/i.test(sname) ? keywordFile('standard-household') : undefined;
    for (const name of READING_NAMES) {
      const fx = fixture(name);
      const storeId = idOf(b, b.kinds[fx.reading.items.find((i) => i.kind)?.kind ?? 'grocery']);
      await check(name, b, settings, { keywords }, `${sname}/${name}/uncategorized`);
      await check(name, b, settings, { keywords, charge: { category: storeId }, rules: [payeeRule(fx.payee, storeId)] }, `${sname}/${name}/rule-filed`);
    }
  });
}

// ---- 3. bank-charge situations ----

const situations = (fx, b) => {
  const id = (label) => idOf(b, label);
  const base = chargeFor(fx);
  return {
    'pending, still waiting': { txn: { ...base, cleared: false } },
    'pending, past the wait': { txn: { ...base, cleared: false }, handleOpts: { now: new Date(Date.now() + 30 * 86400000) } },
    'already split': { txn: { ...base, is_parent: true, subtransactions: [{ id: 's1', amount: base.amount, category: id(b.kinds.grocery) }] } },
    'already tagged #receipt': { txn: { ...base, notes: '#receipt other.jpg' } },
    'filed under an excluded category': { txn: { ...base, category: b.categories.find((c) => b.exclude.groups.includes(b.groups.find((g) => g.id === c.group_id).name) && !c.is_income)?.id ?? null } },
    'filed under a hidden category': { txn: { ...base, category: b.categories.find((c) => c.hidden)?.id ?? 'c-missing' } },
    'filed under an income category': { txn: { ...base, category: b.categories.find((c) => c.is_income).id } },
    'filed under another spending category': { txn: { ...base, category: id(b.kinds.electronics) } },
    'two identical charges': { txns: [base, { ...base, id: `${base.id}-twin`, account: 'acct-chk' }], reading: { ...readingOf(fx), card_last4: null } },
    'two charges, card digits break the tie': { txns: [base, { ...base, id: `${base.id}-twin`, account: 'acct-chk' }] },
    'charge on a closed account': { txn: { ...base, account: 'acct-old' } },
    'charge dated a day before the receipt': { txn: { ...base, date: fx.reading.date ? day(-(fx.daysAgo + 1)) : base.date } },
    'charge a cent over': { txn: { ...base, amount: base.amount - 1 } },
    'charge a cent over, 1% tolerance': { txn: { ...base, amount: base.amount - 1 }, settings: { match: { tolerancePercent: 1 } } },
    'charge a cent under, 1% tolerance': { txn: { ...base, amount: base.amount + 1 }, settings: { match: { tolerancePercent: 1 } } },
    'payee is a transfer': { txn: { ...base, payee: 'p-trans', imported_payee: null } },
    'payee unknown, bank text only': { txn: { ...base, payee: null } },
    replay: { handleOpts: { replay: true } },
  };
};

test('charge situations: each reading against pending, split, tagged, excluded, hidden, income, ambiguous, off-by-a-cent and replay charges', async () => {
  for (const bname of ['standard', 'large']) {
    const b = budget(bname);
    for (const name of READING_NAMES) {
      for (const [sit, o] of Object.entries(situations(fixture(name), b))) {
        await check(name, b, o.settings ?? {}, o, `${bname}/${name}/${sit}`);
      }
    }
  }
});

test('charge situations: what each one leads to on a plain grocery receipt', async () => {
  const b = budget('standard');
  const sits = situations(fixture('grocery-basic'), b);
  const res = {};
  for (const [sit, o] of Object.entries(sits)) res[sit] = (await check('grocery-basic', b, o.settings ?? {}, o, sit)).out;
  assert.equal(res['pending, still waiting'].result, 'waiting');
  assert.match(res['pending, past the wait'].summary.problems.join('\n'), /still pending/);
  assert.equal(res['already split'].result, 'waiting', 'an existing split is never a candidate');
  assert.equal(res['already tagged #receipt'].result, 'waiting');
  assert.equal(res['filed under an excluded category'].result, 'review');
  assert.match(res['filed under an excluded category'].summary.problems[0], /which receipts don't change/);
  assert.equal(res['filed under a hidden category'].result, 'review');
  assert.equal(res['filed under an income category'].result, 'review');
  assert.equal(res['two identical charges'].result, 'review');
  assert.match(res['two identical charges'].summary.problems[0], /more than one transaction matches/);
  assert.equal(res['charge on a closed account'].result, 'waiting');
  assert.match(res['charge dated a day before the receipt'].result, /\+review$/);
  assert.equal(res['charge a cent over'].result, 'waiting', 'without MATCH_TOLERANCE_PERCENT the amount must be exact');
  assert.match(res['charge a cent over, 1% tolerance'].result, /\+review$/, 'within the tolerance it matches, and the extra cent is a doubt');
  assert.equal(res['charge a cent under, 1% tolerance'].result, 'waiting', 'the tolerance is for charges above the total (tips), not below');
  assert.equal(res.replay.result, 'split');
});

test('card digits: two equal charges on two cards are told apart by the last four digits on the receipt', async () => {
  const b = budget('standard');
  const fx = fixture('grocery-basic');
  const base = chargeFor(fx);
  const { out } = await check('grocery-basic', b, {}, { txns: [base, { ...base, id: 'twin', account: 'acct-chk' }] });
  assert.notEqual(out.result, 'review', JSON.stringify(out.summary.problems));
  assert.equal(out.summary.transaction.id, base.id); // Rewards Visa 9999, the fixture's card_last4
});

// ---- 4. the tip: MATCH_TOLERANCE_PERCENT ----

test('tip: a charge 20% over the receipt matches with a 25% tolerance, the tip is spread and the receipt goes to review', async () => {
  const b = budget('standard');
  const { out, writes, txn } = await check('restaurant-tip-handwritten', b, { match: { tolerancePercent: 25 } });
  assert.match(out.result, /^categorize\+review$/);
  assert.match(out.summary.problems.join('\n'), /more than the receipt total \(tip\?\)/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].fields.category, 'c-rest');
  assert.equal(-txn.amount, Math.round(fixture('restaurant-tip-handwritten').reading.total * 120));
  // 19%: under the tolerance no longer
  const { out: under } = await check('restaurant-tip-handwritten', b, { match: { tolerancePercent: 19 } });
  assert.equal(under.result, 'waiting');
});

// ---- 5. the decider's answers: odd, broken, unsure, exactly at the thresholds ----

const ANSWERS = {
  'invalid label': () => reply('Not / A Category', 0.9),
  'label with different case': (s, labels) => reply(labels[0].toUpperCase(), 0.9),
  'no probabilities': (s, labels) => reply(labels[1] ?? labels[0], 0.95),
  'empty probabilities': (s, labels) => reply(labels[0], 0.95, {}),
  'probabilities without the choice': (s, labels) => reply(labels[0], 0.95, { [labels[1] ?? labels[0]]: 0.9 }),
  'probabilities for unknown labels only': (s, labels) => reply(labels[0], 0.95, { 'Fake / One': 0.7, 'Fake / Two': 0.3 }),
  'probabilities as strings': (s, labels) => reply(labels[0], 0.95, { [labels[0]]: '0.95' }),
  'probability over 1': (s, labels) => reply(labels[0], 0.95, { [labels[0]]: 1.4 }),
  'a 50/50 tie': (s, labels) => reply(labels[0], 0.5, { [labels[0]]: 0.5, [labels[1] ?? labels[0]]: 0.5 }),
  'a three-way tie': (s, labels) => reply(labels[0], 0.34, { [labels[0]]: 1 / 3, [labels[1]]: 1 / 3, [labels[2]]: 1 / 3 }),
  'choice not the most likely': (s, labels) => reply(labels[0], 0.6, { [labels[0]]: 0.2, [labels[1]]: 0.8 }),
  'everything unsure': (s, labels) => reply(labels[0], 0.2, spread(labels, labels[0], 0.2)),
  'confidence exactly CATEGORY_MIN_CONFIDENCE': (s, labels) => reply(labels[0], 0.5, { [labels[0]]: 0.5, [labels[1]]: 0.3, [labels[2]]: 0.2 }),
  'margin exactly MOVE_MIN_MARGIN': (s, labels) => reply(labels[1], 0.6, { [labels[1]]: 0.6, [labels[0]]: 0.4 }),
  'NaN confidence': (s, labels) => `{"answers":{"category":{"choice":${JSON.stringify(labels[0])},"confidence":NaN}}}`,
  'string confidence': (s, labels) => reply(labels[0], '0.9'),
  'null confidence': (s, labels) => reply(labels[0], null),
  'negative confidence': (s, labels) => reply(labels[0], -0.1),
  'choice is a number': () => reply(3, 0.9),
  'choice is an object': (s, labels) => reply({ label: labels[0] }, 0.9),
  'no answers at all': () => ({}),
  'answers without category': () => ({ answers: {} }),
  'not JSON': () => 'Sorry, I cannot help with that.',
  'empty body': () => '',
  'JSON null': () => 'null',
  'JSON array': () => '[1,2,3]',
  'bare answer (no answers wrapper)': (s, labels) => ({ category: { choice: labels[0], confidence: 0.9 } }),
  'whole-receipt answer conflicts with every item': (s, labels, ctx) => (s.items_on_receipt ? reply(labels.at(-1), 0.99, spread(labels, labels.at(-1), 0.99)) : oracle(s, labels, ctx)),
  'whole-receipt answer invalid': (s, labels, ctx) => (s.items_on_receipt ? reply('Nope', 2) : oracle(s, labels, ctx)),
};

test('decider answers: odd, broken and borderline replies never throw and keep the invariants, receipt check on and off', async () => {
  const b = budget('standard');
  const names = ['grocery-basic', 'one-item-fuel', 'coupons', 'deposits-fees', 'refund-mixed'];
  for (const [aname, answer] of Object.entries(ANSWERS)) {
    await check('grocery-60-items', b, { receiptCheck: true }, { answer }, `${aname}/grocery-60-items`);
    for (const name of names) {
      for (const settings of [{ receiptCheck: true }, { receiptCheck: true, applyThenReview: false, ruleFallback: false }]) {
        const where = `${aname}/${name}/${JSON.stringify(settings)}`;
        await check(name, b, settings, { answer }, where);
        // the same with the store's category set by a rule
        await check(name, b, settings, { answer, charge: { category: 'c-groc' }, rules: [payeeRule(fixture(name).payee, 'c-groc')] }, `${where}/rule-filed`);
      }
    }
  }
});

test('decider answers: an invalid answer for every item leaves the money uncategorized and sends the receipt to review', async () => {
  const b = budget('standard');
  const { out } = await check('grocery-basic', b, { ruleFallback: false }, { answer: ANSWERS['invalid label'] });
  assert.equal(out.result, 'review');
  assert.match(out.summary.problems.join('\n'), /not sure about: .*invalid answer/);
  // with a store category to fall back on, the whole charge stays where it is and only a note is added
  const filed = await check('grocery-basic', b, {}, { answer: ANSWERS['invalid label'], charge: { category: 'c-groc' } });
  assert.equal(filed.out.result, 'confirm');
  assert.equal(filed.writes.length, 1);
  assert.equal('category' in filed.writes[0].fields, false, 'a confirm never changes the category');
});

test('decider answers: an HTTP 500 is an outage (TransientError, retried), a 400 is not; neither writes', async () => {
  const b = budget('standard');
  resetConfig(excludeFor(b));
  const fx = fixture('grocery-basic');
  for (const [status, name] of [[500, 'TransientError'], [503, 'TransientError'], [400, 'Error']]) {
    await assert.rejects(runReceipt(fx, b, { answer: () => new Response('down', { status }) }), (e) => e.name === name && e.message.includes(`HTTP ${status}`), `HTTP ${status}`);
    assert.equal(api.updateTransaction.mock.calls.length, 0, `HTTP ${status}: nothing was written`);
  }
});

// ---- 6. thresholds exactly at the bar ----

test('thresholds: confidence exactly CATEGORY_MIN_CONFIDENCE stays; exactly MOVE_MIN_CONFIDENCE with exactly MOVE_MIN_MARGIN moves', async () => {
  const b = budget('standard');
  const HOME = 'Daily Expenses / Household Supplies';
  const GRO = 'Daily Expenses / Groceries';
  // every item: Household 0.75, Groceries 0.5 → margin 0.25 (all exact in binary floating point), exactly the bars below
  const answer = () => reply(HOME, 0.75, { [HOME]: 0.75, [GRO]: 0.5 });
  const at = await check('grocery-basic', b, { moveMinConfidence: 0.75, moveMinMargin: 0.25, categoryMinConfidence: 0.75 }, { answer, charge: { category: 'c-groc' } });
  assert.match(at.out.result, /^categorize/, JSON.stringify(at.out.summary.problems));
  assert.equal(at.writes[0].fields.category, 'c-home');
  // a hair under either bar: stays in Groceries
  for (const s of [{ moveMinConfidence: 0.7500001, moveMinMargin: 0.25 }, { moveMinConfidence: 0.75, moveMinMargin: 0.2500001 }]) {
    const under = await check('grocery-basic', b, s, { answer, charge: { category: 'c-groc' } });
    assert.equal(under.out.result, 'confirm', JSON.stringify(s)); // the items fall back to Groceries: nothing moves, so no review
    assert.ok(under.out.summary.receipt.items.every((i) => i.fellBack), JSON.stringify(s));
  }
  // staying in the store's own category needs CATEGORY_MIN_CONFIDENCE: exactly at it stays a pick, a hair under falls back
  const stay = () => reply(GRO, 0.75, { [GRO]: 0.75, [HOME]: 0.25 });
  const kept = await check('grocery-basic', b, { categoryMinConfidence: 0.75 }, { answer: stay, charge: { category: 'c-groc' } });
  assert.ok(kept.out.summary.receipt.items.every((i) => !i.fellBack && i.confidence === 0.75));
  const fell = await check('grocery-basic', b, { categoryMinConfidence: 0.7500001 }, { answer: stay, charge: { category: 'c-groc' } });
  assert.ok(fell.out.summary.receipt.items.every((i) => i.fellBack));
});

test('thresholds: a 0.6 vs 0.4 answer leads by exactly MOVE_MIN_MARGIN 0.2 and should move', async () => {
  const b = budget('standard');
  const HOME = 'Daily Expenses / Household Supplies';
  const GRO = 'Daily Expenses / Groceries';
  // the defaults in .env.example (MOVE_MIN_CONFIDENCE 0.6, MOVE_MIN_MARGIN 0.2) and a decider that says 0.6 vs 0.4
  const answer = () => reply(HOME, 0.6, { [HOME]: 0.6, [GRO]: 0.4 });
  const { out } = await check('grocery-basic', b, { moveMinConfidence: 0.6, moveMinMargin: 0.2 }, { answer, charge: { category: 'c-groc' } });
  assert.match(out.result, /^categorize/, JSON.stringify(out.summary.problems));
});

// ---- 7. splits: SPLIT_TRANSACTIONS and SPLIT_MIN_AMOUNT ----

test('splits: a mixed receipt splits; with splits off the category stays and the breakdown is noted; tiny parts are merged', async () => {
  const b = budget('standard');
  const on = await check('grocery-basic', b, {}, { charge: { category: 'c-groc' } });
  assert.equal(on.out.result, 'split');
  assert.equal(on.writes[0].fields.subtransactions.length, 3); // groceries, household, pharmacy
  const off = await check('grocery-basic', b, { splits: false }, { charge: { category: 'c-groc' } });
  assert.equal(off.out.result, 'note');
  assert.equal('category' in off.writes[0].fields, false);
  assert.match(off.writes[0].fields.notes, /Groceries \d+\.\d\d, Household Supplies \d+\.\d\d/);
  // the toothpaste (3.29 + tax) is under a $5 split minimum: it joins the current category
  const min = await check('grocery-basic', b, { splitMinCents: 500 }, { charge: { category: 'c-groc' } });
  assert.deepEqual(min.out.summary.plan.parts.map((p) => p.category), ['Daily Expenses / Groceries', 'Daily Expenses / Household Supplies']);
  // splits off on an uncategorized charge: the biggest part's category for the whole charge
  const offU = await check('grocery-basic', b, { splits: false });
  assert.equal(offU.out.result, 'categorize');
  assert.equal(offU.writes[0].fields.category, 'c-groc');
});

test('splits: a 60+ line receipt splits into one part per category, exact to the cent, with long notes cut to 200 characters', async () => {
  const b = budget('large');
  const { out, writes } = await check('grocery-60-items', b, {});
  assert.match(out.result, /^split/);
  const subs = writes[0].fields.subtransactions;
  assert.ok(subs.length >= 5, `${subs.length} parts`);
  assert.ok(subs.every((s) => s.notes.length <= 200), subs.map((s) => s.notes.length).join(','));
});

// ---- 8. UNSURE_ITEMS_USE_STORE_CATEGORY and APPLY_THEN_REVIEW on fees nobody can place ----

test('unsure items: fees go to the store category (on), to Uncategorized (off), or hold the receipt (APPLY_THEN_REVIEW off)', async () => {
  const b = budget('standard');
  const filed = { charge: { category: 'c-groc' } };
  const on = await check('deposits-fees', b, {}, filed);
  assert.match(on.out.result, /\+review$/);
  assert.ok(on.out.summary.receipt.items.filter((i) => /DEPOSIT|CRV|BAG FEE|ENV FEE/.test(i.description)).every((i) => i.fellBack && i.category === 'Daily Expenses / Groceries'));
  const off = await check('deposits-fees', b, { ruleFallback: false }, filed);
  assert.ok(off.out.summary.plan.parts.some((p) => p.category === 'Uncategorized'));
  assert.match(off.out.result, /\+review$/);
  const hold = await check('deposits-fees', b, { ruleFallback: false, applyThenReview: false }, filed);
  assert.equal(hold.out.result, 'review');
  assert.equal(hold.writes.length, 0);
});

// ---- 9. OVERWRITE_CATEGORIZED off ----

test('OVERWRITE_CATEGORIZED off: a confident move of a whole charge goes to review instead; a split still happens', async () => {
  const b = budget('standard');
  const { out, writes } = await check('electronics-big', b, { match: { overwrite: false } }, { charge: { category: 'c-groc' } });
  assert.equal(out.result, 'review');
  assert.equal(writes.length, 0);
  assert.match(out.summary.problems.join('\n'), /your rules filed this under "Daily Expenses \/ Groceries", but the receipt reads as "Fun \/ Entertainment"/);
  const split = await check('grocery-basic', b, { match: { overwrite: false } }, { charge: { category: 'c-groc' } });
  assert.equal(split.out.result, 'split');
});

// ---- 10. dry run ----

test('dry run: never writes, for any reading, budget or charge, and says what it would do', async () => {
  for (const bname of BUDGET_NAMES) {
    for (const name of READING_NAMES) {
      const { out, writes } = await check(name, budget(bname), { dryRun: true }, {}, `${bname}/${name}`);
      assert.equal(writes.length, 0);
      assert.ok(!/^(split|categorize|confirm|note)/.test(out.result), `${bname}/${name}: ${out.result} in a dry run`);
    }
  }
});

// ---- 11. budget shapes ----

test('budget shapes: excluded groups and categories are never used, whatever the decider says', async () => {
  for (const bname of BUDGET_NAMES.filter((n) => n !== 'slashGroup')) { // see the todo test below
    const b = budget(bname);
    // a decider that always wants the first excluded category, else the hidden one
    const banned = b.categories.find((c) => b.exclude.groups.includes(b.groups.find((g) => g.id === c.group_id).name) && !c.is_income);
    const bannedLabel = `${b.groups.find((g) => g.id === banned.group_id).name} / ${banned.name}`;
    const answer = (s, labels) => {
      assert.ok(!labels.includes(bannedLabel), `${bname}: the excluded "${bannedLabel}" was offered to the decider`);
      return reply(bannedLabel, 0.99);
    };
    for (const name of ['grocery-basic', 'one-item-fuel']) await check(name, b, {}, { answer }, `${bname}/${name}`);
  }
});

test('budget shapes: a group whose name contains " / " can be excluded by its full name', async () => {
  const b = budget('slashGroup');
  const offered = new Set();
  const answer = (s, labels) => { labels.forEach((l) => offered.add(l)); return reply(labels.includes('Bills / Utilities / Power') ? 'Bills / Utilities / Power' : labels[0], 0.9); };
  const { out, writes } = await check('grocery-basic', b, {}, { answer });
  assert.deepEqual([...offered].sort(), ['Everyday / Food', 'Everyday / Stuff']);
  assert.ok(!writes.some((w) => w.fields.category === 'u1'), `receipt money was filed under the excluded bill category: ${out.result}`);
  // and a charge already filed under the excluded bill category is never changed
  const filed = await check('grocery-basic', b, {}, { answer, charge: { category: 'u1' } });
  assert.equal(filed.out.result, 'review');
});

test('budget shapes: a category with " / " in its own name, emoji and accents are offered, chosen and written by their id', async () => {
  const b = budget('large');
  const { out, writes } = await check('one-item-fuel', b, {});
  assert.equal(out.result, 'categorize');
  assert.equal(writes[0].fields.category, 'l23'); // Transport / Gas / Fuel
  const eu = await check('eu-vat-included', b, {});
  assert.ok(eu.out.summary.plan.parts.some((p) => p.category === 'Food / 🍎 Groceries'), JSON.stringify(eu.out.summary.plan.parts));
  // an excluded single category (EXCLUDE_CATEGORIES with an emoji-free label) is never a choice
  let offered = [];
  await check('grocery-basic', b, {}, { answer: (s, labels) => { offered = labels; return reply(labels[0], 0.9); } });
  assert.ok(!offered.includes('Fun & Hobbies / Lottery'));
  assert.ok(offered.includes('Food / Coffee ☕') && offered.includes('Transport / Gas / Fuel'));
  assert.equal(offered.length, allowedLabels(eu.labels, b).length);
});

test('budget shapes: a budget whose only spending categories are excluded sends every receipt to review', async () => {
  const b = budget('tiny');
  b.exclude.groups.push('Spending');
  const asked = [];
  const { out, writes } = await check('grocery-basic', b, {}, { answer: (s, labels) => { asked.push(labels.length); return reply(labels[0], 0.9); } });
  assert.equal(out.result, 'review', JSON.stringify(out.summary));
  assert.equal(writes.length, 0);
  assert.ok(asked.every((n) => n === 0)); // (the decider is still asked, with no choices at all)
});

// ---- 12. readings with odd shapes ----

test('readings: a negative-total, a zero-total and an items-only-negative reading go to review without asking anything', async () => {
  const b = budget('standard');
  const mk = (over) => ({ ...readingOf(fixture('grocery-basic')), ...over });
  for (const [what, reading] of Object.entries({
    'negative total': mk({ total: -5 }),
    'zero total': mk({ total: 0, subtotal: 0 }),
    'NaN total': mk({ total: NaN }),
    'return flag only': mk({ is_return: true }),
  })) {
    let asked = 0;
    const { out } = await check('grocery-basic', b, {}, { reading, answer: (s, l) => { asked++; return reply(l[0], 0.9); } }, what);
    assert.equal(out.result, 'review', what);
    assert.equal(asked, 0, what);
  }
});

test('readings: items that add up to nothing (a coupon as big as the purchase) go to review, not into Actual', async () => {
  const b = budget('standard');
  const fx = fixture('grocery-basic');
  const reading = { ...readingOf(fx), items: [{ description: 'MILK', amount: 3.49, taxable: false, tax_code: null }, { description: 'RETURN MILK', amount: -3.49, taxable: false, tax_code: null }] };
  const { out, writes } = await check('grocery-basic', b, {}, { reading });
  assert.equal(out.result, 'review');
  assert.equal(writes.length, 0);
  assert.match(out.summary.problems.join('\n'), /add up to zero or less/);
});

test('readings: an item amount of -0, a description of only spaces and a 0.001 amount keep the invariants', async () => {
  const b = budget('standard');
  const fx = fixture('grocery-basic');
  const r = readingOf(fx);
  r.items.push({ description: 'INFO LINE', amount: -0, taxable: false, tax_code: null }, { description: 'ROUNDING', amount: 0.001, taxable: false, tax_code: null });
  await check('grocery-basic', b, {}, { reading: r });
});

test('readings: a misread total (items short of the subtotal) puts the missing money in the store category or Uncategorized, and reviews', async () => {
  const b = budget('standard');
  const filed = await check('misread-short', b, {}, { charge: { category: 'c-groc' } });
  assert.match(filed.out.result, /\+review$/);
  assert.ok(filed.out.summary.plan.parts.find((p) => p.items.some((t) => /10\.00 not read from the receipt/.test(t))).category === 'Daily Expenses / Groceries');
  const bare = await check('misread-short', b, {});
  assert.ok(bare.out.summary.plan.parts.find((p) => p.items.some((t) => /not read from the receipt/.test(t))).category === 'Uncategorized');
});

test('readings: a receipt in EUR or CAD is matched by its number like any other (the currency is not converted)', async () => {
  const b = budget('standard');
  for (const name of ['eu-vat-included', 'canada-gst-pst', 'canada-hst']) {
    const { out } = await check(name, b, {});
    assert.notEqual(out.result, 'waiting', name);
  }
});

test('readings: cash back is part of the charge; it falls back to the store category, reviewed unless the charge is filed there already', async () => {
  const b = budget('standard');
  const { out } = await check('cash-back', b, {}, { rules: [payeeRule('p-fresh', 'c-groc')] });
  assert.equal(out.result, 'categorize+review');
  const cb = out.summary.receipt.items.find((i) => i.description === 'CASH BACK');
  assert.ok(cb.fellBack, 'the cash back is not something the decider can place');
  // already filed under Groceries: the receipt agrees, so only a note is added and nothing is reviewed (by design)
  const filed = await check('cash-back', b, {}, { charge: { category: 'c-groc' } });
  assert.equal(filed.out.result, 'confirm');
});

// ---- 13. a household's learning and examples change what the decider sees, never the invariants ----

test('HOUSEHOLD_EXAMPLES 0/5/15 and SIMILAR_ITEMS: what the decider is shown', async () => {
  const b = budget('standard');
  const fx = fixture('grocery-basic');
  const past = Array.from({ length: 20 }, (_, i) => ({
    id: `old${i}`, account: 'acct-chk', date: day(-10 - i), amount: -1000, payee: 'p-fresh', notes: 'split by hand', is_parent: true,
    subtransactions: [{ id: `old${i}a`, amount: -600, category: 'c-groc', notes: `WHOLE MILK ${i}, EGGS` }, { id: `old${i}b`, amount: -400, category: 'c-home', notes: `DISH SOAP ${i}` }],
  }));
  for (const [n, similar] of [[0, false], [5, false], [15, true]]) {
    const { seen } = await check('grocery-basic', b, { householdExamples: n, similarItems: similar }, { txns: [chargeFor(fx), ...past] }, `examples ${n}`);
    const st = seen[0].state;
    if (n === 0) assert.equal('items_this_household_filed_before' in st, false);
    else {
      const counts = Object.values(st.items_this_household_filed_before).map((l) => l.length);
      assert.ok(counts.every((c) => c <= n), `${n}: ${counts}`);
      assert.ok(counts.some((c) => c === Math.min(n, 20)), `${n}: ${counts}`);
    }
    assert.equal('similar_items_filed_before' in st, similar);
    assert.ok(st.past_purchases_at_this_store?.length > 0 || Object.keys(st).some((k) => /past/.test(k)), Object.keys(st).join(','));
  }
});

test('LEARNING on / record / off: a live apply returns a snapshot to watch; the lessons are shown to the decider only when on', async () => {
  const b = budget('standard');
  const fx = fixture('grocery-basic');
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const mode of ['on', 'record', 'off']) {
    resetConfig({ ...excludeFor(b), learning: { mode } });
    fs.mkdirSync(config.learning.dir, { recursive: true });
    fs.writeFileSync(path.join(config.learning.dir, 'lessons.json'), JSON.stringify({ lessons: [
      { id: 'aaaaaaaaaaaa', txnId: 'old-1', file: 'old.jpg', date: day(-30), payee: 'FreshFields Market', store: 'FRESHFIELDS MKT #0042', item: 'TOOTHPASTE', plain: null, said: 'Daily Expenses / Household Supplies', saidHow: 'model', filed: 'Daily Expenses / Pharmacy', kind: 'item', group: 1 },
    ] }));
    const run = await runReceipt(fx, b, {});
    checkInvariants(run, b, `learning ${mode}`);
    assert.ok(run.out.snapshot, `${mode}: a live split returns its snapshot`);
    const tooth = run.seen.find((s) => s.state.item === 'TOOTHPASTE').state;
    assert.equal('household_corrected_the_pipeline' in tooth, mode === 'on', mode);
  }
});

// ---- 14. property loop: random receipts, random charges, random settings ----

/** A small deterministic random generator, so a failure can be reproduced from its seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test('property: 400 random receipts (random items, coupons, fees, tax codes, tips, settings, answers) keep every invariant', async () => {
  const KINDS = ['grocery', 'household', 'health', 'clothing', 'kids', 'restaurant', 'pet', 'alcohol', 'electronics', 'gift', null];
  const WORDS = { grocery: ['MILK', 'BREAD', 'RICE', 'APPLES'], household: ['SOAP', 'FOIL', 'BLEACH'], health: ['ASPIRIN', 'BANDAGES'], clothing: ['SOCKS', 'TEE'], kids: ['TOY CAR', 'CRAYONS'], restaurant: ['BURGER', 'SALAD'], pet: ['KIBBLE'], alcohol: ['LAGER'], electronics: ['CABLE'], gift: ['GIFT BAG'], null: ['BAG FEE', 'DEPOSIT', 'SVC FEE'] };
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const bname = pick(BUDGET_NAMES);
    const b = budget(bname);
    const n = 1 + Math.floor(r() ** 2 * 40);
    const items = [];
    for (let i = 0; i < n; i++) {
      const kind = pick(KINDS);
      const roll = r();
      const amount = roll < 0.05 ? 0 : roll < 0.1 ? 0.01 : Math.round((0.1 + r() ** 3 * 300) * 100) / 100;
      const code = pick(['T', 'E', 'A', 'F', null]);
      items.push({ description: `${pick(WORDS[kind])} ${i}`, amount, taxable: code === null ? pick([null, false]) : true, tax_code: code, kind });
      if (r() < 0.1) items.push({ description: pick(['COUPON', 'INSTANT SAVINGS', 'TPD/1234567', '5% OFF', 'RETURN ITEM', 'GIFT CARD REDEEM']), amount: -Math.round(r() * 1000) / 100, taxable: null, tax_code: null, kind: null });
    }
    const itemsC = items.reduce((a, it) => a + Math.round(it.amount * 100), 0);
    const tax = r() < 0.3 ? null : Math.round(Math.max(0, itemsC) * r() * 0.15) / 100;
    const tip = r() < 0.15 ? Math.round(r() * 2000) / 100 : null;
    const subtotal = r() < 0.2 ? null : (itemsC + (r() < 0.1 ? Math.round(r() * 2000) : 0)) / 100;
    const total = Math.round(((subtotal ?? itemsC / 100) * 100 + (tax ?? 0) * 100 + (tip ?? 0) * 100)) / 100;
    const fx = {
      name: `random-${seed}`, payee: 'p-fresh', importedPayee: 'FRESHFIELDS MKT #0042', daysAgo: r() < 0.1 ? null : 1 + Math.floor(r() * 5), chargeCents: null,
      reading: { merchant: 'FreshFields Market', store_clues: [], date: null, date_as_printed: null, currency: 'USD', subtotal, tax, tip, total, payment_method: 'card', cash_tendered: null, card_last4: null, is_return: false, tax_lines: r() < 0.3 ? [{ code: 'T', rate: 7, amount: tax ?? 0 }, ...(r() < 0.5 ? [{ code: 'E', rate: 2, amount: 0.01 }] : [])] : null, items },
    };
    if (fx.daysAgo != null) {
      fx.reading.date = day(-fx.daysAgo);
      fx.reading.date_as_printed = fx.reading.date;
    }
    const extra = r() < 0.2 ? Math.round(Math.abs(total) * 100 * r() * 0.2) : 0;
    const settings = {
      ...excludeFor(b), splits: r() > 0.1, splitMinCents: pick([0, 100, 500]), ruleFallback: r() > 0.3, applyThenReview: r() > 0.3, receiptCheck: r() > 0.5,
      taxByItem: r() > 0.3, match: { tolerancePercent: extra ? 25 : 0, overwrite: r() > 0.2 }, moveMinConfidence: pick([0.5, 0.6, 0.9]), moveMinMargin: pick([0, 0.2, 0.5]),
      categoryMinConfidence: pick([0.3, 0.5, 0.8]), dryRun: r() < 0.2,
    };
    const answer = pick([oracle, oracle, oracle, ANSWERS['everything unsure'], ANSWERS['invalid label'], ANSWERS['no probabilities'], ANSWERS['a 50/50 tie'], ANSWERS['whole-receipt answer conflicts with every item']]);
    const labelsAll = b.categories.filter((c) => !c.is_income).map((c) => c.id);
    const current = r() < 0.5 ? null : pick(labelsAll);
    if (Math.round(total * 100) <= 0) continue;
    resetConfig(settings);
    let run;
    try {
      run = await runReceipt(fx, b, { charge: { amount: -(Math.round(total * 100) + extra), category: current, cleared: r() > 0.1 }, answer, handleOpts: { replay: r() < 0.2 } });
    } catch (err) {
      assert.fail(`seed ${seed} (${bname}, ${items.length} items): threw ${err.stack}`);
    }
    checkInvariants(run, b, `seed ${seed} (${bname}, ${items.length} items, settings ${JSON.stringify({ ...settings, excludeGroups: undefined, excludeCategories: undefined })})`);
  }
});

test('dates: future, two-year-old, day-first, written-out and garbage dates keep the invariants (an implausible date is treated as none)', async () => {
  const b = budget('standard');
  const iso = day(-2);
  const [y, m, d] = iso.split('-');
  const printed = {
    future: day(30), 'two years old': day(-730), 'day first': `${d}/${m}/${y.slice(2)}`, 'written out': new Date(`${iso}T12:00:00Z`).toUTCString().slice(5, 16),
    garbage: 'TRANS# 0042 REG 3', empty: '', 'only a time': '12:34 PM', 'ISO with time': `${iso}T09:15:00`,
  };
  for (const [what, text] of Object.entries(printed)) {
    const reading = { ...readingOf(fixture('grocery-basic')), date_as_printed: text, date: null };
    const { out } = await check('grocery-basic', b, {}, { reading, txn: { ...chargeFor(fixture('grocery-basic')), date: day(-2) } }, `date ${what}`);
    if (['future', 'two years old', 'garbage', 'empty', 'only a time'].includes(what)) {
      assert.equal(out.summary.receipt.date, null, what);
      assert.equal(out.result, 'split+review', what); // matched by amount and payee in the recent days, then reviewed
      assert.match(out.summary.problems.join('\n'), /no readable date, so the charge was matched by amount and payee only/, what);
    }
  }
});
