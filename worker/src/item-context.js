// What the categorizer is told about an item and the household's past purchases (pure functions; the local decider
// and the anonymizer for the remote one both build on them).
import { isSolo, normalize, stripDepartment } from './keywords.js';

export const itemText = (it) => {
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

// Who is behind a past item (actual.js provenance). No `by` means you wrote it (old callers, tests).
const isPipeline = (h) => h.by === 'pipeline';
// Items the worker filed only because the model was unsure are not examples of anything.
const usable = (history) => history.filter((h) => h.by !== 'pipeline-fallback');
// How the decider is told an entry is the worker's own, never checked by anyone: it is not evidence of what the household chose.
const UNCHECKED = 'pipeline, unchecked';
const filedBy = (h) => (isPipeline(h) ? { filed_by: UNCHECKED } : {});
// The bonus a correction of yours gets when ranking similar items.
const CORRECTED_BONUS = 0.25;
// At most this many corrections among the examples (they are strong evidence, but a few of them are enough).
const MAX_CORRECTED = 3;

/**
 * Take at most `limit` of the (already ranked) entries, yours first: what the worker made itself fills at most half the room.
 * Entries keep their order within each group.
 */
function capPipeline(ranked, limit) {
  let corrections = 0;
  const mine = ranked.filter((h) => !isPipeline(h) && (h.by !== 'corrected' || ++corrections <= MAX_CORRECTED));
  const theirs = ranked.filter(isPipeline).slice(0, Math.floor(limit / 2));
  return [...mine, ...theirs].slice(0, limit);
}

/**
 * The past items (from any store) that share the most words with this item. Yours (and your corrections, which count
 * a little extra) come before the worker's own, and the worker's fill at most half of `limit`.
 */
export function similarItems(item, itemHistory, limit = 8) {
  const mine = tokens(itemText(item));
  const scored = usable(itemHistory)
    .map((h) => {
      const theirs = tokens(h.items);
      const shared = [...mine].filter((t) => theirs.has(t)).length;
      return { ...h, score: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
    })
    .filter((h) => h.score > 0)
    .map((h) => ({ ...h, score: h.score + (h.by === 'corrected' ? CORRECTED_BONUS : 0) }))
    .sort((a, b) => b.score - a.score);
  return capPipeline(scored, limit).map((h) => ({ items: h.items, filed_as: h.category, store: h.store, ...filedBy(h) }));
}

/** How many similar items were filed in each category. The worker's unchecked entries are shown but never counted: they only echo its own earlier picks. */
export const tallyByCategory = (similar) =>
  similar.filter((s) => !s.filed_by).reduce((o, s) => ({ ...o, [s.filed_as]: (o[s.filed_as] ?? 0) + 1 }), {});

/**
 * The newest `perCategory` item notes per category (this household's, or the pipeline's), with the store. The notes from
 * all accounts are sorted by date first (newest first; same date or no date keeps the order they came in).
 * Small enough to give whole: it shows who buys what ("Egg Book @thrift shop → Child", "DC Charger → Alex").
 * Items the worker filed by default are left out, and its other items fill at most half of a category's room.
 */
export function householdEntries(itemHistory, labels, perCategory = 15) {
  const newestFirst = [...usable(itemHistory)].sort((a, b) => (b.date ? 1 : 0) - (a.date ? 1 : 0) || String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const byCategory = {};
  for (const h of newestFirst) if (labels.includes(h.category)) (byCategory[h.category] ??= []).push(h);
  return Object.fromEntries(Object.entries(byCategory).map(([label, list]) => [label, capPipeline(list, perCategory).map((h) => ({ items: h.items, store: h.store, ...filedBy(h) }))]));
}

/** householdEntries as the strings the local decider reads: "items (at store)". */
export function householdExamples(itemHistory, labels, perCategory = 15) {
  return Object.fromEntries(Object.entries(householdEntries(itemHistory, labels, perCategory)).map(([label, list]) => [label, list.map((e) => exampleText(e))]));
}

/** One example as the local decider reads it: "items (at store)", marked when the worker filed it unchecked. */
export const exampleText = (e, items = e.items, at = e.store) => `${at ? `${items} (at ${at})` : items}${e.filed_by ? ` [filed by ${e.filed_by}]` : ''}`;

/**
 * Past purchases at this store as the decider reads them. A purchase the worker filed itself and nobody checked is
 * not a household choice, so it goes under its own key; in a mixed purchase only its unchecked parts are marked.
 * `partText(part)` writes one part (the anonymizer turns categories into codes); `shown(h)` is the rest of a purchase.
 */
export function pastPurchases(history, partText, shown) {
  const row = (h) => ({ ...shown(h), filed_as: h.parts.map((p) => partText(p) + (p.by === 'pipeline' && h.by !== 'pipeline' ? ` [filed by ${UNCHECKED}]` : '')) });
  const unchecked = history.filter((h) => h.by === 'pipeline').map(row);
  return {
    past_purchases_at_this_store: history.filter((h) => h.by !== 'pipeline').map(row),
    ...(unchecked.length ? { past_purchases_filed_by_the_pipeline_unchecked: unchecked } : {}),
  };
}

/** What the decider reads about one category: its description, or (none written yet) just its name and group. */
export function categoryText(label, notes) {
  const [group, name] = label.split(' / ');
  return notes[label] ? `${name}: ${notes[label]}` : `The "${name}" budget category (group: ${group})`;
}

const clip = (text, n = 80) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const MAX_CORRECTIONS = 3;

/** An item as the lessons and the history write it: the receipt text, with the reader's plain name when it differs. */
export const lessonItemText = (l) => (l.plain && l.plain.toLowerCase() !== String(l.item).toLowerCase() ? `${l.item} (${l.plain})` : String(l.item));

/**
 * Lessons as the lines the decider sees. An item you moved alone is one line. Items moved together (a whole receipt you
 * recategorized, or several items of a part) are ONE line listing them briefly: "whole receipt: MILK, EGGS" (80 characters
 * at most), because they say little about any single item. A line: { item, names, said, filed, payee, store, date, txnId, together }.
 */
export function lessonLines(lessons) {
  const lines = [];
  const groups = new Map();
  for (const l of lessons ?? []) {
    if (!l.filed) continue;
    const base = { said: l.said ?? null, filed: l.filed, payee: l.payee ?? null, store: l.store ?? null, date: l.date, txnId: l.txnId };
    if (isSolo(l)) {
      lines.push({ ...base, item: clip(lessonItemText(l)), names: `${l.item} ${l.plain ?? ''}`, together: false });
      continue;
    }
    const key = `${l.txnId}|${l.group}|${l.filed}`;
    const g = groups.get(key) ?? { ...base, kind: l.kind, list: [], saids: new Set() };
    g.list.push(l.item);
    g.saids.add(l.said ?? null);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const { list, saids, kind, ...base } = g;
    lines.push({ ...base, item: clip(`${kind === 'receipt' ? 'whole receipt' : 'several items'}: ${list.join(', ')}`), names: list.join(' '), said: saids.size === 1 ? [...saids][0] : null, together: true });
  }
  return lines;
}

/**
 * Up to 3 of your corrections that look like this item: the worker filed something like it one way and you filed it
 * another. Ranked by words shared with the item (none shared: not shown), plus a bonus for the same payee. Items moved
 * together come as one line, only at the same payee, and rank lower than an item moved alone.
 * Returns [{ item, said (label or null), filed (label), payee, store }] with the item text cut to 80 characters;
 * the caller decides how each part is shown (anonymize.js turns categories into codes and scans the text).
 */
export function relevantCorrections(item, lessons, { payee = null, store = null, labels = null } = {}) {
  const mine = tokens(itemText(item));
  const here = normalize(payee ?? store ?? '');
  return lessonLines(lessons)
    .filter((l) => !labels || labels.includes(l.filed))
    .map((l) => {
      const theirs = tokens(l.names);
      const shared = [...mine].filter((t) => theirs.has(t)).length;
      const samePayee = here && normalize(l.payee ?? l.store ?? '') === here;
      if (l.together && !samePayee) return { l, score: 0 };
      return { l, score: (shared / Math.max(1, Math.min(mine.size, theirs.size)) + (shared && samePayee ? 0.5 : 0)) * (l.together ? 0.5 : 1) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.l.date ?? '').localeCompare(String(a.l.date ?? '')))
    .slice(0, MAX_CORRECTIONS)
    .map(({ l }) => ({ item: l.item, said: labels && l.said && !labels.includes(l.said) ? null : l.said, filed: l.filed, payee: l.payee, store: l.store }));
}
