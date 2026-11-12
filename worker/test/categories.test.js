// categories.js: with a cloud reader, category descriptions are never written on their own and only after a confirmation.
import './support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

const { autoDescribeAllowed, describeMissing, DESCRIBE_SENDS } = await import('../src/categories.js');
const saved = { ...config.reader };
afterEach(() => {
  Object.assign(config.reader, saved);
  mock.restoreAll();
});

test('autoDescribeAllowed: yes with the local reader, no with a cloud reader (the worker cycle skips describing)', () => {
  assert.equal(autoDescribeAllowed(), true);
  config.reader.provider = 'remote';
  assert.equal(autoDescribeAllowed(), false);
});

test('describeMissing with a cloud reader refuses without a confirmation and sends nothing', async () => {
  config.reader.provider = 'remote';
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('nothing may be sent'); });
  await assert.rejects(describeMissing(['Groceries'], new Map([['Groceries', 'id1']])), /cloud service.*confirm/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('the list of what a description request sends names each kind of data', () => {
  const text = DESCRIBE_SENDS.join(' ');
  for (const word of [/category name/, /transactions/, /store names/, /item notes/]) assert.match(text, word);
});
