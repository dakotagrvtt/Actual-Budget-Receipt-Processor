// "Open in Actual" links: the setting's validation and default, the account deep link vs the base, every placement, and escaping.
import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { layout } from '../src/panel-layout.js';
import { settingsPage, SETTINGS_SECTIONS } from '../src/panel-settings-page.js';
import { config, buildConfig, cleanLinkBase } from '../src/config.js';
import { SETTINGS_BY_KEY, normalizeValue, SettingError } from '../src/web-settings-schema.js';
import { rememberAccounts } from '../src/known-accounts.js';
import { actualUrl, accountIdOf } from '../src/actual-link.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const BASE = 'https://actual.example.test';
const ID = '5a1b2c3d-1111-4222-8333-944455556666';
const bare = (html) => html.replace(/<(style|script)>[^]*?<\/\1>/g, '');
const def = SETTINGS_BY_KEY.get('ACTUAL_LINK_URL');
const saved = { ...config.actual };
const setBase = (v) => { config.actual.linkURL = v; };
const reset = () => { Object.assign(config.actual, saved); };
const links = (html) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes('target="_blank"'));

test('the setting accepts http and https, strips trailing slashes and rebuilds from origin and path', () => {
  assert.equal(normalizeValue(def, 'https://actual.example.test/'), BASE);
  assert.equal(normalizeValue(def, 'http://actual.example.test:5006///'), 'http://actual.example.test:5006');
  assert.equal(normalizeValue(def, 'https://actual.example.test/budget/?a=1#x'), `${BASE}/budget`);
  assert.equal(normalizeValue(def, 'actual.example.test'), BASE, 'no scheme means https');
  assert.equal(normalizeValue(def, ''), '', 'empty means use the server address');
});

test('the setting rejects javascript:, data:, ftp:, user info and garbage', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://actual.example.test', 'https://user:pw@actual.example.test', 'not a url', 'http://', '//', 'file:///etc/passwd']) {
    assert.throws(() => normalizeValue(def, bad), SettingError, bad);
  }
});

test('cleanLinkBase refuses anything that is not a plain http(s) address', () => {
  for (const bad of ['', '   ', 'javascript:alert(1)', 'data:text/html,x', 'ftp://h.example.test', 'https://u:p@h.example.test', 'https://h.example.test/\\x', undefined]) assert.equal(cleanLinkBase(bad), '', String(bad));
  assert.equal(cleanLinkBase(' https://actual.example.test/a/b/ '), `${BASE}/a/b`);
  assert.equal(cleanLinkBase('HTTP://Actual.Example.test:80/'), 'http://actual.example.test');
});

test('the address defaults to the Actual server address; a saved one wins; an unusable one falls back', () => {
  const env = { ACTUAL_SERVER_URL: BASE, ACTUAL_PASSWORD: 'x', ACTUAL_SYNC_ID: ID, NEXTCLOUD_URL: 'https://cloud.example.test', NEXTCLOUD_USER: 'u', NEXTCLOUD_APP_PASSWORD: 'p' };
  assert.equal(buildConfig(env, { quiet: true }).actual.linkURL, BASE);
  assert.equal(buildConfig({ ...env, ACTUAL_LINK_URL: 'https://link.example.test/' }, { quiet: true }).actual.linkURL, 'https://link.example.test');
  assert.equal(buildConfig({ ...env, ACTUAL_LINK_URL: 'javascript:alert(1)' }, { quiet: true }).actual.linkURL, BASE);
  assert.equal(buildConfig({ ...env, ACTUAL_LINK_URL: '' }, { quiet: true }).actual.linkURL, BASE);
});

test('the setting is on the Connections page under Actual Budget, with the usual reset', () => {
  assert.equal(def.section, 'connections');
  const html = fixture.settingsSectionsHtml;
  assert.match(html, /for="s-ACTUAL_LINK_URL">Actual address for links<\/label>/);
  assert.match(html, /name="ACTUAL_LINK_URL" id="s-ACTUAL_LINK_URL"/);
});

test('an account link needs a real id: the page link uses the id of the one account with that name', async () => {
  reset(); setBase(BASE);
  await rememberAccounts([{ id: ID, name: 'Checking' }, { id: 'a-name-not-an-id', name: 'Savings' }, { id: ID.replace('5a', '6b'), name: 'Twin' }, { id: ID.replace('5a', '7c'), name: 'Twin' }]);
  assert.equal(accountIdOf('Checking'), ID);
  assert.equal(actualUrl('Checking'), `${BASE}/accounts/${ID}`);
  assert.equal(actualUrl('Savings'), `${BASE}/`, 'not an id: base');
  assert.equal(actualUrl('Twin'), `${BASE}/`, 'two accounts with the name: base');
  assert.equal(actualUrl('Nowhere'), `${BASE}/`);
  assert.equal(actualUrl(''), `${BASE}/`);
  // only the base and the account id ever appear: never the sync id, a password or a budget id
  assert.match(actualUrl('Checking'), /^https:\/\/actual\.example\.test\/accounts\/[0-9a-f-]{36}$/);
});

