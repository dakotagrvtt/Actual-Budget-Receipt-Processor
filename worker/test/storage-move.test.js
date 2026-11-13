// Folder moves in the same storage, cancel, vanished sources, the migration lock, the storage marker and the CLI. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localClient } from '../src/local-files.js';
import { migrateStorage, moveFolders, cancelMigration, folderMoveProblem } from '../src/migrate-storage.js';
import { config, defaultFolders } from '../src/config.js';
import { writeRecord, readRecord, storageFile, storageIdentity, recordedStorage, verifyStorageMarker, assertStorage, readMarker, writeMarker, clearMarkerProblem, hostDirOf } from '../src/storage-state.js';
import { main } from '../src/migrate-storage-cli.js';
import * as settings from '../src/panel-settings.js';

const local = defaultFolders(true);
async function seed(c, p, bytes = 'made-up photo') {
  await c.createDirectory(path.posix.dirname(p), { recursive: true });
  await c.putFileContents(p, bytes);
}
const text = async (c, p) => Buffer.from(await c.getFileContents(p)).toString();
async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-move-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
/** config pointed at a temp data dir and a local storage; restored after the test. */
async function useConfig(t, { kind = 'local', folders = local } = {}) {
  const dir = await tempRoot(t);
  const saved = { statePath: config.statePath, storage: config.storage, nextcloud: { ...config.nextcloud }, dryRun: config.dryRun, webSettingsPath: config.webSettingsPath };
  await fs.mkdir(path.join(dir, 'data')); await fs.mkdir(path.join(dir, 'files'));
  config.statePath = path.join(dir, 'data', 'state.json');
  config.webSettingsPath = path.join(dir, 'data', 'web-settings.json');
  config.storage = { kind, root: path.join(dir, 'files'), hostDir: path.join(dir, 'files') };
  Object.assign(config.nextcloud, folders);
  config.dryRun = false;
  clearMarkerProblem();
  t.after(() => { Object.assign(config, { ...saved, nextcloud: Object.assign(config.nextcloud, saved.nextcloud) }); clearMarkerProblem(); });
  return { dir, files: path.join(dir, 'files'), client: localClient(path.join(dir, 'files')) };
}

test('same storage, folders swapped and nested: files move in place, state and summaries follow, staging is removed', async (t) => {
  const { client } = await useConfig(t);
  const from = { kind: 'local', location: { hostDir: '/x' }, folders: local };
  // processed moves INSIDE the old inbox, review and archive swap places.
  const to = { kind: 'local', location: { hostDir: '/x' }, folders: { inbox: '/Inbox', processed: '/Inbox/Done', review: '/Archive', archive: '/Needs review' } };
  await seed(client, '/Processed/a.jpg', 'photo a');
  await seed(client, '/Processed/a.jpg.json', JSON.stringify({ file: 'a.jpg', problems: [] }));
  await seed(client, '/Needs review/b.jpg', 'photo b');
  await seed(client, '/Archive/2026-01/c.jpg', 'photo c');
  await seed(client, '/Archive/2026-01/c.jpg.json', JSON.stringify({ file: 'c.jpg', archived: { at: '2026-01-02T00:00:00Z', from: '/Processed/c.jpg', key: '/Inbox/c.jpg@e1', txnId: 'made-up', shrunk: null } }));
  await seed(client, '/Inbox/new.jpg', 'waiting');
  const etagA = (await client.stat('/Processed/a.jpg')).etag;
  const state = {
    '/Inbox/a.jpg@ka': { done: true, filedAs: '/Processed/a.jpg' },
    '/Inbox/b.jpg@kb': { done: true, filedAs: '/Needs review/b.jpg' },
    '/Inbox/c.jpg@e1': { done: true, filedAs: '/Archive/2026-01/c.jpg', archived: { at: '2026-01-02T00:00:00Z', folder: '/Archive', restoreTo: 'processed', shrunk: { before: 1, after: 1 } } },
  };
  let journal = null, committed = null;
  const result = await moveFolders({ client, from, to, state, journal, checkpoint: async (j) => { journal = structuredClone(j); }, commit: async (s) => { committed = s; } });
  assert.equal(result.phase, 'complete');
  assert.equal(await text(client, '/Inbox/Done/a.jpg'), 'photo a');
  assert.equal(await text(client, '/Archive/b.jpg'), 'photo b');
  assert.equal(await text(client, '/Needs review/2026-01/c.jpg'), 'photo c');
  assert.equal(await text(client, '/Inbox/new.jpg'), 'waiting', 'an unmoved file stays');
  assert.equal(await client.exists('/Processed/a.jpg'), false);
  assert.equal(committed['/Inbox/a.jpg@ka'].filedAs, '/Inbox/Done/a.jpg');
  assert.equal(committed['/Inbox/b.jpg@kb'].filedAs, '/Archive/b.jpg');
  assert.equal(committed['/Inbox/c.jpg@e1'].archived.folder, '/Needs review');
  const sidecar = JSON.parse(await text(client, '/Needs review/2026-01/c.jpg.json'));
  assert.equal(sidecar.archived.from, '/Inbox/Done/c.jpg');
  assert.equal(sidecar.archived.key, '/Inbox/c.jpg@e1');
  assert.equal((await client.stat('/Inbox/Done/a.jpg')).etag, etagA, 'a move keeps the version');
  const top = (await client.getDirectoryContents('/')).map((i) => path.posix.basename(i.filename));
  assert.ok(!top.some((n) => n.startsWith('.receipts-move-')), `staging removed: ${top}`);
});

test('folder moves that cannot be told apart are refused before anything moves', () => {
  assert.match(folderMoveProblem({ ...local, inbox: '/' }, { ...local, inbox: '/In' }), /whole storage/);
  assert.match(folderMoveProblem({ ...local, review: '/Processed' }, { ...local, review: '/Look' }), /same folder/);
  assert.equal(folderMoveProblem(local, { ...local, inbox: '/Scans' }), null);
});

