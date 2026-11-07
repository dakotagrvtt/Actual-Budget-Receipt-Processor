// Following an Actual server upgrade without a restart by hand (ACTUAL_API_VERSION=auto). The loader (actual-api.js) picks
// the API version once at startup. The long-running worker also compares the server's version with the one in use at the
// start of each cycle that opens Actual; on a difference it exits non-zero, and Docker's `restart: unless-stopped`
// starts it again, so the loader installs the matching API. A marker file guards against restart loops.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchServerVersion } from './actual-version.js';
import { writePrivate } from './private-files.js';

const VERSION = /^\d+\.\d+\.\d+$/;
export const CHECK_EVERY_MS = 10 * 60 * 1000; // /info is asked at most this often
export const GUARD_MS = 60 * 60 * 1000; // restarted for a version this recently and still not on it: stop restarting
export const EXIT_CODE = 75;
const MARKER = '.upgrade.json';

/** The status page's note about the API version (empty = nothing to say). The page runs in the worker process. */
export const upgradeStatus = { note: '' };

/**
 * What to do about the server's version. Returns { action, message }:
 *  'ok'      nothing to do (not auto, version unknown, or already matching);
 *  'restart' the server runs another version than the API in use: exit so Docker restarts the worker;
 *  'note'    a mismatch, but restarting would not help or was just tried: say so instead of looping.
 * failedFor: a server version this process already failed to install an API for (fell back to the bundled one).
 * restartedFor: { version, at } from the marker file, left by a restart for that version.
 */
export function upgradeDecision({ setting, usingVersion, serverVersion, failedFor = null, restartedFor = null, now = Date.now(), guardMs = GUARD_MS }) {
  if (setting !== 'auto' || !serverVersion || !VERSION.test(serverVersion) || serverVersion === usingVersion) return { action: 'ok', message: '' };
  if (failedFor === serverVersion) {
    return { action: 'note', message: `Actual server ${serverVersion}, but installing the matching @actual-app/api failed at startup; still using ${usingVersion}. Not restarting again (see the log; fix the cause and run ./receipts restart).` };
  }
  if (restartedFor?.version === serverVersion && now - restartedFor.at < guardMs) {
    return { action: 'note', message: `Actual server ${serverVersion}, and the worker already restarted once for it but is still on @actual-app/api ${usingVersion}. Not restarting again (see the log; ./receipts restart tries once more).` };
  }
  return { action: 'restart', message: `the Actual server is ${serverVersion} but this worker uses @actual-app/api ${usingVersion}: exiting so Docker restarts it with the matching version` };
}

async function readMarker(dir) {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
    return typeof m?.version === 'string' && Number.isFinite(m.at) ? m : null;
  } catch {
    return null;
  }
}
/** The marker the worker left in the API dir: { version, at, outcome: 'restarting' | 'stuck', message? }, or null. Used by the setup check. */
export const readUpgradeMarker = readMarker;
const writeMarker = (dir, m) => writePrivate(path.join(dir, MARKER), JSON.stringify(m)).catch(() => {}); // the guard is best effort
const clearMarker = (dir) => fs.rm(path.join(dir, MARKER), { force: true }).catch(() => {});

/**
 * The per-cycle check. `startVersion` is the server version the loader saw at startup (it seeds the cache, so the first
 * cycle asks nothing). check() returns the decision and keeps upgradeStatus.note current.
 */
export function createUpgradeWatcher({ setting, serverURL, usingVersion, startVersion = null, failedFor = null, dir, fetchFn = fetchServerVersion, now = Date.now, everyMs = CHECK_EVERY_MS, status = upgradeStatus }) {
  let cached = startVersion ? { version: startVersion, at: now() } : null;
  return {
    async check() {
      if (setting !== 'auto') return { action: 'ok', message: '' };
      if (!cached || now() - cached.at >= everyMs) {
        const version = await fetchFn(serverURL); // null = unreachable; Actual would not open either, so say nothing
        if (version) cached = { version, at: now() };
        else if (!cached) return { action: 'ok', message: '' };
      }
      const serverVersion = cached.version;
      const marker = await readMarker(dir);
      const d = upgradeDecision({ setting, usingVersion, serverVersion, failedFor, restartedFor: marker, now: now() });
      if (d.action === 'restart') await writeMarker(dir, { version: serverVersion, at: now(), outcome: 'restarting' });
      else if (d.action === 'note') await writeMarker(dir, { version: serverVersion, at: marker?.version === serverVersion ? marker.at : now(), outcome: 'stuck', message: d.message });
      else if (marker && serverVersion === usingVersion) await clearMarker(dir);
      status.note = d.action === 'note' ? d.message : '';
      return d;
    },
  };
}
