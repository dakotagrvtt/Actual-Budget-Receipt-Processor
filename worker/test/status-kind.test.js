// status-kind.js and receipt-lists.js withSeen: a receipt Actual shows reviewed (#review removed) is Done, not "check it in Actual".
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { statusKind } from '../src/status-kind.js';
import { mainList, withSeen } from '../src/receipt-lists.js';

const { processed, review } = config.nextcloud;
const flagged = { done: true, result: 'split+review', applied: { txnId: 't1', action: 'split' }, filedAs: `${review}/a.jpg`, at: '2026-11-01T10:00:00Z' };

test('statusKind: split+review is applied-review, and Done once it is marked reviewed', () => {
  assert.equal(statusKind({ key: 'in/a.jpg@1', ...flagged }), 'applied-review');
  assert.equal(statusKind({ key: 'in/a.jpg@1', ...flagged, reviewed: { at: 'x' } }), 'done');
  // other kinds are unchanged by the flag
  assert.equal(statusKind({ key: 'k', done: true, result: 'review', filedAs: `${review}/a.jpg`, reviewed: true }), 'review');
  assert.equal(statusKind({ key: 'k', done: true, result: 'failed', applied: { txnId: 't1' }, reviewed: true }), 'failed-applied');
  assert.equal(statusKind({ key: 'k', done: true, result: 'split', filedAs: `${processed}/a.jpg` }), 'done');
});

test('withSeen: only charges seen reviewed are marked, on a copy; the list then shows them as Done', () => {
  const state = { 'inbox/a.jpg@1': flagged, 'inbox/b.jpg@2': { ...flagged, applied: { txnId: 't2', action: 'split' } }, 'inbox/c.jpg@3': { done: true, result: 'split', applied: { txnId: 't3' } } };
  const seen = { t1: { at: '2026-11-08T10:00:00Z', reviewed: true }, t2: { at: 'x', reviewed: false }, t3: { at: 'y', reviewed: true } };
  const out = withSeen(state, seen);
  assert.deepEqual(out['inbox/a.jpg@1'].reviewed, { at: '2026-11-08T10:00:00Z' });
  assert.equal(out['inbox/b.jpg@2'].reviewed, undefined);
  assert.equal(state['inbox/a.jpg@1'].reviewed, undefined); // the saved state is not touched
  const kinds = Object.fromEntries(mainList(out, false).recent.map((r) => [r.file, statusKind(r)]));
  assert.deepEqual(kinds, { 'a.jpg': 'done', 'b.jpg': 'applied-review', 'c.jpg': 'done' });
  assert.deepEqual(withSeen(state, {}), state);
});

test('withSeen: a look at Actual from before the entry was last changed does not make it reviewed', () => {
  const state = { 'inbox/a.jpg@1': { ...flagged, at: '2026-11-05T00:00:00Z', fixedOnPage: { at: '2026-11-06T00:00:00Z' } } };
  assert.equal(withSeen(state, { t1: { at: '2026-11-04T00:00:00Z', reviewed: true } })['inbox/a.jpg@1'].reviewed, undefined);
  assert.equal(withSeen(state, { t1: { at: '2026-11-06T00:00:00Z', reviewed: true } })['inbox/a.jpg@1'].reviewed, undefined); // not later
  assert.deepEqual(withSeen(state, { t1: { at: '2026-11-07T00:00:00Z', reviewed: true } })['inbox/a.jpg@1'].reviewed, { at: '2026-11-07T00:00:00Z' });
  const restored = { 'inbox/a.jpg@1': { ...flagged, at: '2026-11-01T00:00:00Z', restoredAt: '2026-11-09T00:00:00Z' } };
  assert.equal(withSeen(restored, { t1: { at: '2026-11-08T00:00:00Z', reviewed: true } })['inbox/a.jpg@1'].reviewed, undefined);
});
