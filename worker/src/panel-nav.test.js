// The receipt page's Previous / Next, jump list, What to do box and Try again button. Nextcloud is a stand-in; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { makeServer, retryTarget } from './trigger.js';
import { clearPhotoCache } from './panel-receipt.js';
import { cleanNav, navQuery, orderFor, receiptNav, whatToDo, escape, dateUsed, receiptPage, taxLine } from './panel-pages.js';
import { SCRIPT, sortItems, rowVisible } from './panel-script.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-nav-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), dryRun: false });
config.trigger.token = 'secret';
const { inbox, review, processed } = config.nextcloud;

const HOSTILE = 'z<i>x"&';
const K = { a: `${inbox}/a.jpg@1`, b: `${inbox}/b.jpg@2`, c: `${inbox}/c.jpg@3`, d: `${inbox}/d.jpg@4`, e: `${inbox}/e.jpg@5`, h: `${inbox}/${HOSTILE}.jpg@6` };
const nextcloud = {
  async statPath() { throw Object.assign(new Error('Not Found'), { status: 404 }); },
  async downloadPath() { throw Object.assign(new Error('Not Found'), { status: 404 }); },
  async readSummary() { return null; },
};
let server;
let base;
test.before(async () => {
  fs.writeFileSync(config.statePath, JSON.stringify({
    [K.a]: { done: true, result: 'review', at: '2026-05-10T10:00:00Z', filedAs: `${review}/a.jpg` },
    [K.b]: { done: true, result: 'categorize', at: '2026-05-09T10:00:00Z', filedAs: `${processed}/b.jpg` },
    [K.c]: { done: true, result: 'review', at: '2026-05-08T10:00:00Z', filedAs: `${review}/c.jpg` },
    [K.d]: { done: true, result: 'split+review', at: '2026-05-07T10:00:00Z', filedAs: `${review}/d.jpg`, applied: { txnId: 't', action: 'split', at: '2026-05-07T10:00:00Z' } },
    [K.e]: { done: false, result: 'waiting for the bank charge', at: '2026-05-06T10:00:00Z', waiting: { nextCheck: '2026-05-06T11:00:00Z', until: '2026-05-09T10:00:00Z', reason: 'no match' } },
    [K.h]: { done: true, result: 'confirm', at: '2026-05-05T10:00:00Z', filedAs: `${processed}/h.jpg` },
  }));
  server = makeServer(() => {}, { nextcloud, prepare: async () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
});
test.beforeEach(() => clearPhotoCache());

const page = async (id, extra = '') => {
  const res = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(id)}${extra}`);
  assert.equal(res.status, 200);
  return res.text();
};
const hrefOf = (html, rel) => (html.match(new RegExp(`<a class="btn" rel="${rel}" href="([^"]*)"`)) ?? [])[1]?.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
const idOf = (href) => new URL(href, 'http://x/').searchParams.get('id');

test('Previous / Next follow the list order (newest first) with the position', async () => {
  const html = await page(K.b);
  assert.match(html, /2 of 6/);
  assert.equal(idOf(hrefOf(html, 'prev')), K.a);
  assert.equal(idOf(hrefOf(html, 'next')), K.c);
  assert.doesNotMatch(hrefOf(html, 'next'), /result=/);
  const first = await page(K.a);
  assert.match(first, /1 of 6/);
  assert.equal(hrefOf(first, 'prev'), undefined, 'no link before the first');
  assert.match(first, /<span class="btn" aria-disabled="true">&larr; Previous/);
  assert.match(await page(K.h), /6 of 6/);
});

test('with a filter, Previous / Next walk only the filtered receipts and carry the filter', async () => {
  const html = await page(K.c, '&result=review');
  assert.match(html, /2 of 2/);
  assert.match(html, /result: review/);
  assert.equal(idOf(hrefOf(html, 'prev')), K.a);
  assert.equal(hrefOf(html, 'next'), undefined);
  assert.match(hrefOf(html, 'prev'), /result=review/);
  const back = html.match(/<a href="(\.\/\?key=[^"]*)">Back to the list/)[1].replaceAll('&amp;', '&').replaceAll('&#38;', '&');
  assert.match(back, /result=review/);
  assert.match(back, /#r3$/, 'back to the row it came from');
  const text = await page(K.b, '&q=categorize');
  assert.match(text, /1 of 1/);
});

