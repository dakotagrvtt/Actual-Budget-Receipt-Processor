import { exclusive } from './session-lock.js';
// What the status page's buttons do. Each handler takes the submitted form (a URLSearchParams) and returns a short
// notice to show, or throws PanelError with a message for the user. No HTTP in here, so tests call them directly.
import crypto from 'node:crypto';
import { config, log } from './config.js';
import { loadCategoryNotes, saveUserNote, restoreNote, isDraft, receiptLabels } from './category-notes.js';
import { knownCategories } from './known-categories.js';
import { exclusionRules, loadOverrides } from './web-settings.js';
import { keywordCandidates, syncLearned, addKeyword, normalize, removeKeyword, restoreKeyword, findKeyword, loadKeywords, strengthOf } from './keywords.js';
import { forgetLesson, loadLessonFile, restoreLesson } from './memory.js';
import { forgetKeys, loadState, parseStateKey } from './state.js';
import { resolveDryRun, writeSettings } from './settings.js';
import { addWord, removeWord, addNotName, removeNotName, loadPrivate, validWord, validPlace, addPlaceWord, removePlaceWord, addNotPlace, removeNotPlace, restoreFound, restoreFoundPlace } from './private-words.js';

export class PanelError extends Error {}
/** A category note is a plain string or { description, ... }. */
const descriptionOf = (note) => (typeof note === 'string' ? note : (note?.description ?? ''));
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export const MAX_DESCRIPTION = 2000;
const MAX_PHRASE = 100;
const MAX_UNDO_TEXT = 1000; // a longer old description gets no Undo (it travels in the redirect link)
const MAX_UNDO_FIELDS = 12; // an Undo link carries a handful of short fields; more is a hand-made link
const MAX_UNDO_FIELD_NAME = 20;
const MAX_WRITTEN_BY = 60;
const MS_PER_MINUTE = 60000;
const CLOCK_SKEW_MS = MS_PER_MINUTE; // an Undo stamped this far in the future is refused
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The undo forms a handler may offer: route name (no slash) → used by the page to build the form. */
export const UNDO_ROUTES = new Set(['undo-keyword', 'undo-category', 'undo-word', 'undo-notname', 'undo-notname-mark', 'undo-place', 'undo-notplace', 'undo-notplace-mark', 'undo-lesson', 'undo-settings', 'undo-exclude', 'undo-receipt-fix']);
/** A handler fills out.undo = { route, fields } to say "this can be undone with a POST of these fields". */
export const offerUndo = (out, route, fields) => {
  if (out) out.undo = { route, fields: signUndo(route, fields) };
};

// An Undo link is good for 15 minutes and is signed (HMAC with the trigger token) over its route, fields and time,
// so an old link from the browser history or a hand-made form can't change anything.
const UNDO_MINUTES = 15;
export const UNDO_WINDOW_MS = UNDO_MINUTES * MS_PER_MINUTE;
const canon = (entries) => JSON.stringify([...entries].map(([k, v]) => [k, String(v).replace(/\r\n/g, '\n')]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)));
const macOf = (route, entries) => crypto.createHmac('sha256', String(config.trigger.token)).update(`${route}\n${canon(entries)}`).digest('hex');
/** The fields plus a time stamp and signature. */
export function signUndo(route, fields, now = Date.now()) {
  const all = { ...fields, ts: String(now) };
  return { ...all, mac: macOf(route, Object.entries(all)) };
}
/** Throws a PanelError unless the form is a signed, fresh Undo for this route, with no field added or changed. */
export function checkUndo(route, form, now = Date.now()) {
  const mac = form.get('mac') ?? '';
  const entries = [...form.entries()].filter(([k]) => k !== 'mac');
  const want = Buffer.from(macOf(route, entries));
  const got = Buffer.from(mac);
  const ts = Number(form.get('ts'));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want) || !Number.isFinite(ts)) throw new PanelError('That Undo link isn\'t valid any more. Nothing was changed.');
  if (now - ts > UNDO_WINDOW_MS || ts - now > CLOCK_SKEW_MS) throw new PanelError(`That Undo link is older than ${UNDO_MINUTES} minutes, so nothing was changed.`);
}
/** The undo asked for in a page link (?undo=route&u=json), or null. Only known routes and plain string fields pass. */
export function undoFromQuery(params) {
  const route = params.get('undo');
  if (!UNDO_ROUTES.has(route)) return null;
  try {
    const raw = JSON.parse(params.get('u') ?? '{}');
    const entries = Object.entries(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || entries.length > MAX_UNDO_FIELDS || entries.some(([k, v]) => typeof v !== 'string' || v.length > MAX_UNDO_TEXT + 10 || k.length > MAX_UNDO_FIELD_NAME)) return null;
    return { route, fields: Object.fromEntries(entries) };
  } catch {
    return null;
  }
}

