// The status page's receipt view: where a receipt's file is now, the photo as something a browser can show, and what was read.
// The request only names a state key; the file path always comes from the worker's own state entry, never from the request.
// deps (tests pass stand-ins): nextcloud { statPath, downloadPath, readSummary }, prepare (image.js prepareImages).
import path from 'node:path/posix';
import { config } from './config.js';
import { loadState, parseStateKey } from './state.js';
import { prepareImages } from './image.js';
import { readDrySummary } from './dry-summaries.js';

const MAX_ID = 2000;
const MAX_FILE = 40 * 1024 * 1024; // a bigger file is not downloaded at all
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 6;
const MAX_BUSY = 2; // downloads/conversions at once
const MAX_QUEUE = 8; // waiting behind them; more than that is "busy"

class NotThere extends Error {}
class Unreadable extends Error {}
class TooBig extends Error {}
class Busy extends Error {}

/** Folder names as nextcloud.js uses them may lack the leading slash (RECEIPTS_INBOX=Receipts/Inbox). */
const slash = (f) => `/${String(f).replace(/^\/+|\/+$/g, '')}`;
/** Is p inside folder (no .. tricks)? */
const inside = (p, folder) => typeof p === 'string' && !p.split('/').includes('..') && p.startsWith(`${slash(folder)}/`);

/** Where this entry's file is now: its filed path (Processed / Needs review), or its inbox path. null if neither is a place we know. */
export function locate(id, entry) {
  const nc = config.nextcloud;
  if (entry.filedAs) return [nc.processed, nc.review].some((f) => inside(entry.filedAs, f)) ? entry.filedAs : null;
  const inbox = parseStateKey(id).file;
  return inside(inbox, nc.inbox) ? inbox : null;
}

async function entryFor(id) {
  if (typeof id !== 'string' || !id || id.length > MAX_ID) return null;
  const state = await loadState();
  return Object.hasOwn(state, id) ? state[id] : null;
}

const defaults = async (deps) => ({ nextcloud: deps.nextcloud ?? (await import('./nextcloud.js')), prepare: deps.prepare ?? prepareImages });
const gone = (err) => err instanceof NotThere || err?.status === 404 || err?.code === 'ENOENT';

// At most MAX_BUSY downloads/conversions run at once; a few more wait; beyond that the answer is "busy".
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_BUSY) {
    if (waiting.length >= MAX_QUEUE) throw new Busy();
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot on
    else running--;
  }
}

/** Stat first: a missing file is NotThere, a huge one TooBig, before any bytes are downloaded. Returns { etag, size }. */
async function check(file, d) {
  let st;
  try {
    st = await d.nextcloud.statPath(file);
  } catch (err) {
    if (gone(err)) throw new NotThere();
    throw err;
  }
  if (st.size > MAX_FILE) throw new TooBig();
  return st;
}

async function download(file, d) {
  try {
    return await d.nextcloud.downloadPath(file);
  } catch (err) {
    if (gone(err)) throw new NotThere();
    throw err;
  }
}

async function convert(file, d) {
  const buf = await download(file, d);
  try {
    const uris = await d.prepare(buf, path.basename(file), config.maxImageSide, { fitPdf: true });
    return { pages: uris.map((u) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')) };
  } catch (err) {
    throw new Unreadable(err.message);
  }
}

// Pages already made for a file, so a PDF isn't converted again for each <img> (kept a few minutes, in memory only).
// Keyed by the state id, the path and the file's etag, so a replaced file is never shown from the old copy.
const cache = new Map();
let sweeper = null;
export const clearPhotoCache = () => cache.clear();
function sweep() {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  if (!cache.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

async function pagesOf(id, file, d) {
  const st = await check(file, d);
  const k = `${id}\n${file}\n${st.etag ?? `${st.size}/${st.lastmod ?? ''}`}`;
  let hit = cache.get(k);
  if (!hit) {
    hit = { at: Date.now(), promise: limited(() => convert(file, d)) };
    cache.set(k, hit);
    hit.promise.catch(() => cache.delete(k));
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    sweeper ??= setInterval(sweep, 60000).unref(); // frees expired entries even when nobody asks again
  }
  return hit.promise;
}

const SAFE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const text = (code, msg) => ({ code, headers: { ...SAFE, 'Content-Type': 'text/plain; charset=utf-8' }, body: `${msg}\n` });
const NOT_FOUND = 'No such receipt here (it may have been removed from the list).';
const WHY = {
  NotThere: 'The file is no longer in Nextcloud (it may have been moved or deleted by hand).',
  TooBig: 'That file is too large to show here.',
  Busy: 'The panel is busy with other photos. Try again in a moment.',
  Unreadable: 'The photo could not be turned into a picture.',
};
const why = (err) => WHY[err?.constructor?.name] ?? (gone(err) ? WHY.NotThere : 'Nextcloud can\'t be reached right now. Try again in a minute.');
const codeOf = (err) => (gone(err) ? 404 : err instanceof TooBig ? 413 : err instanceof Busy ? 503 : err instanceof Unreadable ? 500 : 503);

/** GET /receipt-photo: { code, headers, body }. page is 1-based; raw=true sends the original PDF (as a download) instead of a picture. */
export async function receiptPhoto(id, { page = 1, raw = false } = {}, deps = {}) {
  const entry = await entryFor(id);
  const file = entry && locate(id, entry);
  if (!file) return text(404, NOT_FOUND);
  const d = await defaults(deps);
  try {
    if (raw) {
      if (!/\.pdf$/i.test(file)) return text(404, 'There is no PDF for this receipt.');
      await check(file, d);
      const body = await limited(() => download(file, d));
      return { code: 200, headers: { ...SAFE, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="receipt.pdf"', 'Content-Security-Policy': 'sandbox; default-src \'none\'' }, body };
    }
    const out = await pagesOf(id, file, d);
    if (!Number.isInteger(page) || page < 1 || page > out.pages.length) return text(404, 'No such page.');
    return { code: 200, headers: { ...SAFE, 'Content-Disposition': 'inline', 'Content-Type': 'image/jpeg' }, body: out.pages[page - 1] };
  } catch (err) {
    return text(codeOf(err), why(err));
  }
}

/** The data for the detail page, or { code, message } when there is nothing to show. */
export async function receiptView(id, deps = {}) {
  const entry = await entryFor(id);
  if (!entry) return { code: 404, message: NOT_FOUND };
  const file = locate(id, entry);
  const d = await defaults(deps);
  const view = { id, name: parseStateKey(id).file.split('/').pop(), entry, file, pages: 0, pdf: /\.pdf$/i.test(parseStateKey(id).file), photoNote: '', summaryNote: '', summary: entry.summary ?? null };
  if (!file) {
    view.photoNote = 'This entry has no file location the panel can use.';
    return view;
  }
  try {
    view.pages = (await pagesOf(id, file, d)).pages.length;
  } catch (err) {
    view.photoNote = why(err);
  }
  // The summary filed next to the receipt says what was read and decided (no model is called).
  if (!view.summary && entry.filedAs) {
    try {
      view.summary = await d.nextcloud.readSummary(entry.filedAs);
    } catch {
      view.summaryNote = 'Couldn\'t load the summary (Nextcloud unreachable).';
    }
  }
  // In dry run nothing is filed; the worker keeps a slim copy of the summary beside its state file.
  if (!view.summary && parseStateKey(id).dry) view.summary = await readDrySummary(id);
  return view;
}
