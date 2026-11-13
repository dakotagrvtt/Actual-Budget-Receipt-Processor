// The Archived tab: the receipts you archived (searchable and sortable), Restore, and a short "How archiving works". Also the
// confirm page behind "Archive all done receipts" on the Status tab. Pure: data in, HTML out (trigger.js fetches the data).
import { config, filesPlace } from './config.js';
import { BULK_LIMIT } from './archive-rules.js';
import { STATUS_ORDERING, archiveBanner, receiptNav, orderFor, navQuery } from './panel-status.js';
import { archiveRail, archiveSearch } from './panel-queue.js';
import { escape, layout, post, when, processedDir, archiveDir } from './panel-layout.js';


/** How the Archived list is filtered and sorted (and so how Previous / Next walk it on an archived receipt's page). */
export const ARCHIVE_ORDERING = {
  words: (r) => archiveSearch(r),
  fields: () => ({}),
  wants: () => [],
  sorts: { receipt: (r) => r.file, store: (r) => r.card?.store ?? '', date: (r) => r.card?.date ?? '', total: (r) => r.card?.total ?? '', archived: (r) => r.archived?.at ?? '' },
  types: { receipt: 'text', store: 'text', date: 'date', total: 'num', archived: 'date' },
};

/** Where an archived receipt sits in the Archived list (receiptNav for the archived list); null when it is not in it. */
export function archivedNav(archived, id, nav) {
  const spec = { ...STATUS_ORDERING, ...ARCHIVE_ORDERING };
  const where = receiptNav(archived, id, nav, spec);
  // `full`: the whole Archive list in the chosen sort, for the list pane beside the receipt (a search only hides rows there).
  return where && { ...where, full: orderFor(archived, { ...where.nav, q: '' }, spec) };
}

/** The help box: what moves where, the shrinking, the automatic setting, and Restore. */
function how() {
  const { afterDays, shrink } = config.archive;
  const auto = afterDays > 0
    ? `Automatic archiving is on: a Done receipt is archived by itself once it is ${afterDays} day${afterDays === 1 ? '' : 's'} old (a restored one counts from when you restored it).`
    : 'Automatic archiving is off. To turn it on, set "Archive done receipts after (days)" under Advanced on the Settings tab (ARCHIVE_AFTER_DAYS in .env).';
  return `<details class="how"><summary>How archiving works</summary>
<dl>
<dt>What moves</dt><dd>When you archive a receipt, its photo and its .json summary move from ${escape(processedDir())} to ${escape(archiveDir())}, into a folder for the month of the receipt (for example ${escape(archiveDir())}/2026-03). Nothing changes in Actual. The receipt leaves the Status list and appears here.</dd>
<dt>Smaller files</dt><dd>${shrink ? 'The photo is saved again as a smaller JPEG (at most 2400 pixels on the long side), but only when that saves at least 10%. The original is replaced, so the full-size photo is gone; the small one is still readable. PDFs are moved as they are.' : 'Photos are moved as they are (shrinking is off in the settings).'} What the worker keeps about the receipt in its own list is also cut down to the essentials; the full summary stays in the .json file next to the photo.</dd>
<dt>Archiving by itself</dt><dd>${escape(auto)} Receipts that still carry #review in Actual are never archived by themselves.</dd>
<dt>Opening one</dt><dd>View shows the photo, the items and the tax line from the archive. Its categories can't be changed while it is archived.</dd>
<dt>Restore</dt><dd>Restore moves the photo and summary back to ${escape(processedDir())} and puts the receipt on the Status list again. If the photo was shrunk, the shrunk photo comes back.</dd>
</dl></details>`;
}

/** What the Archive list pane says when it has no rows. */
export const archiveEmpty = (dryRun) => (dryRun
  ? 'You are in dry run. Archived receipts belong to live mode, so none are listed. Go live to see them.'
  : 'Nothing is archived yet. Open a Done receipt and press "Archive receipt", or press "Archive all done receipts" under Activity and test mode.');

/**
 * The Archive tab: the approved two-pane layout. The list pane (← Receipts, search, sort, rows with Restore) is the same pane that stays
 * beside an opened archived receipt; the right side asks you to pick one and keeps the "How archiving works" help.
 * data: { archived: [{ key, file, archived: { at, auto, ... }, card: { store, date, total } }], dryRun, stateError, nav }
 */
export function archivedPage(data, key, notice, undo) {
  const nav = data.nav ?? {};
  const spec = { ...STATUS_ORDERING, ...ARCHIVE_ORDERING };
  const shown = orderFor(data.archived, { ...nav, q: '' }, spec);
  const rail = archiveRail(shown, key, { nav: navQuery({ sort: nav.sort, dir: nav.dir }), sort: nav, empty: archiveEmpty(data.dryRun) });
  const detail = `<section class="workspace-detail archive-landing">${archiveBanner(key)}${data.stateError ? `<p class="notice err">Can't read the list of receipts: ${escape(data.stateError)}</p>` : ''}<div class="pick-pane archive-prompt"><h2>Pick an archived receipt</h2><p class="muted">Archived receipts are read-only. Restore one to work on it again.</p></div>${how()}</section>`;
  return layout({ active: 'archived', key, notice, body: `<div class="workspace-shell archive-shell">${rail}${detail}</div>`, undo, title: 'Archive', heading: 'Archive' });
}

/** The confirm step before archiving every Done receipt. data: { dryRun, count } */
export function archiveAllPage(data, key, notice, undo) {
  const back = `<p><a href="./?key=${escape(encodeURIComponent(key))}">Back to the Status list</a></p>`;
  let body;
  if (data.dryRun) body = `<h2>Archive all done receipts</h2><p>This is a dry run: nothing is moved. Go live first.</p>${back}`;
  else if (!data.count) body = `<h2>Archive all done receipts</h2><p>There are no Done receipts to archive.</p>${back}`;
  else {
    const { shrink } = config.archive;
    const batch = data.count > BULK_LIMIT ? ` They are archived ${BULK_LIMIT} at a time: press the button again for the rest.` : '';
    body = `<h2>Archive ${data.count} done receipt${data.count === 1 ? '' : 's'}?</h2>
<div class="banner live"><b>This moves files in ${filesPlace()}.</b>
The photo and summary of each Done receipt move from ${escape(processedDir())} to ${escape(archiveDir())}, into a folder for each month.${shrink ? ' Photos are saved again as smaller JPEGs (PDFs are not changed); the full-size original is replaced and can\'t be brought back.' : ''}${escape(batch)}</div>
<p class="muted">Nothing changes in Actual. Receipts that still need a look (tagged #review, or in Needs review) are not included. You can restore any of them from the Archived tab.</p>
<form ${post('archive-all', key)}><button class="danger">Archive ${data.count} receipt${data.count === 1 ? '' : 's'}</button></form>
<p><a href="./?key=${escape(encodeURIComponent(key))}">Cancel</a></p>`;
  }
  return layout({ active: 'status', key, notice, body, undo, title: 'Archive all done receipts' });
}
