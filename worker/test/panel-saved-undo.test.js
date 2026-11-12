// P8: the green "Saved · Undo" banner (the Undo of the last save, offered again for the rest of its 15 minutes), the list row while it lasts,
// the inline cash confirmation (the server's own forms, shown in place), Check now without leaving the receipt, and "Looks right" on a
// charge changed in Actual. Fictional receipts only; pages are rendered directly, no network except the local test server.
import './support.js';
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspaceFixtures } from './workspace-fixtures.js';
import { config } from '../src/config.js';
import { receiptPage, receiptUndo } from '../src/panel-receipt-page.js';
import { queueLabel } from '../src/panel-queue.js';
import { undoForm } from '../src/panel-layout.js';
import { signUndo, checkUndo, UNDO_WINDOW_MS } from '../src/panel-actions.js';
import { editorFor } from '../src/receipt-fix.js';
import { makeServer } from '../src/trigger.js';
import { SCRIPT } from '../src/panel-script.js';
import { WORKSPACE_CSS } from '../src/panel-workspace-style.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
afterEach(() => { config.dryRun = false; });

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const savedEntry = (over = {}) => ({ ...fixture.entry, result: 'split', filedAs: `${config.nextcloud.processed}/riverside.jpg`, fixedOnPage: { at: ago(60000), kind: 'applied' }, ...over });
const viewWith = (entry) => ({ ...fixture.view(), entry, fix: editorFor({ id: fixture.id, entry, summary: fixture.summary, query: new URLSearchParams(), seen: null }) });
const banner = (html) => html.match(/<section class="status-banner[^]*?<\/section>/)[0];
const undoFields = (markup) => Object.fromEntries([...markup.match(/<form method="post" action="undo-receipt-fix\?key=fixture-key">([^]*?)<button/)[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));

test('receiptUndo: the link\'s Undo is copied exactly; coming back later it is signed again with ts = the save time (the window never grows)', () => {
  const entry = savedEntry();
  const at = entry.fixedOnPage.at;
  const link = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at }) };
  assert.deepEqual(receiptUndo({ id: fixture.id, entry }, link), { undo: link, fromLink: true });
  const again = receiptUndo({ id: fixture.id, entry }, null);
  assert.equal(again.fromLink, false);
  assert.deepEqual(again.undo, { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at }, Date.parse(at)) });
  assert.equal(again.undo.fields.ts, String(Date.parse(at)), 'stamped with the save time, not now');
  assert.deepEqual(Object.keys(again.undo.fields), ['id', 'at', 'ts', 'mac'], 'the same fields, in the same order, as the Undo handed out at the save');
  const form = new URLSearchParams(again.undo.fields);
  checkUndo('undo-receipt-fix', form); // valid now
  assert.throws(() => checkUndo('undo-receipt-fix', form, Date.parse(at) + UNDO_WINDOW_MS + 1), /older than 15 minutes/, 'and dead exactly 15 minutes after the save');
  const other = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: 'another', at }) };
  assert.equal(receiptUndo({ id: fixture.id, entry }, other).fromLink, false, 'another receipt\'s Undo is not used');
  const stale = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at: ago(120000) }) };
  assert.equal(receiptUndo({ id: fixture.id, entry }, stale).fromLink, false, 'an Undo of an earlier save is not used');
});

test('receiptUndo: none once the 15 minutes are over, after archiving or an archive that ended it, while the save is still recorded, in dry run', () => {
  const none = (entry) => receiptUndo({ id: fixture.id, entry }, null);
  assert.equal(none(savedEntry({ fixedOnPage: { at: ago(UNDO_WINDOW_MS + 1000), kind: 'applied' } })), null);
  assert.equal(none(savedEntry({ archived: { at: ago(1000) } })), null);
  assert.equal(none(savedEntry({ fixedOnPage: { at: ago(60000), kind: 'applied', undoEnded: ago(1000) } })), null);
  assert.equal(none(savedEntry({ fixedOnPage: { at: ago(60000), kind: 'applied', summaryFailed: true } })), null);
  assert.equal(none(savedEntry({ filing: { kind: 'page' } })), null);
  assert.equal(none({ ...fixture.entry }), null, 'no save from the page');
  assert.equal(receiptUndo({ id: `${fixture.id}${'x'.repeat(1000)}`, entry: savedEntry() }, null), null, 'an id too long for an Undo link');
  assert.equal(receiptUndo({ id: `dry:${fixture.id}`, entry: savedEntry() }, null), null);
  config.dryRun = true;
  assert.equal(none(savedEntry()), null, 'test mode never offers Undo');
});

