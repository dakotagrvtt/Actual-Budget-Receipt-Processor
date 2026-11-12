// The pages that list things you can edit: categories (descriptions and exclusions), keywords and what the worker learned.
import { config } from './config.js';
import { isSolo, strengthOf } from './keywords.js';
import { MAX_DESCRIPTION } from './panel-actions.js';
import { escape, layout, post, toolbar, sortable, when, formAction } from './panel-layout.js';
import { underSettings } from './panel-settings-page.js';

const unique = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));

/** data: from categoriesData() { groups: [{ name, categories: [{ label, description, draft }] }], excluded: { groups: [{ name, labels }], categories: [{ label }] }, damaged } */
export function categoriesPage(data, key, notice, undo) {
  const exclude = (kind, field, name, text) => `<form ${post('category-exclude', key)}><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="${field}" value="${escape(name)}"><button class="small plain">${text}</button></form>`;
  const cards = data.groups
    .map((g) => `<section data-group><div class="grouphead"><h2>${escape(g.name)}</h2>${exclude('group', 'group', g.name, 'Exclude group')}</div>
${g.categories.map((c) => `<form class="card" data-row${c.draft ? ' data-draft="1"' : ''} ${post('category-save', key)}>
<input type="hidden" name="label" value="${escape(c.label)}">
<strong>${escape(c.label)}</strong> <span class="tag${c.draft || !c.description ? ' draft' : ''}">${!c.description ? 'no description yet' : c.draft ? 'draft (auto-written)' : 'written by you'}</span>
<textarea name="description" maxlength="${MAX_DESCRIPTION}" required aria-label="Description of ${escape(c.label)}">${escape(c.description)}</textarea>
<button class="small plain" data-act>Save</button> <button class="small plain" formaction="${formAction('category-exclude', key)}" name="kind" value="category" formnovalidate>Exclude</button>
</form>`).join('')}</section>`)
    .join('');
  const ex = data.excluded;
  const includeForm = (kind, field, name) => `<form ${post('category-include', key)}><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="${field}" value="${escape(name)}"><button class="small plain">Include again</button></form>`;
  const excludedRows = ex.groups.map((g) => `<li><div class="grouphead"><span><b>${escape(g.name)}</b> <span class="muted small">(whole group${g.labels.length ? `, ${g.labels.length} categor${g.labels.length === 1 ? 'y' : 'ies'}` : ''})</span></span>${includeForm('group', 'group', g.name)}</div></li>`)
    .concat(ex.categories.map((c) => `<li><div class="grouphead"><span>${escape(c.label)}</span>${includeForm('category', 'label', c.label)}</div></li>`))
    .join('');
  const body = `${data.damaged ? '<div class="banner live"><b>The settings file is damaged</b>Excluding and including can\'t be saved until it is reset on the Settings tab.</div>' : ''}<p class="muted">What belongs in each category. The model reads these when it picks one for each item, so household knowledge helps most ("Sam's clothes", "baby food goes to Child"). Saving marks a description as yours; the worker never rewrites those. Changes apply at the next check. Every spending category from Actual is listed, with an empty box when it has no description yet. Exclude a group or category that receipts should never go to (bills, debt, savings).</p>
${cards ? `${toolbar('cats', 'categories', { checks: [{ field: 'draft', text: 'Drafts only (auto-written)' }] })}<div id="cats">${cards}</div>` : `<p class="muted">No categories yet. They are listed after the first check that opens Actual.${config.reader.provider === 'remote' ? ' With a cloud reader nothing is written automatically (it would send category names, store names, amounts and item notes to it); run ./receipts describe to write the descriptions.' : ' Descriptions are written to the notes file at that check (or run ./receipts describe).'}</p>`}
<h2>Excluded</h2>
<p class="muted small">Receipts never go to these. Press "Include again" to allow one. The same lists are EXCLUDE_CATEGORY_GROUPS and EXCLUDE_CATEGORIES on the Settings tab. They apply at the next check.</p>
${excludedRows ? `<ul>${excludedRows}</ul>` : '<p class="muted">Nothing is excluded.</p>'}`;
  return layout({ active: 'categories', key, notice, body: underSettings(key, 'Categories', body), undo });
}

const SOURCES = { cli: 'command line', actual: 'tag in an Actual note', 'status page': 'this page', learned: 'learned (your corrections)' };

