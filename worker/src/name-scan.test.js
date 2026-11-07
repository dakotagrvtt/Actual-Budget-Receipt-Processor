// name-scan.js: the reader-model scan for private names and places, its sanity checks, cache and failure handling.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { scanForNames, scanTexts, checkScan, wordsFoundIn, placesFoundIn, PROMPT_VERSION } from './name-scan.js';
import { isTransient, isSetupProblem } from './errors.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-scan-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
config.privacy.scanCachePath = path.join(dir, 'cache.json');
config.llmUrl = 'http://reader.test';
afterEach(() => mock.restoreAll());

const readerReturning = (namesFor) => mock.method(globalThis, 'fetch', async (url, init) => {
  const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
  const results = list.map((e) => ({ id: e.id, names: namesFor(e.text) }));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
});

test('scanForNames: item, note, store and the other free texts go to the reader; holiday names do not; empty input makes no call', async () => {
  const fetchMock = readerReturning(() => []);
  assert.deepEqual(await scanForNames([], 'Target'), []);
  assert.deepEqual(await scanForNames([{ kind: 'occasion', text: 'Easter' }], 'Target'), []);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await scanForNames([{ kind: 'store', text: 'Zelle to Jordan Smith' }], 'Target'), []);
  const asked = JSON.parse(JSON.parse(fetchMock.mock.calls[0].arguments[1].body).messages.at(-1).content);
  assert.deepEqual(asked.map((e) => [e.field, e.text]), [['store or payee name', 'Zelle to Jordan Smith']]);
});

test('scanForNames: the cache is bounded (oldest entries go first)', async () => {
  readerReturning(() => []);
  const texts = Array.from({ length: 5100 }, (_, i) => ({ kind: 'note', text: `note number ${i}` }));
  await scanForNames(texts, 'Target');
  const entries = JSON.parse(fs.readFileSync(config.privacy.scanCachePath, 'utf8')).entries;
  assert.equal(Object.keys(entries).length, 5000);
});

test('scanForNames: a damaged cache file is ignored and rewritten', async () => {
  fs.writeFileSync(config.privacy.scanCachePath, 'garbage');
  mock.method(console, 'log', () => {});
  readerReturning((t) => (t.includes('Jo') ? ['Jo'] : []));
  assert.deepEqual(await scanForNames([{ kind: 'item', text: 'for Jo' }], 'Target'), ['Jo']);
  assert.ok(JSON.parse(fs.readFileSync(config.privacy.scanCachePath, 'utf8')).entries);
});

test('scanForNames: the cache key holds the prompt version and the reader model, so a change rescans', async () => {
  const fetchMock = readerReturning(() => []);
  const texts = [{ kind: 'item', text: 'GIFT FOR ALEX' }];
  const saved = config.llmName;
  try {
    config.llmName = 'model-one';
    await scanForNames(texts, 'Target');
    await scanForNames(texts, 'Target');
    assert.equal(fetchMock.mock.callCount(), 1); // cached
    config.llmName = 'model-two';
    await scanForNames(texts, 'Target');
    assert.equal(fetchMock.mock.callCount(), 2); // another reader model: asked again
  } finally {
    config.llmName = saved;
  }
});

test('checkScan: a name the reader reformatted still hides its words ("John Doe" for "MEMBER DOE/JOHN")', () => {
  const out = checkScan({ results: [{ id: 0, names: ['John Doe'] }] }, new Map([[0, 'MEMBER DOE/JOHN']]));
  assert.deepEqual(out.get(0).people.sort(), ['DOE', 'JOHN']);
  // words not in the text are dropped; 1-letter words are dropped; case is the text's
  assert.deepEqual(checkScan({ results: [{ id: 0, names: ['J. Smith Invented'] }] }, new Map([[0, 'bday for j smith']])).get(0).people, ['smith']);
  // whole words only; a digit next to the name still counts as the name
  assert.deepEqual(wordsFoundIn('Alex', 'ALEXA'), []);
  assert.deepEqual(wordsFoundIn('Alex', 'MEMBER ALEX2'), ['ALEX']);
  // NFC vs NFD
  assert.deepEqual(wordsFoundIn('Jos\u00e9', 'GIFT FOR JOSE\u0301'), ['JOS\u00c9']);
});

