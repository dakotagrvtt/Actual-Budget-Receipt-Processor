// The Nextcloud side of archiving and restoring, with the WebDAV client passed in (so tests can use a stand-in). The rule that
// shapes it: a photo is never lost. A shrunk copy is uploaded, checked and its summary written BEFORE the original is deleted,
// and anything that goes wrong on the way falls back to a plain move of the original. The second rule: nothing already in a folder is
// replaced. A name counts as taken when either the file or its .json exists (a summary can sit there without a photo), and a
// summary is written with overwrite:false whenever it goes to a new place.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { log } from './config.js';
import { SHRINKABLE } from './image.js';
import { NO_OVERWRITE, ifMatch, isExists, moveKeepingBoth } from './requeue.js';

/** A shrunk copy is kept only when it is at most this share of the original's size (at least 10% smaller). */
export const KEEP_IF_UNDER = 0.9;

/** Is this name taken in its folder: the file, or a summary without a file? */
export const isTaken = async (c, p) => (await c.exists(p)) || (await c.exists(`${p}.json`));

const stamped = (dir, name) => path.join(dir, `${Date.now()}-${name}`);
const noExt = (name) => name.slice(0, name.length - path.extname(name).length);
const text = (v) => JSON.stringify(v, null, 2);

/**
 * A free path for `name` in `dir`: the plain name, else one with a time stamp in front. Never a name whose file or .json exists.
 */
async function freePath(c, dir, name) {
  const first = path.join(dir, name);
  if (!(await isTaken(c, first))) return first;
  const second = stamped(dir, name);
  if (!(await isTaken(c, second))) return second;
  throw new Error(`no free name for ${name} in ${dir}`);
}

/**
 * Put the summary next to a file that is now at `to`. `summary` is an object (written; never over an existing .json when the file is
 * new there), or null when the old summary could not be read: then the old .json is carried over as it is (a damaged file is kept,
 * not replaced), or a minimal one is written when there is none. `overwrite` only for rewriting a summary in place.
 */
async function putSummary(c, { from, to, summary, extra, overwrite }) {
  if (summary && typeof summary === 'object') {
    await c.putFileContents(`${to}.json`, text({ ...summary, ...extra }), { overwrite });
    return;
  }
  if (from && (await c.exists(`${from}.json`))) {
    const raw = await c.getFileContents(`${from}.json`, { format: 'text' });
    await c.putFileContents(`${to}.json`, typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'), { overwrite });
    return;
  }
  await c.putFileContents(`${to}.json`, text({ file: path.basename(to), ...extra }), { overwrite });
}

/**
 * Move a filed receipt to `dest` (never replacing anything: a taken name, photo or summary, gets a time stamp in front) and put `summary`
 * next to it as its .json; the old .json goes. With dest === from the file stays and only the summary is rewritten. `summary` null keeps the
 * old .json unchanged (it moves along). Returns the path it ended up at. A file that is not at `from` throws with status 404. If only the
 * new .json could not be written (after one more try) it throws with `movedTo` (where the file is now) and leaves the old .json alone.
 * (nextcloud.js refile passes its own client.)
 */
export async function refileWith(c, from, dest, summary) {
  if (!(await c.exists(from))) throw Object.assign(new Error(`${from} is not there`), { status: 404 });
  let at = from;
  if (dest !== from) {
    const other = stamped(path.dirname(dest), path.basename(dest));
    at = await moveKeepingBoth(c, from, (await isTaken(c, dest)) ? other : dest, other);
  }
  const inPlace = at === from;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (summary === null && inPlace) return at;
      if (summary === null) {
        if (await c.exists(`${from}.json`)) await c.moveFile(`${from}.json`, `${at}.json`, NO_OVERWRITE);
      } else {
        await putSummary(c, { from, to: at, summary, extra: {}, overwrite: inPlace });
      }
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    // The old summary stays (it is the only one); the caller learns where the file is now.
    log(`  moved to ${at}, but could not write ${path.basename(at)}.json: ${lastErr.message}`);
    throw Object.assign(new Error(`${path.basename(at)}.json could not be written: ${lastErr.message}`), { movedTo: at });
  }
  if (!inPlace && summary !== null) await c.deleteFile(`${from}.json`).catch(() => {});
  return at;
}