test('a filter that would hide the receipt itself is dropped, with a note', async () => {
  const html = await page(K.b, '&result=review');
  assert.match(html, /2 of 6/);
  assert.match(html, /not in the filtered list/);
  assert.doesNotMatch(hrefOf(html, 'next'), /result=/);
});

test('a sort from the list is followed (empty values last; desc reverses)', async () => {
  const html = await page(K.c, '&sort=receipt&dir=desc');
  assert.equal(idOf(hrefOf(html, 'prev')), K.d);
  assert.equal(idOf(hrefOf(html, 'next')), K.b);
  assert.match(hrefOf(html, 'next'), /sort=receipt&dir=desc/);
  const asc = await page(K.c, '&sort=when&dir=asc');
  assert.equal(idOf(hrefOf(asc, 'prev')), K.d);
  const bad = await page(K.c, '&sort=__proto__&dir=sideways&result=' + 'x'.repeat(500));
  assert.match(bad, /3 of 6/, 'unknown sort and oversize filter are ignored');
});

test('the jump list holds the same receipts in the same order, selects this one, and works without JavaScript', async () => {
  const html = await page(K.c, '&result=review');
  const form = html.match(/<form method="get" action="receipt">[\s\S]*?<\/form>/)[0];
  assert.deepEqual([...form.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), [K.a, K.c].map(escape));
  assert.match(form, new RegExp(`<option value="${escape(K.c)}" selected>c.jpg \\(review\\)</option>`));
  assert.match(form, /<input type="hidden" name="key" value="secret">/);
  assert.match(form, /<input type="hidden" name="result" value="review">/);
  assert.match(form, /name="id"/);
  assert.match(form, /<button class="small plain" data-nojs>Go<\/button>/);
  assert.match(SCRIPT, /select\[data-jump\]/);
  const all = await page(K.a);
  assert.equal([...all.matchAll(/<option value=/g)].length, 6);
  assert.ok(all.includes(escape(`${HOSTILE}.jpg (confirm)`)), 'file names are escaped');
  assert.ok(!all.includes(HOSTILE));
});

test('the arrow keys are wired to the prev / next links, and ignored in form fields and with modifiers', () => {
  assert.match(SCRIPT, /ArrowLeft/);
  assert.match(SCRIPT, /e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey/);
  assert.match(SCRIPT, /tag === 'INPUT' \|\| tag === 'SELECT' \|\| tag === 'TEXTAREA'/);
});

