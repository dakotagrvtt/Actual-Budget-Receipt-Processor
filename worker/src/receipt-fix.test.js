// Fixing a receipt's item categories from its page (receipt-fix.js): the preview, saving to a charge the worker already changed,
// applying a receipt that sits in Needs review, Undo, the lessons, and the session lock. Actual is a fake budget that keeps its
// transactions in memory (test/support.js stands in for the API package), Nextcloud is a map of files.
import '../test/support.js';
import test, { mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { shiftDay, today } from './dates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fix-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), categoryNotesPath: path.join(dir, 'category-notes.json'), dryRun: false });
config.learning.dir = path.join(dir, 'memory');
config.trigger.token = 'secret';
config.actual.dataDir = path.join(dir, 'actual-cache');

const { default: api } = await import('@actual-app/api');
const fix = await import('./receipt-fix.js');
const { allocate, mergeParts, partNote, money, SPLIT_NOTE_MAX, UNCATEGORIZED } = await import('./reconcile.js');
const { rememberCategories } = await import('./known-categories.js');
const { loadState } = await import('./state.js');
const memory = await import('./memory.js');
const learning = await import('./learning.js');
const { PanelError, signUndo } = await import('./panel-actions.js');
const { exclusive, isBusy, BusyError } = await import('./session-lock.js');
const { makeServer } = await import('./trigger.js');

const { inbox, processed, review } = config.nextcloud;
const saved = { envDryRun: config.envDryRun, splits: config.splits, taxByItem: config.taxByItem, accounts: [...config.match.accounts], dry: config.dryRun, mode: config.learning.mode };
const day = (n) => shiftDay(today(), n);

// ---- the fake budget ----
const CAT_ROWS = [
  { id: 'cg', name: 'Groceries', group_id: 'g1' }, { id: 'ch', name: 'Household', group_id: 'g1' },
  { id: 'cs', name: 'Sam', group_id: 'g1' }, { id: 'cf', name: 'Games', group_id: 'g2' },
  { id: 'cr', name: 'Rent', group_id: 'g3', hidden: true }, { id: 'ci', name: 'Pay', group_id: 'g3', is_income: true },
];
const G = 'Daily / Groceries';
const H = 'Daily / Household';
const S = 'Daily / Sam';
const F = 'Fun / Games';
const LABELS = new Map([[G, 'cg'], [H, 'ch'], [S, 'cs'], [F, 'cf']]);
const KNOWN = [{ group: 'Daily', label: G }, { group: 'Daily', label: H }, { group: 'Daily', label: S }, { group: 'Fun', label: F }];

let budget;
function fakeBudget({ replace = true } = {}) {
  const b = { txns: new Map(), updates: [], deletes: [], syncs: 0, opened: 0, closed: 0, kid: 0 };
  const accounts = [{ id: 'a1', name: 'Checking' }, { id: 'a2', name: 'Other' }];
  mock.method(api, 'init', async () => { b.opened++; });
  mock.method(api, 'shutdown', async () => { b.closed++; });
  mock.method(api, 'getAccounts', async () => accounts);
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Target' }, { id: 'pt', name: 'Savings', transfer_acct: 'a2' }]);
  mock.method(api, 'getCategories', async () => CAT_ROWS);
  mock.method(api, 'getCategoryGroups', async () => [{ id: 'g1', name: 'Daily' }, { id: 'g2', name: 'Fun' }, { id: 'g3', name: 'Bills' }]);
  mock.method(api, 'getTransactions', async (acc, start, end) => [...b.txns.values()].filter((t) => t.account === acc && t.date >= start && t.date <= end).map((t) => structuredClone(t)));
  api.sync = async () => { b.syncs++; };
  const kids = (list) => list.map((c) => ({ id: c.id ?? `k${++b.kid}`, ...c }));
  mock.method(api, 'updateTransaction', async (id, fields) => {
    b.updates.push({ id, fields: structuredClone(fields) });
    const t = b.txns.get(id);
    const { subtransactions, ...rest } = fields;
    Object.assign(t, rest);
    if (subtransactions) {
      // As loot-core does it: children missing from the new list are deleted, so the list replaces them. An empty list deletes them
      // all but leaves an (empty) parent, is_parent still true. An API with `replace: false` adds to the children instead.
      if (replace) t.subtransactions = kids(subtransactions);
      else t.subtransactions = [...(t.subtransactions ?? []), ...kids(subtransactions)];
      if (subtransactions.length) t.is_parent = true;
    }
  });
  api.deleteTransaction = async (id) => {
    b.deletes.push(id);
    for (const t of b.txns.values()) {
      t.subtransactions = (t.subtransactions ?? []).filter((c) => c.id !== id);
      if (t.is_parent && t.subtransactions.length === 0) t.is_parent = false;
    }
  };
  budget = b;
  return b;
}

// ---- the fake Nextcloud ----
function fakeNextcloud() {
  const files = new Map();
  const nc = {
    files, moves: [], failRefile: false,
    async readSummary(p) { const f = files.get(p); return f ? structuredClone(f.summary) : null; },
    async refile(from, dest, summary) {
      if (nc.failRefile === true) throw new Error('Nextcloud is down');
      if (!files.has(from)) throw Object.assign(new Error(`${from} is not there`), { status: 404 });
      let at = dest;
      if (dest !== from && files.has(dest)) at = `${path.posix.dirname(dest)}/9-${path.posix.basename(dest)}`; // never over another file
      const old = files.get(from);
      files.delete(from);
      if (nc.failRefile === 'write') { // the file moves, its new summary can't be written (the old one stays)
        files.set(at, old);
        if (at !== from) nc.moves.push([from, at]);
        throw Object.assign(new Error('summary could not be written'), { movedTo: at });
      }
      files.set(at, { summary: structuredClone(summary) });
      if (at !== from) nc.moves.push([from, at]);
      return at;
    },
    async statPath(p) { if (!files.has(p)) throw Object.assign(new Error('Not Found'), { status: 404 }); return { size: 4, etag: 'e' }; },
    async downloadPath() { return Buffer.from('jpeg'); },
  };
  return nc;
}

// ---- a receipt, as the worker read and categorized it ----
const makeReceipt = () => ({
  merchant: 'Target', store: 'Target', payee: 'Target', date: day(-1), subtotal: 40, tax: 1.6, total: 41.6,
  items: [
    { description: 'MILK', plain: 'milk', amount: 20, taxable: false, category: G, confidence: 0.9 },
    { description: 'SPONGES', plain: 'sponges', amount: 10, taxable: true, category: H, confidence: 0.9 },
    { description: 'GUM', plain: 'chewing gum', amount: 10, taxable: true, category: S, confidence: 0.8 },
  ],
});
const KEY = `${inbox}/r1.jpg@e1`;
const partsOf = (allocation) => allocation.map((a) => ({ category: a.label, amount: money(a.cents), items: a.items }));
let nc;

/**
 * Put a receipt in the world. kind 'A': the worker split the charge (children in the budget, summary and file filed);
 * kind 'B': nothing was applied, the file is in Needs review and the charge is untouched. Returns { summary, entry, allocation }.
 */
async function seed({ kind = 'A', review: flagged = false, action = 'split', txn = {}, summary: over = {}, entry: entryOver = {} } = {}) {
  const receipt = makeReceipt();
  const base = { file: 'r1.jpg', receipt, transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: null } };
  const { allocation } = fix.replan({ summary: base, picks: fix.workerPicks(base), labelToId: LABELS, targetCents: 4160 });
  const filedAs = `${kind === 'A' && !flagged ? processed : review}/r1.jpg`;
  const summary = { ...base, plan: { action: kind === 'A' ? action : null, applied: kind === 'A', parts: partsOf(allocation) }, problems: kind === 'B' ? ['not sure about GUM'] : flagged ? ['check it'] : [], ...over };
  const tag = `#receipt r1.jpg${flagged ? ' #review' : ''}`;
  const t = { id: 't1', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', category: null, notes: '', is_parent: false, cleared: true, ...txn };
  if (kind === 'A') {
    Object.assign(t, { notes: tag, is_parent: true, category: null, subtransactions: allocation.map((a, i) => ({ id: `s${i}`, amount: -a.cents, category: a.categoryId, notes: partNote(a, ', ', SPLIT_NOTE_MAX) })), ...txn });
  }
  budget.txns.set('t1', t);
  nc.files.set(filedAs, { summary });
  const entry = { done: true, result: kind === 'B' ? 'review' : `${action}${flagged ? '+review' : ''}`, at: '2026-11-01T10:00:00.000Z', filedAs, ...(kind === 'A' ? { applied: { txnId: 't1', action, at: '2026-11-01T10:00:00.000Z' } } : {}), ...entryOver };
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: entry }));
  return { summary, entry, allocation };
}

