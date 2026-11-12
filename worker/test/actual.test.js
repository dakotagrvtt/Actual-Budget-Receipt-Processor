// actual.js transaction readers, against a fake @actual-app/api (test/support.js swaps the package for a stand-in object).
import './support.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

const { default: api } = await import('@actual-app/api');
const actual = await import('../src/actual.js');

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

test('findTaggedTransactions: finds the tagged note across accounts', async () => {
  fakeBudget();
  const [hit] = await actual.findTaggedTransactions('a.jpg', '2026-09-01');
  assert.equal(hit.id, 't5');
  assert.equal(hit.accountName, 'Credit card');
  assert.equal(hit.payeeName, 'Store Two');
  assert.deepEqual(await actual.findTaggedTransactions('a', '2026-09-01'), []); // "a" is not "a.jpg"
});

test('hasTag accepts every note format receipt.js writes, and rejects other files that start with the same name', () => {
  const name = 'receipt.jpg';
  const tag = `#receipt ${name}`;
  for (const review of ['', ' #review']) {
    const note = `${tag}${review}`;
    const formats = [
      note, // split: the tag alone (the parts go in the sub-transactions)
      `${note} — items: milk; eggs`, // single category: categorize / confirm / note with items
      `${note}: Groceries $10.00, Home $5.00`, // categorize with several categories, or the note action
    ];
    for (const f of formats) {
      assert.equal(actual.hasTag(f, tag), true, f);
      assert.equal(actual.hasTag(`Weekly shop | ${f}`, tag), true, `joined after an existing note: ${f}`);
      assert.equal(actual.hasTag(`${f} | later note`, tag), true, `followed by another note: ${f}`);
    }
  }
  for (const other of ['receipt.jpg2', 'receipt.jpg.bak', 'receipt.jpgx: parts', 'receipt.jpg:parts']) {
    assert.equal(actual.hasTag(`#receipt ${other}`, tag), false, other);
  }
  // an earlier near miss does not hide a real tag later in the note
  assert.equal(actual.hasTag('#receipt receipt.jpg2 | #receipt receipt.jpg: parts', tag), true);
});

test('hasTag: a bare space after the file name is not enough, so a name with spaces is not mistaken for its prefix', () => {
  // "a.jpg scan.jpg" is a file name with a space; its note must not count as the tag of a new "a.jpg"
  assert.equal(actual.hasTag('#receipt a.jpg scan.jpg', '#receipt a.jpg'), false);
  assert.equal(actual.hasTag('#receipt a.jpg scan.jpg #review — items: milk', '#receipt a.jpg'), false);
  assert.equal(actual.hasTag('#receipt a.jpg scan.jpg: Groceries $1.00', '#receipt a.jpg'), false);
  assert.equal(actual.hasTag('#receipt a.jpg #review.jpg', '#receipt a.jpg'), false);
  assert.equal(actual.hasTag('#receipt a.jpg  notes', '#receipt a.jpg'), false);
  // ... and a real name with spaces still matches itself in every format the worker writes
  const tag = '#receipt a.jpg scan.jpg';
  for (const f of [tag, `${tag} #review`, `${tag} — items: milk`, `${tag} #review — items: milk`, `${tag}: Groceries $1.00`, `Weekly shop | ${tag} | later`, `${tag} `]) {
    assert.equal(actual.hasTag(f, tag), true, f);
  }
  // the shorter name's own tag still matches, even next to the longer one
  assert.equal(actual.hasTag('#receipt a.jpg scan.jpg | #receipt a.jpg — items: tea', '#receipt a.jpg'), true);
});

test('realPayeeNames: transfer payees (your own accounts) are left out; budgetTransactions says which payee is a transfer', async () => {
  fakeBudget();
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Store One' }, { id: 'p2', name: "Alex's Checking", transfer_acct: 'a4' }, { id: 'p3', name: '' }]);
  assert.deepEqual(await actual.realPayeeNames(), ['Store One']);
  assert.deepEqual([...(await actual.payeeNames()).values()], ['Store One', "Alex's Checking", '']); // unchanged for everything else
  const got = await collect(actual.budgetTransactions('2026-10-01', '2026-10-31'));
  assert.deepEqual(got.map((x) => [x.t.id, x.payeeName, x.payeeIsTransfer]), [['t1', 'Store One', false], ['t2', null, false], ['t5', "Alex's Checking", true]]);
});

test('itemHistory: each note carries payee (the real Actual payee) next to store (which may be the raw bank text)', async () => {
  fakeBudget();
  mock.method(api, 'getPayees', async () => [{ id: 'p1', name: 'Store One' }, { id: 'p2', name: "Alex's Checking", transfer_acct: 'a4' }]);
  const today = new Date().toISOString().slice(0, 10);
  mock.method(api, 'getTransactions', async (id) => (id === 'a1'
    ? [
        { id: 'h1', date: today, amount: -500, payee: 'p1', category: 'c1', notes: '#receipt x.jpg — items: milk' },
        { id: 'h2', date: today, amount: -500, payee: 'p2', category: 'c1', notes: '#receipt y.jpg — items: tickets' },
        { id: 'h3', date: today, amount: -500, payee: 'p9', imported_payee: 'Zelle to Sam Example', category: 'c1', notes: '#receipt z.jpg — items: lunch' },
      ]
    : []));
  const found = await actual.itemHistory('none', new Map([['c1', 'A / One']]));
  const by = Object.fromEntries(found.map((f) => [f.items, [f.store, f.payee]]));
  assert.deepEqual(by, { milk: ['Store One', 'Store One'], tickets: ["Alex's Checking", null], lunch: ['Zelle to Sam Example', null] });
});

test('cash create removes an unused new payee after an add failure, but keeps one used by an accepted transaction', async () => {
  let used = false;
  const deleted = [];
  api.createPayee = async () => 'new-payee';
  api.deletePayee = async (id) => deleted.push(id);
  api.addTransactions = async () => { throw new Error('add failed'); };
  mock.method(api, 'getTransactions', async () => used ? [{ payee: 'new-payee' }] : []);
  try {
    await assert.rejects(actual.createTransaction('a1', { name: 'New Store' }, { id: 'new' }), /add failed/);
    assert.deepEqual(deleted, ['new-payee']);
    used = true;
    await assert.rejects(actual.createTransaction('a1', { name: 'New Store' }, { id: 'new' }), /add failed/);
    assert.deepEqual(deleted, ['new-payee']);
  } finally {
    delete api.createPayee; delete api.deletePayee; delete api.addTransactions;
  }
});

test('cash verification rejects a split parent with a category set by a rule', () => {
  const children = [{ amount: -100, category: 'cg', notes: 'milk' }];
  const want = { notes: '#receipt sample.jpg', children };
  assert.equal(actual.isWritten({ notes: want.notes, is_parent: true, category: 'ch', subtransactions: children }, want), false);
  assert.equal(actual.isWritten({ notes: want.notes, is_parent: true, category: null, subtransactions: children }, want), true);
});
