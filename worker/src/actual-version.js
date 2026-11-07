// Picking and installing the @actual-app/api version that matches the Actual server (ACTUAL_API_VERSION=auto).
// The decision is a pure function; the install and the /info fetch take their side effects as arguments so tests can fake them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withLock } from './file-lock.js';

const VERSION = /^\d+\.\d+\.\d+$/;
const KEEP_VERSIONS = 2;
const STALE_TMP_MS = 60 * 60 * 1000; // a temp install younger than this may belong to a process still installing
const LOCK_FILE = '.install.lock';
const LOCK_WAIT_MS = 12 * 60 * 1000; // an npm install may take up to 10 minutes
const LOCK_STALE_MS = 15 * 60 * 1000;

/** Which API to load. `cached` is the list of versions already installed under the cache dir.
 *  Returns { action: 'bundled' | 'cached' | 'install', version, reason }. */
export function chooseApi({ setting, serverVersion, bakedVersion, cached = [] }) {
  if (setting !== 'auto') return { action: 'bundled', version: bakedVersion, reason: 'ACTUAL_API_VERSION is not auto' };
  if (!serverVersion || !VERSION.test(serverVersion)) return { action: 'bundled', version: bakedVersion, reason: 'server version unknown' };
  if (serverVersion === bakedVersion) return { action: 'bundled', version: bakedVersion, reason: 'bundled API already matches the server' };
  if (cached.includes(serverVersion)) return { action: 'cached', version: serverVersion, reason: 'cached install matches the server' };
  return { action: 'install', version: serverVersion, reason: 'no API for the server version yet' };
}

/** Cached installs to delete so at most `keep` remain. `entries` is [{ version, mtimeMs }]; `current` is never removed. */
export function versionsToPrune(entries, current, keep = KEEP_VERSIONS) {
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.version);
  const kept = new Set([current, ...newestFirst.filter((v) => v !== current)].slice(0, keep));
  return newestFirst.filter((v) => !kept.has(v));
}

/** The file to import from an installed package.json: exports "." (import, then default), else main, else index.js. */
export function entryOf(pkg) {
  let dot = pkg.exports && typeof pkg.exports === 'object' && '.' in pkg.exports ? pkg.exports['.'] : pkg.exports;
  while (dot && typeof dot === 'object') dot = dot.import ?? dot.default ?? dot.require;
  return typeof dot === 'string' ? dot : (pkg.main ?? 'index.js');
}

/** The server's version from GET <serverURL>/info, or null if it can't be read. */
export async function fetchServerVersion(serverURL, fetchFn = fetch, timeoutMs = 5000) {
  try {
    const res = await fetchFn(`${String(serverURL).replace(/\/+$/, '')}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const version = (await res.json())?.build?.version;
    return typeof version === 'string' ? version.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/** fetchServerVersion, retried until it answers or `totalMs` has passed (the worker can start before Actual is up). */
export async function fetchServerVersionWithRetry(serverURL, { fetchFn = fetch, totalMs = 60000, intervalMs = 5000, timeoutMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onWait = () => {} } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fetchServerVersion(serverURL, fetchFn, timeoutMs);
    if (v || Date.now() - t0 + intervalMs > totalMs) return v;
    onWait();
    await sleep(intervalMs);
  }
}

const readVersion = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'node_modules/@actual-app/api/package.json'), 'utf8')).version;

/** Installed versions under `root`, with their age. Also clears half-finished installs (.tmp-*) left by a crash,
 *  but only old ones: a young one may be another process installing right now. */
export async function listCached(root) {
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (name.startsWith('.tmp-')) {
      const st = await fs.stat(path.join(root, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_TMP_MS) await fs.rm(path.join(root, name), { recursive: true, force: true });
    } else if (VERSION.test(name)) found.push({ version: name, mtimeMs: (await fs.stat(path.join(root, name))).mtimeMs });
  }
  return found;
}

/** Import @actual-app/api from an install dir (<dir>/node_modules/@actual-app/api); throws if it does not load. */
async function loadApiFrom(dir) {
  const pkgDir = path.join(dir, 'node_modules/@actual-app/api');
  const entry = entryOf(JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8')));
  const mod = await import(pathToFileURL(path.join(pkgDir, entry)).href);
  const api = mod.default ?? mod;
  if (typeof api?.init !== 'function') throw new Error('the installed @actual-app/api has no init()');
  return api;
}

/** Install @actual-app/api@version into root/<version>: into a temp dir first, check that it loads, then one rename.
 *  `run(dir, spec)` runs npm; `load(dir)` imports the result. The caller holds the install lock (see prepareApi). */
export async function installApi(root, version, run, load = loadApiFrom) {
  const tmp = path.join(root, `.tmp-${version}-${randomUUID()}`); // not the pid: node is PID 1 in every container
  const final = path.join(root, version);
  await fs.mkdir(tmp, { recursive: true });
  try {
    await fs.writeFile(path.join(tmp, 'package.json'), '{"private":true}\n');
    await run(tmp, `@actual-app/api@${version}`);
    const got = await readVersion(tmp);
    if (got !== version) throw new Error(`npm installed ${got}, not ${version}`);
    await load(tmp); // a broken install must never get its final name
    try {
      await fs.rename(tmp, final);
    } catch (err) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; // another process finished the same install first
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return final;
}

/**
 * The API for `version` from root/<version>, installing it first if needed. The check-then-install runs under a lock
 * file in `root`, so two containers starting together don't install the same version twice.
 * A cached copy that no longer loads is deleted (so the next start reinstalls it) and the error is thrown:
 * the caller falls back to the bundled API for this run. Returns { api, installed }.
 */
export async function prepareApi(root, version, run, { load = loadApiFrom, lock = withLock } = {}) {
  await fs.mkdir(root, { recursive: true });
  return lock(path.join(root, LOCK_FILE), async () => {
    const dir = path.join(root, version);
    const cached = (await listCached(root)).some((c) => c.version === version);
    const installed = !cached;
    if (installed) await installApi(root, version, run, load);
    try {
      return { api: await load(dir), installed };
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true });
      throw new Error(`the ${installed ? 'new' : 'cached'} install of ${version} does not load (${err.message}); removed it so the next start reinstalls`);
    }
  }, { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS });
}

/** Delete old installs beyond KEEP_VERSIONS (never `current`). */
export async function prune(root, current) {
  for (const version of versionsToPrune(await listCached(root), current)) {
    await fs.rm(path.join(root, version), { recursive: true, force: true });
  }
}
