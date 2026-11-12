// reconcile.js: splitting a charge over categories (allocate), discount folding, small-part merging, cash totals and note cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { explainTax, allocate, foldDiscounts, flipNumberRefs, fixTaxGap, gapSummary, gapSplitDoubt, mergeSmallParts, fixCashTotal, paidCash, stripAnnotations, UNCATEGORIZED } from '../src/reconcile.js';

const ids = new Map([['A / One', 'a'], ['B / Two', 'b'], ['C / Three', 'c']]);
const item = (description, amount, category, extra = {}) => ({ description, amount, category, ...extra });
const sum = (allocation) => allocation.reduce((n, a) => n + a.cents, 0);
const part = (label, cents, categoryId = ids.get(label) ?? null, items = [`${label} item`]) => ({ label, categoryId, cents, items });

test('allocate: parts add up exactly to the bank amount, with tax spread by share', () => {
  const receipt = { subtotal: 30, tax: 2.4, total: 32.4, items: [item('x', 10, 'A / One'), item('y', 20, 'B / Two')] };
  const { allocation, problems } = allocate(receipt, ids, 3240);
  assert.deepEqual(problems, []);
  assert.equal(sum(allocation), 3240);
  assert.deepEqual(allocation.map((a) => [a.label, a.cents, a.categoryId]), [['B / Two', 2160, 'b'], ['A / One', 1080, 'a']]);
});

test('allocate: tip and rounding leave no stray cents', () => {
  const receipt = { subtotal: 10, tax: 0, total: 10, items: [item('x', 3.33, 'A / One'), item('y', 3.33, 'B / Two'), item('z', 3.34, 'C / Three')] };
  const { allocation } = allocate(receipt, ids, 1234); // the bank charged 2.34 more (a tip)
  assert.equal(sum(allocation), 1234);
  assert.equal(allocation.length, 3);
});

test('allocate: items of one category are grouped and listed', () => {
  const receipt = { subtotal: 6, total: 6, items: [item('milk', 2, 'A / One'), item('eggs', 4, 'A / One', { plain: 'large eggs' })] };
  const { allocation } = allocate(receipt, ids, 600);
  assert.equal(allocation.length, 1);
  assert.deepEqual(allocation[0].items, ['milk', 'eggs (large eggs)']);
});

test('allocate: a plain name equal to the description is not repeated; an unsure guess is appended', () => {
  const receipt = { subtotal: 5, total: 5, items: [item('Milk', 2, 'A / One', { plain: 'milk' }), item('Thing', 3, UNCATEGORIZED, { unsureGuess: 'Two 34%' })] };
  const { allocation } = allocate(receipt, ids, 500);
  assert.deepEqual(allocation.find((a) => a.label === 'A / One').items, ['Milk']);
  assert.deepEqual(allocation.find((a) => a.label === UNCATEGORIZED).items, ['Thing (maybe Two 34%)']);
});

test('allocate: an item with no category goes to Uncategorized with no category id', () => {
  const receipt = { subtotal: 5, total: 5, items: [item('x', 2, 'A / One'), item('y', 3, null)] };
  const { allocation } = allocate(receipt, ids, 500);
  const un = allocation.find((a) => a.label === UNCATEGORIZED);
  assert.equal(un.categoryId, null);
  assert.equal(un.cents, 300);
});

test('allocate: a label missing from the id map gets a null category id', () => {
  const receipt = { subtotal: 5, total: 5, items: [item('x', 5, 'Hidden / Thing')] };
  assert.equal(allocate(receipt, ids, 500).allocation[0].categoryId, null);
});

