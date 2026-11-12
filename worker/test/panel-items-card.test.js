// The Items & categories card (P6): rows, Set all items, the split bar and legend, the footer, the cash account. Fictional receipts only.
import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { receiptPage } from '../src/panel-receipt-page.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const form = (html) => html.match(/<form\b[^>]*data-preview-form[^]*?<\/form>/)[0];
const names = (markup) => [...new Set([...markup.matchAll(/<(?:input|select)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]))].sort();
const bare = (html) => html.replace(/<(style|script)>[^]*?<\/\1>/g, '');

test('the edit form still submits exactly the same fields', () => {
  const html = fixture.renderReceipt();
  const got = names(form(html));
  // `group` (P7): the list group the receipt was opened from, a cleaned nav field like sort and q.
  const expected = ['key', 'id', 'preview', 'rid', 'group', ...[0, 1, 2, 3, 4].flatMap((i) => [`a${i}`, `c${i}`]), 'nd0', 'na0', 'nc0', 'nt0'].filter((n) => got.includes(n) || /^n[datc]0$/.test(n));
  for (const must of ['key', 'id', 'preview', 'rid', 'a0', 'c0', 'a4', 'c4', 'nd0', 'na0', 'nc0']) assert.ok(got.includes(must), must);
  assert.deepEqual(got.filter((n) => !expected.includes(n)), [], 'nothing new is submitted');
  assert.ok(!got.includes('acct'), 'not a cash receipt: no account field');
});

