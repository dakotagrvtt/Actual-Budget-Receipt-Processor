// A problem with the setup (not with any receipt) that stops the worker's checks until you fix it, e.g. the hosted
// decider refusing the API key. The worker logs it once per distinct message (not at every poll) and keeps it in
// data/worker-alert.json so the status page can show a banner. It clears when a check goes through, or at startup.
import fs from 'node:fs/promises';
import { config, log } from './config.js';
import { writePrivate } from './private-files.js';

let last = '';
let lastKind = null; // 'cycle': raised by a check that failed as a whole, so the next check that goes through clears it
let touched = false; // reported during the cycle in progress
let fileEnabled = false; // only the long-running worker owns the banner file; replay and item-test only log

/** Called once by the worker at startup: from then on problems also go to the status page's banner file. */
export const useAlertFile = () => { fileEnabled = true; };
/** Called at the start of each check: a banner raised by an earlier check clears at the end of the first quiet one. */
export const beginCycle = () => { touched = false; };

/** "the hosted decider ..." -> "The hosted decider ..." */
const sentence = (msg) => msg.charAt(0).toUpperCase() + msg.slice(1);

/**
 * Say it in the log and on the status page, unless it is the same problem as last time. Returns true if it was new.
 * pausing: false for a notice that does not stop the worker (items refused, receipts go on).
 */
export async function reportSetupProblem(err, { pausing = true, kind = null } = {}) {
  touched = true;
  const message = sentence(String(err.message));
  if (message === last) {
    if (kind) lastKind = kind; // the same problem, now known to stop the checks: a passing check clears it
    return false;
  }
  last = message;
  lastKind = kind;
  log(pausing ? `  setup problem: ${message}; stopping this check. Receipts wait and no attempt is counted; the next poll tries again` : `  notice: ${message}`);
  if (!fileEnabled) return true;
  try {
    await writePrivate(config.alertPath, JSON.stringify({ message, at: new Date().toISOString(), pausing }));
  } catch (e) {
    log(`  could not write ${config.alertPath}: ${e.message}`);
  }
  return true;
}

/** End of a cycle that went through: clear the banner, unless this very cycle raised it again. */
export async function clearSetupProblemIfQuiet() {
  if (touched) {
    touched = false;
    return;
  }
  await clearSetupProblem();
}

/** A check went through: clear the banner a failed check raised (kind 'cycle'), not one about a receipt's setup. */
export async function clearCycleProblem() {
  if (lastKind === 'cycle') await clearSetupProblem();
}

/** The problem is gone (or the worker just started): remove the banner. */
export async function clearSetupProblem() {
  last = '';
  lastKind = null;
  if (!fileEnabled) return;
  await fs.rm(config.alertPath, { force: true }).catch(() => {});
}

/** For the status page: { message, at } or null. */
export async function readSetupProblem() {
  try {
    const a = JSON.parse(await fs.readFile(config.alertPath, 'utf8'));
    return typeof a?.message === 'string' ? { message: a.message, at: a.at ?? null, pausing: a.pausing !== false } : null;
  } catch {
    return null;
  }
}
