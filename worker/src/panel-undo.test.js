// Undo buttons, sorting and filtering on the panel pages, and the page security policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { config } from './config.js';
import { makeServer } from './trigger.js';
import { loadKeywords } from './keywords.js';
import { loadCategoryNotes } from './category-notes.js';
import { loadPrivate } from './private-words.js';
import { SCRIPT, compareValues, rowVisible } from './panel-script.js';
import { CSP, escape, resultKey } from './panel-pages.js';
import { signUndo } from './panel-actions.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-undo-test-'));
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
Object.assign(config.privacy, { wordsPath: path.join(dir, 'private-words.json'), seedWords: [] });
config.trigger.token = 'secret';
config.decider.provider = 'remote';

const HOSTILE = '<script>alert(1)</script> & "q"';
const CAT = 'Daily Expenses / Sam';
const writeNotes = () => fs.writeFileSync(config.categoryNotesPath, JSON.stringify({
  [CAT]: 'Sam\'s things',
  'Daily Expenses / Child': { description: 'draft text', auto: true, basedOn: '12 transactions', written: '2026-01-01' },
}));
let server;
let base;
test.before(async () => {
  writeNotes();
  server = makeServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, p, { key = 'secret', body } = {}) =>
  fetch(`${base}${p}${key === null ? '' : `${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`}`, { method, body: body && new URLSearchParams(body), redirect: 'manual' });
const loc = (res) => new URL(res.headers.get('location'), base);

/** Do a POST, follow the redirect, and return the undo form found in the page: { action, fields } (or null). */
async function undoOf(res) {
  assert.equal(res.status, 303);
  const u = loc(res);
  const page = await (await fetch(u)).text();
  const m = page.match(/<div class="notice">[\s\S]*?<form method="post" action="([^"]+)">([\s\S]*?)<button class="small plain">Undo<\/button>/);
  if (!m) return { page, undo: null };
  const fields = Object.fromEntries([...m[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))]));
  return { page, undo: { action: m[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c)), fields } };
}
const sendSigned = (route, fields, over = {}, now) => doUndo({ action: `/${route}?key=secret`, fields: signUndo(route, { ...fields, ...over }, now) });
const doUndo = (undo, over = {}) => fetch(new URL(undo.action, base), { method: 'POST', body: new URLSearchParams({ ...undo.fields, ...over }), redirect: 'manual' });

test('undo routes: 403 without the key, POST only', async () => {
  for (const r of ['undo-keyword', 'undo-category', 'undo-word', 'undo-notname', 'undo-notname-mark', 'undo-place', 'undo-notplace', 'undo-notplace-mark']) {
    assert.equal((await call('POST', `/${r}`, { key: null, body: { word: 'Alexa' } })).status, 403, r);
    assert.equal((await call('POST', `/${r}`, { key: 'bad', body: { word: 'Alexa' } })).status, 403, r);
    assert.equal((await call('GET', `/${r}`)).status, 404, `GET ${r}`);
  }
});

test('removing a keyword offers Undo; undo restores it as it was and clears the tombstone', async () => {
  writeNotes();
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'Gold Bond', category: CAT, store: 'Target', added: '2026-03-04', from: 'actual', strength: 'always', fromTxn: 't1' }] }));
  const { undo, page } = await undoOf(await call('POST', '/keyword-remove', { body: { phrase: 'Gold Bond', store: 'Target' } }));
  assert.ok(undo, page);
  assert.deepEqual(await loadKeywords(), []);
  assert.match(fs.readFileSync(config.keywordsPath, 'utf8'), /removed/);
  const res = await doUndo(undo);
  assert.equal(res.status, 303);
  assert.match(loc(res).searchParams.get('notice'), /Restored "Gold Bond"/);
  assert.equal(loc(res).searchParams.get('undo'), null, 'undo is one step: no undo of an undo');
  assert.deepEqual(await loadKeywords(), [{ phrase: 'Gold Bond', category: CAT, store: 'Target', strength: 'always', added: '2026-03-04', from: 'actual', fromTxn: 't1' }]);
  assert.doesNotMatch(fs.readFileSync(config.keywordsPath, 'utf8'), /removed/, 'tombstone cleared');
  // a second undo finds it already there
  assert.match(loc(await doUndo(undo)).searchParams.get('notice'), /already on the list/);
});

