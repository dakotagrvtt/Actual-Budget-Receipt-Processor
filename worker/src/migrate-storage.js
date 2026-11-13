// Moving the receipt files to another storage (copy mode), or to other folders in the same storage (move mode), and rewriting
// state.json and the summaries to match. Run by migrate-storage-cli.js while the worker and its web app are stopped.
//
// Copy mode: list the old folders (names, versions, sizes only), then copy one file at a time: read it with If-Match, write it
//   without replacing anything, read it back and compare SHA-256. The journal (storage-migration.json) records every destination
//   before it is written, so a stopped run resumes. After each pass the old folders are listed again: a source that changed or
//   vanished loses the copy made of it (only when that copy is still the bytes this migration wrote), and new files are copied.
//   Nothing in state changes until a pass finds the source unchanged; then state is rewritten (migrate-fields.js) and committed.
// Move mode (same storage, other folders): every file whose path changes is moved into a hidden staging folder first, then to its
//   new place, so folders that swap, nest or overlap never meet half way. Summaries are rewritten in place afterwards, each one's
//   new hash recorded first, so a resumed run never rewrites one twice.
import path from 'node:path/posix';
import { createHash, randomUUID } from 'node:crypto';
import { ifMatch, NO_OVERWRITE, isExists } from './requeue.js';
import { sameEtag, normalizeStoragePath, mapStoragePath, inside, migrationRewriter, migratedState, UnsafeMigrationError } from './migrate-fields.js';

export { normalizeStoragePath, mapStoragePath, migrationRewriter, migratedState, UnsafeMigrationError };

/** The storage marker (storage-state.js) and the hidden names this tool makes; none of them is ever a receipt. */
export const MARKER_NAME = '.receipts-storage-id';
export const STAGING_PREFIX = '.receipts-move-';
const PROBE_PREFIX = '.receipts-probe-';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HIDDEN = new RegExp(`^(\\.receipts-storage-id|\\.receipts-claims|\\.receipts-move-.*|\\.receipts-probe-.*|\\.claim-${UUID}|\\..*\\.${UUID}\\.tmp)$`);
export const migrationHidden = (name) => HIDDEN.test(name);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const statusOf = (err) => err?.status ?? err?.response?.status;
const missing = (err) => statusOf(err) === 404;
const FOLDER_KEYS = ['inbox', 'processed', 'review', 'archive'];
const noLog = () => {};
/** err with where it happened in front ("Could not read ... in the old storage"), its status and code kept. */
const at = (err, what) => Object.assign(new Error(`${what} (${err.message})`, { cause: err }), { status: statusOf(err), code: err?.code });

