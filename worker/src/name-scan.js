// Layer 1 of the remote decider's anonymizing: ask the reader model which of the texts about to be sent contain
// the names of private people, and places that locate the household (cities, states, streets, ZIP codes). With the local
// reader the texts never leave this machine for this. With a cloud reader (READER_PROVIDER=remote) they go to its provider,
// raw, which is why config.js refuses that together with the hosted decider unless CLOUD_NAME_SCAN=true. Answers are cached per text
// (data/name-scan-cache.json), so a text that hasn't changed is never scanned twice.
// Fails closed, nothing unscanned is ever sent. If the reader is unreachable, slow or answering 5xx, that is a
// TransientError: a reader outage stops the cycle and the receipt waits, nothing counted (only with a cloud reader, a
// failure that may have been billed counts against the receipt, see failure.js). A setup problem (a refused key,
// no credit) pauses the worker. If its output is unusable even after the constrained retry and a retry one text
// at a time, that is a plain PermanentError: this receipt counts a failed attempt instead of stalling the whole inbox.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { config, log } from './config.js';
import { chatJson } from './llm.js';
import { TransientError, PermanentError, isSetupProblem } from './errors.js';
import { norm, PLACE_TYPES, usablePlace } from './anonymize.js';
import { withLock, writeJsonAtomic } from './file-lock.js';

const MAX_CACHE_ENTRIES = 5000;
const BATCH_CHARS = 6000; // texts per reader call: this many characters at most
const BATCH_ITEMS = 12; // a small batch keeps the 4B reader accurate (81 texts in one call went wrong)
// Bump when the instructions or the fields below change: cached answers from an older prompt are not trusted.
export const PROMPT_VERSION = 6; // 3: places as well as people; 4: fallback place words kept to their own text; 5: batches of 12, item lines need evidence, name shape checks; 6: brand example in the prompt

// An item line is product text, so a name the reader finds in one is only believed when the line has one of these
// cue words (or the word is already a known private word). The one place to edit this list.
const PERSON_CUES = /(?<![\p{L}\p{M}])(?:for|to|from|member|name|cashier|server|gift|bday|birthday|personalized)(?![\p{L}\p{M}])/iu;
// Common receipt and product words that are never reported as a person. Not first names: Tom, Bart, Jack stay possible.
const NOT_NAMES = new Set(`free cage organic org fresh bag tub pack pk ct oz lb lbs gal milk pears chicken beef pork butter cheese bread eggs water juice
  cream sugar salt rice pasta sauce chips snack frozen large small medium mini whole cocktail cookie cookies tax total subtotal each case box can jar
  for to from member name cashier server gift bday birthday personalized card`.split(/\s+/));
const namedSomeone = new WeakSet();
const VOWEL = /[aeiouy]/i;
/** Does this word look like a name? 2+ letters, a vowel (so LBC, KS and the like are out), and not a common product word. */
function looksLikeName(w) {
  if (w.length < 2 || NOT_NAMES.has(w.toLowerCase())) return false;
  const plain = w.normalize('NFD').replace(/\p{M}/gu, '');
  return !/^\p{Script=Latin}+$/u.test(plain) || VOWEL.test(plain);
}

const FIELD = {
  item: (merchant) => `item line from a ${merchant || 'store'} receipt`,
  note: () => 'note on a past split',
  similar: () => 'note on a past purchase',
  category: () => 'description of a budget category',
  keyword: () => 'keyword',
  store: () => 'store or payee name',
};
/** Kinds that are free text worth scanning. Public holiday names are not (see anonymize.js). */
const SCANNED_KINDS = Object.keys(FIELD);

