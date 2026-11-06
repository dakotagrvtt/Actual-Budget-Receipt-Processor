export const cents = (amount) => Math.round(Number(amount) * 100);
export const money = (c) => (c / 100).toFixed(2);
// Split part for money the pipeline couldn't place: unsure items and lines it didn't read. Left uncategorized in Actual.
export const UNCATEGORIZED = 'Uncategorized';
export const shortName = (label) => label.split(' / ').pop();

// Annotations that only make sense on the Uncategorized part (and must not be learned as item history elsewhere).
const NOT_READ = 'not read from the receipt';
const isUnsureNote = (text) => text.endsWith(NOT_READ);
const stripGuess = (text) => text.replace(/ \(maybe [^)]*\)$/, '');

/**
 * Split targetCents in proportion to weights (signed integers, positive sum), exactly: each part is its share
 * rounded down, then the leftover cents go to the largest remainders. Integer math, so no float drift.
 */
function apportion(weights, targetCents) {
  const total = weights.reduce((a, w) => a + w, 0);
  const parts = weights.map((w, i) => {
    const p = w * targetCents;
    let q = Math.floor(p / total);
    let r = p - q * total; // exact remainder in [0, total)
    while (r < 0) { q -= 1; r += total; }
    while (r >= total) { q += 1; r -= total; }
    return { i, q, r };
  });
  let left = targetCents - parts.reduce((a, x) => a + x.q, 0);
  for (const x of [...parts].sort((a, b) => b.r - a.r || Math.abs(weights[b.i]) - Math.abs(weights[a.i]))) {
    if (left <= 0) break;
    x.q += 1;
    left -= 1;
  }
  return parts.map((x) => x.q);
}

/**
 * Split the bank transaction's amount (targetCents) across the receipt's categories.
 * Each category's share is its net line items (returns and coupons count negative); tax, tip, rounding and
 * receipt-level discounts are spread over the categories in proportion to those nets, so the split always adds up
 * exactly to what the bank charged. A category whose net is negative (a returned shirt, a coupon bigger than the
 * item it's for) becomes a credit part with a negative amount, an inflow split line, and the positive parts grow
 * to match; that adds a problem so the receipt gets reviewed.
 * Returns { allocation: [{label, categoryId, cents, items}] (largest first) or null, problems: [string] }.
 */
export function allocate(receipt, labelToId, targetCents, { gapLabel = UNCATEGORIZED } = {}) {
  const problems = [];
  const byLabel = new Map();
  const add = (label, amountCents, text) => {
    const entry = byLabel.get(label) ?? { cents: 0, items: [] };
    entry.cents += amountCents;
    entry.items.push(text);
    byLabel.set(label, entry);
  };
  for (const item of receipt.items) {
    let text = item.plain && item.plain.toLowerCase() !== item.description.toLowerCase() ? `${item.description} (${item.plain})` : item.description;
    if (item.unsureGuess) text += ` (maybe ${item.unsureGuess})`;
    add(item.category ?? UNCATEGORIZED, cents(item.amount), text); // null: an invalid decider answer nobody placed
  }
  const itemsSum = [...byLabel.values()].reduce((a, e) => a + e.cents, 0);
  if (itemsSum <= 0) return { allocation: null, problems: ['line items add up to zero or less'] };

  if (receipt.subtotal != null) {
    const subtotal = cents(receipt.subtotal);
    if (Math.abs(itemsSum - subtotal) > Math.max(5, 0.02 * subtotal)) {
      problems.push(`line items add up to ${money(itemsSum)} but the printed subtotal is ${money(subtotal)}; an item was probably misread or missed`);
      // Money the reader missed goes to the store's usual category, or stays uncategorized, rather than being
      // spread over the items that were read.
      if (subtotal > itemsSum) add(gapLabel, subtotal - itemsSum, `${money(subtotal - itemsSum)} ${NOT_READ}`);
    }
  } else if (Math.abs(cents(receipt.total) - itemsSum) > 0.3 * cents(receipt.total)) {
    problems.push(`line items (${money(itemsSum)}) are far from the printed total (${money(cents(receipt.total))})`);
  }

  // Categories that net to exactly zero (an item and its own refund) have nothing to split.
  const nets = [...byLabel].filter(([, e]) => e.cents !== 0);
  if (!nets.some(([, e]) => e.cents > 0) || nets.reduce((a, [, e]) => a + e.cents, 0) <= 0) {
    return { allocation: null, problems: [...problems, 'returns and coupons cancel out the purchases'] };
  }
  const shares = apportion(nets.map(([, e]) => e.cents), targetCents);
  const allocation = nets
    .map(([label, e], i) => ({ label, categoryId: label === UNCATEGORIZED ? null : labelToId.get(label) ?? null, cents: shares[i], items: e.items }))
    .sort((a, b) => b.cents - a.cents);
  for (const a of allocation) {
    if (a.cents < 0) problems.push(`includes a credit of ${money(-a.cents)} in "${a.label}" (a return or coupon)`);
  }
  return { allocation, problems };
}

