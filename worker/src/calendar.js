// Occasions near a purchase date (birthdays, US holidays): a hint for the categorizer that an item or a meal may
// be a gift. Two sources:
//   - US holidays that people buy gifts or occasion meals for, computed here (no network)
//   - only if you turn it on (OCCASIONS_CALENDAR=true; off by default): all-day birthday, anniversary and holiday
//     events from your Nextcloud calendars (CalDAV, read-only), e.g. the "Contact birthdays" calendar
// A purchase counts as near an occasion from OCCASION_DAYS_BEFORE days before it to OCCASION_DAYS_AFTER days after.
// Calendar errors never block a receipt: the holidays are still used.
import { config, log } from './config.js';
import { DAY, dayDiff, isoDay } from './dates.js';

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
/** The n-th (1-based; -1 = last) given weekday (0 = Sunday) of a month. */
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = utc(y, m, 1);
    return utc(y, m, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = utc(y, m + 1, 0);
  return utc(y, m, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}
/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return utc(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}
export function usHolidays(y) {
  return [
    ["Valentine's Day", utc(y, 2, 14)],
    ['Easter', easter(y)],
    ["Mother's Day", nthWeekday(y, 5, 0, 2)],
    ["Father's Day", nthWeekday(y, 6, 0, 3)],
    ['Halloween', utc(y, 10, 31)],
    ['Thanksgiving', nthWeekday(y, 11, 4, 4)],
    ['Christmas', utc(y, 12, 25)],
  ].map(([name, date]) => ({ name, date: isoDay(date), source: 'US holiday', builtin: true }));
}

// --- Nextcloud CalDAV (read-only) ---
const nc = config.nextcloud;
const auth = () => `Basic ${Buffer.from(`${nc.user}:${nc.password}`).toString('base64')}`;
let calendars = null; // [{ href, name }], looked up once
let warned = false;

async function dav(method, url, body, depth) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth(), 'Content-Type': 'application/xml; charset=utf-8', Depth: depth },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok && res.status !== 207) throw new Error(`CalDAV ${method} HTTP ${res.status}`);
  return res.text();
}
const unxml = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

async function listCalendars() {
  const base = `${nc.url}/remote.php/dav/calendars/${encodeURIComponent(nc.user)}/`;
  const xml = await dav('PROPFIND', base, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>', '1');
  const out = [];
  for (const resp of xml.split(/<d:response>/i).slice(1)) {
    if (!/<cal:calendar\s*\/>|<c:calendar\s*\/>|calendar xmlns/i.test(resp) || /comp name="VTODO"/i.test(resp) && !/comp name="VEVENT"/i.test(resp)) continue;
    const href = /<d:href>([^<]+)<\/d:href>/i.exec(resp)?.[1];
    if (!href || /\/(inbox|outbox|trashbin)\/?$/.test(href)) continue;
    out.push({ href: new URL(href, nc.url).toString(), name: unxml(/<d:displayname>([^<]*)<\/d:displayname>/i.exec(resp)?.[1] ?? '') });
  }
  if (config.occasions.calendars.length) return out.filter((c) => config.occasions.calendars.includes(c.name));
  return out;
}

// Without OCCASIONS_CALENDARS, only occasions count: events in a birthday or holiday calendar (Nextcloud's
// "Contact birthdays", a holidays calendar), or events named like one anywhere. Bills, paydays and days off don't.
const OCCASION_CALENDAR = /birthday|holiday/i;
const OCCASION_EVENT = /birthday|anniversary|\bbday\b|🎂|💍|🎁/iu;
function isOccasion(calName, summary) {
  return config.occasions.calendars.length > 0 || OCCASION_CALENDAR.test(calName) || OCCASION_EVENT.test(summary);
}

const icalDate = (d) => `${isoDay(d).replace(/-/g, '')}T000000Z`;
/** All-day events (recurring ones expanded by the server) between two dates: [{ name, date, source }]. */
async function calendarEvents(start, end) {
  calendars ??= await listCalendars();
  const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data><c:expand start="${icalDate(start)}" end="${icalDate(end)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icalDate(start)}" end="${icalDate(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const events = [];
  for (const cal of calendars) {
    const xml = unxml(await dav('REPORT', cal.href, body, '1')).replace(/\r?\n[ \t]/g, ''); // unfold iCal lines
    for (const ev of xml.split('BEGIN:VEVENT').slice(1)) {
      const date = /\nDTSTART;VALUE=DATE:(\d{4})(\d\d)(\d\d)/.exec(ev);
      if (!date) continue; // timed events (appointments) aren't occasions
      const name = /\nSUMMARY[^:\n]*:([^\r\n]+)/.exec(ev)?.[1]?.replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
      if (name && isOccasion(cal.name, name)) events.push({ name, date: `${date[1]}-${date[2]}-${date[3]}`, source: cal.name || 'calendar' });
    }
  }
  return events;
}

/**
 * Occasions from OCCASION_DAYS_AFTER days before the purchase to OCCASION_DAYS_BEFORE days after it, nearest first:
 * [{ name, source, builtin, when, text }]. `text` is the short string for the categorizer: "Father's Day (US holiday)
 * on 2026-06-21, 3 days after the purchase". `builtin` is true only for the holiday list above (never for a calendar
 * event, whatever the calendar is called); the remote decider keeps only a built-in name (anonymize.js).
 */
export async function occasionDetails(dateIso) {
  const o = config.occasions;
  if (!o.enabled || !dateIso) return [];
  const day = Date.parse(`${dateIso}T00:00:00Z`);
  const start = new Date(day - o.daysAfter * DAY);
  const end = new Date(day + (o.daysBefore + 1) * DAY);
  let found = [start.getUTCFullYear(), end.getUTCFullYear()].filter((y, i, a) => a.indexOf(y) === i).flatMap(usHolidays);
  if (o.useCalendar) {
    try {
      found = found.concat(await calendarEvents(start, end));
    } catch (err) {
      if (!warned) log(`  calendar not read (${err.message}); using US holidays only`);
      warned = true;
    }
  }
  const seen = new Set();
  return found
    .map((e) => ({ ...e, offset: dayDiff(e.date, dateIso) }))
    .filter((e) => e.offset >= -o.daysAfter && e.offset <= o.daysBefore)
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))
    .filter((e) => !seen.has(e.name) && seen.add(e.name)) // a multi-day event (Winter Break) counts once, nearest day
    .slice(0, 5)
    .map((e) => {
      const when = e.offset === 0 ? 'the day of the purchase' : `${Math.abs(e.offset)} day(s) ${e.offset > 0 ? 'after' : 'before'} the purchase`;
      return { name: e.name, source: e.source, builtin: e.builtin === true, when, text: `${e.name} (${e.source}) on ${e.date}, ${when}` };
    });
}

/** The same occasions as short strings (see occasionDetails). */
export async function occasionsNear(dateIso) {
  return (await occasionDetails(dateIso)).map((o) => o.text);
}
