// The Status tab: the list of receipts with their status in plain words (one STATUS table feeds the list and its legend),
// the filter / sort / Previous-Next order, the dry run / live banner and the go-live page.
import { REVIEW_CAUSES, reviewCause } from './review-cause.js';
import { config } from './config.js';
import { statusKind, splitResult } from './status-kind.js';
import { retryStatus } from './panel-actions.js';
import { queueRail, queueGroup, queueSearch } from './panel-queue.js';
import { archiveBanner, railAlerts } from './panel-alerts.js';
import { rowVisible, sortItems } from './panel-script.js';
import { escape, layout, post, hidden, toolbar, sortable, when, shortWhen, ago, clockOrDate, timeTag, whenAhead, money, reviewDir, processedDir, archiveDir } from './panel-layout.js';

// ---- The status of a receipt in plain words: one table feeds the list and its legend ----

export { splitResult, statusKind, archiveBanner };

// What to do to read an applied receipt again. The file can't just be moved back by hand: the worker remembers a file by its
// name and version (the state key), so it would be skipped as done; it has to be uploaded again.
export const REDO = 'undo it in Actual (restore the category or remove the split, and remove the #receipt note), delete the file from Needs review, and upload the receipt again';

const STATUS = {
  waiting: { label: 'Waiting for the bank charge', where: 'the Inbox', changed: 'Nothing changed in Actual', next: 'The worker looks again by itself. Press "Check now" to look right away. If the charge never shows up it goes to review.' },
  retrying: { label: 'Retrying after an error', where: 'the Inbox', changed: 'Not finished yet', next: 'Tried again at the next check. After 3 failed attempts it goes to Needs review.' },
  applying: { label: 'Finishing up', where: 'the Inbox', changed: 'Changed in Actual', next: 'Nothing to do. The file is moved at the next check.' },
  done: { label: 'Done', where: 'Processed', changed: 'Actual updated', next: 'Nothing to do. If a category is wrong, fix it on the receipt\'s page or in Actual; the worker learns from it. When you agree it is right, archive it (the "Archive receipt" button on its page, or "Archive all done receipts" on this page).' },
  archived: { label: 'Archived', where: 'the Archive folder', changed: 'Actual updated', next: 'Nothing to do. Open it from the Archived tab; Restore puts it back on the Status list and in Processed.' },
  preview: { label: 'Preview (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'This is what it would do. If it looks right, go live.' },
  'preview-failed': { label: 'Failed (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Open it to see the last error. Fix the cause, then go live (Try again is live only).' },
  'preview-review': { label: 'Needs review (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Open it to see why. Fix the cause if you can, then go live (Try again is live only).' },
  'preview-retrying': { label: 'Retrying after an error (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Tried again at the next check. After 3 failed attempts it shows as failed here (Try again is live only).' },
  review: { label: 'Needs your review', where: 'Needs review', changed: 'Nothing changed in Actual', next: 'Open it to see why. Fix the cause, then press Try again. If a charge was matched you can also fix the item categories on its page and apply them to Actual.' },
  'applied-review': { label: 'Applied — check it in Actual', where: 'Needs review', changed: 'Changed in Actual and tagged #review', next: 'Check it in Actual and remove the #review tag if it is right, or open it and fix the item categories on its page. If not, ' + REDO + '.' },
  failed: { label: 'Failed', where: 'Needs review', changed: 'Nothing changed in Actual', next: 'Fix the cause (or wait out an outage), then press Try again.' },
  'failed-applied': { label: 'Failed after Actual was changed', where: 'Needs review', changed: 'Changed in Actual', next: 'Check the charge in Actual. To read the receipt again, ' + REDO + '.' },
};
const STATUS_ORDER = ['waiting', 'retrying', 'applying', 'done', 'archived', 'review', 'applied-review', 'failed', 'failed-applied', 'preview', 'preview-review', 'preview-failed', 'preview-retrying'];

/** "Older charge matches: 2026-02-20 42.17, check it." from a waiting reason that carries the older-charge hint, else ''. */
export function olderChargeNote(reason) {
  const text = String(reason ?? '');
  const at = text.indexOf('an older charge matches, check it: ');
  if (at < 0) return '';
  const found = [...text.slice(at).matchAll(/(\d{4}-\d\d-\d\d) [^"]*?(-?[\d,]*\d\.\d\d) "/g)].map((m) => `${m[1]} ${m[2]}`);
  if (found.length === 0) return '';
  return `Older charge matches: ${found.slice(0, 2).join(', ')}${found.length > 2 ? ` (+${found.length - 2} more)` : ''}, check it.`;
}

// What the list shows per status: a short pill word, its colour, and at most one short line. The long advice (where the file is, what
// changed, what to do) stays in STATUS above, which feeds the legend and the receipt page.
const PILL = {
  waiting: ['Waiting', 's-info', ''], retrying: ['Retrying', 's-info', 'Tried again at the next check.'], applying: ['Finishing', 's-info', 'The file is moved at the next check.'],
  done: ['Done', 's-ok', ''], archived: ['Archived', '', ''],
  review: ['Needs review', 's-warn', 'Open it to see why.'], 'applied-review': ['Check in Actual', 's-warn', 'Tagged #review in Actual.'],
  failed: ['Failed', 's-bad', 'Open it to see the error.'], 'failed-applied': ['Failed', 's-bad', 'Actual was changed: check the charge.'],
  preview: ['Dry run', 's-dry', 'Nothing written.'], 'preview-failed': ['Dry run: failed', 's-dry', 'Nothing written.'], 'preview-review': ['Dry run: review', 's-dry', 'Nothing written.'], 'preview-retrying': ['Dry run: retrying', 's-dry', 'Nothing written.'],
};

/** The status as the list shows it: { kind, label (full, for sorting and titles), pill (short word), tone (css class), short (at most one line) }. */
function statusInfo(r) {
  const kind = statusKind(r);
  const [pill, tone, base] = PILL[kind];
  let short = base;
  if (kind === 'waiting') {
    const hint = olderChargeNote(r.waiting.reason);
    const later = whenAhead(r.waiting.nextCheck);
    short = `${later ? `Will be checked again ${later}.` : r.waiting.nextCheck ? 'Will be checked again at the next check.' : 'Will be checked again soon.'}${hint ? ` ${hint}` : ''}`;
  }
  return { kind, label: STATUS[kind].label, pill, tone, short };
}

/** Pill markup (also used on the receipt page): the short word, coloured, with the full label as its title. */
export const pillHtml = (r) => { const i = statusInfo(r); return `<span class="pill ${i.tone}" title="${escape(i.label)}">${escape(i.pill)}</span>`; };

/** Merchant and total for a list row, when the entry carries them (a finished receipt's card, or a saved reading): "Corner Grocery · 84.12". */
export function cardText(r) {
  const c = r.card ?? (r.summary?.receipt ? { store: r.summary.receipt.merchant, total: r.summary.receipt.total } : r.reading?.receipt ? { store: r.reading.receipt.merchant, total: r.reading.receipt.total } : null);
  if (!c) return '';
  return [c.store ? String(c.store).slice(0, 60) : '', money(c.total)].filter(Boolean).join(' · ');
}

/** Purchase identity, shared by the list, receipt header and jump menu. Filenames stay searchable. */
export const receiptTitle = (r) => cardText(r) || r.file || '';
export const purchaseDate = (r) => r.card?.date || r.summary?.receipt?.date || r.reading?.receipt?.date || '';

/** The plain label of a list entry's status (what the Result column sorts on). */
export const resultText = (r) => statusInfo(r).label;

/** The words the text filter searches, as the browser sees them in a row: the receipt cell, the status cell (pill, raw word, line), the time. */
export const rowWords = (r) => {
  const { pill } = statusInfo(r);
  const short = ['review', 'failed', 'retrying'].includes(statusInfo(r).kind) ? reviewCause(r)?.reason ?? statusInfo(r).short : statusInfo(r).short;
  return [r.file, cardText(r), purchaseDate(r), pill, resultKey(r), short, reviewCause(r)?.label, shortWhen(r.at)].filter(Boolean).join(' ');
};

/** The word the result dropdown filters on. */
export function resultKey(r) {
  if (r.done) return String(r.result ?? '');
  if (r.waiting) return 'waiting';
  return r.applied ? 'applying' : 'retrying';
}

// ---- Previous / Next: the receipts in the order (and with the filter) the list had when View was pressed ----

const NAV_SORTS = { receipt: (r) => receiptTitle(r), result: (r) => resultText(r), when: (r) => r.at ?? '' };
const NAV_TYPES = { receipt: 'text', result: 'text', when: 'date' };
// The Archived tab (panel-archive-page.js) sorts by more columns; cleanNav lets all of these names through, and each list uses the ones it knows.
const KNOWN_SORTS = ['receipt', 'result', 'when', 'store', 'date', 'total', 'archived'];

/** How a list is filtered and sorted: the words the text box searches, the values the dropdowns filter on, the sort columns. The Status list's is the default. */
export const STATUS_ORDERING = {
  words: (r) => queueSearch(r),
  fields: (r) => ({ result: resultKey(r), cause: reviewCause(r)?.cause ?? '' }),
  wants: (nav) => [{ field: 'result', value: nav.result }, { field: 'cause', value: nav.cause ?? '' }],
  sorts: NAV_SORTS,
  types: NAV_TYPES,
};

/** The list groups a receipt can be opened from (the receipts list's Review, Waiting and Filed): "Next receipt" stays in the one it was opened from. */
export const NAV_GROUPS = ['review', 'waiting', 'filed'];

/** The first `max` characters by code point (never half of an emoji), as well-formed text. */
export const clipText = (text, max) => Array.from(String(text ?? '').toWellFormed()).slice(0, max).join('');

/** The list's filter and sort from a query (URLSearchParams or form), cleaned: only known names, short values; `group` only when it is one of NAV_GROUPS. */
export function cleanNav(params) {
  const get = (n) => clipText(params.get(n), 100);
  const sort = KNOWN_SORTS.includes(get('sort')) ? get('sort') : '';
  return { result: clipText(get('result'), 60), ...(REVIEW_CAUSES.some(([id]) => id === get('cause')) ? { cause: get('cause') } : {}), q: get('q'), sort, dir: sort && ['asc', 'desc'].includes(get('dir')) ? get('dir') : '', ...(NAV_GROUPS.includes(get('group')) ? { group: get('group') } : {}) };
}
const NAV_NAMES = ['result', 'cause', 'q', 'sort', 'dir', 'group'];
/** The nav as query text (starts with &, empty when nothing is set). Not escaped for HTML. */
export const navQuery = (nav) => NAV_NAMES.filter((n) => nav?.[n]).map((n) => `&${n}=${encodeURIComponent(String(nav[n]).toWellFormed())}`).join('');
/** The nav as hidden form fields. */
export const navFields = (nav) => NAV_NAMES.filter((n) => nav?.[n]).map((n) => hidden(n, nav[n])).join('');
/** The nav without its group (for links that browse the whole list, or open a receipt in its own group). */
export const withoutGroup = (nav) => { if (!nav) return nav; const { group: _group, ...rest } = nav; return rest; };

/** The receipts as the list shows them: filtered by result and text, then sorted like a click on the column header. */
export function orderFor(recent, nav, spec = STATUS_ORDERING) {
  const shown = recent.filter((r) => rowVisible(spec.words(r), spec.fields(r), nav.q, spec.wants(nav)));
  const by = spec.sorts[nav.sort];
  if (!by) return shown;
  const items = shown.map((r, i) => ({ r, v: String(by(r)), i })); // i: the list's own order, the tie-break
  return sortItems(items, nav.dir === 'desc' ? -1 : 1, spec.types[nav.sort]).map((x) => x.r);
}

/**
 * Where a receipt sits in the list: { list, index, prev, next, nav, row, relaxed }, or null when it is not among the receipts listed.
 * When the filter would hide the receipt itself, it is dropped (relaxed) and the sort is kept.
 */
export function receiptNav(recent, id, nav, spec = STATUS_ORDERING) {
  let used = nav;
  let list = orderFor(recent, used, spec);
  let relaxed = false;
  if (!list.some((r) => r.key === id) && (nav.result || nav.cause || nav.q)) {
    used = { ...nav, result: '', q: '', ...(nav.cause ? { cause: '' } : {}) };
    list = orderFor(recent, used, spec);
    relaxed = true;
  }
  const index = list.findIndex((r) => r.key === id);
  if (index < 0) return null;
  return { list, index, prev: list[index - 1] ?? null, next: list[index + 1] ?? null, nav: used, row: recent.findIndex((r) => r.key === id) + 1, relaxed, all: recent };
}

/**
 * Previous and Next within one list group: { group, prev, next }. `group` is the one the receipt was opened from (nav.group), else its own.
 * The order is the list's (filter and sort). A receipt that has left the group since (Save moved it from Review to Filed) still counts
 * from where it now sits in the list. Never another group's receipt: at the end, next is null (no falling back to the previous one).
 */
export function groupSteps(where, id, ownGroup) {
  if (!where) return { group: ownGroup, prev: null, next: null };
  const group = where.nav?.group ?? ownGroup;
  const member = (r) => r.key !== id && queueGroup(r) === group;
  return { group, prev: where.list.slice(0, where.index).filter(member).at(-1) ?? null, next: where.list.slice(where.index + 1).find(member) ?? null };
}

// ---- The list page ----

/** The Try again button (a form), or the note why there is none; `extra` adds hidden fields (the receipt page uses it). '' when neither applies. */
export function retryCell(r, key, extra = '') {
  const s = retryStatus(r.key, r);
  if (s === 'yes') {
    return `<form ${post('retry', key)}><input type="hidden" name="entry" value="${escape(r.key)}">${extra}<button class="small plain">Try again</button></form>`;
  }
  // The note is for receipts sitting in Needs review; a cleanly filed one (it keeps `applied` too) needs none.
  if (s === 'undo' && (r.result === 'failed' || String(r.result).endsWith('review') || statusKind(r) === 'applied-review')) return '<span class="muted small">No Try again: Actual was changed.</span>';
  return '';
}

/**
 * The mode line and its notes: a Live / Dry run chip, when the worker last checked, and a small control to switch (going live asks for
 * confirmation on its own page). `pending` = the mode saved in settings when it differs from the one the worker is using.
 */
function modeBar({ dryRun, pending, heartbeat }, key) {
  const chip = dryRun
    ? '<span class="chip dry" title="The worker only logs what it would do. Nothing changes in Actual or Nextcloud."><b>Dry run</b></span>'
    : '<span class="chip" title="The worker writes to Actual and moves files in Nextcloud."><b>Live</b></span>';
  const beat = Number.isNaN(Date.parse(heartbeat)) ? escape(ago(heartbeat)) : `${timeTag(heartbeat, ago(heartbeat))} (${escape(clockOrDate(heartbeat))})`;
  const last = `<span class="muted small when">Last check ${beat} · every ${Math.round(config.pollSeconds / 60)} min</span>`;
  const button = dryRun
    ? `<form method="get" action="go-live" class="modeform"><input type="hidden" name="key" value="${escape(key)}"><button class="small plain">Go live...</button></form>`
    : `<form ${post('mode', key)} class="modeform"><input type="hidden" name="mode" value="dry"><button class="link">Switch to dry run</button></form>`;
  const soon = pending === null || pending === undefined ? '' : `<p class="muted small">Switching to ${pending ? 'dry run' : 'live'} at the start of the next check.</p>`;
  return `<div class="statusbar">${chip}${last}${button}</div>${soon}`;
}

function statusDetails(data) {
  const explain = data.dryRun ? 'Dry run only previews receipts. Nothing changes in Actual or Nextcloud.' : 'Live mode writes to Actual and moves files in Nextcloud.';
  return `<details class="how"><summary>Status details</summary><p>${explain}</p>${data.settings ? `<p class="muted small">Last changed ${escape(when(data.settings.changedAt))}${data.settings.changedBy ? ` from ${escape(data.settings.changedBy)}` : ''}.</p>` : ''}${[data.envNote, data.apiNote].filter(Boolean).map((note) => `<p class="muted small">${escape(note)}</p>`).join('')}</details>`;
}

/** The status cell: the coloured pill and at most one short line. */
function statusCell(r) {
  const short = ['review', 'failed', 'retrying'].includes(statusInfo(r).kind) ? reviewCause(r)?.reason ?? statusInfo(r).short : statusInfo(r).short;
  return `${pillHtml(r)}${short ? ` <div class="line">${escape(short)}</div>` : ''}`;
}

/** The result dropdown: [stored value, plain label], sorted by label. */
function statusFilterValues(recent) {
  const seen = new Map();
  for (const r of recent) seen.set(resultKey(r), statusInfo(r).label + (statusKind(r) === 'done' ? (splitResult(resultKey(r)).base === 'split' ? ' · split purchase' : ' · filed purchase') : ''));
  return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
}

/** "What the statuses mean": every status, where its file is, whether Actual changed, and what to do. */
function statusLegend() {
  const folders = { 'the Inbox': 'the Inbox', 'Needs review': `Needs review (${reviewDir()})`, Processed: `Processed (${processedDir()})`, 'the Archive folder': `the Archive folder (${archiveDir()})` };
  const rows = STATUS_ORDER.map((k) => {
    const st = STATUS[k];
    return `<dt>${escape(st.label)}</dt><dd>File: ${escape(folders[st.where])}. ${escape(st.changed)}. ${escape(st.next)}</dd>`;
  }).join('');
  return `<details class="how"><summary>What the statuses mean</summary>
<dl>${rows}</dl>
<p class="muted small">"Check now" looks at the Inbox right away, including the receipts waiting for their bank charge (otherwise they wait for their re-check time). Try again moves a file from Needs review back to the Inbox so it is read fresh; it is live only, and only appears when Actual was not changed. In a dry run nothing is written or moved and every file stays in the Inbox: those rows are previews, and a dry run review or failure has no Try again. Archiving (live only) moves a Done receipt's photo and summary from Processed to the Archive folder and takes it off this list; it is on the Archived tab, where Restore brings it back.</p>
</details>`;
}

/** The "Archive all done receipts" button (live only, and only when there is something to archive): it opens a confirm page. */
function archiveAllButton(data, key) {
  if (data.dryRun || !data.archivable) return '';
  return `<form method="get" action="archive-all"><input type="hidden" name="key" value="${escape(key)}"><button class="plain">Archive all done receipts (${data.archivable})...</button></form>`;
}

/**
 * The upload control: a button that opens the file picker (a phone offers the camera and the photo library). With JavaScript, choosing files
 * starts the upload at once, one file per request, with progress; without it the form has a Send button. Same as putting files in the Inbox.
 */
function uploadForm(key) {
  return `<form ${post('upload', key)} enctype="multipart/form-data" data-upload data-send="upload?key=${escape(encodeURIComponent(key))}&amp;defer=1" data-run="run?key=${escape(encodeURIComponent(key))}">
<input class="filebtn" id="receipt-files" type="file" name="receipts" multiple required aria-label="Receipt photos or PDFs" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif"><label class="btn plain" for="receipt-files">Upload receipts</label>
<button class="plain" data-nojs>Send the chosen files</button></form>`;
}

/** The two main actions side by side, and what upload does in one small line. */
function actionBar(key, dryRun) {
  return `<div class="actions-bar"><form ${post('run', key)}><button title="Check the Inbox for receipts now">Check now</button></form>
${uploadForm(key)}</div>
<p class="muted small" role="status" data-upload-status></p>
<p class="muted small hint">Photos or PDFs · up to 25 MB each · 20 files at a time.${dryRun ? ' Preview only.' : ''}</p>`;
}

/**
 * data: { dryRun, pending, settings, envNote, heartbeat, alert: { message, at } | null, recent: [{ key, file, done, result, at, ... }], hiddenDone, archivable }
 * `opts.activity`: show "Activity and test mode" (the mode, Check now, the full table, the legend) instead of the "Pick a receipt" landing.
 * Both are in the page; the one not shown is hidden. `opts.group`: the list group the page was reached from (cleaned nav); 'filed' shows
 * Filed open, as after archiving the last Filed receipt.
 */
export function statusPage(data, key, notice, undo, opts = {}) {
  const activity = Boolean(opts.activity);
  const k = escape(encodeURIComponent(key));
  const link = (r) => `<a class="rowlink" data-view href="receipt?key=${k}&amp;id=${escape(encodeURIComponent(r.key))}">${escape(receiptTitle(r))}</a>`;
  const rows = data.recent
    .map((r, i) => {
      const sub = purchaseDate(r);
      return `<tr id="r${i + 1}" data-row data-search="${escape(queueSearch(r))}" data-result="${escape(resultKey(r))}" data-cause="${escape(reviewCause(r)?.cause ?? '')}"><td data-sort="${escape(receiptTitle(r))}">${link(r)}${sub ? ` <div class="sub">Purchase date: ${escape(sub)}</div>` : ''}</td><td data-sort="${escape(resultText(r))}" title="${escape(resultText(r))}">${statusCell(r)}</td><td data-sort="${escape(r.at ?? '')}" title="${escape(when(r.at))}">${timeTag(r.at)}</td><td data-act>${retryCell(r, key)}</td></tr>`;
    })
    .join('');
  const tools = data.recent.length ? toolbar('recent', 'receipts', { selects: [{ field: 'result', label: 'Result', all: 'All results', values: statusFilterValues(data.recent) }, { field: 'cause', label: 'Review cause', all: 'All review causes', values: REVIEW_CAUSES }] }) : '';
  const review = data.recent.filter((r) => queueGroup(r) === 'review');
  const first = review[0];
  const landing = `<section class="workspace-detail status-landing"${activity ? ' hidden' : ''}><div class="pick-pane"><h2>${first ? 'Pick a receipt' : 'All caught up'}</h2><p class="muted">Start with Review. Waiting receipts are checked for you, and Filed ones are handled.</p>${first ? `<p><a class="btn" data-navigate data-open-first href="receipt?key=${k}&amp;id=${escape(encodeURIComponent(first.key))}&amp;group=review">Open first in Review</a></p>` : '<p class="muted">Nothing needs your review.</p>'}</div></section>`;
  const diagnostics = `<section class="workspace-detail status-overview" id="activity"${activity ? '' : ' hidden'}><a class="workspace-back" data-navigate href="./?key=${k}">&larr; Inbox</a><h2>Activity and test mode</h2>${modeBar(data, key)}
${data.stateError ? `<p class="notice err">Can't read the list of receipts: ${escape(data.stateError)}</p>` : ''}
<p class="muted">Waiting receipts are checked automatically.</p><form method="post" action="run?key=${k}&amp;from=activity"><button class="plain">Check now</button></form>
<details class="status-advanced" open><summary>Search, filters and activity</summary>${tools}
<div class="list">${sortable('recent', [['Receipt', 'text', 'receipt'], ['Result', 'text', 'result'], ['Last processed', 'date', 'when'], ''], rows, 'Nothing processed yet', 'cards status')}</div>
${data.hiddenDone ? `<p class="muted small">${data.hiddenDone} older Done receipt${data.hiddenDone === 1 ? ' is' : 's are'} not shown. Receipts that need attention are always listed. Archive the Done ones you have checked to keep this list short; they are on the Archived tab.</p>` : ''}
${archiveAllButton(data, key)}
${statusDetails(data)}
<details class="how"><summary>Upload help</summary><p>Choose JPG, PNG, WebP, HEIC photos or PDFs. Uploads go to the Nextcloud Inbox and are checked automatically.</p></details>
${statusLegend()}</details></section>`;
  const body = `<div class="workspace-shell${activity ? ' has-receipt' : ''}" data-overview>${queueRail(data.recent, key, '', '', railAlerts(data, key), { openGroup: opts.group === 'filed' ? 'filed' : '', activity })}${landing}${diagnostics}</div>`;
  return layout({ active: 'status', key, notice, body, undo, reviewCount: review.length, title: activity ? 'Activity' : '' });
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
  return layout({ active: 'status', key, notice, body, undo, title: 'Go live' });
}
