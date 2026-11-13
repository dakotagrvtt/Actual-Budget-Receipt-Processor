import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localClient } from '../src/local-files.js';
import { migrateStorage, mapStoragePath, migratedState, migrationRewriter } from '../src/migrate-storage.js';
import { config, defaultFolders } from '../src/config.js';
import { loadState, saveState } from '../src/state.js';
import { writeRecord, storageFile, storageIdentity, sameStorage, assertStorage, adoptStorage, recordedStorage } from '../src/storage-state.js';

const davError = (status, message) => Object.assign(new Error(message), { status });
function fakeDav() {
  const files = new Map(), dirs = new Set(['/']);
  return {
    files, dirs,
    async exists(p) { return files.has(p) || dirs.has(p); },
    async createDirectory(p) { for (let d = p; d !== '/'; d = path.posix.dirname(d)) dirs.add(d); },
    async putFileContents(p, b, opts) { if (opts?.overwrite === false && files.has(p)) throw davError(412, 'clash'); files.set(p, Buffer.from(b)); },
    async getFileContents(p) { if (!files.has(p)) throw davError(404, 'missing'); return files.get(p); },
    async stat(p) { if (!files.has(p)) throw davError(404, 'missing'); return { size: files.get(p).length, etag: 'fake' }; },
    async deleteFile(p) { if (files.has(p)) files.delete(p); else if (dirs.has(p)) dirs.delete(p); else throw davError(404, 'missing'); },
    async moveFile(a, b, opts) {
      if (!files.has(a)) throw davError(404, 'missing');
      if (opts?.overwrite === false && files.has(b)) throw davError(412, 'clash');
      files.set(b, files.get(a)); files.delete(a);
    },
    async getDirectoryContents(p) {
      return [...dirs].filter((d) => d !== p && path.posix.dirname(d) === p).map((filename) => ({ filename, type: 'directory' }))
        .concat([...files.keys()].filter((f) => path.posix.dirname(f) === p).map((filename) => ({ filename, type: 'file' })));
    },
  };
}
const nc = { kind: 'nextcloud', folders: defaultFolders(false) };
const local = { kind: 'local', folders: defaultFolders(true) };
async function seed(c, p, bytes = 'made-up photo') {
  await c.createDirectory(path.posix.dirname(p), { recursive: true });
  await c.putFileContents(p, bytes);
}
for (const reverse of [false, true]) test(`migration ${reverse ? 'local to WebDAV' : 'WebDAV to local'} preserves summaries and nested state paths`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-migration-'));
  try {
    const disk = localClient(dir), dav = fakeDav();
    const source = reverse ? disk : dav, destination = reverse ? dav : disk;
    const from = reverse ? local : nc, to = reverse ? nc : local;
    const p = from.folders.archive + '/2026-01/example.jpg';
    await seed(source, p); await seed(source, p + '.json', '{"madeUp":true}');
    let committed;
    const state = { [from.folders.inbox + '/example.jpg@old']: { filedAs: p, archived: { folder: from.folders.archive }, filing: { from: p, dest: from.folders.processed + '/example.jpg' }, fixedOnPage: { before: { filedAs: p } } } };
    const j = await migrateStorage({ source, destination, from, to, state, checkpoint: async () => {}, commit: async (s) => { committed = s; } });
    const dest = to.folders.archive + '/2026-01/example.jpg';
    assert.equal((await destination.getFileContents(dest)).toString(), 'made-up photo');
    assert.ok(await source.exists(p)); assert.ok(await destination.exists(dest + '.json'));
    assert.equal(Object.values(committed)[0].fixedOnPage.before.filedAs, dest);
    assert.equal(Object.values(committed)[0].archived.folder, to.folders.archive);
    assert.equal(j.phase, 'complete');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('migration resumes after a copied file and keeps name clashes and summaries together', async () => {
  const source = fakeDav(), destination = fakeDav();
  const p = nc.folders.processed + '/example.jpg';
  await seed(source, p); await seed(source, p + '.json', '{}');
  await seed(destination, local.folders.processed + '/example.jpg', 'existing');
  let journal, committed = false, crash = true;
  const args = { source, destination, from: nc, to: local, intoUsed: true, state: { 'x@e': { filedAs: p } }, checkpoint: async (j) => {
    journal = structuredClone(j);
    if (crash && j.copies.some((c) => c.verified)) { crash = false; throw new Error('crash'); }
  }, commit: async () => { committed = true; } };
  await assert.rejects(migrateStorage(args), /crash/);
  assert.equal(committed, false);
  await migrateStorage({ ...args, journal });
  assert.equal(destination.files.size, 3);
  const renamed = journal.copies[0].to;
  assert.notEqual(renamed, local.folders.processed + '/example.jpg');
  assert.ok(destination.files.has(renamed + '.json'));
  assert.equal((await destination.getFileContents(local.folders.processed + '/example.jpg')).toString(), 'existing');
});
test('verification failure leaves state unchanged', async () => {
  const source = fakeDav(), destination = fakeDav();
  await seed(source, nc.folders.inbox + '/example.jpg');
  destination.getFileContents = async () => Buffer.from('corrupt');
  let committed = false;
  await assert.rejects(migrateStorage({ source, destination, from: nc, to: local, state: {}, checkpoint: async () => {}, commit: async () => { committed = true; } }), /verification failed/);
  assert.equal(committed, false);
});
test('startup guard treats unrecorded entries as Nextcloud and allows a completed migration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-guard-'));
  const saved = { statePath: config.statePath, storage: config.storage };
  try {
    config.statePath = path.join(dir, 'state.json'); config.storage = { kind: 'local' };
    await fs.writeFile(config.statePath, '{"made-up@etag":{"filedAs":"/Receipts/Processed/test.jpg"}}');
    await assert.rejects(loadState(), /migrate-storage/);
    assert.equal(Object.keys(await loadState({ allowStorageMismatch: true })).length, 1);
    await writeRecord(storageFile('storage.json'), storageIdentity());
    assert.equal(Object.keys(await loadState()).length, 1);
    config.storage = { kind: 'nextcloud' };
    await assert.rejects(loadState(), /migrate-storage/);
  } finally { Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});
