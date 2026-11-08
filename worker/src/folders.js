// Nextcloud folder names as the settings give them (RECEIPTS_INBOX=Receipts/Inbox) may lack the leading slash or end with one.
// One place for comparing them, so the panel and receipt-fix.js agree on "is this file in that folder".

/** A path without leading and trailing slashes. */
export const trimSlashes = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');

/** Is the file path p inside folder? Slashes at the ends of either are ignored. */
export const inFolder = (p, folder) => String(p ?? '').replace(/^\/+/, '').startsWith(`${trimSlashes(folder)}/`);
