// Turning a receipt into split parts: folds coupons into their items, divides the bank charge over the budget
// categories (spreading tax, tip and rounding exactly), merges tiny parts and cleans up notes. Pure functions, no I/O;
// receipt.js calls them and learning.js reads the notes back.
import { config } from './config.js';

export const cents = (amount) => Math.round(Number(amount) * 100);
export const money = (c) => (c / 100).toFixed(2);
// Split part for money the pipeline couldn't place: unsure items and lines it didn't read. Left uncategorized in Actual.
export const UNCATEGORIZED = 'Uncategorized';
// Longest note on one split part, and longest item list in a single-category note. Shared by actual.js (what is written)
// and learning.js (the snapshot of what was written, which must match it).
export const SPLIT_NOTE_MAX = 200;
export const ITEMS_NOTE_MAX = 300;
export const shortName = (label) => label.split(' / ').pop();

// How far item totals may drift from a printed total before the receipt counts as misread: the larger of 5 cents and 2%.
const drift = (c) => Math.max(5, 0.02 * c);
// Items further than this share of the printed total away from it are flagged for review.
const FAR_FROM_TOTAL = 0.3;
// Annotations that only make sense on the Uncategorized part (and must not be learned as item history elsewhere).
const NOT_READ = 'not read from the receipt';
const isUnsureNote = (text) => text.endsWith(NOT_READ);
// Marks a split part whose items all got the store's usual category only because the model was unsure (once, at the end of
// the part's note); stripAnnotations removes it, and itemHistory reads it back to know such items are not examples (actual.js).
export const STORE_DEFAULT = '(store default)';
const MARK = ` ${STORE_DEFAULT}`;

/** Did every item in this part (apart from money not read) fall back to the store's category? */
function allDefaulted(part) {
  const real = (part.refs ?? []).filter(Boolean);
  return real.length > 0 && real.every((r) => r.fellBack);
}

/**
 * The note written for a part: its items joined by `sep`, cut to `max` characters, and the store-default mark after the cut
 * (so a long note keeps it). The same text is saved in the learning snapshot.
 */
export function partNote(part, sep, max) {
  const marked = allDefaulted(part);
  const limit = marked ? max - MARK.length : max;
  let out = part.items.join(sep);
  if (out.length > limit) { // cut between items, not inside one (a cut item would teach learning a half name)
    out = '';
    for (const t of part.items) {
      const next = out ? out + sep + t : t;
      if (next.length > limit) break;
      out = next;
    }
    if (!out) out = part.items[0].slice(0, limit);
  }
  return out + (marked ? MARK : '');
}
const stripGuess = (text) => text.replace(/ \(maybe [^)]*\)$/, '').replace(/ \(store default\)$/, '');

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

// A negative line that is a return, not a discount: it stays its own line.
const RETURN_LINE = /\b(?:return|refund)/i;
// Words that make a negative line a discount: "INSTANT SAVINGS", "MFR COUPON", "TPD/123", "10% OFF". Anything else negative
// (an exchange, "GIFT CARD -20") stays its own line unless an item number ties it to an item.
const DISCOUNT_WORDS = /coupon|saving|\bsave\b|\boff\b|discount|promo|instant|\btpd\b|\bmfr\b|%/i;
// Item numbers on a discount line ("TPD/1234567"): digit runs long enough not to be a quantity or a price.
// A coupon for the whole receipt ("10% OFF ENTIRE PURCHASE", "STORE-WIDE SAVINGS"): never folded into one item.
const WHOLE_RECEIPT = /\b(?:entire|whole\s+(?:purchase|order|receipt|basket|cart|transaction)|store[\s-]?wide|everything|all items|every item|basket|cart)\b|\b(?:on|of|off|for)\s+(?:your\s+|the\s+|this\s+)?(?:purchase|order|transaction|total|bill|visit)\b|\b(?:purchase|order|transaction|total|bill)\s+(?:discount|coupon|savings?)\b/i;
const NUMBER_REF = /^\d{4,}\s*\/\s*\d{4,}$/; // a coupon line that only points at an item: "0000390146 /1111161"
const itemCodes = (text) => String(text).match(/\d{4,}/g) ?? [];

