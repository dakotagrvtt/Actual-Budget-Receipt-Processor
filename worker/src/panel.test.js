// The control panel: handlers (panel-actions.js), pages (panel-pages.js) and the server (trigger.js) on an ephemeral port.
// All files are in a temp folder; Nextcloud is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { makeServer, clip } from './trigger.js';
import * as actions from './panel-actions.js';
import { loadKeywords } from './keywords.js';
import { loadCategoryNotes, saveUserNote } from './category-notes.js';
import { forgetKeys, loadState, saveState, syncForgotten } from './state.js';
import { readSettings } from './settings.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
Object.assign(config, {
  categoryNotesPath: path.join(dir, 'category-notes.json'),
  keywordsPath: path.join(dir, 'keywords.json'),
  statePath: path.join(dir, 'state.json'),
  heartbeatPath: path.join(dir, 'heartbeat'),
  settingsPath: path.join(dir, 'settings.json'),
  dryRun: false,
  keywordMode: 'mixed',
});
config.trigger.token = 'secret';

const HOSTILE = '<script>alert(1)</script> & "q"';
const writeNotes = () =>
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({
    'Daily Expenses / Sam': 'Sam\'s things',
    'Daily Expenses / Child': { description: 'draft text', auto: true, basedOn: '12 transactions', written: '2026-01-01', previous: 'older text' },
    [`Odd / ${HOSTILE}`]: { description: `mine <b>${HOSTILE}</b>`, auto: false },
  }));
const form = (o) => new URLSearchParams(o);

