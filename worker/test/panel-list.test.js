// The receipts list pane and the desktop landing (P4). Every receipt is made up; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusPage } from '../src/panel-pages.js';
import { WORKSPACE_CSS } from '../src/panel-workspace-style.js';

const at = '2026-11-07T10:00:00Z';
const recent = [
  { key: 'k1', file: 'a.jpg', done: true, result: 'review', at, card: { store: 'Corner Grocery', total: 41.2, date: '2026-11-06' } },
  { key: 'k2', file: 'b.jpg', waiting: { nextCheck: '2099-01-01T00:00:00Z', reason: 'none yet' }, at, card: { store: 'Hardware Mart', total: 12.5, date: '2026-11-05' } },
  { key: 'k3', file: 'c.jpg', done: true, result: 'confirm', applied: { action: 'confirm' }, at, card: { store: 'Pharmacy', total: 8, date: '2026-11-04' } },
];
const page = (over = {}, opts) => statusPage({ dryRun: false, heartbeat: 'x', recent, ...over }, 'k', '', undefined, opts);
const rail = (html) => html.match(/<aside class="queue-rail"[^]*?<\/aside>/)[0];

test('the list pane: Receipts, search, Review and Waiting as plain groups, Filed as a collapsed toggle, a dot per row, no filter chips', () => {
  const r = rail(page());
  assert.match(r, /<h2>Inbox<\/h2>/);
  assert.match(r, /<label class="sr-only" for="queue-search">Search receipts<\/label><input id="queue-search" type="search" data-queue-search /);
  assert.match(r, /<section class="queue-section" data-queue-group="review"><h3 class="queue-heading">Review <span class="queue-count">1<\/span><\/h3>/);
  assert.match(r, /<section class="queue-section" data-queue-group="waiting"><h3 class="queue-heading">Waiting <span class="queue-count">1<\/span><\/h3>/);
  assert.match(r, /<details class="queue-filed" data-queue-group="filed"><summary aria-expanded="false">Filed <span class="queue-count">1<\/span><\/summary>/, 'Filed is collapsed');
  assert.match(r, /class="queue-row r-attn"[^>]*>.*?Corner Grocery/);
  assert.match(r, /class="queue-row r-wait"/);
  assert.match(r, /class="queue-row r-ok"/);
  assert.equal((r.match(/<span class="dot" aria-hidden="true"><\/span>/g) || []).length, 3);
  assert.doesNotMatch(r, /queue-filter[^]*<select|data-chip|queue-archive/);
  assert.match(r, /data-search="[^"]*41\.20/, 'amounts are searchable');
  assert.match(r, /<span class="queue-draft" data-draft-for="k1" hidden>Unsaved edits<\/span>/);
});

test('the list pane ends with the Activity and test mode link instead of an Archive link', () => {
  const r = rail(page());
  assert.match(r, /<a class="queue-activity" data-navigate href="\.\/\?key=k&amp;activity=1">Activity and test mode<\/a>/);
  assert.doesNotMatch(r, /href="archived/);
});

test('setup alerts are plain cards at the top of the list pane', () => {
  const r = rail(page({ alert: { message: 'The decider rejected the API key', at: 'x' } }));
  assert.match(r, /<div class="queue-alerts"><div class="banner live"><b>The worker is paused<\/b>/);
  assert.ok(r.indexOf('queue-alerts') < r.indexOf('<h2>Inbox</h2>'));
  assert.doesNotMatch(rail(page()), /queue-alerts/);
});

test('the desktop landing is "Pick a receipt" with Open first in Review; the diagnostics are the other view', () => {
  const html = page();
  assert.match(html, /<section class="workspace-detail status-landing"><div class="pick-pane"><h2>Pick a receipt<\/h2>/);
  assert.match(html, /<a class="btn" data-navigate data-open-first href="receipt\?key=k&amp;id=k1&amp;group=review">Open first in Review<\/a>/);
  assert.match(html, /<section class="workspace-detail status-overview" id="activity" hidden>/);
  assert.doesNotMatch(html, /<div class="workspace-shell has-receipt"/);
  const activity = page({}, { activity: true });
  assert.match(activity, /<section class="workspace-detail status-landing" hidden>/);
  assert.match(activity, /<section class="workspace-detail status-overview" id="activity"><a class="workspace-back"[^>]*>&larr; Inbox<\/a><h2>Activity and test mode<\/h2>/);
  assert.match(activity, /class="workspace-shell has-receipt" data-overview/);
  for (const needed of ['Last check', 'Check now', 'id="recent" data-sortable', 'What the statuses mean', 'Status details', 'Upload help', 'Last processed']) assert.ok(activity.includes(needed), needed);
});

test('with nothing in Review the landing says "All caught up" and offers no Open button', () => {
  for (const list of [[recent[2]], recent.filter((r) => r.key !== 'k1')]) {
    const html = page({ recent: list });
    assert.match(html, /<div class="pick-pane"><h2>All caught up<\/h2>/);
    assert.match(html, /Nothing needs your review\./);
    assert.doesNotMatch(html.match(/<section class="workspace-detail status-landing"[^]*?<\/section>/)[0], /data-open-first|Pick a receipt/);
  }
});

test('Archive all done and the mode switch stay reachable in Activity and test mode', () => {
  const live = page({ archivable: 2 }, { activity: true });
  assert.match(live, /Archive all done receipts \(2\)\.\.\./);
  assert.match(live, /Switch to dry run/);
  const dry = statusPage({ dryRun: true, heartbeat: 'x', recent }, 'k', '', undefined, { activity: true });
  assert.match(dry, /Go live\.\.\./);
});

test('F6: Activity has one entry (the foot of the list), its own title and a current state; the landing has no second link', () => {
  const landing = page();
  assert.doesNotMatch(landing.match(/<section class="workspace-detail status-landing"[^]*?<\/section>/)[0], /Activity and test mode/);
  assert.doesNotMatch(rail(landing), /queue-activity[^>]*aria-current/);
  const activity = page({}, { activity: true });
  assert.match(activity, /<title>Activity · Receipts<\/title>/);
  assert.match(rail(activity), /<a class="queue-activity" data-navigate href="\.\/\?key=k&amp;activity=1" aria-current="page">/);
});

test('on a phone the landing is hidden by a rule that comes after the one that shows it', () => {
  assert.ok(WORKSPACE_CSS.lastIndexOf('.status-landing{display:none}') > WORKSPACE_CSS.lastIndexOf('.status-landing{display:flex'));
});
