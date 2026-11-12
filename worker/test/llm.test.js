// llm.js: number and receipt parsing, the remote reader's retries and error handling, and the local two-pass JSON flow.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { parseJson, checkReceipt, readReceipt, strictSchema, waitForModel, retryPolicy, ReaderAuthError, forgetReaderQuirks, isQuota } from '../src/llm.js';
import { isTransient, isSetupProblem, isCounted, isSkip } from '../src/errors.js';

test('parseJson: finds the object in surrounding text and drops <think> blocks', () => {
  assert.deepEqual(parseJson('Sure! {"a": 1} done'), { a: 1 });
  assert.deepEqual(parseJson('<think>maybe {"x": 0} first</think>\n{"a": 2}'), { a: 2 });
  assert.deepEqual(parseJson('```json\n{"a": {"b": 3}}\n```'), { a: { b: 3 } });
});

test('parseJson: no object is an error', () => {
  assert.throws(() => parseJson('nothing here'), /no JSON object/);
  assert.throws(() => parseJson('<think>{"a":1}</think>'), /no JSON object/);
  assert.throws(() => parseJson('{broken'), /no JSON object/);
  assert.throws(() => parseJson('{"a": }'), SyntaxError);
});

const good = (extra = {}) => ({
  merchant: ' Target ', store_clues: ['target.com'], date_as_printed: '10/26/26', date: '2026-10-26', currency: 'USD',
  subtotal: 10, tax: 0.8, tip: null, total: 10.8, payment_method: ' Visa ', cash_tendered: null, card_last4: '1234', is_return: false,
  items: [{ description: ' Milk ', plain: 'milk', amount: 4.5 }, { description: 'Eggs', plain: 'eggs', amount: 6.3 }],
  ...extra,
});

test('checkReceipt: a good reading comes back normalized', () => {
  const r = checkReceipt(good());
  assert.equal(r.merchant, ' Target '); // NOTE: the merchant is checked but not trimmed
  assert.equal(r.payment_method, 'visa');
  assert.equal(r.items[0].description, 'Milk');
  assert.equal(r.total, 10.8);
});

test('checkReceipt: blank dates become null and are not parsed here', () => {
  const r = checkReceipt(good({ date: '', date_as_printed: '  ' }));
  assert.deepEqual([r.date, r.date_as_printed], [null, null]);
  assert.equal(checkReceipt(good({ date: 'garbage' })).date, 'garbage');
});

test('checkReceipt: "plain" is dropped unless READ_PLAIN_NAMES is on', async () => {
  // the test environment leaves READ_PLAIN_NAMES unset, which means off
  const r = checkReceipt(good());
  assert.equal('plain' in r.items[0], false);
  config.plainNames = true;
  try {
    const on = checkReceipt(good({ items: [{ description: 'MLK', plain: ' ', amount: 1 }, { description: 'EGG', plain: 'eggs', amount: 1 }] }));
    assert.deepEqual(on.items.map((i) => i.plain), ['MLK', 'eggs']); // a blank plain name falls back to the description
  } finally {
    config.plainNames = false;
  }
});

test('checkReceipt: "taxable" becomes true, false or null; a reading without it stays without it; off drops it', () => {
  const r = checkReceipt(good({ items: [
    { description: 'a', amount: 1, taxable: true }, { description: 'b', amount: 1, taxable: 'false' }, { description: 'c', amount: 1, taxable: 'T' },
    { description: 'd', amount: 1, taxable: null }, { description: 'e', amount: 1 },
  ] }));
  assert.deepEqual(r.items.map((i) => i.taxable), [true, false, null, null, undefined]);
  assert.equal('taxable' in r.items[4], false, 'a saved reading from before the flags has none, so it behaves as before');
  config.taxByItem = false;
  try {
    assert.equal('taxable' in checkReceipt(good({ items: [{ description: 'a', amount: 1, taxable: true }] })).items[0], false);
  } finally {
    config.taxByItem = true;
  }
});

test('readReceipt asks for "taxable" only with TAX_BY_ITEM: one rule in the prompt, one field in the schema, one name in the request', async () => {
  const asked = [];
  const reading = JSON.stringify({ ...good(), items: [{ description: 'MILK', amount: 4.5, taxable: false }] });
  mock.method(globalThis, 'fetch', async (_url, init) => {
    asked.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: reading } }] }));
  });
  try {
    const on = await readReceipt(['data:image/jpeg;base64,AA==']);
    assert.equal(on.receipt.items[0].taxable, false);
    const text = JSON.stringify(asked[0].messages);
    assert.match(asked[0].messages[0].content, /"taxable" is per item/);
    assert.match(text, /items \(array of \{description, amount, taxable, tax_code\}\)/);
    config.taxByItem = false;
    await readReceipt(['data:image/jpeg;base64,AA==']);
    assert.doesNotMatch(JSON.stringify(asked[1].messages), /taxable/);
  } finally {
    config.taxByItem = true;
    mock.restoreAll();
  }
});

