// Everything that happens to one receipt after its file is downloaded: read it, match its charge, categorize the
// items, divide the charge, decide, and apply to Actual (or only log, in dry run). Used by index.js (the poll loop)
// and replay.js (comparison tests).
import { config, log } from './config.js';
import * as nextcloud from './nextcloud.js';
import * as actual from './actual.js';
import { prepareImages } from './image.js';
import { readReceipt } from './llm.js';
import { categorizeItems, receiptLabels } from './categorize.js';
import { allocate, cents, fixCashTotal, mergeSmallParts, money, shortName, UNCATEGORIZED } from './reconcile.js';
import { isoDay, resolveDate, shiftDay, today } from './dates.js';
import { ruleCategoryFor } from './rules.js';
import { harvestAlways } from './keywords.js';
import { occasionsNear } from './calendar.js';
import { chargeDeadline, describe, findMatch, unmatchable } from './match.js';

// How far back to look for a transaction already tagged with a receipt's file name (crash recovery, see processReceipt).
const TAGGED_LOOKBACK_DAYS = 90;

const pct = (c) => `${Math.round((c ?? 0) * 100)}%`;
const validDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
// What the decider said about an item it wasn't sure of (an invalid answer has no category).
const guessText = (category, confidence, invalidAnswer) =>
  category ? `${shortName(category)} ${pct(confidence)}` : `invalid answer "${String(invalidAnswer ?? '?').slice(0, 40)}"`;

/** The one category every past purchase at this store went to: at least 3 purchases, never split elsewhere. */
export function storeConsensus(history) {
  // Uncategorized parts (unsure money left for you) say nothing about where the store's purchases go.
  const purchases = history.map((h) => h.parts.filter((p) => p.category !== UNCATEGORIZED)).filter((parts) => parts.length > 0);
  if (purchases.length < 3) return null;
  const used = new Set(purchases.flat().map((p) => p.category));
  return used.size === 1 ? { label: [...used][0], count: purchases.length } : null;
}

/**
 * Categorize each item, learning from past purchases at this store (never the transaction itself), and settle the
 * items the decider isn't sure of. Pushes doubts about items onto itemDoubts. Returns what the summary reports.
 */
