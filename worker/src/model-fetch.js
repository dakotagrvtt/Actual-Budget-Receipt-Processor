// Node's fetch (undici) gives up after 300 s without response headers or without body data, whatever AbortSignal says.
// modelFetch makes a request's own timeout the real one: it passes an undici Agent whose limits are a little longer than
// the request's signal, so the signal always fires first (a TimeoutError) and the 300 s limit never does.
// The undici package is not a dependency. Node bundles it, and the Agent class is reachable through the global dispatcher
// that the first fetch sets up; if that is not available the request still goes out with Node's defaults.

const nativeFetch = globalThis.fetch;
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const MARGIN_MS = 10000;
const agents = new Map();

/** The undici Agent for a request that may take `timeoutMs`, or undefined if Node does not expose one. */
export async function dispatcherFor(timeoutMs) {
  const wanted = timeoutMs + MARGIN_MS;
  if (agents.has(wanted)) return agents.get(wanted);
  let agent;
  try {
    if (!globalThis[GLOBAL_DISPATCHER]) await nativeFetch('data:,'); // sets up the global dispatcher without any network
    const Agent = globalThis[GLOBAL_DISPATCHER]?.constructor;
    if (typeof Agent === 'function') agent = new Agent({ headersTimeout: wanted, bodyTimeout: wanted });
  } catch {
    agent = undefined;
  }
  agents.set(wanted, agent);
  return agent;
}

/** fetch with a timeout of `timeoutMs` for the whole request (headers and body), which really takes effect. */
export async function modelFetch(url, init, timeoutMs) {
  const dispatcher = await dispatcherFor(timeoutMs);
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), ...(dispatcher ? { dispatcher } : {}) });
}
