// The receipt detail page: the photo, what was read, the bank charge and how it was filed, the actions box, the item
// category editor with its preview, Previous / Next and the help text.
import { config } from './config.js';
import { actualAnchor } from './actual-link.js';
import { queueRail, archiveRail, queueIdentity, queueGroup } from './panel-queue.js';
import { REVIEW_CAUSES } from './review-cause.js';
import { explainTax, noChargeKind } from './reconcile.js';
import { parseStateKey } from './state.js';
import { receiptAnchor, resolveDate } from './dates.js';
import { retryStatus, signUndo, UNDO_WINDOW_MS } from './panel-actions.js';
import { canArchive, undoOpen } from './archive-rules.js';
import { resolveDryRun } from './settings.js';
import { ARCHIVED, plainReason, MAX_UNDO_ID, UNDO_ROUTE, filedCategory } from './receipt-fix.js';
import { rereadState, restoreState, READING_AGAIN, NOTE_HOURS } from './reread.js';
import { escape, layout, post, hidden, undoForm, money, displayMoney, displayDate, fact, when, shortWhen, ago, folder, reviewDir, processedDir, archiveDir } from './panel-layout.js';
import { REDO, cardText, receiptTitle, purchaseDate, pillHtml, resultKey, resultText, retryCell, olderChargeNote, splitResult, navQuery, navFields, withoutGroup, groupSteps } from './panel-status.js';

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
const taxRate = (l) => `${l?.code != null && l.code !== '' ? `${l.code} ` : ''}${Number.isFinite(Number(l?.rate)) && Number(l.rate) > 0 ? `${Number(l.rate)}% on ` : 'on '}${l?.base}`;
export function taxLine(t, total = '') {
  if (!t || typeof t !== 'object' || !Array.isArray(t.lines)) return '';
  const rate = taxRate;
  if (t.how === 'by-rate' && t.lines.length) return `Tax: ${t.lines.map((l) => `${rate(l)} = ${l?.amount}`).join(' · ')}`;
  if (t.how === 'by-item' && t.lines.length) return `Tax: ${t.lines[0]?.amount} on the taxed items (${rate(t.lines[0])})`;
  if (t.how === 'proportional') return `Tax: ${total ? `${total} ` : ''}spread over all items in proportion${t.reason ? ` (${t.reason})` : ''}`;
  return '';
}

/** The tax note under the split, one line per rate when the tax was worked out by rate: ["Tax: T 8.6% on 14.97 = 1.29", ...]; [] when there is none. */
export function taxLines(t, total = '') {
  if (t?.how === 'by-rate' && Array.isArray(t.lines) && t.lines.length) return t.lines.map((l) => `Tax: ${taxRate(l)} = ${l?.amount}`);
  const one = taxLine(t, total);
  return one ? [one] : [];
}

/** What the reader saw: merchant, date, totals, items. `r` is the saved reading (untrusted shape: every field is checked). */
function readingHtml(r, note, dateUsed = null, savedTax = null, itemsHtml = null) {
  if (!r || typeof r !== 'object') return `<p class="muted">${escape(note || 'No saved reading for this receipt.')}</p>`;
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((i) => `<tr><td>${escape(i?.description)}</td><td class="muted">${escape(i?.plain)}${i?.flippedSign === true ? `<div class="small">${escape(FLIPPED)}</div>` : ''}</td><td>${escape(money(i?.amount))}${i?.tax_code != null && i.tax_code !== '' ? ` <span class="muted small">${escape(i.tax_code)}</span>` : ''}</td></tr>`)
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

/** The charge's category as the page can know it: "Split" for a split the worker wrote, the one category it wrote, else the one it had when matched. */
function categoryNow(s, t) {
  const plan = s.plan;
  if (plan?.applied && plan.action === 'split') return 'Split (see Filed as)';
  if (plan?.applied && plan.action === 'categorize') return (Array.isArray(plan.parts) ? plan.parts.find((p) => p?.category && p.category !== 'Uncategorized')?.category : null) ?? t.currentCategory;
  return t.currentCategory;
}

function reviewReasons(summary) {
  return (Array.isArray(summary?.problems) ? summary.problems : []).map((problem) => noChargeKind(summary) === 'cash' && /paid in cash|no bank charge.*enter it in Actual by hand/i.test(String(problem))
    ? 'Paid in cash. Create this purchase here, or archive it if you already entered it in Actual.' : String(problem));
}

/** The decision from the filed summary: transaction, plan, problems (the review reasons). */
function decisionHtml(s) {
  if (!s || typeof s !== 'object') return '';
  const t = s.transaction && typeof s.transaction === 'object' ? s.transaction : null;
  const parts = (Array.isArray(s.plan?.parts) ? s.plan.parts : []).map((p) => `<li>${escape(p?.category)}: ${escape(p?.amount)}</li>`).join('');
  return `${t ? `<h2>Bank charge</h2><table><tbody>${fact('Payee', t.payee)}${fact('Date', t.date)}${fact('Amount', t.amount)}${fact('Account', t.account)}${fact('Category now', categoryNow(s, t))}</tbody></table>` : ''}
${parts ? `<h2>Filed as</h2><ul>${parts}</ul>` : ''}

${s.reread?.doubts ? `<h2>About the new reading</h2>${s.reread.doubts.length ? `<ul>${s.reread.doubts.map((d) => `<li>${escape(d)}</li>`).join('')}</ul>` : '<p class="muted small">Nothing doubtful.</p>'}<p class="muted small">Reading again did not change the #review tag in Actual.</p>` : ''}
${s.waiting ? `<p class="banner">${escape(s.waiting)}</p>` : ''}`;
}

// ---- What to do (the actions box at the top): one short box, by what became of the receipt ----

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


/** The "What to do" box of an archived receipt: where it is, how the photo was stored, and that Restore is the way back. */
function archivedToDo(entry) {
  const a = entry.archived;
  return {
    warn: false,
    lines: [
      ARCHIVED,
      `It was archived ${when(a.at)}${a.auto ? ' by itself' : ''}${a.reason ? ` (${a.reason})` : ''}; the photo and summary are in ${dirOf(entry.filedAs)}.`,
      ...(a.fileMissing ? ['The photo was already gone from Nextcloud when it was archived, so only the summary was filed.'] : a.shrunk ? [`The photo was shrunk when it was archived (${a.shrunk.before} to ${a.shrunk.after} bytes).`] : []),
    ],
  };
}
const dirOf = (p) => String(p ?? '').replace(/\/[^/]*$/, '').replace(/^\/+/, '');

/** The "What to do" box: { warn, lines: [text] }. Plain text; the caller escapes. */
export function whatToDo(entry, id, summary, fix = null) {
  const out = whatToDoBase(entry, id, summary, fix);
  if (entry.reviewed && !entry.archived) out.lines.splice(1, 0, '#review was removed from the charge in Actual, so this counts as reviewed.');
  // Read again (reread.js): asked and not done yet; done (the editor starts from the new reading); put back; or refused by the worker.
  const at = (t) => Date.parse(t ?? '');
  const later = (t, than) => at(t) > Math.max(0, ...than.map(at).filter(Number.isFinite)); // t is after all of `than` (or they are missing)
  const fixes = [entry.fixedOnPage?.at, summary?.pageFix?.at];
  const re = summary?.reread;
  if (entry.reread) out.lines.unshift(READING_AGAIN);
  else if (entry.rereadNote?.text && Date.now() - at(entry.rereadNote.at) < NOTE_HOURS * 3600000 && later(entry.rereadNote.at, [re?.at, ...fixes])) out.lines.splice(1, 0, `Read again was not done: ${entry.rereadNote.text}`);
  else if (re?.before && entry.applied && later(re.at, fixes)) out.lines.splice(1, 0, `The photo was read again ${when(re.at)}. What was read and the items below are the new reading; the charge in Actual still has what was filed before and was not touched. Check the items, then use Preview and Save changes to change it.`);
  else if (re?.restored && entry.applied && later(re.at, fixes)) out.lines.splice(1, 0, `The earlier reading was put back ${when(re.at)}. Nothing was changed in Actual.`);
  else if (!entry.done && entry.previousReading && entry.rereadAt) out.lines.splice(1, 0, `The photo was read again ${when(entry.rereadAt)}; this is the new reading.`);
  if (entry.fixedOnPage && !entry.fixedOnPage.markOnly) out.lines.unshift(`The item categories were fixed on this page (${when(entry.fixedOnPage.at)}). Undo works for 15 minutes after saving, until the receipt is archived: archiving ends it.`);
  return out;
}

function whatToDoBase(entry, id, summary, fix) {
  if (entry.archived) return archivedToDo(entry);
  if (entry.creating) return { warn: true, lines: ['An earlier cash creation is being checked. If it exists in Actual, the worker will finish recording it automatically. If it was not created, Preview offers a safe retry.', ...(entry.error ? [entry.error] : [])] };
  if (entry.filing) return { warn: false, lines: ['The receipt is finishing its Nextcloud save. The worker will retry automatically; the change in Actual will not be repeated.'] };
  if (entry.fixedOnPage?.summaryFailed) return { warn: true, lines: [entry.error ?? 'The worker is recovering an earlier receipt save. Its transaction in Actual is kept.'] };
  if (entry.resolutionPending) return { warn: true, lines: ['The corrected reading is kept, but saving it did not finish. Open Correct reading / choose transaction below to finish saving. Nothing was changed in Actual.'] };
  if (entry.manualLink?.keep) return { warn: false, lines: [entry.manualLink.recovered ? 'The earlier saved purchase was recovered. Its contents in Actual were kept.' : 'Linked to the charge you chose. Its amounts, categories and notes in Actual were kept.', 'You can archive this receipt. Make any further changes in Actual.'] };
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
          'Press "Check now" in Activity to look again right away. If the charge never shows up it goes to review.',
          ...(hint ? [hint] : []),
        ],
      };
    }
    if (entry.applied) return { warn: false, lines: ['Actual has been changed and the worker is moving the file. This finishes at the next check; nothing for you to do.'] };
    return { warn: false, lines: [`The last attempt hit an error${entry.error ? ` (${entry.error})` : ''}. It is tried again at the next check; after 3 failed attempts it goes to Needs review.`] };
  }
  const { dryPrefix, base } = splitResult(r);
  const review = base.endsWith('+review') && !entry.reviewed; // #review removed in Actual: reviewed
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
  if (kind === 'review' && !entry.applied && noChargeKind(summary)) {
    const cash = noChargeKind(summary) === 'cash';
    return { warn: true, lines: cash
      ? ['Paid in cash, so there is no bank charge to match. Nothing was changed in Actual.', ...(canFix ? [`Choose Create this cash purchase, check the items and account, press Preview, and then Create in Actual: it adds the purchase to Actual and moves the file to ${processedDir()}. If a transaction for the same amount is already there, Preview offers to split that one instead.`] : []), 'If you entered it in Actual by hand, press Archive.']
      : ['This is a refund, and refunds are not matched to a charge. Nothing was changed in Actual.', 'Enter it in Actual by hand, then press Archive.'] };
  }
  if (kind === 'review' && !entry.applied) {
    return { warn: true, lines: [`Nothing was changed in Actual. The file is in ${reviewDir()}, because it needs your review.`, 'Fix the cause (a keyword, a payee alias, a clearer photo) and press Try again, or fix the charge in Actual by hand.', ...(canFix ? [`A charge was matched, so you can also pick the right category for each item under Items below, press Preview, and Apply to Actual: that writes the charge and moves the file to ${processedDir()}.`] : [])] };
  }
  if (kind === 'review') {
    return { warn: true, lines: ['Actual was changed before this went to review. The reasons are under Why it needs review.', 'Check the charge in Actual. To read the receipt again, ' + REDO + '.'] };
  }
  const did = DID[kind];
  if (!did) return { warn: false, lines: [`Result: ${r}.`] };
  const flagged = review || (kind === 'already-applied' && (summary?.problems ?? []).length > 0);
  if (flagged) {
    return { warn: true, lines: [`${did} Something was doubtful, so the note is also tagged #review and the receipt is in Needs review.`, 'Check the charge in Actual (search #review) and fix what is wrong. Removing #review without other changes counts as a confirmation.', ...(canFix ? ['Or fix the item categories on this page (Items, below), Preview and Save changes; leave "Mark as checked" ticked to remove #review and move the file to Processed.'] : []), 'To read the receipt again, ' + REDO + '.'] };
  }
  return { warn: false, lines: [did, kind === 'already-applied' ? 'Nothing for you to do.' : `Nothing more to do. If a category is wrong, ${canFix ? 'fix it under Items below (Preview, then Save changes) or in Actual' : 'change it in Actual'}: the worker learns from it (Learned tab).`] };
}


