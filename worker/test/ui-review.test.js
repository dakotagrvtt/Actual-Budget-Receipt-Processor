import "./support.js";
// User-visible contracts from the phone/desktop UI audit. Pure rendered pages, made-up receipt data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusPage, receiptPage, settingsPage } from '../src/panel-pages.js';
import { config } from '../src/config.js';
const key = `${config.nextcloud.inbox}/camera.jpg@1`;
const receipt = { merchant: 'Corner Store', date: '2026-10-19', total: 27.53, payment_method: 'cash', items: [{ description: 'Milk', amount: 27.53 }] };
const base = { id: key, name: 'camera.jpg', entry: { done: true, result: 'review', at: '2026-11-08T12:00:00Z' }, pages: 1, summary: { receipt, problems: ['paid in cash, enter it in Actual by hand'] } };

test('status puts diagnostics and upload instructions after the queue and uses clear receipt identity', () => {
  const html = statusPage({ dryRun: false, heartbeat: 'not yet', envNote: 'DIAGNOSTIC MARKER', recent: [{ ...base.entry, key, file: base.name, card: { store: receipt.merchant, date: receipt.date, total: receipt.total } }] }, 'test', '');
  assert.ok(html.indexOf('data-row') < html.indexOf('DIAGNOSTIC MARKER'));
  assert.match(html, />Corner Store · 27\.53<\/a>/);
  assert.match(html, /Purchase date: 2026-10-19/);
  assert.match(html, /Last processed/);
  assert.doesNotMatch(html, /<span class="raw">/);
  assert.match(html, /data-search="[^"]*camera\.jpg/);
});

test('cash guidance replaces old manual-entry instructions without hiding unrelated doubts', () => {
  const html = receiptPage({ ...base, summary: { ...base.summary, problems: [...base.summary.problems, 'tax total needs checking'] } }, 'test', '');
  assert.doesNotMatch(html, /enter it in Actual by hand/);
  assert.match(html, /tax total needs checking/);
});

test('review reasons and recovery links are before the photo', () => {
  const html = receiptPage({ ...base, summary: { receipt: { ...receipt, payment_method: 'visa' }, problems: ['No matching charge found'] } }, 'test', '');
  assert.ok(html.indexOf('No matching charge found') < html.indexOf('class="receipt-grid"'));
  assert.match(html, /<details class="receipt-photo-toggle" open><summary>View receipt<\/summary>/);
  assert.match(html, /id="receipt-photo"/);
  assert.doesNotMatch(html.slice(0,html.indexOf('class="receipt-grid"')), /\.json file beside/);
});

test('receipt header leads with merchant and separates purchase date from processing time', () => {
  const html = receiptPage(base, 'test', '');
  assert.match(html, /<h2[^>]*data-workspace-title>Corner Store<\/h2>/);
  assert.match(html, /class="workspace-total">\$27\.53<\/span>/);
  assert.match(html, /class="workspace-meta">Oct 19/);
  assert.match(html, /Last processed/);
  assert.match(html, /id="receipt-information"/);
});

test('the cash setting is always visible with its stable fragment destination', () => {
  const html = settingsPage({ sections: [{ id: 'matching', title: 'Matching', settings: [{ key: 'CASH_ACCOUNT', type: 'account', label: 'Cash purchases go to', value: '', source: 'default', choices: [], default: '' }] }] }, 'test', '', undefined, { section: 'everyday' });
  const everyday = html.match(/<section class="settings-everyday">[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(everyday, /<label for="s-CASH_ACCOUNT">Cash purchases go to/);
  assert.match(everyday, /id="s-CASH_ACCOUNT"/);
  assert.doesNotMatch(everyday.slice(0, everyday.indexOf('id="s-CASH_ACCOUNT"')), /<details/);
});

test('correction form exposes metadata and guarded charge choices with escaped labels', () => {
  const html = receiptPage({ ...base, resolution: { values: { merchant: 'Bad <name>', date: '2026-10-19', total: '27.53', payment_method: 'card' }, token: 'synthetic', window: { start: '2026-10-12', end: '2026-10-26' }, candidates: [{ id: 't1', payee: 'Store <x>', amount: '27.53', date: '2026-10-20', account: 'Checking', category: 'Daily / Food', keep: true }] } }, 'test', '');
  assert.match(html, /name="receipt-total" value="27.53"/);
  assert.match(html, /name="receipt-payment_method"/);
  assert.match(html, /Store &#60;x&#62;/);
  assert.match(html, /Link and keep what is in Actual/);
  assert.match(html, />Keep checking for 27\.53<\/button>/);
  const correctionAt = html.indexOf('id="receipt-resolution"');
  const photoAt = html.indexOf('id="receipt-photo"');
  assert.ok(correctionAt >= 0 && photoAt > correctionAt, 'unmatched charge correction precedes the photo');
});

test('queue exposes a review-cause filter, specific reasons, and no review group for completed links', () => {
  const rows = [
    { key: 'a', file: 'a.jpg', done: true, result: 'review', review: { cause: 'matching', label: 'Bank match', reason: 'Choose the bank charge.' } },
    { key: 'b', file: 'b.jpg', done: true, result: 'confirm', manualLink: { keep: true } },
  ];
  const html = statusPage({ recent: rows }, 'test', '');
  assert.match(html, /data-field="cause"/);
  assert.match(html, /data-cause="matching"/);
  assert.match(html, /Choose the bank charge\./);
  assert.match(html, /data-cause=""/);
});

test('an interrupted correction is review work instead of claiming automatic waiting checks', () => {
  const html = statusPage({ recent: [{ key: 'a', file: 'a.jpg', done: false, waiting: { nextCheck: '2099-01-01' }, resolutionPending: {} }] }, 'test', '');
  assert.match(html, /data-cause="service"/);
  assert.match(html, /The receipt record still needs to be saved/);
  assert.doesNotMatch(html, /Will be checked again/);
});

test('Settings validation opens its group and provides an alert and a direct link to the field', () => {
  const html = settingsPage({ sections: [{ id: 'matching', title: 'Accounts and splitting', settings: [{ key: 'CASH_ACCOUNT', type: 'account', label: 'Cash purchases go to', value: '', source: 'default', choices: [], default: '' }] }] }, 'test', 'Cash purchases go to: choose an account.');
  assert.match(html, /class="notice err" role="alert"/);
  assert.match(html, /class="settings-everyday"[\s\S]*id="s-CASH_ACCOUNT"/);
  assert.match(html, /href="#s-CASH_ACCOUNT">Go to Cash purchases go to/);
});

test('Settings connection failures reopen setup and give a clear return link', () => {
  const html = settingsPage({ sections: [{ id: 'connections', title: 'Connections and folders', settings: [{ key: 'ACTUAL_SERVER_URL', type: 'url', label: 'Actual server address', value: 'https://example.invalid', source: 'env', default: '' }] }] }, 'test', 'The server refused the connection. Nothing was saved.');
  assert.match(html, /class="notice err" role="alert"/);
  assert.match(html, /data-settings-section="connections"/, 'P9: the Connections page, not a closed card');
  assert.match(html, /<section class="settings-card settings-panel" id="settings-connections"/);
  assert.match(html, /href="#settings-connections">Go to connections/);
});