const SYSTEM = `You help protect a household's privacy. You get a numbered list of short texts, each labelled with the kind of field it came from.
For each text, list (1) the names of private people that the household knows personally (family members, friends, neighbors, coworkers): first names, nicknames, full names, and (2) the places in it that locate where the household lives or shops.
Rules for people:
- Report only private individuals. Never report businesses, stores, restaurants, brands, products, holidays or characters.
- Item lines are product text from a receipt, so flag a line only when it plainly names a person, for example "MEMBER: J DOE" or "Gift for Alex". Product words that happen to look like names (Dove, Tide, Jack Daniel's, Ben & Jerry's, Wendy's, Sam's Club) are NOT people.
- A store or payee name is almost always a business: report it only when it plainly names a private person, for example "Zelle to Jordan Smith" or "Venmo Alex".
Rules for places:
- Report cities, towns, neighborhoods, states or provinces, street addresses and street names, and ZIP or postal codes, each with its type: "city" (also towns and neighborhoods), "state", "street" (also a whole street address) or "zip".
- Keep a city and its state code together as one place when they are written together ("SPRINGFIELD IL" is one "city" place). A two-letter state code is only a place when it is clearly part of an address.
- Do not report a country on its own ("US", "USA"), nor businesses or brands, even when a place name is part of a brand ("Fake Falls Hawks Pro Shop" has the city "Fake Falls"; report it, the store name stays).
Copy each name and place exactly as it is written in the text. If a text has none, give empty lists.
Answer with JSON only: {"results":[{"id":<number>,"names":["..."],"places":[{"text":"...","type":"city"}]}]} with one entry for every id.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'names', 'places'],
        properties: {
          id: { type: 'integer' },
          names: { type: 'array', items: { type: 'string' } },
          places: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'type'], properties: { text: { type: 'string' }, type: { type: 'string', enum: PLACE_TYPES } } } },
        },
      },
    },
  },
};

// The reader model and the prompt are part of the key: another model or prompt may find names this one missed.
const hashOf = (kind, text) => crypto.createHash('sha256').update(`${PROMPT_VERSION}\n${config.llmName}\n${kind}\n${norm(text)}`).digest('hex').slice(0, 32);

async function readCache() {
  try {
    const c = JSON.parse(await fs.readFile(config.privacy.scanCachePath, 'utf8'));
    return c && typeof c.entries === 'object' && c.entries ? c.entries : {};
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not read ${config.privacy.scanCachePath}: ${err.message}; scanning everything again`);
    return {};
  }
}

async function saveCache(fresh) {
  await withLock(`${config.privacy.scanCachePath}.lock`, async () => {
    const entries = { ...(await readCache()), ...fresh };
    const keys = Object.keys(entries);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES))) delete entries[k]; // oldest first
    await writeJsonAtomic(config.privacy.scanCachePath, { entries });
  });
}

const LETTERS = '\\p{L}\\p{M}';
/**
 * The words of a name the reader gave (2+ letters) that really occur in the text as whole words, as written in the text.
 * "John Doe" for "MEMBER DOE/JOHN" gives ["DOE", "JOHN"]: the reader may reorder or reformat a name, so it is matched word by word.
 */
export function wordsFoundIn(name, text) {
  const found = [];
  const haystack = norm(text);
  for (const w of norm(name).match(new RegExp(`[${LETTERS}]{2,}`, 'gu')) ?? []) {
    const hit = new RegExp(`(?<![${LETTERS}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![${LETTERS}])`, 'iu').exec(haystack);
    if (hit && !found.some((f) => f.toLowerCase() === hit[0].toLowerCase())) found.push(hit[0]);
  }
  return found;
}

const flexible = (token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Where the reader's place really occurs in the text: the whole phrase as written (spaces and punctuation between its
 * words may differ), as { text, type }. If the phrase is not there as such, its words of 3+ characters that are. Nothing
 * the text does not contain, and no country on its own. Words from the fallback carry `local: true`.
 */