beforeEach(async () => {
  fs.rmSync(config.learning.dir, { recursive: true, force: true });
  fs.writeFileSync(config.statePath, '{}');
  Object.assign(config, { splits: true, taxByItem: true, dryRun: false, envDryRun: false });
  fs.rmSync(config.settingsPath, { force: true });
  config.match.accounts = [];
  config.learning.mode = 'on';
  fakeBudget();
  nc = fakeNextcloud();
  await rememberCategories(KNOWN);
});
afterEach(() => {
  mock.restoreAll();
  delete api.sync;
  delete api.deleteTransaction;
  Object.assign(config, { splits: saved.splits, taxByItem: saved.taxByItem, dryRun: saved.dry, envDryRun: saved.envDryRun });
  config.match.accounts = saved.accounts;
  config.learning.mode = saved.mode;
});

const quiet = () => mock.method(console, 'log', () => {});
const queryOf = (picks) => new URLSearchParams({ preview: '1', ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])) });
const entryNow = async () => (await loadState())[KEY];
const summaryNow = async () => nc.files.get((await entryNow()).filedAs).summary;

/** The page's editor for these choices, from the records as they are now (the preview). */
async function previewOf(picks) {
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  return fix.editorFor({ id: KEY, entry, summary, query: picks ? queryOf(picks) : null });
}
/** The form the Save / Apply button sends: the choices and the preview's token. */
async function formFor(picks, extra = {}) {
  const ed = await previewOf(picks);
  assert.ok(ed.preview?.token, JSON.stringify(ed.preview));
  return new URLSearchParams({ id: KEY, token: ed.preview.token, state: ed.preview.state, ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])), ...extra });
}
const commit = async (picks, extra = {}, deps = {}) => {
  quiet();
  const out = {};
  const message = await fix.commitFix(await formFor(picks, extra), out, { nextcloud: nc, lockWaitMs: 200, ...deps });
  return { message, out };
};
const refused = async (form, pattern, deps = {}) => {
  quiet();
  await assert.rejects(() => fix.commitFix(form, {}, { nextcloud: nc, lockWaitMs: 200, ...deps }), (err) => err instanceof PanelError && pattern.test(err.message), `expected ${pattern}`);
};
const WORKER = [G, H, S];
const kidsOf = () => budget.txns.get('t1').subtransactions.map((c) => [c.category, -c.amount]).sort();

// ---- 1. the preview ----

test('preview: parts and tax are worked out again per category (tax stays with the taxed items)', async () => {
  await seed();
  const ed = await previewOf([G, G, S]); // SPONGES moves to Groceries
  assert.equal(ed.ok, true);
  assert.equal(ed.kind, 'applied');
  assert.deepEqual(ed.changed, [1]);
  const parts = Object.fromEntries(ed.preview.parts.map((p) => [p.category, p.amount]));
  // MILK 20.00 + SPONGES 10.00 + 0.80 of the tax on SPONGES; GUM 10.00 + 0.80
  assert.deepEqual(parts, { [G]: '30.80', [S]: '10.80' });
  assert.equal(ed.preview.tax.how, 'by-item');
  assert.equal(ed.preview.split, true);
  assert.equal(ed.preview.wasSplit, true);
  assert.match(ed.preview.token, /^[0-9a-f]{64}$/);
  // unchanged choices give the worker's own parts
  const same = await previewOf(WORKER);
  assert.deepEqual(same.changed, []);
  assert.deepEqual(Object.fromEntries(same.preview.parts.map((p) => [p.category, p.amount])), { [G]: '20.00', [H]: '10.80', [S]: '10.80' });
});

test('preview: no Actual and no Nextcloud are touched', async () => {
  await seed();
  await previewOf([G, G, S]);
  assert.equal(budget.opened, 0);
  assert.equal(budget.updates.length, 0);
});

test('preview: one category for everything, splits off, and nothing placed', async () => {
  await seed();
  assert.deepEqual((await previewOf([G, G, G])).preview.parts.map((p) => [p.category, p.amount]), [[G, '41.60']]);
  assert.equal((await previewOf([G, G, G])).preview.split, false);
  config.splits = false;
  const off = (await previewOf([G, H, S])).preview;
  assert.equal(off.split, false);
  assert.equal(off.parts.length, 3);
  assert.equal(off.main, G); // the largest part gets the whole charge
  const none = (await previewOf([UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED])).preview;
  assert.equal(none.placed, false);
});

test('preview: excluded categories are offered but marked; the choices cover every item', async () => {
  await seed();
  config.excludeCategories = [F];
  try {
    const ed = await previewOf(null);
    assert.equal(ed.options.find((o) => o.label === F).excluded, true);
    assert.equal(ed.options.find((o) => o.label === G).excluded, false);
    assert.deepEqual(ed.items.map((i) => [i.description, i.current]), [['MILK', G], ['SPONGES', H], ['GUM', S]]);
    assert.equal(ed.preview, null); // no preview until asked for
    assert.equal((await previewOf([F, H, S])).preview.parts.some((p) => p.category === F), true); // allowed
  } finally {
    config.excludeCategories = [];
  }
});

test('preview: bad choices are reported, not computed', async () => {
  await seed();
  assert.match((await previewOf([G, 'Nope / Nothing', S])).preview.error, /not one of Actual's categories/);
  const q = queryOf(WORKER);
  q.set('c9', G);
  const entry = await entryNow();
  assert.match(fix.editorFor({ id: KEY, entry, summary: nc.files.get(entry.filedAs).summary, query: q }).preview.error, /item this receipt does not have/);
  q.delete('c9');
  q.set('c1', 'x'.repeat(400));
  assert.match(fix.editorFor({ id: KEY, entry, summary: nc.files.get(entry.filedAs).summary, query: q }).preview.error, /not valid/);
  q.set('c1', G);
  q.set('c01', G); // not a plain index
  assert.match(fix.editorFor({ id: KEY, entry, summary: nc.files.get(entry.filedAs).summary, query: q }).preview.error, /item this receipt does not have/);
});

// ---- 2. what can be fixed ----

test('classify: the reasons a receipt can not be fixed, each in plain words', async () => {
  const entryOf = (over) => ({ done: true, result: 'split', filedAs: `${processed}/r1.jpg`, applied: { txnId: 't1', action: 'split' }, ...over });
  const { summary } = await seed();
  const reason = (entry, sum) => fix.classify(KEY, entry, sum).reason;
  assert.match(reason({ done: false }, summary), /not finished/);
  assert.match(reason(entryOf(), null), /summary could not be read/);
  assert.match(reason(entryOf(), { alreadyApplied: true, transaction: summary.transaction }), /never read/);
  assert.match(reason(entryOf(), { ...summary, receipt: { items: [] } }), /no list of items/);
  assert.match(reason(entryOf(), { ...summary, receipt: { items: [{ description: 'x' }] } }), /no list of items/);
  assert.match(reason(entryOf({ result: 'review', applied: undefined }), { ...summary, transaction: null }), /No bank charge was matched/);
  assert.match(reason(entryOf(), { ...summary, plan: null }), /does not say how the charge was divided/);
  assert.match(reason(entryOf({ applied: { txnId: 'other', action: 'split' } }), summary), /not recorded/);
  assert.match(reason(entryOf({ applied: { txnId: 't1', action: 'already-applied' } }), summary), /not recorded/);
  assert.match(reason(entryOf({ filedAs: undefined }), summary), /does not record where its file is/);
  assert.match(reason(entryOf({ result: 'failed', applied: undefined }), { ...summary, plan: null }), /not in a state/);
  assert.equal(fix.classify(KEY, entryOf(), summary).kind, 'applied');
});

test('classify: a "note" or "confirm" result can be fixed too; review with a matched charge is the apply case', async () => {
  const { summary } = await seed();
  for (const action of ['note', 'confirm', 'categorize']) assert.equal(fix.classify(KEY, { done: true, result: action, filedAs: `${processed}/r1.jpg`, applied: { txnId: 't1', action } }, summary).kind, 'applied');
  const b = await seed({ kind: 'B' });
  assert.equal(fix.classify(KEY, await entryNow(), b.summary).kind, 'review');
});

test('dry run: the preview is offered, nothing can be written', async () => {
  const { summary } = await seed({ kind: 'B' });
  const dryKey = `dry:${KEY}`;
  const entry = { done: true, result: 'dry-run:split' };
  const ed = fix.editorFor({ id: dryKey, entry, summary, query: queryOf([G, G, S]) });
  assert.equal(ed.ok, true);
  assert.equal(ed.dry, true);
  assert.ok(ed.preview.parts.length);
  config.dryRun = true;
  const form = new URLSearchParams({ id: dryKey, token: ed.preview.token });
  await refused(form, /Dry run: nothing is written/);
  await refused(new URLSearchParams({ id: KEY, token: 't' }), /Dry run: nothing is written/);
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.opened, 0);
});

