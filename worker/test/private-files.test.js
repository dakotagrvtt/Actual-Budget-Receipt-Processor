// Files and folders the worker creates are private (0700 / 0600), and old ones are repaired.
import './support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';

const { writeJsonAtomic, withLock } = await import('../src/file-lock.js');
const { saveState, loadState, heartbeat } = await import('../src/state.js');
const { mkdirPrivate, writePrivate, repairPermissions } = await import('../src/private-files.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-test-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const mode = (p) => fs.statSync(p).mode & 0o777;

test('writeJsonAtomic creates a 0600 file in a 0700 folder, whatever the umask', async () => {
  const old = process.umask(0o022);
  try {
    const file = path.join(root, 'a', 'b', 'words.json');
    await writeJsonAtomic(file, { x: 1 });
    assert.equal(mode(file), 0o600);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.equal(mode(path.join(root, 'a')), 0o700);
    await writeJsonAtomic(file, { x: 2 }); // replacing keeps it private
    assert.equal(mode(file), 0o600);
    await withLock(`${file}.lock`, async () => assert.equal(mode(`${file}.lock`), 0o600));
  } finally {
    process.umask(old);
  }
});

test('state.json and the heartbeat are written 0600', async () => {
  const dir = path.join(root, 'st');
  fs.mkdirSync(dir);
  const saved = { statePath: config.statePath, heartbeatPath: config.heartbeatPath };
  Object.assign(config, { statePath: path.join(dir, 'state.json'), heartbeatPath: path.join(dir, 'heartbeat') });
  const old = process.umask(0o022);
  try {
    await saveState({ 'a.jpg@e': { done: true } });
    await heartbeat();
    assert.equal(mode(config.statePath), 0o600);
    assert.equal(mode(config.heartbeatPath), 0o600);
    assert.deepEqual(await loadState(), { 'a.jpg@e': { done: true } });
  } finally {
    process.umask(old);
    Object.assign(config, saved);
  }
});

test('repairPermissions: folders 0700, files 0600, an execute bit kept, links left alone, a missing folder is nothing', async () => {
  const d = path.join(root, 'old');
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'state.json'), '{}', { mode: 0o644 });
  fs.writeFileSync(path.join(d, 'sub', 'tool'), '#!/bin/sh', { mode: 0o755 });
  fs.writeFileSync(path.join(d, 'sub', 'ok.json'), '{}', { mode: 0o600 });
  fs.symlinkSync('/etc/hostname', path.join(d, 'link'));
  fs.chmodSync(path.join(d, 'sub'), 0o755);
  fs.chmodSync(d, 0o755);
  assert.equal(await repairPermissions(d), 4);
  assert.equal(mode(d), 0o700);
  assert.equal(mode(path.join(d, 'sub')), 0o700);
  assert.equal(mode(path.join(d, 'state.json')), 0o600);
  assert.equal(mode(path.join(d, 'sub', 'tool')), 0o700);
  assert.equal(mode(path.join(d, 'sub', 'ok.json')), 0o600);
  assert.equal(await repairPermissions(d), 0); // nothing left to do
  assert.equal(await repairPermissions(path.join(root, 'nope')), 0);
});

test('mkdirPrivate and writePrivate', async () => {
  const old = process.umask(0o022);
  try {
    const d = path.join(root, 'x', 'y');
    await mkdirPrivate(d);
    await writePrivate(path.join(d, 'f'), 'hi');
    assert.equal(mode(d), 0o700);
    assert.equal(mode(path.join(d, 'f')), 0o600);
  } finally {
    process.umask(old);
  }
});
