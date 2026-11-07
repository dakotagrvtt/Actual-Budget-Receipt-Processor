// Turns an uploaded receipt (photo, HEIC or PDF) into downscaled JPEG data URIs with poppler, libheif and ImageMagick.
// Used by receipt.js for the reader and by the status page's photo view; EXIF is stripped before anything leaves the machine.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execP = promisify(execFile);
const TOOL_TIMEOUT_MS = 60000; // a stuck converter must not hang the worker or the panel
const run = (cmd, args) => execP(cmd, args, { timeout: TOOL_TIMEOUT_MS });

export const SUPPORTED = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
const JPEG_QUALITY = 90;
const MAX_PDF_PAGES = 3; // longer PDFs are cut here: receipts are short, and every page is one more image for the model
const PDF_READER_DPI = 150; // what the reader sees; the photo view uses -scale-to instead

/**
 * Turn an uploaded receipt (photo, HEIC or PDF) into downscaled JPEG data URIs for the model.
 * opts.fitPdf (the status page's photo view): render PDF pages at maxSide at most, whatever the page size. The reader
 * keeps its 150 dpi, so what it sees is unchanged.
 */
export async function prepareImages(buffer, filename, maxSide, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-'));
  try {
    const ext = path.extname(filename).toLowerCase();
    const src = path.join(dir, `input${ext}`);
    await fs.writeFile(src, buffer);

    let pages = [src];
    if (ext === '.pdf') {
      await run('pdftoppm', [...(opts.fitPdf ? ['-scale-to', String(maxSide)] : ['-r', String(PDF_READER_DPI)]), '-f', '1', '-l', String(MAX_PDF_PAGES), '-jpeg', src, path.join(dir, 'page')]);
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
      // -strip after -auto-orient (the rotation is applied first): drops EXIF, including the phone's GPS location, before a photo can leave the machine.
      await run('convert', [page, '-auto-orient', '-strip', '-resize', `${maxSide}x${maxSide}>`, '-quality', String(JPEG_QUALITY), out]);
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
