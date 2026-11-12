// Which status a receipt's state entry is in (done, applied-review, waiting, ...). Kept apart from the status page's HTML so the
// worker's archiving (archive-rules.js) and the pages use the very same classification.
import { config } from './config.js';
import { parseStateKey } from './state.js';
import { inFolder } from './folders.js';

/** Was the file filed under the Needs review folder (leading slashes ignored)? */
const filedInReview = (filedAs) => Boolean(filedAs) && inFolder(filedAs, config.nextcloud.review);

/** A result word split into whether it carries the dry run prefix and the word without it. */
export function splitResult(result) {
  const res = String(result ?? '');
  return { dryPrefix: res.startsWith('dry-run:'), base: res.replace(/^dry-run:/, '') };
}

/**
 * Which STATUS a list entry is in. An entry with `reviewed` (set from what the sweep or "Check Actual now" saw, see receipt-lists.js
 * withSeen) that would be "applied-review" is Done: #review is gone in Actual, whatever else was changed there.
 */
export function statusKind(r) {
  const kind = kindOf(r);
  return kind === 'applied-review' && r.reviewed ? 'done' : kind;
}

function kindOf(r) {
  if (r.fixedOnPage?.summaryFailed && !r.filing && !r.archived) return r.applied ? 'failed-applied' : 'failed';
  if (r.filing && !r.archived) return 'applying';
  if (r.resolutionPending && !r.archived) return 'review'; // an interrupted correction needs its save finished, not another worker check
  if (r.archived) return 'archived'; // filed away from the main list (archive.js); its result word still says how it was applied
  const { dryPrefix, base } = splitResult(r.result);
  const dry = parseStateKey(String(r.key ?? '')).dry || dryPrefix; // dry review/failed results carry no prefix; the key does
  if (!r.done) return r.waiting ? 'waiting' : r.applied ? 'applying' : dry ? 'preview-retrying' : 'retrying';
  if (dry) return base === 'failed' ? 'preview-failed' : base === 'review' ? 'preview-review' : 'preview';
  if (base === 'failed') return r.applied ? 'failed-applied' : 'failed';
  if (base === 'review') return r.applied ? 'applied-review' : 'review';
  if (base.endsWith('+review')) return 'applied-review';
  if (base === 'already-applied' && filedInReview(r.filedAs)) return 'applied-review'; // the charge's note carried #review
  return 'done';
}