/**
 * Fold each discount or coupon line (a negative amount) into the item it discounts, before the items are categorized, so
 * the discount can't land in another category than its item and shift money between parts. The target is the item whose
 * text holds an item number the discount line also holds ("TPD/1234567"; an earlier item first, else a later one), else,
 * for a line that has no number but reads as a discount (DISCOUNT_WORDS), the nearest positive item before it. A line
 * with a number that no item has is left alone, unless it holds only two item numbers and no item keeps a number in its text
 * (the reader drops SKUs, so "0000390146 /1111161  4.00-" is a coupon for the item before it). The target's amount drops by the discount and `discountCents` records it
 * (allocate writes "(pipeline: after 3.00 off)" in the part's note).
 * A line stays as it is when there is no target (a coupon for the whole receipt, nothing before it), when the discount is
 * as big as the item, on a return receipt, when it reads as a return, and when it doesn't read as a discount. The items
 * still sum to what they did before, so the subtotal check and the split are unchanged.
 * Mutates the receipt; returns what it folded: [{ line, into, cents }].
 */
export function foldDiscounts(receipt) {
  if (receipt.is_return) return [];
  const folded = [];
  const kept = [];
  receipt.items.forEach((line, i) => {
    const off = -cents(line.amount);
    const target = off > 0 && !RETURN_LINE.test(line.description) ? discountTarget(line, kept, receipt.items.slice(i + 1)) : null;
    if (!target || cents(target.amount) <= off) {
      kept.push(line);
      return;
    }
    target.amount = (cents(target.amount) - off) / 100;
    target.discountCents = (target.discountCents ?? 0) + off;
    folded.push({ line: line.description, into: target.description, cents: off });
  });
  receipt.items = kept;
  return folded;
}

/**
 * Fixes items that add up to more than the printed subtotal (a missed coupon, or a line the reader invented or doubled),
 * using the printed per-rate tax lines to find which group of items is too high. Only with TAX_BY_ITEM.
 *
 * It only acts when all of this holds:
 *  - the items exceed the subtotal by more than allocate() tolerates;
 *  - the prices are not tax-included (items near the total, or a gap equal to the tax, mean tax-included);
 *  - subtotal + tax + tip equals the total;
 *  - two or more coded tax lines make up the tax, and every purchased item's code belongs to one of them.
 *
 * Each tax line says what its group of items should add up to: its printed base, or else its tax divided by its printed
 * rate. The one group that is too high by the receipt's gap takes the whole gap, spread over its positive items in
 * proportion to their amounts (`gapCents` on each item). Several groups are corrected only if all print a base, all are
 * too high, and their excess adds up to the gap (within 2 cents).
 *
 * Anything else changes nothing: items under the subtotal, an item without a code, a gap that fits no group, an "exact"
 * group whose rounding tolerance could hide the gap, or a corrected group that would drop to 0 or less.
 *
 * Mutates the receipt. Returns { cents: items minus subtotal, codes: the line codes whose items were changed }, or null.
 */
