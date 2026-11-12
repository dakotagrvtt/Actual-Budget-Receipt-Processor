// Build a real-DOM browser check page from the shipped SSR and WORKSPACE_SCRIPT.
// Run with: node --env-file=worker/test.env worker/test/workspace-browser-checks.mjs
// Add --form-actions for native name=action regression cases. Add
// --old-action-properties to that mode to reproduce the previous broken reads
// in the generated HTML only, with four expected wrong-endpoint failures.
// Then load the printed HTML through T3 html_preview (320, 390 and 1280px, light/dark).
// Uses the shipped script with synthetic SSR responses at the network boundary.
// Its 450ms preview debounce is accelerated to microtasks so html_preview waits
// for the whole scenario; DOM events, FormData, focus and dialog behavior are real.
// No real budget, receipt or service is used.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { editorFor } from '../src/receipt-fix.js';
import { rememberAccounts } from '../src/known-accounts.js';

const f = await workspaceFixtures();
const formActionMode = process.argv.includes('--form-actions');
const oldActionMode = process.argv.includes('--old-action-properties');
const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `/tmp/receipt-workspace-${formActionMode ? 'form-actions' : 'browser-checks'}${oldActionMode ? '-old' : ''}.html`;
// A tiny synthetic image keeps this interaction harness within preview's inline size limit.
// The separately rendered fixtures retain the full fictional receipt for visual checks.
const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XkAAAAASUVORK5CYII=';
const images = (html) => html.replace(/src="receipt-photo[^"]*"/g, `src="${photo}"`);
const main = (html) => images(html.match(/<main\b[^]*?<\/main>/)[0]);
if (formActionMode) {
  await buildFormActionHarness();
  f.cleanup();
} else {
const base = new URLSearchParams({ preview: '1', rid: f.view().fix.readingId });
f.view().fix.items.forEach((item, i) => { base.set(`c${i}`, f.view().fix.picks[i]); base.set(`a${i}`, item.amountText); });
const coupon = new URLSearchParams(base);
coupon.set('nd0', 'Coupon'); coupon.set('na0', '-1.50'); coupon.set('nc0', 'Daily / Groceries'); coupon.set('nt0', '');
const responses = {
  initial: main(f.renderReceipt()), preview: main(f.changedPreview), unchanged: main(f.unchangedPreview),
  coupon: main(f.renderReceipt(coupon)), checked: main(f.checkedHtml), saved: main(f.savedHtml),
  other: main(f.otherHtml), settingsOverview: main(f.settingsHtml), settings: main(f.renderSettings({}, '', 'everyday')), overview: main(f.overviewHtml),
  searchedOther: main(f.renderOther(new URLSearchParams({ q: 'Pharmacy' }))),
  rules: main(f.ruleHtml), ruleSaved: main(f.ruleSavedHtml),
  settingsSaved: main(f.renderSettings({ CASH_ACCOUNT: 'Checking' }, 'Saved. It applies at the start of the next check.', 'everyday')),
};
const fixtures = JSON.stringify({ id: f.id, otherId: f.recent[2].key, responses }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
function network(fixtures) {
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window), pending = new Set();
  let nextTimer = -1;
  window.setTimeout = function (fn, ms, ...args) {
    if (ms !== 450) return nativeTimeout(fn, ms, ...args);
    const id = nextTimer--; pending.add(id);
    queueMicrotask(() => { if (pending.delete(id)) fn(...args); });
    return id;
  };
  window.clearTimeout = function (id) { if (id < 0) pending.delete(id); else nativeClear(id); };
  window.__workspaceChecks = { requests: [], alerts: [], confirms: [], completed: false, cases: [], failures: [] };
  window.alert = (text) => window.__workspaceChecks.alerts.push(String(text));
  window.confirm = (text) => { window.__workspaceChecks.confirms.push(String(text)); return window.__allowConfirm !== false; };
  let filed = false;
  window.fetch = async function (input, options = {}) {
    const url = new URL(String(input), location.href), method = options.method || 'GET';
    if (url.origin !== location.origin) throw new Error('External network is forbidden in this fixture');
    const body = options.body ? new URLSearchParams(options.body) : null;
    window.__workspaceChecks.requests.push({ method, path: url.pathname, accept: new Headers(options.headers).get('Accept'), query: Object.fromEntries(url.searchParams), body: body ? Object.fromEntries(body) : null });
    let html, returned = new URL('receipt?key=fixture-key&id=' + encodeURIComponent(fixtures.id), location.href);
    if (url.pathname.endsWith('/settings-save') && method === 'POST') {
      if (window.__holdSettings) await new Promise((resolve) => { window.__releaseSettings = resolve; });
      html = fixtures.responses.settingsSaved; returned = new URL('settings?key=fixture-key&section=everyday', location.href);
    }
    else if (url.pathname.endsWith('/keyword-add') && method === 'POST') { html = fixtures.responses.ruleSaved; returned = new URL('keywords?key=fixture-key', location.href); }
    else if (url.pathname.endsWith('/keywords')) {
      if (window.__holdRules) await new Promise((resolve) => { window.__releaseRules = resolve; });
      html = fixtures.responses.rules; returned = url;
    }
    else if (url.pathname.endsWith('/settings')) { html = url.searchParams.get('section') ? fixtures.responses.settings : fixtures.responses.settingsOverview; returned = url; }
    else if (url.pathname.endsWith('/receipt-fix') && method === 'POST') { filed = true; html = body.get('intent') === 'confirm' ? fixtures.responses.checked : fixtures.responses.saved; }
    else if (url.pathname.endsWith('/receipt')) {
      if (url.searchParams.get('preview') === '1') html = url.searchParams.get('nd0') === 'Coupon' ? fixtures.responses.coupon : url.searchParams.get('c0') === 'Daily / Gifts' ? fixtures.responses.preview : fixtures.responses.unchanged;
      else html = url.searchParams.get('id') === fixtures.otherId ? url.searchParams.get('q') ? fixtures.responses.searchedOther : fixtures.responses.other : filed ? fixtures.responses.checked : fixtures.responses.initial;
      returned = url;
    } else if (url.pathname.endsWith('/')) { html = fixtures.responses.overview; returned = url; }
    else throw new Error('Unexpected fixture request: ' + method + ' ' + url.pathname);
    return { ok: true, status: 200, url: returned.href, headers: { get: () => null }, text: async () => html };
  };
  window.__fixtureIds = { id: fixtures.id, otherId: fixtures.otherId };
}
function checks() {
  const result = window.__workspaceChecks;
  const q = (selector) => document.querySelector(selector);
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const tick = () => Promise.resolve();
  const until = async (condition, label) => { for (let i = 0; i < 50; i++) { if (condition()) return; await tick(); } throw new Error(label); };
  const change = (selector, value, event = 'input') => { const input = q(selector); assert(input, 'Missing ' + selector); input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); return input; };
  const click = (selector) => { const el = q(selector); assert(el, 'Missing ' + selector); el.click(); return el; };
  const run = async (name, action) => {
    try { await action(); result.cases.push(name); console.log('PASS: ' + name); }
    catch (error) { result.failures.push({ name, error: error.message }); console.error('FAIL: ' + name + ': ' + error.message); }
  };
  const previewCategory = () => q('[data-preview-fragment] [data-commit] input[name=c0]')?.value;
  (async () => {
    await run('Header has the small-icon wordmark and keyboard users can skip to labelled content', async () => {
      assert(q('.app-brand .brand-icon') && q('.app-brand').textContent.trim() === 'Receipt processor' && ![...q('.app-header').querySelectorAll('a')].some((n) => n.textContent.trim().toLowerCase() === 'receipts.'), 'Header wordmark is not the small icon plus Receipt processor');
      assert(document.querySelectorAll('h1').length === 1 && q('h1').textContent.trim() === 'Receipts', 'Missing single application heading');
      const nav = q('.app-header nav'); assert(nav?.getAttribute('aria-label')?.trim(), 'Header navigation is unlabelled');
      const skip = q('a[href="#app-main"]'), content = q('#app-main');
      assert(skip && content.getAttribute('tabindex') === '-1', 'Skip target cannot receive focus');
      skip.focus(); assert(skip.getBoundingClientRect().bottom > 0 && skip.getBoundingClientRect().top >= 0, 'Focused skip link is offscreen');
      skip.click(); await tick(); assert(document.activeElement === content, 'Skip link did not move focus to content');
    });
    await run('Shipped workspace initializes with editable categories and clean Looks right', async () => {
      assert(document.documentElement.classList.contains('workspace-ready'), 'Workspace did not initialize');
      assert(document.querySelectorAll('[data-preview-form] select.pick[name^=c]').length === 5, 'All categories must be editable');
      assert(q('[data-editor-save]').textContent === 'Looks right', 'Clean confirmation label');
      assert(document.documentElement.scrollWidth <= innerWidth, 'Initial horizontal overflow');
    });
    await run('Editable receipt controls have names and 44px touch targets', async () => {
      const controls = [...document.querySelectorAll('[data-preview-form] input:not([type=hidden]),[data-preview-form] select')];
      assert(controls.every((n) => n.getAttribute('aria-label')?.trim() || [...(n.labels || [])].some((label) => label.textContent.trim())), 'Receipt field has no accessible name');
      const targets = [q('.header-add>summary'), q('.app-header a[href^="settings"]'), q('[name=a0]'), q('[name=c0]'), q('[data-editor-save]')];
      assert(targets.every((n) => n.getBoundingClientRect().width >= 44 && n.getBoundingClientRect().height >= 44), 'Header or receipt target is smaller than 44px');
    });
    await run('Escape closes a menu and restores focus, and outside clicks dismiss it', async () => {
      const menu = q('.receipt-more'), summary = menu.querySelector('summary'), inside = menu.querySelector('a');
      menu.open = true; inside.focus(); inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!menu.open && document.activeElement === summary, 'Escape failed to close menu and return focus');
      menu.open = true; q('[data-workspace-title]').click(); assert(!menu.open, 'Outside click left menu open');
      const upload = [...q('.app-header').querySelectorAll('details')].find((n) => n.querySelector('[data-upload]'));
      upload.open = true; q('[name=a0]').click(); assert(!upload.open, 'Outside click left upload menu open');
      const before = result.requests.length;
      for (const target of [q('[name=a0]'), q('[data-editor-save]'), summary, q('.app-header a[href^="settings"]')]) {
        const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        target.dispatchEvent(event); assert(!event.defaultPrevented, 'Receipt navigation took over an interactive control arrow key');
      }
      assert(result.requests.length === before, 'Arrow key navigated away from an interactive control');
    });
    await run('Invalid amount blocks requests and preserves input focus', async () => {
      const n = result.requests.length, input = q('[name=a0]'); input.focus(); change('[name=a0]', 'abc'); await tick();
      assert(input.getAttribute('aria-invalid') === 'true' && q('[data-editor-save]').disabled, 'Invalid Save guard');
      assert(getComputedStyle(input).borderBottomStyle === 'solid' && parseFloat(getComputedStyle(input).borderBottomWidth) >= 2, 'Visible invalid underline');
      assert(document.activeElement === input && input.value === 'abc', 'Invalid amount focus/value');
      const feedbackIds = [input.getAttribute('aria-describedby'), input.getAttribute('aria-errormessage')].filter(Boolean).join(' ').split(/\s+/);
      const feedback = feedbackIds.map((id) => document.getElementById(id)).find((n) => n && /4\.18/.test(n.textContent));
      assert(feedback && (feedback.getAttribute('role') === 'alert' || feedback.getAttribute('aria-live') === 'assertive'), 'Invalid amount feedback is not associated and announced');
      assert(result.requests.length === n, 'Invalid input fetched a preview');
    });
    await run('Confident-category editing gets a signed live preview without writing', async () => {
      change('[name=a0]', '4.18'); change('[name=c0]', 'Daily / Gifts', 'change');
      await until(() => previewCategory() === 'Daily / Gifts', 'Live preview did not update');
      const form = q('[data-preview-fragment] [data-commit]');
      assert(form.querySelector('[name=token]').value && form.querySelector('[name=state]').value, 'Missing server preview signature');
      assert(!result.requests.some((request) => request.method === 'POST'), 'Editing performed a write');
      assert(result.requests.every((request) => request.accept === 'text/html'), 'Page request did not ask for HTML');
      assert(q('[data-item="0"] [data-item-hint]').hidden === false, 'Changed row recovery is hidden');
    });
    await run('Revert returns to the original row and confirmation preview', async () => {
      click('[data-item="0"] [data-item-revert]');
      await until(() => previewCategory() === 'Daily / Groceries', 'Revert did not refresh preview');
      assert(q('[name=a0]').value === '4.18' && q('[name=c0]').value === 'Daily / Groceries', 'Revert lost baseline values');
      assert(q('[data-preview-fragment]').dataset.previewConfirm === 'true', 'Clean preview is not confirmation-only');
    });
    await run('Adding and discarding a discount clears added values and rows', async () => {
      q('[data-added-lines]').closest('details').open = true;
      change('[name=nd0]', 'Coupon'); change('[name=na0]', '-1.50'); change('[name=nc0]', 'Daily / Groceries', 'change');
      await until(() => q('[data-commit] [name=na0]')?.value === '-1.50', 'Discount preview not returned');
      click('[data-editor-add]'); assert(q('[data-added-lines] tbody').rows.length === 2, 'Second added row missing');
      change('[name=nd1]', 'Extra'); change('[name=na1]', '0');
      click('[data-editor-discard]');
      await until(() => previewCategory() === 'Daily / Groceries', 'Discard did not refresh');
      assert(q('[name=nd0]').value === '' && q('[name=na0]').value === '', 'Discard left added values');
      assert(q('[data-added-lines] tbody').rows.length === 1, 'Discard left extra rows');
      assert(q('[data-draft-for]').hidden, 'Discard left stale Unsaved edits marker');
      assert(!q('[data-workspace-status]').textContent.includes("edits aren't saved"), 'Discard left unsaved status');
    });
    await run('Clean Looks right submits the signed confirm intent', async () => {
      const form = q('[data-commit]'), token = form.querySelector('[name=token]').value;
      click('[data-editor-save]');
      await until(() => result.requests.some((request) => request.method === 'POST' && request.path.endsWith('/receipt-fix')), 'Confirmation did not submit');
      const request = result.requests.find((item) => item.method === 'POST' && item.path.endsWith('/receipt-fix'));
      assert(request.body.intent === 'confirm' && request.body.token === token && request.body.state && request.body.mark === 'yes', 'Confirm dropped guarded fields');
      await until(() => q('.notice')?.textContent.includes('Moved to Filed'), 'Confirm result not rendered');
    });
    await run('Queue navigation retains another receipt’s category draft', async () => {
      change('[name=c0]', 'Daily / Gifts', 'change'); await until(() => previewCategory() === 'Daily / Gifts', 'Draft preview not ready');
      const other = [...document.querySelectorAll('[data-queue-row]')].find((a) => a.dataset.id === window.__fixtureIds.otherId); (other.closest('details') || {}).open = true; other.click();
      await until(() => q('[data-receipt-id]')?.dataset.receiptId === window.__fixtureIds.otherId, 'Other receipt did not open');
      const back = [...document.querySelectorAll('[data-queue-row]')].find((a) => a.dataset.id === window.__fixtureIds.id); back.click();
      await until(() => q('[data-receipt-id]')?.dataset.receiptId === window.__fixtureIds.id && q('[name=c0]')?.value === 'Daily / Gifts', 'Receipt draft was lost');
      assert(q('[data-draft-for]').hidden === false, 'Retained draft marker missing');
    });
    // P9: Settings are pages (overview, then a section), not a dialog. The 54-settings inventory is checked by test/workspace-accessibility.test.js.
    await run('Settings open as pages (no dialog); leaving unsaved settings asks first', async () => {
      click('.app-header a[href^="settings"]'); await until(() => q('#settings-page .settings-cards'), 'Settings overview missing');
      assert(!q('#workspace-dialog').open, 'Settings opened in a dialog');
      click('.settings-link[href*="section=everyday"]'); await until(() => q('[data-settings-section="everyday"]'), 'Everyday page missing');
      assert([...document.querySelectorAll('#settings-page [data-setting]')].every((row) => row.querySelector('#s-' + row.dataset.setting)?.name === row.dataset.setting), 'A retained setting has no editable control');
      assert(document.documentElement.scrollWidth <= innerWidth, 'Settings page has horizontal overflow');
      const accountHeight = q('#s-CASH_ACCOUNT').getBoundingClientRect().height, doneHeight = q('[data-settings-done]').getBoundingClientRect().height;
      assert(accountHeight >= 44 && doneHeight >= 44, 'Settings target is smaller than 44px: account=' + accountHeight + ', done=' + doneHeight);
      assert(q('[data-settings-done]').textContent.startsWith('Done · back to '), 'Done does not say where it goes back to');
      change('#s-CASH_ACCOUNT', 'Checking', 'change'); window.__allowConfirm = false; click('[data-settings-done]');
      for (let i = 0; i < 5; i++) await tick();
      assert(q('[data-settings-section="everyday"]') && q('#s-CASH_ACCOUNT').value === 'Checking' && result.confirms.length > 0, 'Unsaved settings silently left');
      window.__allowConfirm = true;
    });
    await run('Saving a settings section keeps receipt drafts, and Done goes back to the receipt', async () => {
      window.__holdSettings = true;
      const form = q('#s-CASH_ACCOUNT').form; form.requestSubmit(form.querySelector('.settings-save button'));
      await until(() => window.__releaseSettings, 'Settings POST not pending');
      assert([...form.querySelectorAll('button')].every((n) => n.disabled), 'Save stayed enabled during POST');
      window.__releaseSettings(); window.__holdSettings = false;
      await until(() => q('[data-app-main] > .notice') && q('[data-settings-section="everyday"]'), 'Settings response missing or not on the same section');
      assert(q('#s-CASH_ACCOUNT').value === 'Checking', 'Saved value not shown');
      click('[data-settings-done]'); await until(() => q('[data-receipt-id]')?.dataset.receiptId === window.__fixtureIds.id, 'Done did not go back to the receipt');
      await until(() => q('[name=c0]')?.value === 'Daily / Gifts', 'Settings lost receipt draft');
    });
    await run('Make a rule uses the server form, serializes dialog loading and retains receipt edits', async () => {
      window.__holdRules = true;
      click('[data-item="0"] [data-rule-link]');
      await until(() => window.__releaseRules, 'Rule dialog did not request real keywords page');
      const requests = result.requests.length; click('.app-header a[href^="settings"]');
      assert(result.requests.length === requests, 'Concurrent dialog GET was not serialized');
      window.__releaseRules(); window.__holdRules = false;
      await until(() => q('#workspace-dialog form[action*="keyword-add"]'), 'Keyword-add form missing');
      const form = q('#workspace-dialog form[action*="keyword-add"]');
      assert(form.elements.phrase.value === 'Milk, 1 gallon' && form.elements.category.value === 'Daily / Gifts', 'Rule did not use edited row');
      form.requestSubmit(form.querySelector('button'));
      await until(() => !q('#workspace-dialog').open, 'Saved rule dialog did not close');
      assert(result.requests.some((r) => r.path.endsWith('/keyword-add') && r.method === 'POST' && r.body.category === 'Daily / Gifts'), 'Rule did not use real POST contract');
      assert(q('[name=c0]').value === 'Daily / Gifts', 'Rule save lost receipt draft');
    });
    await run('Quick search survives receipt navigation and Back while retaining draft', async () => {
      change('[data-queue-search]', 'Pharmacy');
      const other = [...document.querySelectorAll('[data-queue-row]')].find((a) => a.dataset.id === window.__fixtureIds.otherId);
      assert(new URL(other.href).searchParams.get('q') === 'Pharmacy', 'Quick search absent from receipt href'); other.click();
      await until(() => q('[data-receipt-id]')?.dataset.receiptId === window.__fixtureIds.otherId, 'Filtered receipt did not open');
      assert(q('[data-queue-search]').value === 'Pharmacy' && new URL(q('.workspace-back').href).searchParams.get('q') === 'Pharmacy', 'Receipt failed to preserve search');
      click('.workspace-back'); await until(() => q('[data-overview]'), 'Back did not open queue');
      assert(q('[data-queue-search]').value === 'Pharmacy', 'Back lost quick search');
      assert(document.querySelectorAll('[data-queue-row]').length === 3, 'Filtered overview auto-opened a receipt');
      change('[data-queue-search]', '');
      [...document.querySelectorAll('[data-queue-row]')].find((a) => a.dataset.id === window.__fixtureIds.id).click();
      await until(() => q('[name=c0]')?.value === 'Daily / Gifts', 'Search navigation lost receipt draft');
    });
    await run('Every synthetic page request asks for HTML and stays same-origin', async () => {
      assert(result.requests.length > 8 && result.requests.every((request) => request.accept === 'text/html'), 'A page request did not request HTML');
      assert(result.alerts.length === 0, 'Unexpected page error: ' + result.alerts.join('; '));
      assert(document.documentElement.scrollWidth <= innerWidth, 'Final horizontal overflow');
    });
    result.completed = true;
    console.log('WORKSPACE_BROWSER_RESULT ' + JSON.stringify({ passed: result.cases.length, failed: result.failures.length, completed: true, failures: result.failures }));
  })();
}
const prelude = `<script>(${network.toString()})(${fixtures});</script>`;
const driver = `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(); });</script>`;
const html = images(f.renderReceipt()).replace('<script>', prelude + '<script>').replace('</body>', driver + '</body>');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html);
console.log(target);
f.cleanup();
}

