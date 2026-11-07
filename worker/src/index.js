// The receipt worker (the Docker entry point): every poll it lists the Nextcloud inbox, runs each due receipt through
// receipt.js, files it, and records progress in state.json (state.js) so nothing is done twice. Importing it starts nothing.
import './private-umask.js';
import { config, log } from './config.js';
import * as nextcloud from './nextcloud.js';
import * as actual from './actual.js';
import { waitForModel } from './llm.js';
import { receiptLabels } from './categorize.js';
import { describeMissing, autoDescribeAllowed } from './categories.js';
import { loadAliases } from './payee.js';
import { processReceipt } from './receipt.js';
import * as learning from './learning.js';
import { loadState, saveState, stateKey, parseStateKey, isDue, heartbeat, syncForgotten, failedEntry, giveUpEntry, replacedEntry, MAX_TRANSIENT_CYCLES, MAX_IMAGE_SKIPS } from './state.js';
import { refreshMode, resolveDryRun, envDisagreement, mustStopForDry } from './settings.js';
import { startTriggerServer } from './trigger.js';
import { saveDrySummary } from './dry-summaries.js';
import { createUpgradeWatcher, EXIT_CODE } from './actual-upgrade.js';
import { isTransient, TransientError, isFileChanged } from './errors.js';
import { classifyFailure } from './failure.js';
import { repairPermissions } from './private-files.js';
import path from 'node:path';
import { reportSetupProblem, clearSetupProblem, clearSetupProblemIfQuiet, useAlertFile, beginCycle } from './alert.js';

const MAX_ATTEMPTS = 3; // failed attempts at one receipt before it goes to Needs review
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;

let lastUpgradeNote = '';
let skippedDescribe = false; // the cloud-reader note about category descriptions is logged once per run

// Compares the Actual server's version with the API in use (ACTUAL_API_VERSION=auto only; see actual-upgrade.js).
const upgrade = createUpgradeWatcher({
  setting: config.actual.apiVersion,
  serverURL: config.actual.serverURL,
  usingVersion: actual.apiInfo.version,
  startVersion: actual.apiInfo.serverVersion,
  failedFor: actual.apiInfo.failedFor,
  dir: config.actual.apiDir,
});

// Set by SIGTERM: finish the receipt in hand, start no new one, then exit (see main).
let stopping = false;

/** Move a receipt that's been decided (and maybe applied) out of the inbox, then mark it done. */
async function fileReceipt(item, key, state, { result, summary, folder, applied }) {
  if (config.dryRun && summary) await saveDrySummary(key, summary); // lets the status page show the reading
  const filedAs = !config.dryRun && folder ? await nextcloud.fileInto(item, folder, summary) : undefined;
  // filedAs: the exact path it was filed under, so "Try again" on the status page moves back this very file.
  // applied stays on the finished entry: Actual was changed, so the status page must never offer to requeue it.
  state[key] = { done: true, result, at: new Date().toISOString(), ...(filedAs ? { filedAs } : {}), ...(applied ? { applied } : {}) };
}

/** The file was replaced in the inbox while this receipt was processed: forget this version (or, if Actual was changed for it,
 *  remember only that), count no attempt. The new file is a receipt of its own at the next poll. */
function fileReplaced(item, key, state, err) {
  const kept = replacedEntry(state[key]);
  if (kept) state[key] = kept;
  else delete state[key];
  log(`  ${item.basename} was replaced in the inbox while it was processed${kept ? `; the change already made in Actual for the old version stays (${kept.applied.action}), and the new file is handled as its own receipt` : '; dropping this version'} (${err.message})`);
}

/** One failed attempt at a receipt; the third sends it to review. */
async function failAttempt(item, key, state, entry, message) {
  const attempts = (entry.attempts ?? 0) + 1;
  log(`  error (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`);
  // Read again next time: the reading itself may be what failed (a cloud reader keeps it, see failedEntry).
  const applied = state[key]?.applied; // set when the failure came after Actual was changed
  state[key] = failedEntry(state[key], attempts, message);
  if (attempts >= MAX_ATTEMPTS) {
    const failed = giveUpEntry(item.basename, attempts, message, applied);
    try {
      await fileReceipt(item, key, state, failed);
    } catch (moveErr) {
      if (isFileChanged(moveErr)) return fileReplaced(item, key, state, moveErr);
      // Keep going: the next cycle only retries the move.
      log(`  could not move it to review: ${moveErr.message}`);
      // An applied entry keeps its own folder and summary; only an unapplied one is redirected to review.
      if (!applied) Object.assign(state[key], failed);
    }
  }
}

