// Real filing orchestration with an in-memory WebDAV server and injected lost responses. Never contacts a service.
import './support.js';
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { writeRecord, storageFile, storageIdentity } from '../src/storage-state.js';
import { resumeTransfer } from '../src/filing-transfer.js';
import { timedDavClient } from '../src/dav-timeout.js';
import { isOutage } from '../src/errors.js';
const { fileReceipt, recoverFilings } = await import('../src/index.js');
const { filePageSummary } = await import('../src/filing.js');
const { loadState, saveState } = await import('../src/state.js');
const nc = await import('../src/nextcloud.js');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-filing-'));
process.on('exit', () => import('node:fs').then(({ default: f }) => f.rmSync(dir, { recursive: true, force: true })));
const item = { filename: '/Receipts/Inbox/a.jpg', basename: 'a.jpg', etag: 'v1' };
const id = `${item.filename}@v1`;
const dest = '/Receipts/Processed/a.jpg';
const summary = { file: 'a.jpg', receipt: { merchant: 'Synthetic shop', total: 10 }, plan: { applied: true } };
let serial = 0;
let c;
function dav() {
  const files = new Map([[item.filename, { etag: 'v1', bytes: 'photo' }], [`${item.filename}.json`, { bytes: 'old summary' }]]);
  const client = { files, moves: 0, puts: 0, loseMove: false, failPut: false, losePut: false,
    async exists(p) { return files.has(p); },
    async stat(p) { if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 }); return { ...files.get(p), size: 5 }; },
    async getDirectoryContents(folder) { return [...files].filter(([p]) => path.posix.dirname(p) === folder).map(([filename, f]) => ({ filename, basename: path.posix.basename(filename), type: 'file', ...f })); },
    async moveFile(from, to, opts) { assert.equal(opts.overwrite, false); assert.equal(opts.headers['If-Match'], '"v1"'); assert.equal(files.has(to), false); const file = await client.stat(from); files.set(to, file); files.delete(from); client.moves++; if (client.loseMove) { client.loseMove = false; throw new Error('MOVE response lost'); } },
    async putFileContents(p, data) { client.puts++; if (client.failPut) throw new Error('summary unavailable'); files.set(p, { bytes: data }); if (client.losePut) { client.losePut = false; throw new Error('PUT response lost'); } },
    async getFileContents(p) { if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 }); return files.get(p).bytes; },
    async deleteFile(p) { files.delete(p); },
  };
  return client;
}
beforeEach(async () => {
  config.statePath = path.join(dir, 'state.json'); config.settingsPath = path.join(dir, 'settings.json'); config.dryRun = false; config.envDryRun = false;
  config.nextcloud.url = `https://synthetic.invalid/${++serial}`;
  c = dav(); globalThis.__receiptTestDav = () => c;
  await writeRecord(storageFile('storage.json'), storageIdentity());
  await saveState({});
});
const decision = { result: 'categorize', summary, folder: '/Receipts/Processed', applied: { txnId: 'synthetic-txn', action: 'categorize', at: '2026-11-01' } };

test('worker persists the destination before MOVE and recovers a lost response even with an empty Inbox', async () => {
  c.loseMove = true;
  const state = {};
  await assert.rejects(fileReceipt(item, id, state, decision), /MOVE response lost/);
  const pending = await loadState();
  assert.equal(pending[id].filing.to, dest);
  assert.equal(pending[id].done, false);
  assert.equal(c.files.has(item.filename), false);
  const recovered = await recoverFilings(pending);
  assert.equal(recovered[id].done, true);
  assert.equal(recovered[id].filedAs, dest);
  assert.equal(recovered[id].filing, undefined);
  assert.equal(c.moves, 1);
  assert.deepEqual(JSON.parse(c.files.get(`${dest}.json`).bytes), summary);
  assert.equal((await recoverFilings(await loadState()))[id].done, true);
  assert.equal(c.moves, 1);
});

test('worker keeps its full summary until upload succeeds and retries only filing', async () => {
  c.failPut = true;
  await assert.rejects(fileReceipt(item, id, {}, decision), /summary unavailable/);
  const pending = await loadState();
  assert.deepEqual(pending[id].filing.summary, summary);
  assert.equal(c.files.get(`${item.filename}.json`).bytes, 'old summary');
  c.failPut = false;
  await recoverFilings(pending);
  assert.equal(c.moves, 1);
  assert.equal(c.files.has(`${item.filename}.json`), false);
  assert.equal((await loadState())[id].done, true);
});

