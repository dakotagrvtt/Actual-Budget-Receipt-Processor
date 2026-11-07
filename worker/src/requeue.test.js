// requeue.js (used by nextcloud.js requeueFromReview) with an in-memory stand-in for the WebDAV client. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { requeue, moveKeepingBoth, downloadListed, ifMatch, NO_OVERWRITE, isExists } from './requeue.js';
import { FileChangedError, isFileChanged } from './errors.js';

const requeueFromReview = (from, name, c) => requeue(c, config.nextcloud.inbox, from, name);

const inbox = config.nextcloud.inbox;
const review = config.nextcloud.review;

/** Files by path: { path: string contents }. Records moves and deletes. */
function fakeClient(files, failMove = null) {
  const log = [];
  const moveOptions = [];
  return {
    log,
    moveOptions,
    files,
    exists: async (p) => p in files,
    getFileContents: async (p) => {
      if (!(p in files)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return Buffer.from(files[p]);
    },
    moveFile: async (a, b, options) => {
      log.push(['move', a, b]);
      moveOptions.push(options);
      if (failMove) throw failMove;
      files[b] = files[a];
      delete files[a];
    },
    deleteFile: async (p) => {
      log.push(['delete', p]);
      if (!(p in files)) throw new Error('gone');
      delete files[p];
    },
  };
}
const summary = (o) => JSON.stringify({ file: 'r.jpg', plan: null, problems: ['x'], ...o });

test('requeueFromReview moves exactly the given path and deletes its summary', async () => {
  const exact = `${review}/1700000000000-r.jpg`;
  const c = fakeClient({ [exact]: 'new', [`${exact}.json`]: summary(), [`${review}/r.jpg`]: 'older one', [`${review}/r.jpg.json`]: summary() });
  const out = await requeueFromReview(exact, 'r.jpg', c);
  assert.deepEqual(out, { moved: `${inbox}/r.jpg` });
  assert.equal(c.files[`${inbox}/r.jpg`], 'new');
  assert.ok(`${review}/r.jpg` in c.files, 'the other file with a similar name was not touched');
  assert.ok(!(`${exact}.json` in c.files));
});

test('requeueFromReview refuses when the summary shows something was applied (plan.applied or alreadyApplied)', async () => {
  for (const s of [summary({ plan: { action: 'split', applied: true } }), summary({ alreadyApplied: true })]) {
    const from = `${review}/r.jpg`;
    const c = fakeClient({ [from]: 'x', [`${from}.json`]: s });
    assert.deepEqual(await requeueFromReview(from, 'r.jpg', c), { refused: 'applied' });
    assert.deepEqual(c.log, []);
  }
  // a plan that was not applied (sent to review without changes) is fine
  const from = `${review}/r.jpg`;
  const c = fakeClient({ [from]: 'x', [`${from}.json`]: summary({ plan: { action: 'split', applied: false } }) });
  assert.equal((await requeueFromReview(from, 'r.jpg', c)).moved, `${inbox}/r.jpg`);
});

test('requeueFromReview refuses an unreadable summary, and accepts a missing one', async () => {
  const from = `${review}/r.jpg`;
  const bad = fakeClient({ [from]: 'x', [`${from}.json`]: '{nope' });
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', bad), { refused: 'applied' });
  assert.deepEqual(bad.log, []);
  const none = fakeClient({ [from]: 'x' });
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', none), { moved: `${inbox}/r.jpg` });
});

test('requeueFromReview never renames: a same-named file in the inbox means refuse, nothing moved', async () => {
  const from = `${review}/r.jpg`;
  const c = fakeClient({ [from]: 'x', [`${from}.json`]: summary(), [`${inbox}/r.jpg`]: 'other' });
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', c), { refused: 'exists' });
  assert.deepEqual(c.log, []);
  assert.equal(c.files[`${inbox}/r.jpg`], 'other');
});

test('requeueFromReview: file gone from review -> inInbox if the inbox has it, else null', async () => {
  const from = `${review}/r.jpg`;
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', fakeClient({ [`${inbox}/r.jpg`]: 'x' })), { inInbox: true });
  assert.equal(await requeueFromReview(from, 'r.jpg', fakeClient({})), null);
});

test('every move asks the server not to overwrite (overwrite: false and the Overwrite: F header)', async () => {
  const from = `${review}/r.jpg`;
  const c = fakeClient({ [from]: 'x' });
  await requeueFromReview(from, 'r.jpg', c);
  assert.deepEqual(c.moveOptions, [NO_OVERWRITE]);
  assert.equal(NO_OVERWRITE.overwrite, false);
  assert.equal(NO_OVERWRITE.headers.Overwrite, 'F');
});

test('a 412 or 409 from the move (a file appeared in the inbox since the check) is refused as "exists"; other errors are thrown', async () => {
  const from = `${review}/r.jpg`;
  for (const status of [412, 409]) {
    const c = fakeClient({ [from]: 'x', [`${from}.json`]: summary() }, Object.assign(new Error('exists'), { status }));
    assert.deepEqual(await requeueFromReview(from, 'r.jpg', c), { refused: 'exists' }, String(status));
    assert.ok(`${from}.json` in c.files, 'the summary stays');
  }
  const wrapped = fakeClient({ [from]: 'x' }, Object.assign(new Error('exists'), { response: { status: 412 } }));
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', wrapped), { refused: 'exists' });
  const down = fakeClient({ [from]: 'x' }, Object.assign(new Error('server error'), { status: 500 }));
  await assert.rejects(requeueFromReview(from, 'r.jpg', down), /server error/);
  assert.equal(isExists(new Error('x')), false);
});

test('a summary that says applied: true (the give-up summary) also blocks requeueing', async () => {
  const from = `${review}/r.jpg`;
  const c = fakeClient({ [from]: 'x', [`${from}.json`]: summary({ applied: true, plan: null }) });
  assert.deepEqual(await requeueFromReview(from, 'r.jpg', c), { refused: 'applied' });
  assert.deepEqual(c.log, []);
});

test('moveKeepingBoth: moves to dest; if the server says dest exists, uses the other name; never overwrites', async () => {
  const c = fakeClient({ '/a/r.jpg': 'x' });
  assert.equal(await moveKeepingBoth(c, '/a/r.jpg', '/p/r.jpg', '/p/1-r.jpg'), '/p/r.jpg');
  assert.deepEqual(c.moveOptions, [NO_OVERWRITE]);
  let first = true;
  const racing = { ...fakeClient({ '/a/r.jpg': 'x' }), moveFile: async (a, b, o) => {
    assert.equal(o, NO_OVERWRITE);
    if (first) { first = false; throw Object.assign(new Error('Precondition Failed'), { status: 412 }); }
    racing.moved = [a, b];
  } };
  assert.equal(await moveKeepingBoth(racing, '/a/r.jpg', '/p/r.jpg', '/p/1-r.jpg'), '/p/1-r.jpg');
  assert.deepEqual(racing.moved, ['/a/r.jpg', '/p/1-r.jpg']);
  const down = fakeClient({}, Object.assign(new Error('boom'), { status: 500 }));
  await assert.rejects(moveKeepingBoth(down, '/a', '/b', '/c'), /boom/);
});

/** A WebDAV server with etags that answers 412 to a GET or MOVE whose If-Match is not the file's current etag (and to a MOVE onto an existing file with Overwrite: F). */
function etagServer(files) {
  const moves = [];
  const check = (p, headers = {}) => {
    if (!(p in files)) throw Object.assign(new Error('Not Found'), { status: 404 });
    if (headers['If-Match'] && headers['If-Match'] !== `"${files[p].etag}"`) throw Object.assign(new Error('Precondition Failed'), { status: 412 });
  };
  return {
    files,
    moves,
    getFileContents: async (p, o = {}) => { check(p, o.headers); return Buffer.from(files[p].body); },
    moveFile: async (a, b, o = {}) => {
      check(a, o.headers);
      if (b in files && o.headers?.Overwrite === 'F') throw Object.assign(new Error('Precondition Failed'), { status: 412 });
      moves.push([a, b]);
      files[b] = files[a];
      delete files[a];
    },
  };
}

test('ifMatch: the listed etag, quoted once; nothing without one', () => {
  assert.deepEqual(ifMatch('abc'), { 'If-Match': '"abc"' });
  assert.deepEqual(ifMatch('"abc"'), { 'If-Match': '"abc"' });
  assert.deepEqual(ifMatch('W/"abc"'), { 'If-Match': '"abc"' });
  assert.deepEqual(ifMatch(null), {});
  assert.deepEqual(ifMatch(undefined), {});
});

test('downloadListed: reads the listed version; a file replaced under the same name is a FileChangedError and nothing is read', async () => {
  const s = etagServer({ '/in/r.jpg': { body: 'A', etag: 'ea' } });
  const item = { filename: '/in/r.jpg', basename: 'r.jpg', etag: 'ea' };
  assert.equal((await downloadListed(s, item)).toString(), 'A');
  s.files['/in/r.jpg'] = { body: 'B', etag: 'eb' };
  await assert.rejects(downloadListed(s, item), (err) => err instanceof FileChangedError && isFileChanged(err));
  assert.equal((await downloadListed(s, { ...item, etag: 'eb' })).toString(), 'B'); // the new version, listed on its own
  // other failures pass through unchanged
  await assert.rejects(downloadListed(s, { ...item, filename: '/in/gone.jpg' }), (err) => err.status === 404 && !isFileChanged(err));
  // a listing without an etag sends no condition
  assert.equal((await downloadListed(s, { ...item, etag: undefined })).toString(), 'B');
});

test('moveKeepingBoth with an etag: moves the listed version only; a replaced file stays where it is', async () => {
  const s = etagServer({ '/in/r.jpg': { body: 'A', etag: 'ea' } });
  assert.equal(await moveKeepingBoth(s, '/in/r.jpg', '/p/r.jpg', '/p/1-r.jpg', 'ea'), '/p/r.jpg');
  // the name is taken (412 from Overwrite: F) and the file is the listed one: the other name
  const t = etagServer({ '/in/r.jpg': { body: 'A', etag: 'ea' }, '/p/r.jpg': { body: 'old', etag: 'x' } });
  assert.equal(await moveKeepingBoth(t, '/in/r.jpg', '/p/r.jpg', '/p/1-r.jpg', 'ea'), '/p/1-r.jpg');
  assert.equal(t.files['/p/r.jpg'].body, 'old');
  // replaced meanwhile: nothing moves, with the name free or taken
  for (const taken of [false, true]) {
    const u = etagServer({ '/in/r.jpg': { body: 'B', etag: 'eb' }, ...(taken ? { '/p/r.jpg': { body: 'old', etag: 'x' } } : {}) });
    await assert.rejects(moveKeepingBoth(u, '/in/r.jpg', '/p/r.jpg', '/p/1-r.jpg', 'ea'), (err) => err instanceof FileChangedError);
    assert.deepEqual(u.moves, []);
    assert.equal(u.files['/in/r.jpg'].body, 'B');
  }
  // without an etag the move is not conditional
  const v = etagServer({ '/in/r.jpg': { body: 'B', etag: 'eb' } });
  assert.equal(await moveKeepingBoth(v, '/in/r.jpg', '/p/r.jpg', '/p/1-r.jpg'), '/p/r.jpg');
});