test('allocate: a subtotal bigger than the items adds a gap part with gapLabel', () => {
  const receipt = { subtotal: 20, total: 20, items: [item('x', 15, 'A / One')] };
  const { allocation, problems } = allocate(receipt, ids, 2000, { gapLabel: 'B / Two' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /add up to 15\.00 but the printed subtotal is 20\.00/);
  assert.deepEqual(allocation.map((a) => [a.label, a.cents]), [['A / One', 1500], ['B / Two', 500]]);
  assert.equal(allocation[1].categoryId, 'b');
  assert.deepEqual(allocation[1].items, ['5.00 not read from the receipt']);
});

test('allocate: the gap goes to Uncategorized by default', () => {
  const receipt = { subtotal: 20, total: 20, items: [item('x', 15, 'A / One')] };
  const { allocation } = allocate(receipt, ids, 2000);
  assert.deepEqual(allocation.map((a) => [a.label, a.categoryId]), [['A / One', 'a'], [UNCATEGORIZED, null]]);
});

test('allocate: items over the subtotal are a problem but add no gap part', () => {
  const receipt = { subtotal: 10, total: 10, items: [item('x', 15, 'A / One')] };
  const { allocation, problems } = allocate(receipt, ids, 1000);
  assert.equal(problems.length, 1);
  assert.equal(allocation.length, 1);
});

test('allocate: without a subtotal, items far from the total are a problem', () => {
  const near = allocate({ subtotal: null, total: 10, items: [item('x', 9, 'A / One')] }, ids, 1000);
  assert.deepEqual(near.problems, []);
  const far = allocate({ subtotal: null, total: 10, items: [item('x', 5, 'A / One')] }, ids, 1000);
  assert.match(far.problems[0], /far from the printed total/);
});

test('allocate: a negative-net category becomes a credit part plus a problem', () => {
  const receipt = { subtotal: 10, total: 10, items: [item('x', 14, 'A / One'), item('return', -4, 'B / Two')] };
  const { allocation, problems } = allocate(receipt, ids, 1000);
  assert.equal(sum(allocation), 1000);
  assert.equal(allocation.find((a) => a.label === 'B / Two').cents < 0, true);
  assert.equal(problems.some((p) => /includes a credit of .* in "B \/ Two"/.test(p)), true);
});

test('allocate: items summing to zero or less return null', () => {
  const r = allocate({ subtotal: null, total: 0, items: [item('x', 5, 'A / One'), item('y', -5, 'A / One')] }, ids, 0);
  assert.equal(r.allocation, null);
  assert.deepEqual(r.problems, ['line items add up to zero or less']);
});

test('allocate: a category that nets to zero (an item and its own refund) is dropped', () => {
  const receipt = { subtotal: 5, total: 5, items: [item('x', 5, 'A / One'), item('y', 3, 'B / Two'), item('refund', -3, 'B / Two')] };
  assert.deepEqual(allocate(receipt, ids, 500).allocation.map((a) => a.label), ['A / One']);
});

// NOTE: allocate's 'returns and coupons cancel out the purchases' branch can't be reached: it needs the nets to sum
// to zero or less, but itemsSum (which equals that sum, plus any gap part) was already checked to be positive.

test('mergeSmallParts: a small part folds into the preferred category', () => {
  const merged = mergeSmallParts([part('A / One', 5000), part('B / Two', 3000), part('C / Three', 50)], 100, 'b');
  assert.deepEqual(merged.map((a) => [a.label, a.cents]), [['A / One', 5000], ['B / Two', 3050]]);
});

test('mergeSmallParts: without a preferred category it folds into the largest', () => {
  const merged = mergeSmallParts([part('A / One', 5000), part('B / Two', 3000), part('C / Three', 50)], 100, 'zzz');
  assert.deepEqual(merged.map((a) => [a.label, a.cents]), [['A / One', 5050], ['B / Two', 3000]]);
});

test('mergeSmallParts: credit parts and the Uncategorized part are never merged', () => {
  const parts = [part('A / One', 5000), part('B / Two', -50), part(UNCATEGORIZED, 20, null)];
  const merged = mergeSmallParts(parts, 100, null);
  assert.equal(merged.length, 3);
  assert.equal(sum(merged), 4970);
});

test('mergeSmallParts: tiny categorized parts fold into Uncategorized when nothing categorized is big enough', () => {
  const merged = mergeSmallParts([part('A / One', 50), part('B / Two', 40), part(UNCATEGORIZED, 5000, null)], 100, null);
  assert.deepEqual(merged.map((a) => [a.label, a.cents]), [[UNCATEGORIZED, 5090]]);
  // a categorized item's name is kept in brackets so the note still says where it came from
  assert.deepEqual(merged[0].items, ['Uncategorized item', 'A / One item (One)', 'B / Two item (Two)']);
});

test('mergeSmallParts: a single part, or no small part, comes back unchanged', () => {
  const one = [part('A / One', 5)];
  assert.equal(mergeSmallParts(one, 100, null), one);
  const big = [part('A / One', 500), part('B / Two', 300)];
  assert.deepEqual(mergeSmallParts(big, 100, null).map((a) => a.cents), [500, 300]);
});

test('mergeSmallParts: annotations follow the money', () => {
  const unsure = { ...part(UNCATEGORIZED, 4000, null), items: ['4.00 not read from the receipt'] };
  // into Uncategorized: unsure notes stay as they are
  const small = { ...part('A / One', 30), items: ['gum (maybe Two 40%)', '3.00 not read from the receipt'] };
  const into = mergeSmallParts([unsure, small], 100, null);
  assert.deepEqual(into[0].items, ['4.00 not read from the receipt', 'gum (maybe Two 40%) (One)', '3.00 not read from the receipt']);
  // into a categorized part: guesses and "not read" notes are dropped
  const big = { ...part('B / Two', 5000), items: ['pasta'] };
  const small2 = { ...part('C / Three', 30), items: ['gum (maybe Two 40%)', '3.00 not read from the receipt'] };
  const into2 = mergeSmallParts([big, small2], 100, null);
  assert.deepEqual(into2[0].items, ['pasta', 'gum']);
});

test('paidCash: cash back is not cash', () => {
  assert.equal(paidCash({ payment_method: 'cash' }), true);
  assert.equal(paidCash({ payment_method: 'Cash' }), true);
  assert.equal(paidCash({ payment_method: 'debit with cash back' }), false);
  assert.equal(paidCash({ payment_method: 'card' }), false);
  assert.equal(paidCash({}), false);
});

test('fixCashTotal: a cash receipt whose total is the cash handed over is recomputed', () => {
  const r = { subtotal: 13.5, tax: 1.03, tip: 0, total: 15, cash_tendered: 15, payment_method: 'cash' };
  const note = fixCashTotal(r);
  assert.equal(r.total, 14.53);
  assert.match(note, /total read as 15\.00, which looks like the cash handed over; using subtotal \+ tax = 14\.53/);
});

test('fixCashTotal: a card receipt is left alone', () => {
  const r = { subtotal: 13.5, tax: 1.03, total: 15, cash_tendered: 15, payment_method: 'card' };
  assert.equal(fixCashTotal(r), null);
  assert.equal(r.total, 15);
});

test('fixCashTotal: a consistent total, or missing subtotal/tax, is left alone', () => {
  assert.equal(fixCashTotal({ subtotal: 10, tax: 1, total: 11, payment_method: 'cash' }), null);
  assert.equal(fixCashTotal({ subtotal: 10, tax: 1.005, total: 11, payment_method: 'cash' }), null); // within a cent
  assert.equal(fixCashTotal({ subtotal: null, tax: 1, total: 20, payment_method: 'cash' }), null);
});

test('fixCashTotal: a cash total that is neither the tendered amount nor above the computed one is left alone', () => {
  const r = { subtotal: 10, tax: 1, total: 9, cash_tendered: 20, payment_method: 'cash' };
  assert.equal(fixCashTotal(r), null);
  assert.equal(r.total, 9);
});

test('fixCashTotal: the tip counts toward the computed total', () => {
  const r = { subtotal: 10, tax: 1, tip: 2, total: 20, cash_tendered: 20, payment_method: 'cash' };
  fixCashTotal(r);
  assert.equal(r.total, 13);
});

test('stripAnnotations: keeps items, drops guesses and "not read" notes', () => {
  assert.equal(stripAnnotations("MED-DVD'S (maybe Child 34%), gum"), "MED-DVD'S, gum");
  assert.equal(stripAnnotations('milk, 4.12 not read from the receipt'), 'milk');
  assert.equal(stripAnnotations('4.12 not read from the receipt'), null);
  assert.equal(stripAnnotations(null), null);
  assert.equal(stripAnnotations(''), null);
});

test('stripAnnotations: a "(maybe " note cut off at 200 characters is removed too', () => {
  assert.equal(stripAnnotations('gum, MED-DVD (maybe Child 3'), 'gum, MED-DVD');
});

test('stripAnnotations: keyword tags', () => {
  assert.equal(stripAnnotations('Gold Bond #always'), 'Gold Bond');
  assert.equal(stripAnnotations('A #always; B #usually'), 'A; B');
});

// ---- foldDiscounts ----

const line = (description, amount) => ({ description, amount });
const receiptWith = (...items) => ({ items });

test('foldDiscounts: a discount joins the nearest earlier item and the items still add up', () => {
  const r = receiptWith(line('MILK', 5), line('EGGS', 4), line('INSTANT SAVINGS', -1.5));
  assert.deepEqual(foldDiscounts(r), [{ line: 'INSTANT SAVINGS', into: 'EGGS', cents: 150 }]);
  assert.deepEqual(r.items.map((i) => [i.description, i.amount, i.discountCents]), [['MILK', 5, undefined], ['EGGS', 2.5, 150]]);
});

test('foldDiscounts: an item number on the discount line picks its item, even when another item is nearer', () => {
  const r = receiptWith(line('1234567 CEREAL', 6), line('JUICE', 3), line('TPD/1234567', -3));
  foldDiscounts(r);
  assert.deepEqual(r.items.map((i) => [i.description, i.amount]), [['1234567 CEREAL', 3], ['JUICE', 3]]);
  // a number that no item holds: the line is left alone, not given to the nearest item
  const r2 = receiptWith(line('CEREAL', 6), line('JUICE', 3), line('TPD/9999999', -1));
  assert.deepEqual(foldDiscounts(r2), []);
  assert.deepEqual(r2.items.map((i) => i.amount), [6, 3, -1]);
  // the item can come after its discount line
  const r3 = receiptWith(line('CEREAL', 6), line('TPD/7654321', -2), line('7654321 JUICE', 3));
  foldDiscounts(r3);
  assert.deepEqual(r3.items.map((i) => [i.description, i.amount]), [['CEREAL', 6], ['7654321 JUICE', 1]]);
});

test('foldDiscounts: two discounts on one item add up', () => {
  const r = receiptWith(line('CEREAL', 6), line('COUPON', -1), line('STORE COUPON', -0.5));
  foldDiscounts(r);
  assert.deepEqual([r.items.length, r.items[0].amount, r.items[0].discountCents], [1, 4.5, 150]);
});

test('foldDiscounts: no target leaves the line: nothing before it, a discount as big as the item, a return', () => {
  const first = receiptWith(line('STORE COUPON', -2), line('MILK', 5));
  assert.deepEqual(foldDiscounts(first), []);
  assert.deepEqual(first.items.map((i) => i.amount), [-2, 5]);
  const big = receiptWith(line('MILK', 2), line('COUPON', -3), line('EGGS', 3), line('COUPON', -3));
  assert.deepEqual(foldDiscounts(big), []);
  assert.equal(big.items.length, 4);
  const ret = receiptWith(line('MILK', 5), line('RETURN SHIRT', -4));
  assert.deepEqual(foldDiscounts(ret), []);
  const returnReceipt = { is_return: true, items: [line('SHIRT', 10), line('FEE', -1)] };
  assert.deepEqual(foldDiscounts(returnReceipt), []);
});

test('foldDiscounts: the split is the same total, with the discount in the discounted item\'s category', () => {
  const make = () => receiptWith(line('MILK', 5), line('GUM', 4), line('INSTANT SAVINGS', -3));
  const before = make();
  before.items[0].category = 'A / One'; before.items[1].category = 'B / Two'; before.items[2].category = 'C / Three';
  const folded = make();
  foldDiscounts(folded);
  folded.items[0].category = 'A / One'; folded.items[1].category = 'B / Two';
  const loose = allocate({ subtotal: 6, total: 6, items: before.items }, ids, 600);
  const tight = allocate({ subtotal: 6, total: 6, items: folded.items }, ids, 600);
  assert.equal(sum(loose.allocation), 600);
  assert.equal(sum(tight.allocation), 600);
  // folded into GUM (nearest), the credit no longer sits in its own category: no credit problem, parts are positive
  assert.deepEqual(tight.problems, []);
  assert.deepEqual(tight.allocation.map((a) => [a.label, a.cents]), [['A / One', 500], ['B / Two', 100]]);
  assert.deepEqual(tight.allocation.map((a) => a.items), [['MILK'], ['GUM (pipeline: after 3.00 off)']]);
  assert.ok(loose.problems.length > 0); // before: "includes a credit"
});

test('stripAnnotations removes the discount note so it is never learned as an item', () => {
  assert.equal(stripAnnotations('MILK (pipeline: after 3.00 off), EGGS'), 'MILK, EGGS');
  assert.equal(stripAnnotations('MILK (pipeline: after 3.00 off) (maybe Child 34%)'), 'MILK');
});

test('foldDiscounts: only lines that read as discounts, or have an item number that matches, are folded', () => {
  const r = receiptWith(line('MILK', 5), line('MENS SHIRT', -19.99), line('GIFT CARD', -20), line('10% OFF', -0.5), line('MFR COUPON', -0.25), line('PROMO', -0.1), line('SAVE', -0.1));
  const f = foldDiscounts(r);
  assert.deepEqual(f.map((x) => x.line), ['10% OFF', 'MFR COUPON', 'PROMO', 'SAVE']);
  assert.deepEqual(r.items.map((i) => i.description), ['MILK', 'MENS SHIRT', 'GIFT CARD']);
  assert.equal(r.items[0].amount, 4.05);
  // a matching item number folds without any discount word
  const n = receiptWith(line('1234567 CEREAL', 6), line('ADJ 1234567', -1));
  assert.equal(foldDiscounts(n).length, 1);
});

test('the discount note is stripped even when cut off or written with a $, but a household\'s own "(after 5 off)" stays', () => {
  assert.equal(stripAnnotations('MILK (pipeline: after $3.00 off), EGGS'), 'MILK, EGGS');
  assert.equal(stripAnnotations('MILK (pipeline: after 3.0'), 'MILK');
  assert.equal(stripAnnotations('MILK (after 5 off)'), 'MILK (after 5 off)');
});

// ---- tax over the taxed items only (TAX_BY_ITEM) ----

const taxed = (description, amount, category, taxable) => item(description, amount, category, taxable === undefined ? {} : { taxable });
const byLabel = (allocation) => Object.fromEntries(allocation.map((a) => [a.label, a.cents]));

test('allocate with tax flags: tax goes to the taxed items\' category only, not to untaxed groceries', async () => {
  const { config } = await import('../src/config.js');
  const receipt = { subtotal: 30, tax: 0.8, total: 30.8, items: [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)] };
  config.taxByItem = true;
  const r = allocate(receipt, ids, 3080);
  assert.deepEqual(byLabel(r.allocation), { 'A / One': 2000, 'B / Two': 1080 });
  assert.equal(r.taxByItem, true);
  assert.equal(sum(r.allocation), 3080);
  config.taxByItem = false; // the old way: in proportion to the amounts
  const p = allocate(receipt, ids, 3080);
  assert.deepEqual(byLabel(p.allocation), { 'A / One': 2053, 'B / Two': 1027 });
  assert.equal(p.taxByItem, false);
  config.taxByItem = true;
});

