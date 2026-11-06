// Item-level categorizer test (read-only). Every split you made yourself whose parts carry item notes becomes a
// test receipt: one item per part (note text, part amount). That transaction is hidden from the store history and
// the item history, so the categorizer can't see your answer, then each item is categorized and compared with
// the category you gave it. Usage: node src/item-test.js <name> <backend: decider|rules>
// "Filed" is what the worker would do with the pick (receipt.js settleUnsure: store category, Uncategorized).
// With APPLY_THEN_REVIEW=false the worker would send a receipt with unsure items to review instead; this test still
// counts each item on its own.
// Writes /data/research/item-test-<name>.json. Run it with ./receipts item-test <name> <backend> (changes nothing).
import fs from 'node:fs/promises';
import { config, log } from './config.js';
import * as actual from './actual.js';
import { ruleCategoryFor } from './rules.js';
import { categorizeItems, receiptLabels } from './categorize.js';
import { settleUnsure } from './receipt.js';
import { stripAnnotations, UNCATEGORIZED } from './reconcile.js';
import { occasionsNear } from './calendar.js';
import { shiftDay, today } from './dates.js';

config.dryRun = true;
const [name, backendArg] = process.argv.slice(2);
const backend = backendArg === 'd1' ? 'decider' : backendArg; // d1 = the old name
if (!['decider', 'rules'].includes(backend)) throw new Error('usage: node src/item-test.js <name> <decider|rules>');
await actual.open();
try {
  const labels = await actual.categoryLabels();
  const id2label = actual.idToLabel(labels);
  const allowed = receiptLabels([...labels.keys()]);

  const end = today();
  const since = shiftDay(end, -config.history.days);
  const tests = [];
  for await (const { t, payeeName } of actual.budgetTransactions(since, end)) {
    if (!t.is_parent || t.transfer_id) continue;
    const parts = (t.subtransactions ?? [])
      .map((s) => ({ item: stripAnnotations(s.notes), label: id2label.get(s.category), amount: -s.amount / 100 }))
      .filter((p) => p.item && p.label && allowed.includes(p.label) && p.amount > 0);
    if (parts.length) tests.push({ txn: { ...t, payeeName }, parts });
  }
  log(`${tests.length} split purchase(s), ${tests.reduce((n, t) => n + t.parts.length, 0)} item note(s) to test`);

  const rows = [];
  for (const { txn, parts } of tests) {
    const store = txn.payeeName ?? txn.imported_payee ?? 'unknown store';
    const history = await actual.storeHistory(store, txn.id, id2label);
    const items = await actual.itemHistory(txn.id, id2label);
    const ruleId = ruleCategoryFor({ ...txn, category: null });
    const ruleLabel = ruleId ? id2label.get(ruleId) ?? null : null;
    const fallback = ruleLabel && allowed.includes(ruleLabel) ? ruleLabel : null;
    const receipt = { merchant: store, store, date: txn.date, total: -txn.amount / 100, items: parts.map((p) => ({ description: p.item, amount: p.amount })) };
    const t0 = Date.now();
    if (backend === 'rules') {
      // No model: everything goes to the rule's category, or the store's most-used past category.
      const byCat = new Map();
      for (const h of history) for (const p of h.parts) byCat.set(p.category, (byCat.get(p.category) ?? 0) + p.amount);
      const usual = [...byCat].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      receipt.items.forEach((it) => Object.assign(it, { category: fallback ?? usual, confidence: null }));
    } else {
      await categorizeItems(receipt, [...labels.keys()], history, items, { currentLabel: ruleLabel, ruleLabel, ignoreKeywordsFromTxn: txn.id, occasions: await occasionsNear(txn.date) });
    }
    const secs = (Date.now() - t0) / 1000;
    // What the pipeline would actually file: the same settling as the worker (receipt.js settleUnsure), on copies so
    // the model's own pick stays visible.
    const settled = receipt.items.map((it) => ({ ...it }));
    settleUnsure(settled, fallback);
    receipt.items.forEach((it, i) => {
      const filed = settled[i].category;
      rows.push({ store, date: txn.date, item: parts[i].item, amount: parts[i].amount, yours: parts[i].label, pick: it.category, keyword: it.keyword ?? null, keywordCategory: it.keywordCategory ?? null, source: it.source ?? null, probabilities: it.probabilities ?? null, confidence: it.confidence ?? null, filed, ruleLabel, secs: secs / parts.length });
      log(`${parts[i].label === it.category ? 'OK ' : 'NO '} ${store} | ${parts[i].item} ${parts[i].amount.toFixed(2)} | yours ${parts[i].label} | ${backend} ${it.category ?? '-'}${it.confidence != null ? ` ${Math.round(it.confidence * 100)}%` : ''} | filed ${filed}`);
    });
  }
  await fs.mkdir('/data/research', { recursive: true });
  await fs.writeFile(`/data/research/item-test-${name}.json`, JSON.stringify(rows, null, 1));
  const n = rows.length;
  const right = (k) => rows.filter((r) => r[k] === r.yours).length;
  const money = (k) => rows.filter((r) => r[k] === r.yours).reduce((s, r) => s + r.amount, 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  log(`=== ${name}: model pick right ${right('pick')}/${n} items ($${money('pick').toFixed(2)} of $${total.toFixed(2)}); as filed right ${right('filed')}/${n} ($${money('filed').toFixed(2)}); left uncategorized ${rows.filter((r) => r.filed === UNCATEGORIZED).length}; rule category alone right ${rows.filter((r) => r.ruleLabel === r.yours).length}/${n}`);
  const kwRows = rows.filter((r) => r.keyword != null);
  const otherRows = rows.filter((r) => r.keyword == null);
  const rightIn = (list, k) => list.filter((r) => r[k] === r.yours).length;
  log(`=== ${name}: keyword-matched items: pick right ${rightIn(kwRows, 'pick')}/${kwRows.length}; unmatched items: pick right ${rightIn(otherRows, 'pick')}/${otherRows.length}, filed right ${rightIn(otherRows, 'filed')}/${otherRows.length}`);
} finally {
  await actual.close();
}
