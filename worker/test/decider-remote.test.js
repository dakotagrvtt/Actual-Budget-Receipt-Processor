// The remote decider end to end through categorizeItems: fetch is mocked for both the local reader (name scan) and the
// hosted API, so no network and no model is used.
import test, { mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { categorizeItems } from '../src/categorize.js';
import { findLeaks } from '../src/anonymize.js';
import { loadPrivate } from '../src/private-words.js';
import { resetProbeCache, redact, remoteReady, remoteProbe, modelNames, modelWarning, DeciderAuthError } from '../src/decider-remote.js';
import { isTransient, isSetupProblem, isCounted, countedBy } from '../src/errors.js';
import { readSetupProblem, clearSetupProblem, useAlertFile } from '../src/alert.js';

const KEY = 'sk-test-SECRET-key-123';
const LABELS = ['Daily Expenses / Groceries', 'Daily Expenses / Sam', 'Fun / Gifts'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-remote-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const saved = { decider: { ...config.decider }, privacy: { ...config.privacy }, deciderUrl: config.deciderUrl, llmUrl: config.llmUrl, keywordMode: config.keywordMode, similarItems: config.similarItems, keywordHintWeight: config.keywordHintWeight, receiptCheck: config.receiptCheck };
beforeEach(() => {
  let n = 0;
  const dir = path.join(tmp, `t${++n}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir);
  Object.assign(config, { keywordsPath: path.join(dir, 'keywords.json'), categoryNotesPath: path.join(dir, 'notes.json'), keywordMode: 'off', similarItems: true, keywordHintWeight: 1, excludeGroups: [], excludeCategories: [], deciderUrl: 'https://api.typesafe.test', llmUrl: 'http://reader.test' });
  Object.assign(config.decider, { provider: 'remote', apiKey: KEY, remoteModel: 'jev-latest', preview: null, previewLabel: 'r1' });
  Object.assign(config.privacy, { wordsPath: path.join(dir, 'private-words.json'), scanCachePath: path.join(dir, 'scan-cache.json'), seedWords: ['Sam'], previewRoot: path.join(dir, 'research') });
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ [LABELS[1]]: "Sam's clothes and snacks" }));
});
afterEach(() => {
  mock.restoreAll();
  Object.assign(config, { deciderUrl: saved.deciderUrl, llmUrl: saved.llmUrl, keywordMode: saved.keywordMode, similarItems: saved.similarItems, keywordHintWeight: saved.keywordHintWeight, receiptCheck: saved.receiptCheck });
  Object.assign(config.decider, saved.decider);
  Object.assign(config.privacy, saved.privacy);
});

const reply = (choice, confidence, probabilities) => ({ answers: { category: { choice, confidence, ...(probabilities ? { probabilities } : {}) } }, usage: { input_tokens: 1000 } });

/**
 * Mock fetch. `names` = the names the reader "finds" in any text containing them (only in fields `nameFields`, when given);
 * `api(body, init, n)` answers the hosted API.
 * Returns what was seen: the reader calls, the API calls (body + headers).
 */
function mockWorld({ names = [], api = () => reply('C01', 0.9), reader, flagStores = false, places = () => [], nameFields = null } = {}) {
  const seen = { reader: [], api: [] };
  mock.method(globalThis, 'fetch', async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://reader.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      seen.reader.push(body);
      if (reader) return reader(body);
      const list = JSON.parse(body.messages.at(-1).content);
      const results = list.map((e) => ({ id: e.id, places: places(e.text, e.field), names: (e.field === 'store or payee name' && !flagStores) || (nameFields && !nameFields.includes(e.field)) ? [] : names.map((n) => new RegExp(n, 'i').exec(e.text)?.[0]).filter(Boolean) }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
    }
    if (u.startsWith('https://api.typesafe.test/v1/systemone')) {
      const body = JSON.parse(init.body);
      seen.api.push({ url: u, headers: init.headers, body });
      const out = api(body, init, seen.api.length - 1);
      if (out instanceof Response) return out;
      return new Response(typeof out === 'string' ? out : JSON.stringify(out));
    }
    throw new Error(`unexpected request to ${u}`);
  });
  return seen;
}

const receipt = (...descriptions) => ({
  store: 'POS 4242 TARGET 1234 SPRINGFIELD IL', payee: 'Target', merchant: 'Target', date: '2026-10-26', total: 10,
  store_clues: ['12 Oak Street'], card_last4: '4242', payment_method: 'visa', cash_tendered: null, date_as_printed: '10/26/26',
  items: descriptions.map((description) => ({ description, amount: 2 })),
});
const run = (r, extra = {}) => categorizeItems(r, LABELS, [], [], { businessNames: ['Target'], ...extra });

test('remote: sends Bearer key and model, codes instead of labels, and maps the answer back', async () => {
  const seen = mockWorld({ api: () => reply('C02', 0.8, { C01: 0.1, C02: 0.8, C03: 0.1 }) });
  const r = receipt('MILK');
  const how = await run(r);
  assert.equal(how, 'jev-latest (remote), 3 categories');
  assert.equal(seen.api.length, 1);
  assert.equal(seen.api[0].url, 'https://api.typesafe.test/v1/systemone');
  assert.equal(seen.api[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.api[0].body.model, 'jev-latest');
  assert.deepEqual(Object.keys(seen.api[0].body.questions.category.criteria), ['C01', 'C02', 'C03']);
  assert.deepEqual(Object.keys(seen.api[0].body).sort(), ['model', 'questions', 'state']);
  assert.deepEqual([r.items[0].category, r.items[0].confidence], [LABELS[1], 0.8]);
  assert.deepEqual(r.items[0].probabilities, { [LABELS[0]]: 0.1, [LABELS[1]]: 0.8, [LABELS[2]]: 0.1 });
  // nothing about the receipt beyond item, store and amounts, and no key in the body
  const sent = JSON.stringify(seen.api[0].body);
  for (const s of ['12 Oak Street', '4242', 'visa', '10/26/26', '2026-10-26', KEY, ...LABELS]) assert.ok(!sent.includes(s), `${s} was sent`);
});

test('remote: an answer that is not one of the codes is an invalid, unsure item', async () => {
  mockWorld({ api: () => reply('C99', 0.9) });
  const r = receipt('MILK');
  await run(r);
  assert.equal(r.items[0].category, null);
  assert.match(r.items[0].invalidAnswer, /not one of the categories/);
});

test('remote: keyword hint reweighs the mapped-back probabilities', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'gum', category: LABELS[2], store: null, strength: 'usually' }] }));
  config.keywordMode = 'hint';
  config.keywordHintWeight = 4;
  const seen = mockWorld({ api: () => reply('C01', 0.6, { C01: 0.6, C02: 0.1, C03: 0.3 }) });
  const r = receipt('GUM');
  await run(r);
  assert.deepEqual(seen.api[0].body.state.household_keyword, { phrase: 'gum', category: 'C03' });
  assert.equal(r.items[0].category, LABELS[2]); // 0.3*4 beats 0.6
  assert.deepEqual(r.items[0].modelSaid.category, LABELS[0]);
  assert.equal(r.items[0].source, 'keyword-hint');
});

test('remote: an item filed by keyword is not sent, and a receipt of only such items makes no call at all', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'milk', category: LABELS[0], store: null, strength: 'always' }] }));
  config.keywordMode = 'final';
  const seen = mockWorld();
  const r = receipt('MILK');
  await run(r);
  assert.equal(seen.api.length + seen.reader.length, 0);
  assert.equal(r.items[0].category, LABELS[0]);
});

test('remote errors: 429 and 5xx and a network failure are transient; 401 says to check the key; none shows the key', async () => {
  for (const status of [429, 500, 503]) {
    mockWorld({ api: () => new Response(`slow down ${KEY}`, { status }) });
    await assert.rejects(run(receipt('X')), (e) => e.name === 'TransientError' && !e.message.includes(KEY) && e.message.includes(`HTTP ${status}`));
    mock.restoreAll();
  }
  mockWorld({ api: () => { throw new TypeError(`fetch failed for Authorization: Bearer ${KEY}`); } });
  await assert.rejects(run(receipt('X')), (e) => e.name === 'TransientError' && !e.message.includes(KEY));
  mock.restoreAll();
  for (const status of [401, 403]) {
    mockWorld({ api: () => new Response(`bad key ${KEY}`, { status }) });
    await assert.rejects(run(receipt('X')), (e) => e instanceof DeciderAuthError && isSetupProblem(e) && !isTransient(e) && /check DECIDER_API_KEY in \.env and run \.\/receipts restart/.test(e.message) && !e.message.includes(KEY));
    mock.restoreAll();
  }
});

test('remote errors: 400 and 413 leave that item unsure and the rest of the receipt goes on', async () => {
  for (const status of [400, 413]) {
    const seen = mockWorld({ api: (_b, _i, n) => (n === 0 ? new Response(`you sent Bearer ${KEY}`, { status }) : reply('C01', 0.9)) });
    const r = receipt('FIRST', 'SECOND');
    await run(r);
    assert.equal(seen.api.length, 2);
    assert.equal(r.items[0].category, null);
    assert.match(r.items[0].invalidAnswer, new RegExp(`refused this item \\(HTTP ${status}\\)`));
    assert.ok(!JSON.stringify(r.items[0]).includes(KEY));
    assert.equal(r.items[1].category, LABELS[0]);
    mock.restoreAll();
  }
});

test('remote errors: 422, other 4xx and too many categories mean the setup is wrong: a SetupError (stop the cycle, no attempt), never transient', async () => {
  const body = '{"detail":[{"loc":["body","state"],"msg":"bad","input":{"item":"NETWORK CABLE timed out 503 502"}}]}';
  for (const status of [422, 404, 405]) {
    mockWorld({ api: () => new Response(body, { status }) });
    await assert.rejects(run(receipt('X')), (e) => isSetupProblem(e) && e.permanent === true && !isTransient(e) && e.message.includes(`HTTP ${status}; the server said: `));
    mock.restoreAll();
  }
  // the body behind the fixed prefix says "network" and "503", and still is not an outage
  mockWorld({ api: () => new Response(body, { status: 422 }) });
  const err = await run(receipt('X')).catch((e) => e);
  assert.match(err.message, /network/i);
  assert.match(err.message, /503/);
  assert.equal(isTransient(err), false);
  mock.restoreAll();
  // more categories than the service takes
  const many = Array.from({ length: 256 }, (_, i) => `Group / Cat ${i}`);
  mockWorld();
  await assert.rejects(categorizeItems(receipt('X'), many, [], [], { businessNames: [] }), (e) => isSetupProblem(e) && !isTransient(e) && /at most 255 categories/.test(e.message));
});

test('redact: the key and any bearer token are blanked', () => {
  assert.equal(redact(`oops ${KEY} and Bearer abc.def-123`), 'oops [key] and Bearer [key]');
});

test('name scan: names the reader finds become pseudonyms and are remembered; the listed word works without the reader', async () => {
  const seen = mockWorld({ names: ['Jo'] });
  const r = receipt("BDAY GIFT FOR JO", 'SAMS SNACK');
  r.items[0].description = 'BDAY GIFT FOR Jo';
  await run(r);
  const state = seen.api[0].body.state;
  assert.equal(state.item, 'BDAY GIFT FOR Person B'); // Sam (seed) is A, Jo is found second
  assert.equal(seen.api[1].body.state.other_items_on_receipt[0], 'BDAY GIFT FOR Person B');
  assert.equal(seen.api[0].body.questions.category.criteria.C02, "Person A: Person A's clothes and snacks");
  const p = await loadPrivate();
  assert.deepEqual(p.found.map((f) => f.word), ['Jo']);
  assert.deepEqual(p.words, ['Sam']);
  assert.deepEqual(p.order, ['sam', 'jo']);
  // the reader was shown typed, labelled fields
  const asked = JSON.parse(seen.reader[0].messages.at(-1).content);
  assert.ok(asked.some((e) => e.field === 'item line from a Target receipt'));
  assert.ok(asked.some((e) => e.field === 'description of a budget category'));
  assert.match(seen.reader[0].messages[0].content, /Never report businesses/);
});

test('business names: "Papa John\'s" is kept only in full; the lone word John is hidden everywhere else (the flagged word is not exempt)', async () => {
  const seen = mockWorld({ names: ['John'] });
  const r = receipt("PAPA JOHN'S PIZZA", 'GIFT CARD FOR JOHN');
  await run(r, { businessNames: ['Target', "Papa John's"] });
  assert.equal(seen.api[0].body.state.item, "PAPA JOHN'S PIZZA");
  assert.equal(seen.api[1].body.state.item, 'GIFT CARD FOR Person B');
  assert.equal(seen.api[0].body.state.other_items_on_receipt[0], 'GIFT CARD FOR Person B');
  assert.deepEqual((await loadPrivate()).found.map((f) => f.word), ['JOHN']);
});

test('business names: a transfer payee like "Alex\'s Checking" is not a business; GIFT CARD FOR ALEX is hidden (and even if it were listed, only its full span is kept)', async () => {
  const seen = mockWorld({ names: ['Alex'] });
  await run(receipt('GIFT CARD FOR ALEX'));
  assert.equal(seen.api[0].body.state.item, 'GIFT CARD FOR Person B');
  mock.restoreAll();
  const seen2 = mockWorld({ names: ['Alex'] });
  await run(receipt('GIFT CARD FOR ALEX', "ALEX'S CHECKING"), { businessNames: ['Target', "Alex's Checking"] });
  assert.equal(seen2.api[0].body.state.item, 'GIFT CARD FOR Person B');
});

test('business names: a payee that contains a word you listed yourself is never kept ("Sam\'s Club" with Sam on your list)', async () => {
  const seen = mockWorld({});
  await run(receipt("SAM'S CLUB MEMBERSHIP"), { businessNames: ['Target', "Sam's Club"] });
  assert.equal(seen.api[0].body.state.item, "Person A'S CLUB MEMBERSHIP");
});

test('business names: the receipt merchant and keyword stores are kept in full; stores in past purchases are not trusted', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'zzz', category: LABELS[0], store: 'Ruby Cafe', strength: 'usually' }] }));
  config.keywordMode = 'hint';
  const seen = mockWorld({ names: ['Ruby', 'Hank', 'Jo'] });
  const r = receipt('FROM RUBY TUESDAY CARD, RUBY CAFE, HANK HARDWARE, RUBY JO'); // "FROM" is a person cue, so the reader's names in this item line are believed
  r.merchant = 'Ruby Tuesday';
  await categorizeItems(r, LABELS, [], [{ items: 'x', category: LABELS[0], store: 'Hank Hardware', date: '2026-01-01' }], { businessNames: ['Target'] });
  const item = seen.api[0].body.state.item;
  assert.match(item, /^FROM RUBY TUESDAY CARD, RUBY CAFE, Person \w+ HARDWARE, Person \w+ Person \w+$/);
});

test('name scan: a word on the "not a name" list is sent as it is', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notNames: ['Dove'], found: [], order: [] }));
  const seen = mockWorld({ names: ['Dove'] });
  await run(receipt('DOVE SOAP'));
  assert.equal(seen.api[0].body.state.item, 'DOVE SOAP');
  assert.deepEqual((await loadPrivate()).found, []);
});

test('name scan: texts already scanned are not scanned again (cache)', async () => {
  const seen = mockWorld({ names: ['Jo'] });
  await run(receipt('GIFT FOR JO'));
  const first = seen.reader.length;
  assert.equal(first, 1);
  await run(receipt('GIFT FOR JO'));
  assert.equal(seen.reader.length, first);
  assert.equal(seen.api.length, 2);
  const cache = JSON.parse(fs.readFileSync(config.privacy.scanCachePath, 'utf8'));
  assert.ok(Object.values(cache.entries).some((e) => e.people.includes('JO')));
  // a new text is scanned, and only that one
  await run(receipt('GIFT FOR JO', 'TOWELS'));
  assert.equal(seen.reader.length, first + 1);
  assert.equal(JSON.parse(seen.reader.at(-1).messages.at(-1).content).filter((e) => e.field.startsWith('item line')).length, 1);
});

test('name scan: when the reader is down nothing is sent and the receipt waits (TransientError)', async () => {
  const seen = mockWorld({ reader: () => new Response('loading', { status: 503 }) });
  await assert.rejects(run(receipt('MILK')), (e) => e.name === 'TransientError');
  assert.equal(seen.api.length, 0);
});

test('name scan: unusable output (not JSON, missing ids, invented names) fails closed with a plain error that counts an attempt, not an outage', async () => {
  for (const content of ['I cannot do that', JSON.stringify({ results: [] }), JSON.stringify({ nope: 1 })]) {
    const seen = mockWorld({ reader: () => new Response(JSON.stringify({ choices: [{ message: { content } }] })) });
    await assert.rejects(run(receipt('MILK')), (e) => e.name === 'PermanentError' && !isTransient(e) && /nothing was sent/.test(e.message), content);
    assert.equal(seen.api.length, 0);
    mock.restoreAll();
  }
  // a name the text doesn't contain is ignored, not trusted
  const seen = mockWorld({ reader: (body) => {
    const list = JSON.parse(body.messages.at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: list.map((e) => ({ id: e.id, names: ['Invented'] })) }) } }] }));
  } });
  await run(receipt('MILK'));
  assert.equal(seen.api.length, 1);
  assert.deepEqual((await loadPrivate()).found, []);
});

test('category labels in free text are replaced by their codes, so they no longer block every request', async () => {
  const seen = mockWorld();
  const r = receipt('FINE ITEM', 'MOVED TO Daily Expenses / Groceries');
  const itemHistory = [{ items: 'moved to fun / gifts', category: LABELS[0], store: null, date: '2026-01-01' }];
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ [LABELS[2]]: 'presents; food goes to Daily Expenses / Groceries' }));
  await categorizeItems(r, LABELS, [], itemHistory, { businessNames: ['Target'] });
  assert.equal(seen.api.length, 2);
  assert.equal(seen.api[0].body.state.other_items_on_receipt[0], 'MOVED TO C01');
  assert.equal(seen.api[0].body.questions.category.criteria.C03, 'Gifts: presents; food goes to C01');
  assert.deepEqual(seen.api[0].body.state.items_this_household_filed_before.C01, ['moved to C03']);
  const sent = JSON.stringify(seen.api.map((a) => a.body)).toLowerCase();
  for (const l of LABELS) assert.ok(!sent.includes(l.toLowerCase()), l);
  assert.ok(r.items.every((i) => i.category === LABELS[0]));
});

test('a label in a budget category the receipt cannot use (hidden group) is coded too, and the check looks for every label in the budget', async () => {
  config.excludeGroups = ['Bills'];
  const seen = mockWorld();
  const r = receipt('PAID Bills / Rent LATE');
  await categorizeItems(r, [...LABELS, 'Bills / Rent'], [], [], { businessNames: ['Target'] });
  assert.equal(seen.api.length, 1);
  assert.equal(seen.api[0].body.state.item, 'PAID X01 LATE');
});

test('leak check: what the final check stops is not sent; the log names the field path and kind of leak, never the value; the review reason says privacy check', async () => {
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: ['budget'], found: [], notNames: [], order: ['budget'] }));
  const seen = mockWorld();
  const r = receipt('MILK', 'EGGS');
  await run(r);
  mock.method(console, 'log', console.log); // keep the mock quiet for the assertions below
  assert.equal(seen.api.length, 0); // the fixed question text holds the word: every item is held back
  assert.equal(r.items[0].category, null);
  assert.match(r.items[0].invalidAnswer, /^held back from the hosted decider \(privacy check\): /);
  const line = logs.find((l) => /NOT sent/.test(l));
  assert.match(line, /questions\.category\.instructions \(listed word\)/);
  assert.ok(!/budget\b/i.test(line.replace('questions.category.instructions', '')) && !line.includes('MILK'));
  // a name the scan found (not one you listed) is called that
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], found: [{ word: 'descriptions', firstSeen: '2026-11-01' }], notNames: [], order: ['descriptions'] }));
  logs.length = 0;
  await run(receipt('MILK'));
  assert.match(logs.find((l) => /NOT sent/.test(l)), /questions\.category\.instructions \(found name\)/);
});

test('preview: the exact request is written per item, nothing is sent and no decider is called', async () => {
  config.decider.preview = 'jev-preview';
  config.decider.apiKey = '';
  const seen = mockWorld({ names: ['Jo'] });
  const r = receipt('GIFT FOR JO', 'MILK');
  const how = await run(r);
  assert.match(how, /remote/);
  assert.equal(seen.api.length, 0);
  const dir = path.join(config.privacy.previewRoot, 'jev-preview');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['r1.item1.json', 'r1.item2.json']);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'r1.item1.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['held_back', 'body']);
  assert.deepEqual(file.held_back, []); // nothing the real path would stop
  const body = file.body;
  assert.equal(body.state.item, 'GIFT FOR Person B');
  assert.equal(body.model, 'jev-latest');
  assert.ok(seen.reader.length >= 1); // the name scan ran on the local reader
  assert.ok(r.items.every((i) => /preview only/.test(i.invalidAnswer)));
});

test('remote: the state has the same fields as the local decider\'s, except the dates', async () => {
  const history = [{ date: '2026-10-01', amount: 20, parts: [{ category: LABELS[0], amount: 15, notes: 'milk' }] }];
  const itemHistory = [{ items: 'whole milk', category: LABELS[0], store: 'Target', date: '2026-09-01' }];
  const known = { currentLabel: LABELS[0], ruleLabel: LABELS[0], occasions: ['x (US holiday) on 2026-10-30, 4 day(s) after the purchase'] };
  const seen = mockWorld();
  await categorizeItems(receipt('MILK'), LABELS, history, itemHistory, known);
  mock.restoreAll();
  config.decider.provider = 'local';
  let local;
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return new Response('ok');
    local = JSON.parse(init.body);
    return new Response(JSON.stringify(reply('Daily Expenses / Groceries', 0.9)));
  });
  await categorizeItems(receipt('MILK'), LABELS, history, itemHistory, known);
  const remote = seen.api[0].body.state;
  assert.deepEqual(Object.keys(remote).sort(), Object.keys(local.state).filter((k) => k !== 'date').sort());
  assert.deepEqual(Object.keys(remote.past_purchases_at_this_store[0]).sort(), ['amount', 'filed_as', 'when']);
  assert.equal(local.model, undefined);
});

test('check: remoteReady sends the key; 401 says to check the key', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([String(url), init.method, init.headers.Authorization]);
    return new Response(JSON.stringify({ models: [{ name: 'jev-1.14.0' }, { name: 'jev-latest' }] }));
  });
  assert.deepEqual(await remoteReady(), ['jev-1.14.0', 'jev-latest']);
  assert.deepEqual(calls, [['https://api.typesafe.test/v1/models', 'GET', `Bearer ${KEY}`]]);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('no', { status: 401 }));
  await assert.rejects(remoteReady(), /check DECIDER_API_KEY/);
});

test('preview: an item the real path would hold back is marked in the file (held_back lists path and kind, no values)', async () => {
  config.decider.preview = 'jev-preview';
  config.decider.apiKey = '';
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: ['budget'], found: [], notNames: [], order: ['budget'] }));
  mockWorld();
  const r = receipt('MILK');
  mock.method(console, 'log', () => {});
  await run(r);
  const file = JSON.parse(fs.readFileSync(path.join(config.privacy.previewRoot, 'jev-preview', 'r1.item1.json'), 'utf8'));
  assert.deepEqual(file.held_back, [{ path: 'questions.category.instructions', kind: 'listed word' }]);
  assert.equal(file.body.state.item, 'MILK');
  assert.match(r.items[0].invalidAnswer, /preview only.*privacy check would hold it back/);
});

test('store names: the bank text is never sent; the payee is scanned by the reader like other texts; no payee, no store', async () => {
  const seen = mockWorld({ names: ['Jordan'], flagStores: true });
  const r = receipt('TICKETS');
  r.payee = 'Zelle to Jordan Smith 5521';
  await run(r, { businessNames: ['Target', 'Zelle to Jordan Smith 5521'] });
  assert.equal(seen.api[0].body.state.store, 'Zelle to Person B Smith'); // Jordan scrubbed even in a real payee; 5521 stripped
  assert.ok(!JSON.stringify(seen.api[0].body).includes('POS 4242'));
  const asked = JSON.parse(seen.reader[0].messages.at(-1).content);
  assert.ok(asked.some((e) => e.field === 'store or payee name' && e.text === 'Zelle to Jordan Smith'));
  mock.restoreAll();
  const seen2 = mockWorld();
  const r2 = receipt('TICKETS');
  r2.payee = null;
  await run(r2);
  assert.equal(seen2.api[0].body.state.store, null);
});

test('check: remoteReady reads the documented { models: [{ name }] } answer and tolerates other shapes', async () => {
  assert.deepEqual(modelNames({ models: [{ name: 'jev-1.14.0', description: 'x', release_date: '2026-01-01' }, { name: 'jev-latest' }] }), ['jev-1.14.0', 'jev-latest']);
  assert.deepEqual(modelNames([{ id: 'a' }, 'b', { nope: 1 }]), ['a', 'b']);
  assert.deepEqual(modelNames({ data: [{ id: 'c' }] }), ['c']);
  assert.deepEqual([modelNames(null), modelNames({}), modelNames({ models: 'x' })], [[], [], []]);
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ models: [{ name: 'jev-latest' }] })));
  assert.deepEqual(await remoteReady(), ['jev-latest']);
});

test('check: the model warning only fires for an alias-looking name that is not listed', () => {
  const listed = ['jev-latest', 'jev-1.14.0'];
  assert.equal(modelWarning('jev-latest', listed), null);
  assert.equal(modelWarning('jev-1.12.0', listed), null); // versioned ids work even when not listed
  assert.equal(modelWarning('jev-lates', []), null); // nothing listed: nothing to compare with
  assert.match(modelWarning('jev-lates', listed), /DECIDER_REMOTE_MODEL=jev-lates is not in the list/);
});

test('check: remoteProbe sends one fixed request with no household data and reports the tokens; a bad key is the auth error', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([String(url), init.method, init.headers.Authorization, JSON.parse(init.body)]);
    return new Response(JSON.stringify(reply('A', 0.9)));
  });
  config.privacy.seedWords = ['Sam'];
  assert.equal(await remoteProbe(), 1000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['https://api.typesafe.test/v1/systemone', 'POST', `Bearer ${KEY}`]);
  assert.deepEqual(calls[0][3], {
    model: 'jev-latest',
    state: { item: 'A test item: paper towels' },
    questions: { category: { type: 'choice', instructions: 'Which category fits this item?', criteria: { A: 'household supplies', B: 'food' } } },
  });
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('no', { status: 401 }));
  await assert.rejects(remoteProbe(), (e) => e instanceof DeciderAuthError && /DECIDER_API_KEY/.test(e.message));
});

const allText = (seen) => JSON.stringify(seen.api.map((a) => a.body));

test('person payees: "Jordan Smith" flagged in its own store scan is hidden everywhere and never kept readable', async () => {
  const seen = mockWorld({ names: ['Jordan Smith'], flagStores: true });
  const r = receipt('TICKETS FOR JORDAN SMITH');
  r.payee = 'Jordan Smith';
  const itemHistory = [{ items: 'gift for Jordan Smith', category: LABELS[2], store: 'Jordan Smith', payee: 'Jordan Smith', date: '2026-09-01' }];
  await categorizeItems(r, LABELS, [], itemHistory, { businessNames: ['Jordan Smith', 'Target'] });
  const sent = allText(seen);
  assert.ok(!/jordan|smith/i.test(sent), sent);
  assert.match(seen.api[0].body.state.store, /^Person \w Person \w$/);
  assert.match(seen.api[0].body.state.item, /^TICKETS FOR Person \w Person \w$/);
  // the payee's own name was scanned as a store text
  assert.ok(seen.reader.some((b) => JSON.parse(b.messages.at(-1).content).some((e) => e.field === 'store or payee name' && e.text === 'Jordan Smith')));
});

test('person payees: a one-word payee that is also a hidden name ("Mia") is never kept; "Mia\'s Cafe", scanned clean, stays whole', async () => {
  const seen = mockWorld({ names: ['Mia'] }); // flagged in items, not in the stores' own text
  const r = receipt("birthday gift for Mia, Mia's shoes", "MIA'S CAFE LUNCH FOR MIA");
  r.payee = 'Mia';
  await run(r, { businessNames: ['Mia', "Mia's Cafe"] });
  const first = seen.api[0].body.state;
  assert.equal(first.item, "birthday gift for Person B, Person B's shoes");
  assert.equal(first.store, 'Person B');
  assert.equal(first.other_items_on_receipt[0], "MIA'S CAFE LUNCH FOR Person B");
  mock.restoreAll();
  // with "Mia's Cafe" alone as a payee (clean scan, other words in it), the full name stays
  const seen2 = mockWorld({ names: ['Mia'] });
  const r2 = receipt("MIA'S CAFE LUNCH FOR MIA");
  await run(r2, { businessNames: ["Mia's Cafe"] });
  assert.equal(seen2.api[0].body.state.item, "MIA'S CAFE LUNCH FOR Person B");
});

test('422 on one item: if the fixed probe request goes through the item is only refused; if the probe fails too the cycle pauses', async () => {
  const isProbe = (b) => b.state.item === 'A test item: paper towels';
  resetProbeCache();
  const seen = mockWorld({ api: (b, _i, n) => (isProbe(b) ? reply('A', 0.9) : n === 0 ? new Response('bad shape', { status: 422 }) : reply('C01', 0.9)) });
  const r = receipt('FIRST', 'SECOND');
  await run(r);
  assert.equal(r.items[0].category, null);
  assert.match(r.items[0].invalidAnswer, /refused this item \(HTTP 422\)/);
  assert.equal(r.items[1].category, LABELS[0]);
  assert.equal(seen.api.filter((a) => isProbe(a.body)).length, 1);
  mock.restoreAll();
  resetProbeCache();
  mockWorld({ api: (b) => (isProbe(b) ? new Response('nope', { status: 422 }) : new Response('bad shape', { status: 422 })) });
  await assert.rejects(run(receipt('X')), (e) => isSetupProblem(e) && /HTTP 422/.test(e.message));
  resetProbeCache();
});

test('422 on one item while the probe fails for its own reason: the probe\'s cause is reported (bad key, rate limit), not the 422', async () => {
  const isProbe = (b) => b.state.item === 'A test item: paper towels';
  resetProbeCache();
  mockWorld({ api: (b) => (isProbe(b) ? new Response('no', { status: 401 }) : new Response('bad shape', { status: 422 })) });
  await assert.rejects(run(receipt('X')), (e) => e instanceof DeciderAuthError);
  mock.restoreAll();
  resetProbeCache();
  mockWorld({ api: (b) => (isProbe(b) ? new Response('slow down', { status: 429 }) : new Response('bad shape', { status: 422 })) });
  await assert.rejects(run(receipt('X')), (e) => isTransient(e) && !isSetupProblem(e));
  resetProbeCache();
});

test('every item refused with 400/413 raises a (non-pausing) banner as well as marking them unsure', async () => {
  config.alertPath = path.join(path.dirname(config.categoryNotesPath), 'alert.json');
  useAlertFile();
  await clearSetupProblem();
  mock.method(console, 'log', () => {});
  mockWorld({ api: () => new Response('too big', { status: 413 }) });
  const r = receipt('A', 'B');
  await run(r);
  assert.ok(r.items.every((i) => i.category === null && /refused this item/.test(i.invalidAnswer)));
  const a = await readSetupProblem();
  assert.equal(a.pausing, false);
  assert.match(a.message, /refused every item/);
  // one refused item among accepted ones raises nothing
  await clearSetupProblem();
  mock.restoreAll();
  mockWorld({ api: (_b, _i, n) => (n === 0 ? new Response('x', { status: 400 }) : reply('C01', 0.9)) });
  await run(receipt('A', 'B'));
  assert.equal(await readSetupProblem(), null);
});

// ---- places ----
const KC = (text) => (/Fake Falls/i.test(text) ? [{ text: 'Fake Falls', type: 'city' }] : []);

test('places: the city goes out as "a city" in the store, the household examples and similar items (the real preview strings)', async () => {
  const seen = mockWorld({ places: KC });
  const r = receipt('THRIFT FINDS');
  r.payee = 'Corner Thrift Shop Fake Falls';
  const itemHistory = [
    { items: 'CORNER THRIFT SHOP- FAKE FALLS US', category: LABELS[2], store: 'Corner Thrift Outle Fake Falls', payee: 'Corner Thrift Outle Fake Falls', date: '2026-09-01' },
    { items: 'thrift finds', category: LABELS[0], store: 'Corner Thrift Shop Fake Falls', payee: 'Corner Thrift Shop Fake Falls', date: '2026-09-02' },
  ];
  await categorizeItems(r, LABELS, [], itemHistory, { businessNames: ['Corner Thrift Shop Fake Falls', 'Corner Thrift Outle Fake Falls'] });
  const state = seen.api[0].body.state;
  assert.equal(state.store, 'Corner Thrift Shop a city');
  assert.deepEqual(state.items_this_household_filed_before.C03, ['CORNER THRIFT SHOP- a city US (at Corner Thrift Outle a city)']);
  assert.deepEqual(state.items_this_household_filed_before.C01, ['thrift finds (at Corner Thrift Shop a city)']);
  assert.ok(state.similar_items_filed_before.every((x) => !x.store || x.store.endsWith('a city')));
  assert.ok(!/fake/i.test(allText(seen)), allText(seen));
  // the place is remembered in its own list, not as a name
  const p = await loadPrivate();
  assert.deepEqual(p.places.map((f) => [f.word.toLowerCase(), f.type]), [['fake falls', 'city']]); // one entry, however it was written
  assert.deepEqual(p.found, []);
  assert.ok(seen.reader.some((b) => JSON.parse(b.messages.at(-1).content).some((e) => e.field === 'store or payee name' && e.text === 'Corner Thrift Shop Fake Falls')));
});

test('places: a city and state, a street address, a ZIP code and a state name each become a neutral word (ZIP dropped)', async () => {
  const found = [{ text: 'SPRINGFIELD IL', type: 'city' }, { text: '123 MAIN ST', type: 'street' }, { text: '62704', type: 'zip' }, { text: 'Missouri', type: 'state' }, { text: 'US', type: 'state' }];
  const seen = mockWorld({ places: (t) => found.filter((f) => t.toLowerCase().includes(f.text.toLowerCase())) });
  await run(receipt('FILTERS 123 MAIN ST SPRINGFIELD IL 62704', 'SHIP TO MISSOURI US'));
  assert.equal(seen.api[0].body.state.item, 'FILTERS a street a city');
  assert.equal(seen.api[1].body.state.item, 'SHIP TO a state US'); // "US" alone is not a place
  assert.deepEqual((await loadPrivate()).places.map((f) => f.word).sort(), ['123 MAIN ST', '62704', 'MISSOURI', 'SPRINGFIELD IL']); // as written in the text
});

test('places: a payee whose own scan finds a place is not kept whole ("Fake Falls Hawks Pro Shop" -> "a city Hawks Pro Shop"); neither is a clean one when the place was found elsewhere', async () => {
  const seen = mockWorld({ places: (t, field) => (field === 'store or payee name' ? KC(t) : KC(t)) });
  const r = receipt('FAKE FALLS HAWKS PRO SHOP JERSEY');
  r.payee = 'Fake Falls Hawks Pro Shop';
  await run(r, { businessNames: ['Fake Falls Hawks Pro Shop'] });
  assert.equal(seen.api[0].body.state.item, 'a city HAWKS PRO SHOP JERSEY');
  assert.equal(seen.api[0].body.state.store, 'a city Hawks Pro Shop');
  mock.restoreAll();
  // the scan of the payee's own name came back clean (the reader flags the city only elsewhere): the full name stays, a lone city goes
  const seen2 = mockWorld({ places: (t, field) => (field === 'store or payee name' ? [] : KC(t)) });
  const r2 = receipt('FAKE FALLS HAWKS FAN SHOP JERSEY', 'TRIP TO FAKE FALLS');
  await run(r2, { businessNames: ['Fake Falls Hawks Fan Shop'] });
  // ... but a place found anywhere is never kept readable, not even inside such a name
  assert.equal(seen2.api[0].body.state.item, 'a city HAWKS FAN SHOP JERSEY');
  assert.equal(seen2.api[0].body.state.other_items_on_receipt[0], 'TRIP TO a city');
});

test('places: a place you listed is replaced by "a place" without any scan, and it stops a payee from being kept whole', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], placeWords: ['Springfield'], places: [], notPlaces: [], found: [], notNames: [], order: [] }));
  const seen = mockWorld();
  await run(receipt('SPRINGFIELD HARDWARE PARTS'), { businessNames: ['Springfield Hardware'] });
  assert.equal(seen.api[0].body.state.item, 'a place HARDWARE PARTS');
});

test('places: "not a place" and the same word as a person are respected; a found place is not a name', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notPlaces: ['Lincoln'], places: [], found: [], notNames: [], order: [] }));
  const seen = mockWorld({ places: (t) => (/Lincoln/i.test(t) ? [{ text: 'Lincoln', type: 'city' }] : []) });
  await run(receipt('LINCOLN LOGS'));
  assert.equal(seen.api[0].body.state.item, 'LINCOLN LOGS');
  assert.deepEqual((await loadPrivate()).places, []);
});

test('places: the final check catches a listed or found place that is still in the request (kind "place")', async () => {
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], placeWords: ['budget'], places: [], notPlaces: [], found: [], notNames: [], order: [] }));
  const seen = mockWorld();
  const r = receipt('MILK');
  await run(r); // "budget" is in the fixed question text, which is not scrubbed
  assert.equal(seen.api.length, 0);
  assert.match(logs.find((l) => /NOT sent/.test(l)), /questions\.category\.instructions \(place\)/);
  assert.match(r.items[0].invalidAnswer, /held back from the hosted decider \(privacy check\): .*\(place\)/);
});

test('places: words from a reformatted phrase hide in that one text only; they are never remembered and "MAIN COURSE" elsewhere stays', async () => {
  const seen = mockWorld({ places: (t) => (/123 MAIN ST/.test(t) ? [{ text: '123 Main Street', type: 'street' }] : []) });
  await run(receipt('DELIVERY 123 MAIN ST', 'MAIN COURSE MEAL'));
  assert.equal(seen.api[0].body.state.item, 'DELIVERY a street a street ST');
  assert.equal(seen.api[0].body.state.other_items_on_receipt[0], 'MAIN COURSE MEAL');
  assert.equal(seen.api[1].body.state.item, 'MAIN COURSE MEAL');
  assert.deepEqual((await loadPrivate()).places, []);
});

test('remote: your corrections are scanned, scrubbed and leak-checked like any note, and only codes and payee names go out', async () => {
  const lesson = (item, id) => ({ id, txnId: `t${id}`, item, plain: null, said: LABELS[0], filed: LABELS[1], payee: 'Target', store: 'POS 4242 TARGET 1234 SPRINGFIELD IL', date: '2026-10-01', kind: 'item' });
  const lessons = [lesson('LEGO FOR SAM', 'a'), lesson('LEGO FOR JO', 'b'), lesson('SOCKS', 'c')];
  const seen = mockWorld({ names: ['Jo'] });
  const r = receipt('LEGO SET');
  await run(r, { lessons });
  assert.equal(seen.api.length, 1); // the privacy check let it through
  assert.ok(r.items[0].category, 'the answer was used');
  const field = seen.api[0].body.state.household_corrected_the_pipeline;
  assert.equal(field.length, 2); // SOCKS shares no word with the item
  const sent = JSON.stringify(seen.api[0].body);
  assert.ok(!/\bsam\b|\bjo\b/i.test(sent), 'a listed or found name was sent');
  for (const s of [...LABELS, 'SPRINGFIELD', '4242']) assert.ok(!sent.toLowerCase().includes(s.toLowerCase()), `${s} was sent`);
  assert.ok(field.every((f) => f.pipeline_said === 'C01' && f.household_filed === 'C02' && f.store === 'Target'));
  assert.ok(field.some((f) => /Person/.test(f.item)), 'names became pseudonyms');
  assert.ok(seen.reader.some((b) => /LEGO FOR JO/i.test(JSON.stringify(b))), 'the correction text went to the local name scan');
  // a lesson whose item holds a listed name is held back when the scrubbing is switched off: findLeaks sees the raw name
  const leaks = findLeaks({ state: { household_corrected_the_pipeline: [{ item: 'lego for sam' }] } }, { labels: LABELS, words: ['Sam'], found: [], protect: [], places: [] });
  assert.deepEqual(leaks.map((l) => l.kind), ['listed word']);
});

test('receipt check: the whole-purchase question is a request of its own, anonymized like the items, and its answer comes back as a label', async () => {
  config.receiptCheck = true;
  const seen = mockWorld({ names: ['Jo'], api: (body) => (body.state.items_on_receipt ? reply('C03', 0.5, { C01: 0.2, C02: 0.1, C03: 0.7 }) : reply('C01', 0.5, { C01: 0.5, C02: 0.1, C03: 0.4 })) });
  const r = receipt('GIFT FOR JO', 'MILK');
  await run(r);
  assert.equal(seen.api.length, 3);
  const whole = seen.api[2].body;
  assert.deepEqual(whole.state.items_on_receipt, [{ item: 'GIFT FOR Person B', price: 2 }, { item: 'MILK', price: 2 }]);
  assert.equal('item' in whole.state, false);
  assert.ok(whole.questions.category.instructions.startsWith('If this whole purchase'));
  assert.ok(!JSON.stringify(whole).includes('Jo,') && !JSON.stringify(whole).includes('"GIFT FOR JO"'));
  assert.deepEqual([r.receiptCheck.category, r.receiptCheck.confidence], [LABELS[2], 0.7]);
  assert.deepEqual(r.items.map((i) => i.category), [LABELS[2], LABELS[2]], 'the items that did not clearly win took the whole-purchase category');
  for (const l of LABELS) assert.ok(!JSON.stringify(seen.api.map((a) => a.body)).includes(l), `${l} leaked`);
});

test('receipt check: off, the remote decider gets no extra request; a held-back or refused whole-purchase request leaves the items as they are', async () => {
  config.receiptCheck = false;
  let seen = mockWorld();
  await run(receipt('FIRST', 'SECOND'));
  assert.equal(seen.api.length, 2);
  mock.restoreAll();
  config.receiptCheck = true;
  seen = mockWorld({ api: (body) => (body.state.items_on_receipt ? new Response(`no ${KEY}`, { status: 400 }) : reply('C01', 0.9, { C01: 0.9 })) });
  const r = receipt('FIRST', 'SECOND');
  await run(r);
  assert.equal(seen.api.length, 3);
  assert.equal(r.receiptCheck.category, null);
  assert.match(r.receiptCheck.invalid, /refused this question \(HTTP 400\)/);
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.deepEqual(r.items.map((i) => i.category), [LABELS[0], LABELS[0]]);
});

test('preview: the whole-purchase request is written too, as <receipt>.receipt.json', async () => {
  config.receiptCheck = true;
  config.decider.preview = 'jev-preview';
  config.decider.apiKey = '';
  mockWorld();
  await run(receipt('MILK', 'EGGS'));
  assert.deepEqual(fs.readdirSync(path.join(config.privacy.previewRoot, 'jev-preview')).sort(), ['r1.item1.json', 'r1.item2.json', 'r1.receipt.json']);
  const file = JSON.parse(fs.readFileSync(path.join(config.privacy.previewRoot, 'jev-preview', 'r1.receipt.json'), 'utf8'));
  assert.equal(file.body.state.items_on_receipt.length, 2);
});

test('receipt check: a whole-purchase request the privacy check holds back is not sent, and the items stay as they are', async () => {
  config.receiptCheck = true;
  config.privacy.seedWords = ['whole']; // a word only the whole-purchase question text contains
  const seen = mockWorld({ api: () => reply('C01', 0.9, { C01: 0.9 }) });
  const r = receipt('FIRST', 'SECOND');
  await run(r);
  assert.equal(seen.api.length, 2, 'only the two item requests went out');
  assert.equal(r.receiptCheck.category, null);
  assert.match(r.receiptCheck.invalid, /held back from the hosted decider \(privacy check\)/);
  assert.deepEqual(r.items.map((i) => i.category), [LABELS[0], LABELS[0]]);
  assert.deepEqual(r.receiptCheck.moved, []);
});

test('a provider error that repeats the key across the 300-character cut leaves no fragment of it', async () => {
  for (const status of [502, 422]) {
    for (const pad of [280, 292, 296, 299]) {
      mock.method(globalThis, 'fetch', async () => new Response(`${'x'.repeat(pad)}${KEY} and ${KEY}`, { status }));
      await assert.rejects(remoteReady(), (e) => {
        assert.ok(!e.message.includes(KEY.slice(0, 4)), `HTTP ${status}, pad ${pad}: ${e.message.slice(-40)}`);
        assert.ok(!/SECRET/.test(e.message));
        return true;
      });
      mock.restoreAll();
    }
  }
});

test('hosted decider: answers already paid for are kept in the cache, reused on the next try, and only the missing item is sent again', async () => {
  const cache = {};
  const seen1 = mockWorld({ api: (b, _i, n) => (n < 2 ? reply('C02', 0.9) : new Response('gateway timeout', { status: 504 })) });
  await assert.rejects(run(receipt('MILK', 'BREAD', 'EGGS'), { deciderCache: cache }), (e) => isTransient(e) && isCounted(e) && countedBy(e) === 'decider');
  assert.equal(seen1.api.length, 3);
  assert.equal(Object.keys(cache).length, 2, 'the two paid answers were kept');
  // the checkpoint holds the answers only: no request text, no key
  const saved = JSON.stringify(cache);
  for (const s of ['MILK', 'BREAD', 'EGGS', 'Target', KEY, 'Authorization']) assert.ok(!saved.includes(s), `${s} was saved`);
  mock.restoreAll();
  const seen2 = mockWorld({ api: () => reply('C01', 0.7) });
  const r = receipt('MILK', 'BREAD', 'EGGS');
  await run(r, { deciderCache: cache });
  assert.equal(seen2.api.length, 1, 'only EGGS is asked again');
  assert.equal(seen2.api[0].body.state.item, 'EGGS');
  assert.deepEqual(r.items.map((it) => it.category), [LABELS[1], LABELS[1], LABELS[0]]);
  assert.equal(Object.keys(cache).length, 3);
  // a different model is a different request: nothing is reused
  mock.restoreAll();
  config.decider.remoteModel = 'jev-other';
  const seen3 = mockWorld({ api: () => reply('C01', 0.7) });
  await run(receipt('MILK', 'BREAD', 'EGGS'), { deciderCache: cache });
  assert.equal(seen3.api.length, 3);
});

test('hosted decider: no cache given means every request is sent (replay, item-test)', async () => {
  const seen = mockWorld({ api: () => reply('C01', 0.7) });
  await run(receipt('MILK'));
  await run(receipt('MILK'));
  assert.equal(seen.api.length, 2);
});

test('hosted decider: counted failures are timeouts, 504, 524, 408 and unreadable answers; 429, 5xx and no connection are an outage', async () => {
  const kinds = async (respond) => {
    mockWorld({ api: respond });
    try {
      await run(receipt('MILK'));
    } catch (e) {
      return [isTransient(e), isCounted(e)];
    } finally {
      mock.restoreAll();
    }
  };
  for (const status of [504, 524, 408]) assert.deepEqual(await kinds(() => new Response('x', { status })), [true, true], String(status));
  for (const status of [429, 500, 502, 503]) assert.deepEqual(await kinds(() => new Response('x', { status })), [true, false], String(status));
  assert.deepEqual(await kinds(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }), [true, true]);
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) assert.deepEqual(await kinds(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timeout'), { code }) }); }), [true, true], code);
  assert.deepEqual(await kinds(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); }), [true, false]);
  const body = new Response('x');
  body.text = async () => { throw new TypeError('terminated'); };
  assert.deepEqual(await kinds(() => body), [true, true]);
});

// ---- category names: a short name or group name that names a person ----
const LABEL_FIELD = 'name of a budget category, written "group / category"';
const KID_LABELS = ['Daily Expenses / Coffee', 'Kids / Alex', 'Fun / Gifts'];

test('category names: a person named by a category ("Kids / Alex") is hidden in a note, a description and an item line; ordinary category words stay', async () => {
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'Kids / Alex': "Alex's school things" }));
  // the reader flags Alex only in the category name itself, never in the other texts
  const seen = mockWorld({ names: ['Alex'], nameFields: [LABEL_FIELD] });
  const r = receipt('SOCCER SOCKS ALEX', 'COFFEE BEANS');
  const history = [{ date: '2026-10-01', amount: 30, parts: [{ category: 'Kids / Alex', amount: 30, notes: 'soccer cleats for Alex' }] }];
  const itemHistory = [{ items: 'Coffee filters', category: 'Daily Expenses / Coffee', store: 'Target', date: '2026-09-01' }];
  await categorizeItems(r, KID_LABELS, history, itemHistory, { businessNames: ['Target'] });
  assert.equal(seen.api.length, 2);
  const state = seen.api[0].body.state;
  assert.equal(state.item, 'SOCCER SOCKS Person B'); // Sam (seed) is A
  assert.equal(state.other_items_on_receipt[0], 'COFFEE BEANS'); // an ordinary category word is not touched
  assert.deepEqual(state.past_purchases_at_this_store[0].filed_as, ['C02 30 (soccer cleats for Person B)']);
  const criteria = seen.api[0].body.questions.category.criteria;
  assert.equal(criteria.C02, "Person B: Person B's school things");
  assert.match(criteria.C01, /^The "Coffee" budget category \(group: Daily Expenses\)$/);
  assert.equal(seen.api[1].body.state.item, 'COFFEE BEANS');
  assert.deepEqual(state.items_this_household_filed_before.C01, ['Coffee filters']); // the past item note (no payee, so no store)
  assert.ok(!/alex/i.test(allText(seen)), allText(seen));
  // the category names were scanned as such, and the name is remembered for the Privacy page
  const asked = seen.reader.flatMap((b) => JSON.parse(b.messages.at(-1).content));
  assert.deepEqual(asked.filter((e) => e.field === LABEL_FIELD).map((e) => e.text).sort(), [...KID_LABELS].sort());
  assert.deepEqual((await loadPrivate()).found.map((f) => f.word), ['Alex']);
  // cached: the next receipt does not scan the category names again
  const calls = seen.reader.length;
  await categorizeItems(receipt('COFFEE BEANS'), KID_LABELS, [], [], { businessNames: ['Target'] });
  assert.equal(seen.reader.length, calls);
  assert.ok(!/alex/i.test(allText(seen)));
});

test('category names: a hidden category (not a choice for this receipt) is scanned too; a place in a category name is replaced', async () => {
  config.excludeGroups = ['Trips'];
  const seen = mockWorld({ names: ['Jo'], nameFields: [LABEL_FIELD], places: (t, field) => (field === LABEL_FIELD ? KC(t) : []) });
  await categorizeItems(receipt('GIFT JO', 'MAP FAKE FALLS'), [...LABELS, 'Trips / Fake Falls', 'Family / Jo'], [], [], { businessNames: ['Target'] });
  assert.equal(seen.api[0].body.state.item, 'GIFT Person B');
  assert.equal(seen.api[1].body.state.item, 'MAP a city');
  assert.ok(!/fake|\bjo\b/i.test(allText(seen)), allText(seen));
});

test('category names: "Not a name" is respected; an ordinary category word the scan does not flag is sent as it is', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notNames: ['Alex'], found: [], order: [] }));
  const seen = mockWorld({ names: ['Alex'], nameFields: [LABEL_FIELD] });
  await categorizeItems(receipt('SOCKS FOR ALEX'), KID_LABELS, [], [], { businessNames: ['Target'] });
  assert.equal(seen.api[0].body.state.item, 'SOCKS FOR ALEX');
  assert.deepEqual((await loadPrivate()).found, []);
});

test('category names: when the scan is down nothing is sent, so a person named by a category never goes out unscanned', async () => {
  const seen = mockWorld({ reader: () => new Response('loading', { status: 503 }) });
  await assert.rejects(categorizeItems(receipt('SOCKS FOR ALEX'), KID_LABELS, [], [], { businessNames: ['Target'] }), (e) => e.name === 'TransientError');
  assert.equal(seen.api.length, 0);
});

test('category names: the final check holds back a request where a name flagged in a category name slipped through (kind "found name")', async () => {
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  // contrived on purpose: "budget" is in the fixed question text, which no scrubbing touches
  const seen = mockWorld({ names: ['Budget'], nameFields: [LABEL_FIELD] });
  const r = receipt('MILK');
  await categorizeItems(r, [...LABELS, 'Planning / Budget'], [], [], { businessNames: ['Target'] });
  mock.method(console, 'log', () => {});
  assert.equal(seen.api.length, 0);
  assert.match(r.items[0].invalidAnswer, /held back from the hosted decider \(privacy check\): .*\(found name\)/);
  assert.match(logs.find((l) => /NOT sent/.test(l)), /questions\.category\.instructions \(found name\)/);
});