/** Dry run or live. Going live needs the confirmation box ticked; going back to dry run needs nothing. */
export async function changeMode(form) {
  const mode = form.get('mode');
  if (mode !== 'live' && mode !== 'dry') throw new PanelError('Unknown mode.');
  if (mode === 'live' && form.get('confirm') !== 'yes') throw new PanelError('Tick the box to confirm before going live.');
  const dryRun = mode === 'dry';
  const { dryRun: current, source } = resolveDryRun();
  // An unusable file is rewritten even when the mode looks right, so the next reader finds a clean one.
  if ((source === 'settings' || source === 'env') && current === dryRun && dryRun === config.dryRun) return `Already ${dryRun ? 'in dry run' : 'live'}.`;
  await writeSettings({ dryRun, changedBy: 'status page' });
  log(`mode set to ${dryRun ? 'dry run' : 'live'} from the status page; applies at the start of the next check`);
  return dryRun
    ? 'Switching to dry run. It applies at the start of the next check (press "Check now" to do it right away).'
    : 'Switching to live. It applies at the start of the next check (press "Check now" to do it right away).';
}

/** The group part of "Group / Category" when the category list from Actual isn't known yet (a category name rarely has " / " in it). */
const groupOfLabel = (label) => (label.includes(' / ') ? label.slice(0, label.lastIndexOf(' / ')) : 'Other');

/**
 * The categories in the notes file that receipts may use: [{ label, description, draft }]. Ones excluded with
 * EXCLUDE_CATEGORY_GROUPS / EXCLUDE_CATEGORIES (or on the Categories tab) stay in the file (they come back as they were if
 * un-excluded) but aren't listed.
 */
export function listCategories() {
  const notes = loadCategoryNotes();
  const shown = new Set(receiptLabels(Object.keys(notes), exclusionRules()));
  return Object.entries(notes).filter(([label]) => shown.has(label)).map(([label, v]) => ({
    label,
    description: descriptionOf(v),
    draft: isDraft(v),
  }));
}

/**
 * What the Categories tab shows: every spending category Actual had at the last check (plus any in the notes file), with its
 * description (empty when it has none), grouped, and the excluded groups and categories for the "Excluded" section.
 * { groups: [{ name, categories: [{ label, description, draft }] }], excluded: { groups: [{ name, labels }], categories: [{ label }] }, damaged }
 */
export function categoriesData() {
  const overrides = loadOverrides();
  const rules = exclusionRules(overrides);
  const notes = loadCategoryNotes();
  const known = knownCategories();
  const groupOf = new Map(known.map((c) => [c.label, c.group]));
  const labels = [...new Set([...known.map((c) => c.label), ...Object.keys(notes)])];
  const shown = new Set(receiptLabels(labels, rules));
  const groups = [];
  for (const label of labels.filter((l) => shown.has(l))) {
    const name = groupOf.get(label) ?? groupOfLabel(label);
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, categories: [] }));
    g.categories.push({ label, description: descriptionOf(notes[label]), draft: isDraft(notes[label]) });
  }
  const underGroup = (label) => rules.excludeGroups.some((g) => label.startsWith(`${g} / `));
  return {
    groups,
    excluded: {
      groups: rules.excludeGroups.map((name) => ({ name, labels: labels.filter((l) => l.startsWith(`${name} / `)) })),
      categories: rules.excludeCategories.filter((l) => !underGroup(l)).map((label) => ({ label })),
    },
    damaged: overrides.damaged,
  };
}

