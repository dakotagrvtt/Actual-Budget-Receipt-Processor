// "Read again" on a receipt's page: run the reader (whatever is configured now) on the stored photo once more, so an old receipt
// gets the benefit of later improvements. It never writes to Actual. The page only asks (POST /receipt-reread sets `reread` on the
// state entry, under the session lock, and starts a check); the check does the slow work, so no web request waits for the reader:
//   not filed yet (waiting for its charge, or a dry-run receipt)  the photo is still in the inbox: processReceipt reads it afresh, and
//                  the normal flow goes on as if it had been read that way the first time. A waiting receipt keeps the reading it
//                  replaced (entry.previousReading) for "Use old reading"; a dry-run receipt has none to keep.
//   filed and applied  (rereadFiled, below) the photo is read from its filed place and run through the same steps as a first read
//                  (receipt.js settleReading, then categorizeReceipt). Only the reading in the summary is replaced, with the old one kept
//                  in summary.reread.before; the doubts of the new reading are kept in summary.reread.doubts (summary.problems is what
//                  Actual's #review was about when it was filed, and stays). What Actual has (summary.plan) is not touched, so the Save
//                  checks still compare the charge with what the worker wrote. The editor starts from the new reading; changing Actual is
//                  the usual Preview / Save changes, which also takes care of the #review tag.
//   in Needs review without a change to Actual  "Try again" already reads the photo from scratch, so the page offers that instead.
// "Use old reading" (restoreReading) puts the previous reading back, as long as nothing was saved from the new one.
// A re-read is not a correction: it creates no lessons and no marks. It is refused when a change saved from the page is still there
// (the picks and amounts are numbered by item), when the charge was changed in Actual (the editor is locked), when the receipt
// is archived, and when the photo is gone. Everything here runs under the session lock (the check holds it; the POST takes it).
// Every change of the reading gives the summary a new `reread.at`: the page's reading id, which makes earlier previews stale.
import { config, filesPlace, log } from './config.js';
import { parseStateKey, patchEntry } from './state.js';
import { exclusive } from './session-lock.js';
import { PanelError, retryStatus, UNDO_WINDOW_MS } from './panel-actions.js';
import { actualChanged, classify, asPanelError, loadEntry, hasRealFix, lastFixAt, ARCHIVED } from './receipt-fix.js';
import { cardOf } from './archive-rules.js';
import { locate } from './panel-receipt.js';
import { allocate, gapSplitDoubt, UNCATEGORIZED } from './reconcile.js';
import { isOutage } from './errors.js';
import { resolveDryRun } from './settings.js';
import * as memory from './memory.js';

const LOCK_WAIT_MS = 20000;
const MAX_TRIES = 3; // failed readings of one filed receipt before the request is dropped (the cycle retries it on each check)
export const OUTAGE_HOURS = 24; // a request that keeps meeting an outage is dropped after this long
export const NOTE_HOURS = 24; // "Read again was not done" stays on the page this long
export const READING_AGAIN = 'Reading again… The worker is reading the photo once more. Reload this page in a minute or two.';
const noPhoto = () => `The photo is no longer in ${filesPlace()}, so it can't be read again.`;
const UNDO_FIRST = 'A change from this page is saved for this receipt. Undo it first (the Undo button works for 15 minutes after saving), or change the charge in Actual.';
const FIX_FINAL = 'A change from this page was saved for this receipt, and it can no longer be undone here. Its items are numbered for the current reading, so the reading is not replaced. Change the charge in Actual if it needs more.';
const LOCKED = 'The charge was changed in Actual, so this page shows what Actual has and the reading is not replaced. Edit it in Actual.';
const MODE_CHANGED = 'The worker switched between dry run and live before it got to this, so the receipt was not read again. Nothing was changed.';
const SWITCHING = 'The worker is about to switch between dry run and live (at the next check). Wait until it has, then press the button again.';

const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const withoutFlag = (entry) => { const { reread: _r, ...rest } = entry; return rest; };
const seenFor = async (summary) => (summary?.transaction?.id ? (await memory.seenIndex().catch(() => ({})))[summary.transaction.id] ?? null : null);