/** data: { keywords, categories: [label], mode } */
export function keywordsPage({ keywords, categories, mode }, key, notice, undo) {
  const off = mode === 'off'
    ? '<div class="banner live"><b>Keywords are currently ignored.</b>KEYWORD_MODE is off. Set KEYWORD_MODE=mixed in .env and run ./receipts restart to use them.</div>'
    : '';
  const rows = keywords
    .map((k) => `<tr data-row data-category="${escape(k.category)}"><td>${escape(k.phrase)}</td><td data-label="Category">${escape(k.category)}</td><td data-label="Store">${escape(k.store ?? 'any store')}</td><td data-label="Strength">${strengthOf(k)}</td>
<td class="small" data-label="From">${escape(SOURCES[k.from] ?? k.from ?? '')}${Number.isFinite(k.maxCents) ? `<br>${escape(`charges up to $${(k.maxCents / 100).toFixed(2)}`)}` : ''}${Number.isFinite(k.maxItemCents) ? `<br>${escape(`items up to $${(k.maxItemCents / 100).toFixed(2)}`)}` : ''}</td><td class="small" data-label="Added" data-sort="${escape(k.added ?? '')}">${escape(k.added ?? '')}</td>
<td data-act><form ${post('keyword-remove', key)}><input type="hidden" name="phrase" value="${escape(k.phrase)}"><input type="hidden" name="store" value="${escape(k.store ?? '')}"><button class="small plain">Remove</button></form></td></tr>`)
    .join('');
  const options = categories.map((c) => `<option>${escape(c)}</option>`).join('');
  const body = `${off}
<p class="muted"><b>always</b> files matching items in the category without asking the model; <b>usually</b> only gives the model a hint. (Both need KEYWORD_MODE=mixed; other modes treat every keyword the same way.)
Writing <code>#always gold bond</code> or <code>#usually gold bond</code> in an Actual transaction note adds a keyword from that transaction's category too.</p>
${keywords.length ? toolbar('keywords', 'keywords', { selects: [{ field: 'category', label: 'Category', all: 'All categories', values: unique(keywords.map((k) => k.category)) }] }) : ''}
<div class="list">${sortable('keywords', ['Phrase', 'Category', 'Store', 'Strength', 'From', ['Added', 'date'], ''], rows, 'No keywords yet', 'cards archived-cards')}</div>
<h2>Add a keyword</h2>
<form ${post('keyword-add', key)}>
<label for="phrase">Phrase</label><input type="text" id="phrase" name="phrase" maxlength="100" required placeholder="gold bond">
<label for="category">Category</label><select id="category" name="category" required>${options}</select>
<div class="row"><div><label for="store">Store (optional)</label><input type="text" id="store" name="store" maxlength="100" placeholder="any store"></div>
<div><label for="strength">Strength</label><select id="strength" name="strength"><option value="usually" selected>usually</option><option value="always">always</option></select></div></div>
<button class="keyword-add">Add keyword</button>
</form>`;
  return layout({ active: 'keywords', key, notice, body: underSettings(key, 'Category rules', body), undo });
}

const LEARNING_NOTES = {
  on: 'LEARNING=on: it learns from your corrections and uses what it learned.',
  record: 'LEARNING=record: it learns from your corrections but does not use it yet (for comparing).',
  off: 'LEARNING=off: it does not learn, and anything it learned is not used.',
};
const MAX_ITEMS_SHOWN_CHARS = 200; // a collapsed receipt can hold dozens of items; the row shows the start of the list
const KINDS = { item: 'one item', receipt: 'whole receipt', filled: 'filled in' };
const BROKEN = (error) => `<div class="banner live"><b>The learning files can't be read</b>${escape(error)}. Nothing is written over them; fix or delete the file and reload.</div>`;

/** Items moved together (a collapsed receipt) are one row with one Forget. */
function groupLessons(lessons) {
  const rows = [];
  const groups = new Map();
  for (const l of lessons) {
    if (isSolo(l)) {
      rows.push({ ...l, items: [l.item] });
      continue;
    }
    const k = `${l.txnId}|${l.group}|${l.filed}`;
    const g = groups.get(k);
    if (g) {
      g.items.push(l.item);
      if (g.said !== (l.said ?? null)) g.said = null;
    } else {
      const row = { ...l, said: l.said ?? null, plain: null, items: [l.item] };
      groups.set(k, row);
      rows.push(row);
    }
  }
  return rows;
}

/** data: { mode, lastSweep, watching, lessons: [{ id, date, store, payee, item, plain, said, filed, kind, count? }] } */
export function learnedPage({ mode, lastSweep, watching, lessons, error = null }, key, notice, undo) {
  const rowsOf = groupLessons(lessons);
  const rows = rowsOf
    .map((l) => `<tr data-row data-kind="${escape(l.kind)}"><td data-sort="${escape(l.date ?? '')}">${escape(l.date ?? '')}</td><td data-label="Store">${escape(l.payee ?? l.store ?? '')}</td><td data-label="Item">${l.items.length > 1 ? `<span class="muted">${l.items.length} items:</span> ${escape(l.items.join(', ').slice(0, MAX_ITEMS_SHOWN_CHARS))}` : `${escape(l.item)}${l.plain && l.plain.toLowerCase() !== String(l.item).toLowerCase() ? ` <span class="muted">(${escape(l.plain)})</span>` : ''}`}${l.count > 1 ? ` <span class="tag">${escape(l.count)}x</span>` : ''}</td>
<td data-label="It said → you filed">${l.said ? escape(l.said) : '<span class="muted">unsure</span>'} → <b>${escape(l.filed)}</b>${l.mergedInto ? ` <span class="muted small">(it was merged into ${escape(l.mergedInto)})</span>` : ''}</td><td class="small" data-label="Kind">${escape(KINDS[l.kind] ?? l.kind)}</td>
<td data-act><form ${post('lesson-forget', key)}><input type="hidden" name="id" value="${escape(l.id)}"><button class="small plain">Forget</button></form></td></tr>`)
    .join('');
  const kinds = unique(lessons.map((l) => l.kind));
  const body = `${error ? BROKEN(error) : ''}<p class="muted">${escape(LEARNING_NOTES[mode] ?? mode)} Last look at Actual: ${lastSweep ? escape(when(lastSweep)) : 'not yet'}; ${escape(watching)} charge(s) being watched.</p>
<p class="muted">When you change a category the worker filed in Actual, it notices and learns from it: you do not have to do anything. Press Forget on a line that was a one-off; it will not be learned again. Keywords it learned are on the Keywords page (From: learned) and can be removed there.</p>
${lessons.length ? toolbar('lessons', 'corrections', { selects: [{ field: 'kind', label: 'Kind', all: 'All kinds', values: kinds }] }) : ''}
${sortable('lessons', [['Date', 'date'], 'Store', 'Item', 'It said → you filed', 'Kind', ''], rows, 'Nothing learned yet', 'cards archived-cards')}`;
  return layout({ active: 'learned', key, notice, body: underSettings(key, 'Learned corrections', body), undo });
}