const ensureDir = async (c, dir) => {
  if (!(await c.exists(dir))) await c.createDirectory(dir, { recursive: true });
};
const withoutArchived = (summary) => {
  if (!summary || typeof summary !== 'object') return null;
  const { archived: _gone, ...rest } = summary;
  return rest;
};

/** Upload new bytes under `name` in `dir` (a free name, never replacing a file or leaving a stray .json's name). Returns the path. */
async function putNew(c, dir, name, data) {
  for (const dest of [path.join(dir, name), stamped(dir, name)]) {
    if (await isTaken(c, dest)) continue;
    try {
      await c.putFileContents(dest, data, { overwrite: false });
      return dest;
    } catch (err) {
      if (!isExists(err)) throw err; // taken since the check: try the next name
    }
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}

/** The shrunk copy: upload, check, write the summary, and only then delete the original. null when it is not worth keeping (nothing was written). */
async function archiveShrunk(c, { from, dir, summary, archived, shrinkFn }) {
  const name = path.basename(from);
  // A local folder (local-files.js) can be changed by a sync tool at any moment: the version read is the one deleted, or nothing is.
  // Nextcloud is asked exactly as before.
  const version = c.localFiles === true ? (await c.stat(from)).etag : null;
  const onlyThis = version ? { headers: ifMatch(version) } : undefined;
  const original = Buffer.from(await c.getFileContents(from, onlyThis));
  const jpeg = await shrinkFn(original, name);
  if (!Buffer.isBuffer(jpeg) || jpeg.length === 0 || jpeg.length > original.length * KEEP_IF_UNDER) return null;
  const shrunk = { before: original.length, after: jpeg.length };
  // Which original this copy was made from, in its archive note: a retry deletes a file left at `from` only when it is that very one
  // (finishEarlier), never another photo of the same size. The hash costs no request; the local etag was read above anyway.
  const madeFrom = { sha256: sha256(original), ...(version ? { etag: etagText(version) } : {}) };
  const dest = await putNew(c, dir, `${noExt(name)}.jpg`, jpeg);
  let wroteJson = false;
  // Only what this call made is removed again: the photo at dest is ours (it was free), the .json only once it was written.
  const scrap = () => Promise.all([c.deleteFile(dest), wroteJson ? c.deleteFile(`${dest}.json`) : null].filter(Boolean).map((p) => p.catch(() => {})));
  try {
    const seen = Number((await c.stat(dest)).size);
    if (seen !== jpeg.length) throw new Error(`the upload is ${seen} bytes, expected ${jpeg.length}`);
    await putSummary(c, { from, to: dest, summary, extra: { archived: { ...archived, shrunk: { ...shrunk, ...madeFrom } } }, overwrite: false });
    wroteJson = true;
  } catch (err) {
    await scrap(); // the original is untouched: nothing half-done is left in the archive
    throw err;
  }
  try {
    await c.deleteFile(from, onlyThis);
  } catch (err) {
    if (version && (err.status === 412 || err.response?.status === 412)) {
      // Another version is at `from` now (put there, or changed, since it was read): it stays, and so does nothing of this copy.
      await scrap();
      throw Object.assign(new Error(`${name} changed while it was archived; the new version was left where it is`, { cause: err }), { keepGoing: false });
    }
    let stillThere;
    try {
      stillThere = await c.exists(from);
    } catch {
      throw Object.assign(new Error(`could not tell whether ${from} was deleted (${err.message}); the archived copy ${dest} was kept`), { keepGoing: false });
    }
    if (stillThere) {
      await scrap();
      throw err;
    }
  }
  await c.deleteFile(`${from}.json`).catch(() => {}); // the old summary; the new one is beside the archived photo
  return { dest, shrunk, fileMissing: false };
}

const etagText = (e) => String(e ?? '').replace(/^W\//, '').replaceAll('"', '');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const is404 = (err) => err?.status === 404 || err?.response?.status === 404;
const is412 = (err) => err?.status === 412 || err?.response?.status === 412;
/** What the state entry keeps of a shrunk copy (the archive note also names its original). */
const slim = (shrunk) => (shrunk ? { before: shrunk.before, after: shrunk.after } : null);
/** The etag in a state key ("<path>@<etag>"), or null. */
const keyEtag = (key) => (typeof key === 'string' && key.includes('@') ? etagText(key.slice(key.lastIndexOf('@') + 1)) : null) || null;

/** How long a Nextcloud month folder's file names are reused by the next archiving (Archive all moves many in a row). */
const NAMES_FOR_MS = 2 * 60 * 1000;
const listings = new WeakMap(); // client -> Map(dir -> { at, names })

/**
 * The file names in the month folder `dir`. A local folder is listed each time without reading any file (cheap, and always current).
 * Nextcloud's listing is reused for NAMES_FOR_MS, with the names this module put there since added: one request for a whole "Archive
 * all" instead of one per receipt. A name missing from a reused list (put there by another process meanwhile) only makes a retry
 * archive a photo again beside its earlier copy, never lose one. An error other than "no folder" is thrown, not taken as empty.
 */
async function namesIn(c, dir, now = Date.now()) {
  const local = c.localFiles === true;
  let byDir = local ? null : listings.get(c);
  const kept = byDir?.get(dir);
  if (kept && now - kept.at < NAMES_FOR_MS) return [...kept.names];
  let items;
  try {
    items = await c.getDirectoryContents(dir, local ? { etags: false } : undefined);
  } catch (err) {
    if (!is404(err)) throw err;
    items = []; // no folder yet: nothing was archived there
  }
  const names = items.filter((i) => i.type !== 'directory').map((i) => i.basename);
  if (!local) {
    if (!byDir) listings.set(c, (byDir = new Map()));
    byDir.set(dir, { at: now, names: new Set(names) });
  }
  return names;
}
/** A name this module just put in `dir`: a reused listing knows it too. */
const addName = (c, p) => listings.get(c)?.get(path.dirname(p))?.names.add(path.basename(p));
/** Forget the reused listing of `dir` (something went wrong there: the next archiving looks again). */
const dropNames = (c, dir) => listings.get(c)?.delete(dir);

/**
 * What an earlier archiving of this receipt left in the month folder `dir`: files named like it (any extension: a shrunk copy is .jpg,
 * maybe with a time stamp in front). `mine`: the one whose archive note carries this entry's state key (and transaction id). `bare`: the
 * ones with no summary at all (a photo moved there by a try that stopped before its summary was written), with their etag.
 */
async function earlierTry(c, { from, dir, archived }) {
  const base = noExt(path.basename(from));
  const like = new RegExp(`^(?:\\d+-)?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[A-Za-z0-9]+$`);
  const names = (await namesIn(c, dir)).filter((n) => like.test(n) && !n.endsWith('.json'));
  let mine = null;
  const bare = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let found;
    try {
      found = JSON.parse(await c.getFileContents(`${p}.json`, { format: 'text' }));
    } catch (err) {
      if (!is404(err)) continue; // unreadable: not ours to judge
      // Only a photo without a summary needs its version (rare: a try that stopped half way); asked for it alone.
      try {
        const st = await c.stat(p);
        bare.push({ p, etag: etagText(st.etag), size: Number(st.size) });
      } catch (e) {
        if (!is404(e)) throw e; // gone since the listing: nothing there
      }
      continue;
    }
    const a = found?.archived;
    if (!mine && archived.key && a?.key === archived.key && (!archived.txnId || !a.txnId || a.txnId === archived.txnId)) mine = { dest: p, shrunk: a.shrunk ?? null };
  }
  return { mine, bare };
}

/**
 * The file is not where the entry says. Maybe an earlier archiving moved it and then failed to record that: look in the month folder for a
 * receipt whose archive note carries this entry's state key (and transaction id), or a photo there without a summary that is the very
 * version the entry was made for (its etag is in the state key). Only then is the photo called missing.
 */
async function archiveMissing(c, { from, dir, summary, archived, earlier }) {
  const name = path.basename(from);
  if (earlier.mine) return { ...earlier.mine, shrunk: slim(earlier.mine.shrunk), fileMissing: false };
  const etag = keyEtag(archived.key);
  const adopt = etag && earlier.bare.find((b) => b.etag === etag);
  if (adopt) return summarise(c, { from, to: adopt.p, summary, archived });
  const dest = await freePath(c, dir, name);
  await putSummary(c, { from, to: dest, summary, extra: { archived: { ...archived, shrunk: null, fileMissing: true } }, overwrite: false });
  if (summary) await c.deleteFile(`${from}.json`).catch(() => {}); // a damaged old summary is kept where it is
  return { dest, shrunk: null, fileMissing: true };
}

/** Write the archive summary beside a photo already at `to` (no summary there yet), then drop the old one. As refileWith on failure. */
async function summarise(c, { from, to, summary, archived }) {
  try {
    await putSummary(c, { from, to, summary, extra: { archived: { ...archived, shrunk: null } }, overwrite: false });
  } catch (err) {
    log(`  ${to} is archived, but could not write its .json: ${err.message}`);
    return { dest: to, shrunk: null, fileMissing: false, noSummary: true };
  }
  if (summary) await c.deleteFile(`${from}.json`).catch(() => {});
  return { dest: to, shrunk: null, fileMissing: false };
}

/**
 * Is the file at `from` the very original an earlier try made `shrunk` from? Its archive note names it (sha256 of its bytes, and with
 * a local folder its etag); an older note without them can't tell, and neither can a file that changed while it was read. Returns the
 * etag to delete it by (If-Match), or null: then it is not deleted.
 */
async function sameOriginal(c, from, shrunk, now) {
  if (!shrunk?.sha256 || Number(now.size) !== Number(shrunk.before)) return null;
  const version = etagText(now.etag);
  if (!version || (shrunk.etag && shrunk.etag !== version)) return null;
  let bytes;
  try {
    bytes = Buffer.from(await c.getFileContents(from, { headers: ifMatch(version) }));
  } catch (err) {
    if (is412(err) || is404(err)) return null; // another version, or gone, since the look above
    throw err;
  }
  return sha256(bytes) === shrunk.sha256 ? version : null;
}

/**
 * The receipt is still at `from` but an earlier try left something in the month folder: finish that instead of archiving it twice.
 *   - its summary is there with a shrunk copy, and `from` is the very original it was made from (its hash, see sameOriginal): only the
 *     original has to go, and only that version is deleted (If-Match). Anything else at `from` (another photo of the same size, an
 *     older note that can't tell) is archived as usual, beside the copy: a photo is never deleted on a guess;
 *   - the same version is in the folder without a summary (a local move that stopped half way, both names one file): the move is
 *     finished and the summary written.
 * null: nothing to finish, archive as usual.
 */
async function finishEarlier(c, { from, summary, archived, earlier }) {
  if (!earlier.mine?.shrunk && !earlier.bare.length) return null;
  const now = await c.stat(from);
  const version = etagText(now.etag);
  const original = earlier.mine?.shrunk ? await sameOriginal(c, from, earlier.mine.shrunk, now) : null;
  if (original) {
    try {
      await c.deleteFile(from, { headers: ifMatch(original) });
    } catch (err) {
      if (is412(err)) return null; // another version now: archive it as usual
      throw Object.assign(new Error(`could not delete ${from} (${err.message}); its archived copy ${earlier.mine.dest} was kept`, { cause: err }), { keepGoing: false });
    }
    await c.deleteFile(`${from}.json`).catch(() => {});
    return { ...earlier.mine, shrunk: slim(earlier.mine.shrunk), fileMissing: false };
  }
  const twin = version && earlier.bare.find((b) => b.etag === version);
  if (!twin) return null;
  try {
    await c.moveFile(from, twin.p, { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(version) } });
  } catch (err) {
    if (isExists(err)) return null; // two different files after all (Nextcloud): archive as usual, beside it
    throw err;
  }
  return summarise(c, { from, to: twin.p, summary, archived });
}

