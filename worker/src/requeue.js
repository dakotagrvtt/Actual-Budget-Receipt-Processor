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
export async function moveKeepingBoth(c, from, dest, other, etag) {
  const options = etag ? { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } } : NO_OVERWRITE;
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

/**
 * Put one receipt from Needs review back in the inbox so it is processed again, and delete its .json summary
 * (the next run writes a fresh one). `from` is the exact path fileInto returned when it was filed (kept in the state
 * entry), `name` the file's name in the inbox. Nothing is moved unless it is safe:
 *   { moved: newPath }        done
 *   { inInbox: true }         it is no longer in review and the inbox already has it
 *   { refused: 'applied' }    the summary says Actual was changed for it
 *   { refused: 'exists' }     the inbox already has a different file with this name (never renamed or overwritten)
 *   null                      not in review and not in the inbox
 * `c` is the WebDAV client (a stand-in in tests); nextcloud.js passes its own.
 */
export async function requeue(c, inbox, from, name) {
  const dest = path.join(inbox, name);
  if (!(await c.exists(from))) return (await c.exists(dest)) ? { inInbox: true } : null;
  if (await wasApplied(from, c)) return { refused: 'applied' }; // null (no summary) is fine: the state says nothing was applied
  if (await c.exists(dest)) return { refused: 'exists' };
  try {
    await c.moveFile(from, dest, NO_OVERWRITE);
  } catch (err) {
    if (isExists(err)) return { refused: 'exists' }; // a file appeared there since the check above
    throw err;
  }
  await c.deleteFile(`${from}.json`).catch(() => {}); // no summary, or already gone
  return { moved: dest };
}