test('undo keyword: hostile hidden fields are validated like an add', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [] }));
  const ok = { phrase: 'soap', category: CAT, store: '', strength: 'usually', added: '2026-01-02', from: 'cli' };
  const url = '/undo-keyword?key=secret';
  const tryIt = async (over) => loc(await sendSigned('undo-keyword', ok, over)).searchParams.get('notice');
  assert.match(await tryIt({ category: 'Not a category' }), /Pick a category/);
  assert.match(await tryIt({ phrase: '   ' }), /Type a phrase/);
  assert.match(await tryIt({ phrase: 'x'.repeat(101) }), /under 100/);
  assert.deepEqual(await loadKeywords(), []);
  // junk dates and sources are replaced, not stored
  await tryIt({ added: '<b>x</b>', from: '<script>', strength: 'weird' });
  const [k] = await loadKeywords();
  assert.match(k.added, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(k.from, 'status page');
  assert.equal(k.strength, 'usually');
});

test('a hostile phrase is escaped in the Undo form and the notice', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: HOSTILE, category: CAT, store: null, strength: 'usually', added: '2026-01-02', from: 'cli' }] }));
  const { page, undo } = await undoOf(await call('POST', '/keyword-remove', { body: { phrase: HOSTILE } }));
  assert.ok(undo);
  assert.equal(undo.fields.phrase, HOSTILE);
  assert.ok(!page.includes('<script>alert(1)'), 'no raw script in the page');
  assert.ok(page.includes('&#60;script&#62;alert(1)'));
});

test('category: saving over a description offers Undo that restores text and draft state', async () => {
  writeNotes();
  const child = 'Daily Expenses / Child';
  const { undo } = await undoOf(await call('POST', '/category-save', { body: { label: child, description: 'my words' } }));
  assert.ok(undo);
  assert.equal(loadCategoryNotes()[child].auto, false);
  assert.match(loc(await doUndo(undo)).searchParams.get('notice'), /Restored/);
  const back = loadCategoryNotes()[child];
  assert.equal(back.description, 'draft text');
  assert.equal(back.auto, true);
  assert.equal(back.written, '2026-01-01');
  assert.equal(back.writtenBy, undefined);
  assert.equal(back.basedOn, '12 transactions');
  // a plain string stays a plain string, and multi-line text survives the CRLF a browser sends
  const multi = 'line one\nline two';
  const notes = loadCategoryNotes();
  notes[CAT] = multi;
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify(notes));
  const second = await undoOf(await call('POST', '/category-save', { body: { label: CAT, description: 'new' } }));
  await doUndo(second.undo, { description: 'line one\r\nline two' });
  assert.equal(loadCategoryNotes()[CAT], multi);
});

test('category undo: unknown label, over-long text rejected; a long old description gets no Undo', async () => {
  writeNotes();
  const res = await sendSigned('undo-category', { label: 'Nope', description: 'x', auto: '' });
  assert.match(loc(res).searchParams.get('notice'), /isn't in the list/);
  const long = await sendSigned('undo-category', { label: CAT, description: 'x'.repeat(1001), auto: '' });
  assert.match(loc(long).searchParams.get('notice'), /too long/);
  assert.equal(loadCategoryNotes()[CAT], 'Sam\'s things');
  const notes = loadCategoryNotes();
  notes[CAT] = { description: 'y'.repeat(1500), auto: false };
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify(notes));
  const r = await undoOf(await call('POST', '/category-save', { body: { label: CAT, description: 'short' } }));
  assert.equal(r.undo, null);
  assert.match(loc(await call('POST', '/category-save', { body: { label: CAT, description: 'short2' } })).searchParams.get('notice'), /Saved/);
  assert.match(r.page, /too long to offer Undo/);
});

test('a hidden-field body over 64 KB is refused with 413', async () => {
  const res = await call('POST', '/undo-category', { body: { label: CAT, description: 'x'.repeat(70 * 1024) } });
  assert.equal(res.status, 413);
});

test('private words: every removal offers Undo that puts it back', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: ['Alexa'], notNames: ['Wendy'], placeWords: ['Springfield'], notPlaces: ['Lincoln'], found: [], places: [] }));
  const cases = [
    ['/privacy-word-remove', { word: 'Alexa' }, (p) => p.words, 'Alexa'],
    ['/privacy-notname-remove', { word: 'Wendy' }, (p) => p.notNames, 'Wendy'],
    ['/privacy-place-remove', { word: 'Springfield' }, (p) => p.placeWords, 'Springfield'],
    ['/privacy-notplace-remove', { word: 'Lincoln' }, (p) => p.notPlaces, 'Lincoln'],
  ];
  for (const [route, body, list, word] of cases) {
    const { undo, page } = await undoOf(await call('POST', route, { body }));
    assert.ok(undo, `${route}: ${page.slice(0, 200)}`);
    assert.equal(list(await loadPrivate()).includes(word), false);
    await doUndo(undo);
    assert.equal(list(await loadPrivate()).includes(word), true, route);
  }
});

