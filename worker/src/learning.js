// Learning from your corrections, so nobody has to teach the pipeline anything. The loop:
//   1. receipt.js applies a charge in Actual and hands back a snapshot of what it did; index.js calls watch(snapshot).
//   2. A few hours later (sweep) the worker looks at those charges in Actual. Where you changed a category it filed, that is
//      a lesson (who said what, where you put it). Silence is never evidence: an untouched charge teaches nothing.
//   3. Lessons come back in three small ways: as examples in the item history (by: 'corrected'), as at most 3 lines
//      "household_corrected_the_pipeline" in the decider's request, and, once you have done the same correction often
//      enough at one store, as a store-scoped keyword (from: 'learned').
// LEARNING=on|record|off (config.learning.mode). record = learn, but don't use it; off = nothing (no sweep, nothing read).
// Everything is stored under MEMORY_DIR (memory.js). Never writes to Actual.
import crypto from 'node:crypto';
import { config, log } from './config.js';
import * as actual from './actual.js';
import { isoDay, shiftDay } from './dates.js';
import { ITEMS_NOTE_MAX, SPLIT_NOTE_MAX, UNCATEGORIZED, cents, partKey, partNote } from './reconcile.js';
import { evidenceOf, isSmall, isSolo, keywordCandidates, keywordPhrase, kwVotesOf, normalize, stripDepartment, syncLearned } from './keywords.js';
import { lessonItemText, lessonLines } from './item-context.js';
import * as memory from './memory.js';

const HOUR_MS = 3600000;
const SWEEP_EVERY_MS = 6 * HOUR_MS;
const MAX_WAIT_MS = 24 * HOUR_MS; // backoff ceiling after failed sweeps
const START_BEFORE_DAYS = 7; // look this many days before the oldest watched charge's date
const MAX_IDS = 50; // charge ids kept on a merged lesson (the newest)

const mode = () => config.learning.mode;

// ---- 2. Snapshot + watch ----------------------------------------------------------------------------------------------

/** Where an item's category came from: model | fallback (store default) | keyword | unsure. */
const sourceOf = (it) => {
  if (it.source === 'household') return 'household'; // you chose it on the receipt page (receipt-fix.js)
  if (it.source === 'keyword') return 'keyword';
  if (it.fellBack) return 'fallback';
  if (it.category == null || it.category === UNCATEGORIZED) return 'unsure';
  return 'model';
};
// `part` = the allocation part the item is in. An item folded into another category's part (a small amount merged) keeps
// the category it was given in `cat`, which is what the worker really said about it.
const snapItem = (it, part) => {
  const merged = it.category != null && it.category !== part.label;
  return {
    d: it.description,
    plain: it.plain && it.plain.toLowerCase() !== it.description.toLowerCase() ? it.plain : null,
    src: sourceOf(it),
    ...(Number.isFinite(cents(it.amount)) ? { cents: cents(it.amount) } : {}), // the item's own price, for a learned keyword's item limit
    conf: it.confidence ?? null, // the top category's probability (categorize.js checkAnswer)
    ...(it.margin != null ? { margin: it.margin } : {}),
    ...(merged ? { cat: it.category, merged: true } : {}),
    ...(it.keyword ? { kw: it.keyword, kwCat: it.keywordCategory ?? null } : {}),
  };
};

/**
 * What the worker did to a transaction, for the sweep to compare with later (null when there is nothing to learn from:
 * a note only, or a single category chosen for a receipt that had several). `allocation` is the plan applied,
 * with its `refs` (reconcile.js allocate); the part notes are written exactly as applyPlan wrote them.
 */