test('checkReceipt: "tax_code" is the mark as printed (trimmed, case kept), or null; off drops it', () => {
  const r = checkReceipt(good({ items: [{ description: 'a', amount: 1, taxable: true, tax_code: ' a ' }, { description: 'b', amount: 1, taxable: false, tax_code: 5 }, { description: 'c', amount: 1 }] }));
  assert.deepEqual(r.items.map((i) => i.tax_code), ['a', '5', undefined]);
  // F is a code like any other: the reader's yes stays
  assert.equal(checkReceipt(good({ items: [{ description: 'a', amount: 1, taxable: true, tax_code: 'f' }] })).items[0].taxable, true);
  config.taxByItem = false;
  try {
    assert.equal('tax_code' in checkReceipt(good({ items: [{ description: 'a', amount: 1, tax_code: 'A' }] })).items[0], false);
  } finally {
    config.taxByItem = true;
  }
});

test('checkReceipt: tax codes keep their case ("t" and "T" are different rates)', () => {
  const r = checkReceipt(good({ items: [{ description: 'a', amount: 1, taxable: true, tax_code: 'tF' }, { description: 'b', amount: 1, taxable: true, tax_code: 'T' }, { description: 'c', amount: 1, taxable: true, tax_code: 'f' }] }));
  assert.deepEqual(r.items.map((i) => i.tax_code), ['tF', 'T', 'f']);
  assert.deepEqual(r.items.map((i) => i.taxable), [true, true, true]);
  const l = checkReceipt(good({ tax_lines: [{ code: 't', rate: 5.5, base: 20.96, amount: 1.15 }, { code: 'T', rate: 8, base: 14.97, amount: 1.2 }] })).tax_lines;
  assert.deepEqual(l.map((x) => [x.code, x.base]), [['t', 20.96], ['T', 14.97]]);
});

test('checkReceipt: tax_lines are {code, rate in percent, base, amount}; strings and fractions are normalized; garbage becomes null; off drops it', () => {
  const lines = checkReceipt(good({ tax_lines: [
    { code: ' a ', rate: '8.6%', base: '$51.05', amount: '$4.39' }, { code: 'E', rate: 0.0325, base: 0, amount: 3.26 }, { code: null, rate: 'x', amount: 2 }, { code: 'B', amount: 'junk' }, 'junk', null,
  ] })).tax_lines;
  assert.deepEqual(lines, [{ code: 'a', rate: 8.6, base: 51.05, amount: 4.39 }, { code: 'E', rate: 0.0325, base: null, amount: 3.26 }, { code: null, rate: null, base: null, amount: 2 }]);
  for (const bad of [undefined, null, [], 'x', [{}], 5]) assert.equal(checkReceipt(good({ tax_lines: bad })).tax_lines, null);
  config.taxByItem = false;
  try {
    assert.equal('tax_lines' in checkReceipt(good({ tax_lines: [{ code: 'A', rate: 8, amount: 1 }] })), false);
  } finally {
    config.taxByItem = true;
  }
});

// ---- the remote reader (READER_PROVIDER=remote) ----

const KEY = 'sk-test-SECRET-key-987654';
const saved = { reader: { ...config.reader }, llmName: config.llmName };
const remoteOn = () => {
  Object.assign(config.reader, { provider: 'remote', url: 'https://api.openai.test/v1', host: 'api.openai.test', apiKey: KEY, model: 'gpt-4.1-mini' });
  forgetReaderQuirks();
};
const remoteOff = () => {
  Object.assign(config.reader, saved.reader);
  retryPolicy.sleep = realSleep;
  mock.restoreAll();
};
const realSleep = retryPolicy.sleep;
const IMG = ['data:image/jpeg;base64,AA=='];
const answer = (content = JSON.stringify(good())) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

