// Everything that happens to one receipt after its file is downloaded: read it, match its charge, categorize the
// items, divide the charge, decide, and apply to Actual (or only log, in dry run). Used by index.js (the poll loop)
// and replay.js (comparison tests).
import { config, log } from './config.js';
import * as nextcloud from './nextcloud.js';
import * as actual from './actual.js';
import { prepareImages } from './image.js';
import { readReceipt } from './llm.js';
import { categorizeItems, clearMove, receiptLabels, atLeast } from './categorize.js';
import { allocate, cents, foldDiscounts, fixTaxGap, partNote, fixCashTotal, ITEMS_NOTE_MAX, mergeParts, money, shortName, UNCATEGORIZED } from './reconcile.js';
import { isoDay, receiptAnchor, resolveDate, shiftDay, today } from './dates.js';
import { ruleCategoryFor, amountRulesFor } from './rules.js';
import { harvestAlways } from './keywords.js';
import { occasionDetails } from './calendar.js';
import { chargeDeadline, describe, findMatch, unmatchable } from './match.js';
import { stateKey, txnIdsAppliedUnderName } from './state.js';
import { buildSnapshot, keywordCandidates, lessonsUpTo, usableLessons, withLessons } from './learning.js';

// How far back to look for a transaction already tagged with a receipt's file name (crash recovery, see processReceipt).
const TAGGED_LOOKBACK_DAYS = 90;
// How many near-miss charges the saved summary lists when none could be picked.
const CANDIDATES_LISTED = 10;

const pct = (c) => `${Math.round((c ?? 0) * 100)}%`;
const validDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
// What the decider said about an item it wasn't sure of (an invalid answer has no category).
// An item the privacy check held back is not an invalid answer: the text says so (decider-remote.js HELD_BACK).
const guessText = (category, confidence, invalidAnswer) => {
  if (category) return `${shortName(category)} ${pct(confidence)}`;
  if (String(invalidAnswer ?? '').startsWith('held back from the hosted decider')) return String(invalidAnswer).slice(0, 160);
  return `invalid answer "${String(invalidAnswer ?? '?').slice(0, 40)}"`;
};

/**
 * The one category every past purchase at this store went to: at least 3 purchases, never split elsewhere.
 * Purchases the worker filed itself (h.by === 'pipeline', not confirmed by you) don't count: they would only agree with themselves.
 */
export function storeConsensus(history) {
  // Uncategorized parts (unsure money left for you) say nothing about where the store's purchases go.
  const purchases = history.filter((h) => h.by !== 'pipeline').map((h) => h.parts.filter((p) => p.category !== UNCATEGORIZED && p.by !== 'pipeline')).filter((parts) => parts.length > 0);
  if (purchases.length < 3) return null;
  const used = new Set(purchases.flat().map((p) => p.category));
  return used.size === 1 ? { label: [...used][0], count: purchases.length } : null;
}

/**
 * Remote decider only: the names of Actual's real payees (not transfers to your own accounts). Only these may be sent as
 * store names, and each is kept readable only where it appears in full. With none, no store name is sent at all.
 */
export async function payeeNamesForPrivacy() {
  if (config.decider.provider !== 'remote') return [];
  try {
    return await actual.realPayeeNames();
  } catch (err) {
    log(`    could not list Actual's payees (${err.message}); no store names will be sent to the remote decider`);
    return [];
  }
}

/**
 * The last day of history a receipt may learn from: the day before the purchase date, live, replay and item-test alike.
 * An undated receipt (null) looks up to today.
 */
export const historyEnd = (date) => (date ? shiftDay(date, -1) : null);

/**
 * Categorize each item, learning from past purchases at this store (never the transaction itself), and settle the
 * items the decider isn't sure of. Pushes doubts about items onto itemDoubts. Returns what the summary reports.
 */
