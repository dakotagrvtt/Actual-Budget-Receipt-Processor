// Fixing a receipt's item categories from its page (receipt-fix.js): the preview, saving to a charge the worker already changed,
// applying a receipt that sits in Needs review, Undo, the lessons, and the session lock. Actual is a fake budget that keeps its
// transactions in memory (test/support.js stands in for the API package), Nextcloud is a map of files.
import './support.js';
import test, { mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { shiftDay, today } from '../src/dates.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fix-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json'), categoryNotesPath: path.join(dir, 'category-notes.json'), dryRun: false });
config.learning.dir = path.join(dir, 'memory');
config.trigger.token = 'secret';
config.actual.dataDir = path.join(dir, 'actual-cache');

const { default: api } = await import('@actual-app/api');
const fix = await import('../src/receipt-fix.js');
const { allocate, mergeParts, partNote, money, SPLIT_NOTE_MAX, UNCATEGORIZED } = await import('../src/reconcile.js');
const { rememberCategories } = await import('../src/known-categories.js');
const { loadState } = await import('../src/state.js');
const memory = await import('../src/memory.js');
const learning = await import('../src/learning.js');
const { PanelError, signUndo } = await import('../src/panel-actions.js');
const { exclusive, isBusy, BusyError } = await import('../src/session-lock.js');
const { makeServer } = await import('../src/trigger.js');

const { inbox, processed, review } = config.nextcloud;
// Node 22 may exit while a test awaits the session lock's deliberately unref'ed deadline. The real worker has a listening server.
let lockTestKeepAlive;
beforeEach(() => { lockTestKeepAlive = setInterval(() => {}, 1000); });
afterEach(() => clearInterval(lockTestKeepAlive));

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
  mock.method(api, 'getTransactions', async (acc, start, end) => [...b.txns.values()].filter((t) => t.account === acc && (!start || t.date >= start) && (!end || t.date <= end)).map((t) => structuredClone(t)));
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
    async refile(from, dest, summary, options = {}) {
      if (options.intent?.to && !files.has(from) && files.has(options.intent.to)) from = dest = options.intent.to;
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
  return fix.editorFor({ id: KEY, entry, summary, query: picks ? queryOf(picks) : null, seen: (await memory.loadSeen())['t1'] ?? null });
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
  assert.match(html, /data-preview-none="true"/);
  assert.match(html, /Nothing to update\./);
  assert.doesNotMatch(html, />Save changes<\/button>/);
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
  assert.match(html, /<form\b[^>]*method="get"[^>]*action="receipt"[^>]*data-preview-form[^>]*>[\s\S]*name="preview" value="1"/);
  assert.match(html, /optgroup label="Fun"/);
  assert.doesNotMatch(html, /<button class="plain">Save changes/); // nothing to save before a preview
  assert.match(html, /data-item-revert/);
  assert.match(html, /data-rule-link/);
});

test('page: Preview shows the new parts, the tax line and a Save form; a +review receipt has "Mark as checked" ticked', async () => {
  await seed({ review: true });
  const { html } = await fetchPage([G, G, S]);
  assert.match(html, /data-preview-fragment[^>]*data-preview-valid="true"/);
  assert.match(html, /data-preview-split/);
  assert.match(html, /30\.80/);
  assert.match(html, /10\.80/);
  assert.match(html, /Tax: /);
  assert.match(html, /<form\b[^>]*method="post"[^>]*action="receipt-fix\?key=secret"[^>]*>/);
  assert.match(html, /name="mark" value="yes" checked/);
  assert.match(html, /name="token" value="[0-9a-f]{64}"/);
  assert.match(html, />Save changes<\/button>/);
  assert.match(html, /data-preview-dirty="true"/);
  assert.match(html, /data-item-hint/);
  await seed({ kind: 'B' });
  assert.match((await fetchPage([G, G, S])).html, />Apply to Actual<\/button>/);
});

