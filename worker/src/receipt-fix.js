// Fixing a receipt's item categories from its page (View). Two kinds of receipt can be fixed:
//   applied  the worker already changed the charge in Actual (split / categorize / confirm / note, also "+review"): Save writes the
//            charge again with your categories (an existing split is replaced) and keeps or removes the #review tag.
//   review   nothing was applied but a charge was matched: Apply writes it, and the file moves from Needs review to Processed.
// Two steps: the page shows a preview of the parts (amounts and tax recalculated from the saved reading, no Actual needed), and the
// commit starts again from the server's own records: it re-reads the charge, refuses when it is not what the worker (or an earlier
// change from this page) wrote, and recomputes the parts, which must be the ones previewed (a token covers the receipt's state,
// the choices and the parts). Commits and Undo run under the session lock (session-lock.js) and open Actual themselves, so they
// never interleave with a poll cycle. Every category you change also becomes a lesson (learning.js pageFixes), the same shape the
// sweep makes from a correction in Actual. This file loads Actual, Nextcloud and the learning code only when a commit runs.
// In order: 1-2 what can be fixed and the preview (pure, for the page), 3-4 the note and the checks against the charge,
// 5-7 the commit (POST /receipt-fix), 8 the undo.
import crypto from 'node:crypto';
import path from 'node:path/posix';
import { config, inMatchAccounts, log } from './config.js';
import { allocate, ITEMS_NOTE_MAX, mergeParts, money, partKey, partNote, shortName, SPLIT_NOTE_MAX, UNCATEGORIZED } from './reconcile.js';
import { knownCategories } from './known-categories.js';
import { receiptLabels } from './category-notes.js';
import { exclusionRules } from './web-settings.js';
import { loadState, parseStateKey, patchEntry } from './state.js';
import { inFolder } from './folders.js';
import { BusyError, exclusive } from './session-lock.js';
import { checkUndo, offerUndo, PanelError } from './panel-actions.js';
import * as memory from './memory.js';
import { resolveDryRun } from './settings.js';

const UNDO_ROUTE = 'undo-receipt-fix';
const WRITTEN_ACTIONS = new Set(['split', 'categorize', 'confirm', 'note']);
const LOCK_WAIT_MS = 20000;
const HIDDEN_CATEGORY = 'a hidden or income category'; // what receipt.js buildSummary says for a category it can't name
const NOT_READ = 'not read from the receipt';
const MAX_LABEL = 300;
const STALE = 'This receipt, or the amounts, changed since the preview. Press Preview again. Nothing was changed.';
const MAX_UNDO_ID = 900; // an Undo link carries short fields (panel-actions MAX_UNDO_TEXT)

const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const no = (reason) => ({ ok: false, reason });
const chargeCents = (t) => Math.round(Number(t?.amount) * 100);
const fileOf = (id, summary) => String(summary?.file || parseStateKey(id).file.split('/').pop());
const validItem = (it) => it && typeof it === 'object' && typeof it.description === 'string' && Number.isFinite(Number(it.amount));
const originalOf = (it) => (typeof it.category === 'string' && it.category ? it.category : UNCATEGORIZED);

// ---- 1. Can it be fixed, and the choices ------------------------------------------------------------------------------

/**
 * Can the items of this receipt be fixed here? { ok: true, kind: 'applied' | 'review', dry } or { ok: false, reason }. In dry run
 * only the preview is offered (dry: true): nothing is written, whatever the kind.
 */
export function classify(id, entry, summary) {
  const dry = parseStateKey(id).dry;
  if (!entry?.done) return no('The receipt is not finished yet, so there is nothing to fix.');
  if (!summary || typeof summary !== 'object') return no('The saved summary could not be read, so the items and their categories are not known here.');
  if (summary.alreadyApplied) return no('Actual already had this receipt\'s #receipt note when it was checked, so the receipt was never read; there are no items to fix. Change the categories in Actual.');
  const items = summary.receipt?.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(validItem)) return no('This receipt\'s summary has no list of items, so the categories can\'t be fixed here (it may come from an older version). Change them in Actual.');
  const t = summary.transaction;
  if (!t || typeof t !== 'object' || !t.id || !(chargeCents(t) > 0) || !t.date) return no('No bank charge was matched to this receipt, so there is nothing to write the categories to. Fix what keeps it from matching, then press Try again.');
  if (dry) return { ok: true, kind: summary.plan?.applied ? 'applied' : 'review', dry: true };
  if (entry.applied) {
    if (entry.applied.txnId !== t.id || !WRITTEN_ACTIONS.has(entry.applied.action)) return no('What the worker did to Actual for this receipt is not recorded in a way that can be changed here. Change the categories in Actual.');
    if (summary.plan?.applied !== true || !Array.isArray(summary.plan.parts) || summary.plan.parts.length === 0) return no('The saved summary does not say how the charge was divided, so it can\'t be fixed here. Change the categories in Actual.');
    if (!entry.filedAs) return no('This entry does not record where its file is (it is from an older version), so it can\'t be fixed here. Change the categories in Actual.');
    return { ok: true, kind: 'applied', dry: false };
  }
  if (entry.result === 'review' && summary.plan?.applied !== true) {
    if (!entry.filedAs) return no('This entry does not record where its file is (it is from an older version), so it can\'t be applied from here.');
    return { ok: true, kind: 'review', dry: false };
  }
  return no('This receipt is not in a state that can be fixed here.');
}

