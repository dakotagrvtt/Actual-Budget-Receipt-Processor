// One thing at a time may use the Actual budget and the worker's state: the poll cycle (index.js) holds this for its
// whole run, and so does every change made from the receipt page (receipt-fix.js). They share one process, and the
// Actual API is one global session (open ... close), so two users of it would trip over each other; the cycle also keeps
// state.json in memory for its whole run and saves all of it, which would silently undo an edit made from the page.
// A page change waits for its turn for a short time and otherwise says the worker is busy; it never waits for minutes.

export class BusyError extends Error {}

let held = false;
const waiting = []; // { grant(), dead } in arrival order

const next = () => {
  while (waiting.length) {
    const w = waiting.shift();
    if (w.dead) continue;
    held = true;
    w.grant();
    return;
  }
  held = false;
};

/** Wait for the lock (forever, or `timeoutMs`), run fn, release. A timeout rejects with BusyError and never runs fn. */
export async function exclusive(fn, { timeoutMs = null } = {}) {
  if (held) {
    await new Promise((resolve, reject) => {
      const w = { grant: resolve, dead: false };
      waiting.push(w);
      if (timeoutMs != null) {
        setTimeout(() => {
          if (!w.dead && waiting.includes(w)) {
            w.dead = true;
            reject(new BusyError('the worker is busy checking receipts'));
          }
        }, timeoutMs).unref();
      }
    });
  } else {
    held = true;
  }
  try {
    return await fn();
  } finally {
    next();
  }
}

/** Is something holding the lock right now? (For the page's "busy" wording and tests.) */
export const isBusy = () => held;

/** Wait until whatever holds the lock is done (for at most `ms`); true when it is free. Used before the worker exits, so a save from the page is not cut off. */
export const drain = (ms) => exclusive(async () => true, { timeoutMs: ms }).catch(() => false);