test('an item row shows Not sure with its reason, and Was X · Revert · Make a rule when edited; no raw OCR line, no Check category fold', () => {
  const html = bare(fixture.renderReceipt());
  const unsure = html.match(/<tr data-item="3"[^]*?<\/tr>/)[0];
  assert.match(unsure, /<span class="nsure">Not sure<\/span><span class="reason">Groceries is also possible\.<\/span>/);
  const hint = unsure.match(/<div class="sub item-edit-hint"[^>]*data-item-hint hidden>[^]*?<\/div>/)[0];
  assert.match(hint, /data-was/);
  assert.match(hint, /<button type="button"[^>]*data-item-revert>Revert<\/button>/);
  assert.match(hint, /<a [^>]*data-rule-link>Make a rule<\/a>/);
  assert.doesNotMatch(html, /Check category|item-note"><summary>About the amounts/);
  assert.doesNotMatch(html.match(/<tr data-item="0"[^]*?<\/tr>/)[0], /class="nsure"/, 'a sure item has no badge');
  assert.match(html, /<input type="text" inputmode="decimal" class="amt" name="a0" /, 'the amount stays an editable field');
});

test('Set all items is an sr-only label and a disabled placeholder, in the card head, and the category values keep their full labels', () => {
  const f = form(fixture.renderReceipt());
  const head = f.match(/<div class="edhead">[^]*?<\/select>/)[0];
  assert.match(head, /<h2 class="card-title">Items &amp; categories<\/h2>/);
  assert.match(head, /<label class="sr-only" for="bulk-category">Set all items<\/label>/);
  assert.match(head, /<select [^>]*id="bulk-category" data-bulk-category/);
  assert.match(head, /<option value="" selected disabled>Set all items…<\/option>/);
  assert.ok(f.indexOf('data-bulk-category') < f.indexOf('<table class="items"'));
  assert.match(f, /<option value="Daily \/ Groceries" selected>Groceries<\/option>/);
});

test('the split is an SVG bar and a legend, coloured by class, with no style attribute; the legend adds up to the charge', () => {
  const html = bare(fixture.changedPreview);
  const split = html.match(/<section class="split-preview" data-preview-split>[^]*?<\/section>/)[0];
  assert.match(split, /<svg class="split-bar" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="Split by category"><rect class="c0" x="0\.000"/);
  const rects = [...split.matchAll(/<rect class="c(\d)" x="([\d.]+)" y="0" width="([\d.]+)" height="16"\/>/g)];
  assert.ok(rects.length >= 2);
  assert.ok(Math.abs(rects.reduce((t, m) => t + Number(m[3]), 0) - 100) < 0.01, 'the bar fills its width');
  const legend = [...split.matchAll(/<li><i class="sw c\d" aria-hidden="true"><\/i><span>[^<]*<\/span><strong>\$([\d.-]+)<\/strong><\/li>/g)].map((m) => Math.round(Number(m[1]) * 100));
  assert.equal(legend.length, rects.length);
  assert.equal(legend.reduce((t, c) => t + c, 0), 3215, 'parts add up to the charge');
  assert.match(split, /<p class="live-note">Tax: /);
  assert.doesNotMatch(html, /\sstyle="/);
});

test('the split is hidden when the whole charge is in one category', () => {
  const view = fixture.view();
  const single = fixture.view(new URLSearchParams({ preview: '1', rid: view.fix.readingId, ...Object.fromEntries([0, 1, 2, 3, 4].flatMap((i) => [[`c${i}`, 'Daily / Groceries'], [`a${i}`, ['4.18', '5.98', '9.49', '8.00', '3.79'][i]]])) }));
  const html = bare(receiptPage(single, 'fixture-key', ''));
  assert.match(html, /<section class="split-preview" data-preview-split hidden>/);
});

test('the footer is quiet until there is an edit, and has Discard changes', () => {
  const html = bare(fixture.renderReceipt());
  assert.match(html, /<p data-editor-consequence data-clean="" data-edited="Updates the existing charge in Actual\."><\/p>/);
  assert.match(html, /data-editor-discard hidden>Discard changes<\/button>/);
  assert.doesNotMatch(html, /Save to Actual/);
});

test('a cash receipt: the account menu sits in the footer beside Create, belongs to the form, and the sentence names the account', () => {
  const view = fixture.view();
  const cash = { ...view, fix: { ...view.fix, kind: 'cash', cash: { accounts: ['Cash wallet', 'Checking'], account: 'Cash wallet', chosen: 'Cash wallet' } } };
  const html = bare(receiptPage(cash, 'fixture-key', ''));
  assert.ok(!form(html).includes('name="acct"'), 'outside the form element');
  assert.match(html, /<label for="acct" class="inline-label">Create in<\/label><select name="acct" id="acct" form="receipt-edit-form">/);
  // only the button row is the sticky bar; the sentence and the menu scroll with the card
  const lead = html.match(/<div class="editor-lead">[^]*?<\/div>/)[0];
  const bar = html.match(/<div class="editor-actions">[^]*?<\/div><\/div>/)[0];
  assert.match(lead, /data-editor-consequence/);
  assert.match(lead, /name="acct" id="acct" form="receipt-edit-form"/);
  assert.doesNotMatch(bar, /data-editor-consequence|name="acct"/);
  assert.match(bar, /data-editor-discard[^]*data-editor-save/);
  assert.doesNotMatch(html, /Which Actual account the cash purchase goes in/, 'the repeated explanation is gone');
  assert.match(html, /data-clean="Creates a \$32\.15 purchase in Cash wallet\." [^>]*data-cash-lead="Creates a \$32\.15 purchase in "/);
  assert.match(html, /form="receipt-edit-form" data-editor-save>/);
  assert.match(html, /<a data-navigate href="settings\?key=fixture-key&amp;section=everyday#s-CASH_ACCOUNT"[^>]*>Change the default account<\/a>/, "P9: the Everyday section page, by client navigation (drafts kept)");
});

test('active review names the uncertain item and keeps current reasons in the banner', () => {
  const html = bare(fixture.renderReceipt());
  const banner = html.match(/<section class="status-banner[^]*?<\/section>/)[0];
  assert.match(banner, /1 item to check: Food storage containers\./);
  assert.match(banner, /Why it needs review/);
  const v = fixture.view();
  v.summary = structuredClone(v.summary);
  delete v.summary.receipt.items[3].unsureGuess;
  assert.match(bare(receiptPage(v, 'k', '')), /Already filed in Actual\. Check the categories\./);
});

test('resolved and archived reasons are history inside Receipt details', () => {
  for (const archived of [false, true]) {
    const v = fixture.view();
    v.entry = { ...v.entry, reviewed: true, ...(archived ? { archived: { at: '2026-11-08T12:00:00Z' } } : {}) };
    if (archived) v.fix = null;
    const html = bare(receiptPage(v, 'k', ''));
    assert.doesNotMatch(html.match(/<section class="status-banner[^]*?<\/section>/)[0], /Why it needs review/);
    assert.match(html, /id="receipt-information"[^]*Why it was reviewed/);
  }
});

test('initial split includes known tax and currency', () => {
  const html = bare(fixture.renderReceipt());
  const split = html.match(/<section class="split-preview"[^]*?<\/section>/)[0];
  assert.match(split, /<span>\$32\.15<\/span>/);
  assert.match(split, /<strong>\$20\.09<\/strong>/);
  assert.match(split, /class="live-note">Tax:/);
});

test('with no next and no previous receipt there is no Next/Previous row at all', () => {
  const html = bare(fixture.renderReceipt());
  assert.doesNotMatch(html, /<nav class="next-row"/);
  assert.match(html, /class="editor-actions"[^]*?class="buttons"[^]*?data-editor-save>[^<]*<\/button><\/div><\/div>/);
  assert.equal((html.match(/rel="next"/g) ?? []).length, 0, 'last review receipt has no Next');
  assert.doesNotMatch(html, /aria-disabled="true">Next receipt/, 'F5: no greyed-out Next');

});

test('cash archive is foregrounded while retry stays in More', () => {
  const v = fixture.view();
  v.entry = { ...v.entry, result: 'review', applied: undefined };
  v.fix = { ...v.fix, kind: 'cash', cash: { accounts: ['Cash wallet'], account: 'Cash wallet' } };
  const html = bare(receiptPage(v, 'k', ''));
  const banner = html.match(/<section class="status-banner[^]*?<\/section>/)[0];
  assert.match(banner, /action="archive\?/);
  assert.doesNotMatch(banner, /Try again/);
  assert.match(html.match(/<details class="receipt-more"[^]*?<\/details>/)[0], /Try again/);
});
