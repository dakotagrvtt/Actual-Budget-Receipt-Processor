// What the reader's unconstrained first pass may write, checked by llm.js checkReceipt: amounts as strings in every shape a
// receipt prints them, odd booleans and codes, tax lines, store clues, and outputs that must go to the constrained second
// pass instead (a throw). Data in test-fixtures/synthetic/reader-raw.json and readings/.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { checkReceipt, toNumber } from './llm.js';
import { FIXTURES, READING_NAMES, fixture, readingOf } from '../test/synthetic-harness.js';

const saved = { taxByItem: config.taxByItem, plainNames: config.plainNames };
afterEach(() => Object.assign(config, saved));

const CASES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'reader-raw.json'), 'utf8')).cases;
const at = (obj, dotted) => dotted.split('.').reduce((v, k) => (v == null ? v : k === 'length' ? v.length : v[k]), obj);

test('reader output: what cannot be used throws (no merchant, bad total, no items, bad items, not an object)', () => {
  config.taxByItem = true;
  for (const c of CASES.filter((x) => x.throws)) assert.throws(() => checkReceipt(structuredClone(c.raw)), new RegExp(c.throws), c.about);
});

for (const c of CASES.filter((x) => !x.throws)) {
  test(`reader output: ${c.about}`, () => {
    config.taxByItem = true;
    const raw = structuredClone(c.raw);
    const r = checkReceipt(raw);
    for (const [k, want] of Object.entries(c.expect)) assert.deepEqual(at(r, k), want, k);
    // whatever came in, what goes out is typed: numbers or null, strings or null, booleans
    assert.ok(Number.isFinite(r.total));
    for (const k of ['subtotal', 'tax', 'tip', 'cash_tendered']) assert.ok(r[k] === null || Number.isFinite(r[k]), k);
    for (const it of r.items) {
      assert.ok(Number.isFinite(it.amount) && typeof it.description === 'string' && it.description.trim() === it.description);
      if ('taxable' in it) assert.ok([true, false, null].includes(it.taxable));
    }
    assert.equal(typeof r.is_return, 'boolean');
  });
}

test('reader output: every synthetic reading survives being written with "$" strings, and checks back to the same numbers', () => {
  config.taxByItem = true;
  for (const name of READING_NAMES) {
    const plain = readingOf(fixture(name));
    const asText = (v) => (typeof v === 'number' ? (v < 0 ? `${(-v).toFixed(2)}-` : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`) : v);
    const raw = { ...plain, total: asText(plain.total), subtotal: asText(plain.subtotal), tax: asText(plain.tax), tip: asText(plain.tip), items: plain.items.map((it) => ({ ...it, amount: asText(it.amount) })) };
    const want = checkReceipt(structuredClone(plain));
    const got = checkReceipt(raw);
    assert.deepEqual(got, want, name);
  }
});

test('reader output: with TAX_BY_ITEM off the tax marks and lines are dropped; with it on a saved reading without them keeps none', () => {
  config.taxByItem = false;
  const off = checkReceipt(readingOf(fixture('us-two-rate-EA')));
  assert.equal('tax_lines' in off, false);
  assert.ok(off.items.every((it) => !('taxable' in it) && !('tax_code' in it)));
  config.taxByItem = true;
  const old = readingOf(fixture('us-two-rate-EA'));
  for (const it of old.items) { delete it.taxable; delete it.tax_code; }
  delete old.tax_lines;
  const on = checkReceipt(old);
  assert.equal(on.tax_lines, null);
  assert.ok(on.items.every((it) => !('taxable' in it)), 'an item without the field stays without it');
});

test('reader output: READ_PLAIN_NAMES fills a missing plain name from the description, and drops it when off', () => {
  config.plainNames = true;
  const r = checkReceipt({ merchant: 'A', total: 2, items: [{ description: 'GV 2% MLK', amount: 1, plain: ' ' }, { description: 'X', amount: 1, plain: 'a thing' }] });
  assert.deepEqual(r.items.map((i) => i.plain), ['GV 2% MLK', 'a thing']);
  config.plainNames = false;
  const r2 = checkReceipt({ merchant: 'A', total: 2, items: [{ description: 'X', amount: 2, plain: 'a thing' }] });
  assert.equal('plain' in r2.items[0], false);
});

test('toNumber: the shapes receipts print, other currencies, decimal commas; stray words are NaN', () => {
  const cases = { '16': 16, '16.00': 16, '$16.00': 16, '1,016.00': 1016, '-$1.00': -1, '1.00-': -1, '(1.00)': -1, '.5': 0.5, '5.': 5, 'USD 5': 5, '$ 1 234.50': 1234.5, '12,345,678.90': 12345678.9, '24,50': 24.5, '1.234,50': 1234.5, '1,234.50': 1234.5 };
  for (const [s, n] of Object.entries(cases)) assert.equal(toNumber(s), n, s);
  for (const s of ['', ' ', 'abc', '1.2.3', '--1', '1e3', '0x10', 'NaN', 'Infinity', '1,2,3', '5 apples']) assert.ok(Number.isNaN(toNumber(s)), s);
  for (const v of [null, undefined, true, {}, [], NaN, Infinity, -Infinity]) assert.ok(Number.isNaN(toNumber(v)), String(v));
  assert.equal(toNumber(-0), -0);
  // currencies other than dollars are read like "$" amounts
  for (const [s, n] of Object.entries({ '€24.50': 24.5, '£3.20': 3.2, 'CA$33.80': 33.8, '24.50 EUR': 24.5, '33.80 CAD': 33.8 })) assert.equal(toNumber(s), n, s);
  const r = checkReceipt({ merchant: 'Marché Lumière', currency: 'EUR', total: '€24.50', subtotal: '€21.35', tax: '€3.15', items: [{ description: 'BAGUETTE', amount: '€24.50' }] });
  assert.deepEqual([r.total, r.subtotal, r.tax], [24.5, 21.35, 3.15]);
  // decimal commas and letter codes, but not stray words
  for (const [s, n] of Object.entries({ '€24,50': 24.5, '1.234,50 €': 1234.5, 'US$ 5.00': 5, '(£3.20)': -3.2, '3.20- EUR': -3.2, '24.50 EUR': 24.5 })) assert.equal(toNumber(s), n, s);
  for (const s of ['1,2,3', 'EUR', '5 apples']) assert.ok(Number.isNaN(toNumber(s)), s);
});
