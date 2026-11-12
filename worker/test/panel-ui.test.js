// The panel's look that tests can see: short times and "ago" text, the exact time kept in the page, the upload control with and without
// JavaScript, the waiting wording, and the card the worker saves for the list. No browser.
import './support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { displayDate, displayMoney, money, shortWhen, ago, whenAhead, timeTag, clockOrDate, CSP } from '../src/panel-layout.js';
import { statusPage, cardText } from '../src/panel-status.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { SCRIPT } from '../src/panel-script.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), dryRun: false });
config.trigger.timeZone = 'UTC';
const { inbox } = config.nextcloud;

const NOW = new Date('2026-11-08T21:30:00Z');

test('shortWhen: today with the time, yesterday, a date, the year only when it is another year; nothing for no time', () => {
  assert.equal(shortWhen('2026-11-08T19:17:06Z', NOW), 'Today 7:17 PM');
  assert.equal(shortWhen('2026-11-07T23:59:00Z', NOW), 'Yesterday');
  assert.equal(shortWhen('2026-11-01T10:00:00Z', NOW), 'Nov 1');
  assert.equal(shortWhen('2025-12-31T10:00:00Z', NOW), 'Dec 31, 2025');
  assert.equal(shortWhen('2026-01-01T00:30:00Z', new Date('2026-12-31T23:00:00Z')), 'Jan 1');
  assert.equal(shortWhen('', NOW), '');
  assert.equal(shortWhen('not a date', NOW), '');
  assert.equal(shortWhen(null, NOW), '');
  assert.equal(shortWhen('2026-11-09T09:00:00Z', NOW), 'Nov 9', 'a future day is a plain date');
  assert.equal(clockOrDate('2026-11-08T19:17:06Z'.replace('2026-11-08', new Date().toISOString().slice(0, 10))), '7:17 PM');
});

test('ago: just now, minutes, hours, days; the text itself when it is not a time; never negative', () => {
  const t = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  assert.equal(ago(t(0), NOW.getTime()), 'just now');
  assert.equal(ago(t(2), NOW.getTime()), '2 min ago');
  assert.equal(ago(t(59), NOW.getTime()), '59 min ago');
  assert.equal(ago(t(180), NOW.getTime()), '3 h ago');
  assert.equal(ago(t(60 * 24 * 5), NOW.getTime()), '5 days ago');
  assert.equal(ago('not yet', NOW.getTime()), 'not yet');
  assert.equal(ago(undefined, NOW.getTime()), '');
  assert.equal(ago(new Date(NOW.getTime() + 600000).toISOString(), NOW.getTime()), 'just now', 'a clock a little ahead is not "-10 min"');
});

test('whenAhead: today, tomorrow, later date with a time; nothing once the time has passed', () => {
  assert.equal(whenAhead('2026-11-08T22:24:00Z', NOW), 'today at 10:24 PM');
  assert.equal(whenAhead('2026-11-09T09:00:00Z', NOW), 'tomorrow at 9:00 AM');
  assert.equal(whenAhead('2026-11-12T09:00:00Z', NOW), 'on Nov 12 at 9:00 AM');
  assert.equal(whenAhead('2026-11-08T20:00:00Z', NOW), '');
  assert.equal(whenAhead('garbage', NOW), '');
});

test('timeTag keeps the exact time as datetime and title', () => {
  const html = timeTag('2026-11-07T19:17:06Z');
  assert.match(html, /^<time datetime="2026-11-07T19:17:06\.000Z" title="[^"]*2026[^"]*">/);
  assert.equal(timeTag('nope', 'x'), 'x');
});

const entry = (over = {}) => ({ key: `${inbox}/a.jpg@1`, file: 'a.jpg', done: true, result: 'confirm', applied: {}, at: '2026-10-31T21:08:00Z', ...over });

test('the status page: Last check has the exact time, Live says what it does, the When cell is a <time> with a title', () => {
  const hb = new Date(Date.now() - 120000).toISOString();
  const html = statusPage({ dryRun: false, heartbeat: hb, recent: [entry()] }, 'k', '');
  assert.match(html, /Last check <time datetime="[^"]+" title="[^"]+">2 min ago<\/time> \([^)]+\) · every/);
  assert.match(html, /The worker writes to Actual and moves files in Nextcloud\./);
  assert.match(html, /<td data-sort="2026-10-31T21:08:00Z" title="[^"]*"><time datetime="2026-10-31T21:08:00\.000Z"/);
  assert.match(statusPage({ dryRun: true, heartbeat: 'not yet', recent: [] }, 'k', ''), /Last check not yet · every/);
  assert.match(statusPage({ dryRun: false, heartbeat: hb, recent: [], stateError: 'boom' }, 'k', ''), /<p class="notice err">Can't read the list of receipts: boom/);
});

test('the receipt page shows the full date and time as text', () => {
  const view = { entry: entry(), id: entry().key, name: 'a.jpg', pages: 0, pdf: false, photoNote: '', summaryNote: '', summary: null, fix: { ok: false, reason: 'x' } };
  assert.match(receiptPage(view, 'k', ''), /<time datetime="2026-10-31T21:08:00\.000Z">10\/31\/2026, 9:08:00 PM<\/time>/);
});

