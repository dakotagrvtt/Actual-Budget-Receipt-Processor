// The local decider: asks the llama.cpp server which budget category each receipt item belongs in, with the household's
// history, keywords and category notes as context, then settles unsure items (settleUnsure). With DECIDER_PROVIDER=remote
// the request goes through decider-remote.js instead. Used by index.js and the replay tools.
import { config } from './config.js';
import { waitFor } from './llm.js';
import { categoryDescriptions, receiptLabels } from './category-notes.js';
import { TransientError } from './errors.js';
import { modelFetch } from './model-fetch.js';
import { loadKeywords, keywordsWithLearned, keywordFits, matchKeyword, keywordAction, stripDepartment } from './keywords.js';
import { remoteDecide } from './decider-remote.js';
import { cents } from './reconcile.js';
import { itemText, categoryText, similarItems, householdExamples, pastPurchases, tallyByCategory, relevantCorrections } from './item-context.js';

const EPS = 1e-9;
/** value >= bar, forgiving float error (0.6 - 0.4 is 0.19999999999999996, which still meets a 0.2 bar). */
export const atLeast = (value, bar) => value >= bar - EPS;

export { stripDepartment, similarItems, householdExamples, receiptLabels }; // keyword-cli.js, index.js and the tests import them from here


/**
 * What the categorizer knows about the purchase besides the item itself.
 * Rules by charge amount are not told to the decider: a threshold you set ("Costco under $12 is Restaurants") is not evidence
 * about the items and misled it on small charges. They still set the store's category (currentLabel, ruleLabel).
 */
function purchaseContext(receipt, history, { currentLabel, ruleLabel, occasions }) {
  return {
    ...(occasions?.length ? { birthdays_and_holidays_near_this_date: occasions } : {}),
    store: receipt.store ?? receipt.merchant,
    date: receipt.date,
    total: receipt.total,
    category_your_rules_give_this_store: ruleLabel ?? null,
    current_category_of_the_bank_transaction: currentLabel ?? null,
    ...pastPurchases(history, (p) => `${p.category} ${p.amount}${p.notes ? ` (${p.notes})` : ''}`, (h) => ({ date: h.date, amount: h.amount })),
  };
}

function criteriaFor(labels) {
  const notes = categoryDescriptions(); // yours or written by the reader model (data/category-notes.json)
  return Object.fromEntries(labels.map((l) => [l, categoryText(l, notes)]));
}

const KEYWORD_SENTENCE = ' If household_keyword is present, the household has said items matching that phrase usually belong in that category: follow it unless this receipt clearly suggests otherwise (for example, a gift).';
const QUESTION_TEXT = "Which of the household's budget categories should this receipt item be filed under? Use the category descriptions, the category the household's own rules give this store, how it filed past purchases at this store, and how it filed similar items before.";
const questionText = () => QUESTION_TEXT + (['hint', 'mixed'].includes(config.keywordMode) ? KEYWORD_SENTENCE : '');

// The per-receipt question (RECEIPT_CHECK): the same /v1/systemone choice, asked once about the whole purchase.
const RECEIPT_QUESTION_TEXT = "If this whole purchase were filed under a single budget category, which one fits best? Judge what the purchase as a whole was for, not each item alone. Use the category descriptions, the category the household's own rules give this store, how it filed past purchases at this store, and how it filed items before.";

/** What the decider is told for the per-receipt question: the purchase context and all the items, no single item. */
function receiptState(ctx, receipt, itemHistory, labels) {
  return {
    ...ctx,
    items_on_receipt: receipt.items.map((it) => ({ item: itemText(it), price: it.amount })),
    ...(config.householdExamples ? { items_this_household_filed_before: householdExamples(itemHistory, labels, config.householdExamples) } : {}),
  };
}

