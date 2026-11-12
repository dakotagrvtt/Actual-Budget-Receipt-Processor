// The receipt view: GET /receipt and GET /receipt-photo, with a stand-in for Nextcloud and for the image conversion. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { makeServer } from '../src/trigger.js';
import { clearPhotoCache } from '../src/panel-receipt.js';
import { saveDrySummary } from '../src/dry-summaries.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-receipt-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), dryRun: false });
config.trigger.token = 'secret';
const { inbox, processed, review } = config.nextcloud;

const HOSTILE = '<script>alert(1)</script> & "q"';
const JPEG = Buffer.from('fake-jpeg-bytes');
const PAGE2 = Buffer.from('second-page');
const uri = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;

const K_INBOX = `${inbox}/waiting.jpg@e1`;
const K_DONE = `${inbox}/done.pdf@e2`;
const K_DRY = `dry:${inbox}/dry.heic@e3`;
const K_EVIL = `${inbox}/../../etc/passwd@e4`;
const K_ODD = `${inbox}/<b>${HOSTILE}.jpg@e5`;
const K_OUT = `/Elsewhere/x.jpg@e6`;
const K_BAD_FILED = `${inbox}/y.jpg@e7`;

const files = new Map();
const calls = [];
let down = false;
let summaryDown = false;
const etags = new Map();
const sizes = new Map();
let busyGate = null;
const preps = [];
const nextcloud = {
  async statPath(p) {
    calls.push(`stat ${p}`);
    if (down) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { size: sizes.get(p) ?? files.get(p).length, etag: etags.get(p) ?? 'e' };
  },
  async downloadPath(p) {
    calls.push(`get ${p}`);
    if (busyGate) await busyGate;
    if (down) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 });
    return files.get(p);
  },
  async readSummary(p) {
    if (summaryDown) throw new Error('ECONNREFUSED');
    return p === `${review}/done.pdf` ? { receipt: { merchant: 'Corner <Store>', total: 12.5, items: [{ description: 'MILK', plain: 'milk', amount: 12.5 }] }, problems: ['total is off <by> a cent'], transaction: { payee: 'Corner', date: '2026-05-01', amount: '12.50' } } : null;
  },
};
const prepare = async (buf, name, side, opts) => {
  preps.push({ name, side, opts });
  return name.endsWith('.pdf') ? [uri(buf), uri(PAGE2)] : [uri(buf)];
};

let server;
let base;
test.before(async () => {
  fs.writeFileSync(config.statePath, JSON.stringify({
    [K_INBOX]: { done: false, waiting: { nextCheck: '2026-05-04T10:00:00Z' }, result: 'waiting for the bank charge', at: '2026-05-04T10:00:00Z', reading: { receipt: { merchant: HOSTILE, date: '2026-05-03', date_as_printed: '5/3', total: 9.99, tax: 0.5, currency: 'USD', items: [{ description: HOSTILE, plain: '<i>x</i>', amount: 4.25 }, { description: 'B', plain: 'b', amount: 5.74 }] }, mode: 'constrained' } },
    [K_DONE]: { done: true, result: 'review', at: '2026-05-05T10:00:00Z', filedAs: `${review}/done.pdf` },
    [K_DRY]: { done: true, result: 'dry-run:categorize', at: '2026-05-06T10:00:00Z' },
    [K_EVIL]: { done: true, result: 'x', at: '2026-05-06T10:00:00Z' },
    [K_ODD]: { done: true, result: 'categorize', at: '2026-05-06T10:00:00Z', filedAs: `${processed}/odd.jpg` },
    [K_OUT]: { done: true, result: 'x', at: '2026-05-06T10:00:00Z' },
    [K_BAD_FILED]: { done: true, result: 'x', at: '2026-05-06T10:00:00Z', filedAs: '/etc/passwd' },
  }));
  server = makeServer(() => {}, { nextcloud, prepare });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
});
test.beforeEach(() => {
  clearPhotoCache();
  calls.length = 0;
  down = false;
  summaryDown = false;
  busyGate = null;
  preps.length = 0;
  etags.clear();
  sizes.clear();
  files.clear();
  files.set(`${inbox}/waiting.jpg`, JPEG);
  files.set(`${review}/done.pdf`, Buffer.from('%PDF-1.4 fake'));
  files.set(`${processed}/odd.jpg`, JPEG);
});

