// Matching a receipt to its bank charge: the search window, the payee check, and when a charge that hasn't
// posted yet is given up on.
import { config, log } from './config.js';
import * as actual from './actual.js';
import { storeScore } from './payee.js';
import { cents, money, paidCash } from './reconcile.js';
import { DAY, isoDay, shiftDay } from './dates.js';

// Payee scores closer than this are too close to call between two candidates.
const AMBIGUOUS_SCORE_GAP = 0.15;
// How many older charges the review message lists.
const OLDER_LISTED = 5;

export const describe = (t) => `${t.date} ${t.accountName ?? ''} ${money(-t.amount)} "${t.payeeName ?? t.imported_payee ?? '?'}"`.replace(/ {2,}/g, ' ');

/**
 * Find the bank-synced transaction in a date window. Amount and date narrow the candidates; the payee must then
 * look like the receipt's merchant. Returns { txn } or { problem, kind: 'none' | 'payee' | 'ambiguous', candidates }.
 */
async function matchTransaction(receipt, window, { includeSplits = false } = {}) {
  const total = cents(receipt.total);
  // Scores the merchant as read plus any other text naming the business (e.g. "menards.com" when the logo is cut off).
  const score = (c) => storeScore(receipt, [c.payeeName, c.imported_payee]);
  const candidates = (await actual.findCandidates(total, window, { includeSplits })).map((c) => ({ ...c, payeeScore: score(c) }));
  if (candidates.length === 0) {
    return { kind: 'none', candidates, problem: `no transaction of ${money(total)} found between ${window.start} and ${window.end} (transfers, existing splits and #receipt-tagged ones are skipped)` };
  }
  return pickMatch(receipt, candidates);
}

/**
 * Choose among candidates that already have a payeeScore (and accountName): the best-named one, unless two are
 * too close to call. Returns { txn } or { problem, kind: 'payee' | 'ambiguous', candidates }.
 */
export function pickMatch(receipt, candidates) {
  // Best payee first: a tip-sized difference in amount doesn't make a worse-named charge the better match.
  const passing = candidates
    .filter((c) => c.payeeScore >= config.match.payeeMinScore)
    .sort((a, b) => b.payeeScore - a.payeeScore || a.extraCents - b.extraCents || a.days - b.days);
  if (passing.length === 0) {
    return {
      kind: 'payee',
      candidates,
      problem: `amount and date match, but no payee looks like "${receipt.merchant}"${receipt.store_clues?.length ? ` (clues: ${receipt.store_clues.join(', ')})` : ''}: ${candidates.map((c) => `${describe(c)} (payee score ${c.payeeScore.toFixed(2)})`).join('; ')}. If one of these is right, add the names to payee-aliases.json.`,
    };
  }
  const [best] = passing;
  const close = passing.filter((c) => best.payeeScore - c.payeeScore < AMBIGUOUS_SCORE_GAP);
  if (close.length === 1) return { txn: best };
  // Tie-breaker only: the card's last 4 digits in one account's name.
  const last4 = typeof receipt.card_last4 === 'string' && /^\d{4}$/.test(receipt.card_last4.trim()) ? receipt.card_last4.trim() : null;
  const byCard = last4 ? passing.filter((c) => (c.accountName ?? '').includes(last4)) : [];
  if (byCard.length === 1 && close.includes(byCard[0])) {
    log(`  ${close.length} transactions match; picking the one on the card ending ${last4} (${byCard[0].accountName})`);
    return { txn: byCard[0] };
  }
  return { kind: 'ambiguous', candidates: passing, problem: `more than one transaction matches: ${passing.map(describe).join('; ')}` };
}

/**
 * Match a receipt to its charge. Dated receipts search around the date. Undated ones search the recent days before
 * the upload; an older match found in the long lookback is only reported, never applied.
 * Returns matchTransaction's answer plus doubts (about the match, for review if money moves) and waitable
 * (the charge may simply not have posted yet).
 */
export async function findMatch(receipt, date, anchor, opts) {
  if (date) {
    const m = await matchTransaction(receipt, actual.matchWindow(date, anchor), opts);
    const doubts = [];
    if (m.txn && m.txn.date < date) doubts.push(`the charge (${m.txn.date}) is dated a day before the receipt (${date})`);
    return { ...m, doubts, waitable: m.kind === 'none' || m.kind === 'payee' };
  }
  const day = isoDay(anchor);
  const recent = { start: shiftDay(day, -config.match.noDateRecentDays), end: shiftDay(day, 1), ref: day };
  log(`  no usable date: looking for the charge between ${recent.start} and ${recent.end}`);
  const m = await matchTransaction(receipt, recent, opts);
  if (m.txn) return { ...m, doubts: ['the receipt has no readable date, so the charge was matched by amount and payee only'] };
  if (m.kind === 'ambiguous') return { ...m, doubts: [], waitable: false };
  const long = actual.matchWindow(null, anchor);
  const older = await matchTransaction(receipt, long, opts);
  if (older.txn || older.kind === 'ambiguous') {
    const found = older.txn ? [older.txn] : older.candidates;
    return {
      kind: 'older',
      candidates: found,
      doubts: [],
      waitable: true,
      problem: `the receipt has no readable date and no charge in the ${config.match.noDateRecentDays} days before the upload matches; an older charge matches, check it: ${found.slice(0, OLDER_LISTED).map((c) => `${describe(c)} (payee score ${c.payeeScore.toFixed(2)})`).join('; ')}`,
    };
  }
  return { ...m, doubts: [], waitable: true };
}

/**
 * When a charge may still post (or clear): through the day after the search window's last day for dated receipts,
 * or MATCH_DAYS + 1 days after the upload for undated ones. A pending charge gets MATCH_PENDING_WAIT_DAYS more.
 */
export function chargeDeadline(date, anchor, pending = false) {
  const base = date ? Date.parse(`${date}T00:00:00Z`) + (config.match.days + 2) * DAY : anchor.getTime() + (config.match.days + 1) * DAY;
  return new Date(base + (pending ? config.match.pendingWaitDays * DAY : 0));
}

/** Receipts with nothing to match: cash, refunds, unreadable totals. */
export function unmatchable(receipt) {
  const total = cents(receipt.total);
  if (receipt.is_return === true || total < 0) return "this is a return/refund receipt; refunds aren't matched yet";
  if (!(total > 0)) return 'total is missing or not positive';
  // Cash purchases have no bank charge; the worker never creates transactions, so say so plainly.
  if (paidCash(receipt)) {
    return `paid in cash${receipt.cash_tendered != null ? ` (${money(cents(receipt.cash_tendered))} handed over)` : ''}, so there's no bank charge of ${money(total)} to match; enter it in Actual by hand`;
  }
  return null;
}
