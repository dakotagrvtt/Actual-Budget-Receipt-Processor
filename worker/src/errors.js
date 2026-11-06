// Errors that say nothing about the receipt itself: a model server, Actual or Nextcloud is down, slow or
// restarting. These never count as a failed attempt at a receipt (see index.js); the cycle stops and retries later.
export class TransientError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TransientError';
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** True for outages and timeouts (ours or a library's), false for problems with the receipt or a bug. */
export function isTransient(err) {
  for (let e = err; e; e = e.cause) {
    if (e instanceof TransientError) return true;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (NETWORK_CODES.has(e.code)) return true;
    if (typeof e.status === 'number' && (e.status >= 500 || e.status === 429)) return true; // webdav client errors
    if (/fetch failed|network|socket hang up|timed? ?out|503|502|504/i.test(e.message ?? '')) return true;
  }
  return false;
}