/** A category the Categories tab lists: in the notes file or in Actual's list, and not excluded. */
const listed = (label) => (Object.hasOwn(loadCategoryNotes(), label) || knownCategories().some((c) => c.label === label)) && receiptLabels([label], exclusionRules()).length === 1;

export async function saveCategory(form, out) {
  const label = form.get('label') ?? '';
  const description = (form.get('description') ?? '').trim();
  if (!description) throw new PanelError('The description can\'t be empty.');
  if (description.length > MAX_DESCRIPTION) throw new PanelError(`Keep the description under ${MAX_DESCRIPTION} characters.`);
  if (!listed(label)) throw new PanelError('That category isn\'t in the list.');
  const before = loadCategoryNotes()[label];
  const changed = await saveUserNote(label, description, undefined, true); // true: a category with no entry yet gets one
  // Saving a draft unchanged still makes it yours, which saveUserNote does; false only means a plain string with the same text.
  if (!changed) return `"${label}" was already like that.`;
  const old = descriptionOf(before);
  if (old.length > MAX_UNDO_TEXT) return `Saved "${label}". It is now marked as written by you. The old text was too long to offer Undo.`;
  offerUndo(out, 'undo-category', { label, wrote: hash(description), description: old, auto: isDraft(before) ? '1' : '', writtenBy: String(before?.writtenBy ?? '').slice(0, MAX_WRITTEN_BY), written: String(before?.written ?? '').slice(0, 20) });
  return `Saved "${label}". It is now marked as written by you.`;
}

/** Undo a save: the earlier text and draft state come back (validated like a save, except that it may be empty). */
export async function undoCategory(form) {
  checkUndo('undo-category', form);
  const label = form.get('label') ?? '';
  const description = (form.get('description') ?? '').replace(/\r\n/g, '\n'); // browsers send line breaks as CRLF
  if (description.length > MAX_UNDO_TEXT) throw new PanelError('That description is too long to restore.');
  if (!listed(label)) throw new PanelError('That category isn\'t in the list.');
  const cur = loadCategoryNotes()[label];
  if (hash(descriptionOf(cur)) !== form.get('wrote')) return `"${label}" has changed since, so the earlier text was not put back.`;
  const writtenBy = (form.get('writtenBy') ?? '').slice(0, MAX_WRITTEN_BY);
  const written = DATE.test(form.get('written') ?? '') ? form.get('written') : '';
  await restoreNote(label, { description, auto: form.get('auto') === '1', writtenBy, written });
  return `Restored the earlier description of "${label}".`;
}

/** The phrase, category, store and strength of a keyword form, checked the same way for adding and for undoing a removal. */
function keywordFields(form) {
  const phrase = (form.get('phrase') ?? '').trim();
  const category = form.get('category') ?? '';
  const store = (form.get('store') ?? '').trim();
  const strength = form.get('strength') === 'always' ? 'always' : 'usually';
  if (!normalize(phrase)) throw new PanelError('Type a phrase (letters or numbers).');
  if (phrase.length > MAX_PHRASE || store.length > MAX_PHRASE) throw new PanelError(`Keep the phrase and store under ${MAX_PHRASE} characters.`);
  if (store && !normalize(store)) throw new PanelError('The store needs letters or numbers, or leave it empty.');
  if (!Object.hasOwn(loadCategoryNotes(), category)) throw new PanelError('Pick a category from the list.');
  return { phrase, category, store: store || null, strength };
}

export async function addKeywordFromForm(form) {
  const { phrase, category, store, strength } = keywordFields(form);
  const k = await addKeyword({ phrase, category, store, strength, from: 'status page' });
  return `Added "${k.phrase}"${k.store ? ` at ${k.store}` : ''} → ${k.category} (${k.strength}).`;
}

export async function removeKeywordFromForm(form, out) {
  const phrase = form.get('phrase') ?? '';
  const store = (form.get('store') ?? '').trim() || null;
  if (phrase.length > MAX_PHRASE || (store?.length ?? 0) > MAX_PHRASE) throw new PanelError(`Keep the phrase and store under ${MAX_PHRASE} characters.`);
  const before = findKeyword(await loadKeywords(), phrase, store);
  const n = await removeKeyword(phrase, store);
  if (!n) throw new PanelError(`No keyword "${phrase}" any more.`);
  if (before) {
    const text = (v) => String(v ?? '').slice(0, MAX_PHRASE);
    offerUndo(out, 'undo-keyword', { phrase: text(before.phrase), category: String(before.category ?? ''), store: text(before.store), strength: strengthOf(before), added: text(before.added), from: text(before.from), fromTxn: text(before.fromTxn) });
  }
  return `Removed "${phrase}".`;
}