export function buildSnapshot({ txn, item, receipt, allocation, action, review }) {
  if (action === 'note' || !allocation || (action !== 'split' && allocation.length !== 1)) return null;
  const parts = allocation.map((a) => ({
    label: a.categoryId ? a.label : null,
    cents: a.cents,
    note: action === 'split' ? partNote(a, ', ', SPLIT_NOTE_MAX) : partNote(a, '; ', ITEMS_NOTE_MAX),
    items: (a.refs ?? []).filter(Boolean).map((r) => snapItem(r, a)),
  }));
  return { txnId: txn.id, file: item.basename, date: txn.date, payee: receipt.payee ?? null, store: receipt.store ?? null, amountCents: -txn.amount, action, review: Boolean(review), parts };
}

/**
 * The fixes for item categories you changed on the receipt page, shaped like the ones the sweep finds. `entry` is the snapshot
 * of what the worker proposed (parts with their items); `filed` maps "partIndex:itemIndex" to the label you chose. Items you put
 * back as the worker had them, or left uncategorized, give none. Every change is a lone, deliberate one (solo).
 */
export function pageFixes(entry, filed) {
  const out = [];
  entry.parts.forEach((p, g) => p.items.forEach((it, k) => {
    const to = filed.get(`${g}:${k}`);
    if (!to || to === UNCATEGORIZED) return;
    const said = it.merged ? (it.cat === UNCATEGORIZED ? null : it.cat) : p.label;
    const f = fix(it, p, to, said === null ? 'filled' : 'item', g, true);
    if (f) out.push(f);
  }));
  return out;
}

/** The lessons for those fixes, marked as made on the page (the sweep keeps them while it still judges the charge). */
export const pageLessonsOf = (entry, fixes, day) => fixes.map((f) => ({ ...lessonOf(entry, f, day), via: 'page' }));

/** Remember a snapshot so the sweep can look at the charge later. */
export async function watch(snapshot) {
  if (!snapshot || mode() === 'off') return;
  await memory.watch(snapshot);
}

// ---- 3. Sweep -> lessons ----------------------------------------------------------------------------------------------

const lessonId = (txnId, group, item) => crypto.createHash('sha1').update(`${txnId}\n${group}\n${normalize(item)}`).digest('hex').slice(0, 12);
const wordsOf = (s) => new Set(normalize(s).split(' ').filter((w) => w.length >= 3));
/** Does a note you wrote name this item? All the item's words are in it, and they are at least half of a short note. */
const mentions = (note, item) => {
  const mine = wordsOf(stripDepartment(item.d));
  const theirs = wordsOf(partKey(note)); // without the worker's own annotations, e.g. "(pipeline: after 3.00 off)"
  return mine.size > 0 && [...mine].every((w) => theirs.has(w)) && mine.size * 2 >= theirs.size;
};
const totalItems = (entry) => entry.parts.reduce((n, p) => n + p.items.length, 0);

/**
 * One thing you changed: the item the worker filed, what the worker said about it (the category it picked, even when a
 * small amount was folded into another part), where you put it, and whether it moved alone (`solo`). Null when you
 * agree with what the worker said.
 */
function fix(item, part, filed, kind, group, solo) {
  const said = item.merged ? (item.cat === UNCATEGORIZED ? null : item.cat) : part.label;
  if (said === filed) return null;
  return { item, said, mergedInto: item.merged ? part.label : null, filed, kind, group, solo, partNote: part.note, partItems: part.items.length, partCents: part.cents };
}

/**
 * Compare one watched snapshot with the transaction as it is now. Returns { drop: reason } (gone, amount changed or
 * #receipt tag removed: learn nothing), or { fixes: [...], verified }. `label(categoryId)` gives the category label,
 * null for none, or undefined for a category that can't be named (hidden, deleted): that says nothing.
 */
export function judge(entry, t, label) {
  if (!t) return { drop: 'the charge is gone' };
  if (-t.amount !== entry.amountCents) return { drop: 'the amount changed' };
  if (!actual.hasTag(t.notes ?? '', `#receipt ${entry.file}`)) return { drop: 'the #receipt tag was removed' };
  const fixes = (t.is_parent ? fixesInSplit(entry, t, label) : fixesInSingle(entry, t, label)).filter(Boolean);
  const verified = entry.review && !/#review\b/.test(t.notes ?? '') && fixes.length === 0;
  return { fixes, verified };
}

