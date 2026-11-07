// settings.js: data/settings.json is the dry run / live switch once it exists; it is re-read each cycle and written atomically.
// Temp files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { readSettings, resolveDryRun, refreshMode, writeSettings, envDisagreement, mustStopForDry } from './settings.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
config.settingsPath = path.join(dir, 'settings.json');
const file = config.settingsPath;
const reset = () => {
  fs.rmSync(file, { recursive: true, force: true });
};
const quiet = () => {};
const pick = ({ dryRun, source }) => ({ dryRun, source });

test('no settings file: DRY_RUN from .env applies', () => {
  reset();
  assert.deepEqual(resolveDryRun(true, file), { dryRun: true, source: 'env', settings: null });
  assert.equal(resolveDryRun(false, file).dryRun, false);
});

test('a usable settings file is THE switch, in both directions; DRY_RUN in .env is ignored', () => {
  fs.writeFileSync(file, '{"dryRun":false,"changedAt":"2026-01-01T00:00:00.000Z","changedBy":"cli"}');
  for (const env of [true, false]) assert.deepEqual(pick(resolveDryRun(env, file)), { dryRun: false, source: 'settings' });
  assert.equal(resolveDryRun(true, file).settings.changedBy, 'cli');
  fs.writeFileSync(file, '{"dryRun":true}');
  for (const env of [true, false]) assert.deepEqual(pick(resolveDryRun(env, file)), { dryRun: true, source: 'settings' });
  reset();
});

test('extra fields of any kind are fine; duplicate keys: the last wins (as in bash/python)', () => {
  fs.writeFileSync(file, '{"dryRun":false,"n":1.5,"list":[1,2],"o":{"a":null}}');
  assert.equal(resolveDryRun(true, file, quiet).dryRun, false);
  fs.writeFileSync(file, '{"dryRun":true,"dryRun":false}');
  assert.equal(resolveDryRun(true, file, quiet).dryRun, false);
  fs.writeFileSync(file, '{"dryRun":false,"dryRun":true}');
  assert.equal(resolveDryRun(false, file, quiet).dryRun, true);
  reset();
});

test('a file that exists but is unusable: dry run (never .env), warn once', () => {
  const bads = ['{nope', '', '[]', 'null', '5', '"x"', '{"dryRun":"false"}', '{"dryRun":0}', '{"dryRun":null}', '{}', '{"dryRun":false,}', '﻿{"dryRun":false}', '{"dryRun":false,"x":NaN}'];
  for (const bad of bads) {
    fs.writeFileSync(file, '{"dryRun":true}');
    readSettings(file); // a good read resets the once-only warning
    fs.writeFileSync(file, bad);
    const warnings = [];
    for (const envDefault of [true, false]) {
      const r = resolveDryRun(envDefault, file, (m) => warnings.push(m));
      assert.equal(r.dryRun, true, `${bad}: dry run even when .env says live`);
      assert.equal(r.source, 'unusable');
    }
    assert.equal(warnings.length, 1, `${bad}: warned once, not on every cycle`);
    assert.match(warnings[0], /not usable/);
  }
  reset();
});

test('invalid UTF-8 in the file is unusable too', () => {
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"dryRun":false,"changedBy":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]));
  const r = resolveDryRun(false, file, quiet);
  assert.deepEqual(pick(r), { dryRun: true, source: 'unusable' });
  reset();
});

test('a dangling symlink EXISTS and is unusable: dry run, not "no file"', () => {
  reset();
  fs.symlinkSync(path.join(dir, 'nowhere.json'), file);
  const warnings = [];
  assert.notEqual(readSettings(file, (m) => warnings.push(m)), null, 'not "missing"');
  const r = resolveDryRun(false, file, (m) => warnings.push(m));
  assert.deepEqual(pick(r), { dryRun: true, source: 'unusable' });
  assert.equal(warnings.length, 1);
  reset();
});

test('a symlink to a usable file works', () => {
  reset();
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, '{"dryRun":false}');
  fs.symlinkSync(real, file);
  assert.deepEqual(pick(resolveDryRun(true, file, quiet)), { dryRun: false, source: 'settings' });
  reset();
  fs.rmSync(real);
});

test('a file that cannot be read (no permission) is unusable', (t) => {
  if (process.getuid?.() === 0) return t.skip('root can read anything');
  fs.writeFileSync(file, '{"dryRun":false}', { mode: 0o000 });
  try {
    assert.deepEqual(pick(resolveDryRun(false, file, quiet)), { dryRun: true, source: 'unusable' });
  } finally {
    reset();
  }
});

