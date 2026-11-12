// Real-DOM checks of the shipped bulk category control, with actual synthetic SSR.
// node --env-file=worker/test.env worker/test/workspace-bulk-category-checks.mjs
// Add --single-item to check visibility when a lone item gains an added discount.
// Only fetch and the 450ms debounce clock are substituted. No service is contacted.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { cleanNav, receiptNav } from '../src/panel-status.js';
import { rememberAccounts } from '../src/known-accounts.js';

const fixture = await workspaceFixtures();
try {
  await rememberAccounts([{ name: 'Cash wallet' }, { name: 'Checking' }]);
  const single = process.argv.includes('--single-item');
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `/tmp/receipt-workspace-bulk-category${single ? '-single' : ''}.html`;
  const summary = structuredClone(fixture.summary), entry = { ...fixture.entry, applied: undefined, result: 'review' };
  delete summary.transaction; summary.plan = { applied: false, parts: [] }; summary.receipt.payment_method = 'cash';
  if (single) summary.receipt.items = summary.receipt.items.slice(0, 1);
  summary.receipt.items.forEach((item) => { item.taxable = true; });
  const nav = receiptNav(fixture.recent, fixture.id, cleanNav(new URLSearchParams()));
  const base = new URLSearchParams({ preview: '1', rid: '', acct: 'Checking' });
  summary.receipt.items.forEach((item, i) => { base.set('c' + i, item.category); base.set('a' + i, item.amount.toFixed(2)); });
  const cashLook = { account: { id: 'checking', name: 'Checking' }, payee: { id: 'riverside', name: 'Riverside Market', isNew: false }, duplicates: [] };
  const values = { merchant: 'Riverside Market', date: '2026-11-08', total: '32.15', payment_method: 'cash' };
  const resolution = { values, original: { ...values }, token: 'synthetic-link-token', window: { start: '2026-11-05', end: '2026-11-11' }, candidates: [{ id: 'selected-charge', payee: 'Riverside Market', amount: '32.15', date: '2026-11-08', account: 'Checking' }] };
  const render = (query) => {
    const fix = editorFor({ id: fixture.id, entry, summary, query, cashLook });
    if (!fix.ok || (query.get('preview') === '1' && !fix.preview)) throw new Error('Invalid bulk cash fixture');
    return receiptPage({ ...fixture.view(), entry, summary, fix, resolution }, 'fixture-key', '', nav);
  };
  const previewMain = (html) => {
    const start = html.indexOf('<div data-preview-fragment'), tags = /<\/?div\b[^>]*>/g; tags.lastIndex = start;
    if (start < 0) throw new Error('Actual SSR preview fragment missing');
    let depth = 0;
    for (let match; (match = tags.exec(html));) { depth += match[0].startsWith('</') ? -1 : 1; if (!depth) return '<main data-app-main>' + html.slice(start, tags.lastIndex) + '</main>'; }
    throw new Error('Unclosed actual SSR preview fragment');
  };
  const all = new URLSearchParams(base); for (let i = 0; i < summary.receipt.items.length; i++) all.set('c' + i, 'Daily / Gifts');
  const individual = new URLSearchParams(all); individual.set('c0', 'Daily / Groceries');
  const explicit = new URLSearchParams(base); explicit.set('c0', 'Daily / Gifts');
  const discount = new URLSearchParams(base); Object.entries({ nd0: 'Coupon', na0: '-1.50', nc0: 'Daily / Groceries', nt0: '*' }).forEach(([key, value]) => discount.set(key, value));
  const discountAll = new URLSearchParams(discount); for (let i = 0; i < summary.receipt.items.length; i++) discountAll.set('c' + i, 'Daily / Gifts'); discountAll.set('nc0', 'Daily / Gifts');
  const uncategorized = new URLSearchParams(base); for (let i = 0; i < summary.receipt.items.length; i++) uncategorized.set('c' + i, 'Uncategorized');
  const previews = Object.fromEntries(Object.entries({ base, all, individual, explicit, discount, discountAll, uncategorized }).map(([name, query]) => [name, previewMain(render(query))]));
  const selectedSummary = structuredClone(summary);
  selectedSummary.transaction = { id: 'selected-charge', account: 'Checking', date: '2026-11-08', payee: 'Riverside Market', amount: '32.15', currentCategory: 'Daily / Household supplies' };
  selectedSummary.selection = { at: '2026-11-10T12:00:00Z', keep: false };
  selectedSummary.receipt.payment_method = 'card';
  const selectedPage = (query) => receiptPage({ ...fixture.view(), entry, summary: selectedSummary, fix: editorFor({ id: fixture.id, entry, summary: selectedSummary, query }), resolution }, 'fixture-key', 'Charge selected. Nothing changed in Actual.', nav);
  const selectedQuery = new URLSearchParams(base); for (let i = 0; i < summary.receipt.items.length; i++) selectedQuery.set('c' + i, i === 0 ? 'Daily / Gifts' : 'Daily / Household supplies');
  const selected = selectedPage(new URLSearchParams()).match(/<main\b[^]*?<\/main>/)[0].replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="');
  const data = JSON.stringify({ previews, itemCount: summary.receipt.items.length, selected, selectedPreview: previewMain(selectedPage(selectedQuery)), settings: fixture.renderAllSettings().match(/<main\b[^]*?<\/main>/)[0], receipt: render(new URLSearchParams({ acct: 'Checking' })).match(/<main\b[^]*?<\/main>/)[0], total: '32.15' }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  const html = render(new URLSearchParams({ acct: 'Checking' })).replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="')
    .replace('<script>', `<script>(${network.toString()})(${data});</script><script>`)
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${(single ? singleItemChecks : checks).toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
} finally { fixture.cleanup(); }

function network(data) {
  // The page stands in for a receipt address, so Settings' Done (P9) has a real receipt to go back to.
  history.replaceState(null, '', 'receipt?key=fixture-key&id=fixture');
  let linked = false;
  window.__bulkChecks = { requests: [], passed: [], failures: [], alerts: [], total: data.total };
  window.alert = (message) => window.__bulkChecks.alerts.push(String(message)); window.confirm = () => true;
  const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), pending = new Set(); let nextTimer = -1;
  window.setTimeout = (fn, ms, ...args) => { if (ms !== 450) return nativeTimeout(fn, ms, ...args); const id = nextTimer--; pending.add(id); queueMicrotask(() => { if (pending.delete(id)) fn(...args); }); return id; };
  window.clearTimeout = (id) => { if (id < 0) pending.delete(id); else nativeClear(id); };
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), method = options.method || 'GET';
    if (url.origin !== location.origin) throw new Error('External network forbidden');
    window.__bulkChecks.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    let html;
    if (method === 'POST' && url.pathname.endsWith('/receipt-resolve')) { linked = true; html = data.selected; }
    else if (method !== 'GET') throw new Error('Bulk category edits must never write');
    else if (url.pathname.endsWith('/settings')) html = data.settings;
    else if (linked && url.pathname.endsWith('/receipt')) html = data.selectedPreview;
    else if (url.pathname.endsWith('/receipt') && url.searchParams.get('preview') !== '1') html = data.receipt;
    else if (url.pathname.endsWith('/receipt') && url.searchParams.get('preview') === '1') {
      const query = url.searchParams, all = Array.from({ length: data.itemCount }, (_, i) => query.get('c' + i));
      const name = query.get('nd0') === 'Coupon' ? query.get('nc0') === 'Daily / Gifts' ? 'discountAll' : 'discount'
        : all.every((category) => category === 'Uncategorized') ? 'uncategorized'
        : all.every((category) => category === 'Daily / Gifts') ? 'all'
        : all[0] === 'Daily / Groceries' && all[1] === 'Daily / Gifts' ? 'individual'
        : all[0] === 'Daily / Gifts' ? 'explicit' : 'base';
      html = data.previews[name];
    }
    if (!html) throw new Error('Unexpected synthetic request: ' + url.pathname);
    return { ok: true, status: 200, url: url.href, headers: { get: () => null }, text: async () => html };
  };
}

