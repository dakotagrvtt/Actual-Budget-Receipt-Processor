// Dividing a bank charge over a receipt's categories (reconcile.js), on the synthetic readings: every fixture under every
// budget's category structure, tax by item on and off, charges equal to, above and below the receipt; plus tax regimes
// (US two-rate, F-coded food, EU VAT included, Canadian GST+PST and HST), coupons and store-wide discounts.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { allocate, foldDiscounts, fixTaxGap, partNote, stripAnnotations, mergeSmallParts, fixCashTotal, cents, UNCATEGORIZED } from '../src/reconcile.js';
import { checkReceipt } from '../src/llm.js';
import { BUDGET_NAMES, READING_NAMES, budget, fixture, readingOf } from './synthetic-harness.js';

const pristine = { taxByItem: config.taxByItem, taxByItemMaxRate: config.taxByItemMaxRate };
afterEach(() => Object.assign(config, pristine));

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const byLabel = (allocation) => Object.fromEntries(allocation.map((a) => [a.label, a.cents]));
/** label → id for a budget (all non-income categories, the way categoryLabels names them). */
function labelMap(b) {
  const group = new Map(b.groups.map((g) => [g.id, g.name]));
  return new Map(b.categories.filter((c) => !c.is_income && !c.hidden).map((c) => [`${group.get(c.group_id)} / ${c.name}`, c.id]));
}
/** The fixture checked as the reader's output is, with each item filed by kind (fees and coupons: `unknown`). */
function filed(name, b, { unknown = UNCATEGORIZED, fold = true } = {}) {
  const fx = fixture(name);
  const kinds = fx.reading.items.map((i) => i.kind);
  const r = checkReceipt(readingOf(fx));
  r.items.forEach((it, i) => { it.category = kinds[i] ? b.kinds[kinds[i]] : unknown; });
  if (fold) foldDiscounts(r);
  return r;
}

/** Everything an allocation must be, whatever the input. */
function checkAllocation(result, receipt, labelToId, target, where) {
  if (result.allocation === null) {
    assert.ok(result.problems.length > 0, `${where}: no allocation and no reason`);
    return;
  }
  const a = result.allocation;
  assert.equal(sum(a.map((p) => p.cents)), target, `${where}: parts ${a.map((p) => p.cents).join('+')} != ${target}`);
  for (const p of a) {
    assert.ok(Number.isInteger(p.cents) && !Object.is(p.cents, -0), `${where}: part ${p.label} has ${p.cents} cents`);
    assert.equal(p.categoryId, p.label === UNCATEGORIZED ? null : labelToId.get(p.label) ?? null, `${where}: ${p.label} has id ${p.categoryId}`);
    assert.equal(p.items.length, p.refs.length, `${where}: items and refs out of step in ${p.label}`);
    if (p.cents < 0) assert.ok(result.problems.some((x) => x.includes(`credit of ${(-p.cents / 100).toFixed(2)} in "${p.label}"`)), `${where}: a credit part without a problem`);
  }
  assert.equal(new Set(a.map((p) => p.label)).size, a.length, `${where}: a label appears twice`);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].cents >= a[i].cents, `${where}: not largest first`);
}

// ---- 1. every reading, every budget, tax by item on and off, three charge sizes ----

test('allocate: every reading under every budget adds up exactly to the charge, at the total, with a tip, and a cent under', () => {
  for (const bname of BUDGET_NAMES) {
    const b = budget(bname);
    const ids = labelMap(b);
    for (const name of READING_NAMES) {
      for (const taxByItem of [true, false]) {
        config.taxByItem = taxByItem;
        const r0 = filed(name, b);
        const total = cents(r0.total);
        for (const target of [total, total + Math.round(total * 0.18) + 1, total - 1, 1, 999999]) {
          if (target <= 0) continue;
          const r = structuredClone(r0);
          const where = `${bname}/${name}/taxByItem=${taxByItem}/target=${target}`;
          checkAllocation(allocate(r, ids, target), r, ids, target, where);
          checkAllocation(allocate(r, ids, target, { gapLabel: b.kinds.grocery }), r, ids, target, `${where}/gap→store`);
        }
      }
    }
  }
});

