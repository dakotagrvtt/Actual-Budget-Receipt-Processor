// The status page's archive buttons: POST /archive (one receipt, from its page), /archive-all (every Done receipt, after a confirm
// page) and /restore. Each runs under the session lock (session-lock.js) and re-reads the entry inside it, so what it does is
// decided on the records as they are now, not as the page showed them. Changes go to state.json with patchEntry.
// deps (tests): nc (nextcloud stand-in), actual (for clearing #review), lockWaitMs.
import path from 'node:path/posix';
import { config, filesPlace, log } from './config.js';
import { PanelError } from './panel-actions.js';
import { BusyError, exclusive } from './session-lock.js';
import { loadState, patchEntry, parseStateKey } from './state.js';
import { resolveDryRun } from './settings.js';
import { BULK_LIMIT, bulkCandidates, canArchive, undoOpen } from './archive-rules.js';
import { archiveReceipt, restoreReceipt } from './archive.js';
import { noChargeKind } from './reconcile.js';
import { statusKind } from './status-kind.js';
import { markCheckedNow, settleReviewed } from './receipt-fix.js';
import { seenIndex } from './memory.js';
import { withSeen } from './receipt-lists.js';

const LOCK_WAIT_MS = 20000;
const nameOf = (id) => parseStateKey(id).file.split('/').pop();

