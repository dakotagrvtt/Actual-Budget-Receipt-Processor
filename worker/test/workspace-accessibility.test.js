// Renderer contracts complement the real-DOM checks in test/workspace-browser-checks.mjs.
// Every page and receipt used here is fictional and generated in a temporary directory.
import './support.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFixtures } from './workspace-fixtures.js';
import { SETTINGS } from '../src/web-settings-schema.js';

const fixture = await workspaceFixtures();
after(() => fixture.cleanup());
const pages = {
  receipt: fixture.renderReceipt(),
  overview: fixture.overviewHtml,
  settings: fixture.settingsHtml,
  rules: fixture.ruleHtml,
};

test('every workspace page keeps labelled navigation and a focusable skip destination with a home wordmark', () => {
  for (const [name, html] of Object.entries(pages)) {
    const header = html.match(/<header\b[^]*?<\/header>/)?.[0];
    assert.ok(header, `${name}: header remains available`);
    assert.match(header, /<a class="app-brand" data-navigate href=".\/\?key=fixture-key" title="Home" aria-label="Receipts, home">Receipts<\/a>/, `${name}: home wordmark keeps the key`);
    assert.doesNotMatch(header, /brand-icon/, `${name}: no brand icon`);
    assert.doesNotMatch(header, />receipts\.<\/a>/i, `${name}: the old bold "receipts." logo stays removed`);
    assert.deepEqual([...header.matchAll(/<a data-navigate data-page="([a-z]+)"/g)].map((m) => m[1]), ['status', 'archived', 'settings'], `${name}: three tabs`);
    assert.match(header, /<nav\b[^>]*aria-label="[^"]+"/, `${name}: navigation has a name`);
    const skip = html.match(/<a\b[^>]*href="#app-main"[^>]*>[^]*?<\/a>/);
    assert.ok(skip && /Skip/i.test(skip[0]), `${name}: skip link names its action`);
    assert.ok(html.indexOf(skip[0]) < html.indexOf('<header'), `${name}: skip comes before navigation`);
    const main = html.match(/<main\b[^>]*>/)?.[0];
    assert.match(main, /id="app-main"/, `${name}: skip target exists`);
    assert.match(main, /tabindex="-1"/, `${name}: native skip target accepts focus`);
    const headings = [...html.matchAll(/<h1\b[^>]*>[^]*?<\/h1>/g)].map((m) => m[0]);
    assert.equal(headings.length, 1, `${name}: one application heading`);
    assert.match(headings[0], new RegExp(`>${{ receipt: 'Receipt', overview: 'Inbox', settings: 'Settings', rules: 'Category rules' }[name]}</h1>`), `${name}: the heading names the page`);
    assert.ok(html.indexOf(headings[0]) > html.indexOf('<main'), `${name}: the heading is inside <main>, so a client page swap replaces it`);
    assert.doesNotMatch(headings[0], /aria-hidden|\shidden(?:\s|>)/, `${name}: heading stays in accessibility tree`);
  }
});

test('every retained setting still has a labelled editable control after the workspace cleanup', () => {
  const settingsHtml = fixture.settingsSectionsHtml; // P9: the section pages together hold every setting
  for (const setting of SETTINGS) {
    const id = `s-${setting.key}`;
    assert.ok(settingsHtml.includes(`data-setting="${setting.key}"`), `${setting.key}: setting remains present`);
    assert.ok(settingsHtml.includes(`for="${id}"`), `${setting.key}: explicit label remains present`);
    const control = [...settingsHtml.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)]
      .map((m) => m[0]).find((tag) => tag.includes(`id="${id}"`));
    assert.ok(control?.includes(`name="${setting.key}"`), `${setting.key}: labelled control still submits its setting`);
  }
  assert.equal(SETTINGS.length, 55);
});

test('receipt inputs retain item-specific accessible names before and after a preview', () => {
  for (const html of [pages.receipt, fixture.changedPreview, fixture.unchangedPreview]) {
    const editor = html.match(/<form\b[^>]*data-preview-form[^]*?<\/form>/)?.[0];
    assert.ok(editor, 'real receipt edit form remains present');
    for (let i = 0; i < 5; i++) {
      for (const field of [`a${i}`, `c${i}`]) {
        const control = [...editor.matchAll(/<(?:input|select)\b[^>]*>/g)].map((m) => m[0])
          .find((tag) => tag.includes(`name="${field}"`));
        assert.match(control, /aria-label="[^"]+"/, `${field}: item has an accessible name`);
      }
    }
  }
});
