// Matching a receipt to its bank charge (match.js). The Actual API and webdav are replaced by empty stand-ins (see test/support.js).
import './support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

const { chargeDeadline, unmatchable, pickMatch, findMatch } = await import('../src/match.js');
const { default: api } = await import('@actual-app/api');

const DAY = 86400000;
const saved = JSON.parse(JSON.stringify(config.match));
afterEach(() => {
  mock.restoreAll();
  Object.assign(config.match, JSON.parse(JSON.stringify(saved)));
});

// ---- chargeDeadline ----
test('chargeDeadline: a dated receipt waits through the day after the search window', () => {
  const date = '2026-10-26';
  const until = chargeDeadline(date, new Date('2026-10-27T12:00:00Z'));
  assert.equal(until.toISOString(), new Date(Date.parse(`${date}T00:00:00Z`) + (config.match.days + 2) * DAY).toISOString());
  assert.equal(until.toISOString(), '2026-11-01T00:00:00.000Z'); // MATCH_DAYS=4
});

test('chargeDeadline: an undated receipt waits MATCH_DAYS + 1 days after the upload', () => {
  const anchor = new Date('2026-10-27T12:00:00Z');
  assert.equal(chargeDeadline(null, anchor).toISOString(), '2026-11-01T12:00:00.000Z');
});

test('chargeDeadline: a pending charge gets MATCH_PENDING_WAIT_DAYS more', () => {
  assert.equal(chargeDeadline('2026-10-26', new Date(), true).toISOString(), '2026-11-03T00:00:00.000Z');
  assert.equal(chargeDeadline(null, new Date('2026-10-27T12:00:00Z'), true).toISOString(), '2026-11-03T12:00:00.000Z');
});

// ---- unmatchable ----
test('unmatchable: refunds, missing totals and cash have nothing to match', () => {
  assert.match(unmatchable({ total: 5, is_return: true }), /return\/refund/);
  assert.match(unmatchable({ total: -5 }), /return\/refund/);
  assert.equal(unmatchable({ total: 0 }), 'total is missing or not positive');
  assert.equal(unmatchable({ total: undefined }), 'total is missing or not positive');
  assert.equal(unmatchable({ total: 14.53, payment_method: 'cash', cash_tendered: 20 }), "paid in cash (20.00 handed over), so there's no bank charge of 14.53 to match; use Create in Actual on this receipt's page, or Archive it if you entered it by hand");
  assert.equal(unmatchable({ total: 14.53, payment_method: 'cash' }), "paid in cash, so there's no bank charge of 14.53 to match; use Create in Actual on this receipt's page, or Archive it if you entered it by hand");
});

test('unmatchable: an ordinary card receipt is fine', () => {
  assert.equal(unmatchable({ total: 14.53, payment_method: 'visa' }), null);
  assert.equal(unmatchable({ total: 14.53, payment_method: 'debit with cash back' }), null);
});

// ---- pickMatch ----
const cand = (id, payeeScore, extra = {}) => ({ id, date: '2026-10-26', amount: -1000, payeeName: id, payeeScore, extraCents: 0, days: 0, accountName: 'Checking', ...extra });
const receipt = { merchant: 'Joes Pizza' };

test('pickMatch: one candidate with a good payee score is the match', () => {
  const c = cand('a', 0.9);
  assert.deepEqual(pickMatch(receipt, [c]), { txn: c });
});

test('pickMatch: no candidate named like the merchant is a payee problem, and names them all', () => {
  const m = pickMatch(receipt, [cand('a', 0.2), cand('b', 0.3)]);
  assert.equal(m.kind, 'payee');
  assert.equal(m.candidates.length, 2);
  assert.match(m.problem, /no payee looks like "Joes Pizza"/);
  assert.match(m.problem, /payee score 0\.20/);
});

test('pickMatch: the clearly better payee wins when the gap is wide enough', () => {
  const best = cand('a', 0.95);
  assert.equal(pickMatch(receipt, [cand('b', 0.7), best]).txn, best);
});

test('pickMatch: candidates below PAYEE_MIN_SCORE are ignored', () => {
  const good = cand('a', 0.7);
  assert.equal(pickMatch(receipt, [cand('b', 0.5), good]).txn, good);
});

test('pickMatch: close scores are ambiguous and listed best first', () => {
  const m = pickMatch(receipt, [cand('a', 0.8), cand('b', 0.85, { extraCents: 0 })]);
  assert.equal(m.kind, 'ambiguous');
  assert.deepEqual(m.candidates.map((c) => c.id), ['b', 'a']);
  assert.match(m.problem, /more than one transaction matches/);
});

test('pickMatch: equal scores are ordered by the smaller tip, then the nearer date', () => {
  const m = pickMatch(receipt, [cand('far', 0.9, { days: 3 }), cand('tip', 0.9, { extraCents: 200 }), cand('near', 0.9, { days: 1 })]);
  assert.deepEqual(m.candidates.map((c) => c.id), ['near', 'far', 'tip']);
});

