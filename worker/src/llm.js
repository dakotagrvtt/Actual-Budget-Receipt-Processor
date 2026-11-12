// Talks to the reader model: the local llama.cpp server or, with READER_PROVIDER=remote, an OpenAI-compatible cloud API.
// Builds the receipt request, retries and classifies failures (transient, permanent, setup), and parses the JSON answer.
// categorize.js and describe-categories use its chat helpers too.
import { config, log } from './config.js';
import crypto from 'node:crypto';
import { modelFetch } from './model-fetch.js';
import { TransientError, PermanentError, SetupError, SkipReceiptError, isTransient, isClientTimeout, markCounted, COUNTED_STATUSES } from './errors.js';

// Default sampling, tested with the Qwen3.5-4B reader. Other vision models can set their own with LLM_SAMPLING.
const SAMPLING = config.llmSampling ?? { temperature: 0.1, top_k: 20, top_p: 0.95, min_p: 0.0, repeat_penalty: 1.0 };
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const isRemote = () => config.reader.provider === 'remote';

// ---- READER_PROVIDER=remote: a cloud vision model (OpenAI, OpenRouter, any OpenAI-compatible API) ----
// The request holds the prompt and the receipt image(s) and nothing else: no file name, folder, date or account.
// It uses only standard OpenAI chat parameters (no top_k, min_p, repeat_penalty or chat_template_kwargs: those are
// llama.cpp's). It sends max_tokens rather than max_completion_tokens, because OpenRouter and most other
// OpenAI-compatible APIs take that. Newer OpenAI models that only take max_completion_tokens answer with a 400 that
// says so; the request is then retried once with it, and the form that worked is remembered for the rest of the process.
// LLM_THINKING does not apply.

const REMOTE_MAX_TOKENS = 4096;
const REMOTE_RETRIES = 3; // after the first try, for 429 (not quota) and 500, 502, 503 only: a 504, 524, 408 or a timeout may already be billed
const MODEL_TIMEOUT_MS = 10 * 60 * 1000; // per reader request, headers and body
const RETRY_AFTER_CAP_MS = 120000; // never wait longer than this on a provider's Retry-After
const RETRY_BACKOFF_BASE_MS = 2000; // doubled on each retry, up to the cap below
const RETRY_BACKOFF_CAP_MS = 30000;
const MAX_REQUEST_FIXES = 3; // request adjustments (token field, temperature, JSON mode) tried after a 400 before giving up
const READY_TIMEOUT_MS = 15000; // remoteReady's model-list check
const LOCAL_MAX_TOKENS = 8192; // first pass: room for a long receipt (and some thinking with LLM_THINKING=true)
const LOCAL_CONSTRAINED_MAX_TOKENS = 4096; // second pass: grammar-forced JSON only, no reasoning
const SERVER_ERROR_TEXT_CHARS = 500; // how much of the local server's error body goes into a message
const RETRY_STATUSES = new Set([429, 500, 502, 503]);
export const retryPolicy = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; // tests replace sleep

/** The text with the API key, "Bearer ..." tokens, key-looking strings and image data blanked out. Always used before a provider's words are shown. */
function redactReader(text) {
  let out = String(text ?? '');
  const key = config.reader.apiKey;
  if (key) out = out.split(key).join('[key]');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [key]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]*/gi, '[image]');
}
/** A provider's error words for a message: scrubbed first, then cut to 200 characters. */
const said = (text) => redactReader(text).replace(/\s+/g, ' ').trim().slice(0, 200);

/** The reader's key was refused: not the receipt's fault, and waiting won't fix it (see errors.js SetupError). */
export class ReaderAuthError extends SetupError {
  constructor(status) {
    super(`the reader API key was refused (HTTP ${status}); check READER_API_KEY in .env and run ./receipts restart`);
    this.name = 'ReaderAuthError';
  }
}
/**
 * The reader did not answer in a way that says anything about the receipt (down, busy, timed out). Only the ones that
 * may have been billed and are about this receipt (504, 524, 408, our timeout, an unreadable body) are marked counted
 * (errors.js markCounted): index.js counts those per receipt and gives up after a few checks. The others (429/5xx
 * after the retries, no connection) are an outage: the cycle stops and nothing is counted.
 */
