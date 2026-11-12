// Archiving and restoring: which receipts may be archived, the slim entry, the archive folder and names, shrinking (kept, not kept,
// converter failing), never losing the photo, automatic archiving, the lists, the Archived page and the refusals. The WebDAV client is
// an in-memory stand-in and the image converter is a function; no network, no ImageMagick.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { escape } from '../src/panel-layout.js';
import { archiveFileWith, restoreFileWith, refileWith, KEEP_IF_UNDER } from '../src/archive-files.js';
import { canArchive, archiveMonth, cardOf, slimEntry, restoredEntry, dueForAutoArchive, bulkCandidates, AUTO_LIMIT, BULK_LIMIT } from '../src/archive-rules.js';
import { archiveReceipt, restoreReceipt, autoArchive } from '../src/archive.js';
import { archivedList, mainList, DONE_CAP } from '../src/receipt-lists.js';
import { archivedPage, archiveAllPage, archivedNav, ARCHIVE_ORDERING } from '../src/panel-archive-page.js';
import { statusPage, cleanNav } from '../src/panel-status.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { archiveFolderProblem } from '../src/folders.js';
import * as fix from '../src/receipt-fix.js';
import { tryAgain, retryStatus, PanelError } from '../src/panel-actions.js';
import { archiveOne, archiveAll, restoreOne } from '../src/archive-actions.js';
import { buildConfig } from '../src/config.js';
import { checkChanges } from '../src/web-settings.js';
import { SettingError } from '../src/web-settings-schema.js';
import { loadState } from '../src/state.js';
import { makeServer, archiveTarget, restoreTarget } from '../src/trigger.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), dryRun: false });
config.trigger.token = 'secret';
const { inbox, processed, review, archive } = config.nextcloud;
const saved = { dry: config.dryRun, envDry: config.envDryRun, archive: { ...config.archive } };

const HOSTILE = '<img src=x onerror=alert(1)> & "q"';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const key = (name, etag = 'e1') => `${inbox}/${name}@${etag}`;
const doneEntry = (name, over = {}) => ({ done: true, result: 'split', at: '2026-01-05T10:00:00.000Z', filedAs: `${processed}/${name}`, applied: { txnId: `t-${name}`, action: 'split', at: '2026-01-05T10:00:00.000Z' }, ...over });
const SUMMARY = { file: 'a.jpg', receipt: { merchant: 'Target', date: '2026-03-14', total: 41.6, items: [{ description: 'MILK', amount: 20 }] }, transaction: { id: 't1', payee: 'Target', date: '2026-03-15', amount: '41.60' }, plan: { applied: true, parts: [] } };

beforeEach(() => {
  fs.writeFileSync(config.statePath, '{}');
  Object.assign(config, { dryRun: false, envDryRun: false });
  fs.rmSync(config.settingsPath, { force: true });
  Object.assign(config.archive, { afterDays: 0, shrink: true });
});
afterEach(() => {
  Object.assign(config, { dryRun: saved.dry, envDryRun: saved.envDry });
  Object.assign(config.archive, saved.archive);
});

// ---- the WebDAV stand-in ----
function fakeClient(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, v]) => [p, Buffer.from(v)]));
  const dirs = new Set();
  const c = {
    files, dirs, calls: [], failPut: null, failStat: null, failDelete: null, statSize: null,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async createDirectory(p) { dirs.add(p); },
    async getDirectoryContents(d) { return [...files.keys()].filter((p) => path.posix.dirname(p) === d).map((p) => ({ basename: path.posix.basename(p), filename: p, type: 'file' })); },
    async getFileContents(p, opts = {}) {
      if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return opts.format === 'text' ? files.get(p).toString() : files.get(p);
    },
    async putFileContents(p, data, opts = {}) {
      c.calls.push(['put', p]);
      if (c.failPut && c.failPut(p)) throw new Error('upload failed');
      if (opts.overwrite === false && files.has(p)) throw Object.assign(new Error('exists'), { status: 412 });
      files.set(p, Buffer.from(data));
      return true;
    },
    async stat(p) {
      if (c.failStat) throw new Error('stat failed');
      if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { size: c.statSize ?? files.get(p).length };
    },
    async deleteFile(p) {
      c.calls.push(['delete', p]);
      if (c.failDelete && c.failDelete(p)) throw new Error('delete failed');
      if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 });
      files.delete(p);
    },
    async moveFile(a, b, opts = {}) {
      c.calls.push(['move', a, b]);
      if (opts.overwrite === false && files.has(b)) throw Object.assign(new Error('exists'), { status: 412 });
      files.set(b, files.get(a));
      files.delete(a);
    },
    json(p) { return JSON.parse(files.get(`${p}.json`).toString()); },
  };
  return c;
}
const big = 'x'.repeat(1000);
const shrinkTo = (n) => async () => Buffer.from('y'.repeat(n));

// ---- which statuses can be archived ----

test('canArchive: Done can be archived one by one, in bulk and automatically; the rest cannot', () => {
  const k = key('a.jpg');
  for (const mode of ['single', 'bulk', 'auto']) assert.deepEqual(canArchive(k, doneEntry('a.jpg'), { mode }), { ok: true, kind: 'done' });
  const no = (entry, mode = 'single') => canArchive(k, entry, { mode });
  assert.equal(no({ done: false, waiting: { nextCheck: 'x' } }).ok, false); // waiting
  assert.equal(no({ done: false, attempts: 1, error: 'x' }).ok, false); // retrying
  assert.equal(no({ done: false, applied: { txnId: 't' }, folder: processed }).ok, false); // applying
  assert.equal(no({ done: true, result: 'review', filedAs: `${review}/a.jpg` }).ok, false);
  assert.equal(no({ done: true, result: 'failed', filedAs: `${review}/a.jpg` }).ok, false);
  assert.equal(no({ done: true, result: 'failed', applied: { txnId: 't' }, filedAs: `${review}/a.jpg` }).ok, false);
  assert.equal(no(doneEntry('a.jpg', { archived: { at: 'x' } })).ok, false);
  assert.equal(canArchive(`dry:${inbox}/a.jpg@e1`, doneEntry('a.jpg', { result: 'dry-run:split' })).ok, false);
  config.dryRun = true;
  assert.equal(no(doneEntry('a.jpg')).ok, false);
});

test('canArchive: an "applied, check it in Actual" receipt is archived one at a time only', () => {
  const k = key('a.jpg');
  const flagged = doneEntry('a.jpg', { result: 'split+review', filedAs: `${review}/a.jpg` });
  assert.deepEqual(canArchive(k, flagged, { mode: 'single' }), { ok: true, kind: 'applied-review' });
  for (const mode of ['bulk', 'auto']) assert.equal(canArchive(k, flagged, { mode }).ok, false);
});

test('canArchive: needs a recorded file in the right folder, and no open Undo', () => {
  const k = key('a.jpg');
  const { filedAs: _gone, ...noFile } = doneEntry('a.jpg');
  assert.match(canArchive(k, noFile).reason, /does not record where its file is/);
  assert.match(canArchive(k, doneEntry('a.jpg', { filedAs: '/Elsewhere/a.jpg' })).reason, /not in the Processed folder/);
  const recent = doneEntry('a.jpg', { fixedOnPage: { at: iso(NOW - 60000) } });
  assert.match(canArchive(k, recent, { now: NOW }).reason, /Undo/);
  assert.equal(canArchive(k, doneEntry('a.jpg', { fixedOnPage: { at: iso(NOW - 20 * 60000) } }), { now: NOW }).ok, true);
});

test('manual dismissal accepts unresolved filed receipts without changing normal, bulk or automatic eligibility', () => {
  const id = key('wrong.pdf');
  for (const over of [
    { result: 'review', applied: undefined },
    { result: 'failed', applied: undefined },
    { result: 'failed' },
    { result: 'split+review' },
  ]) {
    const entry = doneEntry('wrong.pdf', { filedAs: `${review}/wrong.pdf`, ...over });
    assert.equal(canArchive(id, entry, { dismiss: true }).ok, true, over.result);
    for (const mode of ['bulk', 'auto']) {
      assert.equal(canArchive(id, entry, { mode }).ok, false);
      assert.equal(canArchive(id, entry, { mode, dismiss: true }).ok, false);
    }
    if (!entry.applied || entry.result === 'failed') assert.equal(canArchive(id, entry).ok, false);
  }
});

test('manual dismissal retains dry-run, folder, unfinished-operation and Undo protections', () => {
  const id = key('wrong.pdf');
  const entry = doneEntry('wrong.pdf', { result: 'review', applied: undefined, filedAs: `${review}/wrong.pdf` });
  for (const over of [
    { filedAs: undefined }, { filedAs: '/Elsewhere/wrong.pdf' }, { filedAs: `${review}/../wrong.pdf` }, { filedAs: `${inbox}/wrong.pdf` },
    { done: false }, { done: false, waiting: { nextCheck: '2099-01-01' } },
    { archived: { at: 'T' } }, { filing: {} }, { creating: {} }, { resolutionPending: {} },
    { reread: { at: 'T' } }, { fixedOnPage: { summaryFailed: true } }, { fixedOnPage: { at: iso(NOW - 60000) } },
    { result: 'dry-run:review' },
  ]) assert.equal(canArchive(id, { ...entry, ...over }, { dismiss: true, now: NOW }).ok, false, JSON.stringify(over));
  assert.equal(canArchive(`dry:${id}`, entry, { dismiss: true }).ok, false);
  config.dryRun = true;
  assert.equal(canArchive(id, entry, { dismiss: true }).ok, false);
  config.dryRun = false;
  config.archive.problem = 'folder clash';
  assert.equal(canArchive(id, entry, { dismiss: true }).ok, false);
});

