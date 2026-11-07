// Decides what the poll loop does with an error thrown while it processed one receipt. index.js has no test harness,
// so the decision lives here. It is pure: it returns what to do and the entry to keep, and index.js does the
// logging, filing and saving.
import { isSetupProblem, isTransient, isSkip, countedBy } from './errors.js';
import { countFailure, countSkip, clearFailureCounts } from './state.js';

// Two paid-call failures in one check look like an outage, not one bad receipt, so the check stops.
const TROUBLES_BEFORE_STOP = 2;

/**
 * kind:
 *   'setup'   The setup is wrong, not the receipt. Stop, count nothing, tell the user.
 *   'counted' A paid cloud call (reader or hosted decider) failed in a way that may have been billed and is about this
 *             receipt. `entry` carries the count. After 3 checks in a row `giveUp` is true, which counts as a failed attempt.
 *   'skip'    The cloud reader refused this receipt's image before reading anything, so we can't tell if the photo or the
 *             setup is at fault. Count no attempt, pause nothing, go on with the next receipt. After 3 skips in a row it
 *             becomes an 'attempt'.
 *   'outage'  A service is down, busy or unreachable (including a cloud provider's outage). Stop the check, count nothing.
 *   'attempt' Anything else: a failed attempt at the receipt.
 * Only consecutive failures count. So every kind except 'counted' and 'skip' returns the entry with its counters cleared;
 * 'skip' clears the failure counters but keeps its own skip count.
 * `troubles` is the number of counted failures so far in this check. `stop` ends the check: an outage, a setup problem,
 * or a second counted failure (even one that gives up).
 */
export function classifyFailure(err, entry, troubles = 0) {
  if (isSetupProblem(err)) return { kind: 'setup', entry: clearFailureCounts(entry), troubles, stop: true };
  if (isSkip(err)) {
    const { giveUp, entry: skipped } = countSkip(entry);
    return giveUp ? { kind: 'attempt', entry: skipped, troubles, stop: false } : { kind: 'skip', entry: skipped, troubles, stop: false };
  }
  const by = isTransient(err) ? countedBy(err) : null;
  if (by) {
    const { count, giveUp, entry: counted } = countFailure(entry, by, err.message);
    const now = troubles + 1;
    return { kind: 'counted', by, count, giveUp, entry: counted, troubles: now, stop: now >= TROUBLES_BEFORE_STOP };
  }
  if (isTransient(err)) return { kind: 'outage', entry: clearFailureCounts(entry), troubles, stop: true };
  return { kind: 'attempt', entry: clearFailureCounts(entry), troubles, stop: false };
}