// Native forms expose named controls as properties. These pages deliberately retain
// the real hidden name=action fields so the regression cannot hide behind a mock form.
async function buildFormActionHarness() {
  await rememberAccounts([{ name: 'Cash wallet' }, { name: 'Checking' }]);
  const values = { merchant: 'Riverside Market', date: '2026-11-08', total: '10.80', payment_method: 'card' };
  const resolutionView = {
    ...f.view(), fix: { ok: false, reason: 'Choose the matching charge.' },
    resolution: { values, original: { ...values, total: '32.15' }, token: 'synthetic-resolution-token', window: { start: '2026-11-05', end: '2026-11-11' }, candidates: [{ id: 'charge-1080', payee: 'Riverside Market', amount: '10.80', date: '2026-11-08', account: 'Checking' }] },
  };
  const resolutionPage = receiptPage(resolutionView, 'fixture-key', '');
  const cashSummary = structuredClone(f.summary);
  delete cashSummary.transaction;
  Object.assign(cashSummary, { plan: { applied: false, parts: [] }, problems: [] });
  Object.assign(cashSummary.receipt, { subtotal: 10.80, tax: 0, total: 10.80, payment_method: 'cash', items: [{ description: 'Lunch', plain: 'Lunch', amount: 10.80, category: 'Daily / Groceries' }] });
  const cashEntry = { ...f.entry, result: 'review', card: { ...f.entry.card, total: 10.80 } };
  delete cashEntry.applied;
  const cashPage = (account) => {
    const query = account ? new URLSearchParams({ preview: '1', acct: account, c0: 'Daily / Groceries', a0: '10.80' }) : new URLSearchParams();
    const cashLook = { account: { id: 'cash-account', name: account || 'Cash wallet' }, payee: { id: 'cafe', name: 'Riverside Market', isNew: false }, duplicates: [{ id: 'cash-duplicate', date: '2026-11-08', payeeName: 'Riverside Market', amount: -1080 }] };
    const fix = editorFor({ id: f.id, entry: cashEntry, summary: cashSummary, query, cashLook });
    if (!fix.ok || (account && !fix.preview?.token)) throw new Error('Invalid synthetic cash editor: ' + JSON.stringify(fix));
    return receiptPage({ ...f.view(), entry: cashEntry, summary: cashSummary, fix }, 'fixture-key', '');
  };
  const data = { id: f.id, responses: { resolution: main(resolutionPage), cash: main(cashPage()), cashWallet: main(cashPage('Cash wallet')), cashChecking: main(cashPage('Checking')), settings: main(f.renderSettings({ CASH_ACCOUNT: 'Checking' }, '', 'everyday')), reset: main(f.renderSettings({}, '', 'everyday')) } };
  const json = JSON.stringify(data).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  let html = images(resolutionPage);
  if (oldActionMode) {
    // Reproduce only the previous property reads in this generated test artifact.
    // Production files are never changed by this option.
    if (!html.includes("form.getAttribute('action')")) throw new Error('No fixed form action reads found to regress');
    html = html.replaceAll("form.getAttribute('action')", 'form.action');
  }
  html = html.replace('<script>', `<script>(${formActionNetwork.toString()})(${json});</script><script>`)
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${formActionChecks.toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
}

function formActionNetwork(data) {
  window.__formActionChecks = { requests: [], cases: [], failures: [], alerts: [] };
  window.alert = (message) => window.__formActionChecks.alerts.push(String(message));
  window.confirm = () => true;
  const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), pending = new Set();
  let nextTimer = -1;
  window.setTimeout = (fn, ms, ...args) => {
    if (ms !== 450) return nativeTimeout(fn, ms, ...args);
    const id = nextTimer--; pending.add(id); queueMicrotask(() => { if (pending.delete(id)) fn(...args); }); return id;
  };
  window.clearTimeout = (id) => { if (id < 0) pending.delete(id); else nativeClear(id); };
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), method = options.method || 'GET';
    if (url.origin !== location.origin) throw new Error('External network forbidden');
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null;
    window.__formActionChecks.requests.push({ path: url.pathname, method, body, query: Object.fromEntries(url.searchParams) });
    let html, resultUrl = url;
    if (method === 'POST' && url.pathname.endsWith('/receipt-resolve')) html = data.responses.resolution;
    else if (method === 'POST' && url.pathname.endsWith('/receipt-cash')) html = data.responses.cashChecking;
    else if (method === 'POST' && url.pathname.endsWith('/settings-reset')) html = data.responses.reset;
    else if (url.pathname.endsWith('/settings')) html = data.responses.settings;
    else if (url.pathname.endsWith('/receipt') && url.searchParams.get('resolve') === '1') html = data.responses.resolution;
    else if (url.pathname.endsWith('/receipt') && url.searchParams.get('preview') === '1') html = url.searchParams.get('acct') === 'Checking' ? data.responses.cashChecking : data.responses.cashWallet;
    else if (url.pathname.endsWith('/')) { html = data.responses.cash; resultUrl = new URL('receipt?key=fixture-key&id=' + encodeURIComponent(data.id), location.href); }
    else throw new Error('Wrong endpoint: ' + method + ' ' + url.pathname);
    return { ok: true, status: 200, url: resultUrl.href, headers: { get: () => null }, text: async () => html };
  };
}

