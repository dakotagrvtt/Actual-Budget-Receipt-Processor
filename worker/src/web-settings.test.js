// The Settings tab: the overrides file, the config rebuild, validation, connection tests, Undo, and the Categories exclude buttons.
// Everything is in a temp folder; the network is a stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-settings-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 'web-settings.json');
// reloadConfig() rebuilds from process.env, so the temp paths go there too.
Object.assign(process.env, {
  WEB_SETTINGS_PATH: file,
  CATEGORY_NOTES_PATH: path.join(dir, 'category-notes.json'),
  KEYWORDS_PATH: path.join(dir, 'keywords.json'),
  SETTINGS_PATH: path.join(dir, 'settings.json'),
  TRIGGER_TOKEN: 'secret',
});
const { config, buildConfig, reloadConfig, reloadStatus } = await import('./config.js');
const { readOverrides } = await import('./web-overrides.js');
const { SETTINGS, SETTINGS_BY_KEY, SECTIONS, normalizeValue, SettingError } = await import('./web-settings-schema.js');
const store = await import('./web-settings.js');
const settings = await import('./panel-settings.js');
const actions = await import('./panel-actions.js');
const { makeServer } = await import('./trigger.js');
const { rememberCategories } = await import('./known-categories.js');
const { loadCategoryNotes } = await import('./category-notes.js');
const { createUpgradeWatcher } = await import('./actual-upgrade.js');
const { keyedClient } = await import('./keyed-client.js');