test('envDisagreement: a clear line only when a usable file says something other than .env', () => {
  fs.writeFileSync(file, '{"dryRun":false}');
  const live = envDisagreement(resolveDryRun(true, file), true);
  assert.equal(live, 'DRY_RUN in .env (true) is ignored; the switch on the status page (data/settings.json) says live. Use the page or ./receipts mode dry to stop.');
  fs.writeFileSync(file, '{"dryRun":true}');
  assert.equal(envDisagreement(resolveDryRun(false, file), false), 'DRY_RUN in .env (false) is ignored; the switch on the status page (data/settings.json) says dry run. Use the page or ./receipts mode live to go live.');
  assert.equal(envDisagreement(resolveDryRun(true, file), true), null, 'they agree');
  fs.writeFileSync(file, '{"dryRun":false}');
  assert.equal(envDisagreement(resolveDryRun(false, file), false), null, 'they agree');
  reset();
  assert.equal(envDisagreement(resolveDryRun(false, file), false), null, 'no file');
  fs.writeFileSync(file, '{nope');
  assert.equal(envDisagreement(resolveDryRun(false, file, quiet), false), null, 'unusable has its own warning');
  reset();
});

test('refreshMode picks up changes between cycles and logs the change and the disagreement once', (t) => {
  const was = config.dryRun;
  const wasEnv = config.envDryRun;
  const logged = [];
  t.mock.method(console, 'log', (...a) => logged.push(a.join(' ')));
  try {
    config.envDryRun = true;
    config.dryRun = true;
    reset();
    assert.equal(refreshMode(), true);
    assert.equal(logged.length, 0, 'no change, no log line');
    fs.writeFileSync(file, '{"dryRun":false,"changedBy":"status page"}');
    assert.equal(refreshMode(), false);
    assert.equal(config.dryRun, false);
    assert.match(logged.join('\n'), /mode changed: dry run -> live \(set by status page/);
    assert.match(logged.join('\n'), /DRY_RUN in \.env \(true\) is ignored; the switch on the status page .* says live/);
    refreshMode();
    assert.equal(logged.length, 2, 'same mode again: silent');
    reset(); // file removed: back to .env
    assert.equal(refreshMode(), true);
    assert.match(logged.join('\n'), /live -> dry run/);
  } finally {
    config.dryRun = was;
    config.envDryRun = wasEnv;
    reset();
  }
});

test('mustStopForDry: only a live worker whose switch now says dry (or is unusable) stops mid-batch', () => {
  const was = config.dryRun;
  const wasEnv = config.envDryRun;
  try {
    config.envDryRun = false;
    config.dryRun = false;
    reset();
    assert.equal(mustStopForDry(), false, 'no file, .env live');
    fs.writeFileSync(file, '{"dryRun":false}');
    assert.equal(mustStopForDry(), false);
    fs.writeFileSync(file, '{"dryRun":true}');
    assert.equal(mustStopForDry(), true, 'switched to dry');
    fs.writeFileSync(file, '{nope');
    assert.equal(mustStopForDry(resolveDryRun(false, file, quiet)), true, 'unusable is dry');
    config.dryRun = true;
    fs.writeFileSync(file, '{"dryRun":false}');
    assert.equal(mustStopForDry(), false, 'switching to live waits for the next cycle');
    fs.writeFileSync(file, '{"dryRun":true}');
    assert.equal(mustStopForDry(), false, 'already dry');
  } finally {
    config.dryRun = was;
    config.envDryRun = wasEnv;
    reset();
  }
});

test('writeSettings writes valid JSON atomically (no envDryRun) and leaves no temp files', async () => {
  const s = await writeSettings({ dryRun: false, changedBy: 'status page' }, file);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, s);
  assert.deepEqual(Object.keys(onDisk), ['dryRun', 'changedAt', 'changedBy']);
  assert.equal(onDisk.dryRun, false);
  assert.equal(onDisk.changedBy, 'status page');
  assert.ok(!Number.isNaN(Date.parse(onDisk.changedAt)));
  assert.deepEqual(readSettings(file), { dryRun: false, changedAt: onDisk.changedAt, changedBy: 'status page' });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'settings.json'), []);
  reset();
});

test('writeSettings replaces a dangling symlink with a real, usable file', async () => {
  reset();
  fs.symlinkSync(path.join(dir, 'nowhere.json'), file);
  await writeSettings({ dryRun: true, changedBy: 'cli' }, file);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(resolveDryRun(false, file).source, 'settings');
  reset();
});