// ---- Fixing the items' categories (receipt-fix.js) ----

/** A category dropdown: Uncategorized, then Actual's categories by group (excluded ones marked). `picked` is the label selected. */
function pickSelect(name, picked, label, fix, bulk = false) {
  const known = new Set(fix.options.map((o) => o.label));
  const groups = [];
  for (const o of fix.options) {
    let g = groups.find((x) => x.name === o.group);
    if (!g) groups.push((g = { name: o.group, options: [] }));
    g.options.push(o);
  }
  const odd = picked !== 'Uncategorized' && !known.has(picked) ? `<option value="${escape(picked)}" selected>${escape(picked)} (not in Actual's list)</option>` : '';
  const opt = (value, text, on) => `<option value="${escape(value)}"${on ? ' selected' : ''}>${escape(text)}</option>`;
  return `<select class="pick" ${bulk ? 'id="bulk-category" data-bulk-category' : `name="${escape(name)}"`} aria-label="${escape(label)}">${bulk ? '<option value="" selected disabled>Set all items…</option>' : ''}${odd}${opt('Uncategorized', 'Uncategorized (leave it to me)', !bulk && picked === 'Uncategorized')}${groups.map((g) => `<optgroup label="${escape(g.name)}">${g.options.map((o) => opt(o.label, `${o.label.slice(g.name.length + 3) || o.label}${o.excluded ? ' (excluded)' : ''}`, !bulk && o.label === picked)).join('')}</optgroup>`).join('')}</select>`;
}

/** The tax mark menu of an added line (only when the receipt has marks): none, then the marks seen on this receipt. */
function markSelect(name, picked, fix) {
  const m = fix.marks ?? { list: [], flagged: false };
  if (!m.list.length && !m.flagged) return '';
  const opt = (value, text) => `<option value="${escape(value)}"${value === picked ? ' selected' : ''}>${escape(text)}</option>`;
  return `<select class="mark" name="${escape(name)}" aria-label="Tax mark">${opt('', 'None')}${m.flagged ? opt('*', 'Taxed') : ''}${m.list.map((c) => opt(c, c)).join('')}</select>`;
}

/** The rows for lines to add: the ones filled in so far, then one blank row. Works without JavaScript (Preview keeps the filled ones). */
function addedRows(fix) {
  const marks = fix.marks ?? { list: [], flagged: false };
  const rows = (fix.added ?? []).map((a, k) => `<tr><td><input type="text" name="nd${k}" value="${escape(a.description)}" maxlength="80" placeholder="Description" aria-label="Description of added line ${k + 1}" autocomplete="off"></td><td><input type="text" inputmode="decimal" class="amt" name="na${k}" value="${escape(a.amount)}" placeholder="0.00" aria-label="Amount of added line ${k + 1}" autocomplete="off"></td><td>${pickSelect(`nc${k}`, a.category, `Category of added line ${k + 1}`, fix)}</td>${marks.list.length || marks.flagged ? `<td>${markSelect(`nt${k}`, a.tax, fix)}</td>` : ''}</tr>`).join('');
  const marked = marks.list.length > 0 || marks.flagged;
  return `<h2>Add a line</h2><p class="muted small">A line the reader skipped, such as a discount (a negative amount, like -5.00) or an item. Fill in the blank row and press Preview; a new blank row appears. Empty a row to remove it. Up to ${fix.maxAdded ?? 10} lines.${marked ? ' Pick the tax mark it was printed with, if any.' : ''}</p>
<div class="scroll"><table class="added"><thead><tr><th>Description</th><th>Amount</th><th>Category</th>${marked ? '<th>Tax</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const FLIPPED = 'A line of item numbers was read as plus and treated as a discount here.';

/** "Looked at Actual 2 h ago" and the Check Actual now button (applied receipts, live only). */
function actualBar(fix, key, id, nav) {
  const a = fix.actual;
  const seen = a ? `Looked at Actual ${ago(a.at)}${a.reviewed ? '; #review is removed there' : ''}${a.differs ? '.' : ': it matches what was filed.'}` : '';
  const button = fix.kind === 'applied' && !fix.dry ? `<form ${post('receipt-check', key)}>${hidden('id', id)}${navFields(nav?.nav)}<button class="small plain">Check Actual now</button></form>` : '';
  return seen || button ? `<div class="actualbar">${seen ? `<p class="muted small">${escape(seen)}</p>` : ''}${button}</div>` : '';
}

/** The Items table when the charge was changed in Actual: what Actual has, no editing, no Preview. */
function lockedItems(r, fix, key, id, nav) {
  const a = fix.actual ?? {};
  const rows = fix.items.map((it) => {
    const label = it.inActual ?? it.filed ?? fix.picks[it.i]; // what Actual has: its changed item, else the part it was filed in, never a new reading's pick
    const cat = it.inActual
      ? `<div>Changed in Actual: <b>${escape(it.inActual)}</b></div>${it.worker !== it.inActual ? `<div class="muted small">the worker chose ${escape(it.worker)}</div>` : ''}`
      : escape(label);
    return `<tr><td>${escape(it.description)}</td><td class="muted">${escape(it.plain)}</td><td>${escape(it.amountText ?? money(it.amount))}</td><td>${cat}${it.flipped ? `<div class="muted small">${escape(FLIPPED)}</div>` : ''}</td></tr>`;
  }).join('');
  const sentence = (t) => { const s = plainReason(t); return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`; };
  const why = [a.changed ? sentence(a.changed) : '', a.whole ? `The whole charge is now in ${a.whole} in Actual.` : ''].filter(Boolean).join(' ');
  return `<p class="quiet-note"><b>This charge was changed in Actual</b>Edit it there. This page shows what Actual has.${why ? ` ${escape(why)}` : ''}</p>
${actualBar(fix, key, id, nav)}
<div class="scroll"><table class="items"><thead><tr><th>Item</th><th>Plain</th><th>Amount</th><th>Category</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** "A", "A and B", "A, B and C". */
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The notice about a gap the worker spread over items (receipt-fix.js gapNotice): a discount line was probably missed. */
export function gapNoticeHtml(g) {
  if (!g) return '';
  const text = `The items came to ${money(g.cents / 100)} more than the subtotal, so the worker lowered ${listOf(g.names)} by that much in total. Usually this means the reader missed a discount line. If you know which item it belongs to, set that item's amount and leave the others as printed (or add the discount with Add a line).`;
  return `<p class="notice warn">${escape(text)}${g.matches ? ` ${escape(`The receipt shows savings of ${money(g.savingsCents / 100)}, which matches.`)}` : ''}</p>`;
}