test('remote reader request: Authorization, model, standard parameters only, a strict schema without unsupported keywords', async () => {
  remoteOn();
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return answer(); });
  try {
    const { receipt, mode } = await readReceipt(IMG);
    assert.equal(mode, 'remote');
    assert.equal(receipt.total, 10.8);
    assert.equal(calls.length, 1, 'one paid request');
    const { url, init, body } = calls[0];
    assert.equal(url, 'https://api.openai.test/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['X-Title'], undefined, 'only OpenRouter gets the app name');
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 4096);
    for (const k of ['top_k', 'top_p', 'min_p', 'repeat_penalty', 'chat_template_kwargs']) assert.ok(!(k in body), k);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'temperature']);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    const schema = JSON.stringify(body.response_format.json_schema.schema);
    assert.doesNotMatch(schema, /minItems|maxItems|minimum|maximum|pattern|"format"/);
    assert.match(schema, /"required"/); // the rest of the schema is kept
    // the request holds the prompt and the image, nothing else
    assert.deepEqual(body.messages[1].content[0], { type: 'image_url', image_url: { url: IMG[0] } });
    assert.ok(!JSON.stringify(body).includes(KEY));
  } finally {
    remoteOff();
  }
});

test('remote reader: OpenRouter gets the optional X-Title header and nothing personal', async () => {
  remoteOn();
  Object.assign(config.reader, { url: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', model: 'openai/gpt-4.1-mini' });
  let headers;
  mock.method(globalThis, 'fetch', async (_url, init) => { headers = init.headers; return answer(); });
  try {
    await readReceipt(IMG);
    assert.equal(headers['X-Title'], 'receipt-pipeline');
    assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type', 'X-Title']);
  } finally {
    remoteOff();
  }
});

test('local reader request is unchanged: no Authorization, no model, llama.cpp sampling, thinking off, 8192 tokens, a constrained second pass', async () => {
  const calls = [];
  let passes = 0;
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return passes++ === 0 ? answer('this is not json') : answer(); // the first pass fails, so the grammar-constrained pass runs
  });
  try {
    const { mode } = await readReceipt(IMG);
    assert.equal(mode, 'constrained');
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.url, `${config.llmUrl}/v1/chat/completions`);
      assert.equal(c.init.headers.Authorization, undefined);
      assert.ok(!('model' in c.body));
      assert.equal(c.body.top_k, 20);
      assert.equal(c.body.min_p, 0);
      assert.equal(c.body.temperature, 0.1);
      assert.equal(c.body.repeat_penalty, 1);
      assert.deepEqual(c.body.chat_template_kwargs, { enable_thinking: false });
    }
    assert.equal(calls[0].body.max_tokens, 8192);
    assert.ok(!('response_format' in calls[0].body));
    assert.equal(calls[1].body.max_tokens, 4096);
    assert.equal(calls[1].body.response_format.type, 'json_schema');
    assert.equal(calls[1].body.response_format.json_schema.strict, true);
    // the first pass of a good answer is direct
    calls.length = 0;
    passes = 1;
    assert.equal((await readReceipt(IMG)).mode, 'direct');
    assert.equal(calls.length, 1);
  } finally {
    mock.restoreAll();
  }
});

test('strictSchema: drops limits, patterns and formats everywhere, keeps the rest, keeps a field called "format", leaves the original alone', () => {
  const schema = { type: 'object', required: ['format', 'n'], properties: { format: { type: 'string', pattern: '^a', format: 'date' }, n: { type: 'number', minimum: 0, maximum: 9 }, list: { type: 'array', minItems: 1, maxItems: 5, items: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } } } };
  const copy = JSON.stringify(schema);
  assert.deepEqual(strictSchema(schema), { type: 'object', required: ['format', 'n'], properties: { format: { type: 'string' }, n: { type: 'number' }, list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } });
  assert.equal(JSON.stringify(schema), copy);
});

test('remote reader: a 400 about response_format retries once with JSON mode and the schema in the prompt', async () => {
  remoteOn();
  const calls = [];
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.response_format.type === 'json_schema') return new Response(JSON.stringify({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } }), { status: 400 });
    return answer();
  });
  try {
    const { receipt } = await readReceipt(IMG);
    assert.equal(receipt.total, 10.8);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].response_format, { type: 'json_object' });
    assert.match(calls[1].messages[0].content, /JSON Schema/);
    assert.match(calls[1].messages[0].content, /"merchant"/);
    assert.equal(calls[0].messages[0].content.includes('JSON Schema'), false);
  } finally {
    remoteOff();
  }
});

