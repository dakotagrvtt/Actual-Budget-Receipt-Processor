// Round 2 small flow fixes: Check now from Activity returns to Activity (S4), rail counts and "No matches" under a search (S5), the Filed toggle's
// expanded state (S6), and Settings Done keeping its origin across a reload through a cleaned `from` (S7).
import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { workspaceFixtures } from './workspace-fixtures.js';
import { makeServer } from '../src/trigger.js';
import { cleanFrom } from '../src/panel-settings-page.js';
import { queueRail } from '../src/panel-queue.js';
import { receiptNav, cleanNav } from '../src/panel-status.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { WORKSPACE_SCRIPT } from '../src/panel-workspace-script.js';
import { withFrame } from '../src/panel-layout.js';
import { settingsPage } from '../src/panel-settings-page.js';
import { categoriesPage } from '../src/panel-lists.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const bare = (html) => html.replace(/<(style|script)>[^]*?<\/\1>/g, '');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'));
  const before = { statePath: config.statePath, settingsPath: config.settingsPath, token: config.trigger.token };
  Object.assign(config, { statePath: path.join(dir, 'state.json'), settingsPath: path.join(dir, 'settings.json') });
  fs.writeFileSync(config.statePath, '{}');
  config.trigger.token = 'secret';
  const runs = [];
  const server = makeServer((why) => runs.push(why));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`, runs); } finally {
    server.close(); Object.assign(config, { statePath: before.statePath, settingsPath: before.settingsPath }); config.trigger.token = before.token; fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('S4: Check now from Activity comes back to Activity; from anywhere else it behaves as before', async () => {
  const html = bare(fixture.overviewHtml);
  assert.match(html, /<form method="post" action="run\?key=fixture-key&amp;from=activity"><button class="plain">Check now<\/button><\/form>/);
  await withServer(async (base, runs) => {
    const post = (query) => fetch(`${base}/run?key=secret${query}`, { method: 'POST', headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal((await post('&from=activity')).headers.get('location'), './?key=secret&activity=1&started=1');
    assert.equal((await post('')).headers.get('location'), './?key=secret&started=1');
    assert.equal((await post('&from=//evil.example')).headers.get('location'), './?key=secret&started=1', 'only the one value counts');
    assert.equal(runs.length, 3, 'each press started a check');
    const webhook = await fetch(`${base}/run?key=secret&from=activity`, { method: 'POST', redirect: 'manual' });
    assert.equal(webhook.status, 202, 'the webhook answer is unchanged');
  });
});

const entries = (specs) => specs.map(([k, group, store]) => ({ key: k, file: `${k}.jpg`, done: true, result: group === 'review' ? 'review' : 'split', card: { store, total: 5, date: '2026-11-06' }, ...(group === 'waiting' ? { done: false, waiting: {} } : {}) }));

test('S5: the receipt page\'s list pane is built from the whole list, so a search never changes its counts', () => {
  const recent = entries([['a', 'review', 'Alpha'], ['b', 'review', 'Bravo'], ['c', 'filed', 'Charlie']]);
  const nav = receiptNav(recent, 'c', cleanNav(new URLSearchParams('q=charlie')));
  assert.deepEqual(nav.list.map((r) => r.key), ['c'], 'Next and Previous follow the search');
  assert.equal(nav.all.length, 3);
  const view = { id: 'c', name: 'c.jpg', entry: recent[2], pages: 0, summary: null };
  const html = bare(receiptPage(view, 'k', '', nav));
  assert.match(html, /<h3 class="queue-heading">Review <span class="queue-count">2<\/span><\/h3>/);
  assert.doesNotMatch(html, /Review <span class="queue-count">0/);
  assert.match(html, /Alpha[^]*Bravo/);
});

test('S5: every group has a hidden "No matches." line, and the script counts the visible rows and shows it instead of "All caught up."', () => {
  const rail = queueRail(entries([['a', 'review', 'Alpha']]), 'k');
  assert.equal((rail.match(/<li class="queue-empty" data-no-match hidden>No matches\.<\/li>/g) ?? []).length, 3, 'Review, Waiting and Filed');
  assert.match(rail, /<li class="queue-empty">None right now\.<\/li><li class="queue-empty" data-no-match hidden>/);
  assert.ok(WORKSPACE_SCRIPT.includes('count.dataset.total'), 'counts fall back to the total when the search is empty');
  assert.ok(WORKSPACE_SCRIPT.includes("hasAttribute('data-no-match')"), 'the No matches line is driven by the script');
});

test('S6: the Filed toggle carries aria-expanded, open when the open receipt is Filed, and the script keeps it in step', () => {
  const recent = entries([['a', 'review', 'Alpha'], ['c', 'filed', 'Charlie']]);
  assert.match(queueRail(recent, 'k'), /<details class="queue-filed" data-queue-group="filed"><summary aria-expanded="false">Filed /);
  assert.match(queueRail(recent, 'k', 'c'), /<details class="queue-filed" data-queue-group="filed" open><summary aria-expanded="true">Filed /);
  assert.match(queueRail(recent, 'k', '', '', null, { openGroup: 'filed' }), /<summary aria-expanded="true">Filed /);
  assert.ok(WORKSPACE_SCRIPT.includes("addEventListener('toggle'") && WORKSPACE_SCRIPT.includes("setAttribute('aria-expanded'"));
});

test('S7: cleanFrom accepts only the list, the Archive or a receipt, as a relative address', () => {
  assert.deepEqual(cleanFrom('receipt?id=abc%2F1&group=review&q=milk&junk=1'), { to: 'receipt', qs: '&id=abc%2F1&q=milk&group=review', value: 'receipt?id=abc%2F1&q=milk&group=review' });
  assert.deepEqual(cleanFrom('archived?sort=store&dir=desc'), { to: 'archived', qs: '&sort=store&dir=desc', value: 'archived?sort=store&dir=desc' });
  assert.deepEqual(cleanFrom('./?activity=1'), { to: './', qs: '&activity=1', value: './?activity=1' });
  assert.deepEqual(cleanFrom('./'), { to: './', qs: '', value: './' });
  for (const bad of ['', null, undefined, '//evil.example/x', 'https://evil.example/', 'http://evil.example/receipt?id=1', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', 'settings?section=x', '../receipt?id=1', 'receipt', 'receipt?id=', `receipt?id=${'x'.repeat(2001)}`, 'receipt?id=1\n', 'x'.repeat(3000)]) {
    const got = cleanFrom(bad);
    assert.ok(got === null || /^(?:\.\/|archived|receipt)(?:\?|$)/.test(got.value), `${String(bad).slice(0, 30)}: ${JSON.stringify(got)}`);
  }
  for (const bad of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', 'settings?section=x', 'receipt', 'receipt?id=', '/\\evil.example']) assert.equal(cleanFrom(bad), null, bad);
});

test('S7: with a `from`, Done and every link and form on the Settings pages carry it; without one nothing changes', () => {
  const from = cleanFrom('receipt?id=abc&group=review');
  const html = bare(withFrame({ from }, () => settingsPage(fixture.settingsData, 'k', '', undefined, { section: 'everyday' })));
  assert.match(html, /data-settings-done href="receipt\?key=k&#38;id=abc&#38;group=review">Done · back to the receipt<\/a>/);
  assert.match(html, /<a class="settings-back" data-navigate href="settings\?key=k&amp;from=receipt%3Fid%3Dabc%26group%3Dreview">/);
  assert.match(html, /<form method="post" action="settings-save\?key=k&amp;from=receipt%3Fid%3Dabc%26group%3Dreview"/);
  const overview = bare(withFrame({ from }, () => settingsPage(fixture.settingsData, 'k', '')));
  assert.match(overview, /href="categories\?key=k&amp;from=receipt%3Fid%3Dabc%26group%3Dreview"/);
  assert.match(overview, /href="settings\?key=k&amp;section=appearance&amp;from=receipt/);
  const plain = bare(settingsPage(fixture.settingsData, 'k', '', undefined, { section: 'everyday' }));
  assert.match(plain, /data-settings-done href=".\/\?key=k">Done · back to Inbox<\/a>/);
  assert.doesNotMatch(plain, /from=/);
  const lists = bare(withFrame({ from }, () => categoriesPage({ groups: [], excluded: { groups: [], categories: [] }, categories: [] }, 'k', '')));
  assert.match(lists, /data-settings-done href="receipt\?key=k&#38;id=abc&#38;group=review">Done/);
});

test('S7: a Settings save redirects back to its section with the cleaned `from`, and drops a bad one', async () => {
  await withServer(async (base) => {
    const save = (from) => fetch(`${base}/settings-reset?key=secret${from}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'section=everyday&key=x', redirect: 'manual' });
    const good = (await save(`&from=${encodeURIComponent('receipt?id=abc&group=review')}`)).headers.get('location');
    assert.match(good, /^\.\/settings\?key=secret&section=everyday&from=receipt%3Fid%3Dabc%26group%3Dreview/, good);
    const bad = (await save(`&from=${encodeURIComponent('https://evil.example/')}`)).headers.get('location');
    assert.doesNotMatch(bad, /from=|evil/);
    const page = await (await fetch(`${base}/settings?key=secret&section=everyday&from=${encodeURIComponent('archived?sort=store')}`)).text();
    assert.match(bare(page), /data-settings-done href="archived\?key=secret&#38;sort=store">Done · back to Archive<\/a>/);
    const evil = await (await fetch(`${base}/settings?key=secret&section=everyday&from=${encodeURIComponent('//evil.example/')}`)).text();
    assert.match(bare(evil), /data-settings-done href=".\/\?key=secret">Done · back to Inbox<\/a>/);
  });
});

