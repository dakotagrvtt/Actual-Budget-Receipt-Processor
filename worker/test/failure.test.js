// What the poll loop does with each kind of error: setup problem, counted paid-call failure, outage, failed attempt.
import './support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { TransientError, PermanentError, SetupError, SkipReceiptError, markCounted } from '../src/errors.js';

const { classifyFailure } = await import('../src/failure.js');
const { failedEntry, countFailure, clearFailureCounts, MAX_TRANSIENT_CYCLES, MAX_IMAGE_SKIPS } = await import('../src/state.js');
const { processReceipt, currentReader } = await import('../src/receipt.js');
const { default: api } = await import('@actual-app/api');

afterEach(() => mock.restoreAll());

const counted = (by = 'reader', message = 'reader HTTP 504: gateway timeout') => markCounted(new TransientError(message), by);

test('a counted failure adds to the receipt count and stores the message; an outage counts nothing and clears the count', () => {
  const first = classifyFailure(counted(), { attempts: 0 }, 0);
  assert.deepEqual([first.kind, first.giveUp, first.entry.transientFails, first.entry.error, first.stop, first.troubles], ['counted', false, 1, 'reader HTTP 504: gateway timeout', false, 1]);
  const outage = classifyFailure(new TransientError('reader HTTP 503 after 4 tries: busy'), first.entry, 0);
  assert.equal(outage.kind, 'outage');
  assert.equal(outage.stop, true);
  assert.equal(outage.entry.transientFails, undefined, 'only consecutive failures count');
  assert.equal(outage.troubles, 0);
});

test('three counted failures in a row give up, and the give-up counts toward stopping the check', () => {
  let entry = {};
  let last;
  for (let n = 1; n <= MAX_TRANSIENT_CYCLES; n++) {
    last = classifyFailure(counted(), entry, 0);
    entry = last.entry;
    assert.equal(last.giveUp, n === MAX_TRANSIENT_CYCLES);
  }
  assert.equal(last.count, MAX_TRANSIENT_CYCLES);
  // earlier in the same check another receipt already had a counted failure: this give-up is the second, so the check stops
  assert.equal(classifyFailure(counted(), { transientFails: 2 }, 1).stop, true);
  assert.equal(classifyFailure(counted(), { transientFails: 2 }, 0).stop, false);
  assert.equal(classifyFailure(counted(), {}, 1).stop, true, 'a second plain counted failure stops it too');
});

test('reader and decider failures have their own counters; the other one starts over', () => {
  const r = classifyFailure(counted('reader'), {}, 0).entry;
  const d = classifyFailure(counted('decider'), r, 0);
  assert.equal(d.by, 'decider');
  assert.deepEqual([d.entry.deciderFails, d.entry.transientFails], [1, undefined]);
  assert.equal(countFailure(d.entry, 'decider').count, 2);
});

test('setup problems and ordinary errors count nothing and clear the counts; a failed attempt is a failed attempt', () => {
  const s = classifyFailure(new SetupError('key refused'), { transientFails: 2, deciderFails: 1, reading: { a: 1 } }, 0);
  assert.deepEqual([s.kind, s.stop, s.entry.transientFails, s.entry.deciderFails, s.entry.reading], ['setup', true, undefined, undefined, { a: 1 }]);
  const a = classifyFailure(new PermanentError('no total'), { transientFails: 2 }, 0);
  assert.deepEqual([a.kind, a.stop, a.entry.transientFails], ['attempt', false, undefined]);
  assert.equal(classifyFailure(new Error('boom'), {}, 0).kind, 'attempt');
});

test('failedEntry keeps the hosted decider\'s paid answers (and the cloud reader\'s reading) for the retry, and drops the counters', () => {
  const prev = { transientFails: 2, deciderFails: 1, reading: { receipt: {} }, deciderAnswers: { abc: { choice: 'C01' } } };
  const e = failedEntry(prev, 1, 'x', 'now', true, true);
  assert.deepEqual(e.deciderAnswers, { abc: { choice: 'C01' } });
  assert.ok(e.reading);
  assert.equal(e.transientFails, undefined);
  assert.equal(e.deciderFails, undefined);
  const local = failedEntry(prev, 1, 'x', 'now', false, false);
  assert.equal(local.deciderAnswers, undefined);
  assert.equal(local.reading, undefined);
  assert.deepEqual(clearFailureCounts(undefined), {});
});

// ---- the saved reading belongs to one reader ----
const reading = { merchant: 'Corner Shop', store_clues: [], date: null, currency: 'USD', total: 25, subtotal: 25, tax: null, tip: null, payment_method: null, cash_tendered: null, card_last4: null, is_return: false, items: [{ description: 'MILK', amount: 25 }] };
const item = { basename: 'a.jpg', filename: 'a.jpg', etag: 'e', lastmod: new Date().toUTCString() };
const withBudget = () => {
  mock.method(api, 'getAccounts', async () => []);
  mock.method(api, 'getPayees', async () => []);
};

