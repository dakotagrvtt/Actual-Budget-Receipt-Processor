import { filePageSummary } from './filing.js';
// Cash purchases: a receipt paid in cash has no bank charge, so it waits in Needs review. Its page offers the same item editor as any
// receipt, and (only when a person presses a button, never by itself, and never in dry run) can
//   create    a new transaction in the chosen account (the receipt total as an outflow, one category or a split), or
//   split     an existing transaction of the same amount found in that account (the person's own entry of the purchase), exactly as
//             "Apply to Actual" does for a matched charge.
// Either way the receipt is then filed like any applied one, with a summary that has the transaction, the plan and the applied record,
// so Done, Check Actual now, the learning watch and Undo (within 15 minutes) treat it like a charge the worker wrote. The created
// transaction is marked the way the worker marks all its writes: a "#receipt <file>" note (items listed for one category, the parts' notes
// on a split), "#review" when part is doubtful, and an `applied` record. Undo deletes it, only while it is still exactly what was written.
// The preview's look at Actual (the account, the payee, duplicates) is read only and is part of the token, so a commit refuses when it changed.
import crypto from 'node:crypto';
import { selectionSnapshot } from './receipt-selection.js';
import path from 'node:path/posix';
import { config, log } from './config.js';
import { money, partNote, shortName, SPLIT_NOTE_MAX, UNCATEGORIZED, cents } from './reconcile.js';
import { inFolder } from './folders.js';
import { patchEntry } from './state.js';
import { BusyError, exclusive } from './session-lock.js';
import { offerUndo, PanelError } from './panel-actions.js';
import * as memory from './memory.js';
import { rememberAccounts } from './known-accounts.js';
import {
  asPanelError, cashDate, classify, cashExtra, editsFrom, fileOf, fingerprint, gapLabelOf, learn, loadEntry, MAX_UNDO_ID, openActual, originalOf, partsOf, refuseInDryRun,
  replan, segmentFor, STALE, tokenFor, UNDO_ROUTE, workerPicks, willReview, writeKind, writeToActual,
} from './receipt-fix.js';

const HIDDEN = 'a hidden or income category';
const LOOK_WAIT_MS = 4000; // the page's look at Actual waits this long for the worker (a check can hold the lock for minutes)
const LOCK_WAIT_MS = 20000;
const NO_ACCOUNT = 'No account is chosen for cash purchases. Pick one on this page, or set "Cash purchases go to" on the Settings tab. Nothing was changed.';

const totalCents = (summary) => cents(summary.receipt.total);

/** The account name asked for (the form's, else the setting), '' when none. */
export const accountAsked = (form) => (form.get('acct') ?? config.cashAccount).trim();

/** Actual's answer (cashLookup) with the category of each existing transaction named. Actual must be open. */
async function look(actual, { entry, summary, accountName }) {
  const labels = await actual.categoryLabels();
  const names = actual.idToLabel(labels);
  await actual.syncNow();
  const found = await actual.cashLookup({ accountName, date: cashDate(entry, summary), cents: totalCents(summary), receipt: summary.receipt });
  await rememberAccounts(found.accounts).catch(() => {});
  const earlier = entry.creating ? await actual.findCreation(entry.creating.id) : null;
  const recovery = entry.creating ? { id: entry.creating.id, found: Boolean(earlier), ...(earlier ? { snapshot: selectionSnapshot(earlier.t), date: earlier.t.date, amount: earlier.t.amount, payeeName: earlier.payeeName, accountName: earlier.account.name } : {}) } : null;
  return { ...found, labels, recovery, duplicates: found.duplicates.map((d) => ({ ...d, category: d.categoryId ? names.get(d.categoryId) ?? HIDDEN : null })) };
}

/**
 * The receipt page's read-only look at Actual for a cash receipt's preview: the account, the payee and the duplicates, or { error }. It takes the
 * session lock for a moment (opening Actual must not overlap a check) and says so plainly when the worker is busy.
 */
