// Real-DOM amount-format regressions with actual editorFor/receiptPage SSR.
// node --env-file=worker/test.env worker/test/workspace-astra-amount-browser-checks.mjs
// --old-save-behavior changes only generated HTML to restore exact-string draft
// comparison and remove successful-save draft reconciliation. Together these
// reproduce the old stale-draft bug. Production source is never modified.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { cleanNav, receiptNav } from '../src/panel-status.js';

const fixture = await workspaceFixtures();
try {
  const old = process.argv.includes('--old-save-behavior');
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `/tmp/receipt-workspace-astra-amount${old ? '-old' : ''}.html`;
  const nav = receiptNav(fixture.recent, fixture.id, cleanNav(new URLSearchParams()));
  const baseQuery = (amount) => {
    const query = new URLSearchParams({ preview: '1', rid: '' });
    fixture.summary.receipt.items.forEach((item, i) => { query.set('c' + i, item.category); query.set('a' + i, i === 0 ? amount : item.amount.toFixed(2)); });
    return query;
  };
  const page = (saved, asked = null) => {
    const summary = structuredClone(fixture.summary), entry = structuredClone(fixture.entry);
    if (saved !== 'initial') {
      summary.pageFix = { amounts: { 0: Number(saved) }, items: {}, added: [] };
      // pageFix.amounts stores dollars as numbers. Its editor renders canonical cents.
      summary.plan.parts = fixture.view(baseQuery(saved)).fix.preview.parts;
      entry.result = 'split'; entry.reviewed = true; entry.fixedOnPage = { at: '2026-11-10T12:00:00Z', wrote: { children: summary.plan.parts.map((part) => ({ category: part.category, amount: -Math.round(Number(part.amount) * 100) })) } };
    }
    const query = asked == null ? new URLSearchParams() : baseQuery(asked);
    const fix = editorFor({ id: fixture.id, entry, summary, query });
    if (!fix.ok || (asked != null && !fix.preview)) throw new Error('Invalid synthetic amount fixture');
    return receiptPage({ ...fixture.view(), entry, summary, fix }, 'fixture-key', saved === 'initial' ? '' : 'Saved to Actual. Still in Filed.', nav);
  };
  const main = (html) => html.match(/<main\b[^]*?<\/main>/)[0].replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="');
  const previewMain = (html) => {
    const start = html.indexOf('<div data-preview-fragment');
    if (start < 0) throw new Error('Actual SSR preview fragment missing');
    const tags = /<\/?div\b[^>]*>/g; tags.lastIndex = start;
    let depth = 0;
    for (let tag; (tag = tags.exec(html));) {
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (!depth) return '<main data-app-main>' + html.slice(start, tags.lastIndex) + '</main>';
    }
    throw new Error('Unclosed actual SSR preview fragment');
  };
  const saved = Object.fromEntries(['5', '0.5', '7', '8'].map((amount) => [amount, main(page(amount))]));
  const edges = [['initial', '5'], ['5', '0.5'], ['0.5', '5'], ['5', '7'], ['7', '7'], ['7', '8'], ['7', '9'], ['8', '9'], ['8', '8'], ['8', '5'], ['5', '8'], ['5', '5']];
  const previews = Object.fromEntries(edges.map(([state, amount]) => [state + ':' + amount, previewMain(page(state, amount))]));
  const metadataValues = { merchant: 'Riverside Market', date: '2026-11-08', total: '10.80', payment_method: 'card' };
  const metadata = main(receiptPage({ ...fixture.view(), fix: { ok: false, reason: 'Find the charge.' }, resolution: { values: metadataValues, original: metadataValues, candidates: [] } }, 'fixture-key', '', nav));
  const data = JSON.stringify({ saved, previews, metadata }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  let html = page('initial').replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="');
  if (old) {
    const from = html.indexOf('  function signature(value) {'), to = html.indexOf('\n  function message(', from);
    if (from < 0 || to < 0) throw new Error('Signature helper not found');
    html = html.slice(0, from) + '  function signature(value) { return JSON.stringify(Object.keys(value).sort().map(function (k) { return [k, value[k]]; })); }' + html.slice(to);
    const clear = '&& submittedDraft && currentDraft && signature(currentDraft.value)';
    if (!html.includes(clear)) throw new Error('Successful-save reconciliation not found');
    html = html.split('\n').filter((line) => !line.includes(clear)).join('\n');
  }
  html = html.replace('<script>', `<script>(${network.toString()})(${data});</script><script>`)
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
} finally { fixture.cleanup(); }

function network(data) {
  let saved = 'initial';
  window.__astraAmount = { requests: [], passed: [], failures: [], alerts: [] };
  window.alert = (text) => window.__astraAmount.alerts.push(String(text)); window.confirm = () => true;
  const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), pending = new Set(); let nextTimer = -1;
  window.setTimeout = (fn, ms, ...args) => { if (ms !== 450) return nativeTimeout(fn, ms, ...args); const id = nextTimer--; pending.add(id); queueMicrotask(() => { if (pending.delete(id)) fn(...args); }); return id; };
  window.clearTimeout = (id) => { if (id < 0) pending.delete(id); else nativeClear(id); };
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), method = options.method || 'GET', body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null;
    if (url.origin !== location.origin) throw new Error('External network forbidden');
    window.__astraAmount.requests.push({ method, path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
    let html, resultUrl = url;
    if (method === 'GET' && url.pathname.endsWith('/receipt') && url.searchParams.get('preview') === '1') html = data.previews[saved + ':' + String(Number(url.searchParams.get('a0')))];
    else if (method === 'POST' && url.pathname.endsWith('/receipt-fix')) {
      if (window.__holdAmountPost) await new Promise((resolve) => { window.__releaseAmountPost = resolve; });
      saved = String(Number(body.a0)); html = data.saved[saved];
      resultUrl = new URL('receipt?key=fixture-key&id=' + encodeURIComponent(body.id), location.href);
    } else if (method === 'GET' && url.pathname.endsWith('/')) html = data.metadata;
    if (!html) throw new Error('Unexpected synthetic request: ' + method + ' ' + url.pathname + ' saved=' + saved + ' amount=' + url.searchParams.get('a0'));
    return { ok: true, status: 200, url: resultUrl.href, headers: { get: () => null }, text: async () => html };
  };
}