// One category for the whole charge now. Several items moved together say little about each; a lone item is a plain correction.
function fixesInSingle(entry, t, label) {
  const now = label(t.category);
  if (!now) return []; // uncategorized or unknown now: no evidence
  const alone = totalItems(entry) === 1;
  return entry.parts.flatMap((p, g) => (p.label === now ? [] : p.items.map((it) => fix(it, p, now, alone ? 'item' : 'receipt', entry.action === 'split' ? 0 : g, alone))));
}

/**
 * Match snapshot parts to the children now: first the ones that are unchanged (same amount, same note, same category), then
 * the ones whose category you changed, when only one child fits. Parts that fit several children are skipped (can't tell).
 */
function matchParts(entry, children, label) {
  const parts = entry.parts.map((p) => ({ p, key: partKey(p.note) }));
  const at = new Map(); // part index -> child index
  const used = new Set();
  const fits = (pt, i) => !used.has(i) && children[i].cents === pt.p.cents && children[i].key === pt.key;
  parts.forEach((pt, g) => {
    const i = children.findIndex((c, k) => fits(pt, k) && label(c.c.category) === pt.p.label);
    if (i >= 0) { at.set(g, i); used.add(i); }
  });
  const rest = parts.map((pt, g) => g).filter((g) => !at.has(g));
  const skipped = new Set();
  for (const g of rest) {
    const cands = children.map((_, i) => i).filter((i) => fits(parts[g], i));
    const rivals = rest.filter((h) => parts[h].p.cents === parts[g].p.cents && parts[h].key === parts[g].key).length;
    if (cands.length === 1 && rivals === 1) { at.set(g, cands[0]); used.add(cands[0]); }
    else if (cands.length > 0) { skipped.add(g); cands.forEach((i) => used.add(i)); }
  }
  return { at, used, spare: rest.filter((g) => !at.has(g) && !skipped.has(g)) };
}

function fixesInSplit(entry, t, label) {
  const children = (t.subtransactions ?? []).map((c) => ({ c, key: partKey(c.notes), cents: -c.amount }));
  const { at, used, spare } = matchParts(entry, children, label);
  const out = [];
  for (const [g, i] of at) {
    const p = entry.parts[g];
    const now = label(children[i].c.category);
    if (now === undefined || now === null || now === p.label) continue;
    for (const it of p.items) out.push(fix(it, p, now, p.label === null ? 'filled' : 'item', g, p.items.length === 1));
  }
  // You restructured the split: a child whose note names an item takes that item's part with it, when only that child does.
  // Anything else is skipped.
  const left = spare.flatMap((g) => entry.parts[g].items.map((it) => ({ it, part: entry.parts[g] })));
  const loose = children.map((ch, i) => ({ ch, i })).filter(({ ch, i }) => !used.has(i) && label(ch.c.category));
  for (const { ch, i } of loose) {
    const hits = left.filter((x) => mentions(ch.c.notes ?? '', x.it) && loose.filter((o) => mentions(o.ch.c.notes ?? '', x.it)).length === 1);
    for (const x of hits) out.push(fix(x.it, x.part, label(ch.c.category), x.part.label === null ? 'filled' : 'item', i, hits.length === 1));
  }
  return out;
}

/** The lesson record for a fix on a watched snapshot. */
export const lessonOf = (entry, f, learnedAt = null) => ({
  id: lessonId(entry.txnId, f.group, f.item.d),
  ...(learnedAt ? { learnedAt } : {}), // the day the sweep saw the correction: when the worker could first have known it (lessonsUpTo)
  txnId: entry.txnId, file: entry.file, date: entry.date, payee: entry.payee ?? null, store: entry.store ?? null,
  item: f.item.d, plain: f.item.plain ?? null, said: f.said, saidHow: f.item.src, filed: f.filed, kind: f.kind, group: f.group,
  solo: f.solo, receiptItems: totalItems(entry), amountCents: entry.amountCents,
  ...(Number.isFinite(f.item.cents) ? { itemCents: f.item.cents } : {}),
  // The keyword that filed (or hinted) the item, when there was one: a correction of it counts against that keyword (keywords.js keywordCandidates).
  ...(f.item.kw ? { kw: f.item.kw, kwCat: f.item.kwCat ?? f.said } : {}),
  ...(f.partItems != null ? { partItems: f.partItems, partCents: f.partCents } : {}), ...(f.mergedInto ? { mergedInto: f.mergedInto } : {}),
});