test('page: test mode shows its preview-only state and no button that writes', async () => {
  const { summary } = await seed({ kind: 'B' });
  config.dryRun = true;
  fs.writeFileSync(config.statePath, JSON.stringify({ [`dry:${KEY}`]: { done: true, result: 'dry-run:review', at: '2026-11-01T10:00:00.000Z' } }));
  const { saveDrySummary } = await import('../src/dry-summaries.js');
  await saveDrySummary(`dry:${KEY}`, summary);
  if (!server) await startServer();
  const res = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(`dry:${KEY}`)}&${queryOf([G, G, S]).toString()}`);
  const html = await res.text();
  assert.match(html, /Test mode: nothing is written\./);
  assert.match(html, /data-preview-valid="false"/);
  assert.match(html, /data-preview-split/);
  assert.doesNotMatch(html, /receipt-fix\?key/);
});

test('page: an unmatched receipt offers finding a charge before category editing', async () => {
  await seed({ kind: 'B', summary: { transaction: null } });
  const { html } = await fetchPage(null);
  assert.match(html, />Find a charge<\/h2>/);
  assert.match(html, /data-resolution-form/);
  assert.match(html, />Find matching charges<\/button>/);
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
  assert.equal(to.searchParams.get('action-error'), '1');
  const refusedPage = await fetch(to);
  assert.equal(refusedPage.headers.get('X-Receipt-Action-Error'), '1');
  assert.match(await refusedPage.text(), /class="notice err" role="alert"/);
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
  delete state[KEY].filing.summary.pageFix.before;
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
  const { davClient, refile } = await import('../src/nextcloud.js');
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
  const { drain } = await import('../src/session-lock.js');
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

// ---- archiving a receipt that is "Applied — check it in Actual" ----

test('archive: a #review receipt first has #review cleared in Actual (like Mark as checked), moves to Processed, then is archived', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  assert.match(budget.txns.get('t1').notes, /#review/);
  const archiveNc = {
    readSummary: (p) => nc.readSummary(p),
    async archiveFile({ from, dir, summary, at }) {
      const dest = `${dir}/${path.posix.basename(from)}`;
      nc.files.delete(from);
      nc.files.set(dest, { summary: { ...summary, archived: { at, from } } });
      return { dest, shrunk: null, fileMissing: false };
    },
  };
  quiet();
  const out = {};
  const message = await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 });
  assert.match(message, /#review tag was removed in Actual first/);
  assert.doesNotMatch(message, /Undo/, 'Looks right: clear #review and archive has no Undo to offer or end');
  assert.equal(out.undo, undefined);
  assert.equal(out.archived, true);
  assert.doesNotMatch(budget.txns.get('t1').notes, /#review/);
  const entry = await entryNow();
  assert.ok(entry.archived);
  assert.equal(entry.result, 'split', 'no more +review: it shows as done when restored');
  assert.equal(entry.applied.txnId, 't1');
  assert.equal(entry.fixedOnPage, undefined);
  assert.deepEqual(nc.moves.map((m) => m[1]), [`${processed}/r1.jpg`], 'moved to Processed on the way');
  assert.equal(entry.filedAs, `${config.nextcloud.archive}/${day(-1).slice(0, 7)}/r1.jpg`);
});

test('archive: a #review receipt whose charge was changed in Actual is not archived, and #review stays', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  budget.txns.get('t1').subtransactions = budget.txns.get('t1').subtransactions.slice(1); // someone changed the split
  quiet();
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: { readSummary: nc.readSummary }, nextcloud: nc, lockWaitMs: 200 }), (err) => err instanceof PanelError && /Not archived: #review could not be cleared/.test(err.message));
  assert.equal((await entryNow()).archived, undefined);
  assert.match(budget.txns.get('t1').notes, /#review/);
});

test('markCheckedNow changes only the note: the split keeps its children (same ids) even when splits are now off', async () => {
  await seed({ review: true });
  config.splits = false; // the setting changed since the worker split the charge
  quiet();
  const message = await fix.markCheckedNow(KEY, { nextcloud: nc });
  assert.match(message, /#review removed/);
  const t = budget.txns.get('t1');
  assert.equal(t.notes, '#receipt r1.jpg');
  assert.equal(t.is_parent, true);
  assert.deepEqual(t.subtransactions.map((c) => c.id), ['s0', 's1', 's2'], 'the same children, not new ones');
  assert.equal(budget.updates.length, 1);
  assert.deepEqual(Object.keys(budget.updates[0].fields), ['notes'], 'only the notes were written');
  assert.equal(budget.deletes.length, 0);
  const entry = await entryNow();
  assert.equal(entry.result, 'split');
  assert.equal(entry.fixedOnPage.markOnly, true);
  assert.equal(entry.filedAs, `${processed}/r1.jpg`);
  assert.deepEqual((await summaryNow()).problems, []);
});

test('markCheckedNow refuses a charge that is no longer what the worker wrote, and a receipt that is not applied; nothing is written', async () => {
  await seed({ review: true });
  budget.txns.get('t1').amount = -9999;
  quiet();
  await assert.rejects(() => fix.markCheckedNow(KEY, { nextcloud: nc }), (e) => e instanceof PanelError && /its amount changed/.test(e.message));
  await seed({ review: true });
  budget.txns.get('t1').notes = 'something else';
  await assert.rejects(() => fix.markCheckedNow(KEY, { nextcloud: nc }), (e) => e instanceof PanelError && /#receipt note was removed/.test(e.message));
  await seed({ kind: 'B' });
  await assert.rejects(() => fix.markCheckedNow(KEY, { nextcloud: nc }), (e) => e instanceof PanelError);
  assert.equal(budget.updates.length, 0);
});

test('archive: a failed archive after #review was cleared can be retried at once (no Undo window), and the half-done state is explained', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  let fail = true;
  const archiveNc = {
    readSummary: (p) => nc.readSummary(p),
    async archiveFile({ from, dir, summary, at }) {
      if (fail) throw new Error('Nextcloud is down');
      const dest = `${dir}/${path.posix.basename(from)}`;
      nc.files.delete(from);
      nc.files.set(dest, { summary: { ...summary, archived: { at, from } } });
      return { dest, shrunk: null, fileMissing: false };
    },
  };
  quiet();
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 }), (e) => e instanceof PanelError && /#review tag was removed in Actual, but the receipt could not be archived/.test(e.message));
  assert.equal((await entryNow()).result, 'split');
  fail = false;
  const out = {};
  await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 });
  assert.equal(out.archived, true);
});

test('archive: when the file could not be moved to Processed after #review was cleared, it is not archived and the reason is passed on', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  nc.failRefile = true;
  quiet();
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: { readSummary: nc.readSummary }, nextcloud: nc, lockWaitMs: 200 }), (e) => e instanceof PanelError && /#review tag was removed in Actual, but the receipt was not archived/.test(e.message) && /summary could not be saved|not in the Processed folder|finishing/.test(e.message));
  assert.equal((await entryNow()).archived, undefined);
});

// ---- 11. amounts and added lines ----

const qWith = (picks, extra = {}) => new URLSearchParams({ preview: '1', ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])), ...extra });
async function editorWith(picks, extra = {}) {
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  return fix.editorFor({ id: KEY, entry, summary, query: qWith(picks, { rid: summary.reread?.at ?? '', ...extra }), seen: (await memory.loadSeen())['t1'] ?? null });
}
/** The form the Save button sends for these fields, with the token the preview made. */
async function formWith(picks, extra = {}, more = {}) {
  const ed = await editorWith(picks, extra);
  assert.ok(ed.preview?.token, JSON.stringify(ed.preview));
  return new URLSearchParams({ id: KEY, token: ed.preview.token, state: ed.preview.state, ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])), ...extra, ...more });
}
const saveWith = async (picks, extra = {}, more = {}) => {
  const form = await formWith(picks, extra, more);
  quiet();
  const out = {};
  const message = await fix.commitFix(form, out, { nextcloud: nc, lockWaitMs: 200 });
  return { message, out };
};
const previewParts = (ed) => Object.fromEntries(ed.preview.parts.map((p) => [p.category, p.amount]));

test('parseAmount: plain decimals, negatives and a sane bound; everything else is refused', () => {
  const { parseAmount } = fix;
  assert.equal(parseAmount('4.99'), 499);
  assert.equal(parseAmount('-1.00'), -100);
  assert.equal(parseAmount(' 12 '), 1200);
  assert.equal(parseAmount('.5'), 50);
  assert.equal(parseAmount('+3.1'), 310);
  assert.equal(parseAmount('100000'), 10000000);
  assert.equal(parseAmount('-100000.00'), -10000000);
  for (const bad of ['', ' ', 'abc', '1.234', '1,50', '$4.99', '4.99-', '1e3', '--1', '1.', '0x10', '100000.01', '99999999999999999999', '-100001', 'NaN', 'Infinity', '1 2']) assert.equal(fix.parseAmount(bad), null, bad);
});

test('amounts: a changed amount is divided again (the parts add up to the charge), and the preview says what changed', async () => {
  await seed();
  const ed = await editorWith(WORKER, { a0: '18.00', na0: '', nd0: '' });
  assert.equal(ed.preview.amountsChanged, 1);
  assert.equal(ed.edited, true);
  assert.deepEqual(ed.changed, []);
  assert.equal(ed.preview.parts.reduce((n, p) => n + Math.round(p.amount * 100), 0), 4160);
  assert.equal(ed.preview.check.ok, false); // 38.00 against the printed 40.00
  assert.equal(ed.preview.checkText, "Items add up to 38.00; the receipt's subtotal is 40.00.");
  // the prefilled boxes show the typed text
  assert.equal(ed.items[0].amountText, '18.00');
  assert.equal(ed.items[1].amountText, '10.00');
});

test('amounts: bad formats, too many decimals and huge numbers show an error instead of a preview; negatives are fine', async () => {
  await seed();
  for (const bad of ['abc', '4.999', '1e5', '100001', '', '12,5']) {
    const ed = await editorWith(WORKER, { a1: bad });
    assert.match(ed.preview.error, /The amount for "SPONGES" must be a number such as 4\.99 or -1\.00/, bad);
    assert.equal(ed.preview.parts, undefined);
    assert.equal(ed.items[1].amountText, bad); // what was typed is shown again
  }
  assert.match((await editorWith(WORKER, { a7: '1.00' })).preview.error, /an item this receipt does not have/);
  assert.equal((await editorWith(WORKER, { a1: '-1.00' })).preview.error, undefined);
});

test('amounts: the subtotal check is green when the items match within 2 cents and a warning otherwise', async () => {
  await seed();
  const same = await editorWith(WORKER);
  assert.equal(same.preview.check.ok, true);
  assert.equal(same.preview.checkText, "Items add up to 40.00; the receipt's subtotal is 40.00.");
  assert.equal((await editorWith(WORKER, { a0: '20.02' })).preview.check.ok, true);
  assert.equal((await editorWith(WORKER, { a0: '20.03' })).preview.check.ok, false);
});

test('amounts: without a subtotal the check uses total minus tax, and with neither it is left out', async () => {
  const r = makeReceipt();
  r.subtotal = null;
  await seed({ summary: { receipt: r } });
  const a = await editorWith(WORKER);
  assert.equal(a.preview.checkText, "Items add up to 40.00; the receipt's total minus tax is 40.00.");
  assert.equal(a.preview.check.ok, true);
  const none = makeReceipt();
  none.subtotal = null;
  none.tax = null;
  await seed({ summary: { receipt: none } });
  assert.equal((await editorWith(WORKER)).preview.check, null);
});

test('amounts: prices that include the tax count as adding up (items = total, subtotal is the net)', async () => {
  const r = makeReceipt();
  r.items = r.items.map((it) => ({ ...it, amount: it.amount * 1.04 }));
  r.items[0].amount = 20.8;
  await seed({ summary: { receipt: r } });
  const ed = await editorWith(WORKER);
  assert.equal(ed.preview.check.ok, true);
  assert.match(ed.preview.checkText, /total \(the prices include the tax\)/);
});

test('added lines: a filled row flows through the parts, keeps the tax mark you pick, and a blank row is skipped', async () => {
  await seed();
  const extra = { nd0: 'COUPON', na0: '-2.00', nc0: H, nt0: '*', nd1: '', na1: '', nc1: G, nt1: '*' };
  const ed = await editorWith(WORKER, extra);
  assert.equal(ed.preview.addedCount, 1);
  assert.equal(ed.preview.fields.added.length, 1);
  assert.deepEqual(ed.preview.fields.added[0], { description: 'COUPON', amount: '-2.00', category: H, tax: '*' });
  assert.equal(ed.preview.parts.reduce((n, p) => n + Math.round(p.amount * 100), 0), 4160);
  assert.match(previewParts(ed)[H] ?? '', /\d/);
  assert.ok(ed.preview.parts.find((p) => p.category === H).items.includes('COUPON'));
  assert.equal(ed.preview.check.ok, false); // 38.00 against 40.00
  // the coupon took tax off the household part, which is taxed: 10 - 2 = 8 -> its tax share falls with it
  assert.equal(ed.preview.tax.how, 'proportional'); // items no longer add up to the subtotal
});

test('added lines: a missed item that makes the items add up keeps the by-item tax spread, with no spurious problems', async () => {
  await seed();
  const ed = await editorWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G, nt0: '' });
  assert.equal(ed.preview.check.ok, true);
  assert.deepEqual(ed.preview.problems, []);
  assert.equal(ed.preview.tax.how, 'by-item');
  assert.deepEqual(previewParts(ed), { [G]: '20.00', [H]: '10.80', [S]: '10.80' });
});

test('added lines: a taxed added line takes its share of the tax like the item it is taxed as', async () => {
  await seed();
  // 40 - 2 (MILK) = 38 + a taxed 2.00 line in Games = 40; the tax (1.60) now sits on 22.00 of taxed items
  const ed = await editorWith([G, H, S], { a0: '18.00', nd0: 'GAME CARD', na0: '2.00', nc0: F, nt0: '*' });
  assert.equal(ed.preview.check.ok, true);
  const parts = previewParts(ed);
  assert.equal(parts[G], '18.00');
  assert.equal(Object.values(parts).reduce((n, v) => n + Math.round(v * 100), 0), 4160);
  assert.ok(Number(parts[F]) > 2.1); // taxed
  const none = await editorWith([G, H, S], { a0: '18.00', nd0: 'GAME CARD', na0: '2.00', nc0: F, nt0: '' });
  assert.equal(previewParts(none)[F], '2.00'); // not taxed
});

test('added lines: the form always has a blank row; filled rows persist through the query and a new blank one follows; the cap holds', async () => {
  await seed();
  const first = await editorWith(WORKER);
  assert.equal(first.added.length, 1);
  assert.deepEqual([first.added[0].description, first.added[0].amount], ['', '']);
  assert.equal(first.added[0].category, S); // follows the item above
  assert.equal(first.added[0].tax, '*'); // GUM is taxed
  const second = await editorWith(WORKER, { nd0: 'COUPON', na0: '-1.00', nc0: H, nt0: '' });
  assert.deepEqual(second.added.map((a) => [a.description, a.amount, a.category, a.tax]), [['COUPON', '-1.00', H, ''], ['', '', H, '']]);
  // bad input still shows the typed rows
  const bad = await editorWith(WORKER, { nd0: 'X', na0: 'oops', nc0: F });
  assert.match(bad.preview.error, /Added line 1: the amount must be a number/);
  assert.equal(bad.added[0].amount, 'oops');
  assert.match((await editorWith(WORKER, { na0: '3.00' })).preview.error, /Added line 1: add a description/);
  assert.match((await editorWith(WORKER, { nd0: 'a', na0: '0' })).preview.error, /not 0/);
  assert.match((await editorWith(WORKER, { nd0: 'a', na0: '1', nt0: 'Z' })).preview.error, /tax mark "Z" is not one this receipt has/);
  assert.match((await editorWith(WORKER, { nd0: 'a', na0: '1', nc0: 'Nope / Nope' })).preview.error, /is not one of Actual's categories/);
  assert.match((await editorWith(WORKER, { nd10: 'a', na10: '1' })).preview.error, /At most 10 lines/);
  const ten = {};
  for (let k = 0; k < 10; k++) Object.assign(ten, { [`nd${k}`]: `L${k}`, [`na${k}`]: '1.00', [`nc${k}`]: G });
  const full = await editorWith(WORKER, ten);
  assert.equal(full.added.length, 10); // no blank row beyond the cap
  assert.equal(full.preview.addedCount, 10);
});

test('added lines: a receipt with tax codes offers its marks, defaulting to the item above, else the most common', async () => {
  const r = makeReceipt();
  r.items.forEach((it, i) => { it.tax_code = ['E', 'A', 'A'][i]; delete it.taxable; });
  r.tax_lines = [{ code: 'A', rate: 8, base: 20, amount: 1.6 }, { code: 'E', rate: 0, base: null, amount: 0 }];
  await seed({ summary: { receipt: r } });
  const ed = await editorWith(WORKER);
  assert.deepEqual(ed.marks, { list: ['E', 'A'], flagged: false });
  assert.equal(ed.added[0].tax, 'A');
  const q = await editorWith(WORKER, { nd0: 'COUPON', na0: '-1.00', nc0: H, nt0: 'E' });
  assert.equal(q.preview.fields.added[0].tax, 'E');
  assert.equal(q.added[1].tax, 'E'); // the next blank row follows the row above
  assert.equal(q.preview.parts.reduce((n, p) => n + Math.round(p.amount * 100), 0), 4160);
});

test('token: it changes with an amount and with an added line, so a preview can not be reused for other numbers', async () => {
  await seed();
  const a = (await editorWith(WORKER)).preview.token;
  const b = (await editorWith(WORKER, { a0: '19.00' })).preview.token;
  const c = (await editorWith(WORKER, { nd0: 'X', na0: '1.00', nc0: G })).preview.token;
  const d = (await editorWith(WORKER, { nd0: 'X', na0: '1.01', nc0: G })).preview.token;
  assert.equal(new Set([a, b, c, d]).size, 4);
  // a form whose token was made for 19.00 is refused for 19.01 (nothing is written)
  const form = await formWith(WORKER, { a0: '19.00' });
  form.set('a0', '19.01');
  await refused(form, /changed since the preview/);
  const form2 = await formWith(WORKER, { nd0: 'X', na0: '1.00', nc0: G });
  form2.set('na0', '2.00');
  await refused(form2, /changed since the preview/);
  assert.equal(budget.updates.length, 0);
});

test('commit: edited amounts and an added line are written, noted, saved in pageFix, and are not lessons', async () => {
  await seed();
  const { message } = await saveWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G, nt0: '' });
  assert.match(message, /^Saved r1\.jpg: split into /);
  assert.match(message, /\(1 amount edited, 1 line added\.\)/);
  assert.deepEqual(kidsOf(), [['cg', 2000], ['ch', 1080], ['cs', 1080]].sort());
  const children = budget.txns.get('t1').subtransactions;
  assert.ok(children.find((c) => c.category === 'cg').notes.includes('MISSED'));
  const s = await summaryNow();
  assert.deepEqual(s.pageFix.amounts, { 0: 18 });
  assert.deepEqual(s.pageFix.added, [{ description: 'MISSED', amount: 2, category: G, taxCode: null, taxable: false }]);
  assert.deepEqual(s.pageFix.items, {});
  assert.equal(s.receipt.items[0].amount, 20); // what was read stays
  assert.deepEqual((await memory.loadLessonFile()).lessons, []); // no category changed: nothing learned
  assert.equal(s.plan.parts.reduce((n, p) => n + Math.round(p.amount * 100), 0), 4160);
});

test('commit: the #receipt note shows the edited amounts (one category: the breakdown; and no stale pipeline notes)', async () => {
  const r = makeReceipt();
  r.items[1].amount = 7;
  r.items[1].discountCents = 300;
  await seed({ summary: { receipt: r } });
  // before the edit the part's items say the pipeline folded 3.00 off
  const before = await editorWith(WORKER);
  assert.match(before.preview.parts.map((p) => p.items.join(';')).join('|'), /SPONGES \(pipeline: after 3\.00 off\)/);
  const ed = await editorWith(WORKER, { a1: '10.00' });
  assert.doesNotMatch(ed.preview.parts.map((p) => p.items.join(';')).join('|'), /pipeline/);
  config.splits = false;
  await saveWith([G, G, G], { a1: '10.00', a0: '21.00' });
  const t = budget.txns.get('t1');
  assert.equal(t.category, 'cg');
  assert.match(t.notes, /^#receipt r1\.jpg — items: MILK/);
  assert.doesNotMatch(t.notes, /pipeline/);
});

test('amounts: editing an item loses its own pipeline notes, keeps its neighbours\', and the tax-gap statement is worked out again', async () => {
  const r = makeReceipt();
  r.items[0].discountCents = 100;
  r.items[1].flippedSign = true;
  r.items[1].discountCents = 50;
  await seed({ summary: { receipt: r } });
  const keep = await editorWith(WORKER, { a2: '10.50' });
  const text = keep.preview.parts.map((p) => p.items.join(';')).join('|');
  assert.match(text, /MILK \(pipeline: after 1\.00 off\)/);
  assert.match(text, /SPONGES \(pipeline: after 0\.50 off\)/);
  const drop = await editorWith(WORKER, { a1: '10.50' });
  assert.doesNotMatch(drop.preview.parts.map((p) => p.items.join(';')).join('|'), /SPONGES \(pipeline/);
  const plan = fix.replan({ summary: nc.files.get((await entryNow()).filedAs).summary, picks: WORKER, amounts: [2000, 1050, 1000], labelToId: LABELS, targetCents: 4160 });
  assert.equal(plan.receipt.items[1].flippedSign, undefined);
  assert.equal(plan.receipt.items[1].discountCents, undefined);
  assert.equal(plan.receipt.items[0].discountCents, 100);
});

// A made-up supermarket receipt where the reader doubled two lines (4.00 for 2.00 each) and fixTaxGap spread the 4.00 over the tF group.
async function gapReceipt(extra = {}) {
  const r = {
    merchant: 'Target', store: 'Target', payee: 'Target', date: day(-1), subtotal: 15.48, tax: 1.08, total: 16.56, ...extra,
    tax_lines: [{ code: 'tF', rate: 6.5, base: null, amount: 0.68 }, { code: 'B', rate: 8, base: null, amount: 0.4 }],
    items: [
      { description: 'CANNED BEANS A', plain: 'canned beans', amount: 4, tax_code: 'tF', category: G },
      { description: 'CANNED BEANS B', plain: 'canned beans', amount: 4, tax_code: 'tF', category: G },
      { description: 'RICE', plain: 'rice', amount: 4.49, tax_code: 'tF', category: G },
      { description: 'SALT', plain: 'salt', amount: 1.99, tax_code: 'tF', category: G },
      { description: 'SOAP', plain: 'soap', amount: 5, tax_code: 'B', category: H },
    ],
  };
  const { fixTaxGap } = await import('../src/reconcile.js');
  assert.deepEqual(fixTaxGap(r), { cents: 400, codes: ['tF'] });
  await seed({ summary: { receipt: r } });
  return r;
}
const GAP_PICKS = [G, G, G, G, H];
const centsOf = (ed) => ed.preview.parts.map((p) => [p.category, p.amount]);

test('gap shares: the boxes start from the amounts as read, with a hint, and an untouched receipt gives the same parts as before', async () => {
  const r = await gapReceipt();
  const summary = nc.files.get((await entryNow()).filedAs).summary;
  assert.ok(summary.receipt.items[2].amount < 4.49 && summary.receipt.items[2].gapCents > 0);
  const ed = await editorWith(GAP_PICKS);
  assert.deepEqual(ed.items.map((i) => i.amountText), ['4.00', '4.00', '4.49', '1.99', '5.00']);
  assert.equal(ed.items[4].gap, 0);
  assert.ok(ed.items[2].gap > 0);
  assert.equal(ed.edited, false);
  assert.equal(ed.preview.amountsChanged, 0);
  const before = fix.replan({ summary, picks: GAP_PICKS, labelToId: LABELS, targetCents: 4160 });
  assert.deepEqual(centsOf(ed), before.allocation.map((a) => [a.label, money(a.cents)]));
  assert.ok(ed.preview.problems.some((p) => /over the printed subtotal/.test(p))); // as the worker had it
  const html = (await fetchPage(GAP_PICKS)).html;
  assert.match(html, /As read; lowered by \d\.\d\d to match the subtotal/);
  assert.match(html, /name="a2" value="4\.49"/);
  void r;
});

test('gap shares: correcting the doubled lines gives back what the other items lost, and nothing is lowered any more', async () => {
  await gapReceipt();
  const ed = await editorWith(GAP_PICKS, { a0: '2.00', a1: '2.00' });
  assert.equal(ed.preview.check.ok, true);
  assert.equal(ed.preview.checkText, "Items add up to 15.48; the receipt's subtotal is 15.48.");
  assert.ok(!ed.preview.problems.some((p) => /over the printed subtotal/.test(p)));
  assert.equal(ed.preview.tax.how, 'by-rate');
  const summary = nc.files.get((await entryNow()).filedAs).summary;
  const plan = fix.replan({ summary, picks: GAP_PICKS, amounts: [200, 200, 449, 199, 500], labelToId: LABELS, targetCents: 4160 });
  assert.deepEqual(plan.receipt.items.map((i) => i.amount), [2, 2, 4.49, 1.99, 5]);
  assert.ok(plan.receipt.items.every((i) => i.gapCents === undefined));
  assert.equal(plan.receipt.taxGap, undefined);
  // saving it keeps the amounts as edited
  const { out } = await saveWith(GAP_PICKS, { a0: '2.00', a1: '2.00' });
  assert.deepEqual((await summaryNow()).pageFix.amounts, { 0: 2, 1: 2 });
  assert.ok(out.undo);
});

test('gap shares: correcting only one doubled line still spreads the gap that is left', async () => {
  await gapReceipt();
  const summary = nc.files.get((await entryNow()).filedAs).summary;
  const plan = fix.replan({ summary, picks: GAP_PICKS, amounts: [200, 400, 449, 199, 500], labelToId: LABELS, targetCents: 4160 });
  assert.equal(plan.receipt.taxGap.cents, 200);
  const total = plan.receipt.items.reduce((n, i) => n + Math.round(i.amount * 100), 0);
  assert.equal(total, 1548);
  assert.ok(plan.receipt.items[2].amount < 4.49);
  assert.ok(plan.problems.some((p) => /over the printed subtotal/.test(p)));
});

test('commit: a later preview starts from the saved amounts and added lines, and a second save replaces them', async () => {
  await seed();
  await saveWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G, nt0: '' });
  const ed = await previewOf(null);
  assert.equal(ed.items[0].amountText, '18.00');
  assert.deepEqual(ed.added.map((a) => [a.description, a.amount, a.category]), [['MISSED', '2.00', G], ['', '', G]]);
  // a preview with only categories keeps the saved amounts and lines
  const pv = await previewOf([G, H, S]);
  assert.equal(pv.preview.addedCount, 1);
  assert.equal(pv.preview.check.ok, true);
  assert.equal(pv.edited, false);
  // clearing the added row and restoring the amount removes them
  await saveWith([G, H, S], { a0: '20.00', nd0: '', na0: '' });
  const s = await summaryNow();
  assert.deepEqual(s.pageFix.amounts, {});
  assert.deepEqual(s.pageFix.added, []);
  assert.deepEqual(kidsOf(), [['cg', 2000], ['ch', 1080], ['cs', 1080]].sort());
});

test('undo: the previous amounts and added lines come back with the categories', async () => {
  await seed();
  const first = await saveWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G, nt0: '' });
  const afterFirst = structuredClone(await summaryNow());
  const second = await saveWith([G, G, S], { a0: '17.00', a1: '11.00', nd0: 'MISSED', na0: '2.00', nc0: G, nt0: '', nd1: 'COUPON', na1: '-1.00', nc1: H });
  const s2 = await summaryNow();
  assert.deepEqual(s2.pageFix.amounts, { 0: 17, 1: 11 });
  assert.equal(s2.pageFix.added.length, 2);
  quiet();
  assert.match(await fix.undoFix(undoForm(second.out), {}, { nextcloud: nc, lockWaitMs: 200 }), /^Undone/);
  assert.deepEqual(await summaryNow(), afterFirst);
  assert.deepEqual((await summaryNow()).pageFix.amounts, { 0: 18 });
  assert.deepEqual((await summaryNow()).pageFix.added.map((a) => a.description), ['MISSED']);
  // and all the way back to a summary with no pageFix at all
  const dummy = first;
  assert.ok(dummy.out.undo);
});

test('undo B: an applied review receipt with edits goes back to a summary without them', async () => {
  const { summary } = await seed({ kind: 'B' });
  const { out } = await saveWith([G, H, S], { a1: '9.00', nd0: 'COUPON', na0: '-1.00', nc0: H });
  assert.equal((await summaryNow()).pageFix.added.length, 1);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual(nc.files.get((await entryNow()).filedAs).summary, summary);
  assert.equal(nc.files.get((await entryNow()).filedAs).summary.pageFix, undefined);
});

test('learning: a category change next to an amount edit and an added line still gives one lesson, only for the category', async () => {
  await seed();
  await saveWith([G, G, S], { a1: '10.00', a2: '9.00', nd0: 'MISSED', na0: '1.00', nc0: G });
  const lessons = (await memory.loadLessonFile()).lessons;
  assert.equal(lessons.length, 1);
  assert.match(JSON.stringify(lessons[0]), /SPONGES/);
  assert.doesNotMatch(JSON.stringify(lessons), /MISSED/);
});

test('commit: an added line in a category that is gone is refused before anything is written', async () => {
  await seed();
  const form = await formWith([G, H, S], { nd0: 'X', na0: '1.00', nc0: F });
  form.set('nc0', 'Daily / Removed');
  await refused(form, /not one of Actual's categories/);
  assert.equal(budget.updates.length, 0);
});

test('dry run: amounts and added lines preview but can not be saved', async () => {
  const { summary } = await seed({ kind: 'B' });
  config.dryRun = true;
  fs.writeFileSync(config.statePath, JSON.stringify({ [`dry:${KEY}`]: { done: true, result: 'dry-run:review', at: '2026-11-01T10:00:00.000Z' } }));
  const { saveDrySummary } = await import('../src/dry-summaries.js');
  await saveDrySummary(`dry:${KEY}`, summary);
  if (!server) await startServer();
  const res = await fetch(`${base}/receipt?key=secret&id=${encodeURIComponent(`dry:${KEY}`)}&${qWith(WORKER, { a0: '18.00', nd0: 'X', na0: '2.00', nc0: G }).toString()}`);
  const html = await res.text();
  assert.match(html, /Items add up to 40\.00; the receipt&#39;s subtotal is 40\.00\./);
  assert.doesNotMatch(html, /receipt-fix\?key/);
  quiet();
  await assert.rejects(() => fix.commitFix(new URLSearchParams({ id: `dry:${KEY}`, token: 'x', state: 'y' }), {}, { nextcloud: nc }), /Dry run/);
});

test('page: each item has an amount box (decimal keypad, labelled) and the Add a line section has a blank row', async () => {
  await seed();
  const { html } = await fetchPage(null);
  assert.equal([...html.matchAll(/<input type="text" inputmode="decimal" class="amt" name="a(\d)" value="(\d+\.\d\d)"/g)].length, 3);
  assert.match(html, /name="a0" value="20\.00" aria-label="Amount for MILK"/);
  assert.match(html, /<h2>Add a line<\/h2>/);
  assert.match(html, /name="nd0" value="" maxlength="80" placeholder="Description"/);
  assert.match(html, /name="na0" value="" placeholder="0\.00"/);
  assert.match(html, /<select class="pick" name="nc0"/);
  assert.match(html, /<select class="mark" name="nt0" aria-label="Tax mark"><option value="">None<\/option><option value="\*" selected>Taxed<\/option>/);
  assert.doesNotMatch(html, /nd1/);
  assert.match(html, /data-original="20\.00"/);
  assert.match(html, /amounts and added lines are not lessons/);
  assert.doesNotMatch(html, /<[^>]+ style=/);
});

test('page: the preview explains the item total, and a mismatch warning still allows Save', async () => {
  await seed();
  let { html } = await fetchPage(WORKER, '&' + new URLSearchParams({ a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G }).toString());
  assert.match(html, /Tax and allocation details[\s\S]*Items add up to 40\.00; the receipt&#39;s subtotal is 40\.00\./);
  assert.match(html, /data-preview-dirty="true"/);
  assert.match(html, />Save changes<\/button>/);
  assert.match(html, /name="a0" value="18\.00"/);
  assert.match(html, /name="nd0" value="MISSED"/);
  assert.match(html, /name="nd1" value=""/); // the new blank row, in the form to edit
  ({ html } = await fetchPage(WORKER, '&a0=15.00'));
  assert.match(html, /<p class="banner">Items add up to 35\.00; the receipt&#39;s subtotal is 40\.00\. You can still save/);
  assert.match(html, />Save changes<\/button>/); // saving stays possible
  assert.match(html, /name="token" value="[0-9a-f]{64}"/);
  ({ html } = await fetchPage(WORKER, '&a0=1.2.3'));
  assert.match(html, /role="alert">The amount for &#34;MILK&#34; must be a number/);
  assert.match(html, /name="a0" value="1\.2\.3"/); // what was typed stays in the box
  assert.doesNotMatch(html, />Save changes<\/button>/);
});

test('page: nothing to save when only the form was previewed unchanged, but an amount change offers Save', async () => {
  await seed();
  assert.doesNotMatch((await fetchPage(WORKER)).html, />Save changes<\/button>/);
  assert.match((await fetchPage(WORKER, '&a1=11.00')).html, />Save changes<\/button>/);
});

test('page: the Save form carries the amounts and the added lines, escaped', async () => {
  await seed();
  const { html } = await fetchPage(WORKER, '&' + new URLSearchParams({ nd0: '<b>"x"</b>', na0: '-1.00', nc0: G, nt0: '*' }).toString());
  const form = html.match(/<form\b[^>]*action="receipt-fix\?[^"]*"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.ok(form, 'the signed Save form is present');
  assert.match(form, /name="na0" value="-1\.00"/);
  assert.match(form, /name="nd0" value="&#60;b&#62;&#34;x&#34;&#60;\/b&#62;"|name="nd0" value="&lt;b&gt;/);
  assert.doesNotMatch(form, /<b>"x"/);
  assert.match(form, /name="nt0" value="\*"/);
  assert.match(form, /name="a2" value="10\.00"/);
});

test('http: POST /receipt-fix with edited amounts saves, and the Undo link puts the amounts back', async () => {
  await seed();
  if (!server) await startServer();
  quiet();
  const form = await formWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G });
  const res = await fetch(`${base}/receipt-fix?key=secret`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  assert.equal(res.status, 303);
  assert.deepEqual((await summaryNow()).pageFix.amounts, { 0: 18 });
});

test('wording: the how-it-works help and the docs mention amounts and added lines', async () => {
  await seed();
  const { html } = await fetchPage(null);
  assert.match(html, /an amount box and a category menu/);
  assert.match(html, /Add a line/);
  const docs = fs.readFileSync(new URL('../../docs/review.md', import.meta.url), 'utf8');
  assert.match(docs, /Add a line/);
  assert.match(docs, /pageFix\.amounts/);
});

// ---- 12. Check Actual now, what Actual has, and the reviewed rule ----

const check = (deps = {}) => { quiet(); return fix.checkActual(new URLSearchParams({ id: KEY }), {}, { nextcloud: nc, lockWaitMs: 200, ...deps }); };
const seenNow = async () => (await memory.loadSeen())['t1'];
/** Someone changes the Household part's category to Games in Actual. */
const changeHousehold = () => { const kid = budget.txns.get('t1').subtransactions.find((c) => c.category === 'ch'); kid.category = 'cf'; };

test('check: a charge that still matches says so, stores the look, and writes nothing to Actual', async () => {
  await seed();
  assert.equal(await check(), 'Actual matches what was filed.');
  const rec = await seenNow();
  assert.deepEqual([rec.changed, rec.items, rec.whole, rec.reviewed], [null, [], null, false]);
  assert.ok(Date.parse(rec.at));
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.deletes.length, 0);
  assert.equal(budget.opened, 1);
  assert.equal(budget.closed, 1);
});

test('check: not watched, a changed split is reported from the save checks and the page is then locked', async () => {
  await seed();
  changeHousehold();
  const msg = await check();
  assert.match(msg, /^Changed in Actual: the split was changed in Actual\. Edit it there; this page now shows what Actual has\.$/);
  assert.equal((await seenNow()).changed, 'its split was changed in Actual');
  assert.equal(budget.updates.length, 0);
});

test('check: a watched charge is judged like the sweep does, with the item and the category it has now', async () => {
  const { summary, allocation } = await seed();
  const learning2 = await import('../src/learning.js');
  await memory.watch(learning2.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: summary.receipt, allocation, action: 'split', review: false }));
  changeHousehold();
  const msg = await check();
  assert.equal(msg, 'Changed in Actual: SPONGES is now Games. Edit it there; this page now shows what Actual has.');
  assert.deepEqual((await seenNow()).items, [{ d: 'SPONGES', now: F, said: H }]);
  // the whole charge in one category
  const t = budget.txns.get('t1');
  Object.assign(t, { is_parent: false, subtransactions: [], category: 'cg' });
  assert.match(await check(), /^Changed in Actual: the whole charge is now in Groceries; its split was changed|^Changed in Actual: the whole charge is now in Groceries/);
  assert.equal((await seenNow()).whole, G);
});

test('check: a charge that is gone, a receipt that is not applied, and a dry run', async () => {
  await seed();
  budget.txns.delete('t1');
  assert.equal(await check(), "Couldn't find the charge in Actual. It may have been deleted or moved.");
  assert.equal((await seenNow()).changed, 'the charge is not in Actual any more');
  await seed({ kind: 'B' });
  await assert.rejects(check(), /Actual was not changed for this receipt/);
  config.dryRun = true;
  await assert.rejects(check(), /Dry run/);
});

test('check: it waits for a poll cycle, gives up with the busy message, and opens nothing while busy', async () => {
  await seed();
  let release;
  const held = exclusive(() => new Promise((r) => { release = r; }));
  await assert.rejects(check({ lockWaitMs: 20 }), /in the middle of a check/);
  assert.equal(budget.opened, 0);
  const patient = check({ lockWaitMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(budget.opened, 0);
  release();
  await held;
  assert.equal(await patient, 'Actual matches what was filed.');
  assert.equal(isBusy(), false);
});

test('check: #review removed counts as reviewed even when categories were changed too; the status list shows it as Done', async () => {
  const { summary, allocation } = await seed({ review: true });
  const learning2 = await import('../src/learning.js');
  await memory.watch(learning2.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: summary.receipt, allocation, action: 'split', review: true }));
  changeHousehold();
  budget.txns.get('t1').notes = '#receipt r1.jpg'; // #review removed by hand
  const msg = await check();
  assert.match(msg, /Changed in Actual: SPONGES is now Games\./);
  assert.match(msg, /#review was removed, so it counts as reviewed\.$/);
  assert.equal((await seenNow()).reviewed, true);
  const { statusKind } = await import('../src/status-kind.js');
  const { withSeen } = await import('../src/receipt-lists.js');
  const state = await loadState();
  assert.equal(statusKind({ ...state[KEY], key: KEY }), 'applied-review');
  assert.equal(statusKind({ ...withSeen(state, await memory.loadSeen())[KEY], key: KEY }), 'done');
  assert.equal(state[KEY].reviewed, undefined); // nothing is written into the state
  // not watched: the save checks give the same answer
  await memory.patchWatch({ drop: ['t1'] });
  budget.txns.get('t1').subtransactions.find((c) => c.category === 'cf').category = 'ch'; // put back
  assert.match(await check(), /^Actual matches what was filed\. #review was removed/);
  assert.equal((await seenNow()).reviewed, true);
});

test('check: still tagged #review is not reviewed', async () => {
  await seed({ review: true });
  assert.equal(await check(), 'Actual matches what was filed.');
  assert.deepEqual([(await seenNow()).review, (await seenNow()).reviewed], [true, false]);
});

test('clearing #review that is already gone changes nothing in Actual and still marks the receipt checked and archivable', async () => {
  await seed({ review: true });
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  quiet();
  const msg = await fix.markCheckedNow(KEY, { nextcloud: nc });
  assert.equal(msg, 'Marked r1.jpg as checked.');
  assert.equal(budget.updates.length, 0);
  assert.equal((await entryNow()).result, 'split');
});

test('archive: a receipt Actual shows reviewed (with other changes) is archived as Done, with no #review to clear and no Actual write', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  changeHousehold();
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  await check();
  const archiveNc = {
    readSummary: (p) => nc.readSummary(p),
    async archiveFile({ from, dir, summary, at }) {
      const dest = `${dir}/${path.posix.basename(from)}`;
      nc.files.delete(from);
      nc.files.set(dest, { summary: { ...summary, archived: { at, from } } });
      return { dest, shrunk: null, fileMissing: false };
    },
  };
  const updates = budget.updates.length;
  quiet();
  const out = {};
  const message = await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 });
  assert.doesNotMatch(message, /#review tag was removed in Actual first/);
  assert.equal(out.archived, true);
  assert.equal(budget.updates.length, updates);
  assert.ok((await entryNow()).archived);
});

test('O1: "Looks right: clear #review and archive" whose archive step fails offers no Undo afterwards: none was handed out', async () => {
  const { archiveOne } = await import('../src/archive-actions.js');
  const { receiptUndo } = await import('../src/panel-receipt-page.js');
  const { queueLabel } = await import('../src/panel-queue.js');
  const { signUndo } = await import('../src/panel-actions.js');
  await seed({ review: true });
  const failing = { readSummary: (p) => nc.readSummary(p), async archiveFile() { throw new Error('Nextcloud is down'); } };
  quiet();
  const out = {};
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), out, { nc: failing, nextcloud: nc, lockWaitMs: 200 }), /#review tag was removed in Actual, but the receipt could not be archived/);
  assert.equal(out.archived, undefined);
  assert.equal(out.undo, undefined, 'the archive path hands out no Undo');
  const entry = await entryNow();
  assert.equal(entry.result, 'split', '#review was cleared');
  assert.ok(entry.fixedOnPage.markOnly, 'the tag-only record: a Looks right, which has no Undo');
  assert.equal(receiptUndo({ id: KEY, entry }, null), null, 'not re-signed on a revisit');
  assert.notEqual(queueLabel({ ...entry, key: KEY }), 'Saved · Undo');
  const { html } = await fetchPage(null);
  assert.doesNotMatch(html, /action="undo-receipt-fix|Marked as checked · Undo/);
  const updates = budget.updates.length;
  const notes = budget.txns.get('t1').notes;
  const msg = await fix.undoFix(new URLSearchParams(signUndo('undo-receipt-fix', { id: KEY, at: entry.fixedOnPage.at })), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /"Looks right" can't be undone: it only removed the #review tag in Actual\. Nothing was changed\./);
  assert.equal(budget.updates.length, updates, 'nothing written to Actual');
  assert.equal(budget.txns.get('t1').notes, notes, '#review not put back');
  assert.equal((await entryNow()).result, 'split');
});

test('Looks right from the page offers no Undo; an Undo link signed for it anyway is refused, changes nothing and keeps the confirmation mark', async () => {
  const { receiptUndo } = await import('../src/panel-receipt-page.js');
  const { queueLabel } = await import('../src/panel-queue.js');
  const { signUndo } = await import('../src/panel-actions.js');
  await seed({ review: true });
  const { message, out } = await commit(WORKER, { intent: 'confirm', mark: 'yes' });
  assert.match(message, /^Marked r1\.jpg as checked \(#review removed\)\.$/);
  assert.equal(out.undo, undefined, 'no Undo is handed out');
  const entry = await entryNow();
  assert.ok(entry.fixedOnPage.markOnly);
  assert.equal(entry.result, 'split');
  assert.deepEqual((await memory.loadMarks()).confirmed, ['t1'], 'the confirmation mark (the learning signal) is recorded');
  assert.equal(receiptUndo({ id: KEY, entry }, null), null);
  assert.notEqual(queueLabel({ ...entry, key: KEY }), 'Saved · Undo');
  const { html } = await fetchPage(null);
  assert.doesNotMatch(html, /action="undo-receipt-fix|Undo available|Saved · Undo/);
  const notes = budget.txns.get('t1').notes;
  const updates = budget.updates.length;
  // A link signed as the old code did (valid signature, inside 15 minutes) is still refused.
  const form = new URLSearchParams(signUndo('undo-receipt-fix', { id: KEY, at: entry.fixedOnPage.at }));
  assert.match(await fix.undoFix(form, {}, { nextcloud: nc, lockWaitMs: 200 }), /^"Looks right" can't be undone: it only removed the #review tag in Actual\. Nothing was changed\.$/);
  assert.equal(budget.updates.length, updates, 'nothing written to Actual');
  assert.equal(budget.txns.get('t1').notes, notes, '#review not put back');
  const after = await entryNow();
  assert.deepEqual(after, entry, 'the receipt\'s records are untouched');
  assert.deepEqual((await memory.loadMarks()).confirmed, ['t1'], 'the confirmation mark stays');
});

test('an older Looks right record that once offered Undo (undoOffered, no undoEnded) loads, shows no Undo, refuses one and archives', async () => {
  const { receiptUndo } = await import('../src/panel-receipt-page.js');
  const { queueLabel } = await import('../src/panel-queue.js');
  const { signUndo } = await import('../src/panel-actions.js');
  const { archiveOne } = await import('../src/archive-actions.js');
  await seed({ review: true });
  await commit(WORKER, { intent: 'confirm', mark: 'yes' });
  const state = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
  // As an older version stored it: the confirmation mark snapshot for its Undo, and the Undo marked as offered.
  state[KEY].fixedOnPage = { ...state[KEY].fixedOnPage, undoOffered: true, marks: { confirmed: false, corrected: null } };
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  const entry = await entryNow();
  assert.equal(receiptUndo({ id: KEY, entry }, null), null);
  assert.notEqual(queueLabel({ ...entry, key: KEY }), 'Saved · Undo');
  const link = signUndo('undo-receipt-fix', { id: KEY, at: entry.fixedOnPage.at });
  const { html } = await fetchPage(null, `&undo=undo-receipt-fix&u=${encodeURIComponent(JSON.stringify(link))}&notice=${encodeURIComponent('Marked r1.jpg as checked.')}`);
  assert.match(html, /Marked r1\.jpg as checked\./);
  assert.doesNotMatch(html, /action="undo-receipt-fix|Undo available|Saved · Undo/);
  const updates = budget.updates.length;
  assert.match(await fix.undoFix(new URLSearchParams(link), {}, { nextcloud: nc, lockWaitMs: 200 }), /"Looks right" can't be undone/);
  assert.equal(budget.updates.length, updates);
  assert.deepEqual((await memory.loadMarks()).confirmed, ['t1'], 'the old marks snapshot is not put back');
  quiet();
  const out = {};
  const message = await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  assert.match(message, /^Archived r1\.jpg/);
  assert.doesNotMatch(message, /Undo/);
  assert.equal(out.archived, true);
});

test('page: a charge changed in Actual locks the editor, shows what Actual has, when it was looked at, and keeps Check Actual now', async () => {
  const { summary, allocation } = await seed();
  const learning2 = await import('../src/learning.js');
  await memory.watch(learning2.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: summary.receipt, allocation, action: 'split', review: false }));
  changeHousehold();
  await check();
  const { html } = await fetchPage(null);
  assert.match(html, /<b>This charge was changed in Actual<\/b>Edit it there\. This page shows what Actual has\./);
  assert.match(html, /Changed in Actual: <b>Fun \/ Games<\/b>/);
  assert.match(html, /the worker chose Daily \/ Household/);
  assert.match(html, /Looked at Actual just now\./);
  assert.match(html, /<form method="post" action="receipt-check\?key=secret">[^]*?name="id"[^]*?Check Actual now<\/button>/);
  assert.doesNotMatch(html, /<select class="pick"/);
  assert.doesNotMatch(html, /name="preview"/);
  assert.doesNotMatch(html, /<h2>Add a line<\/h2>/);
  // even a preview link shows no preview
  const pv = await fetchPage(WORKER, '&a0=15.00');
  assert.doesNotMatch(pv.html, /<div class="banner todo"><b>Preview<\/b>/);
  assert.doesNotMatch(pv.html, />Save changes<\/button>/);
});

test('page: a change that cannot be matched says so in one line; a charge that matches keeps the editor and shows when it was looked at', async () => {
  await seed();
  changeHousehold();
  await check();
  let { html } = await fetchPage(null);
  assert.match(html, /The split was changed in Actual\./);
  assert.doesNotMatch(html, /name="a0"/);
  await seed();
  await check();
  ({ html } = await fetchPage(null));
  assert.match(html, /Looked at Actual just now: it matches what was filed\./);
  assert.match(html, /name="a0"/);
  assert.match(html, /Check Actual now<\/button>/);
  // never offered in a review receipt or without a look
  await seed({ kind: 'B' });
  assert.doesNotMatch((await fetchPage(null)).html, /Check Actual now/);
});

test('page: a reviewed receipt is Done: no "Check in Actual", the line says #review was removed, and the archive button is the plain one', async () => {
  await seed({ review: true });
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  await check();
  const { html } = await fetchPage(null);
  assert.doesNotMatch(html, />Applied — check it in Actual<\/|>Check in Actual<\//);
  assert.match(html, /data-workspace-status>Filed in Actual<\//);
  assert.match(html, /#review was removed from the charge in Actual, so this counts as reviewed\./);
  assert.match(html, /Archive receipt</);
  assert.doesNotMatch(html, /<button>Looks right: clear #review and archive<\/button>/);
  assert.match(html, /Looked at Actual just now; #review is removed there: it matches what was filed\./);
});

test('http: POST /receipt-check needs the key, refuses another site, and redirects back with the notice', async () => {
  await seed();
  if (!server) await startServer();
  quiet();
  const body = new URLSearchParams({ id: KEY }).toString();
  const post = (path2, headers = {}) => fetch(`${base}${path2}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post('/receipt-check')).status, 403);
  assert.equal((await post('/receipt-check?key=wrong')).status, 403);
  assert.equal((await post('/receipt-check?key=secret', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(budget.opened, 0);
  const ok = await post('/receipt-check?key=secret', { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 303);
  const where = new URL(ok.headers.get('location'), base);
  assert.equal(where.pathname, '/receipt');
  assert.equal(where.searchParams.get('id'), KEY);
  assert.equal(where.searchParams.get('notice'), 'Actual matches what was filed.');
});

// ---- 13. round two: guards, never touching typed numbers, an honest view of Actual ----

test('guard: edits that leave a tiny positive net of mixed signs are refused in the preview and in the commit (no part may exceed the charge)', async () => {
  const r = makeReceipt();
  r.subtotal = null; // nothing printed to bound the items
  r.tax = null;
  await seed({ summary: { receipt: r } });
  const extra = { a0: '20.00', nd0: 'BIG DISCOUNT', na0: '-39.99', nc0: G, nt0: '' };
  const ed = await editorWith(WORKER, extra);
  assert.equal(ed.preview.error, 'One part would be bigger than the whole charge; check the amounts.');
  assert.equal(ed.preview.parts, undefined);
  // a hand-made form (no honest token can exist) is refused before Actual is touched
  const form = new URLSearchParams({ id: KEY, token: 'x'.repeat(64), state: (await previewOf(WORKER)).preview.state, ...Object.fromEntries(WORKER.map((p, i) => [`c${i}`, p])), ...extra });
  await refused(form, /One part would be bigger than the whole charge; check the amounts\. Nothing was changed\./);
  assert.equal(budget.updates.length, 0);
  // a sensible discount is fine, and so are plain category changes on the same receipt
  assert.equal((await editorWith(WORKER, { nd0: 'COUPON', na0: '-1.00', nc0: G })).preview.error, undefined);
  assert.equal((await editorWith([G, G, S])).preview.error, undefined);
});

test('commit: a look at Actual newer than the preview makes the preview stale; a look older than the last save is ignored', async () => {
  await seed();
  const form = await formWith(WORKER, { a1: '11.00' });
  changeHousehold();
  await check(); // the look at Actual is now part of the preview's fingerprint
  await refused(form, /changed since the preview/);
  assert.equal(budget.updates.length, 0);
  // an old look (before the entry's last change) says nothing about what is filed now
  await memory.recordSeen({ t1: { at: '2026-01-01T00:00:00.000Z', changed: 'its split was changed in Actual', items: [], whole: null, review: false, reviewed: false } });
  budget.txns.get('t1').subtransactions.find((c) => c.category === 'cf').category = 'ch'; // put back
  const ed = await previewOf([G, H, S]);
  assert.equal(ed.locked, undefined);
  assert.ok(ed.preview.token);
});

test('commit: a split whose child note was edited in Actual is refused (notes count, not only amounts and categories)', async () => {
  await seed();
  const form = await formFor([G, G, S]);
  budget.txns.get('t1').subtransactions[0].notes = 'my own words';
  await refused(form, /its split was changed in Actual/);
  assert.equal(budget.updates.length, 0);
});

test('added lines: control characters and extra spaces are cleaned, and "|" or "#" are refused with a message', async () => {
  await seed();
  const ok = await editorWith(WORKER, { nd0: '  BAGS\u0000\t  AND​\n BOXES ', na0: '1.00', nc0: G });
  assert.equal(ok.preview.fields.added[0].description, 'BAGS AND BOXES');
  for (const bad of ['MILK | EGGS', '#review', 'A #receipt x.jpg']) {
    const ed = await editorWith(WORKER, { nd0: bad, na0: '1.00', nc0: G });
    assert.equal(ed.preview.error, "Added line 1: the description can't contain | or #.", bad);
  }
  // a saved line that is not valid any more is dropped on reading
  const entry = await entryNow();
  const summary = structuredClone(nc.files.get(entry.filedAs).summary);
  summary.pageFix = { at: 'x', kind: 'applied', items: {}, amounts: {}, added: [{ description: 'A | B', amount: 1, category: G, taxCode: null, taxable: false }, { description: 'FINE', amount: 1, category: G, taxCode: null, taxable: false }] };
  const ed = fix.editorFor({ id: KEY, entry, summary, query: null });
  assert.deepEqual(ed.added.map((a) => a.description), ['FINE', '']);
});

test('undo: it restores the summary this change replaced even when the file in Nextcloud still holds an older save', async () => {
  await seed();
  await saveWith([G, H, S], { a0: '18.00', nd0: 'MISSED', na0: '2.00', nc0: G });
  const afterFirst = structuredClone(await summaryNow());
  nc.failRefile = 'write'; // the file moves but its new summary is not written
  const second = await saveWith([G, H, S], { a0: '17.00', nd0: 'MISSED', na0: '3.00', nc0: G });
  assert.match(second.message, /could not be/);
  assert.deepEqual(await summaryNow(), afterFirst); // the file still has the first save's summary
  nc.failRefile = false;
  quiet();
  assert.match(await fix.undoFix(undoForm(second.out), {}, { nextcloud: nc, lockWaitMs: 200 }), /^Undone/);
  const back = await summaryNow();
  assert.deepEqual(back.pageFix.amounts, { 0: 18 });
  assert.deepEqual(back.plan, afterFirst.plan);
  assert.deepEqual(back.pageFix.added.map((a) => a.amount), [2]);
});

// A made-up receipt the worker had to correct (see gapReceipt above): 4.00 too much on the tF items, spread over all four.
test('gap + edits: what you typed is never lowered; the leftover gap goes only on items you did not edit', async () => {
  await gapReceipt();
  const summary = nc.files.get((await entryNow()).filedAs).summary;
  const plan = fix.replan({ summary, picks: GAP_PICKS, amounts: [200, 400, 449, 199, 500], labelToId: LABELS, targetCents: 4160 });
  assert.equal(plan.receipt.items[0].amount, 2); // typed: exactly as typed
  assert.equal(plan.receipt.items[0].gapCents, undefined);
  assert.equal(plan.receipt.taxGap.cents, 200);
  assert.ok(plan.receipt.items[1].amount < 4 && plan.receipt.items[2].amount < 4.49 && plan.receipt.items[3].amount < 1.99);
  assert.equal(plan.receipt.items.reduce((n, i) => n + Math.round(i.amount * 100), 0), 1548);
  // two typed lines: the two others take it
  const two = fix.replan({ summary, picks: GAP_PICKS, amounts: [300, 300, 449, 199, 500], labelToId: LABELS, targetCents: 4160 });
  assert.deepEqual(two.receipt.items.slice(0, 2).map((i) => i.amount), [3, 3]);
  assert.ok(two.receipt.items[2].amount < 4.49 && two.receipt.items[3].amount < 1.99);
  // every item of the group typed: nothing may be lowered, the gap stays (the check warns)
  const all = fix.replan({ summary, picks: GAP_PICKS, amounts: [401, 401, 450, 200, 500], labelToId: LABELS, targetCents: 4160 });
  assert.deepEqual(all.receipt.items.map((i) => i.amount), [4.01, 4.01, 4.5, 2, 5]);
  assert.equal(all.receipt.taxGap, undefined);
  assert.ok(all.problems.some((p) => /printed subtotal is 15\.48/.test(p)));
});

test('gap + edits: the check counts the numbers in the boxes; an untouched receipt the worker corrected warns and explains', async () => {
  await gapReceipt();
  const un = await editorWith(GAP_PICKS);
  assert.equal(un.preview.check.ok, false);
  assert.equal(un.preview.checkText, "Items add up to 19.48; the receipt's subtotal is 15.48.");
  assert.equal(un.preview.pipelineNote, 'The worker lowered the items marked tF by 4.00 in all to match the subtotal.');
  const { html } = await fetchPage(GAP_PICKS);
  assert.match(html, /<p class="banner">Items add up to 19\.48/);
  assert.match(html, /The worker lowered the items marked tF by 4\.00 in all to match the subtotal\./);
  // the same parts as before for an untouched receipt
  const summary = nc.files.get((await entryNow()).filedAs).summary;
  const before = fix.replan({ summary, picks: GAP_PICKS, labelToId: LABELS, targetCents: 4160 });
  assert.deepEqual(un.preview.parts.map((p) => [p.category, p.amount]), before.allocation.map((a) => [a.label, money(a.cents)]));
  // typing the real numbers makes it green with no note
  const typed = await editorWith(GAP_PICKS, { a0: '2.00', a1: '2.00' });
  assert.equal(typed.preview.check.ok, true);
  assert.equal(typed.preview.pipelineNote, null);
});

test('check: with LEARNING=off, or an old watch that a save from this page has outdated, the saved checks decide, not the old snapshot', async () => {
  const { summary, allocation } = await seed();
  const learning2 = await import('../src/learning.js');
  const snap = () => learning2.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: summary.receipt, allocation, action: 'split', review: false });
  await memory.watch(snap());
  changeHousehold();
  config.learning.mode = 'off';
  assert.match(await check(), /^Changed in Actual: the split was changed in Actual\./);
  assert.deepEqual((await seenNow()).items, []);
  config.learning.mode = 'on';
  assert.match(await check(), /^Changed in Actual: SPONGES is now Games\./); // the snapshot is used again
  // a save from this page newer than the snapshot: the snapshot is not the latest write
  const e = await entryNow();
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...e, fixedOnPage: { at: '2099-01-01T00:00:00.000Z', markOnly: true } } }));
  assert.match(await check(), /^Changed in Actual: the split was changed in Actual\./);
  assert.deepEqual((await seenNow()).items, []);
});