/** Waiting entries whose file has left the inbox (moved or deleted by hand) are dropped with their saved reading.
 *  Returns whether anything was dropped. */
function dropDepartedWaiting(state, inbox) {
  const inInbox = new Set(inbox.map(stateKey));
  let dropped = false;
  for (const [k, v] of Object.entries(state)) {
    if (v.waiting && !v.done && parseStateKey(k).dry === config.dryRun && !inInbox.has(k)) {
      delete state[k];
      dropped = true;
    }
  }
  return dropped;
}

/** Before opening the budget: an Actual upgrade needs the matching API, which the loader installs at startup. */
async function checkActualUpgrade() {
  const d = await upgrade.check();
  if (d.action === 'note' && d.message !== lastUpgradeNote) log(`warning: ${d.message}`); // once, not every cycle
  lastUpgradeNote = d.action === 'note' ? d.message : '';
  if (d.action === 'restart') {
    log(d.message);
    process.exit(EXIT_CODE);
  }
}

/** Fill in descriptions for spending categories that have none yet (the reader model, from past transactions; local file only).
 *  With a cloud reader nothing is sent for this on its own: it would put category names, store names, amounts and your item notes in a request. */
async function describeNewCategories(labels) {
  if (!autoDescribeAllowed()) {
    if (!skippedDescribe) log('not writing category descriptions automatically: the reader is a cloud service and this would send category names, store names, amounts and item notes to it; to do it by hand run ./receipts describe');
    skippedDescribe = true;
    return;
  }
  try {
    const written = await describeMissing(receiptLabels([...labels.keys()]), labels);
    if (written.length) log(`wrote ${written.length} category description(s) to review in data/category-notes.json`);
  } catch (err) {
    log(`could not write category descriptions: ${err.message}`);
  }
}

/** The state entry for a receipt whose bank charge hasn't posted yet: it stays in the inbox and is re-checked later. */
function waitingEntry(entry, waiting) {
  const nextCheck = Math.min(Date.now() + config.match.recheckMinutes * MS_PER_MINUTE, Date.parse(waiting.until));
  return {
    done: false,
    attempts: entry.attempts,
    reading: entry.reading,
    waiting: { ...waiting, since: entry.waiting?.since ?? new Date().toISOString(), nextCheck: new Date(nextCheck).toISOString() },
    result: 'waiting for the bank charge',
    at: new Date().toISOString(),
  };
}

/** Decide what an error from one receipt means (failure.js) and record it. Returns what the cycle does next:
 *  { troubles: the updated paid-call failure count, stop: end this check, setup: a setup problem ended it }. */
async function handleReceiptError(err, item, key, state, entry, readerTroubles) {
  const f = classifyFailure(err, state[key] ?? entry, readerTroubles);
  const next = { troubles: f.troubles, stop: f.stop, setup: false };
  if (f.kind === 'setup') {
    // Not the receipt's fault and not an outage that heals itself: stop the cycle, count no attempt (the reading
    // is kept in the entry, so no photo is read twice), tell the user once. The normal poll interval applies.
    state[key] = f.entry;
    await reportSetupProblem(err);
    next.setup = true;
  } else if (f.kind === 'counted') {
    // A cloud reader or the hosted decider failed on this receipt in a way that may have been billed (a timeout,
    // a 504). Count it against the receipt (three checks in a row is a failed attempt), but don't let one receipt hold
    // up the rest of the inbox: only a second such failure in the same check looks like an outage.
    const who = f.by === 'decider' ? 'the hosted decider' : 'the cloud reader';
    log(`  ${who} failed on this receipt (${f.count}/${MAX_TRANSIENT_CYCLES} checks in a row): ${err.message}`);
    state[key] = f.entry;
    if (f.giveUp) await failAttempt(item, key, state, entry, `${who} failed in ${f.count} checks in a row (${err.message})`);
    if (f.stop) log('  paid calls failed twice in this check; stopping it, retrying on the next poll');
  } else if (f.kind === 'skip') {
    // The cloud reader refused this photo's image and has read nothing yet in this process: the photo may be the
    // problem rather than the setup. Leave it for the next check, count no attempt, and go on with the next receipt.
    log(`  skipped for this check (${f.entry.imageSkips}/${MAX_IMAGE_SKIPS}): ${err.message}`);
    state[key] = f.entry;
  } else if (f.kind === 'outage') {
    // An outage says nothing about the receipt: don't count it, and don't try the rest while the server is down.
    state[key] = f.entry;
    log(`  outage (${err.message}); stopping this check, retrying on the next poll`);
  } else {
    state[key] = f.entry;
    await failAttempt(item, key, state, entry, err.message);
  }
  return next;
}