test('processReceipt: a saved reading from another reader is dropped (the photo is read again); one from this reader is kept and does not clear the reader count (a failing cloud name scan keeps counting)', async () => {
  withBudget();
  const saved = { provider: config.reader.provider, host: config.reader.host, model: config.reader.model };
  Object.assign(config.reader, { provider: 'remote', host: 'api.one.test', model: 'm1' });
  try {
    const mine = { receipt: structuredClone(reading), mode: 'remote', reader: currentReader() };
    const entry = { reading: mine, transientFails: 2 };
    let asked = 0;
    const ctx = { state: {}, modelReady: async () => { asked++; throw new TransientError('would read again'); } };
    await processReceipt(item, new Map(), entry, ctx);
    assert.equal(asked, 0, 'no new reading');
    assert.equal(entry.transientFails, 2, 'reusing a reading is not a reader answer');
    // the same saved reading, but the reader is another host now
    config.reader.host = 'api.two.test';
    const entry2 = { reading: mine };
    await assert.rejects(processReceipt(item, new Map(), entry2, ctx), /would read again/);
    assert.equal(asked, 1);
    assert.equal(entry2.reading, undefined);
    // an old entry without a reader stamp is kept
    const old = { reading: { receipt: structuredClone(reading), mode: 'remote' } };
    await processReceipt(item, new Map(), old, ctx);
    assert.equal(asked, 1);
  } finally {
    Object.assign(config.reader, saved);
  }
});

test('a cloud name scan that keeps timing out reaches the give-up threshold even though every attempt reuses the saved reading', async () => {
  withBudget();
  const saved = { provider: config.reader.provider, host: config.reader.host, model: config.reader.model };
  Object.assign(config.reader, { provider: 'remote', host: 'api.one.test', model: 'm1' });
  try {
    let entry = { reading: { receipt: structuredClone(reading), mode: 'remote', reader: currentReader() } };
    const ctx = { state: {}, modelReady: async () => { throw new Error('the photo must not be read again'); } };
    // the scan runs in the hosted decider, after the reading is reused; it times out through the reader
    const scanTimeout = new TransientError('name scan: reader timed out', { cause: markCounted(new TransientError('reader timed out'), 'reader') });
    const seen = [];
    for (let poll = 1; poll <= MAX_TRANSIENT_CYCLES; poll++) {
      await processReceipt(item, new Map(), entry, ctx); // reuses the reading; must not reset the count
      const f = classifyFailure(scanTimeout, entry, 0);
      assert.equal(f.kind, 'counted');
      assert.equal(f.by, 'reader');
      seen.push([f.count, f.giveUp]);
      entry = f.entry;
    }
    assert.deepEqual(seen, [[1, false], [2, false], [3, true]]);
    assert.ok(entry.reading, 'the saved reading is kept, so nothing is read again');
  } finally {
    Object.assign(config.reader, saved);
  }
});

test('currentReader: the cloud reader is provider, host and model; the local reader has no host', () => {
  const saved = { ...config.reader };
  try {
    Object.assign(config.reader, { provider: 'remote', host: 'h.test', model: 'm' });
    assert.deepEqual(currentReader(), { provider: 'remote', host: 'h.test', model: 'm' });
    config.reader.provider = 'local';
    assert.deepEqual(currentReader(), { provider: 'local', host: null, model: config.llmName });
  } finally {
    Object.assign(config.reader, saved);
  }
});

test('a skipped receipt counts no attempt, pauses nothing and does not stop the check; the third skip in a row is a failed attempt', () => {
  const skip = () => new SkipReceiptError('the reader rejected this receipt\'s image (HTTP 400: unsupported image)');
  let entry = { attempts: 1 };
  for (let n = 1; n < MAX_IMAGE_SKIPS; n++) {
    const f = classifyFailure(skip(), entry, 0);
    assert.deepEqual([f.kind, f.stop, f.troubles, f.entry.imageSkips, f.entry.attempts], ['skip', false, 0, n, 1]);
    entry = f.entry;
  }
  const last = classifyFailure(skip(), entry, 0);
  assert.deepEqual([last.kind, last.stop], ['attempt', false]);
  // the count stays through the failed attempt, so the receipt is not skipped three more times
  const kept = failedEntry(last.entry, 2, 'x', 'now', true, false);
  assert.equal(kept.imageSkips, MAX_IMAGE_SKIPS);
  assert.equal(classifyFailure(skip(), kept, 0).kind, 'attempt');
  // anything else in between starts the run again
  assert.equal(classifyFailure(new Error('boom'), { imageSkips: 2 }, 0).entry.imageSkips, undefined);
  assert.equal(classifyFailure(new TransientError('down'), { imageSkips: 2 }, 0).entry.imageSkips, undefined);
  assert.equal(classifyFailure(new SetupError('key'), { imageSkips: 2 }, 0).entry.imageSkips, undefined);
});