/** Every file under the folders (recursively) as a Map: path => { etag, size }. A missing folder is empty. Hidden tool names are skipped. */
export async function inventory(client, folders) {
  const files = new Map();
  const seen = new Set();
  async function walk(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (!await client.exists(dir)) return;
    for (const item of await client.getDirectoryContents(dir)) {
      const name = item.basename ?? path.basename(item.filename);
      if (migrationHidden(name)) continue;
      if (item.type === 'directory') await walk(normalizeStoragePath(item.filename));
      else if (item.type === 'file') {
        const file = normalizeStoragePath(item.filename);
        let { etag, size } = item;
        if (!etag || size == null) ({ etag, size } = await client.stat(file));
        files.set(file, { etag: etag ?? null, size: size == null ? null : Number(size) });
      }
    }
  }
  for (const dir of Object.values(folders)) await walk(normalizeStoragePath(dir));
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
export async function storageFiles(client, folders) { return [...(await inventory(client, folders)).keys()]; }

const sameInventory = (a, b) => a.size === b.size && [...a].every(([f, v]) => b.has(f) && sameEtag(b.get(f).etag, v.etag) && b.get(f).size === v.size);

/** A local folder: settle half-finished moves of every process first (nothing else may use the folder now). */
export async function settleClaims(client) {
  if (client?.localFiles !== true) return;
  if (!client.recoverClaims) throw new Error('Local storage must support recoverClaims({ all: true }) before migration.');
  const recovery = await client.recoverClaims({ all: true });
  if (recovery.remaining > 0) throw new Error('Unsettled local file claims remain. Let them finish before migrating.');
}

/**
 * Are two clients the same storage? A hidden folder is made through one and looked for through the other, then removed. false when
 * that can't be tried (a client without the calls, a refused write): the caller's other checks (marker, location) still apply.
 */
export async function sameBacking(a, b) {
  if (!a?.createDirectory || !a?.deleteFile || !b?.exists) return false;
  const probe = `/${PROBE_PREFIX}${randomUUID()}`;
  try { await a.createDirectory(probe); } catch { return false; }
  try { return await b.exists(probe); }
  catch { return false; }
  finally { await a.deleteFile(probe).catch(() => {}); }
}

/** Is the copy at `to` still the bytes this migration wrote (`digest`)? Then delete it. true when nothing of ours is left there. */
async function removeOurs(client, to, digest, log) {
  if (!digest) return true;
  let bytes;
  try { bytes = Buffer.from(await client.getFileContents(to)); }
  catch (err) { if (missing(err)) return true; throw err; }
  if (hash(bytes) !== digest) { log(`left ${to} in place: it is not the copy this migration made`); return false; }
  await client.deleteFile(to);
  return true;
}

/** Validate before anything is recorded: unsafe pending operations refuse here, before the worker is paused by a journal. */
async function preview(client, files, state, folders, log) {
  const copies = [...files].map(([file, v]) => ({ from: file, to: file, sourceEtag: v.etag, etag: v.etag }));
  const rw = migrationRewriter(folders, folders, copies);
  rw.state(state);
  for (const [file] of files) {
    if (!file.endsWith('.json')) continue;
    let parsed;
    try { parsed = JSON.parse(Buffer.from(await client.getFileContents(file)).toString('utf8')); }
    catch (err) { if (err instanceof SyntaxError) { log(`${file} is not valid JSON; it is copied byte for byte, unchanged`); continue; } if (missing(err)) continue; throw err; }
    try { rw.sidecar(parsed, file); } catch (err) { throw named(err, file); }
  }
}
const named = (err, file) => (err instanceof UnsafeMigrationError ? new UnsafeMigrationError(`${file}: ${err.message}`) : err);

/**
 * Receipt files already in the new storage's folders are unknown to state (left from earlier use of that storage, for example the
 * originals a move away left behind): the worker would file the ones in its inbox again as new receipts. Refused unless intoUsed.
 */
async function checkDestinationEmpty(destination, folders, intoUsed, log) {
  const there = [...(await inventory(destination, folders)).keys()];
  if (!there.length) return;
  const inbox = normalizeStoragePath(folders.inbox);
  const waiting = there.filter((f) => inside(f, inbox)).length;
  const what = `The new storage already holds ${there.length} file(s) in its receipt folders (for example ${there[0]})${waiting ? `, ${waiting} of them in its inbox` : ''}. They are not in this install's state, perhaps left from an earlier use of that storage`;
  if (!intoUsed) throw new Error(`${what}. Migrating there would file those again as new receipts. Move them out of the receipt folders (or remove them once you have checked them) and run ./receipts migrate-storage again; or run ./receipts migrate-storage --into-used to copy beside them anyway. Nothing was copied.`);
  log(`${what}; copying beside them (--into-used): the worker files the ones in the inbox as new receipts`);
}

/** State paths no copy covers: stale ones are counted; one that still exists in the old storage means the old folders are wrong. */
async function checkCoverage(source, state, from, covered, log) {
  const oldDirs = Object.values(from.folders).map(normalizeStoragePath);
  const refs = new Set();
  for (const [key, e] of Object.entries(state)) {
    const file = key.replace(/^dry:/, '').split('@').slice(0, -1).join('@');
    for (const p of [e?.filedAs, e?.filing?.from, e?.filing?.to, e?.resolutionPending?.from, e?.requeue?.from, e?.done ? null : file]) {
      if (typeof p === 'string' && p.startsWith('/') && !covered.has(p)) refs.add(p);
    }
  }
  const there = [];
  let stale = 0;
  for (const p of refs) {
    if (await source.exists(p)) there.push(p); else stale++;
  }
  if (there.length) {
    const outside = there.filter((p) => !oldDirs.some((d) => inside(normalizeStoragePath(p), d)));
    throw new Error(`State names ${there.length} file(s) outside what this migration takes along, for example ${there[0]}.${outside.length ? ` It is outside the old receipt folders (${oldDirs.join(', ')}), so the old folder settings look wrong: put them back as they were before the switch and run ./receipts migrate-storage again.` : ' Stop uploads and sync tools, then run ./receipts migrate-storage again.'} State was not changed.`);
  }
  if (stale) log(`${stale} file(s) named in state were already gone from the old storage; their entries now name the new folders`);
}

async function finishCommit(journal, checkpoint, commit) {
  await commit(journal.state, journal.to, journal);
  journal.phase = 'complete';
  delete journal.state; // the state is in state.json now; the finished journal is removed by the caller
  await checkpoint(journal);
  return journal;
}

/**
 * Copy mode. source/destination: clients; from/to: identities ({ kind, location, folders }); state: the current state.json;
 * journal: a stopped run's journal or null; checkpoint(journal) persists it; commit(state, to, journal) saves both records.
 */
export async function migrateStorage({ source, destination, from, to, state, journal, checkpoint, commit, maxPasses = 5, log = noLog, intoUsed = false }) {
  if (journal?.phase === 'committing') return finishCommit(journal, checkpoint, commit);
  await settleClaims(source);
  const starting = !journal;
  if (starting && await sameBacking(destination, source)) throw new Error('The old and the new storage are the same place. Nothing was copied; run ./receipts migrate-storage again so it moves the folders in place.');
  let current = await inventory(source, from.folders);
  if (starting) await preview(source, current, state, from.folders, log);
  if (starting) await checkDestinationEmpty(destination, to.folders, intoUsed, log);
  journal ??= { version: 2, mode: 'copy', from, to, copies: [], phase: 'copying' };
  journal.damaged ??= [];
  await checkpoint(journal);

  const read = async (copy, meta) => {
    let bytes;
    try { bytes = Buffer.from(await source.getFileContents(copy.from, { headers: ifMatch(meta.etag) })); }
    catch (err) { if (statusOf(err) === 412 || missing(err)) return null; throw at(err, `Could not read ${copy.from} in the old storage`); } // changed or gone: the next listing says which
    if (meta.size != null && bytes.length !== meta.size) return null;
    return bytes;
  };
  const place = async (copy, bytes) => {
    const writing = `Could not write ${copy.to} in the new storage`;
    try { await destination.createDirectory(path.dirname(copy.to), { recursive: true }); }
    catch (err) { throw at(err, writing); }
    let written = false;
    if (!await destination.exists(copy.to)) {
      try { await destination.putFileContents(copy.to, bytes, { overwrite: false }); written = true; }
      catch (err) { if (!isExists(err) && !await destination.exists(copy.to)) throw at(err, writing); }
    }
    const saved = Buffer.from(await destination.getFileContents(copy.to));
    const stat = await destination.stat(copy.to);
    if (Number(stat.size) !== copy.size || saved.length !== copy.size || hash(saved) !== copy.hash) {
      if (!written) throw new Error(`${copy.to} appeared in the new storage during the migration and is not this receipt. Remove it or run ./receipts migrate-storage --cancel. State was not changed.`);
      throw new Error(`Migration verification failed: ${copy.to}. State was not changed; originals remain safe.`);
    }
    copy.etag = stat.etag; copy.verified = true;
    await checkpoint(journal);
  };
  const plan = async () => {
    const taken = new Set(journal.copies.flatMap((c) => [c.to]));
    const planned = new Set(journal.copies.map((c) => c.from));
    for (const file of current.keys()) {
      if (planned.has(file)) continue;
      const isSidecar = file.endsWith('.json') && current.has(file.slice(0, -5));
      if (isSidecar) continue; // planned with its photo
      const group = current.has(`${file}.json`) && !planned.has(`${file}.json`) ? [file, `${file}.json`] : [file];
      const wanted = mapStoragePath(file, from.folders, to.folders);
      let dest = wanted;
      while (taken.has(dest) || taken.has(`${dest}.json`) || await destination.exists(dest) || await destination.exists(`${dest}.json`)) {
        dest = path.join(path.dirname(wanted), `${randomUUID()}-${path.basename(wanted)}`);
      }
      for (const f of group) {
        journal.copies.push({ from: f, to: dest + f.slice(file.length) });
        taken.add(dest + f.slice(file.length)); planned.add(f);
      }
    }
    await checkpoint(journal);
  };
  /** The source moved on: a vanished file loses its entry; a changed one starts again. Either way our earlier copy goes. */
  const reconcile = async () => {
    const drop = new Set();
    for (const copy of journal.copies) {
      const now = current.get(copy.from);
      const photo = !copy.from.endsWith('.json');
      if (!now) drop.add(copy.from);
      else if (photo && copy.verified && !(sameEtag(now.etag, copy.sourceEtag) && now.size === copy.sourceSize)) {
        drop.add(copy.from);
        if (journal.copies.some((c) => c.from === `${copy.from}.json`)) drop.add(`${copy.from}.json`); // the pair gets a new destination together
      }
    }
    for (const copy of journal.copies.filter((c) => drop.has(c.from))) {
      if (copy.hash && !await removeOurs(destination, copy.to, copy.hash, log)) log(`${copy.to}: an earlier copy of ${copy.from} that changed since was kept`);
      if (!current.has(copy.from)) log(`${copy.from} is gone from the old storage; it is not migrated`);
    }
    if (drop.size) { journal.copies = journal.copies.filter((c) => !drop.has(c.from)); await checkpoint(journal); }
  };

  for (let pass = 0; pass < maxPasses; pass++) {
    await reconcile();
    await plan();
    let unsettled = false, photosChanged = false;
    for (const copy of journal.copies.filter((c) => !c.from.endsWith('.json') && !c.verified)) {
      const meta = current.get(copy.from);
      const bytes = await read(copy, meta);
      if (!bytes) { unsettled = true; continue; }
      Object.assign(copy, { sourceEtag: meta.etag, sourceSize: bytes.length, sourceHash: hash(bytes), hash: hash(bytes), size: bytes.length });
      await checkpoint(journal); // the destination and the bytes meant are durable BEFORE the write
      await place(copy, bytes);
      photosChanged = true;
    }
    // Summaries after photos, so their references use every verified destination version. The state's key map comes first.
    const rw = migrationRewriter(from.folders, to.folders, journal.copies);
    rw.state(state);
    for (const copy of journal.copies.filter((c) => c.from.endsWith('.json'))) {
      const meta = current.get(copy.from);
      if (copy.verified && !photosChanged && sameEtag(meta.etag, copy.sourceEtag) && meta.size === copy.sourceSize) continue;
      const bytes = await read(copy, meta);
      if (!bytes) { unsettled = true; continue; }
      let out = bytes;
      try {
        out = Buffer.from(JSON.stringify(rw.sidecar(JSON.parse(bytes.toString('utf8')), copy.from), null, 2));
        journal.damaged = journal.damaged.filter((f) => f !== copy.from);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw named(err, copy.from);
        if (!journal.damaged.includes(copy.from)) { journal.damaged.push(copy.from); log(`${copy.from} is not valid JSON; copied byte for byte, unchanged`); }
      }
      const digest = hash(out);
      if (copy.hash && copy.hash !== digest) {
        // An earlier pass wrote other references: replace our own copy only.
        if (!await removeOurs(destination, copy.to, copy.hash, log)) throw new Error(`${copy.to} changed in the new storage during the migration. Run ./receipts migrate-storage --cancel, check it, and start again. State was not changed.`);
        copy.verified = false;
      }
      Object.assign(copy, { sourceEtag: meta.etag, sourceSize: bytes.length, sourceHash: hash(bytes), hash: digest, size: out.length });
      await checkpoint(journal);
      await place(copy, out);
    }
    const after = await inventory(source, from.folders);
    if (!unsettled && sameInventory(current, after) && journal.copies.every((c) => c.verified)) {
      await checkCoverage(source, state, from, new Set(journal.copies.map((c) => c.from)), log);
      const final = migrationRewriter(from.folders, to.folders, journal.copies);
      journal.state = final.state(state);
      journal.keys = [...final.keys]; // old key => new key, for the dry-run summaries kept under the key
      journal.phase = 'committing';
      await checkpoint(journal);
      return finishCommit(journal, checkpoint, commit);
    }
    current = after;
  }
  throw new Error('Source kept changing during migration. Stop uploads and sync tools, then run ./receipts migrate-storage again. State was not changed.');
}

/** Why a folder change can't be done by moving in place; null when it can. */
export function folderMoveProblem(from, to) {
  const old = Object.fromEntries(FOLDER_KEYS.map((k) => [k, normalizeStoragePath(from[k])]));
  const now = Object.fromEntries(FOLDER_KEYS.map((k) => [k, normalizeStoragePath(to[k])]));
  for (const k of FOLDER_KEYS) {
    if (old[k] === '/' && now[k] !== '/') return `the old ${k} folder is the whole storage, so its files can't be told apart from everything else there`;
    for (const j of FOLDER_KEYS) {
      if (j !== k && old[j] === old[k] && now[j] !== now[k]) return `the old ${k} and ${j} folders were the same folder (${old[k]}), so which files go where can't be told`;
    }
  }
  return null;
}

/** Which old folder a file belongs to (the longest one it is inside) and its path below it. */
function classify(file, folders) {
  const found = Object.entries(folders).map(([k, v]) => [k, normalizeStoragePath(v)]).sort((a, b) => b[1].length - a[1].length).find(([, d]) => inside(file, d));
  return found ? { kind: found[0], rel: file.slice(found[1].length) } : null;
}

const moveOptions = (etag) => (etag ? { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } } : NO_OVERWRITE);
const taken = async (c, p) => (await c.exists(p)) || (await c.exists(`${p}.json`));

