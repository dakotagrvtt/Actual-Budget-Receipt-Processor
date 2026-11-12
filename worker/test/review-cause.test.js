import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCause } from '../src/review-cause.js';
const entry = { done: true, result: 'review' };
test('review groups distinguish cash, bank matching, reading, category and service work', () => {
  for (const [summary, cause] of [
    [{ receipt: { payment_method: 'cash', total: 10 } }, 'cash'],
    [{ problems: ['no transaction of 12.00 found'] }, 'matching'],
    [{ problems: ['line items add up to 12 but printed subtotal is 10'] }, 'reading'],
    [{ transaction: { id: 't1' }, problems: ['unsure about item'] }, 'category'],
    [{ receipt: { is_return: true } }, 'return'],
  ]) assert.equal(reviewCause(entry, summary).cause, cause);
  assert.equal(reviewCause({ ...entry, result: 'failed' }).cause, 'service');
  assert.equal(reviewCause({ ...entry, waiting: {} }).cause, 'matching');
});
test('reviewed receipts leave review groups; uncertain operations keep a repair reason', () => {
  assert.equal(reviewCause({ ...entry, reviewed: {} }), null);
  assert.equal(reviewCause({ done: true, result: 'confirm' }), null);
  assert.equal(reviewCause({ ...entry, creating: { id: 'new' } }).cause, 'service');
  assert.equal(reviewCause({ ...entry, resolutionPending: {} }).cause, 'service');
  assert.equal(reviewCause({ ...entry, review: { cause: 'matching', reason: 'Choose charge' } }).cause, 'matching');
});
