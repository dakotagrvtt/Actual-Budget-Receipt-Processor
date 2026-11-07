// Have the reader model write descriptions for spending categories that don't have one yet, from your past transactions.
// Writes only data/category-notes.json (marked "auto": true for you to review). Never touches Actual.
// Usage: docker compose run --rm --no-deps worker node src/describe-categories.js [--refresh] [--yes]
//   --refresh  also rewrite descriptions it wrote before (yours are never overwritten)
//   --yes      with a cloud reader (READER_PROVIDER=remote): you have read what is sent and agree. ./receipts describe asks first.
import './private-umask.js';
import { config, log } from './config.js';
import * as actual from './actual.js';
import { describeMissing, DESCRIBE_SENDS } from './categories.js';
import { receiptLabels } from './categorize.js';

const refresh = process.argv.includes('--refresh');
const yes = process.argv.includes('--yes');
if (config.reader.provider === 'remote' && !yes) {
  log(`The reader is a cloud service (${config.reader.host}). Writing descriptions sends it, for each category without one:`);
  for (const line of DESCRIBE_SENDS) log(`  - ${line}`);
  log('Nothing is sent until you confirm: run ./receipts describe (it asks), or add --yes.');
  process.exit(1);
}
await actual.open();
try {
  const labelToId = await actual.categoryLabels();
  const labels = receiptLabels([...labelToId.keys()]);
  log(`describing ${refresh ? 'missing and auto-written' : 'missing'} categories among ${labels.length} spending categories`);
  const written = await describeMissing(labels, labelToId, { refresh, confirmedCloud: yes });
  log(`wrote ${written.length} description(s) to data/category-notes.json`);
} finally {
  await actual.close();
}