/**
 * Remove a folder when no file is left in it: its empty subfolders deepest first, each listed again just before it goes (a
 * Nextcloud folder delete takes everything in it, so one that filled up meanwhile is kept).
 */
async function removeIfEmpty(client, folder, log) {
  if (!folder || !await client.exists(folder).catch(() => false)) return;
  const dirs = [folder];
  const files = [];
  for (let i = 0; i < dirs.length; i++) {
    for (const item of await client.getDirectoryContents(dirs[i])) {
      if (item.type === 'directory') dirs.push(normalizeStoragePath(item.filename)); else files.push(item.filename);
    }
  }
  if (files.length) { log(`${folder} still holds ${files.length} file(s); it was left in place`); return; }
  for (const dir of dirs.reverse()) {
    try {
      if ((await client.getDirectoryContents(dir)).length) { log(`${dir} is no longer empty; it was left in place`); return; }
      await client.deleteFile(dir);
    } catch (err) { log(`could not remove ${dir}: ${err.message}`); return; }
  }
}

/** The old folders a finished move emptied: not a folder of the new settings, nor one that holds one. */
function emptiedFolders(from, to) {
  const now = FOLDER_KEYS.map((k) => normalizeStoragePath(to[k]));
  const inside = (dir, parent) => dir === parent || dir.startsWith(`${parent}/`);
  const old = [...new Set(FOLDER_KEYS.map((k) => normalizeStoragePath(from[k])))].sort((a, b) => b.length - a.length); // deepest first
  return old.filter((dir) => dir !== '/' && !now.some((n) => inside(n, dir)));
}

