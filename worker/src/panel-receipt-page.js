// The receipt detail page: the photo, what was read, the bank charge and how it was filed, the "What to do" box, the item
// category editor with its preview, Previous / Next and the help text.
import { config } from './config.js';
import { explainTax } from './reconcile.js';
import { parseStateKey } from './state.js';
import { receiptAnchor, resolveDate } from './dates.js';
import { retryStatus } from './panel-actions.js';
import { escape, layout, post, hidden, money, fact, when, folder, reviewDir, processedDir } from './panel-layout.js';
import { REDO, resultKey, resultText, retryCell, olderChargeNote, splitResult, navQuery, navFields } from './panel-status.js';

/**
 * The purchase date the worker settled on, for the receipt page: { text }. A finished receipt's summary already holds it
 * (receipt.date, null when the printed date was rejected); a waiting or other one is worked out again from the saved
 * reading, the file name and the upload time (saved with the waiting entry; older entries fall back to when it began waiting).
 */
export function dateUsed(view) {
  const none = (printed) => `none (${printed ? 'printed date ignored' : 'no date on the receipt'})`;
  const done = view.summary?.receipt;
  if (done && typeof done === 'object' && 'date' in done) return { text: done.date || none(done.date_as_printed) };
  const r = view.entry?.reading?.receipt;
  if (!r || typeof r !== 'object') return null;
  const modified = [view.entry.lastmod, view.entry.waiting?.since, view.entry.at].map((v) => (v ? new Date(v) : null)).find((d) => d && !Number.isNaN(d.getTime())) ?? new Date();
  const { date: anchor, slackDays } = receiptAnchor(view.name, modified, modified);
  const { date } = resolveDate(r, anchor, { slackDays });
  return { text: date || none(r.date_as_printed || r.date) };
}


/** The one-line "Tax: ..." text from a describeTax shape (saved plan.tax, or explainTax of the reading); '' when it is not usable. */
export function taxLine(t, total = '') {
  if (!t || typeof t !== 'object' || !Array.isArray(t.lines)) return '';
  const rate = (l) => `${l?.code != null && l.code !== '' ? `${l.code} ` : ''}${Number.isFinite(Number(l?.rate)) && Number(l.rate) > 0 ? `${Number(l.rate)}% on ` : 'on '}${l?.base}`;
  if (t.how === 'by-rate' && t.lines.length) return `Tax: ${t.lines.map((l) => `${rate(l)} = ${l?.amount}`).join(' · ')}`;
  if (t.how === 'by-item' && t.lines.length) return `Tax: ${t.lines[0]?.amount} on the taxed items (${rate(t.lines[0])})`;
  if (t.how === 'proportional') return `Tax: ${total ? `${total} ` : ''}spread over all items in proportion${t.reason ? ` (${t.reason})` : ''}`;
  return '';
}