/** Keep at most `max` lessons: same item at the same payee and category merge into one with a count, then the oldest go. */
export function compact(lessons, max = memory.LESSONS_MAX) {
  if (lessons.length <= max) return lessons;
  const merged = new Map();
  for (const l of lessons) {
    const key = [normalize(l.item), normalize(l.payee ?? l.store ?? ''), l.filed].join('|');
    const cur = merged.get(key);
    const ids = (x) => x.txnIds ?? [x.txnId];
    // Keep the evidence of every merged lesson: the largest size it was learned from, and whether any was a lone item or small.
    const evOf = (x) => {
      const e = evidenceOf(x);
      return { evidence: e.evidence, ...(e.cents != null ? { evidenceCents: e.cents } : {}), ...(e.itemCents != null ? { evidenceItemCents: e.itemCents } : {}), solo: isSolo(x), small: x.small ?? isSmall(x) };
    };
    // Every keyword a merged lesson went against stays on it (keywords.js keywordCandidates counts them), not just the newest one's.
    const against = (...xs) => { const v = xs.flatMap(kwVotesOf); return v.length ? { kwVotes: [...new Map(v.map((x) => [`${normalize(x.kw)}|${x.kwCat}`, x])).values()] } : {}; };
    if (!cur) merged.set(key, { ...l, count: l.count ?? 1, txnIds: ids(l), ...evOf(l), ...against(l) });
    else {
      const a = evOf(cur);
      const b = evOf(l);
      const largest = (k) => [a[k], b[k]].filter((n) => n != null);
      const top = (k) => (largest(k).length ? { [k]: Math.max(...largest(k)) } : {});
      merged.set(key, { ...((l.date ?? '') >= (cur.date ?? '') ? l : cur), evidence: a.evidence || b.evidence, solo: a.solo || b.solo, small: a.small || b.small, ...top('evidenceCents'), ...top('evidenceItemCents'), ...against(cur, l), ...(cur.learnedAt || l.learnedAt ? { learnedAt: [cur.learnedAt, l.learnedAt].filter(Boolean).sort().at(-1) } : {}), count: (cur.count ?? 1) + (l.count ?? 1), txnIds: [...new Set([...ids(cur), ...ids(l)])].slice(-MAX_IDS) });
    }
  }
  return [...merged.values()].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, max);
}

/** A lesson without the receipts being re-judged now: a merged one gives up their share of its count (null: nothing left). */
function withoutTxns(l, done) {
  const ids = l.txnIds ?? [l.txnId];
  const gone = ids.filter((id) => done.has(id)).length;
  if (!gone) return l;
  if ((l.count ?? 1) <= gone) return null;
  const rest = ids.filter((id) => !done.has(id));
  return { ...l, count: l.count - gone, txnId: rest[0] ?? `merged:${l.id}`, txnIds: rest };
}

const isForgotten = (forgotten, l) => forgotten.some((f) => f.txnId === l.txnId && normalize(f.item) === normalize(l.item));

/**
 * Is a sweep due? Live only, not LEARNING=off, something is watched, and the last attempt was over 6 hours ago. After
 * failed attempts the wait doubles each time, up to 24 hours (a sweep that keeps failing must not reopen Actual every poll).
 */
