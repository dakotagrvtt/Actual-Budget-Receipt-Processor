// Anonymizing a decider request for the remote (hosted) decider. Pure functions: nothing here reads files or the network.
//
// What the remote decider gets: the item lines, the merchant name, amounts, and the household's past purchases, with
//   - every category label replaced by a code (C01, C02, ...) that only this machine can turn back into a label
//     (also a full label written inside a note or a description),
//   - every date turned into "N days before this purchase" (the purchase date itself is not sent),
//   - every name from the private-words list or the reader's name scan replaced by a pseudonym (Person A, Person B, ...);
//     the scan also reads every category name, so a person named by a category ("Kids / Alex") is hidden wherever the
//     short name is written alone; ordinary category words ("Groceries") stay as they are,
//   - every place that locates the household (city, state, street, neighbourhood; from your list or the reader's scan)
//     replaced by "a city", "a state", "a street" or "a place"; ZIP and postal codes dropped,
//   - all text normalized (NFKC) first, so "José" typed two ways is one word.
// Only fields named below are built into the request; anything else on the receipt (store clues, card digits, payment
// method, cash tendered, the printed date, addresses) has no way in. A store name is only ever the Actual payee's name
// (never the bank's raw text) with digit runs taken out, and it is scanned for people's names like the other texts.
import { config } from './config.js';
import { itemText, similarItems, householdEntries, pastPurchases, tallyByCategory, exampleText, categoryText, relevantCorrections } from './item-context.js';
import { dayDiff } from './dates.js';

// Word edges are letters only: a digit next to a name ("ALEX2", "4ALEX") does not hide it. Combining marks stay with their letter.
const LETTER = '\\p{L}\\p{M}';
// After a name only a letter blocks the match: a combining mark or other mark glued to it ("ALEX" + accent) is still the name.
const AFTER = '\\p{L}';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Compatibility-normalized text (NFKC): "José" as e + accent or as one character is the same string. Invisible format
 * characters (zero-width space and joiner, soft hyphen...) are taken out, so "A<ZWSP>LEX" is ALEX.
 */
export const norm = (s) => String(s).normalize('NFKC').replace(/\p{Cf}/gu, '');
const lower = (s) => norm(s).toLowerCase();

