import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import api from '@actual-app/api';
import { config, log } from './config.js';
import { TransientError, isTransient } from './errors.js';
import { payeeScore } from './payee.js';
import { dayDiff, isoDay, shiftDay, today as todayIso } from './dates.js';
import { money, stripAnnotations, UNCATEGORIZED } from './reconcile.js';
import { setRules } from './rules.js';

// Turning an existing transaction into a split via updateTransaction({ subtransactions }) was fixed in
// actualbudget/actual#8467 (merged 2026-07-21), first released in @actual-app/api 26.8.0.
const apiVersion = JSON.parse(readFileSync(new URL('../node_modules/@actual-app/api/package.json', import.meta.url))).version;
const atLeast = (v, min) => {
  const a = v.split(/[.-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};
export const splitsSupported = atLeast(apiVersion, '26.8.0');

// Actual unreachable or restarting is an outage (TransientError, retried next poll); anything else, such as a wrong
// password or Sync ID, stays a normal Error that says which step failed.
async function step(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isTransient(err)) throw new TransientError(`Actual: could not ${what}: ${err.message}`, { cause: err });
    const hint = /password|auth|token/i.test(err.message ?? '') ? ' (check ACTUAL_PASSWORD / ACTUAL_E2E_PASSWORD)' : '';
    throw new Error(`Actual: could not ${what}: ${err.message}${hint}`, { cause: err });
  }
}

/** Log MATCH_ACCOUNTS names that the budget doesn't have (or can't search), so a typo doesn't silently match nothing. */
async function checkMatchAccounts() {
  const wanted = config.match.accounts;
  if (wanted.length === 0) return;
  const accounts = await api.getAccounts();
  const searchable = new Set(accounts.filter((x) => !x.closed && !x.offbudget).map((x) => x.name));
  const names = new Set(accounts.map((x) => x.name));
  const missing = wanted.filter((n) => !names.has(n));
  const unusable = wanted.filter((n) => names.has(n) && !searchable.has(n));
  if (missing.length) log(`MATCH_ACCOUNTS: no account named ${missing.map((n) => `"${n}"`).join(', ')} in the budget (names must match exactly)`);
  if (unusable.length) log(`MATCH_ACCOUNTS: ${unusable.map((n) => `"${n}"`).join(', ')} closed or off-budget, never searched`);
  if (!wanted.some((n) => searchable.has(n))) {
    log(`WARNING: none of the MATCH_ACCOUNTS (${wanted.join(', ')}) is an open on-budget account, so NO accounts will be searched and no receipt can match. Accounts: ${[...searchable].join(', ')}`);
  }
}

export async function open() {
  const a = config.actual;
  await fs.mkdir(a.dataDir, { recursive: true });
  try {
    await step('connect and log in', () => api.init({ dataDir: a.dataDir, serverURL: a.serverURL, password: a.password }));
    await step('download the budget', () => api.downloadBudget(a.syncId, a.e2ePassword ? { password: a.e2ePassword } : undefined));
    await step('read the accounts', checkMatchAccounts);
    // Read-only copy of your rules, to know which category they give each purchase.
    const [rules, payees, accounts, categories] = await Promise.all([api.getRules(), api.getPayees(), api.getAccounts(), api.getCategories()]);
    const n = setRules(rules, { payees, accounts, categories });
    log(`loaded ${n} Actual rule(s)`);
  } catch (err) {
    try { await api.shutdown(); } catch { /* already down */ } // the caller only closes after a successful open
    throw err;
  }
  if (config.splits && !splitsSupported) {
    log(`@actual-app/api ${apiVersion} can't split existing transactions (needs 26.8.0+); using one category per transaction`);
  }
}

export async function close() {
  await api.shutdown();
}