// ---- 3. saving to a charge the worker already changed ----

test('A: a split is replaced, not added to, and the #receipt note is kept', async () => {
  await seed();
  const { message, out } = await commit([G, G, S]);
  assert.match(message, /^Saved r1\.jpg: split into /);
  assert.deepEqual(kidsOf(), [['cs', 1080], ['cg', 3080]].sort());
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, true);
  assert.equal(t.category, null);
  assert.equal(t.notes, '#receipt r1.jpg');
  assert.equal(t.subtransactions.reduce((n, c) => n + c.amount, 0), -4160);
  assert.equal(budget.updates.length, 1); // one write
  assert.equal(budget.deletes.length, 0);
  assert.equal(budget.opened, 1); // opened and closed again for the one change
  assert.equal(budget.closed, 1);
  assert.equal(budget.syncs >= 1, true);
  assert.equal(out.undo.route, 'undo-receipt-fix');
  // the state entry and the filed summary
  const e = await entryNow();
  assert.equal(e.result, 'split');
  assert.equal(e.applied.txnId, 't1');
  assert.equal(e.fixedOnPage.kind, 'applied');
  assert.deepEqual(e.fixedOnPage.wrote.children.map((c) => [c.category, c.amount]).sort(), [['cg', -3080], ['cs', -1080]].sort());
  const s = await summaryNow();
  assert.deepEqual(s.plan.parts.map((p) => [p.category, p.amount]).sort(), [[G, '30.80'], [S, '10.80']].sort());
  assert.equal(s.plan.applied, true);
  assert.deepEqual(s.pageFix.items, { 1: G });
  assert.equal(s.receipt.items[1].category, H); // what the worker said is kept
  assert.equal(nc.moves.length, 0); // processed stays processed
});

test('A: an API that adds children instead of replacing them still ends up right (old ones are deleted)', async () => {
  mock.restoreAll();
  fakeBudget({ replace: false });
  await seed();
  await commit([G, G, S]);
  assert.deepEqual(kidsOf(), [['cs', 1080], ['cg', 3080]].sort());
  assert.deepEqual(budget.deletes.sort(), ['s0', 's1', 's2']);
  assert.equal(budget.txns.get('t1').is_parent, true);
});

test('A: one category un-splits the charge', async () => {
  await seed();
  const { message } = await commit([G, G, G]);
  assert.match(message, /put in Daily \/ Groceries/);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, false);
  assert.deepEqual(t.subtransactions, []);
  assert.equal(t.category, 'cg');
  assert.match(t.notes, /^#receipt r1\.jpg — items: MILK/);
  // the Actual way: the children are deleted (the last one makes the parent a normal charge), then the category is set;
  // an empty subtransactions list is never sent
  assert.deepEqual(budget.deletes, ['s0', 's1', 's2']);
  assert.equal(budget.updates.length, 1);
  assert.equal('subtransactions' in budget.updates[0].fields, false);
  const e = await entryNow();
  assert.equal(e.result, 'categorize');
  assert.equal(e.applied.action, 'categorize');
  assert.equal((await summaryNow()).plan.action, 'categorize');
});

test('A: un-splitting also works on an API that adds children instead of replacing them', async () => {
  mock.restoreAll();
  fakeBudget({ replace: false });
  await seed();
  await commit([G, G, G]);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, false);
  assert.equal(t.category, 'cg');
  assert.equal(budget.deletes.length, 3);
});

test('A: a single-category charge can be split by fixing an item (and notes the user wrote are kept)', async () => {
  await seed({ action: 'categorize', txn: { is_parent: false, subtransactions: undefined, category: 'cg', notes: 'my note | #receipt r1.jpg — items: MILK; SPONGES; GUM | later' }, summary: { plan: { action: 'categorize', applied: true, parts: [{ category: G, amount: '41.60', items: ['MILK'] }] } } });
  await commit([G, H, S]);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, true);
  assert.equal(t.notes, 'my note | #receipt r1.jpg | later');
  assert.equal(t.category, null);
});

