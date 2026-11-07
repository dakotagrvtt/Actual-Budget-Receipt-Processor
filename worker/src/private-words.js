// The household's private-words list (data/private-words.json), used to anonymize what goes to the remote decider.
//   { "words": ["Alex", ...],                      names you listed (PRIVATE_WORDS in .env seeds it once)
//     "notNames": ["Wendy", ...],                  words the name scan flagged that you said are not names
//     "found": [{ "word": "Jo", "firstSeen": "2026-11-06" }],   names the reader model found in receipts and notes
//     "order": ["alex", "jo"],                     every word ever listed or found, in order: its place is its pseudonym
//     "placeWords": ["Springfield"],               places you listed (PRIVATE_PLACES in .env seeds it once): your town...
//     "places": [{ "word": "Fake Falls", "type": "city", "firstSeen": "2026-11-06" }],   places the reader found
//     "notPlaces": ["Lincoln"],                    found places you said are not places
//     "seededPlaces": ["springfield"] }            PRIVATE_PLACES words already added once
// `order` never shrinks, so a word keeps its pseudonym (Person A, Person B, ...) even after others are removed.
import fs from 'node:fs/promises';
import { config, log } from './config.js';
import { withLock, writeJsonAtomic } from './file-lock.js';
import { today } from './dates.js';
import { SetupError } from './errors.js';
import { PLACE_TYPES, usablePlace } from './anonymize.js';

const MAX_WORD = 40;
const MAX_WORDS = 500;
const lower = (w) => String(w).normalize('NFKC').trim().toLowerCase();
/** A usable word: 2-40 characters with a letter in it. */
export const validWord = (w) => typeof w === 'string' && w.trim().length >= 2 && w.trim().length <= MAX_WORD && /\p{L}/u.test(w);
/** "Person" is the pseudonym word: hiding it would hold back every request (the pseudonyms themselves would be leaks). */
const isPseudonymWord = (w) => /(?<![\p{L}\p{M}])person(?![\p{L}\p{M}])/iu.test(String(w).normalize('NFKC'));

/** A place: 3-40 characters with a letter or digit (a ZIP code is a place), not the words of the neutral tokens. */
export const validPlace = (w) => typeof w === 'string' && w.trim().length >= 3 && w.trim().length <= MAX_WORD && usablePlace({ word: w });

const strings = (v) => (Array.isArray(v) ? v.filter((w) => typeof w === 'string' && validWord(w)).map((w) => w.trim().normalize('NFKC')) : []);
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((w) => !seen.has(lower(w)) && seen.add(lower(w)));
};

/** The file's content in its normal shape (a missing file is an empty list). */
export function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const found = Array.isArray(o.found) ? o.found.filter((f) => f && validWord(f.word) && !isPseudonymWord(f.word)).map((f) => ({ word: f.word.trim().normalize('NFKC'), firstSeen: String(f.firstSeen ?? '') })) : [];
  const placeStrings = (v) => (Array.isArray(v) ? v.filter(validPlace).map((w) => w.trim().normalize('NFKC')) : []);
  const rawPlaces = Array.isArray(o.places) ? o.places.filter((f) => f && validPlace(f.word)).map((f) => ({ word: f.word.trim().normalize('NFKC'), type: PLACE_TYPES.includes(f.type) ? f.type : 'place', firstSeen: String(f.firstSeen ?? '') })) : [];
  const foundPlaces = rawPlaces.filter((f, i) => rawPlaces.findIndex((g) => lower(g.word) === lower(f.word)) === i);
  return {
    words: dedupe(strings(o.words).filter((w) => !isPseudonymWord(w))),
    notNames: dedupe(strings(o.notNames)),
    found: found.filter((f, i) => found.findIndex((g) => lower(g.word) === lower(f.word)) === i),
    order: dedupe(strings(o.order)).map(lower),
    placeWords: dedupe(placeStrings(o.placeWords)),
    places: foundPlaces,
    notPlaces: dedupe(placeStrings(o.notPlaces)),
    seededPlaces: dedupe(placeStrings(o.seededPlaces)).map(lower),
  };
}

/**
 * The private-words file can't be read: nothing is sent, the file is never written over, and the cycle pauses without
 * counting an attempt (a SetupError: index.js shows the banner).
 */
export class PrivateWordsError extends SetupError {
  constructor(message, options) {
    super(message, options);
    this.name = 'PrivateWordsError';
  }
}