/** The account menu of a cash receipt: where the transaction is created (starts from the Settings tab's choice). It sits in the action footer, outside the form, and belongs to it by its form attribute. */
function accountPick(fix, key) {
  const c = fix.cash;
  const names = [...new Set([...(c.accounts ?? []), ...(c.account ? [c.account] : [])])];
  const select = names.length
    ? `<select name="acct" id="acct" form="receipt-edit-form"><option value=""${c.account ? '' : ' selected'}>(not chosen)</option>${names.map((n) => `<option value="${escape(n)}"${n === c.account ? ' selected' : ''}>${escape(n)}</option>`).join('')}</select>`
    : `<input type="text" name="acct" id="acct" form="receipt-edit-form" value="${escape(c.account)}" maxlength="200" autocomplete="off">`;
  // The explanation under Create repeated the sentence above it and is gone; the one thing it carried that nothing else does is the way to the default account.
  return { control: `<label for="acct" class="inline-label">Create in</label>${select}<a data-navigate href="settings?key=${escape(encodeURIComponent(key))}&amp;section=everyday#s-CASH_ACCOUNT" class="small">Change the default account</a>` };
}

/** The Items & categories card: heading with Set all items, a row per item (name, Not sure and the reason, Was X, amount, category), the lines to add. */
function editableItems(r, fix, key, id, nav) {
  if (fix.locked) return lockedItems(r, fix, key, id, nav);
  const rows = fix.items.map((it) => {
    const src = r.items[it.i];
    const unsure = Boolean(src.unsureGuess || src.fellBack || src.invalidAnswer || it.worker === 'Uncategorized');
    const reason = src.reason || (unsure ? 'Check this category against the receipt.' : '');
    const notes = [it.flipped ? FLIPPED : '', it.gap > 0 ? `As read; lowered by ${money(it.gap / 100)} to match the subtotal.` : '', fix.rereadNewer && it.filed && it.filed !== fix.picks[it.i] ? `Actual has ${it.filed}.` : ''].filter(Boolean);
    const lines = [unsure ? `<span class="nsure">Not sure</span><span class="reason">${escape(reason)}</span>` : reason ? `<span class="reason">${escape(reason)}</span>` : '', ...notes.map((n) => `<span class="reason">${escape(n)}</span>`)].filter(Boolean);
    const amount = escape(it.amountText ?? money(it.amount));
    return `<tr data-item="${it.i}" data-unsure="${unsure}"><td><span class="nm">${escape(it.plain || it.description)}</span>${lines.map((l) => `<div class="sub">${l}</div>`).join('')}<div class="sub item-edit-hint" data-item-hint hidden><span class="was">Was <span data-was></span> · </span><button type="button" class="linkbtn" aria-label="Revert edits to ${escape(it.description)}" data-item-revert>Revert</button> · <a href="keywords?key=${escape(encodeURIComponent(key))}&amp;word=${escape(encodeURIComponent(it.description))}&amp;category=${escape(encodeURIComponent(fix.picks[it.i]))}" data-rule-link>Make a rule</a></div></td><td class="muted">${escape(it.description)}</td><td><input type="text" inputmode="decimal" class="amt" name="a${it.i}" value="${amount}" aria-label="Amount for ${escape(it.description)}" aria-invalid="false" autocomplete="off" data-original="${amount}">${src.tax_code != null && src.tax_code !== '' ? `<span class="muted small tax-code">${escape(src.tax_code)}</span>` : ''}</td><td>${pickSelect(`c${it.i}`, fix.picks[it.i], `Category for ${it.description}`, fix)}</td></tr>`;
  }).join('');
  return `<form id="receipt-edit-form" method="get" action="receipt" data-preview-form data-kind="${escape(fix.kind)}" data-reading="${escape(fix.readingId ?? '')}" data-max-added="${fix.maxAdded}" data-id="${escape(id)}" data-applied="${fix.kind === 'applied'}" data-dry="${fix.dry}">
${hidden('key', key)}${hidden('id', id)}${navFields(nav?.nav)}${hidden('preview', '1')}${hidden('rid', fix.readingId ?? '')}
<div class="edhead"><h2 class="card-title">Items &amp; categories</h2><div class="bulk-categories" data-bulk-control hidden><label class="sr-only" for="bulk-category">Set all items</label>${pickSelect('', 'Uncategorized', 'Category for all items', fix, true)}</div></div>
${fix.gapNotice ? `<div class="quiet-note">${gapNoticeHtml(fix.gapNotice)}</div>` : ''}
<div class="scroll"><table class="items"><thead><tr><th>Item</th><th>As read</th><th>Amount</th><th>Category</th></tr></thead><tbody>${rows}</tbody></table></div>
<details class="how add-line"${(fix.added ?? []).some((a) => a.description) ? ' open' : ''}><summary>+ Add a missed line or discount</summary><div data-added-lines>${addedRows(fix)}</div></details>
</form>`;
}

/**
 * The action footer of the card. The consequence sentence is empty until there is an edit, except in test mode and for cash ("Creates a
 * 41.60 purchase in <account>."); the cash account menu sits next to Create. Group-scoped "Next receipt" comes with P7.
 */
function editorActions(fix, key, total, stepRow = '') {
  const cash = fix.kind === 'cash' ? accountPick(fix, key) : null;
  const lead = cash ? `Creates a ${total != null && total !== '' ? `${displayMoney(Math.abs(Number(total)))} ` : ''}purchase in ` : '';
  const sentence = cash ? `${lead}${fix.cash.account || 'the account you choose'}.` : '';
  const clean = fix.dry ? 'Test mode: nothing is written.' : sentence;
  const edited = fix.dry ? clean : fix.kind === 'cash' ? clean : 'Updates the existing charge in Actual.';
  // Only the button row is sticky on a phone; the sentence and the account menu scroll with the card.
  return `<div class="editor-lead"><p data-editor-consequence data-clean="${escape(clean)}" data-edited="${escape(edited)}"${cash ? ` data-cash-lead="${escape(lead)}"` : ''}>${escape(clean)}</p>${cash ? cash.control : ''}</div><div class="editor-actions"><div class="buttons"><button type="button" class="plain" data-editor-discard hidden>Discard changes</button><button form="receipt-edit-form" data-editor-save>${fix.dry ? 'Preview' : 'Preview changes'}</button>${stepRow}</div></div><p class="editor-message" id="receipt-editor-message" data-editor-message role="status" aria-atomic="true"></p>`;
}

function categoryLabel(label, fix) {
  const option = fix.options.find((o) => o.label === label);
  if (!option) return label;
  const short = label.slice(option.group.length + 3) || label;
  return fix.options.filter((o) => (o.label.slice(o.group.length + 3) || o.label) === short).length > 1 ? label : short;
}

/** What the cash purchase would be: the account, the date, the payee and any transactions already there for the same amount. */
function cashFacts(c) {
  if (!c) return '';
  if (c.missing) return '<p class="banner live">Actual was not looked at, so the account and any existing transaction are not known.</p>';
  if (c.error) return `<p class="banner live">${escape(c.error)}</p>`;
  const dups = (c.duplicates ?? []).map((d) => `<tr><td>${escape(d.date)}</td><td>${escape(d.payeeName ?? '')}</td><td>${escape(money(-d.amount / 100))}</td><td>${escape(d.category ?? 'no category')}${d.isParent ? ' (already split)' : ''}</td></tr>`).join('');
  return `<table><tbody>${fact('Account', c.account?.name ?? `${c.accountName || 'not chosen'} (not an open account the worker may use)`)}${fact('Date', c.date)}${fact('Payee', c.payee ? `${c.payee.name}${c.payee.isNew ? ' (new payee)' : ''}` : '')}</tbody></table>
${dups ? `<div class="banner live"><b>A transaction for this amount is already there</b>It may be this same purchase, entered by hand. Splitting it avoids a double entry.<div class="scroll"><table><thead><tr><th>Date</th><th>Payee</th><th>Amount</th><th>Category now</th></tr></thead><tbody>${dups}</tbody></table></div></div>` : ''}${c.review ? '<p class="muted small">Part of it is doubtful, so the note will be tagged #review.</p>' : ''}`;
}

