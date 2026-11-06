// Category descriptions (data/category-notes.json): what goes in each spending category.
// The decider chooses among these, so they carry the household knowledge it can't guess.
//
// File format, keyed by "Group / Category":
//   "Daily Expenses / Adult 2": "Adult 2's clothes, movies, ..."                       ← written by you
//   "Daily Expenses / Child": { "description": "...", "auto": true, ... }         ← written by the reader model, for you to review
// A plain string, or an entry without "auto": true, is yours and is never overwritten.
import fs from 'node:fs';
import { config, log } from './config.js';

export function loadCategoryNotes() {
  try {
    return JSON.parse(fs.readFileSync(config.categoryNotesPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not read ${config.categoryNotesPath}: ${err.message}`);
    return {};
  }
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
