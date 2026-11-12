// Uploading receipt photos from the status page: read the multipart/form-data body, check every file (type by name AND by its first
// bytes, size), clean its name, and save it into the Nextcloud Inbox the way the Nextcloud app would. Pure except uploadToInbox, which
// gets the WebDAV client passed in so tests can use a stand-in. The files are never logged; only their names.
import path from 'node:path/posix';
import crypto from 'node:crypto';
import { SUPPORTED } from './image.js';
import { moveKeepingBoth } from './requeue.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024;
const MAX_NAME_BYTES = 150; // UTF-8 bytes, not characters: Nextcloud's limit is 255 bytes, and a time stamp and temporary prefix are added
const MAX_PART_HEADERS = 8192;

/** The boundary of a multipart/form-data Content-Type, or null. */
export function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(String(contentType ?? ''));
  return m ? (m[1] ?? m[2]) : null;
}

/** filename*=UTF-8''%E2%82%AC.pdf (RFC 5987) as text, or undefined when it is not that form. */
function decodeStar(v) {
  const m = /^utf-8'[^']*'(.*)$/i.exec(v ?? '');
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * Split a multipart/form-data body into { fields: {name: text}, files: [{ field, filename, type, data }] }. Binary-safe: a part ends only at
 * CRLF + "--" + boundary, so the boundary text inside file data is harmless unless it is preceded by a line break. Throws on a body that is not well formed.
 */
export function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const sep = Buffer.from(`\r\n--${boundary}`);
  const fields = {};
  const files = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new Error('not a multipart body');
  pos += delim.length;
  for (;;) {
    if (body.subarray(pos, pos + 2).toString() === '--') return { fields, files };
    if (body.subarray(pos, pos + 2).toString() !== '\r\n') throw new Error('malformed multipart body');
    pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos);
    if (headEnd < 0 || headEnd - pos > MAX_PART_HEADERS) throw new Error('malformed multipart body');
    const head = body.subarray(pos, headEnd).toString('utf8');
    const start = headEnd + 4;
    const end = body.indexOf(sep, start);
    if (end < 0) throw new Error('malformed multipart body');
    const disposition = /^content-disposition:[^\r\n]*$/im.exec(head)?.[0] ?? '';
    // Browsers write a quote in a name as %22 and do not escape backslashes, so a quoted value runs to the next quote.
    const unquote = (v) => (v === undefined ? v : v.replace(/%22/g, '"'));
    const name = unquote(/[;\s]name="([^"]*)"/i.exec(disposition)?.[1]);
    const star = /[;\s]filename\*=([^;\s]+)/i.exec(disposition)?.[1];
    const filename = decodeStar(star) ?? unquote(/[;\s]filename="([^"]*)"/i.exec(disposition)?.[1]) ?? (star === undefined ? undefined : ''); // a filename* that can't be decoded is still a file, without a name
    const data = body.subarray(start, end);
    if (filename !== undefined) files.push({ field: name ?? '', filename, type: /^content-type:\s*([^\r\n;]*)/im.exec(head)?.[1]?.trim() ?? '', data });
    else if (name !== undefined) fields[name] = data.toString('utf8');
    pos = end + sep.length;
  }
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);
/** Does the ftyp box name a HEIC brand, as the major brand or among the compatible brands? (A video's brands are mp4 ones.) */
function heicBrand(buf) {
  if (buf.length < 12 || buf.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  const size = Math.min(buf.readUInt32BE(0) || buf.length, buf.length, 4096);
  if (HEIC_BRANDS.has(buf.subarray(8, 12).toString('latin1'))) return true;
  for (let at = 16; at + 4 <= size; at += 4) if (HEIC_BRANDS.has(buf.subarray(at, at + 4).toString('latin1'))) return true;
  return false;
}

/** What the first bytes say a file is: 'jpeg' | 'png' | 'webp' | 'heic' | 'pdf', or null. */
export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (heicBrand(buf)) return 'heic';
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  return null;
}
const KIND_OF_EXT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', heic: 'heic', heif: 'heic', pdf: 'pdf' };

/** A safe file name for the Inbox: no path, no control or direction-changing characters, no leading dot (those are skipped as partial uploads), at most 150 bytes (no character split), extension kept. */
export function cleanName(raw) {
  const name = String(raw ?? '').split(/[\\/]/).pop().normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/^[.\s]+/, '');
  let ext = path.extname(name);
  if (Buffer.byteLength(ext) > 20) ext = '';
  let base = name.slice(0, name.length - path.extname(name).length).trim() || 'receipt';
  const chars = Array.from(base);
  while (chars.length > 1 && Buffer.byteLength(chars.join('') + ext) > MAX_NAME_BYTES) chars.pop();
  return chars.join('') + ext;
}

const EXT_OF_KIND = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic', pdf: 'pdf' };
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

/**
 * Check a file: { why } (a short sentence) when it can't be uploaded, else { name } the name to save it under. A file whose contents are
 * a different supported type than its ending says (a HEIC photo some phones name .jpg, a PNG called .jpeg) is saved under the ending
 * that fits its contents, because the worker reads a file by its ending.
 */