test('fresh local install records its storage before saving receipts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-fresh-'));
  const saved = { statePath: config.statePath, storage: config.storage };
  try {
    config.statePath = path.join(dir, 'state.json'); config.storage = { kind: 'local' };
    assert.deepEqual(await loadState(), {});
    await saveState({ 'made-up@etag': { done: true } });
    assert.equal(Object.keys(await loadState()).length, 1);
  } finally { Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});

test('migration resumes a crash between saving state and recording storage identity', async () => {
  const source = fakeDav(), destination = fakeDav();
  const p = nc.folders.inbox + '/example.jpg';
  await seed(source, p);
  source.stat = async () => ({ size: Buffer.byteLength('made-up photo'), etag: 'old' });
  let journal, saved, crash = true;
  const args = { source, destination, from: nc, to: local, state: { [p + '@old']: { waiting: { reason: 'made up' }, filing: { from: p, dest: nc.folders.processed + '/example.jpg', etag: 'old' } } },
    checkpoint: async (j) => { journal = structuredClone(j); },
    commit: async (s) => { saved = s; if (crash) { crash = false; throw new Error('crash'); } },
  };
  await assert.rejects(migrateStorage(args), /crash/);
  assert.equal(journal.phase, 'committing');
  const first = structuredClone(saved);
  await migrateStorage({ ...args, state: saved, journal });
  assert.deepEqual(saved, first);
  assert.ok(saved[local.folders.inbox + '/example.jpg@fake']);
  assert.equal(Object.values(saved)[0].filing.etag, 'fake');
  assert.equal(destination.files.size, 1);
});