function checks() {
  const result = window.__astraAmount, q = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const until = async (condition, message) => { for (let i = 0; i < 100; i++) { if (condition()) return; await Promise.resolve(); } throw new Error(message); };
  const change = (selector, value) => { const control = q(selector); control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })); return control; };
  const run = async (name, action) => { try { await action(); result.passed.push(name); console.log('PASS: ' + name); } catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); } };
  const clean = () => {
    assert(q('[data-draft-for]').hidden && q('[data-editor-discard]').hidden && q('[data-item="0"] [data-item-hint]').hidden, 'Canonical server amount left draft/revert/discard indicators');
    assert(!q('[data-workspace-status]').textContent.includes("edits aren't saved"), 'Canonical server amount left unsaved status');
    assert(q('.editor-actions').hidden && q('[data-editor-save]').disabled, 'Clean saved receipt left an inert Save action');
  };
  const saveAmount = async (raw, canonical) => {
    const old = change('[data-preview-form] [name=a0]', raw); await flush();
    await until(() => q('[data-commit] [name=a0]')?.value === canonical && !q('[data-editor-save]').disabled, 'Signed amount preview missing for ' + raw);
    q('[data-editor-save]').click(); await until(() => !old.isConnected, 'Save response did not render'); await flush();
    assert(q('[data-preview-form] [name=a0]').value === canonical, 'Saved editor did not use canonical ' + canonical); clean();
  };
  (async () => {
    await run('Saving 5 returns clean canonical 5.00', () => saveAmount('5', '5.00'));
    await run('Saving .50 returns clean canonical 0.50', () => saveAmount('.50', '0.50'));
    await run('Saving +5 returns clean canonical 5.00', () => saveAmount('+5', '5.00'));
    await run('Saving whitespace-wrapped amount returns clean canonical 7.00', () => saveAmount(' 7 ', '7.00'));
    await run('Changing only amount formatting never marks the saved item unsaved', async () => { change('[data-preview-form] [name=a0]', '+7.00'); await flush(); clean(); });
    await run('A genuinely newer edit during a held Save remains unsaved after the response', async () => {
      change('[data-preview-form] [name=a0]', '8'); await flush();
      window.__holdAmountPost = true; q('[data-editor-save]').click(); await until(() => window.__releaseAmountPost, 'Save POST not held');
      const old = change('[data-preview-form] [name=a0]', '9'); await flush();
      window.__releaseAmountPost(); window.__holdAmountPost = false; await until(() => !old.isConnected, 'Held save did not render'); await flush();
      assert(q('[data-preview-form] [name=a0]').value === '9', 'Newer amount was discarded by the earlier Save');
      assert(!q('[data-draft-for]').hidden && !q('[data-editor-discard]').hidden, 'Newer edit was incorrectly treated as saved');
      assert(q('[data-commit] [name=a0]').value === '9.00', 'Newer edit did not get a fresh signed preview');
    });
    await run('Returning to the old baseline during a pending Save remains dirty against the newly saved amount', async () => {
      q('[data-editor-discard]').click(); await flush(); clean();
      change('[data-preview-form] [name=a0]', '5'); await flush();
      window.__holdAmountPost = true; window.__releaseAmountPost = null; q('[data-editor-save]').click(); await until(() => window.__releaseAmountPost, 'Second Save POST not held');
      const old = change('[data-preview-form] [name=a0]', '8'); await flush();
      window.__releaseAmountPost(); window.__holdAmountPost = false; await until(() => !old.isConnected, 'Second held save did not render'); await flush();
      assert(q('[data-preview-form] [name=a0]').value === '8', 'Returning to the previous baseline lost the newer edit');
      assert(!q('[data-draft-for]').hidden && !q('[data-editor-discard]').hidden, 'Old baseline was incorrectly clean against saved 5.00');
      assert(q('[data-commit] [name=a0]').value === '8.00', 'Old baseline did not get its own fresh preview');
    });
    await run('Invalid raw amounts remain invalid and make no preview or write request', async () => {
      const before = result.requests.length; const input = change('[data-preview-form] [name=a0]', '5.000'); await flush();
      assert(input.getAttribute('aria-invalid') === 'true' && q('[data-editor-save]').disabled, 'Three decimal places were normalized into a valid amount');
      assert(result.requests.length === before, 'Invalid amount sent a request');
      q('[data-editor-discard]').click(); await flush(); clean();
    });
    await run('Equivalent metadata total 10.8 and trimmed merchant do not create a correction draft', async () => {
      q('.workspace-back').click(); await until(() => q('[data-resolution-form]'), 'Metadata fixture did not open');
      change('[data-resolution-form] [name=receipt-total]', '10.8'); change('[data-resolution-form] [name=receipt-merchant]', ' Riverside Market ');
      assert(q('[data-draft-for]').hidden, 'Equivalent 10.80 metadata left a draft marker');
    });
    assert(result.alerts.length === 0, 'Unexpected alert: ' + result.alerts.join('; '));
    console.log('ASTRA_AMOUNT_BROWSER_RESULT ' + JSON.stringify({ passed: result.passed.length, failed: result.failures.length, completed: true, failures: result.failures }));
  })();
}