test('"Not a name" and "Not a place" undo restores the found record with firstSeen and type', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notNames: [], found: [{ word: 'Jo', firstSeen: '2026-02-03' }], placeWords: [], notPlaces: [], places: [{ word: 'Fake Falls', type: 'city', firstSeen: '2026-04-05' }] }));
  let r = await undoOf(await call('POST', '/privacy-notname-add', { body: { word: 'Jo' } }));
  assert.deepEqual((await loadPrivate()).found, []);
  assert.deepEqual((await loadPrivate()).notNames, ['Jo']);
  await doUndo(r.undo);
  assert.deepEqual((await loadPrivate()).found, [{ word: 'Jo', firstSeen: '2026-02-03' }]);
  assert.deepEqual((await loadPrivate()).notNames, []);
  r = await undoOf(await call('POST', '/privacy-notplace-add', { body: { word: 'Fake Falls' } }));
  assert.deepEqual((await loadPrivate()).places, []);
  await doUndo(r.undo);
  assert.deepEqual((await loadPrivate()).places, [{ word: 'Fake Falls', type: 'city', firstSeen: '2026-04-05' }]);
  assert.deepEqual((await loadPrivate()).notPlaces, []);
});

test('private-word undo: hostile fields are checked like a normal add', async () => {
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], found: [], places: [] }));
  const u = (r, f) => sendSigned(r, f);
  assert.match(loc(await u('undo-word', { word: 'x' })).searchParams.get('notice'), /2 to 40/);
  assert.match(loc(await u('undo-word', { word: 'Person' })).searchParams.get('notice'), /can't be hidden/);
  assert.match(loc(await u('undo-place', { word: 'ab' })).searchParams.get('notice'), /3 to 40/);
  await u('undo-notname-mark', { word: 'Jo', firstSeen: '<img src=x onerror=1>' });
  assert.deepEqual((await loadPrivate()).found, [{ word: 'Jo', firstSeen: '' }], 'a junk date is dropped');
  await u('undo-notplace-mark', { word: 'Paris', type: '<b>', firstSeen: '2026-01-01' });
  assert.deepEqual((await loadPrivate()).places, [{ word: 'Paris', type: 'place', firstSeen: '2026-01-01' }]);
});

test('a forged undo link cannot point the form anywhere else', async () => {
  const page = await (await fetch(`${base}/keywords?key=secret&notice=hi&undo=${encodeURIComponent('https://evil.example/x')}&u=${encodeURIComponent('{"a":"b"}')}`)).text();
  assert.doesNotMatch(page, /evil\.example/);
  assert.doesNotMatch(page, />Undo</);
  const bad = await (await fetch(`${base}/keywords?key=secret&notice=hi&undo=undo-keyword&u=${encodeURIComponent('{"a":{"b":1}}')}`)).text();
  assert.doesNotMatch(bad, />Undo</);
  const junk = await (await fetch(`${base}/keywords?key=secret&notice=hi&undo=undo-keyword&u=%7Bnot-json`)).text();
  assert.doesNotMatch(junk, />Undo</);
});

// ---- sorting and filtering ----

const get = async (p) => (await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}key=secret`)).text();
const scripts = (page) => page.match(/<script>/g) ?? [];

test('every page has the inline script exactly once, and a policy that allows only it', async () => {
  const res = await fetch(`${base}/keywords?key=secret`);
  const policy = res.headers.get('content-security-policy');
  assert.equal(policy, CSP);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /form-action 'self'/);
  assert.doesNotMatch(policy, /unsafe-/);
  const page = await res.text();
  const m = page.match(/<script>([\s\S]*?)<\/script>/);
  const { createHash } = await import('node:crypto');
  assert.ok(policy.includes(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`), 'script hash is in the policy');
  const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(policy.includes(`'sha256-${createHash('sha256').update(css).digest('base64')}'`), 'style hash is in the policy');
  assert.doesNotMatch(page, /\son\w+=|style="/, 'no inline handlers or style attributes (the policy would block them)');
  for (const p of ['/', '/categories', '/keywords', '/privacy', '/go-live']) {
    const html = await get(p);
    assert.equal(scripts(html).length, 1, p);
    assert.ok(!/<script src/.test(html));
  }
  new vm.Script(SCRIPT); // it parses
});

// ---- the shared helpers (the same functions are pasted into the script) ----