/**
 * Fold positive parts smaller than minCents into the transaction's current category (if it's one of the parts)
 * or else the largest categorized part, so a stray $0.79 item doesn't become its own split line.
 * Never merged: credit (negative) parts, and the Uncategorized part, which is money left for you to place.
 * When the only categorized parts are tiny, they fold into the Uncategorized part instead of leaving a $0.50
 * categorized line next to $50 uncategorized.
 */
export function mergeSmallParts(allocation, minCents, preferCategoryId) {
  if (allocation.length < 2) return allocation;
  const small = (a) => a.categoryId && a.cents >= 0 && a.cents < minCents;
  const placed = allocation.filter((a) => a.categoryId && a.cents > 0).sort((a, b) => b.cents - a.cents);
  const unplaced = allocation.find((a) => !a.categoryId && a.cents > 0);
  const preferred = placed.find((a) => a.categoryId === preferCategoryId);
  const after = (h) => h.cents + allocation.filter((a) => a !== h && small(a)).reduce((n, a) => n + a.cents, 0);
  // The current category, else the largest; one that would still be tiny after merging loses to Uncategorized.
  const home = [preferred, placed[0]].find((h) => h && after(h) >= minCents) ?? unplaced ?? preferred ?? placed[0];
  if (!home) return allocation;
  const intoUncategorized = !home.categoryId;
  const kept = [];
  for (const part of allocation) {
    if (part !== home && small(part)) {
      home.cents += part.cents;
      // Unsure-money notes stay on the Uncategorized part; a categorized part keeps only real items.
      const items = intoUncategorized
        ? part.items.map((t) => (isUnsureNote(t) ? t : `${t} (${shortName(part.label)})`))
        : part.items.filter((t) => !isUnsureNote(t)).map(stripGuess);
      home.items = [...home.items, ...items];
    } else {
      kept.push(part);
    }
  }
  return kept.sort((a, b) => b.cents - a.cents);
}

/** Paid in cash: the payment line says so. Card receipts print "Tendered" too, so cash_tendered alone isn't enough. */
export const paidCash = (receipt) => /\bcash\b(?!\s*back)/.test(String(receipt.payment_method ?? '').toLowerCase());

/**
 * On cash receipts the reader sometimes takes the cash handed over as the total (paid $15.00 for 14.53). When
 * subtotal + tax + tip doesn't equal the total and the total looks like the cash tendered, use the computed amount.
 * Only for receipts paid in cash (see paidCash): on a card receipt a mismatch means something else was misread.
 * Returns a note when it changed the total.
 */
export function fixCashTotal(receipt) {
  const { subtotal, tax } = receipt;
  if (typeof subtotal !== 'number' || typeof tax !== 'number') return null;
  const computed = cents(subtotal) + cents(tax) + cents(receipt.tip ?? 0);
  const total = cents(receipt.total);
  if (Math.abs(computed - total) <= 1) return null;
  if (!paidCash(receipt)) return null;
  const isTendered = receipt.cash_tendered != null && cents(receipt.cash_tendered) === total;
  if (!isTendered && !(total > computed)) return null;
  receipt.total = computed / 100;
  return `total read as ${money(total)}, which looks like the cash handed over; using subtotal + tax = ${money(computed)}`;
}

/**
 * A split part's note without the pipeline's notes on unsure money ("MED-DVD'S (maybe Child 34%)",
 * "4.12 not read from the receipt"): those are guesses, not examples to learn from. Null if nothing is left.
 */
export function stripAnnotations(notes) {
  if (!notes) return null;
  const out = notes
    .replace(/ \(maybe [^)]*(?:\)|$)/g, '') // also when the note was cut off at 200 characters
    .replace(/(?:^|,\s*)-?\d+(?:\.\d+)? not read from the receipt/g, '')
    .replace(/\s*#(?:always|usually)\b[^,;|(\n#]*/gi, ' ') // the keyword tags (see keywords.js)
    .replace(/\s+([,;|])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .replace(/^[\s,|;]+|[\s,|;]+$/g, '')
    .trim();
  return out || null;
}