test('placements: receipt meta line, banners (changed, waiting, cash), top bar and Settings', async () => {
  reset(); setBase(BASE);
  await rememberAccounts([{ id: ID, name: 'Checking' }, { id: ID.replace('5a', '6b'), name: 'Cash wallet' }]);
  const rel = 'target="_blank" rel="noopener noreferrer"';
  // meta line: the account name is the link
  const html = bare(fixture.renderReceipt());
  assert.match(html, new RegExp(`<p class="workspace-meta">[^<]*· <a class="actual-link" href="${BASE}/accounts/${ID}" ${rel}>Checking &#8599;</a></p>`));
  // top bar: on every page
  assert.match(html, new RegExp(`<a class="header-actual" href="${BASE}/" ${rel}>Actual &#8599;</a><details class="header-add">`));
  // Changed in Actual: the charge's account
  const v = fixture.view();
  const locked = bare(receiptPage({ ...v, fix: { ...v.fix, locked: true } }, 'k', ''));
  const lockedBanner = locked.match(/<section class="status-banner[^]*?<\/section>/)[0];
  assert.match(lockedBanner, /Changed in Actual/);
  assert.ok(lockedBanner.includes(`href="${BASE}/accounts/${ID}"`) && lockedBanner.includes('Open in Actual &#8599;'));
  // Cash: the cash account when its id is known
  const cash = bare(receiptPage({ ...v, fix: { ...v.fix, kind: 'cash', cash: { accounts: ['Cash wallet'], account: 'Cash wallet' } } }, 'k', ''));
  assert.ok(cash.match(/<section class="status-banner[^]*?<\/section>/)[0].includes(`href="${BASE}/accounts/${ID.replace('5a', '6b')}"`));
  const cashUnknown = bare(receiptPage({ ...v, fix: { ...v.fix, kind: 'cash', cash: { accounts: [], account: 'Mystery' } } }, 'k', ''));
  assert.ok(cashUnknown.match(/<section class="status-banner[^]*?<\/section>/)[0].includes(`href="${BASE}/"`), 'unknown cash account: base');
  // Waiting: the base address, beside Find charge
  const waitingEntry = { waiting: { nextCheck: '2099-01-01T00:00:00Z', reason: 'none yet' }, at: '2026-11-08T12:00:00Z' };
  const waiting = bare(receiptPage({ id: v.id, name: 'x.jpg', entry: waitingEntry, pages: 1, summary: { receipt: v.summary.receipt, problems: [] }, resolution: { values: { merchant: 'A', date: '2026-10-19', total: '1.00', payment_method: 'card' }, window: { start: '2026-10-12', end: '2026-10-26' }, candidates: [] } }, 'k', ''));
  const wb = waiting.match(/<section class="status-banner[^]*?<\/section>/)[0];
  assert.ok(wb.indexOf('Find charge or mark as cash') < wb.indexOf(`href="${BASE}/"`), 'link sits after Find charge');
  // Settings -> Connections, next to the Actual settings
  const conn = bare(settingsPage(fixture.settingsData, 'k', '', undefined, { section: 'connections' }));
  assert.match(conn, new RegExp(`<legend>Actual Budget</legend><p class="small connection-actual"><a class="actual-link" href="${BASE}/" ${rel}>Open Actual &#8599;</a></p>`));
  // every link is a new-tab, noopener link
  for (const a of links(html + locked + cash + waiting + conn)) assert.ok(a.includes(rel), a);
  reset();
});

test('no links anywhere when the effective address is invalid or empty', () => {
  for (const bad of ['', 'javascript:alert(1)', 'ftp://actual.example.test', undefined]) {
    setBase(bad);
    const v = fixture.view();
    const pages = [fixture.renderReceipt(), receiptPage({ ...v, fix: { ...v.fix, locked: true } }, 'k', ''), receiptPage({ ...v, fix: { ...v.fix, kind: 'cash', cash: { accounts: [], account: 'Cash wallet' } } }, 'k', ''), settingsPage(fixture.settingsData, 'k', '', undefined, { section: 'connections' }), layout({ active: 'status', key: 'k', body: '<p>x</p>' })].map(bare);
    for (const html of pages) {
      assert.deepEqual(links(html), [], String(bad));
      assert.doesNotMatch(html, /actual-link|header-actual|&#8599;/, String(bad));
    }
    assert.match(pages[0], /<p class="workspace-meta">[^<]*· Checking<\/p>/, 'the account name is still shown');
  }
  reset();
});

test('escaping: the address and the account id cannot break out of the attribute', async () => {
  reset();
  setBase('https://actual.example.test/a"b<c>&d');
  const html = layout({ active: 'status', key: 'k', body: '<p>x</p>' });
  const a = links(bare(html))[0];
  assert.ok(a, 'a link is rendered');
  assert.doesNotMatch(a, /href="[^"]*[<>][^"]*"/, 'no raw angle bracket in the attribute');
  assert.equal((a.match(/href="/g) ?? []).length, 1);
  assert.doesNotMatch(html.replace(/<(style|script)>[^]*?<\/\1>/g, ''), /a"b</);
  // an account id with markup in it is not an id: base link
  setBase(BASE);
  await rememberAccounts([{ id: '"><script>alert(1)</script>', name: 'Checking' }]);
  assert.equal(actualUrl('Checking'), `${BASE}/`);
  // an account name with markup in the meta line is escaped
  const v = fixture.view();
  v.summary = { ...v.summary, transaction: { ...v.summary.transaction, account: '<b onclick="x">Check</b>' } };
  const meta = bare(receiptPage(v, 'k', '')).match(/<p class="workspace-meta">[^]*?<\/p>/)[0];
  assert.doesNotMatch(meta, /<b/);
  assert.match(meta, /&#60;b onclick=&#34;x&#34;&#62;/);
  reset();
});

test('the page stays within the CSP shape: one script, one style, no inline style or handlers', () => {
  setBase(BASE);
  const html = fixture.renderReceipt();
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.equal((html.match(/<script>/g) ?? []).length, 1);
  assert.doesNotMatch(bare(html), /\sstyle=|\son[a-z]+=/);
  reset();
});