test('allocate with tax flags: tip and rounding stay proportional, and the parts still add up exactly', () => {
  const receipt = { subtotal: 30, tax: 0.8, total: 30.8, items: [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)] };
  const { allocation } = allocate(receipt, ids, 3080 + 300); // a $3.00 tip on the bank charge
  assert.deepEqual(byLabel(allocation), { 'A / One': 2200, 'B / Two': 1180 }); // 3.00 tip 2:1, plus all 0.80 tax on the sponges
  assert.equal(sum(allocation), 3380);
  const odd = { subtotal: 10, tax: 0.33, total: 10.33, items: [taxed('a', 3.33, 'A / One', true), taxed('b', 3.33, 'B / Two', true), taxed('c', 3.34, 'C / Three', false)] };
  assert.equal(sum(allocate(odd, ids, 1033 + 1).allocation), 1034);
});

test('allocate with tax flags: anything doubtful falls back to proportional, as before', () => {
  const base = { subtotal: 30, tax: 0.8, total: 30.8 };
  const wholly = (items, over = {}) => byLabel(allocate({ ...base, ...over, items }, ids, 3080).allocation);
  const proportional = { 'A / One': 2053, 'B / Two': 1027 };
  // a line the reader could not tell (null), or flags from a reading saved before they existed (no field at all)
  assert.deepEqual(wholly([taxed('MILK', 20, 'A / One', null), taxed('SPONGES', 10, 'B / Two', true)]), proportional);
  assert.deepEqual(wholly([taxed('MILK', 20, 'A / One'), taxed('SPONGES', 10, 'B / Two')]), proportional);
  // nothing taxed, or no tax printed
  assert.deepEqual(wholly([taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', false)]), proportional);
  assert.deepEqual(wholly([taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)], { tax: null }), proportional);
  // a rate that cannot be right: $0.80 on a $2.00 taxed item is 40%, so the flags (or the tax) were misread
  const implausible = allocate({ ...base, items: [taxed('MILK', 28, 'A / One', false), taxed('GUM', 2, 'B / Two', true)] }, ids, 3080);
  assert.equal(implausible.taxByItem, false);
  assert.deepEqual(byLabel(implausible.allocation), { 'A / One': 2875, 'B / Two': 205 }); // in proportion to 28 : 2
  // the items don't add up to the subtotal: money is missing, so the tax can't be pinned on items
  assert.equal(allocate({ ...base, subtotal: 40, items: [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)] }, ids, 4080).taxByItem, false);
});

test('allocate with tax flags: tax on taxed items in two categories is shared between them by their taxed amounts', () => {
  const receipt = { subtotal: 40, tax: 1.5, total: 41.5, items: [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true), taxed('SOAP', 10, 'C / Three', true)] };
  const { allocation } = allocate(receipt, ids, 4150);
  assert.deepEqual(byLabel(allocation), { 'A / One': 2000, 'B / Two': 1075, 'C / Three': 1075 });
});

