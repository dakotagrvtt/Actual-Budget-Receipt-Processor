import path from 'node:path/posix';
import { createClient } from 'webdav';
import { config, log } from './config.js';
import { SUPPORTED } from './image.js';

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

export async function download(item) {
  return Buffer.from(await client.getFileContents(item.filename));
}

/** Move a receipt into a folder (never overwriting) and store a JSON summary next to it. */
export async function fileInto(item, folder, summary) {
  let dest = path.join(folder, item.basename);
  if (await client.exists(dest)) dest = path.join(folder, `${Date.now()}-${item.basename}`);
  await client.moveFile(item.filename, dest);
  // The receipt is filed either way; a missing summary mustn't make the caller retry (or redo) the whole receipt.
  try {
    await client.putFileContents(`${dest}.json`, JSON.stringify(summary, null, 2), { overwrite: true });
  } catch (err) {
    log(`  moved to ${dest}, but could not write ${path.basename(dest)}.json: ${err.message}`);
  }
  return dest;
}
