// Errors that say nothing about the receipt itself: a model server, Actual or Nextcloud is down, slow or
// restarting. These never count as a failed attempt at a receipt (see index.js); the cycle stops and retries later.
export class TransientError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/**
 * An error that will not go away by waiting, whatever its message says (a 4xx body may echo "network" or "503").
 * isTransient() answers false for it. Counts as a failed attempt at the receipt.
 */
export class PermanentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

/**
 * The setup is wrong, not the receipt (a refused API key, a request the service can't take): the cycle stops and
 * no attempt is counted, like an outage, but waiting alone won't fix it. index.js shows it on the status page.
 */
export class SetupError extends PermanentError {
  constructor(message, options) {
    super(message, options);
    this.name = 'SetupError';
    this.pauses = true;
  }
}

/**
 * This receipt could not be processed in this check, and it is not yet clear whether the receipt or the setup is at fault
 * (a cloud reader's 400 about the image before it has ever read anything): leave it for the next check, count no attempt,
 * pause nothing, and go on with the next receipt. index.js / failure.js give up on a receipt that is skipped too often.
 */
export class SkipReceiptError extends PermanentError {
  constructor(message, options) {
    super(message, options);
    this.name = 'SkipReceiptError';
    this.skip = true;
  }
}
export const isSkip = (err) => {
  for (let e = err; e; e = e.cause) if (e.skip === true) return true;
  return false;
};

/**
 * A paid cloud call (the reader, the hosted decider) that failed in a way that says something about THIS receipt: the
 * request may already have been billed (504, 524, 408, our own timeout, a body that could not be read), so index.js counts it
 * per receipt and gives up on the receipt after a few checks. Every other transient failure of a paid call (429/5xx
 * after the retries, no connection, DNS) is an outage of the provider: nothing is counted and the cycle stops.
 */
export const COUNTED_STATUSES = new Set([408, 504, 524]);
export const markCounted = (err, by) => Object.assign(err, { counts: true, countedBy: by });
/** 'reader' or 'decider' when a paid call failed in a way that counts against the receipt (see markCounted), else null. */
export function countedBy(err) {
  for (let e = err; e; e = e.cause) if (e.counts === true) return e.countedBy ?? 'reader';
  return null;
}
export const isCounted = (err) => countedBy(err) !== null;

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** Our own timeout or an abort, or undici's own header/body timeout, anywhere in the cause chain (not a refused or lost connection). */
export const isClientTimeout = (err) => {
  for (let e = err, i = 0; e && i < 10; e = e.cause, i++) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT') return true;
  }
  return false;
};

/** True for outages and timeouts (ours or a library's), false for problems with the receipt or a bug. */
export function isTransient(err) {
  for (let e = err; e; e = e.cause) {
    if (e.permanent === true) return false;
    if (e instanceof TransientError) return true;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (NETWORK_CODES.has(e.code)) return true;
    if (typeof e.status === 'number' && (e.status >= 500 || e.status === 429)) return true; // webdav client errors
    if (/fetch failed|network|socket hang up|timed? ?out|503|502|504/i.test(e.message ?? '')) return true;
  }
  return false;
}

/** True if the error is a wrong setup (see SetupError): stop the cycle, count no attempt, tell the user. */
export function isSetupProblem(err) {
  for (let e = err; e; e = e.cause) if (e.pauses === true) return true;
  return false;
}

/**
 * The receipt file in the inbox is no longer the version that was listed (the server answered 412 to a request that named the
 * listed etag): someone uploaded another photo under the same name. Nothing was read or moved from the new one.
 * index.js counts no attempt; the new version is a receipt of its own at the next poll.
 */
export class FileChangedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'FileChangedError';
    this.fileChanged = true;
  }
}
export const isFileChanged = (err) => {
  for (let e = err; e; e = e.cause) if (e.fileChanged === true) return true;
  return false;
};
