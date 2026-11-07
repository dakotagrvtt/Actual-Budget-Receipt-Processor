// Setup check: can the worker reach everything it needs? Read-only: changes nothing in Actual or Nextcloud.
// Run with `./receipts check` (uses its own budget copy, so it's safe while the worker runs).
import './private-umask.js';
import { config } from './config.js';
import { resolveDryRun, envDisagreement } from './settings.js';
import { fetchServerVersion } from './actual-version.js';
import { readUpgradeMarker } from './actual-upgrade.js';
import * as actual from './actual.js';
import * as nextcloud from './nextcloud.js';
import { receiptLabels } from './categorize.js';
import { categoryDescriptions } from './category-notes.js';
import { remoteReady, remoteProbe, modelWarning, redact } from './decider-remote.js';
import { checkRemoteUrl } from './config.js';
import { remoteReady as readerReady } from './llm.js';

const HEALTH_TIMEOUT_MS = 5000; // a model server that is up answers /health at once
let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => console.log(`  warn  ${msg}`);
const fail = (msg) => {
  failed++;
  console.log(`  FAIL  ${msg}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    fail(`${name}: ${redact(err.message)}`);
  }
};

// The same rules as the worker: data/settings.json, then .env.
const resolved = resolveDryRun();
config.dryRun = resolved.dryRun;
console.log(`mode: ${config.dryRun ? 'DRY RUN (changes nothing)' : 'LIVE (writes to Actual, moves files in Nextcloud)'}`);
if (resolved.source === 'unusable') warn('data/settings.json exists but is unusable, so this is a dry run until it is fixed or deleted (./receipts mode dry|live rewrites it)');
const disagree = envDisagreement(resolved);
if (disagree) warn(disagree);

console.log('models');
const remoteReader = config.reader.provider === 'remote';
const models = remoteReader ? [] : [[`receipt reader (llm, ${config.llmName})`, config.llmUrl]];
if (config.decider.provider !== 'remote') models.push(['categorizer (decider)', config.deciderUrl]);
for (const [name, url] of models) {
  await step(name, async () => {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (still loading?)`);
    ok(`${name} is up`);
  });
}
if (remoteReader) {
  // No photo is sent by this check: GET <base>/models with the key. (Some providers, OpenRouter among them, list models without checking the key, so a wrong key can still show up at the first receipt.)
  await step('receipt reader (remote)', async () => {
    const status = await readerReady();
    if (status === 404) warn(`${config.reader.host} answered 404 to the model list at ${config.reader.url}/models: the address may be wrong (or it does not list models); the key and model name are not checked until a receipt is read`);
    else ok(`receipt reader answers at ${config.reader.host}; model ${config.reader.model}`);
    warn(`receipt photos are sent to ${config.reader.host} (READER_PROVIDER=remote); see the README before using it for real receipts`);
  });
}
if (config.decider.provider === 'remote') {
  // The hosted decider has no /health. Listing the models proves the address (the docs don't say it needs the key), so a
  // second step sends one fixed test request with the key. Nothing about a receipt or the household goes in either.
  await step('categorizer (remote decider) address', async () => {
    checkRemoteUrl(config.deciderUrl);
    let names = [];
    try {
      names = await remoteReady();
    } catch (err) {
      if (err.name !== 'DeciderAuthError') throw err; // the key step below reports a refused key
    }
    const model = config.decider.remoteModel;
    ok(`categorizer (remote decider) answers at ${config.deciderUrl}; ${names.length} model(s) listed`);
    const warning = modelWarning(model, names);
    if (warning) warn(warning);
    else ok(`model ${model} (remote); requests are anonymized first, see the Privacy page`);
  });
  await step('categorizer (remote decider) API key', async () => {
    await remoteProbe();
    ok('the API key works: one fixed test request ("A test item: paper towels", no household data) was answered; it costs a negligible number of tokens');
  });
}

console.log('nextcloud');
await step('Nextcloud', async () => {
  const inbox = await nextcloud.listFolder(config.nextcloud.inbox);
  ok(`inbox ${config.nextcloud.inbox}: ${inbox.length} receipt file(s) waiting`);
  for (const folder of [config.nextcloud.processed, config.nextcloud.review]) {
    try {
      await nextcloud.listFolder(folder);
      ok(`folder ${folder} exists`);
    } catch {
      if (config.dryRun) warn(`folder ${folder} doesn't exist yet (created on the first live run)`);
      else warn(`folder ${folder} doesn't exist yet (the worker creates it)`);
    }
  }
});

console.log('actual budget');
await step('Actual', async () => {
  const { apiInfo } = actual;
  const server = apiInfo.serverVersion !== undefined ? apiInfo.serverVersion : await fetchServerVersion(config.actual.serverURL);
  const using = `@actual-app/api ${apiInfo.version} (${apiInfo.source === 'cached' ? 'installed for this server' : 'bundled in the image'})`;
  if (!server) warn(`could not read the Actual server version from ${config.actual.serverURL}/info; using ${using}`);
  else if (server === apiInfo.version) ok(`Actual server ${server}; ${using}; versions match`);
  else warn(`Actual server ${server} but ${using}; versions differ${config.actual.apiVersion === 'auto' ? (apiInfo.note ? ` (${apiInfo.note})` : '') : ' (set ACTUAL_API_VERSION=auto to follow the server)'}`);
  // The worker leaves a note here when it could not follow a server upgrade and stopped restarting for it.
  const marker = config.actual.apiVersion === 'auto' ? await readUpgradeMarker(config.actual.apiDir) : null;
  if (marker?.outcome === 'stuck' && marker.version === server) warn(`the worker: ${marker.message}`);
  await actual.open();
  try {
    const labels = await actual.categoryLabels();
    const spending = receiptLabels([...labels.keys()]);
    ok(`budget opened: ${labels.size} categories, ${spending.length} used for receipts`);
    const described = categoryDescriptions();
    const missing = spending.filter((l) => !described[l]);
    if (missing.length) warn(`${missing.length} spending categor${missing.length === 1 ? 'y has' : 'ies have'} no description yet (${remoteReader ? 'with a cloud reader they are not written automatically; ./receipts describe asks first' : 'written automatically before the next batch'}): ${missing.join(', ')}`);
    else ok('every spending category has a description');
    if (config.splits && !actual.splitsSupported) warn('this @actual-app/api version cannot split transactions; set ACTUAL_API_VERSION to 26.8.0 or newer');
  } finally {
    await actual.close();
  }
});

console.log(failed ? `\n${failed} problem(s) found.` : '\nall checks passed.');
process.exit(failed ? 1 : 0);
