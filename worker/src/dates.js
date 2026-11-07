// Work out a receipt's purchase date without trusting the model's own conversion.
// The model copies the date as printed; we parse it here (US month/day order, as on US receipts) and keep
// it only if it's plausible relative to when the photo was uploaded. Otherwise the receipt is treated as undated.
// Also the worker's one set of day helpers (isoDay, today, shiftDay, dayDiff), used everywhere: days are YYYY-MM-DD
// strings, read as UTC midnight (no DST surprises).
export const DAY = 86400000;
/** A Date as YYYY-MM-DD (UTC). */
export const isoDay = (d) => d.toISOString().slice(0, 10);
export const today = () => isoDay(new Date());
/** A YYYY-MM-DD day moved by n days. */
export const shiftDay = (day, n) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
/** Whole days from b to a (both YYYY-MM-DD). */
export const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // e.g. 13/40
  return dt.toISOString().slice(0, 10);
};

/** Every date a printed string could mean, most likely first. */
export function parseCandidates(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const out = [];
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) out.push(iso(+m[1], +m[2], +m[3]));
  m = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s); // not the tail of an ISO date
  // US month/day. Day/month only when the first number can't be a month (31/10/26): an implausible US date like
  // "12/01/26" read in November must not quietly turn into January 12.
  if (m) out.push(+m[1] > 12 ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]));
  m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1]]) out.push(iso(+m[3], MONTHS[m[1]], +m[2]));
  m = /(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2]]) out.push(iso(+m[3], MONTHS[m[2]], +m[1]));
  return out.filter(Boolean);
}


/**
 * Pick the purchase date: the first reading (printed text first, then the model's own date) that falls between
 * 400 days before and 1 day after the upload. Returns { date | null, note }.
 */
export function resolveDate(receipt, anchorDate) {
  const anchor = isoDay(anchorDate);
  const candidates = [...parseCandidates(receipt.date_as_printed), ...(receipt.date ? parseCandidates(receipt.date) : [])];
  for (const c of candidates) {
    const age = dayDiff(anchor, c);
    if (age >= -1 && age <= 400) return { date: c, note: null };
  }
  if (candidates.length === 0) return { date: null, note: 'no purchase date on the receipt' };
  return { date: null, note: `ignored implausible date "${receipt.date_as_printed ?? receipt.date}"` };
}
