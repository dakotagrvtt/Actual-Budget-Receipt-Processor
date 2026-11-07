// Every setting, read once from the environment (.env via compose) at import time and exported as `config`.
// Invalid values either throw at startup (missing required keys, non-numbers) or warn and fall back to a safe default.
// Helpers (bool, num, list, url...) come first, then the provider checks, then the `config` object grouped by topic.
const env = process.env;

function required(key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required setting ${key} (see .env.example)`);
  return value;
}
/** required() for a setting that is trimmed; blank counts as missing. */
function requiredTrimmed(key) {
  if (!(env[key] ?? '').trim()) throw new Error(`Missing required setting ${key} (see .env.example)`);
  return env[key].trim();
}
// true/false/1/0/yes/no/on/off, any case. Anything else (a typo) warns and uses the default, so it can't silently
// flip a switch such as DRY_RUN.
const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];
function bool(key, dflt) {
  if (env[key] === undefined) return dflt;
  const word = env[key].trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  console.warn(`${new Date().toISOString()} ${key}="${env[key]}" is not true or false; using the default (${dflt})`);
  return dflt;
}
function num(key, dflt) {
  const value = Number(env[key] ?? dflt);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

// Comma-separated list setting: trimmed, empties dropped.
const list = (key) => (env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// A URL setting without trailing slashes. No default = required.
const url = (key, dflt) => (dflt === undefined ? required(key) : (env[key] ?? dflt)).replace(/\/+$/, '');

const KEYWORD_MODES = ['off', 'final', 'hint', 'mixed'];
function keywordMode() {
  const mode = (env.KEYWORD_MODE ?? 'mixed').trim().toLowerCase();
  if (KEYWORD_MODES.includes(mode)) return mode;
  console.warn(`${new Date().toISOString()} KEYWORD_MODE="${env.KEYWORD_MODE}" is not one of ${KEYWORD_MODES.join('|')}; keywords are off`);
  return 'off';
}

// LEARNING: on (learn from your corrections in Actual and use it) | record (learn, but don't use it: for evaluation) | off.
const LEARNING_MODES = ['on', 'record', 'off'];
function learningMode() {
  const mode = (env.LEARNING ?? 'on').trim().toLowerCase();
  if (LEARNING_MODES.includes(mode)) return mode;
  console.warn(`${new Date().toISOString()} LEARNING="${env.LEARNING}" is not one of ${LEARNING_MODES.join('|')}; using on`);
  return 'on';
}

const DECIDER_PROVIDERS = ['local', 'remote'];
function deciderProvider() {
  const provider = (env.DECIDER_PROVIDER ?? 'local').trim().toLowerCase();
  if (DECIDER_PROVIDERS.includes(provider)) return provider;
  console.warn(`${new Date().toISOString()} DECIDER_PROVIDER="${env.DECIDER_PROVIDER}" is not one of ${DECIDER_PROVIDERS.join('|')}; using the local decider`);
  return 'local';
}
const remoteDecider = deciderProvider() === 'remote';

/** A hosted address (DECIDER_URL, READER_URL) must be https; plain http is only for a server on this machine. Throws otherwise. */
export function checkRemoteUrl(address, name = 'DECIDER_URL') {
  let u;
  try {
    u = new URL(address);
  } catch {
    throw new Error(`${name} "${address}" is not a web address`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`${name} must start with https:// (plain http would send your requests and API key unencrypted; http is only accepted for localhost, 127.0.0.1 and ::1)`);
  }
  return address;
}

/**
 * READER_URL as the API base, without a trailing / or /chat/completions. /v1 is added only when the address has no path at
 * all (https://api.openai.com): any path that was typed is the provider's own (.../v1, .../api/v1, .../v1beta/openai) and stays.
 */
export function readerBase(address) {
  const a = String(address).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
  let path = '';
  try {
    path = new URL(a).pathname;
  } catch { /* checkRemoteUrl has already refused anything that is not a web address */ }
  return path === '' || path === '/' ? `${a}/v1` : a;
}

