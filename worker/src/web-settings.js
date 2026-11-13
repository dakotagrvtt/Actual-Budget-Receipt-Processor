// The Settings tab's file, data/web-settings.json (config.webSettingsPath): read it, work out what each setting is right
// now and where that comes from, check a change by building a trial config, and write changes atomically.
// The worker itself picks the file up at the start of each check (reloadConfig in config.js).
import fs from 'node:fs/promises';
import { config, buildConfig, extendedDaysProblem, localStorageIn } from './config.js';
import { withLock, writeJsonAtomic } from './file-lock.js';
import { readOverrides } from './web-overrides.js';
import { SETTINGS_BY_KEY, SettingError, defaultWith, normalizeValue } from './web-settings-schema.js';

/** The damaged-file refusal: nothing is written until the file is reset. */
export class DamagedSettingsError extends Error {}
const DAMAGED = 'The settings file (data/web-settings.json) is damaged, so nothing can be saved until it is reset. Press "Reset all to .env" on the Settings tab.';

/** The overrides file as it is now ({ values, changedAt, exists, damaged, ignored }); re-read on every call. */
export const loadOverrides = () => readOverrides(config.webSettingsPath);

/**
 * What a setting is right now: { value, source: 'page' | 'env' | 'default' }. 'page' is the Settings tab's file, 'env' is .env
 * (compose passes it in process.env), 'default' is the built-in default. value is the string as it would be written in .env.
 */
export function effectiveSetting(key, overrides = loadOverrides()) {
  const def = SETTINGS_BY_KEY.get(key);
  if (Object.hasOwn(overrides.values, key)) return { value: overrides.values[key], source: 'page' };
  if (process.env[key] !== undefined) return { value: process.env[key], source: 'env' };
  return { value: defaultWith(def, localStorageIn(process.env)), source: 'default' }; // STORAGE is .env-only, so process.env says
}

/** A list setting's current items (EXCLUDE_CATEGORY_GROUPS ...), parsed the way config.js parses it. */
const effectiveList = (key, overrides) => effectiveSetting(key, overrides).value.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The category exclusions as the Categories tab should show them: what is saved on the Settings tab if it sets them, else what the
 * worker is using. (A saved change reaches `config` at the start of the next check; the page shows it at once.)
 */
export function exclusionRules(overrides = loadOverrides()) {
  const pick = (key, current) => (Object.hasOwn(overrides.values, key) ? effectiveList(key, overrides) : current);
  return { excludeGroups: pick('EXCLUDE_CATEGORY_GROUPS', config.excludeGroups), excludeCategories: pick('EXCLUDE_CATEGORIES', config.excludeCategories) };
}

/** Check typed values and build a trial config with them. changes: { KEY: raw string }. Returns { values: normalized, candidate: the trial config }, or throws SettingError. */
export function checkChanges(changes, overrides = loadOverrides()) {
  const values = {};
  for (const [key, raw] of Object.entries(changes)) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) throw new SettingError(`${key} can't be changed from this page.`);
    values[key] = normalizeValue(def, raw);
  }
  if (['MATCH_NO_DATE_RECENT_DAYS', 'MATCH_NO_DATE_LOOKBACK_DAYS', 'MATCH_NO_DATE_EXTENDED_DAYS'].some((k) => k in values)) {
    const merged = { ...process.env, ...overrides.values, ...values };
    const n = (k, d) => (Number(merged[k] ?? d));
    const problem = extendedDaysProblem(n('MATCH_NO_DATE_RECENT_DAYS', 14), n('MATCH_NO_DATE_LOOKBACK_DAYS', 365), n('MATCH_NO_DATE_EXTENDED_DAYS', 120));
    if (problem) throw new SettingError(`${problem}.`);
  }
  try {
    return { values, candidate: buildConfig({ ...process.env, ...overrides.values, ...values }, { quiet: true }) };
  } catch (err) {
    throw new SettingError(`Those values don't work together: ${err.message}`);
  }
}

// A password is sent to the address next to it, so the two travel together: a new address needs its password typed again,
// and a password can't fall back to .env while the address is not .env's. Enforced where the file is written.
const PAIRS = { ACTUAL_SERVER_URL: ['ACTUAL_PASSWORD', 'ACTUAL_E2E_PASSWORD'], NEXTCLOUD_URL: ['NEXTCLOUD_APP_PASSWORD'] };
const RETYPE = 'Type the password again when you change the address.';
const sameAddress = (a, b) => String(a).trim().replace(/\/+$/, '') === String(b).trim().replace(/\/+$/, '');

