// The Learned page: key required, everything escaped, Forget with a signed Undo, learned keywords on the Keywords page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { makeServer } from '../src/trigger.js';
import { CSP } from '../src/panel-pages.js';
import { signUndo } from '../src/panel-actions.js';
import * as memory from '../src/memory.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-page-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
Object.assign(config, {
  categoryNotesPath: path.join(dir, 'category-notes.json'),
  keywordsPath: path.join(dir, 'keywords.json'),
  statePath: path.join(dir, 'state.json'),
  heartbeatPath: path.join(dir, 'heartbeat'),
  settingsPath: path.join(dir, 'settings.json'),
  dryRun: false,
  keywordMode: 'mixed',
});
Object.assign(config.learning, { mode: 'on', dir: path.join(dir, 'memory') });
config.trigger.token = 'secret';

const HOSTILE = '<script>alert(1)</script> & "q"';
const lesson = (over = {}) => ({ id: 'abcdef012345', txnId: 't1', file: 'a.jpg', date: '2026-11-01', payee: 'Target', store: 'TARGET 1', item: 'GUM', plain: null, said: 'Daily / Sam', saidHow: 'model', filed: 'Fun / Gifts', kind: 'item', group: 0, ...over });
fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'Fun / Gifts': 'gifts' }));

let server;
let base;
test.before(async () => {
  await memory.updateLessons(() => ({ lessons: [lesson(), lesson({ id: '111111111111', txnId: 't2', item: HOSTILE, plain: HOSTILE, said: null, filed: HOSTILE, payee: HOSTILE, kind: 'filled' })], forgotten: [] }));
  await memory.saveSweepInfo({ lastSweep: '2026-11-05T10:00:00.000Z' });
  server = makeServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, p, { key = 'secret', body } = {}) =>
  fetch(`${base}${p}${key === null ? '' : `${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`}`, { method, body: body && new URLSearchParams(body), redirect: 'manual' });
const loc = (res) => new URL(res.headers.get('location'), base);
const decode = (s) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));

test('the Learned page needs the key, and says the mode and the last look', async () => {
  assert.equal((await call('GET', '/learned', { key: null })).status, 403);
  assert.equal((await call('GET', '/learned', { key: 'wrong' })).status, 403);
  assert.equal((await call('POST', '/lesson-forget', { key: 'wrong', body: { id: 'abcdef012345' } })).status, 403);
  const res = await call('GET', '/learned');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), CSP);
  const page = await res.text();
  assert.match(page, /LEARNING=on/);
  assert.match(page, /Last look at Actual: /);
  assert.match(page, /<a data-navigate data-page="settings" href="settings\?key=secret" class="on" aria-current="page">Settings<\/a>/);
  assert.match(page, /GUM/);
  assert.match(page, /Daily \/ Sam<\/b>|Daily \/ Sam →/);
  for (const [m] of [['record'], ['off']]) {
    config.learning.mode = m;
    assert.match(await (await call('GET', '/learned')).text(), new RegExp(`LEARNING=${m}`));
  }
  config.learning.mode = 'on';
});

test('everything on the page is escaped', async () => {
  const page = await (await call('GET', '/learned')).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&#60;script&#62;alert(1)&#60;/script&#62;'));
});

test('Forget removes the lesson and offers a signed Undo that brings it back', async () => {
  const res = await call('POST', '/lesson-forget', { body: { id: 'abcdef012345' } });
  assert.equal(res.status, 303);
  const u = loc(res);
  assert.equal(u.pathname, '/learned');
  const page = await (await fetch(u)).text();
  assert.ok(!page.includes('<td>GUM</td>') && !/<td>GUM /.test(page));
  const m = page.match(/<div class="notice">[\s\S]*?<form method="post" action="([^"]+)">([\s\S]*?)<button class="small plain">Undo<\/button>/);
  assert.ok(m, 'an Undo form');
  const fields = Object.fromEntries([...m[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
  assert.deepEqual(Object.keys(fields).sort(), ['id', 'mac', 'ts']);
  // a changed field or an unsigned form does nothing
  const forged = await call('POST', '/undo-lesson', { body: { ...fields, id: '111111111111' } });
  assert.match(decodeURIComponent(loc(forged).searchParams.get('notice')), /isn't valid/);
  assert.equal((await memory.loadLessonFile()).lessons.some((l) => l.id === 'abcdef012345'), false);
  const back = await call('POST', decode(m[1]).split('?')[0].replace(/^\.?\/?/, '/'), { body: fields });
  assert.match(decodeURIComponent(loc(back).searchParams.get('notice')), /Restored "GUM"/);
  assert.equal((await memory.loadLessonFile()).lessons.some((l) => l.id === 'abcdef012345'), true);
  // an old link is refused
  const old = signUndo('undo-lesson', { id: 'abcdef012345' }, Date.now() - 16 * 60000);
  assert.match(decodeURIComponent(loc(await call('POST', '/undo-lesson', { body: old })).searchParams.get('notice')), /older than 15 minutes/);
});

test('Forget with a bad or unknown id changes nothing and says so', async () => {
  for (const id of ['', 'nope', '../../etc', 'ffffffffffff']) {
    const res = await call('POST', '/lesson-forget', { body: { id } });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(loc(res).searchParams.get('notice')), /Unknown lesson|not there any more/);
  }
  assert.equal((await memory.loadLessonFile()).lessons.length, 2);
});

test('a forgotten lesson is tombstoned: the file keeps it out of the list', async () => {
  await call('POST', '/lesson-forget', { body: { id: '111111111111' } });
  const file = await memory.loadLessonFile();
  assert.equal(file.lessons.some((l) => l.id === '111111111111'), false);
  assert.equal(file.forgotten.some((l) => l.id === '111111111111'), true);
  await memory.restoreLesson('111111111111');
});

test('learned keywords show on the Keywords page as learned, with the usual Remove', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'soda', category: 'Fun / Gifts', store: 'Target', strength: 'usually', from: 'learned', added: '2026-11-01' }] }));
  const page = await (await call('GET', '/keywords')).text();
  assert.match(page, /soda[\s\S]*learned \(your corrections\)/);
  assert.match(page, /action="keyword-remove\?key=secret"/);
});