test('S7: the script adds `from` to a link into Settings from the page you were on, or from the Settings page you are on', () => {
  assert.ok(WORKSPACE_SCRIPT.includes('SETTINGS_PATH') && WORKSPACE_SCRIPT.includes('withFrom(url)'));
  assert.ok(WORKSPACE_SCRIPT.includes('fromOf(new URL(outside.url))'), 'from the Settings page you are on');
});

test('F3: Done always names where it goes, printed by the server; the overview shows it only when Settings was opened from a receipt', () => {
  const settings = (from, section) => bare(withFrame({ from: cleanFrom(from) }, () => settingsPage(fixture.settingsData, 'k', '', undefined, { section })));
  assert.match(settings('', 'everyday'), />Done · back to Inbox<\/a>/);
  assert.match(settings('archived?sort=store', 'everyday'), />Done · back to Archive<\/a>/);
  assert.match(settings('receipt?id=abc', 'everyday'), />Done · back to the receipt<\/a>/);
  assert.doesNotMatch(settings('', undefined), /class="settings-done"/);
  assert.doesNotMatch(settings('archived?sort=store', undefined), /class="settings-done"/);
  assert.match(settings('receipt?id=abc', undefined), /class="settings-done"><a class="btn plain" data-navigate data-settings-done href="receipt\?key=k&#38;id=abc">Done · back to the receipt<\/a>/);
});
