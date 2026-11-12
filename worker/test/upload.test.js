// Uploading receipts from the status page: the multipart reader, type sniffing, name cleaning, the temp-then-move save (mock WebDAV
// client), limits, and POST /upload on a real local server with a stand-in for Nextcloud. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { boundaryOf, parseMultipart, sniff, cleanName, refusal, check, saveToInbox, uploadFiles, uploadNotice, staleUploads, MAX_FILE_BYTES, MAX_FILES } from '../src/upload.js';
import { photoDateFromName } from '../src/dates.js';
import http from 'node:http';
import { makeServer } from '../src/trigger.js';
import { statusPage } from '../src/panel-status.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json') });
config.trigger.token = 'secret';
const { inbox } = config.nextcloud;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpegdata')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pngdata')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.from('....')]);
const PDF = Buffer.from('%PDF-1.4\n...');

/** A multipart body from parts [{ name, filename?, type?, data }]. */
function multipart(parts, boundary = 'XBOUNDX') {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`), Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('boundaryOf reads plain and quoted boundaries', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary=abc123'), 'abc123');
  assert.equal(boundaryOf('multipart/form-data; charset=utf-8; boundary="a b-c"'), 'a b-c');
  assert.equal(boundaryOf('application/x-www-form-urlencoded'), null);
  assert.equal(boundaryOf(undefined), null);
});

test('parseMultipart: several files, fields mixed with files, binary and CRLF data kept exactly', () => {
  const data = Buffer.concat([JPEG, Buffer.from('\r\nline two\r\n\r\n'), Buffer.from([0, 255, 13, 10])]);
  const body = multipart([{ name: 'note', data: 'hello' }, { name: 'receipts', filename: 'a.jpg', type: 'image/jpeg', data }, { name: 'other', data: 'x' }, { name: 'receipts', filename: 'b.pdf', type: 'application/pdf', data: PDF }]);
  const { fields, files } = parseMultipart(body, 'XBOUNDX');
  assert.deepEqual(fields, { note: 'hello', other: 'x' });
  assert.equal(files.length, 2);
  assert.equal(files[0].filename, 'a.jpg');
  assert.equal(files[0].type, 'image/jpeg');
  assert.ok(files[0].data.equals(data));
  assert.ok(files[1].data.equals(PDF));
});

test('parseMultipart: the boundary text inside the file data does not end the part (only after a line break would it)', () => {
  const data = Buffer.concat([JPEG, Buffer.from('--XBOUNDX and more --XBOUNDX--')]);
  const { files } = parseMultipart(multipart([{ name: 'f', filename: 'a.jpg', data }]), 'XBOUNDX');
  assert.equal(files.length, 1);
  assert.ok(files[0].data.equals(data));
});

test('parseMultipart: an empty file box (nameless, empty) and garbage', () => {
  const { files } = parseMultipart(multipart([{ name: 'receipts', filename: '', data: '' }]), 'XBOUNDX');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, '');
  assert.throws(() => parseMultipart(Buffer.from('nothing here'), 'XBOUNDX'));
  assert.throws(() => parseMultipart(Buffer.from('--XBOUNDX\r\nContent-Disposition: form-data; name="a"\r\n\r\ncut off'), 'XBOUNDX'));
});

test('parseMultipart: filename*= (RFC 5987) wins, %22 becomes a quote, a name ending in a backslash is still a file', () => {
  const b = (disposition, data = 'x') => Buffer.from(`--XBOUNDX\r\nContent-Disposition: ${disposition}\r\n\r\n${data}\r\n--XBOUNDX--\r\n`);
  assert.equal(parseMultipart(b("form-data; name=\"f\"; filename=\"fallback.jpg\"; filename*=UTF-8''%E2%82%AC%20caf%C3%A9.jpg"), 'XBOUNDX').files[0].filename, '€ café.jpg');
  assert.equal(parseMultipart(b('form-data; name="f"; filename="a%22b.jpg"'), 'XBOUNDX').files[0].filename, 'a"b.jpg');
  const back = parseMultipart(b('form-data; name="f"; filename="dir\\"'), 'XBOUNDX');
  assert.equal(back.files.length, 1);
  assert.equal(back.files[0].filename, 'dir\\');
  assert.equal(parseMultipart(b("form-data; name=\"f\"; filename*=UTF-8''%E0%A4%A"), 'XBOUNDX').files.length, 1, 'a bad escape does not throw');
});

test('sniff: HEIC by a compatible brand too (major brand not in the list)', () => {
  const box = (major, compat) => Buffer.concat([Buffer.from([0, 0, 0, 16 + compat.length * 4]), Buffer.from('ftyp'), Buffer.from(major), Buffer.from([0, 0, 0, 0]), Buffer.from(compat.join(''))]);
  assert.equal(sniff(box('isom', ['mp41', 'heic'])), 'heic');
  assert.equal(sniff(box('isom', ['mp41', 'iso2'])), null);
});

test('sniff: JPEG, PNG, WebP, HEIC (several brands), PDF; text and short files are nothing', () => {
  assert.equal(sniff(JPEG), 'jpeg');
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(WEBP), 'webp');
  assert.equal(sniff(HEIC), 'heic');
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif1')])), 'heic');
  assert.equal(sniff(PDF), 'pdf');
  assert.equal(sniff(Buffer.from('hello world, not an image')), null);
  assert.equal(sniff(Buffer.from([0xff])), null);
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42')])), null, 'a video is not a photo');
});

test('refusal: type by name and by contents, empty, too big', () => {
  const f = (filename, data) => ({ filename, data });
  assert.equal(refusal(f('a.jpg', JPEG)), null);
  assert.equal(refusal(f('A.HEIC', HEIC)), null);
  assert.equal(refusal(f('a.heif', HEIC)), null);
  assert.equal(refusal(f('a.pdf', PDF)), null);
  assert.match(refusal(f('notes.txt', Buffer.from('hi'))), /not a receipt type/);
  assert.match(refusal(f('fake.jpg', Buffer.from('this is text'))), /contents are not a photo/);
  assert.deepEqual(check(f('a.jpg', PNG)), { name: 'a.png' }, 'saved under the ending that fits its contents');
  assert.deepEqual(check(f('IMG_1.JPEG', HEIC)), { name: 'IMG_1.heic' }, 'a HEIC photo some phones name .jpg');
  assert.deepEqual(check(f('scan.jpg', PDF)), { name: 'scan.pdf' });
  assert.match(refusal(f('notes.txt', JPEG)), /not a receipt type/, 'a name that says text is still refused');
  assert.match(refusal(f('a.png', Buffer.alloc(0))), /empty/);
  assert.match(refusal(f('a.pdf', Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]))), /larger than 25 MB/);
  assert.match(refusal(f('', JPEG)), /no name/);
});

test('cleanName: no path, no leading dot, no control characters, bounded length, extension kept', () => {
  assert.equal(cleanName('../../etc/passwd.jpg'), 'passwd.jpg');
  assert.equal(cleanName('C:\\Users\\me\\scan 1.PNG'), 'scan 1.PNG');
  assert.equal(cleanName('.hidden.jpg'), 'hidden.jpg');
  assert.equal(cleanName('..\u0000re\u0007ceipt\n.pdf'), 'receipt.pdf');
  assert.equal(cleanName('.jpg'), 'jpg', 'a name that is only an extension loses its dot; it is then refused as having no type');
  assert.equal(cleanName(''), 'receipt');
  const long = cleanName(`${'x'.repeat(300)}.jpeg`);
  assert.equal(Buffer.byteLength(long), 150);
  assert.ok(long.endsWith('.jpeg'));
  const wide = cleanName(`${'é€😀'.repeat(60)}.pdf`);
  assert.ok(Buffer.byteLength(wide) <= 150 && wide.endsWith('.pdf'), 'bytes, not characters');
  assert.ok(!wide.includes('\ufffd') && Array.from(wide).every((ch) => ch.codePointAt(0) !== 0xfffd), 'no multibyte character is cut in half');
  assert.equal(cleanName('a\u2066b\u200e\u200fc.jpg'), 'abc.jpg');
  assert.equal(cleanName('a\u202eb.jpg'), 'ab.jpg');
});

// ---- the WebDAV stand-in ----
function fakeClient(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, v]) => [p, Buffer.from(v)]));
  const c = {
    files, calls: [], opts: [], failPut: false,
    async exists(p, o) { c.opts.push(o); return files.has(p); },
    async stat(p) { return { size: files.get(p).length }; },
    async getFileContents(p) { return files.get(p); },
    async putFileContents(p, data, o = {}) {
      c.calls.push(['put', p]);
      c.opts.push(o);
      if (c.failPut) { files.set(p, Buffer.from(data).subarray(0, 2)); throw new Error('quota exceeded'); } // part of the file arrived
      if (o.overwrite === false && files.has(p)) throw Object.assign(new Error('exists'), { status: 412 });
      files.set(p, Buffer.from(data));
    },
    async moveFile(a, b, o = {}) {
      c.calls.push(['move', a, b]);
      c.opts.push(o);
      if (o.overwrite === false && files.has(b)) throw Object.assign(new Error('exists'), { status: 412 });
      files.set(b, files.get(a));
      files.delete(a);
    },
    async deleteFile(p, o) { c.calls.push(['delete', p]); c.opts.push(o); files.delete(p); },
  };
  return c;
}

test('saveToInbox: written under a hidden temporary name first (no .part), then moved; every call has a timeout', async () => {
  const c = fakeClient();
  const { as } = await saveToInbox(c, inbox, 'r.jpg', JPEG);
  assert.equal(as, 'r.jpg');
  assert.match(c.calls[0][1], new RegExp(`^${inbox}/\\.upload-[0-9a-f-]{36}-r\\.jpg$`));
  assert.ok(!c.calls[0][1].endsWith('.part'), 'Nextcloud reserves *.part');
  assert.equal(c.calls[0][0], 'put');
  assert.deepEqual(c.calls[1].slice(0, 1), ['move']);
  assert.equal(c.calls[1][2], `${inbox}/r.jpg`);
  assert.ok(c.files.get(`${inbox}/r.jpg`).equals(JPEG));
  assert.equal([...c.files.keys()].length, 1, 'no temporary file is left');
  const PARTIAL = /^\.|\.(part|tmp|crdownload)$/i; // as in nextcloud.js listInbox
  assert.ok(PARTIAL.test(path.basename(c.calls[0][1])), 'the inbox listing skips the temporary name');
  assert.ok(c.opts.filter(Boolean).every((o) => o.signal instanceof AbortSignal), 'timeouts');
});

test('saveToInbox: a taken name gets the time stamp before the extension; the other file is untouched', async () => {
  const c = fakeClient({ [`${inbox}/IMG_20261105_101530.jpg`]: 'older' });
  const { as } = await saveToInbox(c, inbox, 'IMG_20261105_101530.jpg', JPEG);
  assert.match(as, /^IMG_20261105_101530-\d+\.jpg$/);
  assert.equal(c.files.get(`${inbox}/IMG_20261105_101530.jpg`).toString(), 'older');
  assert.ok(c.files.get(`${inbox}/${as}`).equals(JPEG));
  assert.equal(photoDateFromName(as, new Date('2026-11-06T12:00:00Z'), new Date('2026-11-06T12:00:00Z')), '2026-11-05', 'the camera date in the name still reads');
});

test('saveToInbox: the very same photo (same name, same bytes) is skipped; a different one with the same name is kept', async () => {
  const c = fakeClient({ [`${inbox}/r.jpg`]: JPEG });
  assert.deepEqual(await saveToInbox(c, inbox, 'r.jpg', JPEG), { duplicate: true });
  assert.equal(c.calls.length, 0, 'nothing was uploaded');
  const other = Buffer.concat([JPEG.subarray(0, JPEG.length - 1), Buffer.from('Z')]);
  const got = await saveToInbox(c, inbox, 'r.jpg', other);
  assert.match(got.as, /^r-\d+\.jpg$/);
});

test('saveToInbox: a name taken between the check and the move still replaces nothing', async () => {
  const c = fakeClient();
  const exists = c.exists;
  let n = 0;
  c.exists = async (p, o) => { const r = await exists(p, o); if (p === `${inbox}/r.jpg` && ++n === 2) c.files.set(p, Buffer.from('raced')); return r; };
  const { as } = await saveToInbox(c, inbox, 'r.jpg', JPEG);
  assert.notEqual(as, 'r.jpg');
  assert.equal(c.files.get(`${inbox}/r.jpg`).toString(), 'raced');
});

test('saveToInbox: a PUT that fails part way still gets its temporary file cleaned up', async () => {
  const c = fakeClient();
  c.failPut = true;
  await assert.rejects(() => saveToInbox(c, inbox, 'r.jpg', JPEG), /quota exceeded/);
  assert.deepEqual([...c.files.keys()], []);
  assert.ok(c.calls.some((x) => x[0] === 'delete' && path.basename(x[1]).startsWith('.upload-')));
});

test('staleUploads: only our own temporary files that are over an hour old', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const id = '0123abcd-0123-0123-0123-0123456789ab';
  const item = (basename, ago) => ({ basename, filename: `${inbox}/${basename}`, type: 'file', lastmod: new Date(now - ago).toUTCString() });
  const items = [item(`.upload-${id}-r.jpg`, 2 * 3600e3), item(`.upload-${id}-new.jpg`, 60e3), item('.upload-notours.jpg', 5 * 3600e3), item('.hidden.jpg', 5 * 3600e3), item('r.jpg', 5 * 3600e3), item(`.ocTransferId1.part`, 5 * 3600e3)];
  assert.deepEqual(staleUploads(items, now).map((i) => i.basename), [`.upload-${id}-r.jpg`]);
});

test('uploadFiles: good files go in, bad ones are refused with a reason, a Nextcloud error refuses only that file, extras beyond the limit are refused', async () => {
  const c = fakeClient();
  const out = await uploadFiles(c, inbox, [
    { filename: 'a.jpg', data: JPEG }, { filename: 'bad.jpg', data: Buffer.from('text') }, { filename: 'b.pdf', data: PDF }, { filename: '../x.png', data: PNG },
  ]);
  assert.deepEqual(out.saved.map((s) => s.as), ['a.jpg', 'b.pdf', 'x.png']);
  assert.deepEqual(out.refused.map((r) => r.name), ['bad.jpg']);
  const many = Array.from({ length: MAX_FILES + 2 }, (_, i) => ({ filename: `f${i}.jpg`, data: JPEG }));
  const c2 = fakeClient();
  const o2 = await uploadFiles(c2, inbox, many);
  assert.equal(o2.saved.length, MAX_FILES);
  assert.match(o2.refused[0].why, /too many files/);
  const c3 = fakeClient();
  c3.failPut = true;
  const o3 = await uploadFiles(c3, inbox, [{ filename: 'a.jpg', data: JPEG }]);
  assert.match(o3.refused[0].why, /quota exceeded/);
});

test('uploadNotice: refusals first, then what went in under what name; the dry-run note; short enough that nothing important is clipped', () => {
  const r = { saved: [{ from: 'a.jpg', as: 'a-17.jpg' }, { from: 'b.pdf', as: 'b.pdf' }], skipped: ['dup.jpg'], refused: [{ name: 'c.txt', why: 'not a receipt type' }] };
  const live = uploadNotice(r, false);
  assert.ok(live.indexOf('Not uploaded: c.txt (not a receipt type)') < live.indexOf('Uploaded 2 files'));
  assert.match(live, /a\.jpg as a-17\.jpg, b\.pdf\. The worker is reading them now; refresh/);
  assert.match(live, /Already in the Inbox, skipped: dup\.jpg/);
  assert.match(uploadNotice(r, true), /dry run/);
  assert.match(uploadNotice({ saved: [], refused: [] }, false), /No file was chosen/);
  const many = { saved: Array.from({ length: 15 }, (_, i) => ({ from: `${'long'.repeat(20)}${i}.jpg`, as: `${'long'.repeat(20)}${i}.jpg` })), refused: Array.from({ length: 15 }, (_, i) => ({ name: `${'bad'.repeat(30)}${i}.txt`, why: 'not a receipt type' })) };
  const text = uploadNotice(many, false);
  assert.ok(Array.from(text).length <= 290);
  assert.match(text, /^Not uploaded: .*\(not a receipt type\)/, 'the first refusals and their reasons survive');
});

// ---- the server ----
let uploaded;
let triggers;
let server;
let base;
test.before(async () => {
  uploaded = [];
  triggers = [];
  const client = fakeClient();
  const { uploadFiles: up } = await import('../src/upload.js');
  server = makeServer((why) => triggers.push(why), { nextcloud: { uploadToInbox: async (files) => { const r = await up(client, inbox, files); uploaded.push(client); return r; } } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const send = (parts, { key = 'secret', headers = {}, raw } = {}) => fetch(`${base}/upload?key=${key}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'multipart/form-data; boundary=XBOUNDX', ...headers }, body: raw ?? multipart(parts) });
