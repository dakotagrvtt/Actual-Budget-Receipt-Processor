// Item-level categorizer test (read-only). Every split you made yourself whose parts carry item notes becomes a
// test receipt: one item per part (note text, part amount). That transaction is hidden from the store history and
// the item history, so the categorizer can't see your answer, then each item is categorized and compared with
// the category you gave it. Splits the pipeline made itself (note tagged #receipt) are left out, since they are not
// your answers; --include-pipeline puts them back. A pipeline split you confirmed (removed #review) counts as yours.
// Each transaction sees only history up to the day before its date (store history and item notes; with --with-memory also the lessons the
// sweep had learned by then, and the learned keywords rebuilt from those lessons), the same cut the live worker and replay use for history.
// Your own keywords, category descriptions and rules have no date, so they still reflect today. A test item here is a whole split
// part, so the "item price" a learned keyword's item limit is checked against is the part's amount (a part is the only unit it has).
// What the worker learned from your corrections (lessons, learned keywords) is NOT used, since it would be graded on your own
// answers; --with-memory uses it (other transactions' lessons only).
// Usage: node src/item-test.js <name> <backend: decider|rules> [--allow-remote] [--include-pipeline] [--with-memory]
// With DECIDER_PROVIDER=remote the decider backend would send every one of those items (anonymized as far as the
// anonymizing goes: see docs/cloud.md) to the hosted service, up to a year of them, so it refuses unless you add --allow-remote.
// With a cloud reader as well, the name scan sends those split notes to the reader's provider raw (CLOUD_NAME_SCAN=true is needed for that).
// "Filed" is what the worker would do with the pick (receipt.js settleUnsure: store category, Uncategorized).
// With APPLY_THEN_REVIEW=false the worker would send a receipt with unsure items to review instead; this test still
// counts each item on its own.
// Writes /data/research/item-test-<name>.json (each row has confidence = the top probability and margin = its lead over the runner-up). Run it with ./receipts item-test <name> <backend> (changes nothing).
import './private-umask.js';
import fs from 'node:fs/promises';
import { config, log } from './config.js';
import * as actual from './actual.js';
import { ruleCategoryFor } from './rules.js';
import { categorizeItems, receiptLabels } from './categorize.js';
import { settleUnsure, payeeNamesForPrivacy, historyEnd } from './receipt.js';
import { stripAnnotations, UNCATEGORIZED } from './reconcile.js';
import { occasionDetails } from './calendar.js';
import { shiftDay, today } from './dates.js';
import { watchIndex } from './memory.js';
import { keywordCandidates, lessonsUpTo, usableLessons, withLessons } from './learning.js';

