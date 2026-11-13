// ./receipts migrate-storage runs this in a one-off worker container while the worker is stopped:
//   (no option)      copy the receipts to the storage the settings now name, or move the folders in place when it is the same
//                    storage with other folders; resumes a stopped run
//   --cancel         undo an unfinished copy (removes the copies it made), or a folder move that has not moved a file yet;
//                    never one that is committing. The journal is kept whenever the cleanup could not be done.
//   --into-used      copy even though the new storage's receipt folders already hold files state does not know
//   --adopt          the files are already at the configured place: record it without copying (needs --confirm-adopt)
//   --remember       setup, before switching storage: record the current storage as the one state belongs to
//   --source-info    read only, for ./receipts: the storage besides the current one this run needs (the old storage, or an
//                    unfinished run's destination to clean up), as key=value lines
// One run at a time (data/storage-migration.lock, kept fresh while the run is alive, taken over two minutes after a crash).
import './private-umask.js';
import net from 'node:net';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { readOverrides } from './web-overrides.js';
import { timedDavClient } from './dav-timeout.js';
import { localClient } from './local-files.js';
import { loadState, saveState } from './state.js';
import { withLock } from './file-lock.js';
import { storageFile, readRecord, writeRecord, storageIdentity, recordedStorage, legacyStorage, sameStorage, sameFolders, adoptStorage, readMarker, writeMarker } from './storage-state.js';
import { migrateStorage, moveFolders, cancelMigration, storageFiles, sameBacking, COMMITTING } from './migrate-storage.js';
import { inside } from './migrate-fields.js';
import { renameDrySummaries } from './dry-summaries.js';