function singleItemChecks() {
  const result = window.__bulkChecks, q = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const change = (selector, value, event = 'input') => { const control = q(selector); control.value = value; control.dispatchEvent(new Event(event, { bubbles: true })); };
  const visible = () => q('[data-bulk-category]')?.getBoundingClientRect().height >= 44;
  const run = async (name, action) => { try { await action(); result.passed.push(name); console.log('PASS: ' + name); } catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); } };
  (async () => {
    await run('One item starts without a visible bulk category control', async () => { assert(!visible(), 'Lone-item bulk control should start hidden'); });
    await run('Populating an added discount reveals bulk editing without reloading the receipt', async () => {
      q('[data-added-lines]').closest('details').open = true;
      change('[name=nd0]', 'Coupon'); change('[name=na0]', '-1.50'); change('[name=nc0]', 'Daily / Groceries', 'change'); await flush();
      assert(visible(), 'Bulk control stayed absent/hidden after a populated added line');
      const before = result.requests.length; change('[data-bulk-category]', 'Daily / Gifts', 'change'); await flush();
      assert(q('[name=c0]').value === 'Daily / Gifts' && q('[name=nc0]').value === 'Daily / Gifts', 'Bulk skipped the item or discount');
      assert(result.requests.length === before + 1 && result.requests.every((request) => request.method === 'GET'), 'Single-item bulk did not remain preview-only');
    });
    await run('Clearing both added-line fields hides bulk editing without reverting the item category', async () => {
      change('[name=nd0]', ''); change('[name=na0]', ''); await flush();
      assert(!visible() && q('[name=c0]').value === 'Daily / Gifts', 'Empty added line left bulk visible or undid the individual category');
    });
    await run('Discarding the discount restores the item while bulk editing stays hidden', async () => {
      q('[data-editor-discard]').click(); await flush();
      assert(q('[name=nd0]').value === '' && !visible() && q('[name=c0]').value === 'Daily / Groceries', 'Single-item Discard failed to restore the baseline');
    });
    console.log('BULK_SINGLE_BROWSER_RESULT ' + JSON.stringify({ passed: result.passed.length, failed: result.failures.length, completed: true, failures: result.failures }));
  })();
}