function itemState(ctx, receipt, i, itemHistory, labels, hint, lessons) {
  const it = receipt.items[i];
  const similar = config.similarItems ? similarItems(it, itemHistory, SIMILAR_ITEMS_SHOWN) : null;
  const fixes = relevantCorrections(it, lessons, { payee: receipt.payee ?? null, store: receipt.store ?? receipt.merchant, labels });
  return {
    ...ctx,
    item: itemText(it),
    item_price: it.amount,
    other_items_on_receipt: receipt.items.filter((_, j) => j !== i).map(itemText),
    ...(config.householdExamples ? { items_this_household_filed_before: householdExamples(itemHistory, labels, config.householdExamples) } : {}),
    ...(similar ? { similar_items_filed_before: similar, similar_items_by_category: tallyByCategory(similar) } : {}),
    ...(fixes.length ? { household_corrected_the_pipeline: fixes.map((f) => ({ item: f.item, pipeline_said: f.said, household_filed: f.filed, store: f.store })) } : {}),
    ...(hint ? { household_keyword: { phrase: hint.phrase, category: hint.category } } : {}),
  };
}

const DECIDER_TIMEOUT_MS = 5 * 60 * 1000; // per request
const ERROR_TEXT_CHARS = 300; // how much of a failed response goes into the message
const SIMILAR_ITEMS_SHOWN = 8; // past items like this one that the decider is shown

/**
 * Ask the decider. Outages, timeouts and 5xx are TransientError (the receipt isn't at fault; the cycle retries later);
 * 4xx is a plain Error. Returns the parsed JSON, or { unparsable } when a 200 body isn't JSON.
 */
async function deciderPost(name, url, body) {
  let res;
  let text;
  try {
    res = await modelFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, DECIDER_TIMEOUT_MS);
    text = await res.text(); // the timeout also covers reading the body
  } catch (err) {
    throw new TransientError(`${name} unreachable or timed out: ${err.message}`, { cause: err });
  }
  if (res.status >= 500) throw new TransientError(`${name} HTTP ${res.status}: ${text.slice(0, ERROR_TEXT_CHARS)}`);
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, ERROR_TEXT_CHARS)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { unparsable: text.slice(0, 80) };
  }
}

const brief = (v) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80));

/**
 * One decider answer, checked: the choice must be one of the labels exactly and the confidence a number in [0, 1].
 * Anything else becomes { category: null, confidence: 0, invalid }, which the main flow treats as an unsure item.
 */
export function checkAnswer(a, labels) {
  const choice = a?.choice;
  const confidence = a?.confidence;
  let invalid = null;
  if (typeof choice !== 'string' || !labels.includes(choice)) invalid = `choice ${brief(choice)} is not one of the categories`;
  else if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) invalid = `confidence ${brief(confidence)} is not a number from 0 to 1`;
  if (invalid) return { category: null, confidence: 0, invalid };
  const probabilities = labelProbabilities(a.probabilities, labels, choice);
  // With probabilities, "how sure" is the chosen category's probability and its lead over the best other one. The server's
  // own number is a normalized entropy over ~30 categories: it scores a 50/50 tie high and a clear 70% pick with a long
  // tail low. Without usable probabilities (a reply that has none, or none for the chosen label) the reported confidence
  // stands and the margin is unknown.
  return { category: choice, ...(probabilities ? { ...sureness(probabilities, choice), probabilities } : { confidence }) };
}

/** The probabilities for real labels only, each in [0, 1]; null unless there is one for the chosen label too. */
function labelProbabilities(p, labels, choice) {
  if (!p || typeof p !== 'object') return null;
  const kept = Object.fromEntries(Object.entries(p).filter(([k]) => labels.includes(k)));
  const ok = Object.values(kept).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
  return ok && typeof kept[choice] === 'number' ? kept : null;
}

/** { confidence: the choice's probability, margin: its lead over the best other category } (negative if another is ahead). */
function sureness(probabilities, choice) {
  const others = Object.entries(probabilities).filter(([k]) => k !== choice).map(([, v]) => v);
  return { confidence: probabilities[choice], margin: probabilities[choice] - Math.max(0, ...others) };
}