// ---- the slim entry ----

test('slimEntry drops the bulky fields and keeps result, at, done, applied, filedAs and the archive note', () => {
  const entry = doneEntry('a.jpg', { reading: { receipt: { big } }, deciderAnswers: { a: 1 }, imageSkips: 2, error: 'e', attempts: 2, transientFails: 1, deciderFails: 1, waiting: { x: 1 }, fixedOnPage: { at: 'x', lessons: [1] }, restoredAt: 'y', summary: { big } });
  const slim = slimEntry(entry, { at: 'T', auto: true, filedAs: `${archive}/2026-03/a.jpg`, shrunk: { before: 10, after: 5 }, card: { store: 'Target', date: '2026-03-14', total: 41.6 } });
  assert.deepEqual(slim, {
    result: 'split', at: '2026-01-05T10:00:00.000Z', done: true, applied: entry.applied,
    filedAs: `${archive}/2026-03/a.jpg`,
    archived: { at: 'T', auto: true, folder: archive, shrunk: { before: 10, after: 5 } },
    card: { store: 'Target', date: '2026-03-14', total: 41.6 },
  });
  assert.deepEqual(slimEntry(entry, { at: 'T', auto: false, filedAs: 'p', fileMissing: true }).archived, { at: 'T', auto: false, folder: archive, fileMissing: true });
});

test('a slim entry still tells a re-upload of the same name apart (applied.txnId is kept)', async () => {
  const { txnIdsAppliedUnderName } = await import('../src/state.js');
  const slim = slimEntry(doneEntry('a.jpg'), { at: 'T', filedAs: 'p' });
  assert.deepEqual([...txnIdsAppliedUnderName({ [key('a.jpg', 'old')]: slim }, key('a.jpg', 'new'))], ['t-a.jpg']);
});

test('cardOf takes store, date and total from the summary, with the transaction as a fallback', () => {
  assert.deepEqual(cardOf(SUMMARY), { store: 'Target', date: '2026-03-14', total: 41.6 });
  assert.deepEqual(cardOf({ transaction: { payee: 'Shop', date: '2026-02-01', amount: '12.50' } }), { store: 'Shop', date: '2026-02-01', total: 12.5 });
  assert.deepEqual(cardOf(null), { store: '', date: '', total: null });
});

// ---- the destination month and names ----

test('archiveMonth: the receipt\'s own date, else the month it was filed', () => {
  assert.equal(archiveMonth(SUMMARY, '2026-11-01T00:00:00Z'), '2026-03');
  assert.equal(archiveMonth({ receipt: { date: null } }, '2026-11-01T00:00:00Z'), '2026-11');
  assert.equal(archiveMonth(null, '2025-02-28T23:00:00Z'), '2025-02');
});

test('archiving moves the photo and summary to the folder and never overwrites: a taken name gets a time stamp', async () => {
  const dirA = `${archive}/2026-03`;
  const c = fakeClient({ [`${processed}/a.pdf`]: 'new', [`${processed}/a.pdf.json`]: '{}', [`${dirA}/a.pdf`]: 'older' });
  const out = await archiveFileWith(c, { from: `${processed}/a.pdf`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(1) });
  assert.match(out.dest, new RegExp(`^${dirA}/\\d+-a\\.pdf$`));
  assert.equal(c.files.get(`${dirA}/a.pdf`).toString(), 'older');
  assert.equal(c.files.get(out.dest).toString(), 'new');
  assert.equal(c.json(out.dest).archived.from, `${processed}/a.pdf`);
  assert.equal(c.files.has(`${processed}/a.pdf`), false);
  assert.equal(c.files.has(`${processed}/a.pdf.json`), false);
  assert.ok(c.dirs.has(dirA), 'the month folder was created');
});

// ---- shrinking ----

test('a shrunk copy that is at least 10% smaller is kept: .jpg name, checked, summary written, original deleted last', async () => {
  const dirA = `${archive}/2026-03`;
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: '{}' });
  const out = await archiveFileWith(c, { from: `${processed}/a.png`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(1000 * KEEP_IF_UNDER) });
  assert.equal(out.dest, `${dirA}/a.jpg`);
  assert.deepEqual(out.shrunk, { before: 1000, after: 900 });
  assert.equal(c.files.get(`${dirA}/a.jpg`).length, 900);
  assert.deepEqual(c.json(`${dirA}/a.jpg`).archived, { at: 'T', from: `${processed}/a.png`, shrunk: { before: 1000, after: 900 } });
  assert.equal(c.files.has(`${processed}/a.png`), false);
  const order = c.calls.map((x) => x.join(' '));
  assert.ok(order.indexOf(`put ${dirA}/a.jpg.json`) < order.indexOf(`delete ${processed}/a.png`), 'the summary is written before the original goes');
});

test('a copy that is not 10% smaller is not kept: the original moves unchanged under its own name', async () => {
  const dirA = `${archive}/2026-03`;
  const c = fakeClient({ [`${processed}/a.jpg`]: big, [`${processed}/a.jpg.json`]: '{}' });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(901) });
  assert.equal(out.dest, `${dirA}/a.jpg`);
  assert.equal(out.shrunk, null);
  assert.equal(c.files.get(out.dest).toString(), big);
  assert.equal(c.json(out.dest).archived.shrunk, null);
});

test('PDFs and shrink-off are moved unchanged without calling the converter', async () => {
  let called = 0;
  const shrinkFn = async () => { called++; return Buffer.from('y'); };
  const c = fakeClient({ [`${processed}/a.pdf`]: big, [`${processed}/a.jpg`]: big });
  await archiveFileWith(c, { from: `${processed}/a.pdf`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn });
  await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: false, shrinkFn });
  assert.equal(called, 0);
  assert.equal(c.files.get(`${archive}/m/a.pdf`).toString(), big);
  assert.equal(c.files.get(`${archive}/m/a.jpg`).toString(), big);
});

test('when the converter fails the original is moved instead, and the failure is logged', async () => {
  const c = fakeClient({ [`${processed}/a.jpg`]: big, [`${processed}/a.jpg.json`]: '{}' });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: async () => { throw new Error('convert crashed'); } });
    assert.equal(out.shrunk, null);
    assert.equal(c.files.get(`${archive}/m/a.jpg`).toString(), big);
  } finally {
    console.log = orig;
  }
  assert.ok(lines.some((l) => /could not shrink a\.jpg \(convert crashed\)/.test(l)));
});

test('the original is not deleted when the upload fails; the plain move still happens', async () => {
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: '{}' });
  c.failPut = (p) => p.endsWith('.jpg');
  const out = await archiveFileWith(c, { from: `${processed}/a.png`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(10) });
  assert.equal(out.shrunk, null);
  assert.equal(c.files.get(`${archive}/m/a.png`).toString(), big, 'the photo is in the archive, unchanged');
  assert.equal(c.files.has(`${archive}/m/a.jpg`), false);
});

test('the original is not deleted when the size check fails or the stat fails: the half-done copy is removed, the original moves', async () => {
  for (const setup of [(c) => { c.statSize = 3; }, (c) => { c.failStat = true; }]) {
    const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: '{}' });
    setup(c);
    const out = await archiveFileWith(c, { from: `${processed}/a.png`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(10) });
    assert.equal(out.shrunk, null);
    assert.equal(c.files.has(`${archive}/m/a.jpg`), false, 'no stray shrunk copy');
    assert.equal(c.files.has(`${archive}/m/a.jpg.json`), false);
    assert.equal(c.files.get(`${archive}/m/a.png`).toString(), big);
  }
});

test('if the original cannot be deleted after a good upload, the copy is removed and the original stays', async () => {
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: '{}' });
  c.failDelete = (p) => p === `${processed}/a.png`;
  c.moveFile = async () => { throw new Error('move failed too'); };
  await assert.rejects(() => archiveFileWith(c, { from: `${processed}/a.png`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(10) }), /move failed too/);
  assert.equal(c.files.get(`${processed}/a.png`).toString(), big, 'the original is still there');
  assert.equal(c.files.has(`${archive}/m/a.jpg`), false);
});

test('a photo that is already gone still archives the entry, and says so', async () => {
  const c = fakeClient({ [`${processed}/a.jpg.json`]: JSON.stringify(SUMMARY) });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(1) });
  assert.equal(out.fileMissing, true);
  assert.equal(c.json(`${archive}/m/a.jpg`).archived.fileMissing, true);
  assert.equal(c.files.has(`${processed}/a.jpg.json`), false);
});

test('a photo moved by an earlier archiving that never recorded it is found again by its state key, even under a time-stamped name', async () => {
  const dirA = `${archive}/m`;
  const note = (key, txnId) => JSON.stringify({ archived: { at: 'T0', from: `${processed}/a.jpg`, key, txnId, shrunk: { before: 9, after: 5 } } });
  const c = fakeClient({ [`${dirA}/a.jpg`]: 'small', [`${dirA}/a.jpg.json`]: note('other-key', 't9'), [`${dirA}/1700000000000-a.jpg`]: 'mine', [`${dirA}/1700000000000-a.jpg.json`]: note('my-key', 't1') });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(1), id: { key: 'my-key', txnId: 't1' } });
  assert.deepEqual(out, { dest: `${dirA}/1700000000000-a.jpg`, shrunk: { before: 9, after: 5 }, fileMissing: false });
});