export async function categorizeReceipt(receipt, txn, labels, id2label, currentLabel, itemDoubts, opts) {
  // Look up history by the bank's payee name: more reliable than the name read off the receipt.
  receipt.store = txn.payeeName ?? txn.imported_payee ?? receipt.merchant;
  const history = await actual.storeHistory(receipt.store, txn.id, id2label);
  for (const h of history) log(`    history: ${h.date} ${h.amount} → ${h.parts.map((p) => `${p.category.split(' / ').pop()} ${p.amount}`).join(', ')}`);
  const items = await actual.itemHistory(txn.id, id2label);
  // `#always` tags in your Actual notes become keywords (local file only; Actual is never changed, even live).
  if (opts.harvestKeywords) await harvestAlways(items.always).catch((err) => log(`    #always: could not update keywords: ${err.message}`));
  // What your Actual rules give this purchase (read-only mirror of your rules).
  const ruleCategory = ruleCategoryFor(txn);
  const ruleLabel = ruleCategory ? (id2label.get(ruleCategory) ?? null) : null;
  if (ruleLabel) log(`    your rules: ${receipt.store} → ${ruleLabel}`);
  const occasions = await occasionsNear(receipt.date ?? txn.date);
  if (occasions.length) log(`    occasions: ${occasions.join('; ')}`);
  const categorizedWith = await categorizeItems(receipt, [...labels.keys()], history, items, { currentLabel, ruleLabel, occasions, ...(opts.replay ? { ignoreKeywordsFromTxn: txn.id } : {}) });

  // Items the decider isn't sure about go to the store's usual category instead of sending the receipt to review. The
  // transaction's current category comes first: a charge you re-filed by hand stays where you put it; your rule's
  // category is the fallback for uncategorized charges. Only confident items get split out.
  const allowed = receiptLabels([...labels.keys()]);
  const fallback = [currentLabel, ruleLabel].find((l) => l && allowed.includes(l)) ?? null;
  settleUnsure(receipt.items, fallback, ({ fellBack, unsure }) => {
    log(`  categorized with ${categorizedWith}, using ${history.length} past purchase(s) at this store and ${items.length} past item note(s):`);
    for (const it of receipt.items) log(`    ${itemLogLine(it)}`);
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
 * needs CATEGORY_MIN_CONFIDENCE, moving out of it MOVE_MIN_CONFIDENCE. Whatever is still unsure then becomes an
 * Uncategorized split part for you to fill in (so the confident items can still be split out); an invalid answer has
 * no category at all, so it always goes there, but with APPLY_THEN_REVIEW off an unsure item that has a category keeps it.
 * `onSettled({ fellBack, unsure })`, if given, runs between the two steps, while the unsure items still carry their
 * own category (for logging). Returns { fellBack, unsure }.
 */
export function settleUnsure(items, fallback, onSettled) {
  if (config.ruleFallback && fallback) {
    for (const it of items) {
      // Staying in the store's category needs CATEGORY_MIN_CONFIDENCE; moving out of it needs MOVE_MIN_CONFIDENCE.
      const needed = it.category === fallback ? config.categoryMinConfidence : config.moveMinConfidence;
      if (it.category != null && it.confidence >= needed) continue;
      Object.assign(it, { fellBack: true, fellBackFrom: it.category, originalConfidence: it.confidence, category: fallback, confidence: null });
    }
  }
  const fellBack = items.filter((it) => it.fellBack);
  const unsure = items.filter((it) => !it.fellBack && (it.category == null || (it.confidence != null && it.confidence < config.categoryMinConfidence)));
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

/** One line for the log: the item, its amount, the category it got and how sure the decider was. */
function itemLogLine(it) {
  const plain = it.plain && it.plain.toLowerCase() !== it.description.toLowerCase() ? ` [${it.plain}]` : '';
  const kwNote = it.keyword ? `keyword "${it.keyword}"` : null;
  const how = it.source === 'keyword' ? ` (${kwNote})` : it.fellBack ? ` (store default; model said ${guessText(it.fellBackFrom, it.originalConfidence, it.invalidAnswer)})` : it.confidence != null ? ` (${pct(it.confidence)}${kwNote ? `; ${kwNote}${it.modelSaid ? `, model said ${shortName(it.modelSaid.category)} ${pct(it.modelSaid.confidence)}` : ''}` : ''})` : '';
  return `${it.description}${plain} ${money(cents(it.amount))} → ${it.category ?? `? (${guessText(null, 0, it.invalidAnswer)})`}${how}`;
}

/** True if some item is confidently (MOVE_MIN_CONFIDENCE, from the decider itself) in this category. */
const confidentIn = (receipt, label) =>
  receipt.items.some((it) => it.category === label && !it.fellBack && it.confidence != null && it.confidence >= config.moveMinConfidence);

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
    problems.push(`the receipt reads as "${allocation[0].label}", but no item is at least ${pct(config.moveMinConfidence)} sure of it, so the charge stays "${currentLabel}"`);
    return null;
  }
  if (config.match.overwrite) return 'categorize';
  problems.push(`your rules filed this under "${currentLabel}", but the receipt reads as "${allocation[0].label}"`);
  return null;
}

export async function processReceipt(item, labels, entry, ctx) {
  // A transaction already tagged with this file means it was applied before the state was saved (a crash):
  // don't change Actual again, just file the receipt.
  const tagged = await actual.findTaggedTransaction(item.basename, shiftDay(today(), -TAGGED_LOOKBACK_DAYS));
  if (tagged) return alreadyApplied(item, tagged);
  // Waiting receipts are re-checked from the reading saved the first time, so the photo is read once.
  if (!entry.reading) {
    await ctx.modelReady();
    const images = await prepareImages(await nextcloud.download(item), item.basename, config.maxImageSide);
    const { receipt, mode } = await readReceipt(images);
    entry.reading = { receipt: structuredClone(receipt), mode };
  } else {
    log(`  using the reading saved ${entry.waiting?.since ? `on ${entry.waiting.since}` : 'earlier'}`);
  }
  return handleReceipt(item, structuredClone(entry.reading.receipt), entry.reading.mode, labels, { harvestKeywords: true });
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
  return { result: `${config.dryRun ? 'dry-run:' : ''}already-applied`, summary, folder: review ? config.nextcloud.review : config.nextcloud.processed };
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
  const anchor = validDate(item.lastmod) ?? now;
  const { date, note: dateNote } = resolveDate(receipt, anchor);
  receipt.date = date;
  const totalNote = fixCashTotal(receipt);
  if (totalNote) log(`  ${totalNote}`);
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
  }
  const txn = match?.txn ?? null;
  const current = txn && !txn.is_parent ? txn.category ?? null : null;
  const allowed = receiptLabels([...labels.keys()]);
  const currentLabel = current ? (id2label.get(current) ?? null) : null;
  if (txn) log(`  matched ${describe(txn)}, currently ${txn.is_parent ? 'split' : current ? `"${currentLabel ?? 'a hidden or income category'}"` : 'uncategorized'} (payee score ${txn.payeeScore.toFixed(2)}${txn.extraCents ? `, ${money(txn.extraCents)} more than the receipt` : ''}${txn.pending ? ', pending' : ''})`);
  // Bills, savings, debt, tithing, hidden and income categories are yours (or your rules') alone.
  if (current && !allowed.includes(currentLabel)) {
    problems.push(`this charge is filed under ${currentLabel ? `"${currentLabel}"` : 'a hidden or income category'}, which receipts don't change`);
  }

  // The bank charge usually posts after the receipt is uploaded: wait for it (or for a pending one to clear)
  // instead of sending the receipt to review. Replay tests look at old receipts and never wait.
  if (!opts.replay) {
    const onlyNoMatch = match?.waitable && problems.length === 1;
    const pending = txn?.pending && problems.length === 0;
    if (onlyNoMatch || pending) {
      const until = chargeDeadline(date, anchor, Boolean(pending));
      if (now < until) {
        const reason = pending ? `the matching charge ${describe(txn)} is still pending` : problems[0];
        log(`  waiting until ${until.toISOString()} for the bank: ${reason}`);
        return { result: 'waiting', waiting: { reason, until: until.toISOString() }, summary: { file: item.basename, waiting: reason, until: until.toISOString() } };
      }
      if (pending) matchDoubts.push(`the charge was still pending (not cleared by the bank) on ${isoDay(now)}`);
    }
  } else if (txn?.pending) matchDoubts.push('the charge is still pending (not cleared by the bank)');

  // 2. Categorize, 3. divide what the bank charged (includes any tip) across the categories.
  let allocation = null;
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
    itemDoubts.push(...result.problems); // e.g. items don't add up to the subtotal, or a credit/return line

    // Store guard: if every past purchase at this store went to one category, don't move money elsewhere unreviewed.
    const usual = storeConsensus(cat.history);
    const elsewhere = allocation?.filter((a) => a.categoryId && a.label !== usual?.label) ?? [];
    if (usual && elsewhere.length) {
      itemDoubts.push(`all ${usual.count} past purchases at ${receipt.store} went to "${usual.label}", but this receipt puts ${elsewhere.map((a) => `${money(a.cents)} in "${a.label}"`).join(', ')}`);
    }
  }

  // 4. Decide. Actual's rules have usually categorized the transaction already.
  let action = null;
  const flags = []; // applied anyway, but the receipt goes to review (APPLY_THEN_REVIEW)
  if (allocation && problems.length === 0) {
    allocation = mergeSmallParts(allocation, config.splitMinCents, current);
    action = chooseAction(allocation, receipt, current, currentLabel, problems);
    // When the receipt agrees with the category already set, nothing but a note changes, so item-level doubts
    // don't need your review. Anything that moves money does: with APPLY_THEN_REVIEW the confident part is
    // applied (unsure money left uncategorized) and the receipt still goes to review; otherwise nothing is applied.
    const doubts = action ? [...matchDoubts, ...(action !== 'confirm' ? itemDoubts : [])] : [];
    if (doubts.length) {
      if (config.applyThenReview) flags.push(...doubts);
      else problems.push(...doubts);
    }
    if (problems.length > 0) action = null;
  } else {
    problems.push(...matchDoubts, ...itemDoubts);
  }

  const summary = buildSummary({ item, readMode, cat, receipt, totalNote, txn, current, currentLabel, id2label, match, allocation, action, problems, flags });

  if (problems.length > 0) {
    log(`  needs review, nothing changed: ${problems.join(' / ')}`);
    return { result: 'review', summary, folder: config.nextcloud.review };
  }
  return applyPlan({ item, txn, allocation, action, flags, currentLabel, summary });
}

