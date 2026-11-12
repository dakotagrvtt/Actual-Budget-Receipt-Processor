// Settings rendering contracts: grouping must never drop or duplicate a real setting.
import './support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, SECTIONS } from '../src/web-settings-schema.js';
import { settingsPage, SETTINGS_SECTIONS, sectionOfSetting } from '../src/panel-settings-page.js';

const EVERYDAY = new Set(['CASH_ACCOUNT', 'SPLIT_TRANSACTIONS', 'ARCHIVE_AFTER_DAYS', 'LEARNING']);
const defaults = {
  ACTUAL_SERVER_URL: 'https://actual.invalid', ACTUAL_SYNC_ID: '1a2b3c4d-1234-5678-9abc-def012345678',
  NEXTCLOUD_URL: 'https://cloud.invalid', NEXTCLOUD_USER: 'fixture', CASH_ACCOUNT: 'Cash wallet',
};
const fixture = () => ({
  exists: true,
  sections: SECTIONS.map((sec) => ({ ...sec, settings: SETTINGS.filter((s) => s.section === sec.id).map((s) => ({
    ...s, value: defaults[s.key] ?? s.default, source: 'default', isSet: s.type === 'secret',
    choices: s.type === 'account' ? ['Cash wallet', 'Checking'] : undefined,
  })) })),
});
const setting = (data, key) => data.sections.flatMap((s) => s.settings).find((s) => s.key === key);
const saveForms = (html) => [...html.matchAll(/<form\b[^>]*action="settings-save\?key=fixture"[^>]*>([^]*?)<\/form>/g)].map((m) => m[1]);
// P9: the Settings tab is an overview plus one page per section. The contracts below hold for the whole tab: every page, joined.
const everyPage = (data, notice = '') => [undefined, ...SETTINGS_SECTIONS].map((section) => settingsPage(data, 'fixture', notice, undefined, { section })).join('\n');
const groupFor = (s) => EVERYDAY.has(s.key) ? 'everyday' : s.section === 'connections' ? 'connections' : s.advanced ? `advanced:${s.section}` : 'preferences';

