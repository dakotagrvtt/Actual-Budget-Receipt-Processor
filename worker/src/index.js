// The receipt worker: polls the Nextcloud inbox, runs each new receipt through receipt.js, files it, and keeps
// state.json (state.js) so nothing is done twice. Run by Docker; replay.js and the other tools import what they need.
import { config, log } from './config.js';
import * as nextcloud from './nextcloud.js';
import * as actual from './actual.js';
import { waitForModel } from './llm.js';
import { receiptLabels } from './categorize.js';
import { describeMissing } from './categories.js';
import { loadAliases } from './payee.js';
import { processReceipt } from './receipt.js';
import { loadState, saveState, stateKey, parseStateKey, isDue, heartbeat } from './state.js';
import { startTriggerServer } from './trigger.js';
import { isTransient, TransientError } from './errors.js';

const MAX_ATTEMPTS = 3;

// Set by SIGTERM: finish the receipt in hand, start no new one, then exit (see main).
let stopping = false;

/** Move a receipt that's been decided (and maybe applied) out of the inbox, then mark it done. */
async function fileReceipt(item, key, state, { result, summary, folder }) {
  if (!config.dryRun && folder) await nextcloud.fileInto(item, folder, summary);
  state[key] = { done: true, result, at: new Date().toISOString() };
}

async function cycle({ recheckAll = false } = {}) {
  const state = await loadState();
  const inbox = await nextcloud.listInbox();
  // Waiting entries whose file has left the inbox (moved or deleted by hand) are dropped with their saved reading.
  const inInbox = new Set(inbox.map(stateKey));
  let pruned = false;
  for (const [k, v] of Object.entries(state)) {
    if (v.waiting && !v.done && parseStateKey(k).dry === config.dryRun && !inInbox.has(k)) {
      delete state[k];
      pruned = true;
    }
  }
  if (pruned) await saveState(state);
  const now = Date.now();
  const todo = inbox.filter((item) => isDue(state[stateKey(item)], now, recheckAll));
  if (todo.length === 0) return;
  log(`${todo.length} receipt(s) to process${config.dryRun ? ' (dry run)' : ''}`);

  // Receipts already decided only need moving; anything else needs Actual (and maybe the model).
  const needsActual = todo.some((item) => !state[stateKey(item)]?.folder);
  let labels = null;
  let modelChecked = false;
  const ctx = {
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
  if (needsActual) await actual.open();
  try {
    if (needsActual) {
      labels = await actual.categoryLabels();
      // Fill in descriptions for spending categories that have none yet (the reader model, from past transactions; local file only).
      try {
        const written = await describeMissing(receiptLabels([...labels.keys()]), labels);
        if (written.length) log(`wrote ${written.length} category description(s) to review in data/category-notes.json`);
      } catch (err) {
        log(`could not write category descriptions: ${err.message}`);
      }
    }
    for (const item of todo) {
      if (stopping) {
        log('stopping: the remaining receipts wait for the next start');
        break;
      }
      const key = stateKey(item);
      const entry = (state[key] ??= {});
      log(`- ${item.basename}`);
      let outage = false;
      try {
        if (entry.folder) {
          // Decided (and applied to Actual, if entry.applied) in an earlier cycle, but not moved yet.
          log(`  ${entry.applied ? `already applied (${entry.applied.action})` : 'already decided'}; moving it to ${entry.folder}`);
          await fileReceipt(item, key, state, entry);
        } else {
          const out = await processReceipt(item, labels, entry, ctx);
          if (out.waiting) {
            const nextCheck = Math.min(Date.now() + config.match.recheckMinutes * 60000, Date.parse(out.waiting.until));
            state[key] = {
              done: false,
              attempts: entry.attempts,
              reading: entry.reading,
              waiting: { ...out.waiting, since: entry.waiting?.since ?? new Date().toISOString(), nextCheck: new Date(nextCheck).toISOString() },
              result: 'waiting for the bank charge',
              at: new Date().toISOString(),
            };
            if (config.dryRun) log('  [dry run] leaving it in the inbox (nothing is moved in dry run anyway)');
          } else {
            if (out.applied) {
              // Record the Actual change before moving the file: after a crash here, the next cycle only moves it.
              state[key] = { done: false, applied: out.applied, result: out.result, folder: out.folder, summary: out.summary, at: out.applied.at };
              await saveState(state);
            }
            await fileReceipt(item, key, state, out);
          }
        }
      } catch (err) {
        if (isTransient(err)) {
          // An outage says nothing about the receipt: don't count it, and don't try the rest while the server is down.
          log(`  outage (${err.message}); stopping this check, retrying on the next poll`);
          outage = true;
        } else {
          const attempts = (entry.attempts ?? 0) + 1;
          log(`  error (attempt ${attempts}/${MAX_ATTEMPTS}): ${err.message}`);
          // Read again next time: the reading itself may be what failed.
          state[key] = { done: false, attempts, error: err.message, at: new Date().toISOString() };
          if (attempts >= MAX_ATTEMPTS) {
            const failed = { result: 'failed', folder: config.nextcloud.review, summary: { file: item.basename, problems: [`failed ${attempts} times: ${err.message}`] } };
            try {
              await fileReceipt(item, key, state, failed);
            } catch (moveErr) {
              // Keep going: the next cycle only retries the move.
              log(`  could not move it to review: ${moveErr.message}`);
              Object.assign(state[key], failed);
            }
          }
        }
      }
      await saveState(state);
      await heartbeat();
      if (outage) break;
    }
  } finally {
    if (needsActual) await actual.close();
  }
}

async function main() {
  log(`receipt worker starting: dry run ${config.dryRun}, splits ${config.splits}, polling every ${config.pollSeconds}s, inbox ${config.nextcloud.inbox}`);
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
      timer = setTimeout(r, config.pollSeconds * 1000);
    });
    clearTimeout(timer);
    wake = null;
  }
  log('stopped');
  process.exit(0);
}

// Run the polling loop only when started as the main script, so importing this file starts nothing.
if (import.meta.url === `file://${process.argv[1]}`) main();