export async function categorizeReceipt(receipt, txn, labels, id2label, currentLabel, itemDoubts, opts) {
  // Look up history by the bank's payee name: more reliable than the name read off the receipt.
  receipt.store = txn.payeeName ?? txn.imported_payee ?? receipt.merchant;
  // The remote decider only ever sees the Actual payee's own name (never imported_payee), and not a transfer payee.
  receipt.payee = txn.payeeName && !txn.payeeIsTransfer ? txn.payeeName : null;
  // Nothing from the purchase day on: the history stops the day before. A replay also cuts the lessons (and rebuilds learned keywords from them).
  const until = historyEnd(receipt.date ?? (opts.replay ? txn.date : null));
  const history = await actual.storeHistory(receipt.store, txn.id, id2label, until);
  for (const h of history) log(`    history: ${h.date} ${h.amount} → ${h.parts.map((p) => `${p.category.split(' / ').pop()} ${p.amount}`).join(', ')}`);
  // Your corrections of the worker (learning.js) join the item history as examples; none unless LEARNING=on.
  // Replay tests and item-test use none of it unless asked (--with-memory): they would be graded on what they learned from you.
  const useMemory = !opts.replay || opts.withMemory;
  const lessons = useMemory ? lessonsUpTo((await usableLessons()).filter((l) => l.txnId !== txn.id), opts.replay ? until : null) : []; // never this transaction's own answer
  const items = withLessons(await actual.itemHistory(txn.id, id2label, until), lessons, labels);
  // `#always` tags in your Actual notes become keywords (local file only; Actual is never changed, even live).
  if (opts.harvestKeywords) await harvestAlways(items.always).catch((err) => log(`    #always: could not update keywords: ${err.message}`));
  // What your Actual rules give this purchase (read-only mirror of your rules).
  const ruleCategory = ruleCategoryFor(txn);
  const ruleLabel = ruleCategory ? (id2label.get(ruleCategory) ?? null) : null;
  if (ruleLabel) log(`    your rules: ${receipt.store} → ${ruleLabel}`);
  // Where the charge amount changes that (e.g. a rule for charges of $11.00 or less). Only logged: the decider is never told (categorize.js purchaseContext).
  const amountRules = amountRulesFor(txn).map((r) => ({ ...r, category: r.category ? (id2label.get(r.category) ?? null) : null }));
  if (amountRules.length) log(`    your rules by charge amount: ${amountRules.map((r) => `${r.over == null ? '' : `over ${r.over} `}${r.upTo == null ? '' : `up to ${r.upTo} `}→ ${r.category}`).join('; ')}`);
  const occasionList = await occasionDetails(receipt.date ?? txn.date);
  const occasions = occasionList.map((o) => o.text);
  if (occasions.length) log(`    occasions: ${occasions.join('; ')}`);
  const businessNames = await payeeNamesForPrivacy();
  const categorizedWith = await categorizeItems(receipt, [...labels.keys()], history, items, { currentLabel, ruleLabel, occasions, ...(opts.replay && opts.withMemory ? { learnedKeywords: keywordCandidates(lessons) } : {}), occasionDetails: occasionList, businessNames, lessons, chargeCents: -txn.amount, deciderCache: opts.deciderCache, ignoreLearned: !useMemory, ...(opts.replay ? { ignoreKeywordsFromTxn: txn.id } : {}) });

  // Items the decider isn't sure about go to the store's usual category instead of sending the receipt to review. The
  // transaction's current category comes first: a charge you re-filed by hand stays where you put it; your rule's
  // category is the fallback for uncategorized charges. Only confident items get split out.
  const allowed = receiptLabels([...labels.keys()]);
  const fallback = [currentLabel, ruleLabel].find((l) => l && allowed.includes(l)) ?? null;
  settleUnsure(receipt.items, fallback, ({ fellBack, unsure }) => {
    log(`  categorized with ${categorizedWith}, using ${history.length} past purchase(s) at this store and ${items.length} past item note(s):`);
    for (const it of receipt.items) log(`    ${itemLogLine(it)}`);
    if (receipt.receiptCheck) log(`    ${receiptCheckLine(receipt.receiptCheck)}`);
    const tied = receipt.items.filter((it) => it.keywordTie);
    if (tied.length) itemDoubts.push(...tied.map((it) => `keywords disagree for ${it.description}: ${it.keywordTie.join(' vs ')}`));
    // Doubts about individual items. These only matter if money would move to a different category (see decide).
    if (fellBack.length) {
      itemDoubts.push(`the categorizer wasn't sure, so these went to the store's category "${shortName(fallback)}": ${fellBack.map((it) => `${it.description} (model said ${guessText(it.fellBackFrom, it.originalConfidence, it.invalidAnswer)})`).join(', ')}`);
    }
    if (unsure.length) itemDoubts.push(`not sure about: ${unsure.map((it) => `${it.description} → ${guessText(it.category, it.confidence, it.invalidAnswer)}`).join(', ')}`);
  });
  return { history, ruleLabel, fallback, categorizedWith, occasions };
}