test('a folder move that has started only goes forward: cancel is refused, and a re-run finishes it', async (t) => {
  const { client } = await useConfig(t);
  const from = { kind: 'local', location: { hostDir: '/x' }, folders: local };
  const to = { kind: 'local', location: { hostDir: '/x' }, folders: { ...local, processed: '/Done' } };
  for (const n of ['a', 'b', 'c']) await seed(client, `/Processed/${n}.jpg`, `photo ${n}`);
  let journal, stops = 0;
  const checkpoint = async (j) => { journal = structuredClone(j); if (j.moves?.filter((m) => m.stage === 'staged').length === 1 && stops++ === 0) throw new Error('made-up stop'); };
  await assert.rejects(moveFolders({ client, from, to, state: {}, journal: null, checkpoint, commit: async () => assert.fail('no commit') }), /made-up stop/);
  assert.equal(journal.phase, 'moving');
  const before = structuredClone(journal);
  await assert.rejects(cancelMigration({ journal, client }), /can't be cancelled: 1 file\(s\) have moved already[\s\S]*only goes forward/);
  assert.deepEqual(journal, before, 'the journal is kept as it was');
  assert.equal(await client.exists('/Processed/a.jpg'), false, 'nothing was moved back');
  let committed;
  await moveFolders({ client, from, to, state: {}, journal, checkpoint: async (j) => { journal = structuredClone(j); }, commit: async (s) => { committed = s; } });
  assert.ok(committed);
  for (const n of ['a', 'b', 'c']) assert.equal(await text(client, `/Done/${n}.jpg`), `photo ${n}`);
  // Committing is never cancelled.
  await assert.rejects(cancelMigration({ journal: { ...journal, phase: 'committing' }, client }), /can't be cancelled/);
});

test('folder move cancel: allowed while nothing moved; refused when a planned file is already in staging or gone from its old place', async (t) => {
  const { client } = await useConfig(t);
  const from = { kind: 'local', location: { hostDir: '/x' }, folders: local };
  const to = { kind: 'local', location: { hostDir: '/x' }, folders: { ...local, processed: '/Done' } };
  for (const n of ['a', 'b']) await seed(client, `/Processed/${n}.jpg`, `photo ${n}`);
  let journal;
  // Stopped right after the plan was recorded, before any move.
  const stopFirst = async (j) => { journal = structuredClone(j); throw new Error('made-up stop'); };
  await assert.rejects(moveFolders({ client, from, to, state: {}, journal: null, checkpoint: stopFirst, commit: async () => assert.fail('no commit') }), /made-up stop/);
  assert.ok(journal.moves.every((m) => m.stage === 'planned'));
  // A planned entry whose file already sits in staging (moved, checkpoint lost): a file has moved.
  const [m] = journal.moves;
  await client.createDirectory(path.posix.dirname(m.staged), { recursive: true });
  await client.moveFile(m.from, m.staged);
  await assert.rejects(cancelMigration({ journal, client }), /staging folder[\s\S]*holds/);
  // Forward resume picks it up as staged and finishes.
  let committed;
  await moveFolders({ client, from, to, state: {}, journal: structuredClone(journal), checkpoint: async () => {}, commit: async (s) => { committed = s; } });
  assert.ok(committed);
  for (const n of ['a', 'b']) assert.equal(await text(client, `/Done/${n}.jpg`), `photo ${n}`);
  assert.equal(await client.exists('/Processed'), false, 'the emptied old folder is removed');

  // A fresh plan, nothing moved: cancel works and removes the empty staging folder.
  await client.createDirectory('/Processed', { recursive: true });
  for (const n of ['a', 'b']) { await client.moveFile(`/Done/${n}.jpg`, `/Processed/${n}.jpg`); }
  await assert.rejects(moveFolders({ client, from, to, state: {}, journal: null, checkpoint: stopFirst, commit: async () => assert.fail('no commit') }), /made-up stop/);
  await client.createDirectory(path.posix.join(journal.staging, 'processed'), { recursive: true });
  assert.equal(await cancelMigration({ journal, client }), 0);
  assert.equal(await client.exists(journal.staging), false, 'the empty staging folder is removed');
  for (const n of ['a', 'b']) assert.equal(await text(client, `/Processed/${n}.jpg`), `photo ${n}`);
  // A planned source that is no longer at its old place: refused.
  await client.deleteFile('/Processed/b.jpg');
  await assert.rejects(cancelMigration({ journal, client }), /\/Processed\/b\.jpg is no longer at its old place/);
});

/** One folder move with a name clash, a photo and its summary, and an archived summary that is rewritten. */
async function moveScene(client) {
  await seed(client, '/Processed/a.jpg', 'photo a');
  await seed(client, '/Processed/a.jpg.json', JSON.stringify({ file: 'a.jpg', problems: [] }));
  await seed(client, '/Processed/b.jpg', 'photo b');
  await seed(client, '/Archive/2026-01/c.jpg', 'photo c');
  await seed(client, '/Archive/2026-01/c.jpg.json', JSON.stringify({ file: 'c.jpg', archived: { at: '2026-01-02T00:00:00Z', from: '/Processed/c.jpg', key: '/Inbox/c.jpg@e1', txnId: 'made-up', shrunk: null } }));
  await seed(client, '/Done/a.jpg', 'someone else'); // already at a's new place: a is renamed, its summary follows
  return {
    from: { kind: 'local', location: { hostDir: '/x' }, folders: local },
    to: { kind: 'local', location: { hostDir: '/x' }, folders: { ...local, processed: '/Done', archive: '/Old' } },
    state: {
      '/Inbox/a.jpg@ka': { done: true, filedAs: '/Processed/a.jpg' },
      '/Inbox/b.jpg@kb': { done: true, filedAs: '/Processed/b.jpg' },
      '/Inbox/c.jpg@e1': { done: true, filedAs: '/Archive/2026-01/c.jpg', archived: { at: '2026-01-02T00:00:00Z', folder: '/Archive', restoreTo: 'processed', shrunk: null } },
    },
  };
}
async function checkMoved(client, committed) {
  const a = committed['/Inbox/a.jpg@ka'].filedAs;
  assert.match(a, /^\/Done\/.+-a\.jpg$/);
  assert.equal(await text(client, a), 'photo a');
  assert.equal(JSON.parse(await text(client, `${a}.json`)).file, 'a.jpg');
  assert.equal(await text(client, '/Done/a.jpg'), 'someone else');
  assert.equal(committed['/Inbox/b.jpg@kb'].filedAs, '/Done/b.jpg');
  assert.equal(await text(client, '/Done/b.jpg'), 'photo b');
  assert.equal(committed['/Inbox/c.jpg@e1'].filedAs, '/Old/2026-01/c.jpg');
  assert.equal(committed['/Inbox/c.jpg@e1'].archived.folder, '/Old');
  assert.equal(JSON.parse(await text(client, '/Old/2026-01/c.jpg.json')).archived.from, '/Done/c.jpg');
  for (const p of ['/Processed/a.jpg', '/Processed/a.jpg.json', '/Processed/b.jpg', '/Archive/2026-01/c.jpg']) assert.equal(await client.exists(p), false, p);
  const top = (await client.getDirectoryContents('/')).map((i) => path.posix.basename(i.filename));
  assert.ok(!top.some((n) => n.startsWith('.receipts-move-')), `staging removed: ${top}`);
}
/** Runs the move with one fault, then resumes from the last saved journal (as a re-run of the command would) until it is done. */
async function moveWithFault(t, fault) {
  const { client } = await useConfig(t);
  const { from, to, state } = await moveScene(client);
  let saved = null, committed = null, dead = false, n = 0;
  const realMove = client.moveFile.bind(client);
  client.moveFile = async (...a) => {
    await realMove(...a);
    if (fault.move === ++n) { dead = true; throw new Error('made-up crash after the move'); }
  };
  let checkpoints = 0;
  const checkpoint = async (j) => {
    if (dead || fault.checkpoint === ++checkpoints) { dead = true; throw new Error('made-up crash before the checkpoint'); }
    saved = structuredClone(j);
  };
  const commit = async (s) => { if (fault.commit) { dead = true; throw new Error('made-up crash in commit'); } committed = structuredClone(s); };
  let crashed = false;
  try { await moveFolders({ client, from, to, state, journal: null, checkpoint, commit }); }
  catch (err) { assert.match(err.message, /made-up crash/); crashed = true; }
  client.moveFile = realMove;
  for (let runs = 0; saved?.phase !== 'complete'; runs++) {
    assert.ok(runs < 3, 'finishes on a re-run');
    if (saved) {
      // Cancel is allowed only while nothing moved: still moving, every entry planned, every file at its old place.
      let untouched = saved.phase === 'moving' && saved.moves.every((m) => m.stage === 'planned');
      for (const m of untouched ? saved.moves : []) untouched &&= await client.exists(m.from);
      if (!untouched) await assert.rejects(cancelMigration({ journal: saved, client }), /can't be cancelled/);
      else { assert.equal(await cancelMigration({ journal: saved, client }), 0); saved = null; } // cancelled: the next run plans again
    }
    await moveFolders({ client, from, to, state, journal: saved && structuredClone(saved), checkpoint: async (j) => { saved = structuredClone(j); }, commit: async (s) => { committed = structuredClone(s); } });
  }
  return { client, committed, crashed };
}

test('folder move: a crash right after each move, before its checkpoint, is finished by a re-run', async (t) => {
  // 5 files are staged and then placed (a.jpg, a.jpg.json, b.jpg, the archive photo and summary): 10 moves in all.
  for (let move = 1; move <= 10; move++) {
    await t.test(`crash after move ${move}`, async (t) => {
      const { client, committed, crashed } = await moveWithFault(t, { move });
      assert.ok(crashed);
      await checkMoved(client, committed);
    });
  }
});

test('folder move: a crash at each checkpoint (staging, placing, renames, summaries, commit) is finished by a re-run', async (t) => {
  let count = 0;
  { // Count the checkpoints of a run without faults.
    const { client } = await useConfig(t);
    const { from, to, state } = await moveScene(client);
    let committed;
    await moveFolders({ client, from, to, state, journal: null, checkpoint: async () => { count++; }, commit: async (s) => { committed = s; } });
    await checkMoved(client, committed);
  }
  assert.ok(count > 12, `${count} checkpoints`);
  for (let checkpoint = 1; checkpoint <= count; checkpoint++) {
    await t.test(`crash at checkpoint ${checkpoint}`, async (t) => {
      const { client, committed, crashed } = await moveWithFault(t, { checkpoint });
      assert.ok(crashed);
      await checkMoved(client, committed);
    });
  }
  await t.test('crash in commit', async (t) => {
    const { client, committed, crashed } = await moveWithFault(t, { commit: true });
    assert.ok(crashed);
    await checkMoved(client, committed);
  });
});

test('copy mode: a source that vanishes after it was copied loses its copy and its entry; cancel removes only our copies', async (t) => {
  const { dir } = await useConfig(t);
  await fs.mkdir(path.join(dir, 'old')); await fs.mkdir(path.join(dir, 'new'));
  const source = localClient(path.join(dir, 'old')), destination = localClient(path.join(dir, 'new'));
  const from = { kind: 'local', location: { hostDir: '/old' }, folders: local }, to = { kind: 'local', location: { hostDir: '/new' }, folders: local };
  await seed(source, '/Processed/a.jpg', 'photo a');
  await seed(source, '/Processed/gone.jpg', 'photo gone');
  let removed = false, journal;
  const put = destination.putFileContents.bind(destination);
  destination.putFileContents = async (...args) => {
    await put(...args);
    if (!removed && args[0] === '/Processed/gone.jpg') { removed = true; await source.deleteFile('/Processed/gone.jpg'); }
  };
  let next;
  await migrateStorage({ source, destination, from, to, state: {}, checkpoint: async (j) => { journal = structuredClone(j); }, commit: async (s) => { next = s; } });
  assert.ok(next);
  assert.equal(await destination.exists('/Processed/gone.jpg'), false, 'the copy of a vanished source is removed');
  assert.deepEqual(journal.copies.map((c) => c.from), ['/Processed/a.jpg']);

  // Cancel of an unfinished copy: our copy goes, a file someone else put there stays.
  await seed(destination, '/Inbox/theirs.jpg', 'not ours');
  const left = await cancelMigration({ journal: { mode: 'copy', phase: 'copying', copies: [...journal.copies, { from: '/Inbox/theirs.jpg', to: '/Inbox/theirs.jpg', hash: 'ff' }] }, destination });
  assert.equal(left, 0, 'a file that is not ours is left, not counted as a failed removal');
  assert.equal(await destination.exists('/Processed/a.jpg'), false);
  assert.equal(await text(destination, '/Inbox/theirs.jpg'), 'not ours');
});

test('copy mode: an earlier copy of a source that changed is replaced, not left behind', async (t) => {
  const { dir } = await useConfig(t);
  await fs.mkdir(path.join(dir, 'old')); await fs.mkdir(path.join(dir, 'new'));
  const source = localClient(path.join(dir, 'old')), destination = localClient(path.join(dir, 'new'));
  const from = { kind: 'local', location: { hostDir: '/old' }, folders: local }, to = { kind: 'local', location: { hostDir: '/new' }, folders: local };
  await seed(source, '/Inbox/a.jpg', 'first');
  let changed = false;
  const put = destination.putFileContents.bind(destination);
  destination.putFileContents = async (...args) => {
    await put(...args);
    if (!changed) { changed = true; await source.deleteFile('/Inbox/a.jpg'); await seed(source, '/Inbox/a.jpg', 'second version'); }
  };
  const j = await migrateStorage({ source, destination, from, to, state: {}, checkpoint: async () => {}, commit: async () => {} });
  assert.equal(j.copies.length, 1);
  assert.equal(await text(destination, j.copies[0].to), 'second version');
  const names = (await destination.getDirectoryContents('/Inbox')).map((i) => path.posix.basename(i.filename));
  assert.deepEqual(names, [path.posix.basename(j.copies[0].to)], 'only one copy is left');
});

test('copy mode: state naming files outside the old folders refuses (wrong old folder settings), stale ones only warn', async (t) => {
  const { dir } = await useConfig(t);
  await fs.mkdir(path.join(dir, 'old')); await fs.mkdir(path.join(dir, 'new'));
  const source = localClient(path.join(dir, 'old')), destination = localClient(path.join(dir, 'new'));
  const from = { kind: 'local', location: { hostDir: '/old' }, folders: local }, to = { kind: 'local', location: { hostDir: '/new' }, folders: local };
  await seed(source, '/Receipts/Processed/a.jpg', 'photo a'); // where the receipts really are: not in the old folder settings
  let committed = false;
  const args = { source, destination, from, to, checkpoint: async () => {}, commit: async () => { committed = true; } };
  await assert.rejects(migrateStorage({ ...args, state: { '/Receipts/Inbox/a.jpg@e': { done: true, filedAs: '/Receipts/Processed/a.jpg' } } }), /old folder settings look wrong/);
  assert.equal(committed, false);
  const lines = [];
  await migrateStorage({ ...args, state: { '/Inbox/gone.jpg@e': { done: true, filedAs: '/Processed/gone.jpg' } }, log: (m) => lines.push(m) });
  assert.equal(committed, true);
  assert.ok(lines.some((l) => /already gone/.test(l)));
});

test('a damaged summary is named and copied byte for byte', async (t) => {
  const { dir } = await useConfig(t);
  await fs.mkdir(path.join(dir, 'old')); await fs.mkdir(path.join(dir, 'new'));
  const source = localClient(path.join(dir, 'old')), destination = localClient(path.join(dir, 'new'));
  await seed(source, '/Processed/a.jpg', 'photo a');
  await seed(source, '/Processed/a.jpg.json', '{"file": "a.jpg", broken');
  const lines = [];
  await migrateStorage({ source, destination, from: { kind: 'local', location: { hostDir: '/old' }, folders: local }, to: { kind: 'local', location: { hostDir: '/new' }, folders: local }, state: {}, checkpoint: async () => {}, commit: async () => {}, log: (m) => lines.push(m) });
  assert.equal(await text(destination, '/Processed/a.jpg.json'), '{"file": "a.jpg", broken');
  assert.ok(lines.some((l) => l.includes('/Processed/a.jpg.json') && /not valid JSON/.test(l)));
});

test('the marker: the same storage at a new path is recognized; an empty folder pauses; an upgrade records one quietly', async (t) => {
  const { dir, client } = await useConfig(t);
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  // Upgrade: a record without a marker gets one, written to the storage.
  await writeRecord(storageFile('storage.json'), storageIdentity());
  assert.equal(await verifyStorageMarker(client), 'recorded');
  const id = (await recordedStorage()).marker;
  assert.equal(await readMarker(client), id);
  await assertStorage();

  // The folder moved: same marker at a new path. The record follows by itself.
  const moved = path.join(dir, 'moved');
  await fs.rename(config.storage.root, moved);
  config.storage = { ...config.storage, root: moved, hostDir: moved };
  await assert.rejects(assertStorage(), { code: 'STORAGE_MIGRATION_REQUIRED' });
  assert.equal(await verifyStorageMarker(localClient(moved)), 'moved');
  await assertStorage();
  assert.equal((await recordedStorage()).location.hostDir, moved);

  // An empty (unmounted) folder at the recorded path: no marker while state has receipts. Paused, nothing written there.
  await fs.rename(moved, path.join(dir, 'away')); await fs.mkdir(moved);
  assert.equal(await verifyStorageMarker(localClient(moved)), 'missing');
  await assert.rejects(assertStorage(), /looks empty, not mounted/);
  assert.equal(await readMarker(localClient(moved)), null);
  // Back in place: the pause lifts at the next check.
  await fs.rm(moved, { recursive: true }); await fs.rename(path.join(dir, 'away'), moved);
  assert.equal(await verifyStorageMarker(localClient(moved)), 'same');
  await assertStorage();

  // Another install's storage (a different marker) pauses too.
  await fs.rm(path.join(moved, '.receipts-storage-id'));
  await writeMarker(localClient(moved));
  assert.equal(await verifyStorageMarker(localClient(moved)), 'other');
  await assert.rejects(assertStorage(), /another install/);
});

test('RECEIPTS_HOST_DIR is used only while it names RECEIPTS_DIR', () => {
  assert.equal(hostDirOf({ hostDir: './receipt-files' }, { RECEIPTS_HOST_DIR: '/home/someone/pipeline/receipt-files' }), '/home/someone/pipeline/receipt-files');
  assert.equal(hostDirOf({ hostDir: './other' }, { RECEIPTS_HOST_DIR: '/home/someone/pipeline/receipt-files' }), 'project:other');
  assert.equal(hostDirOf({ hostDir: '/srv/receipts' }, { RECEIPTS_HOST_DIR: '/home/someone/pipeline/receipt-files' }), '/srv/receipts');
});

// ---- The command ----
const quiet = () => {};
async function cli(t, argv, clients, lines = []) {
  return main(argv, { clientFor: async (identity) => clients(identity), out: (l) => lines.push(l), verifyStopped: async () => {} });
}

test('CLI: nothing to migrate, --remember, a folder change moved in place, and --cancel with nothing pending', async (t) => {
  const { client } = await useConfig(t);
  const lines = [];
  const clients = () => client;
  await fs.writeFile(config.statePath, '{}');
  await writeRecord(storageFile('storage.json'), storageIdentity());
  await cli(t, [], clients, lines);
  assert.match(lines.at(-1), /Nothing to migrate/);
  await cli(t, ['--cancel'], clients, lines);
  assert.match(lines.at(-1), /Nothing to cancel/);
  await cli(t, ['--remember'], clients, lines);
  assert.match(lines.at(-1), /No existing receipts/);
  await seed(client, '/Processed/a.jpg', 'photo a');
  await cli(t, ['--remember'], clients, lines);
  assert.match(lines.at(-1), /Existing receipts found/);

  // The processed folder changes in the settings: the CLI sees the same storage and moves the files in place.
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  config.nextcloud.processed = '/Filed';
  await cli(t, [], clients, lines);
  assert.match(lines.at(-1), /moved in place/);
  assert.equal(await text(client, '/Filed/a.jpg'), 'photo a');
  assert.equal(JSON.parse(await fs.readFile(config.statePath, 'utf8'))['/Inbox/a.jpg@e'].filedAs, '/Filed/a.jpg');
  assert.equal(await readRecord(storageFile('storage-migration.json')), null, 'the finished journal is removed');
  const rec = await recordedStorage();
  assert.equal(rec.folders.processed, '/Filed');
  assert.ok(rec.marker);
  await assertStorage();
});

test('CLI: a copy to another folder, cancelled half way; switching back discards the unfinished run by itself', async (t) => {
  const { dir, client: oldClient } = await useConfig(t);
  const newRoot = path.join(dir, 'new'); await fs.mkdir(newRoot);
  const newClient = localClient(newRoot);
  await seed(oldClient, '/Processed/a.jpg', 'photo a');
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), storageIdentity());
  const oldStorage = config.storage;
  const clients = (id) => (id.location.hostDir === oldStorage.hostDir ? oldClient : newClient);
  config.storage = { ...oldStorage, root: newRoot, hostDir: newRoot };
  // A run that stops after writing a copy, before checking it.
  const stat = newClient.stat.bind(newClient);
  const stop = async (p, ...a) => { if (p === '/Processed/a.jpg') throw new Error('made-up stop'); return stat(p, ...a); };
  newClient.stat = stop;
  await assert.rejects(cli(t, [], clients), /made-up stop/);
  newClient.stat = stat;
  assert.equal((await readRecord(storageFile('storage-migration.json'))).phase, 'copying');
  assert.equal(await text(newClient, '/Processed/a.jpg'), 'photo a', 'the copy was written before the stop');
  const lines = [];
  await cli(t, ['--cancel'], clients, lines);
  assert.match(lines.at(-1), /Migration cancelled/);
  assert.equal(await newClient.exists('/Processed/a.jpg'), false);
  assert.equal(await readRecord(storageFile('storage-migration.json')), null);

  // Again stopped half way, then the settings go back to the old folder: the run is discarded, nothing to migrate.
  newClient.stat = stop;
  await assert.rejects(cli(t, [], clients), /made-up stop/);
  newClient.stat = stat;
  config.storage = oldStorage;
  await cli(t, [], clients, lines);
  assert.ok(lines.some((l) => /unfinished migration was cancelled/.test(l)));
  assert.match(lines.at(-1), /Nothing to migrate/);
  assert.equal(await newClient.exists('/Processed/a.jpg'), false);
});

test('CLI: only one run at a time; a lock left by a dead run is taken over after it goes stale', async (t) => {
  await useConfig(t);
  await fs.writeFile(config.statePath, '{}');
  await writeRecord(storageFile('storage.json'), storageIdentity());
  const lock = storageFile('storage-migration.lock');
  await fs.writeFile(lock, 'someone-else');
  await assert.rejects(cli(t, [], () => null), /Another \.\/receipts migrate-storage is running/);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(lock, old, old);
  const lines = [];
  await cli(t, [], () => null, lines);
  assert.match(lines.at(-1), /Nothing to migrate/);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

test('Settings: a save that changes the storage or a folder is refused until ticked; going back to the recorded one is not', async (t) => {
  await useConfig(t, { kind: 'nextcloud', folders: defaultFolders(false) });
  const env = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); settings.testDeps.createClientFn = undefined; });
  settings.testDeps.createClientFn = () => ({ getDirectoryContents: async () => [] });
  const form = (o) => new URLSearchParams(o);
  await assert.rejects(settings.saveSettings(form({ RECEIPTS_PROCESSED: '/Receipts/Filed' }), {}), /migrate-storage/);
  await assert.rejects(fs.stat(config.webSettingsPath), { code: 'ENOENT' }, 'nothing saved');
  assert.match(await settings.saveSettings(form({ RECEIPTS_PROCESSED: '/Receipts/Filed', 'storage-change': 'yes' }), {}), /^Saved/);
  // The record still names the old folder: putting it back needs no tick.
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), folders: { ...storageIdentity().folders, processed: process.env.RECEIPTS_PROCESSED ?? '/Receipts/Processed' } });
  assert.match(await settings.saveSettings(form({ RECEIPTS_PROCESSED: process.env.RECEIPTS_PROCESSED ?? '/Receipts/Processed' }), {}), /^Saved/);
});