test('crash recovery never adopts another receipt\'s photo that merely had the same Processed path', async () => {
  const dirA = `${archive}/m`;
  const c = fakeClient({ [`${dirA}/a.jpg`]: 'A', [`${dirA}/a.jpg.json`]: JSON.stringify({ archived: { from: `${processed}/a.jpg`, key: 'key-A', txnId: 'tA' } }) });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(1), id: { key: 'key-B', txnId: 'tB' } });
  assert.equal(out.fileMissing, true);
  assert.equal(c.files.get(`${dirA}/a.jpg`).toString(), 'A', 'A\'s photo is untouched');
  assert.equal(JSON.parse(c.files.get(`${dirA}/a.jpg.json`)).archived.key, 'key-A', 'A\'s summary is untouched');
  assert.match(out.dest, /\/\d+-a\.jpg$/);
  assert.equal(c.json(out.dest).archived.key, 'key-B');
});

// ---- summaries are never overwritten (A1) ----

test('a summary without a photo counts as a taken name: a second receipt with the same name does not overwrite it', async () => {
  const dirA = `${archive}/m`;
  const c = fakeClient({ [`${dirA}/a.jpg.json`]: JSON.stringify({ mine: 'A (photo was gone)' }), [`${processed}/a.jpg`]: big, [`${processed}/a.jpg.json`]: JSON.stringify(SUMMARY) });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: dirA, summary: SUMMARY, at: 'T', shrink: false, id: { key: 'B' } });
  assert.match(out.dest, /\/\d+-a\.jpg$/);
  assert.equal(JSON.parse(c.files.get(`${dirA}/a.jpg.json`)).mine, 'A (photo was gone)');
  const c2 = fakeClient({ [`${dirA}/a.jpg.json`]: JSON.stringify({ mine: 'A' }), [`${processed}/a.png`]: big });
  c2.files.set(`${dirA}/a.jpg.json`, Buffer.from(JSON.stringify({ mine: 'A' })));
  await c2.putFileContents(`${processed}/a.jpg`, big);
  const shrunk = await archiveFileWith(c2, { from: `${processed}/a.png`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(10), id: { key: 'B' } });
  assert.match(shrunk.dest, /\/\d+-a\.jpg$/, 'the shrunk copy takes a free name too');
  assert.equal(JSON.parse(c2.files.get(`${dirA}/a.jpg.json`)).mine, 'A');
});

