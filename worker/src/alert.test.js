// The "worker is paused" notice: logged once per distinct problem, kept in a file for the status page, cleared on success.
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { reportSetupProblem, clearSetupProblem, clearSetupProblemIfQuiet, readSetupProblem, useAlertFile, beginCycle } from './alert.js';
import { DeciderAuthError } from './decider-remote.js';
import { ReaderAuthError } from './llm.js';
import { statusPage } from './panel-pages.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
config.alertPath = path.join(dir, 'worker-alert.json');
useAlertFile(); // as the worker does at startup
afterEach(async () => {
  mock.restoreAll();
  await clearSetupProblem();
});

test('a setup problem is logged once per distinct message, not at every poll, and a new message is logged again', async () => {
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  const err = new DeciderAuthError();
  for (let poll = 0; poll < 5; poll++) await reportSetupProblem(err);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /setup problem: The hosted decider rejected the API key — check DECIDER_API_KEY in \.env and run \.\/receipts restart/);
  await reportSetupProblem(new Error('the remote decider takes at most 255 categories'));
  assert.equal(logs.length, 2);
  await clearSetupProblem();
  await reportSetupProblem(err); // gone and back again: said again
  assert.equal(logs.length, 3);
});

test('the problem is kept for the status page and removed when it clears', async () => {
  mock.method(console, 'log', () => {});
  assert.equal(await readSetupProblem(), null);
  await reportSetupProblem(new DeciderAuthError());
  const a = await readSetupProblem();
  assert.match(a.message, /^The hosted decider rejected the API key/);
  assert.match(a.at, /^\d{4}-/);
  await clearSetupProblem();
  assert.equal(await readSetupProblem(), null);
  fs.writeFileSync(config.alertPath, 'torn');
  assert.equal(await readSetupProblem(), null); // a damaged file is no banner, not a crash
});

test('the status page shows the banner (escaped) and says receipts are not marked failed; without a problem there is none', () => {
  const data = { dryRun: true, pending: null, settings: null, envNote: null, heartbeat: 'now', recent: [], alert: { message: 'The hosted decider rejected the API key — check DECIDER_API_KEY in .env and run ./receipts restart <b>', at: '2026-11-06T10:00:00Z' } };
  const page = statusPage(data, 'k');
  assert.match(page, /<b>The worker is paused<\/b>The hosted decider rejected the API key — check DECIDER_API_KEY in \.env and run \.\/receipts restart &#60;b&#62;/);
  assert.match(page, /none is marked as failed/);
  assert.doesNotMatch(statusPage({ ...data, alert: null }, 'k'), /worker is paused/);
});

test('a notice raised during a cycle survives that cycle\'s end and clears at the end of the next quiet one; a non-pausing notice says so', async () => {
  mock.method(console, 'log', () => {});
  await reportSetupProblem(new Error('the hosted decider refused every item'), { pausing: false });
  await clearSetupProblemIfQuiet(); // the cycle that raised it
  const a = await readSetupProblem();
  assert.equal(a.pausing, false);
  assert.match(statusPage({ dryRun: true, pending: null, settings: null, envNote: null, heartbeat: 'x', recent: [], alert: a }, 'k'), /refusing requests<\/b>The hosted decider refused every item.*marked unsure/);
  await clearSetupProblemIfQuiet(); // a quiet cycle
  assert.equal(await readSetupProblem(), null);
});

test('a pausing problem fixed without a restart clears at the end of the first good check, not one later', async () => {
  mock.method(console, 'log', () => {});
  beginCycle();
  await reportSetupProblem(new Error('the key was refused')); // this check pauses: no clearSetupProblemIfQuiet
  assert.ok(await readSetupProblem());
  beginCycle(); // the next check goes through
  await clearSetupProblemIfQuiet();
  assert.equal(await readSetupProblem(), null);
});

test('without useAlertFile (replay, item-test) a problem is only logged: the worker\'s banner file is left alone', async () => {
  const mod = await import(`./alert.js?oneoff=${Date.now()}`);
  const lines = [];
  mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  fs.writeFileSync(config.alertPath, JSON.stringify({ message: 'The worker\'s own banner', at: 'x' }));
  await mod.reportSetupProblem(new Error('refused every item'), { pausing: false });
  await mod.clearSetupProblem();
  assert.equal(JSON.parse(fs.readFileSync(config.alertPath, 'utf8')).message, 'The worker\'s own banner');
  assert.ok(lines.some((l) => /refused every item/i.test(l)));
});

test('status page: a remote reader shows a notice about photos leaving the machine; a local one shows none', async () => {
  const { config } = await import('./config.js');
  const data = { dryRun: true, pending: null, settings: null, envNote: null, heartbeat: 'x', recent: [], alert: null };
  assert.doesNotMatch(statusPage(data, 'k'), /photos leave this machine/);
  const saved = { ...config.reader };
  const savedName = config.llmName;
  const key = 'sk-proj-FAKE-key-for-tests-0000000000000';
  Object.assign(config.reader, { provider: 'remote', host: 'openrouter.ai', model: 'openai/gpt-4.1-mini', apiKey: key });
  config.llmName = 'openai/gpt-4.1-mini (remote: openrouter.ai)';
  try {
    const page = statusPage(data, 'k');
    assert.match(page, /Receipt photos leave this machine/);
    assert.match(page, /openai\/gpt-4\.1-mini \(remote: openrouter\.ai\)/);
    assert.match(page, /OpenRouter privacy settings/);
    assert.equal(config.reader.apiKey, key, 'the key really is in the config the page was built from');
    assert.ok(!page.includes(key));
    assert.ok(!page.includes('sk-proj'));
    assert.ok(!statusPage({ ...data, alert: { message: new ReaderAuthError(401).message, at: 'x' } }, 'k').includes(key));
  } finally {
    Object.assign(config.reader, saved);
    config.llmName = savedName;
  }
});
