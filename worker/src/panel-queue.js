import { escape, displayMoney, displayDate, currentFrame, post, hidden } from './panel-layout.js';
import { statusKind } from './status-kind.js';
import { reviewCause } from './review-cause.js';
import { railAlerts } from './panel-alerts.js';
import { config } from './config.js';
import { parseStateKey } from './state.js';
import { undoOpen } from './archive-rules.js';
import { resolveDryRun } from './settings.js';
import { rowWords } from './panel-status.js'; // a cycle that is safe: used only when a list is drawn

export function queueGroup(entry) {
  const kind = statusKind(entry);
  if (kind === 'archived') return 'archive';
  if (kind === 'done') return 'filed';
  if (['waiting', 'retrying', 'applying', 'preview-retrying'].includes(kind)) return 'waiting';
  return 'review';
}

export function queueIdentity(entry) {
  const r = entry.card ?? entry.summary?.receipt ?? entry.reading?.receipt ?? {};
  return { store: r.store || r.merchant || entry.file || 'Receipt', total: r.total, date: r.date || '' };
}

export function queueLabel(entry) {
  const kind = statusKind(entry);
  // Q1: during the 15 minutes after a save from the page (never a "Looks right": undoOpen) the row says Undo is still there (the receipt's page offers it). Live only, and not while a switch to dry run is pending (Undo refuses then).
  if (!config.dryRun && !parseStateKey(String(entry.key ?? '')).dry && undoOpen(entry) && !entry.filing && !entry.creating && !entry.fixedOnPage.summaryFailed && !resolveDryRun().dryRun) return 'Saved · Undo';
  if (kind === 'waiting') return 'Waiting for the bank';
  if (kind === 'retrying' || kind === 'preview-retrying') return 'Retrying automatically';
  if (kind === 'applying') return 'Finishing up';
  if (kind === 'done') return 'Filed';
  if (kind === 'archived') return 'Archived';
  const cause = reviewCause(entry);
  return (cause?.cause === 'cash' ? 'Paid cash · not in Actual' : cause?.label) || (kind.startsWith('preview') ? 'Test mode' : kind.includes('failed') ? 'Check an error' : 'Check categories');
}

/**
 * The text a Receipts-list row is searched on (its data-search, also the activity table's): the displayed store, `$` amount, date, file and
 * label, then the table's status words. The browser's filter and the server's Previous/Next (receiptNav) use this one string.
 */
export function queueSearch(entry) {
  const c = queueIdentity(entry), amount = c.total != null ? displayMoney(c.total) : '';
  return [c.store, amount, c.date, entry.file, queueLabel(entry), rowWords(entry)].join(' ');
}
const archiveSub = (r) => { const at = archiveDay(r.archived?.at); return `Was ${wasGroup(r)}${at ? ` · Archived ${at}` : ''}`; };
const archiveDay = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? displayDate(d.toLocaleDateString('en-CA', { timeZone: config.trigger.timeZone })) : ''; };
/** The same for an Archive-list row. */
export function archiveSearch(entry) {
  const c = queueIdentity(entry), amount = c.total != null ? displayMoney(c.total) : '';
  return [c.store, amount, c.date, entry.file, archiveSub(entry), entry.archived?.fileMissing ? '(photo was already gone)' : '', entry.archived?.auto ? 'auto' : ''].join(' ');
}

// One dot per row: amber for Review, green for Filed, a hollow ring for Waiting, none for Archive.
const DOT = { review: 'r-attn', filed: 'r-ok', waiting: 'r-wait', archive: '' };

/**
 * The receipts list pane: "Receipts", search, Review and Waiting as plain groups, Filed as a collapsed toggle that opens by itself when the
 * open receipt is Filed (or a search matches). Setup alerts sit at the top; "Activity and test mode" at the foot.
 * `alerts`: the banners' HTML (the status page passes its own); by default those of the page frame. `nav`: the list's filter and sort as
 * query text, without a group (each row adds its own). `openGroup`: a group to show open (the list after archiving the last Filed receipt). `activity`: the Activity page is open (the foot link is the current page).
 */