export async function isDue(now = new Date()) {
  if (config.dryRun || mode() === 'off') return false;
  try {
    if ((await memory.loadWatch(now.getTime())).length === 0) return false;
    const info = await memory.loadSweepInfo();
    const failures = Number(info.failures) || 0;
    const wait = failures > 0 ? Math.min(MAX_WAIT_MS, SWEEP_EVERY_MS * 2 ** failures) : SWEEP_EVERY_MS;
    const last = Date.parse(info.lastAttempt ?? info.lastSweep ?? '');
    return !Number.isFinite(last) || now.getTime() - last > wait;
  } catch (err) {
    if (!(err instanceof memory.MemoryError)) throw err;
    memory.warnOnce(err); // a damaged file: say so once, don't try every poll
    return false;
  }
}

/** Count a sweep attempt that failed before it could start (Actual would not open): the next one waits longer. */
export const recordFailedAttempt = (now = new Date()) => memory.recordAttempt(now);

/**
 * Look at every watched charge once (one pass over Actual's transactions) and update lessons, learned keywords and
 * the watch list. `id2label` = Map of category id -> label; `recorded` = the attempt was already written down. Returns counts, for the log. The attempt is written down
 * first; only a sweep that finishes clears the failure count (see isDue).
 */
export async function sweep({ id2label, now = new Date(), recorded = false }) {
  if (!recorded) await memory.recordAttempt(now); // (index.js records it as soon as the sweep is due, before Actual opens)
  const result = { watched: 0, dropped: 0, lessons: 0, verified: 0, keywords: 0 };
  const entries = await memory.loadWatch(now.getTime());
  result.watched = entries.length;
  if (entries.length) {
    const end = isoDay(now);
    // A receipt can be uploaded long after its date; the watch expires by when we started watching, not by the charge's date.
    const oldest = entries.map((e) => e.date).filter(Boolean).sort()[0] ?? end;
    const txns = new Map();
    for await (const { t } of actual.budgetTransactions(shiftDay(oldest, -START_BEFORE_DAYS), end)) if (!t.is_child) txns.set(t.id, t);
    const label = (id) => (id == null ? null : id2label.get(id));
    const judged = entries.map((e) => ({ e, j: judge(e, txns.get(e.txnId), label) }));
    const kept = judged.filter(({ j }) => !j.drop);
    for (const { e, j } of judged) if (j.drop) log(`  learning: no longer watching ${e.file} (${j.drop})`);
    result.dropped = judged.length - kept.length;
    const fresh = kept.flatMap(({ e, j }) => j.fixes.map((f) => ({ e, f })));
    const doneTxns = new Set(kept.map(({ e }) => e.txnId));
    await memory.updateLessons(({ lessons, forgotten }) => {
      // Your latest word per item replaces the earlier one; an item put back as the worker had it is no longer a lesson.
      // (A lesson made on the receipt page stays, unless the sweep now finds your word on the same item in Actual.)
      const again = new Set(fresh.map(({ e, f }) => `${e.txnId}|${normalize(f.item.d)}`));
      const others = lessons.map((l) => (l.via === 'page' && !again.has(`${l.txnId}|${normalize(l.item)}`) ? l : withoutTxns(l, doneTxns))).filter(Boolean);
      // A charge is re-judged on every sweep while it is watched: the same word on the same item keeps the day it was first learned.
      const firstSeen = (l) => lessons.filter((p) => p.learnedAt && p.item === l.item && p.filed === l.filed && (p.txnIds ?? [p.txnId]).includes(l.txnId)).map((p) => p.learnedAt).sort()[0];
      const mine = fresh.map(({ e, f }) => { const l = lessonOf(e, f, isoDay(now)); const was = firstSeen(l); return was && was < l.learnedAt ? { ...l, learnedAt: was } : l; }).filter((l) => !isForgotten(forgotten, l));
      const byId = new Map(mine.map((l) => [l.id, l]));
      result.lessons = byId.size;
      return { lessons: compact([...others, ...byId.values()]), forgotten };
    });
    // What you confirmed or changed outlives the watch (provenance, actual.js).
    const verified = new Set(kept.filter(({ j }) => j.verified).map(({ e }) => e.txnId));
    const corrected = {};
    for (const { e, f } of fresh) (corrected[e.txnId] ??= new Set()).add(partKey(f.partNote));
    await memory.recordMarks({
      confirmed: [...verified],
      corrected: Object.fromEntries(Object.entries(corrected).map(([id, keys]) => [id, [...keys]])),
      clear: kept.filter(({ e, j }) => !j.fixes.length && !verified.has(e.txnId)).map(({ e }) => e.txnId),
    });
    result.verified = verified.size;
    await memory.patchWatch({ drop: judged.filter(({ j }) => j.drop).map(({ e }) => e.txnId), verified: [...verified], unverified: kept.filter(({ e }) => !verified.has(e.txnId)).map(({ e }) => e.txnId) }, now.getTime());
  }
  // Learned keywords always follow the lessons: new ones appear, ones the lessons no longer support go.
  const { added, removed } = await syncLearned(keywordCandidates((await memory.loadLessonFile()).lessons));
  result.keywords = added;
  if (removed) log(`  learning: ${removed} learned keyword(s) removed (the corrections behind them are gone, or as many now disagree)`);
  await memory.saveSweepInfo({ lastSweep: now.toISOString(), lastAttempt: now.toISOString(), failures: 0, ...result });
  log(`  learning: looked at ${result.watched} charge(s): ${result.lessons} correction(s) found, ${result.verified} confirmed, ${result.dropped} no longer watched, ${added} keyword(s) learned`);
  return result;
}

