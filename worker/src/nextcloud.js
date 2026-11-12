import { timedDavClient } from './dav-timeout.js';
import { resumeTransfer } from './filing-transfer.js';
// The worker's WebDAV access to Nextcloud: list the inbox, download a receipt, file it (with its JSON summary) into
// Processed or Needs review, and the small reads behind the status page. Folder paths come from config.nextcloud.
import path from 'node:path/posix';
import { createClient } from 'webdav';
import { config } from './config.js';
import { SUPPORTED, shrinkPhoto } from './image.js';
import { staleUploads, uploadFiles } from './upload.js';
import { archiveFileWith, refileWith, restoreFileWith } from './archive-files.js';
import { keyedClient } from './keyed-client.js';
import { requeue, downloadListed } from './requeue.js';

// The WebDAV client is made from the current settings, and made again when the address, user or app password change
// (the status page's Settings tab changes them between checks). Nothing is read from config at import.
const clientFor = keyedClient((url, user, password) => timedDavClient(createClient(`${url}/remote.php/dav/files/${encodeURIComponent(user)}`, { username: user, password })));
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
export const fileInto = (item, folder, summary, options) => resumeTransfer(
  davClient(), options.intent ?? { from: item.filename, dest: path.join(folder, item.basename), etag: item.etag, summary }, options.checkpoint,
);

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
export const refile = (from, dest, summary, options = {}) => options.checkpoint ? resumeTransfer(davClient(), options.intent ?? { from, dest, summary }, options.checkpoint) : refileWith(davClient(), from, dest, summary);

/** Move a filed receipt and its summary into the Archive folder `dir`, shrinking the photo when asked (see archive-files.js). */
export const archiveFile = (args) => archiveFileWith(davClient(), { shrinkFn: shrinkPhoto, ...args });

/** Put an archived receipt back in `dir` (Processed), without the archive note (see archive-files.js). */
export const restoreFile = (args) => restoreFileWith(davClient(), args);

/** Save files uploaded from the status page into the inbox (see upload.js). Returns { saved, refused }. */
export const uploadToInbox = (files) => uploadFiles(davClient(), config.nextcloud.inbox, files);

/** Delete temporary files of uploads that never finished (".upload-<id>-<name>", over an hour old) from the inbox. Returns how many. */
export async function sweepUploads(now = Date.now()) {
  const c = davClient();
  const old = staleUploads(await c.getDirectoryContents(config.nextcloud.inbox), now);
  for (const i of old) await c.deleteFile(i.filename).catch(() => {});
  return old.length;
}
