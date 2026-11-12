// Real-DOM cash account selection regression with real SSR and accountAsked().
// node --env-file=worker/test.env worker/test/workspace-astra-cash-browser-checks.mjs
// --old-empty-fallback regresses only the generated blank-account response to the
// previous blank-as-missing behavior. No production files or services are changed.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';
import { accountAsked, lookAtActual } from '../src/cash.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { rememberAccounts } from '../src/known-accounts.js';

const fixture = await workspaceFixtures();
try {
  const old = process.argv.includes('--old-empty-fallback');
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `/tmp/receipt-workspace-astra-cash${old ? '-old' : ''}.html`;
  await rememberAccounts([{ name: 'Cash wallet' }, { name: 'Checking' }]);
  const entry = { ...fixture.entry, applied: undefined, result: 'review' };
  const summary = structuredClone(fixture.summary);
  delete summary.transaction;
  summary.plan = { applied: false, parts: [] }; summary.receipt.payment_method = 'cash';
  let actualOpens = 0;
  const page = async (asked) => {
    const query = new URLSearchParams(asked);
    // Old code treated an explicit empty field as an omitted field in both places.
    if (old && query.has('acct') && !query.get('acct').trim()) query.delete('acct');
    const accountName = accountAsked(query);
    const cashLook = accountName === ''
      ? await lookAtActual({ entry, summary, accountName }, { actual: { async open() { actualOpens++; throw new Error('Actual is forbidden in this fixture'); } } })
      : { account: { id: accountName === 'Checking' ? 'checking' : 'wallet', name: accountName }, payee: { id: 'riverside', name: 'Riverside Market', isNew: false }, duplicates: [] };
    const fix = editorFor({ id: fixture.id, entry, summary, query, cashLook });
    if (!fix.ok) throw new Error('Invalid cash fixture: ' + JSON.stringify(fix));
    return receiptPage({ ...fixture.view(), entry, summary, fix }, 'fixture-key', '');
  };
  const omitted = await page(new URLSearchParams({ preview: '1' }));
  const blank = await page(new URLSearchParams({ preview: '1', acct: '' }));
  const checking = await page(new URLSearchParams({ preview: '1', acct: 'Checking' }));
  const main = (html) => html.match(/<main\b[^]*?<\/main>/)[0].replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="');
  const data = JSON.stringify({ blank: main(blank), checking: main(checking), wallet: main(omitted), actualOpens }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  const html = omitted.replace(/src="receipt-photo[^"]*"/g, 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII="')
    .replace('<script>', `<script>(${network.toString()})(${data});</script><script>`)
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
} finally { fixture.cleanup(); }

function network(data) {
  window.__astraCash = { requests: [], passed: [], failures: [], alerts: [], actualOpens: data.actualOpens, blankStates: [] };
  window.alert = (message) => window.__astraCash.alerts.push(String(message)); window.confirm = () => true;
  const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), pending = new Set();
  let nextTimer = -1;
  window.setTimeout = (fn, ms, ...args) => { if (ms !== 450) return nativeTimeout(fn, ms, ...args); const id = nextTimer--; pending.add(id); queueMicrotask(() => { if (pending.delete(id)) fn(...args); }); return id; };
  window.clearTimeout = (id) => { if (id < 0) pending.delete(id); else nativeClear(id); };
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), method = options.method || 'GET';
    if (url.origin !== location.origin) throw new Error('External network forbidden');
    window.__astraCash.requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (method !== 'GET' || !url.pathname.endsWith('/receipt')) throw new Error('No writes or external services are allowed');
    const html = url.searchParams.has('acct') ? url.searchParams.get('acct') === '' ? data.blank : data.checking : data.wallet;
    return { ok: true, status: 200, url: url.href, headers: { get: () => null }, text: async () => html };
  };
}

function checks() {
  const result = window.__astraCash, q = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const until = async (condition, message) => { for (let i = 0; i < 100; i++) { if (condition()) return; await Promise.resolve(); } throw new Error(message); };
  const run = async (name, action) => { try { await action(); result.passed.push(name); console.log('PASS: ' + name); } catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); } };
  const choose = async (value) => {
    const before = result.requests.length, account = q('#acct');
    account.value = value; account.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => result.requests.length > before, 'Account change did not request a preview'); await flush();
    const request = result.requests[before]; assert(Object.hasOwn(request.query, 'acct') && request.query.acct === value, 'Preview changed the explicit account value');
  };
  const blankCannotCreate = async () => {
    const before = result.requests.length;
    q('[data-editor-save]').click(); await until(() => result.requests.length > before, 'Explicit preview did not finish'); await flush();
    const state = { visibleAccount: q('#acct').value, dialogOpen: q('#workspace-dialog').open, signedAccount: q('#workspace-dialog[open] [name=acct]')?.value ?? q('[data-app-main] [data-cash-preview] [name=acct]')?.value ?? null };
    result.blankStates.push(state);
    assert(state.visibleAccount === '' && !state.dialogOpen && state.signedAccount === null, 'Blank account produced a creation choice: ' + JSON.stringify(state));
    assert(!q('[data-app-main] [data-cash-preview] form[action*="receipt-cash"]'), 'Blank account left a signed Create form');
    assert(q('[data-app-main] [data-cash-preview]').textContent.includes('No account is chosen'), 'Blank account did not explain what to fix');
  };
  (async () => {
    await run('Omitted account defaults to Cash wallet in the real initial editor and preview', async () => {
      assert(q('#acct').value === 'Cash wallet', 'Missing account did not use configured default');
      assert(q('[data-cash-preview] [name=acct]').value === 'Cash wallet', 'Omitted account preview and editor disagree');
    });
    await run('Explicit not-chosen account stays blank and cannot open cash creation', async () => { await choose(''); await blankCannotCreate(); });
    await run('Choosing a valid account recovers and signs the selected account', async () => {
      // P8: the confirmation is the preview's own forms shown in place (no dialog); Cancel hides them again.
      await choose('Checking'); q('[data-editor-save]').click(); await until(() => q('[data-app-main] [data-cash-preview][data-confirming]'), 'Valid account did not open confirmation');
      const form = q('[data-app-main] [data-cash-preview] form[action*="receipt-cash"]');
      assert(!q('#workspace-dialog').open && form && getComputedStyle(form).display !== 'none', 'The confirmation is not shown in place');
      assert(form && form.elements.namedItem('acct').value === 'Checking' && form.elements.namedItem('token').value && form.elements.namedItem('state').value, 'Recovery preview signed the wrong account or lost guards');
      q('[data-app-main] [data-cash-cancel]').click();
    });
    await run('Clearing the account after a valid preview removes every stale creation choice', async () => { await choose(''); await blankCannotCreate(); });
    await run('Blank-account flow opens no Actual session and performs no writes', async () => {
      assert(result.actualOpens === 0, 'Blank-account lookup opened Actual');
      assert(result.requests.every((request) => request.method === 'GET'), 'Account selection caused a write');
      assert(result.alerts.length === 0, 'Unexpected page error: ' + result.alerts.join('; '));
    });
    console.log('ASTRA_CASH_BROWSER_RESULT ' + JSON.stringify({ passed: result.passed.length, failed: result.failures.length, completed: true, failures: result.failures, blankStates: result.blankStates, writes: result.requests.filter((request) => request.method !== 'GET').length }));
  })();
}
