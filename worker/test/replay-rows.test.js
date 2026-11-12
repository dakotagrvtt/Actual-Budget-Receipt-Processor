// replay-rows.js: the per-item rows saved for the threshold sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemRows } from '../src/replay-rows.js';

const modelItem = (over = {}) => ({
  description: '20 OZ COKE', amount: 1.58, category: 'B / Two', confidence: 0.7, margin: 0.45, source: undefined,
  probabilities: { 'A / One': 0.25, 'B / Two': 0.7 },
  decided: { category: 'A / One', confidence: 0.5, margin: 0.1, model: { category: 'A / One', confidence: 0.5, margin: 0.1 } },
  ...over,
});

test('itemRows: the whole-purchase answer is on every row, with the item\'s own probability for it, so the bar can be swept offline', () => {
  const receipt = { receiptCheck: { category: 'B / Two', confidence: 0.7, margin: 0.45, moved: ['20 OZ COKE'] }, items: [modelItem({ receiptSaid: { category: 'A / One', confidence: 0.5, margin: 0.1 } }), modelItem({ description: 'CHICKEN BAKE', category: 'B / Two', decided: { category: 'B / Two', confidence: 0.7, margin: 0.45, model: null } })] };
  const [coke, bake] = itemRows('r.read.json', receipt);
  assert.deepEqual([coke.pick, coke.topProbability, coke.filed, coke.pulledByReceipt], ['A / One', 0.5, 'B / Two', true]);
  assert.deepEqual([coke.receiptPick, coke.receiptTopProbability, coke.receiptMargin, coke.itemProbabilityOfReceiptPick], ['B / Two', 0.7, 0.45, 0.7]);
  assert.equal(bake.pulledByReceipt, false);
});

test('itemRows: with no whole-purchase answer (off, one item, invalid) the receipt fields are null, and keyword-filed items still get a row', () => {
  const kw = { description: 'COKE', amount: 2, category: 'C / Three', confidence: 1, source: 'keyword' };
  const rows = itemRows('r', { items: [modelItem(), kw] });
  assert.deepEqual(rows.map((r) => [r.receiptPick, r.receiptTopProbability, r.receiptMargin, r.itemProbabilityOfReceiptPick, r.pulledByReceipt]), [[null, null, null, null, false], [null, null, null, null, false]]);
  assert.equal(rows[1].source, 'keyword');
  const invalid = itemRows('r', { receiptCheck: { category: null, confidence: 0, margin: null, invalid: 'x', moved: [] }, items: [modelItem()] });
  assert.deepEqual([invalid[0].receiptPick, invalid[0].receiptTopProbability], [null, null]);
});