/**
 * Settle the items the decider isn't sure of (mutates them). With a store category to fall back on (and
 * UNSURE_ITEMS_USE_STORE_CATEGORY on), an unsure item goes there; confident ones stay. Staying in the store's category
 * needs CATEGORY_MIN_CONFIDENCE, moving out of it MOVE_MIN_CONFIDENCE and MOVE_MIN_MARGIN (clearMove). Whatever is still unsure then becomes an
 * Uncategorized split part for you to fill in (so the confident items can still be split out); an invalid answer has
 * no category at all, so it always goes there, but with APPLY_THEN_REVIEW off an unsure item that has a category keeps it.
 * `onSettled({ fellBack, unsure })`, if given, runs between the two steps, while the unsure items still carry their
 * own category (for logging). Returns { fellBack, unsure }.
 */
export function settleUnsure(items, fallback, onSettled) {
  if (config.ruleFallback && fallback) {
    for (const it of items) {
      // Staying in the store's category needs CATEGORY_MIN_CONFIDENCE; moving out of it needs a confident, clear-cut move.
      const keeps = it.category === fallback ? atLeast(it.confidence, config.categoryMinConfidence) : clearMove(it);
      // An item the receipt check pulled into the store's own category said something else by itself: that is the store default, not its pick.
      const defaulted = it.receiptSaid && it.category === fallback;
      if (it.category != null && keeps && !defaulted) continue;
      const said = it.receiptSaid ?? { category: it.category, confidence: it.confidence }; // what the item said by itself, if the receipt check moved it
      Object.assign(it, { fellBack: true, fellBackFrom: said.category, originalConfidence: said.confidence, category: fallback, confidence: null });
    }
  }
  const fellBack = items.filter((it) => it.fellBack);
  const unsure = items.filter((it) => !it.fellBack && (it.category == null || (it.confidence != null && !atLeast(it.confidence, config.categoryMinConfidence))));
  onSettled?.({ fellBack, unsure });
  // With no store category to fall back on, unsure items become an uncategorized split part for you to fill in,
  // so the confident items can still be split out. An invalid answer has no category at all, so it always goes there.
  for (const it of unsure) {
    if (!config.applyThenReview && it.category != null) continue;
    it.unsureGuess = it.category ? `${shortName(it.category)} ${pct(it.confidence)}` : null;
    it.category = UNCATEGORIZED;
  }
  return { fellBack, unsure };
}

/** The per-receipt answer for the log (categorize.js applyReceiptCheck): what it said and which items it pulled in. */
export function receiptCheckLine(rc) {
  if (!rc.category) return `whole purchase: no usable answer (${String(rc.invalid ?? '?').slice(0, 80)}); items unchanged`;
  const said = `${shortName(rc.category)} ${pct(rc.confidence)}${rc.margin != null ? `, ${pct(rc.margin)} ahead of the next` : ''}`;
  if (!atLeast(rc.confidence, config.receiptCheckMinConfidence)) return `whole purchase: ${said}, under ${pct(config.receiptCheckMinConfidence)}; items unchanged`;
  return `whole purchase: ${said}; ${rc.moved.length ? `pulled into it: ${rc.moved.join(', ')}` : 'no item changed'}`;
}

/** One line for the log: the item, its amount, the category it got and how sure the decider was. */
function itemLogLine(it) {
  const plain = it.plain && it.plain.toLowerCase() !== it.description.toLowerCase() ? ` [${it.plain}]` : '';
  const kwNote = it.keyword ? `keyword "${it.keyword}"` : null;
  const how = it.source === 'keyword' ? ` (${kwNote})` : it.fellBack ? ` (store default; model said ${guessText(it.fellBackFrom, it.originalConfidence, it.invalidAnswer)})` : it.confidence != null ? ` (${pct(it.confidence)}${it.margin != null ? `, ${pct(it.margin)} ahead of the next` : ''}${kwNote ? `; ${kwNote}${it.modelSaid ? `, model said ${shortName(it.modelSaid.category)} ${pct(it.modelSaid.confidence)}` : ''}` : ''}${it.receiptSaid ? `; whole-purchase answer, item said ${shortName(it.receiptSaid.category)} ${pct(it.receiptSaid.confidence)}` : ''})` : '';
  return `${it.description}${plain} ${money(cents(it.amount))} → ${it.category ?? `? (${guessText(null, 0, it.invalidAnswer)})`}${how}`;
}

