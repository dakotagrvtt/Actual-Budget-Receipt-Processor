// image.js: choosing the primary image heif-convert writes, and which file names are accepted.
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

test('prepareImages: PDF pages use 150 dpi for the reader and -scale-to only when the panel asks (fitPdf)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tools-'));
  const log = path.join(dir, 'args.txt');
  // Stand-ins: pdftoppm records its arguments and writes one page; convert copies its input to its output.
  fs.writeFileSync(path.join(dir, 'pdftoppm'), `#!/bin/sh\necho "$@" >> ${log}\nfor last; do :; done\nprintf jpegbytes > "$last-1.jpg"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'convert'), '#!/bin/sh\ncp "$1" "$(eval echo \\${$#})"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const { prepareImages } = await import('./image.js');
    assert.equal((await prepareImages(Buffer.from('%PDF'), 'a.pdf', 2240)).length, 1);
    assert.equal((await prepareImages(Buffer.from('%PDF'), 'a.pdf', 2240, { fitPdf: true })).length, 1);
    const [reader, panel] = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.match(reader, /^-r 150 -f 1 -l 3 -jpeg /);
    assert.match(panel, /^-scale-to 2240 -f 1 -l 3 -jpeg /);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareImages: convert strips metadata (EXIF, GPS) after applying the orientation', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tools-'));
  const log = path.join(dir, 'args.txt');
  fs.writeFileSync(path.join(dir, 'convert'), `#!/bin/sh\necho "$@" >> ${log}\ncp "$1" "$(eval echo \\\${$#})"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const { prepareImages } = await import('./image.js');
    assert.equal((await prepareImages(Buffer.from('jpegbytes'), 'photo.jpg', 2240)).length, 1);
    const args = fs.readFileSync(log, 'utf8').trim().split(/\s+/);
    assert.ok(args.includes('-strip'));
    assert.ok(args.indexOf('-auto-orient') < args.indexOf('-strip'), '-strip comes after -auto-orient');
    assert.ok(args.indexOf('-strip') < args.indexOf('-resize'));
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
