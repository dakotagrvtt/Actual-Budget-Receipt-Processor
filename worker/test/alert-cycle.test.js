// The banner a failed check raises (kind 'cycle') clears at the next check that goes through; other banners do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { reportSetupProblem, clearCycleProblem, clearSetupProblem, readSetupProblem, useAlertFile } from '../src/alert.js';

test('a failed check banner clears on the next good check; a setup banner stays', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alert-cycle-'));
  const saved = config.alertPath;
  config.alertPath = path.join(dir, 'worker-alert.json');
  t.after(async () => { await clearSetupProblem(); config.alertPath = saved; await fs.rm(dir, { recursive: true, force: true }); });
  useAlertFile();
  await reportSetupProblem(new Error('/Inbox: ENOENT'), { kind: 'cycle' });
  assert.equal((await readSetupProblem()).message, '/Inbox: ENOENT');
  assert.equal((await readSetupProblem()).pausing, true);
  await clearCycleProblem();
  assert.equal(await readSetupProblem(), null);
  await reportSetupProblem(new Error('the hosted decider refused the API key'));
  await clearCycleProblem();
  assert.match((await readSetupProblem()).message, /hosted decider/);
  // The same failure again (already shown) keeps its kind: a later good check still clears it.
  await clearSetupProblem();
  await reportSetupProblem(new Error('made-up failure'), { kind: 'cycle' });
  await reportSetupProblem(new Error('made-up failure'), { kind: 'cycle' });
  await clearCycleProblem();
  assert.equal(await readSetupProblem(), null);
  // Raised first without a kind (a storage check from the web app), then the same message failing a check: it clears.
  await reportSetupProblem(new Error('Receipt storage changed (made up)'));
  await reportSetupProblem(new Error('Receipt storage changed (made up)'), { kind: 'cycle' });
  await clearCycleProblem();
  assert.equal(await readSetupProblem(), null);
});

test('storage check banners clear once the storage is right again', async () => {
  const src = await fs.readFile(new URL('../src/storage-state.js', import.meta.url), 'utf8');
  assert.equal((src.match(/reportSetupProblem\([^)]*\)/g) || []).filter((c) => !c.includes("kind: 'cycle'")).length, 0);
});

test('receipts: missing worker ids follow the owner of an existing data/, never root', async () => {
  const src = await fs.readFile(new URL('../../receipts', import.meta.url), 'utf8');
  const fn = src.match(/fill_worker_ids\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /stat -c %u -- data/);
  assert.match(fn, /"\$uid" == 0/);
  assert.match(src, /sync_storage_overlay\(\) \{[\s\S]*?fill_worker_ids/);
});