test('remote reader: a 400 that wants max_completion_tokens (newer OpenAI models) is retried with it', async () => {
  remoteOn();
  const calls = [];
  mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if ('max_tokens' in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 });
    return answer();
  });
  try {
    await readReceipt(IMG);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].max_completion_tokens, 4096);
    assert.ok(!('max_tokens' in calls[1]));
  } finally {
    remoteOff();
  }
});

test('remote reader: another 400 is an error with the provider words (scrubbed, at most 200 characters), no key, no image', async () => {
  remoteOn();
  const echo = `bad image data:image/jpeg;base64,${'A'.repeat(500)} Bearer ${KEY} key ${KEY} ${'x'.repeat(400)}`;
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: echo } }), { status: 400 }));
  try {
    await assert.rejects(readReceipt(IMG), (err) => {
      assert.match(err.message, /^reader HTTP 400: /);
      assert.ok(err.message.length <= 'reader HTTP 400: '.length + 200);
      assert.ok(!err.message.includes(KEY));
      assert.ok(!err.message.includes('AAAA'));
      return true;
    });
  } finally {
    remoteOff();
  }
});

test('remote reader: 401 and 403 say the key was refused, stop the cycle (SetupError) and never contain the key', async () => {
  remoteOn();
  for (const status of [401, 403]) {
    let n = 0;
    mock.method(globalThis, 'fetch', async () => { n++; return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status }); });
    try {
      await assert.rejects(readReceipt(IMG), (err) => {
        assert.match(err.message, /the reader API key was refused/);
        assert.match(err.message, /READER_API_KEY/);
        assert.ok(!err.message.includes(KEY));
        assert.ok(!JSON.stringify(err).includes(KEY));
        assert.equal(isSetupProblem(err), true);
        assert.equal(isTransient(err), false);
        return true;
      });
      assert.equal(n, 1, 'no retry for a refused key');
    } finally {
      mock.restoreAll();
    }
  }
  remoteOff();
});

test('remote reader: 429 is retried after Retry-After, then succeeds; 5xx backs off; running out of tries is transient', async () => {
  remoteOn();
  const sleeps = [];
  retryPolicy.sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  mock.method(globalThis, 'fetch', async () => {
    n++;
    if (n === 1) return new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } });
    if (n === 2) return new Response('oops', { status: 503 });
    return answer();
  });
  try {
    assert.equal((await readReceipt(IMG)).receipt.total, 10.8);
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [7000, 4000]); // Retry-After honored; otherwise 2 s doubling (attempt 1 -> 4 s)
    mock.restoreAll();
    sleeps.length = 0;
    n = 0;
    mock.method(globalThis, 'fetch', async () => { n++; return new Response(`busy ${KEY}`, { status: 502 }); });
    await assert.rejects(readReceipt(IMG), (err) => {
      assert.equal(isTransient(err), true);
      assert.match(err.message, /reader HTTP 502/);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
    assert.equal(n, 4, 'first try and three retries');
  } finally {
    remoteOff();
  }
});

test('remote reader: a network failure is transient, without the key', async () => {
  remoteOn();
  mock.method(globalThis, 'fetch', async () => { throw Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: 'ECONNREFUSED' } }); });
  try {
    await assert.rejects(readReceipt(IMG), (err) => {
      assert.equal(isTransient(err), true);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  } finally {
    remoteOff();
  }
});

test('remote reader: waitForModel makes one GET <base>/models with the key and never touches the local llm service', async () => {
  remoteOn();
  const urls = [];
  mock.method(globalThis, 'fetch', async (url, init) => { urls.push([String(url), init.headers.Authorization]); return new Response('nope', { status: 404 }); });
  try {
    await waitForModel(); // a 404 is "up": not every provider lists models
    assert.deepEqual(urls, [['https://api.openai.test/v1/models', `Bearer ${KEY}`]]);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
    await assert.rejects(waitForModel(), /the reader API key was refused/);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); });
    await assert.rejects(waitForModel(), (err) => isTransient(err));
  } finally {
    remoteOff();
  }
});

test('remote reader: the key never reaches the log or the console, in success or failure', async () => {
  remoteOn();
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) mock.method(console, m, (...a) => { lines.push(a.join(' ')); });
  let n = 0;
  mock.method(globalThis, 'fetch', async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { message: `response_format json_schema not supported ${KEY}` } }), { status: 400 });
    if (n === 2) return answer('not json at all');
    return new Response(KEY, { status: 401 });
  });
  try {
    await assert.rejects(readReceipt(IMG)); // JSON mode answer is unusable
    await assert.rejects(readReceipt(IMG), ReaderAuthError);
    assert.ok(lines.length > 0, 'the JSON-mode fallback is logged');
    assert.ok(!lines.join('\n').includes(KEY));
  } finally {
    remoteOff();
  }
});