test('upload without JavaScript: a visible file input and a Send button; the styled button is only for the page with the script', () => {
  const html = statusPage({ dryRun: false, heartbeat: 'x', recent: [] }, 'k', '');
  const input = html.match(/<input class="filebtn"[^>]*>/)[0];
  assert.match(input, /type="file"/);
  assert.ok(!/hidden|style=/.test(input), 'nothing in the markup hides it');
  assert.match(html, /<button class="plain" data-nojs>Send the chosen files<\/button>/);
  // the CSS hides the input and shows the styled label only under the `js` class the script sets
  assert.match(html, /\.js input\.filebtn\{position:absolute/);
  assert.match(html, /html:not\(\.js\) label\.btn\[for=receipt-files\]\{display:none\}/);
  assert.match(SCRIPT, /documentElement\.className \+= ' js'/);
  // the result message is its own full-width line under the buttons, not inside the (half-width) form
  const form = html.match(/<form[^>]*data-upload[^>]*>[^]*?<\/form>/)[0];
  assert.ok(!form.includes('data-upload-status'));
  assert.ok(html.includes('data-upload-status'));
});

test('the script guards the upload: one at a time, the input disabled meanwhile', () => {
  assert.match(SCRIPT, /var busy = false/);
  assert.match(SCRIPT, /if \(busy\) return;/);
  assert.match(SCRIPT, /input\.disabled = true/);
  assert.match(SCRIPT, /busy = false; input\.disabled = false/);
  assert.match(SCRIPT, /document\.querySelector\('\[data-upload-status\]'\)/);
});

test('the sort pills and the tabs: wrap, and the pills only show with JavaScript', () => {
  const html = statusPage({ dryRun: false, heartbeat: 'x', recent: [] }, 'k', '');
  assert.match(html, /nav\{display:flex;gap:0;flex-wrap:wrap/);
  assert.match(html, /\.cards thead tr\{display:flex;flex-wrap:wrap/);
  assert.match(html, /\.cards thead\{display:none\}\.js \.cards thead\{display:block\}/);
  assert.doesNotMatch(html, /<span class="raw">/, 'internal result codes are not repeated in the status cell');
  assert.ok(!/style="|onclick=|onload=/.test(html), 'still no inline style or handlers (the CSP)');
  assert.match(CSP, /style-src 'sha256-/);
});

test('waiting rows say when the next check is, in words', () => {
  const row = (waiting) => statusPage({ dryRun: false, heartbeat: 'x', recent: [{ key: `${inbox}/w.jpg@1`, file: 'w.jpg', waiting, at: '2026-11-07T10:00:00Z' }] }, 'k', '');
  const ahead = (ms) => new Date(Date.now() + ms).toISOString();
  assert.match(row({ nextCheck: '2020-01-01T00:00:00Z' }), /Will be checked again at the next check\./);
  assert.match(row({}), /Will be checked again soon\./);
  assert.match(row({ nextCheck: ahead(26 * 3600e3) }), /Will be checked again (tomorrow|on [A-Z][a-z]{2} \d+) at \d+:\d\d [AP]M\./);
  assert.doesNotMatch(row({ nextCheck: ahead(3600e3) }), /Checked again [Tt]oday/);
});

test('cardText: merchant and total from a card, a summary or a reading', () => {
  assert.equal(cardText({ card: { store: 'Shop', total: 4.5 } }), 'Shop · 4.50');
  assert.equal(cardText({ reading: { receipt: { merchant: 'Gas', total: 41 } } }), 'Gas · 41.00');
  assert.equal(cardText({}), '');
});

test('fileReceipt saves a card (store, date, total) on the entry, so the list can show them', async () => {
  const { fileReceipt } = await import('../src/index.js');
  const state = {};
  const summary = { receipt: { merchant: 'Corner Grocery', date: '2026-11-06', total: 84.12 }, transaction: { payee: 'Corner Grocery' } };
  config.dryRun = true; // nothing is moved in dry run; the entry is built the same way
  await fileReceipt({ basename: 'a.jpg' }, 'dry:k', state, { result: 'dry-run:split', summary, folder: config.nextcloud.processed });
  assert.deepEqual(state['dry:k'].card, { store: 'Corner Grocery', date: '2026-11-06', total: 84.12 });
  await fileReceipt({ basename: 'b.jpg' }, 'dry:k2', state, { result: 'dry-run:review', summary: undefined, folder: config.nextcloud.review });
  assert.equal(state['dry:k2'].card, undefined);
  config.dryRun = false;
});


test('purchase display formatting preserves calendar days and numeric input values', () => {
  assert.equal(displayDate('2026-11-08', NOW), 'Nov 8');
  assert.equal(displayDate('2025-11-08', NOW), 'Nov 8, 2025');
  assert.equal(displayDate('2026-02-30', NOW), '2026-02-30');
  assert.equal(displayDate('not a date', NOW), 'not a date');
  assert.equal(displayDate(null, NOW), '');
  assert.equal(displayMoney(32.15), '$32.15');
  assert.equal(displayMoney(null), '');
  assert.equal(money(32.15), '32.15');
});