/** The buttons of a cash receipt's preview: Split this one instead (for each transaction found), and Create in Actual (secondary when one was found). */
function cashPreview(fix, pv, key, id, nav, picks) {
  const c = pv.cash;
  if (fix.dry) return '';
  if (!pv.placed) return '';
  if (!c || c.missing || c.error) return '';
  if (!c.accountName) return '<p class="banner live">No account is chosen. Pick one under Account and press Preview again, or set "Cash purchases go to" on the Settings tab.</p>';
  if (!c.account) return '<p class="banner live">That is not an open account the worker may use. Pick another one under Account and press Preview again.</p>';
  const form = (action, label, cls, dup = '') => `<form ${post('receipt-cash', key)}>${hidden('id', id)}${navFields(nav?.nav)}${picks}${hidden('acct', c.accountName)}${hidden('token', pv.token)}${hidden('state', pv.state)}${hidden('action', action)}${dup ? hidden('dup', dup) : ''}<button class="${cls}">${escape(label)}</button></form>`;
  if (c.recovery) {
    if (c.recovery.found) return `<p class="small">The earlier purchase was found. Finish recording it, or keep its current contents in Actual.</p>${form('create', 'Finish recording purchase', 'plain')}${form('keep-found', `Keep ${c.recovery.payeeName ?? 'purchase'} · ${money(-c.recovery.amount / 100)} · ${c.recovery.date} unchanged`, 'small plain')}`;
    const available = (c.duplicates ?? []).filter((d) => d.snapshot?.cleared !== false);
    if (c.duplicates?.length && !available.length) return '<p class="small">The matching purchases are still pending. Wait for them to clear, then Preview again. Nothing else will be created automatically.</p>';
    return `<p class="small">The earlier purchase was not found after lookup. You can retry, or keep an existing purchase unchanged.</p>${available.length ? available.map((d) => form('adopt-existing', `Keep ${d.payeeName ?? 'purchase'} · ${money(-d.amount / 100)} · ${d.date} unchanged`, 'plain', d.id)).join('') : form('retry-create', 'Retry creation after lookup', 'plain')}`;
  }
  const dups = c.duplicates ?? [];
  return `${dups.filter((d) => !d.isParent).map((d) => form('split', 'Use this purchase', 'plain', d.id)).join('')}${form('create', dups.length ? 'Create another purchase' : fix.applyLabel, dups.length ? 'small plain' : 'plain')}`;
}

/** The split as an SVG bar (the page allows no style attributes): positions are attributes, colours are classes c0 to c7 by the part's order. '' when there is nothing to draw. */
function splitBar(parts) {
  const cents = (v) => Math.round(Number(v) * 100);
  const drawn = parts.map((p, i) => ({ i, c: cents(p.amount) })).filter((x) => x.c > 0);
  const sum = drawn.reduce((t, x) => t + x.c, 0);
  let at = 0;
  return sum > 0 ? `<svg class="split-bar" viewBox="0 0 100 16" preserveAspectRatio="none" role="img" aria-label="Split by category">${drawn.map((x) => { const w = (x.c * 100) / sum; const rect = `<rect class="c${x.i % 8}" x="${at.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="16"/>`; at += w; return rect; }).join('')}</svg>` : '';
}

/**
 * An archived receipt's Items & categories card, read-only: each saved item with its amount and the category it was filed under, then the
 * split. Built from the saved summary; an item whose category the summary does not record says so. Nothing here can be edited until Restore.
 */
