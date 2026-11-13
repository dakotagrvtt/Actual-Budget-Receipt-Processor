import { filePageSummary } from './filing.js';
// Fixing a receipt's item categories and amounts, and adding lines the reader skipped, from its page (View). Two kinds of receipt can be fixed:
//   applied  the worker already changed the charge in Actual (split / categorize / confirm / note, also "+review"): Save writes the
//            charge again with your categories (an existing split is replaced) and keeps or removes the #review tag.
//   review   nothing was applied but a charge was matched: Apply writes it, and the file moves from Needs review to Processed.
// Two steps: the page shows a preview of the parts (amounts and tax recalculated from the saved reading, no Actual needed), and the
// commit starts again from the server's own records: it re-reads the charge, refuses when it is not what the worker (or an earlier
// change from this page) wrote, and recomputes the parts, which must be the ones previewed (a token covers the receipt's state,
// the choices and the parts). Commits and Undo run under the session lock (session-lock.js) and open Actual themselves, so they
// never interleave with a poll cycle. Edited amounts and added lines (summary.pageFix.amounts / .added) flow through the same replan as the
// categories, but are not lessons. Every category you change also becomes a lesson (learning.js pageFixes), the same shape the
// sweep makes from a correction in Actual. This file loads Actual, Nextcloud and the learning code only when a commit runs.
// In order: 1-2 what can be fixed and the preview (pure, for the page), 3-4 the note and the checks against the charge,
// 5-7 the commit (POST /receipt-fix), 8 the undo.
import { selectionSnapshot } from './receipt-selection.js';
import crypto from 'node:crypto';
import path from 'node:path/posix';
import { config, filesPlace, inMatchAccounts, log } from './config.js';
import { allocate, cashPurchase, cents, fixTaxGap, gapSummary, ITEMS_NOTE_MAX, mergeParts, money, partKey, partNote, shortName, SPLIT_NOTE_MAX, UNCATEGORIZED } from './reconcile.js';
import { knownCategories } from './known-categories.js';
import { receiptLabels } from './category-notes.js';
import { exclusionRules } from './web-settings.js';
import { loadState, parseStateKey, patchEntry } from './state.js';
import { currentLook } from './receipt-lists.js';
import { knownAccounts } from './known-accounts.js';
import { isoDay } from './dates.js';
import { inFolder } from './folders.js';
import { BusyError, exclusive } from './session-lock.js';
import { checkUndo, offerUndo, PanelError } from './panel-actions.js';
import * as memory from './memory.js';
import { resolveDryRun } from './settings.js';

export const ARCHIVED = 'Archived. Restore it to change its categories.';
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
 * Has a change that rewrote the item picks or amounts been saved from the page (and not undone)? "Mark as checked" alone
 * (fixedOnPage.markOnly, a pageFix with no items, amounts or added lines) does not count: it leaves the reading as it was.
 */
export function hasRealFix(entry, summary) {
  const f = entry?.fixedOnPage;
  if (f && !f.markOnly) return true;
  const p = summary?.pageFix;
  return Boolean(p && (Object.keys(p.items ?? {}).length || Object.keys(p.amounts ?? {}).length || (p.added ?? []).length));
}
/** When the last real page fix was saved (ms), 0 when there is none. */
export const lastFixAt = (entry, summary) => (hasRealFix(entry, summary) ? Math.max(0, ...[entry?.fixedOnPage?.at, summary?.pageFix?.at].map((t) => Date.parse(t ?? '')).filter(Number.isFinite)) : 0);

/** Was the charge changed in Actual since it was filed (a saved look says so)? Then the editor is locked and the reading must not change under it. */
export const actualChanged = (entry, seen) => Boolean(entry?.changedByHand || entry?.fixedOnPage?.changedByHand || seenView(currentLook(entry, seen))?.differs);

/**
 * Can the items of this receipt be fixed here? { ok: true, kind: 'applied' | 'review', dry } or { ok: false, reason }. In dry run
 * only the preview is offered (dry: true): nothing is written, whatever the kind.
 */
export function classify(id, entry, summary) {
  const dry = parseStateKey(id).dry;
  if (entry?.archived) return no(ARCHIVED);
  if (entry?.filing) return no(`The receipt is finishing its save to ${filesPlace()}. It will retry automatically.`);
  if (entry?.resolutionPending) return no('Finish saving the corrected reading under Correct reading / choose transaction before applying it.');
  if (entry?.manualLink?.keep) return no('This receipt is linked to an existing charge. Its amounts and categories were kept. Edit that charge in Actual.');
  if (!entry?.done) return no('The receipt is not finished yet, so there is nothing to fix.');
  if (!summary || typeof summary !== 'object') return no('The saved summary could not be read, so the items and their categories are not known here.');
  if (summary.alreadyApplied) return no('Actual already had this receipt\'s #receipt note when it was checked, so the receipt was never read; there are no items to fix. Change the categories in Actual.');
  const items = summary.receipt?.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(validItem)) return no('This receipt\'s summary has no list of items, so the categories can\'t be fixed here (it may come from an older version). Change them in Actual.');
  // A cash purchase has no bank charge to fix against: its page can create one (cash.js).
  if (!summary.transaction && (!entry.applied || entry.creating) && summary.receipt && cashPurchase(summary.receipt) && !summary.plan?.applied && String(entry.result ?? '').replace(/^dry-run:/, '') === 'review') {
    if (!dry && !entry.filedAs) return no('This entry does not record where its file is (it is from an older version), so a transaction can\'t be created from here.');
    return { ok: true, kind: 'cash', dry };
  }
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

export const MAX_ADDED = 10; // lines that can be added on the page
const MAX_AMOUNT_CENTS = 100000 * 100;
const MAX_DESCRIPTION = 80;
const MAX_MARK = 12; // as long as llm.js lets a tax code be