// ---- the strict schema follows OpenAI's rules ----

/** Problems with a schema under OpenAI's strict structured outputs: every object closed (additionalProperties false) with all its properties required. */
function strictProblems(schema, at = 'root', found = []) {
  if (Array.isArray(schema)) {
    schema.forEach((x, i) => strictProblems(x, `${at}[${i}]`, found));
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  if (schema.type === 'object' || schema.properties) {
    if (schema.additionalProperties !== false) found.push(`${at}: additionalProperties is not false`);
    const keys = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    for (const k of keys) if (!required.includes(k)) found.push(`${at}: ${k} is not required`);
    for (const k of required) if (!keys.includes(k)) found.push(`${at}: ${k} is required but has no property`);
    for (const [k, v] of Object.entries(schema.properties ?? {})) strictProblems(v, `${at}.${k}`, found);
  }
  for (const k of ['items', 'anyOf', '$defs']) if (schema[k]) strictProblems(schema[k], `${at}/${k}`, found);
  return found;
}

test('remote reader: the schema sent in strict mode follows OpenAI\'s rules for every READ_PLAIN_NAMES and TAX_BY_ITEM setting', async () => {
  remoteOn();
  const sent = [];
  mock.method(globalThis, 'fetch', async (_url, init) => { sent.push(JSON.parse(init.body)); return answer(); });
  const savedFlags = { plainNames: config.plainNames, taxByItem: config.taxByItem };
  try {
    assert.ok(strictProblems({ type: 'object', properties: { a: { type: 'string' } }, required: [] }).length, 'the walker does find problems');
    for (const plainNames of [false, true]) {
      for (const taxByItem of [false, true]) {
        Object.assign(config, { plainNames, taxByItem });
        sent.length = 0;
        await readReceipt(IMG);
        const schema = sent[0].response_format.json_schema.schema;
        assert.equal(schema.type, 'object', 'the root is an object');
        assert.deepEqual(strictProblems(schema), [], `plainNames=${plainNames} taxByItem=${taxByItem}`);
        const itemFields = Object.keys(schema.properties.items.items.properties);
        assert.equal(itemFields.includes('plain'), plainNames);
        assert.equal(itemFields.includes('taxable'), taxByItem);
        assert.equal('tax_lines' in schema.properties, taxByItem);
      }
    }
  } finally {
    Object.assign(config, savedFlags);
    remoteOff();
  }
});

// ---- how the remote reader handles what a provider answers ----

const errBody = (message, extra = {}) => JSON.stringify({ error: { message, ...extra } });
const respond = (status, body, headers) => new Response(body, { status, headers });
/** Run readReceipt against a fetch that answers with the given responses in turn (the last one repeats); returns { calls, error, value }. */
async function readWith(...responses) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(JSON.parse(init.body));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next.clone();
  });
  try {
    return { calls, value: await readReceipt(IMG) };
  } catch (error) {
    return { calls, error };
  } finally {
    mock.restoreAll();
  }
}

test('remote reader: a 400 about temperature retries without it, and the next receipt does not send it at all', async () => {
  remoteOn();
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  try {
    const first = await readWith(respond(400, errBody("Unsupported value: 'temperature' does not support 0.1 with this model.")), new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good()) } }] })));
    assert.equal(first.value.receipt.total, 10.8);
    assert.equal(first.calls.length, 2);
    assert.ok('temperature' in first.calls[0]);
    assert.ok(!('temperature' in first.calls[1]));
    const second = await readWith(answer());
    assert.equal(second.calls.length, 1);
    assert.ok(!('temperature' in second.calls[0]), 'remembered');
    assert.equal(logs.filter((l) => /temperature/.test(l)).length, 1, 'said once');
  } finally {
    remoteOff();
  }
});

