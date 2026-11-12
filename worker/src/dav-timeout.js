import { TransientError } from './errors.js';
// Every WebDAV request gets a deadline and cancels its underlying HTTP request.
export const DAV_TIMEOUT_MS = 30000;
const optionAt = { exists: 1, stat: 1, getDirectoryContents: 1, getFileContents: 1, createDirectory: 1, deleteFile: 1, moveFile: 2, copyFile: 2, putFileContents: 2 };
export function timedDavClient(client, timeoutMs = DAV_TIMEOUT_MS) {
  return new Proxy(client, { get(target, name) {
    const method = target[name];
    if (!(name in optionAt) || typeof method !== 'function') return typeof method === 'function' ? method.bind(target) : method;
    return (...args) => {
      const index = optionAt[name];
      const options = args[index] ?? {};
      const deadline = AbortSignal.timeout(timeoutMs);
      args[index] = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
      return Promise.resolve().then(() => method.apply(target, args)).catch((err) => {
        if (args[index].signal.aborted) { const failure = new TransientError('Nextcloud request timed out or was cancelled', { cause: err }); failure.service = 'nextcloud'; throw failure; }
        throw err;
      });
    };
  } });
}