function archivedItems(view) {
  const s = view.summary;
  const items = Array.isArray(s?.receipt?.items) ? s.receipt.items.filter((it) => it && typeof it === 'object') : [];
  const parts = (Array.isArray(s?.plan?.parts) ? s.plan.parts : []).filter((p) => p && typeof p === 'object');
  // The short name ("Groceries", not "Daily / Groceries"), as the editor shows it.
  const short = (name) => { const at = typeof name === 'string' ? name.indexOf(' / ') : -1; return at >= 0 && name.slice(at + 3) ? name.slice(at + 3) : name; };
  const category = (it) => { const c = filedCategory(s, it) ?? (typeof it.category === 'string' && it.category ? it.category : null); return c ? short(c) : null; };
  const rows = items.map((it) => `<tr><td>${escape(it.plain || it.description)}</td><td class="muted">${escape(it.description)}</td><td>${escape(money(it.amount))}</td><td>${category(it) ? escape(category(it)) : '<span class="muted">Not recorded</span>'}</td></tr>`).join('');
  const split = parts.length ? `<section class="split-preview archived-split"><h3>Filed as<span>${s?.transaction?.amount != null ? escape(displayMoney(Math.abs(Number(s.transaction.amount)))) : ''}</span></h3>${splitBar(parts)}<ul class="split-parts">${parts.map((p, i) => `<li><i class="sw c${i % 8}" aria-hidden="true"></i><span>${escape(p.category)}</span><strong>${escape(displayMoney(p.amount))}</strong></li>`).join('')}</ul></section>` : '';
  return `<p class="muted">${escape(ARCHIVED)}</p>${rows ? `<div class="scroll"><table class="items archived-items"><thead><tr><th>Item</th><th>As read</th><th>Amount</th><th>Category</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}${split}`;
}

/** The preview of the new parts, and (live) the button that writes them. */
function previewHtml(fix, key, id, nav, summary = null) {
  const pv = fix.preview;
  if (fix.rereadStale) return '<div data-preview-fragment><p role="alert">The receipt was read again. Check the new items before saving.</p></div>';
  if (pv?.error) return `<div data-preview-fragment><p role="alert">${escape(pv.error)}</p></div>`;
  const confirmOnly = fix.kind === 'applied' && pv?.review && !fix.changed.length && !fix.edited;
  let parts = confirmOnly ? summary?.plan?.parts ?? [] : pv?.parts ?? summary?.plan?.parts ?? [];
  const target = fix.kind === 'cash' ? summary?.receipt?.total : summary?.transaction?.amount;
  if (pv && !confirmOnly && (pv.note || (!pv.split && parts.length > 1))) parts = [{ category: pv.note ? pv.current || summary?.transaction?.currentCategory || 'Current category' : pv.main, amount: money(Math.abs(Number(target))) }];
  const heading = confirmOnly ? 'In Actual' : pv ? 'After saving' : fix.kind === 'cash' ? 'New purchase' : fix.kind === 'applied' ? 'In Actual' : 'After saving';
  const bar = splitBar(parts);
  const taxNote = taxLines(pv ? pv.tax : summary?.plan?.tax ?? (summary?.receipt ? explainTax(summary.receipt) : null), money(summary?.receipt?.tax)).map((t) => `<p class="live-note">${escape(t)}</p>`).join('');
  // One category takes the whole charge: there is nothing to split, so the section stays in the page but hidden.
  const split = `<section class="split-preview" data-preview-split${parts.length === 1 ? ' hidden' : ''}><h3>${heading}<span>${target != null ? escape(displayMoney(Math.abs(Number(target)))) : ''}</span></h3>${parts.length ? `${bar}<ul class="split-parts">${parts.map((p, i) => `<li><i class="sw c${i % 8}" aria-hidden="true"></i><span>${escape(categoryLabel(p.category, fix))}</span><strong>${escape(displayMoney(p.amount))}</strong></li>`).join('')}</ul>${taxNote}` : '<p class="muted small">Change a category or amount to preview the split.</p>'}</section>`;
  if (!pv) return `<div data-preview-fragment data-preview-review="${Boolean(fix.needsReview)}" data-preview-none="${fix.kind === 'applied' && !fix.needsReview && !fix.rereadNewer}">${split}</div>`;
  const picks = fix.picks.map((p, i) => hidden(`c${i}`, p)).join('')
    + pv.fields.amounts.map((t, i) => hidden(`a${i}`, t)).join('')
    + (pv.fields.added.length ? pv.fields.added : [{ description: '', amount: '', category: 'Uncategorized', tax: '' }]).map((a, k) => hidden(`nd${k}`, a.description) + hidden(`na${k}`, a.amount) + hidden(`nc${k}`, a.category) + hidden(`nt${k}`, a.tax)).join('');
  const none = fix.kind === 'applied' && !pv.review && pv.same === true && fix.changed.length === 0 && !fix.edited;
  const commit = fix.kind === 'cash' ? cashPreview(fix, pv, key, id, nav, picks) : fix.dry || !pv.placed || none ? '' : `<form data-commit ${post('receipt-fix', key)}>${hidden('id', id)}${navFields(nav?.nav)}${picks}${hidden('token', pv.token)}${hidden('state', pv.state)}${confirmOnly ? hidden('intent', 'confirm') : ''}${pv.review ? '<details class="item-note"><summary>Review options</summary><label><input type="checkbox" name="mark" value="yes" checked> Mark as checked</label></details>' : ''}<button data-commit-button>${escape(fix.applyLabel)}</button></form>`;
  // A cash receipt's choices are the server's own signed forms. With the script they stay hidden until Create cash purchase is pressed,
  // then show here in place (data-confirming), with a question above them and a Cancel that only hides them again.
  const dupCount = (pv.cash?.duplicates ?? []).length;
  const cashAsk = fix.kind === 'cash' && commit.includes('<form') ? `<p class="cash-confirm">${escape(pv.cash?.recovery ? 'Choose how to finish this cash purchase. Nothing is written until you choose.' : dupCount ? `${pv.cash.accountName} already has a purchase for this amount. Use it, or create another one?` : `Create a ${money(target) ? `${displayMoney(Math.abs(Number(target)))} ` : ''}purchase in ${pv.cash.accountName}? It is filed right away.`)}</p>` : '';
  const cashCancel = cashAsk ? '<button type="button" class="plain cash-cancel" data-cash-cancel>Cancel</button>' : '';
  const notes = [taxLine(pv.tax), pv.checkText, pv.pipelineNote, ...pv.problems, ...(pv.cautions ?? [])].filter(Boolean);
  const check = pv.check && !pv.check.ok ? `<p class="banner">${escape(pv.checkText)} You can still save: the actual charge is divided in proportion.</p>` : '';
  return `<div data-preview-fragment data-preview-valid="${pv.placed && !fix.dry}" data-preview-none="${none}" data-preview-dirty="${fix.changed.length > 0 || fix.edited}" data-preview-review="${pv.review}" data-preview-confirm="${Boolean(confirmOnly)}" data-preview-kind="${escape(fix.kind)}">${split}${check}${notes.length ? `<details class="item-note"><summary>Tax and allocation details</summary>${notes.map((n) => `<p>${escape(n)}</p>`).join('')}</details>` : ''}<div class="commit-preview"${fix.kind === 'cash' ? ' data-cash-preview' : ''}>${fix.kind === 'cash' ? cashFacts(pv.cash) : ''}${cashAsk}${commit}${cashCancel}</div>${fix.dry ? '<p class="muted small">Test mode: nothing is written. Go live to save.</p>' : !pv.placed ? '<p role="alert">Choose a category for at least one item.</p>' : none ? '<p class="muted small">Nothing to update.</p>' : ''}</div>`;
}

/** Collapsible help for the page. */
const how = () => `<details class="how"><summary>How this page works</summary>
<dl>
<dt>Upload receipts</dt><dd>At the top of the Inbox list, <b>+ Add receipt</b> sends photos or PDFs you pick on this device straight to the Nextcloud Inbox. It is the same as putting the files in the Inbox yourself: the worker reads them at once and files them like any other receipt.</dd>
<dt>Photo</dt><dd>The receipt as the worker has it now (a PDF shows up to 3 pages and can be downloaded). It is read from Nextcloud when you open this page.</dd>
<dt>What was read</dt><dd>What the reader saw: store, totals and items. <b>Purchase date used</b> is the date the worker settled on for matching: the printed date when it is plausible next to when the photo was taken (the date in a camera-style file name) or uploaded, otherwise none (the receipt is then matched by amount and store only). <b>Printed date</b> is the date text exactly as printed on the receipt, shown below it.</dd>
<dt>Bank charge</dt><dd>The transaction in Actual this receipt was matched to. It is missing when no charge was found.</dd>
<dt>Filed as</dt><dd>How the charge was divided across categories, with the amounts.</dd>
<dt>Why it needs review</dt><dd>The reasons the worker was unsure. They are also in the .json file next to the receipt in ${escape(reviewDir())}.</dd>
<dt>Result words</dt><dd><b>categorize</b>: the charge got a category. <b>split</b>: it was split across categories. <b>confirm</b>: the category already agreed; only a note was added. <b>note</b>: a note with the breakdown was added (splits are off or not supported). <b>+review</b> after one of these: it was applied, but part is doubtful, so the note is tagged #review. <b>review</b>: nothing was changed in Actual. <b>failed</b>: it failed 3 times. <b>waiting</b>: the bank charge has not shown up yet. <b>dry-run:</b> in front: a preview, nothing was written.</dd>
<dt>Where files go</dt><dd>Receipts that need review are moved to ${escape(reviewDir())} with a .json that gives the reason. Others go to ${escape(processedDir())}. When you archive a receipt, its photo and .json move on to ${escape(archiveDir())} (a folder per month), and the receipt leaves the Inbox list for the Archived tab.</dd>
<dt>Archive</dt><dd><b>Archive receipt</b> (a Done receipt) moves it to the Archive folder and takes it off the Status list. For a receipt marked "Applied — check it in Actual", <b>Looks right: clear #review and archive</b> first removes the #review tag in Actual (and changes nothing else about the charge). An archived receipt can still be opened here, but not changed: <b>Restore</b> puts it back first.</dd>
<dt>#review</dt><dd>Search for it in Actual to find the charges that were changed but need a look. Remove the tag when you are happy with them.</dd>
<dt>Items and categories</dt><dd>When a bank charge was matched, each item has an amount box and a category menu. Change what is wrong (a discount is a negative amount, like -1.00), or fill in <b>Add a line</b> for something the reader skipped, and press <b>Preview</b>: it shows how the charge would be divided again, tax included, whether the items add up to the receipt's subtotal, and what would be written. Saving is allowed even when they do not add up; the bank charge is what gets divided. <b>Save changes</b> (a receipt already applied) rewrites the charge, replacing its split; <b>Apply to Actual</b> (a receipt in Needs review) writes it and moves the file to ${escape(processedDir())}. Saving refuses if the charge was changed in Actual since the worker wrote it. Each category you change becomes a lesson, as if you had corrected it in Actual; amounts and added lines are not lessons. An Undo button appears for 15 minutes. <b>Looks right</b>, which only removes the #review tag, has no Undo. In a dry run you only get the preview.</dd>
<dt>Cash purchases</dt><dd>A receipt paid in cash has no bank charge, so it waits in Needs review. Its page shows the same item editor: pick the categories, fix amounts, add lines, choose the <b>Account</b> (it starts from <b>Cash purchases go to</b> on the Settings tab) and press <b>Preview</b>. The preview shows the account, the date, the payee and how the amount would be divided, and looks in that account for a transaction of the same amount within 3 days that no receipt is linked to. Only the button after the preview writes anything: <b>Create in Actual</b> adds a new transaction (never automatic, never in dry run); if one of the same amount is already there, <b>Split this one instead</b> divides that one, and <b>Create a new one anyway</b> stays as the second choice. The receipt is then filed like any applied one, and Undo (15 minutes) deletes what was created. If you entered the purchase by hand, press <b>Archive (I entered it by hand)</b>; refunds can be archived the same way.</dd>
<dt>Archive: keep what's in Actual</dt><dd>For a charge you changed by hand in Actual. Nothing is written to Actual (a #review tag stays there) and the receipt is filed in the Archive as it is. <b>Looks right: clear #review and archive</b> also works when you only changed categories or part notes: it removes the #review tag and nothing else, as long as the transaction and the amounts of its parts are as the worker wrote them. A category you changed is still learned by the next look at the charge.</dd>
<dt>Use old reading</dt><dd>After a Read again, puts the reading from before it back, as long as nothing was saved from the new one and the charge was not changed in Actual. It writes nothing to Actual. A receipt still waiting for its charge gets its earlier reading back too (live or dry run); a finished dry-run receipt keeps no earlier reading.</dd>
<dt>Try again</dt><dd>Only for a live receipt that went to review (or failed) without changing Actual. It moves the file back to the inbox, so the next check reads it fresh. If Actual was changed, ${escape(REDO)}.</dd>
<dt>Read again</dt><dd>Reads the photo once more with the reader as it is now, so an older receipt gets later improvements (for example a missed discount line). It never writes to Actual. A receipt still waiting for its charge is simply read again. For one already applied, the new reading replaces <b>What was read</b> and the starting values of the items; Actual keeps what was filed until you use Preview and Save changes. It is refused when a change saved from this page has not been undone, when the charge was changed in Actual, when the receipt is archived, or when the photo is gone. It is not a correction, so nothing is learned from it.</dd>
<dt>Previous / Next</dt><dd>Walk through the receipts in the order the list showed when you opened this receipt, including its filter and sort. The arrow keys do the same, and the menu jumps to any receipt.</dd>
</dl></details>`;

/**
 * Previous / Next through the whole list (filter and sort kept, no group: each receipt opens in its own group), with the position, and (once)
 * the jump list. Only one link on a page may carry rel="next" (the arrow keys click the first): `withRel` is set where the page has no
 * group-scoped "Next receipt" (an archived receipt's page).
 */
function pagerHtml(nav, key, withJump, withRel = false) {
  const k = escape(encodeURIComponent(key));
  const whole = withoutGroup(nav.nav);
  const q = escape(navQuery(whole));
  const to = (r) => `receipt?key=${k}&amp;id=${escape(encodeURIComponent(r.key))}${q}`;
  const link = (r, rel, text) => (r ? `<a class="btn" data-navigate data-step="${rel}"${withRel ? ` rel="${rel}"` : ''} href="${to(r)}">${text}</a>` : `<span class="btn" aria-disabled="true">${text}</span>`);
  const filter = [nav.nav.cause && `review cause: ${REVIEW_CAUSES.find(([id]) => id === nav.nav.cause)?.[1] ?? nav.nav.cause}`, nav.nav.result && `result: ${nav.nav.result}`, nav.nav.q && `text: ${nav.nav.q}`].filter(Boolean).join(', ');
  const jump = withJump
    ? `<form method="get" action="receipt">${hidden('key', key)}${navFields(whole)}<label class="nobtn" for="jump">Go to a receipt</label><select id="jump" name="id" data-jump>${nav.list.map((r, i) => `<option value="${escape(r.key)}"${i === nav.index ? ' selected' : ''}>${escape(`${receiptTitle(r)}${purchaseDate(r) ? ` · ${purchaseDate(r)}` : ''} (${resultText(r)})`)}</option>`).join('')}</select><button class="small plain" data-nojs>Go</button></form>`
    : '';
  return `<div class="pager">${link(nav.prev, 'prev', '&larr; Previous')}<span class="pos">${nav.index + 1} of ${nav.list.length}${filter ? ` <span class="muted small">(${escape(filter)})</span>` : ''}</span>${link(nav.next, 'next', 'Next &rarr;')}${jump}</div>`;
}

/**
 * The archive button of a receipt that is not archived yet, with its one-line explanation, or the short reason it can't be
 * (nothing when that is obvious from the status). A "check it in Actual" receipt can only be archived when its #review can be
 * cleared from this page (the same check as "Mark as checked").
 */
function archiveControls(id, entry, fix, key, keep, summary) {
  // A switch to dry run is pending (the next check makes it): archiving refuses then, so no archive button is offered, as in dry run.
  if (resolveDryRun().dryRun) return { note: '' };
  // Archiving one receipt from its page is allowed right after a save; it ends that save's Undo (the banner and the notice say so).
  const dismiss = canArchive(id, entry, { dismiss: true, endsUndo: true });
  if (!entry.applied && dismiss.ok) return {
    form: `<form ${post('archive', key)}>${hidden('id', id)}${keep}${hidden('dismiss', '1')}<button>Archive receipt</button></form>`,
    primary: `<form ${post('archive', key)}>${hidden('id', id)}${keep}${hidden('dismiss', '1')}<button>Archive receipt</button></form>`,
    note: 'Moves this receipt to Archive without changing Actual. Restore it from Archive if you need it again.',
  };
  if (entry.manualLink?.keep) { const verdict = canArchive(id, entry, { endsUndo: true }); if (!verdict.ok) return { form: '', note: verdict.reason }; const form = `<form ${post('archive', key)}>${hidden('id', id)}${keep}${hidden('keep', '1')}<button>Archive: keep what is in Actual</button></form>`; return { form, primary: form, keep: form, note: 'Keeps the charge and its notes unchanged in Actual.' }; }
  const verdict = canArchive(id, { ...entry, key: id }, { noCharge: noChargeKind(summary), endsUndo: true });
  if (!verdict.ok) return { note: verdict.quiet ? '' : `Can't be archived: ${verdict.reason}` };
  const review = verdict.kind === 'applied-review';
  const hand = entry.applied && (review || fix?.locked) ? `<form ${post('archive', key)}>${hidden('id', id)}${keep}${hidden('keep', '1')}<button class="small plain">Archive: keep what's in Actual</button></form>` : '';
  if (review && !(fix?.ok && fix.kind === 'applied' && !fix.dry)) return { form: hand, keep: hand, note: `Can't be archived from here: the #review tag can't be cleared on this page${fix?.reason ? ` (${fix.reason})` : ''}. Check it in Actual.` };
  const byHand = verdict.kind === 'nocharge';
  const label = byHand ? 'Archive (I entered it by hand)' : review ? 'Looks right: clear #review and archive' : 'Archive receipt';
  const note = byHand
    ? `Moves the photo and summary to ${archiveDir()} and takes this receipt off the Status list. Use it when you entered the purchase in Actual yourself, or it needs nothing. Restore it from the Archived tab.`
    : review
    ? `Removes the #review tag in Actual (and changes nothing else about the charge), moves the file to ${processedDir()}, then archives it to ${archiveDir()}.`
    : `Moves the photo and summary to ${archiveDir()} (shrinking the photo if that setting is on) and takes this receipt off the Status list. Restore it from the Archived tab.`;
  // A charge changed by hand in Actual (or still tagged): a second way that makes no change there at all.
  const main = `<form ${post('archive', key)}>${hidden('id', id)}${keep}<button>${escape(label)}</button></form>`;
  // Q2: on a charge changed in Actual, "Looks right" is this same form (clear #review, then archive), with a sentence that says so.
  const locked = review && fix?.locked ? { form: `<form ${post('archive', key)}>${hidden('id', id)}${keep}<button>Looks right</button></form>`, note: 'Looks right clears the #review tag in Actual and archives this receipt. Nothing else changes in Actual.' } : null;
  return { form: `${main}${hand}`, primary: main, keep: hand, locked, note: hand ? `${note} "Archive: keep what's in Actual" changes nothing in Actual (the #review tag stays there) and files the receipt as it is.` : note };
}