test("pickMatch: the card's last 4 digits break a tie when exactly one account name has them", () => {
  mock.method(console, 'log', () => {});
  const onCard = cand('a', 0.9, { accountName: 'Visa 4242' });
  const other = cand('b', 0.9, { accountName: 'Checking' });
  assert.equal(pickMatch({ ...receipt, card_last4: '4242' }, [other, onCard]).txn, onCard);
  assert.equal(pickMatch({ ...receipt, card_last4: ' 4242 ' }, [other, onCard]).txn, onCard);
  assert.equal(pickMatch({ ...receipt, card_last4: '9999' }, [other, onCard]).kind, 'ambiguous');
  assert.equal(pickMatch({ ...receipt, card_last4: 4242 }, [other, onCard]).kind, 'ambiguous'); // a number is not a usable last 4
  const both = [cand('a', 0.9, { accountName: 'Visa 4242' }), cand('b', 0.9, { accountName: 'Mastercard 4242' })];
  assert.equal(pickMatch({ ...receipt, card_last4: '4242' }, both).kind, 'ambiguous');
});

// ---- findMatch: an undated receipt and an older, unique exact-amount charge ----
const fakeBank = (txns) => {
  mock.method(console, 'log', () => {});
  mock.method(api, 'getAccounts', async () => [{ id: 'a1', name: 'Checking' }]);
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Menards' }, { id: 'p2', name: 'Menards Online' }, { id: 'p3', name: 'Shell' }]);
  mock.method(api, 'getTransactions', async (id, start, end) => txns.filter((t) => t.date >= start && t.date <= end));
};
const old = (id, date, extra = {}) => ({ id, date, amount: -4217, payee: 'p1', ...extra });
const undated = { merchant: 'Menards', total: 42.17 };
const anchor = new Date('2026-11-07T10:00:00Z');
const after = new Date('2026-11-13T00:00:00Z'); // past the undated wait (anchor + MATCH_DAYS + 1)
const before = new Date('2026-11-08T00:00:00Z');

test('findMatch: an undated receipt with no recent charge uses the only exact-amount charge at the store in the extended days', async () => {
  fakeBank([old('t1', '2026-10-09'), old('other-store', '2026-09-20', { payee: 'p3' })]);
  const m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn.id, 't1');
  assert.equal(m.waitable, undefined);
  assert.deepEqual(m.doubts, []);
  assert.match(m.matchDoubts.join(), /undated receipt: using the only exact-amount charge at this store in the 120 days before the photo: 2026-10-09/);
});

test('findMatch: a second plausible charge, a tip-sized difference or the setting at 0 keeps the old behaviour', async () => {
  fakeBank([old('t1', '2026-10-09'), old('t2', '2026-09-01', { payee: 'p2' })]);
  let m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
  assert.equal(m.waitable, true);
  fakeBank([old('t1', '2026-10-09', { amount: -11600 })]);
  config.match.tolerancePercent = 10;
  m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
  fakeBank([old('t1', '2026-10-09')]);
  config.match.noDateExtendedDays = 0;
  m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
  assert.equal(m.kind, 'older');
  assert.match(m.problem, /an older charge matches, check it: 2026-10-09/);
});

test('findMatch: beyond the extended days, or in an account outside MATCH_ACCOUNTS, nothing is used', async () => {
  fakeBank([old('t1', '2026-06-01')]);
  assert.equal((await findMatch(undated, null, anchor, { now: after })).txn, undefined);
  fakeBank([old('t1', '2026-10-09')]);
  config.match.accounts = ['Savings'];
  assert.equal((await findMatch(undated, null, anchor, { now: after })).txn, undefined);
});

test('findMatch: an existing charge of the exact amount in the recent days is the normal undated match', async () => {
  fakeBank([old('t1', '2026-10-09'), old('t2', '2026-11-03')]);
  const m = await findMatch(undated, null, anchor, {});
  assert.equal(m.txn.id, 't2');
  assert.match(m.doubts.join(), /no readable date/);
});

test('findMatch: the extended search waits until the undated deadline has passed', async () => {
  fakeBank([old('t1', '2026-10-09')]);
  let m = await findMatch(undated, null, anchor, { now: before });
  assert.equal(m.txn, undefined);
  assert.equal(m.waitable, true);
  assert.equal(m.kind, 'older'); // the usual hint
  m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn.id, 't1');
  m = await findMatch(undated, null, anchor, { replay: true, now: before }); // replay never waits
  assert.equal(m.txn.id, 't1');
});

test('findMatch: a charge near the photo date (even one that posted late) blocks the extended match', async () => {
  fakeBank([old('t1', '2026-10-09'), old('late', '2026-11-10')]);
  let m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
  fakeBank([old('t1', '2026-10-09'), old('wrong-name', '2026-11-09', { payee: 'p3' })]);
  m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
});

test('findMatch: a tip-sized rival with a fitting payee blocks the extended match', async () => {
  config.match.tolerancePercent = 10;
  fakeBank([old('t1', '2026-10-09'), old('tip', '2026-09-01', { amount: -4630, payee: 'p2' })]);
  const m = await findMatch(undated, null, anchor, { now: after });
  assert.equal(m.txn, undefined);
  assert.equal(m.waitable, true);
});