/** What the reader saw: merchant, date, totals, items. `r` is the saved reading (untrusted shape: every field is checked). */
function readingHtml(r, note, dateUsed = null, savedTax = null, itemsHtml = null) {
  if (!r || typeof r !== 'object') return `<p class="muted">${escape(note || 'No saved reading for this receipt.')}</p>`;
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((i) => `<tr><td>${escape(i?.description)}</td><td class="muted">${escape(i?.plain)}</td><td>${escape(money(i?.amount))}${i?.tax_code != null && i.tax_code !== '' ? ` <span class="muted small">${escape(i.tax_code)}</span>` : ''}</td></tr>`)
    .join('');
  const facts = [
    fact('Merchant', r.merchant), ...(dateUsed ? [fact('Purchase date used', dateUsed.text)] : [fact('Date', r.date ?? r.date_as_printed)]), fact('Printed date', r.date_as_printed),
    fact('Subtotal', money(r.subtotal)), fact('Tax', money(r.tax)), fact('Tip', money(r.tip)), fact('Total', money(r.total)),
    fact('Currency', r.currency), fact('Paid with', r.payment_method), fact('Return', r.is_return ? 'yes' : ''),
  ].join('');
  const tl = taxLine(savedTax ?? explainTax(r), money(r.tax));
  return `<table><tbody>${facts}</tbody></table>
${tl ? `<p class="muted small">${escape(tl)}</p>` : ''}
${itemsHtml ?? (items ? `<h2>Items</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Plain</th><th>Amount</th></tr></thead><tbody>${items}</tbody></table></div>` : '')}`;
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

// ---- What to do: one short box, by what became of the receipt ----

const DID = {
  categorize: 'The charge was put in the category shown under Filed as, and a #receipt note was added (it lists the items, or the parts when the receipt had several).',
  split: 'The charge was split into the categories shown under Filed as, with a #receipt note.',
  confirm: 'The charge already had the category the receipt points to, so only a #receipt note listing the items was added.',
  note: 'The charge was not split (splits are turned off, or this Actual connection cannot split), so the category was left as it was and a #receipt note with the breakdown was added.',
  'already-applied': 'Actual already had this receipt\'s #receipt note from an earlier run, so nothing was changed again.',
};
const WOULD = {
  categorize: 'put the charge in the category shown under Filed as',
  split: 'split the charge as shown under Filed as',
  confirm: 'only add a #receipt note, since the category already agrees',
  note: 'leave the category and add a note with the breakdown',
  'already-applied': 'change nothing, since Actual already has this receipt\'s #receipt note',
};


/** The "What to do" box: { warn, lines: [text] }. Plain text; the caller escapes. */
export function whatToDo(entry, id, summary, fix = null) {
  const out = whatToDoBase(entry, id, summary, fix);
  if (entry.fixedOnPage) out.lines.unshift(`The item categories were fixed on this page (${when(entry.fixedOnPage.at)}). The Undo button in the notice works for 15 minutes after saving.`);
  return out;
}

function whatToDoBase(entry, id, summary, fix) {
  const dry = parseStateKey(id).dry;
  const canFix = fix?.ok === true && !fix.dry;
  const r = String(entry.result ?? '');
  if (!entry.done) {
    if (entry.waiting) {
      const hint = olderChargeNote(entry.waiting.reason);
      return {
        warn: false,
        lines: [
          `Waiting for the bank charge: no matching charge is in Actual yet, or it is still pending.${dry ? ' (This is a dry run: nothing is written.)' : ''} It is checked again ${entry.waiting.nextCheck ? `at ${when(entry.waiting.nextCheck)}` : 'soon'}${entry.waiting.until ? `, and it keeps waiting until ${when(entry.waiting.until)}` : ''}.`,
          'Press "Check for receipts now" on the Status tab to look again right away. If the charge never shows up it goes to review.',
          ...(hint ? [hint] : []),
        ],
      };
    }
    if (entry.applied) return { warn: false, lines: ['Actual has been changed and the worker is moving the file. This finishes at the next check; nothing for you to do.'] };
    return { warn: false, lines: [`The last attempt hit an error${entry.error ? ` (${entry.error})` : ''}. It is tried again at the next check; after 3 failed attempts it goes to Needs review.`] };
  }
  const { dryPrefix, base } = splitResult(r);
  const review = base.endsWith('+review');
  const kind = base.replace(/\+review$/, '');
  if (kind === 'failed' && dry) {
    return { warn: true, lines: ['It failed 3 times. This is a dry run, so nothing was written to Actual or moved in Nextcloud. The last error is under Why it needs review.', 'Fix the cause (or wait out an outage), then press Try again.'] };
  }
  if (dry || dryPrefix) {
    if (kind === 'review') return { warn: false, lines: [`This is a dry run preview: nothing was written to Actual or Nextcloud. Live, it would be sent to ${reviewDir()} with nothing changed (see Why it needs review).`, 'Fix the cause if you can, then go live.'] };
    const would = WOULD[kind];
    return { warn: false, lines: [`This is a dry run preview: nothing was written to Actual or Nextcloud. Live, it would ${would ?? 'be processed'}${review ? `, tag the note #review and file the receipt in ${reviewDir()}` : ''}.`, 'If that looks right, go live: receipts seen in dry run are then processed again, for real.'] };
  }
  if (kind === 'failed') {
    return entry.applied
      ? { warn: true, lines: ['It failed 3 times after Actual had already been changed, and went to Needs review. The last error is under Why it needs review.', 'Check the charge in Actual. To read the receipt again, ' + REDO + '.'] }
      : { warn: true, lines: ['It failed 3 times and went to Needs review. Nothing was changed in Actual; the last error is under Why it needs review.', 'Fix the cause (or wait out an outage), then press Try again.'] };
  }
  if (kind === 'review' && !entry.applied) {
    return { warn: true, lines: [`Nothing was changed in Actual. The file is in ${reviewDir()}, with a .json file beside it that says why (see Why it needs review).`, 'Fix the cause (a keyword, a payee alias, a clearer photo) and press Try again, or fix the charge in Actual by hand.', ...(canFix ? [`A charge was matched, so you can also pick the right category for each item under Items below, press Preview, and Apply to Actual: that writes the charge and moves the file to ${processedDir()}.`] : [])] };
  }
  if (kind === 'review') {
    return { warn: true, lines: ['Actual was changed before this went to review. The reasons are under Why it needs review.', 'Check the charge in Actual. To read the receipt again, ' + REDO + '.'] };
  }
  const did = DID[kind];
  if (!did) return { warn: false, lines: [`Result: ${r}.`] };
  const flagged = review || (kind === 'already-applied' && (summary?.problems ?? []).length > 0);
  if (flagged) {
    return { warn: true, lines: [`${did} Something was doubtful, so the note is also tagged #review and the receipt is in Needs review.`, 'Check the charge in Actual (search #review) and fix what is wrong. Removing #review without other changes counts as a confirmation.', ...(canFix ? ['Or fix the item categories on this page (Items, below), Preview and Save to Actual; leave "Mark as checked" ticked to remove #review and move the file to Processed.'] : []), 'To read the receipt again, ' + REDO + '.'] };
  }
  return { warn: false, lines: [did, kind === 'already-applied' ? 'Nothing for you to do.' : `Nothing more to do. If a category is wrong, ${canFix ? 'fix it under Items below (Preview, then Save to Actual) or in Actual' : 'change it in Actual'}: the worker learns from it (Learned tab).`] };
}


// ---- Fixing the items' categories (receipt-fix.js) ----

/** The category dropdown of one item: Uncategorized, then Actual's categories by group (excluded ones marked). */
function pickSelect(item, fix) {
  const known = new Set(fix.options.map((o) => o.label));
  const picked = fix.picks[item.i];
  const groups = [];
  for (const o of fix.options) {
    let g = groups.find((x) => x.name === o.group);
    if (!g) groups.push((g = { name: o.group, options: [] }));
    g.options.push(o);
  }
  const odd = picked !== 'Uncategorized' && !known.has(picked) ? `<option value="${escape(picked)}" selected>${escape(picked)} (not in Actual's list)</option>` : '';
  const opt = (value, text, on) => `<option value="${escape(value)}"${on ? ' selected' : ''}>${escape(text)}</option>`;
  return `<select class="pick" name="c${item.i}" aria-label="Category for ${escape(item.description)}">${odd}${opt('Uncategorized', 'Uncategorized (leave it to me)', picked === 'Uncategorized')}${groups.map((g) => `<optgroup label="${escape(g.name)}">${g.options.map((o) => opt(o.label, `${o.label.slice(g.name.length + 3) || o.label}${o.excluded ? ' (excluded)' : ''}`, o.label === picked)).join('')}</optgroup>`).join('')}</select>`;
}

/** The Items table with a category dropdown per item, and the Preview button. */
function editableItems(r, fix, key, id, nav) {
  const rows = fix.items.map((it) => {
    const src = r.items[it.i];
    return `<tr><td>${escape(it.description)}</td><td class="muted">${escape(it.plain)}</td><td>${escape(money(it.amount))}${src?.tax_code != null && src.tax_code !== '' ? ` <span class="muted small">${escape(src.tax_code)}</span>` : ''}</td><td>${pickSelect(it, fix)}${it.worker !== fix.picks[it.i] ? `<div class="muted small">the worker chose ${escape(it.worker)}</div>` : ''}</td></tr>`;
  }).join('');
  const lead = fix.kind === 'review'
    ? 'Nothing was applied to Actual for this receipt. Pick the right category for each item, press Preview to see how the charge would be divided, then apply it.'
    : 'Pick a different category for any item, press Preview to see how the charge would be divided again (tax included), then save it to Actual.';
  return `<h2>Items</h2><p class="muted small">${escape(lead)} Each item you change is a lesson for the worker.${fix.dry ? ' Dry run: nothing is written.' : ''}</p>
<form method="get" action="receipt">${hidden('key', key)}${hidden('id', id)}${navFields(nav?.nav)}${hidden('preview', '1')}
<div class="scroll"><table><thead><tr><th>Item</th><th>Plain</th><th>Amount</th><th>Category</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><button class="small">Preview</button></p></form>`;
}

/** The preview of the new parts, and (live) the button that writes them. */
function previewHtml(fix, key, id, nav) {
  const pv = fix.preview;
  if (!pv) return '';
  if (pv.error) return `<div class="banner live"><b>Can't preview</b>${escape(pv.error)}</div>`;
  const parts = pv.parts.map((p) => `<tr><td>${escape(p.category)}</td><td>${escape(p.amount)}</td><td class="muted small">${escape(p.items.join('; '))}</td></tr>`).join('');
  const tl = taxLine(pv.tax, '');
  const main = pv.main ? `"${pv.main}"` : '';
  const what = !pv.placed ? 'Nothing is placed in a real category yet: choose a category for at least one item.'
    : pv.note ? `Splits are turned off, so the charge keeps its category "${pv.current}" and the breakdown is added to its note.`
      : pv.split ? `The charge will be split into ${pv.parts.length} parts${pv.wasSplit ? ', replacing the split it has now' : ''}.`
      : pv.parts.length > 1 ? `Splits are turned off, so the whole charge goes to ${main} and the breakdown is added to its note${pv.wasSplit ? ' (the split it has now is removed)' : ''}.`
        : `The whole charge will go to ${main}${pv.wasSplit ? ' (the split it has now is removed)' : ''}.`;
  const none = fix.kind === 'applied' && fix.changed.length === 0 && !pv.review;
  const learn = config.learning.mode === 'off' ? 'Learning is off, so nothing is learned from this.' : `${fix.changed.length ? `${fix.changed.length} changed item${fix.changed.length === 1 ? ' becomes' : 's become'} a lesson for the worker.` : 'No item changed, so nothing is learned.'}`;
  const picks = fix.picks.map((p, i) => hidden(`c${i}`, p)).join('');
  const commit = fix.dry || !pv.placed || none ? '' : `<form ${post('receipt-fix', key)}>${hidden('id', id)}${navFields(nav?.nav)}${picks}${hidden('token', pv.token)}${hidden('state', pv.state)}${pv.review ? '<p><label><input type="checkbox" name="mark" value="yes" checked> Mark as checked: remove #review in Actual and move the file to Processed</label></p>' : ''}<button class="plain">${escape(fix.applyLabel)}</button></form>`;
  return `<div class="banner todo"><b>Preview</b><p>${escape(what)}</p>${(pv.cautions ?? []).map((c) => `<p class="banner live">${escape(c)}</p>`).join('')}
<div class="scroll"><table><thead><tr><th>Category</th><th>Amount</th><th>Items</th></tr></thead><tbody>${parts}</tbody></table></div>
${tl ? `<p class="muted small">${escape(tl)}</p>` : ''}${pv.problems.length ? `<ul class="small">${pv.problems.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>` : ''}
<p class="muted small">${escape(learn)}${pv.willMove && !fix.dry ? ` The file moves to ${escape(folder(pv.willMove))}.` : ''}</p>
${fix.dry ? '<p><b>Dry run: nothing is written.</b> Go live to save changes.</p>' : none ? '<p class="muted">No category differs from what is in Actual now, so there is nothing to save.</p>' : commit}</div>`;
}

/** Collapsible help for the page. */
const how = () => `<details class="how"><summary>How this page works</summary>
<dl>
<dt>Photo</dt><dd>The receipt as the worker has it now (a PDF shows up to 3 pages and can be downloaded). It is read from Nextcloud when you open this page.</dd>
<dt>What was read</dt><dd>What the reader saw: store, totals and items. <b>Purchase date used</b> is the date the worker settled on for matching: the printed date when it is plausible next to when the photo was taken (the date in a camera-style file name) or uploaded, otherwise none (the receipt is then matched by amount and store only). <b>Printed date</b> is the date text exactly as printed on the receipt, shown below it.</dd>
<dt>Bank charge</dt><dd>The transaction in Actual this receipt was matched to. It is missing when no charge was found.</dd>
<dt>Filed as</dt><dd>How the charge was divided across categories, with the amounts.</dd>
<dt>Why it needs review</dt><dd>The reasons the worker was unsure. They are also in the .json file next to the receipt in ${escape(reviewDir())}.</dd>
<dt>Result words</dt><dd><b>categorize</b>: the charge got a category. <b>split</b>: it was split across categories. <b>confirm</b>: the category already agreed; only a note was added. <b>note</b>: a note with the breakdown was added (splits are off or not supported). <b>+review</b> after one of these: it was applied, but part is doubtful, so the note is tagged #review. <b>review</b>: nothing was changed in Actual. <b>failed</b>: it failed 3 times. <b>waiting</b>: the bank charge has not shown up yet. <b>dry-run:</b> in front: a preview, nothing was written.</dd>
<dt>Where files go</dt><dd>Receipts that need review are moved to ${escape(reviewDir())} with a .json that gives the reason. Others go to ${escape(processedDir())}.</dd>
<dt>#review</dt><dd>Search for it in Actual to find the charges that were changed but need a look. Remove the tag when you are happy with them.</dd>
<dt>Items and categories</dt><dd>When a bank charge was matched, each item has a category menu. Change what is wrong and press <b>Preview</b>: it shows how the charge would be divided again, tax included, and what would be written. <b>Save to Actual</b> (a receipt already applied) rewrites the charge, replacing its split; <b>Apply to Actual</b> (a receipt in Needs review) writes it and moves the file to ${escape(processedDir())}. Saving refuses if the charge was changed in Actual since the worker wrote it. Each item you change becomes a lesson, as if you had corrected it in Actual. An Undo button appears for 15 minutes. In a dry run you only get the preview.</dd>
<dt>Try again</dt><dd>Only for a live receipt that went to review (or failed) without changing Actual. It moves the file back to the inbox, so the next check reads it fresh. If Actual was changed, ${escape(REDO)}.</dd>
<dt>Previous / Next</dt><dd>Walk through the receipts in the order the list showed when you pressed View, including its filter and sort. The arrow keys do the same, and the menu jumps to any receipt.</dd>
</dl></details>`;

/** Previous / Next with the position, and (once) the jump list. */
function pagerHtml(nav, key, withJump) {
  const k = escape(encodeURIComponent(key));
  const q = escape(navQuery(nav.nav));
  const to = (r) => `receipt?key=${k}&amp;id=${escape(encodeURIComponent(r.key))}${q}`;
  const link = (r, rel, text) => (r ? `<a class="btn" rel="${rel}" href="${to(r)}">${text}</a>` : `<span class="btn" aria-disabled="true">${text}</span>`);
  const filter = [nav.nav.result && `result: ${nav.nav.result}`, nav.nav.q && `text: ${nav.nav.q}`].filter(Boolean).join(', ');
  const jump = withJump
    ? `<form method="get" action="receipt">${hidden('key', key)}${navFields(nav.nav)}<label class="nobtn" for="jump">Go to a receipt</label><select id="jump" name="id" data-jump>${nav.list.map((r, i) => `<option value="${escape(r.key)}"${i === nav.index ? ' selected' : ''}>${escape(`${r.file} (${resultKey(r)})`)}</option>`).join('')}</select><button class="small plain" data-nojs>Go</button></form>`
    : '';
  return `<div class="pager">${link(nav.prev, 'prev', '&larr; Previous')}<span class="pos">${nav.index + 1} of ${nav.list.length}${filter ? ` <span class="muted small">(${escape(filter)})</span>` : ''}</span>${link(nav.next, 'next', 'Next &rarr;')}${jump}</div>`;
}

/** The receipt detail page. view: from panel-receipt.js receiptView(). nav: from receiptNav() (null when the receipt is not in the list). */
export function receiptPage(view, key, notice, nav = null, undo = null) {
  const { entry, id } = view;
  const photoUrl = (extra) => `receipt-photo?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}${extra}`;
  const photos = Array.from({ length: view.pages }, (_, i) => `<img class="photo" src="${escape(photoUrl(`&page=${i + 1}`))}" alt="Receipt ${escape(view.name)}, page ${i + 1}">`).join('');
  const pdfLink = view.pdf && view.pages ? `<p><a href="${escape(photoUrl('&raw=1'))}">Download the original PDF</a></p>` : '';
  const reading = entry.reading?.receipt ?? view.summary?.receipt ?? null;
  const todo = whatToDo(entry, id, view.summary, view.fix);
  const status = retryStatus(id, { ...entry, key: id });
  const after = nav ? (nav.next ?? nav.prev) : null; // where Try again goes on to: this receipt leaves the list
  const retry = status === 'yes'
    ? retryCell({ ...entry, key: id }, key, `${hidden('from', 'receipt')}${hidden('next', after?.key ?? '')}${navFields(nav?.nav)}`)
    : ''; // when Actual was changed, the box above already says to undo it there first
  const todoHtml = `<div class="banner todo${todo.warn ? ' live' : ''}"><b>What to do</b>${todo.lines.map((l) => `<p>${escape(l)}</p>`).join('')}${retry.replace('class="small plain"', 'class="plain"')}</div>`;
  const back = `./?key=${escape(encodeURIComponent(key))}${escape(navQuery(nav?.nav))}${nav ? `#r${nav.row}` : ''}`;
  const fix = view.fix?.ok ? view.fix : null;
  const itemsHtml = fix && reading && Array.isArray(reading.items) ? editableItems(reading, fix, key, id, nav) : null;
  const whyNot = !fix && view.fix?.reason && entry.done ? `<p class="muted small">Categories can't be fixed here: ${escape(view.fix.reason)}</p>` : '';
  const body = `<h2>${escape(view.name)}</h2>
<p class="muted">${escape(resultText(entry))}${entry.at ? ` · ${escape(when(entry.at))}` : ''}${entry.filedAs ? ` · filed as ${escape(entry.filedAs)}` : ''}${entry.error ? ` · last error: ${escape(entry.error)}` : ''}</p>
<p><a href="${back}">Back to the list</a></p>
${nav ? pagerHtml(nav, key, true) : ''}${nav?.relaxed ? '<p class="muted small">This receipt is not in the filtered list, so all receipts are shown here.</p>' : ''}
${todoHtml}
<div class="receipt-grid">
<div class="receipt-photos">${photos || `<p class="muted">${escape(view.photoNote || 'No photo to show.')}</p>`}${pdfLink}</div>
<div>
<h2>What was read</h2>
${readingHtml(reading, view.summaryNote, dateUsed(view), view.summary?.plan?.tax, itemsHtml)}
${itemsHtml ? previewHtml(fix, key, id, nav) : whyNot}
${decisionHtml(view.summary)}
</div>
</div>
${nav ? pagerHtml(nav, key, false) : ''}
${how()}`;
  return layout({ active: 'status', key, notice, body, undo, wide: true });
}