export function check(file) {
  if (!file.filename) return { why: 'it has no name' };
  const name = cleanName(file.filename);
  const ext = extOf(name);
  if (!SUPPORTED.test(`x.${ext}`)) return { why: 'not a receipt type (photos: JPG, PNG, WebP, HEIC; or PDF)' };
  if (file.data.length === 0) return { why: 'the file is empty' };
  if (file.data.length > MAX_FILE_BYTES) return { why: `larger than ${MAX_FILE_BYTES / 1048576} MB` };
  const kind = sniff(file.data);
  if (!kind) return { why: 'the contents are not a photo or PDF, whatever the name says' };
  if (kind === KIND_OF_EXT[ext]) return { name };
  return { name: `${name.slice(0, name.length - ext.length - 1)}.${EXT_OF_KIND[kind]}` };
}
/** Why a file can't be uploaded, or null. */
export const refusal = (file) => check(file).why ?? null;

const PUT_MS = 5 * 60 * 1000; // a 25 MB file on a slow link
const OP_MS = 30 * 1000;
const within = (ms) => ({ signal: AbortSignal.timeout(ms) });
/** The name with a time stamp before its extension (IMG_20261105_101530-1762000000000.jpg), so a camera date at the start of the name still reads. */
export const stamp = (name) => `${name.slice(0, name.length - path.extname(name).length)}-${Date.now()}${path.extname(name)}`;
const TEMP = /^\.upload-[0-9a-f-]{36}-/;

/**
 * Save one file into the inbox. It is written under a hidden temporary name (.upload-<id>-<name>, which the worker's inbox listing skips
 * because of the leading dot) and moved to its final name only when complete, so the worker never reads half a file. A taken name gets a
 * time stamp before the extension; nothing is replaced, except that a file with the very same name AND the very same bytes is not saved
 * again. Returns { as } or { duplicate: true }. `c` is the WebDAV client; every call has a timeout (a long one for the upload itself).
 */
export async function saveToInbox(c, inbox, name, data) {
  const wanted = path.join(inbox, name);
  if (await c.exists(wanted, within(OP_MS))) {
    const same = Number((await c.stat(wanted, within(OP_MS))).size) === data.length && Buffer.from(await c.getFileContents(wanted, within(PUT_MS))).equals(data);
    if (same) return { duplicate: true };
  }
  const tmp = path.join(inbox, `.upload-${crypto.randomUUID()}-${name}`);
  try {
    await c.putFileContents(tmp, data, { overwrite: false, ...within(PUT_MS) });
    const dest = (await c.exists(wanted, within(OP_MS))) ? path.join(inbox, stamp(name)) : wanted;
    const other = path.join(inbox, `${stamp(name).replace(/(\.[^.]*)?$/, `-${crypto.randomUUID().slice(0, 8)}$1`)}`);
    return { as: path.basename(await moveKeepingBoth(c, tmp, dest, other, undefined, within(OP_MS))) };
  } catch (err) {
    await c.deleteFile(tmp, within(OP_MS)).catch(() => {}); // also when the upload itself failed part way
    throw err;
  }
}

/** Old temporary files from uploads that never finished: names in the inbox listing that are ours and an hour old. */
export const staleUploads = (items, now = Date.now(), maxAgeMs = 60 * 60 * 1000) => items.filter((i) => i.type !== 'directory' && TEMP.test(i.basename) && now - Date.parse(i.lastmod) > maxAgeMs);

/**
 * Check and save the files of one request. Returns { saved: [{ from, as }], skipped: [name] (already in the Inbox), refused: [{ name, why }] }.
 * At most MAX_FILES are taken; the rest are refused. A Nextcloud failure on one file refuses that file only.
 */
export async function uploadFiles(c, inbox, files) {
  const saved = [];
  const skipped = [];
  const refused = [];
  for (const [i, file] of files.entries()) {
    const label = cleanName(file.filename || 'file');
    const verdict = i >= MAX_FILES ? { why: `too many files at once (${MAX_FILES} at most)` } : check(file);
    if (verdict.why) { refused.push({ name: label, why: verdict.why }); continue; }
    try {
      const got = await saveToInbox(c, inbox, verdict.name, file.data);
      if (got.duplicate) skipped.push(verdict.name);
      else saved.push({ from: label, as: got.as });
    } catch (err) {
      refused.push({ name: label, why: `Nextcloud would not take it (${err.message})` });
    }
  }
  return { saved, skipped, refused };
}

const short = (n) => (Array.from(n).length > 28 ? `${Array.from(n).slice(0, 27).join('')}…` : n);
const list = (items, max) => items.slice(0, max).join(', ') + (items.length > max ? ` and ${items.length - max} more` : '');
const NOTICE_MAX = 290; // the redirect clips a notice at 300 characters; what matters most comes first, so a cut loses the least
/** The notice for the page: what was refused and why first (that needs action), then what was uploaded and under what name. */
export function uploadNotice({ saved, skipped = [], refused }, dryRun) {
  if (!saved.length && !skipped.length && !refused.length) return 'No file was chosen. Nothing was uploaded.';
  const bad = refused.length ? `Not uploaded: ${list(refused.map((r) => `${short(r.name)} (${r.why})`), 3)}. ` : '';
  const same = skipped.length ? `Already in the Inbox, skipped: ${list(skipped.map(short), 3)}. ` : '';
  const ok = saved.length ? `Uploaded ${saved.length} file${saved.length === 1 ? '' : 's'} to the Inbox: ${list(saved.map((s) => (s.from === s.as ? short(s.as) : `${short(s.from)} as ${short(s.as)}`)), 3)}. The worker is reading ${saved.length === 1 ? 'it' : 'them'} now${dryRun ? ' (dry run: you will see a preview, nothing is written to Actual)' : ''}; refresh in a minute.` : 'Nothing was uploaded.';
  const all = bad + same + ok;
  return Array.from(all).length > NOTICE_MAX ? `${Array.from(all).slice(0, NOTICE_MAX - 1).join('')}…` : all;
}