test('scanForNames: unusable output is retried one text per call; a text that still fails is a plain error (not an outage)', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    calls.push(list.length);
    const bad = list.some((e) => e.text.includes('UNREADABLE')) || list.length > 1 && list.some((e) => e.text.includes('BATCHY'));
    const content = bad ? 'sorry, no' : JSON.stringify({ results: list.map((e) => ({ id: e.id, names: [] })) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  mock.method(console, 'log', () => {});
  // fails as a batch, fine one by one
  assert.deepEqual(await scanForNames([{ kind: 'item', text: 'BATCHY ONE' }, { kind: 'item', text: 'BATCHY TWO' }], 'Target'), []);
  assert.ok(calls.includes(1));
  // one text that never works: PermanentError, which counts an attempt for the receipt
  await assert.rejects(scanForNames([{ kind: 'item', text: 'FINE' }, { kind: 'item', text: 'UNREADABLE' }], 'Target'), (e) => e.name === 'PermanentError' && !isTransient(e) && !e.message.includes('UNREADABLE'));
});

test('scanForNames: the reader being down or answering 5xx is still a TransientError', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('loading', { status: 503 }));
  await assert.rejects(scanForNames([{ kind: 'item', text: 'WHILE DOWN' }], 'Target'), (e) => e.name === 'TransientError');
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(scanForNames([{ kind: 'item', text: 'WHILE DOWN' }], 'Target'), (e) => isTransient(e));
});

test('placesFoundIn: the whole phrase as written, only what the text contains, no countries or 2-letter bits', () => {
  assert.deepEqual(placesFoundIn({ text: 'Springfield, IL', type: 'city' }, 'GAS SPRINGFIELD IL'), [{ text: 'SPRINGFIELD IL', type: 'city' }]);
  assert.deepEqual(placesFoundIn({ text: '123 Main St', type: 'street' }, 'SHIP TO 123 MAIN ST'), [{ text: '123 MAIN ST', type: 'street' }]);
  assert.deepEqual(placesFoundIn({ text: '62704', type: 'zip' }, 'IL 62704'), [{ text: '62704', type: 'zip' }]);
  assert.deepEqual(placesFoundIn({ text: 'Fake Falls', type: 'city' }, 'CORNER THRIFT SHOP- FAKE FALLS US'), [{ text: 'FAKE FALLS', type: 'city' }]);
  assert.deepEqual(placesFoundIn({ text: 'Paris', type: 'city' }, 'THRIFT SHOP'), []); // invented
  assert.deepEqual(placesFoundIn({ text: 'US', type: 'state' }, 'SHOP FAKE FALLS US'), []); // country on its own
  assert.deepEqual(placesFoundIn({ text: 'IL', type: 'state' }, 'SHOP IL'), []); // too short to hide safely alone
  assert.deepEqual(placesFoundIn({ text: 'Fake Falls', type: 'city' }, 'FAKEX FALLSS'), []); // whole words only
  // a reformatted phrase falls back to its words of 3+ letters that are there
  assert.deepEqual(placesFoundIn({ text: 'Main Street', type: 'street' }, 'MAIN ST NORTH'), [{ text: 'MAIN', type: 'street', local: true }]); // marked local: used in this one text only
  assert.equal(placesFoundIn({ text: 'Fake Falls', type: 'bogus' }, 'FAKE FALLS')[0].type, 'place'); // an unknown kind still hides it
});

test('checkScan: places are checked against their text and may be missing', () => {
  const out = checkScan({ results: [{ id: 0, names: [], places: [{ text: 'Fake Falls', type: 'city' }, { text: 'Paris', type: 'city' }] }, { id: 1, names: ['Jo'] }] }, new Map([[0, 'SHOP FAKE FALLS'], [1, 'FOR JO']]));
  assert.deepEqual(out.get(0), { people: [], places: [{ text: 'FAKE FALLS', type: 'city' }], local: [] });
  assert.deepEqual(out.get(1), { people: ['JO'], places: [], local: [] });
  // fallback words are kept apart from the places that get remembered
  const f = checkScan({ results: [{ id: 0, names: [], places: [{ text: 'Union Station', type: 'place' }] }] }, new Map([[0, 'UNION SQ STATION 4']]));
  assert.deepEqual(f.get(0), { people: [], places: [], local: [{ text: 'UNION', type: 'place' }, { text: 'STATION', type: 'place' }] });
  assert.throws(() => checkScan({ results: [{ id: 0, names: [], places: 'x' }] }, new Map([[0, 'a']])), /bad places list/);
});

test('scanTexts: places come back with the people; a cache from before places (a list per text) or an older prompt rescans', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    const results = list.map((e) => ({ id: e.id, names: [], places: /Fake Falls/i.test(e.text) ? [{ text: 'Fake Falls', type: 'city' }] : [] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
  });
  const texts = [{ kind: 'store', text: 'Thrift Shop Fake Falls' }];
  const first = await scanTexts(texts, 'Target');
  assert.deepEqual(first.places, [{ text: 'Fake Falls', type: 'city' }]);
  await scanTexts(texts, 'Target');
  assert.equal(fetchMock.mock.callCount(), 1); // cached
  // the old cache format (a plain list of names per text) is not trusted
  const cache = JSON.parse(fs.readFileSync(config.privacy.scanCachePath, 'utf8'));
  for (const k of Object.keys(cache.entries)) cache.entries[k] = [];
  fs.writeFileSync(config.privacy.scanCachePath, JSON.stringify(cache));
  await scanTexts(texts, 'Target');
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.ok(PROMPT_VERSION >= 3); // the version is part of the cache key, so entries from the people-only prompt are never used
});