class ReaderTransient extends TransientError {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReaderTransient';
    this.reader = true;
  }
}
class ReaderBadRequest extends PermanentError {
  constructor(detail) {
    super(`reader HTTP 400: ${said(detail)}`);
    this.name = 'ReaderBadRequest';
    this.detail = redactReader(detail);
  }
}

const NO_STRICT = new Set(['minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern', 'format', 'minLength', 'maxLength', 'uniqueItems', 'minProperties', 'maxProperties', 'default']);
/**
 * The schema for a provider's strict structured outputs: a copy without the keywords strict mode rejects
 * (limits, patterns, formats). checkReceipt still checks everything, so nothing is lost.
 */
export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (NO_STRICT.has(k)) continue;
    // "properties" maps field names to schemas: a field may be called "format"
    out[k] = k === 'properties' || k === '$defs' ? Object.fromEntries(Object.entries(v).map(([n, sub]) => [n, strictSchema(sub)])) : strictSchema(v);
  }
  return out;
}

const remoteHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.reader.apiKey}`,
  ...(/(^|\.)openrouter\.ai$/.test(config.reader.host) ? { 'X-Title': 'receipt-pipeline' } : {}), // OpenRouter's optional app name; nothing personal
});

/** Milliseconds from a Retry-After header (seconds or a date), or null; at most two minutes. */
function retryAfterMs(res) {
  const v = res.headers?.get?.('retry-after');
  if (!v) return null;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS) : null;
}

// What a provider's words say. Tested on the raw body, which may be JSON ({"error":{"code":"insufficient_quota"}}) or text.
// Quota is decided by the structured error first (isQuota); these words are only for an answer with no error code or type.
// "billing" alone is not one: OpenAI's free-tier rate-limit text points at the billing page.
const QUOTA_WORDS = /insufficient_quota|exceeded your current quota|insufficient (credits?|funds|balance)|out of credits|credit balance|payment required/i;
const MODERATION_WORDS = /moderat|flagged|content[ _-]?(policy|filter)|safety|policy violation/i;
const REGION_WORDS = /unsupported_country|country, region|region.{0,40}(not supported|unsupported)|not (available|supported) in your (country|region)|territory/i;
const IMAGE_WORDS = /multimodal|(image|vision|modalit)[^"]{0,60}(not support|unsupported|not allowed|not enabled|cannot|can't|does not|doesn't)|(not support|unsupported|does not (support|accept)|doesn't (support|accept)|cannot (process|accept)|can't (process|accept))[^"]{0,60}(image|vision|modalit)|image_url[^"]{0,60}supported|no endpoints[^"]{0,60}(image|vision)/i;
const MODEL_WORDS = /model.{0,60}(not found|does not exist|not exist|unknown|invalid|not supported|unavailable)|(unknown|invalid|unsupported) model/i;

/** The HTTP-like status inside a 200 answer's "error" object (OpenRouter puts one there), or 0 when it has no number. */
function errorStatus(error) {
  const n = Number(error?.code ?? error?.status);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : 0;
}

/**
 * Has the account run out of quota or credit? The structured error decides: HTTP 402, or error.code / error.type
 * "insufficient_quota". An answer that names some other code or type (rate_limit_exceeded, ...) is not quota, whatever its
 * words say. Only an answer with no code and no type is judged by its words.
 */
export function isQuota(status, text) {
  if (status === 402) return true;
  let error;
  try {
    const parsed = JSON.parse(text);
    error = parsed?.error ?? parsed;
  } catch { /* plain text */ }
  const named = [error?.code, error?.type].filter((v) => typeof v === 'string' && v.trim());
  if (named.length) return named.some((v) => v.toLowerCase() === 'insufficient_quota');
  return QUOTA_WORDS.test(text);
}

/** The error for a request the provider refused or failed, by status and body words. Never for a retryable status (see remotePost). */
function failureFor(status, text) {
  if (isQuota(status, text) && status !== 401 && status !== 404 && !(status >= 500)) {
    return new SetupError(`the reader provider says the account is out of quota or credits (${said(text)}); add credit or check the plan, then run ./receipts restart`);
  }
  if (status === 401) return new ReaderAuthError(401);
  if (status === 403) {
    if (MODERATION_WORDS.test(text)) return new PermanentError(`the reader provider blocked this receipt (moderation): ${said(text)}`);
    if (REGION_WORDS.test(text)) return new SetupError(`the reader provider does not serve your country or region (${said(text)}); use another provider, or set READER_PROVIDER=local`);
    return new ReaderAuthError(403);
  }
  if (status === 402 || status === 404) return new SetupError(`the reader provider answered HTTP ${status} (credits or model name?): ${said(text)}; check READER_MODEL, READER_URL and your account`);
  if (status === 400) return new ReaderBadRequest(text);
  if (status === 0) return new PermanentError(`the reader answered with an error: ${said(text)}`);
  if (status >= 500 || status === 408 || status === 429) {
    const err = new ReaderTransient(`reader HTTP ${status}: ${said(text)}`);
    return COUNTED_STATUSES.has(status) ? markCounted(err, 'reader') : err; // 504, 524, 408: possibly billed. The rest is an outage.
  }
  return new PermanentError(`reader HTTP ${status}: ${said(text)}`);
}

/** One chat request to the remote reader; returns the answer text. Retries 429 (not quota), 500, 502 and 503 a few times, then it is a TransientError. */
async function remotePost(body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let text;
    try {
      res = await modelFetch(`${config.reader.url}/chat/completions`, { method: 'POST', headers: remoteHeaders(), body: JSON.stringify(body) }, MODEL_TIMEOUT_MS);
    } catch (err) {
      // Not retried here: a timeout may already have been billed. Our own timeout counts against the receipt; no connection or DNS is an outage.
      if (isTransient(err)) {
        const failure = new ReaderTransient(said(`reader at ${config.reader.host} unreachable or timed out: ${err.message}`), { cause: err });
        throw isClientTimeout(err) ? markCounted(failure, 'reader') : failure;
      }
      throw err;
    }
    try {
      text = await res.text();
    } catch (err) {
      // The answer started and could not be read to the end: it may have been billed.
      throw markCounted(new ReaderTransient(said(`reader at ${config.reader.host}: the answer could not be read: ${err.message}`), { cause: err }), 'reader');
    }
    let status = res.status;
    let data;
    if (res.ok) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new PermanentError('the reader answered with something that is not JSON');
      }
      if (data?.error) {
        // Some providers answer 200 with the failure in the body: treat it like the status it names.
        status = errorStatus(data.error);
        text = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
      }
    }
    if (!res.ok || data?.error) {
      if (RETRY_STATUSES.has(status) && !isQuota(status, text)) {
        if (attempt >= REMOTE_RETRIES) throw new ReaderTransient(`reader HTTP ${status} after ${attempt + 1} tries: ${said(text)}`);
        await retryPolicy.sleep(retryAfterMs(res) ?? Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_CAP_MS));
        continue;
      }
      throw failureFor(status, text);
    }
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (message?.refusal) throw new PermanentError(`the reader model refused: ${said(message.refusal)}`);
    if (choice?.finish_reason === 'length') {
      throw new PermanentError(`the reader's answer was cut off at ${body.max_completion_tokens ?? body.max_tokens} tokens; a reasoning model may need more`);
    }
    const content = message?.content;
    return Array.isArray(content) ? content.map((p) => p?.text ?? '').join('') : content ?? '';
  }
}

