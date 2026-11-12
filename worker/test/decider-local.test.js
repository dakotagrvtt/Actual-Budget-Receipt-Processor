// The local decider's request body for a fixed fixture must match the stored copy (test/local-decider-body.golden.json),
// so changes to the remote decider cannot alter what the local one sends.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { categorizeItems } from '../src/categorize.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-decider-body.golden.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-local-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
config.keywordsPath = path.join(tmp, 'keywords.json');
config.categoryNotesPath = path.join(tmp, 'category-notes.json');

const LABELS = ['Daily Expenses / Groceries', 'Daily Expenses / Sam', 'Fun / Gifts'];

async function captureBodies() {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'gum', category: 'Daily Expenses / Sam', store: null, strength: 'usually' }] }));
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'Daily Expenses / Sam': "Sam's clothes and snacks" }));
  Object.assign(config, { keywordMode: 'hint', similarItems: true, keywordHintWeight: 1, excludeGroups: [], excludeCategories: [], stripDepartmentPrefixes: true, deciderUrl: 'http://decider.test:8080' });
  const bodies = [];
  const urls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    urls.push([String(url), init.method, init.headers]);
    bodies.push(init.body);
    return new Response(JSON.stringify({ answers: { category: { choice: LABELS[0], confidence: 0.9 } } }));
  });
  const receipt = { store: 'Target', merchant: 'Target', date: '2026-10-26', total: 10.5, items: [{ description: 'MED-GUM', amount: 2 }, { description: 'MILK', plain: 'whole milk', amount: 3.5 }] };
  const history = [{ date: '2026-10-01', amount: 20, parts: [{ category: LABELS[0], amount: 15, notes: 'milk' }, { category: LABELS[1], amount: 5 }] }];
  const itemHistory = [
    { items: 'whole milk', category: LABELS[0], store: 'Target', date: '2026-09-01' },
    { items: 'gum', category: LABELS[1], store: null, date: '2026-08-01' },
  ];
  await categorizeItems(receipt, LABELS, history, itemHistory, { currentLabel: LABELS[0], ruleLabel: LABELS[0], occasions: ['Mom birthday in 3 days'] });
  mock.restoreAll();
  return { bodies, urls };
}

test('local provider: request body, URL and headers are byte-identical to the pre-remote version', async () => {
  const { bodies, urls } = await captureBodies();
  if (process.env.WRITE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify({ bodies, urls }, null, 2));
  assert.deepEqual({ bodies, urls }, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  assert.deepEqual(urls[0], ['http://decider.test:8080/v1/systemone', 'POST', { 'Content-Type': 'application/json' }]);
});
