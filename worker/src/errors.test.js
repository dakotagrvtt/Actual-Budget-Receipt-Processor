// errors.js: which errors count as outages or setup problems (and so never as a failed attempt at a receipt), and which do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TransientError, PermanentError, SetupError, isTransient, isSetupProblem } from './errors.js';

test('isTransient: outages and timeouts are; the message of a PermanentError never makes it one', () => {
  assert.equal(isTransient(new TransientError('x')), true);
  assert.equal(isTransient(new Error('fetch failed')), true);
  assert.equal(isTransient(new Error('model HTTP 503')), true);
  // a 4xx body that happens to say "network" and "503" (an echoed item) is not an outage
  const echoed = new PermanentError('remote decider HTTP 422; the server said: {"input":{"item":"NETWORK CABLE 503 timed out"}}');
  assert.equal(isTransient(echoed), false);
  assert.equal(isTransient(new SetupError('NETWORK 503')), false);
  // wrapping does not change that
  assert.equal(isTransient(new Error('wrapper', { cause: echoed })), false);
  assert.equal(isTransient(new Error('plain bug')), false);
});

test('isSetupProblem: only a SetupError (or one wrapped in another error) stops the cycle without counting an attempt', () => {
  assert.equal(isSetupProblem(new SetupError('bad key')), true);
  assert.equal(isSetupProblem(new Error('wrapper', { cause: new SetupError('bad key') })), true);
  assert.equal(isSetupProblem(new PermanentError('one receipt')), false);
  assert.equal(isSetupProblem(new TransientError('down')), false);
  assert.equal(isSetupProblem(new Error('x')), false);
});

test('isClientTimeout: our timeout, an abort, and undici header/body timeouts anywhere in the cause chain', async () => {
  const { isClientTimeout } = await import('./errors.js');
  const wrap = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
  assert.equal(isClientTimeout(wrap('UND_ERR_HEADERS_TIMEOUT')), true);
  assert.equal(isClientTimeout(wrap('UND_ERR_BODY_TIMEOUT')), true);
  assert.equal(isClientTimeout(Object.assign(new Error('a'), { cause: wrap('UND_ERR_BODY_TIMEOUT') })), true);
  assert.equal(isClientTimeout(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
  assert.equal(isClientTimeout(wrap('ECONNREFUSED')), false);
  assert.equal(isClientTimeout(null), false);
});