/** The category each item has now: your earlier change from this page, else what the worker gave it. */
const currentPicks = (summary) => summary.receipt.items.map((it, i) => summary.pageFix?.items?.[String(i)] ?? originalOf(it));
/** What the worker gave each item (before any change from the page). */
export const workerPicks = (summary) => summary.receipt.items.map(originalOf);

/** The choices in a query or form (c0, c1, ...): { picks } or { error }. Missing ones stay as they are. */
function picksFrom(params, summary) {
  const picks = currentPicks(summary);
  for (const [name, value] of params.entries()) {
    const m = /^c(\d+)$/.exec(name);
    if (!m) continue;
    const i = Number(m[1]);
    if (!Number.isInteger(i) || i >= picks.length || m[1] !== String(i)) return { error: 'One of the choices is for an item this receipt does not have.' };
    if (value.length > MAX_LABEL) return { error: 'One of the categories is not valid.' };
    picks[i] = value;
  }
  return { picks };
}

/** The categories to choose from, with the excluded ones marked: [{ group, label, excluded }]. */
function optionsFor() {
  const rows = knownCategories();
  const shown = new Set(receiptLabels(rows.map((c) => c.label), exclusionRules()));
  return rows.map((c) => ({ group: c.group, label: c.label, excluded: !shown.has(c.label) }));
}

// ---- 2. Preview: the new parts, and what the page shows ---------------------------------------------------------------

/** The store-default etc. flags an item carries from the worker's own choice; a category you pick replaces all of them. */
const CHOICE_FIELDS = ['fellBack', 'fellBackFrom', 'originalConfidence', 'invalidAnswer', 'unsureGuess', 'confidence', 'margin', 'keyword', 'keywordCategory', 'modelSaid', 'receiptSaid', 'keywordTie'];

/** The category the unread money went to: saved with the plan; older summaries are worked out from the part whose note says "not read". */
function gapLabelOf(summary) {
  if (typeof summary.plan?.gapLabel === 'string') return summary.plan.gapLabel;
  const part = (Array.isArray(summary.plan?.parts) ? summary.plan.parts : []).find((p) => Array.isArray(p?.items) && p.items.some((t) => String(t).endsWith(NOT_READ)));
  return part?.category ?? UNCATEGORIZED;
}

/**
 * Divide the charge again with these choices (one per item, a label or Uncategorized): the same allocate + mergeParts the worker used.
 * Returns { receipt (a copy, items carrying the choices), allocation, problems, taxExplained } or { error }.
 */
export function replan({ summary, picks, labelToId, targetCents }) {
  const receipt = structuredClone(summary.receipt);
  receipt.items.forEach((it, i) => {
    if (picks[i] === originalOf(it)) return;
    for (const f of CHOICE_FIELDS) delete it[f];
    Object.assign(it, { category: picks[i], source: 'household' });
  });
  const res = allocate(receipt, labelToId, targetCents, { gapLabel: gapLabelOf(summary) });
  if (!res.allocation) return { error: `The charge can't be divided: ${res.problems.join('; ')}.` };
  const allocation = mergeParts(res.allocation, labelToId.get(summary.transaction.currentCategory) ?? null);
  return { receipt, allocation, problems: res.problems, taxExplained: res.taxExplained ?? null };
}

/**
 * What gets written for these parts, as chooseAction (receipt.js) decides: a split; one category; or, with splits off or
 * unsupported and several parts, the charge's own category kept (`current`) with the breakdown in the note only.
 * `current` is the charge's category now, when it has one (not for a split).
 */
function writeKind(allocation, canSplit, current = null) {
  const main = allocation.find((a) => a.categoryId) ?? null;
  const several = allocation.length > 1;
  return { main, split: several && canSplit, note: several && !canSplit && Boolean(current) };
}

