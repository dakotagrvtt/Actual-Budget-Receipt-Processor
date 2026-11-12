// state.js: state keys, which files are due, and saving state. Uses a temp file, never /data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { isDue, stateKey, parseStateKey, loadState, saveState, forgetKeys, syncForgotten, failedEntry, giveUpEntry, replacedEntry, txnIdsAppliedUnderName, countReaderFailure, MAX_TRANSIENT_CYCLES } from '../src/state.js';

test('isDue: new, decided-but-not-moved and retrying files are due; done ones are not; waiting ones when their time is up or on a manual check', () => {
  assert.equal(isDue(undefined, 1000, false), true);
  assert.equal(isDue({ done: true }, 1000, true), false);
  assert.equal(isDue({ folder: 'x', waiting: { nextCheck: '2999-01-01' } }, 1000, false), true);
  assert.equal(isDue({ done: false, attempts: 1, error: 'x' }, 1000, false), true);
  const entry = { done: false, waiting: { nextCheck: new Date(5000).toISOString() } };
  assert.equal(isDue(entry, 4999, false), false);
  assert.equal(isDue(entry, 5000, false), true);
  assert.equal(isDue(entry, 1, true), true);
});

test('stateKey and parseStateKey round-trip, with the dry: prefix and the @etag', () => {
  const was = config.dryRun;
  try {
    const item = { filename: 'Inbox/receipt 1.jpg', etag: '"abc123"' };
    config.dryRun = false;
    assert.equal(stateKey(item), 'Inbox/receipt 1.jpg@"abc123"');
    assert.deepEqual(parseStateKey(stateKey(item)), { dry: false, file: 'Inbox/receipt 1.jpg' });
    config.dryRun = true;
    assert.equal(stateKey(item), 'dry:Inbox/receipt 1.jpg@"abc123"');
    assert.deepEqual(parseStateKey(stateKey(item)), { dry: true, file: 'Inbox/receipt 1.jpg' });
    // file names may contain '@'; etags don't, so split at the last one
    const odd = { filename: 'Inbox/me@home 2.jpg', etag: '"def"' };
    assert.deepEqual(parseStateKey(stateKey(odd)), { dry: true, file: 'Inbox/me@home 2.jpg' });
    config.dryRun = false;
    assert.deepEqual(parseStateKey(stateKey(odd)), { dry: false, file: 'Inbox/me@home 2.jpg' });
    assert.deepEqual(parseStateKey('a.jpg'), { dry: false, file: 'a.jpg' });
  } finally {
    config.dryRun = was;
  }
});

test('saveState and loadState use config.statePath; a missing file loads as empty', async () => {
  const was = config.statePath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-state-'));
  try {
    config.statePath = path.join(dir, 'state.json');
    assert.deepEqual(await loadState(), {});
    await saveState({ 'a.jpg@x': { done: true } });
    assert.deepEqual(await loadState(), { 'a.jpg@x': { done: true } });
    assert.deepEqual(await fs.readdir(dir), ['state.json']); // the temp file was renamed away
  } finally {
    config.statePath = was;
    await fs.rm(dir, { recursive: true });
  }
});

test('100 concurrent saves: none fails, the file is the last write, no temp files are left', async () => {
  const was = config.statePath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-state-'));
  try {
    config.statePath = path.join(dir, 'state.json');
    const saves = Array.from({ length: 100 }, (_, i) => saveState({ n: i, pad: 'x'.repeat(20000) }));
    const results = await Promise.allSettled(saves);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 0);
    assert.equal((await loadState()).n, 99);
    assert.deepEqual(await fs.readdir(dir), ['state.json']);
  } finally {
    config.statePath = was;
    await fs.rm(dir, { recursive: true });
  }
});

test('forgetKeys and saveState running together neither fail nor bring a forgotten key back', async () => {
  const was = config.statePath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-state-'));
  try {
    config.statePath = path.join(dir, 'state.json');
    await saveState({ 'a@1': { done: true }, 'b@1': { done: true } });
    await Promise.all([saveState({ 'a@1': { done: true }, 'b@1': { done: true } }), forgetKeys(['a@1']), saveState({ 'a@1': { done: true }, 'b@1': { done: true }, 'c@1': {} })]);
    const state = await loadState();
    assert.deepEqual(Object.keys(state).sort(), ['b@1', 'c@1']);
    syncForgotten(state);
  } finally {
    config.statePath = was;
    await fs.rm(dir, { recursive: true });
  }
});