// What this provider turned out to need, per process: after one 400 that taught us, later requests go straight to the form that works.
const learned = new Map();
const learnedFor = () => {
  const key = `${config.reader.host} ${config.reader.model}`;
  if (!learned.has(key)) learned.set(key, {});
  return learned.get(key);
};
/** Forget what was learned about the provider (tests). */
export const forgetReaderQuirks = () => learned.clear();

/**
 * Decides what a 400 that no fallback fixed means.
 * - A model that does not exist is a setup problem.
 * - A 400 about images may only be about this receipt's photo (unsupported format, too many images).
 *   - If this host and model already gave a good reading in this process, it is a plain error for this receipt (a failed attempt).
 *   - Before any good reading, the first such receipt is only skipped for this check (SkipReceiptError: nothing counted,
 *     nothing paused, the cycle goes on).
 *   - A second, different receipt with the same kind of 400, with no good reading in between, looks like a setup problem and pauses the worker.
 * The "good reading" flag lives in memory only, so after a restart one bad photo does not block the inbox.
 */
function finalBadRequest(err, quirks, fingerprint) {
  const setup = () => new SetupError(`the reader model may not accept images, or its name is wrong (HTTP 400: ${said(err.detail)}); check READER_MODEL (it must read images) and run ./receipts restart`);
  if (MODEL_WORDS.test(err.detail)) return setup();
  if (!IMAGE_WORDS.test(err.detail)) return err;
  const before = quirks.badImage;
  quirks.badImage = fingerprint;
  if (before && before !== fingerprint) return setup(); // two different receipts in a row, with no good reading between
  if (quirks.goodReading) return err;
  return new SkipReceiptError(`the reader rejected this receipt's image (HTTP 400: ${said(err.detail)}); nothing has been read with this model yet, so it is not clear whether the photo or the setup is at fault`, { cause: err });
}

