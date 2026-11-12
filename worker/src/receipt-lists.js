// The two lists of receipts the status page shows, from the state entries: the main list (everything not archived) and the
// Archived list. Pure, so they can be tested without the server. The same lists feed Previous / Next on a receipt's page.
import { parseStateKey } from './state.js';
import { statusKind } from './status-kind.js';

/** On the main list, Done receipts are capped at this many (newest first); everything that is not Done is always shown. */
export const DONE_CAP = 100;

/**
 * The state with `reviewed: { at }` added to the entries of charges that Actual shows reviewed (#review removed; memory.js loadSeen),
 * so statusKind lists them as Done. A copy: nothing is written back. `seen` = memory.seenIndex().
 */
export function withSeen(state, seen) {
  const out = { ...state };
  for (const [k, v] of Object.entries(state ?? {})) {
    const rec = v?.applied?.txnId ? currentLook(v, seen?.[v.applied.txnId]) : null;
    if (rec?.reviewed === true && !v.archived) out[k] = { ...v, reviewed: { at: rec.at ?? null } };
  }
  return out;
}

/** When the entry was last changed by the worker or from the page (ms): a look at Actual from before that says nothing about what is filed now. */
export const latestChange = (entry) => Math.max(0, ...[entry?.at, entry?.fixedOnPage?.at, entry?.restoredAt].map((t) => Date.parse(t ?? '')).filter(Number.isFinite));

/** The saved look at a charge (memory.js loadSeen), only when it is newer than the entry's latest change; else null. */
export const currentLook = (entry, rec) => (rec && typeof rec === 'object' && Date.parse(rec.at) > latestChange(entry) ? rec : null);

const rowOf = ([k, v]) => ({ key: k, file: parseStateKey(k).file.split('/').pop(), ...v });
// A restored receipt keeps its old `at`; for ordering (and so the Done cap) it counts from when it was restored.
const latest = (r) => [r.at, r.restoredAt].map((v) => String(v ?? '')).sort().pop();
const newestFirst = (a, b) => latest(b).localeCompare(latest(a));

/**
 * The main list: every non-archived entry of this mode (live or dry run), newest first. A receipt that needs attention is never
 * hidden; only Done ones are capped. Returns { recent, hiddenDone } (hiddenDone: how many older Done receipts were left out).
 */
export function mainList(state, dryRun, { doneCap = DONE_CAP } = {}) {
  const rows = Object.entries(state).filter(([k, v]) => parseStateKey(k).dry === dryRun && !v?.archived).map(rowOf).sort(newestFirst);
  let seen = 0;
  const recent = rows.filter((r) => statusKind(r) !== 'done' || ++seen <= doneCap);
  return { recent, hiddenDone: rows.length - recent.length };
}

/** The archived receipts of this mode, the most recently archived first. */
export function archivedList(state, dryRun) {
  return Object.entries(state).filter(([k, v]) => parseStateKey(k).dry === dryRun && v?.archived).map(rowOf).sort((a, b) => String(b.archived.at ?? '').localeCompare(String(a.archived.at ?? '')));
}
