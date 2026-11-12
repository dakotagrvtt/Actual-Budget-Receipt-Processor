// Unit checks for keywords.js. Run: npm test (from worker/; exits 1 on any failure)
import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchKeyword, normalize, alwaysPhrase, addKeyword, removeKeyword, harvestAlways, loadKeywords, keywordAction, tagPhrases } from '../src/keywords.js';
import { stripDepartment, similarItems } from '../src/categorize.js';
import { stripAnnotations } from '../src/reconcile.js';

// Paths resolve from this file, so the test runs from any directory.
const CLI = fileURLToPath(new URL('../src/keyword-cli.js', import.meta.url));
const CONFIG_URL = new URL('../src/config.js', import.meta.url).href;

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`);
  }
};
const kw = (phrase, category = 'A / One', store = null) => ({ phrase, category, store });
const m = (text, store, ...kws) => matchKeyword([stripDepartment(text)], store, kws);
const hit = (text, phrase) => m(text, null, kw(phrase))?.phrase === phrase;

ok('normalize', normalize("PANTENE10 SH Reese's-Pieces") === 'pantene 10 sh reeses pieces');
ok('gold bond', hit('GOLD BOND HEALING', 'Gold Bond'));
ok('hummus', hit('ORG HUMMUS', 'hummus'));
ok('pantene10', hit('PANTENE10 SH', 'Pantene'));
ok('nerds/Nerds', hit('NERDS', 'Nerds'));
ok('nerds/nerd', hit('NERDS', 'nerd'));
ok('nerd/nerds', hit('NERD ROPE', 'nerds'));
ok('reeses', hit('REESES PIECES', "Reese's Pieces"));
ok('drpepper', hit('DRPEPPER 12PK', 'Dr Pepper'));
ok('meatballs !ball', m('MEATBALLS', null, kw('ball')) === null);
ok('peppermints !mints', m('PEPPERMINTS', null, kw('mints')) === null);
ok('mints ok', hit('MINTS', 'mints'));
ok('med-dvd', hit("MED-DVD'S", 'dvd'));
ok('plain name used', matchKeyword(['XYZ', 'gold bond lotion'], null, [kw('Gold Bond')])?.phrase === 'Gold Bond');
const g = kw('milk', 'G / Groceries');
const s = kw('milk', 'D / Dairy', 'Costco');
ok('store beats global', m('MILK', 'COSTCO WHOLESALE', g, s)?.category === 'D / Dairy');
ok('store scoped elsewhere ignored', m('MILK', 'Target', g, s)?.category === 'G / Groceries');
ok('store whole tokens', m('MILK', 'Costcoo', s) === null);
ok('more tokens beat fewer', m('GOLD BOND', null, kw('gold', 'X / x'), kw('gold bond', 'Y / y'))?.category === 'Y / y');
const t = m('GOLD BOND', null, kw('gold', 'X / x'), kw('bond', 'Y / y'));
ok('tie', Array.isArray(t?.tie) && t.tie.length === 2);
ok('same-category tie is a match', m('GOLD BOND', null, kw('gold', 'X / x'), kw('bond', 'X / x'))?.category === 'X / x');
ok('short token no stemming', m('BUS', null, kw('bu')) === null);
ok('alwaysPhrase explicit', alwaysPhrase('x | #always Gold Bond; foo', null)?.phrase === 'Gold Bond');
ok('alwaysPhrase bare', alwaysPhrase('Gold Bond #always', 'Gold Bond')?.phrase === 'Gold Bond');
ok('alwaysPhrase too long', !!alwaysPhrase('#always a b c d e', null)?.skip);
ok('alwaysPhrase none', alwaysPhrase('hello', 'x') === null);
ok('stripAnnotations #always', stripAnnotations('Gold Bond #always') === 'Gold Bond' && stripAnnotations('#always Gold Bond') === null);

// plurals: only exact, or the other side plus s/es
ok('cans !candy canes', m('CANDY CANES', null, kw('cans')) === null);
ok('can/cans', hit('CANS', 'can') && hit('CAN', 'cans'));
ok('box/boxes', hit('BOXES', 'box'));
// joined matches respect token boundaries
ok('ice cream !spice creamer', m('SPICE CREAMER', null, kw('ice cream')) === null);
ok('ice cream ok', hit('ICE CREAM', 'ice cream') && hit('ICECREAM 1PT', 'ice cream'));
ok('Drpepper keyword <- DR PEPPER', hit('DR PEPPER 12PK', 'Drpepper'));
ok('short one-word keyword not joined', m('CO LA', null, kw('cola')) === null);
ok('one-word !mid-token', m('XDR PEPPERS', null, kw('drpepper')) === null);
// #always phrases
ok('list note: bare tag takes the text before it', alwaysPhrase('A; B #always', 'A; B')?.phrase === 'B');
ok('explicit phrase with ; ok', alwaysPhrase('#always Gold Bond; x', 'A; B')?.phrase === 'Gold Bond');
ok('department stripped', alwaysPhrase("#always MED-DVD'S", null)?.phrase === "DVD'S");
// harvest respects removals, conflicting tags, and records the transaction
config.keywordsPath = '/tmp/keywords.unit-test.json';
await fs.rm(config.keywordsPath, { force: true });
const tag = (phrase, category) => [{ txnId: 't1', notes: `#always ${phrase}`, item: null, category }];
await harvestAlways(tag('Gold Bond', 'A / One'));
let list = await loadKeywords();
ok('harvest adds', list.length === 1 && list[0].from === 'actual' && list[0].fromTxn === 't1');
await harvestAlways(tag('gold bond', 'B / Two'));
ok('conflicting tag skipped', (await loadKeywords())[0].category === 'A / One');
await removeKeyword('Gold Bond');
await harvestAlways(tag('Gold Bond', 'A / One'));
ok('removed stays removed', (await loadKeywords()).length === 0);
await addKeyword({ phrase: 'Gold Bond', category: 'A / One' });
await removeKeyword('Gold Bond');
await addKeyword({ phrase: 'Gold Bond', category: 'C / Three' });
await removeKeyword('Gold Bond');
ok('removed list in file', JSON.parse(await fs.readFile(config.keywordsPath, 'utf8')).removed.length === 1);
await addKeyword({ phrase: 'Gold Bond', category: 'C / Three' });
await harvestAlways(tag('Gold Bond', 'A / One'));
ok('cli add clears removal; keyword kept', (await loadKeywords()).length === 1);
await Promise.all([addKeyword({ phrase: 'x1', category: 'A / One' }), addKeyword({ phrase: 'x2', category: 'A / One' }), addKeyword({ phrase: 'x3', category: 'A / One' })]);
ok('concurrent adds all kept', (await loadKeywords()).length === 4);
await fs.rm(config.keywordsPath, { force: true });