const SRC = path.dirname(fileURLToPath(import.meta.url));
const form = (o) => new URLSearchParams(o);
const writeFile = (values) => fs.writeFileSync(file, JSON.stringify({ values, changedAt: '2026-11-06T12:00:00.000Z' }));
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));
/** Rebuild the config from the file, then put back the paths the other tests of this file rely on. */
function reload() {
  const ok = reloadConfig();
  Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat') });
  config.trigger.token = 'secret';
  return ok;
}
test.beforeEach(() => {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.lock`, { force: true });
  settings.testDeps.fetchFn = undefined;
  settings.testDeps.createClientFn = undefined;
  config.trigger.token = 'secret';
  config.webSettingsPath = file;
});

// ---- config: buildConfig and reloadConfig ----

test('buildConfig builds from any settings object and leaves process.env and the exported config alone', () => {
  const before = config.match.days;
  const c = buildConfig({ ...process.env, MATCH_DAYS: '9', NEXTCLOUD_USER: 'someone' });
  assert.equal(c.match.days, 9);
  assert.equal(c.nextcloud.user, 'someone');
  assert.equal(config.match.days, before);
  assert.equal(process.env.MATCH_DAYS, undefined);
  assert.throws(() => buildConfig({ ...process.env, MATCH_DAYS: 'abc' }), /MATCH_DAYS must be a number/);
  assert.throws(() => buildConfig({ ...process.env, NEXTCLOUD_URL: '' }), /Missing required setting NEXTCLOUD_URL/);
});

test('reloadConfig updates the config in place: the same objects, new values, dryRun untouched', () => {
  const nc = config.nextcloud;
  const match = config.match;
  config.dryRun = false;
  writeFile({ NEXTCLOUD_USER: 'newuser', MATCH_DAYS: '9', POLL_SECONDS: '600', KEYWORD_MODE: 'hint' });
  assert.equal(reload(), true);
  assert.equal(config.nextcloud, nc, 'config.nextcloud is still the same object');
  assert.equal(config.match, match);
  assert.equal(nc.user, 'newuser');
  assert.equal(config.match.days, 9);
  assert.equal(config.pollSeconds, 600);
  assert.equal(config.keywordMode, 'hint');
  assert.equal(config.dryRun, false, 'the dry run switch is settings.js\'s');
  fs.rmSync(file);
  assert.equal(reload(), true);
  assert.equal(nc.user, 'test', 'a key that is no longer in the file falls back to .env');
  assert.equal(config.match.days, 4);
  assert.equal(config.pollSeconds, 300);
  assert.equal(config.keywordMode, 'mixed');
  config.dryRun = true;
});

test('a value from the file wins over .env, and a key not in the file falls back to .env', () => {
  process.env.MATCH_PENDING_WAIT_DAYS = '5';
  process.env.OCCASION_DAYS_BEFORE = '20';
  try {
    writeFile({ OCCASION_DAYS_BEFORE: '3' });
    reload();
    assert.equal(config.occasions.daysBefore, 3, 'the file wins');
    assert.equal(config.match.pendingWaitDays, 5, 'not in the file: .env');
    assert.equal(config.match.days, 4, 'not in either: the default');
    const o = store.loadOverrides();
    assert.deepEqual(['OCCASION_DAYS_BEFORE', 'MATCH_PENDING_WAIT_DAYS', 'MATCH_DAYS'].map((k) => store.effectiveSetting(k, o)), [
      { value: '3', source: 'page' }, { value: '5', source: 'env' }, { value: '4', source: 'default' },
    ]);
  } finally {
    delete process.env.MATCH_PENDING_WAIT_DAYS;
    delete process.env.OCCASION_DAYS_BEFORE;
    fs.rmSync(file, { force: true });
    reload();
  }
});

test('a value that cannot be built keeps the earlier config, is recorded for the page, and clears when fixed', () => {
  writeFile({ MATCH_DAYS: '7' });
  reload();
  writeFile({ MATCH_DAYS: 'abc', POLL_SECONDS: '900' });
  assert.equal(reload(), false);
  assert.equal(config.match.days, 7, 'the earlier config stays in force, all of it');
  assert.equal(config.pollSeconds, 300);
  assert.match(reloadStatus.error, /MATCH_DAYS must be a number/);
  writeFile({ MATCH_DAYS: '8' });
  assert.equal(reload(), true);
  assert.equal(reloadStatus.error, null);
  assert.equal(config.match.days, 8);
  fs.rmSync(file);
  reload();
});

test('the file cannot set what is not on the Settings tab (TRIGGER_TOKEN, DRY_RUN ...): those keys are ignored', () => {
  writeFile({ TRIGGER_TOKEN: 'evil', DRY_RUN: 'false', DECIDER_PROVIDER: 'remote', MATCH_DAYS: '6' });
  const o = readOverrides(file);
  assert.deepEqual(o.values, { MATCH_DAYS: '6' });
  assert.deepEqual(o.ignored.sort(), ['DECIDER_PROVIDER', 'DRY_RUN', 'TRIGGER_TOKEN']);
  reload();
  assert.equal(config.trigger.token, 'secret');
  assert.equal(config.decider.provider, 'local');
  assert.equal(config.envDryRun, true);
  fs.rmSync(file);
  reload();
});

test('a damaged file is ignored with one warning, never a crash; .env applies', () => {
  const bad = ['{not json', '', '[]', '"text"', '{"values":[]}', '{"values":{"MATCH_DAYS":5}}', '{"nope":1}'];
  for (const text of bad) {
    fs.writeFileSync(file, text);
    const warnings = [];
    readOverrides(path.join(dir, 'missing.json'), () => {}); // a readable state in between, so the same problem is new again
    const a = readOverrides(file, (m) => warnings.push(m));
    const b = readOverrides(file, (m) => warnings.push(m));
    assert.ok(a.damaged, text);
    assert.deepEqual(a.values, {}, text);
    assert.equal(warnings.length, 1, `warned once for ${JSON.stringify(text)}`);
    assert.equal(b.damaged, a.damaged);
  }
  // A JSON error quotes the start of the file; that must not reach the message (it could be a password).
  fs.writeFileSync(file, '{"values": {"ACTUAL_PASSWORD": "hunter2-secret"} oops');
  assert.ok(!readOverrides(file, () => {}).damaged.includes('hunter2'));
  assert.equal(reload(), true);
  assert.equal(config.match.days, 4);
  assert.ok(reloadStatus.damaged);
  fs.rmSync(file);
  reload();
  assert.equal(reloadStatus.damaged, null);
  assert.equal(readOverrides(path.join(dir, 'missing.json')).exists, false);
});

// ---- the schema ----

test('the schema holds exactly the keys of the Settings tab, none of the .env-only ones', () => {
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const never of ['TRIGGER_TOKEN', 'TRIGGER_BIND', 'DRY_RUN', 'ACTUAL_API_VERSION', 'DECIDER_API_KEY', 'READER_API_KEY', 'DECIDER_MODEL', 'READER_PROVIDER', 'CLOUD_NAME_SCAN', 'PRIVATE_WORDS', 'PRIVATE_PLACES', 'OCCASIONS_CALENDAR', 'OCCASIONS_CALENDARS', 'COMPOSE_FILE', 'RENDER_GID', 'SETTINGS_PATH', 'KEYWORDS_PATH', 'LLM_URL']) {
    assert.ok(!SETTINGS_BY_KEY.has(never), never);
  }
  assert.ok(keys.every((k) => !/(_PATH|_DIR)$/.test(k)));
  assert.equal(keys.length, 50);
  assert.deepEqual([...new Set(SETTINGS.map((s) => s.section))], SECTIONS.map((s) => s.id));
  for (const s of SETTINGS) assert.ok(s.help && s.label && s.type, s.key);
  assert.deepEqual(SETTINGS.filter((s) => s.type === 'secret').map((s) => s.key), ['ACTUAL_PASSWORD', 'ACTUAL_E2E_PASSWORD', 'NEXTCLOUD_APP_PASSWORD']);
  const poll = SETTINGS_BY_KEY.get('POLL_SECONDS');
  assert.deepEqual([poll.min, poll.max], [60, 3600], 'the container healthcheck allows POLL_SECONDS plus an hour');
});

test('every default in the schema is what config.js uses when the key is missing', () => {
  const base = { ACTUAL_SERVER_URL: 'http://a.invalid', ACTUAL_PASSWORD: 'p', ACTUAL_SYNC_ID: 's', NEXTCLOUD_URL: 'http://n.invalid', NEXTCLOUD_USER: 'u', NEXTCLOUD_APP_PASSWORD: 'q' };
  const bare = buildConfig(base, { quiet: true });
  for (const s of SETTINGS) {
    if (s.default === '' && s.required) continue; // required: no default
    const withDefault = buildConfig({ ...base, [s.key]: s.default }, { quiet: true });
    assert.deepEqual(withDefault, bare, `${s.key}: default "${s.default}" gives the same config as leaving it out`);
    if (s.default !== '') assert.equal(normalizeValue(s, s.default), s.default, `${s.key} default is a valid value`);
  }
});

test('normalizeValue: bad numbers, out-of-range numbers, bad choices and bad shapes are refused with a plain message', () => {
  const def = (k) => SETTINGS_BY_KEY.get(k);
  const refused = [
    ['MATCH_DAYS', 'abc', /not a number/], ['MATCH_DAYS', '', /type a number/], ['MATCH_DAYS', '2.5', /whole number/], ['MATCH_DAYS', '-1', /between 0 and 60/], ['MATCH_DAYS', '61', /between 0 and 60/],
    ['PAYEE_MIN_SCORE', '1.5', /between 0 and 1/], ['PAYEE_MIN_SCORE', 'NaN', /not a number/], ['PAYEE_MIN_SCORE', 'Infinity', /not a number/],
    ['POLL_SECONDS', '59', /between 60 and 3600/], ['POLL_SECONDS', '3601', /between 60 and 3600/],
    ['KEYWORD_MODE', 'sometimes', /one of off, final, hint, mixed/], ['LEARNING', 'yes', /one of on, record, off/],
    ['SPLIT_TRANSACTIONS', 'maybe', /on or off/], ['RECEIPT_CHECK', '2', /on or off/],
    ['RECEIPTS_INBOX', 'Receipts/Inbox', /start with \//], ['RECEIPTS_INBOX', '/a/../b', /\.\./], ['RECEIPTS_INBOX', '', /empty/],
    ['NEXTCLOUD_URL', 'http://', /not a web address/], ['NEXTCLOUD_URL', 'ftp://x.example', /http/], ['NEXTCLOUD_URL', 'https://me:pw@x.example', /user name or password/],
    ['TRIGGER_TIMEZONE', 'Mars/Olympus', /not a time zone/], ['ACTUAL_SYNC_ID', 'not-a-uuid', /looks like/], ['NEXTCLOUD_USER', '', /empty/],
    ['NEXTCLOUD_USER', 'a\nb', /one line/], ['ACTUAL_PASSWORD', '', /empty/],
  ];
  for (const [key, value, why] of refused) assert.throws(() => normalizeValue(def(key), value), (e) => e instanceof SettingError && why.test(e.message), `${key}=${JSON.stringify(value)}`);
  assert.equal(normalizeValue(def('MATCH_DAYS'), ' 7 '), '7');
  assert.equal(normalizeValue(def('PAYEE_MIN_SCORE'), '0.70'), '0.7');
  assert.equal(normalizeValue(def('KEYWORD_MODE'), ' HINT '), 'hint');
  assert.equal(normalizeValue(def('OCCASIONS'), 'Yes'), 'true');
  assert.equal(normalizeValue(def('OCCASIONS'), 'off'), 'false');
  assert.equal(normalizeValue(def('MATCH_ACCOUNTS'), ' Checking , ,Visa '), 'Checking,Visa');
  assert.equal(normalizeValue(def('MATCH_ACCOUNTS'), ''), '');
  assert.equal(normalizeValue(def('RECEIPTS_INBOX'), '/Receipts/Inbox//'), '/Receipts/Inbox');
  assert.equal(normalizeValue(def('NEXTCLOUD_URL'), 'cloud.example.com/'), 'cloud.example.com');
  assert.equal(normalizeValue(def('TRIGGER_TIMEZONE'), 'America/New_York'), 'America/New_York');
  assert.equal(normalizeValue(def('ACTUAL_E2E_PASSWORD'), ''), '', 'the encryption password is optional');
});

// ---- the overrides file ----

test('changeOverrides writes atomically with mode 600, returns the earlier state, and removes the file when nothing is left', async () => {
  const before = await store.changeOverrides({ MATCH_DAYS: '6', POLL_SECONDS: '600' });
  assert.deepEqual(before, { MATCH_DAYS: null, POLL_SECONDS: null });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readFile().values, { MATCH_DAYS: '6', POLL_SECONDS: '600' });
  assert.match(readFile().changedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await store.changeOverrides({ MATCH_DAYS: '7', POLL_SECONDS: null }), { MATCH_DAYS: '6', POLL_SECONDS: '600' });
  assert.deepEqual(readFile().values, { MATCH_DAYS: '7' });
  await store.changeOverrides({ MATCH_DAYS: null });
  assert.equal(fs.existsSync(file), false, 'no values left, no file: "the file exists" means "something is set"');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.endsWith('.lock')), []);
  await assert.rejects(store.changeOverrides({ TRIGGER_TOKEN: 'x' }), SettingError);
});

test('concurrent changes do not lose each other', async () => {
  await Promise.all(['MATCH_DAYS', 'POLL_SECONDS', 'HISTORY_DAYS', 'HISTORY_LIMIT'].map((k, i) => store.changeOverrides({ [k]: String(100 + i) })));
  assert.equal(Object.keys(readFile().values).length, 4);
});

// ---- saving: validation, nothing saved on a refusal ----

const refusedWith = async (fields, why) => {
  await assert.rejects(settings.saveSettings(form(fields), {}), (e) => e instanceof actions.PanelError && why.test(e.message), JSON.stringify(fields));
  assert.equal(fs.existsSync(file), false, `nothing was saved for ${JSON.stringify(fields)}`);
};

test('saving refuses a bad number, an out-of-range number and a bad choice, and saves nothing (not even the good values beside them)', async () => {
  await refusedWith({ MATCH_DAYS: 'abc' }, /not a number/);
  await refusedWith({ MATCH_DAYS: '999' }, /between 0 and 60/);
  await refusedWith({ POLL_SECONDS: '10' }, /between 60 and 3600/);
  await refusedWith({ KEYWORD_MODE: 'sometimes' }, /one of/);
  await refusedWith({ MATCH_DAYS: '9', PAYEE_MIN_SCORE: '2' }, /between 0 and 1/);
  await refusedWith({ OVERWRITE_CATEGORIZED: 'perhaps' }, /on or off/);
});

test('saving refuses any key outside the schema, and a reset of one', async () => {
  for (const key of ['TRIGGER_TOKEN', 'DRY_RUN', 'TRIGGER_BIND', 'DECIDER_API_KEY', 'COMPOSE_FILE', 'ACTUAL_API_VERSION']) {
    await assert.rejects(settings.saveSettings(form({ MATCH_DAYS: '9', [key]: 'x' }), {}), (e) => e instanceof actions.PanelError && new RegExp(`${key}.*only be changed in .env`).test(e.message), key);
    await assert.rejects(settings.resetSetting(form({ reset: key }), {}), actions.PanelError, `reset ${key}`);
  }
  assert.equal(fs.existsSync(file), false);
});

test('saving writes only what differs, says when it applies, and offers Undo', async () => {
  const out = {};
  const msg = await settings.saveSettings(form({ section: 'matching', MATCH_DAYS: '4', MATCH_TOLERANCE_PERCENT: '25', OVERWRITE_CATEGORIZED: 'true', KEYWORD_MODE: '' }), out);
  assert.equal(msg, 'Saved. It applies at the start of the next check.');
  assert.deepEqual(readFile().values, { MATCH_TOLERANCE_PERCENT: '25' }, 'MATCH_DAYS=4 is the default already, so it is not written');
  assert.equal(out.undo.route, 'undo-settings');
  assert.deepEqual(Object.keys(out.undo.fields).sort(), ['id', 'mac', 'ts']);
  assert.match(await settings.saveSettings(form({ MATCH_TOLERANCE_PERCENT: '25' }), {}), /Nothing was different/);
  // The page value of a checkbox: a hidden "false" first, then "true" when ticked.
  await settings.saveSettings(form([['SPLIT_TRANSACTIONS', 'false'], ['SPLIT_TRANSACTIONS', 'true']]), {});
  assert.equal(readFile().values.SPLIT_TRANSACTIONS, undefined, 'ticked = true = the default');
  await settings.saveSettings(form({ SPLIT_TRANSACTIONS: 'false' }), {});
  assert.equal(readFile().values.SPLIT_TRANSACTIONS, 'false');
});

test('Undo puts the earlier state of those keys back, once, and an unsigned or unknown one changes nothing', async () => {
  await settings.saveSettings(form({ MATCH_DAYS: '5' }), {});
  const out = {};
  await settings.saveSettings(form({ MATCH_DAYS: '6', POLL_SECONDS: '900' }), out);
  assert.deepEqual(readFile().values, { MATCH_DAYS: '6', POLL_SECONDS: '900' });
  await assert.rejects(settings.undoSettings(form({ ...out.undo.fields, mac: 'x' })), /isn't valid/);
  assert.equal(readFile().values.MATCH_DAYS, '6');
  assert.equal(await settings.undoSettings(form(out.undo.fields)), 'Restored the earlier settings.');
  assert.deepEqual(readFile().values, { MATCH_DAYS: '5' });
  assert.match(await settings.undoSettings(form(out.undo.fields)), /expired/, 'a second use does nothing');
  assert.deepEqual(readFile().values, { MATCH_DAYS: '5' });
});

test('"Use the .env value" drops one override, with Undo; "Reset all" needs the box, and has Undo', async () => {
  await settings.saveSettings(form({ MATCH_DAYS: '6', POLL_SECONDS: '900' }), {});
  const out = {};
  assert.match(await settings.resetSetting(form({ reset: 'MATCH_DAYS' }), out), /uses the \.env value again/);
  assert.deepEqual(readFile().values, { POLL_SECONDS: '900' });
  await settings.undoSettings(form(out.undo.fields));
  assert.deepEqual(readFile().values, { MATCH_DAYS: '6', POLL_SECONDS: '900' });
  assert.match(await settings.resetSetting(form({ reset: 'HISTORY_DAYS' }), {}), /already uses/);
  await assert.rejects(settings.resetAllSettings(form({}), {}), /Tick the box/);
  const out2 = {};
  await settings.resetAllSettings(form({ confirm: 'yes' }), out2);
  assert.equal(fs.existsSync(file), false);
  await settings.undoSettings(form(out2.undo.fields));
  assert.deepEqual(readFile().values, { MATCH_DAYS: '6', POLL_SECONDS: '900' });
});

test('a damaged file: saving is refused, the page says so, and "Reset all to .env" replaces it', async () => {
  fs.writeFileSync(file, '{broken');
  await assert.rejects(settings.saveSettings(form({ MATCH_DAYS: '6' }), {}), (e) => e instanceof actions.PanelError && /damaged/.test(e.message));
  await assert.rejects(settings.resetSetting(form({ reset: 'MATCH_DAYS' }), {}), /damaged/);
  await assert.rejects(actions.categoriesData() && settings.excludeCategory(form({ kind: 'group', group: 'G' }), {}), actions.PanelError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken', 'untouched');
  assert.equal(settings.settingsData().damaged !== null, true);
  const out = {};
  assert.match(await settings.resetAllSettings(form({}), out), /replaced/);
  assert.equal(out.undo, undefined, 'a damaged file has nothing to restore');
  assert.equal(fs.existsSync(file), false);
  assert.match(await settings.saveSettings(form({ MATCH_DAYS: '6' }), {}), /^Saved/);
});

// ---- connection tests before saving a Connections field ----

const okLogin = () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', data: { token: 'tok' } }) });
const refusedLogin = () => ({ ok: false, status: 400, json: async () => ({ status: 'error', reason: 'invalid-password' }) });
const NEWPW = 'new-secret-pw-8841';

test('Actual: the login is tried over HTTP with the candidate address and password; a refusal saves nothing unless "save anyway"', async () => {
  const calls = [];
  settings.testDeps.fetchFn = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return refusedLogin();
  };
  await assert.rejects(settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), (e) => /refused that password/.test(e.message) && /Nothing was saved/.test(e.message) && /Save even if the connection test fails/.test(e.message) && !e.message.includes(NEWPW));
  assert.deepEqual(calls, [['http://actual.invalid/account/login', { loginMethod: 'password', password: NEWPW }]]);
  assert.equal(fs.existsSync(file), false);
  assert.match(await settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW, anyway: 'yes' }), {}), /^Saved/);
  assert.equal(readFile().values.ACTUAL_PASSWORD, NEWPW);
  assert.equal(calls.length, 1, '"save anyway" does not test');
});

test('Actual: a good login saves (and the test session is logged out); a new address is tried with the password typed for it; a network failure never quotes the password', async () => {
  const urls = [];
  const bodies = [];
  settings.testDeps.fetchFn = async (url, init) => (urls.push(url), bodies.push(JSON.parse(init.body)), okLogin());
  assert.match(await settings.saveSettings(form({ ACTUAL_SERVER_URL: 'actual.example.org/', ACTUAL_PASSWORD: NEWPW }), {}), /^Saved/);
  assert.deepEqual(urls, ['https://actual.example.org/account/login', 'https://actual.example.org/account/logout'], 'the address got https:// like siteUrl does');
  assert.deepEqual(bodies, [{ loginMethod: 'password', password: NEWPW }, { token: 'tok' }]);
  fs.rmSync(file);
  settings.testDeps.fetchFn = async () => {
    throw new Error(`connect ECONNREFUSED while sending ${NEWPW}`);
  };
  await assert.rejects(settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), (e) => /Couldn't reach the Actual server/.test(e.message) && !e.message.includes(NEWPW));
  settings.testDeps.fetchFn = async () => ({ ok: false, status: 404, json: async () => { throw new Error('not json'); } });
  await assert.rejects(settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), /doesn't look like an Actual server/);
  settings.testDeps.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', data: { token: null } }) });
  await assert.rejects(settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), /refused that password/);
  assert.equal(fs.existsSync(file), false);
});

test('Nextcloud: the inbox is listed with a client of its own made from the candidate values', async () => {
  const made = [];
  const listed = [];
  settings.testDeps.createClientFn = (url, opts) => {
    made.push([url, opts]);
    return { getDirectoryContents: async (folder) => (listed.push(folder), []) };
  };
  assert.match(await settings.saveSettings(form({ NEXTCLOUD_URL: 'https://cloud.example.org', NEXTCLOUD_USER: 'ann', NEXTCLOUD_APP_PASSWORD: NEWPW, RECEIPTS_INBOX: '/Scans' }), {}), /^Saved/);
  assert.deepEqual(made, [['https://cloud.example.org/remote.php/dav/files/ann', { username: 'ann', password: NEWPW }]]);
  assert.deepEqual(listed, ['/Scans']);
  fs.rmSync(file);

  settings.testDeps.createClientFn = () => ({ getDirectoryContents: async () => { throw Object.assign(new Error(`Invalid response: 401 for ${NEWPW}`), { status: 401 }); } });
  await assert.rejects(settings.saveSettings(form({ NEXTCLOUD_APP_PASSWORD: NEWPW }), {}), (e) => /refused that user name or app password/.test(e.message) && !e.message.includes(NEWPW));
  settings.testDeps.createClientFn = () => ({ getDirectoryContents: async () => { throw Object.assign(new Error('x'), { status: 404 }); } });
  await assert.rejects(settings.saveSettings(form({ RECEIPTS_INBOX: '/Nope' }), {}), /no folder \/Nope/);
  settings.testDeps.createClientFn = () => ({ getDirectoryContents: async () => { throw new Error(`getaddrinfo ENOTFOUND ${NEWPW}`); } });
  await assert.rejects(settings.saveSettings(form({ NEXTCLOUD_URL: 'https://gone.example.org', NEXTCLOUD_APP_PASSWORD: NEWPW }), {}), (e) => /Couldn't reach Nextcloud/.test(e.message) && !e.message.includes(NEWPW));
  assert.equal(fs.existsSync(file), false);
  assert.match(await settings.saveSettings(form({ RECEIPTS_INBOX: '/Nope', anyway: 'yes' }), {}), /^Saved/);
});

test('the sync ID is checked for its form only; other settings and the processed/review folders run no connection test', async () => {
  let network = 0;
  settings.testDeps.fetchFn = async () => (network++, okLogin());
  settings.testDeps.createClientFn = () => (network++, { getDirectoryContents: async () => [] });
  await assert.rejects(settings.saveSettings(form({ ACTUAL_SYNC_ID: 'nonsense' }), {}), /looks like/);
  await settings.saveSettings(form({ ACTUAL_SYNC_ID: '1a2b3c4d-1234-5678-9abc-def012345678', MATCH_DAYS: '5', RECEIPTS_PROCESSED: '/Done', RECEIPTS_REVIEW: '/Look' }), {});
  assert.equal(network, 0);
  assert.equal(readFile().values.ACTUAL_SYNC_ID, '1a2b3c4d-1234-5678-9abc-def012345678');
});

test('an empty password box keeps the current password', async () => {
  settings.testDeps.fetchFn = async () => assert.fail('no test: nothing changed');
  assert.match(await settings.saveSettings(form({ ACTUAL_PASSWORD: '', NEXTCLOUD_APP_PASSWORD: '', ACTUAL_E2E_PASSWORD: '' }), {}), /Nothing was different/);
  assert.equal(fs.existsSync(file), false);
});

// ---- Categories: exclude, include, undo ----

const HOSTILE = '<b>"x"</b>';
const CATS = [
  { group: 'Daily Expenses', label: 'Daily Expenses / Sam' },
  { group: 'Daily Expenses', label: 'Daily Expenses / Child' },
  { group: 'Bills', label: 'Bills / Rent' },
  { group: 'Bills', label: 'Bills / Power' },
  { group: 'Fun', label: `Fun / ${HOSTILE}` },
];
async function categorySetup() {
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'Daily Expenses / Sam': 'Sam\'s things', 'Bills / Power': { description: 'electricity', auto: true } }));
  await rememberCategories(CATS);
}

test('the Categories data lists every spending category from Actual, with an empty description for those without one', async () => {
  await categorySetup();
  const d = actions.categoriesData();
  assert.deepEqual(d.groups.map((g) => g.name), ['Daily Expenses', 'Bills', 'Fun']);
  const child = d.groups[0].categories.find((c) => c.label === 'Daily Expenses / Child');
  assert.deepEqual(child, { label: 'Daily Expenses / Child', description: '', draft: false });
  assert.equal(d.groups[1].categories.find((c) => c.label === 'Bills / Power').draft, true);
  assert.deepEqual(d.excluded, { groups: [], categories: [] });
});

test('before the first check the list falls back to the notes file; a description can be saved for a category that has none (and undone)', async () => {
  const usual = config.categoryNotesPath;
  fs.mkdirSync(path.join(dir, 'fresh'));
  config.categoryNotesPath = path.join(dir, 'fresh', 'category-notes.json'); // a folder with no known-categories.json yet
  fs.writeFileSync(config.categoryNotesPath, JSON.stringify({ 'A / B / C': 'x' }));
  assert.deepEqual(actions.categoriesData().groups.map((g) => g.name), ['A / B'], 'a group name may contain " / ": the last one splits');
  config.categoryNotesPath = usual;
  await categorySetup();
  const out = {};
  await actions.saveCategory(form({ label: 'Daily Expenses / Child', description: 'Baby food' }), out);
  assert.equal(loadCategoryNotes()['Daily Expenses / Child'].description, 'Baby food');
  assert.equal(loadCategoryNotes()['Daily Expenses / Child'].auto, false);
  await actions.undoCategory(form(out.undo.fields));
  assert.equal(actions.categoriesData().groups[0].categories.find((c) => c.label === 'Daily Expenses / Child').description, '');
  await assert.rejects(actions.saveCategory(form({ label: 'Not / There', description: 'x' }), {}), actions.PanelError);
});

test('Exclude group / Exclude / Include again write the exclusion lists on top of their effective value, with Undo', async () => {
  await categorySetup();
  process.env.EXCLUDE_CATEGORY_GROUPS = 'Old Group';
  reload(); // the worker's config has .env's value, as it does after a start
  try {
    let out = {};
    assert.match(await settings.excludeCategory(form({ kind: 'group', group: 'Bills' }), out), /Excluded the group "Bills"/);
    assert.equal(readFile().values.EXCLUDE_CATEGORY_GROUPS, 'Old Group,Bills', 'starts from .env\'s value');
    const d = actions.categoriesData();
    assert.deepEqual(d.groups.map((g) => g.name), ['Daily Expenses', 'Fun']);
    assert.deepEqual(d.excluded.groups.map((g) => [g.name, g.labels.length]), [['Old Group', 0], ['Bills', 2]]);
    assert.deepEqual(actions.listCategories().map((c) => c.label), ['Daily Expenses / Sam'], 'the keywords list follows at once too');
    await actions.saveCategory(form({ label: 'Daily Expenses / Sam', description: 'still fine' }), {});
    await assert.rejects(actions.saveCategory(form({ label: 'Bills / Rent', description: 'x' }), {}), /isn't in the list/);

    await settings.excludeCategory(form({ kind: 'category', label: 'Daily Expenses / Child' }), {});
    assert.equal(readFile().values.EXCLUDE_CATEGORIES, 'Daily Expenses / Child');
    assert.deepEqual(actions.categoriesData().excluded.categories, [{ label: 'Daily Expenses / Child' }]);

    // Undo the group exclusion: back to .env's value (the override goes away).
    await settings.undoExclude(form(out.undo.fields));
    assert.equal(readFile().values.EXCLUDE_CATEGORY_GROUPS, undefined);
    assert.deepEqual(actions.categoriesData().groups.map((g) => g.name), ['Daily Expenses', 'Bills', 'Fun']);

    out = {};
    assert.match(await settings.includeCategory(form({ kind: 'group', group: 'Old Group' }), out), /Included the group "Old Group" again/);
    assert.equal(readFile().values.EXCLUDE_CATEGORY_GROUPS, '', '.env still names it, so the empty list is saved over it');
    assert.deepEqual(actions.categoriesData().excluded.groups, []);
    await settings.undoExclude(form(out.undo.fields));
    assert.equal(readFile().values.EXCLUDE_CATEGORY_GROUPS, undefined);

    await settings.includeCategory(form({ kind: 'category', label: 'Daily Expenses / Child' }), {});
    assert.deepEqual(actions.categoriesData().excluded.categories, []);
  } finally {
    delete process.env.EXCLUDE_CATEGORY_GROUPS;
    fs.rmSync(file, { force: true });
    reload();
  }
});

test('excluding refuses an unknown or comma-named category, and including something not excluded', async () => {
  await categorySetup();
  await assert.rejects(settings.excludeCategory(form({ kind: 'group', group: 'Nope' }), {}), /isn't in the list/);
  await assert.rejects(settings.excludeCategory(form({ kind: 'category', label: 'Nope / Nothing' }), {}), /isn't in the list/);
  await assert.rejects(settings.excludeCategory(form({ kind: 'weird', group: 'Bills' }), {}), /Unknown kind/);
  await assert.rejects(settings.excludeCategory(form({ kind: 'group', group: 'A,B' }), {}), /comma/);
  await assert.rejects(settings.includeCategory(form({ kind: 'group', group: 'Bills' }), {}), /isn't excluded/);
  assert.equal(fs.existsSync(file), false);
});

// ---- the pages ----

let server;
let base;
test.before(async () => {
  server = makeServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const call = (method, p, body) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}key=secret`, { method, body: body && new URLSearchParams(body), redirect: 'manual' });
const noticeOf = (res) => new URL(res.headers.get('location'), base).searchParams.get('notice');

test('the Settings tab: needs the key, has one form per section, the help, the source of each value and a reset only where the page set it', async () => {
  assert.equal((await fetch(`${base}/settings`)).status, 403);
  assert.equal((await fetch(`${base}/settings?key=nope`)).status, 403);
  for (const p of ['/settings-save', '/settings-reset', '/settings-reset-all', '/category-exclude', '/category-include', '/undo-settings', '/undo-exclude']) {
    assert.equal((await fetch(`${base}${p}`, { method: 'POST', body: new URLSearchParams({ MATCH_DAYS: '9' }) })).status, 403, p);
  }
  assert.equal(fs.existsSync(file), false);
  await settings.saveSettings(form({ MATCH_DAYS: '6' }), {});
  const html = await (await call('GET', '/settings')).text();
  assert.match(html, /class="on">Settings<\/a>/);
  const mainSections = SECTIONS.filter((sec) => SETTINGS.some((s) => s.section === sec.id && !s.advanced));
  for (const s of mainSections) assert.ok(html.includes(`<h2>${s.title}</h2>`), s.title);
  assert.equal((html.match(/<form method="post" action="settings-save\?key=secret"/g) ?? []).length, mainSections.length + 1, 'one per main section, plus the Advanced one');
  assert.match(html, /name="MATCH_DAYS" id="s-MATCH_DAYS" value="6"/);
  assert.match(html, /A bank charge can post a few days after the purchase/);
  assert.match(html, /<option value="mixed" selected>mixed<\/option>/);
  assert.match(html, /type="checkbox" name="SPLIT_TRANSACTIONS" id="s-SPLIT_TRANSACTIONS" value="true" checked/);
  assert.match(html, /type="password" name="ACTUAL_PASSWORD"[^>]*value=""/);
  assert.match(html, /from this page/);
  assert.match(html, /from \.env/);
  assert.match(html, /from default/);
  assert.equal((html.match(/>Use the \.env value<\/button>/g) ?? []).length, 1, 'only MATCH_DAYS is set on the page');
  assert.match(html, /name="reset" value="MATCH_DAYS" formaction="settings-reset\?key=secret"/);
  assert.match(html, /Save even if the connection test fails/);
  assert.match(html, /Set in \.env only/);
  assert.ok(!html.includes('name="TRIGGER_TOKEN"') && !html.includes('name="DRY_RUN"'));
  assert.match(html, /Reset all to \.env/);
  await settings.resetAllSettings(form({ confirm: 'yes' }), {});
});

test('POST /settings-save: a 303 back to the page with the notice and an Undo; a key outside the schema is refused', async () => {
  const res = await call('POST', '/settings-save', { section: 'behaviour', POLL_SECONDS: '600' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^\.\/settings\?key=secret&notice=/);
  assert.equal(noticeOf(res), 'Saved. It applies at the start of the next check.');
  const page = await (await fetch(new URL(res.headers.get('location'), base))).text();
  assert.match(page, /action="undo-settings\?key=secret"/);
  assert.equal(readFile().values.POLL_SECONDS, '600');
  const bad = await call('POST', '/settings-save', { POLL_SECONDS: '700', TRIGGER_TOKEN: 'x' });
  assert.match(noticeOf(bad), /TRIGGER_TOKEN: That setting can only be changed in \.env/);
  assert.equal(readFile().values.POLL_SECONDS, '600');
  assert.match(noticeOf(await call('POST', '/settings-save', { POLL_SECONDS: '5' })), /between 60 and 3600/);
  assert.match(noticeOf(await call('POST', '/settings-reset', { reset: 'DRY_RUN' })), /only be changed in \.env/);
  assert.match(noticeOf(await call('POST', '/settings-reset', { reset: 'POLL_SECONDS' })), /uses the \.env value again/);
  assert.equal(fs.existsSync(file), false);
});

test('the status page shows a failed reload and a damaged file', async () => {
  writeFile({ MATCH_DAYS: 'abc' });
  reload();
  let html = await (await call('GET', '/')).text();
  assert.match(html, /The settings were not reloaded/);
  assert.match(html, /MATCH_DAYS must be a number/);
  assert.match(await (await call('GET', '/settings')).text(), /The last settings reload failed/);
  fs.writeFileSync(file, '{broken');
  reload();
  html = await (await call('GET', '/')).text();
  assert.match(html, /The settings file is damaged/);
  const page = await (await call('GET', '/settings')).text();
  assert.match(page, /action="settings-reset-all\?key=secret"/);
  fs.rmSync(file);
  reload();
  assert.ok(!(await (await call('GET', '/')).text()).includes('not reloaded'));
});

test('the Categories tab has Exclude buttons, an Excluded section with Include again, and escapes names', async () => {
  await categorySetup();
  let html = await (await call('GET', '/categories')).text();
  assert.match(html, /Exclude group<\/button>/);
  assert.equal((html.match(/formaction="category-exclude\?key=secret" name="kind" value="category" formnovalidate>Exclude<\/button>/g) ?? []).length, 5);
  assert.match(html, /no description yet/);
  assert.ok(!html.includes(HOSTILE));
  assert.match(html, /Nothing is excluded/);
  const res = await call('POST', '/category-exclude', { kind: 'group', group: 'Bills' });
  assert.match(res.headers.get('location'), /^\.\/categories\?key=secret&notice=/);
  const after = await (await fetch(new URL(res.headers.get('location'), base))).text();
  assert.match(after, /action="undo-exclude\?key=secret"/);
  assert.match(after, /<b>Bills<\/b> <span class="muted small">\(whole group, 2 categories\)/);
  assert.match(after, /Include again/);
  assert.ok(!/Bills \/ Rent<\/strong>/.test(after), 'excluded categories leave the list');
  await call('POST', '/category-include', { kind: 'group', group: 'Bills' });
  assert.equal(fs.existsSync(file) ? readFile().values.EXCLUDE_CATEGORY_GROUPS : '', '');
  html = await (await call('GET', '/categories')).text();
  assert.match(html, /Nothing is excluded/);
  fs.rmSync(file, { force: true });
});

test('the page script hides a group heading when none of its rows shows', async () => {
  const { SCRIPT } = await import('./panel-script.js');
  assert.match(SCRIPT, /data-group/);
});

// ---- the worker side ----

test('the worker reloads its config at the start of every check, before it reads the mode or lists the folders', () => {
  const src = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const loop = src.slice(src.indexOf('while (!stopping)'));
  assert.ok(loop.indexOf('reloadConfig()') > 0 && loop.indexOf('reloadConfig()') < loop.indexOf('refreshMode()') && loop.indexOf('refreshMode()') < loop.indexOf('ensureFolders'));
});

test('the upgrade watcher follows a changed ACTUAL_SERVER_URL', async () => {
  let url = 'http://one.invalid';
  const seen = [];
  const w = createUpgradeWatcher({ setting: 'auto', serverURL: () => url, usingVersion: '26.8.0', dir: path.join(dir, 'api'), fetchFn: async (u) => (seen.push(u), '26.8.0'), everyMs: 0 });
  await w.check();
  url = 'http://two.invalid';
  await w.check();
  assert.deepEqual(seen, ['http://one.invalid', 'http://two.invalid']);
});

test('keyedClient makes a new client only when its parts change', () => {
  let made = 0;
  const get = keyedClient((...parts) => ({ parts, n: ++made }));
  const a = get('https://x', 'u', 'p');
  assert.equal(get('https://x', 'u', 'p'), a);
  const b = get('https://x', 'u', 'p2');
  assert.notEqual(b, a);
  assert.equal(b.parts[2], 'p2');
  assert.equal(get('https://x', 'u', 'p2'), b);
  assert.equal(made, 2);
});

test('nextcloud.js makes its WebDAV client from the current config and again when the address, user or password change', () => {
  // A stand-in 'webdav' package (this works with or without the real one installed), loaded through a module hook.
  const hook = `export function resolve(s, c, next) { return s === 'webdav' ? { url: 'data:text/javascript,export const createClient=(...a)=>({made:a});', shortCircuit: true } : next(s, c); }`;
  const script = `
    import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}));
    const { config } = await import('./config.js');
    const { davClient } = await import('./nextcloud.js');
    const a = davClient();
    const same = davClient() === a;
    config.nextcloud.url = 'https://new.example.org';
    const b = davClient();
    config.nextcloud.user = 'ann';
    const c = davClient();
    config.nextcloud.password = 'pw2';
    const d = davClient();
    console.log(JSON.stringify({ same, a: a.made, b: b.made, c: c.made, d: d.made, distinct: new Set([a, b, c, d]).size }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: SRC, env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.same, true);
  assert.equal(out.distinct, 4);
  assert.deepEqual(out.a, ['http://nextcloud.invalid/remote.php/dav/files/test', { username: 'test', password: 'test' }]);
  assert.equal(out.b[0], 'https://new.example.org/remote.php/dav/files/test');
  assert.equal(out.c[0], 'https://new.example.org/remote.php/dav/files/ann');
  assert.deepEqual(out.d[1], { username: 'ann', password: 'pw2' });
});

test('web-settings-cli unset removes keys from the file (what ./receipts exclude calls), and refuses other keys', () => {
  writeFile({ EXCLUDE_CATEGORY_GROUPS: 'Bills', EXCLUDE_CATEGORIES: 'A / B', MATCH_DAYS: '6' });
  const run = (...args) => spawnSync(process.execPath, ['--env-file=test.env', 'src/web-settings-cli.js', ...args], { cwd: path.join(SRC, '..'), env: process.env, encoding: 'utf8' });
  let r = run('unset', 'EXCLUDE_CATEGORY_GROUPS', 'EXCLUDE_CATEGORIES', 'HISTORY_DAYS');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'unset EXCLUDE_CATEGORY_GROUPS\nunset EXCLUDE_CATEGORIES\n');
  assert.deepEqual(readFile().values, { MATCH_DAYS: '6' });
  r = run('unset', 'MATCH_DAYS');
  assert.equal(fs.existsSync(file), false, 'the last key removed: the file goes');
  assert.equal(run('unset', 'TRIGGER_TOKEN').status, 2);
  assert.equal(run('unset').status, 2);
  assert.equal(run('frobnicate', 'MATCH_DAYS').status, 2);
  fs.writeFileSync(file, '{broken');
  assert.equal(run('unset', 'MATCH_DAYS').status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

// ---- ./receipts ----

test('./receipts: an exclude written to .env also clears the page\'s override, and status mentions the file', () => {
  const script = fs.readFileSync(path.join(SRC, '..', '..', 'receipts'), 'utf8');
  const start = script.indexOf('unset_web_override() {');
  assert.ok(start > 0);
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.match(script, /unset_web_override "\$\{written\[@\]\}"/);
  assert.match(script, /echo "Some settings are set on the status page \(Settings tab\); they win over \.env\."/);
  const work = path.join(dir, 'bash');
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });
  const run = () => spawnSync('bash', ['-c', `say() { printf '%s\\n' "$*"; }\nwarn() { printf 'WARN %s\\n' "$*"; }\nONE_OFF=(bash -c 'for k in "\${@:4}"; do echo "unset $k"; done' --)\n${fn}\nunset_web_override EXCLUDE_CATEGORIES`], { cwd: work, encoding: 'utf8' });
  assert.equal(run().stdout, '', 'no file: nothing is run');
  fs.writeFileSync(path.join(work, 'data', 'web-settings.json'), '');
  assert.equal(run().stdout, '', 'an empty file: nothing is run');
  fs.writeFileSync(path.join(work, 'data', 'web-settings.json'), '{"values":{"EXCLUDE_CATEGORIES":"x"}}');
  assert.match(run().stdout, /Also removed EXCLUDE_CATEGORIES from the settings saved on the status page/);
});

// ---- review fixes ----

test('OpenID servers are reported, not tested; a failing logout is ignored', async () => {
  settings.testDeps.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', data: { returnUrl: 'https://idp.example/auth' } }) });
  await assert.rejects(settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), /uses OpenID login, so the password can't be tested here/);
  settings.testDeps.fetchFn = async (url) => {
    if (url.endsWith('/logout')) throw new Error('boom');
    return okLogin();
  };
  assert.match(await settings.saveSettings(form({ ACTUAL_PASSWORD: NEWPW }), {}), /^Saved/);
});

const RETYPE = /Type the password again when you change the address\./;

test('a new address needs its password typed in the same request; nothing is sent to it first', async () => {
  let network = 0;
  settings.testDeps.fetchFn = async () => (network++, okLogin());
  settings.testDeps.createClientFn = () => (network++, { getDirectoryContents: async () => [] });
  await assert.rejects(settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://evil.example' }), {}), RETYPE);
  await assert.rejects(settings.saveSettings(form({ NEXTCLOUD_URL: 'https://evil.example', ACTUAL_PASSWORD: NEWPW }), {}), RETYPE, 'the paired password, not another');
  await assert.rejects(settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://evil.example', anyway: 'yes' }), {}), RETYPE, 'also with save anyway');
  assert.equal(network, 0);
  assert.equal(fs.existsSync(file), false);
  // allowed: typed together, and the same password retyped
  assert.match(await settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://good.example', ACTUAL_PASSWORD: 'test' }), {}), /^Saved/);
  assert.equal(readFile().values.ACTUAL_PASSWORD, 'test', 'retyping the .env password is accepted and saved with the address');
  assert.match(await settings.saveSettings(form({ NEXTCLOUD_URL: 'https://nc.example', NEXTCLOUD_APP_PASSWORD: NEWPW }), {}), /^Saved/);
});

test('with an optional encryption password set, it must be retyped with a new address too', async () => {
  process.env.ACTUAL_E2E_PASSWORD = 'e2e-from-env';
  settings.testDeps.fetchFn = async () => okLogin();
  try {
    await assert.rejects(settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://x.example', ACTUAL_PASSWORD: NEWPW }), {}), RETYPE);
    assert.match(await settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://x.example', ACTUAL_PASSWORD: NEWPW, ACTUAL_E2E_PASSWORD: 'e2e-new' }), {}), /^Saved/);
  } finally {
    delete process.env.ACTUAL_E2E_PASSWORD;
  }
});

test('"Use the .env value" on a password is refused while the address is not .env\'s; resetting both, or everything, works', async () => {
  settings.testDeps.fetchFn = async () => okLogin();
  await settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://evil.example', ACTUAL_PASSWORD: NEWPW }), {});
  await assert.rejects(settings.resetSetting(form({ reset: 'ACTUAL_PASSWORD' }), {}), RETYPE);
  assert.equal(readFile().values.ACTUAL_PASSWORD, NEWPW);
  // the address back to .env's is fine whatever the password override is (it goes to .env's own host)
  await settings.resetSetting(form({ reset: 'ACTUAL_SERVER_URL' }), {});
  await settings.resetSetting(form({ reset: 'ACTUAL_PASSWORD' }), {});
  assert.equal(fs.existsSync(file), false);
  await settings.saveSettings(form({ ACTUAL_SERVER_URL: 'https://evil.example', ACTUAL_PASSWORD: NEWPW }), {});
  assert.match(await settings.resetAllSettings(form({ confirm: 'yes' }), {}), /^Every setting/);
  assert.equal(fs.existsSync(file), false);
});

test('the file layer enforces it too: Undo and direct writes cannot send the .env password to a new address', async () => {
  await store.changeOverrides({ ACTUAL_SERVER_URL: 'https://evil.example', ACTUAL_PASSWORD: NEWPW }, { typed: ['ACTUAL_PASSWORD'] });
  await assert.rejects(store.changeOverrides({ ACTUAL_PASSWORD: null }), RETYPE);
  await assert.rejects(store.changeOverrides({ NEXTCLOUD_URL: 'https://evil.example' }), RETYPE);
  await assert.rejects(store.restoreOverrides({ ACTUAL_PASSWORD: null }, { ACTUAL_PASSWORD: NEWPW }), RETYPE, 'Undo may not drop the password while the address stays');
  assert.deepEqual(readFile().values, { ACTUAL_SERVER_URL: 'https://evil.example', ACTUAL_PASSWORD: NEWPW });
});

test('a .env value the page would not accept does not block saving the rest of its section', async () => {
  process.env.POLL_SECONDS = '7200';
  process.env.RECEIPTS_INBOX = 'Receipts/Inbox';
  try {
    const msg = await settings.saveSettings(form({ POLL_SECONDS: '7200', RECEIPTS_INBOX: 'Receipts/Inbox', MATCH_DAYS: '9' }), {});
    assert.match(msg, /^Saved/);
    assert.deepEqual(readFile().values, { MATCH_DAYS: '9' });
    await assert.rejects(settings.saveSettings(form({ POLL_SECONDS: '7201' }), {}), /between 60 and 3600/, 'a changed field is still checked');
  } finally {
    delete process.env.POLL_SECONDS;
    delete process.env.RECEIPTS_INBOX;
  }
});

test('Undo puts back only keys that still hold what the change wrote; two exclusions in a row', async () => {
  await categorySetup();
  const first = {};
  await settings.excludeCategory(form({ kind: 'category', label: 'Daily Expenses / Sam' }), first);
  const second = {};
  await settings.excludeCategory(form({ kind: 'category', label: 'Daily Expenses / Child' }), second);
  assert.equal(readFile().values.EXCLUDE_CATEGORIES, 'Daily Expenses / Sam,Daily Expenses / Child');
  assert.match(await settings.undoExclude(form(first.undo.fields)), /Excluded categories has changed since, so it was not put back\./);
  assert.equal(readFile().values.EXCLUDE_CATEGORIES, 'Daily Expenses / Sam,Daily Expenses / Child', 'the second exclusion survives');
  assert.equal(await settings.undoExclude(form(second.undo.fields)), 'Restored the earlier settings.');
  assert.equal(readFile().values.EXCLUDE_CATEGORIES, 'Daily Expenses / Sam');

  const a = {};
  await settings.saveSettings(form({ MATCH_DAYS: '6', POLL_SECONDS: '900' }), a);
  await settings.saveSettings(form({ POLL_SECONDS: '1000' }), {});
  const msg = await settings.undoSettings(form(a.undo.fields));
  assert.match(msg, /^Restored the earlier settings, except: Seconds between checks has changed since/);
  assert.equal(readFile().values.POLL_SECONDS, '1000');
  assert.equal(readFile().values.MATCH_DAYS, undefined);
});

test('Undo of a reset-all restores per key, and leaves keys set since', async () => {
  await settings.saveSettings(form({ MATCH_DAYS: '6', POLL_SECONDS: '900' }), {});
  const out = {};
  await settings.resetAllSettings(form({ confirm: 'yes' }), out);
  await settings.saveSettings(form({ POLL_SECONDS: '1200' }), {});
  const msg = await settings.undoSettings(form(out.undo.fields));
  assert.match(msg, /except: Seconds between checks has changed since/);
  assert.deepEqual(readFile().values, { POLL_SECONDS: '1200', MATCH_DAYS: '6' });
});

test('web-settings-cli get prints effective values (page first, then .env) as tagged lines, and refuses secrets and unknown keys', () => {
  writeFile({ EXCLUDE_CATEGORIES: 'A / B' });
  const run = (...args) => spawnSync(process.execPath, ['--env-file=test.env', 'src/web-settings-cli.js', ...args], { cwd: path.join(SRC, '..'), env: { ...process.env, EXCLUDE_CATEGORY_GROUPS: 'Bills' }, encoding: 'utf8' });
  const r = run('get', 'EXCLUDE_CATEGORY_GROUPS', 'EXCLUDE_CATEGORIES', 'HISTORY_DAYS');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'value\tEXCLUDE_CATEGORY_GROUPS\tBills\nvalue\tEXCLUDE_CATEGORIES\tA / B\nvalue\tHISTORY_DAYS\t365\n');
  for (const key of ['ACTUAL_PASSWORD', 'TRIGGER_TOKEN']) {
    const bad = run('get', key);
    assert.equal(bad.status, 2, key);
    assert.equal(bad.stdout, '');
  }
});

test('./receipts exclude reads the effective exclusions through the worker image, and falls back to .env', () => {
  const script = fs.readFileSync(path.join(SRC, '..', '..', 'receipts'), 'utf8');
  const start = script.indexOf('effective_excludes() {');
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
  assert.match(script, /^\s+effective_excludes$/m);
  assert.match(script, /csv_items "\$EFF_GROUPS"/);
  const fake = path.join(dir, 'fake-one-off.sh');
  fs.writeFileSync(fake, "printf 'value\\tEXCLUDE_CATEGORY_GROUPS\\tG1,G2\\nvalue\\tEXCLUDE_CATEGORIES\\t\\nnoise\\n'\n");
  const run = (oneOff) => spawnSync('bash', ['-c', `env_get() { echo "env-$1"; }\nONE_OFF=(${oneOff})\n${fn}\neffective_excludes\necho "[$EFF_GROUPS|$EFF_SINGLES]"`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(run(`bash ${fake}`), '[G1,G2|]');
  assert.equal(run('false'), '[env-EXCLUDE_CATEGORY_GROUPS|env-EXCLUDE_CATEGORIES]', 'the call failed: .env');
});

test('MATCH_NO_DATE_EXTENDED_DAYS: refused unless it is past the recent days and within the look-back; .env conflicts turn it off', () => {
  const none = { values: {} };
  assert.throws(() => store.checkChanges({ MATCH_NO_DATE_EXTENDED_DAYS: '14' }, none), /must be greater than MATCH_NO_DATE_RECENT_DAYS/);
  assert.throws(() => store.checkChanges({ MATCH_NO_DATE_EXTENDED_DAYS: '400' }, none), /can't be more than MATCH_NO_DATE_LOOKBACK_DAYS/);
  assert.throws(() => store.checkChanges({ MATCH_NO_DATE_RECENT_DAYS: '200' }, none), /must be greater than MATCH_NO_DATE_RECENT_DAYS/);
  assert.doesNotThrow(() => store.checkChanges({ MATCH_NO_DATE_EXTENDED_DAYS: '0' }, none));
  assert.doesNotThrow(() => store.checkChanges({ MATCH_NO_DATE_EXTENDED_DAYS: '90' }, none));
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    const c = buildConfig({ ...process.env, MATCH_NO_DATE_EXTENDED_DAYS: '10', MATCH_NO_DATE_RECENT_DAYS: '14' });
    assert.equal(c.match.noDateExtendedDays, 0);
    buildConfig({ ...process.env, MATCH_NO_DATE_EXTENDED_DAYS: '10', MATCH_NO_DATE_RECENT_DAYS: '14' });
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.filter((w) => /older-charge match is off/.test(w)).length, 1, 'warned once');
  assert.equal(buildConfig({ ...process.env, MATCH_NO_DATE_EXTENDED_DAYS: '90' }).match.noDateExtendedDays, 90);
});

// ---- Main / Advanced ----

test('every schema key is in exactly one place: the main forms or the Advanced section', async () => {
  const html = await (await call('GET', '/settings')).text();
  const at = html.indexOf('<details class="how" id="advanced"');
  assert.ok(at > 0, 'the Advanced section exists');
  const end = html.indexOf('</details>', at);
  const main = html.slice(0, at) + html.slice(end);
  const adv = html.slice(at, end);
  const named = (part, key) => part.includes(`id="s-${key}"`);
  for (const s of SETTINGS) {
    assert.equal(named(adv, s.key), Boolean(s.advanced), `${s.key} in Advanced`);
    assert.equal(named(main, s.key), !s.advanced, `${s.key} in main`);
  }
  assert.ok(SETTINGS.filter((s) => s.section === 'connections').every((s) => !s.advanced), 'all connections are main');
  assert.ok(SETTINGS.filter((s) => !s.advanced && s.section !== 'connections').length <= 10);
  assert.match(adv, /name="section" value="advanced"/);
  assert.doesNotMatch(adv.replace(/<\/?details[^>]*>/g, ''), /<details/);
});

test('Advanced is closed by default and opens when one of its settings is set on the page, or the notice is about one', async () => {
  const { settingsPage } = await import('./panel-pages.js');
  const closed = settingsPage(settings.settingsData(), 'secret');
  assert.match(closed, /<details class="how" id="advanced"><summary>Advanced settings/);
  await settings.saveSettings(form({ MATCH_DAYS: '7' }), {});
  assert.match(settingsPage(settings.settingsData(), 'secret'), /<details class="how" id="advanced" open>/);
  await settings.resetAllSettings(form({ confirm: 'yes' }), {});
  assert.match(settingsPage(settings.settingsData(), 'secret', 'Days the charge may post after the receipt: must be a whole number.'), /id="advanced" open>/);
});

test('saving the main form leaves advanced values alone, and saving Advanced leaves the main ones alone', async () => {
  await settings.saveSettings(form({ section: 'behaviour', POLL_SECONDS: '600' }), {});
  await settings.saveSettings(form({ section: 'advanced', MATCH_DAYS: '9', PAYEE_MIN_SCORE: '0.7' }), {});
  assert.deepEqual(readFile().values, { POLL_SECONDS: '600', MATCH_DAYS: '9', PAYEE_MIN_SCORE: '0.7' });
  await settings.saveSettings(form({ section: 'behaviour', POLL_SECONDS: '900' }), {});
  assert.deepEqual(readFile().values, { POLL_SECONDS: '900', MATCH_DAYS: '9', PAYEE_MIN_SCORE: '0.7' });
  await settings.saveSettings(form({ section: 'advanced', MATCH_DAYS: '5' }), {});
  assert.deepEqual(readFile().values, { POLL_SECONDS: '900', MATCH_DAYS: '5', PAYEE_MIN_SCORE: '0.7' });
  await settings.resetAllSettings(form({ confirm: 'yes' }), {});
});