async function cycle({ recheckAll = false } = {}) {
  beginCycle();
  const state = await loadState();
  syncForgotten(state);
  const inbox = await nextcloud.listInbox();
  if (dropDepartedWaiting(state, inbox)) await saveState(state);
  const now = Date.now();
  const todo = inbox.filter((item) => isDue(state[stateKey(item)], now, recheckAll));
  // Time to look at the charges we changed, to see which you corrected (learning.js)? Opens Actual even with an empty inbox.
  const sweepDue = await learning.isDue().catch((err) => log(`learning: could not check the watch list: ${err.message}`));
  if (todo.length === 0 && !sweepDue) return;
  // Written down now, before anything that can fail (upgrade check, opening Actual, the sweep): a failure then waits longer.
  if (sweepDue) await learning.recordFailedAttempt().catch((err) => log(`learning: could not note the attempt: ${err.message}`));
  if (todo.length > 0) log(`${todo.length} receipt(s) to process${config.dryRun ? ' (dry run)' : ''}`);

  // Receipts already decided only need moving; anything else needs Actual (and maybe the model).
  const needsActual = sweepDue || todo.some((item) => !state[stateKey(item)]?.folder);
  let labels = null;
  let modelChecked = false;
  const ctx = {
    state, // processReceipt tells a re-used file name from a crash to recover from (state.txnIdsAppliedUnderName)
    // Only a receipt that still has to be read needs the vision model. A model that isn't up is an outage.
    async modelReady() {
      if (modelChecked) return;
      try {
        await waitForModel();
      } catch (err) {
        throw new TransientError(`vision model not ready: ${err.message}`, { cause: err });
      }
      modelChecked = true;
    },
  };
  loadAliases();
  if (needsActual) {
    await checkActualUpgrade();
    await actual.open();
  }
  try {
    if (needsActual) {
      labels = await actual.categoryLabels();
      if (todo.length > 0) await describeNewCategories(labels);
      // Before the receipts: what you corrected since last time may already help with them. Never blocks a receipt.
      if (sweepDue) {
        try {
          await learning.sweep({ id2label: actual.idToLabel(labels), recorded: true });
        } catch (err) {
          log(`learning: sweep failed (${err.message}); trying again later`);
        }
      }
    }
    let processed = 0;
    let stoppedBySetup = false;
    let readerTroubles = 0; // receipts in this check that a paid call (cloud reader, hosted decider) failed on, in a countable way
    for (const item of todo) {
      if (stopping) {
        log('stopping: the remaining receipts wait for the next start');
        break;
      }
      // Switched to dry run mid-batch (status page / ./receipts mode dry): stop before touching the next receipt.
      if (mustStopForDry()) {
        log('the switch now says dry run: stopping before the next receipt; the rest wait');
        break;
      }
      const key = stateKey(item);
      const entry = (state[key] ??= {});
      log(`- ${item.basename}`);
      let outage = false;
      try {
        processed++;
        if (entry.folder) {
          // Decided (and applied to Actual, if entry.applied) in an earlier cycle, but not moved yet.
          log(`  ${entry.applied ? `already applied (${entry.applied.action})` : 'already decided'}; moving it to ${entry.folder}`);
          await fileReceipt(item, key, state, entry);
        } else {
          const out = await processReceipt(item, labels, entry, ctx);
          if (out.waiting) {
            state[key] = waitingEntry(entry, out.waiting);
            if (config.dryRun) log('  [dry run] leaving it in the inbox (nothing is moved in dry run anyway)');
          } else {
            if (out.applied) {
              // Record the Actual change before moving the file: after a crash here, the next cycle only moves it.
              state[key] = { done: false, applied: out.applied, result: out.result, folder: out.folder, summary: out.summary, at: out.applied.at };
              await saveState(state);
              // Watch the charge: the sweep learns from anything you change in it. Best effort, never fails the receipt.
              await learning.watch(out.snapshot).catch((err) => log(`  learning: could not watch this charge: ${err.message}`));
            }
            await fileReceipt(item, key, state, out);
          }
        }
      } catch (err) {
        if (isFileChanged(err)) {
          fileReplaced(item, key, state, err);
          await saveState(state);
          await heartbeat();
          continue;
        }
        const next = await handleReceiptError(err, item, key, state, entry, readerTroubles);
        readerTroubles = next.troubles;
        outage = next.stop;
        if (next.setup) stoppedBySetup = true;
      }
      await saveState(state);
      await heartbeat();
      if (outage) break;
    }
    if (processed > 0 && !stoppedBySetup) await clearSetupProblemIfQuiet();
  } finally {
    if (needsActual) await actual.close();
  }
}