test('all 55 settings have one labelled control and one intended save form', () => {
  const data = fixture(), html = everyPage(data);
  assert.equal(SETTINGS.length, 55);
  const ids = [...html.matchAll(/\bid="s-([A-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, SETTINGS.length);
  assert.equal(new Set(ids).size, SETTINGS.length);
  assert.deepEqual(new Set(ids), new Set(SETTINGS.map((s) => s.key)));
  const forms = saveForms(html);
  for (const s of SETTINGS) {
    assert.match(html, new RegExp(`for="s-${s.key}"`), `${s.key} is labelled`);
    const owners = forms.filter((f) => f.includes(`id="s-${s.key}"`));
    assert.equal(owners.length, 1, `${s.key} has exactly one save owner`);
    const peers = SETTINGS.filter((p) => owners[0].includes(`id="s-${p.key}"`));
    assert.ok(peers.every((p) => groupFor(p) === groupFor(s)), `${s.key} only submits its own UI group`);
  }
  const everyday = forms.find((f) => f.includes('value="everyday"'));
  assert.deepEqual(new Set(SETTINGS.filter((s) => everyday.includes(`id="s-${s.key}"`)).map((s) => s.key)), EVERYDAY);
  assert.match(html, /id="s-CASH_ACCOUNT"[^>]*data-settings-autofocus/);
  assert.ok(html.indexOf('id="s-CASH_ACCOUNT"') < html.indexOf('id="settings-preferences"'));
  assert.match(html, /<option value="record">Learn only<\/option>/);
});

test('an advanced validation error lands on the Advanced page, opens only its group and marks its control', () => {
  const data = fixture();
  const html = settingsPage(data, 'fixture', 'Days the charge may post after the receipt: use a whole number. Nothing was saved.');
  assert.match(html, /data-settings-section="advanced"/);
  assert.match(html, /<section class="settings-advanced" id="advanced"/);
  assert.doesNotMatch(html, /id="settings-advanced-(?!matching)[a-z]+" open/);
  assert.match(html, /id="settings-advanced-matching" open/);
  assert.doesNotMatch(html, /id="settings-connections" open/);
  assert.match(html, /id="s-MATCH_DAYS" aria-invalid="true"/);
  assert.match(html, /href="#s-MATCH_DAYS"/);
  assert.match(html, /role="alert"/);
});

test('everyday errors stay visible without opening unrelated settings', () => {
  const html = settingsPage(fixture(), 'fixture', 'Cash purchases go to: choose an open account.');
  assert.match(html, /id="s-CASH_ACCOUNT" aria-invalid="true"/);
  assert.match(html, /href="#s-CASH_ACCOUNT"/);
  assert.doesNotMatch(html, /id="advanced" open|id="settings-preferences" open|id="settings-connections" open/);
});

test('connections keep password secrecy, account choices, folder editing and test-failure override', () => {
  const data = fixture();
  setting(data, 'ACTUAL_PASSWORD').value = 'MUST-NOT-LEAVE-THE-SERVER';
  setting(data, 'ACTUAL_PASSWORD').source = 'page';
  setting(data, 'CASH_ACCOUNT').value = 'Old <wallet>';
  const html = settingsPage(data, 'fixture', "Couldn't reach the Actual server. Nothing was saved.");
  assert.match(html, /data-settings-section="connections"/, 'a failed connection test lands on Connections');
  assert.match(html, /<section class="settings-card settings-panel" id="settings-connections"/);
  assert.match(html, /name="anyway" value="yes"/);
  assert.match(html, /<legend>Actual Budget<\/legend>/);
  assert.match(html, /<legend>Nextcloud<\/legend>/);
  assert.match(html, /<legend>Receipt folders<\/legend>/);
  assert.match(html, /name="ACTUAL_PASSWORD"[^>]*value=""/);
  assert.doesNotMatch(html, /MUST-NOT-LEAVE-THE-SERVER/);
  assert.match(html, /name="reset" value="ACTUAL_PASSWORD"[^>]*formaction="settings-reset\?key=fixture"/);
  const everyday = settingsPage(data, 'fixture', '', undefined, { section: 'everyday' }); // the cash account lives on Everyday (P9)
  assert.match(everyday, /value="Old &#60;wallet&#62;" selected/);
  assert.match(everyday, /not in the list from the last check/);
  for (const key of ['RECEIPTS_INBOX', 'RECEIPTS_PROCESSED', 'RECEIPTS_REVIEW', 'RECEIPTS_ARCHIVE']) assert.match(html, new RegExp(`name="${key}"`));
});

test('legacy settings anchors and all secondary configuration paths remain available', () => {
  const html = everyPage(fixture());
  for (const id of ['settings-matching', 'settings-behaviour', 'settings-categorizing', 'settings-holidays', 'settings-connections', 'advanced']) assert.match(html, new RegExp(`id="${id}"`));
  for (const route of ['keywords', 'categories', 'learned']) assert.match(html, new RegExp(`href="${route}\\?key=fixture"`));
  assert.match(html, /Save even if the connection test fails/);
  assert.match(html, /name="confirm" value="yes" id="confirm-reset" required/);
  assert.match(html, /Set in \.env only/);
  assert.doesNotMatch(html, /name="TRIGGER_TOKEN"|name="DRY_RUN"|name="ACTUAL_API_VERSION"/);
});

test('damaged settings disable normal writes and keep the recovery reset enabled', () => {
  const data = fixture(); data.damaged = 'Invalid JSON';
  setting(data, 'MATCH_DAYS').source = 'page';
  const html = everyPage(data);
  assert.ok(saveForms(html).length > 2);
  for (const form of saveForms(html)) {
    const buttons = [...form.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length);
    assert.ok(buttons.every((b) => /\bdisabled\b/.test(b)));
  }
  const reset = html.match(/<form[^>]*action="settings-reset-all\?key=fixture"[^>]*>([^]*?)<\/form>/)[1];
  assert.match(reset, /<button class="danger">Reset all to setup values/);
  assert.doesNotMatch(reset, /\bdisabled\b/);
});

test('every settings group defaults to Save even when saved overrides add earlier reset buttons', () => {
  for (const damaged of [false, true]) {
    const data = fixture();
    data.damaged = damaged ? 'Invalid JSON' : undefined;
    data.sections.forEach((section) => section.settings.forEach((s) => { s.source = 'page'; }));
    const forms = saveForms(everyPage(data));
    assert.ok(forms.length > 2, 'covers everyday, preferences, connections and advanced groups');
    for (const form of forms) {
      assert.match(form, /name="reset"/, 'the fixture exposes the competing setup-value button');
      const submitters = [...form.matchAll(/<(?:button|input)\b[^>]*>/g)].map((m) => m[0]).filter((tag) => {
        const type = tag.match(/\btype="([^"]+)"/)?.[1];
        return tag.startsWith('<button') ? !['button', 'reset'].includes(type) : ['submit', 'image'].includes(type);
      });
      const first = submitters[0];
      assert.ok(first, 'settings group has a default submitter');
      assert.doesNotMatch(first, /\bformaction=|\bname="reset"/, 'implicit submission saves the group instead of resetting a setting');
      assert.equal(/\bdisabled\b/.test(first), damaged, 'default Save follows damaged-file write protection');
      assert.ok(form.indexOf(first) < form.indexOf('name="reset"'), 'Save precedes every setting reset in native form order');
    }
  }
});

// ---- P9: the overview and the section pages ----

test('the overview: a card with a chevron per section, the rules and learning pages, no setting controls, and Done', () => {
  const html = settingsPage(fixture(), 'fixture', '');
  assert.match(html, /<h2 class="settings-heading">Settings<\/h2>/);
  const cards = [...html.matchAll(/<a class="settings-link" data-navigate href="([^"]+)">[^]*?<\/a>/g)];
  assert.deepEqual(cards.map((m) => m[1].replaceAll('&amp;', '&')), ['settings?key=fixture&section=everyday', 'settings?key=fixture&section=preferences', 'categories?key=fixture', 'keywords?key=fixture', 'learned?key=fixture', 'settings?key=fixture&section=connections', 'settings?key=fixture&section=appearance', 'settings?key=fixture&section=advanced']);
  for (const [card] of cards) assert.match(card, /<svg class="chev"[^>]*aria-hidden="true">/);
  assert.doesNotMatch(html, /data-setting=|action="settings-save/, 'the overview holds no settings');
  assert.doesNotMatch(html, /class="settings-done"/, 'F3: no Done on the overview (the tab bar leads back)');
  assert.match(html, /Appearance/);
  assert.doesNotMatch(html, /privacy\?key/, 'Privacy only with the hosted decider');
});

test('each section page: ← Settings, its own settings in its own save form(s) with its section value, and Done', () => {
  const data = fixture();
  const seen = [];
  for (const section of SETTINGS_SECTIONS) {
    const html = settingsPage(data, 'fixture', '', undefined, { section });
    assert.match(html, /<a class="settings-back" data-navigate href="settings\?key=fixture">&larr; Settings<\/a>/, section);
    assert.match(html, /data-settings-done href="\.\/\?key=fixture">Done · back to Inbox<\/a>/, section);
    assert.match(html, new RegExp(`data-settings-section="${section}"`));
    const keys = [...html.matchAll(/data-setting="([A-Z0-9_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), SETTINGS.filter((s) => sectionOfSetting(s) === section).map((s) => s.key).sort(), `${section}: exactly its settings`);
    for (const form of saveForms(html)) assert.match(form, new RegExp(`<input type="hidden" name="section" value="${section}">`), `${section}: saves come back here`);
    seen.push(...keys);
  }
  assert.equal(seen.length, 55);
  assert.equal(new Set(seen).size, 55, 'every setting on exactly one section page');
  assert.match(settingsPage({ ...data, exists: true }, 'fixture', '', undefined, { section: 'advanced' }), /action="settings-reset-all\?key=fixture"><div class="check">[^]*?<input type="hidden" name="section" value="advanced">/, 'Reset all comes back to Advanced');
});

test('an unknown section shows the overview; the damaged and reload banners show on every Settings page', () => {
  for (const section of ['', 'evil', '../x', 'Everyday']) assert.match(settingsPage(fixture(), 'fixture', '', undefined, { section }), /<ul class="settings-cards">/, section);
  const data = { ...fixture(), damaged: 'Invalid JSON', reloadError: 'MATCH_DAYS must be a number' };
  for (const section of [undefined, ...SETTINGS_SECTIONS]) {
    const html = settingsPage(data, 'fixture', '', undefined, { section });
    assert.match(html, /The settings file is damaged/, String(section));
    assert.match(html, /The last settings reload failed/, String(section));
  }
});
