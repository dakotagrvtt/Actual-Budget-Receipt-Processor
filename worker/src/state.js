// What the worker remembers between polls: state.json (one entry per inbox file) and the heartbeat file.
// The key of an entry is the file name plus its etag, so a re-uploaded file is a new receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export async function loadState() {
  try {
    return JSON.parse(await fs.readFile(config.statePath, 'utf8'));
  } catch {
    return {};
  }
}
// Write to a temp file and rename it over state.json, so a crash mid-write can't leave half a file.
export async function saveState(state) {
  const tmp = path.join(path.dirname(config.statePath), `.${path.basename(config.statePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, config.statePath);
}
export const heartbeat = () => fs.writeFile(config.heartbeatPath, new Date().toISOString()).catch(() => {});

// Dry-run results are tracked separately, so turning DRY_RUN off processes those receipts for real.
export const stateKey = (item) => `${config.dryRun ? 'dry:' : ''}${item.filename}@${item.etag}`;
/** stateKey() taken apart: { dry, file } (the file name as it was in the inbox, without the etag). */
export function parseStateKey(key) {
  const dry = key.startsWith('dry:');
  const rest = dry ? key.slice(4) : key;
  const at = rest.indexOf('@');
  return { dry, file: at < 0 ? rest : rest.slice(0, at) };
}

/** Is this inbox file due? New, retrying, waiting with its re-check time up (or a manual check), or waiting to be moved. */
export function isDue(entry, now, recheckAll) {
  if (!entry) return true;
  if (entry.done) return false;
  if (entry.folder || !entry.waiting) return true;
  return recheckAll || Date.parse(entry.waiting.nextCheck) <= now;
}