test('remote reader: a provider that needs JSON mode or max_completion_tokens is remembered: later receipts go straight to that form, the fallback is logged once', async () => {
  remoteOn();
  const logs = [];
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  try {
    const first = await readWith(
      respond(400, errBody("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")),
      respond(400, errBody("'response_format' of type 'json_schema' is not supported with this model.")),
      answer(),
    );
    assert.equal(first.error, undefined);
    assert.equal(first.calls.length, 3);
    const later = await readWith(answer());
    assert.equal(later.calls.length, 1, 'no more 400s to learn from');
    assert.equal(later.calls[0].max_completion_tokens, 4096);
    assert.ok(!('max_tokens' in later.calls[0]));
    assert.equal(later.calls[0].response_format.type, 'json_object');
    assert.match(later.calls[0].messages[0].content, /JSON Schema/);
    assert.equal(logs.filter((l) => /json_schema/.test(l)).length, 1);
    assert.equal(logs.filter((l) => /max_completion_tokens/.test(l)).length, 1);
    // another model on the same host has not been learned about
    config.reader.model = 'other-model';
    const other = await readWith(answer());
    assert.equal(other.calls[0].response_format.type, 'json_schema');
    assert.ok('max_tokens' in other.calls[0]);
  } finally {
    remoteOff();
  }
});

test('remote reader: at most three automatic fixes, then the 400 is reported', async () => {
  remoteOn();
  mock.method(console, 'log', () => {});
  try {
    // every answer complains about something the next fix can change, and then about response_format again
    const r = await readWith(
      respond(400, errBody('max_tokens is not supported')),
      respond(400, errBody('temperature is not supported')),
      respond(400, errBody('response_format json_schema is not supported')),
      respond(400, errBody('response_format is still not right')),
    );
    assert.equal(r.calls.length, 4, 'the first try and three fixes');
    assert.match(r.error.message, /^reader HTTP 400: /);
    assert.equal(isSetupProblem(r.error), false);
    assert.ok('response_format' in r.calls[3]);
  } finally {
    remoteOff();
  }
});

test('remote reader: a 429 that says the quota is used up is a setup problem (pause), not a retry', async () => {
  remoteOn();
  const sleeps = [];
  retryPolicy.sleep = async (ms) => { sleeps.push(ms); };
  try {
    for (const body of [errBody('You exceeded your current quota, please check your plan and billing details.', { type: 'insufficient_quota', code: 'insufficient_quota' }), errBody('Out of credits', { code: 'insufficient_quota' })]) {
      const r = await readWith(respond(429, body));
      assert.equal(r.calls.length, 1, 'no retry');
      assert.equal(isSetupProblem(r.error), true);
      assert.equal(isTransient(r.error), false);
      assert.match(r.error.message, /quota or credits/);
    }
    assert.deepEqual(sleeps, []);
    // an ordinary 429 is still retried
    const busy = await readWith(respond(429, errBody('Rate limit reached for requests', { type: 'requests', code: 'rate_limit_exceeded' })), answer());
    assert.equal(busy.calls.length, 2);
    assert.equal(busy.error, undefined);
  } finally {
    remoteOff();
  }
});

test('remote reader: a 403 about moderation fails only that receipt; a 403 about the key or the region does not', async () => {
  remoteOn();
  try {
    const flagged = await readWith(respond(403, errBody('Input was flagged by moderation', { code: 403, metadata: { reasons: ['violence'] } })));
    assert.equal(flagged.calls.length, 1);
    assert.equal(isSetupProblem(flagged.error), false);
    assert.equal(isTransient(flagged.error), false);
    assert.equal(flagged.error.permanent, true);
    assert.match(flagged.error.message, /blocked this receipt/);
    const auth = await readWith(respond(403, errBody(`The API key ${KEY} does not have permission to use this model`)));
    assert.ok(auth.error instanceof ReaderAuthError);
    assert.equal(isSetupProblem(auth.error), true);
    assert.ok(!auth.error.message.includes(KEY));
    const region = await readWith(respond(403, errBody('Country, region, or territory not supported', { code: 'unsupported_country_region_territory' })));
    assert.equal(isSetupProblem(region.error), true);
    assert.match(region.error.message, /country or region/);
    assert.ok(!(region.error instanceof ReaderAuthError));
    const noKey = await readWith(respond(401, errBody('Invalid key')));
    assert.ok(noKey.error instanceof ReaderAuthError);
  } finally {
    remoteOff();
  }
});