export function fixTaxGap(receipt) {
  if (!config.taxByItem || receipt.is_return || receipt.subtotal == null || receipt.tax == null || !Array.isArray(receipt.tax_lines)) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const itemsC = sum(receipt.items.map((it) => cents(it.amount)));
  const gap = itemsC - cents(receipt.subtotal);
  // Only items over the subtotal (a missed coupon, a phantom or doubled line), and only beyond allocate's own tolerance.
  // Items that add up to the total are tax-included prices (VAT), and a gap equal to the tax is the same thing.
  if (gap <= drift(cents(receipt.subtotal)) || Math.abs(gap - cents(receipt.tax)) <= 2) return null;
  if (Math.abs(itemsC - cents(receipt.total)) <= drift(cents(receipt.total))) return null;
  if (Math.abs(cents(receipt.subtotal) + cents(receipt.tax) + cents(receipt.tip ?? 0) - cents(receipt.total)) > 1) return null;
  const coded = [...mergeLines(receipt.tax_lines).values()].filter((l) => l.code);
  if (coded.length < 2 || Math.abs(sum(coded.map((l) => l.amount)) - cents(receipt.tax)) > 1) return null;
  const positive = receipt.items.filter((it) => cents(it.amount) > 0);
  if (!positive.length || positive.some((it) => !it.tax_code)) return null;
  const map = matchCodes(coded, receipt.items, true);
  if (!map || positive.some((it) => !map.has(it.tax_code))) return null;
  const groups = [];
  for (const l of coded) {
    const items = receipt.items.filter((it) => map.get(it.tax_code) === l.code);
    if (!items.length) continue;
    const net = sum(items.map((it) => cents(it.amount)));
    let want = l.base;
    let tol = 2;
    if (want == null) {
      if (!(l.amount > 0) || l.rate == null) return null;
      // the rate as a percent or a fraction: whichever puts the group nearest to what the items net
      const frac = l.rate < 0.15 ? l.rate : l.rate / 100; // below 0.15 a fraction, else a percent
      want = Math.round(l.amount / frac);
      tol = Math.max(2, 0.5 / frac + 1);
    }
    if (!(l.amount > 0)) return null;
    const off = net - want;
    groups.push({ code: l.code, items, net, off: Math.abs(off) > tol ? off : 0, tol, base: l.base != null });
  }
  const bad = groups.filter((g) => g.off !== 0);
  if (groups.some((g) => g.off === 0 && g.tol >= gap)) return null; // an "exact" group could be the one holding the gap
  let fixes;
  if (bad.length === 1 && Math.abs(bad[0].off - gap) <= bad[0].tol) fixes = [[bad[0], gap]];
  else if (bad.length >= 2 && bad.every((g) => g.base) && bad.every((g) => g.off > 0) && Math.abs(sum(bad.map((g) => g.off)) - gap) <= 2) fixes = bad.map((g, i) => [g, i === 0 ? g.off + gap - sum(bad.map((x) => x.off)) : g.off]);
  else return null;
  if (fixes.some(([g, c]) => g.net - c <= 0)) return null;
  for (const [g, c] of fixes) {
    const own = g.items.filter((it) => cents(it.amount) > 0);
    apportion(own.map((it) => cents(it.amount)), c).forEach((share, k) => {
      own[k].amount = (cents(own[k].amount) - share) / 100;
      own[k].gapCents = (own[k].gapCents ?? 0) + share;
    });
  }
  receipt.taxGap = { cents: gap, codes: fixes.map(([g]) => g.code) };
  return receipt.taxGap;
}

/** The item a discount line is about (see foldDiscounts), or null. `before` = items already kept, `after` = items still to come. */
function discountTarget(line, before, after) {
  const codes = itemCodes(line.description);
  const positive = (list) => list.filter((it) => cents(it.amount) > 0);
  if (WHOLE_RECEIPT.test(line.description) && codes.length === 0) return null;
  // A coupon line of only item numbers ("0000390146 /1111161") while no item keeps its number (the reader drops SKUs): the item before it.
  // Only that shape (not a deposit, voucher barcode or card number), and not onto an item with another tax code.
  if (codes.length > 0 && NUMBER_REF.test(line.description.trim()) && ![...before, ...after].some((it) => cents(it.amount) > 0 && itemCodes(it.description).length)) {
    const target = positive(before).at(-1) ?? null;
    return target && line.tax_code && target.tax_code && line.tax_code.toLowerCase() !== target.tax_code.toLowerCase() ? null : target;
  }
  if (codes.length === 0) return DISCOUNT_WORDS.test(line.description) ? positive(before).at(-1) ?? null : null;
  const has = (it) => codes.some((c) => String(it.description).includes(c));
  return positive(before).filter(has).at(-1) ?? positive(after).find(has) ?? null;
}

/** True when the printed lines hold two codes that differ only in case ("t" and "T"): only then is case a signal. */
const caseMatters = (lines) => lines.some((a) => a.code && lines.some((b) => b.code && a.code !== b.code && a.code.toLowerCase() === b.code.toLowerCase()));

/** The printed tax lines as one entry per code: Map code (or null) -> { code, rate, base, amount } with money in cents. */
function mergeLines(taxLines) {
  const merged = new Map();
  for (const l of taxLines) {
    const key = l.code ?? null;
    const m = merged.get(key);
    const base = l.base == null ? null : cents(l.base);
    if (m) { m.amount += cents(l.amount); m.rate = null; m.base = m.base == null || base == null ? null : m.base + base; } else merged.set(key, { code: key, rate: l.rate ?? null, base, amount: cents(l.amount) });
  }
  return merged;
}

/**
 * Which item code belongs to which printed tax line, as a Map item code -> line code, or null when a line that printed
 * its taxed base ("t 20.96 @ 5.500% = 1.15") sits on items that don't net to it (2 cents). Codes match ignoring case
 * ("S" and "s": the reader may misread a case), unless the lines themselves hold two codes that differ only in case: then
 * exactly. Then, for the lines and item codes still unmatched, by arithmetic: a line fits a code when the code's net
 * equals the line's base (2 cents) or, with no base, when the line's amount is its printed rate of that net (see rateFits).
 * Items without a code count as one more candidate, so a line that fits them too is ambiguous. Taken only when every open
 * line fits exactly one code and no code fits two lines; otherwise those lines stay unmatched. A code that has a line
 * (even a 0 one) is never matched by arithmetic.
 * With `gap` (see fixTaxGap) the items are known to be off, so no base is checked and the numbers can't pair anything: only
 * the one line and the one item code left over are paired.
 */