/** Move mode: the same storage with other folders. client: the storage; the rest as for migrateStorage. */
export async function moveFolders({ client, from, to, state, journal, checkpoint, commit, log = noLog }) {
  if (journal?.phase === 'committing') return finishMove(client, journal, checkpoint, commit, log);
  if (!journal) {
    const problem = folderMoveProblem(from.folders, to.folders);
    if (problem) throw new Error(`The receipt folders can't be moved in place: ${problem}. Nothing was changed. Put the folder settings back as they were, then change them so that folders that were one stay one: give them the same new folder, and ./receipts migrate-storage moves it. Moving the files yourself does not work: state would still name the old places.`);
    await settleClaims(client);
    const files = await inventory(client, from.folders);
    await preview(client, files, state, from.folders, log);
    await checkCoverage(client, state, from, new Set(files.keys()), log);
    const staging = `/${STAGING_PREFIX}${randomUUID().slice(0, 8)}`;
    const moves = [], kept = [];
    for (const [file, meta] of files) {
      const target = mapStoragePath(file, from.folders, to.folders);
      if (target === file) { kept.push({ from: file, to: file, sourceEtag: meta.etag, etag: meta.etag }); continue; }
      const { kind, rel } = classify(file, from.folders);
      moves.push({ from: file, staged: path.join(staging, kind, rel), to: target, sourceEtag: meta.etag, stage: 'planned' });
    }
    journal = { version: 2, mode: 'move', from, to, staging, moves, kept, phase: 'moving' };
    await checkpoint(journal); // recorded BEFORE the first move: the worker stays paused until this finishes or is cancelled
  }
  if (journal.phase === 'moving') {
    for (const m of journal.moves.filter((x) => x.stage === 'planned')) {
      await client.createDirectory(path.dirname(m.staged), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try { await client.moveFile(m.from, m.staged, moveOptions(m.sourceEtag)); m.stage = 'staged'; break; }
        catch (err) {
          const there = await client.exists(m.staged);
          const source = await client.exists(m.from);
          if (there && !source) { m.stage = 'staged'; break; } // moved before, its answer lost
          if (!there && !source) { m.stage = 'vanished'; log(`${m.from} is gone; it is not moved`); break; }
          if (there) throw new Error(`${m.staged} and ${m.from} both exist, so the folder move can't tell which one it moved. Nothing more was moved. Check them, remove the one that is not the receipt, and run ./receipts migrate-storage again to finish the move.`, { cause: err });
          if (statusOf(err) !== 412 || attempt) throw err;
          m.sourceEtag = (await client.stat(m.from)).etag; // changed since it was listed: moved as it is now
        }
      }
      await checkpoint(journal);
    }
    journal.phase = 'placing';
    await checkpoint(journal);
  }
  if (journal.phase === 'placing') {
    const byFrom = new Map(journal.moves.map((m) => [m.from, m]));
    // A photo and its summary are placed together, so a renamed photo keeps its summary beside it.
    const photosFirst = [...journal.moves].sort((a, b) => Number(a.from.endsWith('.json')) - Number(b.from.endsWith('.json')));
    for (const m of photosFirst.filter((x) => x.stage === 'staged')) {
      const pair = !m.from.endsWith('.json') ? byFrom.get(`${m.from}.json`) : null;
      const staged = await client.exists(m.staged);
      if (!staged) {
        if (await client.exists(m.to)) m.stage = 'placed'; // placed before, its answer lost
        else { m.stage = 'vanished'; log(`${m.from} went missing during the move`); }
      } else {
        const isPhoto = !m.from.endsWith('.json');
        if (isPhoto ? await taken(client, m.to) : await client.exists(m.to)) {
          const renamed = path.join(path.dirname(m.to), `${randomUUID()}-${path.basename(m.to)}`);
          m.to = renamed;
          if (pair && pair.stage === 'staged') pair.to = `${renamed}.json`;
          await checkpoint(journal); // the new name is durable BEFORE the move
        }
        await client.createDirectory(path.dirname(m.to), { recursive: true });
        try { await client.moveFile(m.staged, m.to, NO_OVERWRITE); }
        catch (err) {
          if (!(await client.exists(m.to) && !await client.exists(m.staged))) throw new Error(`Could not place ${m.from} at ${m.to} (${err.message}). Run ./receipts migrate-storage again to retry: a folder move that has started only goes forward.`, { cause: err });
        }
        m.stage = 'placed';
      }
      if (m.stage === 'placed') m.etag = (await client.stat(m.to)).etag;
      await checkpoint(journal);
    }
    const copies = [...journal.moves.filter((m) => m.stage === 'placed').map((m) => ({ from: m.from, to: m.to, sourceEtag: m.sourceEtag, etag: m.etag })), ...journal.kept];
    const rw = migrationRewriter(from.folders, to.folders, copies, { lenient: true, warn: log });
    journal.state = rw.state(state);
    journal.keys = [...rw.keys];
    journal.sidecars = copies.filter((c) => c.from.endsWith('.json')).map((c) => ({ from: c.from, path: c.to }));
    journal.phase = 'committing';
    await checkpoint(journal);
  }
  return finishMove(client, journal, checkpoint, commit, log);
}