test('the Saved banner: green, Undo with the exact fields, Archive beside it (Archiving ends Undo); the notice line does not repeat the Undo', () => {
  const entry = savedEntry();
  const link = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at: entry.fixedOnPage.at }) };
  const html = receiptPage(viewWith(entry), 'fixture-key', 'Saved riverside.jpg: split into Groceries 19.65.', null, link);
  const b = banner(html);
  assert.match(b, /class="status-banner workspace-status t-ok"/);
  assert.match(b, /<span class="ic ic-ok">/);
  assert.match(b, /<h2 class="status-lead" data-workspace-status>Saved to Actual · Undo available for 1[45] min<\/h2>/);
  assert.match(b, /Your categories are saved to the existing charge\. Archiving ends Undo\./);
  assert.ok(b.includes(undoForm(link, 'fixture-key')), 'the same form the notice line would have had, byte for byte');
  assert.deepEqual(undoFields(b), link.fields);
  assert.match(b, /<form method="post" action="archive\?key=fixture-key">[^]*?>Archive receipt<\/button><\/form>/);
  assert.doesNotMatch(b, /disabled/);
  assert.equal((html.match(/action="undo-receipt-fix/g) ?? []).length, 1, 'one Undo on the page');
  assert.match(html, /<p class="notice">Saved riverside\.jpg: split into Groceries 19\.65\.<\/p>/);
  const later = receiptPage(viewWith(entry), 'fixture-key', '');
  assert.deepEqual(undoFields(banner(later)), signUndo('undo-receipt-fix', { id: fixture.id, at: entry.fixedOnPage.at }, Date.parse(entry.fixedOnPage.at)), 'coming back: the re-signed Undo');
});

test('the Saved banner words follow what was saved: categories or a created cash purchase', () => {
  const lead = (fixedOnPage) => banner(receiptPage(viewWith(savedEntry({ fixedOnPage })), 'fixture-key', '')).match(/data-workspace-status>([^<]*)</)[1];
  assert.match(lead({ at: ago(60000), kind: 'cash', created: 'n1' }), /^Created in Actual · Undo available for/);
  assert.match(lead({ at: ago(UNDO_WINDOW_MS - 30000), kind: 'applied' }), /Undo available for 1 min$/);
});

test('Looks right has no Undo: a plain confirmed banner, no Undo form or "Saved · Undo" anywhere, also for an older record that once offered one and an old link', () => {
  const at = ago(60000);
  const records = { fresh: { at, kind: 'applied', markOnly: true }, older: { at, kind: 'applied', markOnly: true, undoOffered: true } };
  for (const [name, fixedOnPage] of Object.entries(records)) {
    const entry = savedEntry({ fixedOnPage });
    assert.equal(receiptUndo({ id: fixture.id, entry }, null), null, name);
    const link = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at }) };
    assert.equal(receiptUndo({ id: fixture.id, entry }, link), null, `${name}: an old link is not taken up`);
    assert.notEqual(queueLabel(entry), 'Saved · Undo', name);
    for (const html of [receiptPage(viewWith(entry), 'fixture-key', ''), receiptPage(viewWith(entry), 'fixture-key', 'Marked riverside.jpg as checked (#review removed).', null, link)]) {
      const b = banner(html);
      assert.match(b, /data-workspace-status>Filed in Actual</, `${name}: the plain confirmed state`);
      assert.match(b, /<span class="ic ic-ok">/);
      assert.doesNotMatch(html, /action="undo-receipt-fix|Undo available|Saved · Undo|Archiving ends Undo/, `${name}: no Undo in the banner, the notice line or More`);
      assert.match(b, />Archive receipt<\/button>/, `${name}: archiving is offered at once`);
    }
  }
  // Another receipt's Undo in the link is still shown in the notice line, as before.
  const otherLink = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: 'another', at }) };
  assert.match(receiptPage(viewWith(savedEntry({ fixedOnPage: records.fresh })), 'fixture-key', 'Saved.', null, otherLink), /<div class="notice">Saved\.<form method="post" action="undo-receipt-fix/);
});

test('no Saved banner and no Undo in test mode, after the window, or for an archived receipt', () => {
  const entry = savedEntry();
  const link = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at: entry.fixedOnPage.at }) };
  config.dryRun = true;
  assert.doesNotMatch(banner(receiptPage(viewWith(entry), 'fixture-key', '')), /t-ok|undo-receipt-fix/);
  config.dryRun = false;
  const old = savedEntry({ fixedOnPage: { at: ago(UNDO_WINDOW_MS + 60000), kind: 'applied' } });
  assert.doesNotMatch(banner(receiptPage(viewWith(old), 'fixture-key', '')), /undo-receipt-fix|t-ok/);
  assert.match(receiptPage(viewWith(old), 'fixture-key', 'Saved.', null, link), /<div class="notice">Saved\.<form method="post" action="undo-receipt-fix/, 'no live Undo: an Undo in the link stays in the notice line as before (the server refuses it)');
});