function matchCodes(lines, items, gap = false) {
  const lower = (s) => s.toLowerCase();
  const coded = lines.filter((l) => l.code);
  const same = caseMatters(lines) ? (a, b) => a === b : (a, b) => lower(a) === lower(b);
  const map = new Map(); // item code -> line code
  for (const c of new Set(items.map((it) => it.tax_code).filter(Boolean))) {
    const l = coded.find((x) => same(x.code, c));
    if (l) map.set(c, l.code);
  }
  const net = (pick) => items.reduce((n, it) => n + (pick(it) ? cents(it.amount) : 0), 0);
  const live = coded.filter((l) => l.amount > 0);
  for (const l of live) {
    if (!gap && l.base != null && [...map.values()].includes(l.code) && Math.abs(l.base - net((it) => map.get(it.tax_code) === l.code)) > 2) return null;
  }
  const open = live.filter((l) => ![...map.values()].includes(l.code));
  if (!open.length) return map;
  if (gap) {
    const left = [...new Set(items.filter((it) => cents(it.amount) > 0 && it.tax_code && !map.has(it.tax_code)).map((it) => it.tax_code))];
    if (open.length === 1 && left.length === 1 && !coded.some((l) => same(l.code, left[0]))) map.set(left[0], open[0].code);
    return map;
  }
  const positive = items.filter((it) => cents(it.amount) > 0);
  const groups = [...new Set(positive.map((it) => it.tax_code || null))].filter((g) => g === null || (!map.has(g) && !coded.some((l) => same(l.code, g))));
  const fits = (l, g) => (l.base != null ? Math.abs(l.base - net((it) => (it.tax_code || null) === g)) <= 2 : rateFits(l.rate, l.amount, net((it) => (it.tax_code || null) === g)));
  const pairs = open.map((l) => groups.filter((g) => fits(l, g)));
  if (pairs.some((p) => p.length !== 1 || p[0] === null) || new Set(pairs.map((p) => p[0])).size !== open.length) return map;
  open.forEach((l, i) => map.set(pairs[i][0], l.code));
  return map;
}

/** A line's printed rate (percent, or a fraction) gives its amount from the base within max(3 cents, 5%); false without a rate. */
const rateFits = (rate, amount, base) => rate != null && [rate, rate * 100].some((pct) => Math.abs(amount - (pct / 100) * base) <= Math.max(3, 0.05 * amount));

