import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export const SUPPORTED = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
const MAX_PDF_PAGES = 3;

/** Turn an uploaded receipt (photo, HEIC or PDF) into downscaled JPEG data URIs for the model. */
export async function prepareImages(buffer, filename, maxSide) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-'));
  try {
    const ext = path.extname(filename).toLowerCase();
    const src = path.join(dir, `input${ext}`);
    await fs.writeFile(src, buffer);

    let pages = [src];
    if (ext === '.pdf') {
      await run('pdftoppm', ['-r', '150', '-f', '1', '-l', String(MAX_PDF_PAGES), '-jpeg', src, path.join(dir, 'page')]);
      pages = await listWithPrefix(dir, 'page');
    } else if (ext === '.heic' || ext === '.heif') {
      await run('heif-convert', [src, path.join(dir, 'heic.jpg')]);
      const primary = primaryHeic(await fs.readdir(dir));
      pages = primary ? [path.join(dir, primary)] : [];
    }
    if (pages.length === 0) throw new Error(`could not convert ${filename} to an image`);

    const uris = [];
    for (const [i, page] of pages.entries()) {
      const out = path.join(dir, `out-${i}.jpg`);
      await run('convert', [page, '-auto-orient', '-resize', `${maxSide}x${maxSide}>`, '-quality', '90', out]);
      uris.push(`data:image/jpeg;base64,${(await fs.readFile(out)).toString('base64')}`);
    }
    return uris;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function listWithPrefix(dir, prefix) {
  return (await fs.readdir(dir)).filter((f) => f.startsWith(prefix)).sort().map((f) => path.join(dir, f));
}

// heif-convert may also write auxiliary images next to the primary (HDR gain map, depth map: "heic-urn:...",
// "heic-depth.jpg"), and with several top-level images "heic-1.jpg", "heic-2.jpg"... Sorted names can put one of
// those first, so pick the primary by name.
export function primaryHeic(files) {
  const heic = files.filter((f) => f.startsWith('heic'));
  if (heic.includes('heic.jpg')) return 'heic.jpg';
  if (heic.includes('heic-1.jpg')) return 'heic-1.jpg';
  return heic.sort().find((f) => !/urn|depth|aux|gain|hdr/i.test(f)) ?? null;
}