/**
 * Throw a SettingError unless moving the overrides from `before` to `after` keeps every address with a password meant for it.
 * `typed`: the secrets typed in this same request. `restoring` (Undo) skips the "typed again" rule, not the fall-back rule.
 */
export function checkPairs(before, after, typed = [], restoring = false) {
  for (const [urlKey, secrets] of Object.entries(PAIRS)) {
    const addrBefore = effectiveSetting(urlKey, { values: before }).value;
    const addrAfter = effectiveSetting(urlKey, { values: after }).value;
    const addrEnv = effectiveSetting(urlKey, { values: {} }).value;
    const used = secrets.filter((k) => effectiveSetting(k, { values: after }).value !== '');
    if (!restoring && !sameAddress(addrBefore, addrAfter) && !sameAddress(addrAfter, addrEnv) && used.some((k) => !typed.includes(k))) throw new SettingError(RETYPE);
    if (!sameAddress(addrAfter, addrEnv) && used.some((k) => !Object.hasOwn(after, k))) throw new SettingError(RETYPE);
  }
}

/**
 * Change the overrides file under its lock. changes: { KEY: 'value' | null } (null = go back to .env). Values must already be
 * normalized. `typed`: secrets typed in this request (see checkPairs). Returns the earlier state of those keys
 * ({ KEY: 'value' | null }), for Undo. Refuses a damaged file.
 * A file left with no values is removed, so "the file exists" always means "something is set on the page".
 */
export async function changeOverrides(changes, { typed = [] } = {}) {
  return (await applyChanges(changes, { typed })).before;
}

/**
 * Undo: put `previous` ({ KEY: 'value' | null }) back, but only for a key whose override still is what `wrote` says that change
 * left there; any other key is skipped. Returns { skipped: [keys] }.
 */
export async function restoreOverrides(previous, wrote) {
  const { skipped } = await applyChanges(previous, { restoring: true, expect: wrote });
  return { skipped };
}

function applyChanges(changes, { typed = [], restoring = false, expect = null }) {
  return withLock(`${config.webSettingsPath}.lock`, async () => {
    const cur = loadOverrides();
    if (cur.damaged) throw new DamagedSettingsError(DAMAGED);
    const values = { ...cur.values };
    const before = {};
    const skipped = [];
    for (const [key, value] of Object.entries(changes)) {
      if (!SETTINGS_BY_KEY.has(key)) throw new SettingError(`${key} can't be changed from this page.`);
      const now = Object.hasOwn(values, key) ? values[key] : null;
      if (expect && now !== (expect[key] ?? null)) {
        skipped.push(key);
        continue;
      }
      before[key] = now;
      if (value === null) delete values[key];
      else values[key] = value;
    }
    checkPairs(cur.values, values, typed, restoring);
    await write(values);
    return { before, skipped };
  });
}

async function write(values) {
  if (Object.keys(values).length === 0) await fs.rm(config.webSettingsPath, { force: true });
  else await writeJsonAtomic(config.webSettingsPath, { values, changedAt: new Date().toISOString() });
}

/** Throw away everything set on the page (also the way out of a damaged file). Returns the values that were there ({} if it was damaged). Back to .env everywhere is always safe. */
export function resetAllOverrides() {
  return withLock(`${config.webSettingsPath}.lock`, async () => {
    const cur = loadOverrides();
    await write({});
    return cur.damaged ? {} : cur.values;
  });
}

/** Undo of a reset-all: each key comes back only if it is still not set on the page. Returns { skipped: [keys] }. */
export function restoreAllOverrides(values) {
  const known = Object.fromEntries(Object.entries(values).filter(([k]) => SETTINGS_BY_KEY.has(k)));
  return restoreOverrides(known, Object.fromEntries(Object.keys(known).map((k) => [k, null])));
}

/** Remove overrides for these keys (used by `./receipts exclude` via web-settings-cli.js). Returns the keys that were set. */
export async function unsetOverrides(keys) {
  const cur = loadOverrides();
  const set = keys.filter((k) => Object.hasOwn(cur.values, k));
  if (set.length === 0) return [];
  await changeOverrides(Object.fromEntries(set.map((k) => [k, null])));
  return set;
}