// ---- false positives on item lines ----

// A reader that flags every word of every text as a person (the worst case seen with the constrained retry).
const readerFlagsEveryWord = (calls = []) => mock.method(globalThis, 'fetch', async (url, init) => {
  const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
  calls.push(list.length);
  const results = list.map((e) => ({ id: e.id, names: e.text.split(/\s+/) }));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
});
const items = (...lines) => lines.map((text) => ({ kind: 'item', text }));

test('scanForNames: Costco item words flagged as people by the reader record nothing', async () => {
  mock.method(console, 'log', () => {});
  readerFlagsEveryWord();
  const lines = ['KS CAGE FREE', 'BART PEARS', 'COCKTAIL TOM', 'TOLLHOUSE TUB', 'GHIRPEPBARK', 'KSULTFILTMLK', 'BOUCHARD', 'LBC'];
  assert.deepEqual(await scanForNames(items(...lines), 'Costco'), []);
});

test('scanForNames: an item line with a person cue keeps the name ("GIFT FOR TOM", "MEMBER: J DOE")', async () => {
  mock.method(console, 'log', () => {});
  readerFlagsEveryWord();
  assert.deepEqual(await scanForNames(items('GIFT FOR TOM'), 'Costco'), ['TOM']);
  assert.deepEqual(await scanForNames(items('MEMBER: J DOE'), 'Costco'), ['DOE']);
});

test('scanForNames: a note keeps the current rules ("Socks for Maria")', async () => {
  readerReturning((t) => (t.includes('Maria') ? ['Maria'] : []));
  assert.deepEqual(await scanForNames([{ kind: 'note', text: 'Socks for Maria' }], 'Target'), ['Maria']);
});

test('scanTexts: an item word that is a known private word, or was found in a note, is kept', async () => {
  mock.method(console, 'log', () => {});
  readerReturning((t) => (/BART|ALEXA/.test(t) ? t.split(' ') : []));
  const out = await scanTexts(items('BART PEARS ZZ'), 'Costco', ['bart']);
  assert.deepEqual(out.names, ['BART']);
  const out2 = await scanTexts([...items('ALEXA SPEAKER'), { kind: 'note', text: 'ALEXA birthday' }], 'Costco');
  assert.ok(out2.names.includes('ALEXA'));
  assert.deepEqual(out2.byText.get('item\nALEXA SPEAKER').people, ['ALEXA']);
});

test('scanForNames: texts go to the reader in batches of at most 12 (81 texts = 7 calls)', async () => {
  mock.method(console, 'log', () => {});
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    calls.push(list.length);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: list.map((e) => ({ id: e.id, names: [] })) }) } }] }));
  });
  await scanForNames(items(...Array.from({ length: 81 }, (_, i) => `BATCH LINE ${i}`)), 'Costco');
  assert.equal(calls.length, 7);
  assert.ok(calls.every((n) => n <= 12));
});

test('scanForNames: a batch flagging people in over half its item lines is asked again one text per call', async () => {
  mock.method(console, 'log', () => {});
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    const list = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    calls.push(list.length);
    const results = list.map((e) => ({ id: e.id, names: list.length > 1 ? [e.text.split(' ')[0]] : [] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }] }));
  });
  assert.deepEqual(await scanForNames(items('SANITY ONE', 'SANITY TWO', 'SANITY THREE', 'SANITY FOUR'), 'Costco'), []);
  assert.deepEqual(calls, [4, 1, 1, 1, 1]);
});

test('scanForNames: names must look like names (no vowel, one letter, common product word)', async () => {
  readerReturning((t) => t.split(' '));
  assert.deepEqual(await scanForNames([{ kind: 'note', text: 'LBC KS FREE ORGANIC J Maria' }], 'Target'), ['Maria']);
});

test('scanForNames: a setup problem (a refused cloud key) is rethrown at once, not asked again text by text', async () => {
  const saved = { ...config.reader };
  Object.assign(config.reader, { provider: 'remote', url: 'https://api.reader.test/v1', host: 'api.reader.test', apiKey: 'sk-test-abcdefgh1234', model: 'm' });
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  mock.method(console, 'log', () => {});
  try {
    await assert.rejects(scanForNames([{ kind: 'item', text: 'ONE' }, { kind: 'item', text: 'TWO' }, { kind: 'item', text: 'THREE' }], 'Target'), (e) => isSetupProblem(e));
    assert.equal(fetchMock.mock.callCount(), 1, 'one request, not one per text');
  } finally {
    Object.assign(config.reader, saved);
  }
});
