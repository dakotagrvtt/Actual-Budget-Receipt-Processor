// Print the category labels the model must choose from, one per line.
// Usage: docker compose run --rm --no-deps worker node src/list-categories.js
import './private-umask.js';
import * as actual from './actual.js';

await actual.open();
try {
  for (const label of (await actual.categoryLabels()).keys()) console.log(label);
} finally {
  await actual.close();
}
