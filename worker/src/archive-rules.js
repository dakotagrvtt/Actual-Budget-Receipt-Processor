// What may be archived, and what an archived entry keeps. Pure: no Nextcloud, no Actual. Shared by the status page (which
// buttons to show), the page's archive handlers and the worker's automatic archiving.
import { config, filesPlace } from './config.js';
import { parseStateKey } from './state.js';
import { inFolder } from './folders.js';
import { statusKind } from './status-kind.js';
import { UNDO_WINDOW_MS } from './panel-actions.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Automatic archiving does at most this many receipts per check, so a big first batch doesn't stall a check. */
export const AUTO_LIMIT = 20;
/** One press of "Archive all done receipts" does at most this many (each may be downloaded, shrunk and uploaded); press again for the rest. */
export const BULK_LIMIT = 50;

// Fields that only matter while a receipt is being processed or fixed. An archived entry keeps just what the list, the
// "same name uploaded again" check (applied.txnId, state.js txnIdsAppliedUnderName) and Restore need.
const KEPT = ['result', 'at', 'done', 'applied', 'manualLink'];

const no = (reason, quiet = false) => ({ ok: false, reason, quiet });

/**
 * Can this entry be archived? { ok: true, kind } or { ok: false, reason, quiet } (quiet: the reason is obvious from the status,
 * so the page needn't say it). mode: 'single' (one receipt, from its page: also a "Applied, check it in Actual" one, whose #review is
 * cleared first) | 'bulk' | 'auto' (Done receipts only). `dismiss: true` is an explicit single-receipt move that leaves Actual
 * untouched, including for unresolved receipts already filed in Needs review. Live mode only.
 * The Undo of a save from the page must have run out, except for an explicit single archive (`endsUndo: true`, mode 'single'): archiving
 * then ends that Undo (Undo refuses an archived receipt, and Restore does not bring it back). "Archive all" and automatic archiving still
 * wait the 15 minutes out. A save that has not finished (filing, summaryFailed) blocks every archive.
 */
export function canArchive(key, entry, { mode = 'single', now = Date.now(), noCharge = null, dismiss = false, endsUndo = false } = {}) {
  if (config.dryRun || parseStateKey(String(key)).dry) return no('Nothing is moved in dry run.', true);
  if (config.archive.problem) return no(`Archiving is turned off: ${config.archive.problem}. Fix the Archive folder on the Settings tab.`);
  if (!entry || typeof entry !== 'object') return no('That receipt isn\'t in the list any more.');
  if (entry.archived) return no('It is already archived.', true);
  if (entry.filing) return no('The receipt is finishing a saved operation. It will retry automatically.');
  if (entry.creating) return no('Preview to finish the earlier cash creation or retry it safely after lookup. No second purchase is created automatically.');
  if (entry.fixedOnPage?.summaryFailed) return no(`The summary of its last change from this page could not be saved to ${filesPlace()}, so it is kept as it is. The worker will try to recover it automatically.`);
  if (dismiss && mode !== 'single') return no('Dismissing a receipt is only available one at a time.');
  if (dismiss && String(entry.result ?? '').startsWith('dry-run:')) return no('Nothing is moved in dry run.', true);
  if (dismiss && entry.reread) return no('The receipt is waiting to be read again. Let that finish before archiving it.');
  let kind = statusKind({ ...entry, key });
  // A cash or refund receipt in Needs review has no charge to match; once you have dealt with it by hand it can be archived (from its page).
  // `noCharge` = 'cash' | 'return' from its summary (reconcile.js noChargeKind); the caller reads the summary.
  if (kind === 'review' && noCharge && mode === 'single') kind = 'nocharge';
  if (dismiss && !entry.done) return no('The receipt is still waiting or being processed. Let it finish before archiving it.');
  if (!dismiss && kind !== 'done' && kind !== 'nocharge' && !(kind === 'applied-review' && mode === 'single')) {
    return no(kind === 'applied-review' ? 'It is still tagged #review in Actual; it can be archived one at a time, from its own page.' : 'It is not finished, or still needs your attention.', true);
  }
  if (!entry.filedAs) return no('This entry does not record where its file is (it has none, or is from an older version), so it can\'t be moved.');
  // A receipt that Actual shows reviewed (#review removed there) is Done, and its file may still sit in Needs review.
  const home = kind === 'done' ? config.nextcloud.processed : config.nextcloud.review;
  const allowedFile = dismiss
    ? !String(entry.filedAs).split('/').includes('..') && (inFolder(entry.filedAs, config.nextcloud.processed) || inFolder(entry.filedAs, config.nextcloud.review))
    : inFolder(entry.filedAs, home) || ((entry.reviewed || entry.manualLink?.keep) && (inFolder(entry.filedAs, config.nextcloud.review) || inFolder(entry.filedAs, config.nextcloud.inbox)));
  if (!allowedFile) return no(`Its file is not in the ${dismiss ? 'Processed or Needs review' : kind === 'done' ? 'Processed' : 'Needs review'} folder any more (${entry.filedAs}), so it is left alone.`);
  if (entry.resolutionPending) return no('Finish saving the corrected receipt before archiving it.');
  // The page fix is the only record of a change whose summary could not be rewritten: keep the entry whole until that is sorted out.
  const fixedAt = Date.parse(entry.fixedOnPage?.at ?? '');
  // (A "Looks right", which only cleared #review, has no Undo and so no window: it is finished at once.)
  if (!(endsUndo && mode === 'single') && !entry.fixedOnPage?.markOnly && Number.isFinite(fixedAt) && now - fixedAt < UNDO_WINDOW_MS) return no('Its categories were just changed on this page, and the Undo for that is still open. Try again in a few minutes.');
  return { ok: true, kind, ...(kind === 'nocharge' ? { reason: noCharge === 'cash' ? 'cash, entered by hand' : 'refund, dealt with by hand' } : {}) };
}

