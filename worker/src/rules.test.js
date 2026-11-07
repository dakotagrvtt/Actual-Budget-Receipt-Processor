// rules.js: evaluating Actual's rules (conditions, stages, ordering) to get a transaction's category and the stores per category.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setRules, ruleCategoryFor, ruleStoresByCategory, amountRulesFor } from './rules.js';

const payees = [{ id: 'p-target', name: 'Target' }, { id: 'p-shell', name: 'Shell Oil' }];
const accounts = [{ id: 'acc-on', name: 'Card' }, { id: 'acc-off', name: 'Mortgage', offbudget: true }];
const categories = [{ id: 'cat-groc', name: 'Groceries', group_id: 'g1' }, { id: 'cat-gas', name: 'Gas', group_id: 'g2' }];
const setCat = (value, options) => ({ op: 'set', field: 'category', value, ...(options ? { options } : {}) });
const rule = (id, conditions, actions, extra = {}) => ({ id, stage: null, conditionsOp: 'and', conditions, actions, ...extra });
const is = (field, value) => ({ field, op: 'is', value });
const install = (rules) => setRules(rules, { payees, accounts, categories });
const txn = (extra = {}) => ({ id: 't1', payee: 'p-target', imported_payee: 'TARGET 123', account: 'acc-on', amount: -2500, date: '2026-10-26', notes: '', ...extra });

test('setRules returns the rule count', () => {
  assert.equal(install([rule('a', [is('payee', 'p-target')], [setCat('cat-groc')])]), 1);
  assert.equal(install([]), 0);
});

test('ruleCategoryFor: a matching rule gives its category; no match gives null', () => {
  install([rule('a', [is('payee', 'p-target')], [setCat('cat-groc')])]);
  assert.equal(ruleCategoryFor(txn()), 'cat-groc');
  assert.equal(ruleCategoryFor(txn({ payee: 'p-shell' })), null);
});

test('ruleCategoryFor: stages run pre, then default, then post; the last set wins', () => {
  install([
    rule('c', [is('payee', 'p-target')], [setCat('post')], { stage: 'post' }),
    rule('a', [is('payee', 'p-target')], [setCat('pre')], { stage: 'pre' }),
    rule('b', [is('payee', 'p-target')], [setCat('mid')]),
  ]);
  assert.equal(ruleCategoryFor(txn()), 'post');
  install([rule('b', [is('payee', 'p-target')], [setCat('mid')]), rule('a', [is('payee', 'p-target')], [setCat('pre')], { stage: 'pre' })]);
  assert.equal(ruleCategoryFor(txn()), 'mid');
});

test('ruleCategoryFor: within a stage the more specific rule goes later and wins', () => {
  install([
    rule('1-specific', [is('payee', 'p-target'), is('account', 'acc-on')], [setCat('specific')]),
    rule('2-general', [{ field: 'imported_payee', op: 'contains', value: 'target' }], [setCat('general')]),
  ]);
  // "is" conditions score higher than "contains", so the general rule is applied first and the specific one overrides it
  assert.equal(ruleCategoryFor(txn()), 'specific');
});

test('ruleCategoryFor: equal scores are ordered by rule id', () => {
  install([
    rule('b', [is('payee', 'p-target')], [setCat('from-b')]),
    rule('a', [is('payee', 'p-target')], [setCat('from-a')]),
  ]);
  assert.equal(ruleCategoryFor(txn()), 'from-b');
});

test("ruleCategoryFor: a split rule's per-part categories are ignored", () => {
  install([rule('a', [is('payee', 'p-target')], [setCat('part1', { splitIndex: 1 }), setCat('part2', { splitIndex: 2 })])]);
  assert.equal(ruleCategoryFor(txn()), null);
  install([rule('a', [is('payee', 'p-target')], [setCat('whole', { splitIndex: 0 })])]);
  assert.equal(ruleCategoryFor(txn()), 'whole');
});

