// In dry run nothing is filed, so no summary is written next to the receipt. A slim copy is kept here instead
// (<data dir>/dry-summaries/<sha256 of the state key>.json), only so the status page can show what the worker would do.
// It is receipt data like state.json. Nothing in here may ever fail a receipt.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import { writeJsonAtomic } from './file-lock.js';
import { mkdirPrivate } from './private-files.js';

const KEEP = 200;
const MAX_BYTES = 256 * 1024;
const FIELDS = ['receipt', 'transaction', 'plan', 'problems', 'readWith', 'totalCorrected', 'candidates'];

const dirOf = () => path.join(path.dirname(config.statePath), 'dry-summaries');
const fileOf = (key) => path.join(dirOf(), `${crypto.createHash('sha256').update(String(key)).digest('hex')}.json`);

/** Save the slim summary for a state key; keeps the newest KEEP files. Never throws. */
export async function saveDrySummary(key, summary) {
  try {
    const slim = Object.fromEntries(FIELDS.filter((f) => summary?.[f] !== undefined).map((f) => [f, summary[f]]));
    if (JSON.stringify(slim).length > MAX_BYTES) return;
    await mkdirPrivate(dirOf());
    await writeJsonAtomic(fileOf(key), slim);
    await prune();
  } catch (err) {
    log(`  could not keep the dry-run summary: ${err.message}`);
  }
}

async function prune() {
  const dir = dirOf();
  const files = await Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
  for (const { f } of files.sort((a, b) => b.t - a.t).slice(KEEP)) await fs.rm(path.join(dir, f), { force: true });
}

/** The saved summary for a state key, or null. The path comes from the hash only. */
export async function readDrySummary(key) {
  try {
    return JSON.parse(await fs.readFile(fileOf(key), 'utf8'));
  } catch {
    return null;
  }
}

/** After a storage migration renamed state keys (old key => new key): keep each dry-run summary under its new key. Never throws. */
export async function renameDrySummaries(keys) {
  for (const [from, to] of keys) {
    if (from === to) continue;
    try { await fs.rename(fileOf(from), fileOf(to)); }
    catch (err) { if (err.code !== 'ENOENT') log(`could not keep the dry-run summary of ${from}: ${err.message}`); }
  }
}