test('allocate: items filed in one category, alternating categories, or each in its own make one, two or n parts', () => {
  const b = budget('large');
  const ids = labelMap(b);
  const labels = [...ids.keys()];
  for (const name of ['grocery-60-items', 'multi-page', 'grocery-basic']) {
    const base = filed(name, b);
    const target = cents(base.total);
    const one = structuredClone(base);
    one.items.forEach((it) => { it.category = labels[0]; });
    const a1 = allocate(one, ids, target);
    assert.equal(a1.allocation.length, 1, name);
    const alt = structuredClone(base);
    alt.items.forEach((it, i) => { it.category = labels[i % 2]; });
    checkAllocation(allocate(alt, ids, target), alt, ids, target, `${name}/alternating`);
    const each = structuredClone(base);
    each.items.forEach((it, i) => { it.category = labels[i % labels.length]; });
    const an = allocate(each, ids, target);
    checkAllocation(an, each, ids, target, `${name}/each`);
    assert.ok(an.allocation.length <= labels.length);
  }
});

// ---- 2. tax regimes ----

test('tax by item: untaxed groceries carry no tax; the taxed household goods carry all of it (one rate, T marks)', () => {
  const b = budget('standard');
  const r = filed('grocery-basic', b);
  const target = cents(r.total);
  const { allocation, taxByItem } = allocate(r, labelMap(b), target);
  assert.equal(taxByItem, true);
  const items = (label) => sum(r.items.filter((i) => i.category === label).map((i) => cents(i.amount)));
  assert.equal(byLabel(allocation)[b.kinds.grocery], items(b.kinds.grocery));
  assert.equal(sum(allocation.map((a) => a.cents)), target);
});

for (const name of ['us-two-rate-EA', 'us-two-rate-T-TF', 'us-two-rate-T-BF']) {
  test(`tax by rate (${name}): each printed rate goes to the items with its code, exact to the cent`, () => {
    const b = budget('standard');
    const r = filed(name, b);
    const target = cents(r.total);
    const { allocation, taxByRate } = allocate(r, labelMap(b), target);
    assert.ok(taxByRate, `${name}: expected a spread by rate`);
    // expected: per category, its items plus each line's tax in proportion to the category's items with that code
    const expected = {};
    for (const it of r.items) expected[it.category] = (expected[it.category] ?? 0) + cents(it.amount);
    const lineTax = Object.fromEntries(r.tax_lines.map((l) => [l.code, cents(l.amount)]));
    for (const [code, tax] of Object.entries(lineTax)) {
      const coded = r.items.filter((i) => i.tax_code === code);
      const base = sum(coded.map((i) => cents(i.amount)));
      const cats = [...new Set(coded.map((i) => i.category))];
      if (cats.length === 1) expected[cats[0]] += tax; // one category per rate: all of it, no rounding to argue about
      else for (const c of cats) expected[c] += Math.round((tax * sum(coded.filter((i) => i.category === c).map((i) => cents(i.amount)))) / base);
    }
    const got = byLabel(allocation);
    for (const [label, want] of Object.entries(expected)) assert.ok(Math.abs(got[label] - want) <= 1, `${name}: ${label} got ${got[label]}, want ${want}`);
    assert.equal(sum(allocation.map((a) => a.cents)), target);
    // the untaxed prescription (N, no line) carries no tax at all
    if (name === 'us-two-rate-T-BF') assert.equal(got[b.kinds.health], 1000);
  });
}

test('tax: EU VAT already included in the prices is never added again; every category gets exactly its items', () => {
  for (const bname of BUDGET_NAMES) {
    const b = budget(bname);
    const r = filed('eu-vat-included', b);
    const { allocation, problems } = allocate(r, labelMap(b), cents(r.total));
    const items = {};
    for (const it of r.items) items[it.category] = (items[it.category] ?? 0) + cents(it.amount);
    assert.deepEqual(byLabel(allocation), items, bname);
    assert.deepEqual(problems, [], bname);
  }
});

test('tax: EU VAT included, read with the net (HT) subtotal, is not a misread receipt', () => {
  const b = budget('standard');
  const r = filed('eu-vat-net-subtotal', b);
  assert.equal(cents(r.subtotal) + cents(r.tax), cents(r.total));
  assert.equal(sum(r.items.map((i) => cents(i.amount))), cents(r.total));
  const { problems } = allocate(r, labelMap(b), cents(r.total));
  assert.deepEqual(problems, []);
});

