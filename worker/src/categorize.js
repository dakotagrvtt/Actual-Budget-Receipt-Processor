import { config } from './config.js';
import { waitFor } from './llm.js';
import { categoryDescriptions } from './category-notes.js';
import { TransientError } from './errors.js';
import { loadKeywords, matchKeyword, keywordAction, normalize, stripDepartment } from './keywords.js';

export { stripDepartment }; // keyword-cli.js and the tests import it from here

/** Labels receipts may use: everything except EXCLUDE_CATEGORY_GROUPS / EXCLUDE_CATEGORIES (bills, debt, savings). */
export function receiptLabels(labels) {
  return labels.filter((l) => !config.excludeGroups.includes(l.split(' / ')[0]) && !config.excludeCategories.includes(l));
}

const itemText = (it) => {
  const name = stripDepartment(it.description);
  return it.plain && it.plain.toLowerCase() !== it.description.toLowerCase() ? `${name} (${it.plain})` : name;
};
/** Words of 3+ chars (keywords.js normalize), plus the whole text run together when 2-12 chars: "M&M'S" -> "mms". */
const tokens = (s) => {
  const n = normalize(s);
  const set = new Set(n.split(' ').filter((t) => t.length >= 3));
  const joined = n.replace(/ /g, '');
  if (joined.length >= 2 && joined.length <= 12) set.add(joined);
  return set;
};