test('allocate with tax flags: the receipt must add up (subtotal present, items = subtotal, subtotal + tax + tip = total), else proportional', () => {
  const items = () => [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)];
  const by = (receipt) => allocate({ items: items(), ...receipt }, ids, 3080).taxByItem;
  assert.equal(by({ subtotal: 30, tax: 0.8, total: 30.8 }), true);
  assert.equal(by({ subtotal: null, tax: 0.8, total: 30.8 }), false, 'no printed subtotal');
  assert.equal(by({ tax: 0.8, total: 30.8 }), false);
  assert.equal(by({ subtotal: 30.02, tax: 0.8, total: 30.82 }), true, '2 cents off is rounding');
  assert.equal(by({ subtotal: 30.03, tax: 0.8, total: 30.83 }), false, '3 cents off is a misread item');
  assert.equal(by({ subtotal: 30, tax: 0.8, total: 30.82 }), false, 'subtotal + tax is not the total');
  assert.equal(by({ subtotal: 30, tax: 0.8, tip: 2, total: 32.8 }), true, 'a printed tip counts');
  assert.equal(by({ subtotal: 30, tax: 0.8, tip: null, total: 31.8 }), false);
});

test('allocate with tax flags: the highest believable rate is TAX_BY_ITEM_MAX_RATE (12%), and two tax codes on the taxed items mean two rates', async () => {
  const { config } = await import('../src/config.js');
  const rate = (pct) => ({ subtotal: 30, tax: Number((10 * pct).toFixed(2)), total: Number((30 + 10 * pct).toFixed(2)), items: [taxed('MILK', 20, 'A / One', false), taxed('SPONGES', 10, 'B / Two', true)] });
  const target = (r) => Math.round(r.total * 100);
  assert.equal(allocate(rate(0.12), ids, target(rate(0.12))).taxByItem, true);
  assert.equal(allocate(rate(0.13), ids, target(rate(0.13))).taxByItem, false);
  config.taxByItemMaxRate = 0.15;
  try {
    assert.equal(allocate(rate(0.13), ids, target(rate(0.13))).taxByItem, true);
  } finally {
    config.taxByItemMaxRate = 0.12;
  }
  const two = { subtotal: 30, tax: 1, total: 31, items: [taxed('MILK', 20, 'A / One', false), item('SPONGES', 5, 'B / Two', { taxable: true, tax_code: 'A' }), item('SOAP', 5, 'B / Two', { taxable: true, tax_code: 'B' })] };
  assert.equal(allocate(two, ids, 3100).taxByItem, false);
  two.items[2].tax_code = 'A';
  assert.equal(allocate(two, ids, 3100).taxByItem, true);
});

