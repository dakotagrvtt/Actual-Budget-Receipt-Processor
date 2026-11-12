// Public fictional receipts for exercising the shipped page renderer. No service calls.
import './support.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { rememberCategories } from '../src/known-categories.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';
import { receiptNav, statusPage, cleanNav } from '../src/panel-status.js';
import { settingsPage, SETTINGS_SECTIONS } from '../src/panel-settings-page.js';
import { keywordsPage } from '../src/panel-lists.js';
import { SETTINGS, SECTIONS } from '../src/web-settings-schema.js';

export async function workspaceFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-workspace-'));
  Object.assign(config, { statePath: path.join(dir, 'state.json'), categoryNotesPath: path.join(dir, 'notes.json'), settingsPath: path.join(dir, 'settings.json'), dryRun: false, envDryRun: false, cashAccount: 'Cash wallet' });
  config.learning.dir = path.join(dir, 'memory'); config.trigger.token = 'fixture-key'; config.trigger.timeZone = 'UTC';
  const categories = ['Groceries', 'Kitchen & storage', 'Household supplies', 'Gifts'].map((n) => ({ group: 'Daily', label: `Daily / ${n}` }));
  await rememberCategories(categories);
  const items = [
    ['Milk, 1 gallon', 4.18, 'Groceries'], ['Pasta, 2-pack', 5.98, 'Groceries'], ['Rice, 5 lb', 9.49, 'Groceries'],
    ['Food storage containers', 8, 'Kitchen & storage'], ['Dish soap', 3.79, 'Household supplies'],
  ].map(([description, amount, cat], i) => ({ description, plain: description, amount, category: `Daily / ${cat}`, ...(i === 3 ? { unsureGuess: true, reason: 'Groceries is also possible.' } : {}) }));
  const summary = { file: 'riverside.jpg', receipt: { merchant: 'Riverside Market', date: '2026-11-08', subtotal: 31.44, tax: .71, total: 32.15, payment_method: 'card', currency: 'USD', items }, transaction: { id: 't1', account: 'Checking', date: '2026-11-08', payee: 'RIVERSIDE MARKET', amount: '32.15' }, plan: { applied: true, action: 'split', parts: [{ category: 'Daily / Groceries', amount: '20.09' }, { category: 'Daily / Kitchen & storage', amount: '8.18' }, { category: 'Daily / Household supplies', amount: '3.88' }] }, problems: ['Check food storage containers.'] };
  const id = `${config.nextcloud.inbox}/riverside.jpg@1`;
  const entry = { key: id, done: true, result: 'split+review', applied: { txnId: 't1', action: 'split', at: '2026-11-09T10:00:00Z' }, filedAs: `${config.nextcloud.review}/riverside.jpg`, file: 'riverside.jpg', at: '2026-11-09T10:00:00Z', card: { store: 'Riverside Market', date: '2026-11-08', total: 32.15 } };
  const waiting = { key: `${config.nextcloud.inbox}/meridian.jpg@1`, file: 'meridian.jpg', done: false, waiting: { nextCheck: '2026-11-10T10:00:00Z', until: '2026-11-19T10:00:00Z' }, card: { store: 'Meridian Fuel', date: '2026-11-09', total: 42.3 }, at: '2026-11-09T08:20:00Z' };
  const filed = { ...entry, key: `${config.nextcloud.inbox}/pharmacy.jpg@1`, file: 'pharmacy.jpg', result: 'split', card: { store: 'Park Lane Pharmacy', date: '2026-11-06', total: 30.81 } };
  const recent = [entry, waiting, filed];
  const view = (query = new URLSearchParams()) => ({ id, entry, summary, name: 'riverside.jpg', pages: 1, pdf: false, photoNote: '', summaryNote: '', fix: editorFor({ id, entry, summary, query, seen: null }), seen: null });
  const nav = receiptNav(recent, id, cleanNav(new URLSearchParams()));
  const renderReceipt = (query) => receiptPage(view(query), 'fixture-key', '', query ? receiptNav(recent, id, cleanNav(query)) : nav);
  const query = new URLSearchParams({ preview: '1', rid: view().fix.readingId });
  items.forEach((it, i) => { query.set(`c${i}`, it.category); query.set(`a${i}`, it.amount.toFixed(2)); });
  query.set('c0', 'Daily / Gifts');
  const changedPreview = renderReceipt(query);
  const unchangedQuery = new URLSearchParams(query); unchangedQuery.set('c0', items[0].category);
  const unchangedPreview = renderReceipt(unchangedQuery);
  const savedSummary = structuredClone(summary), savedEntry = structuredClone(entry);
  savedSummary.pageFix = { items: { 0: 'Daily / Gifts' } }; savedSummary.plan.parts = view(query).fix.preview.parts;
  savedEntry.result = 'split'; savedEntry.reviewed = true; savedEntry.fixedOnPage = { at: '2026-11-09T11:00:00Z' };
  const savedView = { ...view(), entry: savedEntry, summary: savedSummary, fix: editorFor({ id, entry: savedEntry, summary: savedSummary, query: new URLSearchParams(), seen: null }) };
  const savedHtml = receiptPage(savedView, 'fixture-key', 'Saved to Actual. Moved to Filed.', nav);
  const checkedEntry = { ...entry, result: 'split', reviewed: true, fixedOnPage: { at: '2026-11-09T11:00:00Z', markOnly: true } };
  const checkedView = { ...view(), entry: checkedEntry, fix: editorFor({ id, entry: checkedEntry, summary, query: new URLSearchParams(), seen: null }) };
  const checkedHtml = receiptPage(checkedView, 'fixture-key', 'Moved to Filed. Nothing changed in Actual.', nav);
  const otherSummary = { ...structuredClone(summary), receipt: { ...summary.receipt, merchant: 'Park Lane Pharmacy', date: '2026-11-06', total: 30.81, subtotal: 30.81, tax: 0, items: [{ description: 'ALLERGY TABLETS', plain: 'Allergy tablets', amount: 30.81, category: 'Daily / Gifts' }] }, transaction: { ...summary.transaction, id: 't2', date: '2026-11-06', amount: '30.81' }, plan: { applied: true, action: 'categorize', parts: [{ category: 'Daily / Gifts', amount: '30.81' }] }, problems: [] };
  const otherEntry = { ...filed, applied: { ...filed.applied, txnId: 't2', action: 'categorize' } };
  const otherView = { id: filed.key, entry: otherEntry, summary: otherSummary, name: 'pharmacy.jpg', pages: 0, pdf: false, fix: editorFor({ id: filed.key, entry: otherEntry, summary: otherSummary, query: new URLSearchParams(), seen: null }) };
  const renderOther = (query = new URLSearchParams()) => receiptPage(otherView, 'fixture-key', '', receiptNav(recent, filed.key, cleanNav(query)));
  const otherHtml = renderOther();
  const ruleHtml = keywordsPage({ keywords: [], categories: categories.map((c) => c.label), mode: 'mixed' }, 'fixture-key', '');
  const ruleSavedHtml = keywordsPage({ keywords: [], categories: categories.map((c) => c.label), mode: 'mixed' }, 'fixture-key', 'Rule saved.');
  const data = { sections: SECTIONS.map((sec) => ({ ...sec, settings: SETTINGS.filter((s) => s.section === sec.id).map((s) => ({ ...s, value: s.key === 'CASH_ACCOUNT' ? 'Cash wallet' : s.type === 'secret' ? '' : s.default, source: 'default', isSet: s.type === 'secret' && s.required, choices: s.type === 'account' ? ['Cash wallet', 'Checking'] : undefined })) })), exists: false, ignored: [] };
  // P9: settingsHtml is the overview; a section page is renderSettings(values, notice, section); settingsSectionsHtml joins every section page.
  const renderSettings = (values = {}, notice = '', section) => {
    const next = { ...data, sections: data.sections.map((section) => ({ ...section, settings: section.settings.map((setting) => ({ ...setting, ...(Object.hasOwn(values, setting.key) ? { value: values[setting.key], source: 'page' } : {}) })) })) };
    return settingsPage(next, 'fixture-key', notice, undefined, { section });
  };
  // Test harnesses only: every section page's content in one page, to check all 54 settings and every save form together. No such page ships.
  const renderAllSettings = (values = {}, notice = '') => {
    const pages = SETTINGS_SECTIONS.map((section, i) => renderSettings(values, i ? '' : notice, section));
    const inner = pages.map((page) => page.match(/<main\b[^>]*>([^]*?)<\/main>/)[1]).join('');
    return pages[0].replace(/(<main\b[^>]*>)[^]*?(<\/main>)/, (_, open, close) => open + inner + close);
  };
  return { dir, id, renderAllSettings, entry, summary, recent, view, renderReceipt, changedPreview, unchangedPreview, savedHtml, checkedHtml, otherHtml, renderOther, ruleHtml, ruleSavedHtml, settingsData: data, renderSettings, settingsHtml: settingsPage(data, 'fixture-key', ''), settingsSectionsHtml: SETTINGS_SECTIONS.map((section) => settingsPage(data, 'fixture-key', '', undefined, { section })).join('\n'), overviewHtml: statusPage({ dryRun: false, heartbeat: '2026-11-09T10:00:00Z', recent }, 'fixture-key', ''), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
