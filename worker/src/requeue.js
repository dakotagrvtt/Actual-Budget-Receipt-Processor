// Sending a receipt back from Needs review to the inbox. Kept apart from nextcloud.js so tests can run it with a fake client.
import path from 'node:path/posix';
import { FileChangedError } from './errors.js';

// Options for webdav's moveFile so a file already at the destination is never replaced: the library's `overwrite: false`
// and the plain WebDAV header it stands for (MOVE replaces by default; "Overwrite: F" makes the server answer 412).
export const NO_OVERWRITE = { overwrite: false, headers: { Overwrite: 'F' } };
/** Did a move fail because the destination already exists? (412 Precondition Failed, or 409 Conflict) */
export const isExists = (err) => err?.status === 412 || err?.status === 409 || err?.response?.status === 412 || err?.response?.status === 409;

/** The If-Match header for a listed etag ({} without one): the request only goes through while the file still has that etag
 *  (412 Precondition Failed otherwise). The listing may give the etag with or without its quotes. */
export const ifMatch = (etag) => {
  const e = String(etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
  return e ? { 'If-Match': `"${e}"` } : {};
};

/** The bytes of a listed inbox file, only while it still has the etag the listing gave (If-Match). Another upload under the same
 *  name since then is a FileChangedError: nothing is read, and the new file is looked at on the next poll. */
export async function downloadListed(c, item) {
  try {
    return Buffer.from(await c.getFileContents(item.filename, { headers: ifMatch(item.etag) }));
  } catch (err) {
    if (item.etag && (err?.status === 412 || err?.response?.status === 412)) throw new FileChangedError(`${item.basename} changed since it was listed`, { cause: err });
    throw err;
  }
}

/** Move `from` to `dest` without replacing anything; if the server says `dest` exists (it appeared since the caller looked),
 *  use `other` instead. Returns the path it ended up at. With `etag` (the one the listing gave), the file is only moved while
 *  it still has it, else FileChangedError: the server answers 412 both for a name taken and for a changed file, so a second
 *  412 on the unused name `other` is taken to mean the file changed. */
export async function moveKeepingBoth(c, from, dest, other, etag, extra = {}) {
  const base = etag ? { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } } : NO_OVERWRITE;
  const options = Object.keys(extra).length ? { ...base, ...extra } : base; // extra: e.g. a timeout signal
  try {
    await c.moveFile(from, dest, options);
    return dest;
  } catch (err) {
    if (!isExists(err)) throw err;
  }
  try {
    await c.moveFile(from, other, options);
  } catch (err) {
    if (etag && isExists(err)) throw new FileChangedError(`${path.basename(from)} is not the version that was read (its etag changed)`, { cause: err });
    throw err;
  }
  return other;
}

