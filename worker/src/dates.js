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
 * 400 days before and `slackDays` (1: timezones) after the anchor. Returns { date | null, note }.
 */
export function resolveDate(receipt, anchorDate, { slackDays = 1 } = {}) {
  const anchor = isoDay(anchorDate);
  const candidates = [...parseCandidates(receipt.date_as_printed), ...(receipt.date ? parseCandidates(receipt.date) : [])];
  for (const c of candidates) {
    const age = dayDiff(anchor, c);
    if (age >= -slackDays && age <= 400) return { date: c, note: null };
  }
  if (candidates.length === 0) return { date: null, note: 'no purchase date on the receipt' };
  return { date: null, note: `ignored implausible date "${receipt.date_as_printed ?? receipt.date}"` };
}

// Known camera/app names only, with a time part: YYYY-MM-DD_HHMMSS, YYYY-MM-DD HH.MM.SS, YYYYMMDD_HHMMSS, at the start
// or right after IMG_ / IMG- / PXL_ / VID_ / Screenshot_ / Screenshot- / signal- / PHOTO_. A date in a document title
// ("Order_2026-10-01.pdf", "statement 2020-01-01-2026-11-01.pdf") never counts.
const TIME = '\\d{2}[.-]?\\d{2}[.-]?\\d{2}';
const PHOTO_NAME = new RegExp(`^(?:(?:IMG|PXL|VID|Screenshot|signal|PHOTO)[_-])?(?:(\\d{4})-(\\d{2})-(\\d{2})[_ -]${TIME}|(\\d{4})(\\d{2})(\\d{2})_${TIME})`, 'i');
// A photo is uploaded within about a month of being taken; an older name is more likely something else.
const PHOTO_NAME_MAX_AGE = 31;

/**
 * The day a photo was taken, read from its file name when the camera or upload app put it there
 * (2026-11-05_101530.jpg, IMG_20261105_101530.jpg, PXL_20261105_101530123.jpg, Screenshot_2026-11-05-10-15-30.png).
 * Only the calendar date (local time, like a printed date). null when there is none, it is not a real date,
 * it is after the day after `lastmod`, or it is more than 31 days before it.
 */
export function photoDateFromName(basename, lastmod, now = new Date()) {
  const m = PHOTO_NAME.exec(String(basename ?? ''));
  if (!m) return null;
  const day = m[1] ? iso(+m[1], +m[2], +m[3]) : iso(+m[4], +m[5], +m[6]);
  if (!day) return null;
  const age = dayDiff(isoDay(lastmod ?? now), day);
  if (age < -1 || age > PHOTO_NAME_MAX_AGE) return null;
  return day;
}

/**
 * The anchor every date check hangs on: the earlier of the file-name photo day and the upload (lastmod) time.
 * Returns { date: Date, fromName, slackDays, photoDay }. Anchored on the file name (photo taken before the upload day),
 * a printed date after the photo day is impossible, so no slack; the lastmod anchor keeps 1 day for timezones.
 */
export function receiptAnchor(basename, lastmod, now = new Date()) {
  const modified = lastmod instanceof Date && !Number.isNaN(lastmod.getTime()) ? lastmod : now;
  const photoDay = photoDateFromName(basename, modified, now);
  if (photoDay && photoDay < isoDay(modified)) return { date: new Date(`${photoDay}T00:00:00Z`), fromName: true, slackDays: 0, photoDay };
  return { date: modified, fromName: false, slackDays: photoDay === isoDay(modified) ? 0 : 1, photoDay };
}