test('the web app never locks itself: Settings saves, resets and undo work while storage needs migration', async (t) => {
  await useConfig(t);
  const token = config.trigger.token;
  config.trigger.token = 'made-up';
  t.after(() => { config.trigger.token = token; });
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), location: { hostDir: '/somewhere/else' } });
  const { makeServer } = await import('../src/trigger.js');
  const server = makeServer(quiet, { nextcloud: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const blocked = await fetch(`${base}/archive?key=made-up`, { method: 'POST', body: '' });
  assert.equal(blocked.status, 503);
  for (const route of ['/settings-save', '/settings-reset-all', '/undo-settings']) {
    const res = await fetch(`${base}${route}?key=made-up`, { method: 'POST', body: new URLSearchParams({ section: 'connections' }), redirect: 'manual' });
    assert.notEqual(res.status, 503, route);
  }
  const page = await fetch(`${base}/settings?key=made-up`);
  assert.equal(page.status, 200);
});

// ---- Cancel safety in the command (copy mode) ----
/** A copy run from the current local folder to a new one, stopped after its first copy; returns the pieces. */
async function stoppedCopy(t) {
  const { dir, client: oldClient } = await useConfig(t);
  const newRoot = path.join(dir, 'new'); await fs.mkdir(newRoot);
  const newClient = localClient(newRoot);
  await seed(oldClient, '/Processed/a.jpg', 'photo a');
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), storageIdentity());
  const oldStorage = config.storage;
  config.storage = { ...oldStorage, root: newRoot, hostDir: newRoot };
  const stat = newClient.stat.bind(newClient);
  newClient.stat = async (p, ...a) => { if (p === '/Processed/a.jpg') throw new Error('made-up stop'); return stat(p, ...a); };
  await assert.rejects(cli(t, [], (id) => (id.location.hostDir === oldStorage.hostDir ? oldClient : newClient)), /made-up stop/);
  newClient.stat = stat;
  return { oldStorage, newStorage: config.storage, oldClient, newClient };
}

