// Real-DOM regressions from the Astra workflow review. Synthetic SSR and fetch only.
// node --env-file=worker/test.env worker/test/workspace-astra-browser-checks.mjs
// Add --old-default-submitters to remove only the new default Save buttons from
// the generated fixture HTML and reproduce the previous reset-on-Enter default.
// This inspects native form order and uses requestSubmit(defaultSubmitter).
// It does not claim to send a trusted Enter key or emulate browser keystrokes.
import fs from 'node:fs';
import path from 'node:path';
import { workspaceFixtures } from './workspace-fixtures.js';

const fixture = await workspaceFixtures();
try {
  const old = process.argv.includes('--old-default-submitters');
  const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || `/tmp/receipt-workspace-astra${old ? '-old' : ''}.html`;
  const overrides = Object.fromEntries(fixture.settingsData.sections.flatMap((section) => section.settings).map((setting) => [setting.key, setting.value]));
  Object.assign(overrides, { ARCHIVE_AFTER_DAYS: '30', MATCH_ACCOUNTS: 'Cash wallet' });
  const regress = (html) => old ? html.replace(/(<form\b[^>]*aria-label="(?:Everyday settings|Matching and review)"[^>]*>)\s*<button class="nobtn" tabindex="-1" aria-hidden="true"(?: disabled)?>Save<\/button>/g, '$1') : html;
  // P9: the section pages' forms side by side (renderAllSettings), so every group's default submitter is checked in one run.
  const initial = regress(fixture.renderAllSettings(overrides));
  const saved = regress(fixture.renderAllSettings(overrides, 'Saved synthetic settings.'));
  const data = JSON.stringify({ saved: saved.match(/<main\b[^]*?<\/main>/)[0] }).replace(/[<>&]/g, (c) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[c]));
  const html = initial.replace('<script>', `<script>(${network.toString()})(${data});</script><script>`)
    .replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function () { (${checks.toString()})(); });</script></body>`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, html); console.log(target);
} finally { fixture.cleanup(); }

function network(data) {
  window.__astraChecks = { requests: [], passed: [], failures: [], alerts: [] };
  window.alert = (message) => window.__astraChecks.alerts.push(String(message));
  window.confirm = () => true;
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), method = options.method || 'GET';
    if (url.origin !== location.origin) throw new Error('External network forbidden in synthetic fixture');
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null;
    window.__astraChecks.requests.push({ path: url.pathname, method, body });
    if (method !== 'POST' || !/\/(settings-save|settings-reset)$/.test(url.pathname)) throw new Error('Unexpected fixture request: ' + method + ' ' + url.pathname);
    return { ok: true, status: 200, url: new URL('settings?key=fixture-key', location.href).href, headers: { get: () => null }, text: async () => data.saved };
  };
}

function checks() {
  const result = window.__astraChecks;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (condition, message) => { for (let i = 0; i < 80; i++) { if (condition()) return; await Promise.resolve(); } throw new Error(message); };
  const firstSubmitter = (form) => [...form.elements].find((control) => ['submit', 'image'].includes(control.type));
  const run = async (name, action) => {
    try { await action(); result.passed.push(name); console.log('PASS: ' + name); }
    catch (e) { result.failures.push({ name, error: e.message }); console.error('FAIL: ' + name + ': ' + e.message); }
  };
  const saveDefault = async (key, value) => {
    const control = document.getElementById('s-' + key), form = control.form;
    for (let parent = control; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    control.focus(); control.value = value; control.dispatchEvent(new Event('input', { bubbles: true }));
    const submitter = firstSubmitter(form), before = result.requests.length;
    form.requestSubmit(submitter);
    await until(() => result.requests.length > before, 'Native default submitter did not submit');
    const request = result.requests[before];
    await until(() => !control.isConnected, 'Settings response did not render');
    assert(request.method === 'POST' && request.path.endsWith('/settings-save'), "Default '" + submitter.textContent.trim() + "' posted to " + request.path);
    assert(!Object.hasOwn(request.body, 'reset') && request.body[key] === value, 'Default save reset a setting or lost typed ' + key);
  };
  (async () => {
    await run('Every settings-save form defaults to enabled Save before setup-value resets', async () => {
      const forms = [...document.querySelectorAll('form')].filter((form) => form.getAttribute('action')?.startsWith('settings-save?'));
      assert(forms.length > 2, 'Missing settings groups');
      for (const form of forms) {
        assert(form.querySelector('button[name=reset]'), 'Fixture must expose the competing reset submitter');
        const submitter = firstSubmitter(form);
        assert(submitter && !submitter.disabled && !submitter.hasAttribute('formaction') && submitter.name !== 'reset' && submitter.textContent.trim() === 'Save', 'Wrong default for ' + form.getAttribute('aria-label'));
      }
    });
    await run('Everyday default submission saves the typed archive preference', () => saveDefault('ARCHIVE_AFTER_DAYS', '12'));
    await run('Preferences default submission saves typed accounts instead of resetting one', () => saveDefault('MATCH_ACCOUNTS', 'Checking'));
    await run('Connections default submission saves the edited server address', () => saveDefault('ACTUAL_SERVER_URL', 'https://actual-fixture.invalid'));
    await run('Advanced default submission saves the typed matching window', () => saveDefault('MATCH_DAYS', '5'));
    await run('All 54 settings remain editable after default saves', async () => {
      assert(document.querySelectorAll('[data-setting]').length === 54, 'Settings inventory changed');
      assert([...document.querySelectorAll('[data-setting]')].every((row) => document.getElementById('s-' + row.dataset.setting)?.name === row.dataset.setting), 'A retained setting lost its control');
      assert(!result.alerts.length, 'Unexpected script error: ' + result.alerts.join('; '));
      assert(document.documentElement.scrollWidth <= innerWidth, 'Settings page overflowed horizontally');
    });
    console.log('ASTRA_BROWSER_RESULT ' + JSON.stringify({ passed: result.passed.length, failed: result.failures.length, completed: true, failures: result.failures, resetRequests: result.requests.filter((request) => request.path.endsWith('/settings-reset')).length }));
  })();
}