/**
 * Can this receipt be read again now? { ok: true, kind: 'applied' | 'inbox' } or { ok: false, reason, pending?, quiet? }.
 * 'applied': filed, and Actual was changed for it. 'inbox': the photo is still in the inbox. `quiet` refusals need no note on the
 * page (Try again is already there). Pure; the photo itself is checked by the caller.
 */
export function rereadState(id, entry, summary, seen = null) {
  if (entry?.filing || entry?.creating) return no('The receipt is finishing a saved operation. It will retry automatically.');
  if (entry?.resolutionPending) return no('Finish saving the corrected reading before reading the photo again.');
  if (entry?.reread) return no(READING_AGAIN, { pending: true });
  if (entry?.archived) return no(ARCHIVED.replace('change its categories', 'read it again'));
  if (parseStateKey(id).dry !== config.dryRun) return no(`This receipt was seen in ${config.dryRun ? 'live' : 'dry run'} mode. Switch to that mode to read it again.`);
  if (!entry?.done) {
    // Waiting for its bank charge: the photo is in the inbox. Anything else not finished is being tried by the worker anyway.
    if (entry?.waiting && !entry.folder && !entry.applied) return { ok: true, kind: 'inbox' };
    return no('The worker is still working on this receipt. It will be read again by itself if that fails.');
  }
  if (config.dryRun) return { ok: true, kind: 'inbox' }; // nothing is filed in dry run: the photo is still in the inbox
  if (retryStatus(id, { ...entry, key: id }) === 'yes') return no('Press Try again: it sends the photo back to the inbox to be read from scratch.', { quiet: true });
  if (!entry.applied) return no('This receipt can\'t be read again from here.', { quiet: true });
  const fixable = classify(id, entry, summary);
  if (!fixable.ok) return no(fixable.reason);
  // A real fix numbers its picks and amounts by item; "Mark as checked" alone changes none of that.
  if (hasRealFix(entry, summary)) return no(Date.now() - lastFixAt(entry, summary) < UNDO_WINDOW_MS ? UNDO_FIRST : FIX_FINAL);
  if (actualChanged(entry, seen)) return no(LOCKED);
  return { ok: true, kind: 'applied' };
}

/**
 * Can the reading before the last Read again be put back? { ok: true, kind: 'applied' | 'inbox' } or { ok: false, reason, quiet? }.
 * Only while nothing was saved from the new reading, and (waiting receipts) only if the old reading is still on the entry and came from
 * the reader in use now. A dry-run receipt keeps no old reading, so it is never offered there.
 */
export function restoreState(id, entry, summary, seen = null) {
  if (entry?.filing || entry?.creating) return no('The receipt is finishing a saved operation. It will retry automatically.');
  if (entry?.resolutionPending) return no('Finish saving the corrected reading first.');
  if (entry?.reread) return no(READING_AGAIN, { pending: true, quiet: true });
  if (entry?.archived) return no('Archived.', { quiet: true });
  if (parseStateKey(id).dry !== config.dryRun) return no('Wrong mode.', { quiet: true });
  if (!entry?.done) {
    const prev = entry?.previousReading?.reading;
    if (entry?.waiting && prev?.receipt && (!prev.reader || sameReaderNow(prev.reader))) return { ok: true, kind: 'inbox' };
    return no('', { quiet: true });
  }
  if (config.dryRun || !entry.applied || !summary?.reread?.before) return no('', { quiet: true });
  if (!classify(id, entry, summary).ok) return no('', { quiet: true });
  if (hasRealFix(entry, summary)) return no('A change was saved from the new reading, so the earlier one is not put back.');
  if (actualChanged(entry, seen)) return no(LOCKED);
  return { ok: true, kind: 'applied' };
}
function sameReaderNow(reader) {
  const now = config.reader.provider === 'remote' ? { provider: 'remote', host: config.reader.host, model: config.reader.model } : { provider: 'local', host: null, model: config.llmName ?? null };
  return reader?.provider === now.provider && (reader.host ?? null) === now.host && (reader.model ?? null) === now.model;
}