test('commit: with LEARNING=off the old watch entry is dropped (it would describe the wrong write), and nothing else is written to memory', async () => {
  const { summary, allocation } = await seed();
  const learning2 = await import('../src/learning.js');
  await memory.watch(learning2.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: summary.receipt, allocation, action: 'split', review: false }));
  config.learning.mode = 'off';
  await saveWith([G, G, S]);
  assert.deepEqual(await memory.loadWatch(), []);
  assert.deepEqual((await memory.loadLessonFile()).lessons, []);
  assert.deepEqual(await memory.loadMarks(), { confirmed: [], corrected: {} });
});

test('undo: the look at Actual that the save replaced comes back, or is forgotten when there was none', async () => {
  await seed();
  const none = await saveWith([G, G, S]);
  assert.equal((await seenNow()).changed, null); // the save recorded "matches"
  quiet();
  await fix.undoFix(undoForm(none.out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.equal(await seenNow(), undefined);
  await check();
  const before = structuredClone(await seenNow());
  assert.ok(before);
  const { out } = await saveWith([G, G, S]);
  assert.notEqual((await seenNow()).at, before.at);
  quiet();
  await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.deepEqual(await seenNow(), before);
});

test('seen: two items with the same name, only one moved: only that one shows as changed (matched by place, not name)', async () => {
  const r = makeReceipt();
  r.items = [{ description: 'MILK', plain: 'milk', amount: 20, taxable: false, category: G }, { description: 'MILK', plain: 'milk', amount: 10, taxable: true, category: H }, { description: 'GUM', plain: 'gum', amount: 10, taxable: true, category: S }];
  await seed({ summary: { receipt: r } });
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  const rec = { at: '2099-01-01T00:00:00.000Z', changed: null, items: [{ i: 1, d: 'MILK', now: F, said: H }], whole: null, review: false, reviewed: false };
  const ed = fix.editorFor({ id: KEY, entry, summary, query: null, seen: rec });
  assert.deepEqual(ed.items.map((i) => i.inActual), [null, F, null]);
  // an older record without a place still matches by name
  const old = fix.editorFor({ id: KEY, entry, summary, query: null, seen: { ...rec, items: [{ d: 'GUM', now: F, said: S }] } });
  assert.deepEqual(old.items.map((i) => i.inActual), [null, null, F]);
});

test('learning: lines added on the page are marked in the watch snapshot and are never a lesson, even when you move them in Actual', async () => {
  await seed();
  await saveWith([G, H, S], { nd0: 'MISSED', na0: '2.00', nc0: G, nd1: 'COUPON', na1: '-1.00', nc1: H });
  const [snap] = await memory.loadWatch();
  const flat = snap.parts.flatMap((p) => p.items);
  assert.deepEqual(flat.filter((i) => i.addedOnPage).map((i) => i.d).sort(), ['COUPON', 'MISSED']);
  assert.deepEqual(flat.filter((i) => i.i != null && !i.addedOnPage).map((i) => i.i).sort(), [0, 1, 2]);
  assert.ok(flat.filter((i) => i.addedOnPage).every((i) => i.i >= 3));
  // someone moves the part that holds MISSED in Actual: no lesson for MISSED
  const t = budget.txns.get('t1');
  const kid = t.subtransactions.find((c) => /MISSED/.test(c.notes));
  kid.category = 'cf';
  const learning2 = await import('../src/learning.js');
  const j = learning2.judge(snap, { ...t, amount: t.amount }, (id) => ({ cg: G, ch: H, cs: S, cf: F })[id] ?? null);
  assert.ok(j.fixes.every((f) => !f.item.addedOnPage));
  assert.ok(!j.fixes.some((f) => f.item.d === 'MISSED' || f.item.d === 'COUPON'));
});

test('preview: a receipt Actual already shows reviewed does not offer "Mark as checked"', async () => {
  await seed({ review: true });
  const e = await entryNow();
  const sum = nc.files.get(e.filedAs).summary;
  const flagged = fix.editorFor({ id: KEY, entry: e, summary: sum, query: qWith(WORKER, { a1: '11.00' }) });
  assert.equal(flagged.preview.review, true);
  const reviewed = fix.editorFor({ id: KEY, entry: { ...e, reviewed: { at: 'x' } }, summary: sum, query: qWith(WORKER, { a1: '11.00' }) });
  assert.equal(reviewed.preview.review, false);
});

test('page: a flipped discount is mentioned on the item, and the locked page explains a change in plain words', async () => {
  const r = makeReceipt();
  r.items[1].flippedSign = true;
  r.items[1].discountCents = 100;
  await seed({ summary: { receipt: r } });
  assert.match((await fetchPage(null)).html, /A line of item numbers was read as plus and treated as a discount here\./);
  changeHousehold();
  await check();
  const { html } = await fetchPage(null);
  assert.match(html, /The split was changed in Actual\./);
  assert.doesNotMatch(html, /Why: its/);
});

test('archive all: a reviewed receipt whose #review is back is not archived; one that is still reviewed is, without +review', async () => {
  const { archiveAll } = await import('../src/archive-actions.js');
  await seed({ review: true });
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  await check();
  budget.txns.get('t1').notes = '#receipt r1.jpg #review'; // put back after the look
  const archiveNc = { readSummary: (p) => nc.readSummary(p), async archiveFile({ from, dir, summary, at }) { const dest = `${dir}/${path.posix.basename(from)}`; nc.files.delete(from); nc.files.set(dest, { summary: { ...summary, archived: { at, from } } }); return { dest, shrunk: null, fileMissing: false }; } };
  quiet();
  const msg = await archiveAll(new URLSearchParams(), {}, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /Archived 0 receipts\. 1 could not be moved and stay on the list \(r1\.jpg: #review is back on the charge in Actual/);
  const e = await entryNow();
  assert.equal(e.archived, undefined);
  assert.equal(e.result, 'split+review');
  // #review is gone again: it is archived, and "+review" is dropped so a Restore leaves a Done receipt
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  await check();
  const msg2 = await archiveAll(new URLSearchParams(), {}, { nc: archiveNc, nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg2, /^Archived 1 receipt\./);
  const done = await entryNow();
  assert.ok(done.archived);
  assert.equal(done.result, 'split');
});

test('restore: a reviewed receipt that was archived comes back as Done, not as "check it in Actual"', async () => {
  const { archiveOne, restoreOne } = await import('../src/archive-actions.js');
  const { statusKind } = await import('../src/status-kind.js');
  await seed({ review: true });
  changeHousehold();
  budget.txns.get('t1').notes = '#receipt r1.jpg';
  await check();
  const ncs = {
    readSummary: (p) => nc.readSummary(p),
    async archiveFile({ from, dir, summary, at }) { const dest = `${dir}/${path.posix.basename(from)}`; nc.files.delete(from); nc.files.set(dest, { summary: { ...summary, archived: { at, from } } }); return { dest, shrunk: null, fileMissing: false }; },
    async restoreFile({ from, dir, summary }) { const dest = `${dir}/${path.posix.basename(from)}`; nc.files.delete(from); nc.files.set(dest, { summary }); return { dest }; },
  };
  quiet();
  await archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: ncs, nextcloud: nc, lockWaitMs: 200 });
  await memory.forgetSeen(['t1']); // even with the look gone
  await restoreOne(new URLSearchParams({ id: KEY }), {}, { nc: ncs, nextcloud: nc, lockWaitMs: 200 });
  const e = await entryNow();
  assert.equal(e.archived, undefined);
  assert.equal(statusKind({ ...e, key: KEY }), 'done');
});

// ---- 14. a missed discount: the gap notice on the page ----

test('gap notice: names the items the worker lowered; says the printed savings match only when they do; an old summary has no such sentence', async () => {
  await gapReceipt();
  let html = (await fetchPage(GAP_PICKS)).html;
  assert.match(html, /<p class="notice warn">The items came to 4\.00 more than the subtotal, so the worker lowered CANNED BEANS A, CANNED BEANS B, RICE and SALT by that much in total\. Usually this means the reader missed a discount line\./);
  assert.match(html, /set that item&#39;s amount and leave the others as printed \(or add the discount with Add a line\)\./);
  assert.doesNotMatch(html, /which matches/);
  await gapReceipt({ savings: 4 });
  html = (await fetchPage(GAP_PICKS)).html;
  assert.match(html, /The receipt shows savings of 4\.00, which matches\./);
  await gapReceipt({ savings: 3.2 }); // savings that are not the gap say nothing
  assert.doesNotMatch((await fetchPage(GAP_PICKS)).html, /which matches/);
  // once you type your own amounts the items no longer show the worker's share, and the notice goes with them
  const q = queryOf(GAP_PICKS);
  for (const [i, v] of ['2.00', '2.00', '4.40', '1.90', '5.00'].entries()) q.set(`a${i}`, v);
  const entry = await entryNow();
  assert.equal(fix.editorFor({ id: KEY, entry, summary: nc.files.get(entry.filedAs).summary, query: q }).gapNotice, undefined);
});

// ---- 15. Read again ----

const NEW_READING = () => ({
  merchant: 'Target', date: day(-1), subtotal: 36, tax: 1.6, total: 37.6, savings: 4, tax_lines: null,
  items: [{ description: 'MILK', plain: 'milk', amount: 20 }, { description: 'SPONGES', plain: 'sponges', amount: 20 }, { description: 'COUPON', plain: 'coupon', amount: -4 }],
});
const rereadDeps = (over = {}) => ({
  nextcloud: nc,
  prepare: async () => ['data:image/jpeg;base64,AAAA'],
  read: async () => ({ receipt: NEW_READING(), mode: 'test' }),
  actual: { idToLabel: () => new Map(), findById: async () => null },
  categorize: async (receipt) => {
    for (const it of receipt.items) it.category = it.description === 'MILK' ? G : H;
    return { categorizedWith: 'stub', history: [] };
  },
  ...over,
});
const readyCtx = { labels: LABELS, ctx: { modelReady: async () => {} } };
const reread = await import('../src/reread.js');
const { isDue } = await import('../src/state.js');

test('read again: allowed for an applied receipt; refused after a page fix, when Actual was changed, when archived, and in the wrong mode', async () => {
  const { entry, summary } = await seed();
  assert.deepEqual(reread.rereadState(KEY, entry, summary), { ok: true, kind: 'applied' });
  assert.match(reread.rereadState(KEY, { ...entry, fixedOnPage: { at: new Date().toISOString() } }, summary).reason, /Undo it first/);
  assert.match(reread.rereadState(KEY, { ...entry, fixedOnPage: { at: '2026-11-02T10:00:00.000Z' } }, summary).reason, /can no longer be undone/); // the 15 minutes are over
  // "Mark as checked" alone does not number anything by item: Read again stays possible
  assert.equal(reread.rereadState(KEY, { ...entry, fixedOnPage: { at: '2026-11-02T10:00:00.000Z', markOnly: true } }, { ...summary, pageFix: { at: 'x', items: {}, amounts: {}, added: [], markedChecked: true } }).ok, true);
  assert.match(reread.rereadState(KEY, entry, { ...summary, pageFix: { at: new Date().toISOString(), items: { 0: H }, amounts: {}, added: [] } }).reason, /Undo it first/);
  const look = { at: '2026-11-03T10:00:00.000Z', changed: 'its category was changed in Actual', items: [], whole: null };
  assert.match(reread.rereadState(KEY, entry, summary, look).reason, /changed in Actual/);
  assert.equal(reread.rereadState(KEY, entry, summary, { ...look, changed: null }).ok, true); // a look that found nothing changed is fine
  assert.match(reread.rereadState(KEY, { ...entry, archived: { at: 'x' } }, summary).reason, /Archived/);
  assert.equal(reread.rereadState(KEY, { ...entry, reread: { at: 'x' } }, summary).pending, true);
  assert.match(reread.rereadState(`dry:${KEY}`, entry, summary).reason, /dry run mode/);
  // sent to review without a change to Actual: Try again is the way, and the page says nothing more
  const b = await seed({ kind: 'B' });
  assert.deepEqual([reread.rereadState(KEY, b.entry, b.summary).ok, reread.rereadState(KEY, b.entry, b.summary).quiet], [false, true]);
  // waiting for its charge: the photo is in the inbox
  assert.deepEqual(reread.rereadState(KEY, { done: false, waiting: { reason: 'x' }, reading: {} }, null), { ok: true, kind: 'inbox' });
});

test('read again: the request marks the entry, starts a check, writes nothing to Actual, and is refused (changing nothing) when it must be', async () => {
  const { summary } = await seed();
  let triggered = 0;
  server = makeServer(() => { triggered++; }, { nextcloud: nc, prepare: async () => ['data:image/jpeg;base64,AAAA'], lockWaitMs: 500 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  quiet();
  const post = (headers = {}) => fetch(`${base}/receipt-reread?key=secret`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ id: KEY }).toString() });
  assert.equal((await fetch(`${base}/receipt-reread`, { method: 'POST', redirect: 'manual', body: 'id=x' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(triggered, 0);
  assert.equal((await entryNow()).reread, undefined);
  // the photo is gone
  const stat = nc.statPath;
  nc.statPath = async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
  const lost = await post({ 'sec-fetch-site': 'same-origin' });
  assert.match(new URL(lost.headers.get('location'), base).searchParams.get('notice'), /no longer in Nextcloud.*Nothing was changed/);
  nc.statPath = stat;
  assert.equal((await entryNow()).reread, undefined);
  // allowed
  const ok = await post({ 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 303);
  assert.match(new URL(ok.headers.get('location'), base).searchParams.get('notice'), /Reading the photo again.*Nothing is written to Actual/);
  assert.equal(triggered, 1);
  assert.ok((await entryNow()).reread.at);
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.opened, 0);
  // the page says so, and offers no second button
  const html = (await fetchPage(null)).html;
  assert.match(html, /Reading again/);
  assert.doesNotMatch(html, /receipt-reread\?key/);
  // asked twice: refused
  const again = await post({ 'sec-fetch-site': 'same-origin' });
  assert.match(new URL(again.headers.get('location'), base).searchParams.get('notice'), /Reading again/);
  assert.equal(triggered, 1);
  void summary;
});

test('read again: the page offers the button on an applied receipt, a reason when a page fix is saved, and nothing on a Try again receipt', async () => {
  await seed();
  let html = (await fetchPage(null)).html;
  assert.match(html, /<form method="post" action="receipt-reread\?key=secret">[\s\S]*?<button class="plain">Read again<\/button>/);
  assert.match(html, /Nothing is written to Actual: the items below start from the new reading/);
  await seed({ entry: { fixedOnPage: { at: new Date().toISOString(), kind: 'applied', wrote: {}, before: {} } } });
  html = (await fetchPage(null)).html;
  assert.doesNotMatch(html, /Read again<\/button>/);
  assert.match(html, /Can&#39;t read again: A change from this page is saved/);
  await seed({ kind: 'B' });
  html = (await fetchPage(null)).html;
  assert.doesNotMatch(html, /action="receipt-reread\?/);
  assert.doesNotMatch(html, /Can&#39;t read again/);
});

test('read again: an applied receipt gets the new reading in its summary; Actual, the plan, lessons and marks are untouched; the old reading is kept', async () => {
  const { summary: before } = await seed({ action: 'split' });
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), reread: { at: '2026-11-04T10:00:00.000Z', kind: 'applied' } } }));
  const state = await loadState();
  const lessonsBefore = JSON.stringify(await memory.loadLessonFile());
  const budgetBefore = JSON.stringify([...budget.txns.values()]);
  quiet();
  await reread.rereadFiled(KEY, state, readyCtx, rereadDeps());
  const entry = state[KEY];
  assert.equal(entry.reread, undefined);
  assert.ok(entry.rereadAt);
  const now = nc.files.get(entry.filedAs).summary;
  assert.deepEqual(now.receipt.items.map((i) => [i.description, i.amount, i.category]), [['MILK', 20, G], ['SPONGES', 16, H]]); // the coupon line is folded into SPONGES, as for a first read
  assert.equal(now.receipt.items[1].discountCents, 400);
  assert.equal(now.receipt.savings, 4);
  assert.equal(now.readWith, 'test');
  assert.deepEqual(now.reread.before.receipt, before.receipt); // the old reading stays available
  assert.deepEqual(now.plan, before.plan); // what Actual has stays as filed
  assert.deepEqual(now.transaction, before.transaction);
  assert.equal(JSON.stringify([...budget.txns.values()]), budgetBefore);
  assert.equal(budget.updates.length, 0);
  assert.equal(JSON.stringify(await memory.loadLessonFile()), lessonsBefore);
  // the editor starts from the new reading, still a normal "Save changes" receipt
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: entry }));
  const ed = await editorWith([G, H]);
  assert.equal(ed.ok, true);
  assert.equal(ed.kind, 'applied');
  assert.deepEqual(ed.items.map((i) => i.description), ['MILK', 'SPONGES']);
  assert.equal(ed.preview.token.length, 64);
});

test('read again: a preview made before the new reading cannot be saved over it', async () => {
  await seed();
  const stale = await formWith(WORKER);
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), reread: { at: '2026-11-04T10:00:00.000Z' } } }));
  const state = await loadState();
  quiet();
  const three = () => ({ ...NEW_READING(), subtotal: 36, items: [{ description: 'MILK', amount: 20 }, { description: 'SPONGES', amount: 10 }, { description: 'GUM', amount: 6 }] });
  await reread.rereadFiled(KEY, state, readyCtx, rereadDeps({ read: async () => ({ receipt: three(), mode: 'test' }) }));
  assert.equal(nc.files.get(state[KEY].filedAs).summary.receipt.items[2].amount, 6);
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  await refused(stale, /changed since the preview/);
  assert.equal(budget.updates.length, 0);
});

