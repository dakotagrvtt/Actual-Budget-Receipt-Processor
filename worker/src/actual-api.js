// Loads @actual-app/api. Normally that's the copy baked into the image. With ACTUAL_API_VERSION=auto it is the version
// the Actual server runs, installed once under /data/actual-api/<version>/ and reused. Any failure falls back to the baked copy.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, log } from './config.js';
import { chooseApi, fetchServerVersion, fetchServerVersionWithRetry, listCached, prepareApi, prune } from './actual-version.js';

const { apiVersion: setting, serverURL, apiDir } = config.actual;
const bakedVersion = JSON.parse(readFileSync(new URL('../node_modules/@actual-app/api/package.json', import.meta.url))).version;

// npm needs a writable cache; HOME may not be, so keep it with the installs.
const npm = (dir, spec) =>
  promisify(execFile)('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', spec], {
    cwd: dir,
    env: { ...process.env, npm_config_cache: path.join(apiDir, '.npm-cache') },
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024, // npm's output can be long; the default 1 MB would kill the install
  });

// Only the long-running worker waits for Actual to come up; one-off commands (check, replay, ...) should not hang.
const isWorker = path.basename(process.argv[1] ?? '') === 'index.js';

let api;
// serverVersion is undefined when not asked (setting isn't auto), null when /info failed.
// failedFor: the server version an install was tried for and failed (so the worker does not restart in a loop over it).
const info = { setting, serverVersion: undefined, version: bakedVersion, source: 'bundled', note: '', failedFor: null };

if (setting === 'auto') {
  try {
    info.serverVersion = isWorker
      ? await fetchServerVersionWithRetry(serverURL, { onWait: () => log(`ACTUAL_API_VERSION=auto: waiting for ${serverURL}/info ...`) })
      : await fetchServerVersion(serverURL, fetch, 3000);
    const cached = await listCached(apiDir);
    const choice = chooseApi({ setting, serverVersion: info.serverVersion, bakedVersion, cached: cached.map((c) => c.version) });
    if (info.serverVersion === null) log(`ACTUAL_API_VERSION=auto: could not read ${serverURL}/info; using bundled @actual-app/api ${bakedVersion}`);
    if (choice.action !== 'bundled') {
      if (choice.action === 'install') log(`installing @actual-app/api ${choice.version} to match the Actual server (first start after an upgrade takes a minute)`);
      // Installs (or just loads) under a lock; a cached copy that no longer loads is removed and we fall back to bundled.
      ({ api } = await prepareApi(apiDir, choice.version, npm));
      info.version = choice.version;
      info.source = 'cached';
      await prune(apiDir, choice.version).catch(() => {}); // tidying up must never stop startup
      log(`using @actual-app/api ${choice.version} (matches the Actual server)`);
    } else if (info.serverVersion && info.serverVersion !== bakedVersion) {
      info.note = 'differs from the server';
    }
  } catch (err) {
    info.note = err.message;
    info.failedFor = info.serverVersion ?? null;
    log(`ACTUAL_API_VERSION=auto: could not set up @actual-app/api for server ${info.serverVersion ?? '?'} (${err.message}); using bundled ${bakedVersion}`);
  }
}
if (!api) api = (await import('@actual-app/api')).default;

export { api, info as apiInfo };