test('a failed shrink cleanup only removes what this call made', async () => {
  const dirA = `${archive}/m`;
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${dirA}/a.jpg.json`]: JSON.stringify({ mine: 'A' }) });
  c.failStat = true;
  const out = await archiveFileWith(c, { from: `${processed}/a.png`, dir: dirA, summary: SUMMARY, at: 'T', shrink: true, shrinkFn: shrinkTo(10) });
  assert.equal(out.shrunk, null);
  assert.equal(JSON.parse(c.files.get(`${dirA}/a.jpg.json`)).mine, 'A', 'A\'s summary survived');
});

test('a missing photo restored into Processed does not overwrite a summary that is already there', async () => {
  const c = fakeClient({ [`${archive}/m/a.jpg.json`]: JSON.stringify(SUMMARY), [`${processed}/a.jpg.json`]: JSON.stringify({ other: true }) });
  const out = await restoreFileWith(c, { from: `${archive}/m/a.jpg`, dir: processed, summary: SUMMARY });
  assert.equal(out.missing, true);
  assert.match(out.dest, /\/\d+-a\.jpg$/);
  assert.equal(JSON.parse(c.files.get(`${processed}/a.jpg.json`)).other, true);
});

test('a damaged summary (read as nothing) is carried over, not replaced by an empty one', async () => {
  const c = fakeClient({ [`${processed}/a.jpg`]: big, [`${processed}/a.jpg.json`]: '{ damaged' });
  const out = await archiveFileWith(c, { from: `${processed}/a.jpg`, dir: `${archive}/m`, summary: null, at: 'T', shrink: false });
  assert.equal(c.files.get(`${out.dest}.json`).toString(), '{ damaged');
});

// ---- half moves (A6) ----

test('the photo moved but its summary could not be written: the new path is returned with a warning, not an error', async () => {
  const c = fakeClient({ [`${processed}/a.pdf`]: big, [`${processed}/a.pdf.json`]: '{}' });
  c.failPut = (p) => p.endsWith('.json');
  const out = await archiveFileWith(c, { from: `${processed}/a.pdf`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: false });
  assert.deepEqual(out, { dest: `${archive}/m/a.pdf`, shrunk: null, fileMissing: false, noSummary: true });
  assert.equal(c.files.has(`${processed}/a.pdf.json`), true, 'the old summary stays');
  const back = await restoreFileWith(c, { from: `${archive}/m/a.pdf`, dir: processed, summary: SUMMARY });
  assert.equal(back.noSummary, true);
  assert.match(back.dest, /a\.pdf$/, 'a leftover old summary makes the plain name taken');
});

test('the summary write is tried once more before giving up on it', async () => {
  const c = fakeClient({ [`${processed}/a.pdf`]: big, [`${processed}/a.pdf.json`]: '{}' });
  let fails = 1;
  const put = c.putFileContents;
  c.putFileContents = async (p, d, o) => { if (p.endsWith('.json') && fails-- > 0) throw new Error('blip'); return put(p, d, o); };
  const out = await archiveFileWith(c, { from: `${processed}/a.pdf`, dir: `${archive}/m`, summary: SUMMARY, at: 'T', shrink: false });
  assert.equal(out.noSummary, undefined);
  assert.ok(c.files.has(`${archive}/m/a.pdf.json`));
});

// ---- the orchestration: archiveReceipt, restore ----

function fakeNc(client) {
  return {
    async readSummary(p) { try { return JSON.parse(client.files.get(`${p}.json`).toString()); } catch { return null; } },
    archiveFile: (args) => archiveFileWith(client, { shrinkFn: shrinkTo(10), ...args }),
    restoreFile: (args) => restoreFileWith(client, args),
  };
}

test('archiveReceipt: the month folder, the slim entry with the card, and the shrink setting', async () => {
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: JSON.stringify(SUMMARY) });
  const slim = await archiveReceipt(doneEntry('a.png'), { nc: fakeNc(c), now: NOW });
  assert.equal(slim.filedAs, `${archive}/2026-03/a.jpg`);
  assert.deepEqual(slim.archived, { at: iso(NOW), auto: false, folder: archive, shrunk: { before: 1000, after: 10 } });
  assert.deepEqual(slim.card, { store: 'Target', date: '2026-03-14', total: 41.6 });
  config.archive.shrink = false;
  const c2 = fakeClient({ [`${processed}/b.png`]: big, [`${processed}/b.png.json`]: JSON.stringify(SUMMARY) });
  assert.equal((await archiveReceipt(doneEntry('b.png'), { nc: fakeNc(c2), now: NOW })).filedAs, `${archive}/2026-03/b.png`);
});

test('archiveReceipt: a summary that cannot be read (Nextcloud down) moves nothing', async () => {
  const c = fakeClient({ [`${processed}/a.jpg`]: big });
  const nc = { ...fakeNc(c), readSummary: async () => { throw new Error('ECONNREFUSED'); } };
  await assert.rejects(() => archiveReceipt(doneEntry('a.jpg'), { nc }), /ECONNREFUSED/);
  assert.equal(c.files.get(`${processed}/a.jpg`).toString(), big);
});

test('restore: photo and summary go back to Processed, the archive note is gone, restoredAt is set, never over another file', async () => {
  const c = fakeClient({ [`${processed}/a.png`]: big, [`${processed}/a.png.json`]: JSON.stringify(SUMMARY) });
  const nc = fakeNc(c);
  const slim = await archiveReceipt(doneEntry('a.png'), { nc, now: NOW });
  c.files.set(`${processed}/a.jpg`, Buffer.from('someone else')); // the name is taken by a different file
  const { entry, missing } = await restoreReceipt(slim, { nc, now: NOW + DAY });
  assert.equal(missing, false);
  assert.match(entry.filedAs, new RegExp(`^${processed}/\\d+-a\\.jpg$`));
  assert.equal(c.files.get(`${processed}/a.jpg`).toString(), 'someone else');
  assert.equal(c.files.get(entry.filedAs).length, 10, 'the shrunk photo comes back');
  assert.equal('archived' in c.json(entry.filedAs), false);
  assert.equal(entry.archived, undefined);
  assert.deepEqual(entry.card, { store: 'Target', date: '2026-03-14', total: 41.6 }, 'the list still shows store and total');
  assert.equal(entry.restoredAt, iso(NOW + DAY));
  assert.equal(entry.applied.txnId, 't-a.png');
  assert.equal(c.files.has(`${archive}/2026-03/a.jpg`), false);
});

test('restore: a photo gone from the archive brings back only the summary', async () => {
  const c = fakeClient({ [`${archive}/m/a.jpg.json`]: JSON.stringify({ ...SUMMARY, archived: { at: 'T', fileMissing: true } }) });
  const out = await restoreFileWith(c, { from: `${archive}/m/a.jpg`, dir: processed, summary: SUMMARY });
  assert.equal(out.missing, true);
  assert.equal(c.files.has(`${processed}/a.jpg.json`), true);
  assert.equal(c.files.has(`${archive}/m/a.jpg.json`), false);
});

test('restoredEntry', () => {
  assert.deepEqual(restoredEntry({ done: true, result: 'split', archived: { at: 'T' }, card: { store: 'S' } }, 'p', 'R'), { done: true, result: 'split', card: { store: 'S' }, filedAs: 'p', restoredAt: 'R' });
});

test('refileWith still never replaces a file and moves the summary with it', async () => {
  const c = fakeClient({ [`${review}/a.jpg`]: 'x', [`${review}/a.jpg.json`]: '{}', [`${processed}/a.jpg`]: 'other' });
  const at = await refileWith(c, `${review}/a.jpg`, `${processed}/a.jpg`, { ok: 1 });
  assert.match(at, /^\/Receipts\/Processed\/\d+-a\.jpg$/);
  assert.equal(c.files.get(`${processed}/a.jpg`).toString(), 'other');
  assert.equal(c.files.has(`${review}/a.jpg.json`), false);
  await assert.rejects(() => refileWith(c, `${review}/gone.jpg`, `${processed}/gone.jpg`, {}), (e) => e.status === 404);
});

// ---- automatic archiving ----

test('dueForAutoArchive: only Done receipts older than N days; restoredAt counts if later; at most the limit, oldest first', () => {
  const old = (n) => iso(NOW - n * DAY);
  const state = {
    [key('old.jpg')]: doneEntry('old.jpg', { at: old(40) }),
    [key('new.jpg')]: doneEntry('new.jpg', { at: old(5) }),
    [key('restored.jpg')]: doneEntry('restored.jpg', { at: old(90), restoredAt: old(3) }),
    [key('restored-old.jpg')]: doneEntry('restored-old.jpg', { at: old(90), restoredAt: old(45) }),
    [key('flagged.jpg')]: doneEntry('flagged.jpg', { at: old(90), result: 'split+review', filedAs: `${review}/flagged.jpg` }),
    [key('review.jpg')]: { done: true, result: 'review', at: old(90), filedAs: `${review}/review.jpg` },
    [key('waiting.jpg')]: { done: false, waiting: { nextCheck: 'x' }, at: old(90) },
    [key('archived.jpg')]: doneEntry('archived.jpg', { at: old(90), archived: { at: 'T' } }),
    [`dry:${inbox}/dry.jpg@e1`]: { done: true, result: 'dry-run:split', at: old(90) },
  };
  assert.deepEqual(dueForAutoArchive(state, { now: NOW, days: 30 }), [key('restored-old.jpg'), key('old.jpg')]);
  assert.deepEqual(dueForAutoArchive(state, { now: NOW, days: 30, limit: 1 }), [key('restored-old.jpg')]);
  assert.deepEqual(dueForAutoArchive(state, { now: NOW, days: 0 }), [], 'off by default');
  assert.deepEqual(bulkCandidates(state).sort(), [key('new.jpg'), key('old.jpg'), key('restored-old.jpg'), key('restored.jpg')].sort());
});

test('autoArchive: archives due receipts, at most 20 per call, saves after each, skips a failure and carries on', async () => {
  config.archive.afterDays = 30;
  const c = fakeClient();
  const state = {};
  for (let i = 0; i < 25; i++) {
    const name = `r${String(i).padStart(2, '0')}.pdf`;
    state[key(name)] = doneEntry(name, { at: iso(NOW - (100 - i) * DAY) });
    c.files.set(`${processed}/${name}`, Buffer.from(big));
    c.files.set(`${processed}/${name}.json`, Buffer.from(JSON.stringify(SUMMARY)));
  }
  const nc = fakeNc(c);
  let n = 0;
  const flaky = { ...nc, archiveFile: (args) => { if (args.from.endsWith('r01.pdf')) throw new Error('boom'); return nc.archiveFile(args); } };
  const saves = [];
  const orig = console.log;
  console.log = () => {};
  let done;
  try {
    done = await autoArchive(state, { nc: flaky, now: NOW, save: async (s) => { saves.push(Object.values(s).filter((e) => e.archived).length); n++; } });
  } finally {
    console.log = orig;
  }
  assert.equal(AUTO_LIMIT, 20);
  assert.equal(done, 19, '20 tried, one failed');
  assert.equal(n, 19);
  assert.deepEqual(saves.slice(0, 3), [1, 2, 3]);
  assert.equal(state[key('r01.pdf')].archived, undefined, 'the failed one stays as it was');
  assert.equal(state[key('r00.pdf')].archived.auto, true);
  assert.equal(state[key('r24.pdf')].archived, undefined, 'the newest ones wait for the next check');
  config.archive.afterDays = 0;
  assert.equal(await autoArchive(state, { nc, now: NOW }), 0, 'off: nothing happens');
});

test('autoArchive does nothing in dry run', async () => {
  config.archive.afterDays = 1;
  config.dryRun = true;
  assert.equal(await autoArchive({ [key('a.jpg')]: doneEntry('a.jpg') }, { nc: {} }), 0);
});

// ---- the lists ----

test('the main list leaves archived entries out and never hides a receipt that needs attention; only Done ones are capped', () => {
  const state = { [key('arch.jpg')]: slimEntry(doneEntry('arch.jpg'), { at: 'T', filedAs: `${archive}/m/arch.jpg` }) };
  for (let i = 0; i < 120; i++) state[key(`d${i}.jpg`)] = doneEntry(`d${i}.jpg`, { at: iso(NOW - i * 1000) });
  for (let i = 0; i < 20; i++) state[key(`w${i}.jpg`)] = { done: false, waiting: { nextCheck: 'x' }, at: iso(NOW - 1e9 - i) };
  state[`dry:${inbox}/x.jpg@e`] = { done: true, result: 'dry-run:split', at: iso(NOW) };
  const { recent, hiddenDone } = mainList(state, false);
  assert.equal(recent.some((r) => r.file === 'arch.jpg'), false);
  assert.equal(recent.filter((r) => r.file.startsWith('w')).length, 20, 'all 20 waiting ones are listed, though they are the oldest');
  assert.equal(recent.filter((r) => r.file.startsWith('d')).length, DONE_CAP);
  assert.equal(hiddenDone, 20);
  assert.equal(recent[0].file, 'd0.jpg', 'newest first');
  assert.deepEqual(archivedList(state, false).map((r) => r.file), ['arch.jpg']);
  assert.deepEqual(archivedList(state, true), []);
});

test('Previous / Next on the main list follow exactly the list that is shown', async () => {
  const { receiptNav } = await import('../src/panel-status.js');
  const state = {};
  for (const n of ['a', 'b', 'c']) state[key(`${n}.jpg`)] = doneEntry(`${n}.jpg`, { at: `2026-02-0${'abc'.indexOf(n) + 1}T00:00:00Z` });
  state[key('b.jpg')] = slimEntry(state[key('b.jpg')], { at: 'T', filedAs: `${archive}/m/b.jpg` });
  const { recent } = mainList(state, false);
  const nav = receiptNav(recent, key('a.jpg'), cleanNav(new URLSearchParams()));
  assert.equal(nav.prev.file, 'c.jpg');
  assert.equal(nav.next, null, 'b.jpg is archived, so it is not a neighbour');
});

// ---- pages ----

const archivedRows = () => archivedList({
  [key(`${HOSTILE}.jpg`)]: slimEntry(doneEntry('x.jpg'), { at: iso(NOW), auto: true, filedAs: `${archive}/m/x.jpg`, card: { store: HOSTILE, date: '2026-03-14', total: 41.6 } }),
  [key('b.jpg')]: slimEntry(doneEntry('b.jpg'), { at: iso(NOW - DAY), filedAs: `${archive}/m/b.jpg`, fileMissing: true, card: { store: 'Shop', date: '2026-02-01', total: 5 } }),
}, false);

test('the Archived page: the two-pane list (← Receipts, search, sort, rows with Restore), the help, and everything escaped', () => {
  const html = archivedPage({ archived: archivedRows(), dryRun: false, stateError: null }, 'secret', '');
  assert.match(html, /<div class="workspace-shell archive-shell"><aside class="queue-rail archive-rail" aria-label="Archive"><h2>Archive<\/h2>/);
  assert.match(html, /data-queue-search/);
  assert.match(html, /action="restore\?key=secret"/);
  assert.equal([...html.matchAll(/<li class="archive-item/g)].length, 2);
  assert.match(html, /How archiving works/);
  assert.match(html, /Pick an archived receipt/);
  assert.ok(!html.includes('<img src=x'), 'raw markup never reaches the page');
  assert.ok(html.includes(escape(HOSTILE)));
  assert.match(html, /class="on"[^>]*>Archive/);
  assert.doesNotMatch(html.replace(/<(style|script)>[^]*?<\/\1>/g, ''), /<table/, 'no table any more');
});

test('the Archived page: empty state, and dry run says why it is empty', () => {
  assert.match(archivedPage({ archived: [], dryRun: false }, 'k', ''), /Nothing is archived yet/);
  assert.match(archivedPage({ archived: [], dryRun: true }, 'k', ''), /dry run/);
  config.archive.afterDays = 14;
  assert.match(archivedPage({ archived: [], dryRun: false }, 'k', ''), /once it is 14 days old/);
  config.archive.afterDays = 0;
  assert.match(archivedPage({ archived: [], dryRun: false }, 'k', ''), /Automatic archiving is off/);
});

test('archivedNav walks the Archived list with its own sort', () => {
  const rows = archivedRows();
  const nav = archivedNav(rows, rows[0].key, cleanNav(new URLSearchParams('sort=store&dir=asc')));
  assert.equal(nav.list.length, 2);
  assert.equal(nav.index + 1 <= 2, true);
  assert.equal(archivedNav(rows, 'nope', cleanNav(new URLSearchParams())), null);
});

test('the confirm page says how many, what moves and that it can be restored; the Status list shows the button only when live and non-empty', () => {
  const html = archiveAllPage({ dryRun: false, count: 3 }, 'k', '');
  assert.match(html, /Archive 3 done receipts\?/);
  assert.match(html, /action="archive-all\?key=k"/);
  assert.match(html, /smaller JPEGs/);
  assert.match(html, /Archived tab/);
  config.archive.shrink = false;
  assert.ok(!archiveAllPage({ dryRun: false, count: 1 }, 'k', '').includes('smaller JPEGs'));
  assert.match(archiveAllPage({ dryRun: false, count: BULK_LIMIT + 1 }, 'k', ''), /50 at a time/);
  assert.match(archiveAllPage({ dryRun: true, count: 3 }, 'k', ''), /dry run/);
  const status = (over) => statusPage({ dryRun: false, heartbeat: 'x', recent: [], archivable: 0, hiddenDone: 0, ...over }, 'k', '');
  assert.ok(!status({}).includes('action="archive-all"'));
  assert.match(status({ archivable: 4 }), /action="archive-all"[^>]*>.*Archive all done receipts \(4\)/s);
  assert.ok(!status({ archivable: 4, dryRun: true }).includes('action="archive-all"'));
  assert.match(status({ hiddenDone: 7 }), /7 older Done receipts are not shown/);
});

const viewOf = (entry, id, fixResult = { ok: false, reason: 'x' }) => ({ id, name: 'a.jpg', entry, file: entry.filedAs, pages: 0, pdf: false, photoNote: 'no photo', summaryNote: '', summary: SUMMARY, fix: fixResult });

test('wrong, cash and refund receipts offer a reversible Archive receipt action without confirming anything in Actual', () => {
  const id = key('wrong.pdf');
  const entry = { done: true, result: 'review', at: iso(NOW), filedAs: `${review}/wrong.pdf` };
  for (const receipt of [
    { ...SUMMARY.receipt, payment_method: 'card' },
    { ...SUMMARY.receipt, payment_method: 'cash' },
    { ...SUMMARY.receipt, total: -41.6, payment_method: 'card' },
  ]) {
    const html = receiptPage({ ...viewOf(entry, id), summary: { receipt, transaction: null, problems: ['No matching charge'] } }, 'k', '');
    const form = html.match(/<form\b[^>]*action="archive\?key=k"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';
    assert.match(form, /name="dismiss" value="1"/);
    assert.match(form, /name="id" value="[^"]+"/);
    assert.match(form, />Archive receipt<\/button>/);
    assert.doesNotMatch(form, /name="keep"|#review/);
    assert.match(html, /without changing Actual\. Restore it from Archive/);
  }
});

test('a receipt page: Done offers "Archive receipt"; a flagged one offers the #review wording; others say why not or nothing', () => {
  const k = key('a.jpg');
  const done = receiptPage(viewOf(doneEntry('a.jpg'), k), 'k', '');
  assert.match(done, /Archive receipt</);
  assert.match(done, /action="archive\?key=k"/);
  const flaggedEntry = doneEntry('a.jpg', { result: 'split+review', filedAs: `${review}/a.jpg` });
  const flagged = receiptPage(viewOf(flaggedEntry, k, { ok: true, kind: 'applied', dry: false, items: [], options: [], picks: [], changed: [], preview: null }), 'k', '');
  assert.match(flagged, /Looks right: clear #review and archive</);
  assert.match(receiptPage(viewOf(flaggedEntry, k, { ok: false, reason: 'too old' }), 'k', ''), /Can.{1,6}t be archived from here[^<]*too old/);
  const waiting = receiptPage(viewOf({ done: false, waiting: { nextCheck: 'x' } }, k), 'k', '');
  assert.ok(!waiting.includes('<button class="plain">Looks right'));
  assert.match(receiptPage(viewOf(doneEntry('a.jpg', { filedAs: '/Elsewhere/a.jpg' }), k), 'k', ''), /Can.{1,6}t be archived: Its file is not in the Processed folder/);
  config.dryRun = true;
  assert.ok(!receiptPage(viewOf(doneEntry('a.jpg'), k), 'k', '').includes('<button class="plain">Looks right'));
});

test('an archived receipt\'s page: the one line, Restore, no archive / Try again / fix controls, and it goes back to the Archived tab', () => {
  const k = key('a.jpg');
  const entry = slimEntry(doneEntry('a.jpg'), { at: iso(NOW), filedAs: `${archive}/m/a.jpg`, shrunk: { before: 100, after: 50 }, card: {} });
  const html = receiptPage(viewOf(entry, k, fix.editorFor({ id: k, entry, summary: SUMMARY, query: null })), 'k', '');
  assert.match(html, /Archived\. Restore it to change its categories\./);
  assert.match(html, /action="restore\?key=k"/);
  assert.match(html, /was shrunk when it was archived/);
  assert.ok(!html.includes('<button class="plain">Looks right'));
  assert.ok(!html.includes('<button class="plain">Try again'));
  assert.ok(!html.includes('name="preview"'));
  assert.match(html, /href="archived\?key=k/);
  assert.ok(!receiptPage(viewOf({ ...entry, archived: { ...entry.archived, fileMissing: true } }, k), 'k', '').includes('was shrunk'));
  assert.match(receiptPage(viewOf({ ...entry, archived: { ...entry.archived, fileMissing: true } }, k), 'k', ''), /already gone from Nextcloud/);
});

// ---- refusals ----

test('fix and Try again refuse an archived receipt with a clear message', async () => {
  const k = key('a.jpg');
  const entry = slimEntry(doneEntry('a.jpg'), { at: 'T', filedAs: `${archive}/m/a.jpg`, card: {} });
  assert.deepEqual(fix.classify(k, entry, SUMMARY), { ok: false, reason: 'Archived. Restore it to change its categories.' });
  assert.equal(retryStatus(k, { ...entry, result: 'review', applied: undefined }), 'no');
  fs.writeFileSync(config.statePath, JSON.stringify({ [k]: entry }));
  await assert.rejects(() => tryAgain(new URLSearchParams({ entry: k })), (e) => e instanceof PanelError && /archived\. Restore it first/i.test(e.message));
  await assert.rejects(() => fix.commitFix(new URLSearchParams({ id: k, token: 't', state: 's' }), {}, { nextcloud: { readSummary: async () => SUMMARY }, lockWaitMs: 100 }), (e) => e instanceof PanelError && /Archived\. Restore it/.test(e.message));
});

test('the Undo of a category fix is refused once the receipt was archived', async () => {
  const k = key('a.jpg');
  const entry = slimEntry(doneEntry('a.jpg'), { at: 'T', filedAs: `${archive}/m/a.jpg`, card: {} });
  fs.writeFileSync(config.statePath, JSON.stringify({ [k]: entry }));
  const { signUndo } = await import('../src/panel-actions.js');
  const form = new URLSearchParams(signUndo('undo-receipt-fix', { id: k, at: '2026-11-08T11:55:00.000Z' }));
  const msg = await fix.undoFix(form, {}, { nextcloud: { readSummary: async () => SUMMARY }, lockWaitMs: 100 });
  assert.match(msg, /archived since/);
});

// P8a (owner decision 2026-11-12, option (a)): an explicit single archive is allowed right after a save and ends its Undo. This test used to
// say "archiving refuses while the Undo of a category fix is still open"; the refusal now stays only for the default check, bulk and auto.
test('archiving while the Undo of a category fix is open: allowed one at a time (ending the Undo); bulk and automatic still wait', () => {
  const entry = doneEntry('a.jpg', { fixedOnPage: { at: iso(Date.now() - 60000) } });
  assert.match(canArchive(key('a.jpg'), entry).reason, /Undo/, 'without endsUndo the check is as before');
  assert.deepEqual(canArchive(key('a.jpg'), entry, { endsUndo: true }), { ok: true, kind: 'done' });
  for (const mode of ['bulk', 'auto']) assert.match(canArchive(key('a.jpg'), entry, { mode, endsUndo: true }).reason, /Undo/, mode);
  assert.deepEqual(bulkCandidates({ [key('a.jpg')]: entry }), [], 'Archive all never ends a fresh Undo');
  assert.deepEqual(dueForAutoArchive({ [key('a.jpg')]: entry }, { days: 1 }), [], 'nor does automatic archiving');
  assert.deepEqual(bulkCandidates({ [key('a.jpg')]: doneEntry('a.jpg', { fixedOnPage: { at: iso(Date.now() - 20 * 60000) } }) }), [key('a.jpg')]);
  // A save that has not finished still blocks every archive, Undo or not.
  for (const over of [{ fixedOnPage: { at: iso(Date.now() - 60000), summaryFailed: true } }, { filing: { kind: 'page' }, fixedOnPage: { at: iso(Date.now() - 60000) } }]) {
    assert.equal(canArchive(key('a.jpg'), doneEntry('a.jpg', over), { endsUndo: true }).ok, false, JSON.stringify(over));
    assert.equal(canArchive(key('a.jpg'), doneEntry('a.jpg', over), { endsUndo: true, dismiss: true }).ok, false, JSON.stringify(over));
  }
  config.dryRun = true;
  assert.equal(canArchive(key('a.jpg'), entry, { endsUndo: true }).ok, false, 'dry run still refuses');
});

test('P8a: archiving right after Save or Create cash works, says the Undo has ended, and the old Undo is refused; right after Looks right (no Undo) it says nothing about Undo', async () => {
  const recent = iso(Date.now() - 60000);
  const cases = {
    'saved.pdf': { fixedOnPage: { at: recent, kind: 'applied' } },
    'looks-right.pdf': { fixedOnPage: { at: recent, kind: 'applied', markOnly: true } },
    'cash.pdf': { applied: { txnId: 'new1', action: 'categorize', at: recent, created: true }, fixedOnPage: { at: recent, kind: 'cash', created: 'new1' } },
    'old.pdf': { fixedOnPage: { at: iso(Date.now() - 20 * 60000), kind: 'applied' } },
  };
  const c = fakeClient();
  const state = {};
  for (const [name, over] of Object.entries(cases)) {
    state[key(name)] = doneEntry(name, over);
    c.files.set(`${processed}/${name}`, Buffer.from(big));
    c.files.set(`${processed}/${name}.json`, Buffer.from(JSON.stringify(SUMMARY)));
  }
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  const deps = { nc: fakeNc(c), lockWaitMs: 200 };
  const orig = console.log;
  console.log = () => {};
  try {
    for (const name of ['saved.pdf', 'looks-right.pdf', 'cash.pdf']) {
      const out = {};
      const msg = await archiveOne(new URLSearchParams({ id: key(name), from: 'receipt', next: '' }), out, deps);
      assert.match(msg, new RegExp(`Archived ${name.replace('.', '\\.')}\\.`));
      if (name === 'looks-right.pdf') assert.doesNotMatch(msg, /Undo/, 'a Looks right had no Undo to end');
      else assert.match(msg, /Undo for the last save is no longer available\.$/, name);
      assert.equal(out.archived, true);
    }
    assert.doesNotMatch(await archiveOne(new URLSearchParams({ id: key('old.pdf') }), {}, deps), /Undo/, 'an Undo already run out: nothing to say');
  } finally {
    console.log = orig;
  }
  const { signUndo } = await import('../src/panel-actions.js');
  for (const name of ['saved.pdf', 'cash.pdf']) {
    const form = new URLSearchParams(signUndo('undo-receipt-fix', { id: key(name), at: recent }));
    assert.match(await fix.undoFix(form, {}, { nextcloud: { readSummary: async () => SUMMARY }, lockWaitMs: 100 }), /archived since/, name);
  }
});

test('P8a: a dismissal keeps the page fix for Restore but ends its Undo, so a quick Restore cannot bring the old Undo back', async () => {
  const actual = new Proxy({}, { get() { assert.fail('dismissal, Restore and the refused Undo must not access Actual'); } });
  const id = key('dismissed.pdf');
  const source = `${review}/dismissed.pdf`;
  const at = iso(Date.now() - 60000);
  const entry = { done: true, result: 'review', at, filedAs: source, fixedOnPage: { at, kind: 'applied', lessons: [] } };
  const c = fakeClient({ [source]: big, [`${source}.json`]: JSON.stringify(SUMMARY) });
  const nc = fakeNc(c);
  fs.writeFileSync(config.statePath, JSON.stringify({ [id]: entry }));
  const orig = console.log;
  console.log = () => {};
  try {
    const msg = await archiveOne(new URLSearchParams({ id, dismiss: '1' }), {}, { nc, actual, lockWaitMs: 200 });
    assert.match(msg, /Undo for the last save is no longer available\./);
    const archived = (await loadState())[id];
    assert.equal(archived.fixedOnPage.at, at, 'the page fix record is kept');
    assert.ok(archived.fixedOnPage.undoEnded, 'stamped: its Undo is over');
    await restoreOne(new URLSearchParams({ id }), {}, { nc, actual, lockWaitMs: 200 });
    const restored = (await loadState())[id];
    assert.equal(restored.archived, undefined);
    assert.ok(restored.fixedOnPage.undoEnded, 'Restore does not clear the stamp');
  } finally {
    console.log = orig;
  }
  const { signUndo } = await import('../src/panel-actions.js');
  const form = new URLSearchParams(signUndo('undo-receipt-fix', { id, at }));
  assert.match(await fix.undoFix(form, {}, { nextcloud: { readSummary: async () => SUMMARY }, actual, lockWaitMs: 100 }), /archived after this save, which ended its Undo/);
});

test('P8a: the receipt page offers Archive right after a save, with no disabled state; dry run offers none', () => {
  const k = key('a.jpg');
  const fresh = doneEntry('a.jpg', { fixedOnPage: { at: iso(Date.now() - 60000), kind: 'applied' } });
  const html = receiptPage(viewOf(fresh, k), 'k', '');
  assert.match(html, /<form method="post" action="archive\?key=k">[\s\S]*?>Archive receipt<\/button><\/form>/);
  assert.doesNotMatch(html, /Undo for that is still open|disabled[^>]*>Archive/);
  assert.match(html, /until the receipt is archived: archiving ends it/);
  config.dryRun = true;
  assert.doesNotMatch(receiptPage(viewOf(fresh, k), 'k', ''), /action="archive\?key=k"/);
});

// ---- the page actions (archive / archive all / restore), against stand-ins ----

test('archiveOne, archiveAll and restoreOne: state, notices and dry run', async () => {
  const c = fakeClient();
  const state = {};
  for (const name of ['a.pdf', 'b.pdf']) {
    state[key(name)] = doneEntry(name);
    c.files.set(`${processed}/${name}`, Buffer.from(big));
    c.files.set(`${processed}/${name}.json`, Buffer.from(JSON.stringify(SUMMARY)));
  }
  state[key('w.jpg')] = { done: false, waiting: { nextCheck: 'x' } };
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  const deps = { nc: fakeNc(c), lockWaitMs: 200 };
  const orig = console.log;
  console.log = () => {};
  try {
    const out = {};
    const msg = await archiveOne(new URLSearchParams({ id: key('a.pdf') }), out, deps);
    assert.match(msg, /Archived a\.pdf\./);
    assert.equal(out.archived, true);
    let now = await loadState();
    assert.equal(now[key('a.pdf')].filedAs, `${archive}/2026-03/a.pdf`);
    assert.equal(now[key('a.pdf')].reading, undefined);
    await assert.rejects(() => archiveOne(new URLSearchParams({ id: key('a.pdf') }), {}, deps), /Not archived\. It is already archived/);
    await assert.rejects(() => archiveOne(new URLSearchParams({ id: key('w.jpg') }), {}, deps), /Not archived/);
    const all = await archiveAll(new URLSearchParams(), {}, deps);
    assert.match(all, /Archived 1 receipt\./);
    assert.match(await archiveAll(new URLSearchParams(), {}, deps), /no Done receipts/);
    now = await loadState();
    assert.ok(now[key('b.pdf')].archived && now[key('w.jpg')].waiting);
    const back = {};
    const text = await restoreOne(new URLSearchParams({ id: key('a.pdf') }), back, deps);
    assert.match(text, /Restored a\.pdf to Receipts\/Processed\./);
    assert.equal(back.restored, true);
    now = await loadState();
    assert.equal(now[key('a.pdf')].archived, undefined);
    assert.ok(now[key('a.pdf')].restoredAt);
    assert.equal(now[key('a.pdf')].filedAs, `${processed}/a.pdf`);
    await assert.rejects(() => restoreOne(new URLSearchParams({ id: key('a.pdf') }), {}, deps), /not archived/);
    config.dryRun = true;
    await assert.rejects(() => archiveAll(new URLSearchParams(), {}, deps), /Dry run/);
    await assert.rejects(() => restoreOne(new URLSearchParams({ id: key('b.pdf') }), {}, deps), /Dry run/);
  } finally {
    console.log = orig;
  }
});

test('archiveOne: a failing move leaves the entry and the photo as they were', async () => {
  const c = fakeClient({ [`${processed}/a.jpg`]: big });
  fs.writeFileSync(config.statePath, JSON.stringify({ [key('a.jpg')]: doneEntry('a.jpg') }));
  const nc = { ...fakeNc(c), archiveFile: async () => { throw new Error('Nextcloud is down'); } };
  const orig = console.log;
  console.log = () => {};
  try {
    await assert.rejects(() => archiveOne(new URLSearchParams({ id: key('a.jpg') }), {}, { nc, lockWaitMs: 200 }), /Not archived\. The photo was not moved\. Nextcloud said: Nextcloud is down/);
  } finally {
    console.log = orig;
  }
  assert.equal((await loadState())[key('a.jpg')].archived, undefined);
  assert.equal(c.files.get(`${processed}/a.jpg`).toString(), big);
});

test('dismissal archives unresolved and applied-review receipts reversibly without opening or changing Actual', async () => {
  const actual = new Proxy({}, { get() { assert.fail('dismissal and Restore must not access Actual'); } });
  for (const [name, result, applied] of [
    ['unmatched.pdf', 'review', undefined], ['failed.pdf', 'failed', undefined],
    ['flagged.pdf', 'split+review', { txnId: 't1', action: 'split', at: 'T' }],
    ['failed-applied.pdf', 'failed', { txnId: 't1', action: 'split', at: 'T' }],
  ]) {
    const id = key(name);
    const source = `${review}/${name}`;
    const entry = {
      done: true, result, at: iso(NOW), filedAs: source,
      ...(applied ? { applied, reviewed: { at: 'cached observation' } } : {}),
      reading: { receipt: { merchant: 'Corrected merchant', total: 41.6 } },
      receiptFields: { merchant: 'Corrected merchant' },
      error: 'Original review detail', attempts: 3,
    };
    const summary = { ...SUMMARY, problems: ['No bank charge matched'], receipt: { ...SUMMARY.receipt, payment_method: 'card' } };
    const c = fakeClient({ [source]: big, [`${source}.json`]: JSON.stringify(summary) });
    const nc = fakeNc(c);
    fs.writeFileSync(config.statePath, JSON.stringify({ [id]: entry }));
    const out = {};
    await archiveOne(new URLSearchParams({ id, dismiss: '1', keep: '1' }), out, { nc, actual, lockWaitMs: 200 });
    assert.equal(out.archived, true);
    const archived = (await loadState())[id];
    assert.equal(archived.archived.dismissed, true);
    assert.equal(archived.archived.restoreTo, 'review');
    assert.equal(archived.result, result, 'dismissal does not clear the review status');
    assert.deepEqual(archived.applied, applied);
    assert.equal(c.files.has(source), false);
    assert.deepEqual(c.json(archived.filedAs).problems, summary.problems);
    assert.deepEqual(mainList({ [id]: archived }, false).recent, []);
    await restoreOne(new URLSearchParams({ id }), {}, { nc, actual, lockWaitMs: 200 });
    const restored = (await loadState())[id];
    const { reviewed: _cached, ...original } = entry;
    assert.deepEqual(restored, { ...original, card: cardOf(summary), restoredAt: restored.restoredAt });
    assert.ok(restored.restoredAt);
    assert.deepEqual(c.json(source).problems, summary.problems);
    assert.equal(mainList({ [id]: restored }, false).recent.length, 1);
  }
});

test('dismissal respects the session lock and pending dry-run switch before moving any file', async () => {
  const { exclusive } = await import('../src/session-lock.js');
  const id = key('wrong.pdf');
  const entry = { done: true, result: 'review', at: iso(NOW), filedAs: `${review}/wrong.pdf` };
  const c = fakeClient({ [entry.filedAs]: big });
  fs.writeFileSync(config.statePath, JSON.stringify({ [id]: entry }));
  const form = new URLSearchParams({ id, dismiss: '1' });
  const deps = { nc: fakeNc(c), lockWaitMs: 20 };
  let release;
  const held = exclusive(() => new Promise((resolve) => { release = resolve; }));
  try {
    await assert.rejects(archiveOne(form, {}, deps), /in the middle of a check/);
  } finally {
    release();
    await held;
  }
  fs.writeFileSync(config.settingsPath, JSON.stringify({ dryRun: true }));
  await assert.rejects(archiveOne(form, {}, deps), /Dry run/);
  assert.deepEqual((await loadState())[id], entry);
  assert.equal(c.files.get(entry.filedAs).toString(), big);
  assert.deepEqual(c.calls, []);
});

test('archive redirects: after a success from a receipt page go to the next receipt; restore falls back to the Archived tab', () => {
  const form = new URLSearchParams({ from: 'receipt', id: key('a.jpg'), next: key('b.jpg'), sort: 'when' });
  assert.deepEqual(archiveTarget(form, { archived: true }), { where: './receipt', extra: `&id=${encodeURIComponent(key('b.jpg'))}&sort=when` });
  assert.equal(archiveTarget(form, {}).extra.includes(encodeURIComponent(key('a.jpg'))), true);
  assert.equal(archiveTarget(new URLSearchParams({ from: 'receipt', next: '' }), { archived: true }).where, './');
  assert.equal(restoreTarget(new URLSearchParams({ from: 'receipt', next: '' }), { restored: true }).where, './archived');
  assert.equal(restoreTarget(new URLSearchParams(), {}).where, './archived');
});

test('POST /restore (P7): a success opens the restored receipt in its group, from the Archive list too; a refusal stays on the Archive list', async () => {
  const c = fakeClient();
  const id = key('back.jpg');
  const archived = slimEntry(doneEntry('back.jpg'), { at: iso(NOW), filedAs: `${archive}/2026-03/back.jpg`, card: { store: 'Target', date: '2026-03-14', total: 41.6 } });
  c.files.set(archived.filedAs, Buffer.from(big));
  c.files.set(`${archived.filedAs}.json`, Buffer.from(JSON.stringify(SUMMARY)));
  fs.writeFileSync(config.statePath, JSON.stringify({ [id]: archived }));
  const server = makeServer(() => {}, { nc: fakeNc(c), lockWaitMs: 200 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const orig = console.log;
  console.log = () => {};
  try {
    const res = await fetch(`${base}/restore?key=secret`, { method: 'POST', body: new URLSearchParams({ id }), redirect: 'manual' });
    assert.equal(res.status, 303);
    const to = new URL(res.headers.get('location'), 'http://x/');
    assert.equal(to.pathname, '/receipt');
    assert.equal(to.searchParams.get('id'), id);
    assert.equal(to.searchParams.get('group'), null, 'no group: the receipt opens in its own (Filed)');
    assert.match(to.searchParams.get('notice'), /Restored back\.jpg/);
    assert.equal((await loadState())[id].archived, undefined);
    const again = await fetch(`${base}/restore?key=secret`, { method: 'POST', body: new URLSearchParams({ id }), redirect: 'manual' });
    const refused = new URL(again.headers.get('location'), 'http://x/');
    assert.equal(refused.pathname, '/archived');
    assert.match(refused.searchParams.get('notice'), /not archived/);
  } finally {
    console.log = orig;
    server.closeAllConnections();
    server.close();
  }
});

// ---- the server: the Archived tab, an archived receipt's page, photo from the archive folder ----

test('GET /archived, GET /receipt of an archived receipt, and its photo from the Archive folder', async () => {
  const k = key('a.jpg');
  const entry = slimEntry(doneEntry('a.jpg'), { at: iso(NOW), filedAs: `${archive}/2026-03/a.jpg`, card: { store: 'Target', date: '2026-03-14', total: 41.6 } });
  fs.writeFileSync(config.statePath, JSON.stringify({ [k]: entry, [key('live.jpg')]: doneEntry('live.jpg') }));
  const nextcloud = {
    async statPath() { return { size: 4, etag: 'e' }; },
    async downloadPath() { return Buffer.from('jpeg'); },
    async readSummary(p) { assert.equal(p, `${archive}/2026-03/a.jpg`); return SUMMARY; },
  };
  const server = makeServer(() => {}, { nextcloud, prepare: async () => ['data:image/jpeg;base64,/9j/'] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/archived?key=secret`)).text();
    assert.match(list, /Target/);
    assert.ok(!list.includes('live.jpg'));
    const main = await (await fetch(`${base}/?key=secret`)).text();
    assert.ok(!main.includes('>a.jpg<') && main.includes('live.jpg'));
    const page = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(k)}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Archived\. Restore it to change its categories\./);
    assert.match(html, /1 of 1/);
    const photo = await fetch(`${base}/receipt-photo?key=secret&id=${encodeURIComponent(k)}`);
    assert.equal(photo.status, 200);
    const confirm = await (await fetch(`${base}/archive-all?key=secret`)).text();
    assert.match(confirm, /Archive 1 done receipt\?/);
  } finally {
    server.close();
  }
});