test('CLI cancel of a copy whose new storage can\'t be reached keeps the run and says it is not complete', async (t) => {
  const { newStorage, oldStorage, oldClient, newClient } = await stoppedCopy(t);
  const before = await readRecord(storageFile('storage-migration.json'));
  const unreachable = (id) => { if (id.location.hostDir === newStorage.hostDir) throw new Error('made-up: not mounted'); return oldClient; };
  const lines = [];
  await assert.rejects(cli(t, ['--cancel'], unreachable, lines), /cancel is not complete[\s\S]*Nothing was removed there[\s\S]*kept/);
  assert.ok(!lines.some((l) => /cancelled|removed/.test(l)), `never claims removal: ${lines}`);
  assert.deepEqual(await readRecord(storageFile('storage-migration.json')), before, 'the journal is kept');
  assert.equal(await text(newClient, '/Processed/a.jpg'), 'photo a', 'the copy is still there');
  // The automatic discard when the settings go back follows the same rule.
  config.storage = oldStorage;
  await assert.rejects(cli(t, [], unreachable, lines), /could not be cancelled[\s\S]*cancel is not complete/);
  assert.deepEqual(await readRecord(storageFile('storage-migration.json')), before, 'the journal is kept');
  // Reachable again: the cancel finishes.
  config.storage = newStorage;
  await cli(t, ['--cancel'], (id) => (id.location.hostDir === newStorage.hostDir ? newClient : oldClient), lines);
  assert.match(lines.at(-1), /Migration cancelled/);
  assert.equal(await newClient.exists('/Processed/a.jpg'), false);
  assert.equal(await readRecord(storageFile('storage-migration.json')), null);
});

