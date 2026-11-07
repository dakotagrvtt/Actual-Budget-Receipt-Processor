// The worker's WebDAV access to Nextcloud: list the inbox, download a receipt, file it (with its JSON summary) into
// Processed or Needs review, and the small reads behind the status page. Folder paths come from config.nextcloud.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { createClient } from 'webdav';
import { config, log } from './config.js';
import { SUPPORTED } from './image.js';
import { requeue, moveKeepingBoth, downloadListed } from './requeue.js';

const nc = config.nextcloud;
const client = createClient(`${nc.url}/remote.php/dav/files/${encodeURIComponent(nc.user)}`, {
  username: nc.user,
  password: nc.password,
});

export async function ensureFolders() {
  for (const dir of [nc.inbox, nc.processed, nc.review]) {
    if (!(await client.exists(dir))) await client.createDirectory(dir, { recursive: true });
  }
}

// Uploads still in progress: hidden files (Nextcloud's chunked ".name.ocTransferId….part") and browser/app temp files.
const PARTIAL = /^\.|\.(part|tmp|crdownload)$/i;

/** Receipt files waiting in the inbox: [{filename, basename, etag, lastmod, size}]. */
export async function listInbox() {
  const items = await client.getDirectoryContents(nc.inbox);
  return items.filter((i) => i.type === 'file' && SUPPORTED.test(i.basename) && !PARTIAL.test(i.basename) && i.size > 0);
}

/** Receipt files in any folder (read-only; used by replay tests). */
export async function listFolder(folder) {
  const items = await client.getDirectoryContents(folder);
  return items.filter((i) => i.type === 'file' && SUPPORTED.test(i.basename));
}

export const download = (item) => downloadListed(client, item);

/** Move a receipt into a folder (never overwriting) and store a JSON summary next to it. Only the listed version moves
 *  (item.etag): if the file was replaced meanwhile, FileChangedError and nothing is moved or written. */
export async function fileInto(item, folder, summary) {
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
export const requeueFromReview = (from, name, c = client) => requeue(c, nc.inbox, from, name);

const PANEL_TIMEOUT_MS = 15000;

/** The bytes of a receipt file at an exact path (the status page's photo view). */
export async function downloadPath(p) {
  return Buffer.from(await client.getFileContents(p, { signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) }));
}

/** Size and etag of a file, without downloading it. A missing file throws with status 404. */
export async function statPath(p) {
  const s = await client.stat(p, { signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) });
  return { size: Number(s.size) || 0, etag: s.etag ?? null, lastmod: s.lastmod ?? null };
}

/** The JSON summary filed next to a receipt (`<path>.json`), or null when it can't be read as JSON. */
export async function readSummary(p) {
  try {
    return JSON.parse(await client.getFileContents(`${p}.json`, { format: 'text', signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) }));
  } catch (err) {
    if (err.status === 404) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