/** The doubt to raise when the whole charge moves to another category on the receipt-level answer alone, else null. */
export function receiptAnswerDoubt(action, allocation, receipt, current, currentLabel) {
  if (action !== 'categorize' || !current || allocation[0].categoryId === current || !restsOnReceiptAnswer(receipt, allocation[0].label)) return null;
  return `the charge moved from "${currentLabel}" to "${allocation[0].label}" on the whole-purchase answer alone: no single item picked it by itself`;
}

/** True if the whole charge reads as this category only because the receipt check put the items there: none of them picked it by itself. */
const restsOnReceiptAnswer = (receipt, label) => {
  const here = receipt.items.filter((it) => it.category === label && !it.fellBack);
  return here.length > 0 && here.every((it) => it.receiptSaid);
};

/** True if some item is clearly (clearMove) in this category. */
const confidentIn = (receipt, label) => receipt.items.some((it) => it.category === label && !it.fellBack && clearMove(it));

/**
 * Pick what to do with the transaction. Returns the action, or null with the reason pushed onto problems.
 */
export function chooseAction(allocation, receipt, current, currentLabel, problems) {
  const placed = allocation.filter((a) => a.categoryId);
  if (placed.length === 0) {
    problems.push('no item could be categorized with enough confidence');
    return null;
  }
  if (allocation.length > 1) return config.splits && actual.splitsSupported ? 'split' : current ? 'note' : 'categorize';
  if (!current) return 'categorize';
  if (allocation[0].categoryId === current) return 'confirm';
  // Moving a whole charge to another category takes at least one item the decider is confident about.
  if (!confidentIn(receipt, allocation[0].label)) {
    problems.push(`the receipt reads as "${allocation[0].label}", but no item is at least ${pct(config.moveMinConfidence)} sure of it with a clear lead over the next category, so the charge stays "${currentLabel}"`);
    return null;
  }
  if (config.match.overwrite) return 'categorize';
  problems.push(`your rules filed this under "${currentLabel}", but the receipt reads as "${allocation[0].label}"`);
  return null;
}

export async function processReceipt(item, labels, entry, ctx) {
  // A transaction already tagged with this file means it was applied before the state was saved (a crash):
  // don't change Actual again, just file the receipt. A tag that the state already holds as applied for another upload
  // under this name (a re-used name, since the key includes the etag) belongs to that receipt, so those are left out.
  const tagged = await actual.findTaggedTransactions(item.basename, shiftDay(today(), -TAGGED_LOOKBACK_DAYS));
  const ownedElsewhere = txnIdsAppliedUnderName(ctx?.state, stateKey(item));
  const mine = tagged.filter((t) => !ownedElsewhere.has(t.id));
  if (mine.length === 1) return alreadyApplied(item, mine[0]);
  // Several transactions carry this name and the state can't say which is this photo's: don't guess, don't change Actual.
  if (mine.length > 1) return ambiguousTag(item, mine);
  // Waiting receipts are re-checked from the reading saved the first time, so the photo is read once.
  // A reading made by another reader (switched between local and cloud, or to another host or model) is not reused.
  if (entry.reading?.reader && !sameReader(entry.reading.reader, currentReader())) {
    log('  the saved reading came from another reader; reading the photo again');
    delete entry.reading;
  }
  if (!entry.reading) {
    await ctx.modelReady();
    const images = await prepareImages(await nextcloud.download(item), item.basename, config.maxImageSide);
    const { receipt, mode } = await readReceipt(images);
    entry.reading = { receipt: structuredClone(receipt), mode, reader: currentReader() };
    // Only consecutive reader failures count: the reader answered with a new reading, so its count starts again. A reused
    // reading says nothing about the reader (the cloud name scan that follows is a reader call too, and keeps counting).
    delete entry.transientFails;
  } else {
    log(`  using the reading saved ${entry.waiting?.since ? `on ${entry.waiting.since}` : 'earlier'}`);
  }
  // With the hosted decider, answers already paid for are kept on the entry (keyed by request), so a retry does not buy them again.
  const deciderCache = config.decider.provider === 'remote' ? (entry.deciderAnswers ??= {}) : undefined;
  return handleReceipt(item, structuredClone(entry.reading.receipt), entry.reading.mode, labels, { harvestKeywords: true, ...(deciderCache ? { deciderCache } : {}) });
}