/** The file's content. Only a missing file (ENOENT) is an empty list; any other trouble throws, so layer 2 is never silently empty. */
async function readFile() {
  let text;
  try {
    text = await fs.readFile(config.privacy.wordsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return normalize(null);
    throw new PrivateWordsError(`data/private-words.json can't be read — fix or delete it; nothing is sent to the hosted decider until then (${err.message})`, { cause: err });
  }
  try {
    return normalize(JSON.parse(text));
  } catch (err) {
    throw new PrivateWordsError(`data/private-words.json can't be read — fix or delete it; nothing is sent to the hosted decider until then. It is not valid JSON (${err.message}) and is left as it is`, { cause: err });
  }
}

/** Keep `order` complete: every listed or found word has a place. */
function fillOrder(p) {
  for (const w of [...p.words, ...p.found.map((f) => f.word)]) if (!p.order.includes(lower(w))) p.order.push(lower(w));
}

const said = new Set();
const logOnce = (msg) => {
  if (said.has(msg)) return;
  said.add(msg);
  log(msg);
};

/** PRIVATE_WORDS from .env, added once per word (a word you later remove from the list does not come back). Returns true if anything was added. */
function applySeeds(p) {
  let changed = false;
  for (const w of config.privacy.seedWords) {
    if (!validWord(w) || p.order.includes(lower(w))) continue;
    if (isPseudonymWord(w)) {
      logOnce(`PRIVATE_WORDS: "${w}" is ignored: the word "Person" is used for the pseudonyms (Person A, ...)`);
      continue;
    }
    p.words.push(w.trim());
    p.order.push(lower(w));
    changed = true;
  }
  for (const w of config.privacy.seedPlaces ?? []) {
    if (!validPlace(w) || p.seededPlaces.includes(lower(w))) continue;
    p.seededPlaces.push(lower(w));
    if (!p.placeWords.some((x) => lower(x) === lower(w))) p.placeWords.push(w.trim().normalize('NFKC'));
    changed = true;
  }
  return changed;
}

const locked = (fn) => withLock(`${config.privacy.wordsPath}.lock`, fn);

/** Read-modify-write under a lock. fn edits the list and returns false to skip the write. */
async function update(fn) {
  return locked(async () => {
    const p = await readFile();
    applySeeds(p);
    const result = fn(p);
    if (result === false) return false;
    fillOrder(p);
    await writeJsonAtomic(config.privacy.wordsPath, p);
    return result;
  });
}

/** The list as it is now, with the .env seeds applied (and saved the first time they are seen). */
export async function loadPrivate() {
  const p = await readFile();
  if (applySeeds(p)) {
    try {
      return await update(() => true).then(readFile);
    } catch (err) {
      if (err instanceof PrivateWordsError) throw err;
      log(`could not save ${config.privacy.wordsPath}: ${err.message}`);
    }
  }
  fillOrder(p);
  return p;
}

/** Every word to hide, in pseudonym order: the listed words and the found names you haven't ruled out. */
export function effectiveWords(p) {
  const not = new Set(p.notNames.map(lower));
  const all = new Map();
  for (const w of [...p.words, ...p.found.map((f) => f.word).filter((w) => !not.has(lower(w)))]) all.set(lower(w), w);
  const ranked = [...all.keys()].sort((a, b) => (p.order.indexOf(a) + 1 || Infinity) - (p.order.indexOf(b) + 1 || Infinity));
  return ranked.map((k) => all.get(k));
}

const check = (word) => {
  if (!validWord(word)) throw new Error(`"${String(word).slice(0, 20)}" isn't a usable word (2 to ${MAX_WORD} characters, with a letter).`);
  if (isPseudonymWord(word)) throw new Error('The word "Person" can\'t be hidden: it is part of the pseudonyms (Person A, Person B...).');
  return word.trim();
};

export const addWord = async (word) => {
  const w = check(word);
  return update((p) => {
    if (p.words.length >= MAX_WORDS) throw new Error(`The list is full (${MAX_WORDS} words).`);
    if (p.words.some((x) => lower(x) === lower(w))) return false;
    p.words.push(w);
    p.notNames = p.notNames.filter((x) => lower(x) !== lower(w));
    return true;
  });
};

export const removeWord = (word) => update((p) => {
  const n = p.words.length;
  p.words = p.words.filter((x) => lower(x) !== lower(word));
  return p.words.length !== n || false;
});

/** "This isn't a name": stop hiding it (and drop it from found). */
export const addNotName = async (word) => {
  const w = check(word);
  return update((p) => {
    if (p.notNames.some((x) => lower(x) === lower(w))) return false;
    p.notNames.push(w);
    p.found = p.found.filter((f) => lower(f.word) !== lower(w));
    return true;
  });
};

export const removeNotName = (word) => update((p) => {
  const n = p.notNames.length;
  p.notNames = p.notNames.filter((x) => lower(x) !== lower(word));
  return p.notNames.length !== n || false;
});

/** Undo "Not a name": take the word off the not-names list and, when firstSeen is given, put its found record back. */
export const restoreFound = async (word, firstSeen = null) => {
  const w = check(word);
  return update((p) => {
    const n = p.notNames.length;
    p.notNames = p.notNames.filter((x) => lower(x) !== lower(w));
    let changed = p.notNames.length !== n;
    if (firstSeen !== null && p.found.length < MAX_WORDS && !p.words.concat(p.found.map((f) => f.word)).some((x) => lower(x) === lower(w))) {
      p.found.push({ word: w, firstSeen: String(firstSeen) });
      changed = true;
    }
    return changed || false;
  });
};

/** Remember names the scan found. Words already listed, found or ruled out are skipped. Returns the new ones. */
export async function recordFound(names) {
  const fresh = [];
  await update((p) => {
    const known = new Set([...p.words, ...p.notNames, ...p.found.map((f) => f.word)].map(lower));
    for (const n of names) {
      if (!validWord(n) || known.has(lower(n))) continue;
      if (isPseudonymWord(n)) {
        logOnce(`name scan: "${n}" is not remembered: the word "Person" is used for the pseudonyms`);
        continue;
      }
      known.add(lower(n));
      p.found.push({ word: n.trim(), firstSeen: today() });
      fresh.push(n.trim());
    }
    return fresh.length > 0 || false;
  });
  return fresh;
}

// ---- places: a separate list; places get no Person letters ----

/** Every place to hide: the ones you listed (as "a place") and the ones the scan found that you haven't ruled out. */
export function effectivePlaces(p) {
  const not = new Set(p.notPlaces.map(lower));
  const all = new Map();
  for (const w of p.placeWords) all.set(lower(w), { word: w, type: 'place' });
  for (const f of p.places) if (!not.has(lower(f.word)) && !all.has(lower(f.word))) all.set(lower(f.word), { word: f.word, type: f.type });
  return [...all.values()];
}

const checkPlace = (word) => {
  if (!validPlace(word)) throw new Error(`"${String(word).slice(0, 20)}" isn't a usable place (3 to ${MAX_WORD} characters, such as a town, street or ZIP code).`);
  return word.trim().normalize('NFKC');
};

export const addPlaceWord = async (word) => {
  const w = checkPlace(word);
  return update((p) => {
    if (p.placeWords.length >= MAX_WORDS) throw new Error(`The list is full (${MAX_WORDS} places).`);
    if (p.placeWords.some((x) => lower(x) === lower(w))) return false;
    p.placeWords.push(w);
    p.notPlaces = p.notPlaces.filter((x) => lower(x) !== lower(w));
    return true;
  });
};

export const removePlaceWord = (word) => update((p) => {
  const n = p.placeWords.length;
  p.placeWords = p.placeWords.filter((x) => lower(x) !== lower(word));
  return p.placeWords.length !== n || false;
});

/** "This isn't a place": stop hiding it (and drop it from found). */
export const addNotPlace = async (word) => {
  const w = checkPlace(word);
  return update((p) => {
    if (p.notPlaces.some((x) => lower(x) === lower(w))) return false;
    p.notPlaces.push(w);
    p.places = p.places.filter((f) => lower(f.word) !== lower(w));
    return true;
  });
};

export const removeNotPlace = (word) => update((p) => {
  const n = p.notPlaces.length;
  p.notPlaces = p.notPlaces.filter((x) => lower(x) !== lower(word));
  return p.notPlaces.length !== n || false;
});

/** Undo "Not a place": take the word off the not-places list and, when firstSeen is given, put its found record back. */
export const restoreFoundPlace = async (word, type = 'place', firstSeen = null) => {
  const w = checkPlace(word);
  return update((p) => {
    const n = p.notPlaces.length;
    p.notPlaces = p.notPlaces.filter((x) => lower(x) !== lower(w));
    let changed = p.notPlaces.length !== n;
    if (firstSeen !== null && p.places.length < MAX_WORDS && !p.placeWords.concat(p.places.map((f) => f.word)).some((x) => lower(x) === lower(w))) {
      p.places.push({ word: w, type: PLACE_TYPES.includes(type) ? type : 'place', firstSeen: String(firstSeen) });
      changed = true;
    }
    return changed || false;
  });
};

/** Remember places the scan found ([{ text, type }]). Ones already listed, found or ruled out are skipped. Returns the new ones. */
export async function recordPlaces(places) {
  const fresh = [];
  await update((p) => {
    const known = new Set([...p.placeWords, ...p.notPlaces, ...p.places.map((f) => f.word)].map(lower));
    for (const pl of places) {
      if (p.places.length >= MAX_WORDS) break;
      if (!validPlace(pl?.text) || known.has(lower(pl.text))) continue;
      known.add(lower(pl.text));
      const entry = { word: pl.text.trim().normalize('NFKC'), type: PLACE_TYPES.includes(pl.type) ? pl.type : 'place', firstSeen: today() };
      p.places.push(entry);
      fresh.push(entry);
    }
    return fresh.length > 0 || false;
  });
  return fresh;
}