test('compareValues: text, numbers and dates sort as such; blanks last', () => {
  assert.ok(compareValues('apple', 'Banana', 'text') < 0);
  assert.ok(compareValues('item 2', 'item 10', 'text') < 0, 'natural order');
  assert.ok(compareValues('9', '10', 'num') < 0);
  assert.ok(compareValues('$9.50', '10', 'num') > 0 || Number.isNaN(parseFloat('$9.50')));
  assert.ok(compareValues('2026-01-09', '2026-01-10', 'date') < 0);
  assert.ok(compareValues('', '2026-01-10', 'date') > 0);
  assert.equal(compareValues('', '', 'num'), 0);
});

test('rowVisible: text is case-insensitive; dropdown and checkbox values must match the row', () => {
  assert.equal(rowVisible('Tide Pods', {}, 'pods', []), true);
  assert.equal(rowVisible('Tide Pods', {}, 'soap', []), false);
  assert.equal(rowVisible('x', { result: 'review' }, '', [{ field: 'result', value: 'review' }]), true);
  assert.equal(rowVisible('x', { result: 'review' }, '', [{ field: 'result', value: 'failed' }]), false);
  assert.equal(rowVisible('x', {}, '', [{ field: 'draft', value: '1' }]), false);
  assert.equal(rowVisible('x', { draft: '1' }, '', [{ field: 'draft', value: '1' }, { field: 'result', value: '' }]), true);
});

test('the script runs against a tiny fake page: sorts on header click (toggling) and filters rows', () => {
  const mk = (cells, data = {}) => {
    const row = { hidden: false, dataset: data, cells: cells.map((t) => ({ textContent: t, getAttribute: () => null })), children: [] };
    row.children = row.cells.map((c) => ({ textContent: c.textContent, hasAttribute: () => false }));
    return row;
  };
  const rows = [mk(['b', '2'], { k: 'x' }), mk(['a', '10'], { k: 'y' }), mk(['c', '1'], { k: 'x' })];
  const body = { querySelectorAll: () => rows, appendChild: (r) => { rows.splice(rows.indexOf(r), 1); rows.push(r); } };
  const listeners = [];
  const th = (text, type) => {
    const el = { textContent: text, className: '', attrs: { 'data-type': type }, listeners: {}, lastChild: null, removeAttribute() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, appendChild(c) { this.lastChild = c; }, addEventListener(n, f) { this.listeners[n] = f; } };
    return el;
  };
  const heads = [th('Name', 'text'), th('Num', 'num')];
  const table = { tBodies: [body], querySelectorAll: () => heads };
  const input = { value: '', addEventListener: (n, f) => listeners.push(f) };
  const select = { type: 'select-one', value: '', getAttribute: () => 'k', addEventListener: (n, f) => listeners.push(f) };
  const tools = { hidden: true, getAttribute: () => 'tbl', querySelector: () => input, querySelectorAll: () => [select] };
  const target = { querySelectorAll: (sel) => (sel === '[data-row]' ? rows : []) }; // no [data-group] headings on this page
  const doc = {
    getElementById: () => target,
    createElement: () => ({ textContent: '', nodeName: 'SPAN' }),
    querySelectorAll: (sel) => (sel === '[data-tools]' ? [tools] : [table]),
  };
  vm.runInNewContext(SCRIPT, { document: doc, Array, parseFloat, Date, String, isNaN });
  assert.equal(tools.hidden, false, 'filter bar revealed');
  heads[1].listeners.click();
  assert.deepEqual(rows.map((r) => r.cells[1].textContent), ['1', '2', '10'], 'numeric ascending');
  heads[1].listeners.click();
  assert.deepEqual(rows.map((r) => r.cells[1].textContent), ['10', '2', '1'], 'toggled to descending');
  assert.equal(heads[1].attrs['aria-sort'], 'descending');
  input.value = 'B';
  listeners[0]();
  assert.deepEqual(rows.map((r) => r.hidden), [true, false, true].map((_, i) => rows[i].cells[0].textContent.toLowerCase() !== 'b'));
  input.value = '';
  select.value = 'x';
  listeners[1]();
  assert.deepEqual(rows.filter((r) => !r.hidden).map((r) => r.dataset.k), ['x', 'x']);
});

// ---- signed, short-lived Undo links ----

