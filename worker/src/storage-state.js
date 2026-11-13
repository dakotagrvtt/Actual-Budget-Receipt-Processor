// Which storage state.json belongs to. storage.json (beside state) records the storage kind, its location (the local folder, or the
// Nextcloud address and user) and the receipt folders. A changed record pauses the worker until ./receipts migrate-storage copies
// or moves the files, or --adopt says they are already there.
//
// The storage marker: /.receipts-storage-id at the top of the storage holds a random id, recorded in storage.json too. It tells
// the same storage reached another way (a new Nextcloud address or login spelling, a moved or renamed local folder) apart from
// another one: the same id means the same files, and the record follows the new address by itself. No marker where one was
// recorded, while state has receipts, means an empty or unmounted folder: the worker pauses instead of starting over.
// A copied folder keeps its marker and counts as the same storage; delete .receipts-storage-id in a copy another install will use.
// An install that has no marker recorded yet (an upgrade) gets one quietly; a marker problem there never pauses anything.
// The marker is written in dry run too: it is metadata about the storage, not a receipt change.
// A record with no marker and no receipts in state (a fresh install whose first address was mistyped) owes nothing to the
// storage it names: a change of settings is recorded silently instead of pausing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultFolders, config, log } from './config.js';
import { readOverrides } from './web-overrides.js';
import { normalizeStoragePath } from './migrate-fields.js';
import { reportSetupProblem } from './alert.js';

const FOLDERS = ['inbox', 'processed', 'review', 'archive'];
export const MARKER = '/.receipts-storage-id';

export const storageFile = (name) => path.join(path.dirname(config.statePath), name);
export async function readRecord(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
export async function writeRecord(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); }
  finally { await h.close(); }
  await fs.rename(tmp, file);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/**
 * The local folder as the host sees it. RECEIPTS_DIR (from .env) is the truth; RECEIPTS_HOST_DIR (./receipts writes it, the
 * absolute form of a relative RECEIPTS_DIR) is used only while it still names the same folder, so a hand-edited RECEIPTS_DIR
 * never hides behind an older RECEIPTS_HOST_DIR.
 */
export function hostDirOf(storage, env = process.env) {
  const dir = String(storage?.hostDir || './receipt-files').trim();
  if (path.isAbsolute(dir)) return path.resolve(dir);
  const host = env.RECEIPTS_HOST_DIR ? path.resolve(env.RECEIPTS_HOST_DIR) : '';
  const rel = path.normalize(dir).replace(/\/+$/, '');
  if (host && !rel.startsWith('..') && (host === `/${rel}` || host.endsWith(`/${rel}`))) return host;
  return `project:${rel}`;
}
const folderMap = (nc) => Object.fromEntries(FOLDERS.map((k) => [k, nc[k]]));
/** The storage a config names: { kind, location, folders }. */
export function identityOf(cfg, env = process.env) {
  const location = cfg.storage.kind === 'local'
    ? { hostDir: hostDirOf(cfg.storage, env) }
    : { url: String(cfg.nextcloud.url ?? '').replace(/\/+$/, ''), user: cfg.nextcloud.user };
  return { kind: cfg.storage.kind, location, folders: folderMap(cfg.nextcloud) };
}
export const storageIdentity = () => identityOf(config);

/**
 * The storage of an install from before storage was recorded: always Nextcloud, with the folders and account the settings name
 * for Nextcloud (RECEIPTS_* from .env and the Settings tab, else the Nextcloud defaults), never the local defaults.
 */
export function legacyStorage() {
  let values = { ...process.env };
  try { values = { ...values, ...readOverrides(config.webSettingsPath, () => {}).values }; } catch { /* .env alone */ }
  const dflt = defaultFolders(false);
  const env = { inbox: 'RECEIPTS_INBOX', processed: 'RECEIPTS_PROCESSED', review: 'RECEIPTS_REVIEW', archive: 'RECEIPTS_ARCHIVE' };
  const folders = Object.fromEntries(FOLDERS.map((k) => [k, values[env[k]] ?? dflt[k]]));
  const url = String(values.NEXTCLOUD_URL ?? '').trim().replace(/\/+$/, ''), user = String(values.NEXTCLOUD_USER ?? '').trim();
  return { kind: 'nextcloud', ...(url && user ? { location: { url, user } } : {}), folders };
}
export const sameFolders = (a, b) => FOLDERS.every((k) => normalizeStoragePath(a.folders[k]) === normalizeStoragePath(b.folders[k]));
export function sameStorage(a, b) {
  return a.kind === b.kind && JSON.stringify(a.location) === JSON.stringify(b.location) && sameFolders(a, b);
}
export async function recordedStorage() { return await readRecord(storageFile('storage.json')); }

