// Shared harness for the synthetic-*.test.js files: made-up households (test-fixtures/synthetic), a fake Actual budget,
// a fake decider that answers like a sensible model (or a broken one), config overrides that are undone after each test,
// and the invariants every outcome must keep. It loads support.js (the Actual API and webdav stand-ins) itself.
import './support.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { shiftDay, today } from '../src/dates.js';
import { setRules } from '../src/rules.js';

const { default: api } = await import('@actual-app/api');
const actual = await import('../src/actual.js');
const { itemText } = await import('../src/item-context.js');
const { checkReceipt } = await import('../src/llm.js');

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'synthetic');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(FIXTURES, ...p), 'utf8'));

const BUDGETS = readJson('budgets.json');
export const BUDGET_NAMES = Object.keys(BUDGETS).filter((k) => !k.startsWith('_'));
export const SHARED = BUDGETS._shared;
export const budget = (name) => structuredClone({ ...BUDGETS[name], accounts: SHARED.accounts, payees: SHARED.payees });

export const READING_NAMES = fs.readdirSync(path.join(FIXTURES, 'readings')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
/** A reading fixture, dated `daysAgo` days before today (US style as printed, ISO as the model's own). Items keep their `kind`. */
export function fixture(name) {
  const fx = readJson('readings', `${name}.json`);
  if (fx.daysAgo != null) {
    const iso = day(-fx.daysAgo);
    fx.reading.date = iso;
    fx.reading.date_as_printed = `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)} 12:34 PM`;
  }
  return fx;
}
/** The reading without the test-only `kind` on each item: what the reader would have returned. */
export const readingOf = (fx) => ({ ...structuredClone(fx.reading), items: fx.reading.items.map(({ kind, ...rest }) => rest) });
/** item text the decider sees → kind, for the oracle. */
export const kindsOf = (fx) => new Map(fx.reading.items.map((i) => [itemText(i), i.kind ?? null]));
export const keywordFile = (name) => path.join(FIXTURES, 'keywords', `${name}.json`);

export const day = (n) => shiftDay(today(), n);
export const cents = (s) => Math.round(Number(s) * 100);

// ---- config: every test starts from the same settings ----
const pristine = structuredClone(config);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-test-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let runs = 0;
/** A fresh scratch directory under the test's own temp root. */
export const scratch = () => {
  const dir = path.join(tmpRoot, `r${++runs}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
/**
 * Restore every setting, then point every file the worker would touch at a fresh scratch directory, quiet the log and
 * apply `over` (nested objects are merged: { match: { overwrite: false } }).
 */
export function resetConfig(over = {}) {
  for (const k of Object.keys(config)) if (!(k in pristine)) delete config[k];
  for (const [k, v] of Object.entries(structuredClone(pristine))) {
    if (v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object') {
      for (const kk of Object.keys(config[k])) delete config[k][kk];
      Object.assign(config[k], v);
    } else config[k] = v;
  }
  const dir = scratch();
  Object.assign(config, {
    dryRun: false, keywordsPath: path.join(dir, 'keywords.json'), categoryNotesPath: path.join(dir, 'notes.json'),
    deciderUrl: 'http://decider.test', llmUrl: 'http://reader.test', excludeGroups: [], excludeCategories: [],
  });
  Object.assign(config.learning, { dir: path.join(dir, 'memory') });
  Object.assign(config.occasions, { enabled: false });
  Object.assign(config.privacy, { wordsPath: path.join(dir, 'pw.json'), scanCachePath: path.join(dir, 'scan.json'), previewRoot: path.join(dir, 'research'), seedWords: [], seedPlaces: [] });
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object') Object.assign(config[k], v);
    else config[k] = v;
  }
  return dir;
}

// ---- the fake Actual budget ----
/**
 * Install a budget: accounts, payees, categories, rules and transactions. updateTransaction is recorded in `writes`
 * (and applied to the transaction, so a second look sees it). Returns { writes, txns, labels (Map label → id) }.
 */
export async function fakeActual(b, txns = [], rules = []) {
  const writes = [];
  mock.method(api, 'getAccounts', async () => b.accounts);
  mock.method(api, 'getPayees', async () => b.payees);
  mock.method(api, 'getCategoryGroups', async () => b.groups);
  mock.method(api, 'getCategories', async () => b.categories);
  mock.method(api, 'getRules', async () => rules);
  mock.method(api, 'getTransactions', async (acct, start, end) => txns.filter((t) => t.account === acct && t.date >= start && t.date <= end).map((t) => structuredClone(t)));
  mock.method(api, 'updateTransaction', async (id, fields) => {
    writes.push({ id, fields: structuredClone(fields) });
    const t = txns.find((x) => x.id === id);
    if (t) Object.assign(t, fields, fields.subtransactions ? { is_parent: true } : {});
  });
  setRules(rules, { payees: b.payees, accounts: b.accounts, categories: b.categories });
  const labels = await actual.categoryLabels();
  return { writes, txns, labels };
}
/** A rule "payee is <payeeId> → set category <categoryId>". */
export const payeeRule = (payeeId, categoryId, id = `r-${payeeId}`) => ({ id, stage: null, conditionsOp: 'and', conditions: [{ field: 'payee', op: 'is', value: payeeId }], actions: [{ op: 'set', field: 'category', value: categoryId }] });

/** A bank charge for this fixture: on the card account, dated the receipt day, for the total (or chargeCents). */
export function chargeFor(fx, over = {}) {
  const totalCents = Math.round(fx.reading.total * 100);
  const amount = fx.chargeCents ?? (fx.chargeFactor ? Math.round(totalCents * fx.chargeFactor) : totalCents);
  return { id: `t-${fx.name}`, account: 'acct-cc', date: fx.reading.date ?? day(-1), amount: -amount, payee: fx.payee, imported_payee: fx.importedPayee, category: null, notes: null, cleared: true, ...over };
}

// ---- the fake decider ----
const brief = (state) => state.item ?? '(whole receipt)';
/**
 * Mock fetch for the local decider (and its /health). `answer(state, labels, ctx)` returns the decider's reply body (or a
 * Response); the default is `oracle`. Returns the requests seen ({ state, labels }).
 */
export function fakeDecider(answer = oracle, ctx = {}) {
  const seen = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url);
    if (u.endsWith('/health')) return new Response('ok');
    if (!u.startsWith(`${config.deciderUrl}/v1/systemone`)) throw new Error(`unexpected request to ${u}`);
    const body = JSON.parse(init.body);
    const labels = Object.keys(body.questions.category.criteria);
    seen.push({ state: body.state, labels });
    const out = answer(body.state, labels, ctx);
    if (out instanceof Response) return out;
    return new Response(typeof out === 'string' ? out : JSON.stringify(out));
  });
  return seen;
}
export const reply = (choice, confidence, probabilities) => ({ answers: { category: { choice, confidence, ...(probabilities !== undefined ? { probabilities } : {}) } } });

/** Spread `p` on `label` and the rest evenly over the other labels (at most 4 others named). */
export function spread(labels, label, p) {
  const others = labels.filter((l) => l !== label).slice(0, 4);
  const rest = others.length ? (1 - p) / others.length : 0;
  return Object.fromEntries([[label, p], ...others.map((l) => [l, rest])]);
}

/**
 * A sensible decider: ctx.kinds (item text → kind) and ctx.kindLabels (kind → label). A known kind is answered with 0.85,
 * an unknown one (fees, deposits, cash back) with a near three-way tie on the first labels. The whole-receipt question is
 * answered with the label holding the most money, at 0.7.
 */
export function oracle(state, labels, { kinds = new Map(), kindLabels = {}, sure = 0.85 } = {}) {
  const labelOf = (text) => {
    const k = kinds.get(text);
    const l = k ? kindLabels[k] : null;
    return l && labels.includes(l) ? l : null;
  };
  if (state.items_on_receipt) {
    const by = new Map();
    for (const it of state.items_on_receipt) {
      const l = labelOf(it.item);
      if (l) by.set(l, (by.get(l) ?? 0) + it.price);
    }
    const best = [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? labels[0];
    return reply(best, 0.7, spread(labels, best, 0.7));
  }
  const l = labelOf(state.item);
  if (l) return reply(l, sure, spread(labels, l, sure));
  const [a, b, c] = labels;
  const p = c ? { [a]: 0.35, [b]: 0.33, [c]: 0.32 } : b ? { [a]: 0.51, [b]: 0.49 } : { [a]: 1 };
  return reply(a, 0.9, p);
}

// ---- running a receipt end to end ----
/**
 * Install `b` with `txns`, the decider `answer`, then handleReceipt the fixture. Returns { out, writes, labels, txn, seen }.
 * opts: { txns (default: one charge for the fixture), rules, answer, reading (override), handleOpts, keywords (file path) }
 */
export async function runReceipt(fx, b, opts = {}) {
  const { handleReceipt } = await import('../src/receipt.js');
  mock.reset(); // restoreAll would keep every earlier mock on the tracker, and each later restore walks them all
  quiet();
  const txn = structuredClone(opts.txn ?? chargeFor(fx, opts.charge));
  const txns = structuredClone(opts.txns ?? [txn]); // the fake applies writes to these: never to the caller's objects
  const { writes, labels } = await fakeActual(b, txns, opts.rules ?? []);
  if (opts.keywords) fs.copyFileSync(opts.keywords, config.keywordsPath);
  const seen = fakeDecider(opts.answer ?? oracle, { kinds: kindsOf(fx), kindLabels: b.kinds, ...(opts.deciderCtx ?? {}) });
  // A fixture goes through the reader's own check first (llm.js checkReceipt), as every live reading does; an override is used as given.
  const reading = opts.reading ?? checkReceipt(readingOf(fx));
  const out = await handleReceipt({ basename: `${fx.name}.jpg`, lastmod: new Date().toUTCString() }, reading, 'test', labels, opts.handleOpts ?? {});
  return { out, writes, labels, txn, seen, txns };
}

/** The labels receipts may use in this budget (as receiptLabels would give them with the budget's exclusions). */
// Worked out from the budget's own group and category names, not by splitting the label, so a " / " inside a name can't hide a mistake.
export function allowedLabels(labels, b) {
  const group = new Map(b.groups.map((g) => [g.id, g.name]));
  return b.categories
    .filter((c) => !c.is_income && !c.hidden && !b.exclude.groups.includes(group.get(c.group_id)))
    .map((c) => `${group.get(c.group_id)} / ${c.name}`)
    .filter((l) => labels.has(l) && !b.exclude.categories.includes(l));
}
/** The category id of a "Group / Category" label in this budget, or undefined. */
export const idOf = (b, label) => b.categories.find((c) => `${b.groups.find((g) => g.id === c.group_id).name} / ${c.name}` === label)?.id;
/** Apply the budget's EXCLUDE_CATEGORY_GROUPS / EXCLUDE_CATEGORIES. */
export const excludeFor = (b) => ({ excludeGroups: [...b.exclude.groups], excludeCategories: [...b.exclude.categories] });
/** Quiet the worker's log for this test. */
export const quiet = () => mock.method(console, 'log', () => {});

const RESULT = /^(?:(?:dry-run:)?(?:split|categorize|confirm|note)(?:\+review)?|review|waiting)$/;
const isMoney = (s) => typeof s === 'string' && /^-?\d+\.\d\d$/.test(s) && s !== '-0.00';

/**
 * The invariants every outcome keeps, whatever the receipt, budget or settings:
 *   a known result; review and waiting say why; plan amounts are money strings that add up exactly to the bank charge;
 *   every part's category is one receipts may use (or Uncategorized); every item ends with such a category (or none);
 *   unsure money moved means review; a dry run writes nothing; a live write adds up to the charge, to the cent, with
 *   allowed category ids only, and tags the note with #receipt <file>.
 * `where` names the case in every failure message.
 */
export function checkInvariants({ out, writes, labels, txn: given, txns = [] }, b, where, { allowed = allowedLabels(labels, b) } = {}) {
  // With several candidate charges, the one the receipt matched is the one everything must add up to.
  const txn = txns.find((t) => t.id === out?.summary?.transaction?.id) ?? given;
  const msg = (s) => `${where}: ${s}\n  result=${out?.result} problems=${JSON.stringify(out?.summary?.problems ?? out?.summary?.waiting)}`;
  assert.ok(out && typeof out.result === 'string', msg('no result'));
  assert.match(out.result, RESULT, msg(`unknown result ${out.result}`));
  const s = out.summary;
  if (out.result === 'waiting') {
    assert.ok(s.waiting && out.waiting?.until, msg('waiting without a reason or a time'));
    assert.equal(writes.length, 0, msg('wrote while waiting'));
    return;
  }
  if (out.result === 'review') {
    assert.ok(s.problems.length > 0, msg('review without a reason'));
    assert.equal(writes.length, 0, msg('wrote to Actual although the receipt went to review'));
  }
  for (const p of s.problems) assert.ok(typeof p === 'string' && p.length > 0 && !/undefined|NaN/.test(p), msg(`odd problem text: ${p}`));
  const allowedIds = new Set(allowed.map((l) => labels.get(l)));
  if (s.plan) {
    const parts = s.plan.parts;
    for (const p of parts) {
      assert.ok(isMoney(p.amount), msg(`part amount ${JSON.stringify(p.amount)} is not money`));
      assert.ok(p.category === 'Uncategorized' || allowed.includes(p.category), msg(`part category "${p.category}" is not one receipts may use`));
      assert.ok(Array.isArray(p.items) && p.items.every((t) => typeof t === 'string' && !/undefined|NaN/.test(t)), msg(`part items ${JSON.stringify(p.items)}`));
    }
    assert.equal(parts.reduce((n, p) => n + cents(p.amount), 0), -txn.amount, msg(`parts ${parts.map((p) => p.amount).join(' + ')} do not add up to the charge ${(-txn.amount / 100).toFixed(2)}`));
    const applied = out.result !== 'review';
    const unsureMoney = parts.some((p) => p.category === 'Uncategorized');
    if (applied && unsureMoney) assert.match(out.result, /\+review$/, msg('applied an Uncategorized part without sending the receipt to review'));
    if (applied && /split|categorize/.test(out.result)) {
      const unsureItems = s.receipt.items.filter((it) => it.fellBack || it.category === 'Uncategorized');
      if (unsureItems.length && unsureItems.some((it) => cents(it.amount) !== 0)) assert.match(out.result, /\+review$/, msg(`moved money with unsure items (${unsureItems.map((i) => i.description).join(', ')}) and no review`));
    }
  }
  for (const it of s.receipt?.items ?? []) {
    assert.ok(Number.isFinite(it.amount), msg(`item ${it.description} amount ${it.amount}`));
    if (s.plan && it.category != null) assert.ok(it.category === 'Uncategorized' || allowed.includes(it.category), msg(`item ${it.description} filed under "${it.category}"`));
  }
  if (config.dryRun) assert.equal(writes.length, 0, msg('a dry run wrote to Actual'));
  for (const w of writes) {
    assert.equal(w.id, txn.id, msg('wrote to another transaction'));
    assert.match(w.fields.notes ?? '', new RegExp(`#receipt ${out.summary.file.replace(/\./g, '\\.')}`), msg('the note has no #receipt tag'));
    if (w.fields.subtransactions) {
      const subs = w.fields.subtransactions;
      assert.ok(subs.length >= 2, msg('a split with fewer than two parts'));
      for (const c of subs) {
        assert.ok(Number.isInteger(c.amount) && !Object.is(c.amount, -0), msg(`child amount ${c.amount}`));
        assert.ok(c.category === null || allowedIds.has(c.category), msg(`child category ${c.category} is not allowed`));
        assert.equal(typeof c.notes, 'string', msg('child without a note'));
      }
      assert.equal(subs.reduce((n, c) => n + c.amount, 0), txn.amount, msg(`children ${subs.map((c) => c.amount).join(' + ')} != ${txn.amount}`));
      assert.equal(w.fields.category, null, msg('a split parent kept a category'));
    } else if ('category' in w.fields) {
      assert.ok(allowedIds.has(w.fields.category), msg(`categorized as ${w.fields.category}, not an allowed category`));
    }
  }
}

export { api, actual };
