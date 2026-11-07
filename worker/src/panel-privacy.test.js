// The Privacy page and its buttons: same key / POST / 303 / escaping rules as the other pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { makeServer } from './trigger.js';
import { loadPrivate } from './private-words.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-privacy-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config.privacy, { wordsPath: path.join(dir, 'private-words.json'), seedWords: [] });
Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat'), settingsPath: path.join(dir, 'settings.json') });
config.trigger.token = 'secret';
config.decider.provider = 'remote';
config.decider.apiKey = 'sk-test-SECRET-key-123';

const HOSTILE = '<script>alert(1)</script> & "q"';
let server;
let base;
test.before(async () => {
  server = makeServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const call = (method, p, { key = 'secret', body } = {}) => fetch(`${base}${p}${key === null ? '' : `?key=${encodeURIComponent(key)}`}`, { method, body, redirect: 'manual' });
const post = (p, form, opts) => call('POST', p, { body: new URLSearchParams(form), ...opts });
const noticeOf = (res) => new URL(res.headers.get('location'), base).searchParams.get('notice');

test('privacy routes answer 403 without the right key and change nothing', async () => {
  assert.equal((await call('GET', '/privacy', { key: null })).status, 403);
  assert.equal((await call('GET', '/privacy', { key: 'nope' })).status, 403);
  for (const p of ['/privacy-word-add', '/privacy-word-remove', '/privacy-notname-add', '/privacy-notname-remove']) {
    assert.equal((await post(p, { word: 'Alex' }, { key: null })).status, 403, p);
    assert.equal((await post(p, { word: 'Alex' }, { key: 'nope' })).status, 403, p);
  }
  assert.equal(fs.existsSync(config.privacy.wordsPath), false);
});

test('add and remove a word: 303 back to the page with a notice', async () => {
  let res = await post('/privacy-word-add', { word: 'Alex' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\.\/privacy\?key=secret&notice=/);
  assert.match(noticeOf(res), /"Alex" is now hidden/);
  assert.deepEqual((await loadPrivate()).words, ['Alex']);
  res = await post('/privacy-word-remove', { word: 'Alex' });
  assert.deepEqual((await loadPrivate()).words, []);
  assert.match(noticeOf(await post('/privacy-word-add', { word: 'x' })), /2 to 40 characters/);
  assert.match(noticeOf(await post('/privacy-word-add', {})), /2 to 40 characters/);
});

test('found names get a "not a name" button, and the not-a-name list can be emptied', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: ['Sam'], notNames: [], found: [{ word: 'Dove', firstSeen: '2026-11-01' }], order: ['sam', 'dove'] }));
  let html = await (await call('GET', '/privacy')).text();
  assert.match(html, /Dove/);
  assert.match(html, /Not a name/);
  assert.match(html, /action="privacy-notname-add\?key=secret"/);
  await post('/privacy-notname-add', { word: 'Dove' });
  html = await (await call('GET', '/privacy')).text();
  assert.match(html, /action="privacy-notname-remove\?key=secret"/);
  assert.deepEqual((await loadPrivate()).found, []);
  await post('/privacy-notname-remove', { word: 'Dove' });
  assert.deepEqual((await loadPrivate()).notNames, []);
});

test('the page escapes hostile words and never shows the API key', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [HOSTILE], notNames: [HOSTILE + '2'], found: [{ word: HOSTILE + '3', firstSeen: HOSTILE }], order: [] }));
  const html = await (await call('GET', '/privacy')).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;q&#34;'));
  assert.ok(!html.includes(config.decider.apiKey));
  assert.ok(!(await (await call('GET', '/')).text()).includes(config.decider.apiKey));
  // a hostile notice is escaped too
  const withNotice = await (await fetch(`${base}/privacy?key=secret&notice=${encodeURIComponent('<b>x</b>')}`)).text();
  assert.ok(!withNotice.includes('<b>x</b>'));
});