/**
 * Is this item sure enough to move money out of the store's usual category? Its probability must reach MOVE_MIN_CONFIDENCE
 * and lead the best other category by MOVE_MIN_MARGIN. An unknown margin (no probabilities in the answer, or a keyword
 * pick) passes, so those keep working.
 */
export const clearMove = (it) => it.confidence != null && atLeast(it.confidence, config.moveMinConfidence) && (it.margin == null || atLeast(it.margin, config.moveMinMargin));

/**
 * The decider (DECIDER_MODEL on llama.cpp, GGUF): one /v1/systemone call per item, one at a time. llama.cpp works through
 * them one by one anyway, so sending all at once only made later items of a long receipt hit the timeout.
 */
async function withDecider(receipt, labels, ctx, itemHistory, hints, skip, remote) {
  // The per-receipt question needs two items to be about more than one item, and one item the keywords did not already file.
  const askReceipt = config.receiptCheck && receipt.items.length >= 2 && skip.size < receipt.items.length;
  if (config.decider.provider === 'remote') return remoteDecider(receipt, labels, itemHistory, hints, skip, remote, askReceipt);
  if (skip.size < receipt.items.length) await waitFor(config.deciderUrl);
  const ask = async (state, instructions) => {
    const questions = { category: { type: 'choice', instructions, criteria: criteriaFor(labels) } };
    const out = await deciderPost('decider', `${config.deciderUrl}/v1/systemone`, { state, questions });
    return out?.unparsable != null ? { category: null, confidence: 0, invalid: `reply is not JSON: ${brief(out.unparsable)}` } : checkAnswer((out?.answers ?? out)?.category, labels);
  };
  const picks = [];
  for (let i = 0; i < receipt.items.length; i++) {
    picks.push(skip.has(i) ? null : await ask(itemState(ctx, receipt, i, itemHistory, labels, hints[i], remote.known?.lessons), questionText()));
  }
  if (askReceipt) picks.receipt = await ask(receiptState(ctx, receipt, itemHistory, labels), RECEIPT_QUESTION_TEXT);
  return picks;
}

/** The hosted decider (decider-remote.js): anonymized requests, answers mapped back to category labels. */
const remoteDecider = (receipt, labels, itemHistory, hints, skip, { known, keywords, history, allLabels }, askReceipt) =>
  remoteDecide({ cache: known?.deciderCache, receipt, labels, allLabels, history, itemHistory, hints, skip, known, keywords, notes: categoryDescriptions(), similar: config.similarItems, instructions: questionText(), ...(askReceipt ? { wholeInstructions: RECEIPT_QUESTION_TEXT } : {}) }, checkAnswer);

/**
 * The per-receipt answer against each item's own (RECEIPT_CHECK). When the whole-purchase answer is confident (its
 * probability reaches RECEIPT_CHECK_MIN_CONFIDENCE), an item whose own pick differs keeps it only if the pick clearly wins:
 * it passes the gate it will face in settling (`passes(item)`: CATEGORY_MIN_CONFIDENCE in the store's usual category or with
 * no store category, the move gate otherwise; clearMove when not given) and leads the receipt's category by
 * MOVE_MIN_MARGIN, by the same probabilities that gave its confidence (the reweighed ones for a keyword-hinted item). Any other item takes the
 * receipt's category, with the receipt answer's confidence and margin, so the usual settling (receipt.js settleUnsure)
 * then treats it like any item of that category: it leaves the store's usual category only if the receipt answer clears
 * the same gate. Never touched: items filed by an `always` keyword (source 'keyword'), and items with no category (an
 * invalid answer). An item with a "usually" keyword hint is judged like the others, by its reweighed numbers.
 * An item's lead over the receipt category is unknown without its probabilities (a keyword pick); then the move gate alone decides.
 * Sets item.receiptSaid ({ category, confidence, margin }, what the item said) on every item it moves, and returns them.
 */