function formActionChecks() {
  const result = window.__formActionChecks, q = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (condition, message) => { for (let i = 0; i < 80; i++) { if (condition()) return; await Promise.resolve(); } throw new Error(message); };
  const run = async (name, check) => { try { await check(); result.cases.push(name); console.log('PASS: ' + name); } catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); } };
  const actionForm = (action, root = document) => [...root.querySelectorAll('form')].find((form) => form.elements.namedItem('action')?.value === action);
  const submitAndCheck = async (form, endpoint, expected) => {
    const before = result.requests.length, submitter = form.querySelector('button');
    form.requestSubmit(submitter);
    await until(() => result.requests.length > before, 'Form never submitted');
    const request = result.requests[before];
    assert(request.path.endsWith('/' + endpoint), 'Wrong endpoint: ' + request.path);
    assert(request.method === 'POST', 'Write was not POST');
    for (const [field, value] of Object.entries(expected)) assert(request.body[field] === value, 'Lost ' + field + ': ' + request.body[field]);
    // Let the real response handling replace the page or modal before the next case.
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  (async () => {
    await run('Resolution form retains native action shadowing and corrected total', async () => {
      const form = actionForm('select');
      assert(form?.action instanceof HTMLInputElement, 'Fixture did not reproduce native named-control shadowing');
      assert(form.getAttribute('action').startsWith('receipt-resolve?'), 'Real resolution endpoint absent');
      assert(form.elements.namedItem('receipt-total').value === '10.80' && form.elements.namedItem('token').value, 'Corrected reading/token absent');
    });
    await run('Use this charge posts select to receipt-resolve with guarded reading', async () => {
      await submitAndCheck(actionForm('select'), 'receipt-resolve', { action: 'select', transaction: 'charge-1080', 'receipt-total': '10.80', token: 'synthetic-resolution-token' });
    });
    await run('Keep checking posts recheck to receipt-resolve with corrected total', async () => {
      await submitAndCheck(actionForm('recheck'), 'receipt-resolve', { action: 'recheck', 'receipt-total': '10.80', token: 'synthetic-resolution-token' });
    });
    await run('Cash preview preserves the selected account and server signature', async () => {
      q('.workspace-back').click(); await until(() => q('[data-preview-form]')?.dataset.kind === 'cash', 'Cash editor did not open');
      const account = q('#acct'); account.value = 'Checking'; account.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => q('[data-cash-preview] [name=acct]')?.value === 'Checking', 'Cash preview lost chosen account');
      const request = result.requests.findLast((r) => r.method === 'GET' && r.query.preview === '1');
      assert(request.path.endsWith('/receipt') && request.query.acct === 'Checking', 'Cash preview went to wrong endpoint/account');
      // P8: the confirmation is the preview's own forms, shown in place (no dialog, nothing copied).
      q('[data-editor-save]').click(); await until(() => q('main [data-cash-preview][data-confirming]'), 'Cash confirmation missing');
      assert(!q('#workspace-dialog').open, 'Cash confirmation opened a dialog');
      const form = actionForm('split', q('main [data-cash-preview]'));
      assert(getComputedStyle(form).display !== 'none' && document.activeElement === form.querySelector('button'), 'The safe choice is not shown or not focused');
      assert(form?.action instanceof HTMLInputElement && form.elements.namedItem('token').value && form.elements.namedItem('state').value, 'Cash fixture lacks native shadowing or signature');
    });
    await run('Use this cash purchase posts split with account, duplicate, state and token', async () => {
      const form = actionForm('split', q('main [data-cash-preview]'));
      await submitAndCheck(form, 'receipt-cash', { action: 'split', dup: 'cash-duplicate', acct: 'Checking', token: form.elements.namedItem('token').value, state: form.elements.namedItem('state').value });
    });
    await run('Create cash purchase posts create with the preview signature and account', async () => {
      q('[data-editor-save]').click(); await until(() => q('main [data-cash-preview][data-confirming]'), 'Create confirmation missing');
      const form = actionForm('create', q('main [data-cash-preview]'));
      await submitAndCheck(form, 'receipt-cash', { action: 'create', acct: 'Checking', token: form.elements.namedItem('token').value, state: form.elements.namedItem('state').value });
    });
    await run('Settings reset honors submitter formaction and reset field', async () => {
      q('.app-header a[href^="settings"]').click(); await until(() => q('#settings-page button[name=reset][value=CASH_ACCOUNT]'), 'Settings missing');
      const button = q('button[name=reset][value=CASH_ACCOUNT]');
      const form = button.form, before = result.requests.length; form.requestSubmit(button);
      await until(() => result.requests.length > before, 'Reset did not submit');
      const request = result.requests[before];
      assert(request.method === 'POST' && request.path.endsWith('/settings-reset') && request.body.reset === 'CASH_ACCOUNT', 'Reset formaction/submitter field changed');
    });
    console.log('FORM_ACTION_BROWSER_RESULT ' + JSON.stringify({ passed: result.cases.length, failed: result.failures.length, completed: true, failures: result.failures, wrongPaths: result.requests.filter((r) => /HTMLInputElement|object%20/i.test(r.path)).map((r) => r.path) }));
  })();
}
