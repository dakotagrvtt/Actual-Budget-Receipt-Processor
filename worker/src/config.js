const env = process.env;

function required(key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required setting ${key} (see .env.example)`);
  return value;
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
  const mode = (env.KEYWORD_MODE ?? 'off').trim().toLowerCase();
  if (KEYWORD_MODES.includes(mode)) return mode;
  console.warn(`${new Date().toISOString()} KEYWORD_MODE="${env.KEYWORD_MODE}" is not one of ${KEYWORD_MODES.join('|')}; keywords are off`);
  return 'off';
}

// CATEGORIZER used to choose between the decider (d1) and the reader model (lfm3). Only the decider is left.
if (env.CATEGORIZER && !['d1', 'decider'].includes(env.CATEGORIZER.trim().toLowerCase())) {
  console.warn(`${new Date().toISOString()} CATEGORIZER="${env.CATEGORIZER}" is no longer used: the categorizer is always the decider (remove it from .env)`);
}

export const config = {
  dryRun: bool('DRY_RUN', true),
  splits: bool('SPLIT_TRANSACTIONS', true),
  splitMinCents: Math.round(num('SPLIT_MIN_AMOUNT', 1) * 100),
  aliasesPath: '/data/payee-aliases.json',
  pollSeconds: num('POLL_SECONDS', 300),
  maxImageSide: num('MAX_IMAGE_SIDE', 2240),
  llmUrl: url('LLM_URL', 'http://llm:8080'),
  // Which vision model is reading (shown in logs), and optional sampling overrides as JSON, for trying other models.
  llmName: env.LLM_NAME || 'Qwen3.5-4B',
  llmSampling: env.LLM_SAMPLING ? JSON.parse(env.LLM_SAMPLING) : null,
  llmThinking: bool('LLM_THINKING', false), // Qwen3.5-4B: thinking off read as well in testing, 2.4x faster
  // The decider: a /v1/systemone server (DECIDER_MODEL on the decider-gguf service)
  deciderModel: env.DECIDER_MODEL ?? 'LiquidAI/d1-2B-GGUF:Q8_0',
  deciderUrl: url('D1_GGUF_URL', 'http://decider-gguf:8080'),
  // Categories receipts never go to (bills are routed by Actual rules). Whole groups, or "Group / Category" labels.
  excludeGroups: list('EXCLUDE_CATEGORY_GROUPS'),
  excludeCategories: list('EXCLUDE_CATEGORIES'),
  categoryNotesPath: env.CATEGORY_NOTES_PATH ?? '/data/category-notes.json',
  // Household keywords (keywords.js): off | final (a match skips the model) | hint (the model sees it, and its probabilities are reweighted)
  // | mixed (per keyword: strength "always" works like final, "usually" like hint)
  keywordMode: keywordMode(),
  // Show the decider how similar past items were filed (itemState in categorize.js)
  similarItems: bool('SIMILAR_ITEMS', false),
  keywordHintWeight: num('KEYWORD_HINT_WEIGHT', 4),
  keywordsPath: env.KEYWORDS_PATH ?? '/data/keywords.json',
  stripDepartmentPrefixes: bool('STRIP_DEPARTMENT_PREFIXES', true),
  // Ask the reader to also write each item in plain words. Off: in testing it decoded "MED-CHILD PIC" as "child milk".
  plainNames: bool('READ_PLAIN_NAMES', false),
  categoryMinConfidence: num('CATEGORY_MIN_CONFIDENCE', 0.5),
  // Items under that confidence go to the store's usual category (your rule's / the transaction's) instead of review
  ruleFallback: bool('UNSURE_ITEMS_USE_STORE_CATEGORY', true),
  // Confidence needed to move an item out of the store's usual category (split it off). Defaults to CATEGORY_MIN_CONFIDENCE.
  moveMinConfidence: num('MOVE_MIN_CONFIDENCE', num('CATEGORY_MIN_CONFIDENCE', 0.5)),
  // Apply a split or recategorization even when some items are unsure or don't add up: unsure money stays uncategorized,
  // and the receipt still goes to Needs review. false = hold the whole receipt for review instead.
  applyThenReview: bool('APPLY_THEN_REVIEW', true),
  history: { days: num('HISTORY_DAYS', 365), limit: num('HISTORY_LIMIT', 10) },
  statePath: '/data/state.json',
  // Touched every poll and after each receipt; the container healthcheck reads its age.
  heartbeatPath: '/data/heartbeat',
  // Web page + webhook to check the inbox on demand (see trigger.js). Off unless TRIGGER_TOKEN is set.
  trigger: { token: (env.TRIGGER_TOKEN ?? '').trim(), timeZone: env.TRIGGER_TIMEZONE || 'UTC' },
  actual: {
    serverURL: required('ACTUAL_SERVER_URL'),
    password: required('ACTUAL_PASSWORD'),
    syncId: required('ACTUAL_SYNC_ID'),
    e2ePassword: env.ACTUAL_E2E_PASSWORD || undefined,
    // Replay tests and the setup check use their own copy (ACTUAL_DATA_DIR), so they never share the worker's.
    dataDir: env.ACTUAL_DATA_DIR || '/data/actual-cache',
  },
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