test('remote reader: 504, 524, 408 and a timeout are not retried in the same check (the provider may have billed them); 500, 502 and 503 are', async () => {
  remoteOn();
  const sleeps = [];
  retryPolicy.sleep = async (ms) => { sleeps.push(ms); };
  try {
    for (const status of [504, 524, 408]) {
      const r = await readWith(respond(status, 'gateway timeout'));
      assert.equal(r.calls.length, 1, String(status));
      assert.equal(isTransient(r.error), true);
      assert.equal(r.error.reader, true);
    }
    const timedOut = await readWith(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
    assert.equal(timedOut.calls.length, 1);
    assert.equal(timedOut.error.reader, true);
    assert.equal(isTransient(timedOut.error), true);
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      const undici = await readWith(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('timeout'), { code }) }); });
      assert.equal(undici.calls.length, 1, code);
      assert.equal(undici.error.reader, true, code);
    }
    assert.deepEqual(sleeps, []);
    for (const status of [500, 502, 503]) {
      const r = await readWith(respond(status, 'oops'), answer());
      assert.equal(r.calls.length, 2, String(status));
      assert.equal(r.error, undefined);
    }
  } finally {
    remoteOff();
  }
});

test('remote reader: an answer cut off at the token limit is a clear error for that receipt', async () => {
  remoteOn();
  try {
    const cut = new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"merchant": "Tar' } }] }));
    const r = await readWith(cut);
    assert.equal(r.calls.length, 1);
    assert.match(r.error.message, /cut off at 4096 tokens; a reasoning model may need more/);
    assert.equal(isSetupProblem(r.error), false);
    assert.equal(isTransient(r.error), false);
  } finally {
    remoteOff();
  }
});

test('remote reader: an "error" in a 200 answer goes through the same rules as an error status', async () => {
  remoteOn();
  retryPolicy.sleep = async () => {};
  const ok200 = (error) => new Response(JSON.stringify({ error }));
  try {
    const quota = await readWith(ok200({ code: 429, message: 'You exceeded your current quota', type: 'insufficient_quota' }));
    assert.equal(isSetupProblem(quota.error), true);
    assert.equal(quota.calls.length, 1);
    const auth = await readWith(ok200({ code: 401, message: 'No auth credentials found' }));
    assert.ok(auth.error instanceof ReaderAuthError);
    const busy = await readWith(ok200({ code: 503, message: 'Provider returned error' }), answer());
    assert.equal(busy.calls.length, 2);
    assert.equal(busy.error, undefined);
    const down = await readWith(ok200({ code: 503, message: 'Provider returned error' }));
    assert.equal(down.calls.length, 4);
    assert.equal(isTransient(down.error), true);
    const moderated = await readWith(ok200({ code: 403, message: 'Input was flagged by moderation' }));
    assert.equal(isSetupProblem(moderated.error), false);
    assert.equal(moderated.error.permanent, true);
    const odd = await readWith(ok200({ message: 'something odd', code: 'weird' }));
    assert.equal(odd.error.permanent, true);
    assert.equal(isTransient(odd.error), false);
    assert.equal(odd.calls.length, 1);
    assert.ok(!JSON.stringify(odd.error.message).includes(KEY));
  } finally {
    remoteOff();
  }
});

test('remote reader: only possibly-billed, receipt-specific failures count against the receipt; outages count nothing', async () => {
  remoteOn();
  retryPolicy.sleep = async () => {};
  try {
    for (const status of [504, 524, 408]) {
      const r = await readWith(respond(status, 'gateway timeout'));
      assert.equal(isCounted(r.error), true, String(status));
    }
    const timedOut = await readWith(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
    assert.equal(isCounted(timedOut.error), true);
    const aborted = await readWith(() => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); });
    assert.equal(isCounted(aborted.error), true);
    const cutBody = await readWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('terminated'); } }));
    assert.equal(isCounted(cutBody.error), true, 'the answer could not be read to the end');
    assert.equal(isTransient(cutBody.error), true);
    // retried out: a provider outage
    for (const status of [429, 500, 502, 503]) {
      const r = await readWith(respond(status, 'busy'));
      assert.equal(r.calls.length, 4, String(status));
      assert.equal(isTransient(r.error), true, String(status));
      assert.equal(isCounted(r.error), false, String(status));
    }
    const other5xx = await readWith(respond(520, 'unknown error'));
    assert.equal(isTransient(other5xx.error), true);
    assert.equal(isCounted(other5xx.error), false);
    // no connection, DNS
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']) {
      const r = await readWith(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }); });
      assert.equal(isTransient(r.error), true, code);
      assert.equal(isCounted(r.error), false, code);
    }
  } finally {
    remoteOff();
  }
});