/**
 * The Read again button (reread.js) with its one-line explanation, or the short reason it can't be used (nothing when Try again covers it
 * or it is already running); and, after a re-read, the Use old reading button while nothing was saved from the new reading.
 */
function rereadControls(view, key, keep) {
  const post1 = (route, label, body) => `<form ${post(route, key)}>${hidden('id', view.id)}${keep}<button class="plain">${label}</button></form>`;
  const st = rereadState(view.id, view.entry, view.summary, view.seen ?? null);
  const back = restoreState(view.id, view.entry, view.summary, view.seen ?? null);
  const backForm = back.ok ? post1('receipt-reread-restore', 'Use old reading') : '';
  const backNote = back.ok ? 'Puts the reading from before the last Read again back. Nothing is written to Actual.' : back.reason ? `Can't use the old reading: ${back.reason}` : '';
  if (!st.ok) return { form: backForm, note: [st.pending || st.quiet ? '' : `Can't read again: ${st.reason}`, backNote].filter(Boolean).join(' ') };
  if (!view.pages) return { form: backForm, note: [view.photoNote ? `Can't read again: ${view.photoNote}` : '', backNote].filter(Boolean).join(' ') };
  const note = st.kind === 'applied'
    ? 'Reads the photo again with the reader as it is now, for example after an update. Nothing is written to Actual: the items below start from the new reading, and you decide with Preview and Save changes.'
    : 'Reads the photo again with the reader as it is now. Nothing is written to Actual by this.';
  return { form: `${post1('receipt-reread', 'Read again')}${backForm}`, note: [note, backNote].filter(Boolean).join(' ') };
}