/**
 * Move the receipt at `from` and its summary into `dir` (the archive's month folder).
 *   summary    the receipt's summary; null when there is none or it can't be read (a damaged .json is carried over, not replaced)
 *   at         when it is archived (ISO)
 *   id         { key, txnId } of the state entry: written in the archive note so a later retry can recognise this very receipt
 *   shrink     save the photo again as a smaller JPEG when that saves at least 10% (shrinkFn does the converting)
 * Returns { dest, shrunk: { before, after } | null, fileMissing, noSummary? }. When shrinking fails at any step the original is moved
 * instead (and the reason logged); when even that fails, this throws and the original is where it was. noSummary: the photo moved but
 * its summary could not be written at the new place (the old one stays where it was).
 */
export async function archiveFileWith(c, args) {
  try {
    const done = await archiveInto(c, args);
    if (!done.fileMissing) addName(c, done.dest); // a photo is there now (a missing one has only its summary)
    return done;
  } catch (err) {
    dropNames(c, args.dir); // left something half done maybe: the next archiving there lists the folder again
    throw err;
  }
}

async function archiveInto(c, { from, dir, summary, at, shrink, shrinkFn, id = {} }) {
  const archived = { at, from, ...(id.key ? { key: id.key } : {}), ...(id.txnId ? { txnId: id.txnId } : {}) };
  await ensureDir(c, dir);
  const sum = withoutArchived(summary);
  // What an earlier try of this archiving left in the folder is looked at first, so a retry finishes it instead of starting over.
  const earlier = await earlierTry(c, { from, dir, archived });
  if (!(await c.exists(from))) return archiveMissing(c, { from, dir, summary: sum, archived, earlier });
  const finished = await finishEarlier(c, { from, summary: sum, archived, earlier });
  if (finished) return finished;
  if (shrink && shrinkFn && SHRINKABLE.test(from)) {
    try {
      const done = await archiveShrunk(c, { from, dir, summary: sum, archived, shrinkFn });
      if (done) return done;
    } catch (err) {
      if (err.keepGoing === false) throw err; // the state of the files is unclear: go no further
      log(`  archive: could not shrink ${path.basename(from)} (${err.message}); moving the original instead`);
    }
  }
  try {
    const dest = await refileWith(c, from, path.join(dir, path.basename(from)), sum && { ...sum, archived: { ...archived, shrunk: null } });
    return { dest, shrunk: null, fileMissing: false };
  } catch (err) {
    if (err.movedTo) return { dest: err.movedTo, shrunk: null, fileMissing: false, noSummary: true };
    throw err;
  }
}

/**
 * Put an archived receipt back in `dir` (Processed) with `summary` (no `archived` note), never over another file or summary. A photo that
 * is gone from the archive is reported as `missing`: only its summary is put back. Returns { dest, missing, noSummary? }.
 */
export async function restoreFileWith(c, { from, dir, summary }) {
  const sum = withoutArchived(summary);
  try {
    return { dest: await refileWith(c, from, path.join(dir, path.basename(from)), sum), missing: false };
  } catch (err) {
    if (err.movedTo) return { dest: err.movedTo, missing: false, noSummary: true };
    if (err.status !== 404) throw err;
  }
  const dest = await freePath(c, dir, path.basename(from));
  await putSummary(c, { from, to: dest, summary: sum, extra: {}, overwrite: false });
  if (sum) await c.deleteFile(`${from}.json`).catch(() => {});
  return { dest, missing: true };
}
