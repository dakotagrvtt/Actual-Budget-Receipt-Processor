// ACTUAL_API_VERSION=auto: version choice, pruning, /info parsing and the atomic install (npm and fetch faked, temp dirs only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chooseApi, versionsToPrune, entryOf, fetchServerVersion, fetchServerVersionWithRetry, installApi, listCached, prune, prepareApi } from './actual-version.js';

const base = { setting: 'auto', bakedVersion: '26.8.0', cached: [] };

test('chooseApi: not auto always uses the bundled API', () => {
  for (const setting of ['latest', '26.7.0', '']) {
    assert.equal(chooseApi({ ...base, setting, serverVersion: '26.11.0', cached: ['26.11.0'] }).action, 'bundled');
  }
});

test('chooseApi: auto picks bundled, cached or install', () => {
  assert.equal(chooseApi({ ...base, serverVersion: '26.8.0' }).action, 'bundled');
  assert.deepEqual(chooseApi({ ...base, serverVersion: '26.11.0', cached: ['26.9.0', '26.11.0'] }), { action: 'cached', version: '26.11.0', reason: 'cached install matches the server' });
  const install = chooseApi({ ...base, serverVersion: '26.11.0', cached: ['26.9.0'] });
  assert.equal(install.action, 'install');
  assert.equal(install.version, '26.11.0');
});

test('chooseApi: unknown or odd server version falls back to bundled', () => {
  for (const serverVersion of [null, undefined, '', 'nightly', '../../etc']) {
    assert.equal(chooseApi({ ...base, serverVersion }).action, 'bundled');
  }
});

test('versionsToPrune keeps the 2 newest and never the current one', () => {
  const e = [{ version: '1.0.0', mtimeMs: 1 }, { version: '2.0.0', mtimeMs: 2 }, { version: '3.0.0', mtimeMs: 3 }];
  assert.deepEqual(versionsToPrune(e, '3.0.0'), ['1.0.0']);
  assert.deepEqual(versionsToPrune(e, '1.0.0'), ['2.0.0']);
  assert.deepEqual(versionsToPrune(e.slice(0, 2), '2.0.0'), []);
  assert.deepEqual(versionsToPrune([], '2.0.0'), []);
});

test('entryOf finds the import file', () => {
  assert.equal(entryOf({ main: 'dist/index.js' }), 'dist/index.js');
  assert.equal(entryOf({ exports: { '.': { import: './esm.js', require: './cjs.js' } }, main: 'x.js' }), './esm.js');
  assert.equal(entryOf({ exports: './e.js' }), './e.js');
  assert.equal(entryOf({}), 'index.js');
});

test('fetchServerVersion reads build.version and swallows failures', async () => {
  const json = (body, ok = true) => async () => ({ ok, json: async () => body });
  assert.equal(await fetchServerVersion('http://a', json({ build: { version: '26.11.0' } })), '26.11.0');
  assert.equal(await fetchServerVersion('http://a', json({ build: { version: 'v26.11.0' } })), '26.11.0');
  assert.equal(await fetchServerVersion('http://a', json({})), null);
  assert.equal(await fetchServerVersion('http://a', json({}, false)), null);
  assert.equal(await fetchServerVersion('http://a', async () => { throw new Error('offline'); }), null);
});

// A fake npm that "installs" the requested version.
const fakeNpm = (log = []) => async (dir, spec) => {
  log.push(spec);
  const pkg = path.join(dir, 'node_modules/@actual-app/api');
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ version: spec.split('@').pop(), main: 'index.mjs' }));
  await fs.writeFile(path.join(pkg, 'index.mjs'), 'export function init() {}\nexport default { init };\n');
};
const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'api-test-'));

