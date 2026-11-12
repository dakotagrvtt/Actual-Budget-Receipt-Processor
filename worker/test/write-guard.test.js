// Re-checking a charge right before a write, and a re-used receipt file name. Actual is a fake (test/support.js).
import './support.js';
import test, { mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { shiftDay, today } from '../src/dates.js';

const { default: api } = await import('@actual-app/api');
const actual = await import('../src/actual.js');
const { applyPlan, processReceipt } = await import('../src/receipt.js');
const { txnIdsAppliedUnderName, stateKey } = await import('../src/state.js');

const saved = { dryRun: config.dryRun };
beforeEach(() => {
  config.dryRun = false;
});
afterEach(() => {
  mock.restoreAll();
  delete api.sync;
  config.dryRun = saved.dryRun;
});

const day = (n) => shiftDay(today(), n);
const matched = (over = {}) => ({ id: 't1', account: 'a1', date: day(-1), amount: -1000, category: null, notes: '', is_parent: false, ...over });

/** A budget with these transactions; `sync` is recorded. Returns { writes, synced }. */
function fakeBudget(txns, accounts = [{ id: 'a1', name: 'Checking' }]) {
  const writes = [];
  const synced = [];
  mock.method(api, 'getAccounts', async () => accounts);
  mock.method(api, 'getPayees', async () => []);
  mock.method(api, 'getTransactions', async (id, start, end) => txns.filter((t) => t.account === id && t.date >= start && t.date <= end).map((t) => structuredClone(t)));
  api.sync = async () => synced.push(true);
  mock.method(api, 'updateTransaction', async (id, fields) => void writes.push({ id, fields }));
  return { writes, synced };
}

const allocation = [
  { label: 'Daily / Groceries', categoryId: 'c1', cents: 600, items: ['MILK'] },
  { label: 'Daily / Sam', categoryId: 'c2', cents: 400, items: ['GUM'] },
];
const plan = (txn, action = 'split') => ({ item: { basename: 'a.jpg' }, txn, allocation, action, flags: [], currentLabel: null, summary: { plan: { applied: true }, problems: [] }, receipt: { items: [] } });

test('changedSince: identity, clearing, category, notes and split state are compared', () => {
  const m = matched();
  assert.match(actual.changedSince(m, { ...m, cleared: true, date: day(0), payee: 'x' }), /date|payee/);
  assert.equal(actual.changedSince({ ...m, notes: null }, { ...m, notes: '' }), null); // missing and empty are the same
  assert.match(actual.changedSince(m, null), /no longer/);
  assert.match(actual.changedSince(m, { ...m, account: 'a2' }), /another account/);
  assert.match(actual.changedSince(m, { ...m, amount: -1100 }), /amount/);
  assert.match(actual.changedSince(m, { ...m, category: 'c9' }), /category/);
  assert.match(actual.changedSince(m, { ...m, notes: 'x' }), /notes/);
  assert.match(actual.changedSince(m, { ...m, is_parent: true, subtransactions: [] }), /split/);
  const parent = matched({ is_parent: true, subtransactions: [{ amount: -1000, category: 'c1', notes: '' }] });
  assert.match(actual.changedSince(parent, { ...parent, subtransactions: [{ amount: -1000, category: 'c2', notes: '' }] }), /split/);
});

test('applyPlan: unchanged since matched: syncs, then writes', async () => {
  const { writes, synced } = fakeBudget([matched()]);
  const out = await applyPlan(plan(matched()));
  assert.equal(synced.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(out.result, 'split');
  assert.ok(out.applied);
});

for (const [what, edit] of [
  ['category set', { category: 'c9' }],
  ['notes edited', { notes: 'mine' }],
  ['amount changed', { amount: -1200 }],
  ['made a split by hand', { is_parent: true, subtransactions: [{ amount: -1000, category: 'c1', notes: '' }] }],
]) {
  test(`applyPlan: ${what} meanwhile: nothing is written, the receipt goes to review`, async () => {
    const { writes } = fakeBudget([matched(edit)]);
    for (const action of ['split', 'categorize', 'confirm', 'note']) {
      const out = await applyPlan(plan(matched(), action));
      assert.equal(writes.length, 0, action);
      assert.equal(out.result, 'review');
      assert.equal(out.folder, config.nextcloud.review);
      assert.equal(out.applied, undefined);
      assert.ok(out.summary.problems.includes(actual.CHANGED_MEANWHILE));
      assert.equal(out.summary.plan.applied, false);
    }
  });
}

test('applyPlan: moved to an account outside MATCH_ACCOUNTS, or to a closed or off-budget one, meanwhile: nothing is written, the receipt goes to review', async () => {
  const savedAccounts = config.match.accounts;
  const accounts = [{ id: 'a1', name: 'Checking' }, { id: 'a2', name: 'Savings' }, { id: 'a3', name: 'Old', closed: true }, { id: 'a4', name: 'Broker', offbudget: true }];
  try {
    for (const [moved, searched] of [['a2', ['Checking']], ['a3', []], ['a4', []]]) {
      config.match.accounts = searched;
      const { writes } = fakeBudget([matched({ account: moved })], accounts);
      const out = await applyPlan(plan(matched()));
      assert.equal(writes.length, 0, moved);
      assert.equal(out.result, 'review', moved);
      assert.ok(out.summary.problems.includes(actual.CHANGED_MEANWHILE), moved);
      assert.equal(out.summary.plan.applied, false);
      mock.restoreAll();
    }
    // moved to another account that matching would also search: still a change, nothing written
    config.match.accounts = [];
    const { writes } = fakeBudget([matched({ account: 'a2' })], accounts);
    assert.equal((await applyPlan(plan(matched()))).result, 'review');
    assert.equal(writes.length, 0);
    mock.restoreAll();
    // left in an account that MATCH_ACCOUNTS names: written
    config.match.accounts = ['Checking'];
    const again = fakeBudget([matched()], accounts);
    assert.equal((await applyPlan(plan(matched()))).result, 'split');
    assert.equal(again.writes.length, 1);
  } finally {
    config.match.accounts = savedAccounts;
  }
});

test('applyPlan: a transaction that is gone, or an unreachable server, writes nothing', async () => {
  const { writes } = fakeBudget([]);
  assert.equal((await applyPlan(plan(matched()))).result, 'review');
  api.sync = async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(() => applyPlan(plan(matched())), (err) => err.name === 'TransientError');
  assert.equal(writes.length, 0);
});

test('applyPlan: a bank moving the date invalidates the match', async () => {
  const { writes } = fakeBudget([matched({ date: day(-4) })]);
  assert.equal((await applyPlan(plan(matched()))).result, 'review');
  assert.equal(writes.length, 0);
});

test('applyPlan: dry run reads and writes nothing', async () => {
  const { writes, synced } = fakeBudget([matched({ category: 'c9' })]);
  config.dryRun = true;
  const out = await applyPlan(plan(matched()));
  assert.equal(out.result, 'dry-run:split');
  assert.equal(writes.length, 0);
  assert.equal(synced.length, 0);
});

// ---- a re-used file name ----
const rec = (over = {}) => ({ done: true, result: 'split', ...over });

test('txnIdsAppliedUnderName: transactions applied under another etag of the same name, live and dry kept apart', () => {
  const state = {
    'a.jpg@e1': rec({ applied: { txnId: 't1' } }), 'a.jpg@e3': { done: false, applied: { txnId: 't3' } }, 'a.jpg@e2': rec({ applied: { txnId: 'self' } }),
    'dry:b.jpg@e1': rec({ applied: { txnId: 't4' } }), 'c.jpg@e1': rec(), 'a.jpg.bak@e1': rec({ applied: { txnId: 't5' } }),
  };
  assert.deepEqual([...txnIdsAppliedUnderName(state, 'a.jpg@e2')].sort(), ['t1', 't3']); // not itself
  assert.deepEqual([...txnIdsAppliedUnderName(state, 'b.jpg@e2')], []); // only a dry-run entry
  assert.deepEqual([...txnIdsAppliedUnderName(state, 'dry:b.jpg@e2')], ['t4']);
  assert.deepEqual([...txnIdsAppliedUnderName(state, 'c.jpg@e2')], []); // finished but nothing applied
  assert.deepEqual([...txnIdsAppliedUnderName(undefined, 'a.jpg@e2')], []);
});

const tagged = (id, date, notes) => ({ id, account: 'a1', date, amount: -1000, notes, category: 'c1' });
const reading = { receipt: { merchant: 'Corner Shop', store_clues: [], date: day(-1), currency: 'USD', total: 25, subtotal: 25, tax: null, tip: null, payment_method: null, cash_tendered: null, card_last4: null, is_return: false, items: [{ description: 'MILK', amount: 25 }] }, mode: 'direct' };
const item = { basename: 'a.jpg', filename: 'a.jpg', etag: 'e2', lastmod: new Date().toUTCString() };
const labels = new Map([['Daily / Groceries', 'c1']]);

test('processReceipt: crash recovery still works for a file whose name is not in the state', async () => {
  fakeBudget([tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state: {} });
  assert.equal(out.summary.alreadyApplied, true);
  assert.equal(out.summary.transaction.id, 't9');
});

test('processReceipt: a tag that belongs to an earlier upload of the name (applied in the state) is left out: a new receipt', async () => {
  fakeBudget([tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const state = { 'a.jpg@e1': rec({ applied: { txnId: 't9' } }) };
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state });
  assert.notEqual(out.summary.alreadyApplied, true);
  assert.equal(stateKey(item), 'a.jpg@e2');
});

test('processReceipt: the same photo re-uploaded under the same name after a crash is still found by its tag', async () => {
  // t8 is the earlier upload's; t9 carries the tag and is not recorded anywhere: this photo's crash
  fakeBudget([tagged('t8', day(-30), '#receipt a.jpg'), tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const state = { 'a.jpg@e1': rec({ applied: { txnId: 't8' } }) };
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state });
  assert.equal(out.summary.alreadyApplied, true);
  assert.equal(out.summary.transaction.id, 't9');
  assert.equal(out.applied.txnId, 't9');
});

test('processReceipt: a tagged charge with the same amount and store is not taken as new when it is not recorded for the earlier upload', async () => {
  fakeBudget([tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state: { 'a.jpg@e1': rec() } });
  assert.equal(out.summary.alreadyApplied, true);
});

test('processReceipt: several tags left after leaving out the recorded ones: review, nothing written', async () => {
  const { writes } = fakeBudget([tagged('t7', day(-40), '#receipt a.jpg'), tagged('t8', day(-30), '#receipt a.jpg'), tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const state = { 'a.jpg@e1': rec({ applied: { txnId: 't7' } }) };
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state });
  assert.equal(out.result, 'review');
  assert.match(out.summary.problems[0], /2 transactions already carry/);
  assert.equal(writes.length, 0);
});

test('processReceipt: two transactions carry the name and the state is silent: no guess, review, nothing written', async () => {
  const { writes } = fakeBudget([tagged('t8', day(-30), '#receipt a.jpg'), tagged('t9', day(-3), '#receipt a.jpg | x')]);
  const out = await processReceipt(item, labels, { reading: structuredClone(reading) }, { state: {} });
  assert.equal(out.result, 'review');
  assert.match(out.summary.problems[0], /2 transactions already carry "#receipt a\.jpg"/);
  assert.equal(writes.length, 0);
});

// ---- Read again for a receipt still in the inbox (reread.js) ----

const newReading = () => ({ ...structuredClone(reading.receipt), items: [{ description: 'NEW MILK', amount: 25 }] });

test('processReceipt: Read again on a waiting receipt reads the photo afresh, keeps the old reading for Use old reading and clears the request', async () => {
  fakeBudget([]);
  const old = structuredClone(reading);
  const entry = { done: false, waiting: { reason: 'no charge yet', until: new Date(Date.now() + 86400000).toISOString() }, reading: old, reread: { at: 'x' } };
  let read = 0;
  const out = await processReceipt(item, labels, entry, { state: {}, modelReady: async () => {}, readPhoto: async () => { read++; return { receipt: newReading(), mode: 'test' }; } });
  assert.equal(read, 1);
  assert.equal(entry.reread, undefined);
  assert.equal(entry.reading.receipt.items[0].description, 'NEW MILK');
  assert.deepEqual(entry.previousReading.reading, old);
  assert.ok(entry.rereadAt);
  assert.ok(out.waiting || out.result);
});

test('processReceipt: Read again on a finished dry-run receipt reads the photo afresh and clears the request (no old reading to keep)', async () => {
  config.dryRun = true;
  fakeBudget([]);
  const entry = { done: true, result: 'dry-run:review', reread: { at: 'x' } };
  await processReceipt(item, labels, entry, { state: {}, modelReady: async () => {}, readPhoto: async () => ({ receipt: newReading(), mode: 'test' }) });
  assert.equal(entry.reread, undefined);
  assert.equal(entry.reading.receipt.items[0].description, 'NEW MILK');
  assert.equal(entry.previousReading, undefined);
});

test('processReceipt: if the model is not ready the request stays and the old reading is untouched', async () => {
  fakeBudget([]);
  const { TransientError } = await import('../src/errors.js');
  const old = structuredClone(reading);
  const entry = { done: false, waiting: { reason: 'x', until: 'y' }, reading: old, reread: { at: 'x' } };
  await assert.rejects(processReceipt(item, labels, entry, { state: {}, modelReady: async () => { throw new TransientError('asleep'); } }), /asleep/);
  assert.deepEqual(entry.reading, old);
  assert.deepEqual(entry.reread, { at: 'x' });
  // an outage while reading is thrown for the cycle to treat as one, and nothing is lost
  await assert.rejects(processReceipt(item, labels, entry, { state: {}, modelReady: async () => {}, readPhoto: async () => { throw new TransientError('reader HTTP 503'); } }), /503/);
  assert.deepEqual(entry.reading, old);
  assert.deepEqual(entry.reread, { at: 'x' });
});

test('processReceipt: a re-read that fails (an unusable answer) keeps the old reading and the waiting state, drops the request and leaves a note; the cycle would not count an attempt', async () => {
  fakeBudget([]);
  const old = structuredClone(reading);
  const waiting = { reason: 'x', until: new Date(Date.now() + 86400000).toISOString() };
  const entry = { done: false, attempts: 0, waiting, reading: old, reread: { at: 'x' } };
  const out = await processReceipt(item, labels, entry, { state: {}, modelReady: async () => {}, readPhoto: async () => { throw new Error('no line items'); } });
  assert.deepEqual(entry.reading, old);
  assert.equal(entry.reread, undefined);
  assert.match(entry.rereadNote.text, /Reading again did not work \(no line items\).*earlier reading was kept/);
  assert.equal(entry.previousReading, undefined);
  // the receipt went on with the old reading, and the waiting entry the cycle builds keeps the note
  assert.ok(out.waiting);
  const { waitingEntry } = await import('../src/index.js');
  const next = waitingEntry(entry, out.waiting, item.lastmod);
  assert.deepEqual(next.reading, old);
  assert.equal(next.attempts, 0);
  assert.equal(next.done, false);
  assert.equal(next.rereadNote.text, entry.rereadNote.text);
});

test('processReceipt: a re-read that times out is tried at the next check, up to three times, then dropped with a note; the old reading stays throughout', async () => {
  fakeBudget([]);
  const old = structuredClone(reading);
  const entry = { done: false, waiting: { reason: 'x', until: new Date(Date.now() + 86400000).toISOString() }, reading: old, reread: { at: 'x' } };
  const ctx = { state: {}, modelReady: async () => {}, readPhoto: async () => { throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); } };
  for (const tries of [1, 2]) {
    await processReceipt(item, labels, entry, ctx);
    assert.equal(entry.reread.tries, tries);
    assert.equal(entry.rereadNote, undefined);
  }
  await processReceipt(item, labels, entry, ctx);
  assert.equal(entry.reread, undefined);
  assert.match(entry.rereadNote.text, /timed out/);
  assert.deepEqual(entry.reading, old);
});