test('tax: Canadian GST+PST, HST over the 12% cap, inconsistent tax lines and one combined line for two codes fall back to proportional, exactly', () => {
  const b = budget('standard');
  for (const name of ['canada-gst-pst', 'canada-hst', 'tax-lines-inconsistent', 'us-two-rate-one-line', 'no-tax-marks']) {
    const r = filed(name, b);
    const target = cents(r.total);
    const res = allocate(r, labelMap(b), target);
    checkAllocation(res, r, labelMap(b), target, name);
    assert.equal(res.taxByRate ?? null, null, name);
    // proportional: each category's share is its items scaled by total / items, within a cent
    const itemsC = sum(r.items.map((i) => cents(i.amount)));
    for (const a of res.allocation) {
      const own = sum(r.items.filter((i) => i.category === a.label).map((i) => cents(i.amount)));
      assert.ok(Math.abs(a.cents - (own * target) / itemsC) <= 1, `${name}: ${a.label} ${a.cents} vs ${(own * target) / itemsC}`);
    }
  }
});

test('tax: HST at 13% is spread by item once TAX_BY_ITEM_MAX_RATE allows it', () => {
  const b = budget('standard');
  config.taxByItemMaxRate = 0.15;
  const r = filed('canada-hst', b);
  const { allocation, taxByItem } = allocate(r, labelMap(b), cents(r.total));
  assert.equal(taxByItem, true);
  assert.equal(byLabel(allocation)[b.kinds.grocery], 499, 'the untaxed apples carry no HST');
});

test('tax: an F-coded item is read like any other code (no printed F line: no tax), and the parts still add up', () => {
  const b = budget('standard');
  const r = filed('f-coded-food', b);
  assert.deepEqual(r.items.map((i) => i.taxable), [true, true, true]);
  const res = allocate(r, labelMap(b), cents(r.total));
  checkAllocation(res, r, labelMap(b), cents(r.total), 'f-coded');
  if (res.taxByItem) assert.equal(byLabel(res.allocation)[b.kinds.grocery], 748, 'when tax is spread by item, the F food carries none');
});

test('tax: a zero tax, a zero tip and a printed tip keep exact cents; the tip is spread in proportion to the items', () => {
  const b = budget('standard');
  for (const name of ['zero-tax', 'restaurant-tip-printed', 'delivery-fees-tip', 'service-charge']) {
    const r = filed(name, b);
    for (const target of [cents(r.total), cents(r.total) + 500]) checkAllocation(allocate(r, labelMap(b), target), r, labelMap(b), target, `${name}/${target}`);
  }
});

// ---- 3. coupons and discounts ----

test('coupons: a coded coupon joins its item (before or after it); a leading coupon, an unknown code and a coupon as big as its item stay lines', () => {
  const r = { items: readingOf(fixture('coupons')).items };
  const folded = foldDiscounts(r);
  assert.deepEqual(folded.map((f) => [f.line, f.into]), [
    ['TPD/4400012', '4400012 CEREAL'],
    ['TPD/5500033', '5500033 DETERGENT'],
  ]);
  // the leading store coupon (nothing before it), the unknown item number and a coupon as big as its item (MFR COUPON
  // -1.00 after GUM 1.00) stay as their own lines
  assert.deepEqual(r.items.filter((i) => i.amount < 0).map((i) => i.description), ['STORE COUPON', 'TPD/7777777', 'MFR COUPON']);
  assert.equal(r.items.find((i) => i.description === 'GUM').amount, 1);
});

test('coupons: folding never changes what the items add up to, never makes an item negative, and records what it took off', () => {
  for (const name of READING_NAMES) {
    const r = { is_return: fixture(name).reading.is_return, items: readingOf(fixture(name)).items };
    const before = sum(r.items.map((i) => cents(i.amount)));
    const folded = foldDiscounts(r);
    assert.equal(sum(r.items.map((i) => cents(i.amount))), before, name);
    assert.equal(sum(r.items.map((i) => i.discountCents ?? 0)), sum(folded.map((f) => f.cents)), name);
    for (const it of r.items) if (it.discountCents) assert.ok(it.amount > 0, `${name}: ${it.description} folded to ${it.amount}`);
  }
});