export function applyReceiptCheck(items, answer, passes = clearMove) {
  if (!answer?.category || !atLeast(answer.confidence, config.receiptCheckMinConfidence)) return [];
  const moved = [];
  for (const it of items) {
    if (it.source === 'keyword' || it.category == null || it.category === answer.category) continue;
    const own = (it.reweighed ?? it.probabilities)?.[answer.category];
    const leads = own == null || atLeast(it.confidence - own, config.moveMinMargin);
    if (passes(it) && leads) continue;
    it.receiptSaid = { category: it.category, confidence: it.confidence, margin: it.margin ?? null };
    Object.assign(it, { category: answer.category, confidence: answer.confidence, margin: answer.margin ?? null });
    moved.push(it);
  }
  return moved;
}

/** Multiply the keyword category's probability by `weight`, renormalize; new choice (argmax), its probability (confidence) and its lead over the best other category (margin). */
export function reweigh(probabilities, category, weight) {
  const w = { ...probabilities };
  if (!(category in w)) return null;
  w[category] *= weight;
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  for (const k of Object.keys(w)) w[k] /= sum;
  const choice = Object.keys(w).reduce((a, b) => (w[b] > w[a] ? b : a));
  return { choice, ...sureness(w, choice), probabilities: w };
}

/**
 * Would this reweighted pick pass the gate settleUnsure (receipt.js) will apply? In the store's usual category it needs
 * CATEGORY_MIN_CONFIDENCE, anywhere else the move gate; with no store category to fall back on, CATEGORY_MIN_CONFIDENCE.
 */
function passesSettling(r, labels, { currentLabel, ruleLabel }) {
  const fallback = config.ruleFallback ? [currentLabel, ruleLabel].find((l) => l && labels.includes(l)) : null;
  if (!fallback || r.choice === fallback) return atLeast(r.confidence, config.categoryMinConfidence);
  return clearMove(r);
}

/** Fields categorizeItems sets on an item; cleared first so a re-run starts from nothing. */
const DECISION_FIELDS = ['source', 'keyword', 'keywordTie', 'keywordCategory', 'modelSaid', 'probabilities', 'margin', 'decided', 'keywordTooWeak', 'reweighed', 'receiptSaid'];

/**
 * A keyword hint steers the pick: the keyword category's probability is multiplied (KEYWORD_HINT_WEIGHT) and the numbers
 * recomputed. The result replaces the model's answer on `it` only if it makes the keyword's category the pick (or raises
 * confidence in it) and, for a flip, is sure enough to survive settling.
 */
function applyHintWeight(it, pick, kw, model, labels, known) {
  const r = reweigh(pick.probabilities, kw.category, config.keywordHintWeight);
  if (!r || r.choice !== kw.category || !(pick.category !== kw.category || r.confidence > pick.confidence)) return;
  // A flip must survive settling: a keyword too weak to pass the gate its pick will face is not worth losing the model's answer.
  if (r.choice !== pick.category && !passesSettling(r, labels, known)) {
    it.keywordTooWeak = { category: kw.category, confidence: r.confidence, margin: r.margin };
    return;
  }
  if (r.choice !== pick.category) it.modelSaid = { category: pick.category, confidence: pick.confidence, margin: model.margin };
  it.category = r.choice;
  it.confidence = r.confidence; // the keyword category's reweighted probability, and its lead
  it.margin = r.margin;
  it.reweighed = r.probabilities; // the distribution those numbers come from (applyReceiptCheck compares against it)
}

/**
 * Sets item.category (and item.confidence, item.margin for the decider) on every receipt item. A decider answer that wasn't a valid category
 * and confidence comes back as category null, confidence 0, with item.invalidAnswer saying what came back. `allLabels` is every category label;
 * hidden ones are removed here. Household keywords (keywords.js, KEYWORD_MODE) may file an item without the model
 * (final, or "always" keywords in mixed) or steer it (hint, or "usually" keywords in mixed); a keyword tie sets item.keywordTie instead.
 * With RECEIPT_CHECK, one more question about the whole purchase is asked (receipt.receiptCheck) and may pull items into its category (applyReceiptCheck).
 * Returns a description of the method used.
 */
