// local-files.js: the receipt folders on this machine (STORAGE=local) behave like the WebDAV client the helpers were written for.
// Every test works in its own folder under the system temp folder, with made-up receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { localClient, checkWritable, sweepTemps, firstBytes, STATUS_OF, wroteWhole, settledOnly, SETTLE_MS } from '../src/local-files.js';
import { constants } from 'node:fs';
import { NO_OVERWRITE, ifMatch, isExists, requeue, downloadListed, moveKeepingBoth } from '../src/requeue.js';
import { resumeTransfer } from '../src/filing-transfer.js';
import { archiveFileWith } from '../src/archive-files.js';
import { uploadFiles } from '../src/upload.js';
import { FileChangedError, isTransient } from '../src/errors.js';
import { testChanged } from '../src/connection-test.js';

const CONFIG_URL = new URL('../src/config.js', import.meta.url).href;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

/** A fresh receipt folder with the usual subfolders; removed after the test. */
function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-files-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const sub of ['Inbox', 'Processed', 'Needs review', 'Archive']) fs.mkdirSync(path.join(root, sub));
  return { root, c: localClient(root), at: (...p) => path.join(root, ...p) };
}
const status = (code) => (err) => err.status === code && err.response?.status === code;

test('listing: files and folders shaped like webdav entries, not deeper, symbolic links left out', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'shop-0412.jpg'), JPEG);
  fs.mkdirSync(at('Inbox', 'sub'));
  fs.writeFileSync(at('Inbox', 'sub', 'deeper.jpg'), JPEG);
  fs.symlinkSync(at('Processed'), at('Inbox', 'link'));
  const items = await c.getDirectoryContents('/Inbox');
  assert.deepEqual(items.map((i) => [i.filename, i.basename, i.type, i.size]).sort(), [['/Inbox/shop-0412.jpg', 'shop-0412.jpg', 'file', JPEG.length], ['/Inbox/sub', 'sub', 'directory', 0]]);
  const file = items.find((i) => i.type === 'file');
  assert.match(file.etag, /^[0-9a-f]{32}$/);
  assert.ok(Number.isFinite(Date.parse(file.lastmod)), 'lastmod is a date staleUploads can parse');
  assert.deepEqual(await c.stat('/Inbox/shop-0412.jpg'), file);
  await assert.rejects(c.getDirectoryContents('/Missing'), status(404));
  await assert.rejects(c.stat('/Inbox/none.jpg'), status(404));
  assert.equal(await c.exists('/Inbox/shop-0412.jpg'), true);
  assert.equal(await c.exists('/Inbox/none.jpg'), false);
  assert.equal(await c.exists('Inbox//shop-0412.jpg'), true, 'paths are normalised');
});

test('get: bytes or text, and with If-Match only the version asked for (412 otherwise)', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg.json'), '{"applied":false}');
  assert.equal(await c.getFileContents('/Processed/a.jpg.json', { format: 'text' }), '{"applied":false}');
  assert.ok(Buffer.isBuffer(await c.getFileContents('/Processed/a.jpg.json')));
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const listed = await c.stat('/Inbox/a.jpg');
  assert.deepEqual(await downloadListed(c, listed), JPEG);
  fs.writeFileSync(at('Inbox', 'b.jpg'), Buffer.from('another photo'));
  fs.renameSync(at('Inbox', 'b.jpg'), at('Inbox', 'a.jpg')); // a new upload under the same name
  await assert.rejects(c.getFileContents('/Inbox/a.jpg', { headers: ifMatch(listed.etag) }), status(412));
  await assert.rejects(downloadListed(c, listed), FileChangedError);
  await assert.rejects(c.getFileContents('/Inbox/gone.jpg'), status(404));
});

test('etag: kept by a move, new when the file is written again', async (t) => {
  const { c } = folder(t);
  await c.putFileContents('/Inbox/a.jpg', JPEG);
  const before = (await c.stat('/Inbox/a.jpg')).etag;
  await c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE);
  assert.equal((await c.stat('/Processed/a.jpg')).etag, before);
  await c.moveFile('/Processed/a.jpg', '/Needs review/a.jpg');
  assert.equal((await c.stat('/Needs review/a.jpg')).etag, before);
  await c.putFileContents('/Needs review/a.jpg', Buffer.from('rewritten'));
  assert.notEqual((await c.stat('/Needs review/a.jpg')).etag, before);
});

test('move without overwrite: a taken name is 412 (isExists) and both files stay as they were', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'a.jpg'), 'already filed');
  for (const options of [NO_OVERWRITE, { overwrite: false }, { headers: { Overwrite: 'F' } }]) {
    await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', options), (err) => isExists(err) && err.status === 412);
  }
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG);
  assert.equal(fs.readFileSync(at('Processed', 'a.jpg'), 'utf8'), 'already filed');
  // moveKeepingBoth then takes the other name
  assert.equal(await moveKeepingBoth(c, '/Inbox/a.jpg', '/Processed/a.jpg', '/Processed/1-a.jpg'), '/Processed/1-a.jpg');
  assert.deepEqual(fs.readFileSync(at('Processed', '1-a.jpg')), JPEG);
  assert.equal(fs.existsSync(at('Inbox', 'a.jpg')), false);
});

test('move: If-Match, a missing source or destination folder, a folder, and onto itself', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch('0'.repeat(32)) } }), status(412));
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Nowhere/a.jpg', NO_OVERWRITE), status(409));
  await assert.rejects(c.moveFile('/Inbox/none.jpg', '/Processed/none.jpg', NO_OVERWRITE), status(404));
  await assert.rejects(c.moveFile('/Inbox', '/Processed/Inbox', NO_OVERWRITE), status(403));
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Inbox/a.jpg'), status(403));
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG, 'nothing moved');
  await c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } });
  assert.deepEqual(fs.readFileSync(at('Processed', 'a.jpg')), JPEG);
});