function checks() {
  const result = window.__bulkChecks, q = (selector) => document.querySelector(selector), all = (selector) => [...document.querySelectorAll(selector)];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const contrast = (foreground, background) => {
    const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const change = (selector, value, event = 'input') => { const control = q(selector); assert(control, 'Missing ' + selector); control.value = value; control.dispatchEvent(new Event(event, { bubbles: true })); return control; };
  const run = async (name, action) => { try { await action(); result.passed.push(name); console.log('PASS: ' + name); } catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); } };
  const stableFields = () => Object.fromEntries([...new FormData(q('[data-preview-form]'))].filter(([key]) => /^(a\d+|na\d+|nd\d+|nt\d+|acct)$/.test(key)));
  const signedTotal = () => {
    const form = q('[data-app-main] [data-cash-preview] form'); assert(form?.elements.namedItem('token').value && form.elements.namedItem('state').value, 'Real server preview lacks state/token');
    const cents = all('[data-preview-split] .split-parts strong').reduce((sum, node) => sum + Math.round(Number(node.textContent.replace(/[^0-9.-]/g, '')) * 100), 0);
    assert(cents === 3215, 'Category preview changed the exact purchase total: ' + cents);
    assert(form.elements.namedItem('acct').value === 'Checking', 'Signed preview changed the account');
  };
  (async () => {
    const original = all('[data-preview-form] select[name^=c]').map((select) => select.value);
    await run('Bulk category has a visible label, full grouped options and a readable touch control', async () => {
      const bulk = q('[data-bulk-category]'); assert(bulk && bulk.form === q('[data-preview-form]') && !bulk.name, 'Bulk control is missing, outside editor or submits its own name');
      assert([...bulk.labels].some((label) => label.textContent.trim() === 'Set all items'), 'Bulk label missing');
      assert(bulk.options[0].value === '' && bulk.options[0].textContent.trim() === 'Set all items…', 'Bulk placeholder missing');
      assert([...bulk.options].filter((option) => option.value).map((option) => option.value).join('|') === [...q('[name=c0]').options].map((option) => option.value).join('|'), 'Bulk dropped an available category');
      assert(bulk.querySelector('optgroup') && bulk.getBoundingClientRect().height >= 44, 'Grouped readable control missing');
      assert([...bulk.options].every((option) => { const style = getComputedStyle(option); return contrast(style.color, style.backgroundColor) >= 4.5; }), 'Native category option colors have insufficient contrast');
      assert(innerWidth >= 980 || parseFloat(getComputedStyle(bulk).fontSize) >= 16, 'Mobile category font is smaller than16px');
      assert(document.documentElement.scrollWidth <= innerWidth, 'Bulk control caused horizontal overflow');
    });
    await run('Set all changes every item and blank added-row default with one signed preview and no write', async () => {
      const before = result.requests.length, fields = stableFields(); change('[data-bulk-category]', 'Daily / Gifts', 'change'); await flush();
      assert(all('[data-preview-form] select[name^=c],[data-preview-form] select[name^=nc]').every((select) => select.value === 'Daily / Gifts'), 'Not every item and blank added-row default changed');
      assert(q('[data-bulk-category]').value === 'Daily / Gifts', 'Bulk selector did not retain the common category for native keyboard navigation');
      assert(JSON.stringify(fields) === JSON.stringify(stableFields()), 'Bulk modified amounts, descriptions, tax or account');
      assert(result.requests.length === before + 1 && result.requests.at(-1).method === 'GET', 'Bulk did not issue exactly one preview');
      assert(!q('[data-draft-for]').hidden && !q('[data-editor-discard]').hidden, 'Bulk category edits were not remembered as a draft'); signedTotal();
    });
    await run('Sequential category selections retain the same focused native bulk control', async () => {
      const bulk = q('[data-bulk-category]'); bulk.focus();
      change('[data-bulk-category]', 'Uncategorized', 'change'); await flush();
      assert(document.activeElement === bulk && bulk.value === 'Uncategorized', 'First native category selection lost focus or reset');
      change('[data-bulk-category]', 'Daily / Gifts', 'change'); await flush();
      assert(document.activeElement === bulk && bulk.value === 'Daily / Gifts', 'Following native category selection lost focus or reset'); signedTotal();
    });
    await run('An individual category remains editable after setting all categories', async () => {
      change('[data-preview-form] [name=c0]', 'Daily / Groceries', 'change'); await flush();
      assert(q('[name=c0]').value === 'Daily / Groceries' && q('[name=c1]').value === 'Daily / Gifts', 'Individual edit changed other rows'); signedTotal();
      assert(q('[data-bulk-category]').value === '', 'Mixed individual categories did not restore the bulk placeholder');
      q('[data-editor-discard]').click(); await flush();
      assert(all('[data-preview-form] select[name^=c]').map((select) => select.value).join('|') === original.join('|') && q('[data-draft-for]').hidden, 'Discard did not restore the original individual categories');
    });
    await run('Populated discounts join bulk changes while preserving their amount, tax and description', async () => {
      q('[data-added-lines]').closest('details').open = true;
      change('[name=nd0]', 'Coupon'); change('[name=na0]', '-1.50'); change('[name=nc0]', 'Daily / Groceries', 'change'); change('[name=nt0]', '*', 'change'); await flush();
      const before = result.requests.length, fields = stableFields(); change('[data-bulk-category]', 'Daily / Gifts', 'change'); await flush();
      assert(q('[name=nc0]').value === 'Daily / Gifts', 'Discount category was skipped');
      assert(JSON.stringify(fields) === JSON.stringify(stableFields()), 'Discount contents or account changed');
      assert(result.requests.length === before + 1, 'Discount bulk edit fetched more than one preview'); signedTotal();
      q('[data-editor-add]').click(); assert(q('[name=nc1]').value === 'Daily / Gifts' && q('[name=na1]').value === '', 'New added row did not follow the previous category');
    });
    await run('Discard reverses bulk and added-line changes, and Uncategorized remains an explicit option', async () => {
      q('[data-editor-discard]').click(); await flush();
      assert(q('[name=nd0]').value === '' && q('[name=na0]').value === '' && all('[data-added-lines] tbody tr').length === 1, 'Discard retained discount or extra row');
      assert(all('[data-preview-form] select[name^=c]').map((select) => select.value).join('|') === original.join('|'), 'Discard retained bulk categories');
      change('[data-bulk-category]', 'Uncategorized', 'change'); await flush();
      assert(all('[data-preview-form] select[name^=c],[data-preview-form] select[name^=nc]').every((select) => select.value === 'Uncategorized'), 'Uncategorized was not applied explicitly');
      assert(!q('[data-app-main] [data-cash-preview] form'), 'Entirely uncategorized receipt unexpectedly offered creation');
      q('[data-editor-discard]').click(); await flush();
    });
    await run('All 54 settings remain editable and bulk changes never write', async () => {
      // P9: Settings are pages; the harness serves every section page's content at once to check the inventory.
      q('.app-header a[href^="settings"]').click(); await flush();
      assert(!q('#workspace-dialog').open && all('#settings-page [data-setting]').length === 54, 'Settings inventory changed');
      assert(all('#settings-page [data-setting]').every((row) => document.getElementById('s-' + row.dataset.setting)?.name === row.dataset.setting), 'A retained setting lost its control');
      assert(result.requests.every((request) => request.method === 'GET') && !result.alerts.length, 'Bulk operation wrote or raised a page error');
      assert(document.documentElement.scrollWidth <= innerWidth, 'Settings overflowed');
    });
    await run('Choosing a charge keeps the explicit item edit and uses Actual’s category for untouched rows', async () => {
      q('[data-settings-done]').click(); await flush(); await flush();
      change('[data-preview-form] [name=c0]', 'Daily / Gifts', 'change'); await flush();
      const form = all('form[action^="receipt-resolve"]').find((candidate) => candidate.elements.namedItem('action')?.value === 'select');
      const old = q('[data-preview-form]'); form.requestSubmit(form.querySelector('button')); await flush();
      assert(!old.isConnected && q('[data-preview-form]').dataset.kind === 'review', 'Selected charge did not load its actual review editor');
      const categories = all('[data-preview-form] select[name^=c]').map((select) => select.value);
      assert(categories[0] === 'Daily / Gifts' && categories.slice(1).every((category) => category === 'Daily / Household supplies'), 'Untouched old categories overwrote the selected Actual category, or an explicit edit was lost');
      assert(!q('[data-draft-for]').hidden && q('[data-commit] [name=c0]').value === 'Daily / Gifts' && q('[data-commit] [name=c1]').value === 'Daily / Household supplies', 'Rebased draft did not get its own guarded preview');
      assert(result.requests.filter((request) => request.method === 'POST').every((request) => request.path.endsWith('/receipt-resolve')), 'A category edit wrote to Actual');
    });
    console.log('BULK_CATEGORY_BROWSER_RESULT ' + JSON.stringify({ passed: result.passed.length, failed: result.failures.length, completed: true, failures: result.failures, actualWriteRequests: result.requests.filter((request) => request.method !== 'GET' && !request.path.endsWith('/receipt-resolve')).length }));
  })();
}
