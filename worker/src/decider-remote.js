// The remote decider: TypeSafe's hosted Jev (POST /v1/systemone, the same interface as the local llama.cpp server), reached
// only with anonymized requests. Order for each receipt:
//   1. build every request with the plain texts, only to collect what would be sent (anonymize.js)
//   2. layer 1: the reader scans those texts for private people's names and for places (name-scan.js), and every category
//      name in the budget too ("Kids / Alex"), so a short name or group name that names someone is hidden wherever it is
//      written alone; new ones are remembered
//   3. layer 2: your private-words list and those names become pseudonyms (Person A, ...)
//   4. final leak check on each finished request; a request that fails it is not sent (the item is left unsure, and
//      the log and the review reason say which field and which kind of leak, never the value)
//   5. send, one item at a time; codes in the answer turn back into category labels
// The API key is only ever in the Authorization header: it is never logged, and redact() cleans every message built from
// anything the network gave back.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import crypto from 'node:crypto';
import { modelFetch } from './model-fetch.js';
import { TransientError, PermanentError, SetupError, isTransient, isClientTimeout, markCounted, COUNTED_STATUSES } from './errors.js';
import { today } from './dates.js';
import { loadPrivate, effectiveWords, effectivePlaces, recordFound, recordPlaces } from './private-words.js';
import { scanTexts, textKey } from './name-scan.js';
import { reportSetupProblem } from './alert.js';
import { buildRemoteRequest, decodeAnswer, describeLeaks, dropKnownNames, findLeaks, hasWord, makeScrubber, norm, onlyWordsFrom, pseudonymEntries, spanRegex, storeClean } from './anonymize.js';
import { mkdirPrivate, writePrivate } from './private-files.js';

const TIMEOUT_MS = 2 * 60 * 1000; // per request
const MAX_CHOICES = 255; // Jev's limit for one choice question
const PRICE_PER_MILLION_TOKENS = 0.042;

/** A key the remote service refused: not the receipt's fault, and waiting won't fix it. Stops the cycle (see errors.js SetupError). */
export class DeciderAuthError extends SetupError {
  constructor() {
    super('the hosted decider rejected the API key — check DECIDER_API_KEY in .env and run ./receipts restart');
    this.name = 'DeciderAuthError';
  }
}

/** Another 4xx (422 and so on): either this request's shape or the setup is wrong. remoteDecide runs the fixed probe to tell which. */
class DeciderShapeError extends SetupError {
  constructor(message, status) {
    super(message);
    this.name = 'DeciderShapeError';
    this.status = status;
  }
}

/** The service can't take this item (HTTP 400 or 413): the item is left unsure; the rest of the receipt goes on. */
class DeciderItemError extends PermanentError {
  constructor(message, status) {
    super(message);
    this.name = 'DeciderItemError';
    this.status = status;
  }
}

/** Text with the API key (and any "Bearer ..." token) blanked out. */
export function redact(text) {
  let out = String(text ?? '');
  const key = config.decider.apiKey;
  if (key) out = out.split(key).join('[key]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [key]');
}

const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${config.decider.apiKey}` });

// What the server said, behind a fixed prefix, so nothing in it can be mistaken for our own words (see errors.js).
// The server's words are redacted whole and only then cut, so a key crossing the cut can't leave a fragment.
const said = (name, status, text) => `${name} HTTP ${status}; the server said: ${redact(text).slice(0, 300)}`;

/**
 * One request to the hosted API. 429, 5xx and network trouble are TransientError; 401/403 DeciderAuthError; 400 and
 * 413 DeciderItemError (this item only); any other 4xx (422 and so on) a DeciderShapeError, a SetupError unless the
 * fixed probe request goes through (see remoteDecide: then only that item is refused).
 * Of the TransientErrors only the possibly-billed, receipt-specific ones are marked counted (errors.js markCounted): 504,
 * 524, 408, our own timeout and an answer that could not be read. 429, other 5xx and no connection are an outage.
 */
async function remoteFetch(name, url, init) {
  let res;
  let text;
  try {
    res = await modelFetch(url, { ...init, headers: headers() }, TIMEOUT_MS);
  } catch (err) {
    const failure = new TransientError(redact(`${name} unreachable or timed out: ${err.message}`));
    throw isClientTimeout(err) ? markCounted(failure, 'decider') : failure;
  }
  try {
    text = await res.text();
  } catch (err) {
    throw markCounted(new TransientError(redact(`${name}: the answer could not be read: ${err.message}`)), 'decider');
  }
  if (res.status === 401 || res.status === 403) throw new DeciderAuthError();
  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    const failure = new TransientError(`${name} HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
    throw COUNTED_STATUSES.has(res.status) ? markCounted(failure, 'decider') : failure;
  }
  if (res.status === 413) throw new DeciderItemError(`${name} HTTP 413: the request was too large (over the 64k token limit)`, 413);
  if (res.status === 400) throw new DeciderItemError(said(name, 400, text), 400);
  if (!res.ok) throw new DeciderShapeError(said(name, res.status, text), res.status);
  return text;
}

