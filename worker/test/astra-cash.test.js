import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { accountAsked, lookAtActual } from '../src/cash.js';
import { editorFor } from '../src/receipt-fix.js';
import { receiptPage } from '../src/panel-receipt-page.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const entry = { ...fixture.entry, applied: undefined, result: 'review' };
const summary = structuredClone(fixture.summary);
delete summary.transaction;
summary.plan = { applied: false, parts: [] };
summary.receipt.payment_method = 'cash';
const preview = (query, cashLook) => editorFor({ id: fixture.id, entry, summary, query, cashLook });

test('cash account omission uses the setup default, while explicit empty and whitespace remain empty', () => {
  assert.equal(accountAsked(new URLSearchParams()), 'Cash wallet');
  assert.equal(accountAsked(new URLSearchParams({ acct: '' })), '');
  assert.equal(accountAsked(new URLSearchParams({ acct: '   ' })), '');
  assert.equal(accountAsked(new URLSearchParams({ acct: ' Checking ' })), 'Checking');
  for (const [query, expected] of [[new URLSearchParams(), 'Cash wallet'], [new URLSearchParams({ acct: '' }), ''], [new URLSearchParams({ acct: '   ' }), ''], [new URLSearchParams({ acct: ' Checking ' }), 'Checking']]) {
    assert.equal(preview(query).cash.account, expected, 'editor and lookup must agree about the requested account');
  }
});

test('explicit blank account never opens Actual or renders a cash commit form despite the configured default', async () => {
  let opens = 0;
  const query = new URLSearchParams({ preview: '1', acct: '' });
  const cashLook = await lookAtActual({ entry, summary, accountName: accountAsked(query) }, { actual: { async open() { opens++; throw new Error('Actual must not open'); } } });
  assert.match(cashLook.error, /No account is chosen/);
  assert.equal(opens, 0);
  const fix = preview(query, cashLook);
  assert.equal(fix.cash.account, '');
  assert.equal(fix.preview.cash.accountName, '');
  const html = receiptPage({ ...fixture.view(), entry, summary, fix }, 'fixture-key', '');
  assert.match(html, /No account is chosen/);
  assert.doesNotMatch(html, /<form\b[^>]*action="receipt-cash\?/);
});

test('choosing a valid account again produces a preview signed for that account', () => {
  const query = new URLSearchParams({ preview: '1', acct: 'Checking' });
  const cashLook = { account: { id: 'checking', name: 'Checking' }, payee: { id: 'riverside', name: 'Riverside Market', isNew: false }, duplicates: [] };
  const fix = preview(query, cashLook);
  assert.equal(fix.cash.account, 'Checking');
  assert.equal(fix.preview.cash.accountName, 'Checking');
  assert.match(fix.preview.token, /^[a-f0-9]{64}$/);
  assert.match(fix.preview.state, /^[a-f0-9]{64}$/);
  const html = receiptPage({ ...fixture.view(), entry, summary, fix }, 'fixture-key', '');
  assert.match(html, /<form\b[^>]*action="receipt-cash\?/);
  assert.match(html, /name="acct" value="Checking"/);
});
