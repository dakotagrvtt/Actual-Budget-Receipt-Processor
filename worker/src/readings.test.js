import test from 'node:test';
import assert from 'node:assert/strict';
import { readingFiles, readingFileName } from './readings.js';

test('readingFiles: accepts .read.json and .lfm3-read.json, one per base name, .read.json preferred', () => {
  const out = readingFiles(['b.lfm3-read.json', 'a.read.json', 'a.lfm3-read.json', 'c.read.json', 'c.lfm3-read.json']);
  assert.deepEqual(out, [
    { file: 'a.read.json', name: 'a' },
    { file: 'b.lfm3-read.json', name: 'b' },
    { file: 'c.read.json', name: 'c' },
  ]);
});

test('readingFiles: ignores v1-read, stripped-read and other files', () => {
  assert.deepEqual(readingFiles(['a.v1-read.json', 'a.stripped-read.json', 'notes.txt', 'x.json', '.read.json.bak']), []);
});

test('readingFileName', () => {
  assert.equal(readingFileName('212537'), '212537.read.json');
});
