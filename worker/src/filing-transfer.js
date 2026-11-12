// A persisted destination and source version make MOVE and summary PUT safe to resume after lost responses.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { NO_OVERWRITE, ifMatch } from './requeue.js';
const missing = (err) => err?.status === 404;
const statOrNull = async (c, p) => { try { return await c.stat(p); } catch (err) { if (missing(err)) return null; throw err; } };
const same = (a, b) => a && b && String(a).replace(/^W\//, '').replaceAll('"', '') === String(b).replace(/^W\//, '').replaceAll('"', '');
const unique = (dest) => path.join(path.dirname(dest), `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(dest)}`);
const taken = async (c, p) => (await c.exists(p)) || (await c.exists(`${p}.json`));

export async function resumeTransfer(c, intent, checkpoint) {
  let source = await statOrNull(c, intent.from);
  if (!intent.to) {
    if (!source || (intent.etag && !same(source.etag, intent.etag))) {
      // Older finishing entries did not record their destination. Adopt only one matching file version.
      const files = await c.getDirectoryContents(path.dirname(intent.dest));
      const name = path.basename(intent.from);
      const candidates = files.filter((f) => f.type === 'file' && (f.basename === name || f.basename.endsWith(`-${name}`)) && same(f.etag, intent.etag));
      if (candidates.length !== 1) throw new Error('The moved receipt could not be identified safely; its filing record was kept');
      intent.to = candidates[0].filename;
    } else {
      if (intent.etag && !same(source.etag, intent.etag)) throw new Error('The source receipt changed; its filing record was kept');
      intent.etag = source.etag;
      intent.to = intent.from === intent.dest || !(await taken(c, intent.dest)) ? intent.dest : unique(intent.dest);
    }
    if (!intent.etag) throw new Error('Nextcloud did not return the receipt version');
    await checkpoint(structuredClone(intent)); // destination is durable BEFORE the MOVE
  }
  const alreadyMoved = intent.to !== intent.from && same((await statOrNull(c, intent.to))?.etag, intent.etag);
  let moved = false;
  if (intent.to !== intent.from && source && !alreadyMoved) {
    if (!same(source.etag, intent.etag)) throw new Error('The source receipt changed; nothing was replaced');
    if (await taken(c, intent.to)) {
      intent.to = unique(intent.dest);
      await checkpoint(structuredClone(intent));
    }
    await c.moveFile(intent.from, intent.to, { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(intent.etag) } });
    moved = true;
  }
  const destination = await statOrNull(c, intent.to);
  if (!destination || !same(destination.etag, intent.etag)) throw new Error('The filed receipt version could not be verified');
  await c.putFileContents(`${intent.to}.json`, JSON.stringify(intent.summary, null, 2), { overwrite: true });
  if (intent.from !== intent.to && (!source || moved)) await c.deleteFile(`${intent.from}.json`).catch(() => {});
  return intent.to;
}
