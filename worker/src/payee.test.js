import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { similarity, payeeScore, storeScore, loadAliases } from './payee.js';

test('similarity: bank description noise, store number and city are ignored', () => {
  assert.ok(similarity("TST* Joe's Pizza #1234 BOSTON MA", "Joe's Pizza") >= 0.9);
  assert.equal(similarity('Target', 'TARGET'), 1);
});

test('similarity: businesses sharing only generic words stay low', () => {
  assert.ok(similarity('Dollar Tree', 'Dollar General') < 0.6);
  assert.ok(similarity('Pizza Hut', 'Pizza Ranch') <= 0.5);
});

test('similarity: a shortened brand still matches', () => {
  assert.ok(similarity('Costco Wholesale', 'Costco Whse') >= 0.7);
});

test('similarity: brands that are numbers', () => {
  assert.ok(similarity('7-Eleven', '7-ELEVEN 12345') >= 0.9);
  assert.ok(similarity('76', '76 FUEL #123') >= 0.9);
  assert.ok(similarity('76', '7-Eleven') < 0.6);
});

test('similarity: empty names score 0', () => {
  assert.equal(similarity('', 'Target'), 0);
  assert.equal(similarity('Target', null), 0);
});

test('similarity: one name contained in the other', () => {
  assert.ok(similarity('Walmart', 'WAL MART SUPERCENTER') >= 0.9);
  assert.ok(similarity('Price Chopper', 'JOES PRICE CHOPPER') >= 0.9);
});

test('payeeScore: the best score across the transaction payee strings', () => {
  assert.equal(payeeScore('Target', [null, undefined, 'TARGET 0123']), 1);
  assert.equal(payeeScore('Target', []), 0);
});

test('storeScore: the merchant name alone', () => {
  assert.equal(storeScore({ merchant: 'Target' }, ['Target']), 1);
});

test('storeScore: a website clue names the store when the merchant was misread', () => {
  const receipt = { merchant: 'Home Improvement', store_clues: ['frontend@menards.com'] };
  const score = storeScore(receipt, ['Menards']);
  assert.ok(score >= 0.7 && score <= 0.8, `score ${score}`);
});

test('storeScore: a clue is capped at 0.8, and loses 0.1 more when the merchant name matches nothing', () => {
  const score = storeScore({ merchant: '', store_clues: ['www.menards.com'] }, ['Menards']);
  // NOTE: the domain scores 0.9, the cap makes it 0.8, and an empty merchant (score under 0.3) costs another 0.1.
  assert.ok(Math.abs(score - 0.7) < 1e-9, `score ${score}`);
});

test('storeScore: card processor domains are ignored', () => {
  assert.equal(storeScore({ merchant: 'Joes Diner', store_clues: ['www.square.com'] }, ['Square']), 0);
  assert.equal(storeScore({ merchant: '', store_clues: ['pay.toasttab.com'] }, ['Toast']), 0);
});

test('storeScore: address and numeric clues and single words are ignored', () => {
  for (const clue of ['123 Main St', 'Springfield', 'Store 4455', '1500 Pkwy Drive Suite 2']) {
    assert.equal(storeScore({ merchant: '', store_clues: [clue] }, ['Springfield']), 0, clue);
  }
});

test('storeScore: a multi-word business name clue counts', () => {
  const score = storeScore({ merchant: '', store_clues: ['Hy-Vee Fuel Saver'] }, ['Hy-Vee Fuel Saver']);
  assert.ok(score > 0.5);
});

test('storeScore: a clue is penalized a little when the merchant name points elsewhere', () => {
  const withPenalty = storeScore({ merchant: 'Zzzz Qqqq', store_clues: ['www.menards.com'] }, ['Menards']);
  const without = storeScore({ merchant: '', store_clues: ['www.menards.com'] }, ['Menards']);
  assert.ok(withPenalty > 0);
  assert.ok(withPenalty <= without);
});

test('payeeScore: aliases link different names for the same merchant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payee-test-'));
  const file = path.join(dir, 'aliases.json');
  const before = config.aliasesPath;
  try {
    assert.ok(payeeScore('Walmart', ['WM SUPERCENTER']) < 0.6);
    fs.writeFileSync(file, JSON.stringify([['Walmart', 'WM SUPERCENTER']]));
    config.aliasesPath = file;
    loadAliases();
    assert.ok(payeeScore('Walmart', ['WM SUPERCENTER']) >= 0.9);
  } finally {
    config.aliasesPath = path.join(dir, 'missing.json');
    loadAliases(); // a missing file resets the aliases
    config.aliasesPath = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(payeeScore('Walmart', ['WM SUPERCENTER']) < 0.6);
});