/** The receipt detail page. view: from panel-receipt.js receiptView(). nav: from receiptNav() (null when the receipt is not in the list). */
function resolutionHtml(view, key, nav, { collapsed = false, waiting = false } = {}) {
  const r = view.resolution;
  if (!r) return '';
  const values = r.values;
  const original = Object.fromEntries(Object.entries(r.original ?? r.values).map(([k, v]) => ['receipt-' + k, String(v)]));
  const reading = view.summary?.receipt ?? view.entry.reading?.receipt;
  const sum = reading ? Number(reading.subtotal) + Number(reading.tax || 0) + Number(reading.tip || 0) : NaN;
  const suggestion = Number.isFinite(sum) && sum > 0 && Math.round(sum * 100) !== Math.round(Number(values.total) * 100) ? `<p class="muted small">Items, tax and tip add up to ${escape(money(sum))}. <button type="button" class="link" data-use-read-total="${escape(money(sum))}">Use ${escape(money(sum))}</button> Or keep the total entered above.</p>` : '';
  const fields = Object.entries(values).map(([name, value]) => hidden(`receipt-${name}`, value)).join('');
  const carry = `${hidden('id', view.id)}${navFields(nav?.nav)}`;
  const saveForm = (action, button, transaction = '') => `<form ${post('receipt-resolve', key)}>${carry}${fields}${hidden('token', r.token)}${hidden('action', action)}${transaction ? hidden('transaction', transaction) : ''}<button>${escape(button)}</button></form>`;
  const candidates = r.token ? `<h3>Choose an existing charge</h3><p class="small">Looking for the exact total from ${escape(r.window.start)} through ${escape(r.window.end)}. Choosing a charge does not change Actual.</p>${r.candidates.length ? `<ul class="charge-choices">${r.candidates.map((c) => `<li><p><strong>${escape(c.payee)} · ${escape(c.amount)}</strong><br>${escape(c.date)} · ${escape(c.account)}<br><span class="muted">${escape(c.category ?? (c.keep ? 'Existing split' : 'Uncategorized'))}</span></p>${c.pending ? '<p class="muted small">Pending in Actual. Wait for it to clear.</p>' : `${c.keep ? '<p class="small">Keep this charge as it is in Actual, including its split, categories and notes.</p>' : ''}${saveForm('select', c.keep ? 'Link and keep what is in Actual' : 'Use this charge', c.id)}`}</li>`).join('')}</ul>${r.truncated ? '<p class="small">Showing the 30 nearest charges. Correct the date to narrow the search.</p>' : ''}` : '<p>No matching charge is available yet. Check the reading below, then save it to let the worker keep checking automatically.</p>'}<h3>Keep checking automatically</h3><p class="small">Save this reading and resume the normal checks. Your corrections are kept; the photo is not read again.</p>${saveForm('recheck', `Keep checking for ${values.total}`)}` : '';
  const open = r.token || r.error || view.entry.resolutionPending || (!collapsed && !view.fix?.ok);
  // A waiting receipt reaches this form only through the banner's "Find charge or mark as cash" (hidden until asked for once the script runs).
  return `<details class="how${waiting ? ' reveal-only' : ''}" id="receipt-resolution"${open ? ' open' : ''}><summary>${waiting ? 'Find charge or mark as cash' : 'Correct reading / choose transaction'}</summary><p>${waiting ? 'No bank charge has been found yet. Choose a charge yourself, or correct the merchant, date, total or payment method (pick Cash if you paid cash).' : 'Use this when a purchase date, merchant, total or payment method was read incorrectly, or you want to choose a charge yourself.'}</p>${r.error ? `<p role="alert">${escape(r.error)}</p>` : ''}<form method="get" action="receipt#receipt-resolution" data-resolution-form data-id="${escape(view.id)}" data-source="${escape(JSON.stringify(original))}">${hidden('key', key)}${carry}${hidden('resolve', '1')}<div class="resolution-fields"><label>Merchant<input type="text" name="receipt-merchant" value="${escape(values.merchant)}" maxlength="120" required></label><label>Purchase date<input type="date" name="receipt-date" value="${escape(values.date)}"></label><label>Total<input type="text" inputmode="decimal" name="receipt-total" value="${escape(values.total)}" required></label><label>Payment method<select name="receipt-payment_method">${[['card', 'Card'], ['cash', 'Cash'], ['other', 'Other / unknown']].map(([v, label]) => `<option value="${v}"${values.payment_method === v ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div><button>Find matching charges</button>${suggestion}</form><div data-resolution-results>${candidates}</div></details>`;
}

function workspaceStatus(view, fix) {
  const e = view.entry;
  if (e.archived) return ['Archived', 'Restore this receipt to edit its categories.'];
  if (fix?.locked) return ['Changed in Actual', 'The categories are read-only here. Your changes in Actual are kept.'];
  if (fix?.dry) return ['Test mode', 'Nothing is written to Actual or moved.'];
  if (e.creating || e.filing || e.resolutionPending || e.fixedOnPage?.summaryFailed || e.manualLink?.keep) return [whatToDo(e, view.id, view.summary, fix).lines[0], ''];
  if (e.waiting) return ['Waiting for the bank', 'Checked automatically. There is nothing you need to do.'];
  if (fix?.kind === 'cash') return ['Paid cash. Not in Actual yet.', 'Creating it adds a new purchase.'];
  if (fix?.kind === 'review') return ['Charge found. Not split in Actual yet.', view.summary?.selection && view.summary?.transaction?.currentCategory ? `Using ${view.summary.transaction.currentCategory} from the charge. Check before saving.` : 'Check the categories before saving.'];
  if (e.applied && !e.reviewed && String(e.result).endsWith('+review')) {
    const uncertain = (Array.isArray(view.summary?.receipt?.items) ? view.summary.receipt.items : []).filter((item) => item?.unsureGuess);
    return [uncertain.length ? `${uncertain.length} ${uncertain.length === 1 ? 'item' : 'items'} to check: ${uncertain[0].plain || uncertain[0].description}.` : 'Already filed in Actual. Check the categories.', ''];
  }
  if (e.applied && e.done) return ['Filed in Actual', 'Change any category below to update it.'];
  return [whatToDo(e, view.id, view.summary, fix).lines[0], ''];
}

// The status banner's icons (the colour comes from a class, never a style attribute).
const BANNER_ICONS = {
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.5v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  cash: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8m0 8v1.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
};
const bannerIcon = (name, color) => `<span class="ic ic-${color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BANNER_ICONS[name]}</svg></span>`;

/**
 * The one status banner of a receipt. Amber tint only when the receipt needs you (Review, cash, misread); a plain card otherwise, its only
 * colour the icon. `acts` are existing server forms or reveal links; `why` the review reasons (collapsible). The lead keeps
 * data-workspace-status: the script rewrites it while there are unsaved edits.
 */
function statusBanner({ tone, icon, color, lead, note, error, acts, why, whyTitle, checkStatus = false }) {
  return `<section class="status-banner workspace-status t-${tone}" aria-label="Status">${bannerIcon(icon, color)}<div class="tx"><h2 class="status-lead" data-workspace-status>${escape(lead)}</h2>${note ? `<p class="status-note">${escape(note)}</p>` : ''}${error ? `<p class="status-note error-detail">${escape(error)}</p>` : ''}${checkStatus ? '<p class="status-note check-status" data-check-status role="status"></p>' : ''}</div>${acts ? `<div class="acts">${acts}</div>` : ''}${why.length ? `<details class="item-note why"><summary>${escape(whyTitle)}</summary><ul>${why.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul></details>` : ''}</section>`;
}

const GROUP_NAMES = { review: 'Review', waiting: 'Waiting', filed: 'Filed', archive: 'Archive' };

/**
 * The Undo of this receipt's last save from the page (Save, Create cash; a "Looks right" has none) while it is open, for the Saved banner: the one in the
 * page link right after the save, copied exactly; else (Q1: you came back within the 15 minutes) signed again with ts = the save's own time,
 * so the window never grows. null in dry run (also while a switch to it is pending), once archived or ended, while the save is still being recorded, or for an id too long for a link.
 * { undo: { route, fields }, fromLink }.
 */
export function receiptUndo(view, undo, now = Date.now()) {
  const { entry, id } = view;
  if (config.dryRun || parseStateKey(String(id)).dry || !undoOpen(entry, now)) return null;
  if (entry.filing || entry.creating || entry.fixedOnPage.summaryFailed || String(id).length > MAX_UNDO_ID) return null;
  if (resolveDryRun().dryRun) return null; // a switch to dry run is pending: Undo refuses it, so it is not offered
  const at = entry.fixedOnPage.at;
  if (undo?.route === UNDO_ROUTE && undo.fields?.id === id && undo.fields?.at === at) return { undo, fromLink: true };
  return { undo: { route: UNDO_ROUTE, fields: signUndo(UNDO_ROUTE, { id, at }, Date.parse(at)) }, fromLink: false };
}

/** The green Saved banner's words, by what the last save did. */
function savedWords(fixed, now = Date.now()) {
  const minutes = Math.max(1, Math.ceil((Date.parse(fixed.at) + UNDO_WINDOW_MS - now) / 60000));
  const left = `Undo available for ${minutes} min`;
  if (fixed.kind === 'cash') return [`Created in Actual · ${left}`, 'The cash purchase is in Actual. Undo deletes it again.'];
  return [`Saved to Actual · ${left}`, 'Your categories are saved to the existing charge.'];
}

export function receiptPage(view, key, notice, where = null, undo = null) {
  const { entry, id } = view;
  const reading = entry.reading?.receipt ?? view.summary?.receipt ?? null;
  const identity = { ...entry, key: id, file: view.name, summary: view.summary };
  const title = queueIdentity(identity);
  const fix = view.fix?.ok ? { ...view.fix, needsReview: !entry.reviewed && String(entry.result).endsWith('+review') } : null;
  const saved = receiptUndo(view, undo);
  const [lead, note] = saved ? savedWords(entry.fixedOnPage) : workspaceStatus(view, fix);
  const group = entry.archived ? 'archive' : queueGroup(identity);
  // "Next receipt" stays in the group the receipt was opened from (nav.group), else its own; every link and form on the page carries that
  // group, so it holds after a Save moves the receipt to Filed. An archived receipt walks the Archive list instead (the pager below).
  const steps = entry.archived ? null : groupSteps(where, id, group);
  const nav = where && steps ? { ...where, nav: { ...where.nav, group: steps.group } } : where;
  const k = escape(encodeURIComponent(key));
  const back = `${entry.archived ? 'archived' : './'}?key=${k}${escape(navQuery(nav?.nav))}${nav ? `#r${nav.row}` : ''}`;
  // Archiving goes on to the next receipt of the group, or back to the list after the last one (never to the previous one). Try again keeps
  // its old fall-back to the previous receipt, within the group.
  const after = entry.archived ? null : steps?.next ?? null;
  const keep = `${hidden('from', 'receipt')}${hidden('next', after?.key ?? '')}${navFields(nav?.nav)}`;
  const retryKeep = `${hidden('from', 'receipt')}${hidden('next', (steps?.next ?? steps?.prev)?.key ?? '')}${navFields(nav?.nav)}`;
  const retry = retryStatus(id, { ...entry, key: id }) === 'yes' ? retryCell({ ...entry, key: id }, key, retryKeep) : '';
  const archive = entry.archived ? { form: `<form ${post('restore', key)}>${hidden('id', id)}${keep}<button>Restore</button></form>`, note: '' } : archiveControls(id, entry, view.fix, key, keep, view.summary);
  const again = rereadControls(view, key, keep);
  const waiting = Boolean(entry.waiting) && !entry.done && !entry.archived && !fix;
  const resolving = !fix && Boolean(view.resolution) && !waiting;
  const link = (r) => `receipt?key=${k}&amp;id=${escape(encodeURIComponent(r.key))}${escape(navQuery(nav?.nav))}`;
  let acts = '';
  // Saved · Undo (green, only while the Undo is open): the Undo form and Archive. Archiving is allowed at once and ends the Undo (P8a).
  if (saved) acts = `${undoForm(saved.undo, key)}${archive.primary || ''}`;
  else if (entry.archived) acts = `<form ${post('restore', key)}>${hidden('id', id)}${keep}<button class="primary">Restore receipt</button></form>`;
  else if (waiting) acts = `<form ${post('run', key)} data-check-now><button class="plain">Check now</button></form>${view.resolution ? '<a class="btn plain" href="#receipt-resolution" data-reveal data-focus="receipt-merchant">Find charge or mark as cash</a>' : ''}`;
  else if (resolving) acts = `<a class="btn plain" href="#receipt-resolution" data-reveal data-focus="receipt-total">Fix total</a>${again.form || ''}`;
  else if (fix?.locked) acts = archive.keep || '';
  else if (fix?.kind === 'cash') acts = archive.primary || '';
  else if (retry) acts = retry;
  else if (fix?.kind === 'cash' || group === 'filed') acts = archive.primary || '';
  // "Open in Actual" beside the banner's buttons (Changed in Actual: that charge's account; Waiting: the base address; Cash: the cash account).
  const toActual = (name) => actualAnchor('Open in Actual &#8599;', name, 'actual-link small');
  if (!saved && !entry.archived) {
    if (fix?.locked) acts += toActual(view.summary?.transaction?.account);
    else if (waiting) acts += toActual(view.summary?.transaction?.account);
    else if (fix?.kind === 'cash') acts += toActual(fix.cash?.account);
  }
  const reasons = reviewReasons(view.summary);
  const activeReview = group === 'review' && !saved && !entry.reviewed && !entry.archived;
  const tone = saved ? 'ok' : entry.archived || fix?.locked || waiting || fix?.dry ? 'none' : group === 'review' ? 'attn' : 'none';
  const [icon, color] = saved ? ['check', 'ok'] : entry.archived ? ['archive', 'muted'] : fix?.locked ? ['lock', 'attn'] : waiting ? ['clock', 'muted'] : fix?.kind === 'cash' ? ['cash', 'attn'] : fix?.dry ? ['alert', 'muted'] : group === 'review' ? ['alert', 'attn'] : ['check', 'ok'];
  const banner = statusBanner({ tone, icon, color, lead, note: saved && archive.primary ? `${note} Archiving ends Undo.` : note, error: entry.error, acts, why: activeReview ? reasons : [], checkStatus: waiting && !saved, whyTitle: `Why it needs review${view.summary?.reread?.doubts ? ' (when it was filed)' : ''}` });
  const photoUrl = (extra) => `receipt-photo?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}${extra}`;
  const photos = Array.from({ length: view.pages }, (_, i) => `<img class="photo" src="${escape(photoUrl(`&page=${i + 1}`))}" alt="Receipt ${escape(view.name)}, page ${i + 1}" loading="lazy">`).join('');
  const photo = `<details class="receipt-photo-toggle" open><summary>View receipt</summary><h2 class="workspace-section-title">Receipt</h2><div class="receipt-photo-wrap" data-photo-wrap>${photos || `<p class="muted">${escape(view.photoNote || 'No photo to show.')}</p>`}</div>${photos ? '<button type="button" class="small plain photo-toggle" data-photo-toggle hidden>Show whole receipt</button><button type="button" class="small plain photo-full" data-photo-full>Show full size</button>' : ''}${view.pdf && view.pages ? `<p><a href="${escape(photoUrl('&raw=1'))}">Download original PDF</a></p>` : ''}</details>`;
  // A charge changed in Actual: the read-only table, and "Looks right" (clears the review tag and archives, as its sentence says).
  const stepRow = steps && nav && (steps.prev || steps.next) ? `<nav class="next-row${waiting ? ' waitrow' : ''}" aria-label="${escape(GROUP_NAMES[steps.group])} receipts">${steps.prev ? `<a class="btn plain prev-link" data-navigate rel="prev" href="${link(steps.prev)}">&larr; Previous</a>` : ''}${steps.next ? `<a class="btn plain" data-navigate rel="next" href="${link(steps.next)}">Next receipt &rarr;</a>` : ''}</nav>` : '';
  const lockedFooter = fix?.locked && archive.locked ? `<div class="editor-actions locked-actions"><p class="locked-consequence">${escape(archive.locked.note)}</p><div class="buttons">${archive.locked.form}${stepRow}</div></div>`
    : fix?.locked && archive.primary ? `<div class="editor-actions locked-actions"><p>${escape(archive.note)}</p><div class="buttons">${archive.primary}${stepRow}</div></div>` : '';
  const editable = Boolean(fix && reading && Array.isArray(reading.items) && !fix.locked);
  const editor = fix && reading && Array.isArray(reading.items) ? `${editableItems(reading, fix, key, id, nav)}${!fix.locked ? previewHtml(fix, key, id, nav, view.summary) + editorActions(fix, key, reading.total, stepRow) : lockedFooter}` : resolving ? resolutionHtml(view, key, nav) : entry.archived ? archivedItems(view) : `<p class="muted">${escape(view.fix?.reason || view.summaryNote || 'The items are not ready to edit yet.')}</p>`;
  const browse = nav ? `<details class="how"><summary>Browse receipts</summary>${pagerHtml(nav, key, true, Boolean(entry.archived))}</details>` : '';
  const info = `<details class="workspace-details" id="receipt-information"><summary>Receipt details</summary>${readingHtml(reading, view.summaryNote, dateUsed(view), view.summary?.plan?.tax, fix ? '' : null)}${!activeReview && reasons.length ? `<details class="item-note"><summary>Why it was reviewed</summary><ul>${reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul></details>` : ''}${decisionHtml(view.summary)}<p>${escape(view.name)}</p><p class="small">Last processed ${entry.at && !Number.isNaN(Date.parse(entry.at)) ? `<time datetime="${escape(new Date(entry.at).toISOString())}">${escape(when(entry.at))}</time>` : ''}</p>${entry.filedAs ? `<p>Filed as ${escape(entry.filedAs)}</p>` : ''}${archive.note ? `<p>${escape(archive.note)}</p>` : ''}${again.note ? `<p>${escape(again.note)}</p>` : ''}${browse}<details class="how"><summary>Processing details</summary>${whatToDo(entry, id, view.summary, fix).lines.map((l) => `<p>${escape(l)}</p>`).join('')}<p>Result code: ${escape(resultKey(entry))}</p></details>${how()}</details>`;
  // Every action of the old More menu is still reachable, in one place: the banner or footer where the state shows it, else More. More lists only what is not already visible.
  const shown = `${acts}${lockedFooter}`;
  const extra = (html) => (html && !shown.includes(html) ? html : '');
  const archiveForms = entry.archived ? [] : archive.primary || archive.keep ? [archive.primary, archive.keep] : [archive.form];
  const more = `<details class="receipt-more"><summary>More</summary><div class="receipt-more-panel">${view.resolution && !shown.includes('href="#receipt-resolution"') ? '<a href="#receipt-resolution" data-reveal>Find charge or correct reading</a>' : ''}${extra(again.form)}${extra(retry)}${[...new Set(archiveForms)].map(extra).join('')}${fix ? actualBar(fix, key, id, nav) : ''}<a href="#receipt-information" data-reveal>Receipt details</a></div></details>`;
  const photoColumn = `<div class="receipt-photos" id="receipt-photo" tabindex="-1">${photo}</div>`;
  // Previous / Next receipt within the group: the only links with rel (the arrow keys). Shown under the card, or (waiting) under the banner.

  const editorColumn = `<section class="workspace-editor" id="receipt-items" tabindex="-1">${editable ? '' : `<div class="editor-heading"><h2 class="card-title">${resolving ? 'Find a charge' : 'Items &amp; categories'}</h2></div>`}${editor}${waiting || editable || lockedFooter ? '' : stepRow}</section>`;
  // A waiting receipt has no item editor until a charge is found: the banner, Next and the image. Finding a charge is behind the banner button.
  const next = waiting ? stepRow : '';
  const grid = waiting ? `<div class="receipt-grid waiting-grid">${photoColumn}</div>` : `<div class="receipt-grid${resolving ? ' has-resolution' : ''}">${resolving ? editorColumn + photoColumn : photoColumn + editorColumn}</div>`;
  const resolution = waiting ? resolutionHtml(view, key, nav, { collapsed: true, waiting: true }) : fix && view.resolution ? resolutionHtml(view, key, nav) : '';
  const body = `<div class="workspace-shell has-receipt">${entry.archived ? archiveRail(nav?.full ?? nav?.list ?? [identity], key, { selected: id, nav: navQuery({ sort: nav?.nav?.sort, dir: nav?.nav?.dir }), sort: nav?.nav ?? {}, empty: 'Nothing archived yet.' }) : queueRail(nav?.all ?? nav?.list ?? [identity], key, id, navQuery(withoutGroup(nav?.nav)))}<article class="workspace-detail" data-receipt-id="${escape(id)}"><a class="workspace-back" data-navigate href="${back}">&larr; ${GROUP_NAMES[entry.archived ? 'archive' : steps.group]}</a><div class="workspace-title"><h2 tabindex="-1" data-workspace-title>${escape(title.store)}</h2><div class="title-side"><span class="workspace-total">${title.total != null ? escape(displayMoney(title.total)) : ''}</span>${more}</div></div><p class="workspace-meta">${escape(displayDate(title.date))}${view.summary?.transaction?.account ? ` · ${actualAnchor(`${escape(view.summary.transaction.account)} &#8599;`, view.summary.transaction.account, 'actual-link') || escape(view.summary.transaction.account)}` : ''}</p>${banner}${nav?.relaxed ? '<p class="muted small">This receipt is outside the filter, so all receipts are shown.</p>' : ''}${next}${grid}${resolution}${info}</article></div>`;
  // The banner holds this receipt's Undo: the notice line does not repeat it (nor an older one for the same receipt). A "Looks right" has
  // no Undo: an old link that still carries one for this receipt shows none either.
  const noticeUndo = (saved || entry.fixedOnPage?.markOnly) && undo?.route === UNDO_ROUTE && undo.fields?.id === id ? null : undo;
  return layout({ active: entry.archived ? 'archived' : 'status', key, notice, body, undo: noticeUndo, wide: true, title: title.store, heading: 'Receipt' });
}
