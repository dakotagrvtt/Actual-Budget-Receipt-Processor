// The settings the status page's Settings tab may change, and nothing else: key, section, type, plain-words help and the default.
// Values are strings exactly as they would be written in .env, so they go through the same parsing in config.js.
// Left out on purpose (set in .env only): TRIGGER_TOKEN, TRIGGER_BIND, DRY_RUN (it has its own switch), ACTUAL_API_VERSION,
// the models, GPU, LLM_*, READER_*, DECIDER_*, providers and API keys, CLOUD_NAME_SCAN, PRIVATE_WORDS, PRIVATE_PLACES,
// OCCASIONS_CALENDAR(S), every *_PATH and *_DIR, COMPOSE_FILE and RENDER_GID.

import { knownAccounts } from './known-accounts.js';

export class SettingError extends Error {}

export const SECTIONS = [
  { id: 'connections', title: 'Connections and folders' },
  { id: 'matching', title: 'Accounts and splitting' },
  { id: 'categorizing', title: 'Review decisions' },
  { id: 'behaviour', title: 'Schedule and display' },
  { id: 'holidays', title: 'Holidays and gift meals' },
  { id: 'keywords', title: 'Keywords and learning' },
];

// type: bool | number (min, max, int) | enum (values) | list | text | url | secret | folder | account (one of Actual's open accounts, or empty)
// `storage: 'nextcloud'`: only used (and shown) with Nextcloud storage. `localDefault`: the default with STORAGE=local (config.js defaultFolders).
// `required`: may not be empty. `pattern`/`check`: extra rules for text. `secret`: shown only as set / not set, never as a value.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkTimeZone(v) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return null;
  } catch {
    return 'is not a time zone name (for example America/New_York or UTC)';
  }
}

const bool = (key, section, label, dflt, help) => ({ key, section, label, type: 'bool', default: dflt, help });
const number = (key, section, label, dflt, min, max, help, int = false) => ({ key, section, label, type: 'number', default: dflt, min, max, int, help });

// Advanced settings sit under "Advanced" on the Settings tab: tuning that most people never need to touch.
const adv = (def) => ({ ...def, advanced: true });

