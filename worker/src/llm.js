import { config, log } from './config.js';
import { TransientError, isTransient } from './errors.js';

// Sampling tested with the Qwen3.5-4B reader (LLM_SAMPLING overrides).
// Other vision models can set their own with LLM_SAMPLING.
const SAMPLING = config.llmSampling ?? { temperature: 0.1, top_k: 20, top_p: 0.95, min_p: 0.0, repeat_penalty: 1.0 };
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

async function chat(body) {
  let res;
  let text;
  try {
    res = await fetch(`${config.llmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    text = await res.text();
  } catch (err) {
    // Server down, restarting or too slow: says nothing about the receipt.
    if (isTransient(err)) throw new TransientError(`model server unreachable or timed out: ${err.message}`, { cause: err });
    throw err;
  }
  // 5xx is the server's problem (llama.cpp answers 503 while loading); 4xx means our request was wrong.
  if (res.status >= 500) throw new TransientError(`model server HTTP ${res.status}: ${text.slice(0, 500)}`);
  if (!res.ok) throw new Error(`model server HTTP ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content ?? '';
}

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
  try {
    // LLM_THINKING=false asks the model to answer directly (much faster for models that reason at length).
    const thinking = config.llmThinking;
    const out = await chat({ messages, ...SAMPLING, max_tokens: 8192, ...(thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }) });
    return { value: check(parseJson(out)), mode: thinking ? 'thinking' : 'direct' };
  } catch (err) {
    if (err instanceof TransientError) throw err; // an outage: a second pass would only wait again
    log(`  first pass failed (${err.message}); retrying with constrained JSON`);
  }
  const out = await chat({
    messages,
    ...SAMPLING,
    max_tokens: 4096,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
  });
  return { value: check(parseJson(out)), mode: 'constrained' };
}

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'store_clues', 'date_as_printed', 'date', 'currency', 'subtotal', 'tax', 'tip', 'total', 'payment_method', 'cash_tendered', 'card_last4', 'is_return', 'items'],
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
    is_return: { type: 'boolean' },
    items: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'plain', 'amount'],
        properties: { description: { type: 'string' }, plain: { type: 'string' }, amount: { type: 'number' } },
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

/** 16, "16.00", "$16.00", "1,016.00", "-$1.00", "1.00-" or "(1.00)" → number; anything else → NaN. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  let s = v.trim().replace(/usd/gi, '').replace(/[$\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
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
  r.payment_method = typeof r.payment_method === 'string' && r.payment_method.trim() ? r.payment_method.trim().toLowerCase() : null;
  if (typeof r.card_last4 === 'number') r.card_last4 = String(r.card_last4);
  if (typeof r.card_last4 !== 'string' || !r.card_last4.trim()) r.card_last4 = null;
  r.is_return = r.is_return === true || r.is_return === 'true';
  if (!Array.isArray(r.items) || r.items.length === 0) throw new Error('no line items');
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) throw new Error(`bad item: ${JSON.stringify(it)}`);
    if (typeof it.description !== 'string' || !it.description.trim()) throw new Error(`item without a description: ${JSON.stringify(it)}`);
    it.description = it.description.trim();
    const amount = toNumber(it.amount);
    if (!Number.isFinite(amount)) throw new Error(`bad item amount: ${JSON.stringify(it)}`);
    it.amount = amount;
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
  let fields = 'description, plain, amount';
  if (!config.plainNames) {
    const item = schema.properties.items.items;
    delete item.properties.plain;
    item.required = ['description', 'amount'];
    system = system.replace(/- "plain"[\s\S]*?printed\.\n/, '');
    fields = 'description, amount';
  }
  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: `Return a JSON object with: merchant, store_clues, date_as_printed, date, currency (ISO code like USD), subtotal, tax, tip, total, payment_method, cash_tendered, card_last4 (last 4 digits of the card if printed), is_return, items (array of {${fields}}).` },
      ],
    },
  ];
  const { value, mode } = await chatJson(messages, schema, checkReceipt);
  return { receipt: value, mode };
}

export async function waitFor(url, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new TransientError(`model server at ${url} not ready after ${Math.round(timeoutMs / 60000)} min`);
}
export const waitForModel = () => waitFor(config.llmUrl);