const partsOf = (allocation) => allocation.map((a) => ({ category: a.label, amount: money(a.cents), items: a.items }));
const partsHash = (allocation) => sha(allocation.map((a) => [a.label, a.cents]));
const fingerprint = (id, entry, summary) => sha([id, entry.result ?? '', entry.at ?? '', entry.filedAs ?? '', entry.applied ?? null, entry.fixedOnPage?.at ?? '', summary.pageFix?.at ?? '', summary.transaction?.id ?? '']);
const tokenFor = (id, entry, summary, picks, allocation) => sha([fingerprint(id, entry, summary), picks, partsHash(allocation)]);

/**
 * What the receipt page shows for this receipt: { ok: false, reason } or the editor { ok, kind, dry, items, options, picks, changed,
 * preview }. `query` is the page's query string (c0, c1, ... and `preview=1` once Preview was pressed). No Actual, no Nextcloud.
 */
export function editorFor({ id, entry, summary, query }) {
  const state = classify(id, entry, summary);
  if (!state.ok) return state;
  const options = optionsFor();
  if (options.length === 0) return no('The list of Actual\'s categories is not known yet (the worker has not checked Actual since it started). Press "Check for receipts now" on the Status tab, then reload this page.');
  const now = currentPicks(summary);
  const items = summary.receipt.items.map((it, i) => ({ i, description: it.description, plain: it.plain ?? '', amount: it.amount, current: now[i], worker: originalOf(it) }));
  const out = { ok: true, kind: state.kind, dry: state.dry, items, options, picks: now, changed: [], preview: null, applyLabel: state.kind === 'review' ? 'Apply to Actual' : 'Save to Actual' };
  if (!query || query.get('preview') !== '1') return out;
  const got = picksFrom(query, summary);
  if (got.error) return { ...out, preview: { error: got.error } };
  out.picks = got.picks;
  const known = new Set(options.map((o) => o.label));
  const bad = got.picks.findIndex((p, i) => p !== UNCATEGORIZED && !known.has(p) && p !== now[i]);
  if (bad >= 0) return { ...out, preview: { error: `"${got.picks[bad]}" is not one of Actual's categories.` } };
  out.changed = got.picks.flatMap((p, i) => (p === now[i] ? [] : [i]));
  const labelToId = new Map(options.map((o) => [o.label, o.label]));
  const plan = replan({ summary, picks: got.picks, labelToId, targetCents: chargeCents(summary.transaction) });
  if (plan.error) return { ...out, preview: { error: plan.error } };
  const review = state.kind === 'applied' && String(entry.result ?? '').endsWith('+review');
  const current = categoryNow(state.kind, entry, summary);
  const { main, split, note } = writeKind(plan.allocation, config.splits, current);
  out.preview = {
    parts: partsOf(plan.allocation),
    tax: plan.taxExplained,
    problems: plan.problems,
    placed: Boolean(main),
    split,
    note,
    current,
    cautions: state.kind === 'review' ? cautionsFor(summary, options) : [],
    main: main?.label ?? null,
    kind: state.kind,
    wasSplit: Array.isArray(summary.plan?.parts) && summary.plan.parts.length > 1 && state.kind === 'applied',
    review,
    willMove: state.kind === 'review' || (review && inFolder(entry.filedAs, config.nextcloud.review)) ? config.nextcloud.processed : null,
    token: tokenFor(id, entry, summary, got.picks, plan.allocation),
    state: fingerprint(id, entry, summary),
  };
  return out;
}

/** The label of the category the charge has now, as far as the records say (null: none, or it is split). Only for wording the preview. */
function categoryNow(kind, entry, summary) {
  if (kind === 'review' || entry.applied?.action === 'note') return summary.transaction.currentCategory ?? null;
  if (entry.fixedOnPage ? entry.fixedOnPage.wrote.children : entry.applied.action === 'split') return null;
  return summary.plan.parts.find((p) => p.category !== UNCATEGORIZED)?.category ?? null;
}

/** Reasons the charge may refuse an Apply that can be seen from the summary (the save checks the charge itself). */
function cautionsFor(summary, options) {
  const out = [];
  const cur = summary.transaction.currentCategory;
  if (cur === HIDDEN_CATEGORY || options.find((o) => o.label === cur)?.excluded) out.push(`The charge was filed under ${cur === HIDDEN_CATEGORY ? 'a hidden or income category' : `"${cur}"`}, which receipts don't change, so Apply will refuse.`);
  if (summary.transaction.pending === true) out.push('The charge was still pending (not cleared by the bank) when it was matched; Apply refuses while it is.');
  return out;
}