test('installApi installs into a temp dir then renames; failure leaves nothing behind', async () => {
  const root = await tmpRoot();
  try {
    const calls = [];
    await installApi(root, '26.11.0', fakeNpm(calls));
    assert.deepEqual(calls, ['@actual-app/api@26.11.0']);
    assert.deepEqual(await fs.readdir(root), ['26.11.0']);

    await assert.rejects(installApi(root, '26.12.0', async () => { throw new Error('registry down'); }), /registry down/);
    await assert.rejects(installApi(root, '26.12.0', async (dir) => fakeNpm()(dir, '@actual-app/api@1.0.0')), /not 26.12.0/);
    assert.deepEqual(await fs.readdir(root), ['26.11.0']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('listCached ignores junk and clears stale temp dirs; prune keeps 2', async () => {
  const root = await tmpRoot();
  try {
    assert.deepEqual(await listCached(path.join(root, 'missing')), []);
    for (const [i, v] of ['26.9.0', '26.10.0', '26.11.0'].entries()) {
      await installApi(root, v, fakeNpm());
      await fs.utimes(path.join(root, v), new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    }
    const stale = path.join(root, '.tmp-26.12.0-old');
    await fs.mkdir(stale);
    await fs.utimes(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
    await fs.mkdir(path.join(root, '.tmp-26.12.0-young')); // maybe another process installing right now
    await fs.mkdir(path.join(root, '.npm-cache'));
    assert.deepEqual((await listCached(root)).map((c) => c.version).sort(), ['26.10.0', '26.11.0', '26.9.0']);
    assert.ok(!(await fs.readdir(root)).includes('.tmp-26.12.0-old'), 'old temp dir cleared');
    assert.ok((await fs.readdir(root)).includes('.tmp-26.12.0-young'), 'young temp dir left alone');
    await prune(root, '26.11.0');
    assert.deepEqual((await fs.readdir(root)).sort(), ['.npm-cache', '.tmp-26.12.0-young', '26.10.0', '26.11.0']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fetchServerVersion strips trailing slashes before /info', async () => {
  const urls = [];
  const f = async (u) => { urls.push(u); return { ok: true, json: async () => ({ build: { version: '1.2.3' } }) }; };
  await fetchServerVersion('http://a:5006/', f);
  await fetchServerVersion('http://a:5006///', f);
  assert.deepEqual(urls, ['http://a:5006/info', 'http://a:5006/info']);
});

test('fetchServerVersionWithRetry: retries until /info answers, and gives up after the total time', async () => {
  let calls = 0;
  const slept = [];
  const sleep = async (ms) => slept.push(ms);
  const flaky = async () => {
    if (++calls < 4) throw new Error('connection refused');
    return { ok: true, json: async () => ({ build: { version: '26.11.0' } }) };
  };
  assert.equal(await fetchServerVersionWithRetry('http://a', { fetchFn: flaky, sleep }), '26.11.0');
  assert.equal(calls, 4);
  assert.equal(slept.length, 3);

  // never answers: the clock is faked through sleep, so this finishes at once
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    let tries = 0;
    const down = async () => { tries++; throw new Error('down'); };
    const out = await fetchServerVersionWithRetry('http://a', { fetchFn: down, totalMs: 60000, intervalMs: 5000, sleep: async (ms) => { now += ms; } });
    assert.equal(out, null);
    assert.ok(tries >= 10 && tries <= 13, `about a minute of tries, got ${tries}`);
  } finally {
    Date.now = realNow;
  }
});

test('installApi: concurrent installs of the same version use different temp dirs and both end with one good install', async () => {
  const root = await tmpRoot();
  try {
    const seen = [];
    const npm = async (dir, spec) => {
      seen.push(dir);
      await new Promise((r) => setTimeout(r, 20));
      await fakeNpm()(dir, spec);
    };
    await Promise.all([installApi(root, '26.11.0', npm), installApi(root, '26.11.0', npm)]);
    assert.equal(new Set(seen).size, 2, 'temp names are unique even with the same pid');
    assert.deepEqual(await fs.readdir(root), ['26.11.0']);
    assert.match(path.basename(seen[0]), /^\.tmp-26\.11\.0-[0-9a-f-]{36}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installApi: an install that does not load never gets its final name', async () => {
  const root = await tmpRoot();
  try {
    const broken = async (dir, spec) => {
      await fakeNpm()(dir, spec);
      await fs.writeFile(path.join(dir, 'node_modules/@actual-app/api/index.mjs'), 'export const nothing = 1;\n');
    };
    await assert.rejects(installApi(root, '26.11.0', broken), /no init/);
    assert.deepEqual(await fs.readdir(root), []);
    const syntax = async (dir, spec) => {
      await fakeNpm()(dir, spec);
      await fs.writeFile(path.join(dir, 'node_modules/@actual-app/api/index.mjs'), 'this is not javascript (');
    };
    await assert.rejects(installApi(root, '26.11.0', syntax));
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareApi: installs once under the lock; two at the same time run npm once', async () => {
  const root = await tmpRoot();
  try {
    const calls = [];
    const npm = async (dir, spec) => {
      calls.push(spec);
      await new Promise((r) => setTimeout(r, 30));
      await fakeNpm()(dir, spec);
    };
    const [a, b] = await Promise.all([prepareApi(root, '26.11.0', npm), prepareApi(root, '26.11.0', npm)]);
    assert.equal(calls.length, 1);
    assert.equal(typeof a.api.init, 'function');
    assert.deepEqual([a.installed, b.installed].sort(), [false, true]);
    assert.ok(!(await fs.readdir(root)).includes('.install.lock'), 'lock released');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('prepareApi: a cached version that fails to import is deleted and the error says to fall back', async () => {
  const root = await tmpRoot();
  try {
    await installApi(root, '26.11.0', fakeNpm());
    await fs.rm(path.join(root, '26.11.0/node_modules/@actual-app/api/index.mjs')); // e.g. a half-copied install
    await assert.rejects(prepareApi(root, '26.11.0', fakeNpm()), /does not load.*removed it/);
    assert.deepEqual(await fs.readdir(root), [], 'broken install removed (and no lock left)');
    // next start reinstalls cleanly
    const out = await prepareApi(root, '26.11.0', fakeNpm());
    assert.equal(out.installed, true);
    assert.equal(typeof out.api.init, 'function');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