/** Who reads the photos now: saved with a reading, so a reading from another reader is not used. The local reader has no host. */
export const currentReader = () => (config.reader.provider === 'remote'
  ? { provider: 'remote', host: config.reader.host, model: config.reader.model }
  : { provider: 'local', host: null, model: config.llmName ?? null });
const sameReader = (a, b) => a?.provider === b.provider && (a.host ?? null) === b.host && (a.model ?? null) === b.model;

function ambiguousTag(item, found) {
  const problem = `${found.length} transactions already carry "#receipt ${item.basename}" (${found.map(describe).join('; ')}); cannot tell which one this photo belongs to, so nothing was changed: check them in Actual`;
  log(`  ${problem}`);
  return { result: 'review', summary: { file: item.basename, problems: [problem] }, folder: config.nextcloud.review };
}

function alreadyApplied(item, txn) {
  const review = /#review\b/.test(txn.notes ?? '');
  log(`  already applied to ${describe(txn)} (its note has #receipt ${item.basename}); not changing Actual again`);
  const summary = {
    file: item.basename,
    alreadyApplied: true,
    transaction: { id: txn.id, date: txn.date, account: txn.accountName ?? null, amount: money(-txn.amount), payee: txn.payeeName ?? null, notes: txn.notes ?? null },
    problems: review ? ['this receipt was already applied, and the transaction note is tagged #review: check it in Actual'] : [],
  };
  // Live: recorded as applied, so a later upload under the same name does not take this transaction for its own.
  const applied = config.dryRun ? undefined : { txnId: txn.id, action: 'already-applied', at: new Date().toISOString() };
  return { result: `${config.dryRun ? 'dry-run:' : ''}already-applied`, summary, ...(applied ? { applied } : {}), folder: review ? config.nextcloud.review : config.nextcloud.processed };
}

/**
 * Everything after the receipt has been read: match the bank transaction, categorize the items from this
 * household's history at the store, check, decide, then apply to Actual (or only log, in dry run).
 * opts.includeSplits is for replay tests; opts.replay never waits for a charge; opts.now is
 * the current time (tests). Returns { result, summary } plus folder (where the file goes), applied (what was
 * written to Actual) or waiting ({ reason, until }: leave the file in the inbox and check again later).
 */
