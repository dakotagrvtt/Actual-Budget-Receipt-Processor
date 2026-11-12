// Nextcloud folder names as the settings give them (RECEIPTS_INBOX=Receipts/Inbox) may lack the leading slash or end with one.
// One place for comparing them, so the panel and receipt-fix.js agree on "is this file in that folder".

/** A path without leading and trailing slashes. */
export const trimSlashes = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');

/** Is the file path p inside folder? Slashes at the ends of either are ignored. */
export const inFolder = (p, folder) => String(p ?? '').replace(/^\/+/, '').startsWith(`${trimSlashes(folder)}/`);

/**
 * Why the Archive folder can't be used next to the other receipts folders, or null. It may not be the same as one of them, inside
 * Processed or Needs review (a receipt there would count as filed in both), or hold the inbox, Processed or Needs review.
 * (Inside the inbox is allowed: the inbox is only listed, never searched below.)
 */
export function archiveFolderProblem({ inbox, processed, review, archive }) {
  const norm = (p) => String(p ?? '').split('/').filter((x) => x && x !== '.').join('/'); // // and /./ mean the same folder
  const a = norm(archive);
  if (!a) return `RECEIPTS_ARCHIVE (${archive}) can't be the root of your Nextcloud`;
  if (a.split('/').includes('..')) return `RECEIPTS_ARCHIVE (${archive}) can't contain ".."`;
  const within = (child, parent) => child === parent || child.startsWith(`${parent}/`);
  for (const [name, other] of [['inbox', inbox], ['Processed', processed], ['Needs review', review]]) {
    const o = norm(other);
    if (a === o) return `RECEIPTS_ARCHIVE (${archive}) can't be the same folder as the ${name} folder (${other})`;
    if (name !== 'inbox' && within(a, o)) return `RECEIPTS_ARCHIVE (${archive}) can't be inside the ${name} folder (${other})`;
    if (within(o, a)) return `RECEIPTS_ARCHIVE (${archive}) can't hold the ${name} folder (${other})`;
  }
  return null;
}