// ---- 3. The #receipt note on the charge -------------------------------------------------------------------------------

/** The text of the #receipt note segment for these parts, as the worker writes it (receipt.js applyPlan). */
function segmentFor({ tag, review, allocation, split }) {
  const head = `${tag}${review ? ' #review' : ''}`;
  if (split) return head;
  if (allocation.length === 1) return `${head} — items: ${partNote(allocation[0], '; ', ITEMS_NOTE_MAX)}`;
  return `${head}: ${allocation.map((a) => `${shortName(a.label)} ${money(a.cents)}`).join(', ')}`;
}

/** Where the worker's own segment of a charge's notes sits (from its #receipt tag to the next " | "): [start, end) or null. */
function segmentRange(actual, text, tag) {
  const at = actual.tagAt(text, tag);
  if (at < 0) return null;
  const end = text.indexOf(' | ', at + tag.length);
  return [at, end < 0 ? text.length : end];
}

/** The notes with the worker's segment replaced, or the segment added at the end. */
function withSegment(actual, notes, tag, segment) {
  const text = notes ?? '';
  const range = segmentRange(actual, text, tag);
  if (!range) return [text, segment].filter(Boolean).join(' | ');
  return text.slice(0, range[0]) + segment + text.slice(range[1]);
}

/** The worker's own segment of a charge's notes, or ''. */
function ownSegment(actual, notes, tag) {
  const text = notes ?? '';
  const range = segmentRange(actual, text, tag);
  return range ? text.slice(range[0], range[1]) : '';
}
const hasReviewTag = (segment) => / #review(?=$|[\s:|])/.test(segment);

// ---- 4. Checks against the charge as it is in Actual right now --------------------------------------------------------

const sameParts = (children, parts, ids) => {
  const want = parts.map((p) => JSON.stringify([-Math.round(Number(p.amount) * 100), ids.get(p.category) ?? null])).sort();
  const have = children.map((c) => JSON.stringify([c.amount, c.category ?? null])).sort();
  return want.length === have.length && want.every((x, k) => x === have[k]) && parts.every((p) => p.category === UNCATEGORIZED || ids.has(p.category));
};

/** Why an applied receipt's charge can't be rewritten (it is not what was written), or null. */
function appliedProblem({ actual, row, entry, summary, tag, labels }) {
  const t = row?.t;
  if (!t) return 'it is no longer in Actual';
  if (-t.amount !== chargeCents(summary.transaction)) return 'its amount changed';
  if (!actual.hasTag(t.notes ?? '', tag)) return 'the #receipt note was removed';
  if (!inMatchAccounts(row.account.name)) return 'its account is not one of MATCH_ACCOUNTS';
  const wrote = entry.fixedOnPage?.wrote;
  if (wrote) return actual.isWritten(t, { ...wrote, notes: wrote.notes }) ? null : 'it was changed in Actual after it was last saved from this page';
  const parts = summary.plan.parts;
  const action = entry.applied.action;
  // The categories the worker wrote (or kept) must still exist under the same names, else they can't be compared with the charge.
  const named = action === 'note' ? [summary.transaction.currentCategory] : parts.map((p) => p.category);
  const lost = named.find((l) => l && l !== UNCATEGORIZED && !labels.has(l));
  if (lost) return `the category "${lost}" it was filed under is no longer one of Actual's categories (renamed or hidden), so it can't be compared`;
  if (action === 'split') return t.is_parent && sameParts(t.subtransactions ?? [], parts, labels) ? null : 'its split was changed in Actual';
  if (t.is_parent) return 'it was split in Actual';
  const expected = action === 'note' ? labels.get(summary.transaction.currentCategory) : labels.get(parts.find((p) => p.category !== UNCATEGORIZED)?.category);
  return (t.category ?? null) === (expected ?? null) ? null : 'its category was changed in Actual';
}

