// The Nextcloud side of archiving and restoring, with the WebDAV client passed in (so tests can use a stand-in). The rule that
// shapes it: a photo is never lost. A shrunk copy is uploaded, checked and its summary written BEFORE the original is deleted,
// and anything that goes wrong on the way falls back to a plain move of the original. The second rule: nothing already in a folder is
// replaced. A name counts as taken when either the file or its .json exists (a summary can sit there without a photo), and a
// summary is written with overwrite:false whenever it goes to a new place.
import path from 'node:path/posix';
import { log } from './config.js';
import { SHRINKABLE } from './image.js';
import { NO_OVERWRITE, isExists, moveKeepingBoth } from './requeue.js';

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
  const original = Buffer.from(await c.getFileContents(from));
  const jpeg = await shrinkFn(original, name);
  if (!Buffer.isBuffer(jpeg) || jpeg.length === 0 || jpeg.length > original.length * KEEP_IF_UNDER) return null;
  const shrunk = { before: original.length, after: jpeg.length };
  const dest = await putNew(c, dir, `${noExt(name)}.jpg`, jpeg);
  let wroteJson = false;
  // Only what this call made is removed again: the photo at dest is ours (it was free), the .json only once it was written.
  const scrap = () => Promise.all([c.deleteFile(dest), wroteJson ? c.deleteFile(`${dest}.json`) : null].filter(Boolean).map((p) => p.catch(() => {})));
  try {
    const seen = Number((await c.stat(dest)).size);
    if (seen !== jpeg.length) throw new Error(`the upload is ${seen} bytes, expected ${jpeg.length}`);
    await putSummary(c, { from, to: dest, summary, extra: { archived: { ...archived, shrunk } }, overwrite: false });
    wroteJson = true;
  } catch (err) {
    await scrap(); // the original is untouched: nothing half-done is left in the archive
    throw err;
  }
  try {
    await c.deleteFile(from);
  } catch (err) {
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

/**
 * The file is not where the entry says. Maybe an earlier archiving moved it and then failed to record that: look in the month folder for a
 * receipt whose archive note carries this entry's state key (and transaction id). Only then is the photo called missing.
 */
async function archiveMissing(c, { from, dir, summary, archived }) {
  const name = path.basename(from);
  const base = noExt(name);
  if (archived.key) {
    const mine = new RegExp(`^(?:\\d+-)?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[A-Za-z0-9]+$`);
    let names = [];
    try {
      names = (await c.getDirectoryContents(dir)).map((i) => i.basename).filter((n) => mine.test(n));
    } catch { /* no folder yet: nothing was archived there */ }
    for (const n of names) {
      try {
        const found = JSON.parse(await c.getFileContents(`${path.join(dir, n)}.json`, { format: 'text' }));
        const a = found?.archived;
        if (a?.key === archived.key && (!archived.txnId || !a.txnId || a.txnId === archived.txnId)) return { dest: path.join(dir, n), shrunk: a.shrunk ?? null, fileMissing: false };
      } catch { /* not ours, or unreadable */ }
    }
  }
  const dest = await freePath(c, dir, name);
  await putSummary(c, { from, to: dest, summary, extra: { archived: { ...archived, shrunk: null, fileMissing: true } }, overwrite: false });
  if (summary) await c.deleteFile(`${from}.json`).catch(() => {}); // a damaged old summary is kept where it is
  return { dest, shrunk: null, fileMissing: true };
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
export async function archiveFileWith(c, { from, dir, summary, at, shrink, shrinkFn, id = {} }) {
  const archived = { at, from, ...(id.key ? { key: id.key } : {}), ...(id.txnId ? { txnId: id.txnId } : {}) };
  await ensureDir(c, dir);
  const sum = withoutArchived(summary);
  if (!(await c.exists(from))) return archiveMissing(c, { from, dir, summary: sum, archived });
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