/** Ask the remote reader for the receipt JSON: strict structured output, with the fallbacks below for providers that can't. */
async function remoteChat(messages, schema) {
  const quirks = learnedFor();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'); // which receipt (never logged or stored)
  const body = {
    model: config.reader.model,
    messages: quirks.jsonMode ? withSchemaInPrompt(messages, schema) : messages,
    temperature: SAMPLING.temperature ?? 0.1,
    max_tokens: REMOTE_MAX_TOKENS,
    response_format: quirks.jsonMode ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'receipt', strict: true, schema: strictSchema(schema) } },
  };
  if (quirks.maxCompletion) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (quirks.noTemperature) delete body.temperature;
  for (let fixes = 0; ; fixes++) {
    try {
      return await remotePost(body);
    } catch (err) {
      if (!(err instanceof ReaderBadRequest)) throw err;
      if (fixes >= MAX_REQUEST_FIXES) throw finalBadRequest(err, quirks, fingerprint);
      const why = err.detail;
      if ('max_tokens' in body && /max_completion_tokens|max_tokens/i.test(why)) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
        quirks.maxCompletion = true;
        log('  the reader provider wants max_completion_tokens; using it from now on');
      } else if ('temperature' in body && /temperature/i.test(why)) {
        delete body.temperature;
        quirks.noTemperature = true;
        log('  the reader provider does not take a temperature; leaving it out from now on');
      } else if (body.response_format.type === 'json_schema' && /response_format|json_schema|structured|schema/i.test(why)) {
        // No structured outputs here: plain JSON mode, with the schema described in the prompt.
        body.response_format = { type: 'json_object' };
        body.messages = withSchemaInPrompt(messages, schema);
        quirks.jsonMode = true;
        log('  the reader provider has no json_schema output; using JSON mode with the schema in the prompt from now on');
      } else {
        throw finalBadRequest(err, quirks, fingerprint);
      }
    }
  }
}

function withSchemaInPrompt(messages, schema) {
  const extra = `\n\nReply with one JSON object that follows this JSON Schema:\n${JSON.stringify(schema)}`;
  const at = messages.findIndex((m) => m.role === 'system' && typeof m.content === 'string');
  if (at < 0) return [{ role: 'system', content: `Reply with JSON.${extra}` }, ...messages];
  return messages.map((m, i) => (i === at ? { ...m, content: m.content + extra } : m));
}