const FROM = new Set(['cli', 'actual', 'status page', 'learned']);
/** Undo a keyword removal: the same keyword (own added date and source) is back and its tombstone is gone. */
export async function undoKeyword(form) {
  checkUndo('undo-keyword', form);
  const kw = keywordFields(form);
  const added = form.get('added') ?? '';
  const from = form.get('from') ?? '';
  const fromTxn = (form.get('fromTxn') ?? '').slice(0, MAX_PHRASE);
  const k = await restoreKeyword({ ...kw, added: DATE.test(added) ? added : undefined, from: FROM.has(from) ? from : 'status page', ...(fromTxn ? { fromTxn } : {}) });
  if (!k) return `"${kw.phrase}" is already on the list.`;
  // A learned keyword comes back only while the corrections it was learned from still say so.
  if (k.from === 'learned' && (await syncLearned(keywordCandidates((await loadLessonFile()).lessons))).removed > 0) {
    return `"${kw.phrase}" was not restored: the corrections it was learned from are gone (forgotten or undone). It can come back when you correct it again.`;
  }
  return `Restored "${k.phrase}" → ${k.category} (${k.strength}).`;
}

const LESSON_ID = /^[0-9a-f]{12}$/;

/** Learned page: forget one thing the worker learned from a correction. It is remembered, so the sweep won't learn it again. */
export async function forgetLessonFromForm(form, out) {
  const id = form.get('id') ?? '';
  if (!LESSON_ID.test(id)) throw new PanelError('Unknown lesson.');
  const l = await forgetLesson(id);
  if (!l) throw new PanelError('That lesson is not there any more.');
  offerUndo(out, 'undo-lesson', { id });
  const what = l.forgotCount > 1 ? `the whole-receipt correction (${l.forgotCount} items) → ${l.filed}` : `"${l.item}" → ${l.filed}`;
  return `Forgot ${what}. It will not be learned again, and a keyword that depended on it is gone.`;
}

/** Undo a Forget: the lesson is back. */
export async function undoLesson(form) {
  checkUndo('undo-lesson', form);
  const id = form.get('id') ?? '';
  if (!LESSON_ID.test(id)) throw new PanelError('Unknown lesson.');
  const l = await restoreLesson(id);
  return l ? `Restored "${l.item}" → ${l.filed}.` : 'That lesson was not forgotten (or is already back).';
}

/**
 * Can this recent receipt be tried again? 'yes': live, went to Needs review and nothing was applied to Actual
 * (result "review", or "failed" after 3 errors). 'undo': Actual was changed for it (entry.applied is set, whatever the
 * result says; "<action>+review" also counts): Actual has to be fixed by hand first. 'no': anything else, including every dry-run result (nothing was moved).
 */
export function retryStatus(key, entry) {
  if (parseStateKey(key).dry || !entry?.done || entry.archived || entry.resolutionPending || entry.filing || entry.creating) return 'no';
  if (entry.applied) return 'undo';
  if (entry.result === 'review' || entry.result === 'failed') return 'yes';
  if (String(entry.result ?? '').endsWith('+review')) return 'undo';
  return 'no';
}

// Retry shares the Actual session lock with saves and worker checks, then revalidates the current entry.
export async function tryAgain(form, deps = {}) {
  try { return await exclusive(() => tryAgainNow(form, deps), { timeoutMs: deps.lockWaitMs ?? 20000 }); }
  catch (err) { if (err.name === 'BusyError') throw new PanelError('The worker is busy. Try again in a minute.'); throw err; }
}

