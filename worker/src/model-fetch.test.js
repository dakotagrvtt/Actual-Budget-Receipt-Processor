// model-fetch.js: a request's own timeout wins over Node's built-in 300 s limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { modelFetch, dispatcherFor } from './model-fetch.js';

test('dispatcherFor gives an undici Agent, the same one for the same timeout', async () => {
  const a = await dispatcherFor(600000);
  assert.ok(a && typeof a.dispatch === 'function');
  assert.equal(await dispatcherFor(600000), a);
  assert.notEqual(await dispatcherFor(120000), a);
});

test('modelFetch passes a dispatcher and the request timeout as the signal', async () => {
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => { seen = init; return new Response('ok'); };
  try {
    await modelFetch('http://x.invalid/', { method: 'POST' }, 600000);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.method, 'POST');
  assert.ok(seen.dispatcher);
  assert.ok(seen.signal instanceof AbortSignal);
});

test('modelFetch reaches a local server and reads the body', async () => {
  const srv = http.createServer((req, res) => res.end('hello')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const res = await modelFetch(`http://127.0.0.1:${srv.address().port}/`, {}, 5000);
    assert.equal(await res.text(), 'hello');
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
});

test('modelFetch times out with a TimeoutError from its own signal', async () => {
  const srv = http.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    await assert.rejects(modelFetch(`http://127.0.0.1:${srv.address().port}/`, {}, 100), (e) => e.name === 'TimeoutError');
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
});