test('coupons: a store-wide percent-off line is shared by every category, not charged to the last item alone', () => {
  const b = budget('standard');
  const r = filed('store-wide-percent', b);
  const { allocation } = allocate(r, labelMap(b), cents(r.total));
  const got = byLabel(allocation);
  // 10% off everything: the card's part should be about 90% of 6.99 plus its tax, not 1.24 plus tax
  assert.ok(got[b.kinds.gift] > 600, `the card's part is ${got[b.kinds.gift]} cents`);
});

test('coupons: a coupon bigger than every item it could join, a refund line and a gift-card redemption stay their own lines', () => {
  const r = { items: [{ description: 'GUM', amount: 1 }, { description: 'COUPON', amount: -2 }, { description: 'RETURN SHIRT', amount: -10 }, { description: 'GIFT CARD REDEEM', amount: -20 }, { description: 'TV', amount: 100 }] };
  assert.deepEqual(foldDiscounts(r), []);
  assert.equal(r.items.length, 5);
});

// ---- 4. refunds, gaps and credits ----

test('refunds: a returned shirt in the same category as the new one nets to zero and the other parts stay positive', () => {
  const b = budget('standard');
  const r = filed('refund-mixed', b);
  const res = allocate(r, labelMap(b), cents(r.total));
  checkAllocation(res, r, labelMap(b), cents(r.total), 'refund-mixed');
  assert.ok(!res.allocation.some((a) => a.label === b.kinds.clothing), 'shirt and its return cancel out');
  // the return filed somewhere else than the purchase: a credit part, with a problem
  r.items.find((i) => /RETURN/.test(i.description)).category = b.kinds.gift;
  const credit = allocate(r, labelMap(b), cents(r.total));
  checkAllocation(credit, r, labelMap(b), cents(r.total), 'refund-mixed/credit');
  assert.ok(credit.allocation.some((a) => a.cents < 0));
});

test('gaps: a missed line goes to the gap label; items over the subtotal add no part; both are problems', () => {
  const b = budget('standard');
  const short = filed('misread-short', b);
  const res = allocate(short, labelMap(b), cents(short.total), { gapLabel: b.kinds.grocery });
  assert.match(res.problems[0], /add up to 21\.97 but the printed subtotal is 31\.97/);
  assert.equal(res.taxByItem, false, 'an incomplete item list never spreads tax by item');
  const over = filed('misread-over', b);
  const res2 = allocate(over, labelMap(b), cents(over.total));
  assert.match(res2.problems[0], /add up to 66\.88 but the printed subtotal is 21\.97/);
  checkAllocation(res2, over, labelMap(b), cents(over.total), 'misread-over');
});

// ---- 5. small parts ----

test('mergeSmallParts: whatever the minimum, the total is kept, credits and Uncategorized stay, and no categorized part stays under the minimum unless it is the only home', () => {
  const b = budget('large');
  const ids = labelMap(b);
  for (const name of READING_NAMES) {
    const r = filed(name, b);
    const target = cents(r.total);
    if (target <= 0) continue;
    const res = allocate(r, ids, target);
    if (!res.allocation) continue;
    for (const min of [0, 1, 100, 500, 5000, 1e9]) {
      for (const prefer of [null, ids.get(b.kinds.grocery), 'not-a-category']) {
        const before = structuredClone(res.allocation);
        const merged = mergeSmallParts(structuredClone(res.allocation), min, prefer);
        const where = `${name}/min=${min}/prefer=${prefer}`;
        assert.equal(sum(merged.map((a) => a.cents)), target, where);
        assert.equal(merged.filter((a) => a.cents < 0).length, before.filter((a) => a.cents < 0).length, `${where}: a credit was merged`);
        assert.ok(merged.filter((a) => !a.categoryId).length <= before.filter((a) => !a.categoryId).length, where);
        const small = merged.filter((a) => a.categoryId && a.cents >= 0 && a.cents < min);
        assert.ok(small.length <= 1, `${where}: ${small.length} small parts left`);
        assert.equal(sum(merged.map((a) => a.items.length)), sum(before.map((a) => a.items.length)), `${where}: items lost`);
      }
    }
  }
});