/** Run fn with config.statePath pointing at a fresh temp dir. */
async function inTemp(fn) {
  const was = config.statePath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-state-'));
  try {
    config.statePath = path.join(dir, 'state.json');
    await fn(config.statePath, dir);
  } finally {
    config.statePath = was;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('loadState: only a missing file is an empty state; damaged, wrong-shaped or unreadable files throw', async () => {
  await inTemp(async (file) => {
    assert.deepEqual(await loadState(), {});
    for (const bad of ['{nope', '', '[]', 'null', '5']) {
      await fs.writeFile(file, bad);
      await assert.rejects(loadState(), /damaged|could not read/, JSON.stringify(bad));
    }
    await fs.rm(file);
    await fs.mkdir(file); // a directory: EISDIR
    await assert.rejects(loadState(), /could not read/);
  });
});

test('saveState and forgetKeys never write over a damaged state file; the bytes stay as they were', async () => {
  await inTemp(async (file, dir) => {
    await fs.writeFile(file, '{"a@1": {"done": tr'); // cut off mid-write by something else
    await assert.rejects(saveState({ 'x@1': {} }), /damaged/);
    await assert.rejects(forgetKeys(['a@1']), /damaged/);
    assert.equal(await fs.readFile(file, 'utf8'), '{"a@1": {"done": tr');
    assert.deepEqual(await fs.readdir(dir), ['state.json'], 'no temp file left');
    // the failed forget must not leave the key marked as forgotten: once the file is fixed, a save keeps it
    await fs.writeFile(file, '{}');
    await saveState({ 'a@1': { done: true } });
    assert.deepEqual(Object.keys(await loadState()), ['a@1']);
  });
});

test('failedEntry keeps what was applied (and where it goes) across a failed move; an unapplied entry is just the error', () => {
  const applied = { action: 'split', at: '2026-01-01T00:00:00Z' };
  const prev = { done: false, applied, result: 'split', folder: '/Receipts/Processed', summary: { file: 'r.jpg' }, at: 'x' };
  const e = failedEntry(prev, 1, 'webdav down', 'now');
  assert.deepEqual(e, { applied, result: 'split', folder: '/Receipts/Processed', summary: { file: 'r.jpg' }, done: false, attempts: 1, error: 'webdav down', at: 'now' });
  assert.deepEqual(failedEntry({ done: false, attempts: 1 }, 2, 'boom', 'now'), { done: false, attempts: 2, error: 'boom', at: 'now' });
  assert.deepEqual(failedEntry(undefined, 1, 'boom', 'now'), { done: false, attempts: 1, error: 'boom', at: 'now' });
});

test('giveUpEntry: an applied receipt says so in its summary and keeps `applied`', () => {
  const applied = { action: 'split' };
  const a = giveUpEntry('r.jpg', 3, 'nope', applied, '/Review');
  assert.deepEqual(a, { result: 'failed', folder: '/Review', summary: { file: 'r.jpg', applied: true, problems: ['failed 3 times: nope'] }, applied });
  const b = giveUpEntry('r.jpg', 3, 'nope', undefined, '/Review');
  assert.deepEqual(b, { result: 'failed', folder: '/Review', summary: { file: 'r.jpg', problems: ['failed 3 times: nope'] } });
});

test('failedEntry with a cloud reader keeps the saved reading (a retry does not pay to read the photo again); the local reader reads again', () => {
  const reading = { receipt: { merchant: 'A', total: 1 }, mode: 'remote' };
  const prev = { done: false, reading, attempts: 1 };
  assert.deepEqual(failedEntry(prev, 2, 'boom', 'now', true), { reading, done: false, attempts: 2, error: 'boom', at: 'now' });
  assert.deepEqual(failedEntry(prev, 2, 'boom', 'now', false), { done: false, attempts: 2, error: 'boom', at: 'now' });
  assert.deepEqual(failedEntry({ done: false }, 1, 'boom', 'now', true), { done: false, attempts: 1, error: 'boom', at: 'now' }, 'nothing read yet, nothing to keep');
  // by default it follows the configured reader
  const was = config.reader.provider;
  try {
    config.reader.provider = 'remote';
    assert.ok(failedEntry(prev, 2, 'boom').reading);
    config.reader.provider = 'local';
    assert.equal(failedEntry(prev, 2, 'boom').reading, undefined);
  } finally {
    config.reader.provider = was;
  }
  // an applied entry still keeps what it keeps
  const applied = failedEntry({ applied: { action: 'split' }, folder: 'F', summary: {}, result: 'r', reading }, 1, 'move failed', 'now', true);
  assert.ok(applied.applied && applied.reading);
});

test('countReaderFailure: consecutive cloud reader failures are counted per receipt; the third checks in a row is a failed attempt', () => {
  const prev = { done: false, attempts: 1, reading: undefined };
  const one = countReaderFailure(prev);
  assert.deepEqual([one.count, one.giveUp, one.entry.transientFails, one.entry.attempts], [1, false, 1, 1]);
  const two = countReaderFailure(one.entry);
  assert.deepEqual([two.count, two.giveUp], [2, false]);
  const three = countReaderFailure(two.entry);
  assert.deepEqual([three.count, three.giveUp], [MAX_TRANSIENT_CYCLES, true]);
  assert.equal(countReaderFailure(undefined).count, 1);
  assert.equal(prev.transientFails, undefined, 'the old entry is not changed');
  // a real failed attempt starts the count again
  assert.equal(failedEntry(three.entry, 2, 'x', 'now').transientFails, undefined);
});

test('replacedEntry: nothing applied is dropped; an applied one is kept as done, so a re-used name does not take its transaction for its own', () => {
  assert.equal(replacedEntry({ attempts: 1, error: 'x' }), null);
  assert.equal(replacedEntry(undefined), null);
  const prev = { done: false, applied: { txnId: 't1', action: 'split', at: 'then' }, result: 'split', folder: '/Processed', summary: { s: 1 } };
  const kept = replacedEntry(prev, 'now');
  assert.deepEqual(kept, { done: true, result: 'split', at: 'now', replaced: true, applied: prev.applied });
  assert.equal(isDue(kept, 0, true), false, 'never moved or applied again');
  // the same name, another etag (the replacement): the old transaction is owned by the old entry
  const state = { '/Inbox/r.jpg@ea': kept };
  assert.deepEqual([...txnIdsAppliedUnderName(state, '/Inbox/r.jpg@eb')], ['t1']);
});