test('migration respects custom effective folder mappings and leaves unrelated text alone', async () => {
  const source = fakeDav(), destination = fakeDav();
  const from = { kind: 'nextcloud', folders: { inbox: '/Custom in', processed: '/Custom out', review: '/Custom review', archive: '/Custom archive' } };
  const to = { kind: 'local', folders: { inbox: '/Web inbox', processed: '/Web out', review: '/Web review', archive: '/Web archive' } };
  const p = '/Custom out/example.jpg';
  await seed(source, p);
  let next;
  await migrateStorage({ source, destination, from, to, state: { '/Custom in/example.jpg@old': { filedAs: p, error: p } }, checkpoint: async () => {}, commit: async (s) => { next = s; } });
  const entry = Object.values(next)[0];
  assert.equal(entry.filedAs, '/Web out/example.jpg');
  assert.equal(entry.error, p);
});

test('different inbox versions retain distinct state keys after migration', async () => {
  const source = fakeDav(), destination = fakeDav();
  const p = nc.folders.inbox + '/example.jpg';
  await seed(source, p);
  let next;
  await migrateStorage({ source, destination, from: nc, to: local,
    state: { [p + '@earlier']: { applied: { txnId: 'made-up-old' } }, [p + '@fake']: { waiting: true } },
    checkpoint: async () => {}, commit: async (s) => { next = s; },
  });
  assert.equal(Object.keys(next).length, 2);
  assert.equal(next[local.folders.inbox + '/example.jpg@earlier'].applied.txnId, 'made-up-old');
});

test('#11 folder mapping normalizes segments and refuses traversal', () => {
  assert.equal(mapStoragePath('/Receipts//Inbox/a.jpg', { inbox: 'Receipts/Inbox/' }, { inbox: '/Inbox/' }), '/Inbox/a.jpg');
  assert.equal(mapStoragePath('/Receipts/Inboxish/a.jpg', { inbox: '/Receipts/Inbox' }, { inbox: '/Inbox' }), '/Receipts/Inboxish/a.jpg');
  assert.throws(() => mapStoragePath('/Inbox/a', { inbox: '/Inbox/../bad' }, { inbox: '/new' }), /Unsafe/);
});

test('#2 location identity detects same-kind local and Nextcloud moves', () => {
  for (const [kind, a, b] of [['local', { hostDir: '/old' }, { hostDir: '/new' }], ['nextcloud', { url: 'https://old.invalid', user: 'a' }, { url: 'https://new.invalid', user: 'a' }], ['nextcloud', { url: 'https://old.invalid', user: 'a' }, { url: 'https://old.invalid', user: 'b' }]]) {
    assert.equal(sameStorage({ kind, location: a, folders: local.folders }, { kind, location: b, folders: local.folders }), false);
  }
});