export async function handleReceipt(item, receipt, readMode, labels, opts = {}) {
  const now = opts.now ?? new Date();
  const id2label = actual.idToLabel(labels);
  // The purchase date as printed, checked against when the photo was uploaded; undated receipts match by upload time.
  // The anchor is the earlier of the day in the file name (when the camera named it) and the upload time.
  const { date: anchor, fromName, slackDays, photoDay } = receiptAnchor(item.basename, validDate(item.lastmod) ?? now, now);
  if (fromName) log(`  photo taken ${photoDay} (from the file name)`);
  const { date, note: dateNote } = resolveDate(receipt, anchor, { slackDays });
  receipt.date = date;
  const totalNote = fixCashTotal(receipt);
  if (totalNote) log(`  ${totalNote}`);
  // Discount and coupon lines join the item they discount (live, replay and every re-check of a saved reading go through here).
  for (const f of foldDiscounts(receipt)) log(`  folded "${f.line}" (${money(-f.cents)}) into ${f.into}`);
  const gapFix = fixTaxGap(receipt); // items off the subtotal, fixed from the printed tax lines
  if (gapFix) log(`  items were ${money(Math.abs(gapFix.cents))} ${gapFix.cents > 0 ? 'over' : 'under'} the subtotal; corrected on the items taxed at ${gapFix.codes.join(', ')}`);
  log(`  read (${readMode}): ${receipt.merchant}${receipt.store_clues?.length ? ` [${receipt.store_clues.join(', ')}]` : ''}, ${date ?? 'no date'}${dateNote ? ` (${dateNote})` : ''}, total ${money(cents(receipt.total))}, ${receipt.items.length} item(s)`);

  const problems = []; // anything here sends the receipt to review without changing Actual
  const itemDoubts = []; // matter only if money would move (see step 4)
  const matchDoubts = []; // matter for any change, even a note (a pending charge may be replaced when it clears)
  const blocker = unmatchable(receipt);
  if (blocker) problems.push(blocker);

  // 1. Find the bank transaction.
  let match = null;
  if (problems.length === 0) {
    match = await findMatch(receipt, date, anchor, opts);
    if (match.problem) problems.push(match.problem);
    itemDoubts.push(...(match.doubts ?? []));
    matchDoubts.push(...(match.matchDoubts ?? []));
  }
  const txn = match?.txn ?? null;
  const current = txn && !txn.is_parent ? txn.category ?? null : null;
  const allowed = receiptLabels([...labels.keys()]);
  const currentLabel = current ? (id2label.get(current) ?? null) : null;
  if (txn) log(`  matched ${describe(txn)}, currently ${txn.is_parent ? 'split' : current ? `"${currentLabel ?? 'a hidden or income category'}"` : 'uncategorized'} (payee score ${txn.payeeScore.toFixed(2)}${txn.extraCents ? `, ${money(txn.extraCents)} more than the receipt` : ''}${txn.pending ? ', pending' : ''})`);
  // Bills, savings, debt, giving, hidden and income categories are yours (or your rules') alone.
  if (current && !allowed.includes(currentLabel)) {
    problems.push(`this charge is filed under ${currentLabel ? `"${currentLabel}"` : 'a hidden or income category'}, which receipts don't change`);
  }

  const waiting = waitForCharge({ item, match, txn, problems, matchDoubts, date, anchor, now, replay: opts.replay });
  if (waiting) return waiting;

  // 2. Categorize, 3. divide what the bank charged (includes any tip) across the categories.
  let allocation = null;
  let taxExplained = null;
  let cat = { history: [], ruleLabel: null, fallback: null, categorizedWith: null };
  if (txn && problems.length === 0) {
    cat = await categorizeReceipt(receipt, txn, labels, id2label, currentLabel, itemDoubts, opts);
    if (txn.extraCents > 0) itemDoubts.push(`the charge is ${money(txn.extraCents)} more than the receipt total (tip?)`);
    // A big restaurant bill is often a gift meal (or part of one): worth a look even when Restaurants is kept.
    const gm = config.giftMeal;
    if (gm.minDollars > 0 && [currentLabel, cat.ruleLabel].includes(gm.category) && -txn.amount > gm.minDollars * 100) {
      matchDoubts.push(`${money(-txn.amount)} at a restaurant is over $${gm.minDollars}: it may be a gift meal (Gifts) or need splitting${cat.occasions?.length ? `; near ${cat.occasions[0].split(' on ')[0]}` : ''}`);
    }
    const result = allocate(receipt, labels, -txn.amount, { gapLabel: cat.fallback ?? UNCATEGORIZED });
    allocation = result.allocation;
    taxExplained = result.taxExplained ?? null;
    itemDoubts.push(...result.problems); // e.g. items don't add up to the subtotal, or a credit/return line
    if (result.taxByRate) log(`  tax of ${money(cents(receipt.tax))} spread by rate: ${result.taxByRate.map((l) => `${l.code} ${money(l.amount)} over ${money(l.base)}`).join(', ')} (TAX_BY_ITEM)`);
    else if (result.taxByItem) log(`  tax of ${money(cents(receipt.tax))} spread over the taxed items only (TAX_BY_ITEM)`);

    // Store guard: if every past purchase at this store went to one category, don't move money elsewhere unreviewed.
    const usual = storeConsensus(cat.history);
    const elsewhere = allocation?.filter((a) => a.categoryId && a.label !== usual?.label) ?? [];
    if (usual && elsewhere.length) {
      itemDoubts.push(`all ${usual.count} past purchases at ${receipt.store} went to "${usual.label}", but this receipt puts ${elsewhere.map((a) => `${money(a.cents)} in "${a.label}"`).join(', ')}`);
    }
  }

  // 4. Decide. Actual's rules have usually categorized the transaction already.
  const decision = decide({ allocation, receipt, current, currentLabel, problems, itemDoubts, matchDoubts });
  const { action, flags } = decision;
  allocation = decision.allocation;

  const summary = buildSummary({ item, readMode, cat, receipt, totalNote, txn, current, currentLabel, id2label, match, allocation, action, problems, flags, taxExplained });

  if (problems.length > 0) {
    log(`  needs review, nothing changed: ${problems.join(' / ')}`);
    return { result: 'review', summary, folder: config.nextcloud.review };
  }
  return applyPlan({ item, txn, allocation, action, flags, currentLabel, summary, receipt });
}

