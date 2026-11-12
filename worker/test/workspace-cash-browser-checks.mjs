// Real DOM checks of the shipped cash workflow with fictional SSR and a mocked network boundary.
// Build: node --env-file=worker/test.env worker/test/workspace-cash-browser-checks.mjs
// Check the printed page with html_preview at phone and desktop widths. No services are contacted.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';
import { config } from '../src/config.js';
import { rememberAccounts } from '../src/known-accounts.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { settingsPage } from '../src/panel-settings-page.js';
import { receiptNav, cleanNav } from '../src/panel-status.js';

const f = await workspaceFixtures();
const target = process.argv[2] || '/tmp/receipt-workspace-cash-browser-checks.html';
try {
  await rememberAccounts(['Cash wallet', 'Checking', 'Travel cash'].map((name) => ({ name })));
  const id = f.id, entry = { ...f.entry, result: 'review', applied: undefined };
  const summary = structuredClone(f.summary);
  delete summary.transaction;
  summary.receipt.payment_method = 'cash';
  summary.plan = { applied: false, action: 'review', parts: [] };
  const resolution = { values: { merchant: 'Riverside Market', date: '2026-11-08', total: '32.15', payment_method: 'cash' } };
  const nav = receiptNav([entry, ...f.recent.slice(1)], id, cleanNav(new URLSearchParams()));
  const render = (query = new URLSearchParams()) => {
    const accountName = query.get('acct') || config.cashAccount;
    const cashLook = { account: { id: `account-${accountName}`, name: accountName }, payee: { id: 'payee-riverside', name: 'Riverside Market', isNew: false }, duplicates: accountName === 'Checking' ? [{ id: 'existing-cash-purchase', date: '2026-11-08', amount: -3215, payeeName: 'Riverside Market', category: 'Daily / Groceries', snapshot: { cleared: true } }] : [] };
    return receiptPage({ id, entry, summary, name: 'riverside.jpg', pages: 1, pdf: false, resolution, fix: editorFor({ id, entry, summary, query, cashLook }), seen: null }, 'fixture-key', '', nav);
  };
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII=';
  const images = (html) => html.replace(/src="receipt-photo[^"]*"/g, `src="${photo}"`);
  const main = (html) => images(html.match(/<main\b[^]*?<\/main>/)[0]);
  const previews = {};
  for (const account of ['Cash wallet', 'Checking', 'Travel cash']) for (const category of ['Daily / Groceries', 'Daily / Gifts']) {
    const query = new URLSearchParams({ preview: '1', rid: '', acct: account });
    summary.receipt.items.forEach((item, i) => { query.set(`c${i}`, i === 0 ? category : item.category); query.set(`a${i}`, item.amount.toFixed(2)); });
    previews[`${account}|${category}`] = main(render(query));
  }
  const settings = {};
  const settingsData = JSON.parse(JSON.stringify(f.settingsData));
  for (const section of settingsData.sections) for (const setting of section.settings) if (setting.type === 'account') setting.choices = ['Cash wallet', 'Checking', 'Travel cash'];
  for (const account of ['Cash wallet', 'Checking', 'Travel cash']) {
    const data = structuredClone(settingsData);
    for (const section of data.sections) for (const setting of section.settings) if (setting.key === 'CASH_ACCOUNT') { setting.value = account; setting.source = 'page'; }
    settings[account] = main(settingsPage(data, 'fixture-key', 'Saved. It applies at the start of the next check.', undefined, { section: 'everyday' }));
  }
  // P9: Settings are pages. The header link opens the overview; Everyday holds the cash account. Coming back (Done), the server renders
  // the receipt with the current "Cash purchases go to" default.
  const overview = main(settingsPage(settingsData, 'fixture-key', ''));
  const initials = {};
  const savedDefault = config.cashAccount;
  for (const account of ['Cash wallet', 'Checking', 'Travel cash']) { config.cashAccount = account; initials[account] = main(render()); }
  config.cashAccount = savedDefault;
  // Lossless prefix/suffix packing keeps the inline renderer below its 512 KB limit.
  const pack = (values) => {
    const base = Object.values(values)[0];
    return Object.fromEntries(Object.entries(values).map(([key, value], i) => {
      if (!i) return [key, value];
      let a = 0, z = 0;
      while (a < base.length && a < value.length && base[a] === value[a]) a++;
      while (z < base.length - a && z < value.length - a && base[base.length - 1 - z] === value[value.length - 1 - z]) z++;
      return [key, [a, z, value.slice(a, value.length - z)]];
    }));
  };
  const fixture = JSON.stringify({ id, initials: pack(initials), overview, previews: pack(previews), settings: pack(settings) }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  function network(fixture) {
    // The page stands in for the receipt's address, so Settings' Done (P9) has a real receipt to go back to.
    history.replaceState(null, '', 'receipt?key=fixture-key&id=' + encodeURIComponent(fixture.id));
    for (const values of [fixture.previews, fixture.settings, fixture.initials]) {
      const base = Object.values(values)[0];
      for (const key of Object.keys(values)) if (Array.isArray(values[key])) { const [a, z, middle] = values[key]; values[key] = base.slice(0, a) + middle + (z ? base.slice(-z) : ''); }
    }
    const originalTimeout = window.setTimeout.bind(window), originalClear = window.clearTimeout.bind(window), pending = new Set();
    let timer = -1, defaultAccount = 'Cash wallet';
    const result = window.__cashChecks = { requests: [], cases: [], failures: [], confirms: [], alerts: [], completed: false, hold: false, releases: [] };
    window.setTimeout = function (fn, ms, ...args) { if (ms !== 450) return originalTimeout(fn, ms, ...args); const id = timer--; pending.add(id); queueMicrotask(() => { if (pending.delete(id)) fn(...args); }); return id; };
    window.clearTimeout = function (id) { if (id < 0) pending.delete(id); else originalClear(id); };
    window.alert = (text) => result.alerts.push(String(text));
    window.confirm = (text) => { result.confirms.push(String(text)); return true; };
    window.fetch = async function (input, options = {}) {
      const url = new URL(String(input), location.href), method = options.method || 'GET';
      if (url.origin !== location.origin) throw new Error('External network forbidden');
      const body = options.body ? new URLSearchParams(options.body) : null;
      result.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? Object.fromEntries(body) : null });
      let html, returned = url;
      if (url.pathname.endsWith('/settings-save') && method === 'POST') {
        defaultAccount = body.get('CASH_ACCOUNT'); html = fixture.settings[defaultAccount]; returned = new URL('settings?key=fixture-key&section=everyday', location.href);
      } else if (url.pathname.endsWith('/settings')) html = url.searchParams.get('section') === 'everyday' ? fixture.settings[defaultAccount] : fixture.overview;
      else if (url.pathname.endsWith('/receipt') && url.searchParams.get('preview') === '1') {
        if (result.hold) await new Promise((resolve) => result.releases.push(resolve));
        html = fixture.previews[(url.searchParams.get('acct') || defaultAccount) + '|' + url.searchParams.get('c0')];
      } else if (url.pathname.endsWith('/receipt')) html = fixture.initials[defaultAccount];
      else throw new Error('Unexpected request: ' + method + ' ' + url.pathname);
      if (!html) throw new Error('Missing fictional response: ' + url.search);
      return { ok: true, status: 200, url: returned.href, headers: { get: () => null }, text: async () => html };
    };
  }
  function checks() {
    const result = window.__cashChecks, q = (s) => document.querySelector(s), tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const assert = (ok, label) => { if (!ok) throw new Error(label); };
    const until = async (condition, label) => { for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); } throw new Error(label); };
    const click = (s) => { const el = q(s); assert(el, 'Missing ' + s); el.click(); return el; };
    const change = (s, value, type = 'input') => { const el = q(s); assert(el, 'Missing ' + s); el.value = value; el.dispatchEvent(new Event(type, { bubbles: true })); return el; };
    const run = async (name, fn) => { try { await fn(); result.cases.push(name); console.log('PASS: ' + name); } catch (error) { result.failures.push({ name, error: error.message }); console.error('FAIL: ' + name + ': ' + error.message); } };
    const previewAccount = () => q('main [data-cash-preview] [name=acct]')?.value;
    const cashPosts = () => result.requests.filter((r) => r.method === 'POST' && !r.path.endsWith('/settings-save'));
    // P9: Settings are pages: overview, Everyday, save (back on Everyday), then Done back to the receipt with its drafts.
    async function settingsAccount(account) {
      click('.app-header a[href^="settings"]'); await until(() => q('#settings-page .settings-cards'), 'Settings did not open');
      assert(!q('#workspace-dialog').open, 'Settings opened in a dialog');
      click('.settings-link[href*="section=everyday"]'); await until(() => q('#s-CASH_ACCOUNT'), 'Everyday did not open');
      change('#s-CASH_ACCOUNT', account, 'change');
      const oldPage = q('#settings-page'), form = q('#s-CASH_ACCOUNT').form; form.requestSubmit(form.querySelector('.settings-save button'));
      await until(() => q('#settings-page') !== oldPage && q('[data-app-main] > .notice') && q('#s-CASH_ACCOUNT')?.value === account, 'Settings not saved');
      click('[data-settings-done]'); await until(() => q('[data-preview-form]')?.dataset.kind === 'cash', 'Done did not go back to the receipt');
    }
    (async () => {
      await run('Cash editor initializes without writing or horizontal overflow', async () => {
        assert(document.documentElement.classList.contains('workspace-ready'), 'Workspace not initialized');
        assert(q('[data-preview-form]').dataset.kind === 'cash' && q('#acct').value === 'Cash wallet', 'Initial cash default');
        assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal overflow');
        assert(cashPosts().length === 0, 'Unexpected write');
      });
      await run('Metadata-only draft protects destructive actions and survives cancellation', async () => {
        q('#receipt-resolution').open = true;
        change('[name=receipt-merchant]', 'Corrected Riverside');
        q('.receipt-more').open = true;
        const archive = [...document.querySelectorAll('.receipt-more form')].find((form) => new URL(form.action).pathname.endsWith('/archive'));
        assert(archive, 'Missing archive path'); archive.requestSubmit(archive.querySelector('button'));
        await until(() => q('#workspace-dialog').open, 'Metadata-only action did not ask first');
        assert(q('#workspace-dialog-body').textContent.includes('discards the unsaved edits'), 'Wrong destructive explanation');
        assert(cashPosts().length === 0, 'Destructive request sent before confirmation');
        click('[data-dialog-close]');
        assert(q('[name=receipt-merchant]').value === 'Corrected Riverside', 'Cancel lost metadata draft');
        change('[name=receipt-merchant]', 'Riverside Market');
      });
      await run('Pending cash follows a changed Settings default until an account is chosen', async () => {
        await settingsAccount('Checking');
        assert(q('#acct').value === 'Checking', 'Pending cash ignored Settings');
      });
      await run('Create always refreshes a guarded preview and opens duplicate-safe confirmation', async () => {
        const before = result.requests.filter((r) => r.query.preview === '1').length;
        // P8: the confirmation is the preview's own forms, shown in place; nothing is copied into a dialog.
        click('[data-editor-save]'); await until(() => q('main [data-cash-preview][data-confirming]'), 'Cash confirmation missing');
        assert(!q('#workspace-dialog').open, 'Cash confirmation opened a dialog');
        const form = q('main [data-cash-preview] input[name=action][value=split]')?.form;
        assert(form && getComputedStyle(form).display !== 'none', 'The existing-purchase choice is not shown');
        assert(form && form.querySelector('[name=dup]').value === 'existing-cash-purchase', 'Existing purchase choice missing');
        assert(form.querySelector('[name=token]').value && form.querySelector('[name=state]').value, 'Guard fields absent');
        assert(form.querySelector('[name=acct]').value === 'Checking', 'Confirmation wrong account');
        assert(document.activeElement === form.querySelector('button'), 'Safe existing purchase is not initial focus');
        assert(result.requests.filter((r) => r.query.preview === '1').length > before, 'Create reused cached lookup');
        assert(result.requests.some((r) => r.query.preview === '1' && r.query.acct === 'Checking'), 'Preview used wrong account');
        assert(cashPosts().length === 0, 'Create wrote before confirmation');
        click('main [data-cash-cancel]');
      });
      await run('Cancelling cash confirmation leaves every inline create form hidden', async () => {
        assert(!q('main [data-cash-preview][data-confirming]'), 'Choices are still shown');
        const forms = [...document.querySelectorAll('main [data-cash-preview] form')];
        assert(forms.length >= 2 && forms.every((form) => getComputedStyle(form).display === 'none'), 'Inline create form exposed after close');
        assert(cashPosts().length === 0, 'Closing wrote a purchase');
      });
      await run('New edit disables cached cash choices before a delayed preview returns', async () => {
        result.hold = true; change('[data-preview-form] [name=c0]', 'Daily / Gifts', 'change');
        const cached = [...document.querySelectorAll('main [data-cash-preview] button')];
        assert(cached.length >= 2 && cached.every((button) => button.disabled), 'Stale cached choices enabled');
        await until(() => result.releases.length, 'Expected held preview');
        assert(q('[data-editor-save]').disabled, 'Main save enabled during pending preview');
        result.hold = false; result.releases.splice(0).forEach((release) => release());
        await until(() => q('main [data-cash-preview] [name=c0]')?.value === 'Daily / Gifts', 'New category preview not returned');
        assert(cashPosts().length === 0, 'Edit wrote to Actual');
      });
      await run('Manually chosen cash account survives a later Settings default change', async () => {
        change('#acct', 'Cash wallet', 'change');
        await until(() => previewAccount() === 'Cash wallet', 'Manual account preview missing');
        await settingsAccount('Travel cash');
        await until(() => !q('[data-editor-save]').disabled, 'Refresh did not finish');
        assert(q('#acct').value === 'Cash wallet' && previewAccount() === 'Cash wallet', 'Settings overwrote explicit receipt account');
        assert(q('[data-preview-form] [name=c0]').value === 'Daily / Gifts', 'Settings lost category edits');
      });
      await run('Invalid cash amount blocks Create and retains visible signed choices as disabled', async () => {
        const n = result.requests.length;
        change('[data-preview-form] [name=a0]', 'abc'); await tick();
        assert(q('[data-editor-save]').disabled && q('[data-preview-form] [name=a0]').getAttribute('aria-invalid') === 'true', 'Invalid amount can create');
        assert([...document.querySelectorAll('main [data-cash-preview] button')].every((button) => button.disabled), 'Invalid amount left stale choices enabled');
        assert(result.requests.length === n && cashPosts().length === 0, 'Invalid amount sent request');
      });
      result.completed = true;
      console.log('WORKSPACE_CASH_BROWSER_RESULT ' + JSON.stringify({ passed: result.cases.length, failed: result.failures.length, completed: true, failures: result.failures }));
    })();
  }
  const html = images(render()).replace('<script>', `<script>(${network.toString()})(${fixture});</script><script>`).replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
} finally { f.cleanup(); }