async function finishMove(client, journal, checkpoint, commit, log) {
  const copies = [...journal.moves.filter((m) => m.stage === 'placed').map((m) => ({ from: m.from, to: m.to, sourceEtag: m.sourceEtag, etag: m.etag })), ...journal.kept];
  const rw = migrationRewriter(journal.from.folders, journal.to.folders, copies, { lenient: true, warn: log, keys: journal.keys });
  for (const sc of journal.sidecars.filter((s) => !s.done)) {
    let bytes;
    try { bytes = Buffer.from(await client.getFileContents(sc.path)); }
    catch (err) { if (missing(err)) { sc.done = true; continue; } throw err; }
    if (sc.target && hash(bytes) === sc.target) { sc.done = true; await checkpoint(journal); continue; } // written before a stop
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { log(`${sc.path} is not valid JSON; it was moved unchanged`); sc.done = true; await checkpoint(journal); continue; }
    const out = Buffer.from(JSON.stringify(rw.sidecar(parsed, sc.from), null, 2));
    if (hash(out) === hash(bytes)) { sc.done = true; await checkpoint(journal); continue; }
    sc.target = hash(out);
    await checkpoint(journal); // the new content's hash is durable BEFORE the write: a resumed run sees it was written
    await client.putFileContents(sc.path, out, { overwrite: true });
    sc.done = true;
    await checkpoint(journal);
  }
  await finishCommit(journal, checkpoint, commit);
  await removeIfEmpty(client, journal.staging, log);
  for (const dir of emptiedFolders(journal.from.folders, journal.to.folders)) await removeIfEmpty(client, dir, (msg) => log(`old receipt folder ${msg}`));
  return journal;
}