test('CLI cancel keeps the run when a copy could not be removed', async (t) => {
  const { newStorage, oldClient, newClient } = await stoppedCopy(t);
  newClient.deleteFile = async () => { throw new Error('made-up: read-only'); };
  await assert.rejects(cli(t, ['--cancel'], (id) => (id.location.hostDir === newStorage.hostDir ? newClient : oldClient)), /cancel is not complete: 1 copy/);
  assert.ok(await readRecord(storageFile('storage-migration.json')), 'the journal is kept');
});

test('CLI: a committing journal is never discarded, by --cancel or by switching back, and no storage is opened for it', async (t) => {
  const { newStorage, oldStorage } = await stoppedCopy(t);
  const journal = await readRecord(storageFile('storage-migration.json'));
  await writeRecord(storageFile('storage-migration.json'), { ...journal, phase: 'committing', state: {} });
  const committing = await readRecord(storageFile('storage-migration.json'));
  const never = () => assert.fail('no storage is opened');
  await assert.rejects(cli(t, ['--cancel'], never), /being committed and can't be cancelled/);
  assert.deepEqual(await readRecord(storageFile('storage-migration.json')), committing);
  config.storage = oldStorage;
  await assert.rejects(cli(t, [], never), /unfinished/);
  assert.deepEqual(await readRecord(storageFile('storage-migration.json')), committing);
  assert.ok(newStorage);
});

test('CLI --source-info names the destination a cancel must reach, and the source otherwise', async (t) => {
  const { newStorage, oldStorage } = await stoppedCopy(t);
  const info = async () => { const lines = []; await cli(t, ['--source-info'], () => assert.fail('no storage is opened'), lines); return Object.fromEntries(lines.map((l) => l.split(/=(.*)/s).slice(0, 2))); };
  config.storage = oldStorage; // switched back: the unfinished copy's destination must be reachable to discard it
  assert.deepEqual(await info(), { from_role: 'destination', from_kind: 'local', from_host_dir: newStorage.hostDir, from_account: '', needs_source_password: '0', journal: 'copying' });
  config.storage = newStorage; // still aimed at it: the source is the old folder
  assert.deepEqual(await info(), { from_role: 'source', from_kind: 'local', from_host_dir: oldStorage.hostDir, from_account: '', needs_source_password: '0', journal: 'copying' });
});

test('CLI: a new storage that already holds receipt files is refused unless --into-used', async (t) => {
  const { dir, client: oldClient } = await useConfig(t);
  const newRoot = path.join(dir, 'new'); await fs.mkdir(newRoot);
  const newClient = localClient(newRoot);
  await seed(oldClient, '/Processed/a.jpg', 'photo a');
  await seed(newClient, '/Inbox/left-over.jpg', 'an earlier use');
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), storageIdentity());
  const oldStorage = config.storage;
  config.storage = { ...oldStorage, root: newRoot, hostDir: newRoot };
  const clients = (id) => (id.location.hostDir === oldStorage.hostDir ? oldClient : newClient);
  await assert.rejects(cli(t, [], clients), /already holds 1 file\(s\)[\s\S]*1 of them in its inbox[\s\S]*--into-used[\s\S]*Nothing was copied/);
  assert.equal(await newClient.exists('/Processed/a.jpg'), false);
  assert.equal(await readRecord(storageFile('storage-migration.json')), null, 'no run was started');
  const lines = [];
  await cli(t, ['--into-used'], clients, lines);
  assert.match(lines.at(-1), /Migration complete/);
  assert.equal(await text(newClient, '/Processed/a.jpg'), 'photo a');
  assert.equal(await text(newClient, '/Inbox/left-over.jpg'), 'an earlier use');
});