/** The month folder for an archived receipt, "2026-03": the receipt's own date when its summary has one, else the month it was filed. */
export function archiveMonth(summary, at) {
  const own = /^(\d{4}-(?:0[1-9]|1[0-2]))-\d\d/.exec(String(summary?.receipt?.date ?? ''));
  if (own) return own[1];
  const filed = /^(\d{4}-(?:0[1-9]|1[0-2]))/.exec(String(at ?? ''));
  return filed ? filed[1] : new Date().toISOString().slice(0, 7);
}

/** The little the Archived list needs from the full summary (which stays in the .json file): { store, date, total }. */
export function cardOf(summary) {
  const r = summary?.receipt && typeof summary.receipt === 'object' ? summary.receipt : {};
  const t = summary?.transaction && typeof summary.transaction === 'object' ? summary.transaction : {};
  const text = (v) => (v === undefined || v === null ? '' : String(v).slice(0, 120));
  const raw = r.total ?? t.amount;
  const total = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return { store: text(r.merchant || t.payee), date: text(r.date || t.date), total: Number.isFinite(total) ? total : null };
}

/**
 * The state entry of an archived receipt: the reading, the decider's answers, the failure counters and the page-fix details are
 * dropped (the summary in the archive has what the receipt page shows); the result, times and `applied` stay. An explicit
 * dismissal retains the entry so Restore can recover its unresolved state and saved corrections.
 * info: { at, auto, reason (why, for a cash or refund receipt), filedAs (the archive path), folder (the Archive folder then), fileMissing, noSummary, shrunk: { before, after } | null, card }.
 */
export function slimEntry(entry, info) {
  // Dismissal is reversible even for an unresolved receipt: retain its saved reading, corrections and failure details.
  // `reviewed` is only a cached observation from Actual; derive it again after Restore rather than saving that observation.
  const slim = info.dismiss ? { ...entry } : {};
  delete slim.reviewed;
  // A dismissal keeps the page fix (Restore needs the record), but archiving ended its Undo: a quick Restore must not bring that Undo back.
  if (info.dismiss && entry.fixedOnPage) slim.fixedOnPage = { ...entry.fixedOnPage, undoEnded: info.at ?? new Date().toISOString() };
  if (!info.dismiss) for (const k of KEPT) if (entry[k] !== undefined) slim[k] = entry[k];
  return {
    ...slim,
    ...((entry.changedByHand || entry.fixedOnPage?.changedByHand) ? { changedByHand: true } : {}),
    filedAs: info.filedAs,
    archived: { at: info.at, auto: Boolean(info.auto), ...(info.dismiss ? { dismissed: true, restoreTo: inFolder(entry.filedAs, config.nextcloud.review) ? 'review' : 'processed' } : {}), ...(info.reason ? { reason: String(info.reason).slice(0, 100) } : {}), folder: info.folder ?? config.nextcloud.archive, ...(info.fileMissing ? { fileMissing: true } : {}), ...(info.noSummary ? { noSummary: true } : {}), ...(info.shrunk ? { shrunk: info.shrunk } : {}) },
    card: info.card ?? { store: '', date: '', total: null },
  };
}

/**
 * The Undo of the last save from the page (Save, Create cash) is still open: inside its 15 minutes, and not ended by an archive.
 * Never for a "Looks right" (`markOnly`), which has no Undo, including an older record that once offered one.
 */
export const undoOpen = (entry, now = Date.now()) => {
  const at = Date.parse(entry?.fixedOnPage?.at ?? '');
  return Number.isFinite(at) && now - at < UNDO_WINDOW_MS && now - at > -60000 && !entry.fixedOnPage.markOnly && !entry.fixedOnPage.undoEnded && !entry.archived;
};

/** The entry after Restore: the archive details are gone (the card, store and total for the list, stays), and `restoredAt` makes automatic archiving wait again from now. */
export function restoredEntry(entry, filedAs, at) {
  const { archived: _archived, ...rest } = entry;
  return { ...rest, filedAs, restoredAt: at };
}

/** The keys automatic archiving would archive now: live Done entries whose time (filed, or restored, whichever is later) is `days` old. Oldest first, at most `limit`. */
export function dueForAutoArchive(state, { now = Date.now(), days = config.archive.afterDays, limit = AUTO_LIMIT } = {}) {
  if (!(days > 0)) return [];
  const old = now - days * MS_PER_DAY;
  const timeOf = (e) => Math.max(Date.parse(e.at ?? '') || 0, Date.parse(e.restoredAt ?? '') || 0);
  return Object.entries(state ?? {})
    .filter(([k, e]) => canArchive(k, e, { mode: 'auto', now }).ok && timeOf(e) > 0 && timeOf(e) <= old)
    .sort((a, b) => timeOf(a[1]) - timeOf(b[1]))
    .slice(0, limit)
    .map(([k]) => k);
}

/** The keys "Archive all done receipts" would archive now (all of them; the caller applies BULK_LIMIT). */
export const bulkCandidates = (state) => Object.entries(state ?? {}).filter(([k, e]) => canArchive(k, e, { mode: 'bulk' }).ok).map(([k]) => k);