const noticeOf = (res) => new URL(res.headers.get('location'), base).searchParams.get('notice');

test('POST /upload needs the page key', async () => {
  const res = await send([{ name: 'receipts', filename: 'a.jpg', data: JPEG }], { key: 'wrong' });
  assert.equal(res.status, 403);
  assert.equal(triggers.length, 0);
});

test('POST /upload: Sec-Fetch-Site decides - another site and same-site are refused; same-origin, none and no header (curl) are allowed', async () => {
  const part = [{ name: 'receipts', filename: 'a.jpg', data: JPEG }];
  for (const site of ['cross-site', 'same-site']) {
    triggers.length = 0;
    const res = await send(part, { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403, site);
    assert.equal(triggers.length, 0);
  }
  for (const site of ['same-origin', 'none']) assert.equal((await send(part, { headers: { 'Sec-Fetch-Site': site } })).status, 303, site);
  assert.equal((await send(part)).status, 303);
  // the Origin header (null behind Referrer-Policy: no-referrer, or a proxy's host) plays no part
  assert.equal((await send(part, { headers: { Origin: 'null' } })).status, 303);
  assert.equal((await send(part, { headers: { Origin: 'http://some.proxy.example' } })).status, 303);
});

test('POST /upload: good and bad files together, a check is started, the notice escapes nothing it should not', async () => {
  triggers.length = 0;
  const evil = '<b>x&.jpg';
  const res = await send([{ name: 'receipts', filename: 'good.jpg', data: JPEG }, { name: 'receipts', filename: evil, data: Buffer.from('not an image') }, { name: 'csrf', data: 'x' }]);
  assert.equal(res.status, 303);
  const notice = noticeOf(res);
  assert.match(notice, /Uploaded 1 file to the Inbox: good\.jpg/);
  assert.ok(notice.includes(`Not uploaded: ${evil}`), 'the raw name travels in the notice; the page escapes it when drawing');
  assert.ok(notice.indexOf('Not uploaded') < notice.indexOf('Uploaded 1'));
  assert.deepEqual(triggers, ['upload']);
  const page = await (await fetch(`${base}/?key=secret&notice=${encodeURIComponent(notice)}`)).text();
  assert.ok(!page.includes('<b>x&'));
  assert.ok(page.includes('&#60;b&#62;x&#38;.jpg'));
});

test('POST /upload with Accept: application/json (the page script, one file per request) answers JSON and leaves the check to the script when ?defer=1', async () => {
  triggers.length = 0;
  const res = await fetch(`${base}/upload?key=secret&defer=1`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=XBOUNDX', Accept: 'application/json' }, body: multipart([{ name: 'receipts', filename: 'one.jpg', data: JPEG }]) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.saved[0].from, 'one.jpg');
  assert.deepEqual(triggers, []);
  const bad = await (await fetch(`${base}/upload?key=secret&defer=1`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=XBOUNDX', Accept: 'application/json' }, body: multipart([{ name: 'receipts', filename: 'x.txt', data: 'hi' }]) })).json();
  assert.equal(bad.saved.length, 0);
  assert.match(bad.refused[0].why, /not a receipt type/);
});

test('POST /upload: nothing good means no check; an empty file box; a body that is not a file form; a body over the request limit', async () => {
  triggers.length = 0;
  const bad = await send([{ name: 'receipts', filename: 'a.txt', data: 'hi' }]);
  assert.match(noticeOf(bad), /^Not uploaded: a\.txt.*Nothing was uploaded\./);
  assert.equal(triggers.length, 0);
  assert.match(noticeOf(await send([{ name: 'receipts', filename: '', data: '' }])), /No file was chosen/);
  const form = await fetch(`${base}/upload?key=secret`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
  assert.match(noticeOf(form), /not understood/);
  const big = await send([], { raw: Buffer.alloc(101 * 1024 * 1024, 1) });
  assert.match(noticeOf(big), /more than 100 MB/);
  assert.equal(triggers.length, 0);
});

/** A request with chunked transfer encoding (no Content-Length) of `megabytes` MB, sent in 1 MB pieces. */
function chunked(megabytes, query = 'key=secret') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/upload?${query}`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=XBOUNDX', 'Transfer-Encoding': 'chunked', Accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: 0, body: '' }) : reject(e)));
    const piece = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < megabytes; i++) req.write(piece);
    req.end();
  });
}

test('POST /upload: a chunked body over the limit is cut off with a clear answer, and nothing is saved', async () => {
  triggers.length = 0;
  const r = await chunked(101);
  assert.equal(r.status, 413);
  assert.match(JSON.parse(r.body).message, /more than 100 MB/);
  assert.equal(triggers.length, 0);
});

test('POST /upload without the right key is refused before any upload is attempted', async () => {
  const before = uploaded.length;
  assert.equal((await send([{ name: 'receipts', filename: 'a.jpg', data: JPEG }], { key: '' })).status, 403);
  const r = await chunked(2, 'key=nope');
  assert.ok([403, 0].includes(r.status));
  assert.equal(uploaded.length, before);
});

test('POST /upload: only one upload at a time; the second gets a friendly "try again" (503 as JSON)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = makeServer(() => {}, { nextcloud: { uploadToInbox: async () => { await gate; return { saved: [], skipped: [], refused: [] }; } } });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${slow.address().port}/upload?key=secret`;
  const opts = { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=XBOUNDX', Accept: 'application/json' }, body: multipart([{ name: 'receipts', filename: 'a.jpg', data: JPEG }]) };
  try {
    const first = fetch(url, opts);
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(url, opts);
    assert.equal(second.status, 503);
    assert.match((await second.json()).message, /Another upload is in progress/);
    const htmlSecond = await fetch(url, { ...opts, headers: { ...opts.headers, Accept: 'text/html' }, redirect: 'manual' });
    assert.match(noticeOf(htmlSecond), /Another upload is in progress/);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await fetch(url, opts)).status, 200, 'free again afterwards');
  } finally {
    release();
    slow.close();
  }
});

test('the server gives a slow upload ten minutes, not the default five', () => {
  assert.equal(makeServer(() => {}, {}).requestTimeout, 10 * 60 * 1000);
});

test('the Status page has the upload form: multiple files, phone-friendly accept list, no capture attribute', () => {
  const html = statusPage({ dryRun: false, heartbeat: 'x', recent: [] }, 'k', '');
  assert.match(html, /action="upload\?key=k"/);
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /<input[^>]* type="file"[^>]* multiple /);
  assert.match(html, /accept="image\/jpeg,image\/png,image\/webp,image\/heic,image\/heif,application\/pdf,\.heic,\.heif"/);
  assert.ok(!/capture/.test(html.match(/<input[^>]* type="file"[^>]*>/)[0]));
  assert.match(html, /data-upload data-send="upload\?key=k&amp;defer=1" data-run="run\?key=k"/);
  assert.match(html, /<summary>\+ Add receipt<\/summary>/);
  assert.match(html, /<label class="btn plain" for="receipt-files">Choose photos or PDFs<\/label>/);
  assert.match(html, /<button class="plain" data-nojs>/, 'without JavaScript there is a Send button');
  assert.match(html, /Up to 25 MB each · 20 files at a time/);
  assert.match(statusPage({ dryRun: true, heartbeat: 'x', recent: [] }, 'k', ''), /Dry run only previews receipts\. Nothing changes in Actual or Nextcloud\./);
});
