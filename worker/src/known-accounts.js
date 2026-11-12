// The open on-budget accounts Actual had at the last check (data/known-accounts.json, next to the category notes), so the Settings tab can
// offer them for "Cash purchases go to" even right after a restart.
// File: { "at": ISO time, "accounts": [{ "name": "Checking", "offbudget": false }, ...] }
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeJsonAtomic } from './file-lock.js';

const file = () => path.join(path.dirname(config.categoryNotesPath), 'known-accounts.json');
let latest = null; // the newest list written by this process, in case the file can't be written or read

/** Remember the accounts ([{ id, name }], from actual.openAccounts()) from this check. The id is only for "Open in Actual" links. */
export async function rememberAccounts(rows) {
  const accounts = rows.map(({ id, name }) => (typeof id === 'string' ? { id, name } : { name }));
  latest = { file: file(), accounts };
  await writeJsonAtomic(file(), { at: new Date().toISOString(), accounts });
}

/** The accounts from the last check: [{ name, id? }]; [] before the first check. */
export function knownAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(j.accounts)) return j.accounts.filter((a) => typeof a?.name === 'string');
  } catch { /* not written yet, or unreadable: fall through */ }
  return latest?.file === file() ? latest.accounts : [];
}
