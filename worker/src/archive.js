// Archiving receipts you agree are right: the photo and its summary move to <Archive>/<YYYY-MM>/ (the photo shrunk, when that
// setting is on), and the receipt's state entry is slimmed down to what the Archived list needs. Restore undoes the move.
// This file joins the rules (archive-rules.js), the Nextcloud moves (archive-files.js) and the entry; the status page's buttons
// are in archive-actions.js and the worker's automatic archiving calls autoArchive below.
// deps.nc (tests): a stand-in for nextcloud.js { readSummary, archiveFile, restoreFile }.
import path from 'node:path/posix';
import { config, log } from './config.js';
import { resolveDryRun } from './settings.js';
import { AUTO_LIMIT, archiveMonth, cardOf, dueForAutoArchive, restoredEntry, slimEntry } from './archive-rules.js';

const ncOf = async (deps) => deps.nc ?? (await import('./nextcloud.js'));

/**
 * Move one receipt into the archive and return its new, slim entry. Nothing in state is changed here: the caller stores the entry
 * (the panel with patchEntry under the session lock, the worker in its own state). Throws when the move failed; the photo is then
 * where it was.
 */
export async function archiveReceipt(entry, { auto = false, key, now = Date.now(), reason = null, dismiss = false, ...deps } = {}) {
  const nc = await ncOf(deps);
  const summary = await nc.readSummary(entry.filedAs); // throws when Nextcloud can't be reached: nothing is moved then
  const at = new Date(now).toISOString();
  const dir = path.join(config.nextcloud.archive, archiveMonth(summary, entry.at));
  const moved = await nc.archiveFile({ from: entry.filedAs, dir, summary, at, shrink: config.archive.shrink, id: { key, txnId: entry.applied?.txnId } });
  return slimEntry(entry, { at, auto, reason, dismiss, filedAs: moved.dest, folder: config.nextcloud.archive, noSummary: moved.noSummary, fileMissing: moved.fileMissing, shrunk: moved.shrunk, card: summary ? cardOf(summary) : (entry.card ?? cardOf(null)) }); // a missing summary must not wipe the card the list already has
}

/**
 * Put an archived receipt back in Processed. Returns { entry (the new state entry), missing (the photo was gone; only its summary
 * came back) }. Throws when the move failed.
 */
export async function restoreReceipt(entry, { now = Date.now(), ...deps } = {}) {
  const nc = await ncOf(deps);
  const summary = await nc.readSummary(entry.filedAs);
  // Dismissed receipts return to their original filing group without confirming them. Legacy cash/refund archives return to review.
  const dir = entry.archived?.dismissed
    ? entry.archived.restoreTo === 'review' ? config.nextcloud.review : config.nextcloud.processed
    : entry.result === 'review' && !entry.applied ? config.nextcloud.review : config.nextcloud.processed;
  const moved = await nc.restoreFile({ from: entry.filedAs, dir, summary });
  return { entry: restoredEntry(entry, moved.dest, new Date(now).toISOString()), missing: moved.missing, noSummary: moved.noSummary };
}

/**
 * The worker's automatic archiving, after a check: Done receipts that are ARCHIVE_AFTER_DAYS old, at most AUTO_LIMIT of them.
 * It changes `state` (the caller's own copy, which the worker saves) and calls save(state) after each receipt, so a crash loses
 * at most the one in hand (archive-files.js finds that one again). A failure on one receipt is logged and skipped; this never
 * throws. Returns how many were archived.
 */
export async function autoArchive(state, { save, now = Date.now(), limit = AUTO_LIMIT, ...deps } = {}) {
  if (config.dryRun || resolveDryRun().dryRun || config.archive.problem || !(config.archive.afterDays > 0)) return 0; // also when the switch to dry run is pending
  let done = 0;
  for (const key of dueForAutoArchive(state, { now, limit })) {
    try {
      state[key] = await archiveReceipt(state[key], { auto: true, key, now, ...deps });
      done++;
    } catch (err) {
      log(`archive: could not archive ${path.basename(state[key]?.filedAs ?? key)} (${err.message}); it stays on the list and is tried again at the next check`);
      continue;
    }
    try {
      await save?.(state);
    } catch (err) {
      log(`archive: ${path.basename(state[key].filedAs)} was archived, but the list could not be saved (${err.message}); it is saved with the next change`);
    }
  }
  if (done) log(`archived ${done} receipt(s) older than ${config.archive.afterDays} day(s)`);
  return done;
}