test('the Privacy tab shows with the remote decider only; with the local one the page is 404 and the buttons refuse', async () => {
  assert.match(await (await call('GET', '/')).text(), />Privacy</);
  config.decider.provider = 'local';
  try {
    assert.doesNotMatch(await (await call('GET', '/')).text(), />Privacy</);
    assert.equal((await call('GET', '/privacy')).status, 404);
    assert.match(noticeOf(await post('/privacy-word-add', { word: 'Alex' })), /only apply when DECIDER_PROVIDER=remote/);
  } finally {
    config.decider.provider = 'remote';
  }
});

test('a damaged private-words file: the Privacy page and its buttons say so and leave the file alone; the status page shows the paused banner', async () => {
  const damaged = '{"words":["Jordan"],';
  fs.writeFileSync(config.privacy.wordsPath, damaged);
  const page = await call('GET', '/privacy');
  assert.equal(page.status, 500);
  assert.match(await page.text(), /not valid JSON.*left as it is/);
  const res = await post('/privacy-word-add', { word: 'Alex' });
  assert.equal(res.status, 303);
  assert.match(noticeOf(res), /not valid JSON/);
  assert.equal(fs.readFileSync(config.privacy.wordsPath, 'utf8'), damaged);
  fs.rmSync(config.privacy.wordsPath);
  // the worker's pause notice (alert.js) shows on the status page
  config.alertPath = path.join(dir, 'worker-alert.json');
  fs.writeFileSync(config.alertPath, JSON.stringify({ message: 'The hosted decider rejected the API key — check DECIDER_API_KEY in .env and run ./receipts restart', at: '2026-11-06T10:00:00Z' }));
  assert.match(await (await call('GET', '/')).text(), /The worker is paused<\/b>The hosted decider rejected the API key/);
});

test('places: routes need the key; add, remove, "not a place" and un-mark work and answer 303 with a notice', async () => {
  for (const r of ['/privacy-place-add', '/privacy-place-remove', '/privacy-notplace-add', '/privacy-notplace-remove']) {
    assert.equal((await post(r, { word: 'Springfield' }, { key: null })).status, 403, r);
    assert.equal((await post(r, { word: 'Springfield' }, { key: 'nope' })).status, 403, r);
  }
  fs.rmSync(config.privacy.wordsPath, { force: true });
  let res = await post('/privacy-place-add', { word: 'Springfield' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\.\/privacy\?key=secret&notice=/);
  assert.match(noticeOf(res), /"Springfield" is now replaced by "a place"/);
  assert.deepEqual((await loadPrivate()).placeWords, ['Springfield']);
  assert.match(noticeOf(await post('/privacy-place-add', { word: 'ab' })), /3 to 40 characters/);
  await post('/privacy-place-remove', { word: 'springfield' });
  assert.deepEqual((await loadPrivate()).placeWords, []);
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], found: [], notNames: [], order: [], places: [{ word: 'Lincoln', type: 'city', firstSeen: '2026-11-01' }] }));
  let html = await (await call('GET', '/privacy')).text();
  assert.match(html, /Lincoln/);
  assert.match(html, /action="privacy-notplace-add\?key=secret"/);
  await post('/privacy-notplace-add', { word: 'Lincoln' });
  html = await (await call('GET', '/privacy')).text();
  assert.match(html, /action="privacy-notplace-remove\?key=secret"/);
  assert.deepEqual((await loadPrivate()).places, []);
  await post('/privacy-notplace-remove', { word: 'Lincoln' });
  assert.deepEqual((await loadPrivate()).notPlaces, []);
});

test('places: the page escapes hostile place words and says what is replaced', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], found: [], notNames: [], order: [], placeWords: [HOSTILE + ' town'], places: [{ word: HOSTILE + ' road', type: HOSTILE, firstSeen: HOSTILE }], notPlaces: [HOSTILE + ' lane'] }));
  const html = await (await call('GET', '/privacy')).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;q&#34; town'));
  assert.match(html, /replaced by "a city", "a state", "a street" or "a place"/);
});
