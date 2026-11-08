// dates.js: parsing a printed receipt date and accepting it only when it is plausible next to the upload date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidates, resolveDate, photoDateFromName, receiptAnchor } from './dates.js';

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

test('photoDateFromName: camera and upload-app names', () => {
  const lm = new Date('2026-11-07T10:00:00Z');
  for (const n of ['2026-11-05_101530.jpg', '2026-11-05 10.15.30.jpg', '20261105_101530.jpg', 'IMG_20261105_101530.jpg', 'PXL_20261105_101530123.jpg', 'Screenshot_2026-11-05-10-15-30.png']) {
    assert.equal(photoDateFromName(n, lm, lm), '2026-11-05', n);
  }
  assert.equal(photoDateFromName('receipt.jpg', lm, lm), null);
  assert.equal(photoDateFromName(undefined, lm, lm), null);
});

test('photoDateFromName: not a real date, after the upload day + 1, or too old is ignored', () => {
  const lm = new Date('2026-11-07T10:00:00Z');
  assert.equal(photoDateFromName('2026-13-45_101010.jpg', lm, lm), null);
  assert.equal(photoDateFromName('2026-11-08_101010.jpg', lm, lm), '2026-11-08'); // a day ahead: timezones
  assert.equal(photoDateFromName('2026-11-09_101010.jpg', lm, lm), null);
  assert.equal(photoDateFromName('2012-01-05_101010.jpg', lm, lm), null);
  assert.equal(photoDateFromName('IMG_1234567890123.jpg', lm, lm), null);
});

test('photoDateFromName: only known camera/app patterns with a time, and within 31 days before the upload', () => {
  const lm = new Date('2026-11-07T10:00:00Z');
  assert.equal(photoDateFromName('Order_2026-10-01.pdf', lm, lm), null);
  assert.equal(photoDateFromName('statement 2020-01-01-2026-11-01.pdf', lm, lm), null);
  assert.equal(photoDateFromName('2026-11-05.jpg', lm, lm), null); // no time part
  assert.equal(photoDateFromName('My receipt 2026-11-05_101530.jpg', lm, lm), null); // not at the start
  assert.equal(photoDateFromName('Invoice_2026-11-05_101530.jpg', lm, lm), null); // unknown prefix
  for (const n of ['img_20261105_101530.jpg', 'VID_20261105_101530.mp4', 'signal-2026-11-05-101530.jpg', 'PHOTO_2026-11-05_10-15-30.jpg', 'Screenshot-2026-11-05-10-15-30.png']) {
    assert.equal(photoDateFromName(n, lm, lm), '2026-11-05', n);
  }
  assert.equal(photoDateFromName('2026-10-07_101010.jpg', lm, lm), '2026-10-07'); // 31 days
  assert.equal(photoDateFromName('2026-10-06_101010.jpg', lm, lm), null); // 32 days
});

test('receiptAnchor: the earlier of the photo day and the upload; only a photo day before the upload day is strict', () => {
  const lm = new Date('2026-11-07T10:00:00Z');
  const a = receiptAnchor('2026-11-05_101530.jpg', lm);
  assert.deepEqual([a.fromName, a.slackDays, a.date.toISOString()], [true, 0, '2026-11-05T00:00:00.000Z']);
  const same = receiptAnchor('2026-11-07_011738.jpg', lm);
  assert.deepEqual([same.fromName, same.slackDays, same.date], [false, 0, lm]);
  const ahead = receiptAnchor('2026-11-08_011738.jpg', lm);
  assert.deepEqual([ahead.fromName, ahead.slackDays, ahead.date], [false, 1, lm]);
  assert.deepEqual([receiptAnchor('x.jpg', lm).fromName, receiptAnchor('x.jpg', lm).slackDays], [false, 1]);
});

test('resolveDate: a misread date after the photo day is rejected without slack, accepted with it', () => {
  const r = { date_as_printed: '11/07/2026' };
  const anchor = new Date('2026-11-05T00:00:00Z');
  assert.equal(resolveDate(r, anchor, { slackDays: 0 }).date, null);
  assert.equal(resolveDate({ date_as_printed: '11/06/2026' }, anchor).date, '2026-11-06');
  assert.equal(resolveDate({ date_as_printed: '11/05/2026' }, anchor, { slackDays: 0 }).date, '2026-11-05');
});
