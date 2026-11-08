// The worker's WebDAV access to Nextcloud: list the inbox, download a receipt, file it (with its JSON summary) into
// Processed or Needs review, and the small reads behind the status page. Folder paths come from config.nextcloud.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { createClient } from 'webdav';
import { config, log } from './config.js';
import { SUPPORTED } from './image.js';
import { keyedClient } from './keyed-client.js';
import { requeue, moveKeepingBoth, downloadListed } from './requeue.js';

// The WebDAV client is made from the current settings, and made again when the address, user or app password change
// (the status page's Settings tab changes them between checks). Nothing is read from config at import.
const clientFor = keyedClient((url, user, password) => createClient(`${url}/remote.php/dav/files/${encodeURIComponent(user)}`, { username: user, password }));
export function davClient() {
  const nc = config.nextcloud;
  return clientFor(nc.url, nc.user, nc.password);
}

export async function ensureFolders() {
  const client = davClient();
  const nc = config.nextcloud;
  for (const dir of [nc.inbox, nc.processed, nc.review]) {
    if (!(await client.exists(dir))) await client.createDirectory(dir, { recursive: true });
  }
}

// Uploads still in progress: hidden files (Nextcloud's chunked ".name.ocTransferId….part") and browser/app temp files.
const PARTIAL = /^\.|\.(part|tmp|crdownload)$/i;

/** Receipt files waiting in the inbox: [{filename, basename, etag, lastmod, size}]. */
export async function listInbox() {
  const items = await davClient().getDirectoryContents(config.nextcloud.inbox);
  return items.filter((i) => i.type === 'file' && SUPPORTED.test(i.basename) && !PARTIAL.test(i.basename) && i.size > 0);
}

/** Receipt files in any folder (read-only; used by replay tests). */
export async function listFolder(folder) {
  const items = await davClient().getDirectoryContents(folder);
  return items.filter((i) => i.type === 'file' && SUPPORTED.test(i.basename));
}

export const download = (item) => downloadListed(davClient(), item);

/** Move a receipt into a folder (never overwriting) and store a JSON summary next to it. Only the listed version moves
 *  (item.etag): if the file was replaced meanwhile, FileChangedError and nothing is moved or written. */
export async function fileInto(item, folder, summary) {
  const client = davClient();
  let dest = path.join(folder, item.basename);
  if (await client.exists(dest)) dest = path.join(folder, `${Date.now()}-${item.basename}`);
  dest = await moveKeepingBoth(client, item.filename, dest, path.join(folder, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${item.basename}`), item.etag);
  // The receipt is filed either way; a missing summary mustn't make the caller retry (or redo) the whole receipt.
  try {
    await client.putFileContents(`${dest}.json`, JSON.stringify(summary, null, 2), { overwrite: true });
  } catch (err) {
    log(`  moved to ${dest}, but could not write ${path.basename(dest)}.json: ${err.message}`);
  }
  return dest;
}

/** Put one receipt from Needs review back in the inbox (see requeue.js). `from` is the exact path fileInto returned. */
export const requeueFromReview = (from, name, c = davClient()) => requeue(c, config.nextcloud.inbox, from, name);

const PANEL_TIMEOUT_MS = 15000;

/** The bytes of a receipt file at an exact path (the status page's photo view). */
export async function downloadPath(p) {
  return Buffer.from(await davClient().getFileContents(p, { signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) }));
}

/** Size and etag of a file, without downloading it. A missing file throws with status 404. */
export async function statPath(p) {
  const s = await davClient().stat(p, { signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) });
  return { size: Number(s.size) || 0, etag: s.etag ?? null, lastmod: s.lastmod ?? null };
}

/** The JSON summary filed next to a receipt (`<path>.json`), or null when it can't be read as JSON. */
export async function readSummary(p) {
  try {
    return JSON.parse(await davClient().getFileContents(`${p}.json`, { format: 'text', signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) }));
  } catch (err) {
    if (err.status === 404) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Move an already filed receipt to `dest` (never replacing a file: a taken name gets a time stamp in front) and put `summary` next
 * to it as its .json; the old .json goes. With dest === from the file stays and only the summary is rewritten. Returns the path
 * it ended up at. A file that is not at `from` any more throws an error with status 404. If only the new .json could not be written,
 * it throws with `movedTo` (where the file is now) and leaves the old .json alone.
 */
export async function refile(from, dest, summary) {
  const client = davClient();
  if (!(await client.exists(from))) throw Object.assign(new Error(`${from} is not there`), { status: 404 });
  let at = from;
  if (dest !== from) {
    const other = path.join(path.dirname(dest), `${Date.now()}-${path.basename(dest)}`);
    at = await moveKeepingBoth(client, from, dest, other);
  }
  try {
    await client.putFileContents(`${at}.json`, JSON.stringify(summary, null, 2), { overwrite: true });
  } catch (err) {
    // The old summary stays (it is the only one); the caller learns where the file is now.
    log(`  moved to ${at}, but could not write ${path.basename(at)}.json: ${err.message}`);
    throw Object.assign(new Error(`${path.basename(at)}.json could not be written: ${err.message}`), { movedTo: at });
  }
  if (at !== from) await client.deleteFile(`${from}.json`).catch(() => {});
  return at;
}