test('A: refused when the charge was changed in Actual since the worker wrote it (nothing is written)', async () => {
  const cases = [
    ['a child recategorized', (t) => { t.subtransactions[0].category = 'cf'; }, /split was changed in Actual/],
    ['the split removed', (t) => { t.is_parent = false; t.subtransactions = []; t.category = 'cg'; }, /category was changed|split/],
    ['a child amount edited', (t) => { t.subtransactions[0].amount += 1; t.subtransactions[1].amount -= 1; }, /split was changed/],
    ['the #receipt note removed', (t) => { t.notes = 'mine'; }, /#receipt note was removed/],
    ['the amount changed', (t) => { t.amount = -4200; }, /amount changed/],
  ];
  for (const [what, edit, pattern] of cases) {
    budget.txns.clear();
    await seed();
    edit(budget.txns.get('t1'));
    const form = await formFor([G, G, S]);
    await refused(form, pattern);
    assert.equal(budget.updates.length, 0, what);
    assert.equal((await entryNow()).fixedOnPage, undefined, what);
  }
  budget.txns.clear();
  await seed();
  budget.txns.delete('t1'); // gone
  await refused(await formFor([G, G, S]), /no longer in Actual/);
});

test('A: a single category changed in Actual since is refused too', async () => {
  await seed({ action: 'categorize', txn: { is_parent: false, subtransactions: undefined, category: 'cg', notes: '#receipt r1.jpg — items: MILK' }, summary: { plan: { action: 'categorize', applied: true, parts: [{ category: G, amount: '41.60', items: ['MILK'] }] } } });
  const form = await formFor([G, F, S]);
  budget.txns.get('t1').category = 'cf';
  await refused(form, /category was changed in Actual/);
  assert.equal(budget.updates.length, 0);
});

test('A: after a save from the page, the next one compares with what the page wrote (any later edit in Actual is refused)', async () => {
  await seed();
  await commit([G, G, S]);
  const form = await formFor([G, H, S]);
  budget.txns.get('t1').subtransactions[0].notes = 'edited by hand';
  await refused(form, /changed in Actual after it was last saved from this page/);
  assert.equal(budget.updates.length, 1); // only the first save wrote
});

test('A: a second save works and replaces the first (an item can go back to what the worker chose)', async () => {
  await seed();
  await commit([G, G, S]);
  const { message } = await commit([G, H, S]);
  assert.match(message, /Saved r1\.jpg/);
  assert.deepEqual(kidsOf().map(([c]) => c).sort(), ['cg', 'ch', 'cs']);
  const s = await summaryNow();
  assert.deepEqual(s.pageFix.items, {}); // all as the worker had them
});

test('A: +review: Mark as checked removes #review and moves the file from Needs review to Processed', async () => {
  await seed({ review: true });
  const ed = await previewOf([G, G, S]);
  assert.equal(ed.preview.review, true);
  assert.equal(ed.preview.willMove, processed);
  const { message } = await commit([G, G, S], { mark: 'yes' });
  assert.match(message, /Marked as checked \(#review removed\)/);
  assert.equal(budget.txns.get('t1').notes, '#receipt r1.jpg');
  assert.deepEqual(nc.moves, [[`${review}/r1.jpg`, `${processed}/r1.jpg`]]);
  const e = await entryNow();
  assert.equal(e.filedAs, `${processed}/r1.jpg`);
  assert.equal(e.result, 'split');
  assert.deepEqual((await summaryNow()).problems, []);
});

test('A: +review without the tick keeps #review and leaves the file in Needs review', async () => {
  await seed({ review: true });
  await commit([G, G, S]); // no mark field
  assert.equal(budget.txns.get('t1').notes, '#receipt r1.jpg #review');
  assert.equal(nc.moves.length, 0);
  const e = await entryNow();
  assert.equal(e.filedAs, `${review}/r1.jpg`);
  assert.equal(e.result, 'split+review');
  assert.deepEqual((await summaryNow()).problems, ['check it']);
});

test('A: +review with no category changed: Mark as checked alone is a valid save', async () => {
  await seed({ review: true });
  await commit(WORKER, { mark: 'yes' });
  assert.equal(budget.txns.get('t1').notes, '#receipt r1.jpg');
  assert.equal((await entryNow()).filedAs, `${processed}/r1.jpg`);
  assert.deepEqual(await memory.loadLessonFile().then((l) => l.lessons), []);
});

test('A: nothing changed on a receipt that was not flagged: the preview offers nothing to save', async () => {
  await seed();
  const html = (await fetchPage([...WORKER])).html;
  assert.match(html, /nothing to save/);
  assert.doesNotMatch(html, />Save to Actual<\/button>/);
});

test('A: splits off or unsupported: several parts become the largest category with the breakdown in the note', async () => {
  await seed();
  config.splits = false;
  const { message } = await commit([G, G, S]);
  assert.match(message, /splits are off here/);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, false);
  assert.equal(t.category, 'cg');
  assert.match(t.notes, /^#receipt r1\.jpg: Groceries 30\.80, Sam 10\.80$/);
  assert.equal((await entryNow()).applied.action, 'categorize');
});

// ---- 4. applying a receipt in Needs review ----

test('B: Apply writes the charge, moves the file to Processed and updates the state like a normal apply', async () => {
  await seed({ kind: 'B' });
  const ed = await previewOf([G, G, F]);
  assert.equal(ed.kind, 'review');
  assert.equal(ed.applyLabel, 'Apply to Actual');
  const { message, out } = await commit([G, G, F]);
  assert.match(message, /^Applied r1\.jpg: split into /);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, true);
  assert.equal(t.notes, '#receipt r1.jpg');
  assert.deepEqual(kidsOf(), [['cf', 1080], ['cg', 3080]].sort());
  assert.deepEqual(nc.moves, [[`${review}/r1.jpg`, `${processed}/r1.jpg`]]);
  const e = await entryNow();
  assert.deepEqual({ result: e.result, filedAs: e.filedAs, txn: e.applied.txnId, action: e.applied.action }, { result: 'split', filedAs: `${processed}/r1.jpg`, txn: 't1', action: 'split' });
  const s = await summaryNow();
  assert.equal(s.plan.applied, true);
  assert.deepEqual(s.problems, []);
  assert.ok(out.undo);
});

test('B: a charge that already has another category is overwritten (the explicit apply beats OVERWRITE_CATEGORIZED)', async () => {
  config.match.overwrite = false;
  try {
    await seed({ kind: 'B', txn: { category: 'cg' }, summary: { transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: G } } });
    await commit([F, F, F]);
    assert.equal(budget.txns.get('t1').category, 'cf');
    assert.match(budget.txns.get('t1').notes, /^#receipt r1\.jpg — items: /);
  } finally {
    config.match.overwrite = true;
  }
});

test('B: SPLIT_TRANSACTIONS off writes the largest category and a breakdown note, as the normal flow does', async () => {
  config.splits = false;
  await seed({ kind: 'B' });
  const { message } = await commit([G, G, F]);
  assert.match(message, /put in Daily \/ Groceries \(splits are off here/);
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, false);
  assert.equal(t.category, 'cg');
  assert.equal(t.notes, '#receipt r1.jpg: Groceries 30.80, Games 10.80');
  assert.equal((await entryNow()).applied.action, 'categorize');
  assert.deepEqual(await memory.loadWatch(), []); // nothing to learn from a single category chosen for several items
});

test('B: refused when the charge no longer qualifies (nothing is written, nothing moves)', async () => {
  const cases = [
    ['gone', (m) => m.txns.delete('t1'), /no longer in Actual/],
    ['amount changed', (m) => { m.txns.get('t1').amount = -4200; }, /amount changed/],
    ['split now', (m) => { Object.assign(m.txns.get('t1'), { is_parent: true, subtransactions: [{ id: 'x', amount: -4160, category: 'cg', notes: '' }] }); }, /split now/],
    ['a child', (m) => { m.txns.get('t1').is_child = true; }, /split now/],
    ['already tagged', (m) => { m.txns.get('t1').notes = '#receipt other.jpg'; }, /already has a #receipt note/],
    ['account outside MATCH_ACCOUNTS', () => { config.match.accounts = ['Savings']; }, /not one of MATCH_ACCOUNTS/],
    ['a transfer', (m) => { m.txns.get('t1').transfer_id = 'x'; }, /transfer/],
    ['a transfer payee', (m) => { m.txns.get('t1').payee = 'pt'; }, /transfer/],
    ['an income category', (m) => { m.txns.get('t1').category = 'ci'; }, /hidden or income/],
    ['a category set by hand', (m) => { m.txns.get('t1').category = 'cf'; }, /category changed since/],
  ];
  for (const [what, edit, pattern] of cases) {
    budget.txns.clear();
    nc.files.clear();
    config.match.accounts = [];
    await seed({ kind: 'B' });
    const form = await formFor([G, G, F]);
    edit(budget);
    await refused(form, pattern);
    assert.equal(budget.updates.length, 0, what);
    assert.equal(nc.moves.length, 0, what);
    assert.equal((await entryNow()).applied, undefined, what);
  }
});

test('B: when the file name is already taken in Processed it is filed under another name (never over a file)', async () => {
  await seed({ kind: 'B' });
  nc.files.set(`${processed}/r1.jpg`, { summary: { other: true } });
  await commit([G, G, F]);
  assert.equal((await entryNow()).filedAs, `${processed}/9-r1.jpg`);
  assert.deepEqual(nc.files.get(`${processed}/r1.jpg`).summary, { other: true });
});

test('B: a failed move still records the change in the state (Actual did change) and says what is left', async () => {
  await seed({ kind: 'B' });
  nc.failRefile = true;
  const { message } = await commit([G, G, F]);
  assert.match(message, /Actual was updated, but the file/);
  const e = await entryNow();
  assert.equal(e.applied.txnId, 't1');
  assert.equal(e.filedAs, `${review}/r1.jpg`);
});

// ---- 5. Undo ----

const undoForm = (out, over = {}) => new URLSearchParams({ ...out.undo.fields, ...over });

test('undo A: the split, the notes, the entry and the summary are exactly as before', async () => {
  const { entry, summary } = await seed({ review: true });
  const before = structuredClone(budget.txns.get('t1'));
  const { out } = await commit([G, G, S], { mark: 'yes' });
  assert.equal((await entryNow()).filedAs, `${processed}/r1.jpg`);
  quiet();
  const msg = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /^Undone/);
  const t = budget.txns.get('t1');
  assert.equal(t.notes, before.notes);
  assert.equal(t.is_parent, true);
  assert.deepEqual(t.subtransactions.map((c) => [c.category, c.amount, c.notes]).sort(), before.subtransactions.map((c) => [c.category, c.amount, c.notes]).sort());
  const e = await entryNow();
  assert.deepEqual(e, entry); // the entry as it was, fixedOnPage gone
  assert.deepEqual(nc.files.get(e.filedAs).summary, summary); // the file is back in Needs review, with its old summary
  assert.equal(nc.files.has(`${processed}/r1.jpg`), false);
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
});

test('undo A: from one category back to the split', async () => {
  await seed();
  const before = structuredClone(budget.txns.get('t1'));
  const { out } = await commit([G, G, G]);
  assert.equal(budget.txns.get('t1').is_parent, false);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  const t = budget.txns.get('t1');
  assert.equal(t.is_parent, true);
  assert.equal(t.notes, before.notes);
  assert.deepEqual(t.subtransactions.map((c) => [c.category, c.amount]).sort(), before.subtransactions.map((c) => [c.category, c.amount]).sort());
});

test('undo B: the charge is untouched again, the entry is back in review and the file is back in Needs review', async () => {
  const { entry, summary } = await seed({ kind: 'B' });
  const { out } = await commit([G, G, F]);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  const t = budget.txns.get('t1');
  assert.deepEqual([t.is_parent, t.category, t.notes, t.subtransactions], [false, null, '', []]);
  assert.equal(budget.deletes.length, 2); // the split Apply made is taken apart child by child
  assert.equal(budget.updates.every((u) => !('subtransactions' in u.fields) || u.fields.subtransactions.length > 0), true);
  assert.deepEqual(await entryNow(), entry);
  assert.deepEqual(nc.files.get(`${review}/r1.jpg`).summary, summary);
  assert.equal(nc.files.has(`${processed}/r1.jpg`), false);
});

test('undo: refused (and nothing written) when the charge changed in Actual since the page wrote it', async () => {
  await seed();
  const { out } = await commit([G, G, S]);
  const writes = budget.updates.length;
  budget.txns.get('t1').subtransactions[0].category = 'cf';
  quiet();
  const msg = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /changed in Actual since you saved it here, so nothing was undone/);
  assert.equal(budget.updates.length, writes);
  assert.ok((await entryNow()).fixedOnPage); // the entry still says what the page did
});

test('undo: a link that is old, forged or for a receipt changed again is refused', async () => {
  await seed();
  const { out } = await commit([G, G, S]);
  quiet();
  const writes = budget.updates.length;
  const fields = { id: out.undo.fields.id, at: out.undo.fields.at };
  const old = signUndo('undo-receipt-fix', fields, Date.now() - 20 * 60000);
  await assert.rejects(() => fix.undoFix(new URLSearchParams(old), {}, { nextcloud: nc }), /older than 15 minutes/);
  await assert.rejects(() => fix.undoFix(undoForm(out, { id: `${inbox}/other.jpg@e1` }), {}, { nextcloud: nc }), /isn't valid/);
  await assert.rejects(() => fix.undoFix(undoForm(out, { mac: 'x' }), {}, { nextcloud: nc }), /isn't valid/);
  // a second page change makes the first Undo stale
  await commit([G, H, S]);
  const msg = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /changed again since/);
  assert.equal(budget.updates.length, writes + 1);
});

test('undo: the lessons the change made go, the lessons it replaced come back, the watch is as it was', async () => {
  await seed();
  await commit([G, G, S]);
  const first = (await memory.loadLessonFile()).lessons;
  assert.equal(first.length, 1);
  const { out } = await commit([G, G, F]); // changes GUM too, and SPONGES stays
  assert.equal((await memory.loadLessonFile()).lessons.length, 2);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual((await memory.loadLessonFile()).lessons, first);
  const w = await memory.loadWatch();
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].parts.map((p) => p.label).sort(), [G, S].sort());
});