test('CLI: a local folder moved as a whole (its old path gone) is known by its marker', async (t) => {
  const { dir, files } = await useConfig(t);
  const client = localClient(files);
  await seed(client, '/Processed/a.jpg', 'photo a');
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  const marker = await writeMarker(client);
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), marker });
  const moved = path.join(dir, 'moved');
  await fs.rename(files, moved);
  config.storage = { ...config.storage, root: moved, hostDir: moved };
  const lines = [];
  await cli(t, [], (id) => { if (id.location.hostDir !== moved) throw new Error('made-up: the old folder is gone'); return localClient(moved); }, lines);
  assert.match(lines.at(-1), /same storage[\s\S]*Nothing to migrate/);
  assert.equal((await recordedStorage()).location.hostDir, moved);
  await assertStorage();
});

// ---- Identity ----
test('the marker is written in dry run too', async (t) => {
  const { client } = await useConfig(t);
  config.dryRun = true;
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), storageIdentity());
  assert.equal(await verifyStorageMarker(client), 'recorded');
  assert.ok(await readMarker(client));
  assert.equal(await readMarker(client), (await recordedStorage()).marker);
});

test('with no marker and no receipts owed, a new storage is recorded silently; with receipts it pauses', async (t) => {
  const { client } = await useConfig(t);
  await fs.writeFile(config.statePath, '{}');
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), location: { hostDir: '/somewhere/else' } });
  await assertStorage();
  assert.equal((await recordedStorage()).location.hostDir, config.storage.hostDir);
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), location: { hostDir: '/somewhere/else' } });
  assert.equal(await verifyStorageMarker(client), 'recorded');
  assert.equal((await recordedStorage()).location.hostDir, config.storage.hostDir);
  assert.ok((await recordedStorage()).marker);
  // Receipts in state: owed, so it pauses.
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  await writeRecord(storageFile('storage.json'), { ...storageIdentity(), location: { hostDir: '/somewhere/else' } });
  await assert.rejects(assertStorage(), /migrate-storage/);
  // An unfinished journal is owed too.
  await fs.writeFile(config.statePath, '{}');
  await writeRecord(storageFile('storage-migration.json'), { phase: 'copying', mode: 'copy', copies: [] });
  await assert.rejects(assertStorage(), /migrate-storage/);
});

