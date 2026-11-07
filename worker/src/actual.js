// Everything the worker does in Actual Budget through @actual-app/api: connect, read categories and transactions,
// find candidate charges and past purchases, and write splits, categories and notes. Used by match.js, receipt.js and index.js.
import fs from 'node:fs/promises';
import { api, apiInfo } from './actual-api.js';
import { config, log } from './config.js';
import { TransientError, isTransient } from './errors.js';
import { payeeScore } from './payee.js';
import { dayDiff, isoDay, shiftDay, today as todayIso } from './dates.js';
import { money, partKey, partNote, stripAnnotations, SPLIT_NOTE_MAX, UNCATEGORIZED } from './reconcile.js';
import { setRules } from './rules.js';
import { watchIndex } from './memory.js';
import { mkdirPrivate } from './private-files.js';

// Turning an existing transaction into a split via updateTransaction({ subtransactions }) was fixed in
// actualbudget/actual#8467 (merged 2026-07-21), first released in @actual-app/api 26.8.0.
const apiVersion = apiInfo.version;
const atLeast = (v, min) => {
  const a = v.split(/[.-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
};
// A bank can move a charge's date, so the pre-write re-check reads this many days either side of it.
const RECHECK_DAYS = 31;
// Most item notes kept per category in categoryActivity: enough to show what a category is for.
const ACTIVITY_NOTES_MAX = 40;
// A single-category note written by the worker: "#receipt <file> — items: <list>".
const ITEMS_NOTE = /#receipt [^|]*? — items: ([^|]+)/;
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
  await mkdirPrivate(a.dataDir);
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

/** Map of payee id → { name, transfer }. A transfer payee ("Alex's Checking") stands for one of your own accounts. */
async function payeeTable() {
  return new Map((await api.getPayees()).map((p) => [p.id, { name: p.name, transfer: Boolean(p.transfer_acct) }]));
}

/** Map of payee id → payee name. */
export async function payeeNames() {
  return new Map([...(await payeeTable())].map(([id, p]) => [id, p.name]));
}

/** The names of the real payees: every Actual payee that is not a transfer to one of your accounts. */
export async function realPayeeNames() {
  return [...(await payeeTable()).values()].filter((p) => p.name && !p.transfer).map((p) => p.name);
}

/**
 * Every transaction dated start..end (YYYY-MM-DD) in each open on-budget account, account by account:
 * { t, account, payeeName, payeeIsTransfer } (payeeName is the payee's name, or null; callers fall back to imported_payee themselves).
 * With `matchAccounts`, only the accounts named in MATCH_ACCOUNTS (if any are set). Callers decide which
 * transactions to skip (split parts, transfers, ...). Lazy, so a caller that returns early stops fetching.
 */
export async function* budgetTransactions(start, end, { matchAccounts = false } = {}) {
  const [accounts, payees] = await Promise.all([api.getAccounts(), payeeTable()]);
  for (const account of accounts) {
    if (account.closed || account.offbudget) continue;
    if (matchAccounts && config.match.accounts.length > 0 && !config.match.accounts.includes(account.name)) continue;
    for (const t of await api.getTransactions(account.id, start, end)) {
      const payee = payees.get(t.payee);
      yield { t, account, payeeName: payee?.name ?? null, payeeIsTransfer: payee?.transfer ?? false };
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
  for await (const { t, account, payeeName, payeeIsTransfer } of budgetTransactions(window.start, window.end, { matchAccounts: true })) {
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
      payeeIsTransfer,
      extraCents: target - t.amount, // how much the charge exceeds the receipt (tip)
      days: Math.abs(dayDiff(t.date, window.ref)),
    });
  }
  return candidates;
}

/**
 * The days history covers: HISTORY_DAYS back from `until`, up to and including `until`. No date, or one in the future, means today.
 * Counting back from `until` (not from today) keeps a replay of an old receipt looking at the year before that receipt.
 */
export function historyWindow(until = null) {
  const end = until && until < todayIso() ? until : todayIso();
  return { start: shiftDay(end, -config.history.days), end };
}

/**
 * How this household filed earlier purchases at the same store: the examples the categorizer learns from.
 * Looks back HISTORY_DAYS across on-budget accounts, newest first, and leaves out `excludeId`
 * (the transaction being categorized, so a replay test can't peek at its own answer).
 * `until` = the last day to look at (see historyWindow); a replay passes the day before the purchase, so it can't see the future either.
 */
export async function storeHistory(merchant, excludeId, idToLabel, until = null) {
  const { start, end } = historyWindow(until);
  // A part with no category is the pipeline's Uncategorized part (unsure money), not an income or hidden category.
  const label = (id) => (id == null ? UNCATEGORIZED : idToLabel.get(id) ?? 'an income or hidden category');
  const found = [];
  const { byTxn, verified, corrected } = await watchIndex();
  for await (const { t, payeeName } of budgetTransactions(start, end)) {
    if (t.id === excludeId || t.is_child || t.transfer_id || t.amount >= 0) continue;
    if (payeeScore(merchant, [payeeName ?? undefined, t.imported_payee]) < config.match.payeeMinScore) continue;
    // Each part says who is behind it (by: 'pipeline' for what the worker filed and you have neither confirmed nor changed;
    // storeConsensus ignores those parts). One part you corrected doesn't make the untouched ones yours.
    const own = (s) => ['household', 'corrected'].includes(provenance({ parentNotes: t.notes, notes: s.notes, cents: -s.amount, snapshot: byTxn.get(t.id), verified: verified.has(t.id), corrected: corrected.get(t.id) }));
    const parts = t.is_parent
      ? (t.subtransactions ?? []).map((s) => ({ category: label(s.category), amount: money(-s.amount), notes: stripAnnotations(s.notes), by: own(s) ? 'household' : 'pipeline' }))
      : t.category ? [{ category: label(t.category), amount: money(-t.amount), notes: null, by: byPipeline(t, verified, corrected) ? 'pipeline' : 'household' }] : [];
    if (parts.length > 0) found.push({ date: t.date, amount: money(-t.amount), parts, by: parts.every((p) => p.by === 'pipeline') ? 'pipeline' : 'household' });
  }
  return found.sort((a, b) => b.date.localeCompare(a.date)).slice(0, config.history.limit);
}

/** Did the worker file this transaction (its note has #receipt) and you have neither confirmed nor changed any of it? */
const byPipeline = (t, verified, corrected) => /#receipt /.test(t.notes ?? '') && !verified.has(t.id) && !corrected.has(t.id);

// The mark at the end of a part's note (reconcile.js partNote): every item in the part got the store's category by default.
const markedDefault = (notes) => /\(store default\)$/.test(String(notes ?? '').trim());
const sameNote = (a, b) => partKey(a) === partKey(b);
const isDefaulted = (it) => it.src === 'fallback' || it.src === 'unsure';

/**
 * Who is behind a split part (or a single-category item note), for item history:
 *   household         you made it (the parent has no #receipt tag), or you confirmed the worker's (removed #review)
 *   corrected         the worker made it and you changed it (the category differs from the snapshot, memory remembers you
 *                     changed this part, or you filled in a "(maybe")
 *   pipeline-fallback the worker made it only because the model was unsure (the store's default category)
 *   pipeline          the worker made it from the model's or a keyword's pick
 * `snapshot` is what the worker wrote (memory.js watch list), when it still has it; otherwise the "(store default)" mark
 * at the end of the note says whether it was a default. `category` is the part's label now (leave it out to skip that comparison).
 * `corrected` = the part keys memory.js remembers you changed.
 */
export function provenance({ parentNotes, notes, cents, category, snapshot, verified, corrected }) {
  if (!/#receipt /.test(parentNotes ?? '') || verified) return 'household';
  if (/\(maybe /.test(notes ?? '') || corrected?.includes(partKey(notes))) return 'corrected';
  const part = (snapshot?.parts ?? []).find((p) => p.cents === cents && sameNote(p.note, notes));
  if (part) {
    if (category !== undefined && (part.label ?? null) !== (category ?? null)) return 'corrected';
    return part.items?.length && part.items.every(isDefaulted) ? 'pipeline-fallback' : 'pipeline';
  }
  return markedDefault(notes) ? 'pipeline-fallback' : 'pipeline';
}

/**
 * Item-level history from any store: split parts whose notes list items (the pipeline writes these; you can too),
 * and pipeline-categorized transactions whose note reads "#receipt <file> — items: ...". Leaves out `excludeId`.
 * Each entry says who is behind it (`by`, see provenance) and carries its transaction id. `until`: see storeHistory.
 */
export async function itemHistory(excludeId, idToLabel, until = null) {
  const { start, end } = historyWindow(until);
  const found = [];
  const { byTxn, verified, corrected } = await watchIndex();
  const always = []; // notes carrying `#always` or `#usually` (raw notes, item note, category): read by keywords.harvestAlways
  for await (const { t, payeeName, payeeIsTransfer } of budgetTransactions(start, end)) {
    if (t.id === excludeId || t.is_child || t.transfer_id) continue;
    const store = payeeName ?? t.imported_payee ?? null;
    // payee: the Actual payee's own name, if it is a real one. The remote decider is only ever shown this, never `store`.
    const payee = payeeIsTransfer ? null : payeeName;
    const snapshot = byTxn.get(t.id);
    const ok = verified.has(t.id);
    const fixed = corrected.get(t.id);
    if (t.is_parent) {
      for (const s of t.subtransactions ?? []) {
        const items = stripAnnotations(s.notes);
        if (s.category && idToLabel.has(s.category) && /#(?:always|usually)\b/i.test(s.notes ?? '')) always.push({ txnId: t.id, date: t.date, notes: s.notes, item: items, category: idToLabel.get(s.category) });
        if (items && s.category && idToLabel.has(s.category)) {
          const category = idToLabel.get(s.category);
          found.push({ items, category, store, payee, date: t.date, txnId: t.id, by: provenance({ parentNotes: t.notes, notes: s.notes, cents: -s.amount, category, snapshot, verified: ok, corrected: fixed }) });
        }
      }
    } else if (t.category && idToLabel.has(t.category)) {
      const m = ITEMS_NOTE.exec(t.notes ?? '');
      const items = m && stripAnnotations(m[1]);
      if (/#(?:always|usually)\b/i.test(t.notes ?? '')) always.push({ txnId: t.id, date: t.date, notes: t.notes, item: items || null, category: idToLabel.get(t.category) });
      if (items) {
        const category = idToLabel.get(t.category);
        found.push({ items, category, store, payee, date: t.date, txnId: t.id, by: provenance({ parentNotes: t.notes, notes: m[1], cents: -t.amount, category, snapshot, verified: ok, corrected: fixed }) });
      }
    }
  }
  found.always = always;
  return found;
}

/**
 * Does the note carry `tag` ("#receipt <file>") as a whole? After the file name only what the worker itself writes counts:
 * the end of the note, " #review", " — items: ...", ": " (the category and note actions write "name: parts") or " | " (the next
 * note). A bare space and anything else does not, because a file name may contain spaces: "#receipt a.jpg scan.jpg" is the
 * tag of "a.jpg scan.jpg", not of "a.jpg". "a.jpg" must not match "a.jpg2" or "a.jpg.bak" either, and a later occurrence
 * still counts after an earlier near miss.
 */
const AFTER_FILE_NAME = /^(?:\s*$| \| |: |:\s*$| — items: | #review(?=$|[\s|:]))/;
export function hasTag(notes, tag) {
  for (let at = notes.indexOf(tag); at >= 0; at = notes.indexOf(tag, at + 1)) {
    if (AFTER_FILE_NAME.test(notes.slice(at + tag.length))) return true;
  }
  return false;
}

/**
 * Every transaction (on-budget, not a split part) dated sinceDate..today whose notes carry `#receipt <filename>`: a receipt
 * applied before a crash, before its state was saved. More than one means a file name used for two purchases.
 */
export async function findTaggedTransactions(filename, sinceDate) {
  const today = todayIso();
  const tag = `#receipt ${filename}`;
  const found = [];
  for await (const { t, account, payeeName } of budgetTransactions(sinceDate, today)) {
    if (t.is_child) continue;
    if (hasTag(t.notes ?? '', tag)) found.push({ ...t, accountName: account.name, payeeName });
  }
  return found;
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
    if (note && !note.startsWith('#receipt') && a.notes.length < ACTIVITY_NOTES_MAX) a.notes.push(note);
  };
  const { byTxn, verified, corrected } = await watchIndex();
  for await (const { t, payeeName } of budgetTransactions(shiftDay(today, -config.history.days), today)) {
    if (t.is_child || t.transfer_id) continue;
    const store = payeeName ?? t.imported_payee ?? null;
    const by = (notes, cents) => provenance({ parentNotes: t.notes, notes, cents, snapshot: byTxn.get(t.id), verified: verified.has(t.id), corrected: corrected.get(t.id) });
    if (t.is_parent) {
      // Parts the worker filed only by default say nothing about what a category is for; its other parts and yours count.
      for (const s of t.subtransactions ?? []) if (by(s.notes, -s.amount) !== 'pipeline-fallback') add(s.category, store, s.amount, stripAnnotations(s.notes));
    } else if (byPipeline(t, verified, corrected)) {
      const m = ITEMS_NOTE.exec(t.notes ?? '');
      if (m && by(m[1], -t.amount) !== 'pipeline-fallback') add(t.category, store, t.amount, t.notes);
    } else add(t.category, store, t.amount, t.notes);
  }
  return activity;
}

/** The parts of a split as comparable text: amount, category and note of each, in order. */
const splitKey = (t) => JSON.stringify((t.subtransactions ?? []).map((s) => [s.amount, s.category ?? null, s.notes ?? '']));

/**
 * Did the transaction change since it was matched? Compares what a write would overwrite or depend on: account, amount,
 * category, notes and split state (is_parent and the parts). Returns null when nothing changed, else a short reason.
 * `fresh` is null when the transaction can't be found any more.
 */
export function changedSince(matched, fresh) {
  if (!fresh) return 'it is no longer there';
  if ((fresh.account ?? null) !== (matched.account ?? null)) return 'it moved to another account';
  if (fresh.amount !== matched.amount) return 'its amount changed';
  if ((fresh.category ?? null) !== (matched.category ?? null)) return 'its category changed';
  if ((fresh.notes ?? '') !== (matched.notes ?? '')) return 'its notes changed';
  if (Boolean(fresh.is_parent) !== Boolean(matched.is_parent) || splitKey(fresh) !== splitKey(matched)) return 'its split changed';
  return null;
}

/** The "do not write" problem for a transaction that changed while its receipt was being processed. */
export const CHANGED_MEANWHILE = 'the transaction changed in Actual while the receipt was being processed; nothing was changed';

/**
 * Right before a write: sync with the server and read the transaction again by id (a month either side of its date, since
 * a bank can move the date). Returns null when it is still as it was matched, else why not. A sync that can't run is an
 * outage (TransientError): nothing is written and the receipt is tried again next poll.
 */
export async function changedMeanwhile(txn) {
  await step('sync before writing', async () => {
    if (typeof api.sync === 'function') await api.sync();
  });
  let fresh = null;
  let freshAccount = null;
  for await (const { t, account } of budgetTransactions(shiftDay(txn.date, -RECHECK_DAYS), shiftDay(txn.date, RECHECK_DAYS))) {
    if (t.id === txn.id) {
      fresh = t;
      freshAccount = account;
      break;
    }
  }
  // Closed and off-budget accounts are never read, so a transaction moved there is simply not found. An account outside
  // MATCH_ACCOUNTS is read, but matching would not have offered it.
  let why = changedSince(txn, fresh);
  if (!why && config.match.accounts.length > 0 && !config.match.accounts.includes(freshAccount.name)) why = 'its account is not one of MATCH_ACCOUNTS';
  if (why) log(`  ${CHANGED_MEANWHILE} (${why})`);
  return why;
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
      notes: partNote(a, ', ', SPLIT_NOTE_MAX),
    })),
  });
}

const joinNotes = (existing, note) => [existing, note].filter(Boolean).join(' | ');

export { apiInfo };