let server;
let base;
const triggers = [];
test.before(async () => {
  writeNotes();
  server = makeServer((why) => triggers.push(why));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, p, { key = 'secret', body, headers } = {}) =>
  fetch(`${base}${p}${key === null ? '' : `${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`}`, { method, body, headers, redirect: 'manual' });

// ---- auth ----

test('every route answers 403 without the key (or with a wrong one) and changes nothing', async () => {
  writeNotes();
  const before = fs.readFileSync(config.categoryNotesPath, 'utf8');
  for (const p of ['/', '/categories', '/keywords', '/go-live']) {
    assert.equal((await call('GET', p, { key: null })).status, 403, `GET ${p}`);
    assert.equal((await call('GET', p, { key: 'wrong' })).status, 403, `GET ${p} wrong key`);
  }
  const body = form({ mode: 'live', confirm: 'yes', label: 'Daily Expenses / Sam', description: 'x', phrase: 'a', category: 'b', entry: 'k' });
  for (const p of ['/run', '/mode', '/category-save', '/keyword-add', '/keyword-remove', '/retry']) {
    assert.equal((await call('POST', p, { key: null, body })).status, 403, `POST ${p}`);
    assert.equal((await call('POST', p, { key: 'wrong', body })).status, 403, `POST ${p} wrong key`);
  }
  assert.equal(fs.readFileSync(config.categoryNotesPath, 'utf8'), before);
  assert.equal(fs.existsSync(config.settingsPath), false);
  assert.equal(fs.existsSync(config.keywordsPath), false);
  assert.equal(triggers.length, 0);
});

test('the key also works as a Bearer or X-Trigger-Key header', async () => {
  assert.equal((await call('GET', '/', { key: null, headers: { Authorization: 'Bearer secret' } })).status, 200);
  assert.equal((await call('GET', '/', { key: null, headers: { 'X-Trigger-Key': 'secret' } })).status, 200);
});

// ---- the webhook is unchanged ----

test('POST /run: a webhook gets 202 JSON, a browser gets a 303 back to the page', async () => {
  const hook = await call('POST', '/run');
  assert.equal(hook.status, 202);
  assert.equal(hook.headers.get('content-type'), 'application/json');
  assert.equal(await hook.text(), '{"ok":true}\n');
  const browser = await call('POST', '/run', { headers: { Accept: 'text/html' } });
  assert.equal(browser.status, 303);
  assert.equal(browser.headers.get('location'), './?key=secret&started=1');
  assert.equal(triggers.length, 2);
});

test('a form body over 64 KB is refused with 413', async () => {
  const big = form({ label: 'Daily Expenses / Sam', description: 'x'.repeat(70 * 1024) });
  assert.equal((await call('POST', '/category-save', { body: big })).status, 413);
  assert.equal(loadCategoryNotes()['Daily Expenses / Sam'], 'Sam\'s things');
});

// ---- dry run / live ----

test('going live needs the confirmation; going back to dry run is one click', async () => {
  fs.rmSync(config.settingsPath, { force: true });
  let r = await call('POST', '/mode', { body: form({ mode: 'live' }) });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /Tick the box/);
  assert.equal(fs.existsSync(config.settingsPath), false, 'nothing written without the box');

  r = await call('POST', '/mode', { body: form({ mode: 'live', confirm: 'yes' }) });
  assert.equal(r.status, 303);
  assert.equal(readSettings().dryRun, false);
  assert.equal(readSettings().changedBy, 'status page');
  assert.equal(readSettings().envDryRun, undefined, 'only the switch is stored; .env is ignored once the file exists');

  r = await call('POST', '/mode', { body: form({ mode: 'dry' }) });
  assert.equal(r.status, 303);
  assert.equal(readSettings().dryRun, true);
  fs.rmSync(config.settingsPath, { force: true });
});

test('the status page shows the mode banner and a go-live step that needs a ticked box', async () => {
  config.dryRun = true;
  const status = await (await call('GET', '/')).text();
  assert.match(status, /<b>Dry run<\/b>/);
  assert.match(status, /Go live\.\.\./);
  const confirm = await (await call('GET', '/go-live')).text();
  assert.match(confirm, /type="checkbox" name="confirm" value="yes" required/);
  assert.match(confirm, /write[s]? to Actual/);
  assert.match(confirm, /processed again, for real|processed for real/);
  config.dryRun = false;
  assert.match(await (await call('GET', '/')).text(), /<b>Live<\/b>[\s\S]*Switch to dry run/);
});

// ---- categories ----

test('saving a category: user-written, other fields kept, draft flag cleared', async () => {
  writeNotes();
  const r = await call('POST', '/category-save', { body: form({ label: 'Daily Expenses / Child', description: '  Baby food and toddler snacks  ' }) });
  assert.equal(r.status, 303);
  const saved = loadCategoryNotes()['Daily Expenses / Child'];
  assert.equal(saved.description, 'Baby food and toddler snacks');
  assert.equal(saved.auto, false, 'no longer a draft');
  assert.equal(saved.previous, 'older text');
  assert.equal(saved.basedOn, '12 transactions');
  assert.match(saved.writtenBy, /status page/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.endsWith('.lock')), [], 'no temp or lock files left');

  await actions.saveCategory(form({ label: 'Daily Expenses / Sam', description: 'Sam: clothes' }));
  assert.equal(loadCategoryNotes()['Daily Expenses / Sam'], 'Sam: clothes', 'a plain string stays a string');
});

test('saving rejects an empty description and a category that does not exist', async () => {
  writeNotes();
  await assert.rejects(actions.saveCategory(form({ label: 'Daily Expenses / Sam', description: '   ' })), actions.PanelError);
  await assert.rejects(actions.saveCategory(form({ label: 'Nope / Nothing', description: 'x' })), actions.PanelError);
  assert.equal(Object.keys(loadCategoryNotes()).length, 3);
});

