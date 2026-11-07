// Replay receipts for purchases you already categorized or split yourself, and compare the pipeline's answer
// with yours. Each receipt is read with the reader model (or taken from JSON), matched to its bank transaction (existing
// splits allowed), and categorized from your store history (excluding that purchase). Always a dry run:
// nothing in Actual or Nextcloud is changed, and Nextcloud files are only downloaded.
//
// Never waits for a charge to post (these are old purchases): no match goes straight to the review answer.
//
// Usage (./receipts replay runs it with its own budget copy, data/actual-cache-tools; a bare `docker compose run`
// would share the running worker's cache):
//   ./receipts replay /data/receipt.jpg                one local file (./data = /data)
//   ./receipts replay --nextcloud "/Receipts/Test"     every receipt in a Nextcloud folder
//   ... --receipt /data/read.json      skip reading, use a saved reading
//   ... --readings /data/readings      re-decide every saved reading in a folder (fast: no photos read)
//   ... --save-readings /data/dir      where new readings are saved (default /data/research/readings)
//   ... --only 212537,212930           with --nextcloud: only files whose name contains one of these
//   ... --items-out /data/f.json      where the per-item numbers go (default /data/research/replay-items.json): for every item
//                                      the decider's pick, its top probability (confidence) and margin (lead over the runner-up),
//                                      the category finally filed and how, so MOVE_MIN_CONFIDENCE, CATEGORY_MIN_CONFIDENCE and
//                                      MOVE_MIN_MARGIN can be swept offline without running the models again; with RECEIPT_CHECK also the
//                                      whole-purchase answer (receiptPick, receiptTopProbability, receiptMargin) and the item's own
//                                      probability for it, so RECEIPT_CHECK_MIN_CONFIDENCE can be swept too
//   ... --preview-remote <name>        write the exact anonymized request the remote (hosted) decider would get for every item
//                                      to /data/research/<name>/<receipt>.item<N>.json as { held_back: [{path, kind}], body } (held_back
//                                      lists what the privacy check would stop from being sent). Sends nothing to the decider and calls no
//                                      decider; the name scan runs on the reader (names it finds are saved, see the Privacy page). With a
//                                      cloud reader (READER_PROVIDER=remote) replay does send the photos, and the scan texts, to it.
import './private-umask.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import * as actual from './actual.js';
import * as nextcloud from './nextcloud.js';
import { prepareImages } from './image.js';
import { readReceipt, waitForModel } from './llm.js';
import { loadAliases } from './payee.js';
import { handleReceipt } from './receipt.js';
import { readingFiles, readingFileName } from './readings.js';
import { itemRows } from './replay-rows.js';
import { mkdirPrivate, writePrivate } from './private-files.js';

config.dryRun = true; // never write, whatever .env says

// --with-memory: use what it learned from your corrections (lessons, learned keywords); by default a replay uses none of it.
const withMemory = process.argv.includes('--with-memory');
const args = process.argv.slice(2).filter((a) => a !== '--with-memory');
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const localPath = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const categorizer = flag('categorizer'); // removed: the decider is the only categorizer
if (categorizer && !['decider', 'd1'].includes(categorizer)) throw new Error(`--categorizer ${categorizer}: only the decider is left (set DECIDER_MODEL in .env to try another model)`);
const previewRemote = flag('preview-remote');
if (previewRemote) {
  if (!/^[\w][\w.-]*$/.test(previewRemote)) throw new Error('--preview-remote takes a plain folder name, e.g. --preview-remote jev-preview');
  if (config.reader.provider === 'remote' && !config.privacy.cloudNameScan) {
    throw new Error('--preview-remote runs the name and place scan on the reader, and READER_PROVIDER=remote would send the raw receipt text to its provider. Set CLOUD_NAME_SCAN=true to accept that, or use the local reader');
  }
  config.decider.provider = 'remote'; // build the remote requests whatever DECIDER_PROVIDER says
  config.decider.preview = previewRemote;
}
const receiptJson = flag('receipt');
const ncFolder = flag('nextcloud');

/**
 * How much of the money the pipeline put where you did: for each category, the smaller of your amount and the
 * pipeline's, summed and divided by the total. 100% = identical split; 0% = nothing in common.
 */
function matchScore(yours, pipeline) {
  const sum = (parts) => parts.reduce((m, p) => m.set(p.category, (m.get(p.category) ?? 0) + Number(p.amount)), new Map());
  const a = sum(yours);
  const b = sum(pipeline);
  const total = [...a.values()].reduce((x, y) => x + y, 0);
  let shared = 0;
  for (const [cat, amt] of a) shared += Math.min(amt, b.get(cat) ?? 0);
  return total > 0 ? shared / total : 0;
}