export async function lookAtActual({ entry, summary, accountName }, deps = {}) {
  if (!accountName) return { error: NO_ACCOUNT.replace(' Nothing was changed.', '') };
  try {
    return await exclusive(async () => {
      const actual = deps.actual ?? (await import('./actual.js'));
      await openActual(actual);
      try {
        const { labels: _labels, ...rest } = await look(actual, { entry, summary, accountName });
        return rest;
      } finally {
        await actual.close();
      }
    }, { timeoutMs: deps.lookWaitMs ?? LOOK_WAIT_MS });
  } catch (err) {
    if (err instanceof BusyError) return { error: 'The worker is busy checking receipts right now, so Actual could not be looked at. Press Preview again in a minute.' };
    return { error: err instanceof PanelError ? err.message : `Couldn't look at Actual (${err.message}).` };
  }
}

/**
 * POST /receipt-cash: Create in Actual (form.action 'create') or Split this one instead (action 'split', dup = the transaction's id).
 * form: id, the editor's fields (c0.., a0.., nd0..), acct, token, state. Returns the notice. deps (tests): nextcloud, actual, lockWaitMs.
 */
export async function commitCash(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  refuseInDryRun(id);
  try {
    return await exclusive(() => commitNow(form, out, id, deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t finish creating it; check Actual before trying again');
  }
}

async function commitNow(form, out, id, deps) {
  refuseInDryRun(id);
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  if (state.kind !== 'cash') throw new PanelError('This receipt is not a cash purchase waiting for a transaction. Nothing was changed.');
  if (entry.creating && form.get('action') === 'split') throw new PanelError('An earlier Create may have reached Actual. Finish recording it before choosing another transaction.');
  const edits = editsFrom(form, summary);
  if (edits.error) throw new PanelError(edits.error);
  if (!form.get('token') || !form.get('state')) throw new PanelError('Press Preview first, then create it. Nothing was changed.');
  if (form.get('state') !== fingerprint(id, entry, summary, null)) throw new PanelError(STALE);
  const accountName = accountAsked(form);
  if (!accountName) throw new PanelError(NO_ACCOUNT);
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    return await write({ actual, form, out, id, entry, summary, edits, accountName, deps });
  } finally {
    await actual.close();
  }
}

async function write({ actual, form, out, id, entry, summary, edits, accountName, deps }) {
  const { picks } = edits;
  const found = await look(actual, { entry, summary, accountName });
  const { labels } = found;
  const lost = [...picks, ...edits.added.map((a) => a.category)].find((p) => p !== UNCATEGORIZED && !labels.has(p));
  if (lost !== undefined) throw new PanelError(`"${lost}" is not one of Actual's categories (a category may have been hidden or removed). Nothing was changed.`);
  if (!found.account) throw new PanelError(`"${accountName}" is not an open account in your budget that the worker may use (MATCH_ACCOUNTS). Pick another. Nothing was changed.`);
  const total = totalCents(summary);
  const plan = replan({ summary, picks, amounts: edits.amounts, added: edits.added, labelToId: labels, targetCents: total });
  if (plan.error) throw new PanelError(`${plan.error} Nothing was changed.`);
  if (!plan.allocation.some((a) => a.categoryId)) throw new PanelError('Choose a category for at least one item. Nothing was changed.');
  if (form.get('token') !== tokenFor(id, entry, summary, edits, plan.allocation, null, cashExtra(accountName, found))) throw new PanelError(STALE);
  if (['adopt-existing', 'keep-found'].includes(form.get('action'))) return adoptExisting({ id, entry, summary, found, form, deps });
  if (form.get('action') === 'split') return splitExisting({ actual, form, out, id, entry, summary, edits, plan, found, deps });
  if (!['create', 'retry-create'].includes(form.get('action'))) throw new PanelError('Choose Create or Retry creation from the current preview.');
  return createNew({ actual, out, id, entry, summary, edits, plan, found, labels, deps, retryAbsent: form.get('action') === 'retry-create' });
}

/** Explicitly keep a matching hand-entered purchase after the planned UUID was confirmed absent. */
async function adoptExisting({ id, entry, summary, found, form, deps }) {
  const keepingFound = form.get('action') === 'keep-found';
  const chosen = keepingFound && found.recovery?.found ? { ...found.recovery, id: found.recovery.id } : found.duplicates.find((d) => d.id === form.get('dup'));
  if (!entry.creating || (!keepingFound && found.recovery?.found) || !chosen || chosen.snapshot?.cleared === false) throw new PanelError('Find the earlier purchase again before linking it. Nothing was changed.');
  const at = new Date().toISOString();
  const saved = { ...summary, transaction: { id: chosen.id, date: chosen.date, account: chosen.accountName ?? found.account.name, amount: money(-chosen.amount), payee: chosen.payeeName }, plan: { action: 'note', applied: true, parts: [] }, problems: [], recoveredCreation: { plannedId: entry.creating.id, adoptedId: chosen.id } };
  const dest = path.join(config.nextcloud.processed, path.basename(entry.filedAs));
  await patchEntry(id, (e) => { const { creating, error, ...rest } = e; return { ...rest, result: 'confirm', at, manualLink: { keep: true, at }, applied: { txnId: chosen.id, action: 'note', linked: true, at }, filing: { kind: 'page', from: entry.filedAs, dest, summary: saved } }; });
  try { await filePageSummary(id, entry, dest, saved, deps.nextcloud ?? await import('./nextcloud.js')); }
  catch { return 'Linked to the existing purchase without changing Actual. Its receipt save will finish automatically.'; }
  return 'Linked to the existing purchase without changing its amounts, categories or notes. You can archive this receipt.';
}

/** "Split this one instead": the existing transaction is treated as the matched charge, and the usual Apply (receipt-fix.js) does the rest with its guards. */
async function splitExisting({ actual, form, out, id, entry, summary, edits, plan, found, deps }) {
  const dup = found.duplicates.find((d) => d.id === form.get('dup'));
  if (dup?.isParent) throw new PanelError('That charge is split now. Nothing was changed.');
  if (!dup) throw new PanelError('That transaction is not in the account any more (or no longer looks like this purchase). Press Preview again. Nothing was changed.');
  const patched = {
    ...summary,
    transaction: { id: dup.id, date: dup.date, account: found.account.name, amount: money(totalCents(summary)), payee: dup.payeeName, currentCategory: dup.category, pending: false },
  };
  const inner = new URLSearchParams(form);
  inner.set('token', tokenFor(id, entry, patched, edits, plan.allocation, null)); // the check inside Apply covers the receipt as linked to that transaction
  return writeToActual({ actual, form: inner, out, id, entry, summary: patched, edits, kind: 'review', seen: null, deps, noTransaction: true, cashAccountId: found.account.id });
}

/** "Create in Actual": a new transaction, read back and checked, then the receipt is filed as an applied one. */
async function createNew({ actual, out, id, entry, summary, edits, plan, found, labels, deps, retryAbsent = false }) {
  const { picks } = edits;
  const file = fileOf(id, summary);
  const total = totalCents(summary);
  const date = cashDate(entry, summary);
  const review = willReview(plan);
  const { main, split: wantSplit } = writeKind(plan.allocation, config.splits && actual.splitsSupported, null);
  const action = wantSplit ? 'split' : 'categorize';
  const notes = segmentFor({ tag: `#receipt ${file}`, review, allocation: plan.allocation, split: wantSplit });
  const children = wantSplit ? plan.allocation.map((a) => ({ amount: -a.cents, category: a.categoryId, notes: partNote(a, ', ', SPLIT_NOTE_MAX) })) : null;
  const want = wantSplit ? { notes, children } : { notes, category: main.categoryId };
  let pending = entry.creating;
  const newId = pending?.id ?? deps.newId?.() ?? crypto.randomUUID();
  const identity = { date, account: found.account.id, amount: -total };
  if (pending && retryAbsent && !entry.applied && !found.recovery?.found) {
    pending = { ...pending, identity, want, context: { summary, edits, plan, payee: found.payee, accountName: found.account.name } };
    await patchEntry(id, (e) => ({ ...e, creating: pending }));
  } else if (pending && JSON.stringify([pending.identity, pending.want]) !== JSON.stringify([identity, want])) {
    throw new PanelError('An earlier Create may have reached Actual. Use the same preview choices to finish it, or keep the found purchase unchanged.');
  }
  let row = pending ? await actual.findCreation(newId) : null;
  if (!pending) {
    const tagged = await actual.findTaggedTransactions(file, date);
    if (tagged.length) throw new PanelError('Actual already has a transaction tagged for this receipt. Check it in Actual; a second transaction was not created.');
    await patchEntry(id, (e) => ({ ...e, creating: { id: newId, identity, want, at: new Date().toISOString(), context: { summary, edits, plan, payee: found.payee, accountName: found.account.name } } }));
  }
  if (!row) {
    // An uncertain add is never repeated: Actual may have accepted it before the connection failed.
    if (pending && (!retryAbsent || entry.applied)) throw new PanelError('The earlier Create could not be found. Preview again and choose Retry creation after lookup; no second transaction was created.');
    if (pending && found.duplicates.length) throw new PanelError('A possible existing purchase was found. Check it in Actual before retrying; nothing was created.');
    refuseInDryRun(id);
    try {
      await actual.createTransaction(found.account.id, found.payee, { id: newId, date, amount: -total, notes, cleared: true, ...(wantSplit ? { subtransactions: children } : { category: main.categoryId }) });
    } catch (err) {
      throw new PanelError(`A transaction may have been created in Actual (${err.message}). Check Actual, then Preview again to finish recording it.`);
    }
  }
  if (row && (row.t.account !== identity.account || row.t.date !== identity.date || row.t.amount !== identity.amount || row.t.reconciled || row.payeeIsTransfer || row.account.closed || row.account.offbudget || (pending?.context?.payee && (pending.context.payee.id ? row.t.payee !== pending.context.payee.id : row.payeeName !== pending.context.payee.name)))) throw new PanelError('The earlier purchase was changed in Actual. It was kept; nothing else was created.');
  // Persist success before read-back, rule repair, learning or Nextcloud can fail.
  const appliedAt = new Date().toISOString();
  await patchEntry(id, (e) => ({ ...e, applied: { txnId: newId, action, at: appliedAt, created: true } }));
  row ??= await actual.findById(newId, date);
  let ruleNote = '';
  if (!actual.isWritten(row?.t, want)) {
    if (!row?.t || row.t.account !== identity.account || row.t.date !== date || row.t.amount !== -total || row.t.reconciled || pending) {
      throw new PanelError('The created transaction differs from the preview. Check it in Actual; it will not be created a second time.');
    }
    await actual.rewrite(row.t, want);
    row = await actual.findById(newId, date);
    ruleNote = ' An Actual rule changed the transaction; the receipt split was put back.';
  }
  if (!row?.t || !actual.isWritten(row.t, want)) throw new PanelError('The transaction was created but could not be verified. Check it in Actual.');
  log(`receipt page: ${file}: cash purchase created (${action}) as ${newId} in ${found.account.name}`);

  try {
    const at = new Date().toISOString();
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    const txn = { id: newId, date, amount: -total };
    const base = replan({ summary, picks: workerPicks(summary), labelToId: labels, targetCents: total });
    const learned = base.error ? { lessons: null, watch: null, marks: null, touched: false, count: 0 } : await learn({ summary, plan, picks, txn, file, action, review, base, confirmed: false });
    const items = {};
    picks.forEach((p, i) => { if (p !== originalOf(summary.receipt.items[i])) items[String(i)] = p; });
    const amounts = {};
    edits.amounts.forEach((c, i) => { if (c !== Math.round(Number(summary.receipt.items[i].amount) * 100) + Math.round(Number(summary.receipt.items[i].gapCents) || 0)) amounts[String(i)] = c / 100; });
    const folder = review ? config.nextcloud.review : config.nextcloud.processed;
    const dest = inFolder(entry.filedAs, folder) ? entry.filedAs : path.join(folder, path.basename(entry.filedAs));
    const was = { plan: summary.plan ?? null, problems: summary.problems ?? [], pageFix: summary.pageFix ?? null, noTransaction: true };
    const newSummary = {
      ...summary,
      transaction: { id: newId, date, account: found.account.name, amount: money(total), payee: found.payee.name, bankDescription: null, pending: false, currentCategory: null, currentSplit: null, createdByWorker: true },
      plan: { action, applied: true, parts: partsOf(plan.allocation), gapLabel: gapLabelOf(summary), ...(plan.taxExplained ? { tax: plan.taxExplained } : {}) },
      problems: review ? [...plan.problems, ...(plan.allocation.some((a) => !a.categoryId) ? ['part of this purchase is still Uncategorized'] : [])] : [],
      pageFix: { at, kind: 'cash', items, amounts, added: edits.added, markedChecked: false, before: was },
    };
    const fixedOnPage = {
      at, kind: 'cash', created: newId, identity: { ...identity, payee: row.t.payee ?? null }, wrote: { notes, ...(children ? { children } : { category: main.categoryId }) },
      before: { result: entry.result, applied: null, filedAs: entry.filedAs, at: entry.at ?? null },
      summaryBefore: was, lessons: learned.lessons, watch: learned.watch, marks: learned.marks, learned: learned.touched, seenBefore: null,
    };
    const result = `${action}${review ? '+review' : ''}`;
    await patchEntry(id, (e) => { const { creating: _done, ...rest } = e; return { ...rest, result, at, applied: { txnId: newId, action, at, created: true }, fixedOnPage, filing: { kind: 'page', from: entry.filedAs, dest, summary: newSummary } }; });
    let fileNote = '';
    try {
      const where = await filePageSummary(id, entry, dest, newSummary, nc);
      if (where !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: where }));
    } catch (err) {
      if (err.movedTo && err.movedTo !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: err.movedTo }));
      await patchEntry(id, (e) => ({ ...e, fixedOnPage: { ...e.fixedOnPage, summaryFailed: true } }));
      fileNote = ` The transaction was created, but the file or its summary could not be ${err.movedTo ? 'rewritten' : 'moved'} in Nextcloud (${err.message}).`;
      log(`receipt page: ${file}: ${err.message}`);
    }
    await memory.recordSeen({ [newId]: { at, changed: null, items: [], whole: null, review, reviewed: false } }).catch((err) => log(`receipt page: could not record what Actual has: ${err.message}`));
    if (String(id).length <= MAX_UNDO_ID) offerUndo(out, UNDO_ROUTE, { id, at });
    const parts = plan.allocation.map((a) => `${shortName(a.label)} ${money(a.cents)}`).join(', ');
    const learnNote = config.learning.mode === 'off' ? '' : learned.error ? ` (Learning could not be updated: ${learned.error}.)` : learned.count ? ` Learned from ${learned.count} changed item${learned.count === 1 ? '' : 's'}.` : '';
    return `Created ${file} in ${found.account.name}: ${wantSplit ? `split into ${parts}` : `put in ${main.label}${plan.allocation.length > 1 ? ` (splits are off here; the breakdown is in the note: ${parts})` : ''}`}.${review ? ' It is tagged #review because part of it is doubtful.' : ''}${ruleNote}${learnNote}${fileNote}`;
  } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(`The transaction was created in Actual, but recording that failed (${err.message}). Check the account in Actual.`);
  }
}

/** Complete a previously requested creation only when its UUID is already present. Never adds money automatically. */
export async function recoverCashCreations(state, { actual, nextcloud } = {}) {
  for (const [id, entry] of Object.entries(state).filter(([, e]) => e.creating?.context && !e.filing).slice(0, 10)) {
    if (config.dryRun) break;
    const pending = entry.creating;
    try {
      await actual.syncNow();
      const row = await actual.findCreation(pending.id);
      if (!row) {
        await patchEntry(id, (e) => ({ ...e, creating: { ...e.creating, absent: true }, error: 'The earlier purchase was not found. Preview and use Retry creation to try it again safely.' }));
        continue;
      }
      const { summary, edits, plan, accountName } = pending.context;
      const found = await look(actual, { entry, summary, accountName });
      if (!found.account) throw new PanelError('The cash account is unavailable.');
      await createNew({ actual, out: {}, id, entry, summary, edits, plan, found, labels: found.labels, deps: { actual, nextcloud } });
    } catch (err) { await patchEntry(id, (e) => ({ ...e, error: `Cash recovery: ${err.message}` })); }
  }
}