// ---- 6. cash ----

test('fixCashTotal: the tendered amount read as the total is corrected; a card receipt or cash back is never touched', () => {
  const r = readingOf(fixture('cash-paid-tendered'));
  assert.match(fixCashTotal(r), /total read as 20\.00/);
  assert.equal(r.total, 6.75);
  const cb = readingOf(fixture('cash-back'));
  cb.total = 100;
  assert.equal(fixCashTotal(cb), null, 'debit with cash back is not cash');
  assert.equal(cb.total, 100);
});

// ---- 7. a random property over allocate ----

test('property: 2000 random item lists (negative lines, zeros, one-cent items, huge items) always add up exactly', () => {
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const labels = ['A / One', 'B / Two', 'C / Three', 'D / Four', UNCATEGORIZED];
  const ids = new Map(labels.filter((l) => l !== UNCATEGORIZED).map((l, i) => [l, `c${i}`]));
  for (let k = 0; k < 2000; k++) {
    const n = 1 + Math.floor(r() * 30);
    const items = Array.from({ length: n }, (_, i) => {
      const roll = r();
      const amount = roll < 0.1 ? -Math.round(r() * 5000) / 100 : roll < 0.15 ? 0 : roll < 0.2 ? 0.01 : roll < 0.22 ? Math.round(r() * 1e7) / 100 : Math.round(r() * 10000) / 100;
      const code = ['T', 'E', null][Math.floor(r() * 3)];
      return { description: `item ${i}`, amount, category: labels[Math.floor(r() * labels.length)], taxable: code ? true : r() < 0.5 ? false : null, tax_code: code };
    });
    const itemsC = sum(items.map((i) => cents(i.amount)));
    const tax = r() < 0.5 ? Math.round(Math.max(0, itemsC) * r() * 0.1) / 100 : null;
    const receipt = { items, subtotal: r() < 0.7 ? itemsC / 100 : null, tax, tip: null, total: (itemsC + cents(tax ?? 0)) / 100, tax_lines: r() < 0.3 ? [{ code: 'T', rate: 7, amount: (tax ?? 0) / 2 }, { code: 'E', rate: 2, amount: (tax ?? 0) / 2 }] : null };
    const target = Math.max(1, Math.round(cents(receipt.total) * (0.5 + r())));
    config.taxByItem = r() < 0.7;
    checkAllocation(allocate(receipt, ids, target), receipt, ids, target, `case ${k}`);
  }
});

// Receipts built inline: [description, amount, category, tax_code]; invented stores and numbers.
function made(rows, { subtotal, tax, lines }) {
  const items = rows.map(([description, amount, category, tax_code]) => ({ description, amount, category, tax_code: tax_code ?? null, taxable: null }));
  return { is_return: false, items, subtotal, tax, tip: null, total: subtotal + tax, tax_lines: lines };
}
const MAP = new Map([['A', 1], ['B', 2]]);
const taxOf = (res, label, items) => byLabel(res.allocation)[label] - items;

test('discounts: a coupon of only item numbers folds into the item before it when no item keeps its number; with item numbers kept it still needs a match', () => {
  const r = made([['PAPER PLATES', 19.99, 'A', 'A'], ['0000390146 /1111161', -4, 'A', 'A'], ['BANANAS', 2, 'B', 'B'], ['COUPON 0000555', -1, 'B', 'B']], { subtotal: 16.99, tax: 0, lines: null });
  const folded = foldDiscounts(r);
  assert.deepEqual(folded.map((f) => [f.into, f.cents]), [['PAPER PLATES', 400]]); // "COUPON 0000555" has a word and a number no item has: left alone
  assert.equal(r.items[0].amount, 15.99);
  const keeps = made([['1111161 PAPER PLATES', 19.99, 'A'], ['0000390146 /1111161', -4, 'A'], ['0000999 /2222222', -1, 'A']], { subtotal: 14.99, tax: 0, lines: null });
  assert.deepEqual(foldDiscounts(keeps).map((f) => f.cents), [400]); // the existing number match; the unmatched one stays
  assert.equal(keeps.items.length, 2);
});

