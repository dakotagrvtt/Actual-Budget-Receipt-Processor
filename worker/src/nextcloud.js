import { timedDavClient } from './dav-timeout.js';
import { resumeTransfer } from './filing-transfer.js';
// The worker's access to the receipt files: list the inbox, download a receipt, file it (with its JSON summary) into
// Processed or Needs review, and the small reads behind the status page. Folder paths come from config.nextcloud.
// The files are in Nextcloud (WebDAV), or with STORAGE=local in a folder on this machine (local-files.js, the same client methods).
import path from 'node:path/posix';
import { createClient } from 'webdav';
import { config } from './config.js';
import { SUPPORTED, shrinkPhoto } from './image.js';
import { staleUploads, uploadFiles } from './upload.js';
import { archiveFileWith, refileWith, restoreFileWith } from './archive-files.js';
import { keyedClient } from './keyed-client.js';
import { localClient, sweepTemps, settledOnly } from './local-files.js';
import { requeue, downloadListed } from './requeue.js';

// The WebDAV client is made from the current settings, and made again when the address, user or app password change
// (the status page's Settings tab changes them between checks). Nothing is read from config at import.
const clientFor = keyedClient((url, user, password) => timedDavClient(createClient(`${url}/remote.php/dav/files/${encodeURIComponent(user)}`, { username: user, password })));
const localFor = keyedClient((root) => localClient(root));
export function davClient() {
  if (config.storage.kind === 'local') return localFor(config.storage.root);
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

// Each local inbox file's version at the previous listing and since when (see settledOnly in local-files.js).
let lastListing = new Map();
/** A receipt file by its name: only these need a version (with a local folder only they are read to work out their etag). */
const isReceipt = (name) => SUPPORTED.test(name) && !PARTIAL.test(name);

/** Receipt files waiting in the inbox: [{filename, basename, etag, lastmod, size}]. */
export async function listInbox() {
  // Nextcloud ignores `etags` (a local-files.js option): it is asked exactly as before.
  const items = await davClient().getDirectoryContents(config.nextcloud.inbox, { etags: isReceipt });
  // unreadable: a local file that can't be read (no permission) has no version yet; it waits until it can be read.
  const files = items.filter((i) => i.type === 'file' && isReceipt(i.basename) && i.size > 0 && !i.unreadable);
  if (config.storage?.kind !== 'local') return files;
  const { ready, next } = settledOnly(files, lastListing);
  lastListing = next;
  return ready;
}

/**
 * Receipt files in any folder (read-only). `names` (basename => boolean): only those need an etag; with a local folder the others are
 * listed without reading them (etag null). Nextcloud lists as before.
 */
export async function listFolder(folder, { names } = {}) {
  const items = await davClient().getDirectoryContents(folder, { etags: (name) => SUPPORTED.test(name) && (!names || names(name)) });
  return items.filter((i) => i.type === 'file' && SUPPORTED.test(i.basename));
}

export const download = (item) => downloadListed(davClient(), item);

/** Move a receipt into a folder (never overwriting) and store a JSON summary next to it. Only the listed version moves
 *  (item.etag): if the file was replaced meanwhile, FileChangedError and nothing is moved or written. */
export const fileInto = (item, folder, summary, options) => resumeTransfer(
  davClient(), options.intent ?? { from: item.filename, dest: path.join(folder, item.basename), etag: item.etag, summary }, options.checkpoint,
);

/** Put one receipt from Needs review back in the inbox (see requeue.js). `from` is the exact path fileInto returned. */
export const requeueFromReview = (from, name, etag = null, c = davClient()) => requeue(c, config.nextcloud.inbox, from, name, etag);

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

const SWEEP_TEMPS_EVERY_MS = 60 * 60 * 1000;
let tempsSweptAt = 0;

/**
 * Delete temporary files of uploads that never finished (".upload-<id>-<name>", over an hour old) from the inbox. Returns how many.
 * With a local receipt folder, at most once an hour also the temporary files of writes that stopped half way, in all its folders
 * (local-files.js; Nextcloud clears its own).
 */
export async function sweepUploads(now = Date.now()) {
  const c = davClient();
  const old = staleUploads(await c.getDirectoryContents(config.nextcloud.inbox, { etags: false }), now); // names and times only
  for (const i of old) await c.deleteFile(i.filename).catch(() => {});
  let temps = 0;
  // Moves or deletes another process (the status page) left half done when it was stopped: finished or undone (local-files.js).
  if (config.storage?.kind === 'local') await c.recoverClaims?.();
  if (config.storage?.kind === 'local' && now - tempsSweptAt >= SWEEP_TEMPS_EVERY_MS) {
    tempsSweptAt = now;
    temps = await sweepTemps(config.storage.root, now);
  }
  return old.length + temps;
}