/**
 * Undo an unfinished run. Copy: the copies this migration wrote (still its bytes) are deleted; a file there with other bytes is not
 * ours and stays. Move: only goes forward once a file has moved, so it is cancelled only while nothing moved (every entry planned,
 * each still at its old place, the staging folder holding no file); otherwise this throws and the journal stays to finish the move.
 * A committing journal is never cancelled: state may already be the new one. Returns how many copies could not be removed.
 */
export async function cancelMigration({ journal, destination, client, log = noLog }) {
  if (!journal || journal.phase === 'complete') return 0;
  if (journal.phase === 'committing') throw new Error(COMMITTING);
  if (journal.mode === 'move') {
    const why = await moveStarted(client, journal);
    if (why) throw new Error(`The folder move can't be cancelled: ${why}. A folder move that has started only goes forward: set the folder settings to the new folders again (if you changed them back) and run ./receipts migrate-storage to finish it. Nothing was changed.`);
    await removeIfEmpty(client, journal.staging, log);
    return 0;
  }
  let left = 0;
  for (const copy of journal.copies ?? []) {
    try { await removeOurs(destination, copy.to, copy.hash, log); }
    catch (err) { log(`${copy.to} could not be removed: ${err.message}`); left++; }
  }
  return left;
}
export const COMMITTING = 'The migration is being committed and can\'t be cancelled: state may already name the new storage. Run ./receipts migrate-storage again (with the settings naming the new storage) to finish it.';

/** Why a folder move counts as started (a file may have moved), or null when every file is provably still at its old place. */
async function moveStarted(client, journal) {
  if (journal.phase !== 'moving') return 'its files are already in their new folders or on the way';
  const moved = journal.moves.filter((m) => m.stage !== 'planned' && m.stage !== 'vanished');
  if (moved.length) return `${moved.length} file(s) have moved already, for example ${moved[0].from}`;
  if (journal.staging && await client.exists(journal.staging)) {
    const dirs = [journal.staging];
    for (let i = 0; i < dirs.length; i++) {
      for (const item of await client.getDirectoryContents(dirs[i])) {
        if (item.type === 'directory') dirs.push(normalizeStoragePath(item.filename));
        else return `the staging folder ${journal.staging} holds ${normalizeStoragePath(item.filename)}, so a file has moved`;
      }
    }
  }
  for (const m of journal.moves.filter((x) => x.stage === 'planned')) {
    if (!await client.exists(m.from)) return `${m.from} is no longer at its old place`;
  }
  return null;
}