// ---- tax by rate (tax_lines) ----

const rateReceipt = (lines, over = {}) => ({
  subtotal: 96.83, tax: 7.65, total: 104.48, tax_lines: lines,
  items: [
    item('MILK', 45.85, 'A / One', { taxable: false, tax_code: 'E' }), // Costco E: reads "not taxed" but has a tax line
    item('SPONGES', 30.98, 'B / Two', { taxable: true, tax_code: 'A' }),
    item('SOAP', 20, 'A / One', { taxable: true, tax_code: 'A' }),
  ], ...over,
});
const goodLines = [{ code: 'A', rate: 8.6, amount: 4.39 }, { code: 'E', rate: 7.1, amount: 3.26 }];
const proportional = (r, target) => { const x = allocate(r, ids, target); assert.equal(x.taxByItem, false); assert.equal(sum(x.allocation), target); };

test('allocate with tax_lines: each rate is spread over the items with its code, exact cents (E marked not taxed too)', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const r = allocate(rateReceipt(goodLines), ids, 10448);
  assert.equal(r.taxByItem, true);
  assert.equal(sum(r.allocation), 10448);
  // E tax 3.26 all to A / One; A tax 4.39 split 30.98:20 -> 2.67 B, 1.72 A.
  assert.deepEqual(byLabel(r.allocation), { 'A / One': 4585 + 2000 + 326 + 172, 'B / Two': 3098 + 267 });
  assert.deepEqual(r.taxByRate.map((l) => l.code), ['A', 'E']);
  // the same with E flagged taxed gives the same split
  const flagged = rateReceipt(goodLines); flagged.items[0].taxable = true;
  assert.deepEqual(byLabel(allocate(flagged, ids, 10448).allocation), byLabel(r.allocation));
  // lines one cent off the tax still work
  assert.equal(allocate(rateReceipt([{ code: 'A', amount: 4.4 }, { code: 'E', amount: 3.26 }]), ids, 10448).taxByItem, true);
  // null taxable on an item whose code has a line is fine
  const unk = rateReceipt(goodLines); unk.items[1].taxable = null;
  assert.equal(allocate(unk, ids, 10448).taxByItem, true);
});

test('allocate with tax_lines: food-only Costco (only E items, E line) spreads over them', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const r = { subtotal: 20, tax: 0.7, total: 20.7, tax_lines: [{ code: 'E', amount: 0.7 }], items: [item('A', 12, 'A / One', { taxable: false, tax_code: 'E' }), item('B', 8, 'B / Two', { taxable: false, tax_code: 'E' })] };
  const x = allocate(r, ids, 2070);
  assert.equal(x.taxByItem, true);
  assert.deepEqual(byLabel(x.allocation), { 'A / One': 1242, 'B / Two': 828 });
});

test('allocate with tax_lines: anything that does not fit falls back to proportional', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  proportional(rateReceipt([{ code: 'A', amount: 4.39 }, { code: 'E', amount: 2 }]), 10448); // lines do not sum to the tax
  proportional(rateReceipt([{ code: 'A', amount: 4.39 }, { code: 'E', amount: 1.63 }, { code: 'Z', amount: 1.63 }]), 10448); // line code with no items
  proportional(rateReceipt([{ code: 'A', amount: 7.0 }, { code: 'E', amount: 0.65 }]), 10448); // rate over the cap
  proportional(rateReceipt([{ code: null, amount: 4.39 }, { code: 'E', amount: 3.26 }]), 10448); // two rates, a line without a code
  proportional(rateReceipt([{ code: 'A', amount: 7.65 }]), 10448); // two codes on the items but one line
  proportional(rateReceipt(null), 10448); // two codes, no lines
  const noLine = rateReceipt(goodLines); noLine.items.push(item('X', 0, 'A / One', { taxable: true, tax_code: 'Q' })); // zero-priced: ignored
  assert.equal(allocate(noLine, ids, 10448).taxByItem, true);
  const q = rateReceipt(goodLines); q.items[2].tax_code = 'Q'; // a code with no line is untaxed: A's tax lands on one item, over the cap
  proportional(q, 10448);
  proportional({ ...rateReceipt([{ code: 'Q', amount: 0.8 }, { code: 'R', amount: 6.85 }]) }, 10448); // lines whose codes no item carries
});

