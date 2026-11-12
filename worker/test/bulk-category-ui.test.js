import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { receiptPage } from '../src/panel-receipt-page.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const editor = (html) => html.match(/<form\b[^>]*data-preview-form[^]*?<\/form>/)?.[0];
const bulk = (html) => editor(html)?.match(/<select\b[^>]*data-bulk-category[^]*?<\/select>/)?.[0];
const optionValues = (select) => [...select.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map((m) => m[1]);
const render = (view) => receiptPage(view, 'fixture-key', '');

test('multi-item receipts put a labelled non-submitting bulk selector before the ledger', () => {
  const html = fixture.renderReceipt(), form = editor(html), select = bulk(html);
  assert.ok(select, 'multi-item receipt offers bulk categorization');
  const tag = select.match(/^<select\b[^>]*>/)[0];
  assert.doesNotMatch(tag, /\bname=/, 'bulk choice is not a server write field');
  const id = tag.match(/\bid="([^"]+)"/)?.[1];
  assert.ok(id && form.includes(`for="${id}">Set all items</label>`), 'bulk selector has its own visible label');
  assert.match(select, /<option\b[^>]*value=""[^>]*>Set all items…<\/option>/);
  assert.ok(form.indexOf(select) < form.indexOf('<table class="items"'), 'bulk choice precedes individual rows');
  for (let i = 0; i < 5; i++) assert.match(form, new RegExp(`name="c${i}"`), 'individual categories remain editable');
});

test('bulk selector retains grouped categories, Uncategorized and excluded-category labels', () => {
  const view = fixture.view();
  view.fix.options = view.fix.options.map((option) => ({ ...option, excluded: option.label === 'Daily / Gifts' }));
  const html = render(view), select = bulk(html);
  assert.ok(select);
  const individual = editor(html).match(/<select\b[^>]*name="c0"[^]*?<\/select>/)[0];
  assert.deepEqual(optionValues(select).filter(Boolean), optionValues(individual));
  assert.match(select, /<optgroup label="Daily">/);
  assert.match(select, /value="Uncategorized"/);
  assert.match(select, /Gifts \(excluded\)/);
});

test('a lone item needs no bulk control until a populated added line gives it something to change', () => {
  const view = fixture.view();
  view.summary = structuredClone(view.summary); view.summary.receipt.items = view.summary.receipt.items.slice(0, 1);
  view.fix = { ...view.fix, items: view.fix.items.slice(0, 1), picks: view.fix.picks.slice(0, 1) };
  assert.ok(bulk(render(view)), 'single-item editor retains the hidden enhancement for later added lines');
  assert.match(editor(render(view)), /<div\b[^>]*data-bulk-control[^>]*\bhidden\b/, 'a lone item starts without visible bulk UI, including without JavaScript');
  view.fix.added = [{ description: 'Discount', amount: '-1.50', category: 'Daily / Groceries', tax: '' }, { description: '', amount: '', category: 'Daily / Groceries', tax: '' }];
  assert.ok(bulk(render(view)), 'one item plus a populated added line offers bulk UI');
  assert.equal(bulk(render({ ...view, fix: { ok: false, reason: 'Receipt is unavailable.' } })), undefined, 'no editing control leaks into an unavailable editor');
});
