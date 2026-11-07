// dates.js: parsing a printed receipt date and accepting it only when it is plausible next to the upload date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidates, resolveDate } from './dates.js';

test('parseCandidates: ISO dates', () => {
  assert.deepEqual(parseCandidates('2026-10-26'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('2026/1/5 3:14 PM'), ['2026-01-05']);
});

test('parseCandidates: US month/day/year, two or four digit year', () => {
  assert.deepEqual(parseCandidates('10/26/26 3:14 PM'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('10-26-2026'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('1.5.26'), ['2026-01-05']);
});

test('parseCandidates: day/month only when the first number cannot be a month', () => {
  assert.deepEqual(parseCandidates('31/10/26'), ['2026-10-31']);
  // 12/01/26 stays December 1, never January 12
  assert.deepEqual(parseCandidates('12/01/26'), ['2026-12-01']);
});

test('parseCandidates: month names', () => {
  assert.deepEqual(parseCandidates('Oct 26, 2026'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('October 26 2026'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('26 Oct 2026'), ['2026-10-26']);
  assert.deepEqual(parseCandidates('26 Sept. 2026'), ['2026-09-26']);
});

test('parseCandidates: invalid dates and empty input', () => {
  assert.deepEqual(parseCandidates('13/40/26'), []);
  assert.deepEqual(parseCandidates('02/30/2026'), []);
  assert.deepEqual(parseCandidates('Foo 26, 2026'), []);
  assert.deepEqual(parseCandidates(''), []);
  assert.deepEqual(parseCandidates(null), []);
});

test('parseCandidates: an ISO date is not also read as a US date', () => {
  assert.deepEqual(parseCandidates('2026-10-26'), ['2026-10-26']);
});

const anchor = new Date('2026-11-06T15:00:00Z');

test('resolveDate: a plausible printed date wins', () => {
  assert.deepEqual(resolveDate({ date_as_printed: '11/05/26', date: '2025-01-01' }, anchor), { date: '2026-11-05', note: null });
});

test('resolveDate: the window runs from 1 day after the upload back to 400 days before', () => {
  assert.equal(resolveDate({ date_as_printed: '2026-11-07' }, anchor).date, '2026-11-07');
  assert.equal(resolveDate({ date_as_printed: '2026-11-08' }, anchor).date, null);
  assert.equal(resolveDate({ date_as_printed: '2025-10-02' }, anchor).date, '2025-10-02'); // 400 days
  assert.equal(resolveDate({ date_as_printed: '2025-10-01' }, anchor).date, null); // 401 days
});

test("resolveDate: falls back to the model's own date when the printed text is unusable", () => {
  assert.deepEqual(resolveDate({ date_as_printed: 'garbled', date: '2026-11-01' }, anchor), { date: '2026-11-01', note: null });
  assert.deepEqual(resolveDate({ date_as_printed: null, date: '2026-11-01' }, anchor), { date: '2026-11-01', note: null });
});

test('resolveDate: no date at all', () => {
  assert.deepEqual(resolveDate({}, anchor), { date: null, note: 'no purchase date on the receipt' });
  assert.deepEqual(resolveDate({ date_as_printed: 'garbled', date: null }, anchor), { date: null, note: 'no purchase date on the receipt' });
});

test('resolveDate: an implausible date is ignored with a note naming it', () => {
  assert.deepEqual(resolveDate({ date_as_printed: '03/04/2020', date: '2020-03-04' }, anchor), { date: null, note: 'ignored implausible date "03/04/2020"' });
  // the model's date is quoted when nothing was printed
  assert.deepEqual(resolveDate({ date: '2020-03-04' }, anchor), { date: null, note: 'ignored implausible date "2020-03-04"' });
});