/** An amount typed on the page as cents, or null: an optional sign, digits, at most 2 decimals, |x| <= 100000. */
export function parseAmount(text) {
  const t = String(text ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return Number.isFinite(c) && Math.abs(c) <= MAX_AMOUNT_CENTS ? c : null;
}
const amountText = (c) => (c / 100).toFixed(2);
/** The worker's gap share on an item, shown only while its box still holds the amount as read (not once you typed your own). */
const gapHint = (it, shown) => { const gap = Math.round(Number(it.gapCents) || 0); return gap > 0 && shown === amountText(Math.round(Number(it.amount) * 100) + gap) ? gap : 0; };
/** An item's amount as the reader gave it, in cents: what it is now plus the share fixTaxGap took off it (a folded discount stays off). */
const readCents = (it) => cents(it.amount) + Math.round(Number(it.gapCents) || 0);

/** The amount (cents) of each item now: your earlier edit from this page, else as read (before any tax-gap share). */
const currentAmounts = (summary) => summary.receipt.items.map((it, i) => {
  const saved = summary.pageFix?.amounts?.[String(i)];
  const c = typeof saved === 'number' && Number.isFinite(saved) ? Math.round(saved * 100) : null;
  return c !== null && Math.abs(c) <= MAX_AMOUNT_CENTS ? c : readCents(it);
});

/** A typed description without control or invisible format characters, with runs of white space made one space. */
const cleanText = (t) => String(t ?? '').replace(/\p{Cf}+/gu, '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
// "|" separates the parts of a charge's notes and "#" starts Actual's tags (#review, #receipt): neither may be in a line you add.
const RESERVED = /[|#]/;

/** The lines added from this page earlier, as saved in summary.pageFix.added (untrusted file: every field is checked). */
function savedAdded(summary) {
  const list = Array.isArray(summary.pageFix?.added) ? summary.pageFix.added : [];
  return list.slice(0, MAX_ADDED).flatMap((a) => {
    const c = typeof a?.amount === 'number' && Number.isFinite(a.amount) ? Math.round(a.amount * 100) : 0;
    if (typeof a?.description !== 'string' || !cleanText(a.description) || cleanText(a.description).length > MAX_DESCRIPTION || RESERVED.test(a.description) || c === 0 || Math.abs(c) > MAX_AMOUNT_CENTS) return [];
    const taxCode = typeof a.taxCode === 'string' && a.taxCode && a.taxCode.length <= MAX_MARK ? a.taxCode : null;
    return [{ description: cleanText(a.description), amount: c / 100, category: typeof a.category === 'string' && a.category && a.category.length <= MAX_LABEL ? a.category : UNCATEGORIZED, taxCode, taxable: a.taxable === true || taxCode !== null }];
  });
}

/**
 * The tax marks seen on this receipt, for the tax menu of an added line: { list: codes in order of appearance, flagged: the
 * receipt marks taxed items but prints no codes, common: the most common mark ('' if none), markOf(item) }. A mark is a code, or '*'
 * (taxed, no code), or '' (none).
 */
function taxMarks(receipt) {
  const code = (it) => (typeof it?.tax_code === 'string' && it.tax_code.trim() ? it.tax_code.trim() : '');
  const counts = new Map();
  for (const it of receipt.items) if (code(it)) counts.set(code(it), (counts.get(code(it)) ?? 0) + 1);
  const flagged = counts.size === 0 && receipt.items.some((it) => it.taxable === true);
  const markOf = (it) => code(it) || (flagged && it?.taxable === true ? '*' : '');
  const common = flagged ? '*' : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return { list: [...counts.keys()], flagged, common, markOf };
}

/**
 * The category Actual has for an item as the worker filed it (the part of summary.plan.parts that lists it), or null when no part does.
 * After a re-read the items of the new reading are looked up by name in the filed parts, so a new pick never stands for what Actual has.
 */
export function filedCategory(summary, it) {
  const d = String(it.description);
  const part = (Array.isArray(summary.plan?.parts) ? summary.plan.parts : []).find((p) => Array.isArray(p?.items) && p.items.some((t) => t === d || String(t).startsWith(`${d} (`)));
  return part ? part.category : null;
}

/** The category each item has now: your earlier change from this page, else what the worker gave it. */
const currentPicks = (summary) => {
  // Selecting a charge starts from the category the user already chose in Actual.
  // Keep OCR categories intact for learning, and let explicit item corrections take precedence.
  const selected = summary.selection && !summary.plan?.applied ? summary.transaction?.currentCategory : null;
  return summary.receipt.items.map((it, i) => summary.pageFix?.items?.[String(i)] ?? (selected || originalOf(it)));
};
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

/**
 * Everything the page can change, from a query or form: the categories (c0...), the amounts (a0..., as cents) and the added lines
 * (nd0 description, na0 amount, nc0 category, nt0 tax mark, up to MAX_ADDED rows; a blank row is skipped). Fields that are missing
 * keep what is saved; a form that has any added-line field replaces the saved added lines. Returns { picks, amounts, added } or { error }.
 */
function editsFrom(params, summary) {
  const got = picksFrom(params, summary);
  if (got.error) return got;
  const items = summary.receipt.items;
  const amounts = currentAmounts(summary);
  for (const [name, value] of params.entries()) {
    const m = /^a(\d+)$/.exec(name);
    if (!m) continue;
    const i = Number(m[1]);
    if (!Number.isInteger(i) || i >= items.length || m[1] !== String(i)) return { error: 'One of the amounts is for an item this receipt does not have.' };
    const c = parseAmount(value);
    if (c === null) return { error: `The amount for "${String(items[i].description).slice(0, 40)}" must be a number such as 4.99 or -1.00 (at most 2 decimals, between -100000 and 100000).` };
    amounts[i] = c;
  }
  const rows = new Map();
  for (const [name, value] of params.entries()) {
    const m = /^n([dact])(\d+)$/.exec(name);
    if (!m) continue;
    const k = Number(m[2]);
    if (!Number.isInteger(k) || k >= MAX_ADDED || m[2] !== String(k)) return { error: `At most ${MAX_ADDED} lines can be added.` };
    rows.set(k, { ...rows.get(k), [m[1]]: value });
  }
  if (rows.size === 0) return { ...got, amounts, added: savedAdded(summary) };
  const marks = taxMarks(summary.receipt);
  const allowed = new Set(['', ...marks.list, ...(marks.flagged ? ['*'] : [])]);
  const added = [];
  for (const k of [...rows.keys()].sort((a, b) => a - b)) {
    const r = rows.get(k);
    const description = cleanText(r.d);
    const text = (r.a ?? '').trim();
    if (!description && !text) continue;
    const label = `Added line ${added.length + 1}`;
    if (!description) return { error: `${label}: add a description.` };
    if (RESERVED.test(description)) return { error: `${label}: the description can't contain | or #.` };
    if (description.length > MAX_DESCRIPTION) return { error: `${label}: the description is longer than ${MAX_DESCRIPTION} characters.` };
    const c = parseAmount(text);
    if (c === null || c === 0) return { error: `${label}: the amount must be a number such as 4.99 or -1.00 (at most 2 decimals, not 0, between -100000 and 100000).` };
    const category = r.c || UNCATEGORIZED;
    if (category.length > MAX_LABEL) return { error: `${label}: the category is not valid.` };
    const mark = r.t ?? '';
    if (!allowed.has(mark)) return { error: `${label}: the tax mark "${mark.slice(0, 20)}" is not one this receipt has.` };
    added.push({ description, amount: c / 100, category, taxCode: mark && mark !== '*' ? mark : null, taxable: mark !== '' });
  }
  return { ...got, amounts, added };
}

/**
 * The editor's fields as typed, for showing the form again (even when something typed is not valid): the text of each amount, and
 * the added rows (blank ones dropped, then one new blank row, whose category and tax mark follow the row above).
 */
function draftFrom(params, summary, picks) {
  const items = summary.receipt.items;
  const amounts = currentAmounts(summary).map(amountText);
  const rows = new Map();
  for (const [name, value] of (params ?? [])) {
    const m = /^a(\d+)$/.exec(name);
    if (m && Number(m[1]) < items.length && m[1] === String(Number(m[1]))) amounts[Number(m[1])] = value.slice(0, 40);
    const n = /^n([dact])(\d+)$/.exec(name);
    if (n && Number(n[2]) < MAX_ADDED && n[2] === String(Number(n[2]))) rows.set(Number(n[2]), { ...rows.get(Number(n[2])), [n[1]]: value.slice(0, 300) });
  }
  const marks = taxMarks(summary.receipt);
  let list;
  if (rows.size) {
    list = [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k)).filter((r) => (r.d ?? '').trim() || (r.a ?? '').trim())
      .map((r) => ({ description: r.d ?? '', amount: r.a ?? '', category: r.c || UNCATEGORIZED, tax: r.t ?? '' }));
  } else {
    list = savedAdded(summary).map((a) => ({ description: a.description, amount: amountText(Math.round(a.amount * 100)), category: a.category, tax: a.taxCode ?? (a.taxable ? '*' : '') }));
  }
  list = list.slice(0, MAX_ADDED);
  if (list.length < MAX_ADDED) {
    const last = items.length - 1;
    const above = list.at(-1) ?? { category: picks[last] ?? UNCATEGORIZED, tax: marks.markOf(items[last]) || marks.common };
    list.push({ description: '', amount: '', category: above.category, tax: above.tax });
  }
  return { amounts, added: list, marks: { list: marks.list, flagged: marks.flagged } };
}

/** Do the items add up to what the receipt prints? { items, expected, what, ok } in cents, or null when nothing printed to compare with. */
function addsUp(receipt) {
  const sum = receipt.items.reduce((n, it) => n + cents(it.amount), 0);
  const has = (v) => v != null && Number.isFinite(Number(v));
  let expected;
  let what;
  if (has(receipt.subtotal)) {
    expected = cents(receipt.subtotal);
    what = 'subtotal';
    // prices that already include the tax: the items add up to the total, and the subtotal is the net amount
    if (Math.abs(sum - expected) > 2 && has(receipt.total) && has(receipt.tax) && cents(receipt.tax) > 0 && Math.abs(sum - cents(receipt.total)) <= 2 && Math.abs(expected + cents(receipt.tax) + cents(receipt.tip ?? 0) - cents(receipt.total)) <= 1) {
      expected = cents(receipt.total);
      what = 'total (the prices include the tax)';
    }
  } else if (has(receipt.total) && has(receipt.tax)) {
    expected = cents(receipt.total) - cents(receipt.tax) - cents(receipt.tip ?? 0);
    what = 'total minus tax';
  } else {
    return null;
  }
  return { items: sum, expected, what, ok: Math.abs(sum - expected) <= 2 };
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

// What the pipeline worked out about an item's amount (a folded discount, a tax-gap correction, a flipped sign): wrong once you set the amount.
const AMOUNT_FIELDS = ['discountCents', 'gapCents', 'flippedSign'];

/**
 * Divide the charge again with these choices (one per item, a label or Uncategorized): the same allocate + mergeParts the worker used.
 * `amounts` (cents per item, optional) replaces the read amounts, and `added` (optional) are extra lines {description, amount, category,
 * taxCode, taxable}. An item whose amount you set loses the pipeline's notes about its amount. An added line carries the tax mark you
 * picked (taxable is always a yes or no, so the tax-by-item spread still applies).
 * Returns { receipt (a copy, items carrying the choices), allocation, problems, taxExplained } or { error }.
 */
export function replan({ summary, picks, amounts = null, added = [], labelToId, targetCents }) {
  const receipt = structuredClone(summary.receipt);
  // Any edit starts again from the amounts as read: the shares the tax-gap fix took off are given back, and the same repair runs on the
  // edited receipt below (it does nothing once your numbers match the subtotal). An untouched receipt is left exactly as the worker had it.
  const touched = added.length > 0 || (amounts && receipt.items.some((it, i) => amounts[i] !== readCents(it)));
  if (touched) {
    delete receipt.taxGap;
    for (const it of receipt.items) {
      if (it.gapCents) it.amount = readCents(it) / 100;
      delete it.gapCents;
    }
  }
  const typed = new Set(); // amounts you set: they stay exactly as typed, the tax-gap repair never lowers them
  receipt.items.forEach((it, i) => {
    if (touched && amounts && amounts[i] !== cents(it.amount)) {
      for (const f of AMOUNT_FIELDS) delete it[f];
      it.amount = amounts[i] / 100;
      typed.add(it);
    }
    if (picks[i] === originalOf(it)) return;
    for (const f of CHOICE_FIELDS) delete it[f];
    Object.assign(it, { category: picks[i], source: 'household' });
  });
  for (const a of added) {
    const line = { description: a.description, plain: '', amount: a.amount, taxable: a.taxable === true, tax_code: a.taxCode ?? null, category: a.category, source: 'household', addedOnPage: true };
    receipt.items.push(line);
    typed.add(line);
  }
  if (touched) fixTaxGap(receipt, { lock: typed });
  const res = allocate(receipt, labelToId, targetCents, { gapLabel: gapLabelOf(summary) });
  if (!res.allocation) return { error: `The charge can't be divided: ${res.problems.join('; ')}.` };
  const allocation = mergeParts(res.allocation, labelToId.get(summary.transaction?.currentCategory) ?? null);
  // Edited numbers can leave a tiny net of mixed signs that blows the parts up (21.00 charge: 21000.00 and -20979.00). Never write that.
  if (touched && allocation.some((a) => Math.abs(a.cents) > Math.abs(targetCents))) return { error: 'One part would be bigger than the whole charge; check the amounts.' };
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

/** Are these parts (category, amount, items) the ones filed in Actual (summary.plan.parts, kept up to date by every save from the page)? */
const sameAsFiled = (filed, parts) => {
  const key = (p) => JSON.stringify([p?.category, p?.amount, [...(Array.isArray(p?.items) ? p.items : [])].map(String).sort()]);
  return Array.isArray(filed) && filed.length === parts.length && JSON.stringify(filed.map(key).sort()) === JSON.stringify(parts.map(key).sort());
};
const partsOf = (allocation) => allocation.map((a) => ({ category: a.label, amount: money(a.cents), items: a.items }));
const partsHash = (allocation) => sha(allocation.map((a) => [a.label, a.cents]));
const fingerprint = (id, entry, summary, seen = null) => sha([id, entry.result ?? '', entry.at ?? '', entry.filedAs ?? '', entry.applied ?? null, entry.fixedOnPage?.at ?? '', summary.pageFix?.at ?? '', summary.reread?.at ?? '', summary.transaction?.id ?? '', seen?.at ?? '']);
export const tokenFor = (id, entry, summary, edits, allocation, seen = null, extra = []) => sha([fingerprint(id, entry, summary, seen), edits.picks, edits.amounts, edits.added, partsHash(allocation), config.splits, ...extra]);
export { fingerprint };

/**
 * What the receipt page shows for this receipt: { ok: false, reason } or the editor { ok, kind, dry, items, options, picks, changed,
 * preview }. `query` is the page's query string (c0, c1, ... and `preview=1` once Preview was pressed). No Actual, no Nextcloud.
 */
export function editorFor({ id, entry, summary, query: asked, seen = null, cashLook = null }) {
  const state = classify(id, entry, summary);
  if (!state.ok) return state;
  // Picks and amounts are numbered by item: a Preview link from before the receipt was read again (or the earlier reading was put back)
  // would put them on the wrong items. The page sends the reading it was made for (`rid`); a different one is ignored.
  const readingId = summary.reread?.at ?? '';
  const rereadStale = asked?.get('preview') === '1' && (asked.get('rid') ?? '') !== readingId;
  const query = rereadStale ? null : asked;
  const options = optionsFor();
  if (options.length === 0) return no('The list of Actual\'s categories is not known yet (the worker has not checked Actual since it started). Press "Check now" on the Status tab, then reload this page.');
  const now = currentPicks(summary);
  const draft = draftFrom(query?.get('preview') === '1' ? query : null, summary, now);
  const items = summary.receipt.items.map((it, i) => ({ i, description: it.description, plain: it.plain ?? '', amount: it.amount, gap: gapHint(it, draft.amounts[i]), flipped: it.flippedSign === true, amountText: draft.amounts[i], current: now[i], worker: originalOf(it), filed: state.kind === 'applied' ? filedCategory(summary, it) : null }));
  const out = { ok: true, kind: state.kind, dry: state.dry, items, options, picks: now, changed: [], edited: false, added: draft.added, marks: draft.marks, maxAdded: MAX_ADDED, preview: null, readingId, rereadStale, applyLabel: state.kind === 'review' ? 'Apply to Actual' : state.kind === 'cash' ? 'Create in Actual' : 'Save changes' };
  if (state.kind === 'cash') out.cash = { account: (query?.get('acct') ?? asked?.get('acct') ?? config.cashAccount).trim(), accounts: knownAccounts().map((a) => a.name), chosen: config.cashAccount };
  // The worker spread a gap over some items (a discount line was probably missed): say so next to the editor, while those items still show it.
  const gap = items.some((it) => it.gap > 0) ? gapSummary(summary.receipt) : null;
  if (gap) out.gapNotice = gap;
  // What Actual had when it was last looked at (the sweep, or "Check Actual now"): changed items are shown, and nothing can be edited here.
  // After a re-read (or Use old reading), the places in a look at Actual count the items of the reading the watch was made from, which may be
  // any earlier one, until a save from the page makes a new watch: match by the item's name stored with the look, never by place.
  const oldPlaces = Boolean(summary.reread?.at) && Date.parse(summary.reread.at) > lastFixAt(entry, summary);
  const nameOf = oldPlaces ? (x) => String(x.d).trim().toLowerCase() : null;
  const looked = seenView(currentLook(entry, seen), nameOf);
  if (looked) {
    out.actual = looked;
    for (const it of out.items) it.inActual = looked.byItem.get(it.i) ?? looked.byItem.get(String(it.description).trim().toLowerCase()) ?? null;
    out.rereadNewer = Boolean(summary.reread?.at) && Date.parse(summary.reread.at) > lastFixAt(entry, summary);
    if ((looked.differs || entry.fixedOnPage?.changedByHand) && state.kind === 'applied' && !state.dry) out.locked = true;
  }
  out.rereadNewer ??= Boolean(summary.reread?.at) && Date.parse(summary.reread.at) > lastFixAt(entry, summary);
  if ((entry.changedByHand || entry.fixedOnPage?.changedByHand) && state.kind === 'applied' && !state.dry) out.locked = true;
  if (!query || query.get('preview') !== '1' || out.locked) return out;
  const got = editsFrom(query, summary);
  if (got.error) return { ...out, preview: { error: got.error } };
  out.picks = got.picks;
  const known = new Set(options.map((o) => o.label));
  const bad = got.picks.findIndex((p, i) => p !== UNCATEGORIZED && !known.has(p) && p !== now[i]);
  if (bad >= 0) return { ...out, preview: { error: `"${got.picks[bad]}" is not one of Actual's categories.` } };
  const keptCategories = new Set(savedAdded(summary).map((a) => a.category));
  const badAdded = got.added.find((a) => a.category !== UNCATEGORIZED && !known.has(a.category) && !keptCategories.has(a.category));
  if (badAdded) return { ...out, preview: { error: `"${badAdded.category}" is not one of Actual's categories.` } };
  out.changed = got.picks.flatMap((p, i) => (p === now[i] ? [] : [i]));
  const wasAmounts = currentAmounts(summary);
  const amountsChanged = got.amounts.flatMap((c, i) => (c === wasAmounts[i] ? [] : [i]));
  const addedChanged = JSON.stringify(got.added) !== JSON.stringify(savedAdded(summary));
  out.edited = amountsChanged.length > 0 || addedChanged;
  const labelToId = new Map(options.map((o) => [o.label, o.label]));
  const targetCents = state.kind === 'cash' ? cents(summary.receipt.total) : chargeCents(summary.transaction);
  const plan = replan({ summary, picks: got.picks, amounts: got.amounts, added: got.added, labelToId, targetCents });
  if (plan.error) return { ...out, preview: { error: plan.error } };
  const review = state.kind === 'applied' && String(entry.result ?? '').endsWith('+review') && !entry.reviewed;
  const cash = state.kind === 'cash' ? cashLook ?? { missing: true } : null; // what Actual said about the account, payee and duplicates (cash.js lookup) // reviewed: #review is already gone in Actual
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
    same: sameAsFiled(summary.plan?.parts, partsOf(plan.allocation)),
    willMove: state.kind === 'review' || state.kind === 'cash' || (review && inFolder(entry.filedAs, config.nextcloud.review)) ? config.nextcloud.processed : null,
    token: tokenFor(id, entry, summary, got, plan.allocation, seen, cash ? cashExtra(out.cash.account, cash) : []),
    cash: cash ? { ...cash, date: cashDate(entry, summary), accountName: out.cash.account, review: willReview(plan) } : null,
    state: fingerprint(id, entry, summary, seen),
    amountsChanged: amountsChanged.length,
    addedCount: got.added.length,
    // The check counts the numbers in the boxes (as read for items you left alone, as typed for the others, plus added lines), never the
    // amounts the pipeline lowered: an untouched receipt the worker had to correct must not look as if it added up.
    check: addsUp({ ...summary.receipt, items: [...got.amounts.map((c) => ({ amount: c / 100 })), ...got.added.map((a) => ({ amount: a.amount }))] }),
    checkText: null,
    pipelineNote: plan.receipt.taxGap ? `The worker lowered the items marked ${plan.receipt.taxGap.codes.join(', ')} by ${amountText(plan.receipt.taxGap.cents)} in all to match the subtotal.` : null,
    fields: { amounts: got.amounts.map(amountText), added: got.added.map((a) => ({ description: a.description, amount: amountText(Math.round(a.amount * 100)), category: a.category, tax: a.taxCode ?? (a.taxable ? '*' : '') })) },
  };
  if (out.preview.check) {
    const c = out.preview.check;
    out.preview.checkText = `Items add up to ${amountText(c.items)}; the receipt's ${c.what} is ${amountText(c.expected)}.`;
  }
  return out;
}

/** The purchase date a created cash transaction gets: the receipt's, else the day it was uploaded. */
export const cashDate = (entry, summary) => summary.receipt.date || isoDay(new Date(entry.lastmod ?? entry.at ?? Date.now()));

/** What the cash token covers besides the receipt and the parts: the account chosen and the transactions found in it (so a new one appearing makes the preview stale). */
export const cashExtra = (account, look) => [account ?? '', look?.account?.id ?? '', (look?.duplicates ?? []).map((d) => d.snapshot ?? d), look?.payee?.name ?? '', look?.payee?.id ?? '', look?.recovery ?? null, look?.error ?? ''];
/** Would the worker tag a created cash purchase #review? When money is left uncategorized or the items don't add up. */
export const willReview = (plan) => plan.allocation.some((a) => !a.categoryId) || plan.problems.length > 0;

/** A saved look at the charge (memory.loadSeen) as the page needs it, or null when the record is not usable. */
export function seenView(rec, nameOf = null) {
  if (!rec || typeof rec !== 'object' || Number.isNaN(Date.parse(rec.at))) return null;
  const items = (Array.isArray(rec.items) ? rec.items : []).filter((x) => typeof x?.d === 'string' && typeof x.now === 'string');
  // By place in the receipt's list; a record from before that (no place) is matched by name.
  const byItem = new Map();
  for (const x of items) {
    const k = nameOf ? nameOf(x) : Number.isInteger(x.i) ? x.i : x.d.trim().toLowerCase();
    if (!nameOf || !byItem.has(k)) byItem.set(k, x.now); // by name, the first of two same-named items wins
  }
  const changed = typeof rec.changed === 'string' && rec.changed ? rec.changed : null;
  const whole = typeof rec.whole === 'string' && rec.whole ? rec.whole : null;
  return { at: rec.at, changed, whole, byItem, reviewed: rec.reviewed === true, review: rec.review === true, differs: Boolean(changed) || Boolean(whole) || items.length > 0 };
}

/** The label of the category the charge has now, as far as the records say (null: none, or it is split). Only for wording the preview. */
function categoryNow(kind, entry, summary) {
  if (kind === 'cash') return null;
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

// The note a part was written with (without the pipeline's annotations, which the summary's items may or may not carry), so a note you
// edited on a child in Actual is noticed: judge (learning.js) treats such a split as restructured too.
const noteKey = (note) => partKey(note ?? '') ?? '';
const sameParts = (children, parts, ids) => {
  const want = parts.map((p) => JSON.stringify([-Math.round(Number(p.amount) * 100), ids.get(p.category) ?? null, noteKey(partNote({ items: Array.isArray(p.items) ? p.items.map(String) : [], refs: [] }, ', ', SPLIT_NOTE_MAX))])).sort();
  const have = children.map((c) => JSON.stringify([c.amount, c.category ?? null, noteKey(c.notes)])).sort();
  return want.length === have.length && want.every((x, k) => x === have[k]) && parts.every((p) => p.category === UNCATEGORIZED || ids.has(p.category));
};

/** Why an applied receipt's charge can't be rewritten (it is not what was written), or null. */
function appliedProblem({ actual, row, entry, summary, tag, labels }) {
  const t = row?.t;
  if (!t) return 'it is no longer in Actual';
  if (-t.amount !== chargeCents(summary.transaction)) return 'its amount changed';
  if (!actual.hasTag(t.notes ?? '', tag)) return 'the #receipt note was removed';
  if (!inMatchAccounts(row.account.name)) return 'its account is not one of MATCH_ACCOUNTS';
  if (entry.changedByHand || entry.fixedOnPage?.changedByHand) return 'it was changed by hand in Actual';
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

/** The numbers (cents, sorted) of a split's parts as a comparable text. */
const amountsKey = (list) => [...list].sort((a, b) => a - b).join(',');

/**
 * The checks that matter for clearing #review alone, when appliedProblem found the charge changed by hand: the same transaction, in an
 * account the worker may use, its amount and the amounts of its parts as written (your numbers are never touched), and the #receipt note still there.
 * Categories and part notes may differ. Returns why not, or null.
 */
function clearProblem({ actual, row, entry, summary, tag }) {
  const t = row?.t;
  if (!t) return 'it is no longer in Actual';
  if (-t.amount !== chargeCents(summary.transaction)) return 'its amount changed';
  if (!actual.hasTag(t.notes ?? '', tag)) return 'the #receipt note was removed';
  if (!inMatchAccounts(row.account.name)) return 'its account is not one of MATCH_ACCOUNTS';
  const wrote = entry.fixedOnPage?.wrote;
  const parts = wrote ? wrote.children?.map((c) => c.amount) : entry.applied?.action === 'split' ? summary.plan?.parts?.map((p) => -Math.round(Number(p.amount) * 100)) : null;
  if (parts) {
    if (!t.is_parent || amountsKey(t.subtransactions?.map((c) => c.amount) ?? []) !== amountsKey(parts)) return 'the amounts of its split parts changed';
  } else if (t.is_parent) {
    return 'it was split in Actual';
  }
  return null;
}

/** Why a receipt in Needs review can no longer be applied to its charge, or null. */
function reviewProblem({ row, summary, labels, cashAccountId }) {
  const allowed = new Set(receiptLabels([...labels.keys()], exclusionRules()));
  const t = row?.t;
  if (!t) return 'the charge is no longer in Actual';
  if (summary.selection?.snapshot && JSON.stringify(selectionSnapshot(t)) !== JSON.stringify(summary.selection.snapshot)) return 'the selected charge changed in Actual; choose it again before applying';
  if (-t.amount !== chargeCents(summary.transaction)) return 'the charge\'s amount changed';
  if (t.is_parent || t.is_child) return 'the charge is split now';
  if (t.transfer_id || row.payeeIsTransfer) return 'the charge is a transfer between your accounts';
  if ((t.notes ?? '').includes('#receipt')) return 'the charge already has a #receipt note';
  if (!inMatchAccounts(row.account.name)) return 'the charge\'s account is not one of MATCH_ACCOUNTS';
  if (t.cleared === false && t.account !== cashAccountId) return 'the charge is still pending (not cleared by the bank yet)';
  if (t.category && ![...labels.values()].includes(t.category)) return 'the charge is filed under a hidden or income category, which receipts don\'t change';
  const filedUnder = [...labels].find(([, id]) => id === t.category)?.[0];
  if (filedUnder && !allowed.has(filedUnder)) return `the charge is filed under "${filedUnder}", which receipts don't change`;
  if ((t.category ?? null) !== (labels.get(summary.transaction.currentCategory) ?? null)) return 'its category changed since the receipt was matched';
  return null;
}

// ---- 5. Shared by commit and undo -------------------------------------------------------------------------------------

/** Any error of a commit or undo as a PanelError with a message for the page (`what` leads an unexpected one). */
export const asPanelError = (err, what) => {
  if (err instanceof PanelError) return err;
  if (err instanceof BusyError) return new PanelError('The worker is in the middle of a check right now. Wait a minute and press the button again; nothing was changed.');
  if (err?.name === 'WriteMismatch') return new PanelError(`${err.message}.`);
  return new PanelError(`${what}: ${err.message}`);
};

/** The state entry for an id and its saved summary (null when the entry has no filed copy), or a PanelError saying nothing was changed. */
export async function loadEntry(id, deps) {
  let state;
  try {
    state = await loadState();
  } catch (err) {
    throw new PanelError(`Can't read the list of receipts (${err.message}). Nothing was changed.`);
  }
  if (typeof id !== 'string' || !id || id.length > 2000 || !Object.hasOwn(state, id)) throw new PanelError('That receipt isn\'t in the list any more. Nothing was changed.');
  let entry = state[id];
  if (entry?.filing) {
    try { await (await import('./filing.js')).finishPageFiling(id, entry, deps.nextcloud ?? await import('./nextcloud.js')); entry = (await loadState())[id]; }
    catch (err) { throw new PanelError(`The receipt is still finishing its save to ${filesPlace()} (${err.message}). It will retry automatically. Nothing was changed in Actual.`); }
  }
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
  if (config.learning.mode === 'off') {
    // Nothing is learned, but a snapshot of what the worker wrote earlier would now describe the wrong thing: drop it (only if there is one).
    try {
      if ((await memory.loadWatch()).some((e) => e.txnId === txn.id)) await memory.patchWatch({ drop: [txn.id] });
    } catch (err) {
      log(`  receipt page: could not drop the old watch: ${err.message}`);
    }
    return out;
  }
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
      if (at >= summary.receipt.items.length) return; // a line added on the page: not the worker's, nothing to keep
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
  refuseInDryRun(id);
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  if (state.kind === 'cash') throw new PanelError('This is a cash purchase with no charge in Actual yet: use Create in Actual on the receipt\'s page. Nothing was changed.');
  const edits = editsFrom(form, summary);
  if (edits.error) throw new PanelError(edits.error);
  if (!form.get('token') || !form.get('state')) throw new PanelError('Press Preview first, then save. Nothing was changed.');
  // The receipt's own records changed since the preview (a double click, another tab, a poll): stop before Actual is even opened.
  const seen = (await memory.seenIndex().catch(() => ({})))[summary.transaction?.id] ?? null;
  if (form.get('state') !== fingerprint(id, entry, summary, seen)) throw new PanelError(STALE);
  // A look at Actual (the sweep, Check Actual now) found the charge changed there since it was filed: edit it in Actual.
  if (state.kind === 'applied' && actualChanged(entry, seen)) throw new PanelError('This charge was changed in Actual since it was filed, so it can\'t be saved over from here. Press Check Actual now on the receipt page, and edit it in Actual. Nothing was changed.');
  const confirm = form.get('intent') === 'confirm';
  if (confirm) {
    // A clean review confirmation acknowledges the filed result. Never run it through the current split settings.
    if (state.kind !== 'applied' || !String(entry.result ?? '').endsWith('+review') || entry.reviewed) throw new PanelError('This receipt no longer needs confirmation. Reload its page. Nothing was changed.');
    if (form.get('mark') !== 'yes') throw new PanelError('Mark as checked must be selected to confirm this receipt. Nothing was changed.');
    const unchanged = JSON.stringify(edits.picks) === JSON.stringify(currentPicks(summary))
      && JSON.stringify(edits.amounts) === JSON.stringify(currentAmounts(summary))
      && JSON.stringify(edits.added) === JSON.stringify(savedAdded(summary));
    if (!unchanged) throw new PanelError('The items changed. Preview them again and use Save changes. Nothing was changed.');
    // Verify the same preview signature as Save without using its newly computed allocation to rewrite the charge.
    const labels = new Map(optionsFor().map((o) => [o.label, o.label]));
    const plan = replan({ summary, ...edits, labelToId: labels, targetCents: chargeCents(summary.transaction) });
    if (plan.error || form.get('token') !== tokenFor(id, entry, summary, edits, plan.allocation, seen)) throw new PanelError(STALE);
  }
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    if (confirm) return await clearTagNow({ actual, id, entry, summary, deps });
    return await writeToActual({ actual, form, out, id, entry, summary, edits, kind: state.kind, seen, deps });
  } finally {
    await actual.close();
  }
}

/**
 * "Looks right: clear #review and archive" (archive-actions.js) first clears the #review tag, and nothing else: the charge keeps its
 * category or split exactly as it is in Actual (no re-plan, so a changed SPLIT_TRANSACTIONS or a note you edited on a part is not touched);
 * only the worker's #receipt note loses " #review". The same checks as Save refuse a charge that is no longer what the worker (or the page)
 * wrote. Then the entry stops saying +review, the summary stops listing problems, the file moves to Processed and the sweep's "confirmed"
 * mark is recorded, as for Mark as checked. The caller holds the session lock. Returns the notice text (it may say the file could not be
 * moved); throws a PanelError when nothing was changed.
 */
export async function markCheckedNow(id, deps = {}) {
  refuseInDryRun(id);
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  if (state.kind !== 'applied') throw new PanelError('Actual was not changed for this receipt, so there is no #review tag to clear.');
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    return await clearTagNow({ actual, id, entry, summary, deps });
  } finally {
    await actual.close();
  }
}

// Every "Looks right" (the page's own, and the archive path) ends here. It offers no Undo: it only cleared #review, and the record says
// so with `markOnly` (undoOpen never treats it as open, and the Undo request refuses it).
async function clearTagNow({ actual, id, entry, summary, deps }) {
  const labels = await actual.categoryLabels();
  await actual.syncNow();
  const file = fileOf(id, summary);
  const tag = `#receipt ${file}`;
  const row = await actual.findById(summary.transaction.id, summary.transaction.date);
  // Clearing #review touches only the parent's notes. A category or a part's note you changed in Actual is yours and stays; only the same
  // transaction, its amounts and the #receipt note matter. (Such a change is left for the learning sweep to learn from: no "confirmed" mark.)
  const changedByHand = appliedProblem({ actual, row, entry, summary, tag, labels }) !== null;
  const why = changedByHand ? clearProblem({ actual, row, entry, summary, tag }) : null;
  if (why) throw new PanelError(`Nothing was changed: ${why}. Change the charge in Actual instead, or archive it as it is in Actual (no change is made there).`);
  const txn = row.t;
  const segment = ownSegment(actual, txn.notes, tag);
  const hadReview = hasReviewTag(segment);
  const shape = actual.shapeOf(txn);
  const notes = hadReview ? withSegment(actual, txn.notes, tag, segment.replace(/ #review(?=$|[\s:|])/, '')) : txn.notes ?? '';
  if (hadReview) {
    try {
      await actual.rewriteNotes(txn, notes);
    } catch (err) {
      if (err.name === 'WriteMismatch') throw err;
      throw new PanelError(`Writing to Actual failed (${err.message}); the charge may be partly changed: check it in Actual.`);
    }
    log(`receipt page: ${file}: #review cleared on ${txn.id} (nothing else changed)`);
  }
  try {
    const at = new Date().toISOString();
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    if (hadReview && !changedByHand && config.learning.mode !== 'off') {
      try {
        await memory.recordMarks({ confirmed: [txn.id], corrected: {}, clear: [txn.id] });
      } catch (err) {
        log(`receipt page: could not record the confirmation: ${err.message}`);
      }
    }
    const result = String(entry.result ?? '').replace(/\+review$/, '');
    const was = { plan: summary.plan ?? null, problems: summary.problems ?? [], pageFix: summary.pageFix ?? null };
    const newSummary = { ...summary, problems: [], pageFix: { at, kind: 'applied', items: summary.pageFix?.items ?? {}, amounts: summary.pageFix?.amounts ?? {}, added: summary.pageFix?.added ?? [], markedChecked: hadReview, before: was } };
    const dest = inFolder(entry.filedAs, config.nextcloud.processed) ? entry.filedAs : path.join(config.nextcloud.processed, path.basename(entry.filedAs));
    const fixedOnPage = { at, kind: 'applied', identity: { date: txn.date, payee: txn.payee ?? null, account: txn.account ?? null, amount: txn.amount, cleared: txn.cleared !== false, reconciled: Boolean(txn.reconciled), transfer_id: txn.transfer_id ?? null }, markOnly: true, changedByHand, wrote: { notes, ...shape }, before: { shape, notes: txn.notes ?? '', result: entry.result, applied: entry.applied ?? null, filedAs: entry.filedAs, at: entry.at ?? null }, summaryBefore: was, lessons: null, watch: null, learned: false };
    await patchEntry(id, (e) => ({ ...e, result, at, changedByHand: e.changedByHand || changedByHand, fixedOnPage, filing: { kind: 'page', from: entry.filedAs, dest, summary: newSummary } }));
    let fileNote = '';
    try {
      const where = await filePageSummary(id, entry, dest, newSummary, nc);
      if (where !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: where }));
    } catch (err) {
      if (err.movedTo && err.movedTo !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: err.movedTo }));
      await patchEntry(id, (e) => ({ ...e, fixedOnPage: { ...e.fixedOnPage, summaryFailed: true } }));
      fileNote = ` The file or its summary could not be ${err.movedTo ? 'rewritten' : 'moved'} in ${filesPlace()} (${err.message}); ${err.movedTo ? 'the file was moved, its summary still shows the old plan' : 'it stays where it was'}.`;
      log(`receipt page: ${file}: ${err.message}`);
    }
    return `Marked ${file} as checked${hadReview ? ' (#review removed)' : ''}.${fileNote}`;
  } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(`The charge was changed in Actual, but recording that failed (${err.message}). Check the charge in Actual.`);
  }
}