test('Forget removes the learned keyword the lesson supported (and says so)', async () => {
  const l = (id, txnId) => lesson({ id, txnId, item: 'LEMONADE', filed: 'Fun / Gifts', solo: true });
  await memory.updateLessons(() => ({ lessons: [l('aaaaaaaaaaa1', 'u1'), l('aaaaaaaaaaa2', 'u2')], forgotten: [] }));
  const kw = await import('../src/keywords.js');
  await kw.syncLearned(kw.keywordCandidates((await memory.loadLessonFile()).lessons));
  assert.deepEqual((await kw.loadKeywords()).map((k) => k.phrase), ['lemonade']);
  await call('POST', '/lesson-forget', { body: { id: 'aaaaaaaaaaa1' } });
  assert.deepEqual(await kw.loadKeywords(), []); // one correction is no longer enough
});

test('a damaged learning file is never written over; the page says so', async () => {
  const f = path.join(config.learning.dir, 'lessons.json');
  fs.writeFileSync(f, '{not json');
  const page = await (await call('GET', '/learned')).text();
  assert.match(page, /learning files can't be read/);
  assert.match(page, /damaged/);
  assert.match(decodeURIComponent(loc(await call('POST', '/lesson-forget', { body: { id: 'abcdef012345' } })).searchParams.get('notice')), /damaged/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{not json');
  fs.writeFileSync(f, JSON.stringify({ lessons: [], forgotten: [] }));
});

test('one collapsed receipt is one row with one Forget, which forgets and restores all its lessons', async () => {
  const w = (id, item) => lesson({ id, txnId: 'w1', item, kind: 'receipt', solo: false, group: 0, filed: 'Fun / Gifts', said: 'Daily / Sam' });
  await memory.updateLessons(() => ({ lessons: ['aaaaaaaa0001', 'aaaaaaaa0002', 'aaaaaaaa0003'].map((id, i) => w(id, ['MILK', 'EGGS', 'BREAD'][i])), forgotten: [] }));
  const page = await (await call('GET', '/learned')).text();
  assert.equal((page.match(/name="id" value="aaaaaaaa000/g) ?? []).length, 1);
  assert.match(page, /3 items:<\/span> MILK, EGGS, BREAD/);
  const res = await call('POST', '/lesson-forget', { body: { id: 'aaaaaaaa0001' } });
  assert.match(decodeURIComponent(loc(res).searchParams.get('notice')), /whole-receipt correction \(3 items\)/);
  assert.equal((await memory.loadLessonFile()).lessons.length, 0);
  await memory.restoreLesson('aaaaaaaa0001');
  assert.equal((await memory.loadLessonFile()).lessons.length, 3);
  await memory.updateLessons(() => ({ lessons: [], forgotten: [] }));
});

test('Undo of a removed learned keyword restores it only while the lessons still support it', async () => {
  const kw = await import('../src/keywords.js');
  const l = (id, txnId) => lesson({ id, txnId, item: 'POPCORN', filed: 'Fun / Gifts', solo: true });
  await memory.updateLessons(() => ({ lessons: [l('bbbbbbbbbb01', 'p1'), l('bbbbbbbbbb02', 'p2')], forgotten: [] }));
  await kw.syncLearned(kw.keywordCandidates((await memory.loadLessonFile()).lessons));
  const rm = await call('POST', '/keyword-remove', { body: { phrase: 'popcorn', store: 'Target' } });
  const page = await (await fetch(loc(rm))).text();
  const m = page.match(/<form method="post" action="([^"]+)">([\s\S]*?)<button class="small plain">Undo/);
  const fields = Object.fromEntries([...m[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
  assert.equal(fields.from, 'learned');
  await memory.updateLessons(() => ({ lessons: [], forgotten: [] })); // the evidence is gone meanwhile
  const back = await call('POST', '/undo-keyword', { body: fields });
  assert.match(decodeURIComponent(loc(back).searchParams.get('notice')), /was not restored/);
  assert.deepEqual((await kw.loadKeywords()).map((k) => k.phrase), []);
});

test('the Keywords page shows a learned keyword\'s charge limit and its item-price limit', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'coke', category: 'Fun / Gifts', store: 'Costco', strength: 'usually', from: 'learned', added: '2026-11-01', maxCents: 3000, maxItemCents: 500 }, { phrase: 'milk', category: 'Fun / Gifts', store: null, from: 'learned', added: '2026-11-01', maxCents: 3000 }] }));
  const page = await (await call('GET', '/keywords')).text();
  assert.match(page, /charges up to \$30\.00<br>items up to \$5\.00/);
  assert.equal((page.match(/items up to/g) ?? []).length, 1, 'a keyword with no item limit shows none');
});
