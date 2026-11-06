import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { toNumber, parseJson, checkReceipt } from './llm.js';

test('toNumber: numbers and the formats receipts print', () => {
  assert.equal(toNumber(16), 16);
  assert.equal(toNumber('16.00'), 16);
  assert.equal(toNumber('$16.00'), 16);
  assert.equal(toNumber('USD 16.00'), 16);
  assert.equal(toNumber('1,016.00'), 1016);
  assert.equal(toNumber('-$1.00'), -1);
  assert.equal(toNumber('1.00-'), -1);
  assert.equal(toNumber('(1.00)'), -1);
  assert.equal(toNumber('.5'), 0.5);
});

test('toNumber: anything else is NaN', () => {
  for (const v of ['', 'abc', '1.2.3', null, undefined, {}, NaN, Infinity, '12 apples']) assert.ok(Number.isNaN(toNumber(v)), String(v));
});

test('parseJson: finds the object in surrounding text and drops <think> blocks', () => {
  assert.deepEqual(parseJson('Sure! {"a": 1} done'), { a: 1 });
  assert.deepEqual(parseJson('<think>maybe {"x": 0} first</think>\n{"a": 2}'), { a: 2 });
  assert.deepEqual(parseJson('```json\n{"a": {"b": 3}}\n```'), { a: { b: 3 } });
});

test('parseJson: no object is an error', () => {
  assert.throws(() => parseJson('nothing here'), /no JSON object/);
  assert.throws(() => parseJson('<think>{"a":1}</think>'), /no JSON object/);
  assert.throws(() => parseJson('{broken'), /no JSON object/);
  assert.throws(() => parseJson('{"a": }'), SyntaxError);
});

const good = (extra = {}) => ({
  merchant: ' Target ', store_clues: ['target.com'], date_as_printed: '10/26/26', date: '2026-10-26', currency: 'USD',
  subtotal: 10, tax: 0.8, tip: null, total: 10.8, payment_method: ' Visa ', cash_tendered: null, card_last4: '1234', is_return: false,
  items: [{ description: ' Milk ', plain: 'milk', amount: 4.5 }, { description: 'Eggs', plain: 'eggs', amount: 6.3 }],
  ...extra,
});

test('checkReceipt: a good reading comes back normalized', () => {
  const r = checkReceipt(good());
  assert.equal(r.merchant, ' Target '); // NOTE: the merchant is checked but not trimmed
  assert.equal(r.payment_method, 'visa');
  assert.equal(r.items[0].description, 'Milk');
  assert.equal(r.total, 10.8);
});

test('checkReceipt: money given as strings becomes numbers (a "$16.00" must not become NaN)', () => {
  const r = checkReceipt(good({ total: '$10.80', subtotal: '10.00', tax: '0.80', items: [{ description: 'a', plain: 'a', amount: '$10.00' }] }));
  assert.equal(r.total, 10.8);
  assert.equal(r.subtotal, 10);
  assert.equal(r.tax, 0.8);
  assert.equal(r.items[0].amount, 10);
});

test('checkReceipt: unreadable optional amounts become null; a bad total throws', () => {
  const r = checkReceipt(good({ subtotal: 'n/a', tax: undefined, tip: '', cash_tendered: 'x' }));
  assert.deepEqual([r.subtotal, r.tax, r.tip, r.cash_tendered], [null, null, null, null]);
  assert.throws(() => checkReceipt(good({ total: 'free' })), /bad total/);
});

test('checkReceipt: card_last4 as a number becomes a string; blank becomes null', () => {
  assert.equal(checkReceipt(good({ card_last4: 1234 })).card_last4, '1234');
  assert.equal(checkReceipt(good({ card_last4: '  ' })).card_last4, null);
  assert.equal(checkReceipt(good({ card_last4: undefined })).card_last4, null);
});

test('checkReceipt: blank dates become null and are not parsed here', () => {
  const r = checkReceipt(good({ date: '', date_as_printed: '  ' }));
  assert.deepEqual([r.date, r.date_as_printed], [null, null]);
  assert.equal(checkReceipt(good({ date: 'garbage' })).date, 'garbage');
});

test('checkReceipt: store clues keep names and domains, not codes or logins', () => {
  const r = checkReceipt(good({ store_clues: ['target.com', 'Survey password: abc', 'User ID 12', 'call 5155551234', '', 5, 'PIN 4', 'Circle'] }));
  assert.deepEqual(r.store_clues, ['target.com', 'Circle']);
  assert.deepEqual(checkReceipt(good({ store_clues: 'x' })).store_clues, []);
});

test('checkReceipt: is_return is true only for true or "true"', () => {
  assert.equal(checkReceipt(good({ is_return: true })).is_return, true);
  assert.equal(checkReceipt(good({ is_return: 'true' })).is_return, true);
  assert.equal(checkReceipt(good({ is_return: 'yes' })).is_return, false);
  assert.equal(checkReceipt(good({ is_return: undefined })).is_return, false);
});

test('checkReceipt: rejects what cannot be used', () => {
  assert.throws(() => checkReceipt(null), /not an object/);
  assert.throws(() => checkReceipt(good({ merchant: '  ' })), /no merchant/);
  assert.throws(() => checkReceipt(good({ merchant: 5 })), /no merchant/);
  assert.throws(() => checkReceipt(good({ items: [] })), /no line items/);
  assert.throws(() => checkReceipt(good({ items: 'x' })), /no line items/);
  assert.throws(() => checkReceipt(good({ items: [null] })), /bad item/);
  assert.throws(() => checkReceipt(good({ items: [{ description: ' ', amount: 1 }] })), /without a description/);
  assert.throws(() => checkReceipt(good({ items: [{ description: 'a', amount: 'free' }] })), /bad item amount/);
});

test('checkReceipt: "plain" is dropped unless READ_PLAIN_NAMES is on', async () => {
  // the test environment leaves READ_PLAIN_NAMES unset, which means off
  const r = checkReceipt(good());
  assert.equal('plain' in r.items[0], false);
  config.plainNames = true;
  try {
    const on = checkReceipt(good({ items: [{ description: 'MLK', plain: ' ', amount: 1 }, { description: 'EGG', plain: 'eggs', amount: 1 }] }));
    assert.deepEqual(on.items.map((i) => i.plain), ['MLK', 'eggs']); // a blank plain name falls back to the description
  } finally {
    config.plainNames = false;
  }
});