/**
 * The bank charge usually posts after the receipt is uploaded: wait for it (or for a pending one to clear) instead of
 * sending the receipt to review. Replay tests look at old receipts and never wait. Returns handleReceipt's waiting result,
 * or null to carry on (a pending charge past its deadline adds a doubt to matchDoubts).
 */
function waitForCharge({ item, match, txn, problems, matchDoubts, date, anchor, now, replay }) {
  if (replay) {
    if (txn?.pending) matchDoubts.push('the charge is still pending (not cleared by the bank)');
    return null;
  }
  const onlyNoMatch = match?.waitable && problems.length === 1;
  const pending = txn?.pending && problems.length === 0;
  if (!onlyNoMatch && !pending) return null;
  const until = chargeDeadline(date, anchor, Boolean(pending));
  if (now < until) {
    const reason = pending ? `the matching charge ${describe(txn)} is still pending` : problems[0];
    log(`  waiting until ${until.toISOString()} for the bank: ${reason}`);
    return { result: 'waiting', waiting: { reason, until: until.toISOString() }, summary: { file: item.basename, waiting: reason, until: until.toISOString() } };
  }
  if (pending) matchDoubts.push(`the charge was still pending (not cleared by the bank) on ${isoDay(now)}`);
  return null;
}

/**
 * Step 4 of handleReceipt: merge tiny parts, pick the action and sort the doubts into problems (review, nothing applied)
 * and flags (applied anyway, then reviewed: APPLY_THEN_REVIEW). Pushes onto `problems`. Returns { allocation, action, flags }.
 */
function decide({ allocation, receipt, current, currentLabel, problems, itemDoubts, matchDoubts }) {
  const flags = [];
  if (!allocation || problems.length > 0) {
    problems.push(...matchDoubts, ...itemDoubts);
    return { allocation, action: null, flags };
  }
  allocation = mergeParts(allocation, current);
  let action = chooseAction(allocation, receipt, current, currentLabel, problems);
  // Moving a whole charge on the receipt-level answer alone is a judgment no single item backs: say so, so it gets a look.
  const alone = receiptAnswerDoubt(action, allocation, receipt, current, currentLabel);
  if (alone) itemDoubts.push(alone);
  // When the receipt agrees with the category already set, nothing but a note changes, so item-level doubts
  // don't need your review. Anything that moves money does: with APPLY_THEN_REVIEW the confident part is
  // applied (unsure money left uncategorized) and the receipt still goes to review; otherwise nothing is applied.
  if (action) {
    const doubts = [...matchDoubts, ...(action !== 'confirm' ? itemDoubts : [])];
    if (doubts.length) {
      if (config.applyThenReview) flags.push(...doubts);
      else problems.push(...doubts);
    }
  } else {
    // Nothing is applied: the review reason keeps the specific doubts (held back, pending, ...); the generic sentence only if nothing more specific exists.
    const specific = [...new Set([...matchDoubts, ...itemDoubts])].filter((d) => !problems.includes(d));
    const generic = problems.indexOf('no item could be categorized with enough confidence');
    if (specific.length && generic >= 0) problems.splice(generic, 1);
    problems.push(...specific);
  }
  if (problems.length > 0) action = null;
  return { allocation, action, flags };
}