// ---- 4. Using lessons ---------------------------------------------------------------------------------------------------

/** The lessons the decider may use: all of them with LEARNING=on, none otherwise. */
export async function usableLessons() {
  if (mode() !== 'on') return [];
  try {
    return (await memory.loadLessonFile()).lessons;
  } catch (err) {
    if (!(err instanceof memory.MemoryError)) throw err;
    memory.warnOnce(err); // a damaged file must not stop receipts
    return [];
  }
}

/**
 * Replay and item-test only: the lessons the worker could have had on `day`: by the day its sweep learned them (`learnedAt`),
 * else (lessons from before that was kept) by the transaction's date, which is the best we have. A lesson with neither is kept.
 * A lesson merged from several (compact) carries its newest day, so one with any later evidence is left out whole.
 */
export const lessonsUpTo = (lessons, day) => (day ? lessons.filter((l) => !(l.learnedAt ?? l.date) || (l.learnedAt ?? l.date) <= day) : lessons);

/** The note's items, one by one (it lists them with "," or ";"). */
const piecesOf = (note) => String(note).split(/[;,] /).map(normalize);

/**
 * Item history with your corrections in it (by: 'corrected'). A worker-made entry for an item you corrected is replaced
 * by the lesson, which says where you put it. Items you moved together come as one line (lessonLines). Lessons for
 * categories no longer in `labels` (a Map) are left out.
 */
export function withLessons(items, lessons, labels) {
  const usable = (lessons ?? []).filter((l) => l.filed && (!labels || labels.has(l.filed)));
  if (!usable.length) return items;
  const kept = items.filter((h) => !h.txnId || !usable.some((l) => l.txnId === h.txnId && piecesOf(h.items).some((p) => p === normalize(l.item) || p === normalize(lessonItemText(l)))));
  // Items moved together are not examples (lessonLines gives them to the decider as a correction, at the same store only).
  const added = lessonLines(usable).filter((l) => !l.together).map((l) => ({ items: l.item, category: l.filed, store: l.store, payee: l.payee, date: l.date, txnId: l.txnId, by: 'corrected' }));
  const out = [...kept, ...added];
  out.always = items.always;
  return out;
}

// ---- 5. Learned keywords ------------------------------------------------------------------------------------------------
// The rules are in keywords.js (keywordPhrase, keywordCandidates, syncLearned); re-exported here, where the loop reads best.
export { keywordCandidates, keywordPhrase };