export const SETTINGS = [
  // --- Connections ---
  { key: 'ACTUAL_SERVER_URL', section: 'connections', label: 'Actual server address', type: 'url', required: true, default: '', help: 'The same address you open in the browser. For Actual on this same computer: http://host.docker.internal:5006' },
  { key: 'ACTUAL_LINK_URL', section: 'connections', label: 'Actual address for links', type: 'url', rebuild: true, default: '', help: 'The address your browser uses to open Actual, for the "Open in Actual" links. Empty uses the Actual server address above. Only http:// and https:// addresses work.' },
  { key: 'ACTUAL_PASSWORD', section: 'connections', label: 'Actual server password', type: 'secret', required: true, default: '', help: 'The server password you log in with.' },
  { key: 'ACTUAL_SYNC_ID', section: 'connections', label: 'Actual sync ID', type: 'text', required: true, pattern: UUID, patternText: 'looks like 1a2b3c4d-1234-5678-9abc-def012345678', default: '', help: 'In Actual: Settings, Show advanced settings, Sync ID. Changing it points the worker at a different budget.' },
  { key: 'ACTUAL_E2E_PASSWORD', section: 'connections', label: 'Actual encryption password', type: 'secret', default: '', help: 'Only if the budget uses end-to-end encryption.' },
  { key: 'NEXTCLOUD_URL', section: 'connections', storage: 'nextcloud', label: 'Nextcloud address', type: 'url', required: true, default: '', help: 'The address you open Nextcloud at. A new address for the same account is recognized by itself (the storage marker). Another server pauses receipt processing until you run ./receipts migrate-storage to copy the receipts there.' },
  { key: 'NEXTCLOUD_USER', section: 'connections', storage: 'nextcloud', label: 'Nextcloud user', type: 'text', required: true, default: '', help: 'The Nextcloud user name the receipts folders belong to. A new login spelling of the same account is recognized by itself (the storage marker). Another account pauses processing until you run ./receipts migrate-storage to copy the receipts there.' },
  { key: 'NEXTCLOUD_APP_PASSWORD', section: 'connections', storage: 'nextcloud', label: 'Nextcloud app password', type: 'secret', required: true, default: '', help: 'In Nextcloud: Personal settings, Security, Create new app password.' },
  { key: 'RECEIPTS_INBOX', section: 'connections', label: 'Inbox folder', type: 'folder', required: true, default: '/Receipts/Inbox', localDefault: '/Inbox', help: 'Where you upload receipts. Changing a receipt folder pauses processing until ./receipts migrate-storage moves the files.' },
  { key: 'RECEIPTS_PROCESSED', section: 'connections', label: 'Processed folder', type: 'folder', required: true, default: '/Receipts/Processed', localDefault: '/Processed', help: 'Where receipts go once they are filed in Actual.' },
  { key: 'RECEIPTS_REVIEW', section: 'connections', label: 'Needs review folder', type: 'folder', required: true, default: '/Receipts/Needs review', localDefault: '/Needs review', help: 'Where receipts go when a person should look at them.' },
  { key: 'RECEIPTS_ARCHIVE', section: 'connections', label: 'Archive folder', type: 'folder', required: true, default: '/Receipts/Archive', localDefault: '/Archive', help: 'Where receipts you have checked are moved to when you archive them (in a folder per month). It can\'t be the same as, or inside, the Processed or Needs review folder.' },

  // --- Matching ---
  { key: 'CASH_ACCOUNT', section: 'matching', label: 'Cash purchases go to', type: 'account', default: '', help: 'The Actual account that "Create in Actual" puts a cash purchase in (a cash receipt\'s page can pick another one for that receipt). Empty means not set. The list is what Actual had at the last check.' },
  { key: 'MATCH_ACCOUNTS', section: 'matching', label: 'Accounts to search', type: 'list', default: '', help: 'Only look for a receipt\'s bank charge in these accounts (names, separated by commas). Empty searches every open account that is in your budget.' },
  adv(number('MATCH_DAYS', 'matching', 'Days the charge may post after the receipt', '4', 0, 60, 'A bank charge can post a few days after the purchase. Raise this if charges often show up later than that; lower it to avoid matching the wrong charge.', true)),
  adv(number('MATCH_NO_DATE_RECENT_DAYS', 'matching', 'Undated receipts: days back that are applied', '14', 0, 3650, 'For a receipt with no readable date: how many days before the upload to look for its charge. A match here is doubtful: if the receipt would change the charge\'s category or split it, it goes to review (applied first if Apply then review is on). A receipt that only confirms the category is not reviewed for this.', true)),
  adv(number('MATCH_NO_DATE_LOOKBACK_DAYS', 'matching', 'Undated receipts: days back that are listed', '365', 0, 3650, 'For a receipt with no readable date: charges further back than the setting above, up to this many days, are only listed for you to check. Nothing is applied.', true)),
  adv(number('MATCH_NO_DATE_EXTENDED_DAYS', 'matching', 'Undated receipts: days back for a lone exact match', '120', 0, 3650, 'For a receipt with no readable date and no recent charge: once the wait is over, accept an older charge up to this many days back, but only if exactly one charge has the exact amount and a fitting payee. It is always reviewed. 0 turns this off. Must be more than the first undated setting and at most the second.', true)),
  adv(number('MATCH_RECHECK_MINUTES', 'matching', 'Minutes between re-checks of a waiting receipt', '60', 1, 10080, 'A receipt often arrives before its bank charge. It stays in the Inbox and is checked again this often. Lower notices the charge sooner but does more work.', true)),
  adv(number('MATCH_PENDING_WAIT_DAYS', 'matching', 'Days to wait for a pending charge', '2', 0, 60, 'A charge the bank has not finished yet (pending) is waited on this many extra days. After that anything that would change the charge, even just adding a note, goes to review (applied first if Apply then review is on).', true)),
  adv(number('MATCH_TOLERANCE_PERCENT', 'matching', 'Charge may exceed the receipt by (%)', '0', 0, 100, 'Let the bank charge be this much higher than the receipt total, in percent, for example 25 when tips are added after the receipt. 0 means the amounts must match exactly.')),
  adv(number('PAYEE_MIN_SCORE', 'matching', 'How well the payee must match (0 to 1)', '0.6', 0, 1, 'How closely the bank\'s payee name must look like the store name on the receipt, from 0 (anything) to 1 (identical). Higher is stricter: fewer wrong matches, more receipts in review.')),
  bool('OVERWRITE_CATEGORIZED', 'matching', 'Change a charge your rules already categorized', 'true', 'When your Actual rules already put a charge in one category and the receipt clearly says another: on changes it, off sends the receipt to review. Charges that are already split are never touched.'),
  bool('SPLIT_TRANSACTIONS', 'matching', 'Split a transaction by category', 'true', 'On: a charge with items from several categories is split into them. Off: an uncategorized charge goes whole to the biggest category, with the breakdown in a note; a charge that already has a category keeps it and only gets the breakdown note.'),
  number('SPLIT_MIN_AMOUNT', 'matching', 'Smallest split part (dollars)', '1', 0, 1000, 'Split parts smaller than this many dollars (say one 79-cent item) are folded into the charge\'s main category instead of getting their own line. Raise it for fewer, bigger splits.'),

  // --- Categorizing ---
  adv({ key: 'EXCLUDE_CATEGORY_GROUPS', section: 'categorizing', label: 'Excluded category groups', type: 'list', default: '', help: 'Whole groups receipts never go to (bills, debt, savings), comma-separated. The Categories tab has buttons for this too.' }),
  adv({ key: 'EXCLUDE_CATEGORIES', section: 'categorizing', label: 'Excluded categories', type: 'list', default: '', help: 'Single "Group / Category" labels receipts never go to, comma-separated. The Categories tab has buttons for this too.' }),
  adv(bool('STRIP_DEPARTMENT_PREFIXES', 'categorizing', 'Drop store department codes', 'true', 'Drop codes like "MED-" or "BED-" from item names before categorizing ("MED" reads as medical).')),
  adv(bool('READ_PLAIN_NAMES', 'categorizing', 'Have the reader write items in plain words', 'false', 'Ask the reader to rewrite item names in plain words. Off is safer: in testing it turned "MED-CHILD PIC" (children\'s books) into "child milk".')),
  adv(number('CATEGORY_MIN_CONFIDENCE', 'categorizing', 'Confidence needed for a category (0 to 1)', '0.5', 0, 1, 'How sure the worker must be (0 to 1) before it files an item in a category; less sure items count as unsure. Higher means more unsure items and more reviews.')),
  adv(bool('UNSURE_ITEMS_USE_STORE_CATEGORY', 'categorizing', 'Unsure items stay in the store\'s usual category', 'true', 'Items under the confidence bar stay in the store\'s usual category (from your Actual rules, or the transaction\'s) instead of becoming an Uncategorized part.')),
  adv(number('MOVE_MIN_CONFIDENCE', 'categorizing', 'Confidence needed to move an item out (0 to 1)', '0.6', 0, 1, 'How sure the worker must be (0 to 1) to move an item out of the store\'s usual category. If the setting above is higher, that one is used. Higher keeps more items where they are.')),
  adv(number('MOVE_MIN_MARGIN', 'categorizing', 'Lead needed to move an item out (0 to 1)', '0.2', 0, 1, 'An item\'s best category must lead the runner-up by at least this much (0 to 1) before the item is moved. Higher stops near-ties from moving money.')),
  adv(bool('RECEIPT_CHECK', 'categorizing', 'Ask which category fits the whole purchase', 'true', 'One extra decider question per receipt (two or more items). A food-court visit can stay one category instead of splitting. Off uses per-item answers only.')),
  adv(number('RECEIPT_CHECK_MIN_CONFIDENCE', 'categorizing', 'Confidence for the whole-purchase answer (0 to 1)', '0.5', 0, 1, 'How sure the whole-purchase answer must be (0 to 1) to override the per-item answers. Higher means it overrides less often.')),
  adv(bool('TAX_BY_ITEM', 'categorizing', 'Spread tax over the taxed items only', 'true', 'When the reader saw which items are taxed, only those pay the tax. Off spreads tax in proportion to the amounts.')),
  adv(number('TAX_BY_ITEM_MAX_RATE', 'categorizing', 'Highest believable tax rate (0 to 1)', '0.12', 0, 1, 'If the tax on the taxed items works out above this rate (0.12 is 12%), the reading looks doubtful, so tax is spread over all items in proportion instead.')),
  bool('APPLY_THEN_REVIEW', 'categorizing', 'Apply the sure part, then review', 'true', 'On: when some items are unsure, still apply the confident part and send the receipt to Needs review. Off: change nothing and send it to review.'),
  adv(number('HISTORY_DAYS', 'categorizing', 'Days of past purchases to learn from', '365', 1, 3650, 'How many days back the worker looks at your past purchases at the same store to see how you filed them. Longer sees more history.', true)),
  adv(number('HISTORY_LIMIT', 'categorizing', 'How many past purchases to learn from', '10', 1, 200, 'How many past purchases at the same store it looks at. More gives more context but is slower.', true)),
  adv(bool('SIMILAR_ITEMS', 'categorizing', 'Show similar items from any store', 'true', 'Also show the decider how similar items from any store were filed before. On by default because it tested slightly better.')),
  adv(number('HOUSEHOLD_EXAMPLES', 'categorizing', 'Household examples per category', '5', 0, 50, 'How many of your newest split notes per category the decider sees with every item. Fewer is faster. 0 sends none.', true)),

  // --- Behaviour ---
  number('POLL_SECONDS', 'behaviour', 'Seconds between checks', '300', 60, 3600, 'How often the Inbox is checked for new receipts. Lower picks them up sooner; "Check now" checks right away. An hour at most, so Docker does not report the container unhealthy.', true),
  { key: 'TRIGGER_TIMEZONE', section: 'behaviour', label: 'Time zone for this page', type: 'text', check: checkTimeZone, default: 'UTC', help: 'Time zone for times shown on this page, for example America/New_York.' },
  adv(number('MAX_IMAGE_SIDE', 'behaviour', 'Longest side of a receipt photo (pixels)', '2240', 500, 8000, 'Photos are shrunk to this many pixels on the long side before the reader looks at them. Larger can read small print better but is slower.', true)),

  adv(number('ARCHIVE_AFTER_DAYS', 'behaviour', 'Archive done receipts after (days)', '0', 0, 3650, 'A receipt that is Done (nothing left for you to check) is moved to the Archive folder by itself once it is this many days old. 0 turns this off: then receipts are only archived when you press a button. Receipts that still need a look in Actual are never archived by themselves.', true)),
  adv(bool('ARCHIVE_SHRINK_PHOTOS', 'behaviour', 'Shrink photos when archiving', 'true', 'Archived photos are saved again as a smaller JPEG (at most 2400 pixels on the long side), and only if that saves at least 10%. This cannot be undone for the photo: Restore brings back the smaller picture, not the original. PDFs are never changed. Off moves the photo as it is.')),

  // --- Holidays and gift meals ---
  bool('OCCASIONS', 'holidays', 'Show holidays to the decider', 'true', 'Tell the decider when a purchase is near a US holiday (Valentine\'s, Easter, Mother\'s and Father\'s Day, Halloween, Thanksgiving, Christmas), so it can tell gifts from everyday buys.'),
  adv(number('OCCASION_DAYS_BEFORE', 'holidays', 'Days before a holiday that count', '14', 0, 60, 'How many days before a holiday a purchase still counts as near it.', true)),
  adv(number('OCCASION_DAYS_AFTER', 'holidays', 'Days after a holiday that count', '2', 0, 60, 'How many days after a holiday a purchase still counts as near it.', true)),
  number('GIFT_MEAL_MIN', 'holidays', 'Restaurant charge that goes to review (dollars)', '50', 0, 100000, 'A restaurant charge over this many dollars is sent to review, since it may be a gift meal or need splitting. 0 turns this off.'),
  adv({ key: 'RESTAURANT_CATEGORY', section: 'holidays', label: 'Restaurants category', type: 'text', default: 'Daily Expenses / Restaurants', help: 'The "Group / Category" label that counts as restaurants for the gift meal check.' }),

  // --- Keywords and learning ---
  adv({ key: 'KEYWORD_MODE', section: 'keywords', label: 'Keyword mode', type: 'enum', values: ['off', 'final', 'hint', 'mixed'], default: 'mixed', help: 'mixed (recommended): "always" keywords skip the model, "usually" ones are hints. final: every match skips the model. hint: every match is a hint. off: keywords are ignored.' }),
  adv(number('KEYWORD_HINT_WEIGHT', 'keywords', 'Weight of a "usually" keyword', '20', 1, 1000, 'How strongly a "usually" keyword pulls toward its category. Higher is stronger; 1 only tells the model about it (4 and 20 scored the same in testing).')),
  adv({ key: 'LEARNING', section: 'keywords', label: 'Learning from your corrections', type: 'enum', values: ['on', 'record', 'off'], default: 'on', help: 'on: learn from category changes you make in Actual and use it. record: learn but do not use it yet (to compare). off: no learning at all.' }),
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
/** Is the setting used with this storage (local: STORAGE=local)? The Nextcloud login is not, with a local folder. */
export const usedWith = (def, local) => !(local && def.storage === 'nextcloud');
/** The built-in default with this storage. */
export const defaultWith = (def, local) => (local && def.localDefault !== undefined ? def.localDefault : def.default);
export const isSecret = (key) => SETTINGS_BY_KEY.get(key)?.type === 'secret';
/** Keys that look like settings but are .env-only: the page says so instead of just "unknown". */
export const ENV_ONLY_NOTE = 'That setting can only be changed in .env (then ./receipts restart).';

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

/**
 * Check a typed value the way config.js will read it, and return it in the form written to the overrides file.
 * Throws SettingError with a plain message (never containing a secret) when it is not acceptable.
 */
export function normalizeValue(def, raw) {
  const name = def.label;
  const text = String(raw ?? '');
  if (/[\r\n\0]/.test(text)) throw new SettingError(`${name}: must be on one line.`);
  const v = def.type === 'secret' ? text : text.trim();
  if (v === '') {
    if (def.type === 'list' || (def.type === 'url' && !def.required) || def.type === 'account' || (def.type === 'secret' && !def.required)) return '';
    throw new SettingError(def.type === 'number' ? `${name}: type a number.` : `${name}: can't be empty.`);
  }
  if (v.length > 500) throw new SettingError(`${name}: is too long.`);
  switch (def.type) {
    case 'bool': {
      const w = v.toLowerCase();
      if (TRUE_WORDS.includes(w)) return 'true';
      if (FALSE_WORDS.includes(w)) return 'false';
      throw new SettingError(`${name}: must be on or off.`);
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new SettingError(`${name}: "${v.slice(0, 40)}" is not a number.`);
      if (def.int && !Number.isInteger(n)) throw new SettingError(`${name}: must be a whole number.`);
      if (n < def.min || n > def.max) throw new SettingError(`${name}: must be between ${def.min} and ${def.max}.`);
      return String(n);
    }
    case 'enum': {
      const w = v.toLowerCase();
      if (!def.values.includes(w)) throw new SettingError(`${name}: must be one of ${def.values.join(', ')}.`);
      return w;
    }
    case 'list':
      return v.split(',').map((s) => s.trim()).filter(Boolean).join(',');
    case 'url': {
      const address = v.replace(/\/+$/, '');
      const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${address}`;
      let u;
      try {
        u = new URL(full);
      } catch {
        throw new SettingError(`${name}: "${v.slice(0, 80)}" is not a web address.`);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SettingError(`${name}: must start with http:// or https://.`);
      if (u.username || u.password) throw new SettingError(`${name}: don't put a user name or password in the address.`);
      if (def.rebuild) return `${u.origin}${u.pathname}`.replace(/\/+$/, ''); // origin + path only: no query, fragment or odd escapes
      return address;
    }
    case 'folder': {
      if (!v.startsWith('/')) throw new SettingError(`${name}: must start with / (for example /Receipts/Inbox).`);
      if (v.split('/').includes('..')) throw new SettingError(`${name}: can't contain "..".`);
      return v.replace(/\/+$/, '') || '/';
    }
    case 'secret':
      return v;
    case 'account': {
      // One of the open accounts Actual had at the last check; before the first check the list is not known, so any name is accepted.
      const known = knownAccounts();
      if (known.length && !known.some((a) => a.name === v)) throw new SettingError(`${name}: "${v.slice(0, 80)}" is not one of your open accounts in Actual.`);
      return v;
    }
    default: // text
      if (def.pattern && !def.pattern.test(v)) throw new SettingError(`${name}: ${def.patternText ?? 'is not in the expected form'}.`);
      if (def.check && v) {
        const problem = def.check(v);
        if (problem) throw new SettingError(`${name}: "${v.slice(0, 80)}" ${problem}`);
      }
      return v;
  }
}