export async function categorizeItems(receipt, allLabels, history, itemHistory, known) {
  const labels = receiptLabels(allLabels);
  const ctx = purchaseContext(receipt, history, known);
  const mode = config.keywordMode;
  const hints = [];
  const skip = new Set();
  const matches = [];
  // known.ignoreKeywordsFromTxn: item-test hides keywords made by #always tags on the transaction being tested
  // known.chargeCents: the whole charge in cents; a learned keyword may have a size limit on it and on the item's own price (keywordFits)
  // Keywords the worker learned from your corrections are used only with LEARNING=on (record: learned, not used), and
  // not in replay or item-test (known.ignoreLearned), which would be marked on answers it learned from you.
  const useLearned = config.learning.mode === 'on' && !known.ignoreLearned;
  // known.learnedKeywords (replay and item-test with --with-memory): the keywords the lessons up to the purchase justify, in place of the stored learned ones
  const stored = mode === 'off' ? [] : known.learnedKeywords ? await keywordsWithLearned(known.learnedKeywords) : await loadKeywords();
  const keywords = stored.filter((k) => !(known.ignoreKeywordsFromTxn && k.fromTxn === known.ignoreKeywordsFromTxn) && (useLearned || k.from !== 'learned'));
  receipt.items.forEach((it, i) => {
    for (const field of DECISION_FIELDS) delete it[field];
    const fitting = keywords.filter((k) => labels.includes(k.category) && keywordFits(k, known.chargeCents, cents(it.amount))); // a keyword for a category receipts can't use must not outrank a usable one
    const m = fitting.length ? matchKeyword([stripDepartment(it.description), it.plain], receipt.store ?? receipt.merchant, fitting) : null;
    if (m?.tie) it.keywordTie = m.tie.map((k) => `"${k.phrase}" → ${k.category}`);
    else if (m && labels.includes(m.category)) {
      matches[i] = m;
      it.keywordCategory = m.category;
      if (keywordAction(mode, m) === 'file') skip.add(i);
      else hints[i] = m;
    }
  });
  delete receipt.receiptCheck;
  const picks = await withDecider(receipt, labels, ctx, itemHistory, hints, skip, { known, keywords, history, allLabels });
  const how = config.decider.provider === 'remote' ? `${config.decider.remoteModel} (remote)` : `${config.deciderModel.split('/').pop().replace(/-GGUF.*$/i, '')} (GGUF)`;
  receipt.items.forEach((it, i) => {
    const kw = matches[i];
    if (skip.has(i)) {
      Object.assign(it, { category: kw.category, confidence: 1, source: 'keyword', keyword: kw.phrase });
      delete it.invalidAnswer;
      return;
    }
    const pick = picks[i];
    it.category = pick.category;
    it.confidence = pick.confidence;
    if (pick.probabilities) it.probabilities = pick.probabilities;
    if (pick.margin != null) it.margin = pick.margin;
    if (pick.invalid) it.invalidAnswer = pick.invalid;
    else delete it.invalidAnswer;
    const model = { category: pick.category, confidence: pick.confidence, margin: pick.margin ?? null };
    it.decided = { category: it.category, confidence: it.confidence, margin: it.margin ?? null, model }; // before settleUnsure (receipt.js), for replay
    if (!kw) return;
    it.source = 'keyword-hint';
    it.keyword = kw.phrase;
    if (config.keywordHintWeight !== 1 && pick.probabilities && !pick.invalid) applyHintWeight(it, pick, kw, model, labels, known);
    Object.assign(it.decided, { category: it.category, confidence: it.confidence, margin: it.margin ?? null });
  });
  if (picks.receipt) {
    const moved = applyReceiptCheck(receipt.items, picks.receipt, (it) => passesSettling({ choice: it.category, confidence: it.confidence, margin: it.margin }, labels, known));
    const { category, confidence, margin, probabilities, invalid } = picks.receipt;
    receipt.receiptCheck = { category, confidence, margin: margin ?? null, ...(probabilities ? { probabilities } : {}), ...(invalid ? { invalid } : {}), moved: moved.map((it) => it.description) };
  }
  return `${how}, ${labels.length} categories`;
}
