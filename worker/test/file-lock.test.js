// file-lock.js: only one holder at a time, a stale lock is taken over by exactly one waiter, and only the owner removes a lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from '../src/file-lock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('withLock: runs fn, returns its value and removes the lock', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'a.lock');
  assert.equal(await withLock(lock, async () => { assert.ok(fs.readFileSync(lock, 'utf8').length > 10, 'token inside'); return 7; }), 7);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('withLock: concurrent waiters never overlap', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'a.lock');
  let inside = 0;
  let max = 0;
  await Promise.all(Array.from({ length: 6 }, () => withLock(lock, async () => {
    max = Math.max(max, ++inside);
    await wait(20);
    inside--;
  })));
  assert.equal(max, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('withLock: a stale lock is taken over by exactly one of several concurrent waiters', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'a.lock');
  fs.writeFileSync(lock, 'dead-owner');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lock, old, old);
  let inside = 0;
  let max = 0;
  let ran = 0;
  await Promise.all(Array.from({ length: 6 }, () => withLock(lock, async () => {
    max = Math.max(max, ++inside);
    ran++;
    await wait(30);
    inside--;
  })));
  assert.equal(ran, 6);
  assert.equal(max, 1, 'two waiters were inside at once');
  assert.deepEqual(fs.readdirSync(dir), [], 'no lock or temp files left');
});

test('withLock: a holder whose lock was taken over does not delete the new owner\'s lock', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'a.lock');
  await withLock(lock, async () => { fs.writeFileSync(lock, 'someone-else'); });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else');
});

test('withLock: gives up with "locked" when a fresh lock stays held; staleMs/waitMs are options', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'a.lock');
  fs.writeFileSync(lock, 'other');
  await assert.rejects(withLock(lock, async () => 1, { waitMs: 150 }), /locked/);
  assert.equal(await withLock(lock, async () => 2, { staleMs: -1 }), 2, 'staleMs: -1 treats any lock as stale');
});