/** Re-read the charge, check it, replan and write it; then record the change (state, file, lessons) and build the notice. */
async function writeToActual({ actual, form, out, id, entry, summary, edits, kind, seen, deps, noTransaction = false, cashAccountId = null }) {
  const { picks } = edits;
  const labels = await actual.categoryLabels();
  const named = [...picks, ...edits.added.map((a) => a.category)];
  const lost = named.find((p) => p !== UNCATEGORIZED && !labels.has(p));
  if (lost !== undefined) throw new PanelError(`"${lost}" is not one of Actual's categories (a category may have been hidden or removed). Nothing was changed.`);
  await actual.syncNow();
  const file = fileOf(id, summary);
  const tag = `#receipt ${file}`;
  const row = await actual.findById(summary.transaction.id, summary.transaction.date);
  const why = kind === 'applied' ? appliedProblem({ actual, row, entry, summary, tag, labels }) : reviewProblem({ row, summary, labels, cashAccountId });
  if (why) throw new PanelError(`Nothing was changed: ${why}. ${kind === 'applied' ? 'Change the categories in Actual instead.' : 'Check the charge in Actual.'}`);
  const txn = row.t;
  const plan = replan({ summary, picks, amounts: edits.amounts, added: edits.added, labelToId: labels, targetCents: -txn.amount });
  if (plan.error) throw new PanelError(`${plan.error} Nothing was changed.`);
  if (!plan.allocation.some((a) => a.categoryId)) throw new PanelError('Choose a category for at least one item. Nothing was changed.');
  if (form.get('token') !== tokenFor(id, entry, summary, edits, plan.allocation, seen)) throw new PanelError(STALE);

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
    const amounts = {};
    edits.amounts.forEach((c, i) => { if (c !== readCents(summary.receipt.items[i])) amounts[String(i)] = c / 100; });
    const folder = review ? config.nextcloud.review : config.nextcloud.processed;
    const dest = inFolder(entry.filedAs, folder) ? entry.filedAs : path.join(folder, path.basename(entry.filedAs));
    const newSummary = {
      ...summary,
      plan: { action, applied: true, parts: partsOf(plan.allocation), gapLabel: gapLabelOf(summary), ...(plan.taxExplained ? { tax: plan.taxExplained } : {}) },
      problems: review ? summary.problems ?? [] : [],
      pageFix: { at, kind, items, amounts, added: edits.added, markedChecked: kind === 'applied' && hadReview && !review, before: { plan: summary.plan ?? null, problems: summary.problems ?? [], pageFix: summary.pageFix ?? null, ...(noTransaction ? { noTransaction: true } : {}) } }, // noTransaction: a cash receipt split onto an existing charge; Undo takes the link away again
    };
    const fixedOnPage = {
      at, kind, identity: { date: txn.date, payee: txn.payee ?? null, account: txn.account ?? null, amount: txn.amount, cleared: txn.cleared !== false, reconciled: Boolean(txn.reconciled), transfer_id: txn.transfer_id ?? null },
      wrote: { notes, ...(want.children ? { children: want.children } : { category: want.category }) },
      before: { ...before, result: entry.result, applied: entry.applied ?? null, filedAs: entry.filedAs, at: entry.at ?? null },
      summaryBefore: newSummary.pageFix.before, // what Undo needs to rebuild the summary if the Nextcloud copy was never rewritten
      lessons: learned.lessons, watch: learned.watch, marks: learned.marks, learned: learned.touched,
      seenBefore: seen, // the look at Actual this write replaces, for Undo
    };
    // The state first: Actual has changed, so the entry must say so even if the file cannot be moved after it.
    await patchEntry(id, (e) => ({ ...e, result, at, applied: { txnId: txn.id, action, at }, fixedOnPage, filing: { kind: 'page', from: entry.filedAs, dest, summary: newSummary } }));
    let where = entry.filedAs;
    let fileNote = '';
    try {
      where = await filePageSummary(id, entry, dest, newSummary, nc);
      if (where !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: where }));
    } catch (err) {
      // The file may have moved even though its summary could not be written (err.movedTo).
      if (err.movedTo && err.movedTo !== entry.filedAs) await patchEntry(id, (e) => ({ ...e, filedAs: err.movedTo }));
      await patchEntry(id, (e) => ({ ...e, fixedOnPage: { ...e.fixedOnPage, summaryFailed: true } }));
      fileNote = ` Actual was updated, but the file or its summary could not be ${err.movedTo ? 'rewritten' : 'moved'} in ${filesPlace()} (${err.message}); ${err.movedTo ? 'the file was moved, its summary still shows the old plan' : 'it stays where it was'}.`;
      log(`receipt page: ${file}: ${err.message}`);
    }

    // The charge is what this page just wrote: an older look at Actual (changed items, a locked editor) no longer applies.
    await memory.recordSeen({ [txn.id]: { at, changed: null, items: [], whole: null, review, reviewed: false } }).catch((err) => log(`receipt page: could not update what Actual has: ${err.message}`));
    const changed = Object.keys(items).length;
    if (String(id).length <= MAX_UNDO_ID) offerUndo(out, UNDO_ROUTE, { id, at });
    const parts = plan.allocation.map((a) => `${shortName(a.label)} ${money(a.cents)}`).join(', ');
    const editNote = [Object.keys(amounts).length ? `${Object.keys(amounts).length} amount${Object.keys(amounts).length === 1 ? '' : 's'} edited` : '', edits.added.length ? `${edits.added.length} line${edits.added.length === 1 ? '' : 's'} added` : ''].filter(Boolean).join(', ');
    const learnNote = config.learning.mode === 'off' ? '' : learned.error ? ` (Learning could not be updated: ${learned.error}.)` : learned.count ? ` Learned from ${learned.count} changed item${learned.count === 1 ? '' : 's'}.` : '';
    return `${kind === 'review' ? 'Applied' : 'Saved'} ${file}: ${wantSplit ? `split into ${parts}` : keepCategory ? `kept in its category (splits are off here; the breakdown is in the note: ${parts})` : `put in ${main.label}${plan.allocation.length > 1 ? ` (splits are off here; the breakdown is in the note: ${parts})` : ''}`}.${review ? ' It still has #review.' : hadReview ? ' Marked as checked (#review removed).' : ''}${editNote ? ` (${editNote}.)` : ''}${learnNote}${fileNote}`;
  } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(`The charge was changed in Actual, but recording that failed (${err.message}). Check the charge in Actual.`);
  }
}

