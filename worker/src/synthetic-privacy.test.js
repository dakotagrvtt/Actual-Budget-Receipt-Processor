// The hosted (remote) decider never sees the household's private words: synthetic PRIVATE_WORDS and PRIVATE_PLACES, names
// the reader's scan finds, card digits, addresses, the purchase date and category labels, wherever they hide (item lines,
// bank text, past notes, category notes, keywords, payees). Every reading under two budgets and several settings goes end to
// end through handleReceipt with a fake reader (name scan) and a fake hosted API; every body sent is searched.
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { config } from './config.js';
import { READING_NAMES, budget, fixture, readingOf, resetConfig, excludeFor, fakeActual, checkInvariants, chargeFor, day, quiet, keywordFile } from '../test/synthetic-harness.js';
import { checkReceipt } from './llm.js';

const { handleReceipt } = await import('./receipt.js');
const { resetProbeCache } = await import('./decider-remote.js');

afterEach(() => {
  mock.reset();
  resetConfig();
});

const KEY = 'sk-synthetic-NOT-A-REAL-KEY-000';
const LISTED = ['Sam', 'Quillby']; // PRIVATE_WORDS
const PLACES = ['Maplewood', 'Bristow']; // PRIVATE_PLACES
const FOUND = ['Alex', 'Jordan']; // not listed: only the reader's name scan finds them
const SECRETS = [...LISTED, ...PLACES, ...FOUND];

/** Mock the reader's name scan and the hosted API. Returns the API bodies sent. */
function remoteWorld({ answer = (body) => ({ answers: { category: { choice: 'C01', confidence: 0.9, probabilities: { C01: 0.9, C02: 0.1 } } }, usage: { input_tokens: 10 } }) } = {}) {
  const sent = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://reader.test/v1/chat/completions')) {
      const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
      const results = list.map((e) => ({
        id: e.id,
        names: FOUND.concat(LISTED).map((n) => new RegExp(`\\b${n}\\b`, 'i').exec(e.text)?.[0]).filter(Boolean).filter(() => e.field !== 'store or payee name'),
        places: PLACES.map((p) => new RegExp(`\\b${p}\\b`, 'i').exec(e.text)?.[0]).filter(Boolean).map((text) => ({ text, type: 'place' })),
      }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
    }
    if (u.startsWith('https://api.typesafe.test/')) {
      if (init?.headers?.Authorization !== `Bearer ${KEY}`) return new Response('no key', { status: 401 });
      const body = JSON.parse(init.body);
      sent.push(body);
      return new Response(JSON.stringify(answer(body)));
    }
    throw new Error(`unexpected request to ${u}`);
  });
  return sent;
}

/** Past purchases that carry private words in their notes (yours, at several stores). */
const history = () => [
  { id: 'h1', account: 'acct-chk', date: day(-20), amount: -2500, payee: 'p-fresh', notes: 'split by hand', is_parent: true, subtransactions: [
    { id: 'h1a', amount: -1500, category: 'c-groc', notes: 'BIRTHDAY CAKE FOR SAM' }, { id: 'h1b', amount: -1000, category: 'c-gift', notes: 'FLOWERS FROM MAPLEWOOD FLORIST for Alex' }] },
  { id: 'h2', account: 'acct-cc', date: day(-15), amount: -1200, payee: 'p-pharm', imported_payee: 'CORNER PHARMACY 4821 BRISTOW', category: 'c-med', notes: '#receipt old.jpg — items: RX JORDAN QUILLBY; COUGH DROPS' },
  { id: 'h3', account: 'acct-cc', date: day(-12), amount: -800, payee: 'p-hmart', category: 'c-kid', notes: 'socks for Sam (Daily Expenses / Clothing was wrong)' },
  { id: 'h4', account: 'acct-chk', date: day(-9), amount: -5000, payee: 'p-trans', category: null, notes: 'to Alex savings', transfer_id: 'x' },
];