test('O2: while a switch to dry run is pending (the next check not run yet) no Undo, Archive or "Saved · Undo" is offered', () => {
  const entry = savedEntry();
  const link = { route: 'undo-receipt-fix', fields: signUndo('undo-receipt-fix', { id: fixture.id, at: entry.fixedOnPage.at }) };
  assert.ok(receiptUndo({ id: fixture.id, entry }, null), 'live, nothing pending: offered');
  assert.match(receiptPage(viewWith(entry), 'fixture-key', ''), /action="archive\?key=fixture-key"/);
  fs.writeFileSync(config.settingsPath, JSON.stringify({ dryRun: true, changedAt: ago(1000), changedBy: 'test' }));
  try {
    assert.equal(config.dryRun, false, 'still live until the next check');
    assert.equal(receiptUndo({ id: fixture.id, entry }, null), null);
    assert.equal(receiptUndo({ id: fixture.id, entry }, link), null);
    assert.equal(queueLabel(savedEntry()), 'Filed');
    for (const html of [receiptPage(viewWith(entry), 'fixture-key', ''), receiptPage(viewWith(entry), 'fixture-key', 'Saved.', null, link)]) {
      const b = banner(html);
      assert.doesNotMatch(b, /t-ok|action="undo-receipt-fix|Undo available/);
      assert.doesNotMatch(html, /action="archive\?key=fixture-key"/, 'no Archive anywhere on the page (it would say "Dry run: nothing is moved")');
      assert.doesNotMatch(html, /Saved · Undo/);
    }
  } finally {
    fs.rmSync(config.settingsPath, { force: true });
  }
  assert.equal(queueLabel(savedEntry()), 'Saved · Undo', 'back once nothing is pending');
});

test('the list row says "Saved · Undo" while the Undo lasts (live only), then its usual words', () => {
  assert.equal(queueLabel(savedEntry()), 'Saved · Undo');
  assert.equal(queueLabel(savedEntry({ fixedOnPage: { at: ago(UNDO_WINDOW_MS + 1000), kind: 'applied' } })), 'Filed');
  assert.equal(queueLabel(savedEntry({ fixedOnPage: { at: ago(60000), kind: 'applied', undoEnded: ago(1) } })), 'Filed');
  assert.notEqual(queueLabel(savedEntry({ fixedOnPage: { at: ago(60000), kind: 'applied', summaryFailed: true } })), 'Saved · Undo');
  config.dryRun = true;
  assert.equal(queueLabel(savedEntry()), 'Filed');
});

// ---- the inline cash confirmation ----
const cashEntry = { ...fixture.entry, applied: undefined, result: 'review' };
const cashSummary = structuredClone(fixture.summary);
delete cashSummary.transaction;
cashSummary.plan = { applied: false, parts: [] };
cashSummary.receipt.payment_method = 'cash';
const cashPage = (cashLook) => {
  const query = new URLSearchParams({ preview: '1', acct: 'Checking' });
  const fix = editorFor({ id: fixture.id, entry: cashEntry, summary: cashSummary, query, cashLook });
  return receiptPage({ ...fixture.view(), entry: cashEntry, summary: cashSummary, fix }, 'fixture-key', '');
};
const cashForms = (html) => [...html.matchAll(/<form method="post" action="receipt-cash\?key=fixture-key">([^]*?)<\/form>/g)].map((m) => [...m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((x) => `${x[1]}=${x[2]}`));

test('cash: the confirmation is the server\'s own signed forms in the preview, with a question and a Cancel shown only when asked for', () => {
  const look = { account: { id: 'checking', name: 'Checking' }, payee: { id: 'riverside', name: 'Riverside Market', isNew: false }, duplicates: [] };
  const html = cashPage(look);
  const choices = html.match(/<div class="commit-preview" data-cash-preview>[^]*?<\/div><\/div>/)?.[0] ?? html.match(/<div class="commit-preview" data-cash-preview>[^]*$/)[0];
  assert.match(choices, /<p class="cash-confirm">Create a \$32\.15 purchase in Checking\? It is filed right away\.<\/p><form method="post" action="receipt-cash/);
  assert.match(choices, /<button type="button" class="plain cash-cancel" data-cash-cancel>Cancel<\/button>/);
  const [form] = cashForms(html);
  for (const field of ['id=', 'acct=Checking', 'action=create']) assert.ok(form.some((f) => f.startsWith(field)), field);
  assert.ok(form.some((f) => /^token=[a-f0-9]{64}$/.test(f)) && form.some((f) => /^state=[a-f0-9]{64}$/.test(f)), 'signed token and state');
  // Hidden by the page style until the script marks the choices as asked for (R13); the Cancel and question too.
  assert.ok(WORKSPACE_CSS.includes('.workspace-ready [data-cash-preview] form{display:none}'));
  assert.ok(WORKSPACE_CSS.includes('.workspace-ready [data-cash-preview][data-confirming] form{display:block}'));
  assert.ok(WORKSPACE_CSS.includes('.cash-confirm,.cash-cancel{display:none}'));
});

test('cash: with a purchase already there the question says so, and "Use this purchase" (the safe choice) comes first', () => {
  const look = { account: { id: 'checking', name: 'Checking' }, payee: { id: 'riverside', name: 'Riverside Market', isNew: false }, duplicates: [{ id: 'd1', date: '2026-11-08', amount: -3215, payeeName: 'Riverside Market', snapshot: { cleared: true } }] };
  const html = cashPage(look);
  assert.match(html, /<p class="cash-confirm">Checking already has a purchase for this amount\. Use it, or create another one\?<\/p>/);
  const actions = cashForms(html).map((f) => f.find((x) => x.startsWith('action=')));
  assert.deepEqual(actions, ['action=split', 'action=create']);
  assert.ok(html.indexOf('>Use this purchase<') < html.indexOf('>Create another purchase<'));
});

test('cash: the script shows the forms in place and never copies or rebuilds them; the dialog stays only as a fallback', () => {
  const confirm = SCRIPT.slice(SCRIPT.indexOf('function confirmCash'), SCRIPT.indexOf('async function checkNow'));
  assert.match(confirm, /choices\.dataset\.confirming = '1'/);
  assert.doesNotMatch(confirm, /cloneNode|createElement|innerHTML|appendChild|\.append\(/, 'no form is built in the script');
  assert.match(SCRIPT, /if \(main\(\)\.contains\(choices\)\) confirmCash\(choices\);\s*else \{ var clone = choices\.cloneNode\(true\);/);
  assert.match(SCRIPT, /\[data-cash-cancel\]/);
});

// ---- Check now in place ----

test('Check now: the script posts with Accept: application/json and says "Checking now…"; the server answers 202 to that and keeps the redirect for a form', async () => {
  const check = SCRIPT.slice(SCRIPT.indexOf('async function checkNow'), SCRIPT.indexOf('  function enhance() {'));
  assert.match(check, /method: 'POST', headers: \{ Accept: 'application\/json' \}/);
  assert.match(check, /Checking now…/);
  assert.match(SCRIPT, /form\.hasAttribute\('data-check-now'\) && main\(\)\.contains\(form\)\) \{ e\.preventDefault\(\); checkNow\(form\); return; \}/);
  let runs = 0;
  const server = makeServer(() => { runs++; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const json = await fetch(`${base}/run?key=fixture-key`, { method: 'POST', headers: { Accept: 'application/json' }, redirect: 'manual' });
    assert.equal(json.status, 202);
    const page = await fetch(`${base}/run?key=fixture-key`, { method: 'POST', headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.match(page.headers.get('location'), /^\.\/\?key=fixture-key&started=1$/);
    assert.equal(runs, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Q2: "Looks right" on a charge changed in Actual ----

test('a charge changed in Actual: Looks right is the existing clear-#review-and-archive, with a sentence saying so; keep-what\'s-in-Actual in the banner', () => {
  const entry = { ...fixture.entry, changedByHand: true };
  const fix = editorFor({ id: fixture.id, entry, summary: fixture.summary, query: new URLSearchParams(), seen: null });
  assert.equal(fix.locked, true);
  const html = receiptPage({ ...fixture.view(), entry, fix }, 'fixture-key', '');
  const footer = html.match(/<div class="editor-actions locked-actions">[^]*?<\/div><\/div>/)[0];
  assert.match(footer, /<p class="locked-consequence">Looks right clears the #review tag in Actual and archives this receipt\. Nothing else changes in Actual\.<\/p>/);
  const form = footer.match(/<form method="post" action="archive\?key=fixture-key">[^]*?<\/form>/)[0];
  assert.match(form, /<button>Looks right<\/button>/);
  assert.doesNotMatch(form, /name="keep"|name="dismiss"/, 'the same POST as "Looks right: clear #review and archive"');
  assert.match(banner(html), /name="keep" value="1"[^]*?Archive: keep what's in Actual/);
});
