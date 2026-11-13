// What the Settings tab's buttons do, and the exclude buttons on the Categories tab (both write data/web-settings.json).
// Same shape as panel-actions.js: each handler takes the submitted form, returns a short notice, or throws PanelError.
// A change takes effect at the start of the next check (the worker reloads its config then); nothing here touches the running config.
import crypto from 'node:crypto';
import { config, localStorageIn, reloadStatus, buildConfig } from './config.js';
import { identityOf, recordedStorage, sameStorage, nothingOwed } from './storage-state.js';
import { PanelError, offerUndo, checkUndo, categoriesData, UNDO_WINDOW_MS } from './panel-actions.js';
import { SECTIONS, SETTINGS, SETTINGS_BY_KEY, SettingError, ENV_ONLY_NOTE, defaultWith, normalizeValue, usedWith } from './web-settings-schema.js';
import { loadOverrides, effectiveSetting, exclusionRules, checkChanges, checkPairs, changeOverrides, restoreOverrides, resetAllOverrides, restoreAllOverrides, DamagedSettingsError } from './web-settings.js';
import { knownAccounts } from './known-accounts.js';
import { testChanged, ConnectionTestError } from './connection-test.js';
import { settingsSection } from './panel-settings-page.js';

const MAX_REMEMBERED = 20;
/** Stand-ins for the network in tests: { fetchFn, createClientFn }. */
export const testDeps = {};
const SAVED = 'Saved. It applies at the start of the next check.';
const DAMAGED = 'The settings file is damaged, so nothing can be saved until it is reset. Press "Reset all to .env" on the Settings tab.';
// Fields a settings form carries besides the settings themselves.
const FORM_EXTRAS = new Set(['section', 'anyway', 'confirm', 'reset', 'storage-change']);

// ---- Undo: what a Settings change replaces is kept here, in memory, under a random id. The Undo link carries only the id (signed),
// so a password's old value never travels in a link or a page. A restart forgets them (an Undo lasts 15 minutes anyway). ----
const remembered = new Map();
const restoring = new Set();
function remember(entry) {
  const now = Date.now();
  for (const [id, e] of remembered) if (now - e.at > UNDO_WINDOW_MS) remembered.delete(id);
  while (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
  const id = crypto.randomBytes(8).toString('hex');
  remembered.set(id, { ...entry, at: now });
  return id;
}
// The Undo of a Settings save also carries (signed) the section page it was made on, so pressing it comes back to that page.
const withSection = (form) => { const section = settingsSection(form?.get?.('section')); return section ? { section } : {}; };
const offerSettingsUndo = (out, route, entry, form = null) => offerUndo(out, route, { id: remember(entry), ...withSection(form) });

/** Run a file change; a damaged file or a bad value becomes a message for the page. */
async function guarded(change) {
  try {
    return await change();
  } catch (err) {
    if (err instanceof DamagedSettingsError || err instanceof SettingError || err instanceof ConnectionTestError) throw new PanelError(err.message);
    if (/^file is locked/.test(err.message)) throw new PanelError('The settings file is busy. Try again in a moment.');
    throw err;
  }
}

/** Nothing can be saved while the settings file is damaged. */
function refuseIfDamaged(overrides) {
  if (overrides.damaged) throw new DamagedSettingsError(DAMAGED);
}

function refuseUnknownKeys(form) {
  for (const name of new Set(form.keys())) {
    if (SETTINGS_BY_KEY.has(name) || FORM_EXTRAS.has(name)) continue;
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) throw new PanelError(`${name}: ${ENV_ONLY_NOTE}`);
  }
}
const keyFrom = (value) => {
  if (!SETTINGS_BY_KEY.has(value)) throw new PanelError(`${String(value).slice(0, 60)}: ${ENV_ONLY_NOTE}`);
  return value;
};

/** The value to compare a typed one with: the current value in its normalized form (so ".env says MIXED" equals "mixed"). */
function sameAsCurrent(def, current, typed) {
  if (def.type === 'secret') return current === typed;
  try {
    return normalizeValue(def, current) === typed;
  } catch {
    return false; // a current value that doesn't pass (a typo in .env) is replaced by whatever valid value is typed
  }
}

/**
 * A save or reset that changes where the receipts are (the Nextcloud address or login, or a receipt folder) pauses the worker until
 * ./receipts migrate-storage runs. Say so first; null when the storage stays the same, goes back to the recorded one, or nothing
 * is recorded there yet (a fresh install: the worker records the new one by itself). tick: how to confirm it.
 */
async function storageChangeProblem(candidate, overrides, tick = 'Tick "Save a change of storage or folders" to save it.') {
  const next = identityOf(candidate);
  let now = null;
  try { now = identityOf(buildConfig({ ...process.env, ...overrides.values }, { quiet: true })); } catch { /* the current settings don't build: compare with the record only */ }
  if (now && sameStorage(now, next)) return null;
  const recorded = await recordedStorage().catch(() => null);
  if (recorded && sameStorage(recorded, next)) return null;
  if (recorded && await nothingOwed(recorded).catch(() => false)) return null;
  return `This changes where the receipt files are (the Nextcloud address or login, or a receipt folder). Nothing was changed. After such a change the worker pauses until you run ./receipts migrate-storage: it moves the files to the new folders, or copies them to another storage, and updates the records. ${tick}`;
}
/** The config a reset would give (the overrides without `keys`, or none); null when it does not build (the worker says why). */
function configWithout(overrides, keys) {
  const values = keys ? Object.fromEntries(Object.entries(overrides.values).filter(([k]) => !keys.includes(k))) : {};
  try { return buildConfig({ ...process.env, ...values }, { quiet: true }); } catch { return null; }
}