export async function verifyStopped() {
  if (process.env.RECEIPTS_SERVICES_STOPPED !== '1') throw new Error('Stop the worker and web app using ./receipts migrate-storage.');
  const listening = await new Promise((resolve) => {
    const socket = net.connect({ host: 'worker', port: 8095 });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (listening) throw new Error('The worker web app is still running. Stop it before migrating.');
}

const settings = () => ({ ...process.env, ...readOverrides(config.webSettingsPath, () => {}).values });
const trimUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');
const sameLocation = (a, b) => JSON.stringify(a?.location) === JSON.stringify(b?.location);
const statusOf = (err) => err?.status ?? err?.response?.status;
const describe = (id) => (id.kind === 'local' ? `the folder ${String(id.location?.hostDir ?? '?').replace(/^project:/, './')}` : `Nextcloud ${id.location?.user ?? '?'} at ${id.location?.url ?? '?'}`);

const accountOf = (location) => `${location?.user ?? ''}@${location?.url ?? ''}`;
/**
 * The app password for a Nextcloud account: .env's when it is that account, else MIGRATION_SOURCE_APP_PASSWORD (asked by
 * ./receipts) when MIGRATION_SOURCE_ACCOUNT names this account or is unset.
 */
function passwordFor(location) {
  const s = settings();
  if (trimUrl(s.NEXTCLOUD_URL) === location.url && String(s.NEXTCLOUD_USER ?? '').trim() === location.user && s.NEXTCLOUD_APP_PASSWORD) return s.NEXTCLOUD_APP_PASSWORD;
  const account = process.env.MIGRATION_SOURCE_ACCOUNT;
  if (account && account !== accountOf(location)) return null;
  return process.env.MIGRATION_SOURCE_APP_PASSWORD || null;
}
const needsPassword = (id) => id.kind === 'nextcloud' && Boolean(id.location) && !passwordFor(id.location);

/**
 * A client for a storage identity. The current local folder is /receipts; one other folder (the old one, or an unfinished run's
 * destination) is mounted at RECEIPTS_SOURCE_MOUNT, and RECEIPTS_SOURCE_HOST_DIR says which one it is.
 */
async function defaultClientFor(identity) {
  const current = storageIdentity();
  if (identity.kind === 'local') {
    if (current.kind === 'local' && sameLocation(identity, current)) return localClient(config.storage.root);
    const mounted = process.env.RECEIPTS_SOURCE_HOST_DIR;
    if (process.env.RECEIPTS_SOURCE_MOUNT && (!mounted || mounted === identity.location?.hostDir)) return localClient(process.env.RECEIPTS_SOURCE_MOUNT);
    throw new Error(`The receipt folder ${describe(identity).replace(/^the folder /, '')} is not mounted (it is missing, or this was not run through ./receipts migrate-storage).`);
  }
  const location = identity.location;
  if (!location?.url || !location?.user) throw new Error('Migration needs the Nextcloud address and login (NEXTCLOUD_URL, NEXTCLOUD_USER) of the old storage in .env.');
  const password = passwordFor(location);
  if (!password) throw new Error(`Migration needs the app password of ${describe(identity)}: it is not the account in .env. ./receipts migrate-storage asks for it (or set MIGRATION_SOURCE_APP_PASSWORD).`);
  const { createClient } = await import('webdav');
  const client = timedDavClient(createClient(`${location.url}/remote.php/dav/files/${encodeURIComponent(location.user)}`, { username: location.user, password }));
  try { await client.exists('/'); }
  catch (err) { if ([401, 403].includes(statusOf(err))) throw new Error(`${describe(identity)} refused the app password (${statusOf(err)}). Nothing was changed.`, { cause: err }); throw err; }
  return client;
}

/** The storage state.json belongs to now: the record, else (an install from before records) Nextcloud as its settings name it. */
// No record: an upgrade from before storage.json (receipts in state: Nextcloud then), or a fresh install (nothing to migrate).
async function storedStorage(to, state) {
  const recorded = await recordedStorage();
  if (!recorded && !Object.keys(state).length) return to;
  let from = recorded ?? legacyStorage();
  if (!from.location && from.kind === to.kind) from = { ...from, location: to.location };
  return from;
}

async function locked(fn) {
  const lock = storageFile('storage-migration.lock');
  try { return await withLock(lock, fn, { waitMs: 0, staleMs: 120000, heartbeatMs: 20000 }); }
  catch (err) {
    if (err.message === `file is locked (${lock})`) throw new Error('Another ./receipts migrate-storage is running. Let it finish; if it was killed, try again in two minutes.');
    throw err;
  }
}

/**
 * Is `to` the storage `from` names, reached another way? Local folders by path; otherwise the marker, then a probe file.
 * source() opens the old storage only when it is needed: a moved local folder whose old path is gone is known by its marker.
 */
async function sameStorageBehind(from, to, source, destination) {
  if (from.kind !== to.kind) return false;
  if (from.kind === 'local') {
    const a = from.location?.hostDir, b = to.location?.hostDir;
    if (a === b) return true;
    if (a?.startsWith('/') && b?.startsWith('/') && (inside(a, b) || inside(b, a))) {
      throw new Error(`The new receipt folder (${b}) and the old one (${a}) are inside one another. Copying one into the other is not safe. Choose a folder outside the old one, or move the whole folder there yourself (the worker then knows it by its marker).`);
    }
  }
  const b = await readMarker(destination).catch(() => null);
  if (from.marker && b) return from.marker === b;
  const old = await source();
  const a = from.marker ?? await readMarker(old).catch(() => null);
  if (a && b) return a === b;
  return sameBacking(destination, old);
}

/**
 * The command. argv: the options; deps (tests): clientFor(identity) => client, out(line), verifyStopped().
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out ?? console.log;
  const log = (m) => out(`  ${m}`);
  const known = new Set(['--adopt', '--confirm-adopt', '--cancel', '--remember', '--source-info', '--into-used']);
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) throw new Error(`Unknown option ${unknown}. Usage: ./receipts migrate-storage [--adopt|--cancel|--into-used]`);
  const has = (f) => argv.includes(f);
  const clientFor = deps.clientFor ?? defaultClientFor;
  const progress = storageFile('storage-migration.json'), meta = storageFile('storage.json');
  const to = storageIdentity();

  if (has('--source-info')) {
    const state = await loadState({ allowStorageMismatch: true });
    let journal = await readRecord(progress);
    if (journal?.phase === 'complete') journal = null;
    // An unfinished run whose destination is not the current storage: that destination is what a cancel (or the automatic one
    // when the settings went back) has to reach. Otherwise the old storage the receipts are copied or moved from.
    const cleanup = journal && journal.mode !== 'move' && !(journal.to.kind === to.kind && sameLocation(journal.to, to));
    const other = cleanup ? journal.to : journal ? journal.from : await storedStorage(to, state);
    const current = other.kind === to.kind && sameLocation(other, to);
    out(`from_role=${cleanup ? 'destination' : 'source'}`);
    out(`from_kind=${other.kind}`);
    out(`from_host_dir=${other.kind === 'local' && !current ? other.location?.hostDir ?? '' : ''}`);
    out(`from_account=${other.kind === 'nextcloud' ? accountOf(other.location) : ''}`);
    out(`needs_source_password=${!has('--adopt') && !has('--remember') && !current && needsPassword(other) ? 1 : 0}`);
    out(`journal=${journal?.phase ?? 'none'}`);
    return;
  }
  await (deps.verifyStopped ?? verifyStopped)();
  return locked(async () => {
    const state = await loadState({ allowStorageMismatch: true });
    let journal = await readRecord(progress);
    if (journal?.phase === 'complete') { await fs.rm(progress, { force: true }); journal = null; }
    // Cancel: a committing run never, before any storage is opened. The journal goes only when the cleanup is complete.
    const cancel = async () => {
      if (journal.phase === 'committing') throw new Error(COMMITTING);
      let client;
      try { client = await clientFor(journal.to); }
      catch (err) {
        throw new Error(`The cancel is not complete: ${describe(journal.to)} can't be reached (${err.message}). Nothing was removed there, and the unfinished migration is kept, so the worker stays paused. Make it reachable (the folder there, or the right app password) and run ./receipts migrate-storage --cancel again.`, { cause: err });
      }
      const left = await cancelMigration({ journal, destination: client, client, log });
      if (left) throw new Error(`The cancel is not complete: ${left} copy(s) in ${describe(journal.to)} could not be removed (named above). The unfinished migration is kept, so the worker stays paused. Run ./receipts migrate-storage --cancel again.`);
      await fs.rm(progress, { force: true });
    };

    if (has('--cancel')) {
      if (!journal) { out('No migration is in progress. Nothing to cancel.'); return; }
      await cancel();
      out(`Migration cancelled. ${journal.mode === 'move' ? 'No file had moved yet.' : 'The copies it made were removed; the originals were never changed.'} State is unchanged.`);
      return;
    }
    if (has('--adopt')) {
      if (!has('--confirm-adopt')) return adoptStorage({ confirmed: false });
      let marker = null;
      try { const c = await clientFor(to); marker = await readMarker(c) ?? await writeMarker(c); }
      catch (err) { log(`storage marker not recorded now (the worker records it): ${err.message}`); }
      await adoptStorage({ confirmed: true, marker });
      out('Storage identity adopted. No files were copied or verified. Existing receipt state was kept.');
      return;
    }
    if (has('--remember')) {
      let from = await recordedStorage();
      if (!from && Object.keys(state).length && to.kind !== 'nextcloud') from = legacyStorage();
      if (!from) from = to;
      if (!from.location && from.kind === to.kind) from = { ...from, location: to.location };
      let hasReceipts = Object.keys(state).length > 0;
      if (!hasReceipts) {
        try { hasReceipts = (await storageFiles(await clientFor(from), from.folders)).length > 0; }
        catch (err) { log(`could not list the current storage (${err.message}); assuming it has receipts`); hasReceipts = true; }
      }
      await writeRecord(meta, from);
      out(hasReceipts ? 'Existing receipts found.' : 'No existing receipts.');
      return;
    }

    // The settings point back at the storage an unfinished run was copying from: that run is no longer wanted.
    if (journal && journal.phase !== 'committing' && sameStorage(journal.from, to)) {
      try { await cancel(); }
      catch (err) { throw new Error(`The settings name the old storage again, but the unfinished migration could not be cancelled. ${err.message}`, { cause: err }); }
      out('The settings name the old storage again, so the unfinished migration was cancelled.');
      journal = null;
    }
    const from = journal?.from ?? await storedStorage(to, state);
    if (journal && !sameStorage(journal.to, to)) throw new Error(`A migration to ${describe(journal.to)} is unfinished. Point the settings back at it and run ./receipts migrate-storage to finish it, or run ./receipts migrate-storage --cancel.`);
    if (!journal && sameStorage(from, to)) { out('State already belongs to this storage. Nothing to migrate.'); return; }

    const destination = await clientFor(to);
    const commit = async (next, identity, j) => {
      await saveState(next);
      let marker = null;
      try { marker = await readMarker(destination) ?? await writeMarker(destination); }
      catch (err) { log(`storage marker not written now (the worker writes it): ${err.message}`); }
      await writeRecord(meta, { ...identity, ...(marker ? { marker } : {}) });
      if (j?.keys) await renameDrySummaries(j.keys);
    };
    const checkpoint = (j) => writeRecord(progress, j);
    const finish = async () => fs.rm(progress, { force: true }); // L6: a finished journal is not left behind

    let mode = journal?.mode ?? null, source = null;
    const openSource = async () => (source ??= from.kind === 'local' && from.location?.hostDir === to.location?.hostDir ? destination : await clientFor(from));
    if (!journal) {
      if (await sameStorageBehind(from, to, openSource, destination)) {
        if (sameFolders(from, to)) {
          const marker = await readMarker(destination).catch(() => null) ?? from.marker;
          await writeRecord(meta, { ...to, ...(marker ? { marker } : {}) });
          out(`This is the same storage, reached as ${describe(to)} now. Recorded it. Nothing to migrate.`);
          return;
        }
        mode = 'move';
      } else {
        mode = 'copy';
      }
    }
    if (mode === 'move') {
      await moveFolders({ client: destination, from, to, state, journal, checkpoint, commit, log });
      await finish();
      out('Receipt folders moved in place, and state and summaries now name the new folders.');
      return;
    }
    await migrateStorage({ source: await openSource(), destination, from, to, state, journal, checkpoint, commit, log, intoUsed: has('--into-used') });
    await finish();
    out('Migration complete. Copies were verified by size and SHA-256. Originals were left untouched; remove them only after checking the new storage.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
