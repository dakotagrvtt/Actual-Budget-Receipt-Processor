// The Status tab: the list of receipts with their status in plain words (one STATUS table feeds the list and its legend),
// the filter / sort / Previous-Next order, the dry run / live banner and the go-live page.
import { config } from './config.js';
import { parseStateKey } from './state.js';
import { inFolder } from './folders.js';
import { retryStatus } from './panel-actions.js';
import { rowVisible, sortItems } from './panel-script.js';
import { escape, layout, post, hidden, toolbar, sortable, when, reviewDir, processedDir } from './panel-layout.js';

// ---- The status of a receipt in plain words: one table feeds the list and its legend ----

// What to do to read an applied receipt again. The file can't just be moved back by hand: the worker remembers a file by its
// name and version (the state key), so it would be skipped as done; it has to be uploaded again.
export const REDO = 'undo it in Actual (restore the category or remove the split, and remove the #receipt note), delete the file from Needs review, and upload the receipt again';

const STATUS = {
  waiting: { label: 'Waiting for the bank charge', where: 'the Inbox', changed: 'Nothing changed in Actual', next: 'The worker looks again by itself. Press "Check for receipts now" to look right away. If the charge never shows up it goes to review.' },
  retrying: { label: 'Retrying after an error', where: 'the Inbox', changed: 'Not finished yet', next: 'Tried again at the next check. After 3 failed attempts it goes to Needs review.' },
  applying: { label: 'Finishing up', where: 'the Inbox', changed: 'Changed in Actual', next: 'Nothing to do. The file is moved at the next check.' },
  done: { label: 'Done', where: 'Processed', changed: 'Actual updated', next: 'Nothing to do. If a category is wrong, fix it on the receipt\'s page (View) or in Actual; the worker learns from it.' },
  preview: { label: 'Preview (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'This is what it would do. If it looks right, go live.' },
  'preview-failed': { label: 'Failed (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Open it to see the last error. Fix the cause, then go live (Try again is live only).' },
  'preview-review': { label: 'Needs review (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Open it to see why. Fix the cause if you can, then go live (Try again is live only).' },
  'preview-retrying': { label: 'Retrying after an error (dry run)', where: 'the Inbox', changed: 'Nothing written, nothing moved', next: 'Tried again at the next check. After 3 failed attempts it shows as failed here (Try again is live only).' },
  review: { label: 'Needs your review', where: 'Needs review', changed: 'Nothing changed in Actual', next: 'Open it to see why. Fix the cause, then press Try again. If a charge was matched you can also fix the item categories on its page and apply them to Actual.' },
  'applied-review': { label: 'Applied — check it in Actual', where: 'Needs review', changed: 'Changed in Actual and tagged #review', next: 'Check it in Actual and remove the #review tag if it is right, or open it and fix the item categories on its page. If not, ' + REDO + '.' },
  failed: { label: 'Failed', where: 'Needs review', changed: 'Nothing changed in Actual', next: 'Fix the cause (or wait out an outage), then press Try again.' },
  'failed-applied': { label: 'Failed after Actual was changed', where: 'Needs review', changed: 'Changed in Actual', next: 'Check the charge in Actual. To read the receipt again, ' + REDO + '.' },
};
const STATUS_ORDER = ['waiting', 'retrying', 'applying', 'done', 'review', 'applied-review', 'failed', 'failed-applied', 'preview', 'preview-review', 'preview-failed', 'preview-retrying'];

/** Was the file filed under the Needs review folder (leading slashes ignored)? */
const filedInReview = (filedAs) => Boolean(filedAs) && inFolder(filedAs, config.nextcloud.review);

/** A result word split into whether it carries the dry run prefix and the word without it. */
export function splitResult(result) {
  const res = String(result ?? '');
  return { dryPrefix: res.startsWith('dry-run:'), base: res.replace(/^dry-run:/, '') };
}

/** Which STATUS a list entry is in. */
function statusKind(r) {
  const { dryPrefix, base } = splitResult(r.result);
  const dry = parseStateKey(String(r.key ?? '')).dry || dryPrefix; // dry review/failed results carry no prefix; the key does
  if (!r.done) return r.waiting ? 'waiting' : r.applied ? 'applying' : dry ? 'preview-retrying' : 'retrying';
  if (dry) return base === 'failed' ? 'preview-failed' : base === 'review' ? 'preview-review' : 'preview';
  if (base === 'failed') return r.applied ? 'failed-applied' : 'failed';
  if (base === 'review') return r.applied ? 'applied-review' : 'review';
  if (base.endsWith('+review')) return 'applied-review';
  if (base === 'already-applied' && filedInReview(r.filedAs)) return 'applied-review'; // the charge's note carried #review
  return 'done';
}

/** "Older charge matches: 2026-02-20 42.17, check it." from a waiting reason that carries the older-charge hint, else ''. */
export function olderChargeNote(reason) {
  const text = String(reason ?? '');
  const at = text.indexOf('an older charge matches, check it: ');
  if (at < 0) return '';
  const found = [...text.slice(at).matchAll(/(\d{4}-\d\d-\d\d) [^"]*?(-?[\d,]*\d\.\d\d) "/g)].map((m) => `${m[1]} ${m[2]}`);
  if (found.length === 0) return '';
  return `Older charge matches: ${found.slice(0, 2).join(', ')}${found.length > 2 ? ` (+${found.length - 2} more)` : ''}, check it.`;
}

/** The status as the list shows it: { kind, label, line } where line = where the file is, what changed, what to do (plain text). */
function statusInfo(r) {
  const kind = statusKind(r);
  const st = STATUS[kind];
  const where = `In ${st.where}`;
  let next = st.next;
  let extra = '';
  if (kind === 'waiting') {
    next = `Re-checked ${r.waiting.nextCheck ? `at ${when(r.waiting.nextCheck)}` : 'soon'}, or press "Check for receipts now".`;
    const hint = olderChargeNote(r.waiting.reason);
    extra = hint ? ` ${hint}` : '';
  } else if (kind === 'done') next = 'Nothing to do.';
  return { kind, label: st.label, line: `${where}. ${st.changed}. ${next}${extra}` };
}

/** The plain label of a list entry's status (what the Result column sorts on). */
export const resultText = (r) => statusInfo(r).label;

/** The words the text filter searches, in the order the browser sees them in a row (file, label, raw word, next-step line, when). */
const rowWords = (r) => {
  const { label, line } = statusInfo(r);
  return `${r.file} ${label} ${resultKey(r)} ${line} ${when(r.at)}`;
};

/** The word the result dropdown filters on. */
export function resultKey(r) {
  if (r.done) return String(r.result ?? '');
  if (r.waiting) return 'waiting';
  return r.applied ? 'applying' : 'retrying';
}

// The View links get the list's filter and sort added by the script (data-view), so Previous / Next follow what you saw.
const viewLink = (r, key) => `<a data-view href="receipt?key=${escape(encodeURIComponent(key))}&amp;id=${escape(encodeURIComponent(r.key))}">View</a> `;

// ---- Previous / Next: the receipts in the order (and with the filter) the list had when View was pressed ----

const NAV_SORTS = { receipt: (r) => r.file, result: (r) => resultText(r), when: (r) => r.at ?? '' };
const NAV_TYPES = { receipt: 'text', result: 'text', when: 'date' };

/** The list's filter and sort from a query (URLSearchParams or form), cleaned: only known names, short values. */
export function cleanNav(params) {
  const get = (n) => String(params.get(n) ?? '').slice(0, 100);
  const sort = Object.hasOwn(NAV_SORTS, get('sort')) ? get('sort') : '';
  return { result: get('result').slice(0, 60), q: get('q'), sort, dir: sort && ['asc', 'desc'].includes(get('dir')) ? get('dir') : '' };
}
/** The nav as query text (starts with &, empty when nothing is set). Not escaped for HTML. */
export const navQuery = (nav) => ['result', 'q', 'sort', 'dir'].filter((n) => nav?.[n]).map((n) => `&${n}=${encodeURIComponent(nav[n])}`).join('');
/** The nav as hidden form fields. */
export const navFields = (nav) => ['result', 'q', 'sort', 'dir'].filter((n) => nav?.[n]).map((n) => hidden(n, nav[n])).join('');

/** The receipts as the list shows them: filtered by result and text, then sorted like a click on the column header. */
export function orderFor(recent, nav) {
  const shown = recent.filter((r) => rowVisible(rowWords(r), { result: resultKey(r) }, nav.q, [{ field: 'result', value: nav.result }]));
  if (!nav.sort) return shown;
  const items = shown.map((r, i) => ({ r, v: String(NAV_SORTS[nav.sort](r)), i })); // i: the list's own order, the tie-break
  return sortItems(items, nav.dir === 'desc' ? -1 : 1, NAV_TYPES[nav.sort]).map((x) => x.r);
}

/**
 * Where a receipt sits in the list: { list, index, prev, next, nav, row, relaxed }, or null when it is not among the receipts listed.
 * When the filter would hide the receipt itself, it is dropped (relaxed) and the sort is kept.
 */
export function receiptNav(recent, id, nav) {
  let used = nav;
  let list = orderFor(recent, used);
  let relaxed = false;
  if (!list.some((r) => r.key === id) && (nav.result || nav.q)) {
    used = { ...nav, result: '', q: '' };
    list = orderFor(recent, used);
    relaxed = true;
  }
  const index = list.findIndex((r) => r.key === id);
  if (index < 0) return null;
  return { list, index, prev: list[index - 1] ?? null, next: list[index + 1] ?? null, nav: used, row: recent.findIndex((r) => r.key === id) + 1, relaxed };
}

// ---- The list page ----

/** The Try again button (a form), or the note why there is none; `extra` adds hidden fields (the receipt page uses it). '' when neither applies. */
export function retryCell(r, key, extra = '') {
  const s = retryStatus(r.key, r);
  if (s === 'yes') {
    return `<form ${post('retry', key)}><input type="hidden" name="entry" value="${escape(r.key)}">${extra}<button class="small plain">Try again</button></form>`;
  }
  // The note is for receipts sitting in Needs review; a cleanly filed one (it keeps `applied` too) needs none.
  if (s === 'undo' && (r.result === 'failed' || String(r.result).endsWith('review') || statusKind(r) === 'applied-review')) return `<span class="muted small">No Try again: Actual was changed. Check it there; to read the receipt again, ${escape(REDO)}.</span>`;
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

/** The Result cell: the plain label, the raw result word (small), and one line on where the file is and what to do. */
function statusCell(r) {
  const { label, line } = statusInfo(r);
  return `<b>${escape(label)}</b> <span class="muted small">${escape(resultKey(r))}</span> <div class="muted small">${escape(line)}</div>`;
}

/** The result dropdown: [raw word, "label (raw word)"], sorted by label. */
function statusFilterValues(recent) {
  const seen = new Map();
  for (const r of recent) seen.set(resultKey(r), `${statusInfo(r).label} (${resultKey(r)})`);
  return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
}

/** "What the statuses mean": every status, where its file is, whether Actual changed, and what to do. */
function statusLegend() {
  const folders = { 'the Inbox': 'the Inbox', 'Needs review': `Needs review (${reviewDir()})`, Processed: `Processed (${processedDir()})` };
  const rows = STATUS_ORDER.map((k) => {
    const st = STATUS[k];
    return `<dt>${escape(st.label)}</dt><dd>File: ${escape(folders[st.where])}. ${escape(st.changed)}. ${escape(st.next)}</dd>`;
  }).join('');
  return `<details class="how"><summary>What the statuses mean</summary>
<dl>${rows}</dl>
<p class="muted small">"Check for receipts now" looks at the Inbox right away, including the receipts waiting for their bank charge (otherwise they wait for their re-check time). Try again moves a file from Needs review back to the Inbox so it is read fresh; it is live only, and only appears when Actual was not changed. In a dry run nothing is written or moved and every file stays in the Inbox: those rows are previews, and a dry run review or failure has no Try again.</p>
</details>`;
}

/** data: { dryRun, pending, settings, envNote, heartbeat, alert: { message, at } | null, recent: [{ key, file, done, result, at, ... }] } */
export function statusPage(data, key, notice, undo) {
  const rows = data.recent
    .map((r, i) => `<tr id="r${i + 1}" data-row data-result="${escape(resultKey(r))}"><td>${escape(r.file)}</td><td data-sort="${escape(resultText(r))}" title="${escape(resultKey(r))}">${statusCell(r)}</td><td data-sort="${escape(r.at ?? '')}">${escape(when(r.at))}</td><td data-act>${viewLink(r, key)}${retryCell(r, key)}</td></tr>`)
    .join('');
  const tools = data.recent.length ? toolbar('recent', 'receipts', { selects: [{ field: 'result', label: 'Result', all: 'All results', values: statusFilterValues(data.recent) }] }) : '';
  const body = `${alertBanner(data.alert)}${settingsBanner(data, key)}${readerBanner()}${modeBanner(data, key)}
${data.stateError ? `<p class="notice">Can't read the list of receipts: ${escape(data.stateError)}</p>` : ''}
<div class="muted">last check ${escape(data.heartbeat)} · checks every ${Math.round(config.pollSeconds / 60)} min</div>
<form ${post('run', key)}><button>Check for receipts now</button></form>
${statusLegend()}
${tools}
${sortable('recent', [['Receipt', 'text', 'receipt'], ['Result', 'text', 'result'], ['When', 'date', 'when'], ''], rows, 'Nothing processed yet')}`;
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