test('allocate with tax_lines: the printed rate must fit the items (codes on the wrong items fall back); a fraction or 0.5% works', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  proportional(rateReceipt([{ code: 'A', rate: 5, amount: 4.39 }, { code: 'E', rate: 7.1, amount: 3.26 }]), 10448);
  assert.equal(allocate(rateReceipt([{ code: 'A', rate: 0.086, amount: 4.39 }, { code: 'E', rate: 0.071, amount: 3.26 }]), ids, 10448).taxByItem, true);
  // a real 0.5% rate is read as percent
  const r = { subtotal: 100, tax: 0.45, total: 100.45, tax_lines: [{ code: 'A', rate: 0.5, amount: 0.45 }, { code: 'E', rate: 0, amount: 0 }], items: [item('A', 90, 'A / One', { taxable: true, tax_code: 'A' }), item('B', 10, 'B / Two', { taxable: false, tax_code: 'E' })] };
  assert.equal(allocate(r, ids, 10045).taxByItem, true);
});

test('allocate with tax_lines: lines never make a single-code receipt worse than no lines', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const base = (tc = 'T') => ({ subtotal: 30, tax: 0.8, total: 30.8, items: [item('MILK', 20, 'A / One', { taxable: false, tax_code: null }), item('SPONGES', 10, 'B / Two', { taxable: true, tax_code: tc })] });
  const none = byLabel(allocate(base(), ids, 3080).allocation);
  assert.deepEqual(none, { 'A / One': 2000, 'B / Two': 1080 });
  for (const lines of [
    [{ code: 'T', amount: 0.8 }], [{ code: 'T', amount: 0.6 }, { code: 'T', amount: 0.2 }], [{ code: null, amount: 0.6 }, { code: null, amount: 0.2 }],
    [{ code: 'T', amount: 0.8 }, { code: 'N', amount: 0 }], [{ code: 'T', amount: 0.08 }], [{ code: null, amount: 0.8 }]
  ]) {
    const r = allocate({ ...base(), tax_lines: lines }, ids, 3080);
    assert.equal(r.taxByItem, true, JSON.stringify(lines));
    assert.deepEqual(byLabel(r.allocation), none, JSON.stringify(lines));
  }
});

test('allocate with tax_lines: a "total tax" line without a code is dropped when the coded lines make up the tax', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const r = allocate(rateReceipt([...goodLines, { code: null, rate: null, amount: 7.65 }]), ids, 10448);
  assert.equal(r.taxByItem, true);
  assert.deepEqual(r.taxByRate.map((l) => l.code), ['A', 'E']);
});

test('allocate with tax_lines: a negative taxed category counts as no taxed amount (clamped to 0)', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const r = { subtotal: 20, tax: 1, total: 21, tax_lines: null, items: [item('A', 25, 'A / One', { taxable: true }), item('COUPON', -5, 'B / Two', { taxable: true })] };
  const x = allocate(r, ids, 2100);
  assert.equal(sum(x.allocation), 2100);
});

test('allocate with tax_lines: the reader\'s taxable flag is ignored when per-rate lines are printed; codes are only matched', async () => {
  const { config } = await import('../src/config.js');
  config.taxByItem = true;
  const flip = rateReceipt(goodLines);
  flip.items.forEach((it) => { it.taxable = !it.taxable; });
  assert.deepEqual(byLabel(allocate(flip, ids, 10448).allocation), byLabel(allocate(rateReceipt(goodLines), ids, 10448).allocation));
  // a code with a zero line is untaxed even when flagged taxed
  const z = { subtotal: 30, tax: 0.8, total: 30.8, tax_lines: [{ code: 'T', amount: 0.8 }, { code: 'N', amount: 0 }], items: [item('MILK', 20, 'A / One', { taxable: true, tax_code: 'N' }), item('SPONGES', 10, 'B / Two', { taxable: false, tax_code: 'T' })] };
  assert.deepEqual(byLabel(allocate(z, ids, 3080).allocation), { 'A / One': 2000, 'B / Two': 1080 });
});

// ---- explainTax: how the tax was spread, for the receipt page ----

const coded = (description, amount, tax_code, taxable = true) => ({ description, amount, tax_code, taxable });

test('explainTax: two codes ("tF" -> line "t", "BF" -> line "B") give one entry per printed line, with the printed rate', () => {
  const r = {
    subtotal: 62.3, tax: 3.66, total: 65.96,
    tax_lines: [{ code: 't', rate: 5.6, base: 42.33, amount: 2.37 }, { code: 'B', rate: 8.6, base: 14.97, amount: 1.29 }],
    items: [coded('CEREAL', 42.33, 'tF'), coded('SOAP', 14.97, 'BF'), coded('BREAD', 5, 'N', false)],
  };
  const e = explainTax(r);
  assert.equal(e.how, 'by-rate');
  assert.deepEqual(e.lines, [{ code: 't', rate: 5.6, base: '42.33', amount: '2.37' }, { code: 'B', rate: 8.6, base: '14.97', amount: '1.29' }]);
  assert.deepEqual(allocate(r, ids, 6596, {}).taxExplained, e); // allocate stores the same thing
});

test('explainTax: one rate by item, with the rate worked out when no line prints it', () => {
  const r = { subtotal: 30, tax: 1, total: 31, items: [coded('MILK', 20, null, false), coded('SOAP', 10, 'A')] };
  const e = explainTax(r);
  assert.deepEqual(e, { how: 'by-item', lines: [{ code: 'A', rate: 10, base: '10.00', amount: '1.00' }], reason: null });
});

test('explainTax: proportional, with the reason when it is known; nothing without tax or with TAX_BY_ITEM off', async () => {
  const { config } = await import('../src/config.js');
  const off = { subtotal: 30, tax: 2.4, total: 32.4, items: [{ description: 'x', amount: 10 }, { description: 'y', amount: 20 }] };
  assert.deepEqual(explainTax(off), { how: 'proportional', lines: [], reason: 'no tax marks' });
  assert.equal(explainTax({ ...off, subtotal: 40 }).reason, "the items don't add up to the subtotal");
  assert.equal(explainTax({ ...off, tax: null }), null);
  assert.equal(explainTax({ ...off, tax: 0 }), null);
  config.taxByItem = false;
  try {
    assert.equal(explainTax(off), null);
    assert.equal(allocate(off, ids, 3240).taxExplained, null);
  } finally {
    config.taxByItem = true;
  }
});