/** Why a receipt in Needs review can no longer be applied to its charge, or null. */
function reviewProblem({ row, summary, labels }) {
  const allowed = new Set(receiptLabels([...labels.keys()], exclusionRules()));
  const t = row?.t;
  if (!t) return 'the charge is no longer in Actual';
  if (-t.amount !== chargeCents(summary.transaction)) return 'the charge\'s amount changed';
  if (t.is_parent || t.is_child) return 'the charge is split now';
  if (t.transfer_id || row.payeeIsTransfer) return 'the charge is a transfer between your accounts';
  if ((t.notes ?? '').includes('#receipt')) return 'the charge already has a #receipt note';
  if (!inMatchAccounts(row.account.name)) return 'the charge\'s account is not one of MATCH_ACCOUNTS';
  if (t.cleared === false) return 'the charge is still pending (not cleared by the bank yet)';
  if (t.category && ![...labels.values()].includes(t.category)) return 'the charge is filed under a hidden or income category, which receipts don\'t change';
  const filedUnder = [...labels].find(([, id]) => id === t.category)?.[0];
  if (filedUnder && !allowed.has(filedUnder)) return `the charge is filed under "${filedUnder}", which receipts don't change`;
  if ((t.category ?? null) !== (labels.get(summary.transaction.currentCategory) ?? null)) return 'its category changed since the receipt was matched';
  return null;
}

// ---- 5. Shared by commit and undo -------------------------------------------------------------------------------------

/** Any error of a commit or undo as a PanelError with a message for the page (`what` leads an unexpected one). */
const asPanelError = (err, what) => {
  if (err instanceof PanelError) return err;
  if (err instanceof BusyError) return new PanelError('The worker is in the middle of a check right now. Wait a minute and press the button again; nothing was changed.');
  if (err?.name === 'WriteMismatch') return new PanelError(`${err.message}.`);
  return new PanelError(`${what}: ${err.message}`);
};

/** The state entry for an id and its saved summary (null when the entry has no filed copy), or a PanelError saying nothing was changed. */
async function loadEntry(id, deps) {
  let state;
  try {
    state = await loadState();
  } catch (err) {
    throw new PanelError(`Can't read the list of receipts (${err.message}). Nothing was changed.`);
  }
  if (typeof id !== 'string' || !id || id.length > 2000 || !Object.hasOwn(state, id)) throw new PanelError('That receipt isn\'t in the list any more. Nothing was changed.');
  const entry = state[id];
  let summary = null;
  if (entry.filedAs) {
    try {
      summary = await (deps.nextcloud ?? (await import('./nextcloud.js'))).readSummary(entry.filedAs);
    } catch (err) {
      throw new PanelError(`Can't read the saved summary (${err.message}). Nothing was changed.`);
    }
  }
  return { entry, summary };
}

/** Open Actual for a commit or undo; a failure says nothing was changed. */
const openActual = async (actual) => {
  try {
    await actual.open();
  } catch (err) {
    throw new PanelError(`Couldn't reach Actual (${err.message}). Nothing was changed.`);
  }
};

/** Nothing is written in a dry run, including one that is about to start (the switch was pressed, the next check not run yet). */
function refuseInDryRun(id = '') {
  if (config.dryRun || parseStateKey(id).dry || resolveDryRun().dryRun) throw new PanelError('Dry run: nothing is written. This is a preview only; go live to save changes.');
}

/** Write `want` to the charge (Actual.rewrite); a failed write says the charge may be partly changed, a WriteMismatch passes through as it is. */
async function rewriteCharge(actual, txn, want) {
  try {
    await actual.rewrite(txn, want);
  } catch (err) {
    if (err.name === 'WriteMismatch') throw err;
    throw new PanelError(`Writing to Actual failed (${err.message}); the charge may be partly changed: check it in Actual.`);
  }
}

// ---- 6. Learning from the change --------------------------------------------------------------------------------------