// ---- 7b. Check Actual now ---------------------------------------------------------------------------------------------

/** What the notice says Actual has: the changed items, the whole charge, or why the items can't be matched. */
const latestChangeOf = (entry, summary) => Math.max(0, ...[entry.fixedOnPage?.at, summary.pageFix?.at].map((t) => Date.parse(t ?? '')).filter(Number.isFinite));

/** A reason from a look at Actual as a plain phrase ("the split was changed in Actual"). */
export const plainReason = (t) => String(t ?? '').replace(/^its /, 'the ').replace(/^it /, 'the charge ');

function changeText(rec) {
  const names = rec.items.slice(0, 3).map((x) => `${x.d} is now ${shortName(x.now)}`);
  const more = rec.items.length > 3 ? [`${rec.items.length - 3} more`] : [];
  const parts = [...(rec.whole ? [`the whole charge is now in ${shortName(rec.whole)}`] : []), ...(rec.changed ? [plainReason(rec.changed)] : []), ...(rec.whole ? [] : names), ...(rec.whole ? [] : more)];
  return parts.join('; ');
}

/**
 * POST /receipt-check: look at the receipt's charge in Actual (read only, nothing is written to Actual) and compare it with what was
 * filed: with the watched snapshot when the charge is still watched (the way the sweep does), else with what the worker or this page
 * last wrote (the checks Save uses). The answer is kept (memory.js recordSeen) for the receipt page, which then shows what changed and
 * locks the item editor; #review gone counts as reviewed. form: id. Returns the notice.
 */
