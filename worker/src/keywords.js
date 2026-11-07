// Household keywords: "items matching this phrase belong in this category". Stored in KEYWORDS_PATH
// (default /data/keywords.json, i.e. data/keywords.json on the host) as
//   {"keywords":[{"phrase":"Gold Bond","category":"Daily Expenses / Sam","store":null,"added":"2026-11-06","from":"cli"}]}
// - phrase:   matched against item text as whole tokens (see matchKeyword); plurals and "DRPEPPER"-style run-ons work
// - category: the exact category label
// - store:    null = any store; or a store name that must appear (as whole words) in the receipt's store
// - strength: "always" (KEYWORD_MODE=mixed files it without the model) or "usually" (mixed: the model sees it as a hint); missing = "usually"
// - from:     "cli" (./receipts keyword add), "actual" (an `#always` / `#usually` tag in a transaction note) or "learned"
//             (the worker saw you correct the same item the same way, learning.js; always scoped to one store; yours beat it).
//             A learned keyword may carry size limits: maxCents (the whole charge) and maxItemCents (the item's own price).
// "removed" lists phrases taken out with the CLI so an #always tag doesn't bring them back; a CLI add clears the entry.
// "fromTxn" (actual keywords) is the transaction whose tag made it. A missing file means no keywords. Writes are atomic (tmp file + rename).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, log } from './config.js';
import { today } from './dates.js';
import { withLock } from './file-lock.js';
import { mkdirPrivate, writePrivate } from './private-files.js';

// Letters that do not decompose into a base letter plus a combining mark.
const TRANSLITERATE = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', þ: 'th', ð: 'd', ı: 'i' };

/** Lowercase, accents removed (é→e, ø→o), apostrophes deleted, ASCII letters and digits separated, other punctuation to spaces. Other scripts (Cyrillic, CJK) are kept as words. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[øæœßłđþðı]/g, (c) => TRANSLITERATE[c])
    .replace(/['’]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Store department codes like "MED-" (media) or "BED-" (bedding) mislead the categorizer ("MED" reads as medical),
 * so a short all-caps prefix before a hyphen is dropped from what the model sees. The receipt keeps the original.
 */
export const stripDepartment = (s) => (config.stripDepartmentPrefixes ? s.replace(/^[A-Z]{2,4}-(?=\S)/, '') : s);

const toks = (s) => normalize(s).split(' ').filter(Boolean);
/** Equal, or one side is the other plus a plural s/es (the longer side must be over 3 chars). */
const sameToken = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.length > 3 && (long === `${short}s` || long === `${short}es`);
};
/** Do consecutive whole tokens (at least `min` of them), run together, spell `joined` ("DR PEPPER" / "DRPEPPER")? */
const runsJoined = (text, joined, min) => {
  for (let i = 0; i < text.length; i++) {
    let acc = '';
    for (let j = i; j < text.length && acc.length <= joined.length; j++) {
      acc += text[j];
      if (j - i + 1 >= min && sameToken(acc, joined)) return true;
    }
  }
  return false;
};
const hasRun = (text, phrase) => {
  for (let i = 0; i + phrase.length <= text.length; i++) if (phrase.every((p, j) => sameToken(text[i + j], p))) return true;
  return false;
};