/** The categories you changed on the page, as lessons, plus the watch for the new write. Returns what Undo needs. Never throws. */
async function learn({ summary, plan, picks, txn, file, action, review, base, confirmed }) {
  const out = { lessons: null, watch: null, marks: null, touched: false, count: 0 };
  if (config.learning.mode === 'off') return out;
  try {
    const learning = await import('./learning.js');
    const mine = { id: txn.id, date: txn.date, amount: txn.amount };
    const item = { basename: file };
    const old = learning.buildSnapshot({ txn: mine, item, receipt: base.receipt, allocation: base.allocation, action: 'split', review: false });
    const filed = new Map();
    old.parts.forEach((p, g) => base.allocation[g].refs.filter(Boolean).forEach((ref, k) => filed.set(`${g}:${k}`, picks[base.receipt.items.indexOf(ref)])));
    const fixes = learning.pageFixes(old, filed);
    const names = old.parts.flatMap((p) => p.items.map((i) => i.d));
    out.lessons = await memory.recordPageLessons({ txnId: txn.id, items: names, add: learning.pageLessonsOf(old, fixes, new Date().toISOString().slice(0, 10)) });
    out.count = out.lessons.added.length;
    out.watch = (await memory.loadWatch()).find((e) => e.txnId === txn.id) ?? null;
    const snap = learning.buildSnapshot({ txn: mine, item, receipt: plan.receipt, allocation: plan.allocation, action, review });
    // An item you moved keeps what the worker said about it, so a later correction in Actual is not charged to the worker for your pick.
    snap?.parts.forEach((p, g) => plan.allocation[g].refs.filter(Boolean).forEach((ref, k) => {
      const at = plan.receipt.items.indexOf(ref);
      const said = originalOf(summary.receipt.items[at]);
      if (picks[at] !== said) Object.assign(p.items[k], { cat: said, merged: true });
    }));
    if (snap) await learning.watch(snap);
    else await memory.patchWatch({ drop: [txn.id] });
    out.touched = true;
    // What you changed outlives the watch (provenance, actual.js): the parts you moved are yours.
    const moved = new Set(fixes.map((f) => f.item.d));
    const keys = plan.allocation.filter((a) => (a.refs ?? []).some((r) => r && moved.has(r.description))).map((a) => partKey(partNote(a, action === 'split' ? ', ' : '; ', action === 'split' ? SPLIT_NOTE_MAX : ITEMS_NOTE_MAX)));
    const marks = await memory.loadMarks();
    out.marks = { confirmed: marks.confirmed.includes(txn.id), corrected: marks.corrected[txn.id] ?? null };
    // Marking a flagged receipt as checked is a confirmation (the sweep records the same when you remove #review); your changes win over it.
    await memory.recordMarks({ confirmed: confirmed && !keys.length ? [txn.id] : [], corrected: keys.length ? { [txn.id]: keys } : {}, clear: confirmed && !keys.length ? [txn.id] : [] });
  } catch (err) {
    log(`  receipt page: could not update what was learned: ${err.message}`);
    out.error = err.message;
  }
  return out;
}

// ---- 7. Commit --------------------------------------------------------------------------------------------------------

/**
 * POST /receipt-fix: write the choices to Actual. form: id, c0..cN, token, mark ("yes": remove #review). Returns the notice.
 * deps (tests): nextcloud stand-in, actual (the module), lockWaitMs.
 */