export async function checkActual(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  refuseInDryRun(id);
  try {
    return await exclusive(() => checkNow(id, deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t look at Actual. Nothing was changed');
  }
}

async function checkNow(id, deps) {
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  if (state.kind !== 'applied') throw new PanelError('Actual was not changed for this receipt, so there is nothing to compare with.');
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  let rec;
  try {
    const labels = await actual.categoryLabels();
    await actual.syncNow();
    const file = fileOf(id, summary);
    const tag = `#receipt ${file}`;
    const txnId = summary.transaction.id;
    const row = await actual.findById(txnId, summary.transaction.date);
    const learning = await import('./learning.js');
    const at = new Date();
    if (!row?.t) {
      rec = learning.seenRecord({ drop: 'the charge is gone' }, at);
    } else {
      // The watched snapshot only when it is what was written last: learning on, and not older than a save from this page.
      const found = config.learning.mode === 'off' ? null : (await memory.loadWatch()).find((e) => e.txnId === txnId);
      const snap = found && !(Date.parse(found.watchedAt) < latestChangeOf(entry, summary)) ? found : null;
      if (snap) {
        const names = actual.idToLabel(labels);
        rec = learning.seenRecord(learning.judge(snap, row.t, (cid) => (cid == null ? null : names.get(cid))), at);
      } else {
        const why = appliedProblem({ actual, row, entry, summary, tag, labels });
        const flagged = String(entry.result ?? '').endsWith('+review');
        const notes = row.t.notes ?? '';
        // #review gone from the notes means reviewed, whether or not the #receipt note is still there (you may have rewritten the notes).
        const review = actual.hasTag(notes, tag) ? hasReviewTag(ownSegment(actual, notes, tag)) : /#review\b/.test(notes);
        rec = { at: at.toISOString(), changed: why ? `${why.replace(/^it /, 'the charge ')}` : null, items: [], whole: null, review, reviewed: flagged && !review };
      }
    }
    await memory.recordSeen({ [txnId]: rec });
  } finally {
    await actual.close();
  }
  const reviewed = rec.reviewed ? ' #review was removed, so it counts as reviewed.' : '';
  if (rec.changed === 'the charge is not in Actual any more') return 'Couldn\'t find the charge in Actual. It may have been deleted or moved.';
  if (rec.changed || rec.whole || rec.items.length) return `Changed in Actual: ${changeText(rec)}. Edit it there; this page now shows what Actual has.${reviewed}`;
  return `Actual matches what was filed.${reviewed}`;
}

/**
 * Before a receipt Actual shows reviewed (#review removed there) is archived from Needs review: read the charge again, refuse if #review is
 * back or the #receipt note is gone, and take "+review" off the result (as Mark as checked does) so a Restore later leaves a Done receipt.
 * The caller holds the session lock. Never writes to Actual. Returns nothing; throws a PanelError when the receipt must not be archived.
 */
export async function settleReviewed(id, deps = {}) {
  refuseInDryRun(id);
  const { entry, summary } = await loadEntry(id, deps);
  const state = classify(id, entry, summary);
  if (!state.ok) throw new PanelError(state.reason);
  if (state.kind !== 'applied' || !String(entry.result ?? '').endsWith('+review')) return;
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    await actual.syncNow();
    const row = await actual.findById(summary.transaction.id, summary.transaction.date);
    const tag = `#receipt ${fileOf(id, summary)}`;
    if (!row?.t) throw new PanelError('The charge is not in Actual any more, so the receipt was not archived. Nothing was changed.');
    // (A rewritten note without the #receipt tag is fine: what counts is that #review is not there.)
    const gone = !actual.hasTag(row.t.notes ?? '', tag);
    if (gone ? /#review\b/.test(row.t.notes ?? '') : hasReviewTag(ownSegment(actual, row.t.notes, tag))) throw new PanelError('#review is back on the charge in Actual, so the receipt was not archived. Press Check Actual now on its page. Nothing was changed.');
  } finally {
    await actual.close();
  }
  await patchEntry(id, (e) => ({ ...e, result: String(e.result).replace(/\+review$/, '') }));
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
  refuseInDryRun(id);
  const { entry, summary } = await loadEntry(id, deps);
  const fix = entry.fixedOnPage;
  // "Looks right" only cleared #review and has no Undo, even for a link signed before Undo was removed from it (or an older record).
  if (fix?.markOnly && fix.at === at) return '"Looks right" can\'t be undone: it only removed the #review tag in Actual. Nothing was changed.';
  if (entry.archived) return 'That receipt was archived since, so this Undo was not applied. Restore it first if you want to change it. Nothing was changed.';
  if (!fix || fix.at !== at) return 'That receipt was changed again since, so this Undo was not applied. Nothing was changed.';
  // Archiving ended this Undo (a dismissal keeps the page fix for Restore, stamped undoEnded): a Restore since does not bring it back.
  if (fix.undoEnded) return 'That receipt was archived after this save, which ended its Undo, so this Undo was not applied. Nothing was changed.';
  if (!summary) throw new PanelError('The saved summary is missing, so the change can\'t be undone safely. Nothing was changed.');
  // What the summary was before the change: its own copy, or (when the Nextcloud copy was never rewritten) the one kept in the entry.
  const was = fix.summaryBefore ?? summary.pageFix?.before; // this change's own record first: the file may still hold an older save's summary
  if (!was) throw new PanelError('Nothing in the records says what the summary was before the change, so it can\'t be undone safely. Nothing was changed.');
  const actual = deps.actual ?? (await import('./actual.js'));
  await openActual(actual);
  try {
    await actual.syncNow();
    const transaction = summary.transaction ?? (fix.created ? { id: fix.created, date: fix.identity?.date, amount: money(-fix.identity?.amount) } : null);
    const row = await actual.findById(transaction.id, transaction.date);
    const now = row?.t;
    if (!fix.created && !fix.identity) return 'The original charge identity was not recorded by this older save, so nothing was undone. Change it in Actual.';
    if (!fix.created && fix.identity && (!now || ['date', 'payee', 'account', 'amount', 'transfer_id'].some((key) => (now[key] ?? null) !== (fix.identity[key] ?? null)) || (now.cleared !== false) !== fix.identity.cleared || Boolean(now.reconciled) !== fix.identity.reconciled)) return 'The charge identity or reconciliation status changed in Actual, so nothing was undone.';
    if (fix.created && (!fix.identity || !now || now.reconciled || now.cleared === false || now.transfer_id || ['date', 'payee', 'account', 'amount'].some((key) => (now[key] ?? null) !== (fix.identity[key] ?? null)))) {
      return 'The transaction was changed or reconciled in Actual, so nothing was undone.';
    }
    if (!now || -now.amount !== chargeCents(transaction) || !actual.isWritten(now, fix.wrote)) {
      return 'The charge has been changed in Actual since you saved it here, so nothing was undone. Change it back in Actual if you want to.';
    }
    if (fix.created) {
      // A cash purchase the page created: Undo deletes it (it is exactly what the page wrote, checked above).
      try {
        await actual.deleteTransactionTree(now);
      } catch (err) {
        throw new PanelError(`Deleting the transaction in Actual failed (${err.message}); it may be partly deleted: check it in Actual.`);
      }
    } else {
      const b = fix.before;
      const want = b.shape.children ? { notes: b.notes, children: b.shape.children } : { notes: b.notes, category: b.shape.category };
      await rewriteCharge(actual, now, want);
    }
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
      else await memory.patchWatch({ drop: [(summary.transaction?.id ?? fix.created)] });
      if (fix.marks) await memory.restoreMarks(summary.transaction?.id ?? fix.created, fix.marks);
    } catch (err) {
      log(`receipt page: could not undo what was learned: ${err.message}`);
    }
  }
  // What Actual was last seen to have: back to the look this change replaced (or none).
  if ('seenBefore' in fix) {
    try {
      if (fix.seenBefore) await memory.recordSeen({ [(summary.transaction?.id ?? fix.created)]: fix.seenBefore });
      else await memory.forgetSeen([(summary.transaction?.id ?? fix.created)]);
    } catch (err) {
      log(`receipt page: could not restore what Actual had: ${err.message}`);
    }
  }
  // The summary as it was, and the file back where it was (never over another file).
  const back = { ...summary, plan: was.plan, problems: was.problems };
  if (was.noTransaction) delete back.transaction; // a cash receipt is not linked to a charge any more
  if (was.pageFix) back.pageFix = was.pageFix;
  else delete back.pageFix;
  if (!back.plan) delete back.plan;
  const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
  let where = entry.filedAs;
  let fileNote = '';
  try {
    where = await filePageSummary(id, entry, fix.before.filedAs, back, nc);
  } catch (err) {
    where = err.movedTo ?? entry.filedAs;
    fileNote = ` The file or its summary could not be put back in ${filesPlace()} (${err.message}); the file is in ${path.dirname(where)}.`;
  }
  await patchEntry(id, (e) => {
    const { fixedOnPage: _gone, applied: _applied, creating: _creating, manualLink: _linked, ...rest } = e;
    return { ...rest, result: fix.before.result, at: fix.before.at ?? e.at, filedAs: where, ...(fix.before.applied ? { applied: fix.before.applied } : {}) };
  });
  return `Undone: ${fix.created ? 'the transaction was deleted from Actual and the receipt is back in Needs review' : 'the charge in Actual is as it was before'}.${fileNote}`;
}

// For cash.js (creating a transaction for a cash receipt), which shares the editor's records and checks with the code above.
export { writeToActual, learn, writeKind, partsOf, segmentFor, editsFrom, openActual, gapLabelOf, originalOf, fileOf, refuseInDryRun, STALE, UNDO_ROUTE, MAX_UNDO_ID, LOCK_WAIT_MS, chargeCents };
