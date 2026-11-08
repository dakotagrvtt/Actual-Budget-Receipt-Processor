// What the worker remembers between polls: state.json (one entry per inbox file) and the heartbeat file.
// The key of an entry is the file name plus its etag, so a re-uploaded file is a new receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { writePrivate } from './private-files.js';

/** The saved state. No file yet (ENOENT) is an empty state; anything else (unreadable, damaged, not an object) throws,
 *  so nobody carries on with an empty state and writes it over the real one. */
export async function loadState() {
  let text;
  try {
    text = await fs.readFile(config.statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`could not read ${config.statePath}: ${err.message}`, { cause: err });
  }
  try {
    const state = JSON.parse(text);
    if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new Error('it is not a JSON object');
    return state;
  } catch (err) {
    throw new Error(`${config.statePath} is damaged (${err.message}); fix or restore it`, { cause: err });
  }
}
// Entries the status page cleared ("Try again"). The worker holds state in memory for a whole cycle and saves all of it,
// which would put a cleared entry back; saveState drops these from what it writes.
const forgotten = new Set();
/** Clear entries from state.json now, and keep the worker's in-memory copy from restoring them. */
export async function forgetKeys(keys) {
  for (const k of keys) forgotten.add(k);
  try {
    await queue(async () => {
      const state = await loadState();
      for (const k of keys) delete state[k];
      await writeState(state);
    });
  } catch (err) {
    for (const k of keys) forgotten.delete(k); // nothing was cleared
    throw err;
  }
}
/**
 * Change one entry in state.json without touching the others: fn(entry) returns the new entry (undefined removes it). Read and
 * written inside the write queue. Only for callers that hold the session lock (session-lock.js): the poll cycle keeps the whole
 * state in memory and would write an older copy over this.
 */
export function patchEntry(key, fn) {
  return queue(async () => {
    const state = await loadState();
    const next = fn(state[key]);
    if (next === undefined) delete state[key];
    else state[key] = next;
    await writeState(state);
    return next;
  });
}
/** Called by the worker right after loadState: keys the file no longer has are already gone, so stop tracking them. */
export function syncForgotten(state) {
  for (const k of [...forgotten]) if (!(k in state)) forgotten.delete(k);
}

// All writes to state.json go through one promise chain, so two writes can never interleave (one failing doesn't block the next).
let chain = Promise.resolve();
const queue = (fn) => {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
};

