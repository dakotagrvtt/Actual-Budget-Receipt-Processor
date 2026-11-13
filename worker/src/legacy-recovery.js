// Upgrade old interrupted writes into durable filing records. Existing transaction contents are preserved, not recreated.
import path from 'node:path/posix';
import { patchEntry } from './state.js';
import { config } from './config.js';
import { money } from './reconcile.js';
import { filePageSummary } from './filing.js';
export const legacyPending = (e) => !e.filing && ((e.creating && !e.creating.context) || e.fixedOnPage?.summaryFailed);
export async function recoverLegacyRecords(state, { actual, nextcloud: nc }) {
  if (config.dryRun) return;
  for (const [id, entry] of Object.entries(state).filter(([, e]) => legacyPending(e)).slice(0, 10)) {
    try {
      const txnId = entry.creating?.id ?? entry.applied?.txnId ?? entry.fixedOnPage?.created;
      if (!txnId) throw new Error('The earlier transaction identity is unavailable. The records were kept.');
      await actual.syncNow();
      const row = await actual.findCreation(txnId);
      if (!row) {
        await patchEntry(id, (e) => ({ ...e, ...(e.creating ? { creating: { ...e.creating, absent: true } } : {}), error: 'The earlier purchase was not found. Preview offers a safe retry if nothing was created.' }));
        continue;
      }
      let summary = await nc.readSummary(entry.filedAs);
      if (!summary?.receipt && entry.fixedOnPage?.before?.filedAs && entry.fixedOnPage.before.filedAs !== entry.filedAs) summary = await nc.readSummary(entry.fixedOnPage.before.filedAs);
      if (!summary?.receipt) throw new Error('The earlier receipt reading is unavailable in both saved locations. The purchase in Actual was kept; no second purchase was created.');
      const labels = actual.idToLabel(await actual.categoryLabels());
      const t = row.t;
      const parts = (t.is_parent ? t.subtransactions ?? [] : [t]).map((part) => ({ category: labels.get(part.category) ?? (part.category ? 'Category unavailable' : 'Uncategorized'), amount: money(-part.amount), items: [] }));
      const action = t.is_parent ? 'split' : 'categorize';
      const review = /#review\b/.test(t.notes ?? '');
      const saved = { ...summary, transaction: { id: t.id, date: t.date, account: row.account.name, amount: money(-t.amount), payee: row.payeeName, createdByWorker: Boolean(entry.creating || entry.applied?.created) }, plan: { action, applied: true, parts }, problems: review ? ['An earlier saved purchase was recovered. Check it in Actual.'] : [], recoveredFromRecord: true };
      // Individual past item edits cannot be reconstructed from the written split. Keep this recovery read-only.
      const at = entry.applied?.at ?? entry.creating?.at ?? new Date().toISOString();
      let from = entry.filedAs;
      try { await nc.statPath(from); }
      catch (err) {
        if (err.status !== 404) throw err;
        const etag = id.slice(id.lastIndexOf('@') + 1).replaceAll('"', '');
        const name = path.basename(from);
        const listed = (await Promise.all([config.nextcloud.processed, config.nextcloud.review].map((folder) => nc.listFolder(folder, { names: (n) => n === name || n.endsWith(`-${name}`) })))).flat();
        const matching = listed.filter((f) => (f.basename === name || f.basename.endsWith(`-${name}`)) && String(f.etag).replaceAll('"', '') === etag);
        if (matching.length !== 1) throw new Error('The earlier photo location could not be identified safely. Its records were kept.');
        from = matching[0].filename;
      }
      const folder = review ? config.nextcloud.review : config.nextcloud.processed;
      const dest = path.join(folder, path.basename(entry.filedAs));
      await patchEntry(id, (e) => { const { creating, error, ...rest } = e; return { ...rest, filedAs: from, done: true, result: `${action}${review ? '+review' : ''}`, at, applied: { ...(e.applied ?? {}), txnId, action, at }, manualLink: { keep: true, recovered: true, at }, filing: { kind: 'page', from, dest, summary: saved } }; });
      await filePageSummary(id, { ...entry, filedAs: from }, dest, saved, nc);
    } catch (err) { await patchEntry(id, (e) => ({ ...e, error: `Recovery: ${err.message}` })); }
  }
}