// READER_PROVIDER: local (the llm service, the default) | remote (a cloud vision model with your own OpenAI or OpenRouter key).
const READER_PROVIDERS = ['local', 'remote'];
function readerProvider() {
  const provider = (env.READER_PROVIDER ?? 'local').trim().toLowerCase();
  if (READER_PROVIDERS.includes(provider)) return provider;
  console.warn(`${new Date().toISOString()} READER_PROVIDER="${env.READER_PROVIDER}" is not one of ${READER_PROVIDERS.join('|')}; using the local reader`);
  return 'local';
}
// The local reader's display name when LLM_NAME is not set: the model name from READER_LOCAL_MODEL ("org/Name-GGUF:Q4_K_M" gives
// "Name"), or the default model's name.
function localReaderName(setting) {
  const repo = String(setting ?? '').trim().split(':')[0];
  const name = repo.slice(repo.lastIndexOf('/') + 1).replace(/[-_.]?GGUF$/i, '');
  return name || 'Qwen3.5-4B';
}

const remoteReader = readerProvider() === 'remote';
const readerUrl = remoteReader ? readerBase(checkRemoteUrl(requiredTrimmed('READER_URL'), 'READER_URL')) : '';
const readerModel = remoteReader ? requiredTrimmed('READER_MODEL') : '';
const readerHost = remoteReader ? new URL(readerUrl).host : '';

// The hosted decider's name and place scan (name-scan.js) goes through the reader, so a cloud reader would get the raw
// receipt text that anonymizing is meant to keep from leaving this machine. Both hosted is refused unless you opt in.
const cloudNameScan = bool('CLOUD_NAME_SCAN', false);
if (remoteReader && remoteDecider && !cloudNameScan) {
  throw new Error('DECIDER_PROVIDER=remote together with READER_PROVIDER=remote would send the raw receipt text (item lines, store names, amounts) to the reader\'s provider for the name and place scan, before anonymizing. Use the local reader or the local decider, or set CLOUD_NAME_SCAN=true to accept that');
}

// CATEGORIZER is not a setting any more (the decider is the only categorizer): warn if .env still sets something else.
if (env.CATEGORIZER && !['d1', 'decider'].includes(env.CATEGORIZER.trim().toLowerCase())) {
  console.warn(`${new Date().toISOString()} CATEGORIZER="${env.CATEGORIZER}" is no longer used: the categorizer is always the decider (remove it from .env)`);
}

const envDryRun = bool('DRY_RUN', true);