// Write to a temp file and rename it over state.json, so a crash mid-write can't leave half a file.
async function writeState(state) {
  await loadState(); // throws when the file on disk is unreadable or damaged: never write over it
  for (const k of forgotten) delete state[k];
  // Unique per write (not the pid: node is PID 1 in every container, and the panel and worker share this file).
  const tmp = path.join(path.dirname(config.statePath), `.${path.basename(config.statePath)}.${randomUUID()}.tmp`);
  try {
    await writePrivate(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, config.statePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
export const saveState = (state) => queue(() => writeState(state));
export const heartbeat = () => writePrivate(config.heartbeatPath, new Date().toISOString()).catch(() => {});

// Dry-run results are tracked separately, so turning DRY_RUN off processes those receipts for real.
export const stateKey = (item) => `${config.dryRun ? 'dry:' : ''}${item.filename}@${item.etag}`;
/** stateKey() taken apart: { dry, file } (the file name as it was in the inbox, without the etag). */
export function parseStateKey(key) {
  const dry = key.startsWith('dry:');
  const rest = dry ? key.slice(4) : key;
  const at = rest.lastIndexOf('@'); // an etag never contains '@'; a file name can
  return { dry, file: at < 0 ? rest : rest.slice(0, at) };
}

/**
 * The transaction ids already recorded as applied on other entries with the same file name (another etag: a re-uploaded
 * file is a new key). A "#receipt <name>" tag on one of those belongs to that earlier receipt, not to a crash of this one.
 * Dry-run and live entries are separate, as in stateKey.
 */
export function txnIdsAppliedUnderName(state, key) {
  const me = parseStateKey(key);
  const ids = new Set();
  for (const [k, v] of Object.entries(state ?? {})) {
    if (k === key || !v?.applied?.txnId) continue;
    const p = parseStateKey(k);
    if (p.dry === me.dry && p.file === me.file) ids.add(v.applied.txnId);
  }
  return ids;
}

/** Is this inbox file due? New, retrying, waiting with its re-check time up (or a manual check), or waiting to be moved. */
export function isDue(entry, now, recheckAll) {
  if (!entry) return true;
  if (entry.done) return false;
  if (entry.folder || !entry.waiting) return true;
  return recheckAll || Date.parse(entry.waiting.nextCheck) <= now;
}

/** The entry after a failed attempt. What was applied to Actual is kept (with where it goes and its summary), so the
 *  next cycle only moves the file and nothing is applied twice or forgotten. With a cloud reader the saved reading is kept too. */
export function failedEntry(prev, attempts, message, at = new Date().toISOString(), remoteReader = config.reader.provider === 'remote', remoteDecider = config.decider.provider === 'remote') {
  const kept = prev?.applied ? { applied: prev.applied, result: prev.result, folder: prev.folder, summary: prev.summary } : {};
  // A cloud reader charges for every reading: keep the one already paid for, so a retry does not read the photo again.
  // (The local reader is read again, since the reading itself may be what failed.)
  const reading = remoteReader && prev?.reading ? { reading: prev.reading } : {};
  // Answers the hosted decider was already paid for stay too; they go when the receipt finishes (the entry is replaced then).
  const paid = remoteDecider && prev?.deciderAnswers && Object.keys(prev.deciderAnswers).length ? { deciderAnswers: prev.deciderAnswers } : {};
  const skips = prev?.imageSkips ? { imageSkips: prev.imageSkips } : {}; // stays, so a receipt given up on is not skipped three more times
  return { ...kept, ...reading, ...paid, ...skips, done: false, attempts, error: message, at };
}
/** A paid cloud call (reader, hosted decider) that keeps failing on one receipt (a timeout may still be billed): this many checks in a row count as a failed attempt. */
export const MAX_TRANSIENT_CYCLES = 3;
// The counters on an entry: consecutive failures of the cloud reader, and of the hosted decider.
const COUNTERS = { reader: 'transientFails', decider: 'deciderFails' };
/**
 * The entry after a paid call failed on this receipt without saying anything about it: the count of checks in a row, and
 * whether that is enough to count a failed attempt. `by` is 'reader' or 'decider'; the other kind's count starts over.
 */
export function countFailure(prev, by = 'reader', message) {
  const count = (prev?.[COUNTERS[by]] ?? 0) + 1;
  const entry = clearFailureCounts(prev);
  entry[COUNTERS[by]] = count;
  if (message) entry.error = message;
  return { count, giveUp: count >= MAX_TRANSIENT_CYCLES, entry };
}
export const countReaderFailure = (prev, message) => countFailure(prev, 'reader', message);
/** Checks in a row in which the cloud reader's 400 about this receipt's image only skipped it: this many and it counts as a failed attempt. */
export const MAX_IMAGE_SKIPS = 3;
/** The entry after a skipped check (see SkipReceiptError): the skips so far, and whether that is enough to count a failed attempt. */
export function countSkip(prev) {
  const count = (prev?.imageSkips ?? 0) + 1;
  return { count, giveUp: count >= MAX_IMAGE_SKIPS, entry: { ...clearFailureCounts(prev), imageSkips: count } };
}
/** The entry without its failure counters: something other than a paid-call failure happened, so only consecutive ones count. */
export function clearFailureCounts(entry) {
  const { transientFails, deciderFails, imageSkips, ...rest } = entry ?? {};
  return rest;
}
/**
 * What to keep for a receipt whose file was replaced in the inbox while it was processed (errors.js FileChangedError), or null
 * to drop the entry. Nothing was applied: drop it, the new file has its own key. Actual already changed: keep that it was applied
 * (done, no file to move), so this transaction is never changed again and, with the file name re-used, txnIdsAppliedUnderName
 * tells the new upload that the tag on it belongs to this one.
 */
export function replacedEntry(prev, at = new Date().toISOString()) {
  if (!prev?.applied) return null;
  return { done: true, result: prev.result, at, replaced: true, applied: prev.applied };
}
/** The summary and entry for a receipt that failed too often. `applied` marks that Actual was already changed. */
export function giveUpEntry(file, attempts, message, applied, review = config.nextcloud.review) {
  return {
    result: 'failed',
    folder: review,
    summary: { file, ...(applied ? { applied: true } : {}), problems: [`failed ${attempts} times: ${message}`] },
    ...(applied ? { applied } : {}),
  };
}