// ---- settings ----

test('the Archive folder may not be, or sit inside, another receipts folder', () => {
  const f = { inbox: '/R/Inbox', processed: '/R/Processed', review: '/R/Needs review' };
  assert.equal(archiveFolderProblem({ ...f, archive: '/R/Archive' }), null);
  assert.equal(archiveFolderProblem({ ...f, archive: '/R/Inbox/Archive' }), null, 'inside the inbox is harmless: the inbox is only listed');
  assert.match(archiveFolderProblem({ ...f, archive: '/R/Processed' }), /same folder as the Processed/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R/Needs review/old/' }), /inside the Needs review/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R/Processed/Archive' }), /inside the Processed/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R/Inbox' }), /same folder as the inbox/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R' }), /can't hold/);
  assert.match(archiveFolderProblem({ ...f, archive: '/' }), /root/);
  assert.match(archiveFolderProblem({ ...f, archive: '//' }), /root/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R//Processed/./x' }), /inside the Processed/);
  assert.match(archiveFolderProblem({ ...f, archive: '/R/../x' }), /"\.\."/);
});

const BASE = { ACTUAL_SERVER_URL: 'http://a.invalid', ACTUAL_PASSWORD: 'p', ACTUAL_SYNC_ID: 's', NEXTCLOUD_URL: 'http://n.invalid', NEXTCLOUD_USER: 'u', NEXTCLOUD_APP_PASSWORD: 'q' };

