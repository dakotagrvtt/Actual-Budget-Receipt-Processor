// private-words.js: the private-words file (names, places, found words), seeding, damage handling and pseudonym order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { addPlaceWord, removePlaceWord, addNotPlace, removeNotPlace, recordPlaces, effectivePlaces, addNotName, addWord, effectiveWords, loadPrivate, recordFound, removeNotName, removeWord, PrivateWordsError } from '../src/private-words.js';
import { isTransient, isSetupProblem } from '../src/errors.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-words-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const fresh = (seeds = []) => {
  config.privacy.wordsPath = path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
  config.privacy.seedWords = seeds;
};
const onDisk = () => JSON.parse(fs.readFileSync(config.privacy.wordsPath, 'utf8'));

test('PRIVATE_WORDS seeds the list once; a word removed later does not come back', async () => {
  fresh(['Alex', 'Jo']);
  assert.deepEqual((await loadPrivate()).words, ['Alex', 'Jo']);
  assert.deepEqual(onDisk().words, ['Alex', 'Jo']);
  await removeWord('alex');
  assert.deepEqual((await loadPrivate()).words, ['Jo']);
  assert.deepEqual(onDisk().order, ['alex', 'jo']); // its place (its pseudonym) is kept
});

test('words: add, remove, unusable words refused, adding clears "not a name"', async () => {
  fresh();
  assert.equal(await addWord('Alex'), true);
  assert.equal(await addWord('alex'), false);
  await assert.rejects(addWord('A'), /usable word/);
  await assert.rejects(addWord('1234'), /usable word/);
  await addNotName('Dove');
  await addWord('Dove');
  assert.deepEqual((await loadPrivate()).notNames, []);
  assert.equal(await removeWord('nobody'), false);
});

test('found names: recorded once with a date; "not a name" removes them from found and from what is hidden', async () => {
  fresh(['Sam']);
  assert.deepEqual(await recordFound(['Jo', 'jo', 'Sam', 'X']), ['Jo']);
  assert.deepEqual(await recordFound(['Jo']), []);
  let p = await loadPrivate();
  assert.deepEqual(p.found.map((f) => f.word), ['Jo']);
  assert.match(p.found[0].firstSeen, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(effectiveWords(p), ['Sam', 'Jo']);
  await addNotName('jo');
  p = await loadPrivate();
  assert.deepEqual([p.found, p.notNames, effectiveWords(p)], [[], ['jo'], ['Sam']]);
  assert.deepEqual(await recordFound(['Jo']), []); // ruled out: not found again
  await removeNotName('jo');
  assert.deepEqual((await loadPrivate()).notNames, []);
});

test('an unreadable file is an error, never an empty list: nothing reads it as empty and nothing writes over it', async () => {
  fresh(['Alex']); // a seed would be written to the file if the file were treated as empty
  const damaged = '{"words":["Jordan"],';
  fs.writeFileSync(config.privacy.wordsPath, damaged);
  for (const run of [() => loadPrivate(), () => recordFound(['Jo']), () => addWord('Sam'), () => removeWord('Jordan'), () => addNotName('Dove')]) {
    await assert.rejects(run(), (e) => e instanceof PrivateWordsError && isSetupProblem(e) && !isTransient(e) && /^data\/private-words\.json can't be read — fix or delete it; nothing is sent to the hosted decider until then/.test(e.message) && /not valid JSON/.test(e.message));
  }
  assert.equal(fs.readFileSync(config.privacy.wordsPath, 'utf8'), damaged); // untouched
  // fixing the file brings it back
  fs.writeFileSync(config.privacy.wordsPath, '{"words":["Jordan"]}');
  assert.deepEqual((await loadPrivate()).words, ['Jordan', 'Alex']);
});

test('a file that cannot be read for another reason than being missing is an error too (a missing one is just empty)', async () => {
  fresh();
  assert.deepEqual((await loadPrivate()).words, []); // ENOENT
  fs.mkdirSync(config.privacy.wordsPath); // reading a directory fails with EISDIR
  await assert.rejects(loadPrivate(), (e) => e instanceof PrivateWordsError && /can't be read/.test(e.message));
  await assert.rejects(recordFound(['Jo']), PrivateWordsError);
});

test('the word "Person" (the pseudonym) cannot be hidden: refused, ignored in seeds and in the scan, dropped from the file', async () => {
  fresh(['Person', 'Alex', 'Person A']);
  assert.deepEqual((await loadPrivate()).words, ['Alex']);
  await assert.rejects(addWord('person'), /Person/);
  await assert.rejects(addNotName('Person B'), /Person/);
  assert.deepEqual(await recordFound(['Person', 'Jo']), ['Jo']);
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: ['Person', 'Alex'], found: [{ word: 'Person C', firstSeen: '' }], notNames: [], order: [] }));
  const p = await loadPrivate();
  assert.deepEqual([p.words, p.found], [['Alex'], []]);
  assert.equal((await addWord('Personal')) !== undefined, true); // only the whole word counts
});

test('words are stored NFKC-normalized (José typed two ways is one word)', async () => {
  fresh();
  await addWord('Jose\u0301');
  assert.deepEqual((await loadPrivate()).words, ['Jos\u00e9']);
  assert.equal(await addWord('JOS\u00c9'), false);
});

test('places: your own list (seeded once from PRIVATE_PLACES), found places and "not a place" live apart from the names', async () => {
  fresh();
  config.privacy.seedPlaces = ['Springfield', '62704'];
  let p = await loadPrivate();
  assert.deepEqual([p.placeWords, p.words, p.found], [['Springfield', '62704'], [], []]);
  await removePlaceWord('springfield');
  assert.deepEqual((await loadPrivate()).placeWords, ['62704']); // a removed seed does not come back
  assert.deepEqual((await recordPlaces([{ text: 'Fake Falls', type: 'city' }, { text: 'fake falls', type: 'city' }, { text: '62704', type: 'zip' }, { text: 'IL', type: 'state' }, { text: 'City', type: 'city' }])).map((f) => [f.word, f.type]), [['Fake Falls', 'city']]);
  p = await loadPrivate();
  assert.deepEqual(effectivePlaces(p), [{ word: '62704', type: 'place' }, { word: 'Fake Falls', type: 'city' }]);
  await addNotPlace('fake falls');
  p = await loadPrivate();
  assert.deepEqual([p.places, p.notPlaces, effectivePlaces(p)], [[], ['fake falls'], [{ word: '62704', type: 'place' }]]);
  assert.deepEqual(await recordPlaces([{ text: 'Fake Falls', type: 'city' }]), []); // ruled out: not found again
  await removeNotPlace('Fake Falls');
  assert.deepEqual((await loadPrivate()).notPlaces, []);
  await assert.rejects(addPlaceWord('ab'), /usable place/);
  await assert.rejects(addPlaceWord('city'), /usable place/);
  assert.equal(await addPlaceWord('Main Street'), true);
  assert.equal(await addPlaceWord('MAIN STREET'), false);
  config.privacy.seedPlaces = [];
});

test('places: the found list is capped like the names (500)', async () => {
  fresh();
  const many = Array.from({ length: 520 }, (_, i) => ({ text: `Town number ${i}`, type: 'city' }));
  assert.equal((await recordPlaces(many)).length, 500);
  assert.equal((await loadPrivate()).places.length, 500);
  assert.deepEqual(await recordPlaces([{ text: 'One more town', type: 'city' }]), []);
});