config.dryRun = true;
const argv = process.argv.slice(2);
const allowRemote = argv.includes('--allow-remote');
const includePipeline = argv.includes('--include-pipeline');
const withMemory = argv.includes('--with-memory'); // use what it learned from your corrections (lessons, learned keywords)
const [name, backendArg] = argv.filter((a) => !['--allow-remote', '--include-pipeline', '--with-memory'].includes(a));
const backend = backendArg === 'd1' ? 'decider' : backendArg; // d1 = the old name
if (!['decider', 'rules'].includes(backend)) throw new Error('usage: node src/item-test.js <name> <decider|rules> [--allow-remote] [--include-pipeline] [--with-memory]');
if (backend === 'decider' && config.decider.provider === 'remote' && !allowRemote) {
  throw new Error('item-test would send a year of your split notes to the hosted decider, one request per item (anonymized first; with a cloud reader the name scan sends the raw notes to the reader provider); add --allow-remote if you want that, or use the rules backend.');
}
await actual.open();
try {
  const labels = await actual.categoryLabels();
  const id2label = actual.idToLabel(labels);
  const allowed = receiptLabels([...labels.keys()]);

  const end = today();
  const since = shiftDay(end, -config.history.days);
  const businessNames = await payeeNamesForPrivacy(); // once: it reads every payee in Actual
  const { verified } = await watchIndex();
  const tests = [];
  for await (const { t, payeeName, payeeIsTransfer } of actual.budgetTransactions(since, end)) {
    if (!t.is_parent || t.transfer_id) continue;
    if (!includePipeline && /#receipt /.test(t.notes ?? '') && !verified.has(t.id)) continue; // the pipeline's own split, not your answer
    const parts = (t.subtransactions ?? [])
      .map((s) => ({ item: stripAnnotations(s.notes), label: id2label.get(s.category), amount: -s.amount / 100 }))
      .filter((p) => p.item && p.label && allowed.includes(p.label) && p.amount > 0);
    if (parts.length) tests.push({ txn: { ...t, payeeName, payeeIsTransfer }, parts });
  }
  log(`${tests.length} split purchase(s), ${tests.reduce((n, t) => n + t.parts.length, 0)} item note(s) to test`);

  const rows = [];
  for (const { txn, parts } of tests) {
    const store = txn.payeeName ?? txn.imported_payee ?? 'unknown store';
    // Nothing from the transaction's day on: the test must not see purchases or notes made after it.
    const until = historyEnd(txn.date);
    const history = await actual.storeHistory(store, txn.id, id2label, until);
    const lessons = withMemory ? lessonsUpTo((await usableLessons()).filter((l) => l.txnId !== txn.id), until) : [];
    const items = withLessons(await actual.itemHistory(txn.id, id2label, until), lessons, labels);
    const ruleId = ruleCategoryFor({ ...txn, category: null });
    const ruleLabel = ruleId ? id2label.get(ruleId) ?? null : null;
    const fallback = ruleLabel && allowed.includes(ruleLabel) ? ruleLabel : null;
    const payee = txn.payeeName && !txn.payeeIsTransfer ? txn.payeeName : null;
    // The remote decider never sees the bank's raw text (imported_payee): its store is the payee, or "unknown store".
    const receipt = { merchant: config.decider.provider === 'remote' ? (payee ?? 'unknown store') : store, store, payee, date: txn.date, total: -txn.amount / 100, items: parts.map((p) => ({ description: p.item, amount: p.amount })) };
    const t0 = Date.now();
    if (backend === 'rules') {
      // No model: everything goes to the rule's category, or the store's most-used past category.
      const byCat = new Map();
      for (const h of history) for (const p of h.parts) byCat.set(p.category, (byCat.get(p.category) ?? 0) + p.amount);
      const usual = [...byCat].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      receipt.items.forEach((it) => Object.assign(it, { category: fallback ?? usual, confidence: null }));
    } else {
      const occasionList = await occasionDetails(txn.date);
      await categorizeItems(receipt, [...labels.keys()], history, items, { currentLabel: ruleLabel, ruleLabel, ...(withMemory ? { learnedKeywords: keywordCandidates(lessons) } : {}), ignoreKeywordsFromTxn: txn.id, chargeCents: -txn.amount, lessons, ignoreLearned: !withMemory, occasions: occasionList.map((o) => o.text), occasionDetails: occasionList, businessNames });
    }
    const secs = (Date.now() - t0) / 1000;
    // What the pipeline would actually file: the same settling as the worker (receipt.js settleUnsure), on copies so
    // the model's own pick stays visible.
    const settled = receipt.items.map((it) => ({ ...it }));
    settleUnsure(settled, fallback);
    receipt.items.forEach((it, i) => {
      const filed = settled[i].category;
      rows.push({ store, date: txn.date, item: parts[i].item, amount: parts[i].amount, yours: parts[i].label, pick: it.category, keyword: it.keyword ?? null, keywordCategory: it.keywordCategory ?? null, source: it.source ?? null, probabilities: it.probabilities ?? null, receiptPick: receipt.receiptCheck?.category ?? null, receiptConfidence: receipt.receiptCheck?.category ? receipt.receiptCheck.confidence : null, pulledByReceipt: Boolean(it.receiptSaid), confidence: it.confidence ?? null, margin: it.margin ?? null, filed, ruleLabel, secs: secs / parts.length });
      log(`${parts[i].label === it.category ? 'OK ' : 'NO '} ${store} | ${parts[i].item} ${parts[i].amount.toFixed(2)} | yours ${parts[i].label} | ${backend} ${it.category ?? '-'}${it.confidence != null ? ` ${Math.round(it.confidence * 100)}%${it.margin != null ? ` (+${Math.round(it.margin * 100)})` : ''}` : ''} | filed ${filed}`);
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
