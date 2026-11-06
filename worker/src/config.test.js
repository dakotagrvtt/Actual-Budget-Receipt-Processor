import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_URL = new URL('./config.js', import.meta.url).href;
const RECEIPTS = fileURLToPath(new URL('../../receipts', import.meta.url));

/** Load config.js in a fresh process with `env` on top of the test environment; returns what it printed and warned. */
function load(env, expr) {
  const clean = { ...process.env };
  for (const k of ['DRY_RUN', 'SPLIT_TRANSACTIONS', 'LLM_THINKING', 'OVERWRITE_CATEGORIZED', 'SIMILAR_ITEMS']) delete clean[k];
  const r = spawnSync('node', ['-e', `import(${JSON.stringify(CONFIG_URL)}).then((m) => console.log(JSON.stringify(${expr})))`], { env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { value: JSON.parse(r.stdout), warnings: r.stderr };
}

test('bool: true, 1, yes and on, in any case, are true', () => {
  for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'Yes', 'on', 'ON', ' true ']) {
    const { value, warnings } = load({ SIMILAR_ITEMS: v }, 'm.config.similarItems');
    assert.equal(value, true, v);
    assert.equal(warnings, '', v);
  }
});

test('bool: false, 0, no and off, in any case, are false', () => {
  for (const v of ['false', 'FALSE', 'False', '0', 'no', 'No', 'off', 'OFF', ' false ']) {
    const { value, warnings } = load({ DRY_RUN: v }, 'm.config.dryRun');
    assert.equal(value, false, v);
    assert.equal(warnings, '', v);
  }
});

test('bool: unset gives the default, without a warning', () => {
  assert.deepEqual(load({}, '[m.config.dryRun, m.config.splits, m.config.llmThinking, m.config.similarItems]'), { value: [true, true, false, false], warnings: '' });
});

test('bool: anything else warns on stderr and uses the default', () => {
  for (const v of ['tru', 'maybe', 'enabled', '', '2', 'constructor']) {
    const { value, warnings } = load({ DRY_RUN: v }, 'm.config.dryRun');
    assert.equal(value, true, `DRY_RUN="${v}" falls back to the default, which is dry run`);
    assert.match(warnings, new RegExp(`DRY_RUN="${v}" is not true or false; using the default \\(true\\)`), v);
    assert.equal(warnings.trim().split('\n').length, 1, v);
  }
  const { value, warnings } = load({ LLM_THINKING: 'sure' }, 'm.config.llmThinking');
  assert.equal(value, false);
  assert.match(warnings, /LLM_THINKING="sure" is not true or false; using the default \(false\)/);
});

test('DRY_RUN defaults to true, so a typo can never turn a dry run live', () => {
  assert.equal(load({}, 'm.config.dryRun').value, true);
  assert.equal(load({ DRY_RUN: 'flase' }, 'm.config.dryRun').value, true);
});

test('./receipts mode agrees with the worker about DRY_RUN', () => {
  const script = fs.readFileSync(RECEIPTS, 'utf8');
  const fn = /^mode\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0];
  assert.ok(fn, 'mode() not found in receipts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-test-'));
  try {
    const modeFor = (envFile) => {
      if (envFile === null) fs.rmSync(path.join(dir, '.env'), { force: true });
      else fs.writeFileSync(path.join(dir, '.env'), envFile);
      const r = spawnSync('bash', ['-c', `${fn}\nmode`], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const cases = ['true', 'false', 'False', 'FALSE', '0', 'no', 'off', 'OFF', 'yes', '1', 'on', "'false'", '"false"', 'false # live now', 'flase', ''];
    for (const v of cases) {
      const worker = load({ DRY_RUN: v.replace(/ #.*$/, '').replace(/^(['"])(.*)\1$/, '$2') }, 'm.config.dryRun').value;
      assert.equal(modeFor(`A=1\nDRY_RUN=${v}\nB=2\n`), worker ? 'dry run' : 'live', `DRY_RUN=${v}`);
    }
    assert.equal(modeFor('A=1\n'), 'dry run'); // unset
    assert.equal(modeFor(null), 'dry run'); // no .env at all
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CATEGORIZER: the old values are no longer used; d1 and decider stay quiet, others warn', () => {
  for (const v of ['d1', 'decider', 'D1']) assert.equal(load({ CATEGORIZER: v }, '1').warnings, '', v);
  assert.match(load({ CATEGORIZER: 'lfm3' }, '1').warnings, /CATEGORIZER="lfm3" is no longer used/);
});