/** The JSON saved next to the filed receipt: what was read, matched, decided and why. */
function buildSummary({ item, readMode, cat, receipt, totalNote, txn, current, currentLabel, id2label, match, allocation, action, problems, flags, taxExplained = null }) {
  return {
    file: item.basename,
    readWith: readMode,
    categorizedWith: cat.categorizedWith,
    historyUsed: cat.history,
    receipt,
    totalCorrected: totalNote,
    transaction: txn
      ? {
          id: txn.id, date: txn.date, account: txn.accountName, amount: money(-txn.amount), payee: txn.payeeName,
          bankDescription: txn.imported_payee, payeeScore: Number(txn.payeeScore.toFixed(2)),
          pending: txn.pending ?? null,
          currentCategory: current ? (currentLabel ?? 'a hidden or income category') : null,
          ruleCategory: cat.ruleLabel,
          currentSplit: txn.is_parent ? (txn.subtransactions ?? []).map((s) => ({ category: id2label.get(s.category) ?? '?', amount: money(-s.amount) })) : null,
        }
      : null,
    // Charges that might be this one, when none could be picked (payee mismatch, ambiguous, older undated match).
    candidates: !txn && match?.candidates?.length ? match.candidates.slice(0, CANDIDATES_LISTED).map(describe) : undefined,
    plan: allocation ? { action, applied: action != null, gapLabel: cat.fallback ?? UNCATEGORIZED, parts: allocation.map((a) => ({ category: a.label, amount: money(a.cents), items: a.items })), ...(taxExplained ? { tax: taxExplained } : {}) } : null,
    problems: [...problems, ...flags],
  };
}

/** Write the decision to Actual (or only log it, in dry run). Returns handleReceipt's result. */
export async function applyPlan({ item, txn, allocation, action, flags, currentLabel, summary, receipt }) {
  const parts = allocation.map((a) => `${shortName(a.label)} ${money(a.cents)}`).join(', ');
  // #review marks transactions the pipeline changed but wants you to check (searchable in Actual).
  const note = `#receipt ${item.basename}${flags.length ? ' #review' : ''}`;
  const main = allocation.find((a) => a.categoryId);
  const plan = {
    split: `split into: ${parts}`,
    categorize: `categorize as "${main.label}"`,
    confirm: `leave it as "${currentLabel}" (the receipt agrees) and add a #receipt note`,
    note: `leave it as "${currentLabel}" and note the breakdown (${parts}); splits are turned off`,
  }[action];
  const result = `${action}${flags.length ? '+review' : ''}`;
  if (flags.length) log(`  applying, then sending to review: ${flags.join(' / ')}`);
  if (config.dryRun) {
    log(`  [dry run] would ${plan}`);
    return { result: `dry-run:${result}`, summary };
  }
  // Categorizing can take minutes: if you edited the charge meanwhile, don't overwrite it (and never split onto a split).
  if (await actual.changedMeanwhile(txn)) {
    const problems = [...(summary.problems ?? []), actual.CHANGED_MEANWHILE];
    return { result: 'review', summary: { ...summary, ...(summary.plan ? { plan: { ...summary.plan, applied: false } } : {}), problems }, folder: config.nextcloud.review };
  }
  // Single-category notes list the items, so later receipts can learn from them (see actual.itemHistory).
  const withItems = `${note} — items: ${allocation.length === 1 ? partNote(allocation[0], '; ', ITEMS_NOTE_MAX) : allocation.flatMap((a) => a.items).join('; ').slice(0, ITEMS_NOTE_MAX)}`;
  if (action === 'split') await actual.split(txn, allocation, note);
  else if (action === 'categorize') await actual.categorize(txn, main.categoryId, allocation.length > 1 ? `${note}: ${parts}` : withItems);
  else await actual.addNote(txn, action === 'note' ? `${note}: ${parts}` : withItems);
  log(`  done: ${plan}`);
  // snapshot: what was written, for learning.js to look at later (live only; a dry run, replay or item-test never gets here).
  const snapshot = buildSnapshot({ txn, item, receipt, allocation, action, review: flags.length > 0 });
  return { result, summary, applied: { txnId: txn.id, action, at: new Date().toISOString() }, ...(snapshot ? { snapshot } : {}), folder: flags.length ? config.nextcloud.review : config.nextcloud.processed };
}