async function loadAll() {
  let text;
  try {
    text = await fs.readFile(config.keywordsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { keywords: [], removed: [] };
    throw err;
  }
  const j = JSON.parse(text);
  return { keywords: Array.isArray(j?.keywords) ? j.keywords : [], removed: Array.isArray(j?.removed) ? j.removed : [] };
}

export const loadKeywords = async () => (await loadAll()).keywords;

async function save(keywords, removed) {
  await mkdirPrivate(path.dirname(config.keywordsPath));
  const tmp = `${config.keywordsPath}.tmp-${crypto.randomUUID()}`;
  await writePrivate(tmp, JSON.stringify({ keywords, ...(removed.length ? { removed } : {}) }, null, 2) + '\n');
  await fs.rename(tmp, config.keywordsPath);
}

/** Load-modify-save under a lock file (see file-lock.js). */
const locked = (fn) => withLock(`${config.keywordsPath}.lock`, fn);

const isLearned = (k) => k.from === 'learned';
const sameKey = (k, phrase, store) => normalize(k.phrase) === normalize(phrase) && normalize(k.store) === normalize(store);

/** The keyword with this phrase and store, or undefined. */
export const findKeyword = (keywords, phrase, store = null) => keywords.find((k) => sameKey(k, phrase, store));

const makeEntry = ({ phrase, category, store = null, strength = 'usually', from = 'cli', fromTxn, maxCents, maxItemCents }) => ({
  phrase: phrase.trim(), category, store: store?.trim() || null, strength: strength === 'always' ? 'always' : 'usually',
  added: today(), from, ...(fromTxn ? { fromTxn } : {}),
  ...(from === 'learned' && Number.isFinite(maxCents) ? { maxCents } : {}),
  ...(from === 'learned' && Number.isFinite(maxItemCents) ? { maxItemCents } : {}),
});

// A size is known when it is a positive number; an unknown one (missing, zero, negative) fails a limit.
const within = (limit, cents) => !Number.isFinite(limit) || (Number.isFinite(cents) && cents > 0 && cents <= limit);

/**
 * Does a keyword apply to this charge and this item? Only learned keywords are limited, by the charge (maxCents) and by the
 * item's own price (maxItemCents); both must pass. An unknown size fails a limit that is set. A keyword without a limit
 * (yours, or learned before item prices were kept) doesn't look at that size.
 */
export const keywordFits = (k, chargeCents, itemCents) => !isLearned(k) || (within(k.maxCents, chargeCents) && within(k.maxItemCents, itemCents));

/** Add a keyword, replacing one with the same normalized phrase and store. Returns the new entry. */
export const addKeyword = (kw) =>
  locked(async () => {
    const all = await loadAll();
    const keywords = all.keywords.filter((k) => !sameKey(k, kw.phrase, kw.store ?? null));
    const entry = makeEntry(kw);
    keywords.push(entry);
    await save(keywords, all.removed.filter((k) => !sameKey(k, kw.phrase, kw.store ?? null)));
    return entry;
  });

/**
 * Put a removed keyword back as it was (keeps its own `added`, `from` and `fromTxn`) and clear its tombstone, so it
 * behaves as if never removed. Returns the entry, or null when the same phrase and store are on the list already.
 */
export const restoreKeyword = (kw) =>
  locked(async () => {
    const all = await loadAll();
    if (all.keywords.some((k) => sameKey(k, kw.phrase, kw.store ?? null))) return null;
    const entry = { ...makeEntry(kw), ...(kw.added ? { added: kw.added } : {}) };
    all.keywords.push(entry);
    await save(all.keywords, all.removed.filter((k) => !sameKey(k, kw.phrase, kw.store ?? null)));
    return entry;
  });

/** Remove the keyword with this phrase and store (and remember it, so #always doesn't re-add it). Returns how many were removed. */
export const removeKeyword = (phrase, store = null) =>
  locked(async () => {
    const all = await loadAll();
    const kept = all.keywords.filter((k) => !sameKey(k, phrase, store));
    const removed = all.removed.filter((k) => !sameKey(k, phrase, store));
    if (kept.length !== all.keywords.length) removed.push({ phrase: phrase.trim(), store: store?.trim() || null });
    if (kept.length !== all.keywords.length || removed.length !== all.removed.length) await save(kept, removed);
    return all.keywords.length - kept.length;
  });

/**
 * Which keyword applies to an item. `texts` = the item text after stripDepartment, plus the reader's plain name.
 * A keyword matches when its tokens are consecutive whole tokens of a text (plural s/es allowed on either side), or,
 * for multi-word phrases, when the text without spaces contains the phrase without spaces ("DRPEPPER").
 * Best = store-scoped over global, then more tokens, then longer phrase. Returns the keyword, null, or
 * {tie: [keywords]} when the best candidates disagree on the category.
 */
export function matchKeyword(texts, store, keywords) {
  const mine = texts.filter(Boolean).map((t) => toks(t));
  const storeToks = toks(store);
  const cands = [];
  for (const k of keywords) {
    const p = toks(k.phrase);
    if (!p.length) continue;
    if (k.store) {
      const s = toks(k.store);
      if (!s.length || !hasRun(storeToks, s)) continue;
    }
    const joined = p.join('');
    const hit = mine.some((t) => hasRun(t, p) || runsJoined(t, joined, p.length > 1 ? 1 : joined.length >= 5 ? 2 : Infinity));
    if (hit) cands.push({ k, rank: [k.store ? 1 : 0, p.length, joined.length] });
  }
  if (!cands.length) return null;
  // A keyword you made beats one the worker learned.
  const yours = cands.filter((c) => !isLearned(c.k));
  if (yours.length) cands.splice(0, cands.length, ...yours);
  const cmp = (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2];
  cands.sort((a, b) => cmp(b, a));
  const best = cands.filter((c) => cmp(c, cands[0]) === 0).map((c) => c.k);
  return new Set(best.map((k) => k.category)).size > 1 ? { tie: best } : best[0];
}

/**
 * Add a keyword the worker learned from your corrections (learning.js). Returns 'added', 'promoted' (usually became
 * always), 'kept' (already there) or 'blocked': you have a keyword for the phrase, or you removed it before.
 */
export const learnKeyword = ({ phrase, category, store = null, strength = 'usually', fromTxn, maxCents, maxItemCents }) =>
  locked(async () => {
    const all = await loadAll();
    const p = normalize(phrase);
    if (all.keywords.some((k) => !isLearned(k) && normalize(k.phrase) === p)) return 'blocked';
    if (all.removed.some((r) => normalize(r.phrase) === p && (!r.store || normalize(r.store) === normalize(store)))) return 'blocked';
    const have = findKeyword(all.keywords, phrase, store);
    if (have) {
      if (!isLearned(have) || have.category !== category || strength !== 'always' || strengthOf(have) === 'always') return 'kept';
      await save(all.keywords.map((k) => (k === have ? { ...k, strength: 'always', ...(Number.isFinite(maxCents) ? { maxCents } : {}), ...(Number.isFinite(maxItemCents) ? { maxItemCents } : {}) } : k)), all.removed);
      return 'promoted';
    }
    await save([...all.keywords, makeEntry({ phrase, category, store, strength, from: 'learned', fromTxn, maxCents, maxItemCents })], all.removed);
    return 'added';
  });

/** A keyword's strength: "always" or (anything else, including missing) "usually". */
export const strengthOf = (k) => (k?.strength === 'always' ? 'always' : 'usually');

/**
 * What KEYWORD_MODE does with a matched keyword: 'file' (filed by keyword, no model call), 'hint' (the model sees it)
 * or 'none' (off). final/hint/off apply to every keyword; mixed follows the keyword's strength. A keyword the worker
 * learned (from: 'learned') is never filed without the model in final mode: it is only a hint there.
 */
export const keywordAction = (mode, k) => (mode === 'final' && isLearned(k) ? 'hint' : mode === 'final' ? 'file' : mode === 'hint' ? 'hint' : mode === 'mixed' ? (strengthOf(k) === 'always' ? 'file' : 'hint') : 'none');

/**
 * Every `#always` / `#usually` tag in a note: { phrase, strength }, or { skip: reason }. [] if there is none.
 * `#always Gold Bond` -> "Gold Bond": the text after the tag, up to a , ; | ( newline or the next #.
 * A bare tag (nothing usable after it) takes the text before it back to the previous separator:
 * "GOLD BOND #always, TIDE PODS" -> "GOLD BOND". With no text before it either, it uses `itemNote` (the part's
 * note with annotations stripped) when that is a single item.
 */
export function tagPhrases(notes, itemNote) {
  const text = notes ?? '';
  const out = [];
  for (const m of text.matchAll(/#(always|usually)\b([^,;|(\n#]*)/gi)) {
    const tag = `#${m[1].toLowerCase()}`;
    const strength = tag === '#always' ? 'always' : 'usually';
    let phrase = m[2].trim();
    if (!phrase) {
      // The notes the worker adds ("(store default)", "(maybe Child 34%)") are not part of the phrase.
      const before = text.slice(0, m.index).replace(/ \(store default\)/g, '').replace(/ \((?:maybe|pipeline:) [^)]*(?:\)|$)/g, '');
      phrase = before.split(/[,;|(\n#:)]/).pop().trim();
      if (!phrase && itemNote && !/[,;]/.test(itemNote)) phrase = itemNote.trim();
    }
    phrase = stripDepartment(phrase).trim();
    if (!phrase) {
      out.push({ skip: `no phrase after ${tag} and no item note` });
      continue;
    }
    const words = toks(phrase).length;
    if (words < 1 || words > 4 || phrase.length > 40) out.push({ skip: `"${phrase}" is not 1-4 words / 40 characters` });
    else out.push({ phrase, strength });
  }
  return out;
}

/** The first tag of a note (see tagPhrases), or null. */
export const alwaysPhrase = (notes, itemNote) => tagPhrases(notes, itemNote)[0] ?? null;

/**
 * Add keywords from #always / #usually tags found by actual.itemHistory (`itemHistory.always`; entries carry the
 * transaction `date`). Per phrase only the newest tag counts. The file is written at most once. Never touches Actual.
 */
export async function harvestAlways(tagged) {
  if (!tagged?.length) return;
  const newest = new Map();
  for (const t of tagged) {
    for (const r of tagPhrases(t.notes, t.item)) {
      if (r.skip) {
        log(`    skipped: ${r.skip}`);
        continue;
      }
      const key = normalize(r.phrase);
      const cur = newest.get(key);
      if (!cur || (t.date ?? '') >= (cur.t.date ?? '')) newest.set(key, { t, r });
    }
  }
  if (!newest.size) return;
  await locked(async () => {
    const all = await loadAll();
    const keywords = [...all.keywords];
    let changed = false;
    for (const { t, r } of newest.values()) {
      const idx = keywords.findIndex((k) => sameKey(k, r.phrase, null));
      const have = keywords[idx];
      if (have) {
        if (have.category !== t.category && have.from === 'actual') log(`    #${r.strength} skipped: "${r.phrase}" is already a keyword for ${have.category}; the tag says ${t.category}`);
        else if (have.category === t.category && have.from === 'actual' && strengthOf(have) !== r.strength) {
          keywords[idx] = { ...have, strength: r.strength, fromTxn: t.txnId };
          changed = true;
          log(`    #${r.strength}: keyword "${have.phrase}" is now ${r.strength} (from Actual)`);
        }
        continue;
      }
      if (findKeyword(all.removed, r.phrase, null)) continue; // removed on purpose with the CLI
      const entry = makeEntry({ phrase: r.phrase, category: t.category, strength: r.strength, from: 'actual', fromTxn: t.txnId });
      keywords.push(entry);
      changed = true;
      log(`    #${r.strength}: keyword "${entry.phrase}" → ${entry.category} (from Actual)`);
    }
    if (changed) await save(keywords, all.removed);
  });
}

// ---- Keywords learned from your corrections (learning.js decides when; these are the rules) ----

// Words that say nothing about what an item is: units, receipt furniture. A phrase needs a real word beside them.
const GENERIC = new Set('oz lb lbs ea pk ct gal tax sale coupon savings instant dep btl misc grocery produce dept item reg total each pack case box bag'.split(' '));

// "bags", "boxes", "items": the singular counts too.
const isGeneric = (w) => GENERIC.has(w) || (w.endsWith('s') && GENERIC.has(w.slice(0, -1))) || (w.endsWith('es') && GENERIC.has(w.slice(0, -2)));

/**
 * Did this lesson come from one item alone (in its part, or on its receipt)? Lessons saved without the field:
 * a whole-receipt one (kind 'receipt') is not solo.
 */
export const isSolo = (l) => (l.solo === undefined ? l.kind !== 'receipt' : l.solo !== false);

/** The keyword phrase for an item: its normalized text, when it is 1-4 words, 40 characters, has a real word, and a single word has 4+ letters. Else null. */
export function keywordPhrase(item) {
  const phrase = normalize(stripDepartment(String(item ?? '')));
  const words = phrase.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 4 || phrase.length > 40) return null;
  if (!words.some((w) => /^[a-z]{3,}$/.test(w) && !isGeneric(w))) return null;
  if (words.length === 1 && (words[0].length < 4 || isGeneric(words[0]))) return null;
  return phrase;
}

const SMALL_RECEIPT_ITEMS = 3;
const SMALL_RECEIPT_CENTS = 3000;
const SMALL_ITEM_CENTS = 500; // the least a learned keyword's item-price limit can be

// A lesson that moved several items together but only a small whole: a small receipt, or one small split part (the food court).
// Lessons stored before partItems/partCents existed are not small.
// A small part counts only when it had a category and you changed it (kind 'item'); a filled-in Uncategorized part is a grab bag.
export const isSmall = (l) => (l.kind === 'receipt'
  ? l.receiptItems <= SMALL_RECEIPT_ITEMS && l.amountCents <= SMALL_RECEIPT_CENTS
  : l.kind === 'item' && l.partItems <= SMALL_RECEIPT_ITEMS && l.partCents <= SMALL_RECEIPT_CENTS);

/**
 * Does this lesson count as evidence for a keyword (a lone item, or a small receipt or part), and how big was what it
 * learned from? `cents`: a lone item: its charge. A small part: the part. A small receipt: the receipt. Big collapsed
 * lessons: none. `itemCents`: the item's own price (null for a lesson saved without a price).
 * Lessons merged by compact() carry `evidence`, `evidenceCents` and `evidenceItemCents` (the largest) and are read as they are.
 */
export function evidenceOf(l) {
  const fin = (n) => (Number.isFinite(n) ? n : null);
  if (l.evidence !== undefined) return { evidence: Boolean(l.evidence), cents: fin(l.evidenceCents), itemCents: fin(l.evidenceItemCents) };
  // A small part of a big receipt keeps its small size, even when it was a lone item: the limit follows what was learned from.
  if (isSmall(l)) return { evidence: true, cents: fin(l.kind === 'receipt' ? l.amountCents : l.partCents), itemCents: fin(l.itemCents) };
  if (isSolo(l)) return { evidence: true, cents: fin(l.amountCents), itemCents: fin(l.itemCents) };
  return { evidence: false, cents: null, itemCents: null };
}

/** The keywords a lesson went against: [{ kw, kwCat }]. A lesson merged by compact() lists every one of its members' (`kwVotes`). */
export const kwVotesOf = (l) => (l.kwVotes ?? (l.kw && l.kwCat ? [{ kw: l.kw, kwCat: l.kwCat }] : []));

/**
 * The keywords the lessons justify: [{ phrase, category, store, strength, fromTxn }], always scoped to one real payee.
 * Evidence: two corrections of the same item to the same category on different receipts there make a "usually" keyword;
 * three, with at least one of them an item alone in its part (or on its receipt) and fewer than a third as many the other way
 * (one exception turns "always" into "usually" until 4 fixes agree; 0 against needs 3), make "always".
 * Changes that moved several items at once (a collapsed split, a recategorized charge) are weaker: on a big receipt
 * (over 3 items or $30) they never make a keyword, at any count; they only add to one that has a lone item behind it or a
 * small receipt (the food court: one is enough), and never promote one alone.
 * If the same item was filed in two categories, the one with more receipts wins; a tie gives none.
 * An exception does not delete a keyword: a lesson made by correcting an item a keyword filed (it carries `kw` and `kwCat`)
 * also counts, as a vote for the category you chose, in the keyword's own group. So one gift filed elsewhere only turns
 * "always" into "usually" (the keyword no longer has every vote), and the keyword goes only when the corrections that
 * disagree with it are as many as those behind it (a tie gives none), or more (the other category then wins). More agreeing
 * corrections bring it back.
 * Two limits come with a keyword: the whole charge (maxCents: twice the largest evidence charge, at least $30) and the
 * item's own price (maxItemCents: twice the largest evidence item price, at least $5; none when no evidence lesson
 * has an item price, as for lessons saved without one).
 */
export function keywordCandidates(lessons) {
  const groups = new Map();
  const vote = (phrase, l) => {
    const store = String(l.payee ?? '').trim();
    if (!phrase || !store || !l.filed || store.length > 100) return;
    const key = `${phrase}|${normalize(store)}`;
    const g = groups.get(key) ?? { phrase, store, cats: new Map() };
    const c = g.cats.get(l.filed) ?? { txns: new Map(), solo: new Set(), small: false, txnId: l.txnId, date: '' };
    c.txns.set(l.txnId, Math.max(c.txns.get(l.txnId) ?? 0, l.count ?? 1));
    const ev = evidenceOf(l);
    if (isSolo(l)) c.solo.add(l.txnId);
    // A small receipt or part is enough on its own, whether it held one item or several: one correction of a 1-item $5
    // receipt teaches at least as much as one of a 2-item $9 receipt. A merged lesson (compact()) carries `small`;
    // one merged before that existed can only say it was evidence and not a lone item.
    if (l.small ?? (l.evidence !== undefined ? !isSolo(l) && ev.evidence : isSmall(l))) c.small = true;
    if (ev.evidence && ev.cents != null) c.topCents = Math.max(c.topCents ?? 0, ev.cents);
    if (ev.evidence && ev.itemCents != null) c.topItemCents = Math.max(c.topItemCents ?? 0, ev.itemCents);
    if ((l.date ?? '') >= c.date) Object.assign(c, { date: l.date ?? '', txnId: l.txnId });
    g.cats.set(l.filed, c);
    groups.set(key, g);
  };
  for (const l of lessons) {
    vote(keywordPhrase(l.item), l);
    // Against a keyword: you moved an item it filed, somewhere else (a lone item or a small receipt, not a big receipt moved whole).
    for (const v of kwVotesOf(l)) if (l.filed !== v.kwCat && evidenceOf(l).evidence) vote(normalize(v.kw), l);
  }
  const out = [];
  for (const g of groups.values()) {
    const ranked = [...g.cats].map(([category, c]) => ({ category, c, n: [...c.txns.values()].reduce((a, b) => a + b, 0) })).sort((a, b) => b.n - a.n);
    if (ranked.length > 1 && ranked[0].n === ranked[1].n) continue; // evenly split: it learned nothing
    const { category, c, n } = ranked[0];
    // Items moved together on a big receipt only add to the count of a phrase that has a lone item or a small receipt behind it.
    if (c.solo.size === 0 && !c.small) continue;
    if (n < 2 && !c.small) continue;
    // "always" needs 3 receipts for it, one a lone item, and more than three times as many for it as against (4 for 1 against): it can come back from an exception.
    const against = ranked.slice(1).reduce((a, r) => a + r.n, 0);
    const always = n >= 3 && c.solo.size >= 1 && n > 3 * against;
    // A learned keyword only applies to charges about the size it was learned from (twice the size of the evidence, at least $30).
    const maxCents = c.topCents == null ? {} : { maxCents: Math.max(2 * c.topCents, SMALL_RECEIPT_CENTS) };
    const maxItemCents = c.topItemCents == null ? {} : { maxItemCents: Math.max(2 * c.topItemCents, SMALL_ITEM_CENTS) };
    out.push({ phrase: g.phrase, category, store: g.store, strength: always ? 'always' : 'usually', fromTxn: c.txnId, ...maxCents, ...maxItemCents });
  }
  return out;
}

/**
 * The keywords as they would have been with only these `candidates` learned (replay and item-test with --with-memory, from
 * the lessons up to the purchase): the household's own keywords as they are now, plus the candidates, minus the ones
 * syncLearned would not add (you have a keyword for the phrase, or you removed it). Nothing is written.
 */
export async function keywordsWithLearned(candidates) {
  const all = await loadAll();
  const own = all.keywords.filter((k) => !isLearned(k));
  const allowed = candidates.filter((c) => {
    const p = normalize(c.phrase);
    return !own.some((k) => normalize(k.phrase) === p) && !all.removed.some((r) => normalize(r.phrase) === p && (!r.store || normalize(r.store) === normalize(c.store)));
  });
  return [...own, ...allowed.map((c) => makeEntry({ ...c, from: 'learned' }))];
}

/**
 * Make the learned keywords match the candidates: add the missing ones (not where you have a keyword for the phrase or removed
 * it), set each one's strength and size limits, and delete the ones no candidate supports any more (the evidence was forgotten,
 * reverted or outvoted by corrections that disagree). Deleted this way they are not tombstoned: more evidence can bring them back.
 * Only what you do yourself (removing a keyword, Forget) is permanent. Returns { added, removed }.
 */
export const syncLearned = (candidates) =>
  locked(async () => {
    const all = await loadAll();
    const support = (k) => candidates.find((c) => c.category === k.category && normalize(c.phrase) === normalize(k.phrase) && normalize(c.store) === normalize(k.store));
    const kept = all.keywords.filter((k) => !isLearned(k) || support(k));
    let changed = kept.length !== all.keywords.length;
    const out = kept.map((k) => {
      const c = isLearned(k) && support(k);
      if (!c || (strengthOf(k) === c.strength && k.maxCents === c.maxCents && k.maxItemCents === c.maxItemCents)) return k;
      changed = true;
      const { maxCents, maxItemCents, ...rest } = { ...k, strength: c.strength };
      return { ...rest, ...(c.maxCents != null ? { maxCents: c.maxCents } : {}), ...(c.maxItemCents != null ? { maxItemCents: c.maxItemCents } : {}) };
    });
    let added = 0;
    for (const c of candidates) {
      const p = normalize(c.phrase);
      if (out.some((k) => (!isLearned(k) && normalize(k.phrase) === p) || sameKey(k, c.phrase, c.store))) continue;
      if (all.removed.some((r) => normalize(r.phrase) === p && (!r.store || normalize(r.store) === normalize(c.store)))) continue;
      out.push(makeEntry({ ...c, from: 'learned' }));
      added++;
      changed = true;
    }
    if (changed) await save(out, all.removed);
    return { added, removed: all.keywords.length - kept.length };
  });