export function placesFoundIn(place, text) {
  const haystack = norm(text);
  const tokens = norm(place?.text ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const type = PLACE_TYPES.includes(place?.type) ? place.type : 'place';
  if (!tokens.length) return [];
  const find = (pattern) => new RegExp(`(?<![${LETTERS}])${pattern}(?![\\p{L}])`, 'iu').exec(haystack)?.[0];
  const phrase = find(tokens.map(flexible).join('[^\\p{L}\\p{N}]+'));
  if (phrase) return usablePlace({ word: phrase }) ? [{ text: phrase, type }] : [];
  // Not there as such: its words of 3+ characters that are, marked local (hidden in this one text, never remembered).
  const out = [];
  for (const t of tokens) {
    const hit = t.length >= 3 ? find(flexible(t)) : undefined;
    if (hit && usablePlace({ word: hit }) && !out.some((o) => o.text.toLowerCase() === hit.toLowerCase())) out.push({ text: hit, type, local: true });
  }
  return out;
}

/**
 * The reader's answer, checked: one entry for every id asked about, { people, places }. Each word of a name and each
 * place must really appear in its text. `places` may be missing (older answers): then there are none.
 */
export function checkScan(value, asked) {
  if (!Array.isArray(value?.results)) throw new Error('the reader did not answer with a results list');
  const out = new Map();
  for (const r of value.results) {
    const text = asked.get(r?.id);
    const places = r?.places ?? [];
    if (text === undefined || !Array.isArray(r.names) || r.names.some((n) => typeof n !== 'string')) throw new Error('the reader\'s answer has an unknown id or a bad names list');
    if (!Array.isArray(places) || places.some((p) => typeof p?.text !== 'string')) throw new Error('the reader\'s answer has a bad places list');
    const found = places.flatMap((p) => placesFoundIn(p, text));
    const uniq = found.filter((p, i) => found.findIndex((q) => q.text.toLowerCase() === p.text.toLowerCase()) === i);
    // Whole phrases are remembered; fallback words only apply to this text.
    const said = [...new Set(r.names.flatMap((n) => wordsFoundIn(n, text)))];
    // `flagged` remembers that the reader named someone at all (before the name checks); the sanity check on a batch uses it.
    const entry = { people: said.filter(looksLikeName), places: uniq.filter((p) => !p.local), local: uniq.filter((p) => p.local).map(({ text: t, type }) => ({ text: t, type })) };
    if (said.length) namedSomeone.add(entry);
    out.set(r.id, entry);
  }
  for (const id of asked.keys()) if (!out.has(id)) throw new Error(`the reader's answer is missing text ${id}`);
  return out;
}

async function askReader(batch, merchant) {
  const asked = new Map(batch.map((b, i) => [i, b.text]));
  const list = batch.map((b, i) => ({ id: i, field: FIELD[b.kind](merchant), text: b.text }));
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(list, null, 1) }];
  const { value } = await chatJson(messages, SCHEMA, (v) => checkScan(v, asked));
  return batch.map((b, i) => [b, value.get(i)]);
}

/** A batch answer that flags people in more than half of its item lines (and at least 3) is the reader going wrong. */
function implausible(answer) {
  const items = answer.filter(([b]) => b.kind === 'item');
  const flagged = items.filter(([, f]) => namedSomeone.has(f)).length;
  return flagged >= 3 && flagged > items.length / 2;
}

/** Item-line names without evidence are dropped: they need a cue word in the line or must already be a known private word. */
function believed(t, found, known) {
  if (t.kind !== 'item' || !found.people.length || PERSON_CUES.test(t.text)) return found;
  return { ...found, people: found.people.filter((w) => known.has(w.toLowerCase())) };
}

/**
 * One batch. If the output stays unusable (after llm.js's constrained retry), the texts are asked again one per call;
 * a text that still fails is a PermanentError. An outage (TransientError) or a setup problem is never retried here.
 */