test('allocate: the proportional-tax reason is not "items don\'t add up" just because a credit part was added as a problem', () => {
  // items add up to the subtotal; the only problem is the refund line's category going negative
  const receipt = { subtotal: 40, tax: 1.6, total: 41.6, items: [item('x', 30, 'A / One'), item('y', 15, 'B / Two'), item('refund', -5, 'C / Three')] };
  const r = allocate(receipt, ids, 4160);
  assert.match(r.problems.join(), /credit/);
  assert.equal(r.taxExplained.how, 'proportional');
  assert.equal(r.taxExplained.reason, 'no tax marks');
  // a real mismatch with the subtotal still says so
  const off = allocate({ subtotal: 50, tax: 1.6, total: 51.6, items: [item('x', 30, 'A / One'), item('y', 10, 'B / Two')] }, ids, 5160);
  assert.equal(off.taxExplained.reason, "the items don't add up to the subtotal");
});

// flipNumberRefs: a numbers-only line the reader gave a plus sign, while the items exceed the subtotal.
const bulkStoreShape = () => ({
  subtotal: 40.28, tax: 3.54, total: 43.82, is_return: false,
  tax_lines: [{ code: 'A', rate: 9.5, base: null, amount: 2.94 }, { code: 'E', rate: 6.5, base: null, amount: 0.60 }],
  items: [
    item('WIDGET ONE', 23.99, 'A / One', { tax_code: 'A' }), // its 5.00 discount line was dropped by the reader
    item('GADGET TWO', 12.0, 'A / One', { tax_code: 'A' }),
    item('FRUIT BOX', 4.29, 'B / Two', { tax_code: 'E' }),
    item('0000222222 /56366', 1.0, 'B / Two', { tax_code: 'E' }), // really 1.00-
    item('SNACK BAG', 6.0, 'B / Two', { tax_code: 'E' }),
  ],
});
const itemSum = (r) => r.items.reduce((n, i) => n + Math.round(i.amount * 100), 0);

test('flipNumberRefs: the made-up receipt adds up after flip, fold and tax-gap fix', () => {
  const was = config.taxByItem;
  config.taxByItem = true;
  try {
    const r = bulkStoreShape();
    assert.equal(itemSum(r), 4728);
    assert.deepEqual(flipNumberRefs(r), [{ line: '0000222222 /56366', cents: 100 }]);
    assert.equal(foldDiscounts(r).length, 1);
    assert.equal(r.items.length, 4);
    const box = r.items.find((i) => i.description === 'FRUIT BOX');
    assert.equal(box.amount, 3.29);
    assert.equal(box.flippedSign, true);
    const gap = fixTaxGap(r);
    assert.deepEqual(gap, { cents: 500, codes: ['A'] });
    assert.equal(itemSum(r), 4028);
    // only the A items were reduced, in proportion; the E items kept their amounts
    assert.ok(r.items.filter((i) => i.tax_code === 'A').every((i) => i.gapCents > 0));
    assert.equal(r.items.find((i) => i.description === 'SNACK BAG').amount, 6);
    assert.equal(box.amount, 3.29);
    const { problems } = allocate(r, ids, 4382);
    assert.ok(!problems.some((p) => /misread/.test(p)));
  } finally {
    config.taxByItem = was;
  }
});

test('flipNumberRefs: does nothing when the items do not exceed the subtotal', () => {
  const r = bulkStoreShape();
  r.subtotal = 47.28;
  assert.deepEqual(flipNumberRefs(r), []);
  assert.equal(r.items[3].amount, 1);
  r.subtotal = 47.26; // within tolerance
  assert.deepEqual(flipNumberRefs(r), []);
});

test('flipNumberRefs: does nothing when flipping would overshoot', () => {
  const r = bulkStoreShape();
  r.subtotal = 46.4; // gap 0.88: 2 x 1.00 is more than gap + tolerance
  assert.deepEqual(flipNumberRefs(r), []);
  assert.equal(r.items[3].amount, 1);
});

test('flipNumberRefs: leaves normal descriptions, returns and receipts without a subtotal alone', () => {
  const r = bulkStoreShape();
  r.items[3].description = 'ORANGE JUICE';
  assert.deepEqual(flipNumberRefs(r), []);
  const ret = bulkStoreShape();
  ret.is_return = true;
  assert.deepEqual(flipNumberRefs(ret), []);
  const none = bulkStoreShape();
  none.subtotal = null;
  assert.deepEqual(flipNumberRefs(none), []);
  assert.equal(ret.items[3].amount, 1);
});

// ---- flipNumberRefs, tightened ----
const ref = (amount, n = 1) => item(`000011111${n} /22222${n}`, amount, 'A / One');
const flipsOf = (receipt) => flipNumberRefs(receipt).map((f) => f.cents);

test('flipNumberRefs: a big subtotal gets no 2% overshoot (only about 2 cents)', () => {
  // 1030.00 against 1000.00: gap 30 is over the 2% tolerance (20), and flipping 20.00 would land 10.00 under the subtotal
  const r = { subtotal: 1000, items: [item('BIG ITEM', 1010, 'A / One'), ref(20)] };
  assert.deepEqual(flipsOf(r), []);
  assert.equal(r.items[1].amount, 20);
  // a flip that lands within 2 cents under the subtotal is fine
  const ok = { subtotal: 1000, items: [item('BIG ITEM', 1020, 'A / One'), ref(10.01)] };
  assert.deepEqual(flipsOf(ok), [1001]);
});