async function tryAgainNow(form, deps) {
  const key = form.get('entry') ?? '';
  if (config.dryRun || resolveDryRun().dryRun) throw new PanelError('Nothing is moved in dry run. Go live first.');
  let state;
  try {
    state = await loadState();
  } catch (err) {
    throw new PanelError(`Can't read the list of receipts (${err.message}). Nothing was moved.`);
  }
  const entry = state[key];
  if (!entry) throw new PanelError('That receipt isn\'t in the list any more (it may already have been sent back). Nothing was moved.');
  if (entry.archived) throw new PanelError('That receipt is archived. Restore it first (Archived tab); nothing was moved.');
  const status = retryStatus(key, entry);
  if (status === 'undo') throw new PanelError('That change was already applied in Actual. Undo it there first (restore the category and remove the #receipt note). Then delete the file from Needs review and upload the receipt again.');
  if (status !== 'yes') throw new PanelError('That receipt can\'t be tried again.');
  const name = parseStateKey(key).file.split('/').pop();
  if (!entry.filedAs) throw new PanelError(`This entry doesn't record where ${name} was filed (it is from an older version), so it can't be moved back safely. Delete it from Needs review and upload the receipt again.`);
  const nextcloud = deps.nextcloud ?? (await import('./nextcloud.js'));
  const out = await nextcloud.requeueFromReview(entry.filedAs, name);
  if (!out) throw new PanelError(`Couldn't find ${name} in the Needs review folder (expected ${entry.filedAs}). Upload the receipt again.`);
  if (out.refused === 'applied') throw new PanelError(`The summary next to ${name} says it was applied in Actual, so it was not moved. Check Actual; if it needs redoing, undo it there, delete the file from Needs review and upload the receipt again.`);
  if (out.refused === 'exists') throw new PanelError(`The inbox already has a file called ${name}, so nothing was moved. Rename or remove one of them, then try again.`);
  try {
    await forgetKeys([key]);
  } catch (err) {
    throw new PanelError(`${name} was moved back to the inbox, but the list of receipts could not be updated (${err.message}), so it may be skipped. Delete it from the inbox and upload the receipt again once that is fixed.`);
  }
  log(`try again from the status page: ${name} ${out.moved ? `moved back to ${out.moved}` : 'is already in the inbox'}; state cleared`);
  return `${name} is back in the inbox. It will be read again at the next check.`;
}

// ---- Privacy page (remote decider only): the words and places kept out of what is sent ----

/** Run a privacy-list change; its own errors (a damaged or full list) are shown to the user as they are. */
async function orPanelError(change) {
  try {
    return await change();
  } catch (err) {
    throw new PanelError(err.message);
  }
}

function needRemote() {
  if (config.decider.provider !== 'remote') throw new PanelError('Privacy settings only apply when DECIDER_PROVIDER=remote.');
}
function wordFrom(form) {
  const word = (form.get('word') ?? '').trim();
  if (!validWord(word)) throw new PanelError('Type a word or name of 2 to 40 characters, with a letter in it.');
  return word;
}

export async function addPrivateWord(form) {
  needRemote();
  const word = wordFrom(form);
  return orPanelError(async () => ((await addWord(word)) ? `"${word}" is now hidden from the remote decider.` : `"${word}" was already on the list.`));
}

export async function removePrivateWord(form, out) {
  needRemote();
  const word = wordFrom(form);
  if (!(await removeWord(word))) return `"${word}" wasn't on the list.`;
  offerUndo(out, 'undo-word', { word });
  return `"${word}" is no longer on the list. Requests may now include it.`;
}

/** Undo a removal from "Names to hide": same checks as adding. */
export async function undoWord(form) {
  checkUndo('undo-word', form);
  needRemote();
  const word = wordFrom(form);
  await orPanelError(() => addWord(word));
  return `"${word}" is back on the list.`;
}

/** "Not a name" on a word the scan found: it is sent as it is from now on. */
export async function markNotName(form, out) {
  needRemote();
  const word = wordFrom(form);
  const rec = (await loadPrivate()).found.find((f) => f.word.toLowerCase() === word.toLowerCase());
  if (!(await addNotName(word))) return `"${word}" was already marked as not a name.`;
  offerUndo(out, 'undo-notname-mark', { word: rec?.word ?? word, ...(rec ? { firstSeen: rec.firstSeen } : {}) });
  return `"${word}" is not treated as a name any more.`;
}