test('excluded groups and categories are not listed, and saving one is refused', async () => {
  writeNotes();
  const was = [config.excludeGroups, config.excludeCategories];
  try {
    assert.equal(actions.listCategories().length, 3);
    config.excludeGroups = ['Odd'];
    config.excludeCategories = ['Daily Expenses / Sam'];
    const shown = actions.listCategories().map((c) => c.label);
    assert.deepEqual(shown, ['Daily Expenses / Child'], 'the excluded single category and the excluded group are hidden');
    for (const label of ['Daily Expenses / Sam', `Odd / ${HOSTILE}`]) {
      await assert.rejects(actions.saveCategory(form({ label, description: 'x' })), (e) => e instanceof actions.PanelError && /isn't in the list/.test(e.message));
    }
  } finally {
    [config.excludeGroups, config.excludeCategories] = was;
  }
});

test('concurrent saves on the notes file do not lose each other', async () => {
  const notes = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`G / C${i}`, `old ${i}`]));
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify(notes));
  await Promise.all(Object.keys(notes).map((label, i) => saveUserNote(label, `new ${i}`)));
  const after = loadCategoryNotes();
  for (let i = 0; i < 12; i++) assert.equal(after[`G / C${i}`], `new ${i}`);
  writeNotes();
});

// ---- keywords ----

test('adding and removing a keyword through the panel (same file and rules as the CLI)', async () => {
  writeNotes();
  fs.rmSync(config.keywordsPath, { force: true });
  let r = await call('POST', '/keyword-add', { body: form({ phrase: ' Gold Bond ', category: 'Daily Expenses / Sam', store: 'Target', strength: 'always' }) });
  assert.equal(r.status, 303);
  let kws = await loadKeywords();
  assert.equal(kws.length, 1);
  assert.deepEqual({ ...kws[0], added: undefined }, { phrase: 'Gold Bond', category: 'Daily Expenses / Sam', store: 'Target', strength: 'always', added: undefined, from: 'status page' });

  await actions.addKeywordFromForm(form({ phrase: 'tide pods', category: 'Daily Expenses / Child', strength: 'weird' }));
  kws = await loadKeywords();
  assert.equal(kws.find((k) => k.phrase === 'tide pods').strength, 'usually', 'default and fallback is usually');
  assert.equal(kws.find((k) => k.phrase === 'tide pods').store, null);

  // Adding the same phrase and store again replaces it, like the CLI.
  await actions.addKeywordFromForm(form({ phrase: 'GOLD BOND', category: 'Daily Expenses / Child', store: 'target' }));
  assert.equal((await loadKeywords()).filter((k) => k.phrase.toLowerCase() === 'gold bond').length, 1);

  r = await call('POST', '/keyword-remove', { body: form({ phrase: 'GOLD BOND', store: 'target' }) });
  assert.equal(r.status, 303);
  assert.deepEqual((await loadKeywords()).map((k) => k.phrase), ['tide pods']);
  assert.equal(JSON.parse(fs.readFileSync(config.keywordsPath, 'utf8')).removed[0].phrase, 'GOLD BOND', 'remembered, so an #always tag does not bring it back');
  await assert.rejects(actions.removeKeywordFromForm(form({ phrase: 'nothing here' })), actions.PanelError);
});

test('adding rejects an empty phrase and a category that is not in the list', async () => {
  fs.rmSync(config.keywordsPath, { force: true });
  await assert.rejects(actions.addKeywordFromForm(form({ phrase: ' !! ', category: 'Daily Expenses / Sam' })), actions.PanelError);
  await assert.rejects(actions.addKeywordFromForm(form({ phrase: 'x', category: 'Made / Up' })), actions.PanelError);
  assert.deepEqual(await loadKeywords(), []);
});

test('a notice is cut by code point (no lone surrogate, so encodeURIComponent cannot throw); long remove phrases are refused', async () => {
  const long = `${'a'.repeat(299)}😀😀`; // the 300th UTF-16 unit would be half an emoji
  assert.throws(() => encodeURIComponent(long.slice(0, 300)), URIError);
  assert.equal(Array.from(clip(long)).length, 300);
  assert.doesNotThrow(() => encodeURIComponent(clip(long)));
  assert.equal(clip(long), `${'a'.repeat(299)}😀`);
  await assert.rejects(actions.removeKeywordFromForm(form({ phrase: 'x'.repeat(101) })), /under 100 characters/);
  await assert.rejects(actions.removeKeywordFromForm(form({ phrase: 'x', store: 'y'.repeat(101) })), /under 100 characters/);
});