// strength: mixed-mode dispatch
const al = { phrase: 'a', strength: 'always' };
const us = { phrase: 'u', strength: 'usually' };
const none = { phrase: 'n' };
ok('mixed: always files', keywordAction('mixed', al) === 'file');
ok('mixed: usually hints', keywordAction('mixed', us) === 'hint');
ok('mixed: no strength = usually', keywordAction('mixed', none) === 'hint');
ok('final/hint ignore strength', keywordAction('final', us) === 'file' && keywordAction('hint', al) === 'hint');
ok('off ignores', keywordAction('off', al) === 'none');
// #usually tags
ok('alwaysPhrase #usually', alwaysPhrase('x | #usually Gold Bond; foo', null)?.phrase === 'Gold Bond' && alwaysPhrase('#usually Gold Bond', null)?.strength === 'usually');
ok('alwaysPhrase #always strength', alwaysPhrase('#always Gold Bond', null)?.strength === 'always');
ok('alwaysPhrase bare #usually', alwaysPhrase('Gold Bond #usually', 'Gold Bond')?.phrase === 'Gold Bond');
ok('stripAnnotations #usually', stripAnnotations('Gold Bond #usually') === 'Gold Bond' && stripAnnotations('#usually Gold Bond') === null && stripAnnotations('A #always; B #usually') === 'A; B');
const tag2 = (kind, phrase, category, txnId = 't2') => [{ txnId, notes: `#${kind} ${phrase}`, item: null, category }];
await fs.rm(config.keywordsPath, { force: true });
await harvestAlways(tag2('usually', 'Nerds', 'A / One'));
await harvestAlways(tag2('always', 'Gold Bond', 'A / One'));
list = await loadKeywords();
ok('harvest strengths', list.find((k) => k.phrase === 'Nerds')?.strength === 'usually' && list.find((k) => k.phrase === 'Gold Bond')?.strength === 'always');
await harvestAlways(tag2('always', 'nerds', 'A / One', 't3'));
ok('tag updates strength (same category)', (await loadKeywords()).find((k) => k.phrase === 'Nerds')?.strength === 'always' && (await loadKeywords()).length === 2);
await harvestAlways(tag2('usually', 'Gold Bond', 'B / Two', 't4'));
ok('strength tag with other category ignored', (await loadKeywords()).find((k) => k.phrase === 'Gold Bond')?.strength === 'always' && (await loadKeywords()).find((k) => k.phrase === 'Gold Bond').category === 'A / One');
await addKeyword({ phrase: 'milk', category: 'A / One' });
await harvestAlways(tag2('always', 'milk', 'A / One', 't5'));
ok('tag does not touch cli keyword', (await loadKeywords()).find((k) => k.phrase === 'milk')?.strength === 'usually');
// CLI flags
const notes = '/tmp/category-notes.unit-test.json';
await fs.writeFile(notes, JSON.stringify({ 'A / One': '', 'B / Two': '' }));
await fs.rm(config.keywordsPath, { force: true });
const cli = (...a) => execFileSync('node', [CLI, ...a], { env: { ...process.env, KEYWORDS_PATH: config.keywordsPath, CATEGORY_NOTES_PATH: notes, KEYWORD_MODE: 'mixed' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
cli('add', 'Gold Bond', 'one');
cli('add', 'Nerds', 'two', '--always');
cli('add', 'Mints', '--usually', 'one', '--at', 'Target');
list = await loadKeywords();
ok('cli default usually', list.find((k) => k.phrase === 'Gold Bond')?.strength === 'usually');
ok('cli --always', list.find((k) => k.phrase === 'Nerds')?.strength === 'always');
ok('cli --usually + --at', list.find((k) => k.phrase === 'Mints')?.strength === 'usually' && list.find((k) => k.phrase === 'Mints').store === 'Target');
ok('cli list shows strength', /Nerds.*\[always\]/.test(cli('list')));
ok('cli test shows strength and action', /\[always\]/.test(cli('test', 'NERDS ROPE')) && /filed by keyword/.test(cli('test', 'NERDS ROPE')) && /hint/.test(cli('test', 'GOLD BOND LOTION')));
let bothFailed = false;
try { cli('add', 'x', 'one', '--always', '--usually'); } catch { bothFailed = true; }
ok('cli rejects both flags', bothFailed);
await fs.rm(notes, { force: true });
// similarItems
const past = [
  { items: 'M&Ms', category: 'Daily Expenses / Child', store: 'Target' },
  { items: 'Whole milk 1 gal', category: 'Daily Expenses / Groceries', store: 'Costco' },
  { items: 'Gold Bond lotion', category: 'Daily Expenses / Sam', store: null },
];
const sim = similarItems({ description: "M&M'S" }, past, 8);
ok("similar: M&M'S finds M&Ms only", sim.length === 1 && sim[0].filed_as === 'Daily Expenses / Child');
ok('similar: unrelated finds nothing', similarItems({ description: 'WD40 SPRAY' }, past, 8).length === 0);
ok('similar: words still match', similarItems({ description: 'GOLD BOND HEALING' }, past, 8)[0]?.filed_as === 'Daily Expenses / Sam');
await fs.rm(config.keywordsPath, { force: true });

// tags before a comma / paren do not grab the next item
ok('bare tag before comma', alwaysPhrase('GOLD BOND #always, TIDE PODS', null)?.phrase === 'GOLD BOND');
ok('bare tag before paren', alwaysPhrase('Gold Bond #always (for Sam)', null)?.phrase === 'Gold Bond');
ok('explicit phrase stops at comma', alwaysPhrase('#always Gold Bond, Tide', null)?.phrase === 'Gold Bond');
ok('bare tag after separator', alwaysPhrase('Tide, Gold Bond #usually', null)?.phrase === 'Gold Bond');
ok('stripAnnotations keeps items after tag', stripAnnotations('GOLD BOND #always, TIDE PODS') === 'GOLD BOND, TIDE PODS' && stripAnnotations('Gold Bond #always (for Sam)') === 'Gold Bond (for Sam)');
// every tag is harvested (matchAll)
const two = tagPhrases('Gold Bond #always, Nerds #usually, #always Tide', null);
ok('all tags found', two.length === 3 && two[0].phrase === 'Gold Bond' && two[1].phrase === 'Nerds' && two[1].strength === 'usually' && two[2].phrase === 'Tide');
// a worker note in front of the tag (even cut off) is not part of the phrase
ok('pipeline note before a tag', tagPhrases('MILK (pipeline: 0.37 less than read, from the tax #always', null)[0].phrase === 'MILK' && tagPhrases('MILK (maybe Child 34%) #usually', null)[0].phrase === 'MILK');
await fs.rm(config.keywordsPath, { force: true });
await harvestAlways([{ txnId: 't9', date: '2026-01-01', notes: 'Gold Bond #always, Nerds #usually', item: null, category: 'A / One' }]);
list = await loadKeywords();
ok('multi-tag note harvests both', list.length === 2);
// conflicting strengths: the newest tag wins, whatever the order; one write
await fs.rm(config.keywordsPath, { force: true });
await harvestAlways([
  { txnId: 'new', date: '2026-03-01', notes: '#usually Tide', item: null, category: 'A / One' },
  { txnId: 'old', date: '2026-01-01', notes: '#always Tide', item: null, category: 'A / One' },
]);
list = await loadKeywords();
ok('newest tag wins', list.length === 1 && list[0].strength === 'usually' && list[0].fromTxn === 'new');
await harvestAlways([
  { txnId: 'a', date: '2026-02-01', notes: '#always Tide', item: null, category: 'A / One' },
  { txnId: 'b', date: '2026-04-01', notes: '#usually Tide', item: null, category: 'A / One' },
  { txnId: 'c', date: '2026-03-01', notes: '#always Tide', item: null, category: 'A / One' },
]);
ok('newest tag wins again, no flip-flop', (await loadKeywords())[0].strength === 'usually');
const mt = (await fs.stat(config.keywordsPath)).mtimeMs;
await harvestAlways([{ txnId: 'c', date: '2026-03-01', notes: '#usually Tide', item: null, category: 'A / One' }]);
ok('no change, no write', (await fs.stat(config.keywordsPath)).mtimeMs === mt);
await fs.rm(config.keywordsPath, { force: true });
// learned keywords with size limits: list shows both, test checks each one and says which stops it
await fs.writeFile(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'coke', category: 'A / One', store: 'Costco', strength: 'usually', from: 'learned', added: '2026-10-01', maxCents: 3000, maxItemCents: 500 }] }));
ok('cli list shows both limits', /\(charges up to \$30\.00, items up to \$5\.00\)/.test(cli('list')));
ok('cli test without amounts says what was not checked', /charge limit was not checked \(add --amount/.test(cli('test', 'COKE', '--at', 'Costco')) && /item price limit was not checked \(add --item-amount/.test(cli('test', 'COKE', '--at', 'Costco')));
const fitting = cli('test', 'COKE', '--at', 'Costco', '--amount', '13.78', '--item-amount', '1.58');
ok('cli test within both limits has no complaint', !/Not applied|not checked/.test(fitting));
ok('cli test names the item limit', /Not applied: the item price is over the limit/.test(cli('test', 'COKE', '--at', 'Costco', '--amount', '13.78', '--item-amount', '15.49')) && !/charge is over/.test(cli('test', 'COKE', '--at', 'Costco', '--amount', '13.78', '--item-amount', '15.49')));
ok('cli test names the charge limit', /Not applied: the charge is over the limit/.test(cli('test', 'COKE', '--at', 'Costco', '--amount', '50', '--item-amount', '1.58')));
let badItemAmount = false;
try { cli('test', 'COKE', '--item-amount', 'x'); } catch { badItemAmount = true; }
ok('cli --item-amount needs a number', badItemAmount);
const { keywordFits } = await import('../src/keywords.js');
ok('keywordFits: both limits, unknown sizes, yours and older keywords', keywordFits({ from: 'learned', maxCents: 3000, maxItemCents: 500 }, 1378, 158) && !keywordFits({ from: 'learned', maxCents: 3000, maxItemCents: 500 }, 1378, 1549) && !keywordFits({ from: 'learned', maxCents: 3000, maxItemCents: 500 }, 5000, 158) && !keywordFits({ from: 'learned', maxItemCents: 500 }, 1378) && keywordFits({ from: 'learned', maxCents: 3000 }, 1378) && keywordFits({ from: 'cli', maxItemCents: 1 }, 1, 99999));
// the size limits are applied before matching, as in the worker: a keyword over its limit lets a lower one through
await fs.writeFile(config.keywordsPath, JSON.stringify({ keywords: [
  { phrase: 'coke zero', category: 'B / Two', store: 'Costco', strength: 'usually', from: 'learned', added: '2026-10-01', maxItemCents: 500 },
  { phrase: 'coke', category: 'A / One', store: 'Costco', strength: 'usually', from: 'learned', added: '2026-10-01' },
] }));
ok('cli test: within the item limit the longer keyword wins', /Match: "coke zero"/.test(cli('test', 'COKE ZERO', '--at', 'Costco', '--item-amount', '1.58')));
ok('cli test: over the item limit the next keyword applies', /Match: "coke" .*A \/ One/.test(cli('test', 'COKE ZERO', '--at', 'Costco', '--item-amount', '15.49')) && !/Not applied/.test(cli('test', 'COKE ZERO', '--at', 'Costco', '--item-amount', '15.49')));
ok('cli test: no amount given, the limited keyword is shown and the check is reported', /Match: "coke zero"/.test(cli('test', 'COKE ZERO', '--at', 'Costco')) && /not checked/.test(cli('test', 'COKE ZERO', '--at', 'Costco')));
await fs.writeFile(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'coke zero', category: 'B / Two', store: 'Costco', from: 'learned', added: '2026-10-01', maxItemCents: 500 }] }));
ok('cli test: the only keyword over its limit says so', /Match: "coke zero"/.test(cli('test', 'COKE ZERO', '--at', 'Costco', '--item-amount', '15.49')) && /Not applied: the item price is over the limit/.test(cli('test', 'COKE ZERO', '--at', 'Costco', '--item-amount', '15.49')));
await fs.rm(config.keywordsPath, { force: true });
// KEYWORD_MODE validation
const modeOf = (v) => execFileSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => console.log('MODE=' + m.config.keywordMode))`], { env: { ...process.env, KEYWORD_MODE: v }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
ok('KEYWORD_MODE mixed accepted', modeOf('Mixed').includes('MODE=mixed'));
ok('KEYWORD_MODE invalid -> off', modeOf('bogus').includes('MODE=off'));
const warned = (() => {
  const r = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)})`], { env: { ...process.env, KEYWORD_MODE: 'bogus' }, encoding: 'utf8' });
  return r.stderr.includes('KEYWORD_MODE') && r.stderr.split('KEYWORD_MODE').length === 2;
})();
ok('KEYWORD_MODE invalid warns once', warned);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

test('normalize: accents and letters without a decomposition become ASCII, other scripts stay words', () => {
  assert.equal(normalize('Crème Fraîche'), 'creme fraiche');
  assert.equal(normalize('Øl ÆBLE straße łódź'), 'ol aeble strasse lodz');
  assert.equal(normalize('Молоко 1л'), 'молоко 1 л');
  assert.equal(normalize('牛乳'), '牛乳');
});