test('Settings: "Use the .env value" and "Reset all" that change the storage or a folder need the same tick as Save', async (t) => {
  await useConfig(t, { kind: 'nextcloud', folders: defaultFolders(false) });
  const env = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); settings.testDeps.createClientFn = undefined; });
  settings.testDeps.createClientFn = () => ({ getDirectoryContents: async () => [] });
  const form = (o) => new URLSearchParams(o);
  await fs.writeFile(config.statePath, JSON.stringify({ '/Receipts/Inbox/a.jpg@e': { done: true, filedAs: '/Receipts/Processed/a.jpg' } }));
  const filed = async () => {
    assert.match(await settings.saveSettings(form({ RECEIPTS_PROCESSED: '/Receipts/Filed', 'storage-change': 'yes' }), {}), /^Saved/);
    // Migrated: the record names the new folder.
    const id = storageIdentity();
    await writeRecord(storageFile('storage.json'), { ...id, folders: { ...id.folders, processed: '/Receipts/Filed' }, marker: 'made-up-marker' });
  };
  await filed();
  await assert.rejects(settings.resetSetting(form({ reset: 'RECEIPTS_PROCESSED' }), {}), /migrate-storage[\s\S]*Use setup value/);
  assert.match(await fs.readFile(config.webSettingsPath, 'utf8'), /Filed/, 'nothing reset');
  assert.match(await settings.resetSetting(form({ reset: 'RECEIPTS_PROCESSED', 'storage-change': 'yes' }), {}), /uses the \.env value again/);
  await filed();
  await assert.rejects(settings.resetAllSettings(form({ confirm: 'yes' }), {}), /migrate-storage[\s\S]*Also reset a change of storage/);
  assert.match(await fs.readFile(config.webSettingsPath, 'utf8'), /Filed/, 'nothing reset');
  assert.match(await settings.resetAllSettings(form({ confirm: 'yes', 'storage-change': 'yes' }), {}), /Every setting uses its \.env value again/);
});