// ---- try again ----

const live = (result, extra) => [`/Receipts/Inbox/r.jpg@etag1`, { done: true, result, at: '2026-01-01T00:00:00Z', filedAs: '/Receipts/Needs review/r.jpg', ...extra }];

test('retryStatus: review/failed in live is eligible; applied-then-review needs an undo; everything else is not', () => {
  const s = (k, e) => actions.retryStatus(k, e);
  assert.equal(s(...live('review')), 'yes');
  assert.equal(s(...live('failed')), 'yes');
  for (const r of ['split+review', 'categorize+review', 'confirm+review', 'note+review']) assert.equal(s(...live(r)), 'undo', r);
  for (const r of ['split', 'categorize', 'confirm', 'already-applied']) assert.equal(s(...live(r)), 'no', r);
  assert.equal(s('dry:/Receipts/Inbox/r.jpg@e', { done: true, result: 'review' }), 'no', 'dry-run entries: nothing was moved');
  assert.equal(s(...live('review', { done: false })), 'no');
  // Anything recorded as applied is 'undo', whatever the result string says (the move-failed-three-times path writes 'failed').
  const applied = { action: 'split', at: '2026-01-01T00:00:00Z' };
  for (const r of ['failed', 'review', 'split', 'categorize', 'whatever']) assert.equal(s(...live(r, { applied })), 'undo', r);
  assert.equal(s('dry:/Receipts/Inbox/r.jpg@e', { done: true, result: 'failed', applied }), 'no', 'dry-run entries stay no');
  assert.equal(s('x', undefined), 'no');
});

// What the worker does at the start of each cycle (after loading state), so earlier clicks stop being tracked.
const newCycle = () => syncForgotten({});
const stubNextcloud = (answer) => {
  const calls = [];
  return { calls, requeueFromReview: async (from, name) => (calls.push([from, name]), answer) };
};

test('try again: moves the file back, clears the state entry, leaves other entries alone', async () => {
  config.dryRun = false;
  const [k1, e1] = live('review');
  const k2 = '/Receipts/Inbox/other.jpg@etag9';
  newCycle();
  await saveState({ [k1]: e1, [k2]: { done: true, result: 'split' } });
  const nc = stubNextcloud({ moved: '/Receipts/Inbox/r.jpg' });
  const notice = await actions.tryAgain(form({ entry: k1 }), { nextcloud: nc });
  assert.deepEqual(nc.calls, [['/Receipts/Needs review/r.jpg', 'r.jpg']], 'moves exactly the recorded path');
  assert.match(notice, /back in the inbox/);
  assert.deepEqual(Object.keys(await loadState()), [k2]);
});

test('try again: a worker holding the old state in memory cannot put the entry back', async () => {
  newCycle();
  const [k1, e1] = live('review');
  await saveState({ [k1]: e1 });
  const workerCopy = await loadState(); // the worker loaded this before the click
  await forgetKeys([k1]);
  await saveState(workerCopy);
  assert.deepEqual(await loadState(), {});
  newCycle();
});

test('try again: refused when something was applied, in dry run, or when the entry is gone; nothing moves', async () => {
  newCycle();
  const [k1, e1] = live('split+review');
  await saveState({ [k1]: e1 });
  const nc = stubNextcloud({ moved: 'x' });
  config.dryRun = false;
  await assert.rejects(actions.tryAgain(form({ entry: k1 }), { nextcloud: nc }), /Undo it there first.*delete the file from Needs review and upload the receipt again/);
  await assert.rejects(actions.tryAgain(form({ entry: 'nope' }), { nextcloud: nc }), /isn't in the list/);
  const [k2, e2] = live('review');
  await saveState({ [k2]: e2 });
  config.dryRun = true;
  await assert.rejects(actions.tryAgain(form({ entry: k2 }), { nextcloud: nc }), /dry run/);
  config.dryRun = false;
  assert.deepEqual(nc.calls, []);
  assert.ok(k2 in (await loadState()));
});

test('try again: a file that is not in Needs review keeps its state entry; one already in the inbox clears it', async () => {
  newCycle();
  const [k, e] = live('failed');
  await saveState({ [k]: e });
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: stubNextcloud(null) }), /Couldn't find r.jpg/);
  assert.ok(k in (await loadState()));
  await actions.tryAgain(form({ entry: k }), { nextcloud: stubNextcloud({ inInbox: true }) });
  assert.deepEqual(await loadState(), {});
});

