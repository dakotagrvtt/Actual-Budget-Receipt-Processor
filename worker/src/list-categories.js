// Print the category labels the model must choose from, one per line.
// Usage: docker compose run --rm --no-deps worker node src/list-categories.js [--tsv]
//   --tsv  every spending category instead (excluded ones too), as "category<TAB>Group<TAB>Group / Category" lines,
//          for ./receipts exclude. The tag keeps them apart from anything else the Actual API prints.
import './private-umask.js';
import * as actual from './actual.js';
import { receiptLabels } from './category-notes.js';

const tsv = process.argv.includes('--tsv');
await actual.open();
try {
  const rows = await actual.spendingCategories();
  if (tsv) for (const c of rows) console.log(`category\t${c.group}\t${c.label}`);
  else for (const label of receiptLabels(rows.map((c) => c.label))) console.log(label);
} finally {
  await actual.close();
}