// --- The marker ---------------------------------------------------------------------------------------------------------------
const statusOf = (err) => err?.status ?? err?.response?.status;
/** The marker id in the storage `client` reaches, or null when there is none. Other errors (an outage) throw. */
export async function readMarker(client) {
  let text;
  try { text = Buffer.from(await client.getFileContents(MARKER)).toString('utf8'); }
  catch (err) { if (statusOf(err) === 404) return null; throw err; }
  try { const id = JSON.parse(text)?.id; if (typeof id === 'string' && id) return id; } catch { /* below */ }
  throw new Error(`${MARKER} in the receipt storage is damaged. Delete it; the worker writes a new one.`);
}
/** Make the marker if there is none (never replacing one) and return the id that is there now. */
export async function writeMarker(client) {
  const id = randomUUID();
  try {
    await client.putFileContents(MARKER, JSON.stringify({ id, createdAt: new Date().toISOString() }), { overwrite: false, headers: { Overwrite: 'F' } });
    return id;
  } catch (err) {
    const found = await readMarker(client).catch(() => null);
    if (found) return found;
    throw err;
  }
}
export async function stateHasReceipts() {
  try { return Object.keys(JSON.parse(await fs.readFile(config.statePath, 'utf8')) ?? {}).length > 0; }
  catch (err) { return err.code !== 'ENOENT'; } // unreadable: assume it has some (loadState says what is wrong)
}
const describe = (id) => (id.kind === 'local' ? `the folder ${String(id.location?.hostDir).replace(/^project:/, './')}` : `${id.location?.user} at ${id.location?.url}`);

let markerProblem = null;
function problem(message) {
  const err = new Error(message);
  err.code = 'STORAGE_MIGRATION_REQUIRED';
  return err;
}
/**
 * Check the marker of the storage the settings name (the worker runs it before loading state). Recognizes the same storage at a
 * new address and records it; pauses for an empty or unmounted folder or another install's storage (assertStorage throws then).
 * An outage skips the check and keeps the last verdict. Returns what it decided, for the log and tests.
 */
export async function verifyStorageMarker(client, { write = true } = {}) {
  const meta = storageFile('storage.json');
  const saved = await recordedStorage();
  const progress = await readRecord(storageFile('storage-migration.json'));
  if (!saved || (progress && progress.phase !== 'complete')) { markerProblem = null; return 'skipped'; }
  let found;
  try { found = await readMarker(client); }
  catch (err) { log(`storage marker not checked: ${err.message}`); return 'unknown'; }
  const current = storageIdentity();
  if (saved.marker) {
    if (found === saved.marker) {
      markerProblem = null;
      if (!sameStorage(saved, current) && saved.kind === current.kind && sameFolders(saved, current)) {
        await writeRecord(meta, { ...current, marker: saved.marker });
        log(`the receipt storage is now reached as ${describe(current)} (its marker matches); recorded it`);
        return 'moved';
      }
      return 'same';
    }
    if (!found) {
      if (!await stateHasReceipts()) {
        markerProblem = null;
        if (write && sameStorage(saved, current)) await writeRecord(meta, { ...current, marker: await writeMarker(client) });
        return 'renewed';
      }
      markerProblem = problem(`The receipt storage (${describe(current)}) has no ${MARKER.slice(1)} file, but this install has receipts recorded there: the folder looks empty, not mounted, or not the right one. The worker is paused so nothing starts over. Mount or point the settings at the right folder. If the receipts are really there (the marker file was deleted), run ./receipts migrate-storage --adopt.`);
      return 'missing';
    }
    markerProblem = problem(`The receipt storage (${describe(current)}) belongs to another install or copy (its ${MARKER.slice(1)} differs from the one recorded). The worker is paused. Point the settings back at this install's storage, or run ./receipts migrate-storage to move to this one. If it really is this install's storage, run ./receipts migrate-storage --adopt.`);
    return 'other';
  }
  // No marker recorded yet (an upgrade, a fresh install): record one for this storage. Never pauses.
  markerProblem = null;
  if (!sameStorage(saved, current) && await nothingOwed(saved)) {
    await writeRecord(meta, current);
    log(`nothing was recorded in ${describe(saved)} yet; the receipt storage is now ${describe(current)}`);
    return verifyStorageMarker(client, { write });
  }
  if (!sameStorage(saved, current)) return 'unrecorded';
  if (!found && !write) return 'unrecorded';
  try { await writeRecord(meta, { ...saved, marker: found ?? await writeMarker(client) }); return 'recorded'; }
  catch (err) { log(`storage marker not written: ${err.message}`); return 'unrecorded'; }
}
export const clearMarkerProblem = () => { markerProblem = null; };

