// Round 2: the Archive tab is the approved two-pane (list pane with Restore beside the open receipt, read-only items), never the old table.
import './support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptPage, cleanNav } from '../src/panel-pages.js';
import { archivedPage, archivedNav } from '../src/panel-archive-page.js';
import { archiveRail } from '../src/panel-queue.js';

const bare = (html) => html.replace(/<(style|script)>[^]*?<\/\1>/g, '');
const entry = (key, store, total, at, extra = {}) => ({ key, file: `${key}.jpg`, done: true, result: 'split', filedAs: `Archive/m/${key}.jpg`, archived: { at, ...extra }, card: { store, date: '2026-11-05', total } });
const LIST = [
  entry('g', 'Greenleaf Shop', 24.1, '2026-11-09T12:00:00Z'),
  entry('j', 'Juniper Market', 15.6, '2026-11-08T12:00:00Z', { dismissed: true, restoreTo: 'review' }),
  entry('p', 'Paper Trail', 8.9, '2026-11-06T12:00:00Z'),
];
const SUMMARY = {
  receipt: { merchant: 'Greenleaf Shop', date: '2026-11-05', total: 24.1, tax: 1.6, items: [{ description: 'BASIL FRSH', plain: 'Fresh basil', amount: 15 }, { description: 'CNDL SOY 8OZ', plain: 'Candle', amount: 7.5 }, { description: 'MYSTERY', amount: 1 }] },
  transaction: { id: 't', payee: 'Greenleaf', date: '2026-11-05', amount: '24.10', account: 'Checking' },
  plan: { applied: true, action: 'split', parts: [{ category: 'Daily / Groceries', amount: '16.60', items: ['BASIL FRSH'] }, { category: 'Daily / Household', amount: '7.50', items: ['CNDL SOY 8OZ'] }] },
};
const view = (id, summary = SUMMARY) => ({ id, name: `${id}.jpg`, entry: LIST.find((e) => e.key === id), pages: 0, summary });

test('the Archive list pane has "← Receipts", search, rows (name, amount, "Was … · Archived <date>", no dot) and an inline Restore', () => {
  const html = bare(archivedPage({ archived: LIST, dryRun: false, nav: cleanNav(new URLSearchParams()) }, 'k', ''));
  const rail = html.match(/<aside\b[^]*?<\/aside>/)[0];
  assert.match(rail, /^<aside class="queue-rail archive-rail" aria-label="Archive"><h2>Archive<\/h2>/);
  assert.doesNotMatch(rail, /archive-back|&larr; Inbox/, 'F8: no "← Receipts" in the pane');
  assert.match(rail, /type="search" data-queue-search/);
  assert.match(rail, /<span class="queue-store">Greenleaf Shop<\/span><span class="queue-amount">\$24\.10<\/span><span class="queue-sub">Was Filed · Archived Nov 9<\/span>/);
  assert.match(rail, /Juniper Market[^]*?Was Review · Archived Nov 8/, 'a receipt dismissed from Review says so');
  assert.doesNotMatch(rail, /class="dot"/);
  assert.equal((rail.match(/<form method="post" action="restore\?key=k"><input type="hidden" name="id" value="[a-z]">/g) ?? []).length, 3, 'one inline Restore per row');
  assert.match(rail, /aria-label="Restore Greenleaf Shop">Restore<\/button>/);
  assert.doesNotMatch(rail, /Review <span|All caught up|queue-heading/);
});

test('the Archive landing keeps the help and asks for a receipt; its sort is honoured and rows use client navigation', () => {
  const html = bare(archivedPage({ archived: LIST, dryRun: false, nav: cleanNav(new URLSearchParams('sort=store&dir=desc')) }, 'k', ''));
  assert.match(html, /<h2>Pick an archived receipt<\/h2>/);
  assert.match(html, /How archiving works/);
  assert.deepEqual([...html.matchAll(/<span class="queue-store">([^<]+)</g)].map((m) => m[1]), ['Paper Trail', 'Juniper Market', 'Greenleaf Shop']);
  assert.match(html, /<option value="store" selected>Store<\/option>/);
  assert.match(html, /<option value="desc" selected>Descending<\/option>/);
  for (const a of html.match(/<a class="queue-row"[^>]*>/g)) assert.match(a, /^<a class="queue-row" data-navigate /, 'no full page reload, so no unsaved-edits prompt');
  assert.match(html, /<title>Archive · Receipts<\/title>/);
});

test('an archived receipt keeps the Archive list beside it: never "Review 0", the open row marked, Restore inline', () => {
  const nav = archivedNav(LIST, 'g', cleanNav(new URLSearchParams('q=green')));
  assert.deepEqual(nav.list.map((r) => r.key), ['g'], 'the search narrows Previous / Next');
  assert.equal(nav.full.length, 3, 'the list pane is not narrowed by the search');
  const html = bare(receiptPage(view('g'), 'k', '', nav));
  const rail = html.match(/<aside\b[^]*?<\/aside>/)[0];
  assert.match(rail, /archive-rail/);
  assert.doesNotMatch(html, /queue-heading|All caught up|None right now/);
  assert.match(rail, /<li class="archive-item open"><a class="queue-row" data-navigate data-queue-row data-id="g"[^>]*aria-current="page"/);
  assert.equal((rail.match(/action="restore\?key=k"/g) ?? []).length, 3);
  assert.match(html, /<button class="primary">Restore receipt<\/button>/);
});

test('an archived receipt shows its items with the category each was filed under, and the split, read-only', () => {
  const html = bare(receiptPage(view('g'), 'k', '', archivedNav(LIST, 'g', cleanNav(new URLSearchParams()))));
  const card = html.match(/<section class="workspace-editor"[^]*?<\/section>\s*(?:<\/div>|<details)/)?.[0] ?? html;
  assert.match(card, /Archived\. Restore it to change its categories\./);
  assert.match(card, /<tr><td>Fresh basil<\/td><td class="muted">BASIL FRSH<\/td><td>15\.00<\/td><td>Groceries<\/td><\/tr>/);
  assert.match(card, /<tr><td>Candle<\/td><td class="muted">CNDL SOY 8OZ<\/td><td>7\.50<\/td><td>Household<\/td><\/tr>/);
  assert.match(card, /<td><span class="muted">Not recorded<\/span><\/td>/, 'an item no filed part lists says so');
  assert.match(card, /<section class="split-preview archived-split"><h3>Filed as<span>\$24\.10<\/span><\/h3><svg class="split-bar"/);
  assert.doesNotMatch(card, /<input|<select|data-editor-save|data-preview-form/, 'nothing editable');
});

test('an archived receipt with no readable summary still opens, with just the note', () => {
  const html = bare(receiptPage(view('p', null), 'k', '', archivedNav(LIST, 'p', cleanNav(new URLSearchParams()))));
  assert.match(html, /Archived\. Restore it to change its categories\./);
  assert.doesNotMatch(html, /archived-items/);
});

test('an empty Archive list pane says why, and has no sort menu', () => {
  const rail = archiveRail([], 'k', { empty: 'Nothing archived yet.' });
  assert.match(rail, /<li class="queue-empty">Nothing archived yet\.<\/li>/);
  assert.doesNotMatch(rail, /archive-sort/);
});