export function queueRail(entries, key, selected = '', nav = '', alerts = null, { openGroup = '', activity = false } = {}) {
  const by = { review: [], waiting: [], filed: [], archive: [] };
  for (const entry of entries) by[queueGroup(entry)].push(entry);
  const k = escape(encodeURIComponent(key));
  const row = (r, group) => {
    const c = queueIdentity(r), label = queueLabel(r);
    // The row says which group it was opened from, so the receipt's "Next receipt" stays in that group. `nav` never carries a group itself.
    const href = `receipt?key=${encodeURIComponent(key)}&id=${encodeURIComponent(r.key)}${nav}${group === 'archive' ? '' : `&group=${group}`}`;
    const amount = c.total != null ? displayMoney(c.total) : '';
    return `<li><a class="queue-row ${DOT[group]}" data-navigate data-queue-row data-id="${escape(r.key)}" data-search="${escape(queueSearch(r))}" href="${escape(href)}"${r.key === selected ? ' aria-current="page"' : ''}><span class="dot" aria-hidden="true"></span><span class="queue-store">${escape(c.store)}</span><span class="queue-amount">${escape(amount)}</span><span class="queue-sub">${escape(label)}</span><span class="queue-date">${escape(displayDate(c.date))}</span><span class="queue-draft" data-draft-for="${escape(r.key)}" hidden>Unsaved edits</span></a></li>`;
  };
  // A search hides rows in place (the script): `No matches.` shows when it hides all of a group's, in place of `All caught up.` and the like.
  const list = (id, empty) => `<ul class="queue-list">${by[id].map((r) => row(r, id)).join('') || `<li class="queue-empty">${empty}</li>`}<li class="queue-empty" data-no-match hidden>No matches.</li></ul>`;
  const count = (id) => `<span class="queue-count">${by[id].length}</span>`;
  const plain = (id, title, empty) => `<section class="queue-section" data-queue-group="${id}"><h3 class="queue-heading">${title} ${count(id)}</h3>${list(id, empty)}</section>`;
  const open = (id) => by[id].some((r) => r.key === selected) || openGroup === id;
  const toggle = (id, title) => `<details class="queue-filed" data-queue-group="${id}"${open(id) ? ' open' : ''}><summary aria-expanded="${open(id) ? 'true' : 'false'}">${title} ${count(id)}</summary>${list(id, 'None right now.')}</details>`;
  const banners = alerts ?? railAlerts(currentFrame().setup, key);
  return `<aside class="queue-rail" aria-label="Inbox">${banners ? `<div class="queue-alerts">${banners}</div>` : ''}<h2>Inbox</h2><div class="queue-filter"><label class="sr-only" for="queue-search">Search receipts</label><input id="queue-search" type="search" data-queue-search placeholder="Search stores or amounts" autocomplete="off"></div>${plain('review', 'Review', 'All caught up.')}${plain('waiting', 'Waiting', 'None right now.')}${toggle('filed', 'Filed')}${by.archive.length ? toggle('archive', 'Archive') : ''}<a class="queue-activity" data-navigate href="./?key=${k}&amp;activity=1"${activity ? ' aria-current="page"' : ''}>Activity and test mode</a></aside>`;
}

/** Which list an archived receipt came from, for "Was Filed": a receipt dismissed straight from Needs review was in Review; everything else was Filed. */
export const wasGroup = (entry) => (entry.archived?.dismissed && entry.archived.restoreTo === 'review' ? 'Review' : 'Filed');

const SORT_CHOICES = [['', 'Recently archived'], ['store', 'Store'], ['date', 'Receipt date'], ['total', 'Amount']];

/**
 * The Archive list pane (the approved two-pane Archive): search, a sort menu, and one row per archived receipt (name,
 * amount, "Was Filed · Archived <date>", no dot) with Restore beside it. It stays beside an opened archived receipt.
 * `entries`: archived entries in the order to show. `selected`: the open receipt's key. `nav`: the list's filter and sort as query text.
 * `sort`: { sort, dir } as chosen. `empty`: what to say when there is nothing archived.
 */
export function archiveRail(entries, key, { selected = '', nav = '', sort = {}, empty = 'Nothing archived yet.' } = {}) {
  const k = escape(encodeURIComponent(key));
  const row = (r) => {
    const c = queueIdentity(r), amount = c.total != null ? displayMoney(c.total) : '';
    const sub = archiveSub(r);
    const href = `receipt?key=${encodeURIComponent(key)}&id=${encodeURIComponent(r.key)}${nav}`;
    const open = r.key === selected;
    return `<li class="archive-item${open ? ' open' : ''}"><a class="queue-row" data-navigate data-queue-row data-id="${escape(r.key)}" data-search="${escape(archiveSearch(r))}" href="${escape(href)}"${open ? ' aria-current="page"' : ''}><span class="queue-store">${escape(c.store)}</span><span class="queue-amount">${escape(amount)}</span><span class="queue-sub">${escape(sub)}</span></a><form ${post('restore', key)}>${hidden('id', r.key)}<button class="small plain" aria-label="Restore ${escape(c.store)}">Restore</button></form></li>`;
  };
  const choice = (name, value, text) => `<option value="${escape(value)}"${(sort[name] ?? '') === value ? ' selected' : ''}>${escape(text)}</option>`;
  const sorter = `<form class="archive-sort" method="get" action="${selected ? 'receipt' : 'archived'}">${hidden('key', key)}${selected ? hidden('id', selected) : ''}<label class="sr-only" for="archive-sort">Sort archive</label><select id="archive-sort" name="sort" data-jump>${SORT_CHOICES.map(([v, t]) => choice('sort', v, t)).join('')}</select><label class="sr-only" for="archive-dir">Sort direction</label><select id="archive-dir" name="dir" data-jump>${choice('dir', 'asc', 'Ascending')}${choice('dir', 'desc', 'Descending')}</select><button class="small plain" data-nojs>Sort</button></form>`;
  const list = `<ul class="queue-list archive-list">${entries.map(row).join('') || `<li class="queue-empty">${escape(empty)}</li>`}<li class="queue-empty" data-no-match hidden>No matches.</li></ul>`;
  return `<aside class="queue-rail archive-rail" aria-label="Archive"><h2>Archive</h2><div class="queue-filter"><label class="sr-only" for="queue-search">Search archived receipts</label><input id="queue-search" type="search" data-queue-search placeholder="Search archived receipts" autocomplete="off"></div>${entries.length ? sorter : ''}<section class="queue-section" data-queue-group="archive">${list}</section></aside>`;
}
