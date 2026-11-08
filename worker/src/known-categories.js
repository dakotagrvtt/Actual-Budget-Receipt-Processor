// The spending categories Actual had at the last check (data/known-categories.json, next to the category notes), so the
// status page's Categories tab can list every category, with or without a description, even right after a restart.
// File: { "at": ISO time, "categories": [{ "group": "Daily Expenses", "label": "Daily Expenses / Sam" }, ...] }
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeJsonAtomic } from './file-lock.js';

const file = () => path.join(path.dirname(config.categoryNotesPath), 'known-categories.json');
let latest = null; // the newest list written by this process, in case the file can't be written or read

/** Remember the spending categories ([{ group, label }], from actual.spendingCategories()) from this check. */
export async function rememberCategories(rows) {
  const categories = rows.map(({ group, label }) => ({ group, label }));
  latest = { file: file(), categories };
  await writeJsonAtomic(file(), { at: new Date().toISOString(), categories });
}

/** The categories from the last check: [{ group, label }], in Actual's order; [] before the first check. */
export function knownCategories() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(j.categories)) return j.categories.filter((c) => typeof c?.label === 'string' && typeof c?.group === 'string');
  } catch { /* not written yet, or unreadable: fall through */ }
  return latest?.file === file() ? latest.categories : [];
}