/** The past items (from any store) that share the most words with this item. */
export function similarItems(item, itemHistory, limit = 8) {
  const mine = tokens(itemText(item));
  return itemHistory
    .map((h) => {
      const theirs = tokens(h.items);
      const shared = [...mine].filter((t) => theirs.has(t)).length;
      return { ...h, score: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((h) => ({ items: h.items, filed_as: h.category, store: h.store }));
}

/** What the categorizer knows about the purchase besides the item itself. */
function purchaseContext(receipt, history, { currentLabel, ruleLabel, occasions }) {
  return {
    ...(occasions?.length ? { birthdays_and_holidays_near_this_date: occasions } : {}),
    store: receipt.store ?? receipt.merchant,
    date: receipt.date,
    total: receipt.total,
    category_your_rules_give_this_store: ruleLabel ?? null,
    current_category_of_the_bank_transaction: currentLabel ?? null,
    past_purchases_at_this_store: history.map((h) => ({
      date: h.date,
      amount: h.amount,
      filed_as: h.parts.map((p) => `${p.category} ${p.amount}${p.notes ? ` (${p.notes})` : ''}`),
    })),
  };
}

function criteriaFor(labels) {
  const notes = categoryDescriptions(); // yours or written by the reader model (data/category-notes.json)
  return Object.fromEntries(
    labels.map((l) => {
      const [group, name] = l.split(' / ');
      return [l, notes[l] ? `${name}: ${notes[l]}` : `The "${name}" budget category (group: ${group})`];
    }),
  );
}

const KEYWORD_SENTENCE = ' If household_keyword is present, the household has said items matching that phrase usually belong in that category: follow it unless this receipt clearly suggests otherwise (for example, a gift).';
const QUESTION_TEXT = "Which of the household's budget categories should this receipt item be filed under? Use the category descriptions, the category the household's own rules give this store, how it filed past purchases at this store, and how it filed similar items before.";
const questionText = () => QUESTION_TEXT + (['hint', 'mixed'].includes(config.keywordMode) ? KEYWORD_SENTENCE : '');

/**
 * Every item note this household wrote (or the pipeline wrote), grouped by category, newest first, with the store.
 * Small enough to give whole: it shows who buys what ("Egg Book @thrift shop → Child", "DC Charger → Adult 1").
 */
function householdExamples(itemHistory, labels, perCategory = 15) {
  const out = {};
  for (const h of itemHistory) {
    if (!labels.includes(h.category)) continue;
    const list = (out[h.category] ??= []);
    if (list.length < perCategory) list.push(h.store ? `${h.items} (at ${h.store})` : h.items);
  }
  return out;
}

function itemState(ctx, receipt, i, itemHistory, labels, hint) {
  const it = receipt.items[i];
  const similar = config.similarItems ? similarItems(it, itemHistory, 8) : null;
  return {
    ...ctx,
    item: itemText(it),
    item_price: it.amount,
    other_items_on_receipt: receipt.items.filter((_, j) => j !== i).map(itemText),
    items_this_household_filed_before: householdExamples(itemHistory, labels),
    ...(similar ? { similar_items_filed_before: similar, similar_items_by_category: similar.reduce((o, s) => ({ ...o, [s.filed_as]: (o[s.filed_as] ?? 0) + 1 }), {}) } : {}),
    ...(hint ? { household_keyword: { phrase: hint.phrase, category: hint.category } } : {}),
  };
}

const DECIDER_TIMEOUT_MS = 5 * 60 * 1000; // per request

/**
 * Ask the decider. Outages, timeouts and 5xx are TransientError (the receipt isn't at fault; the cycle retries later);
 * 4xx is a plain Error. Returns the parsed JSON, or { unparsable } when a 200 body isn't JSON.
 */
async function deciderPost(name, url, body) {
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS) });
    text = await res.text(); // the timeout also covers reading the body
  } catch (err) {
    throw new TransientError(`${name} unreachable or timed out: ${err.message}`, { cause: err });
  }
  if (res.status >= 500) throw new TransientError(`${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
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
  const p = a.probabilities;
  const probabilities = p && typeof p === 'object' && Object.values(p).every((v) => typeof v === 'number' && Number.isFinite(v)) ? p : null;
  return { category: choice, confidence, ...(probabilities ? { probabilities } : {}) };
}

/**
 * The decider (DECIDER_MODEL on llama.cpp, GGUF): one /v1/systemone call per item, one at a time. llama.cpp works through
 * them one by one anyway, so sending all at once only made later items of a long receipt hit the timeout.
 */
async function withDecider(receipt, labels, ctx, itemHistory, hints, skip) {
  if (skip.size < receipt.items.length) await waitFor(config.deciderUrl);
  const questions = { category: { type: 'choice', instructions: questionText(), criteria: criteriaFor(labels) } };
  const picks = [];
  for (let i = 0; i < receipt.items.length; i++) {
    if (skip.has(i)) {
      picks.push(null);
      continue;
    }
    const out = await deciderPost('decider', `${config.deciderUrl}/v1/systemone`, { state: itemState(ctx, receipt, i, itemHistory, labels, hints[i]), questions });
    picks.push(out?.unparsable != null ? { category: null, confidence: 0, invalid: `reply is not JSON: ${brief(out.unparsable)}` } : checkAnswer((out?.answers ?? out)?.category, labels));
  }
  return picks;
}

/** The decider's confidence as computed server-side: 1 - H(p)/ln(n), the normalized entropy over the n categories. */
export function entropyConfidence(probs) {
  const p = Object.values(probs);
  if (p.length < 2) return 1;
  const h = -p.reduce((s, x) => s + (x > 0 ? x * Math.log(x) : 0), 0);
  return 1 - h / Math.log(p.length);
}

/** Multiply the keyword category's probability by `weight`, renormalize; new choice (argmax) and confidence. */
export function reweigh(probabilities, category, weight) {
  const w = { ...probabilities };
  if (!(category in w)) return null;
  w[category] *= weight;
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  for (const k of Object.keys(w)) w[k] /= sum;
  const choice = Object.keys(w).reduce((a, b) => (w[b] > w[a] ? b : a));
  return { choice, confidence: entropyConfidence(w), pChoice: w[choice], pCategory: w[category] };
}

/**
 * Sets item.category (and item.confidence for the decider) on every receipt item. A decider answer that wasn't a valid category
 * and confidence comes back as category null, confidence 0, with item.invalidAnswer saying what came back. `allLabels` is every category label;
 * hidden ones are removed here. Household keywords (keywords.js, KEYWORD_MODE) may file an item without the model
 * (final, or "always" keywords in mixed) or steer it (hint, or "usually" keywords in mixed); a keyword tie sets item.keywordTie instead. Returns a description of the method used.
 */
export async function categorizeItems(receipt, allLabels, history, itemHistory, known) {
  const labels = receiptLabels(allLabels);
  const ctx = purchaseContext(receipt, history, known);
  const mode = config.keywordMode;
  const hints = [];
  const skip = new Set();
  const matches = [];
  // known.ignoreKeywordsFromTxn: item-test hides keywords made by #always tags on the transaction being tested
  const keywords = mode === 'off' ? [] : (await loadKeywords()).filter((k) => !(known.ignoreKeywordsFromTxn && k.fromTxn === known.ignoreKeywordsFromTxn));
  receipt.items.forEach((it, i) => {
    delete it.source;
    delete it.keyword;
    delete it.keywordTie;
    delete it.keywordCategory;
    delete it.modelSaid;
    delete it.probabilities;
    const m = keywords.length ? matchKeyword([stripDepartment(it.description), it.plain], receipt.store ?? receipt.merchant, keywords) : null;
    if (m?.tie) it.keywordTie = m.tie.map((k) => `"${k.phrase}" → ${k.category}`);
    else if (m && labels.includes(m.category)) {
      matches[i] = m;
      it.keywordCategory = m.category;
      if (keywordAction(mode, m) === 'file') skip.add(i);
      else hints[i] = m;
    }
  });
  const picks = await withDecider(receipt, labels, ctx, itemHistory, hints, skip);
  const how = `${config.deciderModel.split('/').pop().replace(/-GGUF.*$/i, '')} (GGUF)`;
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
    if (pick.invalid) it.invalidAnswer = pick.invalid;
    else delete it.invalidAnswer;
    if (!kw) return;
    it.source = 'keyword-hint';
    it.keyword = kw.phrase;
    // Its confidence is the entropy formula, which we can recompute.
    if (config.keywordHintWeight !== 1 && pick.probabilities && !pick.invalid) {
      const r = reweigh(pick.probabilities, kw.category, config.keywordHintWeight);
      // Use it only if it makes the keyword's category the pick (or raises confidence in it); else keep the model's own.
      if (r && r.choice === kw.category && (pick.category !== kw.category || r.confidence > pick.confidence)) {
        if (r.choice !== pick.category) it.modelSaid = { category: pick.category, confidence: pick.confidence };
        it.category = r.choice;
        // A flipped pick is only as sure as the keyword category's own reweighted probability.
        it.confidence = r.choice !== pick.category ? r.pCategory : r.confidence;
      }
    }
  });
  return `${how}, ${labels.length} categories`;
}
