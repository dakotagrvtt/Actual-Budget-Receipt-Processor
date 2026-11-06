// Writes descriptions for spending categories that have none yet, from what the household filed there. The reader
// model writes them for you to review; see category-notes.js for the file format.
import fs from 'node:fs';
import { config, log } from './config.js';
import { today } from './dates.js';
import * as actual from './actual.js';
import { chatJson, waitForModel } from './llm.js';
import { ruleStoresByCategory } from './rules.js';
import { loadCategoryNotes } from './category-notes.js';

const SYSTEM = `You write short descriptions of a household's budget categories, based on what they actually filed there.
- One sentence, under 25 words, listing the kinds of purchases and typical stores.
- If the category is a person's name, say it is that person's own purchases and what kinds.
- Describe kinds of things, not dates or amounts. Don't invent anything the transactions don't show.
- Reply with only the JSON object.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: { description: { type: 'string' } },
};

function prompt(label, activity, ruleStores) {
  const stores = [...activity.stores].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([s, n]) => `${s} (${n}×)`);
  const amounts = activity.amounts.sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)].toFixed(2) : 'n/a';
  return `Budget category: "${label}"
Transactions filed here in the last ${config.history.days} days: ${activity.count} (median ${median})
Stores your Actual rules send here automatically: ${ruleStores?.join(', ') || 'none'}
Stores: ${stores.join(', ') || 'none recorded'}
Item notes the household wrote: ${activity.notes.slice(0, 30).join('; ') || 'none'}

Return {"description": "..."}.`;
}

/**
 * Write descriptions for spending categories that don't have one (or, with refresh, regenerate the auto ones).
 * Categories with no transactions to learn from are skipped. Writes only data/category-notes.json.
 * Returns the labels it wrote.
 */
export async function describeMissing(labels, labelToId, { refresh = false } = {}) {
  const notes = loadCategoryNotes();
  const todo = labels.filter((l) => {
    const v = notes[l];
    if (v == null || (typeof v === 'object' && !v.description)) return true;
    return refresh && typeof v === 'object' && v.auto === true;
  });
  if (todo.length === 0) return [];

  const activity = await actual.categoryActivity(todo.map((l) => labelToId.get(l)));
  const ruleStores = ruleStoresByCategory(await actual.payeeNames());
  await waitForModel();
  const written = [];
  for (const label of todo) {
    const a = activity.get(labelToId.get(label));
    if (!a || a.count === 0) {
      log(`  ${label}: no transactions to learn from yet; skipped`);
      continue;
    }
    const check = (v) => {
      if (typeof v?.description !== 'string' || v.description.trim().length < 5) throw new Error('empty description');
      return v;
    };
    const { value } = await chatJson([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(label, a, ruleStores.get(labelToId.get(label))) }], SCHEMA, check);
    notes[label] = { description: value.description.trim(), auto: true, basedOn: `${a.count} transactions`, written: today() };
    written.push(label);
    log(`  ${label}: ${notes[label].description}`);
    fs.writeFileSync(config.categoryNotesPath, `${JSON.stringify(notes, null, 2)}\n`); // save as we go
  }
  return written;
}