export const config = {
  // --- Worker loop and files under /data ---
  // dryRun is what the worker acts on. It starts as the .env value; once data/settings.json exists it is the switch
  // (settings.js), re-read at the start of every poll cycle.
  dryRun: envDryRun,
  envDryRun,
  settingsPath: env.SETTINGS_PATH ?? '/data/settings.json',
  pollSeconds: num('POLL_SECONDS', 300),
  statePath: '/data/state.json',
  // Touched every poll and after each receipt; the container healthcheck reads its age.
  heartbeatPath: '/data/heartbeat',
  // A setup problem that pauses the checks (alert.js): the status page shows it as a banner.
  alertPath: env.ALERT_PATH ?? '/data/worker-alert.json',
  // Web page + webhook to check the inbox on demand (see trigger.js). Off unless TRIGGER_TOKEN is set.
  trigger: { token: (env.TRIGGER_TOKEN ?? '').trim(), timeZone: env.TRIGGER_TIMEZONE || 'UTC' },

  // --- Reader (vision model) ---
  maxImageSide: num('MAX_IMAGE_SIDE', 2240),
  llmUrl: url('LLM_URL', 'http://llm:8080'),
  // Which vision model is reading (shown in logs), and optional sampling overrides as JSON, for trying other models.
  llmName: remoteReader ? `${readerModel} (remote: ${readerHost})` : env.LLM_NAME || localReaderName(env.READER_LOCAL_MODEL),
  llmSampling: env.LLM_SAMPLING ? JSON.parse(env.LLM_SAMPLING) : null,
  llmThinking: bool('LLM_THINKING', false), // Qwen3.5-4B: thinking off read as well in testing, 2.4x faster
  // Ask the reader to also write each item in plain words. Off: in testing it decoded "MED-CHILD PIC" as "child milk".
  plainNames: bool('READ_PLAIN_NAMES', false),
  // READER_PROVIDER=remote: the receipt photo goes to a cloud vision model (llm.js). The key is never logged or shown.
  // LLM_URL, LLM_NAME, LLM_THINKING and the sleep/wake of the llm service only apply to the local reader (a remote one uses only
  // LLM_SAMPLING's temperature).
  reader: {
    provider: remoteReader ? 'remote' : 'local',
    url: readerUrl, // ends in /v1; chat goes to <url>/chat/completions
    host: readerHost,
    apiKey: remoteReader ? requiredTrimmed('READER_API_KEY') : '',
    model: readerModel,
  },

  // --- Decider (picks a category per item) ---
  // A /v1/systemone server (DECIDER_MODEL on the decider-gguf service)
  deciderModel: env.DECIDER_MODEL ?? 'LiquidAI/d1-2B-GGUF:Q8_0',
  // Local: the decider-gguf service (D1_GGUF_URL, which compose.yaml sets). Remote: DECIDER_URL, so a DECIDER_URL left in
  // .env can never redirect the local decider.
  deciderUrl: remoteDecider ? checkRemoteUrl(url('DECIDER_URL', 'https://api.typesafe.ai')) : url('D1_GGUF_URL', 'http://decider-gguf:8080'),
  // DECIDER_PROVIDER=remote: TypeSafe's hosted Jev, anonymized (decider-remote.js, anonymize.js). The key is never logged or shown.
  decider: {
    provider: remoteDecider ? 'remote' : 'local',
    apiKey: remoteDecider ? required('DECIDER_API_KEY').trim() : '',
    remoteModel: (env.DECIDER_REMOTE_MODEL || 'jev-latest').trim(),
    preview: null, // replay --preview-remote <dir>: write the anonymized requests there, send nothing
    previewLabel: '',
  },
  // Anonymizing for the remote decider: people's names found by the reader, and the household's own word list.
  privacy: {
    wordsPath: env.PRIVATE_WORDS_PATH ?? '/data/private-words.json',
    scanCachePath: env.NAME_SCAN_CACHE_PATH ?? '/data/name-scan-cache.json',
    seedWords: list('PRIVATE_WORDS'),
    seedPlaces: list('PRIVATE_PLACES'), // your town, street...: seeds the places list once (private-words.js)
    previewRoot: env.RESEARCH_DIR ?? '/data/research', // replay --preview-remote writes under here
    cloudNameScan, // CLOUD_NAME_SCAN: allow the name and place scan to run on a cloud reader (see above)
  },

  // --- Categories, keywords and learning ---
  // Categories receipts never go to (bills are routed by Actual rules). Whole groups, or "Group / Category" labels.
  excludeGroups: list('EXCLUDE_CATEGORY_GROUPS'),
  excludeCategories: list('EXCLUDE_CATEGORIES'),
  categoryNotesPath: env.CATEGORY_NOTES_PATH ?? '/data/category-notes.json',
  // Household keywords (keywords.js): off | final (a match skips the model) | hint (the model sees it, and its probabilities are reweighted)
  // | mixed (per keyword: strength "always" works like final, "usually" like hint)
  keywordMode: keywordMode(),
  keywordHintWeight: num('KEYWORD_HINT_WEIGHT', 20),
  keywordsPath: env.KEYWORDS_PATH ?? '/data/keywords.json',
  // Show the decider how similar past items were filed (itemState in categorize.js)
  similarItems: bool('SIMILAR_ITEMS', true),
  householdExamples: Math.max(0, Math.round(num('HOUSEHOLD_EXAMPLES', 5))), // newest item notes per category sent with each question; 0 sends none
  // What the worker learns from your corrections in Actual (learning.js): watch.json, lessons.json, sweep.json live in dir.
  learning: { mode: learningMode(), dir: env.MEMORY_DIR ?? '/data/memory' },
  stripDepartmentPrefixes: bool('STRIP_DEPARTMENT_PREFIXES', true),
  history: { days: num('HISTORY_DAYS', 365), limit: num('HISTORY_LIMIT', 10) },
  // One extra decider question per receipt: which single category fits the whole purchase (categorize.js checkReceipt).
  // An item then leaves that category only when it clearly beats it. RECEIPT_CHECK_MIN_CONFIDENCE = how sure the answer must be to count.
  receiptCheck: bool('RECEIPT_CHECK', true),
  receiptCheckMinConfidence: num('RECEIPT_CHECK_MIN_CONFIDENCE', 0.5),
  categoryMinConfidence: num('CATEGORY_MIN_CONFIDENCE', 0.5),
  // Items under that confidence go to the store's usual category (your rule's / the transaction's) instead of review
  ruleFallback: bool('UNSURE_ITEMS_USE_STORE_CATEGORY', true),
  // Confidence (the top category's probability) needed to move an item out of the store's usual category (split it off). Defaults to CATEGORY_MIN_CONFIDENCE.
  // Never below the bar to stay in the store's category.
  moveMinConfidence: num('MOVE_MIN_CONFIDENCE', Math.max(0.6, num('CATEGORY_MIN_CONFIDENCE', 0.5))),
  // Also needed to move an item out: its top category must lead the runner-up by this much (a 50/50 tie never moves money).
  // A decider answer without probabilities has no margin and passes.
  moveMinMargin: num('MOVE_MIN_MARGIN', 0.2),
  // Birthdays and US holidays near the purchase date, shown to the categorizer as a gift hint (see calendar.js).
  occasions: {
    enabled: bool('OCCASIONS', true),
    useCalendar: bool('OCCASIONS_CALENDAR', false), // off by default: read all-day events from your Nextcloud calendars
    calendars: list('OCCASIONS_CALENDARS'), // by name; empty = all
    daysBefore: num('OCCASION_DAYS_BEFORE', 14), // a purchase up to this many days before an occasion
    daysAfter: num('OCCASION_DAYS_AFTER', 2), // or this many days after it
  },
  // A restaurant charge over this many dollars goes to review: it may be a gift meal (Gifts) or need splitting. 0 = off.
  giftMeal: { minDollars: num('GIFT_MEAL_MIN', 50), category: env.RESTAURANT_CATEGORY ?? 'Daily Expenses / Restaurants' },

  // --- Splitting and tax ---
  splits: bool('SPLIT_TRANSACTIONS', true),
  splitMinCents: Math.round(num('SPLIT_MIN_AMOUNT', 1) * 100),
  // Spread the receipt's tax over the taxed items only, when the reader saw which items are taxed (reconcile.js allocate).
  // Also turns on asking the reader for each item's tax mark (llm.js). Off: tax is spread over every item in proportion to its amount.
  taxByItem: bool('TAX_BY_ITEM', true),
  // The highest tax rate (printed tax over the taxed items) that TAX_BY_ITEM believes; above it the tax is spread in proportion to the amounts.
  taxByItemMaxRate: num('TAX_BY_ITEM_MAX_RATE', 0.12),
  // Apply a split or recategorization even when some items are unsure or don't add up: unsure money stays uncategorized,
  // and the receipt still goes to Needs review. false = hold the whole receipt for review instead.
  applyThenReview: bool('APPLY_THEN_REVIEW', true),

  // --- Matching a receipt to its bank transaction ---
  aliasesPath: '/data/payee-aliases.json',
  match: {
    accounts: list('MATCH_ACCOUNTS'),
    days: num('MATCH_DAYS', 4),
    noDateLookbackDays: num('MATCH_NO_DATE_LOOKBACK_DAYS', 365),
    // Undated receipts: a charge in these days before the upload is applied; an older one is only reported for review.
    noDateRecentDays: num('MATCH_NO_DATE_RECENT_DAYS', 14),
    // A receipt whose charge hasn't posted (or cleared) yet stays in the inbox; check again this often.
    recheckMinutes: num('MATCH_RECHECK_MINUTES', 60),
    // Extra days to wait for a pending charge to clear, after the window for it to post.
    pendingWaitDays: num('MATCH_PENDING_WAIT_DAYS', 2),
    tolerancePercent: num('MATCH_TOLERANCE_PERCENT', 0),
    overwrite: bool('OVERWRITE_CATEGORIZED', true),
    payeeMinScore: num('PAYEE_MIN_SCORE', 0.6),
  },

  // --- Actual Budget and Nextcloud ---
  actual: {
    serverURL: required('ACTUAL_SERVER_URL'),
    password: required('ACTUAL_PASSWORD'),
    syncId: required('ACTUAL_SYNC_ID'),
    e2ePassword: env.ACTUAL_E2E_PASSWORD || undefined,
    // Replay tests and the setup check use their own copy (ACTUAL_DATA_DIR), so they never share the worker's.
    dataDir: env.ACTUAL_DATA_DIR || '/data/actual-cache',
    // 'auto' = install the API version the server runs (see actual-api.js); anything else is the version baked into the image.
    apiVersion: (env.ACTUAL_API_VERSION || 'auto').trim(),
    apiDir: env.ACTUAL_API_DIR || '/data/actual-api',
  },
  nextcloud: {
    url: url('NEXTCLOUD_URL'),
    user: required('NEXTCLOUD_USER'),
    password: required('NEXTCLOUD_APP_PASSWORD'),
    inbox: env.RECEIPTS_INBOX ?? '/Receipts/Inbox',
    processed: env.RECEIPTS_PROCESSED ?? '/Receipts/Processed',
    review: env.RECEIPTS_REVIEW ?? '/Receipts/Needs review',
  },
};

export const log = (...args) => console.log(new Date().toISOString(), ...args);
