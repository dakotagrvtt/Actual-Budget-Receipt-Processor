import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryHeic, SUPPORTED } from './image.js';

test('primaryHeic: the plain conversion wins over auxiliary images', () => {
  assert.equal(primaryHeic(['input.heic', 'heic-depth.jpg', 'heic.jpg', 'heic-urn:com:apple:photo:2020:aux:hdrgainmap.jpg']), 'heic.jpg');
});

test('primaryHeic: with several top-level images the first one is the primary', () => {
  assert.equal(primaryHeic(['heic-2.jpg', 'heic-1.jpg', 'heic-depth.jpg']), 'heic-1.jpg');
});

test('primaryHeic: otherwise the first name that is not an auxiliary image', () => {
  assert.equal(primaryHeic(['heic-depth.jpg', 'heic-photo.jpg', 'heic-urn-x.jpg']), 'heic-photo.jpg');
  assert.equal(primaryHeic(['heic-depth.jpg', 'heic-urn-x.jpg']), null);
  assert.equal(primaryHeic(['input.heic', 'other.jpg']), null);
});

test('SUPPORTED: photo and PDF extensions, any case', () => {
  for (const f of ['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.HEIC', 'a.heif', 'a.pdf']) assert.ok(SUPPORTED.test(f), f);
  for (const f of ['a.txt', 'a.jpg.bak', 'jpg']) assert.ok(!SUPPORTED.test(f), f);
});