test('tax by rate: a number-only coupon folded into its item makes the per-rate spread match to the cent', () => {
  const r = made([['PAPER PLATES', 19.99, 'A', 'A'], ['0000390146 /1111161', -4, 'B', null], ['SOAP', 10, 'B', 'B']], { subtotal: 25.99, tax: 1.88, lines: [{ code: 'A', rate: 8, base: 15.99, amount: 1.28 }, { code: 'B', rate: 6, base: 10, amount: 0.6 }] });
  foldDiscounts(r);
  const res = allocate(r, MAP, cents(r.total));
  assert.ok(res.taxByRate);
  assert.equal(taxOf(res, 'A', 1599), 128);
  assert.equal(taxOf(res, 'B', 1000), 60);
});

test('tax by rate: Hy-Vee style codes "tF"/"T" with lines "t"/"T" and bases are matched by case and arithmetic', () => {
  const r = made([['CEREAL', 20.96, 'A', 'tF'], ['SOAP', 14.97, 'B', 'T'], ['BREAD', 5, 'A', 'N']], { subtotal: 40.93, tax: 2.35, lines: [{ code: 't', rate: 5.5, base: 20.96, amount: 1.15 }, { code: 'T', rate: 8, base: 14.97, amount: 1.2 }] });
  const res = allocate(r, MAP, cents(r.total));
  assert.ok(res.taxByRate);
  assert.equal(taxOf(res, 'A', 2596), 115);
  assert.equal(taxOf(res, 'B', 1497), 120);
});

test('tax by rate: a different case is matched ("t" line, "T" item) when unambiguous', () => {
  const r = made([['CEREAL', 20, 'A', 'T'], ['BREAD', 5, 'B', 'N']], { subtotal: 25, tax: 1.2, lines: [{ code: 't', rate: null, base: null, amount: 1.2 }, { code: 'X', rate: null, base: null, amount: 0 }] });
  r.items[1].tax_code = 'X';
  const res = allocate(r, MAP, cents(r.total));
  assert.equal(taxOf(res, 'A', 2000), 120);
});

test('tax by rate: Walmart style item code "R" with line "TAX1" is matched by the printed rate', () => {
  const r = made([['TOWELS', 30, 'A', 'R'], ['PEARS', 10, 'B', 'N']], { subtotal: 40, tax: 1.8, lines: [{ code: 'TAX1', rate: 6, base: null, amount: 1.8 }] });
  const res = allocate(r, MAP, cents(r.total));
  assert.equal(res.taxByItem, true);
  assert.equal(taxOf(res, 'A', 3000), 180);
  assert.equal(taxOf(res, 'B', 1000), 0);
});

test('tax by rate: two groups fit one line (or nothing fits): proportional, as before', () => {
  const both = made([['TOWELS', 30, 'A', 'R'], ['LAMP', 30, 'B', 'S']], { subtotal: 60, tax: 1.8, lines: [{ code: 'TAX1', rate: 6, base: null, amount: 1.8 }] });
  assert.equal(allocate(both, MAP, cents(both.total)).taxByItem, false);
  const none = made([['TOWELS', 30, 'A', 'R'], ['PEARS', 10, 'B', 'N']], { subtotal: 40, tax: 1.8, lines: [{ code: 'TAX1', rate: 9, base: null, amount: 1.8 }] });
  assert.equal(allocate(none, MAP, cents(none.total)).taxByItem, false);
});

test('tax by rate: a printed base that the code-matched items do not net to falls back to proportional', () => {
  const lines = (base) => [{ code: 'A', rate: null, base, amount: 1.2 }, { code: 'B', rate: null, base: null, amount: 0.8 }];
  const ok = made([['X', 15, 'A', 'A'], ['Y', 10, 'B', 'B']], { subtotal: 25, tax: 2, lines: lines(15) });
  assert.ok(allocate(ok, MAP, cents(ok.total)).taxByRate);
  const bad = made([['X', 15, 'A', 'A'], ['Y', 10, 'B', 'B']], { subtotal: 25, tax: 2, lines: lines(12) });
  assert.equal(allocate(bad, MAP, cents(bad.total)).taxByRate, null);
});