/** A record that holds nothing but the identity: no marker was ever written there and state has no receipts. */
export async function nothingOwed(saved) {
  return Boolean(saved) && !saved.marker && !await readRecord(storageFile('storage-migration.json')) && !await stateHasReceipts();
}

export async function assertStorage() {
  const saved = await recordedStorage();
  const old = saved ?? legacyStorage();
  const current = storageIdentity();
  const progress = await readRecord(storageFile('storage-migration.json'));
  // Old releases did not save locations. Capture the current location once, before any later setup switch.
  const compatible = !old.location && old.kind === current.kind && sameFolders(old, current);
  if (!progress && !sameStorage(old, current) && !compatible && await nothingOwed(saved)) {
    await writeRecord(storageFile('storage.json'), current);
    return;
  }
  if (progress && progress.phase !== 'complete') {
    const what = progress.mode === 'move' ? 'A move of the receipt folders' : progress.to?.kind ? `A copy of the receipts to ${describe(progress.to)}` : 'A copy of the receipts';
    const undo = progress.mode === 'move' ? 'A folder move that has started only goes forward.' : 'Or undo it with ./receipts migrate-storage --cancel (the originals were never changed).';
    const err = problem(`${what} is unfinished, so the worker is paused. Run ./receipts migrate-storage to finish it. ${undo}`);
    await reportSetupProblem(err, { kind: 'cycle' });
    throw err;
  }
  if (!sameStorage(old, current) && !compatible) {
    const err = problem('Receipt storage changed: the storage kind, its location (the local folder, the Nextcloud address or login) or the receipt folders differ from what this install recorded. Run ./receipts migrate-storage: it copies the files to a new storage, or moves them to the new folders when only the folders changed (do not move receipt folders yourself: state would still name the old places). If it is the same storage reached another way (a local folder you moved as a whole, or another spelling of the same Nextcloud address or login) and the worker did not recognize it, run ./receipts migrate-storage --adopt. Or put the settings back as they were. Original files stay in place.');
    await reportSetupProblem(err, { kind: 'cycle' });
    throw err;
  }
  if (markerProblem) { await reportSetupProblem(markerProblem, { kind: 'cycle' }); throw markerProblem; }
  if (compatible) await writeRecord(storageFile('storage.json'), { ...current, ...(old.marker ? { marker: old.marker } : {}) });
}

/**
 * Explicit operator assertion that the same files are already at the configured location. Never copies or rewrites state.
 * marker: the id found in that storage (the CLI reads or writes it); without one the worker records the marker it finds.
 */
export async function adoptStorage({ confirmed = false, marker = null } = {}) {
  if (!confirmed) throw new Error('Adoption needs confirmation: existing receipt files and summaries must already be at the configured location. No files will be copied or verified, and state will stay unchanged.');
  const current = storageIdentity();
  const saved = await recordedStorage() ?? legacyStorage();
  const progress = await readRecord(storageFile('storage-migration.json'));
  if (progress && progress.phase !== 'complete') throw new Error('Finish the pending migration before adopting storage.');
  if (saved.kind !== current.kind || !sameFolders(saved, current)) {
    throw new Error('Adoption requires the same storage kind and receipt folder paths. Use ./receipts migrate-storage to copy and rewrite paths.');
  }
  await writeRecord(storageFile('storage.json'), { ...current, ...(marker ? { marker } : {}) });
  markerProblem = null;
}