/** Save one section of the Settings tab. Only values that differ from the current ones are written. */
export function saveSettings(form, out) {
  return guarded(async () => {
    refuseUnknownKeys(form);
    const overrides = loadOverrides();
    refuseIfDamaged(overrides);
    const typed = {};
    const retyped = []; // secrets typed in this request, even when equal to the current one
    const local = localStorageIn(process.env);
    for (const def of SETTINGS) {
      if (!form.has(def.key) || !usedWith(def, local)) continue; // the Nextcloud login is not on the page with a local folder
      const all = form.getAll(def.key);
      const raw = all[all.length - 1]; // a checkbox sends a hidden "false" first, then "true" when ticked
      if (def.type === 'secret' && raw === '') continue; // an empty password box means keep the current one
      if (def.type === 'enum' && raw === '') continue;
      const current = effectiveSetting(def.key, overrides).value;
      if (def.type !== 'secret' && raw === current) continue; // untouched: a value .env has that this page wouldn't accept must not block the rest
      const value = normalizeValue(def, raw);
      if (def.type === 'secret') retyped.push(def.key);
      if (def.type === 'secret' || !sameAsCurrent(def, current, value)) typed[def.key] = value;
    }
    const keys = Object.keys(typed);
    if (keys.length === 0) return 'Nothing was different, so nothing was saved.';
    const { candidate } = checkChanges(typed, overrides);
    checkPairs(overrides.values, { ...overrides.values, ...typed }, retyped); // before any test: nothing is sent to a new address with an old password
    if (form.get('anyway') !== 'yes') {
      try {
        await testChanged(keys, candidate, testDeps);
      } catch (err) {
        if (!(err instanceof ConnectionTestError)) throw err;
        throw new PanelError(`${err.message} Nothing was saved. Tick "Save even if the connection test fails" to save it anyway.`);
      }
    }
    if (form.get('storage-change') !== 'yes') {
      const problem = await storageChangeProblem(candidate, overrides);
      if (problem) throw new PanelError(problem);
    }
    const before = await changeOverrides(typed, { typed: retyped });
    offerSettingsUndo(out, 'undo-settings', { kind: 'keys', before, wrote: typed }, form);
    return SAVED;
  });
}

/** "Use the .env value": drop one setting's override. */
export function resetSetting(form, out) {
  return guarded(async () => {
    const key = keyFrom(form.get('reset'));
    const overrides = loadOverrides();
    refuseIfDamaged(overrides);
    if (!Object.hasOwn(overrides.values, key)) return `${SETTINGS_BY_KEY.get(key).label} already uses the .env value.`;
    const candidate = form.get('storage-change') === 'yes' ? null : configWithout(overrides, [key]);
    const problem = candidate && await storageChangeProblem(candidate, overrides, 'Tick "Save a change of storage or folders" under Save options, then press "Use setup value" again.');
    if (problem) throw new PanelError(problem);
    const before = await changeOverrides({ [key]: null });
    offerSettingsUndo(out, 'undo-settings', { kind: 'keys', before, wrote: { [key]: null } }, form);
    return `${SETTINGS_BY_KEY.get(key).label} uses the .env value again. It applies at the start of the next check.`;
  });
}

/** "Reset all to .env": replace the whole file (also the way out of a damaged one). A working file needs the box ticked. */
export function resetAllSettings(form, out) {
  return guarded(async () => {
    const overrides = loadOverrides();
    if (!overrides.damaged && form.get('confirm') !== 'yes') throw new PanelError('Tick the box to confirm resetting every setting on this page to its .env value.');
    if (!overrides.damaged && !overrides.exists) return 'Nothing was set on this page.';
    // A damaged file is already out of use (setup values apply), so its reset changes nothing about the storage.
    const candidate = overrides.damaged || form.get('storage-change') === 'yes' ? null : configWithout(overrides, null);
    const problem = candidate && await storageChangeProblem(candidate, overrides, 'Tick "Also reset a change of storage or folders" to reset anyway.');
    if (problem) throw new PanelError(problem);
    const was = await resetAllOverrides();
    if (!overrides.damaged && Object.keys(was).length) offerSettingsUndo(out, 'undo-settings', { kind: 'all', values: was }, form);
    return overrides.damaged ? 'The damaged settings file was replaced. Every setting uses its .env value again.' : 'Every setting uses its .env value again. It applies at the start of the next check.';
  });
}