/** Do both paths show the same file version (the same etag)? false when either has none. */
async function sameVersion(c, a, b) {
  const tag = (s) => String(s?.etag ?? '').replace(/^W\//, '').replaceAll('"', '');
  try {
    const [x, y] = [await c.stat(a), await c.stat(b)];
    return Boolean(tag(x)) && tag(x) === tag(y);
  } catch {
    return false; // can't tell: treated as another file, so nothing is moved
  }
}

/** Did the pipeline change Actual for this receipt? Reads the summary fileInto stored next to it. true / false / null (no summary). */
async function wasApplied(file, c) {
  let text;
  try {
    text = Buffer.from(await c.getFileContents(`${file}.json`)).toString('utf8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
  try {
    const summary = JSON.parse(text);
    return summary?.alreadyApplied === true || summary?.applied === true || summary?.plan?.applied === true;
  } catch {
    return true; // can't read it, so can't tell: treat as applied and leave the file alone
  }
}

const tagOf = (s) => String(s?.etag ?? s ?? '').replace(/^W\//, '').replaceAll('"', '');
const statOrNull = async (c, p) => {
  try {
    return await c.stat(p);
  } catch (err) {
    if (err?.status === 404 || err?.response?.status === 404) return null;
    throw err;
  }
};

/**
 * Put one receipt from Needs review back in the inbox so it is processed again, and delete its .json summary
 * (the next run writes a fresh one). `from` is the exact path fileInto returned when it was filed (kept in the state
 * entry), `name` the file's name in the inbox, `etag` the version meant (the status page's "Try again" records it). Nothing is moved
 * unless it is safe:
 *   { moved: newPath }        done
 *   { inInbox: true }         it is no longer in review and the inbox has it (with `etag`: that very version)
 *   { unsure: true }          (with `etag`) it is not in review, and the inbox has a file of that name that is not that version:
 *                             where it went can't be told yet (another process may be moving it); nothing is changed
 *   { refused: 'applied' }    the summary says Actual was changed for it
 *   { refused: 'exists' }     the inbox already has a different file with this name (never renamed or overwritten)
 *   { refused: 'changed' }    (with `etag`) the file in review is not that version any more; it stays there
 *   null                      not in review and not in the inbox
 * `c` is the WebDAV client (a stand-in in tests); nextcloud.js passes its own.
 */
export async function requeue(c, inbox, from, name, etag = null) {
  const dest = path.join(inbox, name);
  const want = tagOf(etag);
  if (!(await c.exists(from))) {
    if (!want) return (await c.exists(dest)) ? { inInbox: true } : null; // an older note without a version: as before
    // A local folder's move or delete that stopped half way (or is under way in the other process) can hide the file for a moment:
    // what can be settled is settled first.
    await c.recoverClaims?.();
    if (!(await c.exists(from))) {
      const there = await statOrNull(c, dest);
      if (!there) return null;
      return tagOf(there) === want ? { inInbox: true } : { unsure: true };
    }
  }
  if (await wasApplied(from, c)) return { refused: 'applied' }; // null (no summary) is fine: the state says nothing was applied
  // A taken name is refused, unless it is this very version at both names: a local folder's move that stopped half way (link, then
  // unlink); moving it again finishes that (local-files.js). Nextcloud never shows one version at two names.
  if ((await c.exists(dest)) && !(await sameVersion(c, from, dest))) return { refused: 'exists' };
  // With a version, only that version moves (If-Match): what the note says is then what is in the inbox.
  const options = want ? { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(want) } } : NO_OVERWRITE;
  try {
    await c.moveFile(from, dest, options);
  } catch (err) {
    if (!isExists(err)) throw err;
    // 412 is both "the name is taken" and "another version": a free name means the file changed.
    if (want && !(await c.exists(dest))) return { refused: 'changed' };
    return { refused: 'exists' }; // a file appeared there since the check above
  }
  await c.deleteFile(`${from}.json`).catch(() => {}); // no summary, or already gone
  return { moved: dest };
}

/**
 * "Try again" (panel-actions.js) writes down what it is about to move (entry.requeue: { from, name, etag }) before it moves anything,
 * and clears the entry once the file is back in the inbox. Stopped in between, the file can be in the inbox while its entry still says
 * "done" under the very same key (same name, same version): the worker would skip it, maybe with a copy left in Needs review. The
 * worker runs this before it lists the inbox: each recorded requeue is done again (requeue finishes or refuses it) and the entry
 * cleared when that very version is in the inbox. When neither place can be told (requeue's `unsure`: the file is not in review and
 * the inbox has another one of that name) the note stays and is looked at again next time; otherwise only the note goes.
 * deps: { requeueFromReview(from, name, etag), forgetKeys(keys), saveState(state), log? }. Returns the state, without the cleared entries.
 */
export async function replayRequeues(state, deps) {
  let changed = false;
  for (const [key, entry] of Object.entries(state)) {
    const r = entry?.requeue;
    if (!r?.from || !r?.name) continue;
    const out = await deps.requeueFromReview(r.from, r.name, r.etag ?? null);
    if (out?.unsure) {
      deps.log?.(`"try again" of ${r.name}: it is not in Needs review and the inbox has another file of that name; looked at again next time`);
      continue;
    }
    if (out?.moved || out?.inInbox) {
      await deps.forgetKeys([key]);
      delete state[key];
    } else {
      const { requeue: _done, ...rest } = entry;
      state[key] = rest;
      changed = true;
    }
  }
  if (changed) await deps.saveState(state);
  return state;
}