test('Try again shows on the receipt page when allowed, with the way back; not when Actual was changed', async () => {
  const html = await page(K.c);
  const form = html.match(/<form method="post" action="retry\?key=secret">[\s\S]*?<\/form>/)[0];
  assert.match(form, new RegExp(`name="entry" value="${escape(K.c)}"`));
  assert.match(form, /name="from" value="receipt"/);
  assert.match(form, new RegExp(`name="next" value="${escape(K.d)}"`), 'goes on to the next receipt');
  assert.match(form, />Try again</);
  const last = await page(K.c, '&result=review');
  assert.match(last.match(/<form method="post" action="retry[\s\S]*?<\/form>/)[0], new RegExp(`name="next" value="${escape(K.a)}"`), 'last in the filter: the previous one');
  assert.match(last, /name="result" value="review"/);
  const applied = await page(K.d);
  assert.doesNotMatch(applied, /action="retry/);
  assert.match(applied, /undo it in Actual \(restore the category or remove the split, and remove the #receipt note\), delete the file from Needs review, and upload the receipt again/);
  assert.doesNotMatch(await page(K.b), /action="retry/);
});

test('Try again refused from a receipt page lands back on that receipt, with the filter kept', async () => {
  const body = new URLSearchParams({ entry: K.d, from: 'receipt', next: K.e, result: 'split+review', sort: 'when', dir: 'asc' });
  const res = await fetch(`${base}/retry?key=secret`, { method: 'POST', body, redirect: 'manual' });
  assert.equal(res.status, 303);
  const loc = new URL(res.headers.get('location'), 'http://x/');
  assert.equal(loc.pathname, '/receipt');
  assert.equal(loc.searchParams.get('id'), K.d);
  assert.equal(loc.searchParams.get('result'), 'split+review');
  assert.match(loc.searchParams.get('notice'), /already applied in Actual/);
  const fromList = await fetch(`${base}/retry?key=secret`, { method: 'POST', body: new URLSearchParams({ entry: K.d }), redirect: 'manual' });
  assert.equal(new URL(fromList.headers.get('location'), 'http://x/').pathname, '/');
});

test('retryTarget: only two fixed pages; the request cannot name another place', () => {
  const t = (fields, out = {}) => retryTarget(new URLSearchParams(fields), out);
  assert.deepEqual(t({ entry: 'k' }), { where: './', extra: '' });
  assert.deepEqual(t({ entry: 'k', return: 'https://evil.example/', to: '//evil.example', from: 'list' }), { where: './', extra: '' });
  const ok = t({ from: 'receipt', entry: 'k1', next: 'k2', result: 'review' }, { retried: true });
  assert.deepEqual(ok, { where: './receipt', extra: '&id=k2&result=review' });
  assert.equal(t({ from: 'receipt', entry: 'k1', next: 'k2' }).extra, '&id=k1', 'a refusal stays on this receipt');
  assert.deepEqual(t({ from: 'receipt', entry: 'k1', next: '' }, { retried: true }), { where: './', extra: '' }, 'no next receipt: the list');
  const evil = t({ from: 'receipt', entry: 'k1', next: '../../x?a=b&c', sort: 'evil', dir: 'up', q: '&key=z' }, { retried: true });
  assert.equal(evil.where, './receipt');
  assert.equal(evil.extra, `&id=${encodeURIComponent('../../x?a=b&c')}&q=${encodeURIComponent('&key=z')}`, 'values stay encoded; unknown sort and dir are dropped');
});

test('cleanNav, navQuery, orderFor and receiptNav', () => {
  assert.deepEqual(cleanNav(new URLSearchParams('sort=when&dir=desc&result=review&q=x&other=1')), { result: 'review', q: 'x', sort: 'when', dir: 'desc' });
  assert.deepEqual(cleanNav(new URLSearchParams('dir=desc')), { result: '', q: '', sort: '', dir: '' });
  assert.equal(navQuery({ result: 'a b', q: '', sort: 'when', dir: 'asc' }), '&result=a%20b&sort=when&dir=asc');
  const recent = [{ key: 'k1', file: 'b.jpg', done: true, result: 'review', at: '2026-01-02' }, { key: 'k2', file: 'a.jpg', done: true, result: 'split', at: '' }, { key: 'k3', file: 'c.jpg', done: true, result: 'review', at: '2026-01-01' }];
  assert.deepEqual(orderFor(recent, cleanNav(new URLSearchParams('sort=when&dir=asc'))).map((r) => r.key), ['k3', 'k1', 'k2'], 'an empty date stays last');
  assert.deepEqual(orderFor(recent, cleanNav(new URLSearchParams('sort=when&dir=desc'))).map((r) => r.key), ['k1', 'k3', 'k2']);
  assert.deepEqual(orderFor(recent, cleanNav(new URLSearchParams('result=review'))).map((r) => r.key), ['k1', 'k3']);
  assert.equal(receiptNav(recent, 'nope', cleanNav(new URLSearchParams())), null);
  assert.equal(receiptNav(recent, 'k3', cleanNav(new URLSearchParams())).row, 3);
});

test('What to do: plain words for every kind of result', () => {
  const live = (entry) => whatToDo({ done: true, ...entry }, `${inbox}/x.jpg@1`, entry.summary).lines.join(' ');
  assert.match(live({ result: 'categorize' }), /put in the category.*#receipt note/);
  assert.match(live({ result: 'split' }), /split into the categories/);
  assert.match(live({ result: 'confirm' }), /only a #receipt note/);
  assert.match(live({ result: 'note' }), /splits are turned off, or this Actual connection cannot split/);
  assert.match(live({ result: 'categorize' }), /lists the items, or the parts/);
  assert.match(live({ result: 'review' }), /Nothing was changed in Actual.*Needs review.*Try again/);
  assert.match(live({ result: 'review', applied: { txnId: 't' } }), /undo it in Actual \(restore the category or remove the split, and remove the #receipt note\), delete the file from Needs review, and upload the receipt again/);
  assert.match(live({ result: 'split+review', applied: { txnId: 't' } }), /tagged #review.*search #review.*undo it in Actual \(restore the category.*upload the receipt again/);
  assert.match(live({ result: 'failed' }), /failed 3 times.*Nothing was changed.*Try again/);
  assert.match(live({ result: 'failed', applied: { txnId: 't' } }), /already been changed.*undo/);
  assert.match(live({ result: 'already-applied', summary: { problems: [] } }), /nothing was changed again/);
  assert.equal(whatToDo({ done: true, result: 'review' }, `${inbox}/x.jpg@1`).warn, true);
  assert.equal(whatToDo({ done: true, result: 'categorize' }, `${inbox}/x.jpg@1`).warn, false);
  const waiting = whatToDo({ done: false, waiting: { nextCheck: '2026-05-06T11:00:00Z', until: '2026-05-09T10:00:00Z', reason: 'x an older charge matches, check it: 2026-01-02 Foo (payee score 0.9) 12.50 "' } }, `${inbox}/x.jpg@1`).lines.join(' ');
  assert.match(waiting, /Waiting for the bank charge.*checked again at.*keeps waiting until/);
  assert.match(whatToDo({ done: false, error: 'boom' }, `${inbox}/x.jpg@1`).lines.join(' '), /last attempt hit an error \(boom\).*3 failed attempts/);
  assert.match(whatToDo({ done: false, applied: { txnId: 't' } }, `${inbox}/x.jpg@1`).lines.join(' '), /moving the file/);
  const dry = (result) => whatToDo({ done: true, result }, `dry:${inbox}/x.jpg@1`).lines.join(' ');
  assert.match(dry('dry-run:split'), /dry run preview: nothing was written.*would split the charge/);
  assert.match(dry('dry-run:categorize+review'), /would put the charge.*tag the note #review/);
  assert.match(dry('review'), /nothing was written.*Needs review/);
});

test('the receipt page shows What to do, the help section and the two-column layout', async () => {
  const html = await page(K.c);
  assert.match(html, /<b>What to do<\/b><p>Nothing was changed in Actual/);
  assert.match(html, /<details class="how"><summary>How this page works<\/summary>/);
  assert.match(html, /<body class="wide">/);
  assert.match(html, /class="receipt-grid"/);
  assert.match(await page(K.e), /Waiting for the bank charge/);
  assert.match(await page(K.h), /Nothing more to do/);
});

test('the status list rows have anchors and sort keys for the way back', async () => {
  const html = await (await fetch(`${base}/?key=secret`)).text();
  assert.match(html, /<tr id="r1" data-row/);
  assert.match(html, /<th data-type="date" data-key="when">When<\/th>/);
  assert.match(html, /<a data-view href="receipt\?key=secret&amp;id=/);
});

test('What to do: a failed dry-run receipt is a failure, not a preview; folder names come from the settings', () => {
  const failed = whatToDo({ done: true, result: 'failed' }, `dry:${inbox}/x.jpg@1`);
  assert.equal(failed.warn, true);
  assert.match(failed.lines.join(' '), /failed 3 times.*dry run/);
  assert.doesNotMatch(failed.lines.join(' '), /would be processed/);
  const saved = config.nextcloud.review;
  config.nextcloud.review = '/Quittance/Look <b>';
  try {
    assert.match(whatToDo({ done: true, result: 'review' }, `${inbox}/x.jpg@1`).lines.join(' '), /file is in Quittance\/Look <b>,/);
    const html = receiptPage({ entry: { done: true, result: 'review' }, id: `${inbox}/x.jpg@1`, name: 'x.jpg', pages: 0, pdf: false, photoNote: '', summaryNote: '', summary: null }, 'secret', '');
    assert.match(html, /Quittance\/Look &#60;b&#62;/);
    assert.doesNotMatch(html, /Receipts\/Needs review/);
  } finally {
    config.nextcloud.review = saved;
  }
});

test('dateUsed: the date the worker settled on, not the raw reader date', () => {
  // a finished receipt: the summary holds the settled date, null when it was rejected
  assert.equal(dateUsed({ summary: { receipt: { date: '2026-10-26', date_as_printed: '10/26/26' } } }).text, '2026-10-26');
  assert.equal(dateUsed({ summary: { receipt: { date: null, date_as_printed: '12/01/20' } } }).text, 'none (printed date ignored)');
  assert.equal(dateUsed({ summary: { receipt: { date: null } } }).text, 'none (no date on the receipt)');
  // a waiting one: worked out again from the reading, the file name and the upload time
  const waiting = (receipt, extra = {}) => ({ name: 'x.jpg', entry: { done: false, reading: { receipt }, waiting: { since: '2026-11-07T10:00:00Z' }, ...extra } });
  assert.equal(dateUsed(waiting({ date: '2026-11-03', date_as_printed: '11/03/2026' })).text, '2026-11-03');
  assert.equal(dateUsed(waiting({ date: '2020-01-02', date_as_printed: '01/02/2020' })).text, 'none (printed date ignored)');
  assert.equal(dateUsed(waiting({ date: null, date_as_printed: null })).text, 'none (no date on the receipt)');
  // the file-name day is the anchor: a printed date after the photo day is rejected, with the saved upload time
  const named = { ...waiting({ date_as_printed: '11/06/2026' }, { lastmod: '2026-11-07T10:00:00Z' }), name: '2026-11-04_101010.jpg' };
  assert.equal(dateUsed(named).text, 'none (printed date ignored)');
  assert.equal(dateUsed({ name: 'x.jpg', entry: {} }), null);
});

test('the receipt page shows Purchase date used and the printed date, not the raw reader date', () => {
  const view = { entry: { done: true, result: 'review' }, id: `${inbox}/x.jpg@1`, name: 'x.jpg', pages: 0, pdf: false, photoNote: '', summaryNote: '', summary: { receipt: { merchant: 'Shop', date: null, date_as_printed: '12/01/20', items: [] } } };
  const html = receiptPage(view, 'secret', '');
  assert.match(html, /<th>Purchase date used<\/th><td>none \(printed date ignored\)<\/td>/);
  assert.match(html, /<th>Printed date<\/th><td>12\/01\/20<\/td>/);
});

test('ties sort in the list\'s own order in both directions, on the server and in the browser', () => {
  const rows = [{ key: 'n', file: 'a', result: 'review', done: true, at: '2026-01-03' }, { key: 'm', file: 'b', result: 'review', done: true, at: '2026-01-03' }, { key: 'o', file: 'c', result: 'review', done: true, at: '2026-01-01' }];
  const keys = (dir) => orderFor(rows, cleanNav(new URLSearchParams(`sort=when&dir=${dir}`))).map((r) => r.key);
  assert.deepEqual(keys('asc'), ['o', 'n', 'm']);
  assert.deepEqual(keys('desc'), ['n', 'm', 'o']);
  const items = [{ v: 'x', i: 0 }, { v: 'x', i: 1 }, { v: '', i: 2 }, { v: 'a', i: 3 }];
  assert.deepEqual(sortItems(items, -1, 'text').map((x) => x.i), [0, 1, 3, 2]);
  assert.deepEqual(sortItems(items, 1, 'text').map((x) => x.i), [3, 0, 1, 2]);
});

// ---- status clarity fixes ----
import { statusPage, settingsPage } from './panel-pages.js';
import { SETTINGS as SCHEMA } from './web-settings-schema.js';

const REDO_TEXT = /undo it in Actual \(restore the category or remove the split, and remove the #receipt note\), delete the file from Needs review, and upload the receipt again/;

test('applied-and-reviewed receipts say the same thing everywhere: undo, remove #receipt, delete, upload again', () => {
  const at = '2026-11-07T10:00:00Z';
  const recent = [{ key: 'k1', file: 's.jpg', done: true, result: 'split+review', applied: { action: 'split' }, at }];
  const html = statusPage({ heartbeat: 'now', alert: null, recent }, 'k');
  assert.match(html, REDO_TEXT);
  assert.doesNotMatch(html, /move the file back/i);
  const flagged = whatToDo({ done: true, result: 'split+review', applied: {} }, 'k1', {}).lines.join(' ');
  assert.match(flagged, REDO_TEXT);
  assert.match(whatToDo({ done: true, result: 'review', applied: {} }, 'k1', {}).lines.join(' '), REDO_TEXT);
});

test('dry run rows: unprefixed review, failed and retrying results are previews in the Inbox with no Try again', () => {
  const at = '2026-11-07T10:00:00Z';
  const recent = [
    { key: 'dry:/in/a.jpg@1', file: 'a.jpg', done: true, result: 'review', at },
    { key: 'dry:/in/b.jpg@1', file: 'b.jpg', done: true, result: 'failed', at },
    { key: 'dry:/in/c.jpg@1', file: 'c.jpg', error: 'boom', at },
    { key: '/in/d.jpg@1', file: 'd.jpg', done: true, result: 'dry-run:split', at },
  ];
  const html = statusPage({ heartbeat: 'now', alert: null, recent }, 'k');
  const row = (n) => html.match(new RegExp(`<tr[^>]*>\\s*<td>${n}</td>.*?</tr>`, 's'))[0];
  assert.match(row('a.jpg'), /Needs review \(dry run\).*In the Inbox\. Nothing written, nothing moved/s);
  assert.match(row('b.jpg'), /Failed \(dry run\).*In the Inbox\. Nothing written, nothing moved/s);
  assert.match(row('c.jpg'), /Retrying after an error \(dry run\).*In the Inbox/s);
  assert.match(row('d.jpg'), /Preview \(dry run\)/);
  for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) assert.doesNotMatch(row(n), /Try again<\/button>/, n);
  assert.match(html, /Try again moves a file[^<]*it is live only/);
});

test('already-applied filed to Needs review shows the applied-review status; filed to Processed stays Done', () => {
  const at = '2026-11-07T10:00:00Z';
  const review = `/${String(config.nextcloud.review).replace(/^\/+/, '')}/x.jpg`;
  const processed = `/${String(config.nextcloud.processed).replace(/^\/+/, '')}/y.jpg`;
  const recent = [
    { key: 'k1', file: 'x.jpg', done: true, result: 'already-applied', applied: { action: 'already-applied' }, filedAs: review, at },
    { key: 'k2', file: 'y.jpg', done: true, result: 'already-applied', applied: { action: 'already-applied' }, filedAs: processed, at },
  ];
  const html = statusPage({ heartbeat: 'now', alert: null, recent }, 'k');
  const row = (n) => html.match(new RegExp(`<tr[^>]*>\\s*<td>${n}</td>.*?</tr>`, 's'))[0];
  assert.match(row('x.jpg'), /Applied — check it in Actual/);
  assert.match(row('y.jpg'), /<b>Done<\/b>/);
});

test('the Result cell sorts on its label, and the text filter sees the same words on server and browser', () => {
  const at = '2026-11-07T10:00:00Z';
  const recent = [
    { key: 'k1', file: 'a.jpg', done: true, result: 'review', at },
    { key: 'k2', file: 'b.jpg', done: true, result: 'confirm', applied: {}, at },
    { key: 'k3', file: 'c.jpg', done: true, result: 'failed', at },
  ];
  const html = statusPage({ heartbeat: 'now', alert: null, recent }, 'k');
  assert.match(html, /<td data-sort="Needs your review" title="review">/);
  // the browser's row text: every cell but the actions, as textContent
  const text = (n) => {
    const tr = html.match(new RegExp(`<tr[^>]*>\\s*<td>${n}</td>.*?</tr>`, 's'))[0];
    const cells = [...tr.matchAll(/<td(?![^>]*data-act)[^>]*>(.*?)<\/td>/gs)].map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    return cells.join(' ');
  };
  for (const q of ['Nothing changed in Actual', 'review review', 'Fix the cause', 'Nothing to do', 'confirm', 'b.jpg needs']) {
    const server = orderFor(recent, cleanNav(new URLSearchParams({ q }))).map((r) => r.file);
    const browser = recent.filter((r) => rowVisible(text(r.file), {}, q, [])).map((r) => r.file);
    assert.deepEqual(server, browser, q);
  }
  const labels = orderFor(recent, cleanNav(new URLSearchParams('sort=result&dir=asc'))).map((r) => r.file);
  assert.deepEqual(labels, ['b.jpg', 'c.jpg', 'a.jpg'], 'Done, Failed, Needs your review');
});

test('Advanced settings open when the notice names a setting key', () => {
  const adv = SCHEMA.find((s) => s.advanced);
  const data = { sections: [{ id: 'x', title: 'X', settings: [{ ...adv, source: 'env', value: '', isSet: false }] }] };
  const open = (n) => /id="advanced" open>/.test(settingsPage(data, 'k', n));
  assert.equal(open(undefined), false);
  assert.equal(open(`${adv.key} (200) must be greater than something`), true);
});

test('the three help texts say what really happens', () => {
  const help = (k) => SCHEMA.find((s) => s.key === k).help;
  for (const k of ['MATCH_NO_DATE_RECENT_DAYS', 'MATCH_PENDING_WAIT_DAYS']) assert.match(help(k), /Apply then review/, k);
  assert.match(help('MATCH_PENDING_WAIT_DAYS'), /even just adding a note/);
  assert.match(help('SPLIT_TRANSACTIONS'), /already has a category keeps it/);
});

test('the receipt page: item tax marks after the price and one Tax line under the facts; an old summary without the field is explained from the reading', () => {
  const reading = {
    merchant: 'Shop', subtotal: 62.3, tax: 3.66, total: 65.96,
    tax_lines: [{ code: 't', rate: 5.6, base: 42.33, amount: 2.37 }, { code: 'T', rate: 8.6, base: 14.97, amount: 1.29 }],
    items: [{ description: 'CEREAL', amount: 42.33, taxable: true, tax_code: 'tF' }, { description: 'TOWELS <b>', amount: 14.97, taxable: true, tax_code: 'T' }, { description: 'BREAD', amount: 5, taxable: false, tax_code: 'N' }, { description: 'GUM', amount: 0 }],
  };
  const page = (summary) => receiptPage({ entry: { done: true, result: 'review' }, id: `${inbox}/x.jpg@1`, name: 'x.jpg', pages: 0, pdf: false, photoNote: '', summaryNote: '', summary }, 'secret', '');
  const old = page({ receipt: reading });
  assert.match(old, /Tax: t 5\.6% on 42\.33 = 2\.37 · T 8\.6% on 14\.97 = 1\.29/);
  assert.match(old, /<td>42\.33 <span class="muted small">tF<\/span><\/td>/);
  assert.match(old, /<td>0\.00<\/td>/); // no code: no mark
  assert.ok(!old.includes('TOWELS <b>'));
  // the saved field wins, and is escaped
  const saved = page({ receipt: reading, plan: { tax: { how: 'proportional', lines: [], reason: 'a <reason>' } } });
  assert.match(saved, /Tax: 3\.66 spread over all items in proportion \(a &#60;reason&#62;\)/);
  assert.equal(taxLine({ how: 'by-item', lines: [{ code: 'T', rate: 8.6, base: '14.97', amount: '1.29' }] }), 'Tax: 1.29 on the taxed items (T 8.6% on 14.97)');
  assert.equal(taxLine({ nonsense: 1 }), '');
});
