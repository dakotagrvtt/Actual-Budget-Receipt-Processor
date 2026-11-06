// Household keywords: "items matching this phrase belong in this category". Stored in KEYWORDS_PATH
// (default /data/keywords.json, i.e. data/keywords.json on the host) as
//   {"keywords":[{"phrase":"Gold Bond","category":"Daily Expenses / Adult 2","store":null,"added":"2026-11-06","from":"cli"}]}
// - phrase:   matched against item text as whole tokens (see matchKeyword); plurals and "DRPEPPER"-style run-ons work
// - category: the exact category label
// - store:    null = any store; or a store name that must appear (as whole words) in the receipt's store
// - strength: "always" (KEYWORD_MODE=mixed files it without the model) or "usually" (mixed: the model sees it as a hint); missing = "usually"
// - from:     "cli" (./receipts keyword add) or "actual" (an `#always` / `#usually` tag in a transaction note)
// "removed" lists phrases taken out with the CLI so an #always tag doesn't bring them back; a CLI add clears the entry.
// "fromTxn" (actual keywords) is the transaction whose tag made it. A missing file means no keywords. Writes are atomic (tmp file + rename).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, log } from './config.js';
import { today } from './dates.js';

/** Lowercase, apostrophes deleted, letters and digits separated, other punctuation to spaces. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
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
  await fs.mkdir(path.dirname(config.keywordsPath), { recursive: true });
  const tmp = `${config.keywordsPath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify({ keywords, ...(removed.length ? { removed } : {}) }, null, 2) + '\n');
  await fs.rename(tmp, config.keywordsPath);
}

/** Load-modify-save under an O_EXCL lock file (retries for 5 s; a lock older than 30 s is stale and removed). */
async function locked(fn) {
  const lock = `${config.keywordsPath}.lock`;
  await fs.mkdir(path.dirname(config.keywordsPath), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      await (await fs.open(lock, 'wx')).close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 30000) await fs.unlink(lock).catch(() => {});
      else if (Date.now() - t0 > 5000) throw new Error(`keywords file is locked (${lock})`);
      else await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

const sameKey = (k, phrase, store) => normalize(k.phrase) === normalize(phrase) && normalize(k.store) === normalize(store);

/** The keyword with this phrase and store, or undefined. */
export const findKeyword = (keywords, phrase, store = null) => keywords.find((k) => sameKey(k, phrase, store));

const makeEntry = ({ phrase, category, store = null, strength = 'usually', from = 'cli', fromTxn }) => ({
  phrase: phrase.trim(), category, store: store?.trim() || null, strength: strength === 'always' ? 'always' : 'usually',
  added: today(), from, ...(fromTxn ? { fromTxn } : {}),
});

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
  const cmp = (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2];
  cands.sort((a, b) => cmp(b, a));
  const best = cands.filter((c) => cmp(c, cands[0]) === 0).map((c) => c.k);
  return new Set(best.map((k) => k.category)).size > 1 ? { tie: best } : best[0];
}

/** A keyword's strength: "always" or (anything else, including missing) "usually". */
export const strengthOf = (k) => (k?.strength === 'always' ? 'always' : 'usually');

/**
 * What KEYWORD_MODE does with a matched keyword: 'file' (filed by keyword, no model call), 'hint' (the model sees it)
 * or 'none' (off). final/hint/off apply to every keyword; mixed follows the keyword's strength.
 */
export const keywordAction = (mode, k) => (mode === 'final' ? 'file' : mode === 'hint' ? 'hint' : mode === 'mixed' ? (strengthOf(k) === 'always' ? 'file' : 'hint') : 'none');

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
      phrase = text.slice(0, m.index).split(/[,;|(\n#:)]/).pop().trim();
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
