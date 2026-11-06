// Have the reader model write descriptions for spending categories that don't have one yet, from your past transactions.
// Writes only data/category-notes.json (marked "auto": true for you to review). Never touches Actual.
// Usage: docker compose run --rm --no-deps worker node src/describe-categories.js [--refresh]
//   --refresh  also rewrite descriptions it wrote before (yours are never overwritten)
import { log } from './config.js';
import * as actual from './actual.js';
import { describeMissing } from './categories.js';
import { receiptLabels } from './categorize.js';

const refresh = process.argv.includes('--refresh');
await actual.open();
try {
  const labelToId = await actual.categoryLabels();
  const labels = receiptLabels([...labelToId.keys()]);
  log(`describing ${refresh ? 'missing and auto-written' : 'missing'} categories among ${labels.length} spending categories`);
  const written = await describeMissing(labels, labelToId, { refresh });
  log(`wrote ${written.length} description(s) to data/category-notes.json`);
} finally {
  await actual.close();
}
