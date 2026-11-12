// The files the worker learns into (data/memory, MEMORY_DIR): what it applied and still watches (watch.json), what you
// corrected (lessons.json) and when it last looked (sweep.json). No Actual in here, so actual.js and the panel can read them.
// Every write is atomic and under a lock; a missing or damaged file reads as empty.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import { withLock, writeJsonAtomic } from './file-lock.js';
import { keywordCandidates, syncLearned } from './keywords.js';

const WATCH_MAX = 400;
const WATCH_DAYS = 60;
export const LESSONS_MAX = 1000;
const FORGOTTEN_MAX = 500;
const DAY_MS = 86400000;

const where = (name) => path.join(config.learning.dir, name);

/** A memory file that exists but can't be read as JSON. It is never written over (the panel says so; fix or delete the file). */
export class MemoryError extends Error {}

async function readJson(name, dflt) {
  let text;
  try {
    text = await fs.readFile(where(name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return dflt;
    throw new MemoryError(`${where(name)} can't be read: ${err.message}`);
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new MemoryError(`${where(name)} is damaged (${err.message}); fix or delete it`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new MemoryError(`${where(name)} is damaged (not a JSON object); fix or delete it`);
  return j;
}

const warned = new Set();
/** Log a memory problem once per file and message, not on every poll. */
export function warnOnce(err) {
  if (warned.has(err.message)) return;
  warned.add(err.message);
  log(`learning: ${err.message}`);
}

/** Load-modify-save one file under its lock. fn gets the parsed object and returns the one to save. */
const update = (name, dflt, fn) =>
  withLock(`${where(name)}.lock`, async () => {
    const next = fn(await readJson(name, dflt));
    await writeJsonAtomic(where(name), next);
    return next;
  });

const fresh = (e, now) => now - Date.parse(e.watchedAt) <= WATCH_DAYS * DAY_MS;

/** The watched snapshots (newest last), without the ones older than WATCH_DAYS. */
export async function loadWatch(now = Date.now()) {
  const j = await readJson('watch.json', { entries: [] });
  return (Array.isArray(j.entries) ? j.entries : []).filter((e) => e && e.txnId && fresh(e, now));
}

/**
 * Change the watch list without replacing it (a charge watched meanwhile stays): `drop` = ids to stop watching, `verified` =
 * ids you confirmed, `unverified` = ids whose confirmation no longer holds.
 */
export const patchWatch = ({ drop = [], verified = [], unverified = [] }, now = Date.now()) =>
  update('watch.json', { entries: [] }, (j) => {
    const gone = new Set(drop);
    const yes = new Set(verified);
    const no = new Set(unverified);
    const entries = (Array.isArray(j.entries) ? j.entries : []).filter((e) => e && !gone.has(e.txnId) && fresh(e, now)).map((e) => {
      if (yes.has(e.txnId)) return { ...e, verified: true };
      if (no.has(e.txnId)) {
        const { verified: _gone, ...rest } = e;
        return rest;
      }
      return e;
    });
    return { entries: entries.slice(-WATCH_MAX) };
  });

/** Start watching a transaction the worker just changed. A second snapshot of the same transaction replaces the first. */
export const watch = (snapshot, now = Date.now()) =>
  update('watch.json', { entries: [] }, (j) => {
    const kept = (Array.isArray(j.entries) ? j.entries : []).filter((e) => e && e.txnId !== snapshot.txnId && fresh(e, now));
    return { entries: [...kept, { ...snapshot, watchedAt: new Date(now).toISOString() }].slice(-WATCH_MAX) };
  });

const MARKS_MAX = 5000;

/** { confirmed: [txn ids], corrected: { txn id: [part keys] } }: what you confirmed or changed, kept after the watch expires. */
export async function loadMarks() {
  const j = await readJson('marks.json', {});
  return { confirmed: Array.isArray(j.confirmed) ? j.confirmed : [], corrected: j.corrected && typeof j.corrected === 'object' && !Array.isArray(j.corrected) ? j.corrected : {} };
}

/** Remember sweep verdicts: ids confirmed, parts corrected ({ id: [keys] }), and ids to forget (reverted). Bounded. */
export const recordMarks = ({ confirmed = [], corrected = {}, clear = [] }) =>
  update('marks.json', {}, (j) => {
    const cur = { confirmed: Array.isArray(j.confirmed) ? j.confirmed : [], corrected: j.corrected && typeof j.corrected === 'object' && !Array.isArray(j.corrected) ? j.corrected : {} };
    const drop = new Set(clear);
    const sure = [...cur.confirmed.filter((id) => !drop.has(id) && !(id in corrected)), ...confirmed.filter((id) => !(id in corrected))];
    const fixed = Object.fromEntries(Object.entries({ ...cur.corrected, ...corrected }).filter(([id]) => !drop.has(id)));
    const ids = Object.keys(fixed);
    for (const id of ids.slice(0, Math.max(0, ids.length - MARKS_MAX))) delete fixed[id];
    return { confirmed: [...new Set(sure)].slice(-MARKS_MAX), corrected: fixed };
  });

const SEEN_MAX = 2000;

/**
 * What Actual had when a charge was last looked at, by transaction id (the sweep and the receipt page's "Check Actual now"):
 * { at, changed: why the items can't be matched (or null), items: [{ d, now, said }] the items whose category differs from what
 * was filed, whole: the one category the whole charge has now (or null), review: #review is still in the notes, reviewed: it was
 * flagged and #review is gone (whatever else changed) }. Kept apart from the marks, which mean confirmed or corrected.
 */
export async function loadSeen() {
  const j = await readJson('seen.json', {});
  return j.seen && typeof j.seen === 'object' && !Array.isArray(j.seen) ? j.seen : {};
}

/** Remember what Actual had for these charges ({ txnId: record }), replacing earlier records; at most SEEN_MAX (the oldest go). */
export const recordSeen = (records) =>
  update('seen.json', {}, (j) => {
    const seen = { ...(j.seen && typeof j.seen === 'object' && !Array.isArray(j.seen) ? j.seen : {}), ...records };
    const ids = Object.keys(seen).sort((a, b) => String(seen[a]?.at ?? '').localeCompare(String(seen[b]?.at ?? '')));
    for (const id of ids.slice(0, Math.max(0, ids.length - SEEN_MAX))) delete seen[id];
    return { seen };
  });

/** Forget the looks at these charges (Undo of a change made on the receipt page). */
export const forgetSeen = (ids) =>
  update('seen.json', {}, (j) => {
    const seen = { ...(j.seen && typeof j.seen === 'object' && !Array.isArray(j.seen) ? j.seen : {}) };
    for (const id of ids) delete seen[id];
    return { seen };
  });

/** loadSeen for the pages: a damaged file reads as empty (the Learned page and the sweep report it). */
export async function seenIndex() {
  try {
    return await loadSeen();
  } catch (err) {
    if (!(err instanceof MemoryError)) throw err;
    warnOnce(err);
    return {};
  }
}

/** Put one charge's marks back as they were ({ confirmed: boolean, corrected: keys | null }), after an Undo from the receipt page. */
export const restoreMarks = (txnId, was) =>
  update('marks.json', {}, (j) => {
    const confirmed = (Array.isArray(j.confirmed) ? j.confirmed : []).filter((id) => id !== txnId);
    const corrected = { ...(j.corrected && typeof j.corrected === 'object' && !Array.isArray(j.corrected) ? j.corrected : {}) };
    delete corrected[txnId];
    if (was.confirmed) confirmed.push(txnId);
    if (was.corrected) corrected[txnId] = was.corrected;
    return { confirmed, corrected };
  });

/**
 * What provenance needs (actual.js): the watched snapshots by transaction id, the ids you confirmed (removed #review
 * without a change), and `corrected`: ids where you changed something, with the parts' keys. A damaged file reads as empty
 * here (receipts must not stop); the Learned page and the sweep report it.
 */
export async function watchIndex(now = Date.now()) {
  try {
    const entries = await loadWatch(now);
    const marks = await loadMarks();
    return {
      byTxn: new Map(entries.map((e) => [e.txnId, e])),
      verified: new Set([...entries.filter((e) => e.verified).map((e) => e.txnId), ...marks.confirmed]),
      corrected: new Map(Object.entries(marks.corrected)),
    };
  } catch (err) {
    if (!(err instanceof MemoryError)) throw err;
    warnOnce(err);
    return { byTxn: new Map(), verified: new Set(), corrected: new Map() };
  }
}

/** { lessons, forgotten: [{ txnId, item }] } */
export async function loadLessonFile() {
  const j = await readJson('lessons.json', {});
  return { lessons: Array.isArray(j.lessons) ? j.lessons : [], forgotten: Array.isArray(j.forgotten) ? j.forgotten : [] };
}

/** Change the lesson file: fn({ lessons, forgotten }) returns the new one. */
export const updateLessons = (fn) =>
  update('lessons.json', {}, (j) => {
    const out = fn({ lessons: Array.isArray(j.lessons) ? j.lessons : [], forgotten: Array.isArray(j.forgotten) ? j.forgotten : [] });
    return { lessons: out.lessons, forgotten: out.forgotten.slice(-FORGOTTEN_MAX) };
  });

/**
 * Lessons from category changes made on the receipt page. `items` = the items (names) judged for this charge: whatever lesson the
 * page made earlier for them is replaced by `add` (an item put back as the worker had it ends with none). A lesson you forgot on the
 * Learned page is not made again. Returns { added, removed } (the lessons now there / no longer there), for the page's Undo.
 */
export async function recordPageLessons({ txnId, items, add }) {
  const norm = new Set(items.map((i) => String(i).toLowerCase()));
  let added = [];
  let removed = [];
  await updateLessons(({ lessons, forgotten }) => {
    removed = lessons.filter((l) => l.via === 'page' && l.txnId === txnId && norm.has(String(l.item).toLowerCase()));
    added = add.filter((l) => !forgotten.some((f) => f.txnId === l.txnId && String(f.item).toLowerCase() === String(l.item).toLowerCase()));
    return { lessons: [...lessons.filter((l) => !removed.includes(l)), ...added], forgotten };
  });
  return { added, removed };
}

/** Take back what recordPageLessons did: the lessons it added go (by id), the ones it replaced come back. */
export async function revertPageLessons({ added, removed }) {
  const ids = new Set(added.map((l) => l.id));
  await updateLessons(({ lessons, forgotten }) => ({ lessons: [...lessons.filter((l) => !ids.has(l.id)), ...removed.filter((r) => !lessons.some((l) => l.id === r.id && !ids.has(l.id)))], forgotten }));
}

export const loadSweepInfo = () => readJson('sweep.json', {});
export const saveSweepInfo = (info) => update('sweep.json', {}, () => info);
/** A sweep is starting: counted as a failure until it finishes (the sweep resets the count), so a failing one backs off. */
export const recordAttempt = (now = new Date()) =>
  update('sweep.json', {}, (j) => ({ ...j, lastAttempt: now.toISOString(), failures: (Number(j.failures) || 0) + 1 }));

// What the Learned page shows and does (kept here, not in learning.js, so the panel doesn't load Actual's API).
/** What the Learned page shows. A damaged memory file comes back as `error` (never written over). */
export async function learnedData() {
  const base = { mode: config.learning.mode, lastSweep: null, watching: 0, lessons: [], error: null };
  try {
    const { lessons } = await loadLessonFile();
    const info = await loadSweepInfo();
    return { ...base, lastSweep: info.lastSweep ?? null, watching: (await loadWatch()).length, lessons: [...lessons].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))) };
  } catch (err) {
    if (!(err instanceof MemoryError)) throw err;
    return { ...base, error: err.message };
  }
}

// Learned keywords follow the lessons: after a Forget (or its Undo) the ones the lessons no longer support go.
const resync = async () => syncLearned(keywordCandidates((await loadLessonFile()).lessons));

// Items moved together (a collapsed receipt) are one lesson to the household: Forget and Undo take them all.
const together = (a, b) => a.solo === false && b.solo === false && a.txnId === b.txnId && a.group === b.group && a.filed === b.filed;

/**
 * Forget a lesson (and, for items moved together, all the lessons of that change): they are removed and remembered, so the
 * sweep does not make them again. Returns the lesson with `forgotCount`, or null.
 */
export async function forgetLesson(id) {
  let gone = null;
  let n = 0;
  await updateLessons(({ lessons, forgotten }) => {
    gone = lessons.find((l) => l.id === id) ?? null;
    if (!gone) return { lessons, forgotten };
    const all = lessons.filter((l) => l === gone || together(l, gone));
    n = all.length;
    return { lessons: lessons.filter((l) => !all.includes(l)), forgotten: [...forgotten, ...all] };
  });
  if (gone) await resync();
  return gone && { ...gone, forgotCount: n };
}

/** Undo a Forget: the lesson (and the ones forgotten with it) is back and may be updated by the sweep again. Returns it, or null. */
export async function restoreLesson(id) {
  let back = null;
  await updateLessons(({ lessons, forgotten }) => {
    back = forgotten.find((l) => l.id === id) ?? null;
    if (!back) return { lessons, forgotten };
    const all = forgotten.filter((l) => l === back || together(l, back));
    return { lessons: [...lessons, ...all.filter((l) => !lessons.some((x) => x.id === l.id))], forgotten: forgotten.filter((l) => !all.includes(l)) };
  });
  if (back) await resync();
  return back;
}