// ---- 6. learning ----

test('learning: one lesson per changed item, in the sweep\'s shape, none for unchanged items', async () => {
  await seed();
  const { message } = await commit([G, G, S]);
  assert.match(message, /Learned from 1 changed item\./);
  const { lessons } = await memory.loadLessonFile();
  assert.equal(lessons.length, 1);
  const [l] = lessons;
  assert.equal(l.item, 'SPONGES');
  assert.equal(l.said, H);
  assert.equal(l.filed, G);
  assert.equal(l.txnId, 't1');
  assert.equal(l.file, 'r1.jpg');
  assert.equal(l.store, 'Target');
  assert.equal(l.payee, 'Target');
  assert.equal(l.kind, 'item');
  assert.equal(l.solo, true);
  assert.equal(l.via, 'page');
  assert.equal(l.amountCents, 4160);
  assert.equal(l.itemCents, 1000);
  assert.equal(l.saidHow, 'model');
  assert.match(l.learnedAt, /^\d{4}-\d\d-\d\d$/);
  // the same keys the sweep's own lessonOf gives
  const sweepShape = learning.lessonOf({ txnId: 't1', file: 'r1.jpg', date: day(-1), payee: 'Target', store: 'Target', amountCents: 4160, parts: [{ items: [{}] }] }, { item: { d: 'x', src: 'model' }, said: H, filed: G, kind: 'item', group: 0, solo: true }, '2026-11-08');
  for (const k of Object.keys(sweepShape)) assert.ok(k in l, k);
});

test('learning: several changed items give a lesson each; an item put back as the worker had it gives none', async () => {
  await seed();
  await commit([F, G, S]);
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((l) => [l.item, l.said, l.filed]).sort(), [['MILK', G, F], ['SPONGES', H, G]].sort());
  await commit([G, G, S]); // MILK back where the worker had it
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((l) => [l.item, l.filed]), [['SPONGES', G]]);
});

test('learning: nothing changed, nothing learned', async () => {
  await seed({ kind: 'B' });
  const { message } = await commit(WORKER);
  assert.doesNotMatch(message, /Learned from/);
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
});

test('learning: a lesson you forgot on the Learned page is not made again', async () => {
  await seed();
  await commit([G, G, S]);
  const [l] = (await memory.loadLessonFile()).lessons;
  await memory.forgetLesson(l.id);
  await commit([G, G, G]);
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((x) => x.item), ['GUM']); // SPONGES stays forgotten
});

test('learning: the watch holds what the page wrote, so the sweep neither learns it again nor drops it; the page lesson survives the sweep', async () => {
  await seed();
  await commit([G, G, S]);
  const w = await memory.loadWatch();
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].parts.map((p) => [p.label, p.cents]).sort(), [[G, 3080], [S, 1080]].sort());
  quiet();
  const id2label = new Map([...LABELS].map(([label, id]) => [id, label]));
  const result = await learning.sweep({ id2label, now: new Date() });
  assert.equal(result.dropped, 0);
  assert.equal(result.lessons, 0); // your own change is not a correction
  assert.deepEqual((await memory.loadLessonFile()).lessons.map((l) => [l.item, l.filed]), [['SPONGES', G]]);
  assert.equal((await memory.loadWatch()).length, 1);
});

test('learning: a later correction in Actual on the same item replaces the page lesson', async () => {
  await seed();
  await commit([G, G, S]);
  const kids = budget.txns.get('t1').subtransactions;
  const sponge = kids.find((c) => c.category === 'cg');
  assert.ok(sponge);
  // the user moves the whole Groceries part to Games in Actual
  sponge.category = 'cf';
  quiet();
  await learning.sweep({ id2label: new Map([...LABELS].map(([label, id]) => [id, label])), now: new Date() });
  const items = (await memory.loadLessonFile()).lessons.filter((l) => l.item === 'SPONGES');
  assert.equal(items.length, 1);
  assert.equal(items[0].filed, F);
  assert.equal(items[0].said, H); // what the worker said, not the pick you made on the page
});

test('learning: LEARNING=off writes no lessons, no watch and no marks', async () => {
  config.learning.mode = 'off';
  await seed();
  const { message } = await commit([G, G, S]);
  assert.doesNotMatch(message, /Learned/);
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
  assert.deepEqual(await memory.loadWatch(), []);
  assert.equal(fs.existsSync(path.join(config.learning.dir, 'marks.json')), false);
  assert.equal((await entryNow()).fixedOnPage.learned, false);
  // and Undo has nothing of that to take back
  const { out } = await commit([G, H, S]);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
});

test('learning: LEARNING=record still learns (it only decides whether lessons are used)', async () => {
  config.learning.mode = 'record';
  await seed();
  await commit([G, G, S]);
  assert.equal((await memory.loadLessonFile()).lessons.length, 1);
});