test('put: whole files only, private, overwrite false refuses a taken name, a missing folder is 409, no temporary file left', async (t) => {
  const { c, at } = folder(t);
  await c.putFileContents('/Processed/a.jpg.json', '{"v":1}');
  await c.putFileContents('/Processed/a.jpg.json', '{"v":2}', { overwrite: true });
  assert.equal(fs.readFileSync(at('Processed', 'a.jpg.json'), 'utf8'), '{"v":2}');
  await assert.rejects(c.putFileContents('/Processed/a.jpg.json', '{"v":3}', { overwrite: false }), (err) => isExists(err));
  assert.equal(fs.readFileSync(at('Processed', 'a.jpg.json'), 'utf8'), '{"v":2}');
  await c.putFileContents('/Inbox/new.jpg', JPEG, { overwrite: false });
  await assert.rejects(c.putFileContents('/Nowhere/x.json', '{}'), status(409));
  assert.equal(fs.statSync(at('Processed', 'a.jpg.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(at('Inbox', 'new.jpg')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(at('Processed')), ['a.jpg.json']);
  assert.deepEqual(fs.readdirSync(at('Inbox')), ['new.jpg']);
});

test('folders: created private, recursive is fine when they exist, without it an existing folder is 405', async (t) => {
  const { c, at } = folder(t);
  await c.createDirectory('/Archive/2026-04/x', { recursive: true });
  await c.createDirectory('/Archive/2026-04/x', { recursive: true });
  assert.equal(fs.statSync(at('Archive', '2026-04', 'x')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(at('Archive', '2026-04')).mode & 0o777, 0o700);
  await assert.rejects(c.createDirectory('/Archive/2026-04'), status(405));
});

test('delete: a file, a missing one is 404, never the root', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  await c.deleteFile('/Inbox/a.jpg');
  assert.equal(fs.existsSync(at('Inbox', 'a.jpg')), false);
  await assert.rejects(c.deleteFile('/Inbox/a.jpg'), status(404));
  await assert.rejects(c.deleteFile('/'), status(403));
  assert.equal(fs.existsSync(at('Inbox')), true);
});

test('paths that lead out of the receipt folder are refused: "..", and symbolic links to outside', async (t) => {
  const { c, at } = folder(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-files-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not a receipt');
  fs.symlinkSync(outside, at('Inbox', 'escape'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), at('Inbox', 'secret.jpg'));
  await assert.rejects(c.getFileContents('/../' + path.basename(outside) + '/secret.txt'), status(403));
  await assert.rejects(c.getFileContents('/Inbox/../../x'), status(403));
  await assert.rejects(c.getFileContents('/Inbox/escape/secret.txt'), status(403));
  await assert.rejects(c.getFileContents('/Inbox/secret.jpg'), status(403));
  await assert.rejects(c.putFileContents('/Inbox/escape/new.jpg', JPEG), status(403));
  await assert.rejects(c.moveFile('/Inbox/secret.jpg', '/Processed/secret.jpg', NO_OVERWRITE), status(403));
  await assert.rejects(c.getDirectoryContents('/Inbox/escape'), status(403));
  await assert.rejects(c.exists('a\0b'), status(400));
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt'], 'nothing was written outside');
});

test('a missing receipt folder (not mounted) is an outage, not a missing file; an aborted signal stops a call', async (t) => {
  const { root } = folder(t);
  const gone = localClient(path.join(root, 'not-mounted'));
  const { isOutage } = await import('../src/errors.js');
  await assert.rejects(gone.getDirectoryContents('/Inbox'), (err) => err.name === 'TransientError' && /is not there/.test(err.message) && isOutage(err));
  await assert.rejects(gone.exists('/Inbox'), (err) => isOutage(err));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(localClient(root).getDirectoryContents('/Inbox', { signal: ac.signal }));
});

test('checkWritable: passes for a writable folder and leaves nothing behind; names a missing one', async (t) => {
  const { at } = folder(t);
  await checkWritable(at('Inbox'));
  assert.deepEqual(fs.readdirSync(at('Inbox')), []);
  await assert.rejects(checkWritable(at('Nope')), /is not there/);
  fs.writeFileSync(at('file'), '');
  await assert.rejects(checkWritable(at('file')), /not a folder/);
});

// ---- the helpers that take "the client", end to end on a local folder ----

test('resumeTransfer files a receipt into Processed with its summary, and resuming after the move finishes the job', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'shop-0412.jpg'), JPEG);
  fs.writeFileSync(at('Inbox', 'shop-0412.jpg.json'), '{"stale":true}');
  const saved = [];
  const intent = { from: '/Inbox/shop-0412.jpg', dest: '/Processed/shop-0412.jpg', summary: { applied: true, store: 'Example Shop' } };
  assert.equal(await resumeTransfer(c, intent, async (i) => saved.push(i)), '/Processed/shop-0412.jpg');
  assert.deepEqual(fs.readFileSync(at('Processed', 'shop-0412.jpg')), JPEG);
  assert.deepEqual(JSON.parse(fs.readFileSync(at('Processed', 'shop-0412.jpg.json'), 'utf8')), intent.summary);
  assert.equal(fs.existsSync(at('Inbox', 'shop-0412.jpg')), false);
  assert.equal(fs.existsSync(at('Inbox', 'shop-0412.jpg.json')), false);
  assert.equal(saved.length, 1, 'the destination was saved before the move');
  // A lost answer: the same intent run again finds the file already at its place (same etag) and finishes quietly.
  assert.equal(await resumeTransfer(c, saved[0], async () => {}), '/Processed/shop-0412.jpg');
});

test('resumeTransfer never replaces a receipt already filed under the same name', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'a.jpg'), 'an older receipt');
  const to = await resumeTransfer(c, { from: '/Inbox/a.jpg', dest: '/Processed/a.jpg', summary: {} }, async () => {});
  assert.notEqual(to, '/Processed/a.jpg');
  assert.equal(fs.readFileSync(at('Processed', 'a.jpg'), 'utf8'), 'an older receipt');
  assert.deepEqual(fs.readFileSync(path.join(at('Processed'), path.basename(to))), JPEG);
});

test('requeue moves a receipt from Needs review back to the inbox, and refuses when the inbox has the name', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Needs review', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Needs review', 'a.jpg.json'), '{"applied":false}');
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg'), { moved: '/Inbox/a.jpg' });
  assert.deepEqual(fs.readdirSync(at('Needs review')), []);
  fs.writeFileSync(at('Needs review', 'a.jpg'), Buffer.from('a second photo'));
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg'), { refused: 'exists' });
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG);
});

test('archiveFileWith moves a done receipt into the month folder with its summary', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'a.jpg.json'), '{"applied":true}');
  const r = await archiveFileWith(c, { from: '/Processed/a.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: '2026-04-12T10:00:00.000Z', shrink: false });
  assert.equal(r.dest, '/Archive/2026-04/a.jpg');
  assert.deepEqual(fs.readFileSync(at('Archive', '2026-04', 'a.jpg')), JPEG);
  assert.equal(JSON.parse(fs.readFileSync(at('Archive', '2026-04', 'a.jpg.json'), 'utf8')).archived.at, '2026-04-12T10:00:00.000Z');
  assert.equal(fs.existsSync(at('Processed', 'a.jpg')), false);
});

test('uploadFiles saves into the local inbox without replacing a file of the same name', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'phone.jpg'), 'there first');
  const r = await uploadFiles(c, '/Inbox', [{ filename: 'phone.jpg', data: JPEG }]);
  assert.equal(r.saved.length, 1);
  assert.equal(fs.readFileSync(at('Inbox', 'phone.jpg'), 'utf8'), 'there first');
  const names = fs.readdirSync(at('Inbox'));
  assert.equal(names.length, 2);
  assert.ok(names.every((n) => !n.endsWith('.tmp')));
});

// ---- a move that stopped half way: the file linked at its new name, the old name not yet removed (the worker stopped in between) ----

/** Both names of one file, as a local move leaves them when it stops between link and unlink. */
const halfMove = (at, from, to) => fs.linkSync(at(...from), at(...to));
const names = (at, ...dir) => fs.readdirSync(at(...dir)).sort();

test('crash between link and unlink: moving again only drops the old name, also with overwrite', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  halfMove(at, ['Inbox', 'a.jpg'], ['Processed', 'a.jpg']);
  const { etag } = await c.stat('/Inbox/a.jpg');
  await c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', { ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } });
  assert.deepEqual(names(at, 'Inbox'), []);
  assert.equal(fs.statSync(at('Processed', 'a.jpg')).nlink, 1);
  fs.writeFileSync(at('Inbox', 'b.jpg'), JPEG);
  halfMove(at, ['Inbox', 'b.jpg'], ['Processed', 'b.jpg']);
  await c.moveFile('/Inbox/b.jpg', '/Processed/b.jpg'); // rename(2) between two names of one file would do nothing
  assert.deepEqual(names(at, 'Inbox'), []);
  assert.equal(fs.statSync(at('Processed', 'b.jpg')).nlink, 1);
});

test('crash between link and unlink: resumeTransfer finishes the move and drops the old summary', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'shop-0412.jpg'), JPEG);
  fs.writeFileSync(at('Inbox', 'shop-0412.jpg.json'), '{"stale":true}');
  const { etag } = await c.stat('/Inbox/shop-0412.jpg');
  halfMove(at, ['Inbox', 'shop-0412.jpg'], ['Processed', 'shop-0412.jpg']);
  const intent = { from: '/Inbox/shop-0412.jpg', dest: '/Processed/shop-0412.jpg', to: '/Processed/shop-0412.jpg', etag, summary: { applied: true } };
  assert.equal(await resumeTransfer(c, intent, async () => {}), '/Processed/shop-0412.jpg');
  assert.deepEqual(names(at, 'Inbox'), []);
  assert.deepEqual(names(at, 'Processed'), ['shop-0412.jpg', 'shop-0412.jpg.json']);
  assert.equal(fs.statSync(at('Processed', 'shop-0412.jpg')).nlink, 1);
});

test('crash between link and unlink: requeue finishes the move instead of refusing a name its own file holds', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Needs review', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Needs review', 'a.jpg.json'), '{"applied":false}');
  halfMove(at, ['Needs review', 'a.jpg'], ['Inbox', 'a.jpg']);
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg'), { moved: '/Inbox/a.jpg' });
  assert.deepEqual(names(at, 'Needs review'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  assert.equal(fs.statSync(at('Inbox', 'a.jpg')).nlink, 1);
});

