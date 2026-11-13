// The receipt folders on this machine instead of Nextcloud (STORAGE=local): a stand-in for the part of the `webdav` client the worker
// uses (exists, stat, getDirectoryContents, getFileContents, putFileContents, createDirectory, moveFile, deleteFile), so every helper
// that takes "the client" (filing-transfer.js, requeue.js, archive-files.js, upload.js) works unchanged. The rules those helpers rely on:
//   - paths are WebDAV style (/Inbox/x.jpg) under one root folder; ".." and symbolic links that lead out of it are refused;
//   - errors carry the HTTP status a WebDAV server would answer: 404 not there, 412 a precondition failed (the destination exists with
//     Overwrite: F, or If-Match names another version), 409 the parent folder is missing;
//   - a move or put that must not replace anything never does, also against a file that appears at the same moment: the new name is made
//     with link(2), which fails when the name exists, never by "look, then rename";
//   - the etag is a hash of the file's bytes and its inode number, so a moved or linked file keeps its etag (filing-transfer.js checks
//     the destination has the source's etag after a move), a file written again gets a new one, and a restart changes nothing;
//   - a sync tool or a person may change these folders at any moment. A file is moved or deleted only after it is "claimed": renamed to a
//     hidden name only this client uses (.claim-<id>, beside it), with a record of the move written first (.receipts-claims/<id>.json in the
//     root). Its version is checked on the claimed name, so a file put at the old name meanwhile is never the one removed, and a file
//     changed in place before the move is done goes back to its folder. A move that stopped half way (the worker was stopped) is finished
//     or undone from its record by the next call; nothing else in a folder is ever removed for it;
//   - what is created is private: folders 0700, files 0600 (as everything under /data, see private-files.js).
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';
import crypto from 'node:crypto';
import { TransientError } from './errors.js';
import { log } from './config.js';

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** An error shaped like the webdav package's: `status` is what the callers check. */
const failure = (status, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status, response: { status } });
// A full disk is 507 (Insufficient Storage) and a busy or failing disk 503, as a server would answer: both are >= 500, so errors.js
// counts them as passing troubles and the receipt is tried again later. A name too long for the file system is 414, never retried.
export const STATUS_OF = {
  ENOENT: 404, ENOTDIR: 409, EEXIST: 412, EISDIR: 405, EACCES: 403, EPERM: 403, EROFS: 403,
  ENOSPC: 507, EDQUOT: 507, EIO: 503, EAGAIN: 503, EBUSY: 503, ENAMETOOLONG: 414,
};
/** A file system error as a WebDAV-like one; anything else (an abort, an error that already has a status) is passed on as it is. */
function asDav(err, p) {
  const status = STATUS_OF[err?.code];
  if (!status) throw err;
  throw failure(status, `${p}: ${err.code}`, err);
}
const gone = (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR';

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
/**
 * The etag of a file version: its bytes (sha256) and its inode number. A rename or hard link keeps both; a change of the bytes or a copy
 * gives another. Not the device number: it can change when the folder is mounted again, and every etag the worker kept would change.
 */
const etagFrom = (ino, content) => sha256(`${ino}:${content}`).slice(0, 32);
/** A folder has no bytes to hash: its inode and modification time. */
const folderEtag = (st) => sha256(`folder:${st.ino}:${st.mtimeNs}`).slice(0, 32);
/** The numbers that change whenever the bytes do (ctime even when mtime is set back): a hash is reused only while all are the same. */
const versionOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const unchanged = (a, b) => versionOf(a) === versionOf(b);
// Hashes of file contents by version: a listing of a big folder reads each file once per run of the worker, not on every check.
const HASHES_MAX = 50000;
const hashes = new Map();
/** Changed less than this long ago: a write in the same clock tick could leave the numbers above as they were, so it is not cached. */
const SETTLED_NS = 2000000000n;
function remember(st, content) {
  if (BigInt(Date.now()) * 1000000n - st.ctimeNs < SETTLED_NS) return;
  const key = versionOf(st);
  hashes.delete(key);
  hashes.set(key, content);
  if (hashes.size > HASHES_MAX) hashes.delete(hashes.keys().next().value); // the oldest entry
}
// The etags of files this process wrote whole (putFileContents): nobody is still writing them, see wroteWhole.
const WRITTEN_MAX = 10000;
const written = new Set();
/**
 * Did this process write the file with this etag in one piece (an upload from the status page)? Then the inbox needn't wait for it to
 * settle (nextcloud.js listInbox). A move keeps the etag, so the upload's temporary file moved into the inbox counts.
 */
export const wroteWhole = (etag) => written.has(String(etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, ''));

/** A file in a local inbox untouched for this long is whole: no copy pauses that long. */
export const SETTLE_MS = 30 * 1000;
/**
 * With a local receipt folder anything can write into the inbox, and a file being copied in shows up before it is whole (Nextcloud
 * only lists finished uploads). A local file counts only once it is settled: one version (etag) seen unchanged for SETTLE_MS, or not
 * changed for SETTLE_MS by its own time, or written whole by this worker (an upload from the status page, read at once). Two listings
 * a moment apart are not enough: a copy can pause between them. `seen` is what the previous listing kept by path ({ etag, since: when
 * that version was first seen }); returns the files to read and what to keep for the next listing.
 */
export function settledOnly(items, seen, now = Date.now(), whole = wroteWhole) {
  const next = new Map(items.map((i) => {
    const before = seen.get(i.filename);
    return [i.filename, { etag: i.etag, since: before?.etag === i.etag ? before.since : now }];
  }));
  const ready = items.filter((i) => whole(i.etag) || now - next.get(i.filename).since >= SETTLE_MS || now - Date.parse(i.lastmod) >= SETTLE_MS);
  return { ready, next };
}

// Files that could not be read for a listing, logged once each (per process) so a poll every minute doesn't repeat it.
const UNREADABLE_MAX = 1000;
const unreadable = new Set();
function unreadableOnce(p, err) {
  const key = `${p}:${err.code}`;
  if (unreadable.has(key)) return;
  unreadable.add(key);
  if (unreadable.size > UNREADABLE_MAX) unreadable.delete(unreadable.values().next().value);
  log(`can't read ${p} (${err.code}); it is listed, but not read or moved until it can be read`);
}

/** The same file (not just the same version): device and inode of two fresh stats. */
const sameFile = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
const lstatOrNull = (abs) => fs.lstat(abs, { bigint: true }).catch((err) => {
  if (gone(err)) return null;
  throw err;
});
const linkUnavailable = (err) => ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(err?.code);
async function syncPath(abs) {
  const fh = await fs.open(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  try { await fh.sync(); } finally { await fh.close(); }
}
const syncParent = (abs) => syncPath(path.dirname(abs));

/** The temporary names this client writes beside a file (see tempBeside): a dot, part of the name, a random id, ".tmp". */
const TEMP_NAME = /^\..*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** At most this many bytes of the file's name in its temporary name: with the dot, the id and ".tmp" it stays within 255 bytes. */
const TEMP_NAME_BYTES = 200;
/** A claimed file (see claim), and the root folder of the claim records. Both are left out of every listing. */
const CLAIM_NAME = /^\.claim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIMS = '.receipts-claims';
// The tool's own names at the top of the storage, never listed: claim records, the storage marker, a folder move's staging folder and
// the same-storage probe (see migrate-storage.js).
const ROOT_OWN = /^\.receipts-(claims|storage-id|move-.+|probe-.+)$/;
const RECORD_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
// The status page shares the worker process. Check and replay are separate processes, each with its own owner id.
const OWNER = crypto.randomUUID();
/** Claims in progress in this process: never undone by a recovery running at the same moment. */
const active = new Set();
/** Another process's record younger than this may still be in progress: it is left alone. No move takes that long. */
const FOREIGN_AFTER_MS = 60 * 1000;
/** How often a client looks for records of moves that stopped half way (it also looks before its first call). */
const RECOVER_EVERY_MS = 10 * 1000;

/** The first `max` bytes of `name` in UTF-8, never cutting a character in two. */
export function firstBytes(name, max) {
  let out = '';
  let bytes = 0;
  for (const ch of name) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
}
/** The etag the caller asked for in an If-Match header ({} or a missing header: no condition). Quotes and W/ don't count. */
const wantedEtag = (options) => {
  const h = options?.headers ?? {};
  const raw = h['If-Match'] ?? h['if-match'];
  return raw ? String(raw).replace(/^W\//, '').replace(/^"|"$/g, '') : null;
};
const noOverwrite = (options) => options?.overwrite === false || /^f$/i.test(String(options?.headers?.Overwrite ?? options?.headers?.overwrite ?? ''));
const abortError = (signal) => signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
const checkSignal = (signal) => {
  if (signal?.aborted) throw abortError(signal);
};
/**
 * Run `work` but answer as soon as `signal` aborts, as a WebDAV request would: the caller is not kept waiting on a slow disk. What was
 * started still ends on its own (a claimed file is put back or the move finished; see moveFile), as a server finishes a request.
 */
function bounded(signal, work) {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const CHUNK = 1024 * 1024;
/** The sha256 of an open file's bytes, read in pieces (an abort stops it between two). With the fstat before and after the read. */
async function hashOpen(fh, signal, before) {
  const cached = hashes.get(versionOf(before));
  if (cached) return { content: cached, after: before };
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; ;) {
    checkSignal(signal);
    const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
    if (!bytesRead) break;
    h.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  const content = h.digest('hex');
  const after = await fh.stat({ bigint: true });
  if (unchanged(before, after)) remember(after, content); // read while it was being written: not kept, the next look reads it again
  return { content, after };
}

/** The listing entry for a path, shaped like webdav's (lastmod as an HTTP date, as Nextcloud sends it). */
const entry = (p, st, etag) => ({
  filename: p,
  basename: posix.basename(p),
  lastmod: new Date(Number(st.mtimeNs / 1000000n)).toUTCString(),
  size: st.isDirectory() ? 0 : Number(st.size),
  type: st.isDirectory() ? 'directory' : 'file',
  etag,
});

/**
 * A client for the receipt folders under `root` (an existing folder). Each method takes the same arguments as the webdav client's;
 * the options it does not need are ignored. A `signal` makes it answer (reject) as soon as it aborts. `localFiles` tells a helper it
 * may ask for what only this client does (If-Match on a delete; archive-files.js), without changing what it asks Nextcloud.
 */
export function localClient(root) {
  /** The real root, checked on every call: a missing one (the folder not mounted) is an outage, not a missing receipt. */
  async function realRoot() {
    try {
      const real = await fs.realpath(root);
      if ((await fs.stat(real)).isDirectory()) return real;
    } catch { /* below */ }
    const err = new TransientError(`The receipt folder ${root} is not there (is RECEIPTS_DIR mounted?)`);
    err.service = 'files';
    throw err;
  }

  /** A WebDAV path ("/Inbox/x.jpg") as { p, abs } under the root. Refuses ".." and anything that resolves outside the root. */
  async function resolve(p) {
    const text = String(p ?? '');
    if (text.includes('\0')) throw failure(400, 'a path can\'t contain a NUL character');
    const parts = text.split('/').filter((x) => x && x !== '.');
    if (parts.includes('..')) throw failure(403, `${text}: ".." is not allowed`);
    if (parts[0] === CLAIMS) throw failure(403, `${text}: that folder is the worker's own`);
    const base = await realRoot();
    const abs = path.join(base, ...parts);
    // The deepest part of the path that exists, with its symbolic links followed, must still be inside the root.
    for (let at = abs; ; at = path.dirname(at)) {
      let real;
      try {
        real = await fs.realpath(at);
      } catch (err) {
        if (gone(err) && at !== base) continue;
        return asDav(err, text);
      }
      if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw failure(403, `${text} leads outside the receipt folder`);
      break;
    }
    return { p: `/${parts.join('/')}`, abs };
  }

  /**
   * What is at `abs` now: { st, etag } from one open file, so the etag and the numbers belong to the same file even when the name is
   * replaced meanwhile. Throws the fs error (the caller maps it).
   */
  async function look(abs, signal) {
    const fh = await fs.open(abs, constants.O_RDONLY | constants.O_NONBLOCK); // O_NONBLOCK: a pipe put there doesn't hang the call
    try {
      const st = await fh.stat({ bigint: true });
      if (st.isDirectory()) return { st, etag: folderEtag(st) };
      if (!st.isFile()) return { st, etag: folderEtag(st) }; // a device or pipe: no bytes are read from it
      const { content } = await hashOpen(fh, signal, st);
      return { st, content, etag: etagFrom(st.ino, content) };
    } finally {
      await fh.close();
    }
  }
  const etagAt = async (abs, signal) => (await look(abs, signal)).etag;

  // ---- claims: see the comment at the top. A record is written before the rename, so a stop at any point leaves something to go by.
  let claimsDir = null;
  const recordsDir = async () => (claimsDir ??= path.join(await realRoot(), CLAIMS));
  const recordPath = async (id) => path.join(await recordsDir(), `${id}.json`);
  async function writeRecord(rec) {
    const dir = await recordsDir();
    await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
    const file = path.join(dir, `${rec.id}.json`);
    const tmp = tempBeside(file);
    try {
      await fs.writeFile(tmp, JSON.stringify(rec), { mode: PRIVATE_FILE, flag: 'wx' });
      await syncPath(tmp);
      await syncParent(dir);
      await fs.rename(tmp, file);
      await syncPath(dir);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
  const dropRecord = async (id) => {
    await fs.rm(await recordPath(id), { force: true });
    await syncPath(await recordsDir());
  };
  const claimAlert = (id, file, reason) => log(`unsettled local claim ${id}, file ${file}: ${reason}`);

  // Exclusive creation cannot replace a concurrent upload. Verify both versions before deleting the source.
  // Copies change the inode and etag, so use this only for restoration and new uploads, never a successful MOVE.
  async function linkOrCopy(src, dest) {
    await syncPath(src);
    try {
      await fs.link(src, dest);
    } catch (err) {
      if (!linkUnavailable(err)) throw err;
      const before = await look(src);
      await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
      const copied = await look(dest);
      await syncPath(dest);
      const after = await look(src);
      const verified = await look(dest);
      if (before.etag !== after.etag || before.content !== copied.content || copied.etag !== verified.etag || !sameFile(await lstatOrNull(dest), copied.st)) {
        await unlinkIfSame(dest, copied.st);
        throw new Error(`exclusive copy could not be verified at ${dest}; source kept`);
      }
    }
    await syncParent(dest);
  }

  /**
   * Take the file at `src` away from its folder before anything is checked or changed: rename it to .claim-<id> beside it. From then on
   * a new file at the old name is somebody else's and is never touched. `to`: where it is going (null for a delete); `etag`: the version
   * meant, when known. Returns the claim { id, abs, fromAbs, rec }.
   */
  async function claim(src, to, etag) {
    const id = crypto.randomUUID();
    const name = `.claim-${id}`;
    const rec = { id, owner: OWNER, at: Date.now(), from: src.p, claim: posix.join(posix.dirname(src.p), name), to: to ?? null, etag: etag ?? null };
    active.add(id);
    try {
      await writeRecord(rec);
      try {
        await syncPath(src.abs);
        await syncParent(src.abs);
        await fs.rename(src.abs, path.join(path.dirname(src.abs), name));
      } catch (err) {
        await dropRecord(id).catch(() => {});
        throw err;
      }
    } catch (err) {
      active.delete(id);
      throw err;
    }
    try { await syncParent(src.abs); } catch (err) {
      active.delete(id);
      claimAlert(id, src.p, `claim rename could not be synced (${err.code ?? err.message})`);
      throw err;
    }
    return { id, abs: path.join(path.dirname(src.abs), name), fromAbs: src.abs, rec };
  }
  /** The claimed file is where it should be now (moved, or deleted): drop the claimed name and the record. */
  async function commit(cl) {
    await fs.unlink(cl.abs).catch((err) => { if (!gone(err)) throw err; });
    await syncParent(cl.abs);
    await dropRecord(cl.id);
    active.delete(cl.id);
  }
  /**
   * Put a claimed file back in its folder: at its own name, or, when a new file took that name meanwhile, beside it with a time stamp in
   * front (as moveKeepingBoth names a second file). Neither file is lost. Returns the path it is at.
   */
  async function restore(cl) {
    const dir = path.dirname(cl.fromAbs);
    const name = path.basename(cl.fromAbs);
    const names = [name, `${Date.now()}-${name}`, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${name}`];
    let at = null;
    for (const n of names) {
      try {
        await linkOrCopy(cl.abs, path.join(dir, n));
        at = path.join(dir, n);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST' || n === names.at(-1)) throw err; // the record stays: the next recovery tries again
      }
    }
    await commit(cl);
    return at;
  }
  /** Remove the name `abs` only while it is this very file (a move linked it there). */
  async function unlinkIfSame(abs, st) {
    if (sameFile(await lstatOrNull(abs), st)) await fs.unlink(abs).catch(() => {});
  }
  /** Undo a claim when something failed; when even that fails, the record is kept and the next recovery tries again. */
  const putBack = (cl) => restore(cl).catch((err) => {
    active.delete(cl.id);
    claimAlert(cl.id, cl.rec.from, `restore failed (${err.code ?? err.message}); hidden file ${cl.rec.claim} and record kept`);
  });

  /**
   * Finish or undo one recorded move or delete that stopped half way. The claimed file is at the destination too and still the version
   * the record names: the move is finished (the claimed name goes). Otherwise the destination name made by this move goes and the file
   * is put back where it came from. Not claimed at all (stopped before the rename, or already done): only the record goes.
   * Returns 'finished' (done, or nothing left to do) or 'undone' (put back).
   */
  async function settle(rec) {
    const cl = { id: rec.id, abs: (await resolveInside(rec.claim)).abs, fromAbs: (await resolveInside(rec.from)).abs, rec };
    const st = await lstatOrNull(cl.abs);
    if (!st) {
      await dropRecord(rec.id);
      return 'finished';
    }
    const current = st.isFile() ? await etagAt(cl.abs).catch(() => null) : null;
    const meant = Boolean(rec.etag) && current === rec.etag;
    if (rec.to) {
      const to = (await resolveInside(rec.to)).abs;
      if (sameFile(await lstatOrNull(to), st)) {
        if (meant) {
          await syncPath(cl.abs);
          await syncParent(to);
          return commit(cl).then(() => 'finished');
        }
        await fs.unlink(to);
      }
    } else if (meant) {
      return commit(cl).then(() => 'finished'); // a delete of the version asked for
    }
    await restore(cl);
    return 'undone';
  }
  /** A path from a record: inside the root (records are written by this client, but a damaged one must not lead elsewhere). */
  async function resolveInside(p) {
    const parts = String(p ?? '').split('/').filter((x) => x && x !== '.');
    if (!parts.length || parts.includes('..') || parts[0] === CLAIMS) throw new Error(`bad path in a claim record: ${p}`);
    return { abs: path.join(await realRoot(), ...parts) };
  }

  let recoveredAt = 0;
  /**
   * Settle the records of moves and deletes that stopped half way (before the first call, then at most every few seconds). Returns how
   * many. `all`: every record, however young and whoever wrote it, for when no other process can be in the middle of one (a migration
   * with the worker and the status page stopped); returns { finished, undone, remaining }, remaining > 0 when some could not be settled
   * (unreadable, or settling failed): those records stay.
   */
  async function recover(force = false, all = false, details = false) {
    const now = Date.now();
    const counts = { finished: 0, undone: 0, remaining: 0 };
    const claims = [];
    if (details) counts.claims = claims;
    const unsettled = (id, file, reason) => {
      counts.remaining++;
      claims.push({ id, file, reason });
      claimAlert(id, file, reason);
    };
    if (!force && now - recoveredAt < RECOVER_EVERY_MS) return 0;
    recoveredAt = now;
    let names;
    try {
      names = await fs.readdir(await recordsDir());
    } catch (err) {
      if (all && !gone(err)) return asDav(err, `/${CLAIMS}`); // not "nothing to settle": it could not be looked at
      if (!gone(err)) claimAlert('unknown', `/${CLAIMS}`, err.code ?? err.message);
      return all ? counts : 0; // no records folder: nothing ever stopped half way
    }
    for (const n of names) {
      const id = RECORD_NAME.exec(n)?.[1];
      if (!id) continue;
      if (active.has(id)) {
        if (all) unsettled(id, `/${CLAIMS}/${n}`, 'in progress in this process');
        continue;
      }
      let rec;
      try {
        rec = JSON.parse(await fs.readFile(path.join(await recordsDir(), n), 'utf8'));
      } catch (err) {
        if (!gone(err)) unsettled(id, `/${CLAIMS}/${n}`, `record cannot be read (${err.code ?? err.message})`);
        continue; // unreadable: left for a person, nothing is guessed
      }
      if (rec?.id !== id) {
        unsettled(id, rec?.from ?? `/${CLAIMS}/${n}`, 'record id does not match its filename');
        continue;
      }
      if (!all && rec.owner !== OWNER && now - Number(rec.at) < FOREIGN_AFTER_MS) {
        claimAlert(id, rec.from, 'waiting for the other process or its claim timeout');
        continue;
      }
      try {
        counts[await settle(rec)]++;
      } catch (err) {
        unsettled(id, rec.from, `recovery failed (${err.code ?? err.message}); hidden file ${rec.claim} and record kept`);
      }
    }
    return all ? counts : counts.finished + counts.undone;
  }

  const statOf = async (abs, p) => {
    try {
      return await fs.stat(abs, { bigint: true });
    } catch (err) {
      return asDav(err, p);
    }
  };
  /** A hidden temporary name beside `abs` (the inbox listing skips names starting with a dot and ending in .tmp). */
  const tempBeside = (abs) => path.join(path.dirname(abs), `.${firstBytes(path.basename(abs), TEMP_NAME_BYTES)}.${crypto.randomUUID()}.tmp`);

  /**
   * Claim the file at `from` and check it: a file (not a folder), with the etag If-Match names. Returns { cl, st, version }; on a
   * mismatch the file is put back first. `to` as for claim.
   */
  async function claimChecked(src, from, to, want, signal) {
    const st = await statOf(src.abs, from);
    if (st.isDirectory()) throw failure(403, `${from} is a folder; only files are moved or deleted this way`);
    await recover();
    let cl;
    try {
      cl = await claim(src, to, want);
    } catch (err) {
      return asDav(err, from);
    }
    try {
      const cst = await fs.lstat(cl.abs, { bigint: true });
      if (!cst.isFile()) throw failure(403, `${from} is not a file`); // a folder or link put at the name since the look above
      const version = await etagAt(cl.abs, signal);
      if (want && version !== want) throw failure(412, `${from} is not the version asked for (If-Match)`);
      if (!want) await writeRecord({ ...cl.rec, etag: version }); // the version a recovery may finish moving
      checkSignal(signal);
      return { cl, st: cst, version };
    } catch (err) {
      await putBack(cl);
      if (err.status) throw err;
      return asDav(err, from);
    }
  }

  // ensureFolders on a live worker and the first inbox listing in dry run both check the storage before processing receipts.
  let writableCheck = null;
  const checkStorage = () => (writableCheck ??= realRoot().then(checkWritable).catch((err) => {
    writableCheck = null;
    throw err;
  }));

  const client = {
    localFiles: true,
    /**
     * Settle what moves and deletes that stopped half way left (records older than a minute from another process too); returns how many.
     * { all: true }: every record, also young ones and other processes' (only while no other process uses the folder, e.g. for a
     * migration); returns { finished, undone, remaining }. Add details: true for claims: [{ id, file, reason }] naming unsettled files.
     */
    recoverClaims: (options) => recover(true, options?.all === true, options?.details === true),

    async exists(p, options) {
      return bounded(options?.signal, async () => {
        const { abs } = await resolve(p);
        try {
          await fs.stat(abs);
          return true;
        } catch (err) {
          if (gone(err)) return false;
          return asDav(err, p);
        }
      });
    },

    async stat(p, options) {
      return bounded(options?.signal, async () => {
        const r = await resolve(p);
        try {
          const { st, etag } = await look(r.abs, options?.signal);
          return entry(r.p, st, etag);
        } catch (err) {
          return asDav(err, p);
        }
      });
    },

    /**
     * The folder's files and folders (not the folder itself, not deeper). Symbolic links, other special files and claims are left out.
     * Only this client: `etags` false lists without reading any file (etag null), a function (basename => boolean) reads only the files
     * it picks; working out an etag reads the whole file, once per version. A file that can't be read (no permission, a disk error) is
     * listed with etag null and `unreadable: true` (and logged once), so one such file never fails the listing of its folder.
     */
    async getDirectoryContents(dir, options) {
      const signal = options?.signal;
      const hashed = typeof options?.etags === 'function' ? options.etags : () => options?.etags !== false;
      return bounded(signal, async () => {
        const r = await resolve(dir);
        await checkStorage();
        await recover(); // a file a stopped move left claimed is back (or at its new place) before anyone looks for it
        let names;
        try {
          names = await fs.readdir(r.abs, { withFileTypes: true });
        } catch (err) {
          return asDav(err, dir);
        }
        const out = [];
        for (const d of names) {
          if (!d.isFile() && !d.isDirectory()) continue;
          if (CLAIM_NAME.test(d.name) || (r.p === '/' && ROOT_OWN.test(d.name))) continue;
          checkSignal(signal);
          const p = posix.join(r.p, d.name);
          const abs = path.join(r.abs, d.name);
          if (d.isFile() && !hashed(d.name)) {
            const st = await lstatOrNull(abs);
            if (st?.isFile()) out.push(entry(p, st, null));
            continue;
          }
          try {
            const { st, etag } = await look(abs, signal);
            if (st.isFile() || st.isDirectory()) out.push(entry(p, st, etag));
          } catch (err) {
            if (gone(err)) continue; // gone since the readdir: not there, as a listing a moment later would say
            if (!STATUS_OF[err?.code]) throw err; // an abort
            // Not "no file", but not a reason to hide the rest of the folder either: listed without a version, never read or moved by one.
            const st = await lstatOrNull(abs);
            if (!st?.isFile() && !st?.isDirectory()) continue;
            unreadableOnce(p, err);
            out.push({ ...entry(p, st, null), unreadable: true });
          }
        }
        return out;
      });
    },

    /**
     * The bytes (a Buffer), or the text with { format: 'text' }. With If-Match only while the file has that etag (else 412): the etag
     * is worked out from the very bytes returned, and a file that changed while it was read (being written) is 412 too.
     */
    async getFileContents(p, options = {}) {
      const signal = options.signal;
      return bounded(signal, async () => {
        const { abs } = await resolve(p);
        let fh;
        try {
          fh = await fs.open(abs, constants.O_RDONLY);
        } catch (err) {
          return asDav(err, p);
        }
        try {
          const before = await fh.stat({ bigint: true });
          if (before.isDirectory()) throw failure(405, `${p} is a folder`);
          const want = wantedEtag(options);
          const known = hashes.get(versionOf(before));
          if (want && known && etagFrom(before.ino, known) !== want) throw failure(412, `${p} is not the version asked for (If-Match)`);
          let data;
          try {
            data = await fh.readFile({ signal });
          } catch (err) {
            return asDav(err, p); // EIO: 503, tried again later
          }
          if (want) {
            const after = await fh.stat({ bigint: true });
            if (!unchanged(before, after) || data.length !== Number(after.size)) throw failure(412, `${p} changed while it was read`);
            const content = sha256(data);
            if (etagFrom(after.ino, content) !== want) throw failure(412, `${p} is not the version asked for (If-Match)`);
            remember(after, content);
          }
          return options.format === 'text' ? data.toString('utf8') : data;
        } catch (err) {
          if (err.status) throw err;
          return asDav(err, p);
        } finally {
          await fh.close();
        }
      });
    },

    /**
     * Write a whole file. It is written under a temporary name first, so nobody ever sees half a file. overwrite (the default) then
     * renames it over the old one; overwrite: false links it to the name, which fails (412) when the name exists, then drops the temporary name.
     */
    async putFileContents(p, data, options = {}) {
      return bounded(options.signal, async () => {
        const { abs } = await resolve(p);
        const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
        const tmp = tempBeside(abs);
        let fh;
        try {
          fh = await fs.open(tmp, 'wx', PRIVATE_FILE);
        } catch (err) {
          if (err.code === 'ENOENT') throw failure(409, `${p}: its folder is not there`, err); // as WebDAV answers a PUT into a missing folder
          return asDav(err, p);
        }
        try {
          let mine;
          try {
            await fh.writeFile(bytes);
            await fh.sync();
            mine = await fh.stat({ bigint: true });
            if (options.overwrite === false) await linkOrCopy(tmp, abs);
            else await fs.rename(tmp, abs);
            await syncParent(abs);
          } catch (err) {
            await fs.rm(tmp, { force: true });
            return asDav(err, p);
          }
          if (options.overwrite === false) await fs.rm(tmp, { force: true });
          // Nobody wrote to it since (same size and time): its bytes are the ones written, in one piece.
          const now = await fh.stat({ bigint: true });
          if (now.size === mine.size && now.mtimeNs === mine.mtimeNs) {
            written.add(etagFrom(now.ino, sha256(bytes)));
            if (written.size > WRITTEN_MAX) written.delete(written.values().next().value);
          }
          return true;
        } finally {
          await fh.close();
        }
      });
    },

    /** A folder (0700); { recursive: true } also makes the missing parents and is fine when it exists. Without it, an existing folder is 405. */
    async createDirectory(p, options = {}) {
      return bounded(options.signal, async () => {
        await checkStorage();
        const { abs } = await resolve(p);
        try {
          await fs.mkdir(abs, { recursive: Boolean(options.recursive), mode: PRIVATE_DIR });
          const base = await realRoot();
          for (let dir = abs; dir === base || dir.startsWith(`${base}${path.sep}`); dir = path.dirname(dir)) await syncPath(dir);
        } catch (err) {
          if (err.code === 'EEXIST') throw failure(405, `${p} already exists`, err);
          return asDav(err, p);
        }
      });
    },

    /**
     * Move a file. It is claimed first (see claim), its version checked (If-Match, else 412) on the claimed name. Without overwrite
     * (overwrite: false, or the header Overwrite: F) a taken destination is 412 and the file goes back: it is hard-linked to the new name
     * (link(2) never replaces a name). It is checked once more there; changed in place meanwhile, the new name goes and the file is put
     * back (412). Only then is the claimed name dropped. With overwrite, a rename (which replaces). The same file already at `to` (left
     * by an older version of this client that stopped half way) only loses its old name.
     */
    async moveFile(from, to, options = {}) {
      const signal = options.signal;
      return bounded(signal, async () => {
        const src = await resolve(from);
        const dest = await resolve(to);
        if (src.abs === dest.abs) throw failure(403, `${from} can't be moved onto itself`);
        const { cl, st, version } = await claimChecked(src, from, dest.p, wantedEtag(options), signal);
        try {
          if (sameFile(await lstatOrNull(dest.abs), st)) {
            await syncPath(cl.abs);
            await syncParent(dest.abs);
            return await commit(cl);
          }
          await syncPath(cl.abs);
          if (!noOverwrite(options)) {
            await fs.rename(cl.abs, dest.abs);
            await syncParent(dest.abs);
            await syncParent(cl.abs);
            await dropRecord(cl.id).catch(() => {});
            active.delete(cl.id);
            return undefined;
          }
          try { await fs.link(cl.abs, dest.abs); } catch (err) {
            if (linkUnavailable(err)) throw failure(503, `${to}: hard links are unavailable (${err.code}); use a receipt filesystem with hard-link support`, err);
            throw err;
          }
          await syncParent(dest.abs);
          if ((await etagAt(cl.abs, signal).catch(() => null)) !== version) {
            await unlinkIfSame(dest.abs, st);
            throw failure(412, `${from} changed while it was moved; it was put back`);
          }
          return await commit(cl);
        } catch (err) {
          if (active.has(cl.id)) await putBack(cl);
          if (err.status) throw err;
          // A missing destination folder is 409, as WebDAV answers.
          if (err.code === 'ENOENT') throw failure(409, `${to}: its folder is not there`, err);
          return asDav(err, to);
        }
      });
    },

    /**
     * Delete a file (a folder only when it is empty; the worker never deletes folders). With If-Match the file is claimed first and
     * deleted only when it is that version (else it is put back, 412): a file put at the name meanwhile is never the one deleted.
     */
    async deleteFile(p, options = {}) {
      const signal = options?.signal;
      return bounded(signal, async () => {
        const r = await resolve(p);
        if (r.p === '/') throw failure(403, 'the receipt folder itself can\'t be deleted');
        const want = wantedEtag(options);
        if (want) {
          const { cl } = await claimChecked(r, p, null, want, signal);
          try {
            return await commit(cl);
          } catch (err) {
            if (active.has(cl.id)) await putBack(cl);
            return asDav(err, p);
          }
        }
        try {
          const st = await fs.lstat(r.abs);
          if (st.isDirectory()) await fs.rmdir(r.abs);
          else await fs.unlink(r.abs);
        } catch (err) {
          return asDav(err, p);
        }
        return undefined;
      });
    },
  };
  return client;
}

/** Is the folder writable and does it support hard links? Creates and removes hidden probe names. Throws with a plain message otherwise. */
export async function checkWritable(dir) {
  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    throw new Error(`${dir} is not there`);
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  const probe = path.join(dir, `.write-test-${crypto.randomUUID()}`);
  const linked = `${probe}-link`;
  try {
    await fs.writeFile(probe, '', { mode: PRIVATE_FILE, flag: 'wx' });
    try { await fs.link(probe, linked); } catch (err) {
      throw new Error(`hard links are unavailable in ${dir} (${err.code ?? err.message}); local receipt storage requires hard-link support (FAT/exFAT is unsupported)`, { cause: err });
    }
  } catch (err) {
    if (err.cause) throw err;
    // With STORAGE=local the worker runs as RECEIPTS_UID (set by setup to the folder's owner), so this names whose folder it must be.
    throw new Error(`can't write in ${dir} (${err.code ?? err.message}); the worker runs as user id ${process.getuid?.() ?? '?'} (RECEIPTS_UID)`);
  } finally {
    await fs.rm(linked, { force: true });
    await fs.rm(probe, { force: true });
  }
}

/** How old a temporary file must be before the sweep removes it: no write takes that long. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove the temporary files writes that stopped half way left behind (".<name>.<id>.tmp", over an hour old) in the folder `dir` and the
 * folders in it, a few levels deep (the archive's month folders too). Symbolic links are not followed. Returns how many were removed.
 */
export async function sweepTemps(dir, now = Date.now(), maxAgeMs = TEMP_MAX_AGE_MS, depth = 4) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // gone, or not readable: nothing to clear there
  }
  let removed = 0;
  for (const d of entries) {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (depth > 0) removed += await sweepTemps(abs, now, maxAgeMs, depth - 1);
    } else if (d.isFile() && TEMP_NAME.test(d.name)) {
      const st = await fs.stat(abs).catch(() => null);
      if (st && now - st.mtimeMs > maxAgeMs && (await fs.rm(abs).then(() => true, () => false))) removed++;
    }
  }
  return removed;
}