test('CLI on a fresh install (no storage.json, no receipts): the current storage is the source, so nothing to migrate', async (t) => {
  await useConfig(t);
  const lines = [];
  await cli(t, ['--source-info'], () => assert.fail('no storage is opened'), lines);
  const info = Object.fromEntries(lines.map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(info.from_kind, 'local'); assert.equal(info.from_host_dir, ''); assert.equal(info.needs_source_password, '0');
  await cli(t, [], () => assert.fail('no storage is opened'), lines);
  assert.match(lines.at(-1), /Nothing to migrate/);
  // An upgrade from before storage.json, with receipts in state: they were on Nextcloud then.
  await fs.writeFile(config.statePath, JSON.stringify({ '/Inbox/a.jpg@e': { done: true, filedAs: '/Processed/a.jpg' } }));
  lines.length = 0;
  await cli(t, ['--source-info'], () => assert.fail('no storage is opened'), lines);
  assert.ok(lines.includes('from_kind=nextcloud'));
});

test('folder move: an emptied old folder is removed; one a new folder lives in is kept', async (t) => {
  const { client } = await useConfig(t);
  const from = { kind: 'local', location: { hostDir: '/x' }, folders: local };
  const to = { kind: 'local', location: { hostDir: '/x' }, folders: { ...local, processed: '/Filed', review: '/Processed/Review' } };
  await seed(client, '/Processed/a.jpg', 'photo a');
  await seed(client, '/Needs review/b.jpg', 'photo b');
  await client.createDirectory('/Inbox', { recursive: true });
  const lines = [];
  await moveFolders({ client, from, to, state: {}, journal: null, checkpoint: async () => {}, commit: async () => {}, log: (l) => lines.push(l) });
  assert.equal(await text(client, '/Filed/a.jpg'), 'photo a');
  assert.equal(await text(client, '/Processed/Review/b.jpg'), 'photo b');
  assert.equal(await client.exists('/Needs review'), false, 'emptied: removed');
  assert.equal(await client.exists('/Processed'), true, 'the new review folder is inside it: kept');
  assert.equal(await client.exists('/Inbox'), true, 'unchanged folders stay');
});

test('an unfinished migration pauses the worker with its own message, not the storage-changed one', async (t) => {
  await useConfig(t);
  await fs.writeFile(config.statePath, '{}');
  await writeRecord(storageFile('storage.json'), storageIdentity());
  await writeRecord(storageFile('storage-migration.json'), { version: 2, mode: 'copy', phase: 'copying', from: storageIdentity(), to: { kind: 'local', location: { hostDir: '/made-up/new' }, folders: local }, copies: [] });
  await assert.rejects(assertStorage(), (err) => /copy of the receipts to the folder \/made-up\/new is unfinished[\s\S]*--cancel/.test(err.message) && !/--adopt/.test(err.message));
  await writeRecord(storageFile('storage-migration.json'), { version: 2, mode: 'move', phase: 'moving', from: storageIdentity(), to: storageIdentity(), moves: [] });
  await assert.rejects(assertStorage(), /move of the receipt folders is unfinished[\s\S]*only goes forward/);
});

test('copy errors say whether the old storage could not be read or the new one written', async (t) => {
  const { dir, client: oldClient } = await useConfig(t);
  await seed(oldClient, '/Processed/a.jpg', 'photo a');
  const from = { kind: 'local', location: { hostDir: '/old' }, folders: local };
  const to = { kind: 'local', location: { hostDir: '/new' }, folders: local };
  const deny = (err) => Object.assign(new Error(`made-up: ${err}`), { code: 'EACCES' });
  const unreadable = { ...oldClient, getFileContents: async () => { throw deny('read'); } };
  const target = localClient(path.join(dir, 'data'));
  const run = (source, destination) => migrateStorage({ source, destination, from, to, state: {}, journal: null, checkpoint: async () => {}, commit: async () => {} });
  await assert.rejects(run(Object.setPrototypeOf(unreadable, Object.getPrototypeOf(oldClient)), target), /Could not read \/Processed\/a\.jpg in the old storage \(made-up: read\)/);
  const unwritable = Object.setPrototypeOf({ ...target, putFileContents: async () => { throw deny('write'); } }, Object.getPrototypeOf(target));
  await assert.rejects(run(oldClient, unwritable), /Could not write \/Processed\/a\.jpg in the new storage \(made-up: write\)/);
});

test('./receipts creates the local folders before start and migration; the health check follows a pausing banner', async () => {
  const script = await fs.readFile(new URL('../../receipts', import.meta.url), 'utf8');
  const fn = (name) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
  assert.match(fn('prepare_hosting'), /make_local_folders quiet/);
  assert.match(fn('storage_prepare'), /make_local_folders quiet/);
  assert.match(fn('make_local_folders'), /quiet" == quiet && -n "\$\(page_folder_keys\)" \]\] && return 0/);
  const compose = await fs.readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /\/data\/heartbeat[\s\S]*\/data\/worker-alert\.json[\s\S]*pausing!==false/);
});