test('crash between link and unlink: archiving (refile, moveKeepingBoth) again leaves the receipt at one name only', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'a.jpg.json'), '{"applied":true}');
  fs.mkdirSync(at('Archive', '2026-04'));
  halfMove(at, ['Processed', 'a.jpg'], ['Archive', '2026-04', 'a.jpg']);
  const r = await archiveFileWith(c, { from: '/Processed/a.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: '2026-04-12T10:00:00.000Z', shrink: false });
  assert.deepEqual(names(at, 'Processed'), []);
  const base = path.posix.basename(r.dest);
  assert.deepEqual(names(at, 'Archive', '2026-04'), [base, `${base}.json`]);
  assert.equal(fs.statSync(at('Archive', '2026-04', base)).nlink, 1);
  // Another name of the same file in the destination folder that no record of a move names is not guessed to be debris: it stays.
  fs.writeFileSync(at('Inbox', 'b.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'b.jpg'), 'another receipt');
  halfMove(at, ['Inbox', 'b.jpg'], ['Processed', '1-b.jpg']);
  assert.equal(await moveKeepingBoth(c, '/Inbox/b.jpg', '/Processed/b.jpg', '/Processed/2-b.jpg'), '/Processed/2-b.jpg');
  assert.deepEqual(names(at, 'Processed'), ['1-b.jpg', '2-b.jpg', 'b.jpg']);
  assert.equal(fs.readFileSync(at('Processed', 'b.jpg'), 'utf8'), 'another receipt');
  assert.deepEqual(names(at, 'Inbox'), []);
});

/** Run `hook` once, just before the first call of fs/promises `name` whose first argument matches `when`; the real call follows. */
function before(t, name, when, hook) {
  const real = fsp[name];
  let done = false;
  t.after(() => { fsp[name] = real; });
  fsp[name] = async (...args) => {
    if (!done && when(...args)) {
      done = true;
      await hook(...args);
    }
    return real(...args);
  };
  return () => { fsp[name] = real; };
}
const claimed = (p) => path.basename(String(p)).startsWith('.claim-');
const ifMatchMove = (etag) => ({ ...NO_OVERWRITE, headers: { ...NO_OVERWRITE.headers, ...ifMatch(etag) } });
/** No claimed file in the folders and no record left: every claim was finished or undone. */
function noClaimsLeft(at) {
  const left = [];
  for (const dir of ['Inbox', 'Processed', 'Needs review', 'Archive']) left.push(...fs.readdirSync(at(dir)).filter((n) => n.startsWith('.claim-')));
  if (fs.existsSync(at('.receipts-claims'))) left.push(...fs.readdirSync(at('.receipts-claims')));
  assert.deepEqual(left, []);
}

test('#1 a sync tool puts a new file at the old name after the claim: the version asked for moves, the new file is never deleted', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  // Between the link to the destination and the drop of the old name: the window where unlink(source) used to delete the newcomer.
  before(t, 'link', (src) => claimed(src), () => {
    fs.writeFileSync(at('Inbox', 'new.jpg'), 'a new upload');
    fs.renameSync(at('Inbox', 'new.jpg'), at('Inbox', 'a.jpg'));
  });
  await c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', ifMatchMove(etag));
  assert.deepEqual(fs.readFileSync(at('Processed', 'a.jpg')), JPEG);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg'), 'utf8'), 'a new upload');
  assert.equal((await c.stat('/Processed/a.jpg')).etag, etag);
  noClaimsLeft(at);
});

test('#1 the old name replaced before the claim: If-Match refuses (412) and the new file stays where it is', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  before(t, 'rename', (src, dst) => claimed(dst), () => {
    fs.writeFileSync(at('Inbox', 'new.jpg'), 'a new upload');
    fs.renameSync(at('Inbox', 'new.jpg'), at('Inbox', 'a.jpg'));
  });
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', ifMatchMove(etag)), status(412));
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg'), 'utf8'), 'a new upload');
  noClaimsLeft(at);
});

test('#2 the file changed in place after its version was checked: the move is undone, the file is back in its folder (412)', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  before(t, 'link', (src) => claimed(src), (src) => fs.appendFileSync(src, 'more bytes')); // the same inode, written through a name
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', ifMatchMove(etag)), status(412));
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg')).length, JPEG.length + 'more bytes'.length);
  noClaimsLeft(at);
  // resumeTransfer keeps its record and never verifies a destination that isn't there: nothing is half filed.
  const intent = { from: '/Inbox/a.jpg', dest: '/Processed/a.jpg', to: '/Processed/a.jpg', etag, summary: {} };
  await assert.rejects(resumeTransfer(c, intent, async () => {}), /changed/);
  assert.deepEqual(names(at, 'Processed'), []);
});

test('#2 without If-Match the version claimed is the one checked: a change before the commit puts the file back too', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  before(t, 'link', (src) => claimed(src), (src) => fs.appendFileSync(src, 'x'));
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE), status(412));
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  noClaimsLeft(at);
});

test('a claimed file put back finds its name taken: it is kept beside the newcomer with a time stamp, neither is lost', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  before(t, 'link', (src) => claimed(src), (src) => {
    fs.appendFileSync(src, 'x');
    fs.writeFileSync(at('Inbox', 'a.jpg'), 'a new upload');
  });
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE), status(412));
  const inbox = names(at, 'Inbox');
  assert.equal(inbox.length, 2);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg'), 'utf8'), 'a new upload');
  assert.match(inbox.find((n) => n !== 'a.jpg'), /^\d+-a\.jpg$/);
  noClaimsLeft(at);
});

test('delete with If-Match: only the version asked for; a file put at the name meanwhile is not deleted (412)', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Processed/a.jpg');
  await assert.rejects(c.deleteFile('/Processed/a.jpg', { headers: ifMatch('0'.repeat(32)) }), status(412));
  assert.deepEqual(names(at, 'Processed'), ['a.jpg']);
  await c.deleteFile('/Processed/a.jpg', { headers: ifMatch(etag) });
  assert.deepEqual(names(at, 'Processed'), []);
  fs.writeFileSync(at('Processed', 'b.jpg'), JPEG);
  const b = (await c.stat('/Processed/b.jpg')).etag;
  before(t, 'rename', (src, dst) => claimed(dst), () => fs.writeFileSync(at('Processed', 'b.jpg'), 'replaced by the sync tool'));
  await assert.rejects(c.deleteFile('/Processed/b.jpg', { headers: ifMatch(b) }), status(412));
  assert.equal(fs.readFileSync(at('Processed', 'b.jpg'), 'utf8'), 'replaced by the sync tool');
  noClaimsLeft(at);
});

/** What a move that was stopped (the worker killed) leaves: a record, the claimed file, maybe its link at the destination. */
function stoppedMove(at, { from, to, etag, linked, owner = 'another-process', age = 5 * 60 * 1000 }) {
  const id = crypto.randomUUID();
  const claim = path.posix.join(path.posix.dirname(from), `.claim-${id}`);
  fs.renameSync(at(...from.split('/').filter(Boolean)), at(...claim.split('/').filter(Boolean)));
  if (linked) fs.linkSync(at(...claim.split('/').filter(Boolean)), at(...to.split('/').filter(Boolean)));
  fs.mkdirSync(at('.receipts-claims'), { recursive: true });
  fs.writeFileSync(at('.receipts-claims', `${id}.json`), JSON.stringify({ id, owner, at: Date.now() - age, from, claim, to, etag }));
  return id;
}

test('a move stopped after the link: the next call finishes it when the file is still the version recorded', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag, linked: true });
  assert.deepEqual((await c.getDirectoryContents('/Inbox')).map((i) => i.basename), [], 'claims are never listed');
  assert.deepEqual(names(at, 'Inbox'), []);
  assert.deepEqual(names(at, 'Processed'), ['a.jpg']);
  assert.equal(fs.statSync(at('Processed', 'a.jpg')).nlink, 1);
  noClaimsLeft(at);
});