test('tax: a misread case of one mark ("S" vs "s") does not strand an item; a printed rate that does not fit the items falls back', () => {
  const r = made([['SOAP', 50, 'A', 'S'], ['LAMP', 5, 'B', 's'], ['MILK', 10, 'B', null]], { subtotal: 65, tax: 3.85, lines: [{ code: 'S', rate: 7, base: null, amount: 3.85 }] });
  const res = allocate(r, MAP, cents(r.total));
  assert.equal(res.taxByItem, true);
  assert.equal(taxOf(res, 'A', 5000), 350);
  assert.equal(taxOf(res, 'B', 1500), 35);
  const wrong = made([['SOAP', 50, 'A', 'S'], ['MILK', 10, 'B', null]], { subtotal: 60, tax: 3.85, lines: [{ code: 'S', rate: 3, base: null, amount: 3.85 }] });
  assert.equal(allocate(wrong, MAP, cents(wrong.total)).taxByItem, false);
});

test('tax: an uncoded item that fits a line as well as a coded one makes it ambiguous (no arithmetic match)', () => {
  const r = made([['SOAP', 10, 'A', null], ['MILK', 10, 'B', 'N']], { subtotal: 20, tax: 0.6, lines: [{ code: 'TAX1', rate: 6, base: null, amount: 0.6 }] });
  assert.equal(allocate(r, MAP, cents(r.total)).taxByItem, false);
});

test('discounts: a number-only coupon folds only in the shape "digits / digits", and not onto an item with another tax code', () => {
  for (const text of ['0000390146 /1111161']) {
    const ok = made([['PLATES', 10, 'A', 'A'], [text, -1, 'A', 'A']], { subtotal: 9, tax: 0, lines: null });
    assert.equal(foldDiscounts(ok).length, 1);
  }
  for (const text of ['0012345678', 'XXXX XXXX 1234', '1234 5678 9012']) {
    const no = made([['PLATES', 10, 'A', 'A'], [text, -1, 'A', 'A']], { subtotal: 9, tax: 0, lines: null });
    assert.equal(foldDiscounts(no).length, 0, text);
  }
  const other = made([['PLATES', 10, 'A', 'A'], ['0000390146 /1111161', -1, 'A', 'b']], { subtotal: 9, tax: 0, lines: null });
  assert.equal(foldDiscounts(other).length, 0);
});

test('tax: a second printed line that no taxed item belongs to falls back instead of piling its tax on the first line\'s items', () => {
  const r = made([['SOAP', 50, 'A', 'A'], ['MILK', 50, 'B', null]], { subtotal: 100, tax: 5.5, lines: [{ code: 'A', rate: 7, base: null, amount: 3.5 }, { code: 'B', rate: 4, base: null, amount: 2 }] });
  assert.equal(allocate(r, MAP, cents(r.total)).taxByItem, false);
});

// Tax-line gap: the items miss the subtotal, the printed per-rate lines say which group is off.
const L = (code, rate, amount, base = null) => ({ code, rate, base, amount });
const itemSum = (r) => sum(r.items.map((i) => cents(i.amount)));

test('tax gap: a skipped coupon (items over, group off by the receipt gap) is taken off that group, and the spread then matches', () => {
  const r = made([['PLATES', 30, 'A', 'A'], ['MUGS', 21, 'A', 'A'], ['CHIPS', 45.8, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] });
  assert.deepEqual(fixTaxGap(r), { cents: 400, codes: ['A'] });
  assert.equal(itemSum(r), 9280);
  assert.equal(r.items[2].amount, 45.8);
  const res = allocate(r, MAP, cents(r.total));
  assert.ok(res.taxByRate);
  assert.match(res.problems.join('|'), /were 4\.00 over the printed subtotal; the difference was put on the items taxed at A/);
  assert.doesNotMatch(res.allocation.flatMap((a) => a.items).join('|'), /pipeline/); // no per-item note
});

test('tax gap: an invented item (one rate exact, the other group over) is taken off the other group', () => {
  const r = made([['LAMP', 12.99, 'A', 'A'], ['RUG', 73.61, 'B', 'E'], ['BAGEL', 8.99, 'B', 'E']], { subtotal: 86.6, tax: 5.52, lines: [L('A', 8.5, 1.1), L('E', 6, 4.42)] });
  assert.equal(fixTaxGap(r).codes[0], 'E');
  assert.equal(r.items[0].amount, 12.99);
  assert.equal(itemSum(r), 8660);
});