test('read again: refused when the receipt changed since it was asked for (a saved page fix, a locked charge, a lost photo); nothing is read or changed', async () => {
  const { summary } = await seed();
  const asked = { ...(await entryNow()), reread: { at: '2026-11-04T10:00:00.000Z' } };
  const run = async (entryOver, put = () => {}, deps = {}) => {
    fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...asked, ...entryOver } }));
    put();
    const state = await loadState();
    let read = 0;
    quiet();
    await reread.rereadFiled(KEY, state, readyCtx, rereadDeps({ read: async () => { read++; return { receipt: NEW_READING(), mode: 'x' }; }, ...deps }));
    assert.equal(read, 0);
    assert.equal(state[KEY].reread, undefined);
    assert.equal(nc.files.get(state[KEY].filedAs).summary.receipt.items.length, 3);
    return state[KEY].rereadNote.text;
  };
  assert.match(await run({ fixedOnPage: { at: new Date().toISOString() } }), /Undo it first.*Nothing was changed/);
  assert.match(await run({ archived: { at: 'x' } }), /Archived/);
  await memory.recordSeen({ t1: { at: '2099-01-01T00:00:00.000Z', changed: 'its category was changed in Actual', items: [], whole: null } });
  assert.match(await run({}), /changed in Actual/);
  await memory.forgetSeen(['t1']);
  const gone = nc.files.get(asked.filedAs);
  assert.match(await run({}, () => {}, { nextcloud: { ...nc, downloadPath: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } } }), /no longer in Nextcloud/);
  void gone;
  void summary;
});