async function askWithFallback(batch, merchant) {
  try {
    const answer = await askReader(batch, merchant);
    if (batch.length > 1 && implausible(answer)) {
      log(`  name scan: the reader flagged people in most of ${batch.length} texts, which is not believable; asking one text at a time`);
      const out = [];
      for (const one of batch) out.push(...(await askWithFallback([one], merchant)));
      return out;
    }
    return answer;
  } catch (err) {
    if (err instanceof TransientError || isSetupProblem(err)) throw err; // an outage or a setup problem is the same for every single text: asking again only repeats it
    if (batch.length > 1) {
      log(`  name scan: the reader's answer for ${batch.length} texts was unusable (${err.message}); asking one text at a time`);
      const out = [];
      for (const one of batch) out.push(...(await askWithFallback([one], merchant)));
      return out;
    }
    throw new PermanentError(`name scan could not read one of the texts (${err.message}), so nothing was sent to the remote decider`, { cause: err });
  }
}

function batches(items) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= BATCH_ITEMS || chars + it.text.length > BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The key a text's own scan result is looked up by (see scanTexts). */
export const textKey = (kind, text) => `${kind}\n${norm(text)}`;

/**
 * Scan these texts ({ kind, text }). Returns { names, places, byText }: names = every person's name found (strings),
 * places = every place found ([{ text, type }]), byText = Map(textKey -> { people, places } for that one text), so a
 * caller can ask whether a given text, such as a payee's own name, came back clean. Cached texts cost nothing.
 * `merchant` names the receipt in the item-line field label. `knownWords` = private words already listed or found:
 * a name in an item line is kept only with a person cue in the line or when it is one of these (or found in a non-item text).
 */
export async function scanTexts(texts, merchant, knownWords = []) {
  const unique = new Map();
  for (const t of texts) if (SCANNED_KINDS.includes(t.kind) && typeof t.text === 'string' && t.text.trim()) unique.set(hashOf(t.kind, t.text), { ...t, text: norm(t.text) });
  const names = new Set();
  const places = new Map();
  const byText = new Map();
  const locals = new Map(); // normalized text -> words hidden in that text only
  const results = []; // [text, what the reader found], filtered once everything is read
  const take = (t, found) => {
    byText.set(textKey(t.kind, t.text), found);
    if (found.local?.length) locals.set(norm(t.text), [...(locals.get(norm(t.text)) ?? []), ...found.local]);
    found.people.forEach((n) => names.add(n));
    found.places.forEach((p) => places.set(p.text.toLowerCase(), p));
  };
  if (!unique.size) return { names: [], places: [], byText, locals };
  const cache = await readCache();
  const todo = [];
  for (const [hash, t] of unique) {
    const hit = cache[hash];
    if (hit && Array.isArray(hit.people) && Array.isArray(hit.places)) results.push([t, hit]);
    else todo.push({ ...t, hash });
  }
  if (todo.length) {
    const fresh = {};
    try {
      for (const batch of batches(todo)) {
        for (const [b, found] of await askWithFallback(batch, merchant)) {
          fresh[b.hash] = found; // cached as the reader said it; the item-line evidence check is applied below, every time
          results.push([b, found]);
        }
      }
    } finally {
      // Keep what was scanned even when a later text failed: the retry then only redoes the rest.
      if (Object.keys(fresh).length) {
        try {
          await saveCache(fresh);
        } catch (err) {
          log(`  could not save the name scan cache (${err.message}); continuing`);
        }
      }
    }
    log(`  name scan: ${todo.length} text(s) scanned, ${unique.size - todo.length} already known`);
  }
  const known = new Set(knownWords.map((w) => String(w).toLowerCase()));
  for (const [t, found] of results) if (t.kind !== 'item') found.people.forEach((w) => known.add(w.toLowerCase()));
  for (const [t, found] of results) take(t, believed(t, found, known));
  return { names: [...names], places: [...places.values()], byText, locals };
}

/** Names the reader found in these texts: a list of strings (see scanTexts). */
export async function scanForNames(texts, merchant) {
  return (await scanTexts(texts, merchant)).names;
}