test('try again: an entry without a recorded path (older version) is refused; nothing moves, state kept', async () => {
  newCycle();
  const [k, e] = live('review', { filedAs: undefined });
  await saveState({ [k]: e });
  const nc = stubNextcloud({ moved: 'x' });
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: nc }), /doesn't record where r\.jpg was filed/);
  assert.deepEqual(nc.calls, []);
  assert.ok(k in (await loadState()));
});

test('try again: refused when the summary shows it was applied, or the inbox has the name; state kept', async () => {
  newCycle();
  const [k, e] = live('review');
  await saveState({ [k]: e });
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: stubNextcloud({ refused: 'applied' }) }), /says it was applied/);
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: stubNextcloud({ refused: 'exists' }) }), /already has a file called r\.jpg/);
  assert.ok(k in (await loadState()));
});

test('try again: a double click moves the file once; the second request gets a friendly notice and moves nothing', async () => {
  newCycle();
  const [k, e] = live('review');
  await saveState({ [k]: e });
  const nc = stubNextcloud({ moved: '/Receipts/Inbox/r.jpg' });
  const slow = { requeueFromReview: async (...a) => { await new Promise((r) => setTimeout(r, 20)); return nc.requeueFromReview(...a); } };
  const results = await Promise.allSettled([actions.tryAgain(form({ entry: k }), { nextcloud: slow }), actions.tryAgain(form({ entry: k }), { nextcloud: slow })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected').reason;
  assert.ok(rejected instanceof actions.PanelError);
  assert.match(rejected.message, /isn't in the list any more.*Nothing was moved/);
  assert.equal(nc.calls.length, 1);
  assert.deepEqual(await loadState(), {});
});

test('the status page: a Try again button for review results, an undo note for applied ones, none in dry run', async () => {
  newCycle();
  config.dryRun = false;
  await saveState({
    '/Receipts/Inbox/a.jpg@1': { done: true, result: 'review', at: '2026-01-03T00:00:00Z' },
    '/Receipts/Inbox/b.jpg@1': { done: true, result: 'split+review', at: '2026-01-02T00:00:00Z' },
    '/Receipts/Inbox/c.jpg@1': { done: true, result: 'categorize', at: '2026-01-01T00:00:00Z' },
    '/Receipts/Inbox/e.jpg@1': { done: true, result: 'failed', applied: { action: 'split' }, at: '2026-01-05T00:00:00Z' },
    '/Receipts/Inbox/f.jpg@1': { done: true, result: 'split', applied: { action: 'split' }, at: '2026-01-06T00:00:00Z' },
    'dry:/Receipts/Inbox/d.jpg@1': { done: true, result: 'dry-run:review', at: '2026-01-04T00:00:00Z' },
  });
  const page = await (await call('GET', '/')).text();
  assert.equal((page.match(/Try again/g) ?? []).length, 1, 'not for the failed-but-applied one');
  assert.equal((page.match(/Undo it there first/g) ?? []).length, 2, 'b (split+review) and e (failed, applied); f was filed cleanly');
  assert.match(page, /name="entry" value="\/Receipts\/Inbox\/a.jpg@1"/);
  assert.match(page, /Undo it there first/);
  assert.doesNotMatch(page, /d\.jpg/);
  config.dryRun = true;
  const dry = await (await call('GET', '/')).text();
  assert.match(dry, /d\.jpg/);
  assert.doesNotMatch(dry, /Try again/);
  config.dryRun = false;
});

// ---- escaping ----

test('hostile category names, descriptions, phrases, stores and file names are escaped on every page', async () => {
  writeNotes();
  fs.writeFileSync(config.keywordsPath, JSON.stringify({ keywords: [
    { phrase: HOSTILE, category: `Odd / ${HOSTILE}`, store: '"><img src=x onerror=1>', strength: 'always', from: '<i>x</i>', added: '2026-01-01' },
  ] }));
  await saveState({ [`/Receipts/Inbox/${HOSTILE}.jpg@1`]: { done: true, result: `<b>review</b>`, at: '2026-01-01T00:00:00Z' } });
  for (const p of ['/', '/categories', '/keywords']) {
    const page = await (await call('GET', `${p}?notice=${encodeURIComponent(HOSTILE)}`)).text();
    assert.doesNotMatch(page, /<script>alert/, p);
    assert.doesNotMatch(page, /<img src=x/, p);
    assert.doesNotMatch(page, /<b>review<\/b>|<i>x<\/i>/, p);
    assert.match(page, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/, p);
  }
  const cats = await (await call('GET', '/categories')).text();
  assert.match(cats, /value="Odd \/ &#60;script&#62;/);
  assert.match(cats, /mine &#60;b&#62;/);
});

// ---- the switch, the disagreement note, and an unreadable state file ----

test('the status page says plainly when DRY_RUN in .env is ignored because the settings file decides', async () => {
  const was = config.envDryRun;
  try {
    config.envDryRun = true;
    config.dryRun = false;
    fs.writeFileSync(config.settingsPath, '{"dryRun":false,"changedBy":"cli"}');
    const page = await (await call('GET', '/')).text();
    assert.match(page, /DRY_RUN in \.env \(true\) is ignored; the switch on the status page \(data\/settings\.json\) says live\. Use the page or \.\/receipts mode dry to stop\./);
    fs.writeFileSync(config.settingsPath, '{"dryRun":true}');
    config.dryRun = true;
    assert.doesNotMatch(await (await call('GET', '/')).text(), /is ignored/, 'file and .env agree: no note');
    fs.rmSync(config.settingsPath, { force: true });
    assert.doesNotMatch(await (await call('GET', '/')).text(), /is ignored/, 'no file: no note');
  } finally {
    config.envDryRun = was;
    config.dryRun = false;
    fs.rmSync(config.settingsPath, { force: true });
  }
});

test('the status page shows an error (not "nothing processed") when the state file is damaged; Try again refuses and moves nothing', async () => {
  const [k, e] = live('review');
  newCycle();
  await saveState({ [k]: e });
  fs.writeFileSync(config.statePath, '{broken');
  const page = await (await call('GET', '/')).text();
  assert.match(page, /Can't read the list of receipts/);
  const nc = stubNextcloud({ moved: 'x' });
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: nc }), /Can't read the list of receipts.*Nothing was moved/);
  assert.deepEqual(nc.calls, []);
  assert.equal(fs.readFileSync(config.statePath, 'utf8'), '{broken', 'not overwritten');
  fs.rmSync(config.statePath);
  newCycle();
});

test('try again: if the list cannot be updated after the file was moved back, the notice says what to do', async () => {
  newCycle();
  const [k, e] = live('review');
  await saveState({ [k]: e });
  const breakIt = { requeueFromReview: async () => (fs.writeFileSync(config.statePath, '{broken'), { moved: '/Receipts/Inbox/r.jpg' }) };
  await assert.rejects(actions.tryAgain(form({ entry: k }), { nextcloud: breakIt }), /moved back to the inbox, but the list of receipts could not be updated.*upload the receipt again/);
  fs.rmSync(config.statePath);
  newCycle();
});