/**
 * The remote reader has no /health. A cheap GET <base>/models with the key: any answer except a refused key means it is
 * there (not every provider lists models, and some answer without checking the key). Unreachable is a TransientError.
 */
export async function remoteReady() {
  let res;
  try {
    res = await fetch(`${config.reader.url}/models`, { headers: remoteHeaders(), signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
  } catch (err) {
    throw new TransientError(said(`reader at ${config.reader.host} unreachable or timed out: ${err.message}`), { cause: err });
  }
  await res.body?.cancel?.().catch(() => {});
  if (res.status === 401 || res.status === 403) throw new ReaderAuthError(res.status);
  return res.status; // ./receipts check warns about a 404 (no model list; not an error)
}

/** One chat request to the local llama.cpp server; returns the answer text. */
async function chat(body) {
  let res;
  let text;
  try {
    res = await modelFetch(`${config.llmUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, MODEL_TIMEOUT_MS);
    text = await res.text();
  } catch (err) {
    // Server down, restarting or too slow: says nothing about the receipt.
    if (isTransient(err)) throw new TransientError(`model server unreachable or timed out: ${err.message}`, { cause: err });
    throw err;
  }
  // 5xx is the server's problem (llama.cpp answers 503 while loading); 4xx means our request was wrong.
  if (res.status >= 500) throw new TransientError(`model server HTTP ${res.status}: ${text.slice(0, SERVER_ERROR_TEXT_CHARS)}`);
  if (!res.ok) throw new Error(`model server HTTP ${res.status}: ${text.slice(0, SERVER_ERROR_TEXT_CHARS)}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? '';
}

/** The JSON object in a model's answer (think blocks and text around it ignored). */
export function parseJson(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Ask the reader (LLM_URL) for JSON. Pass 1 answers directly, or reasons first when LLM_THINKING=true;
 * if that output doesn't parse or validate, pass 2 forces schema-valid JSON with a grammar.
 */
export async function chatJson(messages, schema, check) {
  if (isRemote()) {
    // One paid request: strict structured output makes a second, constrained pass pointless.
    const value = check(parseJson(await remoteChat(messages, schema)));
    // A good reading: this host and model takes images, so a later 400 about an image is that receipt's problem.
    Object.assign(learnedFor(), { goodReading: true, badImage: null });
    return { value, mode: 'remote' };
  }
  try {
    // LLM_THINKING=false asks the model to answer directly (much faster for models that reason at length).
    const thinking = config.llmThinking;
    const out = await chat({ messages, ...SAMPLING, max_tokens: LOCAL_MAX_TOKENS, ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
    return { value: check(parseJson(out)), mode: thinking ? 'thinking' : 'direct' };
  } catch (err) {
    if (err instanceof TransientError) throw err; // an outage: a second pass would only wait again
    log(`  first pass failed (${err.message}); retrying with constrained JSON`);
  }
  const out = await chat({
    messages,
    ...SAMPLING,
    max_tokens: LOCAL_CONSTRAINED_MAX_TOKENS,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
  });
  return { value: check(parseJson(out)), mode: 'constrained' };
}

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'store_clues', 'date_as_printed', 'date', 'currency', 'subtotal', 'tax', 'tip', 'total', 'payment_method', 'cash_tendered', 'card_last4', 'savings', 'is_return', 'tax_lines', 'items'],
  properties: {
    merchant: { type: 'string' },
    store_clues: { type: 'array', items: { type: 'string' } },
    date_as_printed: nullable('string'),
    date: nullable('string'),
    currency: { type: 'string' },
    subtotal: nullable('number'),
    tax: nullable('number'),
    tip: nullable('number'),
    total: { type: 'number' },
    payment_method: nullable('string'),
    cash_tendered: nullable('number'),
    card_last4: nullable('string'),
    savings: nullable('number'),
    is_return: { type: 'boolean' },
    tax_lines: {
      anyOf: [
        { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'rate', 'base', 'amount'], properties: { code: nullable('string'), rate: nullable('number'), base: nullable('number'), amount: { type: 'number' } } } },
        { type: 'null' },
      ],
    },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'plain', 'amount', 'taxable', 'tax_code'],
        properties: { description: { type: 'string' }, plain: { type: 'string' }, amount: { type: 'number' }, taxable: nullable('boolean'), tax_code: nullable('string') },
      },
    },
  },
};

