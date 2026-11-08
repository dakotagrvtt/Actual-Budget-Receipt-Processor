// Category descriptions (data/category-notes.json): what goes in each spending category.
// The decider chooses among these, so they carry the household knowledge it can't guess.
//
// File format, keyed by "Group / Category":
//   "Daily Expenses / Sam": "Sam's clothes, movies, ..."                       ← written by you
//   "Daily Expenses / Child": { "description": "...", "auto": true, ... }         ← written by the reader model, for you to review
// A plain string, or an entry without "auto": true, is yours and is never overwritten.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, log } from './config.js';
import { withLock, writeJsonAtomic } from './file-lock.js';
import { today } from './dates.js';

export function loadCategoryNotes() {
  try {
    return JSON.parse(fs.readFileSync(config.categoryNotesPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not read ${config.categoryNotesPath}: ${err.message}`);
    return {};
  }
}

/**
 * Labels receipts may use: everything except EXCLUDE_CATEGORY_GROUPS / EXCLUDE_CATEGORIES (bills, debt, savings).
 * `rules` is { excludeGroups, excludeCategories }: the config by default; the Categories tab passes what is saved
 * on the Settings tab, which is not in the config until the next check.
 */
export function receiptLabels(labels, rules = config) {
  // A group name may itself contain " / " ("Bills / Utilities"), so test the label's start, not its first part.
  return labels.filter((l) => !rules.excludeGroups.some((g) => l.startsWith(`${g} / `)) && !rules.excludeCategories.includes(l));
}

/** label → description text, whoever wrote it. */
export function categoryDescriptions() {
  const notes = loadCategoryNotes();
  return Object.fromEntries(
    Object.entries(notes)
      .map(([label, v]) => [label, typeof v === 'string' ? v : v?.description])
      .filter(([, text]) => typeof text === 'string' && text.trim()),
  );
}

/**
 * Change the notes file safely while the worker may be writing it too: lock, read it fresh, let fn edit the notes,
 * write atomically. fn returns false to skip the write. A file that can't be parsed is never overwritten.
 */
export function updateNotes(fn) {
  return withLock(`${config.categoryNotesPath}.lock`, async () => {
    let notes = {};
    try {
      notes = JSON.parse(await fsp.readFile(config.categoryNotesPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`could not read ${config.categoryNotesPath}: ${err.message}`);
    }
    if (fn(notes) === false) return false;
    await writeJsonAtomic(config.categoryNotesPath, notes);
    return true;
  });
}

/**
 * Save a description you wrote. The entry stops being a draft (no "auto": true), so the worker never rewrites it.
 * Other fields are kept (previous, basedOn, ...); a plain string stays a plain string.
 * Returns false for a category that isn't in the file, unless `create` is true (a category Actual has but the file doesn't yet).
 */
export function saveUserNote(label, description, by = 'you (status page)', create = false) {
  const text = String(description).trim();
  if (!text) throw new Error('The description can\'t be empty.');
  return updateNotes((notes) => {
    if (!Object.hasOwn(notes, label)) {
      if (!create) return false;
      notes[label] = { description: text, auto: false, writtenBy: by, written: today() };
      return true;
    }
    const cur = notes[label];
    if (typeof cur === 'string') {
      if (cur === text) return false;
      notes[label] = text;
    } else {
      notes[label] = { ...(cur ?? {}), description: text, auto: false, writtenBy: by, written: today() };
    }
    return true;
  });
}

/**
 * Undo a save: put back the earlier description and its draft flag (and who wrote it, when). A plain-string entry stays
 * a plain string. Returns false for a category that isn't in the file. An empty description puts back "no description yet".
 */
export function restoreNote(label, { description, auto, writtenBy, written }) {
  return updateNotes((notes) => {
    if (!Object.hasOwn(notes, label)) return false;
    const cur = notes[label];
    if (typeof cur === 'string' && !auto) {
      notes[label] = description;
      return true;
    }
    const next = { ...(typeof cur === 'string' ? {} : cur), description, auto: Boolean(auto) };
    for (const [k, v] of Object.entries({ writtenBy, written })) {
      if (v) next[k] = v;
      else delete next[k];
    }
    notes[label] = next;
    return true;
  });
}

/** Is this notes entry a draft written by the model (still open to being rewritten)? */
export const isDraft = (v) => typeof v === 'object' && v !== null && v.auto === true;