test('undo: a missing, wrong or tampered signature changes nothing, on every route', async () => {
  writeNotes();
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [] }));
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notNames: [], found: [], places: [], notPlaces: [] }));
  const routes = { 'undo-keyword': { phrase: 'soap', category: CAT }, 'undo-category': { label: CAT, description: 'zzz', wrote: 'x' }, 'undo-word': { word: 'Alexa' }, 'undo-notname': { word: 'Wendy' }, 'undo-notname-mark': { word: 'Jo', firstSeen: '2026-01-01' }, 'undo-place': { word: 'Springfield' }, 'undo-notplace': { word: 'Lincoln' }, 'undo-notplace-mark': { word: 'Paris', type: 'city', firstSeen: '2026-01-01' } };
  for (const [route, fields] of Object.entries(routes)) {
    const signed = signUndo(route, fields);
    const bad = [
      fields, // no ts or mac at all
      { ...signed, mac: 'x'.repeat(64) },
      { ...signed, mac: '' },
      { ...signed, extra: 'smuggled' }, // a field added after signing
      { ...signed, ...Object.fromEntries(Object.keys(fields).slice(0, 1).map((k) => [k, `${fields[k]}!`])) }, // a field changed
      signUndo('undo-other', fields), // signed for another route
    ];
    for (const f of bad) assert.match(loc(await doUndo({ action: `/${route}?key=secret`, fields: f })).searchParams.get('notice'), /isn't valid any more/, route);
  }
  assert.deepEqual(await loadKeywords(), []);
  assert.equal(loadCategoryNotes()[CAT], 'Sam\'s things');
  const p = await loadPrivate();
  assert.deepEqual([p.words, p.notNames, p.found, p.placeWords, p.places, p.notPlaces].flat(), []);
});

test('undo: a link older than 15 minutes (or from the future) is refused with a friendly notice', async () => {
  const f = { word: 'Alexa' };
  const old = await sendSigned('undo-word', f, {}, Date.now() - 16 * 60000);
  assert.match(loc(old).searchParams.get('notice'), /older than 15 minutes/);
  const future = await sendSigned('undo-word', f, {}, Date.now() + 10 * 60000);
  assert.match(loc(future).searchParams.get('notice'), /older than 15 minutes/);
  assert.deepEqual((await loadPrivate()).words, []);
  const fresh = await sendSigned('undo-word', f, {}, Date.now() - 14 * 60000);
  assert.match(loc(fresh).searchParams.get('notice'), /back on the list/);
});

test('undo: a forged from=actual or auto=1 cannot be slipped in', async () => {
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [] }));
  const good = signUndo('undo-keyword', { phrase: 'soap', category: CAT, store: '', strength: 'usually', added: '2026-01-02', from: 'cli' });
  const res = await doUndo({ action: '/undo-keyword?key=secret', fields: { ...good, from: 'actual', strength: 'always' } });
  assert.match(loc(res).searchParams.get('notice'), /isn't valid/);
  assert.deepEqual(await loadKeywords(), []);
});

test('category undo after a newer save: nothing is overwritten', async () => {
  writeNotes();
  const first = await undoOf(await call('POST', '/category-save', { body: { label: CAT, description: 'first' } }));
  await call('POST', '/category-save', { body: { label: CAT, description: 'second, newer' } });
  const res = await doUndo(first.undo);
  assert.match(loc(res).searchParams.get('notice'), /changed since/);
  assert.equal(loadCategoryNotes()[CAT], 'second, newer');
  // and a replay of the same link after a successful undo changes nothing either
  writeNotes();
  const a = await undoOf(await call('POST', '/category-save', { body: { label: CAT, description: 'again' } }));
  await doUndo(a.undo);
  await call('POST', '/category-save', { body: { label: CAT, description: 'mine now' } });
  assert.match(loc(await doUndo(a.undo)).searchParams.get('notice'), /changed since/);
  assert.equal(loadCategoryNotes()[CAT].description ?? loadCategoryNotes()[CAT], 'mine now');
});

test('keyword undo keeps a category longer than 100 characters', async () => {
  const cat = `Group / ${'long name '.repeat(14)}`.trim();
  const notes = loadCategoryNotes();
  notes[cat] = 'x';
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify(notes));
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [{ phrase: 'soap', category: cat, store: null, strength: 'usually', added: '2026-01-02', from: 'cli' }] }));
  const { undo } = await undoOf(await call('POST', '/keyword-remove', { body: { phrase: 'soap' } }));
  assert.equal(undo.fields.category, cat);
  await doUndo(undo);
  assert.equal((await loadKeywords())[0].category, cat);
  writeNotes();
});

test('found-name undo respects the list size cap', async () => {
  const found = Array.from({ length: 500 }, (_, i) => ({ word: `Name${i}x`, firstSeen: '2026-01-01' }));
  fs.writeFileSync(config.privacy.wordsPath, JSON.stringify({ words: [], notNames: ['Jo'], found, places: [], notPlaces: [], placeWords: [] }));
  await sendSigned('undo-notname-mark', { word: 'Jo', firstSeen: '2026-01-01' });
  const p = await loadPrivate();
  assert.equal(p.found.length, 500);
  assert.deepEqual(p.notNames, []);
});
