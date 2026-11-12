// Round 2: each page has its own document title and page heading, and client navigation updates the title and moves focus to the new page.
import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { archivedPage, archiveAllPage } from '../src/panel-archive-page.js';
import { goLivePage } from '../src/panel-status.js';
import { learnedPage, categoriesPage } from '../src/panel-lists.js';
import { WORKSPACE_SCRIPT } from '../src/panel-workspace-script.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)[1];
const h1Of = (html) => html.match(/<h1 class="sr-only" tabindex="-1" data-page-heading>([^<]*)<\/h1>/)?.[1];

test('every page has a meaningful <title> and a matching page heading inside <main>', () => {
  const section = (name) => fixture.renderSettings({}, '', name);
  const cases = [
    ['Inbox', 'Inbox', fixture.overviewHtml],
    ['Settings', 'Settings', fixture.settingsHtml],
    ['Appearance', 'Appearance', section('appearance')],
    ['Everyday', 'Everyday', section('everyday')],
    ['Category rules', 'Category rules', fixture.ruleHtml],
    ['Archive', 'Archive', archivedPage({ archived: [], dryRun: false }, 'k', '')],
    ['Archive all done receipts', 'Archive all done receipts', archiveAllPage({ dryRun: false, count: 2 }, 'k', '')],
    ['Go live', 'Go live', goLivePage('k', '')],
    ['Riverside Market', 'Receipt', fixture.renderReceipt()],
  ];
  for (const [title, heading, html] of cases) {
    assert.equal(titleOf(html), `${title} · Receipts`, title);
    assert.equal(h1Of(html), heading, title);
    assert.ok(html.indexOf('<h1 ') > html.indexOf('<main'), `${title}: the heading is replaced with the page on client navigation`);
  }
  assert.equal(new Set(cases.map((c) => titleOf(c[2]))).size, cases.length, 'no two pages share a title');
});

test('the page heading is not a second visible heading', () => {
  const html = fixture.settingsHtml;
  assert.match(html, /\.sr-only\{/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
});

test('client navigation sets document.title and focuses the notice, the receipt title or the page heading, in that order', () => {
  assert.match(WORKSPACE_SCRIPT, /document\.title = title/);
  const order = ['.notice', '[data-workspace-title]', '[data-page-heading]'].map((sel) => WORKSPACE_SCRIPT.indexOf(`querySelector('${sel}')`));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], 'notice, then receipt title, then page heading');
  assert.ok(WORKSPACE_SCRIPT.includes('data.title') && WORKSPACE_SCRIPT.includes('result.title'), 'both the fetched page and a form result pass their title');
});

test('a row focused on return to the list keeps focus, and revealing a form moves focus into it', () => {
  assert.ok(WORKSPACE_SCRIPT.includes("focus.matches('.notice')"), 'a kept focus is only overridden by a notice');
  assert.ok(WORKSPACE_SCRIPT.includes("opened.querySelector('summary,input,select,button')"), 'a revealed form takes focus');
});


test('desktop and phone tabs say Inbox and keep the review badge', () => {
  const html = fixture.overviewHtml;
  for (const label of ['Main', 'Main, bottom bar']) {
    const nav = html.match(new RegExp('<nav[^>]*aria-label="' + label + '"[^>]*>([^]*?)</nav>'))[1];
    assert.match(nav, /data-page="status"[^>]*>[^]*?Inbox<span class="badge" data-review-badge/);
    assert.doesNotMatch(nav, />Receipts/);
  }
});