async function main() {
  // Make the data directory and what is in it private to this user (it may have been created with looser permissions).
  const repaired = await repairPermissions(path.dirname(config.statePath)).catch(() => 0);
  if (repaired > 0) log(`made ${repaired} file(s) and folder(s) in ${path.dirname(config.statePath)} private to this user`);
  useAlertFile();
  await clearSetupProblem(); // a fixed .env + restart removes the banner; a problem that is still there comes back at the first check
  refreshMode();
  log(`receipt worker starting: dry run ${config.dryRun}, splits ${config.splits}, polling every ${config.pollSeconds}s, inbox ${config.nextcloud.inbox}`);
  if (config.decider.provider === 'remote') log(`decider: ${config.decider.remoteModel} on ${config.deciderUrl} (hosted, requests anonymized; ${config.reader.provider === 'remote' ? 'the receipt reader is a cloud service' : 'the receipt reader stays local'})`);
  if (config.reader.provider === 'remote') {
    log(`reader: ${config.llmName}`);
    log(`*** receipt photos are sent to ${config.reader.host} (READER_PROVIDER=remote) ***`);
    if (config.decider.provider === 'remote') log('  *** CLOUD_NAME_SCAN=true: the name and place check for the hosted decider also goes through the cloud reader, so the raw receipt text (item lines, store names) goes to that provider before anonymizing ***');
  }
  const disagree = envDisagreement(resolveDryRun());
  if (disagree) log(`*** ${disagree} ***`);
  // Check the inbox without waiting for the next poll: `./receipts run-now` (SIGUSR1), the trigger page or a webhook.
  // A trigger during a check runs another check right after it, so a receipt uploaded mid-batch isn't left waiting.
  // A manual check also re-checks receipts waiting for their bank charge.
  let wake = null;
  let again = false;
  let recheckAll = false;
  const trigger = (why) => {
    log(`checking the inbox now (${why})`);
    recheckAll = true;
    if (wake) wake();
    else again = true;
  };
  process.on('SIGUSR1', () => trigger('run-now'));
  // docker stop: finish the receipt in hand (compose gives the worker stop_grace_period), then exit.
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    log('SIGTERM: stopping after the current receipt');
    if (wake) wake();
  });
  startTriggerServer(trigger);
  while (!stopping) {
    refreshMode(); // the status page / ./receipts mode may have changed it; only ever between cycles
    await heartbeat();
    try {
      // Retried every cycle, so a Nextcloud outage at startup doesn't stop the worker.
      if (!config.dryRun) await nextcloud.ensureFolders();
      const opts = { recheckAll };
      recheckAll = false;
      await cycle(opts);
    } catch (err) {
      log(`cycle failed${isTransient(err) ? ' (outage, retrying on the next poll)' : ''}: ${err.message}`);
    }
    await heartbeat();
    if (stopping) break;
    if (again) {
      again = false;
      continue;
    }
    let timer;
    await new Promise((r) => {
      wake = r;
      timer = setTimeout(r, config.pollSeconds * MS_PER_SECOND);
    });
    clearTimeout(timer);
    wake = null;
  }
  log('stopped');
  process.exit(0);
}

// Run the polling loop only when started as the main script, so importing this file starts nothing.
if (import.meta.url === `file://${process.argv[1]}`) main();