test('read again: a reader that fails keeps the request for the next check, and gives up after three tries with a note', async () => {
  await seed();
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), reread: { at: '2026-11-04T10:00:00.000Z' } } }));
  const state = await loadState();
  quiet();
  const broken = rereadDeps({ read: async () => { throw new Error('the model is down'); } });
  await reread.rereadFiled(KEY, state, readyCtx, broken);
  assert.equal(state[KEY].reread.tries, 1);
  await reread.rereadFiled(KEY, state, readyCtx, broken);
  await reread.rereadFiled(KEY, state, readyCtx, broken);
  assert.equal(state[KEY].reread, undefined);
  assert.match(state[KEY].rereadNote.text, /failed 3 times \(the model is down\)/);
  assert.equal(nc.files.get(state[KEY].filedAs).summary.reread, undefined);
  // the page says what happened
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  assert.match((await fetchPage(null)).html, /Read again was not done: Reading again failed 3 times/);
});

test('read again: receipts still in the inbox are read by the normal check (due at once), and a request whose photo left the inbox is dropped', async () => {
  const now = Date.now();
  assert.equal(isDue({ done: true, result: 'dry-run:split' }, now, false), false);
  assert.equal(isDue({ done: true, result: 'dry-run:split', reread: { at: 'x' } }, now, false), true);
  assert.equal(isDue({ done: false, waiting: { nextCheck: new Date(now + 3600000).toISOString() }, reread: { at: 'x' } }, now, false), true);
  const state = {
    [`${inbox}/a.jpg@1`]: { done: false, waiting: { nextCheck: 'x' }, reread: { at: 'x' } },
    [`${inbox}/b.jpg@1`]: { done: true, result: 'split', reread: { at: 'x' } },
    [`${inbox}/c.jpg@1`]: { done: true, result: 'split', filedAs: `${processed}/c.jpg`, applied: { txnId: 't' }, reread: { at: 'x' } },
  };
  assert.deepEqual(reread.filedRereads(state), [`${inbox}/c.jpg@1`]);
  assert.equal(reread.dropStaleRereads(state, new Set([`${inbox}/a.jpg@1`])), true);
  assert.equal(state[`${inbox}/a.jpg@1`].reread !== undefined, true);
  assert.equal(state[`${inbox}/b.jpg@1`].reread, undefined);
  assert.match(state[`${inbox}/b.jpg@1`].rereadNote.text, /no longer in Nextcloud/);
  assert.equal(state[`${inbox}/c.jpg@1`].reread !== undefined, true);
});

// ---- 16. Read again, round two: what the page shows after a re-read, and Use old reading ----

/** Ask for a re-read of the seeded receipt and run it (the check's part) with this reading; returns the entry afterwards. */
async function rereadWith(readFn, { entry: entryOver = {}, deps = {} } = {}) {
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), reread: { at: '2026-11-04T10:00:00.000Z' }, ...entryOver } }));
  const state = await loadState();
  quiet();
  await reread.rereadFiled(KEY, state, readyCtx, rereadDeps({ ...(readFn ? { read: async () => ({ receipt: readFn(), mode: 'test' }) } : {}), ...deps }));
  fs.writeFileSync(config.statePath, JSON.stringify(state));
  return state[KEY];
}
const THREE = () => ({ ...NEW_READING(), subtotal: 36, items: [{ description: 'MILK', amount: 20 }, { description: 'SPONGES', amount: 10 }, { description: 'GUM', amount: 6 }] });
const ridOf = async () => encodeURIComponent((await summaryNow()).reread.at);
const restoreForm = () => new URLSearchParams({ id: KEY });
const restoreIt = () => reread.restoreReading(restoreForm(), {}, { nextcloud: nc, lockWaitMs: 200 });

test('read again: an untouched new reading that divides the charge differently shows Save, and Save works; once saved, the same parts say nothing differs', async () => {
  await seed();
  await rereadWith(THREE);
  const rid = await ridOf();
  let html = (await fetchPage([G, H, H], `&rid=${rid}`)).html;
  assert.match(html, /The photo was read again/);
  assert.match(html, /<form\b[^>]*method="post"[^>]*action="receipt-fix\?key=secret"[^>]*>/);
  assert.match(html, />Save changes<\/button>/);
  assert.doesNotMatch(html, /Nothing differs from what is in Actual/);
  const { message } = await saveWith([G, H, H]);
  assert.match(message, /^Saved r1\.jpg/);
  assert.ok(budget.updates.length > 0);
  html = (await fetchPage([G, H, H], `&rid=${await ridOf()}`)).html;
  assert.match(html, /Nothing to update\./);
  assert.doesNotMatch(html, />Save changes<\/button>/);
  assert.doesNotMatch(html, /The photo was read again/); // a later save: the line about the charge "not touched" is gone
});

test('read again: "Changed in Actual" labels follow the items of the new reading (matched by name), not the old places', async () => {
  await seed();
  // the new reading lists the items in another order: SPONGES was item 1, now it is item 0
  await rereadWith(() => ({ ...THREE(), items: [{ description: 'SPONGES', amount: 10 }, { description: 'MILK', amount: 20 }, { description: 'GUM', amount: 6 }] }));
  await memory.recordSeen({ t1: { at: '2099-01-01T00:00:00.000Z', changed: null, items: [{ i: 1, d: 'SPONGES', now: S }], whole: null, review: false, reviewed: false } });
  const ed = await editorWith([H, G, H]);
  assert.equal(ed.locked, true);
  assert.deepEqual(ed.items.map((i) => [i.description, i.inActual]), [['SPONGES', S], ['MILK', null], ['GUM', null]]);
});

test('read again: the new reading\'s own doubts are kept apart; the filed problems and Actual\'s #review are not touched', async () => {
  const { summary: before } = await seed({ review: true });
  await rereadWith(() => ({ ...THREE(), subtotal: 40 })); // the items no longer add up to the subtotal
  const now = await summaryNow();
  assert.deepEqual(now.problems, before.problems);
  assert.ok(now.reread.doubts.some((d) => /line items add up to 36\.00 but the printed subtotal is 40\.00/.test(d)), JSON.stringify(now.reread.doubts));
  assert.match(budget.txns.get('t1').notes, /#review/);
  assert.equal(budget.updates.length, 0);
  const html = (await fetchPage(null)).html;
  assert.match(html, /Why it needs review \(when it was filed\)/);
  assert.match(html, /About the new reading[\s\S]*add up to 36\.00/);
  assert.match(html, /did not change the #review tag/);
});

test('read again: a Preview link from before the re-read is ignored with a plain message; so is one from before Use old reading', async () => {
  await seed();
  const stale = queryOf([G, H, H]);
  await rereadWith(THREE);
  const entry = await entryNow();
  const ed = fix.editorFor({ id: KEY, entry, summary: await summaryNow(), query: stale });
  assert.equal(ed.rereadStale, true);
  assert.equal(ed.preview, null);
  assert.match((await fetchPage([G, H, H])).html, /The receipt was read again\. Check the new items before saving\./);
  // the right reading id works
  assert.ok((await editorWith([G, H, H])).preview.token);
  // after Use old reading the id changes again
  const rid = await ridOf();
  await restoreIt();
  assert.match((await fetchPage([G, H, H], `&rid=${rid}`)).html, /The receipt was read again\. Check the new items before saving\./);
});

test('read again: the date is judged against the original upload time (entry.lastmod), not the filed file\'s time', async () => {
  await seed();
  const dates = [];
  const deps = { categorize: async (receipt) => { dates.push(receipt.date); for (const it of receipt.items) it.category = G; return { categorizedWith: 'stub', history: [] }; } };
  await rereadWith(THREE, { entry: { lastmod: new Date().toISOString() }, deps });
  await rereadWith(THREE, { entry: { lastmod: '2020-01-01T00:00:00.000Z' }, deps });
  assert.equal(dates[0], day(-1));
  assert.equal(dates[1], null); // a printed date far from the upload is not believed
});

test('read again: "not done" notes go away after a day or once a later re-read has happened', async () => {
  await seed();
  const note = (at) => fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...JSON.parse(fs.readFileSync(config.statePath, 'utf8'))[KEY], rereadNote: { at, text: 'Archived.' } } }));
  note(new Date().toISOString());
  assert.match((await fetchPage(null)).html, /Read again was not done: Archived\./);
  note(new Date(Date.now() - 3 * 86400000).toISOString());
  assert.doesNotMatch((await fetchPage(null)).html, /Read again was not done/);
  await seed();
  await rereadWith(THREE);
  note(new Date(Date.now() - 1000).toISOString()); // older than the next re-read: stale
  await rereadWith(THREE, { entry: { rereadNote: undefined } });
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), rereadNote: { at: '2026-11-04T10:00:00.000Z', text: 'Archived.' } } }));
  assert.doesNotMatch((await fetchPage(null)).html, /Read again was not done/);
});

test('read again: an outage (the model server asleep) is not counted and stops the filed re-reads; other failures count', async () => {
  await seed();
  const { TransientError } = await import('../src/errors.js');
  const KEY2 = `${inbox}/r2.jpg@e1`;
  const first = { ...(await entryNow()), reread: { at: 'x' } };
  const state = { [KEY]: first, [KEY2]: { ...first } };
  let asked = 0;
  const ctx = { labels: LABELS, ctx: { modelReady: async () => { asked++; throw new TransientError('model not ready'); } } };
  let saves = 0;
  quiet();
  await reread.rereadAllFiled(state, [KEY, KEY2], { ...ctx, save: async () => { saves++; }, beat: async () => {} }, rereadDeps());
  assert.equal(asked, 1, 'the second receipt is not tried after an outage');
  assert.equal(saves, 1);
  assert.deepEqual(state[KEY].reread, { at: 'x' }); // no tries counted, still asked for
  assert.equal(state[KEY].reread.tries, undefined);
  assert.equal(state[KEY].rereadNote, undefined);
});

test('read again: with nothing in the inbox, the check reads every filed receipt asked for, saving after each, and writes nothing to Actual', async () => {
  await seed();
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), reread: { at: 'x' } } }));
  const state = await loadState();
  assert.deepEqual(reread.filedRereads(state), [KEY]);
  let saved2 = 0;
  quiet();
  await reread.rereadAllFiled(state, reread.filedRereads(state), { ...readyCtx, save: async () => { saved2++; }, beat: async () => {} }, rereadDeps());
  assert.equal(saved2, 1);
  assert.equal(state[KEY].reread, undefined);
  assert.ok(state[KEY].rereadAt);
  assert.ok((await summaryNow()).reread.at);
  assert.equal(budget.updates.length, 0);
  assert.deepEqual(reread.filedRereads(state), []);
});

