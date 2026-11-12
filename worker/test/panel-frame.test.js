// The app frame (P3): wordmark, three tabs with the current one marked, the Review badge, the Dry run chip and the bottom tab bar.
// Every receipt here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { layout, withFrame } from '../src/panel-pages.js';

const frame = (opts = {}) => layout({ active: 'status', key: 'k', body: '<p>x</p>', ...opts });
const tabs = (html) => [...html.matchAll(/<a data-navigate data-page="([a-z]+)"[^>]*?(?: class="on" aria-current="page")?>/g)].map((m) => m[0]);

test('the frame has three tabs and marks the current one; the settings family sits under the Settings tab', () => {
  for (const [active, tab] of [['status', 'status'], ['archived', 'archived'], ['settings', 'settings'], ['categories', 'settings'], ['keywords', 'settings'], ['learned', 'settings'], ['privacy', 'settings']]) {
    const html = frame({ active });
    const current = [...html.matchAll(/<a data-navigate data-page="([a-z]+)" href="[^"]*" class="on" aria-current="page">/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(current)], [tab], active);
    assert.equal(current.length, 2, 'once in the top bar and once in the bottom bar');
    assert.match(html, new RegExp(`<main[^>]*data-tab="${tab}"`));
  }
  assert.doesNotMatch(frame().replace(/<style>[^]*?<\/style>/, ''), /header-more|>More</, 'the More menu is gone');
  assert.match(frame(), /<nav class="tabs" aria-label="Main, bottom bar">/);
  assert.equal(tabs(frame()).length, 6);
});

test('the Review badge shows the count, comes from the frame, and is hidden at zero', () => {
  const shown = withFrame({ reviewCount: 3 }, () => frame());
  assert.match(shown, /<span class="badge" data-review-badge><span data-count>3<\/span><span class="sr-only"> to review<\/span><\/span>/);
  assert.match(shown, /data-review-count="3"/);
  assert.match(frame(), /<span class="badge" data-review-badge hidden>/);
  assert.match(frame({ reviewCount: 7 }), /data-review-count="7"/, 'a page can pass its own count');
  assert.match(frame(), /data-review-count="0"/, 'outside a frame there is no badge');
  assert.match(withFrame({ reviewCount: 2 }, () => frame({ reviewCount: 5 })), /data-review-count="5"/);
});

test('the Dry run chip is in the page, and only visible in dry run; it links to Activity and test mode', () => {
  const before = config.dryRun;
  try {
    config.dryRun = false;
    assert.match(frame(), /<a class="dry-chip" data-navigate data-dry-chip href="\.\/\?key=k&amp;activity=1"[^>]* hidden>Dry run<\/a>/);
    assert.match(frame(), /data-dry="false"/);
    config.dryRun = true;
    assert.match(frame(), /<a class="dry-chip" data-navigate data-dry-chip href="\.\/\?key=k&amp;activity=1"[^>]*>Dry run<\/a>/);
    assert.doesNotMatch(frame().match(/<a class="dry-chip"[^>]*>/)[0], / hidden/);
    assert.match(frame(), /data-dry="true"/);
  } finally { config.dryRun = before; }
});

test('the frame stays CSP-safe: one script, one style, no style attributes or inline handlers', () => {
  const html = frame();
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.equal((html.match(/<style/g) || []).length, 1);
  assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/);
  assert.ok(html.indexOf('<script>') < html.indexOf('</head>'), 'the script is in the head, so the theme applies before first paint');
});
