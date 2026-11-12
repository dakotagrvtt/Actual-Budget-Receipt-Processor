// The receipt page skeleton (P5): title row with More, one status banner per state, the image, waiting and archived receipts.
// Every receipt is made up; pages are rendered directly, no network.
import "./support.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptPage } from '../src/panel-pages.js';
import { config } from '../src/config.js';
import { readFileSync } from 'node:fs';

const key = `${config.nextcloud.inbox}/camera.jpg@1`;
const receipt = { merchant: 'Corner Store', date: '2026-10-19', total: 27.53, payment_method: 'visa', items: [{ description: 'Milk', amount: 27.53 }] };
const view = (entry, extra = {}) => ({ id: key, name: 'camera.jpg', entry, pages: 1, summary: { receipt, problems: [] }, ...extra });
const banner = (html) => html.match(/<section class="status-banner[^]*?<\/section>/)[0];
const forms = (html) => [...html.matchAll(/<form [^>]*action="([a-z-]+)\?key=/g)].map((m) => m[1]);
const resolution = { values: { merchant: 'Corner Store', date: '2026-10-19', total: '27.53', payment_method: 'card' }, window: { start: '2026-10-12', end: '2026-10-26' }, candidates: [] };

test('a receipt waiting for the bank has a plain banner with Check now and Find charge, then Next and the image only', () => {
  const nav = { list: [{ key, file: 'camera.jpg', waiting: {}, at: '2026-11-08T12:00:00Z' }, { key: 'other', file: 'x.jpg', waiting: {} }], index: 0, prev: null, next: { key: 'other', file: 'x.jpg' }, nav: {}, row: 1 };
  const html = receiptPage(view({ waiting: { nextCheck: '2099-01-01T00:00:00Z', reason: 'none yet' }, at: '2026-11-08T12:00:00Z' }, { summary: null, resolution }), 'k', '', nav);
  const b = banner(html);
  assert.match(b, /class="status-banner workspace-status t-none"/);
  assert.match(b, /<span class="ic ic-muted"><svg /);
  assert.match(b, /Waiting for the bank/);
  // P8: the same /run form (no-JS: the redirect to the list as before); data-check-now lets the script start it in place.
  assert.match(b, /<form method="post" action="run\?key=k" data-check-now><button class="plain">Check now<\/button><\/form>/);
  assert.match(b, /<p class="status-note check-status" data-check-status role="status"><\/p>/);
  assert.match(b, /<a class="btn plain" href="#receipt-resolution" data-reveal data-focus="receipt-merchant">Find charge or mark as cash<\/a>/);
  // P7: Next stays in the group (Waiting) and is the page's one rel="next" link.
  assert.match(html, /<nav class="next-row waitrow" aria-label="Waiting receipts"><a class="btn plain" data-navigate rel="next" href="receipt\?key=k&amp;id=other&#38;group=waiting">Next receipt &rarr;<\/a><\/nav>/);
  assert.ok(html.includes('id="receipt-photo"'));
  assert.doesNotMatch(html.replace(/<(style|script)>[^]*?<\/\1>/g, ''), /data-preview-form|id="receipt-items"/, 'no item editor until a charge is found');
  assert.doesNotMatch(html.match(/<details class="how reveal-only" id="receipt-resolution"[^>]*>/)[0], / open/, 'the correction form is collapsed until asked for');
});

test('an archived receipt is read-only with a Restore receipt button in the banner, and the Archive tab current', () => {
  const html = receiptPage(view({ done: true, result: 'confirm', archived: { at: '2026-11-08T12:00:00Z' }, filedAs: 'Archive/2026-11/camera.jpg' }), 'k', '');
  const b = banner(html);
  assert.match(b, /t-none/);
  assert.match(b, /<h2 class="status-lead" data-workspace-status>Archived<\/h2>/);
  assert.match(b, /<button class="primary">Restore receipt<\/button>/);
  assert.deepEqual(forms(b), ['restore']);
  assert.match(html, /data-tab="archived"/);
  assert.match(html, /&larr; Archive<\/a>/);
});

test('the title row carries a quiet More menu with the old actions, and the banner tone follows the list group', () => {
  const html = receiptPage(view({ done: true, result: 'review', at: '2026-11-08T12:00:00Z' }), 'k', '');
  const title = html.match(/<div class="workspace-title">[^]*?<\/p>/)[0];
  assert.match(title, /<div class="title-side"><span class="workspace-total">\$27\.53<\/span><details class="receipt-more"><summary>More<\/summary>/);
  assert.match(title, /<a href="#receipt-information" data-reveal>Receipt details<\/a>/);
  assert.doesNotMatch(html.match(/<div class="editor-heading">[^]*?<\/div>/)?.[0] ?? '', /receipt-more/, 'More left the editor heading');
  assert.match(banner(html), /t-attn/);
  assert.match(html, /&larr; Review<\/a>/, 'the back link names the group, with no counter');
  const filed = receiptPage(view({ done: true, result: 'confirm', applied: { action: 'confirm' }, at: '2026-11-08T12:00:00Z' }), 'k', '');
  assert.match(banner(filed), /t-none/);
  assert.match(filed, /&larr; Filed<\/a>/);
  assert.match(banner(filed), /<span class="ic ic-ok">/);
});

test('the image stays open with a peek button the script reveals; the ids the page depends on remain', () => {
  const html = receiptPage(view({ done: true, result: 'review', at: '2026-11-08T12:00:00Z' }), 'k', '');
  assert.match(html, /<details class="receipt-photo-toggle" open>/);
  assert.match(html, /<button type="button" class="small plain photo-toggle" data-photo-toggle hidden>Show whole receipt<\/button>/);
  for (const id of ['receipt-photo', 'receipt-information']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /data-workspace-title/);
  assert.doesNotMatch(html.replace(/<style>[^]*?<\/style>/, ''), /\sstyle="/);
});

// ---- Round 2 (T8): More lists only what the banner or footer does not already show ----

const moreOf = (html) => html.match(/<details class="receipt-more">[^]*?<\/details>/)[0];
const actionsIn = (html) => [...html.matchAll(/<form [^>]*action="([a-z-]+)\?key=/g)].map((m) => m[1]);
const bareHtml = (html) => html.replace(/<(style|script)>[^]*?<\/\1>/g, '');

test('waiting: one "Find charge or mark as cash" entry, which reveals one clearly labelled form; More does not repeat it', () => {
  const html = bareHtml(receiptPage(view({ waiting: { nextCheck: '2099-01-01T00:00:00Z', reason: 'none yet' }, at: '2026-11-08T12:00:00Z' }, { summary: null, resolution }), 'k', ''));
  assert.equal((html.match(/href="#receipt-resolution"/g) ?? []).length, 1, 'one way in');
  assert.doesNotMatch(moreOf(html), /receipt-resolution|Find charge/);
  assert.equal((html.match(/<summary>Find charge or mark as cash<\/summary>/g) ?? []).length, 1, 'one labelled form');
  assert.doesNotMatch(html, /Correct reading \/ choose transaction/, 'the second wording is gone');
  assert.match(html, /<details class="how reveal-only" id="receipt-resolution">/, 'hidden until asked for once the script runs');
  assert.match(moreOf(html), /receipt-information/, 'More still has Receipt details');
});

test('a receipt that is waiting shows its form already open when a search has results', () => {
  const found = { ...resolution, token: 'tok', candidates: [] };
  const html = bareHtml(receiptPage(view({ waiting: { nextCheck: '2099-01-01T00:00:00Z' }, at: '2026-11-08T12:00:00Z' }, { summary: null, resolution: found }), 'k', ''));
  assert.match(html, /<details class="how reveal-only" id="receipt-resolution" open>/);
});

test('a misread receipt: Fix total and Read again are in the banner, so More repeats neither', () => {
  const html = bareHtml(receiptPage(view({ done: true, result: 'review', at: '2026-11-08T12:00:00Z' }, { fix: null, resolution, pages: 1 }), 'k', ''));
  const more = moreOf(html);
  assert.doesNotMatch(more, /receipt-resolution/);
  for (const route of actionsIn(banner(html))) assert.ok(!actionsIn(more).includes(route), `${route} is not repeated in More`);
  assert.match(banner(html), /t-attn/);
  assert.match(banner(html), /<a class="btn plain" href="#receipt-resolution" data-reveal data-focus="receipt-total">Fix total<\/a>/);
  assert.match(html.match(/<details class="how" id="receipt-resolution"[^>]*>/)[0], / open/);
});

test('an archived receipt: Restore receipt is in the banner and More has only Receipt details', () => {
  const html = bareHtml(receiptPage(view({ done: true, result: 'confirm', archived: { at: '2026-11-08T12:00:00Z' }, filedAs: 'Archive/2026-11/camera.jpg' }), 'k', ''));
  assert.deepEqual(actionsIn(moreOf(html)), []);
  assert.deepEqual(actionsIn(banner(html)), ['restore']);
});

test('Saved: Archive is in the banner, so More does not list it again; a Review receipt (no Archive in its banner) keeps it in More', async () => {
  const { workspaceFixtures } = await import('./workspace-fixtures.js');
  const fixture = await workspaceFixtures();
  try {
    assert.equal(actionsIn(moreOf(bareHtml(fixture.savedHtml))).includes('archive'), false);
    assert.equal(actionsIn(banner(bareHtml(fixture.savedHtml))).includes('archive'), true);
    assert.equal(actionsIn(moreOf(bareHtml(fixture.renderReceipt()))).includes('archive'), true, 'Archive stays reachable');
    assert.equal(actionsIn(banner(bareHtml(fixture.renderReceipt()))).includes('archive'), false);
  } finally { fixture.cleanup(); }
});

test('desktop full-size photo has a "Show full size" control that opens the dialog, and phone peek is kept', () => {
  const page = readFileSync(new URL('../src/panel-receipt-page.js', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../src/panel-workspace-script.js', import.meta.url), 'utf8');
  assert.match(page, /data-photo-full>Show full size/);
  assert.ok(script.includes("openDialog('Receipt full size'"));
  assert.ok(script.includes("classList.add('peek')"));
});