test('config: archive defaults (folder, off, shrink on) and a clashing folder turns archiving off but does not stop the build', () => {
  const c = buildConfig(BASE, { quiet: true });
  assert.equal(c.nextcloud.archive, '/Receipts/Archive');
  assert.deepEqual(c.archive, { afterDays: 0, shrink: true, problem: null });
  const set = buildConfig({ ...BASE, ARCHIVE_AFTER_DAYS: '30', ARCHIVE_SHRINK_PHOTOS: 'false', RECEIPTS_ARCHIVE: '/A' }, { quiet: true });
  assert.deepEqual(set.archive, { afterDays: 30, shrink: false, problem: null });
  assert.equal(set.nextcloud.archive, '/A');
  assert.match(buildConfig({ ...BASE, RECEIPTS_ARCHIVE: '/Receipts/Processed/Old' }, { quiet: true }).archive.problem, /inside the Processed folder/);
  assert.match(buildConfig({ ...BASE, RECEIPTS_ARCHIVE: '/Receipts/Inbox' }, { quiet: true }).archive.problem, /same folder as the inbox/);
  // an upgrade whose Processed folder is /Receipts makes the default archive folder clash: the worker still starts, archiving is off
  assert.match(buildConfig({ ...BASE, RECEIPTS_PROCESSED: '/Receipts' }, { quiet: true }).archive.problem, /inside the Processed/);
  assert.equal(c.archive.problem, null);
});