/** Undo a Settings save, reset or exclusion: the earlier override state of those keys comes back. */
async function undoFromMemory(route, form, out = {}) {
  checkUndo(route, form);
  const id = form.get('id') ?? '';
  const entry = remembered.get(id);
  if (!entry || Date.now() - entry.at > UNDO_WINDOW_MS) return 'That Undo has expired (it is kept for 15 minutes while the worker runs), so nothing was changed.';
  if (restoring.has(id)) throw new PanelError('That Undo is already running. Wait for it to finish.');
  restoring.add(id);
  try {
    const { skipped } = await guarded(async () => {
      refuseIfDamaged(loadOverrides());
      return entry.kind === 'all' ? restoreAllOverrides(entry.values) : restoreOverrides(entry.before, entry.wrote);
    });
    remembered.delete(id); // one successful use; a refused write can still be retried
    const total = entry.kind === 'all' ? Object.keys(entry.values).length : Object.keys(entry.before).length;
    const notPut = skipped.map((k) => `${SETTINGS_BY_KEY.get(k).label} has changed since, so it was not put back.`).join(' ');
    if (!skipped.length) return 'Restored the earlier settings.';
    return skipped.length < total ? `Restored the earlier settings, except: ${notPut}` : notPut;
  } catch (err) {
    if (err instanceof PanelError && Date.now() - entry.at <= UNDO_WINDOW_MS) offerUndo(out, route, { id, ...withSection(form) });
    throw err;
  } finally {
    restoring.delete(id);
  }
}
export const undoSettings = (form, out) => undoFromMemory('undo-settings', form, out);
export const undoExclude = (form, out) => undoFromMemory('undo-exclude', form, out);

// ---- Categories tab: Exclude / Include again ----

/** Write one exclusion list (EXCLUDE_CATEGORY_GROUPS or EXCLUDE_CATEGORIES), starting from its effective value. */
function writeExclusions(key, items, out) {
  return guarded(async () => {
    const overrides = loadOverrides();
    refuseIfDamaged(overrides);
    const { values } = checkChanges({ [key]: items.join(',') }, overrides);
    const before = await changeOverrides(values);
    offerSettingsUndo(out, 'undo-exclude', { kind: 'keys', before, wrote: values });
  });
}

function target(form) {
  const kind = form.get('kind');
  if (kind !== 'group' && kind !== 'category') throw new PanelError('Unknown kind.');
  const name = (kind === 'group' ? form.get('group') : form.get('label')) ?? '';
  if (!name || name.length > 300) throw new PanelError('Unknown category.');
  if (name.includes(',')) throw new PanelError('A name with a comma can\'t be excluded here (the list is comma-separated).');
  return { kind, name, key: kind === 'group' ? 'EXCLUDE_CATEGORY_GROUPS' : 'EXCLUDE_CATEGORIES', rule: kind === 'group' ? 'excludeGroups' : 'excludeCategories' };
}

export async function excludeCategory(form, out) {
  const { kind, name, key, rule } = target(form);
  const data = categoriesData();
  const known = kind === 'group' ? data.groups.map((g) => g.name) : data.groups.flatMap((g) => g.categories.map((c) => c.label));
  if (!known.includes(name)) throw new PanelError(`That ${kind} isn't in the list.`);
  const list = exclusionRules()[rule];
  await writeExclusions(key, [...list, name], out);
  return `Excluded the ${kind} "${name}". Receipts won't be filed there from the next check. It is listed under Excluded below.`;
}

export async function includeCategory(form, out) {
  const { kind, name, key, rule } = target(form);
  const list = exclusionRules()[rule];
  if (!list.includes(name)) throw new PanelError(`"${name}" isn't excluded.`);
  await writeExclusions(key, list.filter((x) => x !== name), out);
  return `Included the ${kind} "${name}" again. Receipts can be filed there from the next check.`;
}

// ---- What the Settings page shows ----

/**
 * The Settings page's data. A secret never gets a `value`: only `isSet`.
 * { sections: [{ id, title, settings: [{ key, label, type, help, default, source, advanced, value | isSet, min, max, values }] }], damaged, exists, changedAt, reloadError, ignored }
 */
export function settingsData() {
  const overrides = loadOverrides();
  const local = localStorageIn(process.env);
  const sections = SECTIONS.map((s) => ({
    ...s,
    settings: SETTINGS.filter((d) => d.section === s.id && usedWith(d, local)).map((d) => {
      const e = effectiveSetting(d.key, overrides);
      const shared = { key: d.key, label: d.label, type: d.type, help: d.help, default: defaultWith(d, local), source: e.source, advanced: Boolean(d.advanced), required: Boolean(d.required), min: d.min, max: d.max, int: d.int, values: d.values, ...(d.type === 'account' ? { choices: knownAccounts().map((a) => a.name) } : {}) };
      return d.type === 'secret' ? { ...shared, isSet: e.value !== '' } : { ...shared, value: e.value };
    }),
  }));
  const storage = { kind: local ? 'local' : 'nextcloud', hostDir: config.storage.hostDir };
  return { sections, storage, damaged: overrides.damaged, exists: overrides.exists, changedAt: overrides.changedAt, ignored: overrides.ignored, reloadError: reloadStatus.error };
}