const q = (p, id, extra = '', key = 'secret') => fetch(`${base}${p}?${key === null ? '' : `key=${encodeURIComponent(key)}&`}id=${encodeURIComponent(id)}${extra}`);

test('both routes answer 403 without the key', async () => {
  for (const p of ['/receipt', '/receipt-photo']) {
    assert.equal((await q(p, K_INBOX, '', null)).status, 403, p);
    assert.equal((await q(p, K_INBOX, '', 'wrong')).status, 403, p);
  }
  assert.deepEqual(calls, []);
});

test('unknown ids and path tricks answer 404 and never touch Nextcloud', async () => {
  for (const id of ['nope', '../../etc/passwd', `${inbox}/waiting.jpg`, '/Receipts/Processed/odd.jpg', `${inbox}/waiting.jpg@zzz`, '', 'constructor', '__proto__', 'x'.repeat(5000)]) {
    for (const p of ['/receipt', '/receipt-photo']) {
      assert.equal((await q(p, id)).status, 404, `${p} ${id.slice(0, 30)}`);
    }
  }
  assert.equal((await fetch(`${base}/receipt-photo?key=secret`)).status, 404);
  assert.deepEqual(calls, []);
});

test('a state entry whose path leaves the known folders is not served', async () => {
  for (const id of [K_EVIL, K_OUT, K_BAD_FILED]) {
    assert.equal((await q('/receipt-photo', id)).status, 404, id);
  }
  assert.deepEqual(calls, []);
});

test('the photo comes with the right type and safe headers; a waiting receipt is fetched from the inbox', async () => {
  const res = await q('/receipt-photo', K_INBOX);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  assert.deepEqual(calls, [`stat ${inbox}/waiting.jpg`, `get ${inbox}/waiting.jpg`]);
});

test('a filed receipt is fetched from where it was filed (filedAs), and PDF pages are separate pictures', async () => {
  const p1 = await q('/receipt-photo', K_DONE);
  assert.equal(p1.status, 200);
  assert.equal(calls[1], `get ${review}/done.pdf`);
  const p2 = await q('/receipt-photo', K_DONE, '&page=2');
  assert.deepEqual(Buffer.from(await p2.arrayBuffer()), PAGE2);
  assert.equal(calls.filter((c) => c.startsWith('get')).length, 1, 'converted once, then cached');
  assert.equal((await q('/receipt-photo', K_DONE, '&page=3')).status, 404);
  assert.equal((await q('/receipt-photo', K_DONE, '&page=abc')).status, 404);
  assert.equal((await q('/receipt-photo', K_DONE, '&page=0')).status, 404);
});

test('the original PDF is served as a download; not for a photo', async () => {
  const res = await q('/receipt-photo', K_DONE, '&raw=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(preps.length, 0, 'the raw PDF is not converted');
  assert.equal((await q('/receipt-photo', K_INBOX, '&raw=1')).status, 404);
});

test('a dry-run receipt is looked up in the inbox', async () => {
  files.set(`${inbox}/dry.heic`, JPEG);
  assert.equal((await q('/receipt-photo', K_DRY)).status, 200);
  assert.equal(calls[1], `get ${inbox}/dry.heic`);
});

test('a file that is gone: friendly 404 (photo) and a page with a note (detail); Nextcloud down: 503', async () => {
  files.delete(`${inbox}/waiting.jpg`);
  const gone = await q('/receipt-photo', K_INBOX);
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /no longer in Nextcloud/);
  const page = await q('/receipt', K_INBOX);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /no longer in Nextcloud/);
  clearPhotoCache();
  down = true;
  const err = await q('/receipt-photo', K_INBOX);
  assert.equal(err.status, 503);
  assert.match(await err.text(), /Nextcloud can't be reached/);
  clearPhotoCache();
  const detail = await q('/receipt', K_INBOX);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /can&#39;t be reached right now/);
});