const READ_SYSTEM = `You read photos of shopping receipts and turn them into JSON.
Rules:
- Copy prices exactly as printed. Do not invent items that are not on the receipt.
- Each purchased line counts once. Lines that only repeat an item's price (like "Net Price:") are not separate items.
- "total" is the amount due for the purchase, including tax and tip. "subtotal" is before tax. Use null for anything not printed.
- "total" is never the cash handed over or the change given back. "payment_method" is "cash", "card", or what else is
  printed (null if not shown). "cash_tendered" is the cash handed over when paid in cash, else null.
- Discounts and coupons are line items with negative amounts.
- "savings" is the total savings the receipt prints on a line of its own ("INSTANT SAVINGS $4.00", "YOU SAVED 3.20",
  "TOTAL SAVINGS"), as a positive number. Use null if no such line is printed. Do not add up discounts yourself.
- An amount printed with a minus after it ("5.00-", "5.00-A") is negative. A line of only item numbers with such an
  amount ("0000393481 / 580664    5.00-") is a discount for an item: include it with a negative amount, never skip it.
- A multi-buy line under an item, like "1 @ 2 $4.00" (one at a 2-for-$4.00 price), is not the item's price: the amount is the price
  printed on the item's own line (2.00).
- "merchant" is the business name: from the logo or header, or else from a business named in a website, email
  address or return policy. Never use a city, street, state or tax jurisdiction as the merchant.
- "store_clues" lists every other piece of text that names the business: website and email domains, store names in
  the fine print, loyalty program names. Never a city, street, state, address or phone number. Use [] if there are none.
- "is_return" is true only for a refund or return receipt (money paid back to the customer), else false.
- "date_as_printed" copies the purchase or transaction date exactly as printed (for example "10/26/26 3:14 PM").
  It is never a return-by, exchange, expiry or "valid until" date. Use null if no purchase date is visible.
- "date" is that purchase date as YYYY-MM-DD, or null if no purchase date is visible. Do not guess a date.
- "description" is the item text as printed, not the SKU or item code.
- "plain" says in a few everyday words what the item most likely is, decoding store abbreviations and department
  prefixes using the kind of store it is (for example "GV 2% MLK GAL" at a supermarket is "store-brand 2% milk, gallon").
  If you can't tell, copy the description. Never guess a brand or size that isn't printed.
- Reply with only the JSON object.`;

// Added to the reader's instructions only with TAX_BY_ITEM. Kept to one rule: the model only copies what the receipt prints.
const TAXABLE_RULE = `
- "taxable" is per item: true if the receipt marks that line as taxed, false if it marks it as not taxed, null if the
  receipt prints no tax marks. "tax_code" is the mark printed beside the item's price, copied exactly, keeping upper and lower case ("t" and "T" can be different rates), or null. Never decide
  what a mark means yourself.
- "tax_lines" lists each tax line as printed, e.g. "A 8.600% TAX 4.39" is {"code": "A", "rate": 8.6, "base": null, "amount": 4.39}
  (rate in percent). If the line also prints the taxed amount, that is its "base": "t 20.96 @ 5.500% = 1.15" is
  {"code": "t", "rate": 5.5, "base": 20.96, "amount": 1.15}; else base is null. A line may have no code (a single "TAX 2.68": code null). One entry per tax line, not the total tax line. Use null if no tax line is printed.`;

