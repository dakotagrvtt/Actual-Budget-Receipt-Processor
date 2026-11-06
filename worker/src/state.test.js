// state.js: state keys, which files are due, and saving state. Uses a temp file, never /data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { isDue, stateKey, parseStateKey, loadState, saveState } from './state.js';

test('isDue: a file with no entry is new', () => {
  assert.equal(isDue(undefined, 1000, false), true);
});

test('isDue: a done file is not due', () => {
  assert.equal(isDue({ done: true }, 1000, true), false);
});

test('isDue: a file decided but not yet moved is due', () => {
  assert.equal(isDue({ folder: 'x', waiting: { nextCheck: '2999-01-01' } }, 1000, false), true);
});

test('isDue: a file that failed and is retrying is due', () => {
  assert.equal(isDue({ done: false, attempts: 1, error: 'x' }, 1000, false), true);
});

test('isDue: a waiting file is due when its re-check time is up, or on a manual check', () => {
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