test('Read again after "Looks right": there is no Undo to end, none is offered or applied, while queued or after the new reading', async () => {
  const { receiptUndo } = await import('../src/panel-receipt-page.js');
  const { queueLabel } = await import('../src/panel-queue.js');
  const { signUndo } = await import('../src/panel-actions.js');
  await seed({ review: true });
  const { out } = await commit(WORKER, { intent: 'confirm', mark: 'yes' });
  assert.equal(out.undo, undefined);
  const saved = await entryNow();
  assert.equal(receiptUndo({ id: KEY, entry: saved }, null), null, 'no Looks right Undo before the re-read either');
  const asked = {};
  await reread.requestReread(new URLSearchParams({ id: KEY }), asked, { nextcloud: nc, lockWaitMs: 200 });
  assert.equal(asked.trigger, 'read again');
  const queued = await entryNow();
  assert.ok(queued.reread, 'the re-read is queued');
  assert.deepEqual(queued.fixedOnPage, saved.fixedOnPage, 'the save record is kept as it was');
  assert.equal(receiptUndo({ id: KEY, entry: queued }, null), null);
  assert.notEqual(queueLabel({ ...queued, key: KEY }), 'Saved · Undo');
  const { html } = await fetchPage(null);
  assert.doesNotMatch(html, /action="undo-receipt-fix|Undo available/);
  const notes = budget.txns.get('t1').notes;
  const updates = budget.updates.length;
  const undo = () => fix.undoFix(new URLSearchParams(signUndo('undo-receipt-fix', { id: KEY, at: saved.fixedOnPage.at })), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(await undo(), /"Looks right" can't be undone/);
  await rereadWith(null);
  assert.equal((await entryNow()).reread, undefined, 'the re-read ran');
  assert.match(await undo(), /"Looks right" can't be undone/);
  assert.equal(budget.updates.length, updates, 'nothing written to Actual');
  assert.equal(budget.txns.get('t1').notes, notes, '#review not put back');
  assert.equal((await entryNow()).result, 'split');
});

test('read again: a pending switch between dry run and live refuses the request; flags of the other mode are cleared with a note', async () => {
  await seed();
  const { writeSettings } = await import('../src/settings.js');
  await writeSettings({ dryRun: true, changedBy: 'test' }); // takes effect at the next check
  await assert.rejects(() => reread.requestReread(new URLSearchParams({ id: KEY }), {}, { nextcloud: nc, lockWaitMs: 200 }), (err) => err instanceof PanelError && /about to switch/.test(err.message));
  assert.equal((await entryNow()).reread, undefined);
  fs.rmSync(config.settingsPath, { force: true });
  const state = { [`dry:${KEY}`]: { done: true, result: 'dry-run:split', reread: { at: 'x' } } };
  assert.equal(reread.dropStaleRereads(state, new Set([`dry:${KEY}`])), true);
  assert.equal(state[`dry:${KEY}`].reread, undefined);
  assert.match(state[`dry:${KEY}`].rereadNote.text, /switched between dry run and live/);
});

test('use old reading: puts the previous reading back, writes nothing to Actual, makes earlier previews stale and lets Read again work again', async () => {
  const { summary: before } = await seed();
  await rereadWith(THREE);
  const lessons = JSON.stringify(await memory.loadLessonFile());
  const stale = await formWith([G, H, H]);
  let html = (await fetchPage(null)).html;
  assert.match(html, /<form method="post" action="receipt-reread-restore\?key=secret">[\s\S]*?<button class="plain">Use old reading<\/button>/);
  const message = await restoreIt();
  assert.match(message, /earlier reading is back/);
  const now = await summaryNow();
  assert.deepEqual(now.receipt, before.receipt);
  assert.deepEqual(now.plan, before.plan);
  assert.equal(now.reread.restored, true);
  assert.equal(now.reread.before, undefined);
  assert.equal(now.reread.doubts, undefined);
  assert.equal(budget.updates.length, 0);
  assert.equal(JSON.stringify(await memory.loadLessonFile()), lessons);
  assert.equal((await entryNow()).card.store, 'Target');
  await refused(stale, /changed since the preview/);
  const entry = await entryNow();
  assert.equal(reread.rereadState(KEY, entry, now).ok, true);
  html = (await fetchPage(null)).html;
  assert.doesNotMatch(html, /Use old reading<\/button>/);
  assert.match(html, /Read again<\/button>/);
  assert.match(html, /The earlier reading was put back/);
});

test('use old reading: refused after a save from the new reading, when the charge was changed in Actual, when archived, and with nothing to put back', async () => {
  await seed();
  assert.equal(reread.restoreState(KEY, await entryNow(), await summaryNow()).ok, false); // never re-read
  await rereadWith(THREE);
  assert.equal(reread.restoreState(KEY, await entryNow(), await summaryNow()).ok, true);
  assert.equal(reread.restoreState(KEY, { ...(await entryNow()), archived: { at: 'x' } }, await summaryNow()).ok, false);
  assert.equal(reread.restoreState(KEY, { ...(await entryNow()), reread: { at: 'x' } }, await summaryNow()).ok, false);
  const look = { at: '2099-01-01T00:00:00.000Z', changed: 'its category was changed in Actual', items: [], whole: null };
  assert.match(reread.restoreState(KEY, await entryNow(), await summaryNow(), look).reason, /changed in Actual/);
  await saveWith([G, H, H]);
  const after = reread.restoreState(KEY, await entryNow(), await summaryNow());
  assert.equal(after.ok, false);
  assert.match(after.reason, /saved from the new reading/);
  await assert.rejects(() => restoreIt(), (err) => err instanceof PanelError && /saved from the new reading.*Nothing was changed/.test(err.message));
  assert.equal(config.dryRun, false);
});

test('use old reading: a waiting receipt gets the reading it had back, if the same reader made it; a dry-run receipt keeps none', async () => {
  const { currentReader } = await import('../src/receipt.js');
  const mine = currentReader();
  const prev = { receipt: { merchant: 'Old', items: [{ description: 'OLD', amount: 1 }] }, mode: 'test', reader: mine };
  const waiting = (over = {}) => ({ done: false, waiting: { reason: 'x', until: 'y' }, reading: { receipt: { merchant: 'New', items: [{ description: 'NEW', amount: 1 }] }, mode: 'test', reader: mine }, previousReading: { reading: prev, at: 'z' }, rereadAt: 'w', ...over });
  assert.deepEqual(reread.restoreState(KEY, waiting(), null), { ok: true, kind: 'inbox' });
  assert.equal(reread.restoreState(KEY, waiting({ previousReading: { reading: { ...prev, reader: { ...mine, host: 'elsewhere' } } } }), null).ok, false);
  assert.equal(reread.restoreState(KEY, waiting({ previousReading: undefined }), null).ok, false);
  assert.equal(reread.restoreState(`dry:${KEY}`, { done: true, result: 'dry-run:split' }, null).ok, false);
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: waiting() }));
  quiet();
  assert.match(await reread.restoreReading(restoreForm(), {}, { nextcloud: nc, lockWaitMs: 200 }), /earlier reading is back/);
  const e = await entryNow();
  assert.deepEqual(e.reading, prev);
  assert.equal(e.previousReading, undefined);
  assert.notEqual(e.rereadAt, 'w');
});

test('http: POST /receipt-reread-restore needs the key, refuses another site, and redirects back with the notice', async () => {
  await seed();
  await rereadWith(THREE);
  if (!server) await startServer();
  quiet();
  const post = (path2, headers = {}) => fetch(`${base}${path2}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: restoreForm().toString() });
  assert.equal((await post('/receipt-reread-restore')).status, 403);
  assert.equal((await post('/receipt-reread-restore?key=secret', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.ok((await summaryNow()).reread.before);
  const ok = await post('/receipt-reread-restore?key=secret', { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 303);
  assert.match(new URL(ok.headers.get('location'), base).searchParams.get('notice'), /earlier reading is back/);
  assert.equal((await summaryNow()).reread.before, undefined);
  assert.equal(budget.updates.length, 0);
});

// ---- 17. Read again, round three ----

test('read again: a timeout on this photo or a cloud reader failing on it counts as a try (and the others are still read); a plain outage waits but is dropped after a day', async () => {
  await seed();
  const { TransientError, markCounted } = await import('../src/errors.js');
  const KEY2 = `${inbox}/r2.jpg@e1`;
  const first = { ...(await entryNow()), reread: { at: new Date().toISOString() } };
  const run = async (deps) => {
    const state = { [KEY]: structuredClone(first), [KEY2]: structuredClone(first) };
    quiet();
    const seenResults = [];
    for (let round = 0; round < 3; round++) {
      await reread.rereadAllFiled(state, reread.filedRereads(state), { ...readyCtx, save: async () => {}, beat: async () => {} }, rereadDeps(deps));
      seenResults.push([state[KEY].reread?.tries, state[KEY2].reread?.tries]);
    }
    return { state, seenResults };
  };
  // the download times out (the 15 s limit on a big file): both receipts are tried each check, and after 3 checks both give up with a note
  const slow = { nextcloud: { ...nc, downloadPath: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } } };
  let out = await run(slow);
  assert.deepEqual(out.seenResults, [[1, 1], [2, 2], [undefined, undefined]]);
  assert.match(out.state[KEY].rereadNote.text, /failed 3 times/);
  assert.match(out.state[KEY2].rereadNote.text, /failed 3 times/);
  // a cloud reader that times out on this photo (it may be billed)
  out = await run({ read: async () => { throw markCounted(new TransientError('reader HTTP 504: gateway timeout'), 'reader'); } });
  assert.deepEqual(out.seenResults, [[1, 1], [2, 2], [undefined, undefined]]);
  // a real outage is not counted ...
  const down = { read: async () => { throw new TransientError('reader HTTP 503: busy'); } };
  out = await run(down);
  assert.deepEqual(out.seenResults, [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
  assert.deepEqual(out.state[KEY].reread.tries, undefined);
  assert.equal(out.state[KEY].rereadNote, undefined);
  // ... but it does not last for ever
  const old = { ...first, reread: { at: new Date(Date.now() - 2 * 86400000).toISOString() } };
  const state = { [KEY]: old };
  quiet();
  await reread.rereadFiled(KEY, state, readyCtx, rereadDeps(down));
  assert.equal(state[KEY].reread, undefined);
  assert.match(state[KEY].rereadNote.text, /could not be done for 24 hours/);
});

test('read again: "Changed in Actual" labels use the name stored with the look after two re-reads, not a place in the last reading before them', async () => {
  await seed();
  const reading = (names) => () => ({ ...THREE(), items: names.map((d, i) => ({ description: d, amount: [10, 20, 6][i] })) });
  await rereadWith(reading(['SPONGES', 'MILK', 'GUM'])); // 1st re-read
  await rereadWith(reading(['GUM', 'SPONGES', 'MILK'])); // 2nd re-read: "before" is now the 1st
  assert.equal((await summaryNow()).reread.before.receipt.items[0].description, 'SPONGES');
  // a hand change in Actual, seen against the worker's original watch: SPONGES was item 1 then
  await memory.recordSeen({ t1: { at: '2099-01-01T00:00:00.000Z', changed: null, items: [{ i: 1, d: 'SPONGES', now: S }], whole: null, review: false, reviewed: false } });
  const ed = await editorWith([H, H, H]);
  assert.deepEqual(ed.items.map((i) => [i.description, i.inActual]), [['GUM', null], ['SPONGES', S], ['MILK', null]]);
  // and after Use old reading as well
  await memory.forgetSeen(['t1']);
  await restoreIt();
  await memory.recordSeen({ t1: { at: '2099-01-02T00:00:00.000Z', changed: null, items: [{ i: 1, d: 'SPONGES', now: S }], whole: null, review: false, reviewed: false } });
  const back = await editorWith([G, H, S]);
  assert.deepEqual(back.items.map((i) => [i.description, i.inActual]), [['SPONGES', S], ['MILK', null], ['GUM', null]]); // Use old reading goes back one step: to the 1st re-read
});

test('an amount edit on a one-category receipt still shows Save (the parts do not change), and Save records the amounts; an untouched receipt says nothing differs', async () => {
  const { summary } = await seed({ action: 'categorize' });
  // one category: everything went to Groceries
  const receipt = makeReceipt();
  for (const it of receipt.items) it.category = G;
  const base = { ...summary, receipt };
  const { allocation } = fix.replan({ summary: base, picks: [G, G, G], labelToId: LABELS, targetCents: 4160 });
  const one = { ...base, plan: { action: 'categorize', applied: true, parts: partsOf(allocation) } };
  const filedAs = (await entryNow()).filedAs;
  nc.files.set(filedAs, { summary: one });
  const t = budget.txns.get('t1');
  Object.assign(t, { is_parent: false, subtransactions: undefined, category: 'cg', notes: '#receipt r1.jpg' });
  fs.writeFileSync(config.statePath, JSON.stringify({ [KEY]: { ...(await entryNow()), result: 'categorize', applied: { txnId: 't1', action: 'categorize', at: '2026-11-01T10:00:00.000Z' } } }));
  const picks = [G, G, G];
  // untouched
  let html = (await fetchPage(picks, '&rid=')).html;
  assert.match(html, /Nothing to update\./);
  // the user sets one amount (the gap notice tells them to): the parts stay the same, but there is something to save
  html = (await fetchPage(picks, '&rid=&a0=21.00&a1=10.00&a2=10.00')).html;
  assert.match(html, />Save changes<\/button>/);
  assert.doesNotMatch(html, /Nothing differs from what is in Actual/);
  const { message } = await saveWith(picks, { a0: '21.00', a1: '10.00', a2: '10.00' });
  assert.match(message, /^Saved r1\.jpg/);
  assert.match(message, /1 amount edited/);
  assert.deepEqual((await summaryNow()).pageFix.amounts, { 0: 21 });
});

// ---- 18. Cash purchases: Create in Actual, Split this one instead, Undo, Archive ----

const cash = await import('../src/cash.js');
const { archiveOne, restoreOne: restoreArchived } = await import('../src/archive-actions.js');
const { statusKind: statusOf } = await import('../src/status-kind.js');
const { SETTINGS_BY_KEY, normalizeValue, SettingError } = await import('../src/web-settings-schema.js');
const { rememberAccounts } = await import('../src/known-accounts.js');
const CASH_PROBLEM = 'paid in cash (50.00 handed over), so there\'s no bank charge of 41.60 to match; use Create in Actual on this receipt\'s page, or Archive it if you entered it by hand';
const archiveNc = () => ({
  readSummary: (p) => nc.readSummary(p),
  async archiveFile({ from, dir, summary, at }) { const dest = `${dir}/${path.posix.basename(from)}`; nc.files.delete(from); nc.files.set(dest, { summary: { ...summary, archived: { at, from } } }); return { dest, shrunk: null, fileMissing: false }; },
  async restoreFile({ from, dir, summary }) { const dest = `${dir}/${path.posix.basename(from)}`; nc.files.delete(from); nc.files.set(dest, { summary }); return { dest }; },
});

/** The fake Actual's way of adding a transaction (the stand-in API has none); budget.adds records every call. */
function cashApi(payees = [{ id: 'p1', name: 'Target' }]) {
  budget.adds = [];
  budget.newPayees = [];
  api.getPayees = async () => payees.map((p) => ({ ...p }));
  api.createPayee = async ({ name }) => { const id = `pn${payees.length}`; payees.push({ id, name }); budget.newPayees.push(name); return id; };
  const dropChild = api.deleteTransaction; // (the stand-in only knows split parts: a whole transaction goes too)
  api.deleteTransaction = async (id) => { await dropChild(id); budget.txns.delete(id); };
  api.addTransactions = async (account, list, opts) => {
    for (const t of list) {
      budget.adds.push({ account, t: structuredClone(t), opts });
      const { subtransactions, ...rest } = t;
      budget.txns.set(t.id, { ...rest, account, is_parent: Boolean(subtransactions?.length), ...(subtransactions ? { subtransactions: subtransactions.map((c, i) => ({ id: `ck${budget.adds.length}-${i}`, ...c })) } : {}) });
    }
    return 'ok';
  };
}
afterEach(() => {
  delete api.addTransactions;
  delete api.createPayee;
  config.cashAccount = '';
});

/** A cash receipt in Needs review (made-up store and items): total 41.60, items already categorized the way the worker would. */
function cashSeed({ receipt: over = {}, entry: entryOver = {}, key = KEY } = {}) {
  const receipt = { ...makeReceipt(), payment_method: 'cash', cash_tendered: 50, ...over };
  delete receipt.store;
  delete receipt.payee;
  const filedAs = `${review}/r1.jpg`;
  const summary = { file: 'r1.jpg', receipt, transaction: null, plan: null, problems: [CASH_PROBLEM] };
  nc.files.set(filedAs, { summary });
  fs.writeFileSync(config.statePath, JSON.stringify({ [key]: { done: true, result: 'review', at: '2026-11-01T10:00:00.000Z', filedAs, ...entryOver } }));
  config.cashAccount = 'Checking';
  cashApi();
  return summary;
}
async function cashPreview(picks, extra = {}) {
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  const acct = 'acct' in extra ? extra.acct : config.cashAccount;
  const cashLook = await cash.lookAtActual({ entry, summary, accountName: acct || config.cashAccount }, {});
  const query = new URLSearchParams({ preview: '1', rid: '', acct, ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])), ...extra });
  return { ed: fix.editorFor({ id: KEY, entry, summary, query, cashLook }), look: cashLook };
}
async function cashForm(picks, extra = {}, more = {}) {
  const { ed } = await cashPreview(picks, extra);
  assert.ok(ed.preview?.token, JSON.stringify(ed.preview));
  const acct = 'acct' in extra ? extra.acct : config.cashAccount;
  return new URLSearchParams({ id: KEY, token: ed.preview.token, state: ed.preview.state, acct, action: 'create', ...Object.fromEntries(picks.map((p, i) => [`c${i}`, p])), ...more });
}
const cashDeps = { nextcloud: undefined, lockWaitMs: 200, newId: () => 'new-1' };
const doCash = async (form, out = {}) => { quiet(); return { message: await cash.commitCash(form, out, { ...cashDeps, nextcloud: nc }), out }; };
const cashRefused = async (form, pattern) => { quiet(); await assert.rejects(() => cash.commitCash(form, {}, { ...cashDeps, nextcloud: nc }), (err) => err instanceof PanelError && pattern.test(err.message), `expected ${pattern}`); };
const noWrites = () => assert.deepEqual([budget.adds.length, budget.updates.length, budget.deletes.length, budget.newPayees.length], [0, 0, 0, 0]);

test('cash setting: "Cash purchases go to" may be empty, or one of the open accounts from the last check', async () => {
  const def = SETTINGS_BY_KEY.get('CASH_ACCOUNT');
  assert.equal(normalizeValue(def, ''), '');
  await rememberAccounts([{ name: 'Checking' }, { name: 'Wallet' }]);
  assert.equal(normalizeValue(def, ' Wallet '), 'Wallet');
  assert.throws(() => normalizeValue(def, 'Nope'), (err) => err instanceof SettingError && /not one of your open accounts/.test(err.message));
  assert.throws(() => normalizeValue(def, 'x\ny'), SettingError);
  assert.equal(def.default, '');
});

test('cash: only a cash purchase in Needs review gets the editor; a card receipt, a return, an archived or unfinished one does not', async () => {
  cashSeed();
  const entry = await entryNow();
  const sum = nc.files.get(entry.filedAs).summary;
  assert.deepEqual(fix.classify(KEY, entry, sum), { ok: true, kind: 'cash', dry: false });
  assert.match(fix.classify(KEY, entry, { ...sum, receipt: { ...sum.receipt, payment_method: 'visa' } }).reason, /No bank charge was matched/);
  assert.match(fix.classify(KEY, entry, { ...sum, receipt: { ...sum.receipt, is_return: true } }).reason, /No bank charge was matched/);
  assert.match(fix.classify(KEY, { ...entry, archived: { at: 'x' } }, sum).reason, /Archived/);
  assert.equal(fix.classify(KEY, { ...entry, done: false }, sum).ok, false);
  assert.equal(fix.classify(KEY, { ...entry, applied: { txnId: 't', action: 'split' } }, sum).kind === 'cash', false);
  // dry run: the preview only
  assert.deepEqual(fix.classify(`dry:${KEY}`, { done: true, result: 'dry-run:review' }, sum), { ok: true, kind: 'cash', dry: true });
});

test('cash: Preview looks at Actual (read only) and shows the account, date and payee; nothing is written; the page has the button and no inline style or handler', async () => {
  cashSeed();
  const { ed, look } = await cashPreview([G, H, S]);
  assert.equal(look.account.name, 'Checking');
  assert.deepEqual([ed.preview.cash.payee.name, ed.preview.cash.payee.isNew, ed.preview.cash.date], ['Target', false, day(-1)]);
  assert.equal(ed.applyLabel, 'Create in Actual');
  noWrites();
  const { html } = await fetchPage([G, H, S], '&acct=Checking&rid=');
  assert.match(html, /<form method="post" action="receipt-cash\?key=secret">[\s\S]*name="action" value="create"[\s\S]*<button class="plain">Create in Actual<\/button>/);
  assert.match(html, /Account[\s\S]*Checking/);
  assert.doesNotMatch(html, /<[^>]+\s(style|on[a-z]+)=/);
  noWrites();
});

test('cash: Create is refused (nothing written) with no account, an unusable account, in dry run, with a stale preview or one made for another account', async () => {
  cashSeed();
  config.cashAccount = '';
  const none = await cashForm([G, H, S], { acct: '' });
  await cashRefused(none, /No account is chosen.*Settings tab/);
  config.cashAccount = 'Checking';
  const wrong = await cashForm([G, H, S], { acct: 'Savings' });
  await cashRefused(wrong, /not an open account/);
  const good = await cashForm([G, H, S]);
  good.set('acct', 'Other'); // another account than the preview was made for
  await cashRefused(good, /changed since the preview/);
  const stale = await cashForm([G, H, S]);
  stale.set('c1', G);
  await cashRefused(stale, /changed since the preview|Press Preview/);
  await cashRefused(new URLSearchParams({ id: KEY, acct: 'Checking', action: 'create' }), /Press Preview first/);
  config.dryRun = true;
  fs.writeFileSync(config.statePath, JSON.stringify({ [`dry:${KEY}`]: { done: true, result: 'dry-run:review' } }));
  await cashRefused(new URLSearchParams({ id: `dry:${KEY}`, action: 'create' }), /Dry run/);
  config.dryRun = false;
  noWrites();
  // not a cash receipt
  await seed({ kind: 'B' });
  await cashRefused(new URLSearchParams({ id: KEY, token: 'x', state: 'y', acct: 'Checking' }), /No bank charge was matched|not a cash purchase/);
});

test('cash: one category creates a plain transaction (the total as an outflow, the worker\'s #receipt note), files the receipt as done and learns the changed picks', async () => {
  cashSeed();
  const { message, out } = await doCash(await cashForm([G, G, G]));
  assert.match(message, /^Created r1\.jpg in Checking: put in Daily \/ Groceries\./);
  assert.equal(budget.adds.length, 1);
  const { account, t, opts } = budget.adds[0];
  assert.deepEqual([account, t.id, t.date, t.amount, t.category, t.cleared, t.subtransactions], ['a1', 'new-1', day(-1), -4160, 'cg', true, undefined]);
  assert.match(t.notes, /^#receipt r1\.jpg — items: MILK/);
  assert.deepEqual(opts, { learnCategories: false, runTransfers: false });
  assert.equal(budget.newPayees.length, 0); // the existing payee Target fits the store
  assert.equal(budget.adds[0].t.payee, 'p1');
  const e = await entryNow();
  assert.deepEqual([e.result, e.applied.txnId, e.applied.action, e.filedAs], ['categorize', 'new-1', 'categorize', `${processed}/r1.jpg`]);
  const s = nc.files.get(e.filedAs).summary;
  assert.deepEqual([s.transaction.id, s.transaction.account, s.transaction.amount, s.plan.applied, s.problems], ['new-1', 'Checking', '41.60', true, []]);
  assert.equal(nc.files.has(`${review}/r1.jpg`), false);
  assert.equal(statusOf({ ...e, key: KEY }), 'done');
  assert.equal(fix.classify(KEY, e, s).kind, 'applied'); // from now on it is an ordinary applied receipt
  assert.ok(out.undo);
  assert.ok((await memory.loadLessonFile()).lessons.length > 0, 'the changed picks became lessons');
});

test('cash: several categories create a split parent with children, notes written as for a matched charge; a new payee is created when none fits', async () => {
  cashSeed({ receipt: { merchant: 'Corner Bakery' } });
  const { message } = await doCash(await cashForm([G, H, S]));
  assert.match(message, /split into/);
  const t = budget.adds[0].t;
  assert.equal(t.category, undefined);
  assert.equal(t.notes, '#receipt r1.jpg');
  assert.equal(t.subtransactions.length, 3);
  assert.equal(t.subtransactions.reduce((n, c) => n + c.amount, 0), -4160);
  assert.deepEqual(t.subtransactions.map((c) => c.category).sort(), ['cg', 'ch', 'cs']);
  assert.ok(t.subtransactions.every((c) => c.notes && !/#receipt/.test(c.notes)));
  assert.deepEqual(budget.newPayees, ['Corner Bakery']);
  assert.equal(t.payee, 'pn1');
  assert.equal(budget.txns.get('new-1').is_parent, true);
});

test('cash: a transaction of the same amount near the date is offered to be split instead; Create anyway stays; others are not duplicates', async () => {
  cashSeed();
  const txn = (id, over = {}) => ({ id, account: 'a1', date: day(-1), amount: -4160, payee: 'p1', category: null, notes: '', is_parent: false, cleared: true, ...over });
  budget.txns.set('x1', txn('x1'));
  budget.txns.set('far', txn('far', { date: day(-9) })); // too far from the purchase date
  budget.txns.set('other', txn('other', { amount: -4161 }));
  budget.txns.set('tagged', txn('tagged', { notes: '#receipt other.jpg' }));
  budget.txns.set('elsewhere', txn('elsewhere', { account: 'a2' }));
  const { ed, look } = await cashPreview([G, H, S]);
  assert.deepEqual(look.duplicates.map((d) => d.id), ['x1']);
  assert.deepEqual(ed.preview.cash.duplicates.map((d) => [d.date, d.payeeName, d.category]), [[day(-1), 'Target', null]]);
  const { html } = await fetchPage([G, H, S], '&acct=Checking&rid=');
  assert.match(html, /A transaction for this amount is already there/);
  assert.match(html, /name="action" value="split"[\s\S]*name="dup" value="x1"[\s\S]*Use this purchase/);
  assert.match(html, /<button class="small plain">Create another purchase<\/button>/);
  assert.doesNotMatch(html, /<button class="plain">Create in Actual<\/button>/);
  // Create anyway: the existing one is left alone
  await doCash(await cashForm([G, H, S]));
  assert.equal(budget.adds.length, 1);
  assert.deepEqual(budget.updates, []);
});

test('cash: Split this one instead writes the split onto the existing transaction (Apply\'s guards) and files the receipt; Undo puts both back', async () => {
  cashSeed();
  budget.txns.set('x1', { id: 'x1', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', category: null, notes: 'bought by hand', is_parent: false, cleared: true });
  const { message, out } = await doCash(await cashForm([G, H, S], {}, { action: 'split', dup: 'x1' }));
  assert.match(message, /^Applied r1\.jpg: split into/);
  assert.equal(budget.adds.length, 0);
  const t = budget.txns.get('x1');
  assert.equal(t.is_parent, true);
  assert.equal(t.subtransactions.length, 3);
  assert.match(t.notes, /^bought by hand \| #receipt r1\.jpg/);
  const e = await entryNow();
  assert.equal(e.applied.txnId, 'x1');
  const s = nc.files.get(e.filedAs).summary;
  assert.deepEqual([s.transaction.id, s.plan.applied], ['x1', true]);
  // Undo
  quiet();
  const undone = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(undone, /^Undone/);
  assert.equal(budget.txns.get('x1').is_parent, false);
  const back = await entryNow();
  assert.deepEqual([back.result, back.applied, back.filedAs], ['review', undefined, `${review}/r1.jpg`]);
  const sum = nc.files.get(back.filedAs).summary;
  assert.equal(sum.transaction, undefined); // a cash receipt again, not linked
  assert.equal(fix.classify(KEY, back, sum).kind, 'cash');
  // an existing split, or a charge changed since the preview, is refused by the usual guards
  budget.txns.get('x1').is_parent = true;
  budget.txns.get('x1').subtransactions = [{ id: 'k', amount: -4160, category: 'cg' }];
  const { ed } = await cashPreview([G, H, S]);
  assert.equal(ed.preview.cash.duplicates[0].isParent, true);
  await cashRefused(await cashForm([G, H, S], {}, { action: 'split', dup: 'x1' }), /split now|Nothing was changed/);
});

test('cash: Undo deletes the created transaction only while it is exactly what was written, and moves the receipt back to Needs review', async () => {
  cashSeed();
  const { out } = await doCash(await cashForm([G, H, S]));
  // someone edits the new transaction: Undo leaves it alone
  const t = budget.txns.get('new-1');
  const keepNotes = t.notes;
  t.notes = `${keepNotes} edited`;
  quiet();
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /changed in Actual since you saved it/);
  assert.equal(budget.txns.has('new-1'), true);
  assert.deepEqual(budget.deletes, []);
  t.notes = keepNotes;
  const msg = await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /transaction was deleted from Actual/);
  assert.equal(budget.txns.has('new-1'), false);
  assert.deepEqual(budget.deletes, ['new-1']); // Actual deletes the children with their parent
  const back = await entryNow();
  assert.deepEqual([back.result, back.applied, back.fixedOnPage, back.filedAs], ['review', undefined, undefined, `${review}/r1.jpg`]);
  assert.equal(nc.files.has(`${processed}/r1.jpg`), false);
  assert.deepEqual(nc.files.get(back.filedAs).summary.problems, [CASH_PROBLEM]);
});

test('cash: manual Archive is offered for cash, returns and unmatched receipts; normal cash archiving preserves its reason and restores to Needs review', async () => {
  cashSeed();
  let html = (await fetchPage(null)).html;
  assert.match(html, /<button>Archive receipt<\/button>/);
  assert.match(html, /Paid in cash, so there is no bank charge to match/);
  assert.match(html, /data-kind="cash"/);
  assert.match(html, /data-editor-save>Preview changes<\/button>/);
  const secondary = html.match(/<details class="receipt-more">[\s\S]*?<\/details>/)?.[0] ?? '';
  assert.doesNotMatch(secondary, /Archive receipt/);
  assert.match(secondary, /Try again/);
  assert.match(html.match(/<section class="status-banner[^]*?<\/section>/)[0], /Archive receipt/);
  assert.doesNotMatch(secondary, /data-editor-save/);
  assert.match(html, /form="receipt-edit-form" data-editor-save/);
  assert.match(html, /settings\?key=secret&amp;section=everyday#s-CASH_ACCOUNT/);
  cashSeed({ receipt: { is_return: true, payment_method: 'visa', total: -5, subtotal: -5 } });
  assert.match((await fetchPage(null)).html, /<button>Archive receipt<\/button>/);
  await seed({ kind: 'B' }); // an ordinary review receipt
  assert.match((await fetchPage(null)).html, /<button>Archive receipt<\/button>/);
  quiet();
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 }), (err) => err instanceof PanelError && /Not archived/.test(err.message));
  cashSeed();
  const out = {};
  assert.match(await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 }), /^Archived r1\.jpg/);
  assert.equal(out.archived, true);
  const e = await entryNow();
  assert.deepEqual([e.archived.reason, e.card.store, e.card.date, e.card.total], ['cash, entered by hand', 'Target', day(-1), 41.6]);
  if (!server) await startServer();
  const archived = await (await fetch(`${base}/archived?key=secret`)).text();
  assert.match(archived, /Target/);
  assert.match(archived, /41\.60/);
  assert.match((await fetchPage(null)).html, /cash, entered by hand/);
  assert.equal(budget.updates.length + budget.adds.length, 0);
  await restoreArchived(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  const back = await entryNow();
  assert.equal(back.filedAs, `${review}/r1.jpg`);
  assert.equal(back.archived, undefined);
  assert.equal(statusOf({ ...back, key: KEY }), 'review');
});

test('http: POST /receipt-cash needs the key and refuses another site; a form without a preview is turned back with a notice', async () => {
  cashSeed();
  if (!server) await startServer();
  quiet();
  const body = new URLSearchParams({ id: KEY, acct: 'Checking', action: 'create' }).toString();
  const post = (path2, headers = {}) => fetch(`${base}${path2}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post('/receipt-cash')).status, 403);
  assert.equal((await post('/receipt-cash?key=wrong')).status, 403);
  assert.equal((await post('/receipt-cash?key=secret', { 'sec-fetch-site': 'cross-site' })).status, 403);
  noWrites();
  const ok = await post('/receipt-cash?key=secret', { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 303);
  assert.match(new URL(ok.headers.get('location'), base).searchParams.get('notice'), /Press Preview first/);
  noWrites();
});

// ---- 19. A split changed by hand in Actual ----

/** The snapshot the worker would watch for the seeded split, flagged for review. */
async function watchFlagged() {
  const entry = await entryNow();
  const summary = nc.files.get(entry.filedAs).summary;
  const base = fix.replan({ summary, picks: fix.workerPicks(summary), labelToId: LABELS, targetCents: 4160 });
  const snap = learning.buildSnapshot({ txn: { id: 't1', date: day(-1), amount: -4160 }, item: { basename: 'r1.jpg' }, receipt: base.receipt, allocation: base.allocation, action: 'split', review: true });
  await memory.watch(snap);
  return snap;
}
const labelOf = (id) => [...LABELS].find(([, v]) => v === id)?.[0];

test('judge: tags still there with a category changed is not reviewed yet; #review gone is reviewed, also when the notes were rewritten without #receipt', async () => {
  await seed({ review: true });
  const snap = await watchFlagged();
  const t = structuredClone(budget.txns.get('t1'));
  t.subtransactions[1].category = 'cs'; // the hand change: one part to another category
  let j = learning.judge(snap, t, labelOf);
  assert.equal(j.reviewed, false);
  assert.ok(j.fixes.length > 0, 'the change is a lesson');
  t.notes = t.notes.replace(' #review', ''); // Looks right cleared #review
  j = learning.judge(snap, t, labelOf);
  assert.deepEqual([j.reviewed, j.fixes.length > 0], [true, true]);
  t.notes = 'BANK DESCRIPTION OF THE PURCHASE'; // rewritten: no #receipt and no #review
  j = learning.judge(snap, t, labelOf);
  assert.equal(j.drop, 'the #receipt tag was removed');
  assert.equal(j.reviewed, true);
  const rec = learning.seenRecord(j);
  assert.deepEqual([rec.reviewed, rec.review, rec.changed], [true, false, 'its #receipt note was removed']);
  // and still tagged #review after the rewrite: not reviewed
  t.notes = 'BANK DESCRIPTION #review';
  assert.equal(learning.judge(snap, t, labelOf).reviewed, false);
});

test('check Actual: a charge whose notes were rewritten without #receipt or #review counts as reviewed (Done)', async () => {
  const { withSeen } = await import('../src/receipt-lists.js');
  await seed({ review: true });
  budget.txns.get('t1').notes = 'BANK DESCRIPTION OF THE PURCHASE';
  quiet();
  const msg = await fix.checkActual(new URLSearchParams({ id: KEY }), {}, { nextcloud: nc, lockWaitMs: 200 });
  assert.match(msg, /#review was removed, so it counts as reviewed/);
  const seen = await memory.seenIndex();
  assert.equal(seen.t1.reviewed, true);
  assert.equal(statusOf(withSeen({ [KEY]: await entryNow() }, seen)[KEY] && { ...withSeen({ [KEY]: await entryNow() }, seen)[KEY], key: KEY }), 'done');
});

test('a re-read does not make a look at Actual (reviewed) stale: it changes nothing in Actual', async () => {
  const { withSeen } = await import('../src/receipt-lists.js');
  await seed({ review: true });
  await memory.recordSeen({ t1: { at: new Date(Date.now() + 60000).toISOString(), changed: null, items: [], whole: null, review: false, reviewed: true } });
  const before = withSeen({ [KEY]: await entryNow() }, await memory.seenIndex());
  assert.ok(before[KEY].reviewed);
  await rereadWith(THREE);
  const after = withSeen({ [KEY]: await entryNow() }, await memory.seenIndex());
  assert.ok(after[KEY].reviewed, 'still reviewed after the re-read');
  await restoreIt();
  assert.ok(withSeen({ [KEY]: await entryNow() }, await memory.seenIndex())[KEY].reviewed, 'and after Use old reading');
});

test('Looks right: a split whose categories you changed in Actual still has #review cleared (only the parent\'s note), is archived, and the change stays to be learned', async () => {
  await seed({ review: true });
  await watchFlagged();
  budget.txns.get('t1').subtransactions[1].category = 'cs';
  quiet();
  const out = {};
  const message = await archiveOne(new URLSearchParams({ id: KEY }), out, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  assert.match(message, /^Archived r1\.jpg/);
  assert.doesNotMatch(message, /Undo/, 'the Changed-in-Actual Looks right offers no Undo');
  assert.equal(out.undo, undefined);
  assert.deepEqual(budget.updates.map((u) => Object.keys(u.fields)), [['notes']], 'only the note is written');
  assert.doesNotMatch(budget.txns.get('t1').notes, /#review/);
  assert.equal(budget.txns.get('t1').subtransactions[1].category, 'cs', 'your category is yours');
  assert.deepEqual(budget.deletes, []);
  assert.ok((await entryNow()).archived);
  assert.equal((await memory.loadMarks()).confirmed.includes('t1'), false, 'not recorded as confirmed: you changed it');
  const w = await memory.loadWatch();
  assert.equal(w.length, 1); // the sweep still judges it: Health to your category is learned
  assert.equal(learning.judge(w[0], structuredClone(budget.txns.get('t1')), labelOf).fixes.length > 0, true);
});

test('Looks right: when the split\'s amounts changed it is refused, and "Archive: keep what\'s in Actual" files it without touching Actual', async () => {
  await seed({ review: true });
  await watchFlagged();
  const t = budget.txns.get('t1');
  t.subtransactions[0].amount -= 100;
  t.subtransactions[1].amount += 100;
  quiet();
  const { html } = await fetchPage(null);
  assert.match(html, /<button class="small plain">Archive: keep what's in Actual<\/button>/);
  assert.match(html, /name="keep" value="1"/);
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 }), (err) => err instanceof PanelError && /amounts of its split parts changed/.test(err.message));
  assert.match(budget.txns.get('t1').notes, /#review/);
  const opened = budget.opened;
  const out = {};
  const message = await archiveOne(new URLSearchParams({ id: KEY, keep: '1' }), out, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  assert.match(message, /^Archived r1\.jpg/);
  assert.equal(out.archived, true);
  assert.deepEqual([budget.updates.length, budget.deletes.length, budget.opened], [0, 0, opened]);
  assert.match(budget.txns.get('t1').notes, /#review/); // Actual is exactly as it was
  const e = await entryNow();
  assert.deepEqual([e.result, e.archived.reason, e.card.store], ['split', 'kept as it is in Actual', 'Target']);
  assert.equal((await memory.loadWatch()).length, 1, 'the watch is kept for the sweep');
  // not for a receipt Actual was not changed for
  await seed({ kind: 'B' });
  await assert.rejects(() => archiveOne(new URLSearchParams({ id: KEY, keep: '1' }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 }), (err) => err instanceof PanelError && /Not archived/.test(err.message));
});

test('Archive of a reviewed charge whose #receipt note you removed works as a normal archive of a Done receipt', async () => {
  await seed({ review: true });
  budget.txns.get('t1').notes = 'BANK DESCRIPTION';
  quiet();
  await fix.checkActual(new URLSearchParams({ id: KEY }), {}, { nextcloud: nc, lockWaitMs: 200 });
  const updates = budget.updates.length;
  const message = await archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  assert.match(message, /^Archived r1\.jpg/);
  assert.equal(budget.updates.length, updates);
  const e = await entryNow();
  assert.deepEqual([e.result, e.card.store, e.card.total], ['split', 'Target', 41.6]);
});

test('a locked page shows what Actual has for every item, not the new reading\'s pick; the charge\'s category says Split for a split', async () => {
  await seed({ review: true });
  // the new reading puts GUM in Household, but the worker filed it (and Actual still has it) in Sam
  await rereadWith(THREE);
  await memory.recordSeen({ t1: { at: '2099-01-01T00:00:00.000Z', changed: null, items: [{ i: 1, d: 'SPONGES', now: S }], whole: null, review: true, reviewed: false } });
  const ed = await editorWith([G, H, H]);
  assert.equal(ed.locked, true);
  const shown = Object.fromEntries(ed.items.map((i) => [i.description, i.inActual ?? i.filed ?? ed.picks[i.i]]));
  assert.deepEqual(shown, { MILK: G, SPONGES: S, GUM: S });
  const { html } = await fetchPage(null);
  const plain = html.replaceAll('&#47;', '/');
  const row = (name) => new RegExp(`<tr><td>${name}</td>[\\s\\S]*?</tr>`).exec(plain)[0];
  assert.match(row('GUM'), /Daily \/ Sam/);
  assert.doesNotMatch(row('GUM'), /Household/);
  assert.match(plain, /Category now<\/th>|Category now/);
  assert.match(plain, /Split \(see Filed as\)/);
});

// Regression cases from the cash transaction review.
test('cash review: a rule replacing the new split is repaired without a second creation', async () => {
  cashSeed();
  const form = await cashForm([G, H, S]);
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); const t = budget.txns.get('new-1'); t.category = 'ch'; t.is_parent = false; delete t.subtransactions; };
  const { message } = await doCash(form);
  assert.match(message, /rule/i);
  assert.equal(budget.txns.get('new-1').is_parent, true);
  assert.equal((await entryNow()).applied.txnId, 'new-1');
  await cashRefused(form, /cash purchase|Preview|changed|state/i);
  assert.equal(budget.adds.length, 1);
});

test('cash review: an ambiguous add failure retains the planned id and retry adopts it', async () => {
  cashSeed();
  const form = await cashForm([G, H, S]);
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); throw new Error('connection lost after add'); };
  await cashRefused(form, /may have been created|check.*Actual/i);
  assert.equal((await entryNow()).creating.id, 'new-1');
  api.addTransactions = add;
  await doCash(await cashForm([G, H, S]));
  assert.equal(budget.adds.length, 1);
  assert.equal((await entryNow()).applied.txnId, 'new-1');
});

for (const field of ['date', 'payee', 'account', 'reconciled']) test(`cash review: Undo preserves a created transaction after ${field} changes`, async () => {
  cashSeed();
  const { out } = await doCash(await cashForm([G, H, S]));
  budget.txns.get('new-1')[field] = { date: day(-2), payee: 'another', account: 'a2', reconciled: true }[field];
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /changed|reconciled/);
  assert.ok(budget.txns.has('new-1'));
  assert.equal(budget.deletes.length, 0);
});