/** The printed tax lines as one entry per code, without a "TOTAL TAX" line or a 0 line no item carries; null when none are left. */
function tidyTaxLines(receipt, taxCents) {
  if (!Array.isArray(receipt.tax_lines) || !receipt.tax_lines.length) return null;
  const merged = mergeLines(receipt.tax_lines);
  let lines = [...merged.values()];
  const coded = lines.filter((l) => l.code);
  if (merged.has(null) && coded.length && merged.get(null).amount === taxCents && Math.abs(coded.reduce((n, l) => n + l.amount, 0) - taxCents) <= 1) {
    lines = coded;
  }
  const sameCode = caseMatters(lines) ? (a, b) => a === b : (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const carried = (c) => receipt.items.some((it) => cents(it.amount) > 0 && sameCode(it.tax_code, c));
  lines = lines.filter((l) => l.amount > 0 || !l.code || carried(l.code));
  return lines.length ? lines : null;
}

/**
 * How to spread the printed tax over the categories by the items the receipt marks as taxed, or null to spread it in
 * proportion to the amounts. Needs TAX_BY_ITEM, a printed tax, a yes or no for every purchased line (not needed
 * when per-rate lines decide), at least one taxed item, and a receipt that adds up: items = subtotal (2 cents),
 * subtotal + tax + tip = total (1 cent). A reading saved before the flags existed has none, so it never qualifies.
 *
 * Printed tax lines (receipt.tax_lines, each {code, rate in percent, amount}) are tidied first: lines with the same
 * code are added up (case matters: "t" and "T" are two codes), a code-less line equal to the whole tax (a "TOTAL TAX" line) is dropped when the others make up
 * the tax, and a zero line no item carries is dropped. An item whose code matches a line is taxed when that line's
 * amount is above 0; a line code that no item carries is matched to an item code (matchCodes: ignoring case unless the
 * lines hold "t" and "T", else by the taxed amount or printed rate). With printed per-rate lines (any line with a code) that
 * is the only signal: a code with a line amount of 0, with no line, or no code is untaxed, and the reader's yes or no is
 * ignored. Codes are never interpreted
 * (what a letter means differs by store and state), only matched to the receipt's own lines. Without coded lines
 * (a single "TAX 2.68", or none) the reader's yes or no is the only signal.
 * - The taxed items carry one code at most (or the lines have no codes): the whole tax is spread over the taxed items;
 *   the lines are not needed, so a misread line can't hurt a receipt that adds up.
 * - Two or more codes (two rates): needs lines that sum to the tax within 1 cent, a code on every line, each taxed
 *   item matching a line, and each line spread over the items with its code. Otherwise null.
 * In both cases the rate (tax over its taxed items' amounts) must be above 0 and up to TAX_BY_ITEM_MAX_RATE (12%); a line
 * with a printed rate must also match it (percent or fraction) within max(3 cents, 5%).
 * A category whose taxed items net negative (a coupon bigger than its items) counts as 0 taxed.
 * Returns { taxCents, taxed, shares: per-category tax in cents, byRate: [{code, amount, base, rate}] or null, single?: { code, rate } }
 * (single: the one taxed code, in the one-code case), in the order of `nets`.
 */
function taxPlan(receipt, nets, targetCents) {
  if (!config.taxByItem || receipt.tax == null) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const taxCents = cents(receipt.tax);
  const lines = tidyTaxLines(receipt, taxCents);
  const codeMap = lines ? matchCodes(lines, receipt.items) : new Map();
  if (!codeMap) return null; // a printed base that the matched items don't have: the codes sit on the wrong items
  const codeOf = (c) => codeMap.get(c) ?? c; // an item code as the line code it belongs to
  const lineAmount = new Map((lines ?? []).filter((l) => l.code).map((l) => [l.code, l.amount]));
  const perRate = lineAmount.size > 0;
  const isTaxed = (it) => (perRate ? Boolean(it.tax_code) && (lineAmount.get(codeOf(it.tax_code)) ?? 0) > 0 : it.taxable === true);
  const purchased = receipt.items.filter((it) => cents(it.amount) > 0);
  if (!purchased.length || (!perRate && !purchased.every((it) => typeof it.taxable === 'boolean'))) return null;
  // A receipt that doesn't add up has a misread amount somewhere, so the tax can't be pinned on items.
  const itemsCents = receipt.items.reduce((n, it) => n + cents(it.amount), 0);
  if (receipt.subtotal == null || Math.abs(itemsCents - cents(receipt.subtotal)) > 2) return null;
  if (Math.abs(cents(receipt.subtotal) + taxCents + cents(receipt.tip ?? 0) - cents(receipt.total)) > 1) return null;
  if (!(taxCents > 0) || targetCents - taxCents <= 0) return null;
  const basesOf = (pick) => nets.map(([, e]) => Math.max(0, e.refs.reduce((n, r) => n + (r && pick(r) ? cents(r.amount) : 0), 0)));
  const rateOk = (amount, base) => base > 0 && amount / base <= config.taxByItemMaxRate;
  const taxedCodes = new Set(receipt.items.filter((it) => cents(it.amount) > 0 && isTaxed(it) && it.tax_code).map((it) => codeOf(it.tax_code)));
  if (taxedCodes.size <= 1) {
    // A printed line with tax that no taxed item belongs to: its tax would land on the other line's items.
    if (perRate && lines.some((l) => l.code && l.amount > 0 && !taxedCodes.has(l.code))) return null;
    const taxed = basesOf(isTaxed);
    if (!rateOk(taxCents, sum(taxed))) return null;
    // The one matched line, when it prints a rate, must fit the items (its base was checked in matchCodes).
    const only = lines?.find((l) => taxedCodes.has(l.code));
    if (only && only.rate != null && !rateFits(only.rate, only.amount, sum(taxed))) return null;
    const code = only?.code ?? [...taxedCodes][0] ?? null;
    return { taxCents, taxed, shares: apportion(taxed, taxCents), byRate: null, single: { code, rate: only?.rate ?? null } };
  }
  // Two or more rates: only the printed lines can say which tax belongs to which items.
  if (!lines || lines.some((l) => !l.code) || Math.abs(sum(lines.map((l) => l.amount)) - taxCents) > 1) return null;
  const amounts = lines.map((l) => l.amount);
  amounts[amounts.indexOf(Math.max(...amounts))] += taxCents - sum(amounts); // a cent of rounding goes to the biggest line
  const shares = nets.map(() => 0);
  const byRate = [];
  for (const [i, line] of lines.entries()) {
    if (amounts[i] === 0) continue;
    const bases = basesOf((r) => codeOf(r.tax_code) === line.code);
    const base = sum(bases);
    if (!rateOk(amounts[i], base)) return null;
    // The printed rate (percent, or a fraction) must fit the items: otherwise the codes sit on the wrong items.
    if (line.rate != null && !rateFits(line.rate, amounts[i], base)) return null;
    apportion(bases, amounts[i]).forEach((c, k) => { shares[k] += c; });
    byRate.push({ code: line.code, amount: amounts[i], base, rate: line.rate ?? null });
  }
  return { taxCents, taxed: shares, shares, byRate };
}

/** Tax-included prices (EU VAT), see allocate. */
function isTaxIncluded(receipt, itemsSum) {
  return receipt.subtotal != null && receipt.tax != null && cents(receipt.tax) > 0
    && Math.abs(itemsSum - cents(receipt.total)) <= drift(cents(receipt.total))
    && Math.abs(cents(receipt.subtotal) + cents(receipt.tax) + cents(receipt.tip ?? 0) - cents(receipt.total)) <= 1
    && Math.abs(itemsSum - cents(receipt.subtotal)) > drift(cents(receipt.subtotal));
}

/** A printed rate as a percent (it may be a fraction), else the rate the amount works out to; 3 decimals. */
function ratePercent(printed, amount, base) {
  const fit = printed != null ? [printed, printed * 100].find((pct) => Math.abs(amount - (pct / 100) * base) <= Math.max(3, 0.05 * amount)) : undefined;
  return Math.round((fit ?? (base > 0 ? (amount / base) * 100 : 0)) * 1000) / 1000;
}

/**
 * How the tax was (or would be) spread, from a taxPlan result: { how: 'by-rate' | 'by-item' | 'proportional', lines: [{code, rate, base, amount}], reason },
 * money as 2-decimal strings, rate in percent. null when there is no tax to explain or TAX_BY_ITEM is off.
 * `why` names the reason for a proportional spread when the caller knows it (otherwise it is worked out from the receipt).
 */
export function describeTax(receipt, plan, why = null) {
  if (!config.taxByItem || receipt?.tax == null || !(cents(receipt.tax) > 0)) return null;
  const line = (code, rate, base, amount) => ({ code, rate: ratePercent(rate, amount / 100, base / 100), base: money(base), amount: money(amount) });
  if (plan?.byRate) return { how: 'by-rate', lines: plan.byRate.map((l) => line(l.code, l.rate, l.base, l.amount)), reason: null };
  if (plan) {
    const base = plan.taxed.reduce((n, c) => n + c, 0);
    return { how: 'by-item', lines: [line(plan.single?.code ?? null, plan.single?.rate ?? null, base, plan.taxCents)], reason: null };
  }
  return { how: 'proportional', lines: [], reason: why ?? proportionalReason(receipt) };
}

function proportionalReason(receipt) {
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  const itemsCents = items.reduce((n, it) => n + cents(it.amount), 0);
  const taxCents = cents(receipt.tax);
  if (receipt.subtotal == null || Math.abs(itemsCents - cents(receipt.subtotal)) > 2) return "the items don't add up to the subtotal";
  if (Math.abs(cents(receipt.subtotal) + taxCents + cents(receipt.tip ?? 0) - cents(receipt.total)) > 1) return "the subtotal, tax and tip don't add up to the total";
  const perRate = Array.isArray(receipt.tax_lines) && receipt.tax_lines.some((l) => l?.code);
  const marked = items.some((it) => it.taxable === true || (perRate && it.tax_code));
  if (!marked && !items.every((it) => cents(it.amount) <= 0 || typeof it.taxable === 'boolean')) return 'no tax marks';
  if (!marked) return 'no item is marked as taxed';
  return "the tax marks don't fit the receipt's tax lines or a believable rate";
}

/**
 * Explain from the receipt alone (for a summary saved without the field): runs taxPlan with all items as one group,
 * since only the per-rate split matters. Same shape as describeTax; null when nothing applies. No Actual calls.
 */
export function explainTax(receipt) {
  try {
    if (!receipt || !Array.isArray(receipt.items) || !receipt.items.length || receipt.tax == null || !config.taxByItem) return null;
    const itemsSum = receipt.items.reduce((n, it) => n + cents(it.amount), 0);
    if (itemsSum <= 0) return null;
    const target = Number.isFinite(cents(receipt.total)) ? cents(receipt.total) : itemsSum + cents(receipt.tax);
    const included = isTaxIncluded(receipt, itemsSum);
    const plan = included ? null : taxPlan(receipt, [['all', { cents: itemsSum, refs: receipt.items }]], target);
    return describeTax(receipt, plan, included ? 'the prices already include the tax' : null);
  } catch {
    return null;
  }
}

/**
 * The cents each category gets of targetCents. By default in proportion to the nets. With a taxPlan, the printed tax goes
 * to the categories of the taxed items (in proportion to their taxed amounts) and everything else (the items, tip,
 * rounding) in proportion to the nets, so untaxed groceries don't pay tax on taxed household goods. Both parts are
 * apportioned exactly, so the shares always add up to targetCents.
 */
function shareOut(nets, targetCents, plan) {
  const weights = nets.map(([, e]) => e.cents);
  if (!plan) return apportion(weights, targetCents);
  const base = apportion(weights, targetCents - plan.taxCents);
  return base.map((c, i) => c + plan.shares[i]);
}

/**
 * Split the bank transaction's amount (targetCents) across the receipt's categories.
 * Each category's share is its net line items (returns and coupons count negative); tax, tip, rounding and
 * receipt-level discounts are spread over the categories in proportion to those nets (tax only over the taxed items
 * when the reader marked them and the rate is believable, see taxPlan), so the split always adds up
 * exactly to what the bank charged. A category whose net is negative (a returned shirt, a coupon bigger than the
 * item it's for) becomes a credit part with a negative amount, an inflow split line, and the positive parts grow
 * to match; that adds a problem so the receipt gets reviewed.
 * Returns { allocation: [{label, categoryId, cents, items}] (largest first) or null, problems: [string] }.
 */
export function allocate(receipt, labelToId, targetCents, { gapLabel = UNCATEGORIZED } = {}) {
  const problems = [];
  const byLabel = new Map();
  const add = (label, amountCents, text, ref = null) => {
    const entry = byLabel.get(label) ?? { cents: 0, items: [], refs: [] };
    entry.cents += amountCents;
    entry.items.push(text);
    entry.refs.push(ref); // the receipt item behind each text (null for money not read), for the learning snapshot
    byLabel.set(label, entry);
  };
  for (const item of receipt.items) {
    let text = item.plain && item.plain.toLowerCase() !== item.description.toLowerCase() ? `${item.description} (${item.plain})` : item.description;
    if (item.discountCents) text += ` (pipeline: after ${money(item.discountCents)} off)`; // see foldDiscounts
    if (item.unsureGuess) text += ` (maybe ${item.unsureGuess})`;
    add(item.category ?? UNCATEGORIZED, cents(item.amount), text, item); // null: an invalid decider answer nobody placed
  }
  const itemsSum = [...byLabel.values()].reduce((a, e) => a + e.cents, 0);
  if (itemsSum <= 0) return { allocation: null, problems: ['line items add up to zero or less'] };

  // Tax-included prices (EU VAT): the items add up to the total, and the printed subtotal is the net amount (subtotal + tax = total).
  // The prices already carry the tax, so nothing is misread, no tax goes on top and the tax-by-item spread does not apply.
  const taxIncluded = isTaxIncluded(receipt, itemsSum);
  if (receipt.subtotal != null && !taxIncluded) {
    const subtotal = cents(receipt.subtotal);
    if (Math.abs(itemsSum - subtotal) > drift(subtotal)) {
      problems.push(`line items add up to ${money(itemsSum)} but the printed subtotal is ${money(subtotal)}; an item was probably misread or missed`);
      // Money the reader missed goes to the store's usual category, or stays uncategorized, rather than being
      // spread over the items that were read.
      if (subtotal > itemsSum) add(gapLabel, subtotal - itemsSum, `${money(subtotal - itemsSum)} ${NOT_READ}`);
    }
  } else if (Math.abs(cents(receipt.total) - itemsSum) > FAR_FROM_TOTAL * cents(receipt.total)) {
    problems.push(`line items (${money(itemsSum)}) are far from the printed total (${money(cents(receipt.total))})`);
  }

  // Categories that net to exactly zero (an item and its own refund) have nothing to split.
  const nets = [...byLabel].filter(([, e]) => e.cents !== 0);
  if (!nets.some(([, e]) => e.cents > 0) || nets.reduce((a, [, e]) => a + e.cents, 0) <= 0) {
    return { allocation: null, problems: [...problems, 'returns and coupons cancel out the purchases'] };
  }
  // The unread-money part (a subtotal mismatch) means the item list is incomplete, so the tax can't be pinned on items.
  const unread = problems.length > 0; // decided here, before the credit and tax-gap problems below are added
  const plan = problems.length === 0 && !taxIncluded ? taxPlan(receipt, nets, targetCents) : null;
  if (receipt.taxGap) {
    const { cents: g, codes } = receipt.taxGap;
    problems.push(`line items were ${money(g)} over the printed subtotal; the difference was put on the items taxed at ${codes.join(', ')} (from the receipt's tax lines)`);
  }
  const shares = shareOut(nets, targetCents, plan);
  const allocation = nets
    .map(([label, e], i) => ({ label, categoryId: label === UNCATEGORIZED ? null : labelToId.get(label) ?? null, cents: shares[i], items: e.items, refs: e.refs }))
    .sort((a, b) => b.cents - a.cents);
  for (const a of allocation) {
    if (a.cents < 0) problems.push(`includes a credit of ${money(-a.cents)} in "${a.label}" (a return or coupon)`);
  }
  const why = taxIncluded ? 'the prices already include the tax' : unread ? "the items don't add up to the subtotal" : null;
  return { allocation, problems, taxByItem: Boolean(plan), taxByRate: plan?.byRate ?? null, taxExplained: describeTax(receipt, plan, why) };
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
      const moved = part.items.map((t, i) => ({ t, ref: part.refs?.[i] ?? null }));
      const carried = intoUncategorized ? moved : moved.filter((m) => !isUnsureNote(m.t));
      const items = intoUncategorized
        ? carried.map((m) => (isUnsureNote(m.t) ? m.t : `${m.t} (${shortName(part.label)})`))
        : carried.map((m) => stripGuess(m.t));
      home.refs = [...(home.refs ?? home.items.map(() => null)), ...carried.map((m) => m.ref)];
      home.items = [...home.items, ...items];
    } else {
      kept.push(part);
    }
  }
  return kept.sort((a, b) => b.cents - a.cents);
}

