// The settings the status page's Settings tab may change, and nothing else: key, section, type, plain-words help and the default.
// Values are strings exactly as they would be written in .env, so they go through the same parsing in config.js.
// Left out on purpose (set in .env only): TRIGGER_TOKEN, TRIGGER_BIND, DRY_RUN (it has its own switch), ACTUAL_API_VERSION,
// the models, GPU, LLM_*, READER_*, DECIDER_*, providers and API keys, CLOUD_NAME_SCAN, PRIVATE_WORDS, PRIVATE_PLACES,
// OCCASIONS_CALENDAR(S), every *_PATH and *_DIR, COMPOSE_FILE and RENDER_GID.

export class SettingError extends Error {}

export const SECTIONS = [
  { id: 'connections', title: 'Connections' },
  { id: 'matching', title: 'Matching' },
  { id: 'categorizing', title: 'Categorizing' },
  { id: 'behaviour', title: 'Behaviour' },
  { id: 'holidays', title: 'Holidays and gift meals' },
  { id: 'keywords', title: 'Keywords and learning' },
];

// type: bool | number (min, max, int) | enum (values) | list | text | url | secret | folder
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

export const SETTINGS = [
  // --- Connections ---
  { key: 'ACTUAL_SERVER_URL', section: 'connections', label: 'Actual server address', type: 'url', required: true, default: '', help: 'The same address you open in the browser. For Actual on this same computer: http://host.docker.internal:5006' },
  { key: 'ACTUAL_PASSWORD', section: 'connections', label: 'Actual server password', type: 'secret', required: true, default: '', help: 'The server password you log in with.' },
  { key: 'ACTUAL_SYNC_ID', section: 'connections', label: 'Actual sync ID', type: 'text', required: true, pattern: UUID, patternText: 'looks like 1a2b3c4d-1234-5678-9abc-def012345678', default: '', help: 'In Actual: Settings, Show advanced settings, Sync ID. Changing it points the worker at a different budget.' },
  { key: 'ACTUAL_E2E_PASSWORD', section: 'connections', label: 'Actual encryption password', type: 'secret', default: '', help: 'Only if the budget uses end-to-end encryption.' },
  { key: 'NEXTCLOUD_URL', section: 'connections', label: 'Nextcloud address', type: 'url', required: true, default: '', help: 'The address you open Nextcloud at.' },
  { key: 'NEXTCLOUD_USER', section: 'connections', label: 'Nextcloud user', type: 'text', required: true, default: '', help: 'The Nextcloud user name the receipts folders belong to.' },
  { key: 'NEXTCLOUD_APP_PASSWORD', section: 'connections', label: 'Nextcloud app password', type: 'secret', required: true, default: '', help: 'In Nextcloud: Personal settings, Security, Create new app password.' },
  { key: 'RECEIPTS_INBOX', section: 'connections', label: 'Inbox folder', type: 'folder', required: true, default: '/Receipts/Inbox', help: 'Where you upload receipts.' },
  { key: 'RECEIPTS_PROCESSED', section: 'connections', label: 'Processed folder', type: 'folder', required: true, default: '/Receipts/Processed', help: 'Where receipts go once they are filed in Actual.' },
  { key: 'RECEIPTS_REVIEW', section: 'connections', label: 'Needs review folder', type: 'folder', required: true, default: '/Receipts/Needs review', help: 'Where receipts go when a person should look at them.' },

  // --- Matching ---
  { key: 'MATCH_ACCOUNTS', section: 'matching', label: 'Accounts to search', type: 'list', default: '', help: 'Accounts searched for the bank transaction a receipt belongs to (comma-separated names). Empty means all open, on-budget accounts.' },
  number('MATCH_DAYS', 'matching', 'Days the charge may post after the receipt', '4', 0, 60, 'How many days after the receipt date the bank transaction may post (it may also be dated 1 day before).', true),
  number('MATCH_NO_DATE_RECENT_DAYS', 'matching', 'Undated receipts: days back that are applied', '14', 0, 3650, 'A receipt with no readable date uses a charge in this many days before the upload; anything that moves money goes to review.', true),
  number('MATCH_NO_DATE_LOOKBACK_DAYS', 'matching', 'Undated receipts: days back that are listed', '365', 0, 3650, 'A charge found only further back than the days above, up to this many, is listed for review and never applied.', true),
  number('MATCH_RECHECK_MINUTES', 'matching', 'Minutes between re-checks of a waiting receipt', '60', 1, 10080, 'A receipt often arrives before its bank charge. It stays in the inbox and is checked again this often.', true),
  number('MATCH_PENDING_WAIT_DAYS', 'matching', 'Days to wait for a pending charge', '2', 0, 60, 'A matching charge the bank has not cleared yet is waited on this many days longer; after that it is applied and reviewed.', true),
  number('MATCH_TOLERANCE_PERCENT', 'matching', 'Charge may exceed the receipt by (%)', '0', 0, 100, 'Allow the charge to exceed the receipt total by this percent (for example 25 for restaurant tips).'),
  number('PAYEE_MIN_SCORE', 'matching', 'How well the payee must match (0 to 1)', '0.6', 0, 1, 'How closely the bank payee must match the receipt\'s merchant name. Higher is stricter.'),
  bool('OVERWRITE_CATEGORIZED', 'matching', 'Change a charge your rules already categorized', 'true', 'If a receipt points to one different category: on switches the charge to the receipt\'s category (only when an item is clearly sure), off sends it to review. Existing splits are never touched.'),
  bool('SPLIT_TRANSACTIONS', 'matching', 'Split a transaction by category', 'true', 'On splits a transaction by category when a receipt spans several; off uses the largest category only.'),
  number('SPLIT_MIN_AMOUNT', 'matching', 'Smallest split part (dollars)', '1', 0, 1000, 'Parts smaller than this (one $0.79 item) are folded into the transaction\'s current or largest category.'),

  // --- Categorizing ---
  { key: 'EXCLUDE_CATEGORY_GROUPS', section: 'categorizing', label: 'Excluded category groups', type: 'list', default: '', help: 'Whole groups receipts never go to (bills, debt, savings), comma-separated. The Categories tab has buttons for this too.' },
  { key: 'EXCLUDE_CATEGORIES', section: 'categorizing', label: 'Excluded categories', type: 'list', default: '', help: 'Single "Group / Category" labels receipts never go to, comma-separated. The Categories tab has buttons for this too.' },
  bool('STRIP_DEPARTMENT_PREFIXES', 'categorizing', 'Drop store department codes', 'true', 'Drop codes like "MED-" or "BED-" from item names before categorizing ("MED" reads as medical).'),
  bool('READ_PLAIN_NAMES', 'categorizing', 'Have the reader write items in plain words', 'false', 'Off by default: in testing it decoded "MED-CHILD PIC" (children\'s books) as "child milk".'),
  number('CATEGORY_MIN_CONFIDENCE', 'categorizing', 'Confidence needed for a category (0 to 1)', '0.5', 0, 1, 'The top category\'s probability. Items below this are unsure.'),
  bool('UNSURE_ITEMS_USE_STORE_CATEGORY', 'categorizing', 'Unsure items stay in the store\'s usual category', 'true', 'Items under the confidence bar stay in the store\'s usual category (from your Actual rules, or the transaction\'s) instead of becoming an Uncategorized part.'),
  number('MOVE_MIN_CONFIDENCE', 'categorizing', 'Confidence needed to move an item out (0 to 1)', '0.6', 0, 1, 'Needed to move an item out of the store\'s usual category. The default is 0.6, or the confidence bar above if that is higher.'),
  number('MOVE_MIN_MARGIN', 'categorizing', 'Lead needed to move an item out (0 to 1)', '0.2', 0, 1, 'An item\'s category must be ahead of the best other one by at least this much to move out. Stops near ties from moving money.'),
  bool('RECEIPT_CHECK', 'categorizing', 'Ask which category fits the whole purchase', 'true', 'One extra decider question per receipt (two or more items). A food-court visit can stay one category instead of splitting. Off uses per-item answers only.'),
  number('RECEIPT_CHECK_MIN_CONFIDENCE', 'categorizing', 'Confidence for the whole-purchase answer (0 to 1)', '0.5', 0, 1, 'How sure the whole-purchase answer must be to override items.'),
  bool('TAX_BY_ITEM', 'categorizing', 'Spread tax over the taxed items only', 'true', 'When the reader saw which items are taxed, only those pay the tax. Off spreads tax in proportion to the amounts.'),
  number('TAX_BY_ITEM_MAX_RATE', 'categorizing', 'Highest believable tax rate (0 to 1)', '0.12', 0, 1, 'Tax over the taxed items above this rate is spread in proportion to the amounts instead.'),
  bool('APPLY_THEN_REVIEW', 'categorizing', 'Apply the sure part, then review', 'true', 'On: when some items are unsure, still apply the confident part and send the receipt to Needs review. Off: change nothing and send it to review.'),
  number('HISTORY_DAYS', 'categorizing', 'Days of past purchases to learn from', '365', 1, 3650, 'How far back to look at past purchases at the same store.', true),
  number('HISTORY_LIMIT', 'categorizing', 'How many past purchases to learn from', '10', 1, 200, 'How many past purchases at the same store the decider sees.', true),
  bool('SIMILAR_ITEMS', 'categorizing', 'Show similar items from any store', 'true', 'Also show the decider how similar items from any store were filed before. On by default because it tested slightly better.'),
  number('HOUSEHOLD_EXAMPLES', 'categorizing', 'Household examples per category', '5', 0, 50, 'How many of your newest split notes per category the decider sees with every item. Fewer is faster. 0 sends none.', true),

  // --- Behaviour ---
  number('POLL_SECONDS', 'behaviour', 'Seconds between checks', '300', 60, 3600, 'How often the inbox is checked. The "Check for receipts now" button checks right away. At most an hour, so the container is not reported unhealthy.', true),
  { key: 'TRIGGER_TIMEZONE', section: 'behaviour', label: 'Time zone for this page', type: 'text', check: checkTimeZone, default: 'UTC', help: 'Time zone for times shown on this page, for example America/New_York.' },
  number('MAX_IMAGE_SIDE', 'behaviour', 'Longest side of a receipt photo (pixels)', '2240', 500, 8000, 'Receipts are downscaled to this many pixels on the long side before the reader sees them.', true),

  // --- Holidays and gift meals ---
  bool('OCCASIONS', 'holidays', 'Show holidays to the decider', 'true', 'Holidays near the purchase date (Valentine\'s, Easter, Mother\'s and Father\'s Day, Halloween, Thanksgiving, Christmas) are shown to the decider as a gift hint. These are US holidays.'),
  number('OCCASION_DAYS_BEFORE', 'holidays', 'Days before a holiday that count', '14', 0, 60, 'A purchase up to this many days before a holiday counts as near it.', true),
  number('OCCASION_DAYS_AFTER', 'holidays', 'Days after a holiday that count', '2', 0, 60, 'A purchase up to this many days after a holiday counts as near it.', true),
  number('GIFT_MEAL_MIN', 'holidays', 'Restaurant charge that goes to review (dollars)', '50', 0, 100000, 'A restaurant charge over this many dollars goes to review (it may be a gift meal or need splitting). 0 is off.'),
  { key: 'RESTAURANT_CATEGORY', section: 'holidays', label: 'Restaurants category', type: 'text', default: 'Daily Expenses / Restaurants', help: 'The "Group / Category" label that counts as restaurants for the gift meal check.' },

  // --- Keywords and learning ---
  { key: 'KEYWORD_MODE', section: 'keywords', label: 'Keyword mode', type: 'enum', values: ['off', 'final', 'hint', 'mixed'], default: 'mixed', help: 'mixed (recommended): "always" keywords skip the model, "usually" ones are hints. final: every match skips the model. hint: every match is a hint. off: keywords are ignored.' },
  number('KEYWORD_HINT_WEIGHT', 'keywords', 'Weight of a "usually" keyword', '20', 1, 1000, 'Multiplies the keyword category\'s probability by this (1 tells the model only; 4 and 20 scored the same in testing).'),
  { key: 'LEARNING', section: 'keywords', label: 'Learning from your corrections', type: 'enum', values: ['on', 'record', 'off'], default: 'on', help: 'on: learn from category changes you make in Actual and use it. record: learn but do not use it yet (to compare). off: no learning at all.' },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
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
    if (def.type === 'list' || (def.type === 'secret' && !def.required)) return '';
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
      return address;
    }
    case 'folder': {
      if (!v.startsWith('/')) throw new SettingError(`${name}: must start with / (for example /Receipts/Inbox).`);
      if (v.split('/').includes('..')) throw new SettingError(`${name}: can't contain "..".`);
      return v.replace(/\/+$/, '') || '/';
    }
    case 'secret':
      return v;
    default: // text
      if (def.pattern && !def.pattern.test(v)) throw new SettingError(`${name}: ${def.patternText ?? 'is not in the expected form'}.`);
      if (def.check && v) {
        const problem = def.check(v);
        if (problem) throw new SettingError(`${name}: "${v.slice(0, 80)}" ${problem}`);
      }
      return v;
  }
}