export async function commitFix(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  refuseInDryRun(id);
  try {
    return await exclusive(() => commitNow(form, out, id, deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t save the change. Nothing was changed in Actual');
  }
}

/** The commit under the session lock: re-read the records, check the preview still holds, open Actual and write. */
async function commitNow(form, out, id, deps) {
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  const got = picksFrom(form, summary);
  if (got.error) throw new PanelError(got.error);
  const { picks } = got;
  if (!form.get('token') || !form.get('state')) throw new PanelError('Press Preview first, then save. Nothing was changed.');
  // The receipt's own records changed since the preview (a double click, another tab, a poll): stop before Actual is even opened.
  if (form.get('state') !== fingerprint(id, entry, summary)) throw new PanelError(STALE);
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    return await writeToActual({ actual, form, out, id, entry, summary, picks, kind: state.kind, deps });
  } finally {
    await actual.close();
  }
}

/** Re-read the charge, check it, replan and write it; then record the change (state, file, lessons) and build the notice. */
async function writeToActual({ actual, form, out, id, entry, summary, picks, kind, deps }) {
  const labels = await actual.categoryLabels();
  const bad = picks.findIndex((p, i) => p !== UNCATEGORIZED && !labels.has(p));
  if (bad >= 0) throw new PanelError(`"${picks[bad]}" is not one of Actual's categories (a category may have been hidden or removed). Nothing was changed.`);
  await actual.syncNow();
  const file = fileOf(id, summary);
  const tag = `#receipt ${file}`;
  const row = await actual.findById(summary.transaction.id, summary.transaction.date);
  const why = kind === 'applied' ? appliedProblem({ actual, row, entry, summary, tag, labels }) : reviewProblem({ row, summary, labels });
  if (why) throw new PanelError(`Nothing was changed: ${why}. ${kind === 'applied' ? 'Change the categories in Actual instead.' : 'Check the charge in Actual.'}`);
  const txn = row.t;
  const plan = replan({ summary, picks, labelToId: labels, targetCents: -txn.amount });
  if (plan.error) throw new PanelError(`${plan.error} Nothing was changed.`);
  if (!plan.allocation.some((a) => a.categoryId)) throw new PanelError('Choose a category for at least one item. Nothing was changed.');
  if (form.get('token') !== tokenFor(id, entry, summary, picks, plan.allocation)) throw new PanelError(STALE);

  const hadReview = hasReviewTag(ownSegment(actual, txn.notes, tag)); // the worker's own segment only, never a #review someone else wrote
  const review = kind === 'applied' && hadReview && form.get('mark') !== 'yes';
  const current = txn.is_parent ? null : txn.category ?? null;
  const { main, split: wantSplit, note: keepCategory } = writeKind(plan.allocation, config.splits && actual.splitsSupported, current);
  const action = wantSplit ? 'split' : keepCategory ? 'note' : 'categorize';
  const notes = withSegment(actual, txn.notes, tag, segmentFor({ tag, review, allocation: plan.allocation, split: wantSplit }));
  const want = wantSplit
    ? { notes, children: plan.allocation.map((a) => ({ amount: -a.cents, category: a.categoryId, notes: partNote(a, ', ', SPLIT_NOTE_MAX) })) }
    : { notes, category: keepCategory ? current : main.categoryId };
  const before = { shape: actual.shapeOf(txn), notes: txn.notes ?? '' };

  await rewriteCharge(actual, txn, want);
  log(`receipt page: ${file}: ${kind === 'review' ? 'applied' : 'categories changed'} (${action}) on ${txn.id}`);

  try {
    const at = new Date().toISOString();
    const result = `${action}${review ? '+review' : ''}`;
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    const base = replan({ summary, picks: workerPicks(summary), labelToId: labels, targetCents: -txn.amount });
    const learned = base.error ? { lessons: null, watch: null, marks: null, touched: false, count: 0 } : await learn({ summary, plan, picks, txn, file, action, review, base, confirmed: hadReview && !review });
    const items = {};
    picks.forEach((p, i) => { if (p !== originalOf(summary.receipt.items[i])) items[String(i)] = p; });
    const folder = review ? config.nextcloud.review : config.nextcloud.processed;
    const dest = inFolder(entry.filedAs, folder) ? entry.filedAs : path.join(folder, path.basename(entry.filedAs));
    const newSummary = {
      ...summary,
      plan: { action, applied: true, parts: partsOf(plan.allocation), gapLabel: gapLabelOf(summary), ...(plan.taxExplained ? { tax: plan.taxExplained } : {}) },
      problems: review ? summary.problems ?? [] : [],
      pageFix: { at, kind, items, markedChecked: kind === 'applied' && hadReview && !review, before: { plan: summary.plan ?? null, problems: summary.problems ?? [], pageFix: summary.pageFix ?? null } },
    };
    const fixedOnPage = {
      at, kind,
      wrote: { notes, ...(want.children ? { children: want.children } : { category: want.category }) },
      before: { ...before, result: entry.result, applied: entry.applied ?? null, filedAs: entry.filedAs, at: entry.at ?? null },
      summaryBefore: newSummary.pageFix.before, // what Undo needs to rebuild the summary if the Nextcloud copy was never rewritten
      lessons: learned.lessons, watch: learned.watch, marks: learned.marks, learned: learned.touched,
    };
    // The state first: Actual has changed, so the entry must say so even if the file cannot be moved after it.
    await patchEntry(id, (e) => ({ ...e, result, at, applied: { txnId: txn.id, action, at }, fixedOnPage }));
    let where = entry.filedAs;
    let fileNote = '';
    try {
      where = await nc.refile(entry.filedAs, dest, newSummary);
      if (where !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: where }));
    } catch (err) {
      // The file may have moved even though its summary could not be written (err.movedTo).
      if (err.movedTo && err.movedTo !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: err.movedTo }));
      await patchEntry(id, (e) => ({ ...e, fixedOnPage: { ...e.fixedOnPage, summaryFailed: true } }));
      fileNote = ` Actual was updated, but the file or its summary could not be ${err.movedTo ? 'rewritten' : 'moved'} in Nextcloud (${err.message}); ${err.movedTo ? 'the file was moved, its summary still shows the old plan' : 'it stays where it was'}.`;
      log(`receipt page: ${file}: ${err.message}`);
    }

    const changed = Object.keys(items).length;
    if (String(id).length <= MAX_UNDO_ID) offerUndo(out, UNDO_ROUTE, { id, at });
    const parts = plan.allocation.map((a) => `${shortName(a.label)} ${money(a.cents)}`).join(', ');
    const learnNote = config.learning.mode === 'off' ? '' : learned.error ? ` (Learning could not be updated: ${learned.error}.)` : learned.count ? ` Learned from ${learned.count} changed item${learned.count === 1 ? '' : 's'}.` : '';
    return `${kind === 'review' ? 'Applied' : 'Saved'} ${file}: ${wantSplit ? `split into ${parts}` : keepCategory ? `kept in its category (splits are off here; the breakdown is in the note: ${parts})` : `put in ${main.label}${plan.allocation.length > 1 ? ` (splits are off here; the breakdown is in the note: ${parts})` : ''}`}.${review ? ' It still has #review.' : hadReview ? ' Marked as checked (#review removed).' : ''}${learnNote}${fileNote}`;
  } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(`The charge was changed in Actual, but recording that failed (${err.message}). Check the charge in Actual.`);
  }
}