test('a move stopped after the link, the file changed since: undone, the file back in its folder, the new name gone', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag, linked: true });
  fs.appendFileSync(at('Processed', 'a.jpg'), 'changed');
  assert.equal(await localClient(at()).recoverClaims(), 1);
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  noClaimsLeft(at);
});

test('a move stopped before the link: undone; a file put at the old name meanwhile stays, the claimed one comes back beside it', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag, linked: false });
  fs.writeFileSync(at('Inbox', 'a.jpg'), 'a new upload');
  await c.recoverClaims();
  const inbox = names(at, 'Inbox');
  assert.equal(inbox.length, 2);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg'), 'utf8'), 'a new upload');
  assert.deepEqual(fs.readFileSync(at('Inbox', inbox.find((n) => n !== 'a.jpg'))), JPEG);
  assert.deepEqual(names(at, 'Processed'), []);
  noClaimsLeft(at);
});

test('a fresh record of another process is left alone (that move may still be running); a stale one is settled', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag, linked: false, age: 1000 });
  assert.equal(await c.recoverClaims(), 0);
  assert.equal(fs.readdirSync(at('.receipts-claims')).length, 1);
  assert.deepEqual(names(at, 'Inbox').filter((n) => !n.startsWith('.claim-')), []);
  await assert.rejects(c.stat('/.receipts-claims'), status(403));
  const [rec] = fs.readdirSync(at('.receipts-claims'));
  const json = JSON.parse(fs.readFileSync(at('.receipts-claims', rec), 'utf8'));
  fs.writeFileSync(at('.receipts-claims', rec), JSON.stringify({ ...json, at: Date.now() - 5 * 60 * 1000 }));
  assert.equal(await c.recoverClaims(), 1);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  noClaimsLeft(at);
  assert.deepEqual((await c.getDirectoryContents('/')).map((i) => i.basename).sort(), ['Archive', 'Inbox', 'Needs review', 'Processed'], 'the records folder is never listed');
});

test('#7 etag: a hash of the bytes and the inode, the same for every client and after a move; a change of the bytes is a new one', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const st = fs.statSync(at('Inbox', 'a.jpg'), { bigint: true });
  const content = crypto.createHash('sha256').update(JPEG).digest('hex');
  const want = crypto.createHash('sha256').update(`${st.ino}:${content}`).digest('hex').slice(0, 32);
  assert.equal((await c.stat('/Inbox/a.jpg')).etag, want);
  assert.equal((await localClient(at()).stat('/Inbox/a.jpg')).etag, want, 'nothing of this process (a restart) is in it');
  await c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE);
  assert.equal((await c.stat('/Processed/a.jpg')).etag, want);
  // The same size and the modification time set back: the bytes still tell.
  const { mtime } = fs.statSync(at('Processed', 'a.jpg'));
  const other = Buffer.from(JPEG);
  other[5] ^= 0xff;
  fs.writeFileSync(at('Processed', 'a.jpg'), other);
  fs.utimesSync(at('Processed', 'a.jpg'), mtime, mtime);
  assert.notEqual((await c.stat('/Processed/a.jpg')).etag, want);
  // Two files with the same bytes are two files.
  fs.writeFileSync(at('Inbox', 'b.jpg'), JPEG);
  fs.writeFileSync(at('Inbox', 'c.jpg'), JPEG);
  assert.notEqual((await c.stat('/Inbox/b.jpg')).etag, (await c.stat('/Inbox/c.jpg')).etag);
});

test('errors: a full or failing disk is a passing trouble (5xx), a name too long is 414 and not retried', async (t) => {
  const { c } = folder(t);
  for (const code of ['ENOSPC', 'EDQUOT']) assert.equal(STATUS_OF[code], 507);
  for (const code of ['EIO', 'EAGAIN', 'EBUSY']) assert.equal(STATUS_OF[code], 503);
  for (const status of [507, 503]) assert.equal(isTransient(Object.assign(new Error('x'), { status, response: { status } })), true);
  const tooLong = `${'x'.repeat(300)}.jpg`;
  await assert.rejects(c.putFileContents(`/Inbox/${tooLong}`, JPEG), (err) => err.status === 414 && !isTransient(err));
});

test('long names: the temporary name is cut by bytes, never inside a character, so a name of up to 255 bytes can be written', async (t) => {
  const { c, at } = folder(t);
  assert.equal(firstBytes('aé€😀', 6), 'aé€');
  assert.equal(firstBytes('aé€😀', 5), 'aé');
  assert.equal(firstBytes('😀', 3), '');
  const name = `${'é'.repeat(124)}.jpeg`; // 253 bytes
  await c.putFileContents(`/Inbox/${name}`, JPEG, { overwrite: false });
  await c.putFileContents(`/Inbox/${name}`, Buffer.from('again'));
  assert.deepEqual(names(at, 'Inbox'), [name]);
});

test('sweepTemps removes the temporary files of writes that stopped half way, over an hour old, in all the folders', async (t) => {
  const { root, at } = folder(t);
  fs.mkdirSync(at('Archive', '2026-04'));
  const id = () => crypto.randomUUID();
  const old = [at('Inbox', `.a.jpg.${id()}.tmp`), at('Archive', '2026-04', `.a.jpg.json.${id()}.tmp`), at('Inbox', `..upload-${id()}-b.jpg.${id()}.tmp`)];
  const keep = [at('Inbox', `.c.jpg.${id()}.tmp`), at('Inbox', '.hidden.tmp'), at('Processed', 'receipt.tmp')];
  for (const f of [...old, ...keep]) fs.writeFileSync(f, 'x');
  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  for (const f of [...old, keep[1], keep[2]]) fs.utimesSync(f, twoHoursAgo, twoHoursAgo);
  assert.equal(await sweepTemps(root, now), 3);
  for (const f of old) assert.equal(fs.existsSync(f), false, f);
  for (const f of keep) assert.equal(fs.existsSync(f), true, f);
});

// ---- config and the Settings connection test in local mode ----

