// Your Actual rules, read-only: which category they give a transaction, and which stores they send to each category.
// Mirrors Actual's own evaluation (loot-core rules/condition.ts, rule-utils.ts, rule.ts): stages pre → default → post,
// within a stage less specific rules first so more specific ones win, and the last "set category" that matches wins.
import { shiftDay } from './dates.js';

// rule-utils.ts OP_SCORES and computeScore.
const OP_SCORES = {
  is: 10, isNot: 10, oneOf: 9, notOneOf: 9, isapprox: 5, isbetween: 5, gt: 1, gte: 1, lt: 1, lte: 1,
  contains: 0, doesNotContain: 0, matches: 0, hasTags: 0, hasAnyTag: 0, onBudget: 0, offBudget: 0,
};
const EXACT = new Set(['is', 'isNot', 'isapprox', 'oneOf', 'notOneOf']);

function score(rule) {
  // Actual's reducer returns 0 (dropping the score so far) on an op it doesn't know; mirrored so ties rank the same.
  const s = rule.conditions.reduce((n, c) => (OP_SCORES[c.op] == null ? 0 : n + OP_SCORES[c.op]), 0);
  return rule.conditions.every((c) => EXACT.has(c.op)) ? s * 2 : s;
}

function rank(rules) {
  const byStage = { pre: [], default: [], post: [] };
  for (const r of rules) (byStage[r.stage] ?? byStage.default).push(r);
  const sort = (list) => list.sort((a, b) => score(a) - score(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...sort(byStage.pre), ...sort(byStage.default), ...sort(byStage.post)];
}

// shared/rules.ts FIELD_INFO: the condition type comes from the field, not from what the rule row says.
const FIELD_TYPES = {
  imported_payee: 'string', payee_name: 'string', notes: 'string',
  payee: 'id', category: 'id', category_group: 'id', account: 'id',
  date: 'date', amount: 'number',
  cleared: 'boolean', reconciled: 'boolean', transfer: 'boolean', parent: 'boolean',
};

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? v.map(lower) : v);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** shared/tags.ts extractTagsForFilter: "one #two ##two" → ["#one", "#two"]. */
const tagsIn = (value) => [...new Set([...String(value ?? '').matchAll(/#*([^#\s]+)/g)].map((m) => `#${m[1]}`))];
const hasTag = (notes, tag) => new RegExp(`(?<!#)${escapeRe(tag.toLowerCase())}([\\s#]|$)`).test(notes);

/**
 * rules/condition.ts parse + eval. Where Actual compares an id field (payee, account, category) by *name* for contains,
 * doesNotContain and matches, so do we: the "apply rule" / matching-transactions view does (conditionsToAQL reaches
 * into payee.name), and that's what you meant when you wrote "payee contains walmart". Actual's live import path
 * compares the raw id there, which can never contain a store name.
 */
function conditionMatches(c, t, ctx) {
  const type = FIELD_TYPES[c.field] ?? c.type;
  let v = t[c.field];
  if (type === 'string') v ??= '';
  if (v === undefined) return false;
  if (typeof v === 'string') v = v.toLowerCase();
  if (type === 'number' && c.options) {
    if (c.options.outflow) {
      if (v > 0) return false;
      v = -v;
    } else if (c.options.inflow && v < 0) return false;
  }
  // Actual lowercases string values except tag lists; id values stay as stored (ids are lowercase uuids anyway).
  const raw = c.value;
  const want = type === 'string' && c.op !== 'hasTags' && c.op !== 'hasAnyTag'
    ? (Array.isArray(raw) ? raw.filter(Boolean).map(lower) : lower(raw))
    : raw;
  const num = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
  // contains / doesNotContain / matches on an id field compare its name (see above).
  const named = () => {
    if (v == null) return null;
    const name = { payee: ctx.payeeName, account: ctx.accountName, category: ctx.categoryName }[c.field]?.get(t[c.field]);
    return name == null ? null : name.toLowerCase();
  };
  const text = () => (type === 'id' ? named() : v);

  if (type === 'date') {
    if (v == null) return false;
    // Recurring-date values ({frequency, ...}) need Actual's schedule engine: treated as no match.
    if (typeof raw !== 'string') return false;
    const d = String(v);
    switch (c.op) {
      case 'is':
        if (raw.length === 10) return d === raw;
        if (raw.length === 7) return d.slice(0, 7) === raw;
        if (raw.length === 4) return d.slice(0, 4) === raw;
        return false;
      case 'isapprox': return raw.length === 10 && d >= shiftDay(raw, -2) && d <= shiftDay(raw, 2);
      // Actual rejects month/year values for these (the rule is invalid there), so they never match here.
      case 'gt': return raw.length === 10 && d > raw;
      case 'gte': return raw.length === 10 && d >= raw;
      case 'lt': return raw.length === 10 && d < raw;
      case 'lte': return raw.length === 10 && d <= raw;
      default: return false;
    }
  }

  switch (c.op) {
    case 'is': return v === num(want);
    case 'isNot': return v !== num(want);
    case 'isapprox': {
      if (type !== 'number') return v === want;
      const n = num(want);
      const threshold = Math.round(Math.abs(n) * 0.075); // shared/rules.ts getApproxNumberThreshold
      return v >= n - threshold && v <= n + threshold;
    }
    case 'oneOf': return v !== null && Array.isArray(want) && want.includes(v);
    case 'notOneOf': return v !== null && Array.isArray(want) && !want.includes(v);
    case 'contains': {
      const s = text();
      return s != null && String(s).includes(lower(want));
    }
    case 'doesNotContain': {
      const s = text();
      return s != null && !String(s).includes(lower(want));
    }
    case 'matches': {
      const s = text();
      if (s == null) return false;
      try {
        // Pattern and text are both lowercased, as in Actual, which makes it case-insensitive.
        return new RegExp(lower(want)).test(s);
      } catch {
        return false; // invalid regex: Actual logs and treats it as no match
      }
    }
    case 'hasTags': return v !== null && tagsIn(want).every((tag) => hasTag(String(v), tag));
    case 'hasAnyTag': return v !== null && tagsIn(want).some((tag) => hasTag(String(v), tag));
    case 'onBudget':
    case 'offBudget': {
      const account = ctx.accounts.get(t.account);
      if (!account) return false;
      return Boolean(account.offbudget) === (c.op === 'offBudget');
    }
    case 'isbetween': {
      const [lo, hi] = [want.num1, want.num2].sort((a, b) => a - b);
      return v >= lo && v <= hi;
    }
    case 'gt': return v !== null && v > num(want);
    case 'gte': return v !== null && v >= num(want);
    case 'lt': return v !== null && v < num(want);
    case 'lte': return v !== null && v <= num(want);
    default: return false; // operators this mirror doesn't know: treated as no match
  }
}

const matches = (rule, t, ctx) =>
  rule.conditions.length > 0 &&
  (rule.conditionsOp === 'or' ? rule.conditions.some((c) => conditionMatches(c, t, ctx)) : rule.conditions.every((c) => conditionMatches(c, t, ctx)));

/**
 * "set category" actions that apply to the whole transaction. A split rule's per-part actions carry
 * options.splitIndex > 0 (rule.ts execActions); 0 or absent is "apply to all", i.e. the parent.
 * Template/formula setters can't be evaluated here and are skipped.
 */
const wholeCategorySets = (rule) =>
  rule.actions.filter((a) => a.op === 'set' && a.field === 'category' && !a.options?.splitIndex && !a.options?.template && !a.options?.formula);

let ranked = null;
let ctx = { payeeName: new Map(), accounts: new Map(), accountName: new Map(), categoryName: new Map(), categoryGroup: new Map() };

/** Install rules and lookups: actual.open() calls it with what the API returns, tests with fixtures. Returns the rule count. */
export function setRules(rules, { payees = [], accounts = [], categories = [] } = {}) {
  ranked = rank(rules);
  ctx = {
    payeeName: new Map(payees.map((p) => [p.id, p.name])),
    accounts: new Map(accounts.map((a) => [a.id, a])),
    accountName: new Map(accounts.map((a) => [a.id, a.name])),
    categoryName: new Map(categories.map((c) => [c.id, c.name])),
    categoryGroup: new Map(categories.map((c) => [c.id, c.group_id])),
  };
  return ranked.length;
}

/**
 * The fields Actual's rule runner adds before evaluating (transaction-rules.ts runRules /
 * prepareTransactionForRules): missing payee/category count as null, plus payee_name and category_group.
 */
function forRules(txn) {
  const t = { ...txn, payee: txn.payee ?? null, category: txn.category ?? null };
  const name = t.payee ? ctx.payeeName.get(t.payee) : undefined;
  if (name != null) t.payee_name = name;
  if (t.category && ctx.categoryGroup.has(t.category)) t.category_group = ctx.categoryGroup.get(t.category);
  return t;
}

/**
 * The category id your rules would set on the whole transaction, or null. A split rule's per-part categories are
 * ignored: they'd split the purchase, and the last part's category isn't the purchase's category.
 */
export function ruleCategoryFor(txn) {
  if (!ranked) throw new Error('rules not loaded');
  const t = forRules(txn);
  let category = null;
  for (const rule of ranked) {
    if (!matches(rule, t, ctx)) continue;
    for (const a of wholeCategorySets(rule)) category = a.value ?? null;
  }
  return category;
}

/**
 * categoryId → store names your rules send there (from payee / imported_payee is and oneOf conditions).
 * Only whole-transaction "set category" counts: a split rule sends just a share of each purchase to each part's
 * category, and listing the store under those would read as "this store's purchases go here".
 * payeeName (id → name) defaults to the payees loaded with the rules.
 */
export function ruleStoresByCategory(payeeName = ctx.payeeName) {
  if (!ranked) throw new Error('rules not loaded');
  const out = new Map();
  for (const rule of ranked) {
    const set = wholeCategorySets(rule).pop(); // the last one wins in Actual
    if (!set?.value) continue;
    for (const c of rule.conditions) {
      if (c.field !== 'payee' && c.field !== 'imported_payee') continue;
      if (c.op !== 'is' && c.op !== 'oneOf') continue;
      const values = Array.isArray(c.value) ? c.value : [c.value];
      const names = values.map((v) => (c.field === 'payee' ? payeeName.get(v) : v)).filter(Boolean);
      out.set(set.value, [...new Set([...(out.get(set.value) ?? []), ...names])]);
    }
  }
  return out;
}

// The amount values (in cents, as the transaction holds them) where a condition's outcome can flip.
function amountEdges(c) {
  if (c.field !== 'amount') return [];
  const num = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
  // An outflow-only condition compares the spending size, so its edge sits on the negative side.
  const sign = c.options?.outflow ? -1 : 1;
  let edges = [];
  if (c.op === 'isbetween') edges = [c.value?.num1, c.value?.num2];
  else if (c.op === 'isapprox') {
    const n = num(c.value);
    const t = Math.round(Math.abs(n) * 0.075);
    edges = [n - t, n + t];
  } else if (['is', 'gt', 'gte', 'lt', 'lte'].includes(c.op)) edges = [num(c.value)];
  return edges.filter(Number.isFinite).map((e) => sign * e);
}

const MAX_AMOUNT_RANGES = 4;

/**
 * Where the charge amount changes the category your rules give this store. Finds rules whose other conditions match
 * the transaction but that also test the amount, tries amounts at and next to every edge (and the transaction's own),
 * and returns the spending ranges in dollars: [{ upTo, category }, { over, upTo, category }, { over, category }], with
 * category ids (null = no rule category). Empty when the amount doesn't matter, or when it splits into more than 4 ranges.
 */
export function amountRulesFor(txn) {
  if (!ranked) throw new Error('rules not loaded');
  const t = forRules(txn);
  const edges = new Set();
  for (const rule of ranked) {
    const amountConds = rule.conditions.filter((c) => c.field === 'amount');
    if (!amountConds.length) continue;
    const others = rule.conditions.filter((c) => c.field !== 'amount');
    if (rule.conditionsOp !== 'or' && !others.every((c) => conditionMatches(c, t, ctx))) continue;
    for (const c of amountConds) for (const e of amountEdges(c)) edges.add(e);
  }
  if (!edges.size) return [];
  // Spending sizes in cents to probe, smallest first: the edges, one either side, the charge itself, and the extremes.
  const sizes = new Set([1, 100_000_000, Math.abs(txn.amount ?? 0)]);
  for (const e of edges) for (const d of [-1, 0, 1]) sizes.add(-e + d);
  const probes = [...sizes].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  const runs = [];
  for (const size of probes) {
    const category = ruleCategoryFor({ ...txn, amount: -size });
    const last = runs[runs.length - 1];
    if (last && last.category === category) last.end = size;
    else runs.push({ category, end: size });
  }
  if (runs.length < 2 || runs.length > MAX_AMOUNT_RANGES) return [];
  return runs.map((r, i) => ({
    ...(i > 0 ? { over: runs[i - 1].end / 100 } : {}),
    ...(i < runs.length - 1 ? { upTo: r.end / 100 } : {}),
    category: r.category,
  }));
}
