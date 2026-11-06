// Setup check: can the worker reach everything it needs? Read-only: changes nothing in Actual or Nextcloud.
// Run with `./receipts check` (uses its own budget copy, so it's safe while the worker runs).
import { config } from './config.js';
import * as actual from './actual.js';
import * as nextcloud from './nextcloud.js';
import { receiptLabels } from './categorize.js';
import { categoryDescriptions } from './category-notes.js';

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
    fail(`${name}: ${err.message}`);
  }
};

console.log(`mode: ${config.dryRun ? 'DRY RUN (changes nothing)' : 'LIVE (writes to Actual, moves files in Nextcloud)'}`);

console.log('models');
const models = [['receipt reader (llm)', config.llmUrl]];
models.push(['categorizer (decider)', config.deciderUrl]);
for (const [name, url] of models) {
  await step(name, async () => {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} (still loading?)`);
    ok(`${name} is up`);
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
  await actual.open();
  try {
    const labels = await actual.categoryLabels();
    const spending = receiptLabels([...labels.keys()]);
    ok(`budget opened: ${labels.size} categories, ${spending.length} used for receipts`);
    const described = categoryDescriptions();
    const missing = spending.filter((l) => !described[l]);
    if (missing.length) warn(`${missing.length} spending categor${missing.length === 1 ? 'y has' : 'ies have'} no description yet (written automatically before the next batch): ${missing.join(', ')}`);
    else ok('every spending category has a description');
    if (config.splits && !actual.splitsSupported) warn('this @actual-app/api version cannot split transactions; set ACTUAL_API_VERSION to 26.8.0 or newer');
  } finally {
    await actual.close();
  }
});

console.log(failed ? `\n${failed} problem(s) found.` : '\nall checks passed.');
process.exit(failed ? 1 : 0);