const MAX_TAX_CODE_CHARS = 12; // longer text is not a code but something the reader misread
/** A printed tax code as trimmed text, case kept (a number becomes its digits), or null. */
const taxCode = (v) => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  return typeof s === 'string' && s.trim() && s.trim().length <= MAX_TAX_CODE_CHARS ? s.trim() : null;
};
/** One printed tax line {code, rate, base, amount}: rate as the reader gave it, "%" stripped (8.6 for 8.6%; reconcile also accepts a fraction like 0.086); null when unreadable. */
const taxLine = (l) => {
  if (typeof l !== 'object' || l === null) return null;
  const amount = toNumber(l.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  let rate = typeof l.rate === 'string' ? toNumber(l.rate.replace('%', '')) : toNumber(l.rate);
  if (!Number.isFinite(rate) || rate <= 0) rate = null;
  const base = toNumber(l.base); // the taxed amount when the line prints one
  return { code: taxCode(l.code), rate: rate == null ? null : Math.round(rate * 1e4) / 1e4, base: Number.isFinite(base) && base > 0 ? base : null, amount };
};
/** The "taxable" answer as true, false or null (a string like "true" counts; anything else is "can't tell"). */
const taxableFlag = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/** 16, "16.00", "$16.00", "1,016.00", "-$1.00", "1.00-", "(1.00)", "€24,50", "CA$33.80", "24.50 EUR", "1.234,50" → number; anything else → NaN. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  // Currency symbols (any \p{Sc}) and 2-3 letter codes (CA$, US$, EUR, CAD) before or after the number, and any whitespace (NBSP too).
  let s = v.replace(/\p{Sc}/gu, ' ').trim().replace(/^[a-z]{2,3}(?=[\s\d.(-])/i, '').replace(/(?<=[\d.)-])\s*[a-z]{2,3}$/i, '').replace(/[\s\u00a0\u202f]/g, '');
  // Separators: the last of "." and "," is the decimal mark when both occur; a lone comma is decimal unless it groups thousands ("1,016").
  if (s.includes(',') && s.includes('.')) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (s.includes(',')) {
    s = /^[-(]?\d{1,3}(,\d{3})+\D*$/.test(s) ? s.replace(/,/g, '') : /^[-(]?\d*,\d{1,2}[-)]?$/.test(s) ? s.replace(',', '.') : s;
  }
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/^-|-$/.test(s)) { sign = -sign; s = s.replace(/^-|-$/, ''); } // receipts print discounts as "1.00-"
  return /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? sign * Number(s) : NaN;
}

// The first (thinking) pass isn't schema-constrained, so everything is type-checked here: a "$16.00" string must
// not become NaN and silently skip the subtotal check.
export function checkReceipt(r) {
  const optional = (v) => (Number.isFinite(toNumber(v)) ? toNumber(v) : null);
  if (typeof r !== 'object' || r === null) throw new Error('output is not an object');
  if (typeof r.merchant !== 'string' || !r.merchant.trim()) throw new Error('no merchant');
  if (!Array.isArray(r.store_clues)) r.store_clues = [];
  // Keep names and domains only: drop survey logins, phone/account numbers and similar printed codes.
  r.store_clues = r.store_clues.filter((s) => typeof s === 'string' && s.trim() && !/password|user ?id|pin\b|\d{4,}/i.test(s));
  for (const k of ['date', 'date_as_printed']) if (typeof r[k] !== 'string' || !r[k].trim()) r[k] = null; // dates are checked later
  const total = toNumber(r.total);
  if (!Number.isFinite(total)) throw new Error(`bad total: ${JSON.stringify(r.total)}`);
  r.total = total;
  for (const k of ['subtotal', 'tax', 'tip', 'cash_tendered']) r[k] = optional(r[k]);
  // The savings the receipt prints for itself: only a plain non-negative amount counts (it is compared with a gap, never used as an item).
  const savings = toNumber(r.savings);
  r.savings = Number.isFinite(savings) && savings >= 0 ? savings : null;
  r.payment_method = typeof r.payment_method === 'string' && r.payment_method.trim() ? r.payment_method.trim().toLowerCase() : null;
  if (typeof r.card_last4 === 'number') r.card_last4 = String(r.card_last4);
  if (typeof r.card_last4 !== 'string' || !r.card_last4.trim()) r.card_last4 = null;
  r.is_return = r.is_return === true || r.is_return === 'true';
  // Only with TAX_BY_ITEM: the printed tax lines, or null when absent or unreadable.
  if (!config.taxByItem) delete r.tax_lines;
  else {
    const lines = Array.isArray(r.tax_lines) ? r.tax_lines.map(taxLine).filter(Boolean) : [];
    r.tax_lines = lines.length ? lines : null;
  }
  if (!Array.isArray(r.items) || r.items.length === 0) throw new Error('no line items');
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) throw new Error(`bad item: ${JSON.stringify(it)}`);
    if (typeof it.description !== 'string' || !it.description.trim()) throw new Error(`item without a description: ${JSON.stringify(it)}`);
    it.description = it.description.trim();
    const amount = toNumber(it.amount);
    if (!Number.isFinite(amount)) throw new Error(`bad item amount: ${JSON.stringify(it)}`);
    it.amount = amount;
    // Only with TAX_BY_ITEM, and only when the reader answered: an item without the field (a reading saved without it) stays without it.
    if (!config.taxByItem) {
      delete it.taxable;
      delete it.tax_code;
    } else {
      if ('taxable' in it) it.taxable = taxableFlag(it.taxable);
      if ('tax_code' in it) it.tax_code = taxCode(it.tax_code);
    }
    if (!config.plainNames) delete it.plain;
    else if (typeof it.plain !== 'string' || !it.plain.trim()) it.plain = it.description;
  }
  return r;
}

/** Read merchant, date, totals and line items (no categories) from receipt images. */
export async function readReceipt(images) {
  // Plain-language names are optional (READ_PLAIN_NAMES); without them the schema and prompt leave the field out.
  const schema = structuredClone(RECEIPT_SCHEMA);
  let system = READ_SYSTEM;
  let fields = ['description', 'plain', 'amount', 'taxable', 'tax_code'];
  const item = schema.properties.items.items;
  const without = (field) => {
    delete item.properties[field];
    item.required = item.required.filter((f) => f !== field);
    fields = fields.filter((f) => f !== field);
  };
  if (!config.plainNames) {
    without('plain');
    system = system.replace(/- "plain"[\s\S]*?printed\.\n/, '');
  }
  if (config.taxByItem) system = system.replace(/\n- Reply with only/, `${TAXABLE_RULE}\n- Reply with only`);
  else {
    delete schema.properties.tax_lines;
    schema.required = schema.required.filter((f) => f !== 'tax_lines');
    without('taxable');
    without('tax_code');
  }
  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: `Return a JSON object with: merchant, store_clues, date_as_printed, date, currency (ISO code like USD), subtotal, tax, tip, total, payment_method, cash_tendered, card_last4 (last 4 digits of the card if printed), savings, is_return, items (array of {${fields.join(', ')}})${config.taxByItem ? ', tax_lines (array of {code, rate, base, amount})' : ''}.` },
      ],
    },
  ];
  const { value, mode } = await chatJson(messages, schema, checkReceipt);
  return { receipt: value, mode };
}

const WAIT_TIMEOUT_MS = 15 * 60 * 1000; // a local model can take minutes to load
const WAIT_POLL_MS = 5000;

/** Wait until the local model server answers /health; TransientError if it does not within the timeout. */
export async function waitFor(url, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  throw new TransientError(`model server at ${url} not ready after ${Math.round(timeoutMs / 60000)} min`);
}
// A remote reader is never waited for like a local server that is loading: one cheap check.
export const waitForModel = () => (isRemote() ? remoteReady() : waitFor(config.llmUrl));