test('page save resumes a lost MOVE and clears its summary failure without changing financial records', async () => {
  const entry = { done: true, filedAs: item.filename, applied: decision.applied, fixedOnPage: { summaryFailed: true } };
  await saveState({ [id]: entry }); c.loseMove = true;
  await assert.rejects(filePageSummary(id, entry, dest, summary, nc), /MOVE response lost/);
  await recoverFilings(await loadState());
  const result = (await loadState())[id];
  assert.deepEqual(result.applied, entry.applied);
  assert.equal(result.filedAs, dest);
  assert.equal(result.fixedOnPage.summaryFailed, undefined);
  assert.equal(result.filing, undefined);
  assert.equal(c.moves, 1);
});

test('lost PUT acknowledgement is idempotent; destination collisions preserve both photos', async () => {
  c.files.set(dest, { etag: 'other', bytes: 'other receipt' });
  const intent = { from: item.filename, dest, etag: item.etag, summary };
  let saved;
  c.losePut = true;
  await assert.rejects(resumeTransfer(c, intent, async (v) => { saved = v; }), /PUT response lost/);
  const where = await resumeTransfer(c, saved, async () => {});
  assert.notEqual(where, dest);
  assert.equal(c.files.get(dest).bytes, 'other receipt');
  assert.equal(c.files.get(where).bytes, 'photo');
  assert.equal(c.moves, 1);
  assert.deepEqual(JSON.parse(c.files.get(`${where}.json`).bytes), summary);
});

test('a changed destination version refuses the summary write; legacy finishing entries adopt only a unique version', async () => {
  const intent = { from: item.filename, dest, to: dest, etag: 'v1', summary };
  c.files.delete(item.filename); c.files.set(dest, { etag: 'newer', bytes: 'keep' });
  await assert.rejects(resumeTransfer(c, intent, async () => {}), /version/);
  assert.equal(c.puts, 0);
  c.files.set(dest, { etag: 'v1', bytes: 'photo' });
  const legacy = { from: item.filename, dest, etag: 'v1', summary };
  assert.equal(await resumeTransfer(c, legacy, async () => {}), dest);
});

test('all WebDAV methods get a cancellation deadline and retain caller options; a timeout is an outage', async () => {
  let options;
  const client = timedDavClient({ putFileContents: async (...args) => { options = args[2]; return 'ok'; } }, 20);
  assert.equal(await client.putFileContents('/synthetic', 'x', { overwrite: false, headers: { 'If-Match': 'v1' } }), 'ok');
  assert.equal(options.overwrite, false); assert.equal(options.headers['If-Match'], 'v1'); assert.ok(options.signal);
  const held = setTimeout(() => {}, 1000);
  try {
    const blocked = timedDavClient({ getDirectoryContents: async (_p, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, 15);
    await assert.rejects(blocked.getDirectoryContents('/synthetic'), (err) => isOutage(err) && err.service === 'nextcloud');
  } finally { clearTimeout(held); }
});


test('a failed final local checkpoint retains the in-memory journal after successful remote filing', async () => {
  const rename = fs.rename.bind(fs);
  let injected = false;
  const hook = mock.method(fs, 'rename', async (...args) => {
    if (!injected && c.puts > 0 && args[1] === config.statePath) { injected = true; throw new Error('disk unavailable at final checkpoint'); }
    return rename(...args);
  });
  const state = {};
  try { await assert.rejects(fileReceipt(item, id, state, decision), /final checkpoint/); }
  finally { hook.mock.restore(); }
  assert.equal(state[id].done, false);
  assert.deepEqual(state[id].filing.summary, summary);
  assert.equal(state[id].filing.to, dest);
  await saveState(state); // a later error-handler save must keep the pending filing record
  const recovered = await recoverFilings(await loadState());
  assert.equal(recovered[id].done, true);
  assert.equal(c.moves, 1);
});

test('recovery finishes the verified older destination while preserving a new upload at the same Inbox name', async () => {
  c.loseMove = true;
  await assert.rejects(fileReceipt(item, id, {}, decision), /MOVE response lost/);
  c.files.set(item.filename, { etag: 'v2', bytes: 'new photo' });
  c.files.set(`${item.filename}.json`, { bytes: 'new reading' });
  const recovered = await recoverFilings(await loadState());
  assert.equal(recovered[id].done, true);
  assert.equal(c.files.get(item.filename).bytes, 'new photo');
  assert.equal(c.files.get(`${item.filename}.json`).bytes, 'new reading');
  assert.equal(c.files.get(dest).bytes, 'photo');
  assert.equal(c.moves, 1);
});
