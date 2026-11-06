import test from 'node:test';
import assert from 'node:assert/strict';
import { usHolidays, occasionsNear } from './calendar.js';

const date = (year, name) => usHolidays(year).find((h) => h.name === name).date;

test('usHolidays 2026', () => {
  assert.equal(date(2026, "Valentine's Day"), '2026-02-14');
  assert.equal(date(2026, 'Easter'), '2026-04-05');
  assert.equal(date(2026, "Mother's Day"), '2026-05-10');
  assert.equal(date(2026, "Father's Day"), '2026-06-21');
  assert.equal(date(2026, 'Halloween'), '2026-10-31');
  assert.equal(date(2026, 'Thanksgiving'), '2026-11-26');
  assert.equal(date(2026, 'Christmas'), '2026-12-25');
  assert.ok(usHolidays(2026).every((h) => h.source === 'US holiday'));
});

test('usHolidays: other years (Easter and the weekday rules)', () => {
  assert.equal(date(2025, 'Easter'), '2025-04-20');
  assert.equal(date(2024, 'Easter'), '2024-03-31');
  assert.equal(date(2025, 'Thanksgiving'), '2025-11-27');
  assert.equal(date(2025, "Mother's Day"), '2025-05-11');
  assert.equal(date(2025, "Father's Day"), '2025-06-15');
});

test('occasionsNear: a holiday soon after the purchase', async () => {
  assert.deepEqual(await occasionsNear('2026-06-18'), ["Father's Day (US holiday) on 2026-06-21, 3 day(s) after the purchase"]);
});

test('occasionsNear: the day of, and a holiday just before the purchase', async () => {
  assert.deepEqual(await occasionsNear('2026-10-31'), ['Halloween (US holiday) on 2026-10-31, the day of the purchase']);
  assert.deepEqual(await occasionsNear('2026-11-01'), ['Halloween (US holiday) on 2026-10-31, 1 day(s) before the purchase']);
});

test('occasionsNear: outside OCCASION_DAYS_BEFORE / OCCASION_DAYS_AFTER nothing is near', async () => {
  assert.deepEqual(await occasionsNear('2026-06-01'), []); // 20 days before Father's Day; the window is 14
  assert.deepEqual(await occasionsNear('2026-06-24'), []); // 3 days after; the window is 2
});

test('occasionsNear: a holiday later in the same month', async () => {
  assert.deepEqual(await occasionsNear('2026-12-20'), ['Christmas (US holiday) on 2026-12-25, 5 day(s) after the purchase']);
});

test('occasionsNear: no date, no occasions', async () => {
  assert.deepEqual(await occasionsNear(null), []);
});