test('the Settings tab checks the new settings', () => {
  assert.deepEqual(checkChanges({ ARCHIVE_AFTER_DAYS: '45', ARCHIVE_SHRINK_PHOTOS: 'off', RECEIPTS_ARCHIVE: '/Receipts/Old/' }).values, { ARCHIVE_AFTER_DAYS: '45', ARCHIVE_SHRINK_PHOTOS: 'false', RECEIPTS_ARCHIVE: '/Receipts/Old' });
  assert.throws(() => checkChanges({ ARCHIVE_AFTER_DAYS: '-1' }), SettingError);
  assert.throws(() => checkChanges({ ARCHIVE_AFTER_DAYS: '2.5' }), /whole number/);
  assert.throws(() => checkChanges({ ARCHIVE_AFTER_DAYS: 'soon' }), /not a number/);
  assert.throws(() => checkChanges({ ARCHIVE_SHRINK_PHOTOS: 'maybe' }), /on or off/);
  assert.throws(() => checkChanges({ RECEIPTS_ARCHIVE: 'Receipts/Archive' }), /must start with \//);
  assert.match(checkChanges({ RECEIPTS_ARCHIVE: '/Receipts/Needs review/Archive' }).candidate.archive.problem, /inside the Needs review/);
});

// ---- review fixes ----

test('archiveOne, archiveAll and restoreOne wait for the session lock and say "busy" when it stays taken', async () => {
  const { exclusive } = await import('../src/session-lock.js');
  const c = fakeClient({ [`${processed}/a.pdf`]: big, [`${processed}/a.pdf.json`]: JSON.stringify(SUMMARY) });
  fs.writeFileSync(config.statePath, JSON.stringify({ [key('a.pdf')]: doneEntry('a.pdf'), [key('z.pdf')]: slimEntry(doneEntry('z.pdf'), { at: 'T', filedAs: `${archive}/m/z.pdf` }) }));
  const deps = { nc: fakeNc(c), lockWaitMs: 30 };
  let release;
  const held = exclusive(() => new Promise((r) => { release = r; }));
  try {
    for (const run of [() => archiveOne(new URLSearchParams({ id: key('a.pdf') }), {}, deps), () => archiveAll(new URLSearchParams(), {}, deps), () => restoreOne(new URLSearchParams({ id: key('z.pdf') }), {}, deps)]) {
      await assert.rejects(run, (e) => e instanceof PanelError && /in the middle of a check/.test(e.message));
    }
    assert.ok(c.files.has(`${processed}/a.pdf`), 'nothing moved while the lock was held');
  } finally {
    release();
    await held;
  }
});

test('a clashing Archive folder turns archiving off (manual, bulk, auto) with a clear reason; Restore still works', async () => {
  config.archive.problem = 'RECEIPTS_ARCHIVE (/Receipts/Archive) can\'t be inside the Processed folder (/Receipts)';
  try {
    assert.match(canArchive(key('a.jpg'), doneEntry('a.jpg')).reason, /Archiving is turned off.*Settings tab/);
    assert.deepEqual(bulkCandidates({ [key('a.jpg')]: doneEntry('a.jpg') }), []);
    config.archive.afterDays = 1;
    assert.equal(await autoArchive({ [key('a.jpg')]: doneEntry('a.jpg') }, { nc: {}, now: NOW + 400 * DAY }), 0);
    fs.writeFileSync(config.statePath, JSON.stringify({ [key('a.jpg')]: doneEntry('a.jpg') }));
    await assert.rejects(() => archiveOne(new URLSearchParams({ id: key('a.jpg') }), {}, { nc: {} }), /Archiving is turned off/);
    await assert.rejects(() => archiveAll(new URLSearchParams(), {}, { nc: {} }), /Archiving is turned off/);
    assert.match(statusPage({ dryRun: false, heartbeat: 'x', recent: [] }, 'k', ''), /Archiving is turned off/);
    assert.match(archivedPage({ archived: [], dryRun: false }, 'k', ''), /Archiving is turned off/);
  } finally {
    config.archive.problem = null;
  }
});

test('automatic archiving waits while a switch to dry run is pending', async () => {
  config.archive.afterDays = 1;
  fs.writeFileSync(config.settingsPath, JSON.stringify({ dryRun: true, changedAt: 'x', changedBy: 't' }));
  try {
    assert.equal(await autoArchive({ [key('a.jpg')]: doneEntry('a.jpg') }, { nc: {}, now: NOW }), 0);
  } finally {
    fs.rmSync(config.settingsPath, { force: true });
  }
});

test('a restored receipt is not hidden by the Done cap: it counts from when it was restored', () => {
  const state = {};
  for (let i = 0; i < DONE_CAP + 5; i++) state[key(`d${i}.jpg`)] = doneEntry(`d${i}.jpg`, { at: iso(NOW - i * 1000) });
  state[key('restored.jpg')] = doneEntry('restored.jpg', { at: '2020-01-01T00:00:00.000Z', restoredAt: iso(NOW + 1000) });
  const { recent } = mainList(state, false);
  assert.equal(recent[0].file, 'restored.jpg');
});

test('archiveMonth refuses impossible months', () => {
  assert.equal(archiveMonth({ receipt: { date: '2026-13-01' } }, '2026-05-01T00:00:00Z'), '2026-05');
  assert.equal(archiveMonth({ receipt: { date: '2026-00-10' } }, '2026-13-01T00:00:00Z').length, 7);
});

test('canArchive refuses while a page fix could not save its summary, but not for the Undo-less #review clearing (Looks right)', () => {
  const k = key('a.jpg');
  assert.match(canArchive(k, doneEntry('a.jpg', { fixedOnPage: { at: iso(NOW - DAY), summaryFailed: true } }), { now: NOW }).reason, /could not be saved/);
  assert.equal(canArchive(k, doneEntry('a.jpg', { fixedOnPage: { at: iso(NOW - 1000), markOnly: true } }), { now: NOW }).ok, true);
});

test('Looks right has no Undo: a fresh markOnly record (also an older one that once offered Undo) is finished at once for Archive all and auto archive', async () => {
  const { undoOpen } = await import('../src/archive-rules.js');
  const recent = iso(Date.now() - 60000);
  const looksRight = doneEntry('lr.jpg', { fixedOnPage: { at: recent, kind: 'applied', markOnly: true } });
  const older = doneEntry('old-lr.jpg', { fixedOnPage: { at: recent, kind: 'applied', markOnly: true, undoOffered: true } });
  const saved = doneEntry('saved.jpg', { fixedOnPage: { at: recent, kind: 'applied' } });
  for (const entry of [looksRight, older]) {
    assert.equal(undoOpen(entry), false, 'no Undo is open');
    assert.equal(canArchive(key('lr.jpg'), entry, { mode: 'bulk' }).ok, true);
    assert.equal(canArchive(key('lr.jpg'), entry, { mode: 'auto' }).ok, true);
  }
  assert.equal(undoOpen(saved), true, 'Save keeps its Undo');
  assert.deepEqual(bulkCandidates({ [key('lr.jpg')]: looksRight, [key('old-lr.jpg')]: older, [key('saved.jpg')]: saved }).sort(), [key('lr.jpg'), key('old-lr.jpg')].sort(), 'Archive all still waits out a Save\'s Undo');
});

test('an archived receipt is found where it was archived even after RECEIPTS_ARCHIVE changed; a path outside is never served', async () => {
  const { locate } = await import('../src/panel-receipt.js');
  const entry = slimEntry(doneEntry('a.jpg'), { at: 'T', filedAs: '/Old archive/2026-03/a.jpg', folder: '/Old archive' });
  assert.equal(locate(key('a.jpg'), entry), '/Old archive/2026-03/a.jpg');
  assert.equal(locate(key('a.jpg'), { ...entry, filedAs: '/Elsewhere/a.jpg' }), null);
  assert.equal(locate(key('a.jpg'), { ...entry, filedAs: '/Old archive/../etc/a.jpg' }), null);
});

test('the Archived list\'s search words match the row text, and its rows open the receipt by client navigation', () => {
  const [row] = archivedRows().filter((r) => r.archived.fileMissing);
  assert.match(ARCHIVE_ORDERING.words(row), /^Shop \$5\.00 2026-02-01 b\.jpg Was Filed · Archived .*\(photo was already gone\)/, 'the displayed text, $ included, as the row shows it');
  assert.match(archivedPage({ archived: [row], dryRun: false }, 'k', ''), /<a class="queue-row" data-navigate data-queue-row data-id="[^"]*" data-search="[^"]*" href="receipt\?key=k&#38;id=[^"]*"><span class="queue-store">Shop<\/span>/);
});

test('archiving with no readable summary keeps the card the list already had', async () => {
  const c = fakeClient({ [`${processed}/a.pdf`]: big });
  const kept = { store: 'Corner Grocery', date: '2026-11-06', total: 84.12 };
  const slim = await archiveReceipt(doneEntry('a.pdf', { card: kept }), { nc: fakeNc(c), now: NOW });
  assert.deepEqual(slim.card, kept);
  const none = await archiveReceipt(doneEntry('a.pdf'), { nc: { ...fakeNc(fakeClient({ [`${processed}/a.pdf`]: big })) }, now: NOW });
  assert.deepEqual(none.card, { store: '', date: '', total: null });
});