// ---- 8. Undo ----------------------------------------------------------------------------------------------------------

/** POST /undo-receipt-fix: put the charge, the entry and the file back, if the charge is still exactly what the page wrote. */
export async function undoFix(form, out, deps = {}) {
  checkUndo(UNDO_ROUTE, form);
  const id = form.get('id') ?? '';
  refuseInDryRun(id);
  try {
    return await exclusive(() => undoNow(id, form.get('at') ?? '', deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t finish the undo; if it got as far as Actual the charge may be partly changed, so check it there');
  }
}

/** The undo under the session lock: put the charge back if it is still exactly what the page wrote, then restore the records. */
async function undoNow(id, at, deps) {
  const { entry, summary } = await loadEntry(id, deps);
  const fix = entry.fixedOnPage;
  if (!fix || fix.at !== at) return 'That receipt was changed again since, so this Undo was not applied. Nothing was changed.';
  if (!summary) throw new PanelError('The saved summary is missing, so the change can\'t be undone safely. Nothing was changed.');
  // What the summary was before the change: its own copy, or (when the Nextcloud copy was never rewritten) the one kept in the entry.
  const was = summary.pageFix?.before ?? fix.summaryBefore;
  if (!was) throw new PanelError('Nothing in the records says what the summary was before the change, so it can\'t be undone safely. Nothing was changed.');
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    await actual.syncNow();
    const row = await actual.findById(summary.transaction.id, summary.transaction.date);
    const now = row?.t;
    if (!now || -now.amount !== chargeCents(summary.transaction) || !actual.isWritten(now, fix.wrote)) {
      return 'The charge has been changed in Actual since you saved it here, so nothing was undone. Change it back in Actual if you want to.';
    }
    const b = fix.before;
    const want = b.shape.children ? { notes: b.notes, children: b.shape.children } : { notes: b.notes, category: b.shape.category };
    await rewriteCharge(actual, now, want);
  } finally {
    await actual.close();
  }
  // From here the charge in Actual is back; whatever fails below is said as it is, never as "nothing was changed".
  try {
    return await restoreRecords({ id, entry, summary, fix, was, deps });
  } catch (err) {
    throw new PanelError(`The charge in Actual was put back, but the receipt's own records could not be restored (${err.message}). Its page may still show the change.`);
  }
}

/** After Undo has put the charge back: learning, the summary, the file and the state entry. */
async function restoreRecords({ id, entry, summary, fix, was, deps }) {
  // Learning: the lessons made then go, the ones they replaced come back, the watch and the marks are what they were.
  if (fix.learned) {
    try {
      if (fix.lessons) await memory.revertPageLessons(fix.lessons);
      if (fix.watch) await memory.watch(fix.watch);
      else await memory.patchWatch({ drop: [summary.transaction.id] });
      if (fix.marks) await memory.restoreMarks(summary.transaction.id, fix.marks);
    } catch (err) {
      log(`receipt page: could not undo what was learned: ${err.message}`);
    }
  }
  // The summary as it was, and the file back where it was (never over another file).
  const back = { ...summary, plan: was.plan, problems: was.problems };
  if (was.pageFix) back.pageFix = was.pageFix;
  else delete back.pageFix;
  if (!back.plan) delete back.plan;
  const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
  let where = entry.filedAs;
  let fileNote = '';
  try {
    where = await nc.refile(entry.filedAs, fix.before.filedAs, back);
  } catch (err) {
    where = err.movedTo ?? entry.filedAs;
    fileNote = ` The file or its summary could not be put back in Nextcloud (${err.message}); the file is in ${path.dirname(where)}.`;
  }
  await patchEntry(id, (e) => {
    const { fixedOnPage: _gone, applied: _applied, ...rest } = e;
    return { ...rest, result: fix.before.result, at: fix.before.at ?? e.at, filedAs: where, ...(fix.before.applied ? { applied: fix.before.applied } : {}) };
  });
  return `Undone: the charge in Actual is as it was before.${fileNote}`;
}
