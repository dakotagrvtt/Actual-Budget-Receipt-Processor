// Small helpers for files that more than one process edits (keywords.json, category-notes.json, settings.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdirPrivate, writePrivate } from './private-files.js';

/** Write JSON to a temp file next to the target, then rename it over the target, so a crash can't leave half a file. */
export async function writeJsonAtomic(file, data) {
  await mkdirPrivate(path.dirname(file));
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  await writePrivate(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(tmp, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn under an O_EXCL lock file at `lock`. Retries for `waitMs` (default 5 s); a lock older than `staleMs`
 * (default 30 s) is stale and taken over. The lock file holds a random token, and only its owner removes it,
 * so a slow holder whose lock was taken over can't delete the new owner's lock.
 */
export async function withLock(lock, fn, { waitMs = 5000, staleMs = 30000 } = {}) {
  await mkdirPrivate(path.dirname(lock));
  const token = crypto.randomUUID();
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx', 0o600);
      await h.writeFile(token);
      await h.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        if (await takeOver(lock, token, st)) break;
      } else if (Date.now() - t0 > waitMs) {
        throw new Error(`file is locked (${lock})`);
      } else {
        await sleep(50);
      }
    }
  }
  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still ours.
    if ((await fs.readFile(lock, 'utf8').catch(() => null)) === token) await fs.unlink(lock).catch(() => {});
  }
}

/** Replace a stale lock with ours by renaming a fresh file over it (never a gap with no lock), then check we won. */
async function takeOver(lock, token, seen) {
  const now = await fs.stat(lock).catch(() => null);
  if (!now || now.mtimeMs !== seen.mtimeMs || now.ino !== seen.ino) return false; // someone else just did it
  const mine = `${lock}.${crypto.randomUUID()}.new`;
  await writePrivate(mine, token);
  try {
    await fs.rename(mine, lock);
  } catch (err) {
    await fs.unlink(mine).catch(() => {});
    return false;
  }
  await sleep(100); // if another waiter renamed over ours in the same instant, the file now holds its token
  return (await fs.readFile(lock, 'utf8').catch(() => null)) === token;
}