/** Undo "Not a name": the word leaves that list and its found record (with its first-seen date) comes back. */
export async function undoNotNameMark(form) {
  checkUndo('undo-notname-mark', form);
  needRemote();
  const word = wordFrom(form);
  const firstSeen = form.has('firstSeen') ? dateOrEmpty(form.get('firstSeen')) : null;
  await restoreFound(word, firstSeen);
  return `"${word}" is on the scan's list again.`;
}

export async function unmarkNotName(form, out) {
  needRemote();
  const word = wordFrom(form);
  if (!(await removeNotName(word))) return `"${word}" wasn't on the list.`;
  offerUndo(out, 'undo-notname', { word });
  return `"${word}" can be flagged as a name again.`;
}

export async function undoNotName(form) {
  checkUndo('undo-notname', form);
  needRemote();
  const word = wordFrom(form);
  await addNotName(word);
  return `"${word}" is marked as not a name again.`;
}

const dateOrEmpty = (v) => (DATE.test(v ?? '') ? v : '');

function placeFrom(form) {
  const word = (form.get('word') ?? '').trim();
  if (!validPlace(word)) throw new PanelError('Type a town, street or ZIP code of 3 to 40 characters.');
  return word;
}

export async function addPrivatePlace(form) {
  needRemote();
  const word = placeFrom(form);
  return orPanelError(async () => ((await addPlaceWord(word)) ? `"${word}" is now replaced by "a place" in what is sent.` : `"${word}" was already on the list.`));
}

export async function removePrivatePlace(form, out) {
  needRemote();
  const word = placeFrom(form);
  if (!(await removePlaceWord(word))) return `"${word}" wasn't on the list.`;
  offerUndo(out, 'undo-place', { word });
  return `"${word}" is no longer on the list. Requests may now include it.`;
}

export async function undoPlace(form) {
  checkUndo('undo-place', form);
  needRemote();
  const word = placeFrom(form);
  await orPanelError(() => addPlaceWord(word));
  return `"${word}" is back on the list.`;
}

/** "Not a place" on a place the scan found: it is sent as it is from now on. */
export async function markNotPlace(form, out) {
  needRemote();
  const word = placeFrom(form);
  const rec = (await loadPrivate()).places.find((f) => f.word.toLowerCase() === word.toLowerCase());
  if (!(await addNotPlace(word))) return `"${word}" was already marked as not a place.`;
  offerUndo(out, 'undo-notplace-mark', { word: rec?.word ?? word, ...(rec ? { type: rec.type, firstSeen: rec.firstSeen } : {}) });
  return `"${word}" is not treated as a place any more.`;
}

/** Undo "Not a place": the place leaves that list and its found record (type, first-seen date) comes back. */
export async function undoNotPlaceMark(form) {
  checkUndo('undo-notplace-mark', form);
  needRemote();
  const word = placeFrom(form);
  const firstSeen = form.has('firstSeen') ? dateOrEmpty(form.get('firstSeen')) : null;
  await restoreFoundPlace(word, form.get('type') ?? 'place', firstSeen);
  return `"${word}" is on the scan's list again.`;
}

export async function unmarkNotPlace(form, out) {
  needRemote();
  const word = placeFrom(form);
  if (!(await removeNotPlace(word))) return `"${word}" wasn't on the list.`;
  offerUndo(out, 'undo-notplace', { word });
  return `"${word}" can be flagged as a place again.`;
}

export async function undoNotPlace(form) {
  checkUndo('undo-notplace', form);
  needRemote();
  const word = placeFrom(form);
  await addNotPlace(word);
  return `"${word}" is marked as not a place again.`;
}

/** What the Privacy page shows: { words, found: [{ word, firstSeen }], notNames, placeWords, places: [{ word, type, firstSeen }], notPlaces }. */
export async function privacyData() {
  const { words, found, notNames, placeWords, places, notPlaces } = await loadPrivate();
  const not = new Set(notNames.map((w) => w.toLowerCase()));
  const notP = new Set(notPlaces.map((w) => w.toLowerCase()));
  return { words, found: found.filter((f) => !not.has(f.word.toLowerCase())), notNames, placeWords, places: places.filter((f) => !notP.has(f.word.toLowerCase())), notPlaces };
}