async function run(name, b, settings = {}) {
  resetConfig({
    ...excludeFor(b), ...settings,
    deciderUrl: 'https://api.typesafe.test', llmUrl: 'http://reader.test',
    decider: { provider: 'remote', apiKey: KEY, remoteModel: 'jev-latest', preview: null, previewLabel: '' },
    privacy: { seedWords: LISTED, seedPlaces: PLACES },
  });
  resetProbeCache();
  mock.reset();
  quiet();
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'Kids / Kid': "Sam Quillby's clothes, toys and snacks", 'Fun / Gifts': 'presents for Alex and Jordan; anything from Maplewood Mall' }));
  if (settings.keywordMode) fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [
    ...JSON.parse(fs.readFileSync(keywordFile('standard-household'), 'utf8')).keywords,
    { phrase: 'for sam', category: 'Kids / Kid', store: null, strength: 'usually' },
    { phrase: 'alex', category: 'Fun / Gifts', store: 'Corner Pharmacy', strength: 'usually' },
  ] }));
  const fx = fixture(name);
  const txn = { ...chargeFor(fx), imported_payee: `${fx.importedPayee} CARD 4821 BRISTOW` };
  const { writes, labels } = await fakeActual(b, [txn, ...history()]);
  const sent = remoteWorld();
  let out;
  try {
    out = await handleReceipt({ basename: `${name}.jpg`, lastmod: new Date().toUTCString() }, checkReceipt(readingOf(fx)), 'test', labels, {});
  } catch (err) {
    assert.fail(`${name}: threw ${err.stack}`);
  }
  return { out, writes, labels, txn, sent, fx };
}

/** Search every body sent for anything private. */
function assertClean(sent, { labels, fx, where }) {
  const text = JSON.stringify(sent);
  for (const w of SECRETS) assert.doesNotMatch(text, new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, 'iu'), `${where}: "${w}" was sent`);
  // card digits on their own (an item number such as TPD/9999999 may contain them and is not a card)
  for (const digits of ['4821', '9999', '0000']) assert.doesNotMatch(text, new RegExp(`(?<!\\d)${digits}(?!\\d)`), `${where}: card digits ${digits} were sent`);
  assert.ok(!text.includes(KEY), `${where}: the API key is in a body`);
  if (fx.reading.date) assert.ok(!text.includes(fx.reading.date), `${where}: the purchase date was sent`);
  for (const l of labels.keys()) assert.ok(!text.toLowerCase().includes(l.toLowerCase()), `${where}: the label "${l}" was sent`);
  for (const clue of fx.reading.store_clues ?? []) assert.ok(!text.includes(clue), `${where}: store clue "${clue}" was sent`);
}

const SETTINGS = {
  plain: { receiptCheck: false },
  everything: { receiptCheck: true, similarItems: true, householdExamples: 15, keywordMode: 'hint', occasions: { enabled: true } },
  noExamples: { householdExamples: 0, similarItems: false, keywordMode: 'mixed' },
};

// The reader/decider matrix: every reading, three settings on the standard household, the loudest on the large one (emoji and accents).
for (const [bname, sname] of [['standard', 'plain'], ['standard', 'everything'], ['standard', 'noExamples'], ['large', 'everything']]) {
  const settings = SETTINGS[sname];
  test(`privacy: every reading, "${bname}" budget, "${sname}" settings: nothing private reaches the hosted decider, and the invariants hold`, async () => {
    const b = budget(bname);
    let requests = 0;
    for (const name of READING_NAMES) {
      const r = await run(name, b, settings);
      assertClean(r.sent, { labels: r.labels, fx: r.fx, where: `${bname}/${sname}/${name}` });
      checkInvariants(r, b, `${bname}/${sname}/${name}`);
      requests += r.sent.length;
    }
    assert.ok(requests > READING_NAMES.length, `only ${requests} requests were sent: the test would prove nothing`);
  });
}

test('privacy: the pharmacy receipt with names, a street and card digits is still categorized (pseudonyms, not silence)', async () => {
  const b = budget('standard');
  const { out, sent } = await run('pharmacy-names', b, SETTINGS.everything);
  const items = sent.filter((s) => s.state.item).map((s) => s.state.item);
  assert.ok(items.some((t) => /Person [A-Z]/.test(t)), items.join(' | '));
  assert.ok(items.some((t) => /a place/.test(t)), items.join(' | '));
  assert.notEqual(out.result, 'review', JSON.stringify(out.summary.problems));
});

/** grocery-basic with "category" (a word of the fixed question text) on the private list: every request is held back. */
async function heldBack() {
  const saved = LISTED.slice();
  LISTED.push('category');
  try {
    return await run('grocery-basic', budget('standard'), { receiptCheck: false });
  } finally {
    LISTED.splice(0, LISTED.length, ...saved);
  }
}

test('privacy: a private word inside the fixed question text holds everything back: nothing is sent and the receipt goes to review', async () => {
  const r = await heldBack();
  assert.equal(r.sent.length, 0);
  assert.equal(r.out.result, 'review');
  assert.equal(r.writes.length, 0);
});

test('privacy: when every item is held back, the review reason says so', async () => {
  const r = await heldBack();
  assert.match(r.out.summary.problems.join('\n'), /held back from the hosted decider/);
});