test('learning: the parts you moved count as yours (marks), the old watch is replaced', async () => {
  await seed();
  await seedWatch();
  await commit([G, G, S]);
  const marks = JSON.parse(fs.readFileSync(path.join(config.learning.dir, 'marks.json'), 'utf8'));
  assert.ok(marks.corrected.t1.length >= 1);
  assert.deepEqual((await memory.loadWatch()).map((w) => w.parts.length), [2]);
});
async function seedWatch() {
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  const base = fix.replan({ summary, picks: fix.workerPicks(summary), labelToId: LABELS, targetCents: 4160 });
  await memory.watch(learning.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: base.receipt, allocation: base.allocation, action: 'split', review: false }));
  assert.equal((await memory.loadWatch())[0].parts.length, 3);
}

// ---- 7. refusing bad requests ----

test('invalid category, item index, token and receipt are refused before anything is written', async () => {
  await seed();
  const good = await formFor([G, G, S]);
  const withField = (name, value) => { const f = new URLSearchParams(good); f.set(name, value); return f; };
  await refused(withField('c1', 'Nope / Nothing'), /not one of Actual's categories/);
  await refused(withField('c1', 'Rent'), /not one of Actual's categories/);
  await refused(withField('c1', 'Bills / Rent'), /not one of Actual's categories/); // hidden
  await refused(withField('c7', G), /item this receipt does not have/);
  await refused(withField('c1', 'x'.repeat(500)), /not valid/);
  await refused(withField('token', 'f'.repeat(64)), /Press Preview again/);
  const noToken = new URLSearchParams(good);
  noToken.delete('token');
  await refused(noToken, /Press Preview first/);
  const noState = new URLSearchParams(good);
  noState.delete('state');
  await refused(noState, /Press Preview first/);
  await refused(withField('state', 'f'.repeat(64)), /changed since the preview/);

  await refused(withField('id', `${inbox}/nothing.jpg@e1`), /isn't in the list/);
  await refused(withField('id', 'x'.repeat(3000)), /isn't in the list/);
  const bare = new URLSearchParams(good);
  for (const n of ['c0', 'c1', 'c2']) bare.set(n, UNCATEGORIZED);
  await refused(bare, /at least one item/);
  assert.equal(budget.updates.length, 0);
  assert.equal(nc.moves.length, 0);
});

test('a preview made before another change is stale and refused', async () => {
  await seed();
  const stale = await formFor([G, G, S]);
  await commit([G, H, F]);
  const writes = budget.updates.length;
  await refused(stale, /changed since the preview/);
  assert.equal(budget.updates.length, writes);
});

test('a preview made before the settings changed the amounts is refused', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  config.taxByItem = false; // the tax would be spread differently now
  await refused(form, /changed since the preview/);
  assert.equal(budget.updates.length, 0);
});

test('choosing only Uncategorized is refused', async () => {
  await seed();
  const ed = await previewOf([UNCATEGORIZED, UNCATEGORIZED, UNCATEGORIZED]);
  assert.equal(ed.preview.placed, false);
  const form = new URLSearchParams({ id: KEY, token: ed.preview.token, state: ed.preview.state, c0: UNCATEGORIZED, c1: UNCATEGORIZED, c2: UNCATEGORIZED });
  await refused(form, /at least one item/);
});

// ---- 8. serialization ----

test('double submit: two commits at once write once (the second sees a changed receipt)', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  quiet();
  const run = () => fix.commitFix(new URLSearchParams(form), {}, { nextcloud: nc, lockWaitMs: 2000 });
  const results = await Promise.allSettled([run(), run()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /changed since the preview/);
  assert.equal(budget.updates.length, 1);
  assert.equal(budget.opened, 1);
});

test('a commit waits for a poll cycle holding the session lock, then goes ahead; it gives up with "busy" if the wait is too long', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  quiet();
  let release;
  const held = exclusive(() => new Promise((r) => { release = r; }));
  assert.equal(isBusy(), true);
  // too short a wait: busy, nothing opened or written
  await assert.rejects(() => fix.commitFix(new URLSearchParams(form), {}, { nextcloud: nc, lockWaitMs: 20 }), /in the middle of a check/);
  assert.equal(budget.opened, 0);
  assert.equal(budget.updates.length, 0);
  // a patient one runs as soon as the cycle ends
  const patient = fix.commitFix(new URLSearchParams(form), {}, { nextcloud: nc, lockWaitMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(budget.updates.length, 0);
  release();
  await held;
  assert.match(await patient, /Saved r1\.jpg/);
  assert.equal(budget.updates.length, 1);
  assert.equal(isBusy(), false);
});

test('a failure to open Actual changes nothing and is reported', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  mock.method(api, 'downloadBudget', async () => { throw new Error('connect ECONNREFUSED'); });
  await refused(form, /Couldn't reach Actual/);
  assert.equal(budget.updates.length, 0);
  assert.equal((await entryNow()).fixedOnPage, undefined);
});

test('a write that Actual does not take as intended is reported and the state is left alone', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  mock.method(api, 'updateTransaction', async () => {}); // accepted, but nothing happens
  await refused(form, /did not end up with the categories that were written/);
  assert.equal((await entryNow()).fixedOnPage, undefined);
});

test('session lock: waiters run in order, a timed-out waiter never runs, and a failure releases the lock', async () => {
  const order = [];
  let release;
  const first = exclusive(() => new Promise((r) => { release = r; }).then(() => order.push('first')));
  const second = exclusive(async () => order.push('second'));
  const gone = exclusive(async () => order.push('never'), { timeoutMs: 10 });
  await assert.rejects(gone, BusyError);
  release();
  await first;
  await second;
  assert.deepEqual(order, ['first', 'second']);
  await assert.rejects(exclusive(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(isBusy(), false);
  assert.equal(await exclusive(async () => 'ok'), 'ok');
});

// ---- 9. the page ----

let server;
let base;
async function startServer() {
  server = makeServer(() => {}, { nextcloud: nc, prepare: async () => ['data:image/jpeg;base64,AAAA'], lockWaitMs: 500 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
});
async function fetchPage(picks, extra = '') {
  if (!server) await startServer();
  const q = picks ? `&${queryOf(picks).toString()}` : '';
  const res = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(KEY)}${q}${extra}`);
  return { res, html: await res.text() };
}

test('page: the items table has a category menu per item, with the current category selected, and a Preview form', async () => {
  await seed();
  const { res, html } = await fetchPage(null);
  assert.equal(res.status, 200);
  assert.equal([...html.matchAll(/<select class="pick" name="c(\d)"/g)].length, 3);
  assert.match(html, /<select class="pick" name="c1"[^>]*>[\s\S]*?<option value="Daily &#47; Household" selected>|<option value="Daily \/ Household" selected>/);
  assert.match(html, /<form method="get" action="receipt">[\s\S]*name="preview" value="1"[\s\S]*Preview<\/button>/);
  assert.match(html, /optgroup label="Fun"/);
  assert.doesNotMatch(html, /<button class="plain">Save to Actual/); // nothing to save before a preview
  assert.match(html, /fix the item categories|pick the right category|Pick a different category/i);
});

test('page: Preview shows the new parts, the tax line and a Save form; a +review receipt has "Mark as checked" ticked', async () => {
  await seed({ review: true });
  const { html } = await fetchPage([G, G, S]);
  assert.match(html, /<b>Preview<\/b>/);
  assert.match(html, /30\.80/);
  assert.match(html, /10\.80/);
  assert.match(html, /Tax: /);
  assert.match(html, /<form method="post" action="receipt-fix\?key=secret">/);
  assert.match(html, /name="mark" value="yes" checked/);
  assert.match(html, /name="token" value="[0-9a-f]{64}"/);
  assert.match(html, />Save to Actual<\/button>/);
  assert.match(html, /1 changed item becomes a lesson/);
  await seed({ kind: 'B' });
  assert.match((await fetchPage([G, G, S])).html, />Apply to Actual<\/button>/);
});

test('page: dry run shows the preview and "Dry run: nothing is written." and no button that writes', async () => {
  const { summary } = await seed({ kind: 'B' });
  config.dryRun = true;
  fs.writeFileSync(config.statePath, JSON.stringify({ [`dry:${KEY}`]: { done: true, result: 'dry-run:review', at: '2026-11-01T10:00:00.000Z' } }));
  const { saveDrySummary } = await import('./dry-summaries.js');
  await saveDrySummary(`dry:${KEY}`, summary);
  if (!server) await startServer();
  const res = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(`dry:${KEY}`)}&${queryOf([G, G, S]).toString()}`);
  const html = await res.text();
  assert.match(html, /Dry run: nothing is written\./);
  assert.match(html, /<b>Preview<\/b>/);
  assert.doesNotMatch(html, /receipt-fix\?key/);
});

test('page: a receipt that can not be fixed says why, in plain words', async () => {
  await seed({ kind: 'B', summary: { transaction: null } });
  const { html } = await fetchPage(null);
  assert.match(html, /Categories can't be fixed here: No bank charge was matched/);
  assert.doesNotMatch(html, /<select class="pick"/);
});

test('page: hostile text in items and categories is escaped; no inline handlers or style attributes; the CSP holds', async () => {
  const hostile = '<img src=x onerror=alert(1)> "q"';
  const { summary } = await seed();
  summary.receipt.items[0].description = hostile;
  summary.receipt.items[1].category = `<b>Evil</b>`;
  nc.files.get(`${processed}/r1.jpg`).summary = summary;
  const { res, html } = await fetchPage(null);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>Evil<\/b>/);
  assert.match(html, /&#60;b&#62;Evil&#60;\/b&#62; \(not in Actual's list\)/);
  const tags = html.replace(/<script>[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '').replace(/"[^"]*"/g, '""'); // attribute values out of the way
  assert.doesNotMatch(tags, /<[^>]*\s(?:on[a-z]+|style)=/i);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
});

test('page: nothing secret is written into the page (the trigger token appears only as the access key already in the links)', async () => {
  await seed();
  const { html } = await fetchPage([G, G, S]);
  const withoutKeys = html.replace(/<style>[\s\S]*?<\/style>/, '').replaceAll('key=secret', '').replaceAll('name="key" value="secret"', '');
  assert.doesNotMatch(withoutKeys, /secret/);
  assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ''), /password|ACTUAL_|app.?password/i);
});

test('http: POST /receipt-fix needs the key, saves, redirects to the receipt with a notice and an Undo that works', async () => {
  await seed();
  if (!server) await startServer();
  const body = await formFor([G, G, S]);
  quiet();
  const post = (p, key = 'secret') => fetch(`${base}${p}${key === null ? '' : `?key=${key}`}`, { method: 'POST', body: new URLSearchParams(p === '/receipt-fix' ? body : {}), redirect: 'manual' });
  assert.equal((await post('/receipt-fix', null)).status, 403);
  assert.equal((await post('/receipt-fix', 'bad')).status, 403);
  assert.equal((await fetch(`${base}/receipt-fix?key=secret`)).status, 404); // GET is not a route
  const res = await post('/receipt-fix');
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get('location'), base);
  assert.equal(to.pathname, '/receipt');
  assert.equal(to.searchParams.get('id'), KEY);
  assert.match(to.searchParams.get('notice'), /^Saved r1\.jpg/);
  assert.equal(budget.updates.length, 1);
  const page = await (await fetch(to)).text();
  const m = page.match(/<form method="post" action="(undo-receipt-fix\?key=secret)">([\s\S]*?)<button class="small plain">Undo<\/button>/);
  assert.ok(m, 'an Undo button');
  const fields = Object.fromEntries([...m[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  const undo = await fetch(`${base}/${m[1]}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  assert.equal(undo.status, 303);
  assert.match(new URL(undo.headers.get('location'), base).searchParams.get('notice'), /^Undone/);
  assert.deepEqual(budget.txns.get('t1').subtransactions.map((c) => c.category).sort(), ['cg', 'ch', 'cs']);
});

test('http: a refusal comes back as a notice on the receipt page, and nothing is written', async () => {
  await seed();
  if (!server) await startServer();
  const body = await formFor([G, G, S]);
  budget.txns.get('t1').subtransactions[0].category = 'cf';
  quiet();
  const res = await fetch(`${base}/receipt-fix?key=secret`, { method: 'POST', body, redirect: 'manual' });
  const to = new URL(res.headers.get('location'), base);
  assert.equal(to.pathname, '/receipt');
  assert.match(to.searchParams.get('notice'), /Nothing was changed: its split was changed in Actual/);
  assert.equal(budget.updates.length, 0);
});

test('wording: the What to do box and the help mention fixing the categories on the page', async () => {
  await seed({ kind: 'B' });
  let { html } = await fetchPage(null);
  assert.match(html, /you can also pick the right category for each item under Items below/);
  assert.match(html, /Items and categories/);
  await seed({ review: true });
  ({ html } = await fetchPage(null));
  assert.match(html, /fix the item categories on this page/);
  await seed();
  ({ html } = await fetchPage(null));
  assert.match(html, /fix it under Items below/);
  await commit([G, G, S]);
  ({ html } = await fetchPage(null));
  assert.match(html, /The item categories were fixed on this page/);
});

// ---- 10. review round: un-split, failed file writes, safer checks, bookkeeping ----

test('undo after the summary could not be rewritten in Nextcloud: the charge, the entry and the file are restored', async () => {
  const { entry } = await seed({ kind: 'B' });
  nc.failRefile = true;
  const { message, out } = await commit([G, G, F]);
  assert.match(message, /Actual was updated, but the file/);
  assert.equal((await summaryNow()).pageFix, undefined); // the Nextcloud copy was never rewritten
  assert.ok((await entryNow()).fixedOnPage.summaryFailed);
  nc.failRefile = false;
  quiet();
  const msg = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /^Undone/);
  const t = budget.txns.get('t1');
  assert.deepEqual([t.is_parent, t.category, t.notes], [false, null, '']);
  assert.deepEqual(await entryNow(), entry);
});

test('a moved file whose summary could not be written is followed by the state, and Undo moves it back', async () => {
  const { entry } = await seed({ kind: 'B' });
  nc.failRefile = 'write';
  const { message, out } = await commit([G, G, F]);
  assert.match(message, /the file was moved, its summary still shows the old plan/);
  assert.equal((await entryNow()).filedAs, `${processed}/r1.jpg`);
  nc.failRefile = false;
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual(await entryNow(), entry);
  assert.equal(nc.files.has(`${review}/r1.jpg`), true);
});

test('undo with nothing to rebuild the summary from refuses before Actual is opened', async () => {
  await seed({ kind: 'B' });
  nc.failRefile = true;
  const { out } = await commit([G, G, F]);
  nc.failRefile = false;
  const state = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  delete state[KEY].fixedOnPage.summaryBefore;
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  const opened = budget.opened;
  quiet();
  await assert.rejects(() => fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /can't be undone safely\. Nothing was changed/);
  assert.equal(budget.opened, opened);
});

test('an error after the charge was put back is reported as such, never as "nothing was changed"', async () => {
  await seed({ kind: 'B' });
  const { out } = await commit([G, G, F]);
  nc.refile = async () => { fs.writeFileSync(config.statePath, '{ damaged'); throw new Error('boom'); }; // and the state is damaged meanwhile
  quiet();
  await assert.rejects(() => fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), (err) => /charge in Actual was put back/.test(err.message) && !/Nothing was changed/.test(err.message));
});

test('writing to Actual that throws is reported as a possibly partial change', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  mock.method(api, 'updateTransaction', async () => { throw new Error('socket hang up'); });
  await refused(form, /charge may be partly changed: check it in Actual/);
});

test('nextcloud refile: a summary that can not be written keeps the old .json and reports where the file is', async () => {
  const { davClient, refile } = await import('./nextcloud.js');
  const c = davClient();
  const calls = [];
  Object.assign(c, {
    exists: async (p) => p === '/a/old.jpg',
    moveFile: async (from, to) => { calls.push(['move', from, to]); },
    putFileContents: async () => { throw new Error('quota'); },
    deleteFile: async (p) => { calls.push(['delete', p]); },
  });
  mock.method(console, 'log', () => {});
  await assert.rejects(() => refile('/a/old.jpg', '/b/old.jpg', { x: 1 }), (err) => err.movedTo === '/b/old.jpg' && /could not be written/.test(err.message));
  assert.deepEqual(calls, [['move', '/a/old.jpg', '/b/old.jpg']]); // the old .json was not deleted
  c.putFileContents = async () => {};
  calls.length = 0;
  c.exists = async (p) => p === '/a/old.jpg';
  assert.equal(await refile('/a/old.jpg', '/b/old.jpg', { x: 1 }), '/b/old.jpg');
  assert.deepEqual(calls, [['move', '/a/old.jpg', '/b/old.jpg'], ['delete', '/a/old.jpg.json']]);
});

test('drain: waits for a running save and says whether the lock became free in time', async () => {
  const { drain } = await import('./session-lock.js');
  assert.equal(await drain(50), true);
  let release;
  const held = exclusive(() => new Promise((r) => { release = r; }));
  assert.equal(await drain(20), false); // still saving
  const waits = drain(2000);
  release();
  await held;
  assert.equal(await waits, true);
});

test('B: refused when the charge is filed under an excluded category, or is still pending', async () => {
  config.excludeCategories = [F];
  try {
    await seed({ kind: 'B', txn: { category: 'cf' }, summary: { transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: F } } });
    const ed = await previewOf([G, G, S]);
    assert.match(ed.preview.cautions.join(' '), /"Fun \/ Games", which receipts don't change/); // shown in the preview too
    await refused(await formFor([G, G, S]), /filed under "Fun \/ Games", which receipts don't change/);
  } finally {
    config.excludeCategories = [];
  }
  budget.txns.clear();
  await seed({ kind: 'B', summary: { transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: null, pending: true } } });
  assert.match((await previewOf([G, G, S])).preview.cautions.join(' '), /still pending/);
  budget.txns.get('t1').cleared = false;
  await refused(await formFor([G, G, S]), /still pending/);
  assert.equal(budget.updates.length, 0);
});

test('#review is read from the worker\'s own segment only', async () => {
  // someone else's #review elsewhere in the notes is not the worker's flag
  await seed({ txn: { notes: '#receipt r1.jpg | todo #review later' } });
  const { message } = await commit([G, G, S], { mark: 'yes' });
  assert.doesNotMatch(message, /Marked as checked/);
  assert.equal(budget.txns.get('t1').notes, '#receipt r1.jpg | todo #review later');
  assert.equal((await entryNow()).result, 'split');
  // its own #review before an items list is recognized
  budget.txns.clear();
  await seed({ action: 'categorize', review: true, txn: { is_parent: false, subtransactions: undefined, category: 'cg', notes: 'x | #receipt r1.jpg #review — items: MILK | y' }, summary: { plan: { action: 'categorize', applied: true, parts: [{ category: G, amount: '41.60', items: ['MILK'] }] } } });
  const second = await commit([G, G, G], { mark: 'yes' });
  assert.match(second.message, /Marked as checked/);
  assert.match(budget.txns.get('t1').notes, /^x \| #receipt r1\.jpg — items: .* \| y$/);
});

test('a switch to dry run that has not started yet already stops saves and undos', async () => {
  await seed();
  const { out } = await commit([G, G, S]);
  const form = await formFor([G, H, S]);
  fs.writeFileSync(config.settingsPath, JSON.stringify({ dryRun: true, changedAt: new Date().toISOString(), changedBy: 'status page' }));
  assert.equal(config.dryRun, false); // the worker has not picked the switch up yet
  const writes = budget.updates.length;
  await refused(form, /Dry run: nothing is written/);
  quiet();
  await assert.rejects(() => fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /Dry run: nothing is written/);
  assert.equal(budget.updates.length, writes);
});

test('splits off: a charge with a category keeps it and only gets the breakdown note (the "note" action), like the pipeline', async () => {
  config.splits = false;
  await seed({ kind: 'B', txn: { category: 'cg' }, summary: { transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: G } } });
  const pv = (await previewOf([F, H, S])).preview;
  assert.equal(pv.note, true);
  assert.equal(pv.current, G);
  const { message } = await commit([F, H, S]);
  assert.match(message, /kept in its category \(splits are off here/);
  const t = budget.txns.get('t1');
  assert.equal(t.category, 'cg'); // unchanged
  assert.equal(t.is_parent, false);
  assert.match(t.notes, /^#receipt r1\.jpg: /);
  const e = await entryNow();
  assert.equal(e.result, 'note');
  assert.equal(e.applied.action, 'note');
  assert.deepEqual(await memory.loadWatch(), []);
  // the page can fix it again later: the "note" result is compared with the category it kept
  const again = await commit([G, H, S]);
  assert.match(again.message, /Saved r1\.jpg/);
});

test('splits off: a split charge has no category to keep, so it gets the largest part\'s category', async () => {
  await seed();
  config.splits = false;
  const pv = (await previewOf([G, G, S])).preview;
  assert.equal(pv.note, false);
  await commit([G, G, S]);
  assert.equal(budget.txns.get('t1').category, 'cg');
});

test('learning bookkeeping: Mark as checked records a confirmation, and Undo puts the old marks back', async () => {
  await seed({ review: true });
  await memory.recordMarks({ corrected: { t1: ['old part'] } });
  const before = JSON.parse(fs.readFileSync(path.join(config.learning.dir, 'marks.json'), 'utf8'));
  const { out } = await commit(WORKER, { mark: 'yes' });
  const marks = JSON.parse(fs.readFileSync(path.join(config.learning.dir, 'marks.json'), 'utf8'));
  assert.deepEqual(marks.confirmed, ['t1']);
  assert.equal('t1' in marks.corrected, false);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.learning.dir, 'marks.json'), 'utf8')), before);
});

test('learning bookkeeping: the watched snapshot keeps what the worker said about an item you moved', async () => {
  await seed();
  await commit([G, G, S]);
  const [w] = await memory.loadWatch();
  const sponges = w.parts.flatMap((p) => p.items).find((i) => i.d === 'SPONGES');
  assert.deepEqual([sponges.cat, sponges.merged], [H, true]);
  const milk = w.parts.flatMap((p) => p.items).find((i) => i.d === 'MILK');
  assert.equal(milk.merged, undefined);
});

test('the unread-money category saved with the plan is used again; older summaries fall back to the note text', async () => {
  const items = [{ description: 'MILK', amount: 20, category: G }, { description: 'GUM', amount: 10, category: S }];
  const receipt = { merchant: 'Target', store: 'Target', subtotal: 40, tax: 0, total: 40, items };
  const base = { file: 'r1.jpg', receipt, transaction: { id: 't1', date: day(-1), currentCategory: null, amount: '40.00' } };
  const picks = fix.workerPicks(base);
  const labelToId = LABELS;
  const withGap = (plan) => fix.replan({ summary: { ...base, plan }, picks, labelToId, targetCents: 4000 }).allocation.map((a) => a.label);
  assert.ok(withGap({ gapLabel: F, parts: [] }).includes(F)); // the 10.00 not read goes to the saved category
  assert.ok(withGap({ parts: [{ category: H, items: ['10.00 not read from the receipt'] }] }).includes(H)); // older summary
  assert.ok(withGap({ parts: [] }).includes(UNCATEGORIZED));
});

test('a note result or a category that was renamed since is refused with that reason, not compared by guess', async () => {
  await seed({ action: 'note', txn: { is_parent: false, subtransactions: undefined, category: 'cg', notes: '#receipt r1.jpg: x' }, summary: { transaction: { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: 'Old / Name' }, plan: { action: 'note', applied: true, parts: [{ category: G, amount: '41.60', items: ['MILK'] }] } } });
  await refused(await formFor([G, G, S]), /"Old \/ Name" it was filed under is no longer one of Actual's categories/);
  budget.txns.clear();
  await seed({ action: 'categorize', txn: { is_parent: false, subtransactions: undefined, category: 'cg', notes: '#receipt r1.jpg — items: MILK' }, summary: { plan: { action: 'categorize', applied: true, parts: [{ category: 'Renamed / Away', amount: '41.60', items: ['MILK'] }] } } });
  await refused(await formFor([G, G, S]), /"Renamed \/ Away" it was filed under is no longer one of Actual's categories/);
  assert.equal(budget.updates.length, 0);
});