test('tax gap: printed bases, codes "tF"/"T" with lines "t"/"T", notes read as items: the group off by its base is corrected', () => {
  const r = made([['CEREAL', 20.96, 'A', 'tF'], ['Manual Weight', 3.96, 'A', 'tF'], ['Manual Weight', 7.96, 'A', 'tF'], ['SOAP', 14.97, 'B', 'T']], { subtotal: 35.93, tax: 2.35, lines: [L('t', 5.5, 1.15, 20.96), L('T', 8, 1.2, 14.97)] });
  assert.deepEqual(fixTaxGap(r), { cents: 1192, codes: ['t'] });
  assert.equal(itemSum(r), 3593);
  assert.equal(r.items[3].amount, 14.97);
});

test('tax gap: nothing changes when it is unclear (no bases and two groups off, gap fits no group, uncoded item, no TAX_BY_ITEM, one rate)', () => {
  const run = (rows, o) => { const r = made(rows, o); const before = JSON.stringify(r.items); const out = fixTaxGap(r); assert.equal(out, null); assert.equal(JSON.stringify(r.items), before); };
  run([['P', 51, 'A', 'A'], ['C', 50, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] }); // both off, no bases
  run([['P', 51, 'A', 'A'], ['C', 45.8, 'B', 'E']], { subtotal: 93.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] }); // A off by 4.01, receipt gap 3.00
  run([['P', 51, 'A', 'A'], ['C', 45.8, 'B', 'E'], ['X', 1, 'B', null]], { subtotal: 93.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] }); // an uncoded item
  run([['P', 51, 'A', 'A'], ['C', 45.8, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 6.74)] }); // one rate
  config.taxByItem = false;
  run([['P', 51, 'A', 'A'], ['C', 45.8, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] });
});

test('tax gap: only positive gaps beyond the subtotal tolerance; not on VAT-inclusive prices; same-sign groups; exact groups that could hold the gap', () => {
  const none = (rows, o) => { const r = made(rows, o); assert.equal(fixTaxGap(r), null); assert.ok(!r.items.some((i) => i.gapCents)); };
  // items under the subtotal (a missed item): the old behavior, nothing spread over the items that were read
  none([['PLATES', 40, 'A', 'A'], ['CHIPS', 45.8, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] });
  // VAT included in the prices: items add up to the total, bases are net
  none([['BREAD', 3.2, 'A', 'A'], ['CHEESE', 4.84, 'A', 'A'], ['WINE', 16.38, 'B', 'B']], { subtotal: 21.27, tax: 3.15, total: 24.42, lines: [L('A', 5.5, 0.42, 7.62), L('B', 20, 2.73, 13.65)] });
  // a small gap that allocate accepts (2%)
  none([['P', 47.5, 'A', 'A'], ['C', 45.8, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 6, 2.75)] });
  // two groups off in opposite directions (codes on the wrong items)
  none([['P', 40, 'A', 'A'], ['C', 60, 'B', 'E']], { subtotal: 92.8, tax: 6.74, lines: [L('A', 8.5, 3.99, 46.99), L('E', 6, 2.75, 45.8)] });
  // a low rate: the exact group's rounding tolerance (0.5 / 0.005) is bigger than the gap
  none([['P', 51, 'A', 'A'], ['C', 150, 'B', 'E']], { subtotal: 197, tax: 6.74, lines: [L('A', 8.5, 3.99), L('E', 0.5, 2.75)] });
});

test('notes: split notes are cut between items, and a cut-off "(pipeline:" or "(maybe" start is never learned', () => {
  assert.equal(partNote({ items: ['MILK', 'BREAD', 'EGGS'] }, ', ', 14), 'MILK, BREAD');
  assert.equal(partNote({ items: ['MILK'.repeat(10)] }, ', ', 14), 'MILKMILKMILKMI');
  for (const cut of ['BREAD (pi', 'BREAD (', 'BREAD (pipeline', 'BREAD (mayb', 'BREAD (m']) assert.equal(stripAnnotations(`MILK, ${cut}`), 'MILK, BREAD', cut);
});