/** Run fn under the session lock; the worker being busy, or an unexpected error, becomes a message for the page. */
async function locked(deps, what, fn) {
  try {
    return await exclusive(fn, { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof PanelError) throw err;
    if (err instanceof BusyError) throw new PanelError('The worker is in the middle of a check right now. Wait a minute and press the button again; nothing was changed.');
    throw new PanelError(`${what}: ${err.message}`);
  }
}

function refuseInDryRun() {
  if (config.dryRun || resolveDryRun().dryRun) throw new PanelError('Dry run: nothing is moved. Go live first.');
}

/** Archiving (not Restore) is off while the Archive folder setting clashes with another folder. */
function refuseIfOff() {
  if (config.archive.problem) throw new PanelError(`Archiving is turned off: ${config.archive.problem}. Fix the Archive folder on the Settings tab. Nothing was moved.`);
}

async function entries() {
  try {
    return withSeen(await loadState(), await seenIndex());
  } catch (err) {
    throw new PanelError(`Can't read the list of receipts (${err.message}). Nothing was changed.`);
  }
}

/** Store the slim entry, but only if the entry is still the one that was archived (same file, not archived meanwhile). */
const store = (id, was, next) => patchEntry(id, (e) => {
  if (!e || e.filedAs !== was.filedAs || e.archived) throw new PanelError('That receipt changed while it was being archived. Check the Archived tab.');
  return next;
});

/** What the notice says about how the photo was stored. */
const how = (e) => (e.archived.noSummary ? ' The photo moved, but its summary could not be copied; the old summary is still beside the old place.' : '') + (e.archived.fileMissing ? ` The photo was already gone from ${filesPlace()}; only the summary was filed.` : e.archived.shrunk ? ` The photo was shrunk from ${kb(e.archived.shrunk.before)} to ${kb(e.archived.shrunk.after)}.` : '');
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * POST /archive: archive one receipt. form: id. A "Done" receipt just moves. An "Applied, check it in Actual" one first has its #review
 * tag removed in Actual and its file moved to Processed (receipt-fix.js markCheckedNow, what "Mark as checked" does), because
 * archiving it means you checked it. `dismiss=1` instead moves the receipt without reading or writing Actual and preserves
 * its review state for Restore. Sets out.archived on success (the page then moves on to the next receipt).
 */
export async function archiveOne(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  const dismiss = form.get('dismiss') === '1';
  refuseInDryRun();
  refuseIfOff();
  return locked(deps, 'Couldn\'t archive it', async () => {
    let entry = (await entries())[id];
    // A cash or refund receipt in Needs review: its summary says so (the entry does not).
    let noCharge = null;
    if (!dismiss && entry?.filedAs && statusKind({ ...entry, key: id }) === 'review') {
      try {
        noCharge = noChargeKind(await (deps.nc ?? (await import('./nextcloud.js'))).readSummary(entry.filedAs));
      } catch (err) {
        throw new PanelError(`Not archived. The summary could not be read (${err.message}).`);
      }
    }
    // An explicit archive of one receipt may follow a save at once; it ends that save's Undo (said in the notice).
    const verdict = canArchive(id, entry, { noCharge, dismiss, endsUndo: true });
    if (!verdict.ok) throw new PanelError(`Not archived. ${verdict.reason}`);
    const endedUndo = undoOpen(entry);
    let cleared = false;
    let clearNote = '';
    // "Archive: keep what's in Actual": nothing is read from or written to Actual (#review stays as it is there). For a charge you changed or
    // reworded by hand. The result loses "+review" so a Restore later shows a Done receipt. The learning watch is not touched: the sweep still judges it.
    const keep = !dismiss && form.get('keep') === '1';
    if (keep) {
      if (!entry.applied || !['applied-review', 'done'].includes(verdict.kind)) throw new PanelError('Not archived. Actual was not changed for this receipt, so there is nothing to keep.');
      entry = { ...entry, result: String(entry.result ?? '').replace(/\+review$/, '') };
    } else if (!dismiss && verdict.kind === 'applied-review') {
      try {
        clearNote = await markCheckedNow(id, deps);
      } catch (err) {
        if (err instanceof PanelError) throw new PanelError(`Not archived: #review could not be cleared. ${err.message}`);
        throw err;
      }
      cleared = true;
      entry = (await entries())[id]; // the entry now says it is done; the file should be in Processed
      const again = canArchive(id, entry, { mode: 'single', endsUndo: true });
      if (!again.ok) throw new PanelError(`The #review tag was removed in Actual, but the receipt was not archived. ${again.reason} ${clearNote}`.trim());
    }
    // Shown reviewed by a look at Actual: read the charge again first (#review may be back), and drop "+review" from the result.
    if (!dismiss && !keep && entry.reviewed && String(entry.result ?? '').endsWith('+review')) {
      await settleReviewed(id, deps);
      entry = (await entries())[id];
    }
    let slim;
    try {
      slim = await archiveReceipt(entry, { key: id, dismiss, ...(dismiss ? { reason: 'dismissed without changing Actual' } : keep ? { reason: 'kept as it is in Actual' } : verdict.reason ? { reason: verdict.reason } : {}), ...deps });
    } catch (err) {
      log(`archive: ${nameOf(id)}: ${err.message}`);
      throw new PanelError(`${cleared ? 'The #review tag was removed in Actual, but the receipt could not be archived (it stays where it is now)' : 'Not archived. The photo was not moved'}. ${filesPlace(true)} said: ${err.message}${cleared ? ` ${clearNote}` : ''}`);
    }
    await store(id, entry, slim);
    log(`archive: ${nameOf(id)} archived as ${slim.filedAs}`);
    out.archived = true;
    return `Archived ${nameOf(id)}${cleared ? ' (its #review tag was removed in Actual first)' : ''}. Find it on the Archived tab.${how(slim)}${clearNote && /could not be/.test(clearNote) ? clearNote : ''}${endedUndo ? ' Undo for the last save is no longer available.' : ''}`;
  });
}

/** POST /archive-all: archive every Done receipt (at most BULK_LIMIT per press; the rest wait for the next press). Never touches "check it in Actual" ones. */
export async function archiveAll(form, out, deps = {}) {
  refuseInDryRun();
  refuseIfOff();
  return locked(deps, 'Couldn\'t archive the receipts', async () => {
    const state = await entries();
    const keys = bulkCandidates(state);
    if (keys.length === 0) return 'There are no Done receipts to archive.';
    let done = 0;
    let failed = 0;
    let first = '';
    for (const id of keys.slice(0, BULK_LIMIT)) {
      try {
        if (state[id].reviewed && String(state[id].result ?? '').endsWith('+review')) {
          await settleReviewed(id, deps); // #review may be back in Actual: then it stays on the list
          state[id] = (await entries())[id];
        }
        await store(id, state[id], await archiveReceipt(state[id], { key: id, ...deps }));
        done++;
      } catch (err) {
        failed++;
        first ||= `${nameOf(id)}: ${err.message}`;
        log(`archive: ${nameOf(id)}: ${err.message}`);
      }
    }
    const left = keys.length - done - failed;
    out.archived = done > 0;
    return `Archived ${done} receipt${done === 1 ? '' : 's'}.${failed ? ` ${failed} could not be moved and stay on the list (${first}).` : ''}${left > 0 ? ` ${left} more are waiting: press the button again.` : ''}`;
  });
}

/** POST /restore: put an archived receipt back in Processed and on the main list. form: id. Sets out.restored. */
export async function restoreOne(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  refuseInDryRun();
  return locked(deps, 'Couldn\'t restore it', async () => {
    const entry = (await entries())[id];
    if (!entry) throw new PanelError('That receipt isn\'t in the list any more. Nothing was changed.');
    if (!entry.archived) throw new PanelError('That receipt is not archived. Nothing was changed.');
    let restored;
    try {
      restored = await restoreReceipt(entry, deps);
    } catch (err) {
      throw new PanelError(`Not restored. The photo was not moved (${err.message}).`);
    }
    await patchEntry(id, (e) => {
      if (!e?.archived || e.filedAs !== entry.filedAs) throw new PanelError('That receipt changed while it was being restored. Check the Status tab.');
      return restored.entry;
    });
    out.restored = true;
    log(`archive: ${nameOf(id)} restored to ${restored.entry.filedAs}`);
    return `Restored ${nameOf(id)} to ${path.dirname(restored.entry.filedAs).replace(/^\/+/, '')}. It is on the Status list again.${restored.noSummary ? ' The photo moved, but its summary could not be copied; the old summary is still in the archive.' : restored.missing ? ' The photo was already gone from the archive; only its summary came back.' : entry.archived.shrunk ? ' Its photo stays the shrunk version.' : ''}`;
  });
}
