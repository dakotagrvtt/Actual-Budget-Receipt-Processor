import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, mergeSmallParts, fixCashTotal, paidCash, stripAnnotations, UNCATEGORIZED } from './reconcile.js';

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
  const r = { subtotal: 10, tax: 1, tip: 2, total: 20, payment_method: 'cash' };
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