/** mergeSmallParts with the SPLIT_MIN_CENTS setting: what the worker (receipt.js) and the receipt page's category fix (receipt-fix.js) both use. */
export const mergeParts = (allocation, preferCategoryId) => mergeSmallParts(allocation, config.splitMinCents, preferCategoryId);

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

/** The key that says two notes are the same part: the note without the worker's annotations (or as it is). */
export const partKey = (note) => stripAnnotations(note) ?? note ?? '';

const CUT_NOTE = new RegExp(`(?:${[' (pipeline:', ' (maybe'].flatMap((w) => Array.from({ length: w.length - 1 }, (_, i) => w.slice(0, i + 2).replace(/[()]/g, '\\$&'))).join('|')})$`);

/**
 * A split part's note without the pipeline's notes on unsure money ("MED-DVD'S (maybe Child 34%)",
 * "4.12 not read from the receipt"): those are guesses, not examples to learn from. Null if nothing is left.
 */
export function stripAnnotations(notes) {
  if (!notes) return null;
  const out = notes
    .replace(/ \(pipeline: [^)]*(?:\)|$)/g, '') // a discount folded into the item (foldDiscounts), also when the note was cut off inside it
    .replace(/ \(maybe [^)]*(?:\)|$)/g, '') // also when the note was cut off at 200 characters
    .replace(/ \(store default(?:\)|$)/g, '') // items the store's category got only by default (see STORE_DEFAULT)
    .replace(CUT_NOTE, '') // a note cut off right after its start, e.g. "BREAD (pi"
    .replace(/(?:^|,\s*)-?\d+(?:\.\d+)? not read from the receipt/g, '')
    .replace(/\s*#(?:always|usually)\b[^,;|(\n#]*/gi, ' ') // the keyword tags (see keywords.js)
    .replace(/\s+([,;|])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .replace(/^[\s,|;]+|[\s,|;]+$/g, '')
    .trim();
  return out || null;
}