test('a file that cannot be converted gives a short 500 message, not a crash', async () => {
  const bad = makeServer(() => {}, { nextcloud, prepare: async () => { throw new Error('convert: boom /secret/path'); } });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${bad.address().port}/receipt-photo?key=secret&id=${encodeURIComponent(K_INBOX)}`);
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /secret\/path|boom/);
  } finally {
    bad.closeAllConnections();
    bad.close();
  }
});

test('the detail page shows the saved reading without any model, escaped', async () => {
  const res = await q('/receipt', K_INBOX);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /img-src 'self'/);
  const page = await res.text();
  assert.match(page, /<img class="photo" src="receipt-photo\?key=secret&#38;id=/);
  assert.match(page, /Merchant<\/th><td>&#60;script&#62;alert\(1\)/);
  assert.match(page, /9\.99/);
  assert.match(page, /4\.25/);
  assert.ok(!page.includes('<script>alert(1)'));
  assert.ok(!page.includes('<i>x</i>'));
  assert.equal((page.match(/<script>/g) ?? []).length, 1);
});

test('the detail page of a filed receipt reads the summary filed next to it: reading, bank charge, review reasons, all pages and the PDF link', async () => {
  const page = await (await q('/receipt', K_DONE)).text();
  assert.match(page, /Corner &#60;Store&#62;/);
  assert.match(page, /Why it needs review/);
  assert.match(page, /total is off &#60;by&#62; a cent/);
  assert.match(page, /Bank charge/);
  assert.equal((page.match(/<img class="photo"/g) ?? []).length, 2);
  assert.match(page, /raw=1/);
  assert.ok(!page.includes('<by>'));
});

test('a hostile file name is escaped on the detail page; entries with no reading say so', async () => {
  const page = await (await q('/receipt', K_ODD)).text();
  assert.ok(!page.includes('<b><script>'));
  assert.ok(!page.includes('<script>alert(1)'));
  assert.match(page, /No saved reading/);
  assert.match(await (await q('/receipt', K_DRY)).text(), /no longer in Nextcloud|No saved reading/);
});

test('limits: a file over 40 MB is refused after a stat, before any download', async () => {
  sizes.set(`${inbox}/waiting.jpg`, 41 * 1024 * 1024);
  const res = await q('/receipt-photo', K_INBOX);
  assert.equal(res.status, 413);
  assert.deepEqual(calls, [`stat ${inbox}/waiting.jpg`]);
  const raw = await q('/receipt-photo', K_DONE, '&raw=1');
  assert.equal(raw.status, 200);
  sizes.set(`${review}/done.pdf`, 41 * 1024 * 1024);
  assert.equal((await q('/receipt-photo', K_DONE, '&raw=1')).status, 413);
  assert.match(await (await q('/receipt', K_INBOX)).text(), /too large to show/);
});

test('limits: the PDF is rendered for the panel with fitPdf at the configured side', async () => {
  await q('/receipt-photo', K_DONE);
  assert.deepEqual(preps[0], { name: 'done.pdf', side: config.maxImageSide, opts: { fitPdf: true } });
});

test('limits: only 2 downloads run at once, a few wait, the rest get "busy"', async () => {
  let open;
  busyGate = new Promise((r) => { open = r; });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(`${inbox}/bulk${i}.jpg@b${i}`);
  const state = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  for (const id of ids) {
    state[id] = { done: true, result: 'x', at: '2026-05-06T10:00:00Z' };
    files.set(id.slice(0, id.indexOf('@')), JPEG);
  }
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  const pending = ids.map((id) => q('/receipt-photo', id));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.filter((c) => c.startsWith('get')).length, 2, 'two started');
  open();
  const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 10, '2 running + 8 queued all finish');
  assert.equal(statuses.filter((s) => s === 503).length, 2, 'the rest are told to try again');
  assert.match(await (await q('/receipt', K_INBOX)).text(), /Waiting|waiting/);
});

test('cache: keyed by the file version, so a replaced file is fetched again; the same version is not', async () => {
  await q('/receipt-photo', K_INBOX);
  await q('/receipt-photo', K_INBOX);
  assert.equal(calls.filter((c) => c.startsWith('get')).length, 1);
  etags.set(`${inbox}/waiting.jpg`, 'e-new');
  await q('/receipt-photo', K_INBOX);
  assert.equal(calls.filter((c) => c.startsWith('get')).length, 2);
});

test('responses: photos and text answers carry nosniff and no-referrer', async () => {
  for (const res of [await q('/receipt-photo', K_INBOX), await q('/receipt-photo', 'nope')]) {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('detail page: an outage while reading the summary says so, not "No saved reading"', async () => {
  summaryDown = true;
  const page = await (await q('/receipt', K_DONE)).text();
  assert.match(page, /Couldn&#39;t load the summary \(Nextcloud unreachable\)/);
  assert.doesNotMatch(page, /No saved reading/);
});

test('folders configured without a leading slash still work', async () => {
  const old = { ...config.nextcloud };
  Object.assign(config.nextcloud, { inbox: inbox.slice(1), processed: processed.slice(1), review: review.slice(1) + '/' });
  try {
    assert.equal((await q('/receipt-photo', K_INBOX)).status, 200);
    assert.equal((await q('/receipt-photo', K_DONE)).status, 200);
    assert.equal((await q('/receipt-photo', K_EVIL)).status, 404);
  } finally {
    Object.assign(config.nextcloud, old);
  }
});

test('dry run: the slim summary kept beside the state file shows on the detail page', async () => {
  const summary = { file: 'dry.heic', receipt: { merchant: 'Dry <Mart>', total: 3.5, items: [{ description: 'GUM', plain: 'gum', amount: 3.5 }] }, problems: ['check <this>'], historyUsed: [{ big: 'x'.repeat(1000) }], plan: { parts: [{ category: 'Snacks', amount: '3.50' }] } };
  await saveDrySummary(K_DRY, summary);
  const saved = fs.readdirSync(path.join(dir, 'dry-summaries'));
  assert.equal(saved.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'dry-summaries', saved[0]), 'utf8'), /historyUsed|"file"/);
  const page = await (await q('/receipt', K_DRY)).text();
  assert.match(page, /Dry &#60;Mart&#62;/);
  assert.match(page, /check &#60;this&#62;/);
  assert.match(page, /Snacks/);
  // a live entry never reads that folder, and a different key gets nothing
  assert.match(await (await q('/receipt', K_ODD)).text(), /No saved reading/);
});

test('dry summaries: oversize ones are skipped, only the newest 200 are kept, and errors never throw', async () => {
  const d = path.join(dir, 'dry-summaries');
  fs.rmSync(d, { recursive: true, force: true });
  await saveDrySummary('dry:/x@1', { receipt: { blob: 'x'.repeat(300 * 1024) } });
  assert.equal(fs.existsSync(d) ? fs.readdirSync(d).length : 0, 0);
  for (let i = 0; i < 205; i++) await saveDrySummary(`dry:/n${i}@1`, { receipt: { i } });
  assert.equal(fs.readdirSync(d).length, 200);
  const keep = config.statePath;
  config.statePath = path.join(dir, 'state.json', 'inside-a-file'); // cannot be created
  await saveDrySummary('dry:/y@1', { receipt: {} });
  config.statePath = keep;
});