/** POST /v1/systemone. Returns the parsed JSON, or { unparsable } when a 200 body isn't JSON. */
export async function remotePost(body) {
  const text = await remoteFetch('remote decider', `${config.deciderUrl}/v1/systemone`, { method: 'POST', body: JSON.stringify(body) });
  try {
    return JSON.parse(text);
  } catch {
    return { unparsable: redact(text).slice(0, 80) };
  }
}

/**
 * For `./receipts check`: GET /v1/models. The documented answer is { models: [{ name, description, release_date }] };
 * a bare list or { data: [...] } is tolerated, and anything else gives an empty list. Returns the model names.
 */
export function modelNames(parsed) {
  const list = Array.isArray(parsed) ? parsed : (parsed?.models ?? parsed?.data ?? []);
  return (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? m : (m?.name ?? m?.id))).filter((n) => typeof n === 'string');
}

export async function remoteReady() {
  const text = await remoteFetch('remote decider', `${config.deciderUrl}/v1/models`, { method: 'GET' });
  try {
    return modelNames(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * A warning if the configured model looks wrong, or null. Versioned ids (jev-1.14.0) are accepted by the service even
 * when /v1/models doesn't list them, so only an alias-looking name (no digits) that is not listed is flagged.
 */
export function modelWarning(model, names) {
  if (!names.length || names.includes(model) || /\d/.test(model)) return null;
  return `DECIDER_REMOTE_MODEL=${model} is not in the list (${names.slice(0, 8).join(', ')}); check the spelling`;
}

// The fixed probe, run at most once a minute: it tells a bad request from a bad setup.
let probe = null;
export const resetProbeCache = () => { probe = null; };
/** null when the fixed probe goes through, else the error it failed with. */
async function probeError() {
  if (!probe || Date.now() - probe.at > 60000) probe = { at: Date.now(), err: remoteProbe().then(() => null, (e) => e ?? new Error('probe failed')) };
  return probe.err;
}

/**
 * For `./receipts check`: one fixed request with no household data, to prove the key (GET /v1/models may not need one).
 * Costs a negligible number of tokens. Throws DeciderAuthError or another Error; returns the usage the service reported.
 */
export async function remoteProbe() {
  const body = {
    model: config.decider.remoteModel,
    state: { item: 'A test item: paper towels' },
    questions: { category: { type: 'choice', instructions: 'Which category fits this item?', criteria: { A: 'household supplies', B: 'food' } } },
  };
  const out = await remotePost(body);
  return Number(out?.usage?.input_tokens) || 0;
}

/** Every name that could stay readable where it appears in full: the real Actual payees, this receipt's merchant, the keyword stores. */
function protectCandidates({ receipt, keywords, businessNames }) {
  return [...new Set([...(businessNames ?? []), receipt.merchant, ...keywords.map((k) => k.store)].filter((n) => typeof n === 'string' && n.trim()))];
}

/**
 * Of those, the ones that really are businesses and stay readable in full:
 *   (a) the scan of the name's own text came back clean (`isClean(name)`): "Jordan Smith" flagged as a person never is,
 *   (b) it is not made up only of hidden words (a payee "Sam" while Sam is hidden), and
 *   (c) it contains no word you listed yourself (your list wins).
 * "Sam's Club" scanned clean stays whole while a lone "Sam" elsewhere is still hidden.
 */
function protectedNames({ candidates, listedWords = [], hiddenWords = [], isClean = () => false }) {
  return candidates.filter((n) => isClean(n) && !onlyWordsFrom(n, hiddenWords) && !hasWord(n, listedWords));
}

/** What the answer to a request depends on: a hash of the finished (anonymized) request, which names the model, the item and what it is compared with. Never the key (a header). */
const requestFingerprint = (body, labels = []) => crypto.createHash('sha256').update(JSON.stringify([body, labels])).digest('hex');

const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'receipt';

/** replay --preview-remote: write the finished request instead of sending it, with what the real path would hold back. */
async function writePreview(body, name, leaks) {
  const dir = path.join(config.privacy.previewRoot, config.decider.preview);
  await mkdirPrivate(dir);
  const held_back = leaks.map(({ path: where, kind }) => ({ path: where, kind }));
  await writePrivate(path.join(dir, `${safeName(config.decider.previewLabel)}.${name}.json`), `${JSON.stringify({ held_back, body }, null, 2)}\n`);
}

/** How a held-back item is described in the receipt summary and the review reason (receipt.js shows it as it is). */
export const HELD_BACK = 'held back from the hosted decider (privacy check)';
const unsure = (invalid) => ({ category: null, confidence: 0, invalid });
const brief = (v) => JSON.stringify(v).slice(0, 80);

/**
 * Picks for every item (null for items filed by keyword), by asking the remote decider with anonymized requests.
 * args: { receipt, labels, allLabels, history, itemHistory, hints, skip, known, keywords, notes, similar, instructions, wholeInstructions };
 * check = checkAnswer. known.businessNames = the real (non-transfer) Actual payee names.
 * With wholeInstructions, one more request asks the per-receipt question (about all the items together); it goes through the same
 * scan, privacy check and sending as the item requests, and its answer is `picks.receipt` (unsure when held back or refused).
 */
export async function remoteDecide(args, check) {
  const { receipt, labels, skip } = args;
  if (labels.length > MAX_CHOICES) throw new SetupError(`the remote decider takes at most ${MAX_CHOICES} categories; ${labels.length} are in use (hide some with EXCLUDE_CATEGORY_GROUPS)`);
  const preview = config.decider.preview;
  if (!preview && !config.decider.apiKey) throw new SetupError('DECIDER_API_KEY is not set (add it to .env and run ./receipts restart)');
  if (skip.size >= receipt.items.length) return receipt.items.map(() => null);
  const realPayees = args.known?.businessNames ?? [];
  const input = (i) => ({ ...args, realPayees, index: i, hint: args.hints[i], model: config.decider.remoteModel, today: today() });
  const todo = receipt.items.map((_, i) => i).filter((i) => !skip.has(i));
  // The jobs, in order: each item, then (if asked) the per-receipt question, which has no item number (i: null).
  const jobs = todo.map((i) => ({ i, name: `item${i + 1}`, what: `item ${i + 1}`, input: input(i) }));
  if (args.wholeInstructions) jobs.push({ i: null, name: 'receipt', what: 'the whole-receipt question', input: { ...input(0), whole: true, hint: undefined } });

  // 1-2: what would be sent, scanned for names (once for the whole receipt)
  const texts = [];
  const collect = (text, kind) => {
    texts.push({ kind, text });
    return text;
  };
  for (const job of jobs) buildRemoteRequest(job.input, collect);
  // A name can only stay readable if the scan of that name's own text came back clean, so every candidate that appears
  // in a text is scanned as a store text too (cached, so this costs once per name).
  const candidates = protectCandidates({ receipt, keywords: args.keywords, businessNames: realPayees });
  const used = candidates.filter((n) => {
    const re = spanRegex([n]);
    return re && texts.some((t) => new RegExp(re).test(t.text));
  });
  for (const n of used) texts.push({ kind: 'store', text: storeClean(n) });
  // Every category name, whole: a full label only ever goes out as a code, but its short name and group name go out in the
  // category's description and may be written alone in a note or an item line ("soccer cleats for Alex", "Kids / Alex").
  // A name or place the scan flags in a category name is remembered and hidden everywhere like any other; an ordinary
  // category word ("Groceries") is not flagged and goes out as it is. Cached per name, so a budget costs one scan.
  for (const l of new Set([...labels, ...(args.allLabels ?? [])])) if (typeof l === 'string') texts.push({ kind: 'label', text: l });
  const p0 = await loadPrivate();
  const scan = await scanTexts(texts, receipt.merchant, effectiveWords(p0));
  const found = scan.names;
  const names = dropKnownNames(found, { notNames: p0.notNames });
  const fresh = await recordFound(names);
  if (fresh.length) log(`  name scan found ${fresh.length} new name(s); they are hidden from the remote decider (review them on the Privacy page)`);
  const freshPlaces = await recordPlaces(scan.places.filter((pl) => !p0.notPlaces.some((n) => n.toLowerCase() === pl.text.toLowerCase())));
  if (freshPlaces.length) log(`  name scan found ${freshPlaces.length} new place(s); they are replaced by "a city", "a street"... in what is sent (review them on the Privacy page)`);

  // 3: pseudonyms for the listed words and the names found; a business name stays readable only where it appears in full
  const p = await loadPrivate();
  const words = effectiveWords(p);
  const listed = new Set(p.words.map((w) => w.normalize('NFKC').toLowerCase()));
  const foundOnly = words.filter((w) => !listed.has(w.normalize('NFKC').toLowerCase()));
  const places = effectivePlaces(p);
  const notPlace = new Set(p.notPlaces.map((w) => w.toLowerCase()));
  // Clean = the scan of that name's own text found no person and no place (apart from ones you ruled out).
  const cleanScan = (n) => {
    const flagged = scan.byText.get(textKey('store', storeClean(n)));
    return Array.isArray(flagged?.people) && dropKnownNames(flagged.people, { notNames: p.notNames }).length === 0 && flagged.places.every((pl) => notPlace.has(pl.text.toLowerCase())) && !(flagged.local?.length > 0);
  };
  const protect = protectedNames({ candidates: used, listedWords: [...p.words, ...places.map((pl) => pl.word)], hiddenWords: words, isClean: cleanScan });
  const entries = pseudonymEntries(words, p.order);
  const scrubAll = makeScrubber(entries, { protect, places });
  // Words from a place the reader gave in another form are hidden in that one text only, never recorded.
  const scrub = (text) => {
    const extra = scan.locals.get(norm(text));
    return extra?.length ? makeScrubber(entries, { protect, places: [...places, ...extra.map((e) => ({ word: e.text, type: e.type }))] })(text) : scrubAll(text);
  };

  // 4-5: check each finished request, then send it
  const picks = receipt.items.map(() => null);
  let tokens = 0;
  let sent = 0;
  let refused = 0;
  let reused = 0;
  const answers = new Map(); // job index -> pick
  for (const [n, job] of jobs.entries()) {
    const { body, codes } = buildRemoteRequest(job.input, (text) => scrub(text));
    const everyLabel = [...codes.all(), ...(args.allLabels ?? []), ...labels].filter((l) => l.includes(' / '));
    const leaks = findLeaks(body, { labels: everyLabel, words, found: foundOnly, protect, places });
    if (leaks.length) log(`    remote decider: ${job.what} NOT sent; the privacy check found something private in ${describeLeaks(leaks)}`);
    if (preview) {
      await writePreview(body, job.name, leaks);
      answers.set(n, unsure(`preview only: nothing was sent${leaks.length ? ' (the privacy check would hold it back)' : ''}`));
      continue;
    }
    if (leaks.length) {
      answers.set(n, unsure(`${HELD_BACK}: ${describeLeaks(leaks)}`));
      continue;
    }
    // An answer already paid for in an earlier try of this receipt (same request, same model): use it, do not ask again.
    const fp = requestFingerprint(body, codes.all());
    const paid = args.cache?.[fp];
    if (paid) {
      answers.set(n, check(decodeAnswer(paid, codes), labels));
      reused++;
      continue;
    }
    let out;
    try {
      out = await remotePost(body);
    } catch (err) {
      // 400/413: this item. Another 4xx (422...): the setup is wrong only if the fixed probe fails too.
      const probeErr = err instanceof DeciderShapeError ? await probeError() : null;
      const itemOnly = err instanceof DeciderItemError || (err instanceof DeciderShapeError && probeErr === null);
      // The probe failing for its own reason (outage, rate limit, bad key) is the real cause: report that, not the 422.
      if (!itemOnly) throw probeErr && (isTransient(probeErr) || probeErr instanceof DeciderAuthError) ? probeErr : err;
      log(`    remote decider: ${job.what} was refused (${err.message})`);
      if (job.i != null) refused++;
      answers.set(n, unsure(`the hosted decider refused this ${job.i != null ? 'item' : 'question'} (HTTP ${err.status})`));
      continue;
    }
    sent++;
    tokens += Number(out?.usage?.input_tokens) || 0;
    // Keep the answer with the receipt's state right away: if a later item times out, this one is not bought again.
    // Only the answer (a choice and its numbers); never the request, which holds the receipt's words.
    const answer = (out?.answers ?? out)?.category;
    if (args.cache && out?.unparsable == null && answer && typeof answer === 'object') args.cache[fp] = answer;
    answers.set(n, out?.unparsable != null ? unsure(`reply is not JSON: ${brief(out.unparsable)}`) : check(decodeAnswer((out?.answers ?? out)?.category, codes), labels));
  }
  for (const [n, job] of jobs.entries()) {
    if (job.i != null) picks[job.i] = answers.get(n);
    else picks.receipt = answers.get(n);
  }
  if (refused > 0 && refused === todo.length) {
    await reportSetupProblem(new Error(`the hosted decider refused every item of the last receipt (HTTP 400/413), so they were marked unsure: check DECIDER_REMOTE_MODEL and the category list`), { pausing: false });
  }
  if (reused) log(`  remote decider: ${reused} answer(s) from an earlier try were reused, not bought again`);
  if (sent) log(`  remote decider: ${sent} request(s), ${tokens} input tokens (about $${((tokens * PRICE_PER_MILLION_TOKENS) / 1e6).toFixed(5)})`);
  return picks;
}
