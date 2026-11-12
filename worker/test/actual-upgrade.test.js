// actual-upgrade.js: when the long-running worker should restart to follow an Actual server upgrade. Temp dir, fake /info.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { upgradeDecision, createUpgradeWatcher, readUpgradeMarker, GUARD_MS, CHECK_EVERY_MS } from '../src/actual-upgrade.js';

const base = { setting: 'auto', usingVersion: '26.7.0', serverVersion: '26.8.0' };

test('upgradeDecision: a different server version means restart', () => {
  const d = upgradeDecision(base);
  assert.equal(d.action, 'restart');
  assert.match(d.message, /26\.8\.0 .* 26\.7\.0/);
});

test('upgradeDecision: nothing to do when not auto, version unknown or odd, or already matching', () => {
  assert.equal(upgradeDecision({ ...base, setting: 'latest' }).action, 'ok');
  assert.equal(upgradeDecision({ ...base, setting: '26.7.0' }).action, 'ok');
  assert.equal(upgradeDecision({ ...base, serverVersion: null }).action, 'ok');
  assert.equal(upgradeDecision({ ...base, serverVersion: 'edge-nightly' }).action, 'ok');
  assert.equal(upgradeDecision({ ...base, serverVersion: '26.7.0' }).action, 'ok');
});

test('upgradeDecision: an install that already failed in this run, or a restart just made for the same version, is a note, not another restart', () => {
  const failed = upgradeDecision({ ...base, failedFor: '26.8.0' });
  assert.equal(failed.action, 'note');
  assert.match(failed.message, /installing the matching .* failed/);
  const now = 10_000_000;
  const again = upgradeDecision({ ...base, restartedFor: { version: '26.8.0', at: now - 1000 }, now });
  assert.equal(again.action, 'note');
  assert.match(again.message, /already restarted once/);
  // an old marker, or one for another version, does not stop a restart
  assert.equal(upgradeDecision({ ...base, restartedFor: { version: '26.8.0', at: now - GUARD_MS - 1 }, now }).action, 'restart');
  assert.equal(upgradeDecision({ ...base, restartedFor: { version: '26.7.5', at: now - 1000 }, now }).action, 'restart');
  // failing for an older server version says nothing about the current one
  assert.equal(upgradeDecision({ ...base, failedFor: '26.7.9' }).action, 'restart');
});

async function watcherIn(opts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-test-'));
  let t = 1_000_000;
  const asked = [];
  const answers = opts.answers ?? [];
  const status = { note: '' };
  const w = createUpgradeWatcher({
    setting: 'auto', serverURL: 'http://actual.invalid', usingVersion: '26.7.0', dir, status,
    now: () => t,
    fetchFn: async (url) => (asked.push(url), answers.length ? answers.shift() : null),
    ...opts.watcher,
  });
  return { w, dir, asked, status, advance: (ms) => { t += ms; }, clock: () => t };
}

test('watcher: the version seen at startup seeds the cache, so the first cycle asks nothing; later checks are at most every 10 minutes', async () => {
  const { w, asked, advance, dir } = await watcherIn({ watcher: { startVersion: '26.7.0' }, answers: ['26.7.0', '26.7.0'] });
  try {
    assert.equal((await w.check()).action, 'ok');
    assert.equal(asked.length, 0);
    advance(CHECK_EVERY_MS - 1);
    await w.check();
    assert.equal(asked.length, 0);
    advance(1);
    await w.check();
    assert.equal(asked.length, 1);
    await w.check();
    assert.equal(asked.length, 1, 'cached again');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('watcher: an upgrade is found on the next check after the cache expires, and leaves a marker', async () => {
  const { w, dir, advance, clock } = await watcherIn({ watcher: { startVersion: '26.7.0' }, answers: ['26.8.0'] });
  try {
    assert.equal((await w.check()).action, 'ok');
    advance(CHECK_EVERY_MS);
    const d = await w.check();
    assert.equal(d.action, 'restart');
    assert.deepEqual(await readUpgradeMarker(dir), { version: '26.8.0', at: clock(), outcome: 'restarting' });
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('watcher: after the restart still on the old API (install failed), it notes it, says so in status, and does not restart again', async () => {
  const { w, dir, status } = await watcherIn({ watcher: { startVersion: '26.8.0', usingVersion: '26.7.0' } });
  try {
    await fs.writeFile(path.join(dir, '.upgrade.json'), JSON.stringify({ version: '26.8.0', at: 1_000_000 - 5000, outcome: 'restarting' }));
    const d = await w.check();
    assert.equal(d.action, 'note');
    assert.match(status.note, /already restarted once/);
    const marker = await readUpgradeMarker(dir);
    assert.equal(marker.outcome, 'stuck');
    assert.match(marker.message, /Not restarting again/);
    assert.equal((await w.check()).action, 'note', 'every later cycle too');
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('watcher: an install that failed at startup (failedFor) never restarts, even with no marker', async () => {
  const { w, dir, status } = await watcherIn({ watcher: { startVersion: '26.8.0', failedFor: '26.8.0' } });
  try {
    const d = await w.check();
    assert.equal(d.action, 'note');
    assert.match(status.note, /failed at startup/);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('watcher: once versions match, the note and the marker are cleared', async () => {
  const { w, dir, status } = await watcherIn({ watcher: { startVersion: '26.7.0' } });
  try {
    await fs.writeFile(path.join(dir, '.upgrade.json'), JSON.stringify({ version: '26.7.0', at: 1, outcome: 'restarting' }));
    status.note = 'old note';
    assert.equal((await w.check()).action, 'ok');
    assert.equal(status.note, '');
    assert.equal(await readUpgradeMarker(dir), null);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('watcher: an unreachable server says nothing and is asked again next time; not auto means never asked', async () => {
  const a = await watcherIn({ answers: [null, '26.7.0'] });
  try {
    assert.equal((await a.w.check()).action, 'ok');
    assert.equal((await a.w.check()).action, 'ok');
    assert.equal(a.asked.length, 2, 'a failed look is not cached');
  } finally {
    await fs.rm(a.dir, { recursive: true });
  }
  const b = await watcherIn({ watcher: { setting: 'latest' }, answers: ['99.0.0'] });
  try {
    assert.equal((await b.w.check()).action, 'ok');
    assert.equal(b.asked.length, 0);
  } finally {
    await fs.rm(b.dir, { recursive: true });
  }
});

test('watcher: an unwritable marker dir does not break the check', async () => {
  const { w, dir } = await watcherIn({ watcher: { startVersion: '26.8.0', dir: '/nonexistent-dir/for-test' } });
  await fs.rm(dir, { recursive: true });
  assert.equal((await w.check()).action, 'restart');
});