/** Pseudonym for place i of the persisted order: Person A ... Person Z, Person AA, ... */
export function pseudonym(i) {
  let n = i;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Person ${letters}`;
}

// A word on its own: not glued to other letters. A trailing 's / ’s (possessive) is allowed.
const wordPattern = (word) => escapeRe(norm(word).trim()).replace(/\s+/g, '\\s+');
const wholeWord = (words, tail = '') => new RegExp(`(?<![${LETTER}])(${words.map(wordPattern).join('|')})${tail}(?![${AFTER}])`, 'giu');

// Business names that stay readable inside a text. Only an exact whole-word occurrence of the full name is protected
// (any case; ' and ’ count the same); every other occurrence of a hidden word is still replaced.
const spanPattern = (span) => escapeRe(norm(span).trim()).replace(/['’]/g, "['’]").replace(/\s+/g, '\\s+');
export function spanRegex(spans) {
  const list = [...new Set(spans.filter((x) => typeof x === 'string').map((x) => norm(x).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return list.length ? new RegExp(`(?<![${LETTER}])(?:${list.map(spanPattern).join('|')})(?![${AFTER}])`, 'giu') : null;
}
const MARK_OPEN = '';
const MARK_CLOSE = '';

/** Run `fn` on the text with every protected span swapped for a placeholder, then put the spans back. */
function aroundSpans(text, re, fn) {
  if (!re) return fn(text);
  const kept = [];
  const masked = text.replace(/[]/g, ' ').replace(new RegExp(re), (m) => `${MARK_OPEN}${kept.push(m) - 1}${MARK_CLOSE}`);
  return fn(masked).replace(/(\d+)/g, (_, i) => kept[Number(i)] ?? '');
}

/**
 * Replace every listed word (whole word, any case, possessives kept: "Alex's" -> "Person A's") with its pseudonym.
 * `entries` = [{ word, pseudo }]. `protect` = business names that stay as they are wherever they appear in full
 * ("Papa John's" stays, but a lone "John" is still replaced). Returns scrub(text).
 */
export function makeScrubber(entries, { protect = [], places = [] } = {}) {
  const hidePlaces = makePlaceScrubber(places);
  if (!entries.length && !places.length) return (text) => norm(text);
  const byWord = new Map(entries.map((e) => [lower(e.word).replace(/\s+/g, ' '), e.pseudo]));
  const longestFirst = entries.map((e) => e.word).sort((a, b) => b.length - a.length);
  const re = entries.length ? wholeWord(longestFirst, "((?:['’]s)?)") : null;
  const keep = spanRegex(protect);
  const hide = (t) => (re ? t.replace(re, (_, word, possessive) => `${byWord.get(lower(word).replace(/\s+/g, ' ')) ?? 'Person'}${possessive}`) : t);
  // Places go first and are never kept: not even inside a business name that is otherwise kept whole.
  return (text) => aroundSpans(hidePlaces(norm(text)), keep, hide);
}

/** True if every word of the name (2+ letters; 's and punctuation ignored) is one of `words`, so nothing readable would be left. */
export function onlyWordsFrom(name, words) {
  const own = wordsIn(name).filter((w) => w.length >= 2).map(lower);
  const set = new Set(words.map(lower));
  return own.every((w) => set.has(w));
}

/** True if the text holds any of the words as a whole word. */
export const hasWord = (text, words) => words.length > 0 && wholeWord(words).test(norm(text));

/** Pseudonym entries for the words to hide: each word's place in the persisted `order` gives its letter. */
export function pseudonymEntries(words, order) {
  const place = (w) => order.indexOf(lower(w));
  return words.map((word) => ({ word, pseudo: pseudonym(place(word) >= 0 ? place(word) : order.length + words.indexOf(word)) }));
}

const wordsIn = (s) => norm(s).match(new RegExp(`[${LETTER}]+`, 'gu')) ?? [];

/**
 * The words of flagged names worth hiding: not on your "not a name" list, 2+ letters. Returns single words as
 * written, once each. A business name does not excuse a word here: it only protects its own full span inside a text
 * (see makeScrubber).
 */
export function dropKnownNames(names, { notNames = [] }) {
  const skip = new Set(notNames.flatMap(wordsIn).map(lower));
  const out = new Map();
  for (const name of names) for (const w of wordsIn(name)) if (w.length >= 2 && !skip.has(lower(w)) && !out.has(lower(w))) out.set(lower(w), w);
  return [...out.values()];
}

// Places: no letters of their own, just a neutral word for what kind of place was there.
const PLACE_TOKEN = { city: 'a city', state: 'a state', street: 'a street', place: 'a place', zip: '' };
export const PLACE_TYPES = Object.keys(PLACE_TOKEN);
// Words of the tokens themselves, countries on their own: never treated as a place (they would hit "a city" or "US").
const NOT_PLACES = new Set(['a', 'city', 'state', 'street', 'place', 'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'america']);
/** A place entry the scrubber and the leak check can use: { word, type } with a word of 3+ characters that is not a token word. */
export const usablePlace = (p) => {
  const w = norm(p?.word ?? '').trim();
  return w.length >= 3 && !NOT_PLACES.has(w.toLowerCase()) && /[\p{L}\p{N}]/u.test(w);
};
const ALNUM = '\\p{L}\\p{N}';
/**
 * A place as a pattern: its words with anything (or nothing) that is not a letter or digit between them, so "Fake Falls"
 * also finds "FAKE-FALLS", "FAKE  FALLS" and "FakeFalls". Edges are letters AND digits ("123" is not inside "12345").
 */
const placeRegex = (words) => {
  const alt = words.map((w) => norm(w).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escapeRe).join(`[^${ALNUM}]*`)).filter(Boolean).sort((a, b) => b.length - a.length);
  return alt.length ? new RegExp(`(?<![${ALNUM}])(?:${alt.join('|')})(?![${ALNUM}])`, 'giu') : null;
};
const CITY_MARK = '\uE002';

/**
 * Scrub function for places: [{ word, type }] -> text with each place swapped for its neutral word (ZIP codes removed).
 * A state code (two capitals, not "US") and a ZIP code right after a replaced city go with it ("FAKE FALLS IL 62704").
 */
function makePlaceScrubber(places) {
  const list = places.filter(usablePlace).sort((a, b) => b.word.length - a.word.length);
  const compiled = list.map((p) => ({ re: placeRegex([p.word]), type: PLACE_TYPES.includes(p.type) ? p.type : 'place' })).filter((c) => c.re);
  if (!compiled.length) return (text) => text;
  return (text) => {
    let out = text.replace(/\uE002/g, ' ');
    let changed = false;
    for (const { re, type } of compiled) {
      out = out.replace(re, () => {
        changed = true;
        return type === 'city' ? CITY_MARK : PLACE_TOKEN[type];
      });
    }
    if (!changed) return text;
    out = out.replace(/\uE002(?:[ ,]+(?!US\b)[A-Z]{2}\b)?(?:[ ,]*\d{5}(?:-\d{4})?(?![\p{L}\p{N}]))?/gu, 'a city');
    return out.replace(/\s{2,}/g, ' ').trim();
  };
}

/** Category codes for one request: the choices get C01, C02, ... in order; a label seen elsewhere gets X01, X02, ... */
export function makeCodes(labels) {
  const toCode = new Map();
  const toLabel = new Map();
  const add = (label, code) => {
    toCode.set(label, code);
    toLabel.set(code, label);
  };
  const pad = (n) => String(n).padStart(2, '0');
  labels.forEach((l, i) => add(l, `C${pad(i + 1)}`));
  let extra = 0;
  return {
    code: (label) => {
      if (label == null) return null;
      if (!toCode.has(label)) add(label, `X${pad(++extra)}`);
      return toCode.get(label);
    },
    label: (code) => (labels.includes(toLabel.get(code)) ? toLabel.get(code) : undefined),
    all: () => [...toCode.keys()],
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "12 days before this purchase". */
export function relativeDay(day, refDay) {
  if (!day || !refDay) return null;
  const n = dayDiff(refDay, day);
  if (Number.isNaN(n)) return null;
  if (n === 0) return 'the same day as this purchase';
  return n > 0 ? `${plural(n, 'day')} before this purchase` : `${plural(-n, 'day')} after this purchase`;
}

/**
 * Occasions near the purchase, without names: only a holiday from the built-in list keeps its public name; anything
 * else (a birthday, an event from your calendar, whatever a calendar calls itself) becomes "a birthday or personal
 * occasion". `occasion` = { name, builtin, when } (calendar.js occasionDetails); a plain string (calendar.js text) has no
 * trustworthy source, so it never keeps a name.
 */
export function anonymizeOccasion(occasion) {
  const o = typeof occasion === 'string' ? parseOccasionText(occasion) : occasion;
  if (!o?.when) return 'an occasion near this purchase';
  const when = String(o.when).replace(/ the purchase$/, ' this purchase');
  return `${o.builtin === true ? `${o.name} (US holiday)` : 'a birthday or personal occasion'}, ${when}`;
}
const parseOccasionText = (text) => {
  const m = /^.* \([^)]*\) on \d{4}-\d\d-\d\d, (.+)$/.exec(text);
  return m ? { builtin: false, when: m[1] } : null;
};

const byCode = (codes, map) => Object.fromEntries(Object.entries(map).map(([label, v]) => [codes.code(label), v]));
/** Digit runs of 3+ (card digits, store numbers, ZIP codes) are taken out of a store name. */
const stripDigits = (s) => s.replace(/\d{3,}/g, ' ').replace(/\s+/g, ' ').trim();
/** A store name as it is scanned and sent: normalized, digit runs taken out. */
export const storeClean = (name) => stripDigits(norm(name));

/** Replaces every full category label in a text with its code (case does not matter; the same code as everywhere else). */
function labelCoder(labels, codes) {
  const full = [...new Set(labels.filter((l) => typeof l === 'string' && l.includes(' / ')))].sort((a, b) => b.length - a.length);
  if (!full.length) return (text) => text;
  const squash = (l) => lower(l).replace(/\s+/g, ' ');
  const byText = new Map(full.map((l) => [squash(l), l]));
  const re = new RegExp(full.map((l) => escapeRe(norm(l)).replace(/\s+/g, '\\s+')).join('|'), 'giu');
  return (text) => text.replace(re, (m) => codes.code(byText.get(squash(m))) ?? m);
}

/**
 * The anonymized request body for item `index` (or, with `whole: true`, for the per-receipt question about the whole
 * purchase: all the items with their prices instead of one item, no keyword hint, similar items or corrections), and the
 * codes needed to read the answer.
 * `scrub(text, kind)` is applied to every piece of free text that goes into it (kind: item | note | category | keyword |
 * similar | store | occasion), after normalizing it and replacing any category label in it with a code; so the same
 * function can first collect what will be sent (to scan it for names) and then do the replacing.
 * input: { labels, allLabels (every category in the budget), receipt (payee = the Actual payee entity name of the
 *          charge, if it is a real one; no payee, no store is sent), realPayees (names of real, non-transfer Actual payees: the only store names
 *          that may be sent), index, history, itemHistory (entries may carry payee), known: { ruleLabel, currentLabel,
 *          occasions, occasionDetails }, hint, notes, similar (bool), instructions (wholeInstructions for `whole`), model, today }
 */
export function buildRemoteRequest(input, scrub) {
  const { labels, receipt, index, history, itemHistory, known = {}, hint, notes = {}, model, whole = false } = input;
  const instructions = whole ? input.wholeInstructions : input.instructions;
  const codes = makeCodes(labels);
  const refDay = receipt.date ?? input.today;
  const it = whole ? null : receipt.items[index];
  const coded = labelCoder([...labels, ...(input.allLabels ?? [])], codes);
  const text = (s, kind) => scrub(coded(norm(s)), kind);
  // Store names: the payee's own name only, and only if it is a real Actual payee.
  const real = new Set((input.realPayees ?? []).map((p) => lower(p).trim()));
  const storeText = (name) => {
    if (typeof name !== 'string' || !real.has(lower(name).trim())) return null;
    const clean = storeClean(name);
    return clean ? text(clean, 'store') : null;
  };
  const store = storeText(receipt.payee);
  const payeeFor = new Map(itemHistory.map((h) => [`${h.items}\n${h.store}`, h.payee]));
  const examplePayee = (e) => storeText(payeeFor.get(`${e.items}\n${e.store}`));
  const similar = !whole && input.similar ? similarItems(it, itemHistory, 8) : null;
  const examples = config.householdExamples ? householdEntries(itemHistory, labels, config.householdExamples) : null;
  // Your corrections that look like this item. The text is scanned like a past note; stores only as an Actual payee's name.
  const fixes = whole ? [] : relevantCorrections(it, known.lessons, { payee: receipt.payee ?? null, labels });
  const part = (p) => `${codes.code(p.category)} ${p.amount}${p.notes ? ` (${text(p.notes, 'note')})` : ''}`;
  const example = (e) => {
    return exampleText(e, text(e.items, 'note'), examplePayee(e));
  };
  const state = {
    ...(known.occasionDetails?.length || known.occasions?.length ? { birthdays_and_holidays_near_this_date: (known.occasionDetails ?? known.occasions).map(anonymizeOccasion) } : {}),
    store,
    total: receipt.total,
    category_your_rules_give_this_store: codes.code(known.ruleLabel ?? null),
    current_category_of_the_bank_transaction: codes.code(known.currentLabel ?? null),
    ...pastPurchases(history, part, (h) => ({ when: relativeDay(h.date, refDay), amount: h.amount })),
    ...(whole
      ? { items_on_receipt: receipt.items.map((o) => ({ item: text(itemText(o), 'item'), price: o.amount })) }
      : { item: text(itemText(it), 'item'), item_price: it.amount, other_items_on_receipt: receipt.items.filter((_, j) => j !== index).map((o) => text(itemText(o), 'item')) }),
    ...(examples ? { items_this_household_filed_before: byCode(codes, Object.fromEntries(Object.entries(examples).map(([label, list]) => [label, list.map(example)]))) } : {}),
    ...(similar
      ? {
          similar_items_filed_before: similar.map((s) => ({ items: text(s.items, 'similar'), filed_as: codes.code(s.filed_as), store: examplePayee(s), ...(s.filed_by ? { filed_by: s.filed_by } : {}) })),
          similar_items_by_category: byCode(codes, tallyByCategory(similar)),
        }
      : {}),
    ...(fixes.length ? { household_corrected_the_pipeline: fixes.map((f) => ({ item: text(f.item, 'similar'), pipeline_said: codes.code(f.said), household_filed: codes.code(f.filed), store: storeText(f.payee) })) } : {}),
    ...(hint && !whole ? { household_keyword: { phrase: text(hint.phrase, 'keyword'), category: codes.code(hint.category) } } : {}),
  };
  // Built after the state: the labels seen there that aren't choices got their X codes already.
  const criteria = Object.fromEntries(labels.map((l) => [codes.code(l), text(categoryText(l, notes), 'category')]));
  const questions = { category: { type: 'choice', instructions, criteria } };
  return { body: { model, state, questions }, codes };
}

/** The answer with codes turned back into labels: { choice, confidence, probabilities }. Unknown codes stay as they are (they fail checkAnswer). */
export function decodeAnswer(answer, codes) {
  if (!answer || typeof answer !== 'object') return answer;
  const out = { ...answer, choice: typeof answer.choice === 'string' ? (codes.label(answer.choice) ?? answer.choice) : answer.choice };
  if (answer.probabilities && typeof answer.probabilities === 'object') {
    out.probabilities = Object.fromEntries(Object.entries(answer.probabilities).filter(([c]) => codes.label(c) !== undefined).map(([c, p]) => [codes.label(c), p]));
  }
  return out;
}

/**
 * Where the finished request still holds something it must not: a category label (any in the budget), or a listed/found
 * word. `found` = the words that came from the name scan (so a leak can say which kind). `protect` = the business
 * names makeScrubber was told to keep; they are not looked into.
 * `places` = [{ word, type }] hidden places. Returns [{ path, kind }]: the field (never its value), e.g. "state.item", and
 * "category label" | "listed word" | "found name" | "place".
 */
export function findLeaks(body, { labels, words, found = [], protect = [], places = [] }) {
  const forbiddenLabels = labels.map(lower).filter(Boolean);
  const foundSet = new Set(found.map(lower));
  const wordRe = words.length ? wholeWord(words) : null;
  const placeWords = places.filter(usablePlace).map((p) => p.word);
  const placeRe = placeRegex(placeWords);
  const keep = spanRegex(protect);
  // What is wrong with this string, or null.
  const kindOf = (raw, whole = false) => {
    const s = norm(raw);
    if (forbiddenLabels.some((x) => s.toLowerCase().includes(x))) return 'category label';
    const visible = keep ? s.replace(new RegExp(keep), ' ') : s;
    // Places are looked for in the full string, protected spans or not; the serialized check skips them (a number there is a price).
    if (placeRe && !whole && new RegExp(placeRe).test(s)) return 'place';
    if (wordRe === null) return null;
    const m = new RegExp(wordRe).exec(visible);
    if (!m) return null;
    return foundSet.has(lower(m[1])) ? 'found name' : 'listed word';
  };
  const leaks = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const kind = kindOf(v);
      if (kind) leaks.push({ path, kind });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const kind = kindOf(k);
        if (kind) leaks.push({ path: `${path} (a key)`, kind });
        walk(x, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(body, '');
  // The whole serialized request, as the last line of defense against anything the walk didn't see.
  if (!leaks.length) {
    const kind = kindOf(JSON.stringify(body), true);
    if (kind) leaks.push({ path: 'the request', kind });
  }
  return leaks;
}

/** "state.item (listed word), state.store (found name)": for the log and the review reason. Never a value. */
export const describeLeaks = (leaks) => leaks.map((l) => `${l.path} (${l.kind})`).join(', ');