// Inputs: { name, reading?: receipt JSON, load?: () => Buffer }
const inputs = [];
if (receiptJson) inputs.push({ name: path.basename(receiptJson), reading: JSON.parse(await fs.readFile(receiptJson, 'utf8')) });
else if (flag('readings')) {
  // Re-decide from saved readings (<name>.read.json, or the older <name>.lfm3-read.json, in a folder) without reading the photos again.
  const dir = flag('readings');
  for (const { file, name } of readingFiles(await fs.readdir(dir))) {
    inputs.push({ name, reading: JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) });
  }
}
else if (ncFolder) {
  const only = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  for (const item of await nextcloud.listFolder(ncFolder)) {
    if (only && !only.some((s) => item.basename.includes(s))) continue;
    inputs.push({ name: item.basename, lastmod: item.lastmod, load: () => nextcloud.download(item) });
  }
}
else if (localPath) inputs.push({ name: path.basename(localPath), lastmod: (await fs.stat(localPath)).mtime.toISOString(), load: () => fs.readFile(localPath) });
else throw new Error('usage: replay.js <image> | --nextcloud <folder> | --receipt <json>  [--readings <folder>] [--save-readings <folder>] [--only <names>]');
if (inputs.length === 0) throw new Error(`no receipt files found in ${ncFolder}`);

const fmt = (parts) => parts.map((p) => `${p.category.split(' / ').pop()} ${p.amount}`).join(', ');
const results = [];
const rows = [];

loadAliases();
await actual.open();
try {
  const labels = await actual.categoryLabels();
  if (config.reader.provider === 'remote') {
    log(`*** cloud reader: the receipt photos${previewRemote ? ' and the name-scan texts' : ''} are sent to ${config.reader.host}${previewRemote ? ' (only the decider requests are written to files instead of sent)' : ''} ***`);
  }
  for (const input of inputs) {
    let receipt = input.reading;
    let readMode = 'from saved JSON';
    try {
      if (!receipt) {
        await waitForModel();
        const started = Date.now();
        const read = await readReceipt(await prepareImages(await input.load(), input.name, config.maxImageSide));
        receipt = read.receipt;
        readMode = `${config.llmName}, ${read.mode}, ${((Date.now() - started) / 1000).toFixed(1)} s`;
        const saveDir = flag('save-readings') ?? '/data/research/readings';
        await mkdirPrivate(saveDir);
        await writePrivate(path.join(saveDir, readingFileName(path.parse(input.name).name)), JSON.stringify(receipt, null, 2));
      }
      for (const it of receipt.items) delete it.category; // categories come from the categorizer under test
      log(`=== ${input.name} (dry run, replay${previewRemote ? `, previewing remote requests in ${config.privacy.previewRoot}/${previewRemote}` : ''}) ===`);
      config.decider.previewLabel = path.parse(input.name).name;
      const { result, summary } = await handleReceipt({ basename: input.name, lastmod: input.lastmod }, structuredClone(receipt), readMode, labels, { includeSplits: true, replay: true, withMemory });
      const t = summary.transaction;
      const yours = t?.currentSplit ?? (t?.currentCategory ? [{ category: t.currentCategory, amount: t.amount }] : null);
      const score = yours && summary.plan ? matchScore(yours, summary.plan.parts) : null;
      if (yours) log(`yours:    ${fmt(yours)}`);
      if (summary.plan) log(`pipeline: ${fmt(summary.plan.parts)}`);
      if (score != null) log(`match:    ${Math.round(score * 100)}%`);
      rows.push(...itemRows(input.name, summary.receipt));
      results.push({ file: input.name, categorizer: summary.categorizedWith ?? '-', result, score, yours: yours ? fmt(yours) : '-', pipeline: summary.plan ? fmt(summary.plan.parts) : '-', problems: summary.problems.join(' / ') });
    } catch (err) {
      log(`  error on ${input.name}: ${err.message}`);
      results.push({ file: input.name, categorizer: '-', result: 'error', yours: '-', pipeline: '-', problems: err.message });
    }
  }
} finally {
  await actual.close();
}

const itemsOut = flag('items-out') ?? '/data/research/replay-items.json';
await mkdirPrivate(path.dirname(itemsOut));
await writePrivate(itemsOut, JSON.stringify(rows, null, 1));
log(`=== ${rows.length} item(s) with their top probability and margin saved to ${itemsOut} ===`);

const scored = results.filter((r) => r.score != null);
const avg = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : null;
log(`=== summary: ${results.length} run(s)${avg != null ? `, average match ${Math.round(avg * 100)}%` : ''} ===`);
for (const r of results) {
  log(`${r.file} [${r.categorizer}] ${r.result}${r.score != null ? `, match ${Math.round(r.score * 100)}%` : ''}\n    yours:    ${r.yours}\n    pipeline: ${r.pipeline}${r.problems ? `\n    review:   ${r.problems}` : ''}`);
}