test('cash review: Undo works when Nextcloud retained the pre-create summary', async () => {
  cashSeed(); nc.failRefile = 'write';
  const { out } = await doCash(await cashForm([G, H, S]));
  nc.failRefile = false;
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /^Undone/);
  assert.equal(budget.txns.has('new-1'), false);
});

test('cash review: an uncleared hand entry can be split in the selected account', async () => {
  cashSeed();
  budget.txns.set('x1', { id: 'x1', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', category: null, notes: '', cleared: false });
  await doCash(await cashForm([G, H, S], {}, { action: 'split', dup: 'x1' }));
  assert.equal(budget.txns.get('x1').is_parent, true);
});

test('cash review: already split duplicates have no split button', async () => {
  cashSeed();
  budget.txns.set('x1', { id: 'x1', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', category: null, notes: '', is_parent: true, subtransactions: [] });
  const { html } = await fetchPage([G, H, S], '&acct=Checking&rid=');
  assert.doesNotMatch(html, /name="action" value="split"/);
});

test('cash review: Looks right preserves the manual edit lock after archive restore', async () => {
  await seed({ review: true });
  await watchFlagged();
  budget.txns.get('t1').subtransactions[1].category = 'cs';
  quiet();
  await archiveOne(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  await restoreArchived(new URLSearchParams({ id: KEY }), {}, { nc: archiveNc(), nextcloud: nc, lockWaitMs: 200 });
  assert.equal((await editorWith([G, H, S])).locked, true);
});

test('cash review: a failed read-back can be finished without adding again', async () => {
  cashSeed();
  const form = await cashForm([G, H, S]);
  const read = api.getTransactions;
  let fail = true;
  api.getTransactions = async (...args) => {
    if (fail && budget.adds.length) throw new Error('read-back unavailable');
    return read(...args);
  };
  await cashRefused(form, /check Actual/i);
  assert.equal((await entryNow()).applied.txnId, 'new-1');
  fail = false;
  await doCash(await cashForm([G, H, S]));
  assert.equal(budget.adds.length, 1);
});

test('cash review: a tagged receipt cannot be created again', async () => {
  cashSeed();
  budget.txns.set('old', { id: 'old', account: 'a1', date: day(-1), amount: -4160, notes: '#receipt r1.jpg' });
  await cashRefused(await cashForm([G, H, S]), /already has a transaction tagged/);
  assert.equal(budget.adds.length, 0);
});

// Metadata correction uses the same synthetic budget and files as page edits.
const resolution = await import('../src/receipt-resolution.js');
async function resolutionForm(over = {}, action = 'select') {
  const entry = await entryNow();
  const summary = entry.resolutionPending?.summary ?? await nc.readSummary(entry.filedAs);
  const query = new URLSearchParams({ resolve: '1', ...Object.fromEntries(Object.entries(resolution.resolutionValues(summary.receipt)).map(([k, v]) => [`receipt-${k}`, v])), ...over });
  const result = await resolution.resolutionPreview({ id: KEY, entry, summary }, query, { lockWaitMs: 200 });
  assert.ok(result.token, result.error);
  query.set('id', KEY); query.set('token', result.token); query.set('action', action); query.set('transaction', 't1');
  return { form: query, result };
}
const resolveForm = (form, out = {}) => resolution.commitResolution(form, out, { nextcloud: nc, lockWaitMs: 200 });

test('correct reading: choosing a charge saves metadata without writing Actual; normal Preview can apply it', async () => {
  quiet(); await seed({ kind: 'B' });
  const { form, result } = await resolutionForm({ 'receipt-merchant': 'Correct merchant' });
  assert.equal(result.candidates[0].id, 't1');
  assert.match(await resolveForm(form), /Nothing was changed in Actual/);
  assert.equal(budget.updates.length, 0);
  const summary = await summaryNow();
  assert.equal(summary.receipt.merchant, 'Correct merchant');
  assert.equal(summary.transaction.id, 't1');
  assert.deepEqual(summary.receipt.manualFields, ['merchant', 'date', 'total', 'payment_method']);
  await commit(WORKER);
  assert.ok(budget.updates.length > 0);
});

test('selected charge category: linking starts every item in the Actual category without changing OCR provenance or writing Actual', async () => {
  quiet();
  await seed({ kind: 'B', txn: { category: 'ch', notes: 'Bank description' } });
  const before = structuredClone(budget.txns.get('t1'));
  const raw = structuredClone((await summaryNow()).receipt.items);
  const { form, result } = await resolutionForm();
  assert.equal(result.candidates[0].category, H);
  assert.equal(result.candidates[0].keep, false);
  await resolveForm(form);
  const summary = await summaryNow();
  assert.equal(summary.transaction.currentCategory, H);
  assert.deepEqual(summary.receipt.items, raw);
  assert.deepEqual(fix.workerPicks(summary), WORKER);
  const editor = await previewOf(null);
  assert.deepEqual(editor.picks, [H, H, H]);
  assert.deepEqual(editor.items.map((item) => item.current), [H, H, H]);
  assert.deepEqual(editor.items.map((item) => item.worker), WORKER);
  assert.deepEqual(budget.txns.get('t1'), before);
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.deletes.length, 0);
});

test('existing selected charge: saved item corrections override its category without a summary migration', async () => {
  const transaction = { id: 't1', date: day(-1), account: 'Checking', amount: '41.60', payee: 'Target', currentCategory: H };
  const { summary } = await seed({ kind: 'B', txn: { category: 'ch' }, summary: {
    transaction, plan: null, selection: { at: '2026-01-01T00:00:00.000Z', keep: false },
    pageFix: { items: { '0': F, '2': 'Uncategorized' } },
  } });
  const original = structuredClone(summary);
  const editor = await previewOf(null);
  assert.deepEqual(editor.picks, [F, H, 'Uncategorized']);
  assert.deepEqual(await summaryNow(), original, 'opening an existing link does not rewrite its summary');
  assert.equal(budget.opened, 0);
  assert.equal(budget.updates.length, 0);
});

test('selected charge category: choosing a charge retains explicit category corrections already saved on the receipt', async () => {
  quiet();
  await seed({ kind: 'B', txn: { category: 'ch' }, summary: { pageFix: { items: { '0': F, '2': 'Uncategorized' } } } });
  const corrections = structuredClone((await summaryNow()).pageFix);
  await resolveForm((await resolutionForm()).form);
  assert.deepEqual((await summaryNow()).pageFix, corrections);
  assert.deepEqual((await previewOf(null)).picks, [F, H, 'Uncategorized']);
  assert.deepEqual(fix.workerPicks(await summaryNow()), WORKER);
  assert.equal(budget.updates.length, 0);
});

test('selected charge category: an uncategorized charge keeps the OCR item categories', async () => {
  quiet();
  await seed({ kind: 'B' });
  await resolveForm((await resolutionForm()).form);
  assert.equal((await summaryNow()).transaction.currentCategory, null);
  assert.deepEqual((await previewOf(null)).picks, WORKER);
  assert.equal(budget.updates.length, 0);
});

test('selected charge category: signed Save keeps the full charge in one category including tax, and Undo restores the linked review state', async () => {
  quiet();
  await seed({ kind: 'B', txn: { category: 'ch', notes: 'Bank description' } });
  await resolveForm((await resolutionForm()).form);
  const beforeTxn = structuredClone(budget.txns.get('t1'));
  const beforeEntry = structuredClone(await entryNow());
  const beforeSummary = structuredClone(await summaryNow());
  const picks = (await previewOf(null)).picks;
  assert.deepEqual(picks, [H, H, H]);
  const preview = (await previewOf(picks)).preview;
  assert.deepEqual(preview.parts.map((part) => [part.category, part.amount]), [[H, '41.60']]);
  assert.equal(preview.split, false);
  assert.match(preview.token, /^[0-9a-f]{64}$/);
  const signed = await formFor(picks);
  const out = {};
  await fix.commitFix(signed, out, { nextcloud: nc, lockWaitMs: 200 });
  const transaction = budget.txns.get('t1');
  assert.equal(transaction.amount, -4160);
  assert.equal(transaction.category, 'ch');
  assert.equal(transaction.is_parent, false);
  assert.ok(!transaction.subtransactions?.length);
  assert.match(transaction.notes, /#receipt r1\.jpg/);
  assert.equal(budget.updates.length, 1);
  assert.deepEqual((await previewOf(null)).picks, [H, H, H]);
  assert.deepEqual((await summaryNow()).pageFix.items, { '0': H, '2': H });
  assert.deepEqual((await summaryNow()).receipt.items, beforeSummary.receipt.items);
  assert.deepEqual((await summaryNow()).plan.parts.map((part) => [part.category, part.amount]), [[H, '41.60']]);
  assert.ok(out.undo);
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /^Undone/);
  assert.deepEqual(budget.txns.get('t1'), beforeTxn);
  assert.deepEqual(await entryNow(), beforeEntry);
  const { plan: _emptyPlan, ...originalSummary } = beforeSummary; // Undo removes an empty plan rather than storing null.
  assert.deepEqual(await summaryNow(), originalSummary);
  assert.deepEqual((await previewOf(null)).picks, [H, H, H]);
  assert.equal(nc.files.has(`${processed}/r1.jpg`), false);
});

test('selected charge category: an Actual category edit after linking refuses a signed Save without moving or writing anything', async () => {
  quiet();
  await seed({ kind: 'B', txn: { category: 'ch' } });
  await resolveForm((await resolutionForm()).form);
  const form = await formFor((await previewOf(null)).picks);
  const entry = structuredClone(await entryNow());
  const summary = structuredClone(await summaryNow());
  const moves = structuredClone(nc.moves);
  budget.txns.get('t1').category = 'cf';
  const manual = structuredClone(budget.txns.get('t1'));
  await refused(form, /selected charge changed|category changed since/);
  assert.deepEqual(budget.txns.get('t1'), manual);
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.deletes.length, 0);
  assert.deepEqual(await entryNow(), entry);
  assert.deepEqual(await summaryNow(), summary);
  assert.deepEqual(nc.moves, moves);
});

test('correct reading: stale selection and a changed charge after linking both refuse writes', async () => {
  quiet(); await seed({ kind: 'B' });
  const { form } = await resolutionForm();
  budget.txns.get('t1').notes = 'A hand edit';
  await assert.rejects(resolveForm(form), /charges changed/);
  assert.equal(budget.updates.length, 0);
  await resolveForm((await resolutionForm()).form);
  const save = await formFor(WORKER);
  budget.txns.get('t1').date = day(-2);
  await assert.rejects(fix.commitFix(save, {}, { nextcloud: nc }), /selected charge changed/);
  assert.equal(budget.updates.length, 0);
});

test('correct reading: split, reconciled or excluded-category charges link and archive while keeping Actual unchanged', async () => {
  quiet();
  for (const txn of [{ is_parent: true, subtransactions: [{ id: 's1', amount: -4160, category: 'cg', notes: 'kept' }] }, { reconciled: true }, { category: 'cr' }]) {
    await seed({ kind: 'B', txn });
    const before = structuredClone(budget.txns.get('t1'));
    const { form, result } = await resolutionForm();
    assert.equal(result.candidates[0].keep, true);
    assert.match(await resolveForm(form), /You can archive/);
    assert.deepEqual(budget.txns.get('t1'), before);
    const entry = await entryNow();
    assert.equal(fix.classify(KEY, entry, await summaryNow()).ok, false);
    assert.equal((await import('../src/archive-rules.js')).canArchive(KEY, entry).ok, true);
  }
  assert.equal(budget.updates.length, 0);
});

test('correct reading: pending, transfer and already tagged charges cannot be chosen', async () => {
  quiet();
  for (const txn of [{ cleared: false }, { transfer_id: 'a2' }, { payee: 'pt' }, { notes: '#receipt already.jpg' }]) {
    await seed({ kind: 'B', txn });
    const { form, result } = await resolutionForm();
    if (txn.cleared === false) assert.equal(result.candidates[0].pending, true);
    else assert.equal(result.candidates.length, 0);
    await assert.rejects(resolveForm(form), /cannot be chosen/);
  }
  assert.equal(budget.updates.length, 0);
});

test('correct reading: automatic check preserves corrections across waiting and processing failures', async () => {
  quiet(); await seed({ kind: 'B' });
  nc.requeueFromReview = async (from) => { nc.files.set(`${inbox}/r1.jpg`, nc.files.get(from)); nc.files.delete(from); return { moved: `${inbox}/r1.jpg` }; };
  const { form } = await resolutionForm({ 'receipt-total': '42.00', 'receipt-payment_method': 'cash' }, 'recheck');
  const out = {};
  assert.match(await resolveForm(form, out), /will not read the photo again/);
  const nextId = `${inbox}/r1.jpg@e`;
  assert.equal(form.get('id'), nextId);
  assert.equal(out.trigger, 'corrected receipt');
  const entry = (await loadState())[nextId];
  assert.equal(entry.receiptFields.total, 42);
  assert.equal(entry.reading.receipt.payment_method, 'cash');
  assert.equal((await loadState())[KEY], undefined);
  const { waitingEntry } = await import('../src/index.js');
  const { failedEntry } = await import('../src/state.js');
  const waiting = waitingEntry(entry, { until: new Date(Date.now() + 100000).toISOString() });
  assert.deepEqual(waiting.receiptFields, entry.receiptFields);
  const failed = failedEntry(waiting, 1, 'service interrupted', undefined, false);
  assert.deepEqual(failed.receiptFields, entry.receiptFields);
  assert.deepEqual(failed.reading, entry.reading);
  assert.equal(budget.updates.length, 0);
});

test('correct reading: failed sidecar save retains corrections and pauses processing until retry finishes', async () => {
  quiet(); await seed({ kind: 'B' });
  const { form } = await resolutionForm({ 'receipt-merchant': 'Kept name' });
  nc.failRefile = true;
  await assert.rejects(resolveForm(form), /corrected reading was kept/);
  const entry = await entryNow();
  assert.equal(entry.resolutionPending.summary.receipt.merchant, 'Kept name');
  assert.equal((await import('../src/state.js')).isDue({ ...entry, done: false }, Date.now(), true), false);
  assert.equal((await import('../src/panel-actions.js')).retryStatus(KEY, entry), 'no');
  nc.failRefile = false;
  await resolveForm((await resolutionForm()).form);
  assert.equal((await entryNow()).resolutionPending, undefined);
  assert.equal((await summaryNow()).receipt.merchant, 'Kept name');
  assert.equal(budget.updates.length, 0);
});

test('correct reading: validation and mode changes refuse saves; ordinary page loads do not open Actual', async () => {
  quiet(); const { entry, summary } = await seed({ kind: 'B' });
  const before = budget.opened;
  const values = resolution.resolutionValues(summary.receipt);
  assert.deepEqual(await resolution.resolutionPreview({ id: KEY, entry, summary }, new URLSearchParams()), { values, original: values });
  assert.equal(budget.opened, before);
  for (const [name, value] of [['merchant', ''], ['date', '2026-02-30'], ['total', '-1'], ['total', '12.345'], ['payment_method', 'wire']]) {
    assert.throws(() => resolution.parseResolution(new URLSearchParams({ [`receipt-${name}`]: value }), summary.receipt), PanelError);
  }
  const { form } = await resolutionForm();
  config.dryRun = true;
  await assert.rejects(resolveForm(form), /Dry run/);
  assert.equal(budget.updates.length, 0);
});

test('http: correction route requires key, same-origin POST and a current preview; it keeps the cause filter', async () => {
  quiet(); await seed({ kind: 'B' });
  if (!server) await startServer();
  const { form } = await resolutionForm();
  form.set('cause', 'matching');
  const post = (url, site) => fetch(`${base}${url}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site }, body: form });
  assert.equal((await post('/receipt-resolve', 'same-origin')).status, 403);
  assert.equal((await post('/receipt-resolve?key=secret', 'cross-site')).status, 403);
  const result = await post('/receipt-resolve?key=secret', 'same-origin');
  assert.equal(result.status, 303);
  const url = new URL(result.headers.get('location'), base);
  assert.equal(url.searchParams.get('cause'), 'matching');
  assert.match(url.searchParams.get('notice'), /Linked to the charge/);
  assert.equal(budget.updates.length, 0);
});

test('manually corrected date and total survive the normal reading normalization', async () => {
  quiet();
  const { settleReading } = await import('../src/receipt.js');
  const receipt = { ...makeReceipt(), date: day(-300), total: 99, payment_method: 'cash', manualFields: ['date', 'total'] };
  const out = settleReading(receipt, { basename: 'r1.jpg', lastmod: new Date().toISOString() });
  assert.equal(receipt.date, day(-300));
  assert.equal(receipt.total, 99);
  assert.equal(out.totalNote, null);
  assert.equal(out.dateNote, null);
});

test('correct reading: a lost requeue response pauses the new file version and safely resumes on retry', async () => {
  quiet(); await seed({ kind: 'B' });
  let moved = false;
  nc.requeueFromReview = async (from) => {
    nc.files.set(`${inbox}/r1.jpg`, nc.files.get(from)); nc.files.delete(from); moved = true;
    throw new Error('MOVE response lost');
  };
  const { form } = await resolutionForm({}, 'recheck');
  await assert.rejects(resolveForm(form), /MOVE response lost/);
  assert.equal(moved, true);
  const { resolutionBlocked } = await import('../src/state.js');
  assert.equal(resolutionBlocked(await loadState(), { filename: `${inbox}/r1.jpg`, etag: 'e' }), true);
  const retry = await resolutionForm({}, 'recheck');
  await resolveForm(retry.form);
  const entry = (await loadState())[`${inbox}/r1.jpg@e`];
  assert.equal(entry.receiptFields.total, 41.6);
  assert.equal(resolutionBlocked(await loadState(), { filename: `${inbox}/r1.jpg` }), false);
  assert.equal(budget.updates.length, 0);
});

// Approved reliability fixes. Exercise real page handlers and the worker recovery entry points against the fake budget.
test('cash recovery adopts an acknowledged-lost creation automatically and never adds a second purchase', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); throw new Error('response lost'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  const actual = await import('../src/actual.js');
  await exclusive(async () => cash.recoverCashCreations(await loadState(), { actual, nextcloud: nc }));
  assert.equal(budget.adds.length, 1);
  assert.equal((await entryNow()).creating, undefined);
  assert.equal((await entryNow()).applied.txnId, 'new-1');
  await exclusive(async () => cash.recoverCashCreations(await loadState(), { actual, nextcloud: nc }));
  assert.equal(budget.adds.length, 1);
});

test('cash recovery leaves an absent creation for an explicit fresh retry using its original UUID', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async () => { throw new Error('offline before add'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  const actual = await import('../src/actual.js');
  await exclusive(async () => cash.recoverCashCreations(await loadState(), { actual, nextcloud: nc }));
  assert.equal((await entryNow()).creating.absent, true);
  assert.equal(budget.adds.length, 0);
  assert.equal((await import('../src/panel-actions.js')).retryStatus(KEY, await entryNow()), 'no');
  const form = await cashForm([G, H, S]); form.set('action', 'retry-create');
  await doCash(form);
  assert.equal(budget.adds.length, 1);
  assert.equal((await entryNow()).applied.txnId, 'new-1');
});

test('cash recovery finds the original UUID after a date change and refuses to duplicate or overwrite it', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); throw new Error('response lost'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  budget.txns.get('new-1').date = day(-100);
  const before = structuredClone(budget.txns.get('new-1'));
  const actual = await import('../src/actual.js');
  await exclusive(async () => cash.recoverCashCreations(await loadState(), { actual, nextcloud: nc }));
  assert.equal((await entryNow()).creating.id, 'new-1');
  assert.match((await entryNow()).error, /changed in Actual/);
  assert.deepEqual(budget.txns.get('new-1'), before);
  assert.equal(budget.adds.length, 1);
});

test('cash recovery can explicitly keep an existing purchase after the planned UUID is confirmed absent', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async () => { throw new Error('offline before add'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  const entered = { id: 'hand', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', notes: 'keep my notes', category: 'cg', cleared: true };
  budget.txns.set('hand', structuredClone(entered));
  const form = await cashForm([G, H, S]); form.set('action', 'adopt-existing'); form.set('dup', 'hand');
  await doCash(form);
  assert.deepEqual(budget.txns.get('hand'), entered);
  assert.equal(budget.adds.length, 0);
  assert.equal(budget.updates.length, 0);
  assert.equal((await entryNow()).manualLink.keep, true);
  assert.equal((await entryNow()).creating, undefined);
});

test('successful cash creation keeps its intended summary and the worker finishes it after the Undo window', async () => {
  cashSeed(); quiet(); nc.failRefile = 'write';
  await doCash(await cashForm([G, H, S]));
  const pending = await entryNow();
  assert.ok(pending.filing.summary.transaction);
  pending.fixedOnPage.at = '2020-01-01T00:00:00Z';
  await (await import('../src/state.js')).saveState({ [KEY]: pending });
  nc.failRefile = false;
  const { recoverFilings } = await import('../src/index.js');
  await exclusive(async () => recoverFilings(await loadState(), nc));
  assert.equal((await entryNow()).filing, undefined);
  assert.equal((await entryNow()).fixedOnPage.summaryFailed, undefined);
  assert.equal((await summaryNow()).transaction.id, 'new-1');
  assert.equal(budget.adds.length, 1);
});

for (const [field, value] of [['category', 'ch'], ['notes', 'hand edit'], ['date', day(-2)], ['payee', 'p-other'], ['reconciled', true], ['cleared', false]]) test(`cash stale preview refuses after ${field} changes`, async () => {
  cashSeed(); quiet();
  budget.txns.set('hand', { id: 'hand', account: 'a1', date: day(-1), amount: -4160, payee: 'p1', notes: '', category: 'cg', cleared: true });
  const form = await cashForm([G, H, S], {}, { action: 'split', dup: 'hand' });
  budget.txns.get('hand')[field] = value;
  await cashRefused(form, /changed|Preview|charge/);
  assert.equal(budget.updates.length, 0);
  assert.equal(budget.adds.length, 0);
});

for (const [field, value] of [['date', day(-2)], ['payee', 'p-other'], ['account', 'a2'], ['reconciled', true], ['cleared', false], ['transfer_id', 'a2']]) test(`Undo of an existing charge preserves a newer ${field} edit`, async () => {
  quiet(); await seed();
  const { out } = await commit([G, H, F]);
  const writes = budget.updates.length;
  budget.txns.get('t1')[field] = value;
  const before = structuredClone(budget.txns.get('t1'));
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /nothing was undone|nothing was changed/i);
  assert.equal(budget.updates.length, writes);
  assert.deepEqual(budget.txns.get('t1'), before);
});

test('Try again waits for a page save, revalidates its result and cannot forget an applied receipt', async () => {
  quiet(); await seed({ kind: 'B' });
  let release;
  const held = exclusive(() => new Promise((r) => { release = r; }));
  const actions = await import('../src/panel-actions.js');
  const retry = actions.tryAgain(new URLSearchParams({ entry: KEY }), { nextcloud: nc, lockWaitMs: 200 });
  await (await import('../src/state.js')).patchEntry(KEY, (e) => ({ ...e, applied: { txnId: 't1', action: 'split' } }));
  release(); await held;
  await assert.rejects(retry, /already applied/);
  assert.equal(nc.moves.length, 0);
  assert.equal((await entryNow()).applied.txnId, 't1');
});

test('legacy cash intent without saved editor choices adopts its existing UUID read-only', async () => {
  const original = cashSeed(); quiet();
  await doCash(await cashForm([G, G, F]));
  const completed = await entryNow();
  const transaction = structuredClone(budget.txns.get('new-1'));
  nc.files.delete(completed.filedAs); nc.files.set(`${review}/r1.jpg`, { summary: original });
  await (await import('../src/state.js')).saveState({ [KEY]: { done: true, result: 'review', filedAs: `${review}/r1.jpg`, creating: { id: 'new-1', identity: completed.fixedOnPage.identity, want: completed.fixedOnPage.wrote, at: completed.at } } });
  const { recoverLegacyRecords } = await import('../src/legacy-recovery.js');
  await exclusive(async () => recoverLegacyRecords(await loadState(), { actual: await import('../src/actual.js'), nextcloud: nc }));
  const recovered = await entryNow();
  assert.equal(recovered.creating, undefined);
  assert.equal(recovered.manualLink.recovered, true);
  assert.equal(recovered.applied.txnId, 'new-1');
  assert.equal(recovered.filing, undefined);
  assert.deepEqual(budget.txns.get('new-1'), transaction);
  assert.equal(budget.adds.length, 1);
});

test('legacy failed summary recovers from the old sidecar location after the Undo window', async () => {
  const original = cashSeed(); quiet();
  await doCash(await cashForm([G, H, S]));
  const completed = await entryNow();
  completed.fixedOnPage.summaryFailed = true;
  completed.fixedOnPage.at = '2020-01-01T00:00:00Z';
  nc.files.get(completed.filedAs).summary = null;
  const read = nc.readSummary;
  nc.readSummary = async (p) => p === completed.fixedOnPage.before.filedAs ? structuredClone(original) : read(p);
  await (await import('../src/state.js')).saveState({ [KEY]: completed });
  const { recoverLegacyRecords } = await import('../src/legacy-recovery.js');
  await exclusive(async () => recoverLegacyRecords(await loadState(), { actual: await import('../src/actual.js'), nextcloud: nc }));
  assert.equal((await entryNow()).fixedOnPage.summaryFailed, undefined);
  assert.equal((await summaryNow()).transaction.id, 'new-1');
  assert.equal((await entryNow()).filing, undefined);
  assert.equal(budget.adds.length, 1);
  assert.equal((await import('../src/archive-rules.js')).canArchive(KEY, await entryNow()).ok, true);
});

test('legacy recovery keeps records and reports missing receipt readings instead of inventing them', async () => {
  cashSeed(); quiet(); await doCash(await cashForm([G, H, S]));
  const entry = await entryNow(); entry.fixedOnPage.summaryFailed = true;
  nc.readSummary = async () => null;
  await (await import('../src/state.js')).saveState({ [KEY]: entry });
  await (await import('../src/legacy-recovery.js')).recoverLegacyRecords(await loadState(), { actual: await import('../src/actual.js'), nextcloud: nc });
  assert.match((await entryNow()).error, /earlier receipt reading is unavailable/);
  assert.equal((await entryNow()).fixedOnPage.summaryFailed, true);
  assert.equal(budget.adds.length, 1);
});

test('a found cash purchase changed in Actual can be explicitly kept instead of repeatedly failing completion', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); throw new Error('response lost'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  budget.txns.get('new-1').notes = 'my later edit';
  const before = structuredClone(budget.txns.get('new-1'));
  const form = await cashForm([G, H, S]); form.set('action', 'keep-found');
  await doCash(form);
  assert.deepEqual(budget.txns.get('new-1'), before);
  assert.equal((await entryNow()).manualLink.keep, true);
  assert.equal((await entryNow()).creating, undefined);
  assert.equal(budget.adds.length, 1);
});

test('a stale keep-found preview refuses after another Actual edit', async () => {
  cashSeed(); quiet();
  const add = api.addTransactions;
  api.addTransactions = async (...args) => { await add(...args); throw new Error('response lost'); };
  await cashRefused(await cashForm([G, H, S]), /may have been created/);
  api.addTransactions = add;
  const form = await cashForm([G, H, S]); form.set('action', 'keep-found');
  budget.txns.get('new-1').notes = 'edited after preview';
  await cashRefused(form, /changed|Preview/);
  assert.equal((await entryNow()).creating.id, 'new-1');
  assert.equal(budget.adds.length, 1);
});

for (const [field, value] of [['cleared', false], ['transfer_id', 'a2']]) test(`Undo of a created cash purchase preserves a later ${field} change`, async () => {
  cashSeed(); quiet(); const { out } = await doCash(await cashForm([G, H, S]));
  budget.txns.get('new-1')[field] = value;
  const before = structuredClone(budget.txns.get('new-1'));
  assert.match(await fix.undoFix(undoForm(out), {}, { nextcloud: nc, lockWaitMs: 200 }), /nothing was undone/i);
  assert.deepEqual(budget.txns.get('new-1'), before);
  assert.equal(budget.deletes.length, 0);
});