test('#2 same-kind migration copies to a different local root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'same-kind-'));
  try {
    await fs.mkdir(path.join(dir, 'old')); await fs.mkdir(path.join(dir, 'new'));
    const source = localClient(path.join(dir, 'old')), destination = localClient(path.join(dir, 'new'));
    source.recoverClaims = async () => ({ remaining: 0 });
    await seed(source, '/Inbox/a.jpg');
    const journal = await migrateStorage({ source, destination, from: { ...local, location: { hostDir: '/old' } }, to: { ...local, location: { hostDir: '/new' } }, state: {}, checkpoint: async () => {}, commit: async () => {} });
    assert.equal(journal.phase, 'complete');
    assert.equal((await destination.getFileContents('/Inbox/a.jpg')).toString(), 'made-up photo');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const kind of ['local', 'nextcloud']) test(`#3/#4 ${kind} source additions and changes are rescanned before commit`, async () => {
  const source = fakeDav(), destination = fakeDav();
  let recovered = false, changed = false, committed;
  if (kind === 'local') {
    source.localFiles = true;
    source.recoverClaims = async (options) => { assert.deepEqual(options, { all: true }); recovered = true; await seed(source, nc.folders.inbox + '/claimed.jpg'); return { finished: 1, undone: 0, remaining: 0 }; };
  }
  const p = nc.folders.inbox + '/a.jpg';
  await seed(source, p, 'before');
  const put = destination.putFileContents;
  destination.putFileContents = async (...args) => {
    await put(...args);
    if (!changed) { changed = true; await seed(source, p, 'after'); await seed(source, nc.folders.inbox + '/new.jpg'); }
  };
  const j = await migrateStorage({ source, destination, from: { ...nc, kind }, to: local, state: {}, checkpoint: async () => {}, commit: async (s) => { committed = s; } });
  assert.ok(committed);
  assert.equal((await destination.getFileContents(j.copies.find((c) => c.from === p).to)).toString(), 'after');
  assert.ok(j.copies.some((c) => c.from.endsWith('/new.jpg')));
  if (kind === 'local') assert.ok(recovered && j.copies.some((c) => c.from.endsWith('/claimed.jpg')));
});

test('#4 unsettled claims refuse migration before inventory', async () => {
  const source = { localFiles: true, recoverClaims: async () => ({ remaining: 1 }) };
  await assert.rejects(migrateStorage({ source, destination: fakeDav(), from: local, to: nc }), /Unsettled/);
});

test('#3 continuously changing source is bounded and never commits', async () => {
  const source = fakeDav(), destination = fakeDav();
  await seed(source, nc.folders.inbox + '/a.jpg');
  let reads = 0, committed = false;
  const listing = source.getDirectoryContents;
  source.getDirectoryContents = async (p) => { if (p === nc.folders.inbox) await seed(source, p + `/new-${++reads}.jpg`); return listing(p); };
  await assert.rejects(migrateStorage({ source, destination, from: nc, to: local, state: {}, maxPasses: 2, checkpoint: async () => {}, commit: async () => { committed = true; } }), /kept changing/);
  assert.equal(committed, false);
});

test('#7 retry name and etag follow a collision-renamed inbox copy', () => {
  const p = nc.folders.inbox + '/a.jpg';
  const next = migratedState({ [p + '@old']: { requeue: { from: p, name: 'a.jpg', etag: 'old' }, done: true } }, nc.folders, local.folders, [{ from: p, to: '/Inbox/unique-a.jpg', sourceEtag: 'old', etag: 'new' }]);
  assert.equal(next['/Inbox/unique-a.jpg@new'].requeue.name, 'unique-a.jpg');
  assert.equal(next['/Inbox/unique-a.jpg@new'].requeue.etag, 'new');
});

test('#8 correction, filing and requeue etags translate; unknown version or path fields refuse', () => {
  const p = nc.folders.review + '/a.jpg';
  const copies = [{ from: p, to: '/Needs review/a.jpg', sourceEtag: 'old', etag: 'new' }];
  const entry = { resolutionPending: { from: p, action: 'reread', fileEtag: 'old', summary: { file: 'a.jpg', problems: [] } }, filing: { kind: 'worker', from: p, dest: nc.folders.processed + '/a.jpg', etag: 'old', summary: { file: 'a.jpg' } } };
  const next = Object.values(migratedState({ '/Receipts/Inbox/a.jpg@old': entry }, nc.folders, local.folders, copies))[0];
  assert.equal(next.resolutionPending.fileEtag, 'new');
  assert.equal(next.filing.etag, 'new');
  assert.equal(next.filing.dest, '/Processed/a.jpg');
  assert.equal(next.resolutionPending.summary.file, 'a.jpg');
  assert.throws(() => migratedState({ '/x@e': { resolutionPending: { fileEtag: 'unknown' } } }, nc.folders, local.folders, copies), /Let the pending operation finish/);
  // Fields nobody listed fail closed instead of being copied with a stale version or an old path.
  assert.throws(() => migratedState({ [p + '@old']: { madeUpEtag: 'old' } }, nc.folders, local.folders, copies), /unknown version field/);
  assert.throws(() => migratedState({ [p + '@old']: { madeUp: { sourcePath: p } } }, nc.folders, local.folders, copies), /unknown file reference/);
});

test('#9 archive sidecar keys and the shrunk etag follow the migrated state and verified copy', async () => {
  const source = fakeDav(), destination = fakeDav();
  const p = nc.folders.archive + '/a.jpg', key = nc.folders.inbox + '/a.jpg@fake';
  await seed(source, p);
  await seed(source, p + '.json', JSON.stringify({ file: 'a.jpg', archived: { at: '2026-01-01T00:00:00Z', from: p, key, txnId: 'made-up', shrunk: { before: 10, after: 5, sha256: 'ab', etag: 'fake' } } }));
  let next;
  const journal = await migrateStorage({ source, destination, from: nc, to: local, state: { [key]: { filedAs: p, archived: { at: '2026-01-01T00:00:00Z', folder: nc.folders.archive, restoreTo: 'processed', shrunk: { before: 10, after: 5 } } } }, checkpoint: async () => {}, commit: async (s) => { next = s; } });
  const sidecar = JSON.parse(await destination.getFileContents('/Archive/a.jpg.json'));
  assert.equal(sidecar.archived.key, Object.keys(next)[0]);
  assert.equal(sidecar.archived.from, '/Archive/a.jpg');
  assert.equal(sidecar.archived.shrunk.etag, 'fake'); // the destination copy's version (the fake client reports 'fake')
  assert.equal(sidecar.file, 'a.jpg');
  assert.equal(Object.values(next)[0].archived.folder, '/Archive');
  assert.ok(journal.copies.every((c) => c.verified && c.hash));
  assert.equal(JSON.parse(await source.getFileContents(p + '.json')).archived.key, key);
});

test('#9 a shrunk etag whose original version was not copied is dropped, not kept stale', () => {
  const p = nc.folders.archive + '/a.jpg';
  const rw = migrationRewriter(nc.folders, local.folders, [{ from: p, to: '/Archive/a.jpg', sourceEtag: 'now', etag: 'dest' }]);
  const out = rw.sidecar({ file: 'a.jpg', archived: { from: p, shrunk: { before: 9, after: 3, sha256: 'cd', etag: 'earlier' } } }, p + '.json');
  assert.equal('etag' in out.archived.shrunk, false);
  assert.equal(out.archived.shrunk.sha256, 'cd');
});

test('#10 worker and web refuse the same location mismatch and pending journal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-web-'));
  const saved = { statePath: config.statePath, storage: config.storage }, token = config.trigger.token;
  const { makeServer } = await import('../src/trigger.js');
  let server;
  try {
    config.statePath = path.join(dir, 'state.json'); config.storage = { kind: 'local', hostDir: '/new' }; config.trigger.token = 'made-up';
    await fs.writeFile(config.statePath, '{"made-up@etag":{"filedAs":"/Processed/example.jpg"}}');
    await writeRecord(storageFile('storage.json'), { ...storageIdentity(), location: { hostDir: '/old' } });
    await assert.rejects(loadState(), /migrate-storage/);
    server = makeServer(() => assert.fail('triggered during migration'), { nextcloud: { uploadToInbox: () => assert.fail('uploaded during migration') } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    for (const route of ['/upload', '/retry', '/archive', '/archive-all', '/restore', '/receipt-reread', '/receipt-reread-restore', '/receipt-resolve', '/receipt-fix', '/undo-receipt-fix', '/receipt-cash']) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${route}?key=made-up`, { method: 'POST', body: '' });
      assert.equal(res.status, 503, route); assert.match(await res.text(), /migrate-storage/);
    }
    await writeRecord(storageFile('storage.json'), storageIdentity());
    await writeRecord(storageFile('storage-migration.json'), { phase: 'copying' });
    await assert.rejects(assertStorage(), /migrate-storage/);
  } finally { if (server) await new Promise((r) => server.close(r)); config.trigger.token = token; Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});

test('#3 CLI refuses invocation without the service stop check', async () => {
  const { verifyStopped } = await import('../src/migrate-storage-cli.js');
  const old = process.env.RECEIPTS_SERVICES_STOPPED;
  try {
    delete process.env.RECEIPTS_SERVICES_STOPPED;
    await assert.rejects(verifyStopped(), /Stop the worker and web app/);
    const script = await fs.readFile(new URL('../../receipts', import.meta.url), 'utf8');
    assert.match(script, /docker compose stop worker\n  \( storage_tool "\$\{args\[@\]\}" \) \|\| rc=\$\?\n[\s\S]*?elif ! docker compose up -d worker; then/);
    assert.match(script, /^worker_running\(\) \{ COMPOSE_FILE="\$1" docker compose ps --status running --services worker; \}/m);
    const fn = (name) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
    assert.doesNotMatch(fn('storage_tool') + fn('storage_prepare'), /python3/, 'L3: no python3 on the host');
    assert.doesNotMatch(fn('make_local_folders'), /chmod/, 'L9: an existing folder keeps its mode');
    assert.match(fn('choose_storage'), /-z "\$current" \]\] && current=nextcloud/, 'M5: an existing .env without STORAGE is Nextcloud');
    // Opus 8: a failed docker compose ps never reads as "not running".
    assert.match(fn('storage_tool'), /running="\$\(worker_running "\$STORAGE_FILES"\)" \|\| die /);
    // Opus 7 and 8: the run state before the command comes back, and a stopped worker stays stopped.
    assert.match(fn('cmd_migrate_storage'), /was_running="\$\(worker_running "\$STORAGE_FILES"\)" \|\| die [\s\S]*?docker compose stop worker[\s\S]*?if \[\[ -z "\$was_running" \]\]; then[\s\S]*?elif ! docker compose up -d worker/);
    assert.match(fn('remember_storage_switch'), /was_running="\$\(worker_running "\$STORAGE_FILES"\)" \|\| die [\s\S]*?if ! result="\$\(storage_tool --remember\)"; then\n    \[\[ -z "\$was_running" \]\] \|\| docker compose up -d worker[^\n]*\n    die /);
    // Sol 4 / Terra 9: no advice to move receipt files by hand and adopt.
    assert.doesNotMatch(script, /move (the|your) (receipt )?files (there )?(yourself|by hand)[^\n]*--adopt/i);
  } finally { if (old === undefined) delete process.env.RECEIPTS_SERVICES_STOPPED; else process.env.RECEIPTS_SERVICES_STOPPED = old; }
});

for (const kind of ['nextcloud', 'local']) test(`explicit adoption keeps ${kind} state unchanged and unblocks the guard`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-adopt-'));
  const saved = { statePath: config.statePath, storage: config.storage, nextcloud: { ...config.nextcloud } };
  try {
    config.statePath = path.join(dir, 'state.json');
    config.storage = { kind, hostDir: '/synthetic/new' };
    config.nextcloud.url = 'https://new.synthetic.invalid';
    const identity = storageIdentity();
    const old = { ...identity, location: kind === 'local' ? { hostDir: '/synthetic/old' } : { ...identity.location, url: 'http://old.synthetic.invalid' } };
    await writeRecord(storageFile('storage.json'), old);
    const bytes = JSON.stringify({ '/Inbox/synthetic.jpg@original': { done: true, filedAs: '/Processed/synthetic.jpg', applied: { txnId: 'synthetic' } } }, null, 3);
    await fs.writeFile(config.statePath, bytes);
    await assert.rejects(loadState(), (e) => e.code === 'STORAGE_MIGRATION_REQUIRED' && e.message.includes('--adopt'));
    await assert.rejects(adoptStorage(), /confirmation/);
    assert.deepEqual(await recordedStorage(), old);
    await adoptStorage({ confirmed: true });
    assert.deepEqual(await recordedStorage(), identity);
    assert.equal(await fs.readFile(config.statePath, 'utf8'), bytes);
    assert.equal(Object.keys(await loadState()).length, 1);
    await adoptStorage({ confirmed: true });
    await assertStorage();
  } finally { Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});

test('explicit-only design requires adoption for Nextcloud address or user changes regardless of recorded etags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-address-'));
  const saved = { statePath: config.statePath, storage: config.storage, nextcloud: { ...config.nextcloud } };
  try {
    config.statePath = path.join(dir, 'state.json'); config.storage = { kind: 'nextcloud' };
    config.nextcloud.url = 'https://old.synthetic.invalid'; config.nextcloud.user = 'synthetic-user';
    const old = storageIdentity();
    await writeRecord(storageFile('storage.json'), old);
    for (const etag of ['matching', 'mismatched']) {
      await fs.writeFile(config.statePath, JSON.stringify({ [`/Inbox/a.jpg@${etag}`]: { done: true, filedAs: '/Processed/a.jpg' } }));
      for (const url of ['http://old.synthetic.invalid', 'https://new.synthetic.invalid']) {
        config.nextcloud.url = url;
        await assert.rejects(loadState(), { code: 'STORAGE_MIGRATION_REQUIRED' });
        assert.deepEqual(await recordedStorage(), old);
      }
    }
    config.nextcloud.url = old.location.url; config.nextcloud.user = 'different-user';
    await assert.rejects(loadState(), { code: 'STORAGE_MIGRATION_REQUIRED' });
  } finally { Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});

test('storage identity normalizes trailing slashes and folder paths without conflating accounts', () => {
  const saved = { storage: config.storage, nextcloud: { ...config.nextcloud } };
  try {
    config.storage = { kind: 'nextcloud' }; config.nextcloud.url = 'https://synthetic.invalid///';
    const a = storageIdentity();
    config.nextcloud.url = 'https://synthetic.invalid';
    const b = storageIdentity();
    assert.equal(sameStorage(a, b), true);
    assert.equal(sameStorage(a, { ...b, folders: { ...b.folders, inbox: b.folders.inbox + '/' } }), true);
    assert.equal(sameStorage(a, { ...b, location: { ...b.location, user: 'other' } }), false);
  } finally { Object.assign(config, saved); }
});

test('adoption refuses incomplete migration, changed folders and storage kinds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-adopt-refuse-'));
  const saved = { statePath: config.statePath, storage: config.storage };
  try {
    config.statePath = path.join(dir, 'state.json'); config.storage = { kind: 'local', hostDir: '/synthetic/new' };
    const identity = storageIdentity();
    const old = { ...identity, location: { hostDir: '/synthetic/old' } };
    for (const phase of ['copying', 'committing']) {
      await writeRecord(storageFile('storage.json'), old);
      await writeRecord(storageFile('storage-migration.json'), { phase });
      await assert.rejects(adoptStorage({ confirmed: true }), /pending migration/);
      assert.deepEqual(await recordedStorage(), old);
    }
    await writeRecord(storageFile('storage-migration.json'), { phase: 'complete' });
    for (const previous of [{ ...old, kind: 'nextcloud' }, { ...old, folders: { ...old.folders, inbox: '/different' } }]) {
      await writeRecord(storageFile('storage.json'), previous);
      await assert.rejects(adoptStorage({ confirmed: true }), /same storage kind and receipt folder paths/);
      assert.deepEqual(await recordedStorage(), previous);
    }
    await writeRecord(storageFile('storage.json'), old);
    await adoptStorage({ confirmed: true });
    await assertStorage();
  } finally { Object.assign(config, saved); await fs.rm(dir, { recursive: true, force: true }); }
});