test('isQuota: the structured error decides; words only when there is no code or type; bare "billing" is not quota', () => {
  assert.equal(isQuota(402, 'anything'), true);
  assert.equal(isQuota(429, JSON.stringify({ error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'x' } })), true);
  assert.equal(isQuota(429, JSON.stringify({ error: { type: 'insufficient_quota' } })), true);
  assert.equal(isQuota(429, JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details' } })), true); // no code: words
  assert.equal(isQuota(429, 'Insufficient credits'), true);
  // OpenAI's free-tier rate limit mentions the billing page, with a rate-limit code
  const rate = JSON.stringify({ error: { type: 'requests', code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-4.1-mini. Please add a payment method at https://platform.openai.com/account/billing' } });
  assert.equal(isQuota(429, rate), false);
  assert.equal(isQuota(429, 'Rate limit reached. See the billing page to add a payment method.'), false);
  // a named other code wins over quota-sounding words
  assert.equal(isQuota(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'you exceeded your current quota of requests per minute' } })), false);
  assert.equal(isQuota(429, JSON.stringify({ error: { code: 429, message: 'Too many requests' } })), false);
});

test('remote reader: a 400 about an image pauses only until the host and model has read one receipt, or fails twice in a row on different receipts', async () => {
  remoteOn();
  mock.method(console, 'log', () => {});
  const bad = () => respond(400, errBody('You uploaded an unsupported image. Please make sure your image is valid.'));
  const read = async (img, ...responses) => {
    const calls = [];
    mock.method(globalThis, 'fetch', async () => {
      calls.push(1);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      return next.clone();
    });
    try {
      return { value: await readReceipt([img]) };
    } catch (error) {
      return { error };
    } finally {
      mock.restoreAll();
      mock.method(console, 'log', () => {});
    }
  };
  const A = 'data:image/jpeg;base64,AAAA';
  const B = 'data:image/jpeg;base64,BBBB';
  const C = 'data:image/jpeg;base64,CCCC';
  try {
    // nothing has worked yet: the first such receipt is skipped for this check (not counted, nothing paused)
    const first = await read(A, bad());
    assert.equal(isSetupProblem(first.error), false);
    assert.equal(isSkip(first.error), true);
    assert.equal(isTransient(first.error), false);
    // the same receipt again is skipped again
    assert.equal(isSkip((await read(A, bad())).error), true);
    // a second, different receipt before any good reading: now it looks like the setup
    const second = await read(B, bad());
    assert.equal(isSetupProblem(second.error), true);
    assert.match(second.error.message, /may not accept images/);
    // a 'model does not exist' always pauses, even for a first receipt
    assert.equal(isSetupProblem((await read(C, respond(400, errBody('The model `gpt-9-ultra` does not exist')))).error), true);
    forgetReaderQuirks();
    assert.equal(isSkip((await read(A, bad())).error), true);
    // with no good reading, the other image wordings skip the first receipt too
    forgetReaderQuirks();
    for (const message of ['This model does not support image inputs.', 'No endpoints found that support image input']) {
      assert.equal(isSkip((await read(A, respond(400, errBody(message)))).error), true, message);
      forgetReaderQuirks();
    }
    // after a good reading, one bad photo is that receipt's problem
    assert.ok((await read(B, answer())).value);
    const one = await read(A, bad());
    assert.equal(isSetupProblem(one.error), false);
    assert.equal(one.error.permanent, true);
    assert.match(one.error.message, /HTTP 400/);
    // the same photo again is still just that receipt
    assert.equal(isSetupProblem((await read(A, bad())).error), false);
    // a different receipt with the same kind of 400, in a row: now it looks like the setup
    assert.equal(isSetupProblem((await read(C, bad())).error), true);
    // a good reading in between resets the run
    assert.ok((await read(B, answer())).value);
    assert.equal(isSetupProblem((await read(A, bad())).error), false);
    assert.ok((await read(B, answer())).value);
    assert.equal(isSetupProblem((await read(C, bad())).error), false);
    // a model that does not exist is always the setup's problem
    assert.equal(isSetupProblem((await read(A, respond(400, errBody('The model `gpt-9-ultra` does not exist')))).error), true);
  } finally {
    remoteOff();
  }
});

test('checkReceipt: savings is the receipt\'s printed total savings as a positive number, else null', () => {
  assert.equal(checkReceipt(good({ savings: 4 })).savings, 4);
  assert.equal(checkReceipt(good({ savings: '$3.20' })).savings, 3.2);
  assert.equal(checkReceipt(good({ savings: 0 })).savings, 0);
  for (const bad of [undefined, null, -4, '4.00-', 'a lot', NaN, Infinity, {}, '']) assert.equal(checkReceipt(good({ savings: bad })).savings, null, String(bad));
  assert.equal(checkReceipt(good()).savings, null); // a reading from before the field
});