/** Map of "Group / Category" label → category id, for spending categories that aren't hidden. */
export async function categoryLabels() {
  const [groups, categories] = await Promise.all([api.getCategoryGroups(), api.getCategories()]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const labels = new Map();
  for (const c of categories) {
    if (c.is_income || c.hidden) continue;
    labels.set(`${groupName.get(c.group_id) ?? 'Other'} / ${c.name}`, c.id);
  }
  return labels;
}

/** Map of category id → "Group / Category" label: categoryLabels() turned around. */
export const idToLabel = (labels) => new Map([...labels].map(([label, id]) => [id, label]));

/** Map of payee id → payee name. */
export async function payeeNames() {
  return new Map((await api.getPayees()).map((p) => [p.id, p.name]));
}

/**
 * Every transaction dated start..end (YYYY-MM-DD) in each open on-budget account, account by account:
 * { t, account, payeeName } (payeeName is the payee's name, or null; callers fall back to imported_payee themselves).
 * With `matchAccounts`, only the accounts named in MATCH_ACCOUNTS (if any are set). Callers decide which
 * transactions to skip (split parts, transfers, ...). Lazy, so a caller that returns early stops fetching.
 */
export async function* budgetTransactions(start, end, { matchAccounts = false } = {}) {
  const [accounts, payeeName] = await Promise.all([api.getAccounts(), payeeNames()]);
  for (const account of accounts) {
    if (account.closed || account.offbudget) continue;
    if (matchAccounts && config.match.accounts.length > 0 && !config.match.accounts.includes(account.name)) continue;
    for (const t of await api.getTransactions(account.id, start, end)) {
      yield { t, account, payeeName: payeeName.get(t.payee) ?? null };
    }
  }
}

/** The dates to search: around the receipt date, or (undated receipt) the weeks before the photo was uploaded. */
export function matchWindow(date, anchorDate) {
  if (date) return { start: shiftDay(date, -1), end: shiftDay(date, config.match.days), ref: date };
  const anchor = isoDay(anchorDate);
  return { start: shiftDay(anchor, -config.match.noDateLookbackDays), end: shiftDay(anchor, 1), ref: anchor };
}

/**
 * Bank-synced transactions that could belong to a receipt, before the payee check:
 * an outflow equal to the receipt total (or larger by up to MATCH_TOLERANCE_PERCENT, for tips),
 * dated from 1 day before to MATCH_DAYS after the receipt date.
 */
export async function findCandidates(totalCents, window, { includeSplits = false } = {}) {
  const m = config.match;
  const target = -totalCents; // Actual stores outflows as negative integer cents
  const tolerance = Math.round((totalCents * m.tolerancePercent) / 100);
  const candidates = [];
  for await (const { t, account, payeeName } of budgetTransactions(window.start, window.end, { matchAccounts: true })) {
    if (t.is_child || t.transfer_id) continue;
    if (t.is_parent && !includeSplits) continue; // never touch existing splits (replay tests read them, never write)
    if (t.amount > target || t.amount < target - tolerance) continue;
    if ((t.notes ?? '').includes('#receipt')) continue; // already handled
    // Rule-categorized transactions stay candidates: a receipt can show they need splitting.
    candidates.push({
      ...t,
      cleared: t.cleared !== false, // rules can test it (rules.js); missing counts as cleared
      pending: t.cleared === false, // bank-synced but not posted yet: may still change or be replaced when it clears
      accountName: account.name,
      payeeName,
      extraCents: target - t.amount, // how much the charge exceeds the receipt (tip)
      days: Math.abs(dayDiff(t.date, window.ref)),
    });
  }
  return candidates;
}

/**
 * How this household filed earlier purchases at the same store: the examples the categorizer learns from.
 * Looks back HISTORY_DAYS across on-budget accounts, newest first, and leaves out `excludeId`
 * (the transaction being categorized, so a replay test can't peek at its own answer).
 */
export async function storeHistory(merchant, excludeId, idToLabel) {
  const today = todayIso();
  // A part with no category is the pipeline's Uncategorized part (unsure money), not an income or hidden category.
  const label = (id) => (id == null ? UNCATEGORIZED : idToLabel.get(id) ?? 'an income or hidden category');
  const found = [];
  for await (const { t, payeeName } of budgetTransactions(shiftDay(today, -config.history.days), today)) {
    if (t.id === excludeId || t.is_child || t.transfer_id || t.amount >= 0) continue;
    if (payeeScore(merchant, [payeeName ?? undefined, t.imported_payee]) < config.match.payeeMinScore) continue;
    const parts = t.is_parent
      ? (t.subtransactions ?? []).map((s) => ({ category: label(s.category), amount: money(-s.amount), notes: stripAnnotations(s.notes) }))
      : t.category ? [{ category: label(t.category), amount: money(-t.amount), notes: null }] : [];
    if (parts.length > 0) found.push({ date: t.date, amount: money(-t.amount), parts });
  }
  return found.sort((a, b) => b.date.localeCompare(a.date)).slice(0, config.history.limit);
}

/**
 * Item-level history from any store: split parts whose notes list items (the pipeline writes these; you can too),
 * and pipeline-categorized transactions whose note reads "#receipt <file> — items: ...". Leaves out `excludeId`.
 */
export async function itemHistory(excludeId, idToLabel) {
  const today = todayIso();
  const found = [];
  const always = []; // notes carrying `#always` or `#usually` (raw notes, item note, category): read by keywords.harvestAlways
  for await (const { t, payeeName } of budgetTransactions(shiftDay(today, -config.history.days), today)) {
    if (t.id === excludeId || t.is_child || t.transfer_id) continue;
    const store = payeeName ?? t.imported_payee ?? null;
    if (t.is_parent) {
      for (const s of t.subtransactions ?? []) {
        const items = stripAnnotations(s.notes);
        if (s.category && idToLabel.has(s.category) && /#(?:always|usually)\b/i.test(s.notes ?? '')) always.push({ txnId: t.id, date: t.date, notes: s.notes, item: items, category: idToLabel.get(s.category) });
        if (items && s.category && idToLabel.has(s.category)) found.push({ items, category: idToLabel.get(s.category), store });
      }
    } else if (t.category && idToLabel.has(t.category)) {
      const m = /#receipt [^|]*? — items: ([^|]+)/.exec(t.notes ?? '');
      const items = m && stripAnnotations(m[1]);
      if (/#(?:always|usually)\b/i.test(t.notes ?? '')) always.push({ txnId: t.id, date: t.date, notes: t.notes, item: items || null, category: idToLabel.get(t.category) });
      if (items) found.push({ items, category: idToLabel.get(t.category), store });
    }
  }
  found.always = always;
  return found;
}

/**
 * The transaction (on-budget, not a split part) dated sinceDate..today whose notes carry `#receipt <filename>`, or
 * null: a receipt applied before a crash, before its state was saved.
 */
export async function findTaggedTransaction(filename, sinceDate) {
  const today = todayIso();
  const tag = `#receipt ${filename}`;
  for await (const { t, account, payeeName } of budgetTransactions(sinceDate, today)) {
    if (t.is_child) continue;
    const notes = t.notes ?? '';
    const at = notes.indexOf(tag);
    // The tag ends at the end of the note, a space or " | "; "a.jpg" must not match "a.jpg.bak".
    if (at < 0 || !/^($|[\s|])/.test(notes.slice(at + tag.length))) continue;
    return { ...t, accountName: account.name, payeeName };
  }
  return null;
}

/**
 * What was filed in each of the given categories over the last HISTORY_DAYS: how many transactions, which stores,
 * amounts, and any item notes (split parts' notes, or the transaction note). Map of categoryId → activity.
 */
export async function categoryActivity(categoryIds) {
  const wanted = new Set(categoryIds);
  const today = todayIso();
  const activity = new Map(categoryIds.map((id) => [id, { count: 0, stores: new Map(), amounts: [], notes: [] }]));
  const add = (categoryId, store, amount, note) => {
    if (!wanted.has(categoryId) || amount >= 0) return;
    const a = activity.get(categoryId);
    a.count += 1;
    a.amounts.push(-amount / 100);
    if (store) a.stores.set(store, (a.stores.get(store) ?? 0) + 1);
    if (note && !note.startsWith('#receipt') && a.notes.length < 40) a.notes.push(note);
  };
  for await (const { t, payeeName } of budgetTransactions(shiftDay(today, -config.history.days), today)) {
    if (t.is_child || t.transfer_id) continue;
    const store = payeeName ?? t.imported_payee ?? null;
    if (t.is_parent) for (const s of t.subtransactions ?? []) add(s.category, store, s.amount, s.notes);
    else add(t.category, store, t.amount, t.notes);
  }
  return activity;
}

/** Give the whole transaction one category. */
export async function categorize(txn, categoryId, note) {
  await api.updateTransaction(txn.id, { category: categoryId, notes: joinNotes(txn.notes, note) });
}

/** Leave the category alone; only record that the receipt was checked. */
export async function addNote(txn, note) {
  await api.updateTransaction(txn.id, { notes: joinNotes(txn.notes, note) });
}

/** Split the transaction into one child per category. Children inherit the payee, account and date. */
export async function split(txn, allocation, note) {
  await api.updateTransaction(txn.id, {
    category: null,
    notes: joinNotes(txn.notes, note),
    subtransactions: allocation.map((a) => ({
      amount: -a.cents,
      category: a.categoryId,
      notes: a.items.join(', ').slice(0, 200),
    })),
  });
}

const joinNotes = (existing, note) => [existing, note].filter(Boolean).join(' | ');
