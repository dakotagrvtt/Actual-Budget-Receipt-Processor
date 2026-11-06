// actual.js transaction readers, against a fake @actual-app/api (test/support.js swaps the package for a stand-in object).
import '../test/support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';

const { default: api } = await import('@actual-app/api');
const actual = await import('./actual.js');

const accounts = [
  { id: 'a1', name: 'Checking' },
  { id: 'a2', name: 'Closed card', closed: true },
  { id: 'a3', name: 'Mortgage', offbudget: true },
  { id: 'a4', name: 'Credit card' },
];
const txns = {
  a1: [
    { id: 't1', date: '2026-10-01', amount: -1000, payee: 'p1', notes: '' },
    { id: 't2', date: '2026-10-20', amount: -1000, payee: 'p9', imported_payee: 'RAW' },
  ],
  a2: [{ id: 't3', date: '2026-10-01', amount: -1000, payee: 'p1' }],
  a3: [{ id: 't4', date: '2026-10-01', amount: -1000, payee: 'p1' }],
  a4: [{ id: 't5', date: '2026-10-02', amount: -1000, payee: 'p2', notes: '#receipt a.jpg | x' }],
};
const asked = [];
const fakeBudget = () => {
  mock.method(api, 'getAccounts', async () => accounts);
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Store One' }, { id: 'p2', name: 'Store Two' }]);
  mock.method(api, 'getTransactions', async (id, start, end) => {
    asked.push(id);
    return txns[id].filter((t) => t.date >= start && t.date <= end);
  });
};
const saved = JSON.parse(JSON.stringify(config.match));
afterEach(() => {
  mock.restoreAll();
  asked.length = 0;
  Object.assign(config.match, JSON.parse(JSON.stringify(saved)));
});

const collect = async (gen) => {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
};

test('budgetTransactions: open on-budget accounts in order, with payee names and date bounds', async () => {
  fakeBudget();
  const got = await collect(actual.budgetTransactions('2026-10-01', '2026-10-31'));
  assert.deepEqual(got.map((x) => [x.t.id, x.account.id, x.payeeName]), [['t1', 'a1', 'Store One'], ['t2', 'a1', null], ['t5', 'a4', 'Store Two']]);
  assert.deepEqual(asked, ['a1', 'a4']); // closed and off-budget accounts are never read
  assert.deepEqual((await collect(actual.budgetTransactions('2026-10-15', '2026-10-31'))).map((x) => x.t.id), ['t2']);
});

test('budgetTransactions: matchAccounts applies MATCH_ACCOUNTS only when asked for', async () => {
  fakeBudget();
  config.match.accounts = ['Credit card'];
  assert.deepEqual((await collect(actual.budgetTransactions('2026-10-01', '2026-10-31', { matchAccounts: true }))).map((x) => x.t.id), ['t5']);
  assert.deepEqual((await collect(actual.budgetTransactions('2026-10-01', '2026-10-31'))).map((x) => x.t.id), ['t1', 't2', 't5']);
});

test('budgetTransactions: stops fetching when the caller stops', async () => {
  fakeBudget();
  for await (const x of actual.budgetTransactions('2026-10-01', '2026-10-31')) if (x.t.id === 't1') break;
  assert.deepEqual(asked, ['a1']);
});

test('findTaggedTransaction: finds the tagged note across accounts and returns early', async () => {
  fakeBudget();
  const hit = await actual.findTaggedTransaction('a.jpg', '2026-09-01');
  assert.equal(hit.id, 't5');
  assert.equal(hit.accountName, 'Credit card');
  assert.equal(hit.payeeName, 'Store Two');
  assert.equal(await actual.findTaggedTransaction('a', '2026-09-01'), null); // "a" is not "a.jpg"
});
