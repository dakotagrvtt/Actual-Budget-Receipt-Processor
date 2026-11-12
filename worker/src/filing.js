// Page saves keep the intended summary until Nextcloud confirms it. The worker resumes these records independently of Inbox.
import { patchEntry } from './state.js';
export async function finishPageFiling(id, entry, nc) {
  const intent = entry.filing;
  if (!intent) return entry.filedAs;
  const checkpoint = async (next) => { await patchEntry(id, (e) => ({ ...e, filing: next })); };
  try {
    const where = await nc.refile(intent.from, intent.dest, intent.summary, { intent, checkpoint });
    await patchEntry(id, (e) => {
      const { filing: _done, error: _oldError, ...rest } = e;
      if (rest.fixedOnPage?.summaryFailed) { rest.fixedOnPage = { ...rest.fixedOnPage }; delete rest.fixedOnPage.summaryFailed; }
      return { ...rest, filedAs: where };
    });
    return where;
  } catch (err) {
    if (err.movedTo) await patchEntry(id, (e) => ({ ...e, filedAs: err.movedTo, filing: { ...e.filing, to: err.movedTo } }));
    throw err;
  }
}
export async function filePageSummary(id, entry, dest, summary, nc) {
  const filing = { kind: 'page', from: entry.filedAs, dest, summary };
  await patchEntry(id, (e) => ({ ...e, filing }));
  return finishPageFiling(id, { ...entry, filing }, nc);
}