/** The JSON saved next to the filed receipt: what was read, matched, decided and why. */
function buildSummary({ item, readMode, cat, receipt, totalNote, txn, current, currentLabel, id2label, match, allocation, action, problems, flags }) {
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
    candidates: !txn && match?.candidates?.length ? match.candidates.slice(0, 10).map(describe) : undefined,
    plan: allocation ? { action, applied: action != null, parts: allocation.map((a) => ({ category: a.label, amount: money(a.cents), items: a.items })) } : null,
    problems: [...problems, ...flags],
  };
}

/** Write the decision to Actual (or only log it, in dry run). Returns handleReceipt's result. */
async function applyPlan({ item, txn, allocation, action, flags, currentLabel, summary }) {
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
  // Single-category notes list the items, so later receipts can learn from them (see actual.itemHistory).
  const withItems = `${note} — items: ${allocation.flatMap((a) => a.items).join('; ').slice(0, 300)}`;
  if (action === 'split') await actual.split(txn, allocation, note);
  else if (action === 'categorize') await actual.categorize(txn, main.categoryId, allocation.length > 1 ? `${note}: ${parts}` : withItems);
  else await actual.addNote(txn, action === 'note' ? `${note}: ${parts}` : withItems);
  log(`  done: ${plan}`);
  return { result, summary, applied: { txnId: txn.id, action, at: new Date().toISOString() }, folder: flags.length ? config.nextcloud.review : config.nextcloud.processed };
}