// ---- The requests (POST /receipt-reread, /receipt-reread-restore) -------------------------------------------------------

/** Both requests: the switch to dry run / live must not be pending (a flagged receipt would wait for a mode it is not in). */
function refuseWhileSwitching() {
  if (resolveDryRun().dryRun !== config.dryRun) throw new PanelError(`${SWITCHING} Nothing was changed.`);
}

/**
 * POST /receipt-reread: mark the receipt for another reading and start a check (out.trigger). form: id. Returns the notice.
 * deps (tests): nextcloud stand-in (statPath), lockWaitMs.
 */
export async function requestReread(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  try {
    return await exclusive(() => requestNow(id, out, deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t ask for another reading. Nothing was changed');
  }
}

async function requestNow(id, out, deps) {
  refuseWhileSwitching();
  const { entry, summary } = await loadEntry(id, deps);
  const state = rereadState(id, entry, summary, await seenFor(summary));
  if (!state.ok) throw new PanelError(`${state.reason} Nothing was changed.`);
  const file = locate(id, entry);
  const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
  try {
    if (!file) throw Object.assign(new Error('no file'), { status: 404 });
    await nc.statPath(file);
  } catch (err) {
    if (err.status === 404) throw new PanelError(`${noPhoto()} Nothing was changed.`);
    throw new PanelError(`${filesPlace(true)} can't be reached right now (${err.message}). Nothing was changed.`);
  }
  // (Read again is allowed only before any real page save, or after a "Looks right", which has no Undo: there is no Undo to end here.)
  await patchEntry(id, (e) => {
    const { rereadNote: _old, ...rest } = e;
    return { ...rest, reread: { at: new Date().toISOString(), kind: state.kind } };
  });
  out.trigger = 'read again';
  log(`receipt page: ${parseStateKey(id).file}: read again asked for`);
  return 'Reading the photo again. It takes a minute or two; the page shows the new reading when it is done. Nothing is written to Actual.';
}

/** The summary with the reading before the last Read again back in place. Its `reread` has a new time (so earlier previews are stale) and no `before`. */
export function restoredSummary(summary, at = new Date().toISOString()) {
  const before = summary.reread.before;
  const back = { ...summary };
  for (const f of READING_FIELDS) {
    if (f in before) back[f] = before[f];
    else delete back[f];
  }
  back.reread = { at, restored: true };
  return back;
}
const READING_FIELDS = ['readWith', 'categorizedWith', 'historyUsed', 'receipt', 'totalCorrected'];

/**
 * POST /receipt-reread-restore: put the reading before the last Read again back ("Use old reading"). Nothing is read, nothing is written
 * to Actual, no lesson or mark. Applied receipt: the summary in Nextcloud gets the old reading back. Waiting receipt: the entry does.
 */
export async function restoreReading(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  try {
    return await exclusive(() => restoreNow(id, deps), { timeoutMs: deps.lockWaitMs ?? LOCK_WAIT_MS });
  } catch (err) {
    throw asPanelError(err, 'Couldn\'t put the earlier reading back. Nothing was changed');
  }
}

async function restoreNow(id, deps) {
  refuseWhileSwitching();
  const { entry, summary } = await loadEntry(id, deps);
  const st = restoreState(id, entry, summary, await seenFor(summary));
  if (!st.ok) throw new PanelError(`${st.reason || 'There is no earlier reading to put back.'} Nothing was changed.`);
  const at = new Date().toISOString();
  if (st.kind === 'inbox') {
    await patchEntry(id, (e) => {
      const { previousReading, ...rest } = e;
      return { ...rest, reading: previousReading.reading, rereadAt: at };
    });
  } else {
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    const back = restoredSummary(summary, at);
    try {
      await nc.refile(entry.filedAs, entry.filedAs, back);
    } catch (err) {
      throw new PanelError(`The summary could not be rewritten in ${filesPlace()} (${err.message}). Nothing was changed.`);
    }
    await patchEntry(id, (e) => ({ ...e, card: cardOf(back), rereadAt: at }));
  }
  log(`receipt page: ${parseStateKey(id).file}: the earlier reading was put back`);
  return 'The earlier reading is back. Nothing was written to Actual.';
}

// ---- In the check ------------------------------------------------------------------------------------------------------

/** The keys of filed receipts waiting for another reading in this mode (the others are read by processReceipt, from the inbox). */
export const filedRereads = (state) => Object.entries(state).filter(([k, e]) => e?.reread && e.done && e.filedAs && e.applied && parseStateKey(k).dry === config.dryRun).map(([k]) => k);

const noted = (e, text) => ({ ...withoutFlag(e), rereadNote: { at: new Date().toISOString(), text } });

/**
 * Requests that can no longer be done, dropped with a note the page shows: the mode changed since they were made (a flag would
 * wait for a check that never comes), or the photo is no longer in the inbox (so processReceipt never sees it).
 * `inboxKeys` = the state keys of what the inbox lists now. Returns whether anything changed.
 */
export function dropStaleRereads(state, inboxKeys) {
  let changed = false;
  for (const [k, e] of Object.entries(state)) {
    if (!e?.reread) continue;
    if (parseStateKey(k).dry !== config.dryRun) state[k] = noted(e, MODE_CHANGED);
    else if (inboxKeys.has(k) || filedRereads({ [k]: e }).length) continue;
    else state[k] = noted(e, noPhoto());
    changed = true;
  }
  return changed;
}

/** Drop the request with a note for the page (the reason it was not done). */
function giveUp(state, key, text) {
  state[key] = noted(state[key], text);
  log(`  read again: ${text}`);
}

/**
 * Read the filed receipts in `keys` again, one after the other (the check calls this after the inbox, with an empty inbox too). After each one
 * the state is saved (save) and the heartbeat written (beat). Stops early when stop() says so, or when a reader outage shows.
 */
export async function rereadAllFiled(state, keys, { labels, ctx, save, beat, stop = () => false }, deps = {}) {
  for (const key of keys) {
    if (stop()) break;
    const result = await rereadFiled(key, state, { labels, ctx }, deps);
    await save(state);
    await beat();
    if (result === 'outage') break;
  }
}

/**
 * Read one filed, applied receipt again (the caller holds the session lock and has Actual open). Replaces the reading in its summary and
 * the entry's card; touches nothing in Actual, no lesson, no mark. Never throws: an outage (the model server asleep, Nextcloud down) keeps
 * the request without counting and returns 'outage'; another failure keeps it for the next check (up to MAX_TRIES) or drops it with a note.
 * state[key] is changed in memory; the caller saves the state.
 * ctx: { labels (Actual's categories, label → id), modelReady() }. deps (tests): nextcloud, actual, read, prepare, categorize.
 */
export async function rereadFiled(key, state, { labels, ctx }, deps = {}) {
  const entry = state[key];
  const name = parseStateKey(key).file.split('/').pop();
  log(`- ${name}: reading it again`);
  let modelDown = false;
  try {
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    const summary = await nc.readSummary(entry.filedAs);
    // The same checks as when it was asked for: Save or Check Actual may have happened since (they hold the lock, so not during this).
    const st = rereadState(key, withoutFlag(entry), summary, await seenFor(summary));
    if (!st.ok || st.kind !== 'applied') return giveUp(state, key, `${st.reason ?? 'It can\'t be read again now.'} Nothing was changed.`);
    let bytes;
    try {
      bytes = await nc.downloadPath(entry.filedAs);
    } catch (err) {
      if (err.status === 404) return giveUp(state, key, noPhoto());
      throw err;
    }
    try {
      await ctx.modelReady();
    } catch (err) {
      modelDown = true; // the model server itself is not up: a real outage, for this receipt and the rest
      throw err;
    }
    const { prepareImages } = await import('./image.js');
    const images = await (deps.prepare ?? prepareImages)(bytes, name, config.maxImageSide);
    const { readReceipt } = await import('./llm.js');
    const { receipt, mode } = await (deps.read ?? readReceipt)(images);
    const fresh = await readAgain({ receipt, mode, summary, entry, name, labels, deps });
    await nc.refile(entry.filedAs, entry.filedAs, fresh);
    // The state follows the file: a page that fails to rewrite the summary leaves the old reading and keeps nothing half-done.
    state[key] = { ...withoutFlag(entry), card: cardOf(fresh), rereadAt: fresh.reread.at };
    delete state[key].rereadNote;
    log(`  read again: ${receipt.items.length} item(s) (${mode}); the charge in Actual was not touched`);
  } catch (err) {
    // A real outage says nothing about the receipt: nothing is counted, but it must not last forever (the request is dropped after OUTAGE_HOURS).
    // Only a down model server stops the others too. A timeout on this photo, or a cloud reader failing on it (possibly billed), counts as a try.
    if (modelDown || isOutage(err)) {
      if (Date.now() - Date.parse(entry.reread.at) > OUTAGE_HOURS * 3600000) giveUp(state, key, `Reading again could not be done for ${OUTAGE_HOURS} hours (${err.message}). Nothing was changed.`);
      else log(`  read again: ${err.message}; it stays asked for and is tried at the next check`);
      return modelDown ? 'outage' : 'later';
    }
    const tries = (entry.reread.tries ?? 0) + 1;
    log(`  read again failed (${tries}/${MAX_TRIES}): ${err.message}`);
    if (tries >= MAX_TRIES) giveUp(state, key, `Reading again failed ${tries} times (${err.message}). Nothing was changed.`);
    else state[key] = { ...entry, reread: { ...entry.reread, tries } };
  }
  return 'done';
}

/**
 * The new summary: the old one with the new reading in place of summary.receipt (and what goes with it), the old reading kept in
 * `reread.before`, and the new reading's own doubts in `reread.doubts` (what the first read would have raised about the reading:
 * a flipped line, items off the subtotal, uncertain items, a missed discount over different categories).
 */
async function readAgain({ receipt, mode, summary, entry, name, labels, deps }) {
  const { settleReading, categorizeReceipt, flipDoubt } = await import('./receipt.js');
  const t = summary.transaction;
  // The upload time as the first read had it: the entry's own record, never the filed file's time (archive and restore change that).
  const item = { basename: name, lastmod: entry.lastmod ?? entry.fixedOnPage?.before?.at ?? entry.at };
  const settled = settleReading(receipt, item, new Date());
  // The charge as the first read saw it: its own category then (not what the worker wrote), so the store's usual category falls back the same way.
  const actual = deps.actual ?? (await import('./actual.js'));
  const id2label = actual.idToLabel(labels);
  const currentLabel = labels.has(t.currentCategory) ? t.currentCategory : null;
  const row = await actual.findById(t.id, t.date).catch(() => null);
  const txn = {
    ...(row?.t ?? { id: t.id, date: t.date, imported_payee: t.bankDescription ?? null }),
    amount: -Math.round(Number(t.amount) * 100),
    payeeName: row ? row.payeeName : t.payee ?? null,
    payeeIsTransfer: row ? Boolean(row.payeeIsTransfer) : false,
    category: currentLabel ? labels.get(currentLabel) : null,
  };
  const doubts = [...flipDoubt(settled.flips, receipt)];
  const cat = await (deps.categorize ?? categorizeReceipt)(receipt, txn, labels, id2label, currentLabel, doubts, { harvestKeywords: false });
  const split = allocate(receipt, labels, -txn.amount, { gapLabel: cat.fallback ?? UNCATEGORIZED });
  doubts.push(...split.problems, ...gapSplitDoubt(receipt));
  const at = new Date().toISOString();
  const before = Object.fromEntries(READING_FIELDS.filter((f) => f in summary).map((f) => [f, summary[f]]));
  return {
    ...summary,
    readWith: mode,
    categorizedWith: cat.categorizedWith,
    historyUsed: cat.history,
    receipt,
    totalCorrected: settled.totalNote,
    reread: { at, before, doubts: [...new Set(doubts)] },
  };
}