test('ruleCategoryFor: template and formula setters are skipped', () => {
  install([rule('a', [is('payee', 'p-target')], [setCat('t', { template: '{{x}}' }), setCat('f', { formula: '=1' })])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleCategoryFor: contains compares the payee name, not its id', () => {
  install([rule('a', [{ field: 'payee', op: 'contains', value: 'TARG' }], [setCat('cat-groc')])]);
  assert.equal(ruleCategoryFor(txn()), 'cat-groc');
  assert.equal(ruleCategoryFor(txn({ payee: 'p-shell' })), null);
  assert.equal(ruleCategoryFor(txn({ payee: null })), null);
});

test('ruleCategoryFor: payee_name and imported_payee conditions are case-insensitive', () => {
  install([rule('a', [{ field: 'payee_name', op: 'is', value: 'TARGET' }], [setCat('x')])]);
  assert.equal(ruleCategoryFor(txn()), 'x');
  install([rule('a', [{ field: 'imported_payee', op: 'matches', value: '^target \\d+$' }], [setCat('y')])]);
  assert.equal(ruleCategoryFor(txn()), 'y');
});

test('ruleCategoryFor: an invalid regex never matches', () => {
  install([rule('a', [{ field: 'imported_payee', op: 'matches', value: '(' }], [setCat('x')])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleCategoryFor: oneOf, isNot and notOneOf', () => {
  install([rule('a', [{ field: 'payee', op: 'oneOf', value: ['p-shell', 'p-target'] }], [setCat('one')])]);
  assert.equal(ruleCategoryFor(txn()), 'one');
  install([rule('a', [{ field: 'payee', op: 'isNot', value: 'p-target' }], [setCat('not')])]);
  assert.equal(ruleCategoryFor(txn()), null);
  install([rule('a', [{ field: 'payee', op: 'notOneOf', value: ['p-shell'] }], [setCat('none')])]);
  assert.equal(ruleCategoryFor(txn()), 'none');
});

test('ruleCategoryFor: isapprox on an amount allows 7.5%', () => {
  install([rule('a', [{ field: 'amount', op: 'isapprox', value: -2500 }], [setCat('near')])]);
  assert.equal(ruleCategoryFor(txn({ amount: -2600 })), 'near');
  assert.equal(ruleCategoryFor(txn({ amount: -2800 })), null);
});

test('ruleCategoryFor: gt, lt and isbetween on amounts', () => {
  install([rule('a', [{ field: 'amount', op: 'lt', value: -2000 }], [setCat('big')])]);
  assert.equal(ruleCategoryFor(txn()), 'big');
  assert.equal(ruleCategoryFor(txn({ amount: -1000 })), null);
  install([rule('a', [{ field: 'amount', op: 'isbetween', value: { num1: -3000, num2: -2000 } }], [setCat('between')])]);
  assert.equal(ruleCategoryFor(txn()), 'between');
});

test('ruleCategoryFor: the outflow option compares the amount as a positive number', () => {
  install([rule('a', [{ field: 'amount', op: 'gt', value: 2000, options: { outflow: true } }], [setCat('out')])]);
  assert.equal(ruleCategoryFor(txn()), 'out');
  assert.equal(ruleCategoryFor(txn({ amount: 2500 })), null); // an inflow never matches an outflow condition
});

test('ruleCategoryFor: hasTags and hasAnyTag read #tags in notes', () => {
  install([rule('a', [{ field: 'notes', op: 'hasTags', value: '#receipt #review' }], [setCat('both')])]);
  assert.equal(ruleCategoryFor(txn({ notes: 'x #receipt y #review' })), 'both');
  assert.equal(ruleCategoryFor(txn({ notes: '#receipt only' })), null);
  install([rule('a', [{ field: 'notes', op: 'hasAnyTag', value: '#receipt #review' }], [setCat('any')])]);
  assert.equal(ruleCategoryFor(txn({ notes: '#receipt only' })), 'any');
  assert.equal(ruleCategoryFor(txn({ notes: 'no tags' })), null);
});

test('ruleCategoryFor: date operators', () => {
  install([rule('a', [{ field: 'date', op: 'is', value: '2026-10' }], [setCat('month')])]);
  assert.equal(ruleCategoryFor(txn()), 'month');
  assert.equal(ruleCategoryFor(txn({ date: '2026-11-01' })), null);
  install([rule('a', [{ field: 'date', op: 'isapprox', value: '2026-10-28' }], [setCat('near')])]);
  assert.equal(ruleCategoryFor(txn()), 'near'); // within 2 days
  assert.equal(ruleCategoryFor(txn({ date: '2026-10-20' })), null);
  install([rule('a', [{ field: 'date', op: 'gt', value: '2026-10-25' }], [setCat('after')])]);
  assert.equal(ruleCategoryFor(txn()), 'after');
  // month and year values are not valid for gt/lt in Actual
  install([rule('a', [{ field: 'date', op: 'gt', value: '2026-10' }], [setCat('after')])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleCategoryFor: onBudget and offBudget use the account', () => {
  install([rule('a', [{ field: 'account', op: 'onBudget' }], [setCat('on')])]);
  assert.equal(ruleCategoryFor(txn()), 'on');
  assert.equal(ruleCategoryFor(txn({ account: 'acc-off' })), null);
  assert.equal(ruleCategoryFor(txn({ account: 'unknown' })), null);
  install([rule('a', [{ field: 'account', op: 'offBudget' }], [setCat('off')])]);
  assert.equal(ruleCategoryFor(txn({ account: 'acc-off' })), 'off');
});

test('ruleCategoryFor: category_group is filled in from the transaction category', () => {
  install([rule('a', [is('category_group', 'g1')], [setCat('grp')])]);
  assert.equal(ruleCategoryFor(txn({ category: 'cat-groc' })), 'grp');
  assert.equal(ruleCategoryFor(txn({ category: 'cat-gas' })), null);
});

test('ruleCategoryFor: conditionsOp "or" needs one condition; an empty rule never matches', () => {
  install([rule('a', [is('payee', 'p-shell'), is('account', 'acc-on')], [setCat('or')], { conditionsOp: 'or' })]);
  assert.equal(ruleCategoryFor(txn()), 'or');
  install([rule('a', [], [setCat('empty')])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleCategoryFor: an unknown operator never matches', () => {
  install([rule('a', [{ field: 'notes', op: 'weird', value: 'x' }], [setCat('x')])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleCategoryFor: a rule with no matching category action leaves the category alone', () => {
  install([rule('a', [is('payee', 'p-target')], [{ op: 'set', field: 'notes', value: 'hi' }])]);
  assert.equal(ruleCategoryFor(txn()), null);
});

test('ruleStoresByCategory: stores named by payee is and oneOf conditions, per category', () => {
  install([
    rule('a', [is('payee', 'p-target')], [setCat('cat-groc')]),
    rule('b', [{ field: 'imported_payee', op: 'oneOf', value: ['HY-VEE', 'ALDI'] }], [setCat('cat-groc')]),
    rule('c', [is('payee', 'p-shell')], [setCat('cat-gas')]),
  ]);
  const stores = ruleStoresByCategory();
  assert.deepEqual([...stores.get('cat-groc')].sort(), ['ALDI', 'HY-VEE', 'Target']);
  assert.deepEqual(stores.get('cat-gas'), ['Shell Oil']);
});

test("ruleStoresByCategory: split-rule parts and rules on other operators don't count", () => {
  install([
    rule('a', [is('payee', 'p-target')], [setCat('cat-groc', { splitIndex: 1 })]),
    rule('b', [{ field: 'payee', op: 'contains', value: 'shell' }], [setCat('cat-gas')]),
    rule('c', [{ field: 'amount', op: 'is', value: -100 }], [setCat('cat-gas')]),
  ]);
  assert.equal(ruleStoresByCategory().size, 0);
});

test('ruleStoresByCategory: takes a payee map, and the last set action of a rule wins', () => {
  install([rule('a', [is('payee', 'p-x')], [setCat('first'), setCat('last')])]);
  const stores = ruleStoresByCategory(new Map([['p-x', 'Corner Store']]));
  assert.deepEqual(stores.get('last'), ['Corner Store']);
  assert.equal(stores.has('first'), false);
});

const costco = [{ id: 'p-costco', name: 'Costco' }, { id: 'p-hv', name: 'Hy-Vee' }];
const costcoCats = [{ id: 'cat-groc', name: 'Groceries', group_id: 'g1' }, { id: 'cat-rest', name: 'Restaurants', group_id: 'g1' }];
const installCostco = (rules) => setRules(rules, { payees: costco, accounts, categories: costcoCats });
const costcoTxn = (extra = {}) => ({ id: 't2', payee: 'p-costco', account: 'acc-on', amount: -1378, date: '2026-10-26', ...extra });

test('amountRulesFor: pre oneOf + default is + post "amount gte -1100" gives two ranges split at $11.00', () => {
  installCostco([
    rule('a', [{ field: 'payee', op: 'oneOf', value: ['p-hv', 'p-costco'] }], [setCat('cat-groc')], { stage: 'pre' }),
    rule('b', [is('payee', 'p-costco')], [setCat('cat-groc')]),
    rule('c', [is('payee', 'p-costco'), { field: 'amount', op: 'gte', value: -1100 }], [setCat('cat-rest')], { stage: 'post' }),
  ]);
  assert.equal(ruleCategoryFor(costcoTxn()), 'cat-groc');
  const want = [{ upTo: 11, category: 'cat-rest' }, { over: 11, category: 'cat-groc' }];
  assert.deepEqual(amountRulesFor(costcoTxn()), want);
  assert.deepEqual(amountRulesFor(costcoTxn({ amount: -500 })), want); // same answer whatever this charge is
  assert.deepEqual(amountRulesFor(costcoTxn({ payee: 'p-hv' })), []); // the amount rule is not about this store
});

test('amountRulesFor: isbetween gives three ranges (edges are inclusive: $10.00 itself is in the middle range)', () => {
  installCostco([
    rule('a', [is('payee', 'p-costco')], [setCat('cat-groc')], { stage: 'pre' }),
    rule('b', [is('payee', 'p-costco'), { field: 'amount', op: 'isbetween', value: { num1: -2000, num2: -1000 } }], [setCat('cat-rest')]),
  ]);
  assert.deepEqual(amountRulesFor(costcoTxn()), [
    { upTo: 9.99, category: 'cat-groc' },
    { over: 9.99, upTo: 20, category: 'cat-rest' },
    { over: 20, category: 'cat-groc' },
  ]);
});

test('amountRulesFor: outflow option, and a rule with no amount condition gives nothing', () => {
  installCostco([rule('a', [is('payee', 'p-costco'), { field: 'amount', op: 'gt', value: 5000, options: { outflow: true } }], [setCat('cat-rest')])]);
  assert.deepEqual(amountRulesFor(costcoTxn()), [{ upTo: 50, category: null }, { over: 50, category: 'cat-rest' }]);
  installCostco([rule('a', [is('payee', 'p-costco')], [setCat('cat-groc')])]);
  assert.deepEqual(amountRulesFor(costcoTxn()), []);
});