test('flipNumberRefs: tax-included prices are left alone (items near the total, or a gap equal to the tax)', () => {
  // items = 21.80 against a total of 21.50 and a subtotal of 20.00: VAT-style, not a missed coupon
  const vat = { subtotal: 20, tax: 1.5, total: 21.5, items: [item('THING', 20, 'A / One'), ref(0.9, 1), ref(0.9, 2)] };
  assert.deepEqual(flipsOf(vat), []);
  // the gap is the tax: 22.00 against 20.00 with 2.00 tax
  const gapIsTax = { subtotal: 20, tax: 2, total: 20, items: [item('THING', 20, 'A / One'), item('X', 1, 'A / One'), ref(1)] };
  assert.deepEqual(flipsOf(gapIsTax), []);
  // the same receipt without a tax line to explain the gap is flipped
  const plain = { subtotal: 20, tax: 0, total: 20, items: [item('THING', 20, 'A / One'), item('X', 1, 'A / One'), ref(1)] };
  assert.deepEqual(flipsOf(plain), [100]);
});

test('flipNumberRefs: of two candidates the one that lands nearest the subtotal wins; more than one only if each still fits', () => {
  const two = { subtotal: 41, items: [item('A', 40, 'A / One'), ref(2, 1), ref(3, 2)] }; // gap 4: flipping 2.00 lands on 41.00, 3.00 on 39.00
  assert.deepEqual(flipsOf(two), [200]);
  assert.equal(two.items[2].amount, 3);
  const both = { subtotal: 36, items: [item('A', 40, 'A / One'), ref(2, 1), ref(2, 2)] }; // gap 8: each flip takes off 4
  assert.deepEqual(flipsOf(both), [200, 200]);
  assert.ok(both.items.slice(1).every((i) => i.flippedSign === true && i.amount === -2));
  const third = { subtotal: 36, items: [item('A', 40, 'A / One'), ref(2, 1), ref(2, 2), ref(2, 3)] }; // gap 10; after two flips it is 2, inside the tolerance: the third line stays
  assert.equal(flipsOf(third).length, 2);
  assert.equal(third.items[3].amount, 2);
});

test('fixTaxGap with a lock: locked amounts are never lowered; with nothing else to lower in the group the gap is left', () => {
  const was = config.taxByItem;
  config.taxByItem = true;
  try {
    const make = () => {
      const r = bulkStoreShape();
      r.items = r.items.filter((i) => !/^0000/.test(i.description));
      r.items[2].amount = 3.29; // FRUIT BOX with its 1.00 discount already folded: 35.99 + 3.29 + 6.00 = 45.28 against 40.28
      return r;
    };
    const r = make();
    assert.deepEqual(fixTaxGap(r, { lock: new Set([r.items[0]]) }), { cents: 500, codes: ['A'] });
    assert.equal(r.items[0].amount, 23.99); // locked: untouched
    assert.equal(r.items[1].amount, 7); // GADGET took the whole 5.00
    const all = make();
    assert.equal(fixTaxGap(all, { lock: new Set([all.items[0], all.items[1]]) }), null); // every A item is locked: nothing to lower
    assert.deepEqual(all.items.map((i) => i.amount), [23.99, 12, 3.29, 6]);
    const drops = make();
    drops.items[1].amount = 2; // GADGET would drop to 0 or less
    assert.equal(fixTaxGap(drops, { lock: new Set([drops.items[0]]) }), null);
    // without a lock the same gap is spread over both A items, as before
    const plain = make();
    assert.deepEqual(fixTaxGap(plain), { cents: 500, codes: ['A'] });
    assert.ok(plain.items[0].amount < 23.99 && plain.items[1].amount < 12);
  } finally {
    config.taxByItem = was;
  }
});

// A made-up receipt whose 4.00 discount line was missed: fixTaxGap spread the gap over the two items taxed "A".
const missedDiscount = (savings, categories = ['A / One', 'B / Two']) => ({
  subtotal: 10, tax: 0, total: 10, savings, taxGap: { cents: 400, codes: ['A'] },
  items: [item('SOAP', 4.57, categories[0], { gapCents: 157 }), item('PAPER', 3.43, categories[1], { gapCents: 243 }), item('GUM', 2, 'C / Three')],
});

test('gapSummary: the gap, the items that got a share, and whether the printed savings match it (an older reading has no savings)', () => {
  assert.deepEqual(gapSummary(missedDiscount(4)), { cents: 400, names: ['SOAP', 'PAPER'], savingsCents: 400, matches: true });
  assert.equal(gapSummary(missedDiscount(4.01)).matches, true); // within a cent
  assert.equal(gapSummary(missedDiscount(3.2)).matches, false);
  const old = missedDiscount(undefined);
  delete old.savings;
  assert.deepEqual(gapSummary(old), { cents: 400, names: ['SOAP', 'PAPER'], savingsCents: null, matches: false });
  assert.equal(gapSummary({ items: [item('x', 1)] }), null);
  assert.equal(gapSummary({ taxGap: { cents: 400 }, items: [item('x', 1)] }), null);
});

test('gapSplitDoubt: only when the savings match the gap and the items that got a share are in different categories', () => {
  const [doubt] = gapSplitDoubt(missedDiscount(4));
  assert.match(doubt, /prints savings of 4\.00, matching the 4\.00 the items were over the subtotal/);
  assert.match(doubt, /SOAP, PAPER/);
  assert.match(doubt, /split between categories may be wrong/);
  assert.deepEqual(gapSplitDoubt(missedDiscount(4, ['A / One', 'A / One'])), []); // one category: the totals are right either way
  assert.deepEqual(gapSplitDoubt(missedDiscount(3)), []); // savings that do not match the gap
  assert.deepEqual(gapSplitDoubt(missedDiscount(null)), []);
  assert.deepEqual(gapSplitDoubt({ items: [item('x', 1, 'A / One')] }), []);
});

test('gapSummary: an item name that appears twice is listed once', () => {
  const r = missedDiscount(4);
  r.items.push(item('SOAP', 1, 'A / One', { gapCents: 5 }));
  assert.deepEqual(gapSummary(r).names, ['SOAP', 'PAPER']);
});

test('cash totals above the subtotal are not silently changed without tendered-total evidence', () => {
  for (const cash_tendered of [undefined, 60]) {
    const receipt = { subtotal: 40, tax: 0, total: 50, payment_method: 'cash', cash_tendered };
    assert.equal(fixCashTotal(receipt), null);
    assert.equal(receipt.total, 50);
  }
});