/** config.js in a fresh process with `env` (process.env without the Nextcloud login, plus `env`). */
function load(env, expr) {
  const clean = { ...process.env };
  for (const k of ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_APP_PASSWORD', 'STORAGE', 'RECEIPTS_DIR', 'RECEIPTS_INBOX', 'RECEIPTS_PROCESSED', 'RECEIPTS_REVIEW', 'RECEIPTS_ARCHIVE']) delete clean[k];
  const r = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => console.log(JSON.stringify(${expr})))`], { env: { ...clean, ...env }, encoding: 'utf8' });
  return { status: r.status, value: r.status === 0 ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test('config: STORAGE=local needs no Nextcloud login and puts the folders at the top of the receipt folder', () => {
  const { status, value, err } = load({ STORAGE: 'local' }, '{ storage: m.config.storage, nc: m.config.nextcloud, place: m.filesPlace(true) }');
  assert.equal(status, 0, err);
  assert.deepEqual(value.storage, { kind: 'local', root: '/receipts', hostDir: './receipt-files' });
  assert.equal(value.nc.url, '');
  assert.equal(value.nc.password, '');
  assert.deepEqual([value.nc.inbox, value.nc.processed, value.nc.review, value.nc.archive], ['/Inbox', '/Processed', '/Needs review', '/Archive']);
  assert.equal(value.place, 'The receipt folder');
});

test('config: Nextcloud is the default and still needs its login; an unknown STORAGE warns and means Nextcloud', () => {
  assert.notEqual(load({}, 'm.config.storage').status, 0, 'no Nextcloud login without STORAGE=local is an error');
  const nc = load({ NEXTCLOUD_URL: 'http://nextcloud.invalid', NEXTCLOUD_USER: 'u', NEXTCLOUD_APP_PASSWORD: 'p' }, '[m.config.storage.kind, m.config.nextcloud.inbox, m.filesPlace()]');
  assert.deepEqual(nc.value, ['nextcloud', '/Receipts/Inbox', 'Nextcloud']);
  const odd = load({ STORAGE: 'dropbox', NEXTCLOUD_URL: 'http://nextcloud.invalid', NEXTCLOUD_USER: 'u', NEXTCLOUD_APP_PASSWORD: 'p' }, 'm.config.storage.kind');
  assert.equal(odd.value, 'nextcloud');
  assert.match(odd.err, /STORAGE="dropbox" is not one of nextcloud\|local/);
  const set = load({ STORAGE: 'local', RECEIPTS_DIR: '/srv/receipts', RECEIPTS_MOUNT: '/mnt/r', RECEIPTS_INBOX: '/Receipts/Inbox' }, '[m.config.storage, m.config.nextcloud.inbox]');
  assert.deepEqual(set.value, [{ kind: 'local', root: '/mnt/r', hostDir: '/srv/receipts' }, '/Receipts/Inbox']);
});

test('connection test, local storage: a changed inbox must be a writable folder; Nextcloud is never called', async (t) => {
  const { root } = folder(t);
  const never = () => { throw new Error('Nextcloud must not be called with a local folder'); };
  const candidate = (inbox) => ({ storage: { kind: 'local', root }, nextcloud: { url: '', user: '', password: '', inbox }, actual: {} });
  await testChanged(['RECEIPTS_INBOX'], candidate('/Inbox'), { createClientFn: never });
  await assert.rejects(testChanged(['RECEIPTS_INBOX'], candidate('/Missing'), { createClientFn: never }), /The receipt folder is not ready: .*Missing is not there/);
  await testChanged(['NEXTCLOUD_URL', 'RECEIPTS_PROCESSED'], candidate('/Missing'), { createClientFn: never }); // nothing of the local inbox changed
});

/** Hand out a wrapped FileHandle for the next fs/promises open that `when(path, flags)` picks: `wrap(fh, path)` returns the stand-in. */
function onOpen(t, when, wrap) {
  const real = fsp.open;
  t.after(() => { fsp.open = real; });
  fsp.open = async (p, flags, ...rest) => (when(String(p), flags) ? wrap(await real(p, flags, ...rest), String(p)) : real(p, flags, ...rest));
}
const withMethod = (fh, name, fn) => new Proxy(fh, { get: (o, k) => (k === name ? fn : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) });
const fsError = (code) => Object.assign(new Error(code), { code });

test('#6 get with If-Match: a file still being written while it is read is 412, never half a file for the version asked for', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const listed = await c.stat('/Inbox/a.jpg');
  onOpen(t, (p, flags) => p.endsWith('a.jpg') && flags === constants.O_RDONLY, (fh, p) => withMethod(fh, 'readFile', async (o) => {
    const data = await fh.readFile(o);
    fs.appendFileSync(p, 'the rest of the photo'); // the copy goes on after the bytes were read
    return data;
  }));
  await assert.rejects(c.getFileContents('/Inbox/a.jpg', { headers: ifMatch(listed.etag) }), status(412));
  await assert.rejects(downloadListed(c, listed), FileChangedError);
});

test('#6 a local inbox file is read only once it is settled: same version twice, quiet for a while, or written whole by the worker', async (t) => {
  const { c, at } = folder(t);
  const now = Date.now();
  const item = (name, etag, ageMs) => ({ filename: `/Inbox/${name}`, basename: name, etag, lastmod: new Date(now - ageMs).toUTCString(), size: 9, type: 'file' });
  const fresh = item('copying.jpg', 'e1', 1000);
  const quiet = item('old.jpg', 'e2', SETTLE_MS + 5000);
  let { ready, next } = settledOnly([fresh, quiet], new Map(), now, () => false);
  assert.deepEqual(ready.map((i) => i.basename), ['old.jpg']);
  // #12 (phase 4) Two listings a second apart are not enough (a copy can pause): the version must stay the same for SETTLE_MS.
  ({ ready, next } = settledOnly([fresh, quiet], next, now + 1000, () => false));
  assert.deepEqual(ready.map((i) => i.basename), ['old.jpg'], 'the same version a moment later: not yet');
  const grown = { ...fresh, etag: 'e3', lastmod: new Date(now + SETTLE_MS - 2).toUTCString() }; // written to just now
  ({ ready, next } = settledOnly([grown, quiet], next, now + SETTLE_MS - 1, () => false));
  assert.deepEqual(ready.map((i) => i.basename), ['old.jpg'], 'grew since the last listing: still being written');
  ({ ready, next } = settledOnly([grown, quiet], next, now + SETTLE_MS + 1000, () => false));
  assert.deepEqual(ready.map((i) => i.basename), ['old.jpg'], 'its clock starts again at the new version');
  ({ ready } = settledOnly([grown, quiet], next, now + 2 * SETTLE_MS, () => false));
  assert.deepEqual(ready.map((i) => i.basename), ['copying.jpg', 'old.jpg'], 'unchanged for SETTLE_MS since it was first seen');
  // An upload from the status page is read at once (the check right after it), also after its move into the inbox.
  await uploadFiles(c, '/Inbox', [{ filename: 'phone.jpg', data: JPEG }]);
  const up = await c.stat('/Inbox/phone.jpg');
  assert.equal(wroteWhole(up.etag), true);
  assert.equal(settledOnly([up], new Map(), Date.now()).ready.length, 1);
  fs.writeFileSync(at('Inbox', 'other.jpg'), JPEG);
  assert.equal(wroteWhole((await c.stat('/Inbox/other.jpg')).etag), false, 'written by someone else');
});

test('#12 listing: a file that went away meanwhile is left out; one that can\'t be read is listed without a version, never failing the folder (#5)', async (t) => {
  const { c, at } = folder(t);
  for (const n of ['a.jpg', 'gone.jpg', 'bad.jpg']) fs.writeFileSync(at('Inbox', n), JPEG);
  const real = fsp.open;
  t.after(() => { fsp.open = real; });
  fsp.open = async (p, ...rest) => {
    if (String(p).endsWith('gone.jpg')) throw fsError('ENOENT');
    return real(p, ...rest);
  };
  assert.deepEqual((await c.getDirectoryContents('/Inbox')).map((i) => i.basename).sort(), ['a.jpg', 'bad.jpg']);
  for (const code of ['EIO', 'EACCES']) {
    fsp.open = async (p, ...rest) => {
      if (String(p).endsWith('bad.jpg')) throw fsError(code);
      return real(p, ...rest);
    };
    const listed = await c.getDirectoryContents('/Inbox');
    assert.deepEqual(listed.map((i) => [i.basename, Boolean(i.etag), Boolean(i.unreadable)]).sort(), [['a.jpg', true, false], ['bad.jpg', false, true], ['gone.jpg', true, false]], code);
  }
  // The folder itself can't be read: that is still an error, not an empty folder.
  const readdir = fsp.readdir;
  t.after(() => { fsp.readdir = readdir; });
  fsp.readdir = async (p, ...rest) => (String(p).endsWith('Inbox') ? Promise.reject(fsError('EIO')) : readdir(p, ...rest));
  await assert.rejects(c.getDirectoryContents('/Inbox'), (err) => err.status === 503 && isTransient(err));
});

test('#12 get: a disk error while reading is 503 (tried again later), not an unknown error', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  onOpen(t, (p, flags) => p.endsWith('a.jpg') && flags === constants.O_RDONLY, (fh) => withMethod(fh, 'readFile', async () => { throw fsError('EIO'); }));
  await assert.rejects(c.getFileContents('/Inbox/a.jpg'), (err) => err.status === 503 && isTransient(err));
});

test('#13 a signal that aborts during a call ends it at once, whatever the disk is doing', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const real = fsp.open;
  t.after(() => { fsp.open = real; });
  // A disk that takes far longer than the caller will wait (the claimed name too, so a move is caught after its claim).
  const slow = (p) => String(p).endsWith('a.jpg') || claimed(p);
  fsp.open = async (p, ...rest) => (slow(p) ? new Promise((r) => setTimeout(r, 300)).then(() => real(p, ...rest)) : real(p, ...rest));
  for (const call of [
    (signal) => c.getFileContents('/Inbox/a.jpg', { signal }),
    (signal) => c.stat('/Inbox/a.jpg', { signal }),
    (signal) => c.getDirectoryContents('/Inbox', { signal }),
    (signal) => c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', { ...NO_OVERWRITE, signal }),
  ]) {
    const started = Date.now();
    await assert.rejects(call(AbortSignal.timeout(30)), (err) => err.name === 'TimeoutError');
    assert.ok(Date.now() - started < 200, 'answered when the signal aborted, not when the disk did');
  }
  fsp.open = real; // releases future opens; the open already delayed above still completes on its own
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (fs.existsSync(at('Inbox', 'a.jpg')) && !fs.readdirSync(at('Inbox')).some(claimed) && (!fs.existsSync(at('.receipts-claims')) || !fs.readdirSync(at('.receipts-claims')).length)) break;
  }
  noClaimsLeft(at);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
});

test('#3 archive with shrinking: a new file put at the original\'s name while it was shrunk is never deleted; the copy goes', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  fs.writeFileSync(at('Processed', 'a.jpg.json'), '{"applied":true}');
  const shrinkFn = async () => {
    fs.writeFileSync(at('Processed', 'new.jpg'), 'a new version from the phone');
    fs.renameSync(at('Processed', 'new.jpg'), at('Processed', 'a.jpg'));
    return Buffer.from([0xff, 0xd8]);
  };
  await assert.rejects(archiveFileWith(c, { from: '/Processed/a.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: 'T', shrink: true, shrinkFn }), (err) => err.keepGoing === false);
  assert.equal(fs.readFileSync(at('Processed', 'a.jpg'), 'utf8'), 'a new version from the phone');
  assert.deepEqual(names(at, 'Archive', '2026-04'), []);
  // Changed in place (the same file written again) between the read and the delete: kept too.
  fs.writeFileSync(at('Processed', 'b.jpg'), JPEG);
  const inPlace = async () => { fs.appendFileSync(at('Processed', 'b.jpg'), 'more'); return Buffer.from([0xff, 0xd8]); };
  await assert.rejects(archiveFileWith(c, { from: '/Processed/b.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: 'T', shrink: true, shrinkFn: inPlace }), (err) => err.keepGoing === false);
  assert.equal(fs.readFileSync(at('Processed', 'b.jpg')).length, JPEG.length + 4);
  assert.deepEqual(names(at, 'Archive', '2026-04'), []);
  noClaimsLeft(at);
});

test('#11 an archiving retry finishes what the earlier try left instead of archiving the photo twice', async (t) => {
  const { c, at } = folder(t);
  const dir = '/Archive/2026-04';
  fs.mkdirSync(at('Archive', '2026-04'));
  const small = async () => Buffer.from([0xff, 0xd8]);
  // A move into the archive that stopped half way (both names one file, no summary yet), retried with shrinking on: no shrunk copy
  // beside the original, the move is finished and the summary written.
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  halfMove(at, ['Processed', 'a.jpg'], ['Archive', '2026-04', 'a.jpg']);
  const a = await archiveFileWith(c, { from: '/Processed/a.jpg', dir, summary: { applied: true }, at: 'T', shrink: true, shrinkFn: small, id: { key: '/Inbox/a.jpg@x' } });
  assert.equal(a.dest, `${dir}/a.jpg`);
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Archive', '2026-04'), ['a.jpg', 'a.jpg.json']);
  assert.equal(JSON.parse(fs.readFileSync(at('Archive', '2026-04', 'a.jpg.json'), 'utf8')).archived.key, '/Inbox/a.jpg@x');
  // The photo moved, then the try stopped before its summary: found again by the version in the state key, not called missing.
  fs.writeFileSync(at('Processed', 'b.jpg'), JPEG);
  const { etag } = await c.stat('/Processed/b.jpg');
  fs.renameSync(at('Processed', 'b.jpg'), at('Archive', '2026-04', 'b.jpg'));
  const b = await archiveFileWith(c, { from: '/Processed/b.jpg', dir, summary: { applied: true }, at: 'T', shrink: true, shrinkFn: small, id: { key: `/Inbox/b.jpg@${etag}` } });
  assert.deepEqual([b.dest, b.fileMissing], [`${dir}/b.jpg`, false]);
  assert.deepEqual(names(at, 'Archive', '2026-04').filter((n) => n.includes('b.jpg')), ['b.jpg', 'b.jpg.json']);
  // A shrunk copy and its summary are there, the original was not deleted yet: only the original goes.
  fs.writeFileSync(at('Processed', 'c.jpg'), JPEG);
  fs.writeFileSync(at('Archive', '2026-04', 'c.jpg'), Buffer.from([0xff, 0xd8]));
  const sha256 = crypto.createHash('sha256').update(JPEG).digest('hex'); // the note names its original (#1)
  fs.writeFileSync(at('Archive', '2026-04', 'c.jpg.json'), JSON.stringify({ archived: { key: '/Inbox/c.jpg@y', shrunk: { before: JPEG.length, after: 2, sha256 } } }));
  const cc = await archiveFileWith(c, { from: '/Processed/c.jpg', dir, summary: { applied: true }, at: 'T', shrink: true, shrinkFn: small, id: { key: '/Inbox/c.jpg@y' } });
  assert.deepEqual([cc.dest, cc.shrunk], [`${dir}/c.jpg`, { before: JPEG.length, after: 2 }]);
  assert.deepEqual(names(at, 'Processed'), []);
  assert.deepEqual(names(at, 'Archive', '2026-04').filter((n) => n.includes('c.jpg')), ['c.jpg', 'c.jpg.json']);
});

test('#10 requeue while a move of it stopped half way in another process: the inbox already has it, so the entry can be cleared', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Needs review', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Needs review/a.jpg');
  stoppedMove(at, { from: '/Needs review/a.jpg', to: '/Inbox/a.jpg', etag, linked: true, age: 1000 }); // still fresh: not settled yet
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg'), { inInbox: true });
  const [rec] = fs.readdirSync(at('.receipts-claims'));
  const json = JSON.parse(fs.readFileSync(at('.receipts-claims', rec), 'utf8'));
  fs.writeFileSync(at('.receipts-claims', rec), JSON.stringify({ ...json, at: 0 }));
  await c.recoverClaims();
  assert.deepEqual(names(at, 'Needs review'), []);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
  assert.equal((await c.stat('/Inbox/a.jpg')).etag, etag, 'the same key as its done entry: why that entry must be cleared');
  noClaimsLeft(at);
});

// ---- phase 4 ----

test('recoverClaims({ all: true }) settles every record, however young and whoever wrote it, and counts what it did; the default call is unchanged', async (t) => {
  const { c, at } = folder(t);
  for (const n of ['a.jpg', 'b.jpg']) fs.writeFileSync(at('Inbox', n), n);
  const ea = (await c.stat('/Inbox/a.jpg')).etag;
  const eb = (await c.stat('/Inbox/b.jpg')).etag;
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag: ea, linked: true, age: 1000 }); // fresh, another process
  stoppedMove(at, { from: '/Inbox/b.jpg', to: '/Processed/b.jpg', etag: eb, linked: false, age: 1000 });
  fs.writeFileSync(at('.receipts-claims', `${crypto.randomUUID()}.json`), '{not json'); // damaged: left for a person
  assert.equal(await c.recoverClaims(), 0, 'by default a fresh record of another process is left alone');
  assert.deepEqual(await c.recoverClaims({ all: true }), { finished: 1, undone: 1, remaining: 1 });
  assert.deepEqual(names(at, 'Inbox'), ['b.jpg']);
  assert.deepEqual(names(at, 'Processed'), ['a.jpg']);
  assert.equal(fs.readdirSync(at('.receipts-claims')).length, 1, 'only the damaged record is left');
  // Nothing (left) to settle.
  const empty = folder(t);
  assert.deepEqual(await empty.c.recoverClaims({ all: true }), { finished: 0, undone: 0, remaining: 0 });
});

test('#1 an archiving retry never deletes a same-size file that replaced the original the shrunk copy was made from', async (t) => {
  const { c, at } = folder(t);
  const dir = '/Archive/2026-04';
  fs.mkdirSync(at('Archive', '2026-04'));
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Processed/a.jpg');
  // The earlier try: its copy and note are there (made from this original), then it stopped before deleting the original.
  fs.writeFileSync(at('Archive', '2026-04', 'a.jpg'), Buffer.from([0xff, 0xd8]));
  const sha256 = crypto.createHash('sha256').update(JPEG).digest('hex');
  fs.writeFileSync(at('Archive', '2026-04', 'a.jpg.json'), JSON.stringify({ archived: { key: '/Inbox/a.jpg@k', shrunk: { before: JPEG.length, after: 2, sha256, etag } } }));
  // Meanwhile a sync tool put another photo of the very same size at the original's name.
  const other = Buffer.from(JPEG.map((b) => b ^ 1));
  fs.writeFileSync(at('Processed', 'new.jpg'), other);
  fs.renameSync(at('Processed', 'new.jpg'), at('Processed', 'a.jpg'));
  const out = await archiveFileWith(c, { from: '/Processed/a.jpg', dir, summary: { applied: true }, at: 'T', shrink: false, id: { key: '/Inbox/a.jpg@k' } });
  assert.notEqual(out.dest, `${dir}/a.jpg`);
  assert.deepEqual(fs.readFileSync(at(...out.dest.split('/').filter(Boolean))), other, 'archived as usual, beside the earlier copy');
  assert.deepEqual(fs.readFileSync(at('Archive', '2026-04', 'a.jpg')), Buffer.from([0xff, 0xd8]));
  // The same bytes as a new file (a copy, another inode) is not the original either: the local etag names the very file.
  fs.writeFileSync(at('Processed', 'b.jpg'), JPEG);
  fs.writeFileSync(at('Archive', '2026-04', 'b.jpg'), Buffer.from([0xff, 0xd8]));
  fs.writeFileSync(at('Archive', '2026-04', 'b.jpg.json'), JSON.stringify({ archived: { key: '/Inbox/b.jpg@k', shrunk: { before: JPEG.length, after: 2, sha256, etag: 'another-file' } } }));
  const b = await archiveFileWith(c, { from: '/Processed/b.jpg', dir, summary: { applied: true }, at: 'T', shrink: false, id: { key: '/Inbox/b.jpg@k' } });
  assert.notEqual(b.dest, `${dir}/b.jpg`);
  assert.deepEqual(fs.readFileSync(at(...b.dest.split('/').filter(Boolean))), JPEG);
  noClaimsLeft(at);
});

test('#5 a listing reads only the files asked for (etags), and none at all with etags: false', async (t) => {
  const { c, at } = folder(t);
  for (const n of ['a.jpg', 'notes.txt', 'b.pdf']) fs.writeFileSync(at('Inbox', n), n);
  const opened = [];
  onOpen(t, (p, flags) => flags === (constants.O_RDONLY | constants.O_NONBLOCK) && !p.endsWith('Inbox'), (fh, p) => (opened.push(path.basename(p)), fh));
  const plain = await c.getDirectoryContents('/Inbox', { etags: false });
  assert.deepEqual(plain.map((i) => [i.basename, i.etag, i.size, i.type]).sort(), [['a.jpg', null, 5, 'file'], ['b.pdf', null, 5, 'file'], ['notes.txt', null, 9, 'file']]);
  assert.deepEqual(opened, []);
  const some = await c.getDirectoryContents('/Inbox', { etags: (name) => /\.(jpg|pdf)$/.test(name) });
  assert.deepEqual(opened.sort(), ['a.jpg', 'b.pdf'], 'the .txt is never read');
  assert.equal(some.find((i) => i.basename === 'a.jpg').etag, (await c.stat('/Inbox/a.jpg')).etag);
  assert.equal(some.find((i) => i.basename === 'notes.txt').etag, null);
});

test('#5 #13 archiving lists the month folder by name only, reads no unrelated file, and a folder that can\'t be listed is an error', async (t) => {
  const { c, at } = folder(t);
  fs.mkdirSync(at('Archive', '2026-04'));
  for (let i = 0; i < 5; i++) fs.writeFileSync(at('Archive', '2026-04', `old-${i}.jpg`), `old ${i}`);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  const opened = [];
  onOpen(t, (p) => p.includes(`${path.sep}2026-04${path.sep}old-`), (fh, p) => (opened.push(path.basename(p)), fh));
  const out = await archiveFileWith(c, { from: '/Processed/a.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: 'T', shrink: false, id: { key: '/Inbox/a.jpg@k' } });
  assert.equal(out.dest, '/Archive/2026-04/a.jpg');
  assert.deepEqual(opened, [], 'no other archived photo is read');
  // The month folder can't be listed (a disk error): not taken as "nothing archived there"; nothing is moved.
  fs.writeFileSync(at('Processed', 'b.jpg'), JPEG);
  const readdir = fsp.readdir;
  t.after(() => { fsp.readdir = readdir; });
  fsp.readdir = async (p, ...rest) => (String(p).endsWith('2026-04') ? Promise.reject(fsError('EIO')) : readdir(p, ...rest));
  await assert.rejects(archiveFileWith(c, { from: '/Processed/b.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: 'T', shrink: false }), status(503));
  fsp.readdir = readdir;
  assert.deepEqual(names(at, 'Processed'), ['b.jpg']);
});

test('#6 requeue with the version meant: a photo hidden by a move under way in another process is never taken for another one in the inbox', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Needs review', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Needs review/a.jpg');
  // A fresh claim of the other process hides the review photo; a different photo sits at the inbox name.
  stoppedMove(at, { from: '/Needs review/a.jpg', to: '/Processed/a.jpg', etag, linked: false, age: 1000 });
  fs.writeFileSync(at('Inbox', 'a.jpg'), 'another photo');
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg', etag), { unsure: true }, 'neither place can be told: nothing is cleared');
  // Without the version (an older note) it was taken as "already in the inbox": the bug this fixes.
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg'), { inInbox: true });
  // Once the other process's claim is settled (here: old enough), the photo is back in review; the inbox name is taken.
  const [rec] = fs.readdirSync(at('.receipts-claims'));
  const json = JSON.parse(fs.readFileSync(at('.receipts-claims', rec), 'utf8'));
  fs.writeFileSync(at('.receipts-claims', rec), JSON.stringify({ ...json, at: 0 }));
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg', etag), { refused: 'exists' });
  assert.deepEqual(names(at, 'Needs review'), ['a.jpg']);
  // The very version in the inbox (a move to it stopped half way): that is "in the inbox".
  fs.rmSync(at('Inbox', 'a.jpg'));
  stoppedMove(at, { from: '/Needs review/a.jpg', to: '/Inbox/a.jpg', etag, linked: true, age: 1000 });
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg', etag), { inInbox: true });
});

test('#6 requeue with the version meant moves only that version: one changed in review since is left there', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Needs review', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Needs review/a.jpg');
  fs.appendFileSync(at('Needs review', 'a.jpg'), 'edited');
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg', etag), { refused: 'changed' });
  assert.deepEqual(names(at, 'Needs review'), ['a.jpg']);
  assert.deepEqual(names(at, 'Inbox'), []);
  const now = (await c.stat('/Needs review/a.jpg')).etag;
  assert.deepEqual(await requeue(c, '/Inbox', '/Needs review/a.jpg', 'a.jpg', now), { moved: '/Inbox/a.jpg' });
  noClaimsLeft(at);
});

test('#13 an older filing record without its destination: only files of that name are read to find it again', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  fs.renameSync(at('Inbox', 'a.jpg'), at('Processed', '17-a.jpg')); // moved before the record knew where
  for (let i = 0; i < 4; i++) fs.writeFileSync(at('Processed', `other-${i}.jpg`), `other ${i}`);
  const opened = [];
  onOpen(t, (p) => p.includes(`${path.sep}Processed${path.sep}`), (fh, p) => (opened.push(path.basename(p)), fh));
  const to = await resumeTransfer(c, { from: '/Inbox/a.jpg', dest: '/Processed/a.jpg', etag, summary: { ok: true } }, async () => {});
  assert.equal(to, '/Processed/17-a.jpg');
  assert.ok(opened.every((n) => n.includes('a.jpg')), `read: ${opened.join(', ')}`);
});

test('EPERM on move restores a visible receipt by exclusive copy and reports unsupported hard links', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  t.mock.method(fsp, 'link', async () => { throw fsError('EPERM'); });
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE), /hard links are unavailable/);
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG);
  assert.deepEqual(names(at, 'Processed'), []);
  noClaimsLeft(at);
});

test('restore with unsupported links never replaces an upload appearing at the old name', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const { etag } = await c.stat('/Inbox/a.jpg');
  stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag, linked: false });
  t.mock.method(fsp, 'link', async () => { throw fsError('EPERM'); });
  const copy = fsp.copyFile;
  let raced = false;
  t.mock.method(fsp, 'copyFile', async (src, dest, flags) => {
    assert.equal(flags, constants.COPYFILE_EXCL);
    if (!raced) { raced = true; fs.writeFileSync(dest, 'concurrent upload'); }
    return copy(src, dest, flags);
  });
  assert.equal((await c.recoverClaims({ all: true })).undone, 1);
  assert.equal(fs.readFileSync(at('Inbox', 'a.jpg'), 'utf8'), 'concurrent upload');
  const restored = names(at, 'Inbox').find((n) => n !== 'a.jpg');
  assert.deepEqual(fs.readFileSync(at('Inbox', restored)), JPEG);
  noClaimsLeft(at);
});

test('upload with EPERM uses a verified exclusive copy and refuses a taken name', async (t) => {
  const { c, at } = folder(t);
  t.mock.method(fsp, 'link', async () => { throw fsError('EPERM'); });
  await c.putFileContents('/Inbox/a.jpg', JPEG, { overwrite: false });
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG);
  await assert.rejects(c.putFileContents('/Inbox/a.jpg', 'other', { overwrite: false }), status(412));
  assert.deepEqual(fs.readFileSync(at('Inbox', 'a.jpg')), JPEG);
  assert.deepEqual(names(at, 'Inbox'), ['a.jpg']);
});

test('checkWritable probes hard links and cleans both names after EPERM', async (t) => {
  const { at } = folder(t);
  let probes = 0;
  t.mock.method(fsp, 'link', async () => { probes++; throw fsError('EPERM'); });
  await assert.rejects(checkWritable(at('Inbox')), /hard links.*EPERM.*FAT\/exFAT/);
  assert.equal(probes, 1);
  assert.deepEqual(fs.readdirSync(at('Inbox')), []);
});

test('claim record EACCES is logged and returned with its id and record filename', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const id = stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag: 'version', linked: false });
  const read = fsp.readFile;
  t.mock.method(fsp, 'readFile', async (p, ...args) => {
    if (String(p).endsWith(`${id}.json`)) throw fsError('EACCES');
    return read(p, ...args);
  });
  const messages = [];
  t.mock.method(console, 'log', (...args) => messages.push(args.join(' ')));
  const result = await c.recoverClaims({ all: true, details: true });
  assert.equal(result.remaining, 1);
  assert.equal(result.claims[0].id, id);
  assert.match(result.claims[0].file, new RegExp(`${id}.json`));
  assert.match(result.claims[0].reason, /EACCES/);
  assert.ok(messages.some((m) => m.includes(id) && m.includes(`${id}.json`) && m.includes('EACCES')));
});

test('failed restoration logs the hidden claim, original filename and reason', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  t.mock.method(fsp, 'link', async () => { throw fsError('EPERM'); });
  t.mock.method(fsp, 'copyFile', async () => { throw fsError('ENOSPC'); });
  const messages = [];
  t.mock.method(console, 'log', (...args) => messages.push(args.join(' ')));
  await assert.rejects(c.moveFile('/Inbox/a.jpg', '/Processed/a.jpg', NO_OVERWRITE));
  assert.ok(messages.some((m) => /unsettled local claim [0-9a-f-]+, file \/Inbox\/a.jpg/.test(m) && m.includes('ENOSPC') && m.includes('.claim-')));
  const result = await c.recoverClaims({ all: true, details: true });
  assert.equal(result.remaining, 1);
  assert.equal(result.claims[0].file, '/Inbox/a.jpg');
  assert.match(result.claims[0].reason, /ENOSPC/);
});

test('file data is synced before publication and the directory before PUT returns', async (t) => {
  const { c } = folder(t);
  const events = [];
  onOpen(t, () => true, (fh, p) => withMethod(fh, 'sync', async () => { events.push(`sync:${p}`); return fh.sync(); }));
  for (const method of ['link', 'rename']) {
    const real = fsp[method];
    t.mock.method(fsp, method, async (src, dest) => { events.push(`publish:${dest}`); return real(src, dest); });
  }
  for (const overwrite of [false, true]) {
    events.length = 0;
    await c.putFileContents('/Inbox/a.jpg', JPEG, { overwrite });
    const publish = events.findIndex((e) => e.startsWith('publish:'));
    assert.ok(events.slice(0, publish).some((e) => e.startsWith('sync:') && e.endsWith('.tmp')));
    assert.ok(events.slice(publish + 1).some((e) => e.startsWith('sync:') && e.endsWith('/Inbox')));
  }
});

test('restore also falls back safely for ENOTSUP and EXDEV', async (t) => {
  const { c, at } = folder(t);
  for (const code of ['ENOTSUP', 'EXDEV']) {
    const name = `${code}.jpg`;
    fs.writeFileSync(at('Inbox', name), JPEG);
    const { etag } = await c.stat(`/Inbox/${name}`);
    stoppedMove(at, { from: `/Inbox/${name}`, to: `/Processed/${name}`, etag, linked: false });
    const link = t.mock.method(fsp, 'link', async () => { throw fsError(code); });
    assert.equal((await c.recoverClaims({ all: true })).undone, 1);
    link.mock.restore();
    assert.deepEqual(fs.readFileSync(at('Inbox', name)), JPEG);
    noClaimsLeft(at);
  }
});

test('an unreadable claimed file remains recorded and recovery names its original', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Inbox', 'a.jpg'), JPEG);
  const id = stoppedMove(at, { from: '/Inbox/a.jpg', to: '/Processed/a.jpg', etag: 'version', linked: false });
  const lstat = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (p, ...args) => {
    if (String(p).endsWith(`.claim-${id}`)) throw fsError('EACCES');
    return lstat(p, ...args);
  });
  const result = await c.recoverClaims({ all: true, details: true });
  assert.equal(result.remaining, 1);
  assert.equal(result.claims[0].file, '/Inbox/a.jpg');
  assert.match(result.claims[0].reason, /EACCES/);
  assert.ok(fs.existsSync(at('.receipts-claims', `${id}.json`)));
});

test('shrinking syncs the published photo and directory before deleting the original', async (t) => {
  const { c, at } = folder(t);
  fs.writeFileSync(at('Processed', 'a.jpg'), JPEG);
  const events = [];
  onOpen(t, () => true, (fh, p) => withMethod(fh, 'sync', async () => { events.push(`sync:${p}`); return fh.sync(); }));
  const link = fsp.link;
  t.mock.method(fsp, 'link', async (src, dest) => { events.push(`link:${dest}`); return link(src, dest); });
  const originalDelete = c.deleteFile;
  t.mock.method(c, 'deleteFile', async (p, ...args) => { events.push(`delete:${p}`); return originalDelete(p, ...args); });
  await archiveFileWith(c, { from: '/Processed/a.jpg', dir: '/Archive/2026-04', summary: { applied: true }, at: 'T', shrink: true, shrinkFn: async () => Buffer.from([0xff, 0xd8]) });
  const published = events.findIndex((e) => e === `link:${at('Archive', '2026-04', 'a.jpg')}`);
  const removed = events.indexOf('delete:/Processed/a.jpg');
  assert.ok(published >= 0 && removed > published);
  assert.ok(events.slice(0, published).some((e) => e.startsWith('sync:') && e.includes('/Archive/2026-04/') && e.endsWith('.tmp')));
  assert.ok(events.slice(published + 1, removed).includes(`sync:${at('Archive', '2026-04')}`));
});

test('the worker startup listing and folder setup report unsupported hard links', async (t) => {
  const { root } = folder(t);
  t.mock.method(fsp, 'link', async () => { throw fsError('EPERM'); });
  await assert.rejects(localClient(root).getDirectoryContents('/Inbox'), /hard links are unavailable/);
  await assert.rejects(localClient(root).createDirectory('/Processed', { recursive: true }), /hard links are unavailable/);
});
