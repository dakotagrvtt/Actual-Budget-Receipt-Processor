// The HTML of the control panel (status, go-live, categories, keywords, learned, settings, privacy, receipt view). Pure functions:
// data in, string out; trigger.js fetches the data and serves the page. Everything user-controlled goes through escape().
import { config } from './config.js';
import { isSolo, strengthOf } from './keywords.js';
import { retryStatus, MAX_DESCRIPTION } from './panel-actions.js';
import { SCRIPT, hashOf } from './panel-script.js';

export const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Who runs the name and place scan, for the Privacy page: the cloud reader when there is one. */
const scanWhere = () => (config.reader.provider === 'remote' ? `the cloud reader (${escape(config.reader.host)}, CLOUD_NAME_SCAN=true; the raw text is sent to it)` : 'the reader model on this machine');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: config.trigger.timeZone }) : '');

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--accent:#2f6fde;--warn:#b25000;--warnbg:#fff4e5;--okbg:#e8f5e9}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#98989d;--line:#3a3a3c;--accent:#5e9bff;--warn:#ffb866;--warnbg:#3a2a14;--okbg:#17301b}}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:48rem;margin:1.5rem auto;padding:0 16px}
h1{font-size:1.3rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.5rem 0 .25rem}.muted{color:var(--muted)}.small{font-size:.85rem}
nav{display:flex;gap:.25rem;flex-wrap:wrap;margin:0 0 1rem;border-bottom:1px solid var(--line)}
nav a{padding:.4rem .8rem;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}
nav a.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;margin:.5rem 0}
button.small{padding:.25rem .7rem;margin:0}button.plain{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.danger{background:#c0392b}
input[type=text],select,textarea{font:inherit;width:100%;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:5.5rem;resize:vertical}label{display:block;margin:.6rem 0 .15rem;font-weight:600;font-size:.9rem}
.notice{padding:.5rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--okbg)}
.banner{padding:.6rem .8rem;border-radius:8px;border:1px solid var(--line);margin:.5rem 0}
.banner.live{background:var(--warnbg);border-color:var(--warn)}.banner b{display:block}
.card{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;margin:.6rem 0}
.tag{display:inline-block;font-size:.75rem;padding:.05rem .5rem;border:1px solid var(--line);border-radius:99px;color:var(--muted)}
.tag.draft{color:var(--warn);border-color:var(--warn)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
td form{margin:0}.check{display:flex;gap:.5rem;align-items:flex-start;margin:.8rem 0}.check input{margin-top:.3rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap}.row>*{flex:1 1 10rem}
[hidden]{display:none!important}
.tools{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.4rem 0}.tools>input,.tools>select{flex:1 1 9rem;width:auto}
.tools label{display:flex;gap:.4rem;align-items:center;margin:0;font-weight:400;flex:0 0 auto}
th.sortable{cursor:pointer;white-space:nowrap;user-select:none}
.notice form{display:inline;margin-left:.5rem}.notice button{margin:0}
.photo{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:.5rem 0}
.setting{border-top:1px solid var(--line);padding:.4rem 0 .6rem}.setting label{margin:.2rem 0}.setting .help{margin:.2rem 0}
.setting .check{margin:.2rem 0}.setting .check label{margin:0;font-weight:600}
.setting .actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.nobtn{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.grouphead{display:flex;gap:.5rem;align-items:center;justify-content:space-between;flex-wrap:wrap}.grouphead h2{margin:1.2rem 0 .25rem}
input[type=password],input[type=number]{font:inherit;width:100%;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
`;

/** The Content-Security-Policy for every page: only the one inline style and the one inline script (by hash), forms only to this server. */
export const CSP = `default-src 'none'; style-src ${hashOf(CSS)}; script-src ${hashOf(SCRIPT)}; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** The page frame: head, title, top navigation, optional notice. `active` is 'status' | 'categories' | 'keywords' | 'learned' | 'settings' | 'privacy'. */
export function layout({ active, key, notice, body, undo }) {
  const k = `?key=${encodeURIComponent(key)}`;
  const link = (id, href, text) => `<a href="${href}${escape(k)}"${active === id ? ' class="on"' : ''}>${text}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipts</title><style>${CSS}</style></head><body>
<h1>Receipts</h1>
<nav>${link('status', './', 'Status')}${link('categories', 'categories', 'Categories')}${link('keywords', 'keywords', 'Keywords')}${link('learned', 'learned', 'Learned')}${link('settings', 'settings', 'Settings')}${config.decider.provider === 'remote' ? link('privacy', 'privacy', 'Privacy') : ''}</nav>
${noticeHtml(notice, undo, key)}
${body}
<script>${SCRIPT}</script>
</body></html>`;
}

/** The notice line; after a removal it carries an Undo button (a POST form with what is needed to put the item back). */
function noticeHtml(notice, undo, key) {
  if (!notice) return '';
  if (!undo) return `<p class="notice">${escape(notice)}</p>`;
  const fields = Object.entries(undo.fields).map(([n, v]) => `<input type="hidden" name="${escape(n)}" value="${escape(v)}">`).join('');
  return `<div class="notice">${escape(notice)}<form ${post(undo.route, key)}>${fields}<button class="small plain">Undo</button></form></div>`;
}

const post = (action, key) => `method="post" action="${action}?key=${escape(encodeURIComponent(key))}"`;

/** A filter bar for the rows of #id: text box, optional dropdowns and checkboxes. Hidden until the script runs. */
function toolbar(id, label, { selects = [], checks = [] } = {}) {
  const sels = selects.map((s) => `<select data-field="${escape(s.field)}" aria-label="${escape(s.label)}"><option value="">${escape(s.all)}</option>${s.values.map((v) => `<option value="${escape(v)}">${escape(v)}</option>`).join('')}</select>`).join('');
  const boxes = checks.map((c) => `<label><input type="checkbox" data-field="${escape(c.field)}"> ${escape(c.text)}</label>`).join('');
  return `<div class="tools" data-tools="${escape(id)}" hidden><input type="text" data-q placeholder="Filter ${escape(label)}" aria-label="Filter ${escape(label)}" autocomplete="off">${sels}${boxes}</div>`;
}
/** A sortable table. cols: ['Name', ['Added', 'date'], ''] (an empty title is not sortable). */
function sortable(id, cols, rows, empty) {
  const th = cols.map((c) => (Array.isArray(c) ? `<th data-type="${c[1]}">${c[0]}</th>` : `<th>${c}</th>`)).join('');
  return `<div class="scroll"><table id="${escape(id)}" data-sortable><thead><tr>${th}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
}
const unique = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b));

/** The dry run / live banner. `pending` = the mode saved in settings when it differs from the one the worker is using. */
function modeBanner({ dryRun, pending, settings, envNote, apiNote }, key) {
  const now = dryRun
    ? '<div class="banner"><b>Dry run</b>The worker only logs what it would do. Nothing changes in Actual or Nextcloud.</div>'
    : '<div class="banner live"><b>Live</b>The worker writes to Actual and moves files in Nextcloud.</div>';
  const soon = pending === null || pending === undefined
    ? ''
    : `<p class="muted small">Switching to ${pending ? 'dry run' : 'live'} at the start of the next check.</p>`;
  const by = settings ? `<p class="muted small">Last changed ${escape(when(settings.changedAt))}${settings.changedBy ? ` from ${escape(settings.changedBy)}` : ''}.</p>` : '';
  const env = (envNote ? `<p class="muted small">${escape(envNote)}</p>` : '') + (apiNote ? `<p class="muted small">${escape(apiNote)}</p>` : '');
  const button = dryRun
    ? `<form method="get" action="go-live"><input type="hidden" name="key" value="${escape(key)}"><button class="plain">Go live...</button></form>`
    : `<form ${post('mode', key)}><input type="hidden" name="mode" value="dry"><button class="plain">Switch to dry run</button></form>`;
  return now + soon + by + env + button;
}

function resultText(r) {
  if (r.done) return r.result;
  if (r.waiting) return `waiting for the bank charge (next check ${r.waiting.nextCheck ? when(r.waiting.nextCheck) : 'soon'})`;
  if (r.applied) return 'applied, moving the file';
  return `retrying (${r.error ?? 'error'})`;
}

/** The word the result dropdown filters on. */
export function resultKey(r) {
  if (r.done) return String(r.result ?? '');
  if (r.waiting) return 'waiting';
  return r.applied ? 'applying' : 'retrying';
}

const viewLink = (r, key) => `<a href="receipt?key=${escape(encodeURIComponent(key))}&amp;id=${escape(encodeURIComponent(r.key))}">View</a> `;

function retryCell(r, key) {
  const s = retryStatus(r.key, r);
  if (s === 'yes') {
    return `<form ${post('retry', key)}><input type="hidden" name="entry" value="${escape(r.key)}"><button class="small plain">Try again</button></form>`;
  }
  // The note is for receipts sitting in Needs review; a cleanly filed one (it keeps `applied` too) needs none.
  if (s === 'undo' && (r.result === 'failed' || String(r.result).endsWith('review'))) return '<span class="muted small">Applied in Actual. Undo it there first to try again.</span>';
  return '';
}

/** The setup-problem banner (alert.js): paused, or only the hosted decider refusing requests. */
function alertBanner(alert) {
  if (!alert) return '';
  const refusing = alert.pausing === false;
  return `<div class="banner live"><b>${refusing ? 'The hosted decider is refusing requests' : 'The worker is paused'}</b>${escape(alert.message)}${alert.at ? ` <span class="muted small">(since ${escape(when(alert.at))})</span>` : ''}. ${refusing ? 'The affected items were marked unsure.' : 'Receipts wait in the inbox; none is marked as failed.'}</div>`;
}

/** Problems with the Settings tab's settings: the last reload failed (the earlier ones stay in use), or the file is damaged. */
function settingsBanner({ reloadError, settingsDamaged }, key) {
  const link = `<a href="settings?key=${escape(encodeURIComponent(key))}">Settings tab</a>`;
  return (reloadError ? `<div class="banner live"><b>The settings were not reloaded</b>${escape(reloadError)}. The worker is still using the earlier settings. Fix it on the ${link}, or in .env.</div>` : '')
    + (settingsDamaged ? `<div class="banner live"><b>The settings file is damaged</b>Settings saved on this page are ignored (.env is used) and nothing can be saved until it is reset on the ${link}.</div>` : '');
}

/** What a cloud reader means for privacy; empty for the local reader. */
function readerBanner() {
  if (config.reader.provider !== 'remote') return '';
  return `<div class="banner live"><b>Receipt photos leave this machine</b>The reader is ${escape(config.llmName)}. Each photo is sent whole to ${escape(config.reader.host)}: store and address, date and time, everything you bought, prices, card digits, member numbers and sometimes names. Location data in the photo is removed first. The hosted decider's anonymizing does not apply to photos. The provider may keep requests for a while; check its current policy${/openrouter\.ai$/.test(config.reader.host) ? ' and your OpenRouter privacy settings (the request is forwarded to a third-party model provider)' : ''}. Each photo costs money.${config.decider.provider === 'remote' ? ' The name and place scan for the hosted decider also runs on this cloud reader (CLOUD_NAME_SCAN=true), so the raw receipt text goes to that provider before anonymizing.' : ''}</div>`;
}

/** data: { dryRun, pending, settings, envNote, heartbeat, alert: { message, at } | null, recent: [{ key, file, done, result, at, ... }] } */
export function statusPage(data, key, notice, undo) {
  const rows = data.recent
    .map((r) => `<tr data-row data-result="${escape(resultKey(r))}"><td>${escape(r.file)}</td><td>${escape(resultText(r))}</td><td data-sort="${escape(r.at ?? '')}">${escape(when(r.at))}</td><td data-act>${viewLink(r, key)}${retryCell(r, key)}</td></tr>`)
    .join('');
  const tools = data.recent.length ? toolbar('recent', 'receipts', { selects: [{ field: 'result', label: 'Result', all: 'All results', values: unique(data.recent.map(resultKey)) }] }) : '';
  const body = `${alertBanner(data.alert)}${settingsBanner(data, key)}${readerBanner()}${modeBanner(data, key)}
${data.stateError ? `<p class="notice">Can't read the list of receipts: ${escape(data.stateError)}</p>` : ''}
<div class="muted">last check ${escape(data.heartbeat)} · checks every ${Math.round(config.pollSeconds / 60)} min</div>
<form ${post('run', key)}><button>Check for receipts now</button></form>
${tools}
${sortable('recent', ['Receipt', 'Result', ['When', 'date'], ''], rows, 'Nothing processed yet')}`;
  return layout({ active: 'status', key, notice, body, undo });
}

/** The second step of going live: says what will happen and needs a ticked box. */
export function goLivePage(key, notice, undo) {
  const body = `<h2>Go live?</h2>
<div class="banner live"><b>This changes real data.</b>
In live mode the worker writes to Actual (splits and recategorizes transactions, adds notes) and moves receipt files in Nextcloud.
Receipts it already looked at in dry run are processed again, for real, at the next check.</div>
<form ${post('mode', key)}>
<input type="hidden" name="mode" value="live">
<label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I understand: receipts seen in dry run will be processed for real, changing Actual and moving files in Nextcloud.</span></label>
<button class="danger">Go live</button>
</form>
<p><a href="./?key=${escape(encodeURIComponent(key))}">Cancel, stay in dry run</a></p>`;
  return layout({ active: 'status', key, notice, body, undo });
}

const formAction = (action, key) => `${action}?key=${escape(encodeURIComponent(key))}`;

/** data: from categoriesData() { groups: [{ name, categories: [{ label, description, draft }] }], excluded: { groups: [{ name, labels }], categories: [{ label }] }, damaged } */
export function categoriesPage(data, key, notice, undo) {
  const exclude = (kind, field, name, text) => `<form ${post('category-exclude', key)}><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="${field}" value="${escape(name)}"><button class="small plain">${text}</button></form>`;
  const cards = data.groups
    .map((g) => `<section data-group><div class="grouphead"><h2>${escape(g.name)}</h2>${exclude('group', 'group', g.name, 'Exclude group')}</div>
${g.categories.map((c) => `<form class="card" data-row${c.draft ? ' data-draft="1"' : ''} ${post('category-save', key)}>
<input type="hidden" name="label" value="${escape(c.label)}">
<strong>${escape(c.label)}</strong> <span class="tag${c.draft || !c.description ? ' draft' : ''}">${!c.description ? 'no description yet' : c.draft ? 'draft (auto-written)' : 'written by you'}</span>
<textarea name="description" maxlength="${MAX_DESCRIPTION}" required aria-label="Description of ${escape(c.label)}">${escape(c.description)}</textarea>
<button class="small" data-act>Save</button> <button class="small plain" formaction="${formAction('category-exclude', key)}" name="kind" value="category" formnovalidate>Exclude</button>
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
  return layout({ active: 'categories', key, notice, body, undo });
}

const SOURCES = { cli: 'command line', actual: 'tag in an Actual note', 'status page': 'this page', learned: 'learned (your corrections)' };

/** data: { keywords, categories: [label], mode } */
export function keywordsPage({ keywords, categories, mode }, key, notice, undo) {
  const off = mode === 'off'
    ? '<div class="banner live"><b>Keywords are currently ignored.</b>KEYWORD_MODE is off. Set KEYWORD_MODE=mixed in .env and run ./receipts restart to use them.</div>'
    : '';
  const rows = keywords
    .map((k) => `<tr data-row data-category="${escape(k.category)}"><td>${escape(k.phrase)}</td><td>${escape(k.category)}</td><td>${escape(k.store ?? 'any store')}</td><td>${strengthOf(k)}</td>
<td class="small">${escape(SOURCES[k.from] ?? k.from ?? '')}${Number.isFinite(k.maxCents) ? `<br>${escape(`charges up to $${(k.maxCents / 100).toFixed(2)}`)}` : ''}${Number.isFinite(k.maxItemCents) ? `<br>${escape(`items up to $${(k.maxItemCents / 100).toFixed(2)}`)}` : ''}</td><td class="small" data-sort="${escape(k.added ?? '')}">${escape(k.added ?? '')}</td>
<td data-act><form ${post('keyword-remove', key)}><input type="hidden" name="phrase" value="${escape(k.phrase)}"><input type="hidden" name="store" value="${escape(k.store ?? '')}"><button class="small plain">Remove</button></form></td></tr>`)
    .join('');
  const options = categories.map((c) => `<option>${escape(c)}</option>`).join('');
  const body = `${off}
<p class="muted"><b>always</b> files matching items in the category without asking the model; <b>usually</b> only gives the model a hint. (Both need KEYWORD_MODE=mixed; other modes treat every keyword the same way.)
Writing <code>#always gold bond</code> or <code>#usually gold bond</code> in an Actual transaction note adds a keyword from that transaction's category too.</p>
${keywords.length ? toolbar('keywords', 'keywords', { selects: [{ field: 'category', label: 'Category', all: 'All categories', values: unique(keywords.map((k) => k.category)) }] }) : ''}
${sortable('keywords', ['Phrase', 'Category', 'Store', 'Strength', 'From', ['Added', 'date'], ''], rows, 'No keywords yet')}
<h2>Add a keyword</h2>
<form ${post('keyword-add', key)}>
<label for="phrase">Phrase</label><input type="text" id="phrase" name="phrase" maxlength="100" required placeholder="gold bond">
<label for="category">Category</label><select id="category" name="category" required>${options}</select>
<div class="row"><div><label for="store">Store (optional)</label><input type="text" id="store" name="store" maxlength="100" placeholder="any store"></div>
<div><label for="strength">Strength</label><select id="strength" name="strength"><option value="usually" selected>usually</option><option value="always">always</option></select></div></div>
<button>Add keyword</button>
</form>`;
  return layout({ active: 'keywords', key, notice, body, undo });
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
    .map((l) => `<tr data-row data-kind="${escape(l.kind)}"><td data-sort="${escape(l.date ?? '')}">${escape(l.date ?? '')}</td><td>${escape(l.payee ?? l.store ?? '')}</td><td>${l.items.length > 1 ? `<span class="muted">${l.items.length} items:</span> ${escape(l.items.join(', ').slice(0, MAX_ITEMS_SHOWN_CHARS))}` : `${escape(l.item)}${l.plain && l.plain.toLowerCase() !== String(l.item).toLowerCase() ? ` <span class="muted">(${escape(l.plain)})</span>` : ''}`}${l.count > 1 ? ` <span class="tag">${escape(l.count)}x</span>` : ''}</td>
<td>${l.said ? escape(l.said) : '<span class="muted">unsure</span>'} → <b>${escape(l.filed)}</b>${l.mergedInto ? ` <span class="muted small">(it was merged into ${escape(l.mergedInto)})</span>` : ''}</td><td class="small">${escape(KINDS[l.kind] ?? l.kind)}</td>
<td data-act><form ${post('lesson-forget', key)}><input type="hidden" name="id" value="${escape(l.id)}"><button class="small plain">Forget</button></form></td></tr>`)
    .join('');
  const kinds = unique(lessons.map((l) => l.kind));
  const body = `${error ? BROKEN(error) : ''}<p class="muted">${escape(LEARNING_NOTES[mode] ?? mode)} Last look at Actual: ${lastSweep ? escape(when(lastSweep)) : 'not yet'}; ${escape(watching)} charge(s) being watched.</p>
<p class="muted">When you change a category the worker filed in Actual, it notices and learns from it: you do not have to do anything. Press Forget on a line that was a one-off; it will not be learned again. Keywords it learned are on the Keywords page (From: learned) and can be removed there.</p>
${lessons.length ? toolbar('lessons', 'corrections', { selects: [{ field: 'kind', label: 'Kind', all: 'All kinds', values: kinds }] }) : ''}
${sortable('lessons', [['Date', 'date'], 'Store', 'Item', 'It said → you filed', 'Kind', ''], rows, 'Nothing learned yet')}`;
  return layout({ active: 'learned', key, notice, body, undo });
}

/** What the remote decider does and does not get; the first thing the Privacy page says. */
const PRIVACY_EXPLAINER = `The categorizer runs on TypeSafe's hosted model. It is sent the item lines, the store name, amounts and how your past purchases were filed, with category names replaced by codes (C01, C02...), dates turned into "12 days before this purchase", and the names below replaced by Person A, Person B... A store name is only ever the name of an Actual payee (never the bank's raw text, and never a transfer to one of your accounts), with long digit runs removed; where there is no such payee, no store name is sent. It never gets the receipt photo, card digits, payment method, addresses, the printed date or calendar event names. Places that could show where you live or shop (a city, state, street address or ZIP code) are replaced by "a city", "a state", "a street" or "a place" (ZIP codes are dropped). A business name such as "Papa John's" stays readable only where it appears in full; the same word anywhere else is still hidden. An item that fails the final privacy check is not sent and is marked unsure.`;

/** data: { words, found: [{ word, firstSeen }], notNames, placeWords, places: [{ word, type, firstSeen }], notPlaces } */
export function privacyPage({ words, found, notNames, placeWords = [], places = [], notPlaces = [] }, key, notice, undo) {
  const wordForm = (action, word, label) => `<form ${post(action, key)}><input type="hidden" name="word" value="${escape(word)}"><button class="small plain">${label}</button></form>`;
  const list = (id, label, cols, rows, empty) => `${toolbar(id, label)}${sortable(id, cols, rows, empty)}`;
  const wordRows = words.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-word-remove', w, 'Remove')}</td></tr>`).join('');
  const foundRows = found.map((f) => `<tr data-row><td>${escape(f.word)}</td><td class="small">${escape(f.firstSeen)}</td><td data-act>${wordForm('privacy-notname-add', f.word, 'Not a name')}</td></tr>`).join('');
  const notRows = notNames.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-notname-remove', w, 'Remove')}</td></tr>`).join('');
  const placeRows = placeWords.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-place-remove', w, 'Remove')}</td></tr>`).join('');
  const foundPlaceRows = places.map((f) => `<tr data-row><td>${escape(f.word)}</td><td class="small">${escape(f.type)}</td><td class="small">${escape(f.firstSeen)}</td><td data-act>${wordForm('privacy-notplace-add', f.word, 'Not a place')}</td></tr>`).join('');
  const notPlaceRows = notPlaces.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-notplace-remove', w, 'Remove')}</td></tr>`).join('');
  const body = `<p class="muted">${PRIVACY_EXPLAINER}</p>
<h2>Names to hide</h2>
<p class="muted small">Every word here is replaced in anything sent: first names, nicknames, pet names. Whole words only, any capitals, "Alex's" too.</p>
${list('p-words', 'names', ['Word', ''], wordRows, 'None yet')}
<form ${post('privacy-word-add', key)}>
<label for="word">Add a name</label><input type="text" id="word" name="word" maxlength="40" required placeholder="Alex">
<button>Add</button>
</form>
<h2>Names the scan found</h2>
<p class="muted small">Before a receipt is sent, ${scanWhere()} looks through the text for people's names. These were found and are hidden too. If one is not a name (a product, a brand), press "Not a name".</p>
${list('p-found', 'found names', ['Word', ['First seen', 'date'], ''], foundRows, 'Nothing found yet')}
<h2>Places to hide</h2>
<p class="muted small">Your town, street or ZIP code. Every one listed here is replaced by "a place" in anything sent. Whole words or phrases, any capitals.</p>
${list('p-places', 'places', ['Place', ''], placeRows, 'None yet')}
<form ${post('privacy-place-add', key)}>
<label for="place">Add a place</label><input type="text" id="place" name="word" maxlength="40" required placeholder="Springfield">
<button>Add</button>
</form>
<h2>Places the scan found</h2>
<p class="muted small">${scanWhere().replace(/^./, (c) => c.toUpperCase())} also looks for places. These were found and are replaced too. If one is not a place, press "Not a place".</p>
${list('p-foundplaces', 'found places', ['Place', 'Kind', ['First seen', 'date'], ''], foundPlaceRows, 'Nothing found yet')}
<h2>Not a place</h2>
<p class="muted small">Words the scan may flag but that are not places (for example a person called Lincoln). They are sent as they are.</p>
${list('p-notplaces', 'words', ['Word', ''], notPlaceRows, 'None')}
<h2>Not a name</h2>
<p class="muted small">Words the scan may flag but that are not people. They are sent as they are.</p>
${list('p-notnames', 'words', ['Word', ''], notRows, 'None')}`;
  return layout({ active: 'privacy', key, notice, body, undo });
}

const SOURCE_TEXT = { page: 'this page', env: '.env', default: 'default' };

/** One setting's input, by type. A secret is never given a value: only "set" or "not set". */
function settingInput(s) {
  const id = `s-${s.key}`;
  const name = `name="${escape(s.key)}" id="${id}"`;
  switch (s.type) {
    case 'bool': {
      const on = ['true', '1', 'yes', 'on'].includes(String(s.value).trim().toLowerCase());
      return `<div class="check"><input type="hidden" name="${escape(s.key)}" value="false"><input type="checkbox" ${name} value="true"${on ? ' checked' : ''}><label for="${id}">${escape(s.label)}</label></div>`;
    }
    case 'enum': {
      const cur = String(s.value).trim().toLowerCase();
      return `<label for="${id}">${escape(s.label)}</label><select ${name}>${s.values.includes(cur) ? '' : '<option value="" selected>(not valid: pick one)</option>'}${s.values.map((v) => `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(v)}</option>`).join('')}</select>`;
    }
    case 'secret':
      return `<label for="${id}">${escape(s.label)}</label><input type="password" ${name} value="" autocomplete="new-password" placeholder="${s.isSet ? 'Set. Leave empty to keep it' : 'Not set'}">`;
    case 'number':
      return `<label for="${id}">${escape(s.label)}</label><input type="text" inputmode="${s.int ? 'numeric' : 'decimal'}" ${name} value="${escape(s.value)}" aria-describedby="h-${s.key}">`;
    default:
      return `<label for="${id}">${escape(s.label)}</label><input type="text" ${name} value="${escape(s.value)}" maxlength="500" autocomplete="off"${s.type === 'url' ? ' inputmode="url"' : ''}>`;
  }
}

function rangeText(s) {
  if (s.type === 'number') return ` Between ${s.min} and ${s.max}.`;
  return '';
}

/** data: from settingsData() */
export function settingsPage(data, key, notice, undo) {
  const reset = (s) => (s.source === 'page'
    ? `<button class="small plain" name="reset" value="${escape(s.key)}" formaction="${formAction('settings-reset', key)}" formnovalidate>Use the .env value</button>`
    : '');
  const sections = data.sections.map((sec) => {
    const rows = sec.settings.map((s) => `<div class="setting">
${settingInput(s)}
<div class="muted small help" id="h-${escape(s.key)}">${escape(s.help)}${escape(rangeText(s))}${s.type === 'secret' ? '' : s.default !== '' ? ` Default: ${escape(s.default)}.` : ''}</div>
<div class="actions"><span class="tag${s.source === 'page' ? ' draft' : ''}">from ${escape(SOURCE_TEXT[s.source])}</span>${s.type === 'secret' ? `<span class="tag">${s.isSet ? 'set' : 'not set'}</span>` : ''}${reset(s)}</div>
</div>`).join('');
    const anyway = sec.id === 'connections'
      ? '<div class="check"><input type="checkbox" name="anyway" value="yes" id="anyway"><label for="anyway">Save even if the connection test fails</label></div><p class="muted small">Before a change to an address, user, password or the inbox is saved, it is tried: Actual by logging in, Nextcloud by listing the inbox. The sync ID is only checked for its form.</p>'
      : '';
    return `<form ${post('settings-save', key)}>
<button class="nobtn" tabindex="-1" aria-hidden="true">Save</button>
<h2>${escape(sec.title)}</h2>
${rows}
${anyway}<input type="hidden" name="section" value="${escape(sec.id)}">
<button>Save ${escape(sec.title.toLowerCase())}</button>
</form>`;
  }).join('\n');
  const damaged = data.damaged ? `<div class="banner live"><b>The settings file is damaged</b>data/web-settings.json can't be read (${escape(data.damaged)}). It is ignored and .env is used. Nothing can be saved on this page until it is reset.<form ${post('settings-reset-all', key)}><button class="danger">Reset all to .env</button></form></div>` : '';
  const reloadError = data.reloadError ? `<div class="banner live"><b>The last settings reload failed</b>${escape(data.reloadError)}. The worker is still using the earlier settings.</div>` : '';
  const resetAll = data.exists && !data.damaged
    ? `<h2>Reset</h2><form ${post('settings-reset-all', key)}><div class="check"><input type="checkbox" name="confirm" value="yes" id="confirm-reset" required><label for="confirm-reset">Put every setting on this page back to its .env value</label></div><button class="plain">Reset all to .env</button></form>`
    : '';
  const body = `${damaged}${reloadError}<p class="muted">Change settings without editing .env. A value saved here wins over .env; "Use the .env value" goes back. Saved changes apply at the start of the next check (press "Check for receipts now" on the Status tab to do it right away).${data.changedAt ? ` Last saved ${escape(when(data.changedAt))}.` : ''}</p>
${data.ignored?.length ? `<p class="muted small">Ignored in the file (not settings of this page): ${escape(data.ignored.join(', '))}.</p>` : ''}
${sections}
${resetAll}
<p class="muted small">Set in .env only (then ./receipts restart): TRIGGER_TOKEN, TRIGGER_BIND, DRY_RUN (the Status tab has its own switch), ACTUAL_API_VERSION, the models, GPU and provider settings, API keys, CLOUD_NAME_SCAN, PRIVATE_WORDS, PRIVATE_PLACES, the calendar settings and every file path.</p>`;
  return layout({ active: 'settings', key, notice, body, undo });
}

const money = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n).toFixed(2) : '');
const fact = (label, value) => (value === '' || value === null || value === undefined ? '' : `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`);

/** What the reader saw: merchant, date, totals, items. `r` is the saved reading (untrusted shape: every field is checked). */
function readingHtml(r, note) {
  if (!r || typeof r !== 'object') return `<p class="muted">${escape(note || 'No saved reading for this receipt.')}</p>`;
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((i) => `<tr><td>${escape(i?.description)}</td><td class="muted">${escape(i?.plain)}</td><td>${escape(money(i?.amount))}</td></tr>`)
    .join('');
  const facts = [
    fact('Merchant', r.merchant), fact('Date', r.date ?? r.date_as_printed), fact('Printed date', r.date ? r.date_as_printed : ''),
    fact('Subtotal', money(r.subtotal)), fact('Tax', money(r.tax)), fact('Tip', money(r.tip)), fact('Total', money(r.total)),
    fact('Currency', r.currency), fact('Paid with', r.payment_method), fact('Return', r.is_return ? 'yes' : ''),
  ].join('');
  return `<table><tbody>${facts}</tbody></table>
${items ? `<h2>Items</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Plain</th><th>Amount</th></tr></thead><tbody>${items}</tbody></table></div>` : ''}`;
}

/** The decision from the filed summary: transaction, plan, problems (the review reasons). */
function decisionHtml(s) {
  if (!s || typeof s !== 'object') return '';
  const t = s.transaction && typeof s.transaction === 'object' ? s.transaction : null;
  const problems = (Array.isArray(s.problems) ? s.problems : []).map((p) => `<li>${escape(p)}</li>`).join('');
  const parts = (Array.isArray(s.plan?.parts) ? s.plan.parts : []).map((p) => `<li>${escape(p?.category)}: ${escape(p?.amount)}</li>`).join('');
  return `${t ? `<h2>Bank charge</h2><table><tbody>${fact('Payee', t.payee)}${fact('Date', t.date)}${fact('Amount', t.amount)}${fact('Account', t.account)}${fact('Category now', t.currentCategory)}</tbody></table>` : ''}
${parts ? `<h2>Filed as</h2><ul>${parts}</ul>` : ''}
${problems ? `<h2>Why it needs review</h2><ul>${problems}</ul>` : ''}
${s.waiting ? `<p class="banner">${escape(s.waiting)}</p>` : ''}`;
}

/** The receipt detail page. view: from panel-receipt.js receiptView(). */
export function receiptPage(view, key, notice) {
  const { entry, id } = view;
  const photoUrl = (extra) => `receipt-photo?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}${extra}`;
  const photos = Array.from({ length: view.pages }, (_, i) => `<img class="photo" src="${escape(photoUrl(`&page=${i + 1}`))}" alt="Receipt ${escape(view.name)}, page ${i + 1}">`).join('');
  const pdfLink = view.pdf && view.pages ? `<p><a href="${escape(photoUrl('&raw=1'))}">Download the original PDF</a></p>` : '';
  const reading = entry.reading?.receipt ?? view.summary?.receipt ?? null;
  const body = `<h2>${escape(view.name)}</h2>
<p class="muted">${escape(resultText(entry))}${entry.at ? ` · ${escape(when(entry.at))}` : ''}${entry.filedAs ? ` · filed as ${escape(entry.filedAs)}` : ''}${entry.error ? ` · last error: ${escape(entry.error)}` : ''}</p>
<p><a href="./?key=${escape(encodeURIComponent(key))}">Back to the list</a></p>
${photos || `<p class="muted">${escape(view.photoNote || 'No photo to show.')}</p>`}${pdfLink}
<h2>What was read</h2>
${readingHtml(reading, view.summaryNote)}
${decisionHtml(view.summary)}`;
  return layout({ active: 'status', key, notice, body });
}
