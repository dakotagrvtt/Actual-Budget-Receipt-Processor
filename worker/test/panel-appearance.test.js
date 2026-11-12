// P10: Appearance. The theme and accent are per device (localStorage), applied from a script in <head> before first paint,
// and the controls are plain buttons outside every settings form.
import './support.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SETTINGS, SECTIONS } from '../src/web-settings-schema.js';
import { settingsPage } from '../src/panel-settings-page.js';
import { SCRIPT, readPrefs, applyPrefs } from '../src/panel-script.js';

const data = () => ({ exists: true, sections: SECTIONS.map((sec) => ({ ...sec, settings: SETTINGS.filter((s) => s.section === sec.id).map((s) => ({ ...s, value: s.default, source: 'default', isSet: false })) })) });
const full = () => settingsPage(data(), 'fixture', '', undefined, { section: 'appearance' });
const page = () => full().match(/<div id="settings-page"[^]*<\/div>\s*<\/main>/)?.[0] ?? full();

/** A tiny <html> element and a document that is still loading, so only the head part of the script has run. */
function run(storage) {
  const attrs = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, className: '' };
  const listeners = {};
  const document = { documentElement: root, readyState: 'loading', addEventListener: (n, f) => { listeners[n] = f; } };
  const window = { localStorage: storage };
  vm.runInNewContext(SCRIPT, { document, window, Array, JSON, parseFloat, Date, String, isNaN });
  return { attrs, listeners };
}

test('stored theme and accent are set on <html> before the document is ready', () => {
  const { attrs, listeners } = run({ getItem: () => JSON.stringify({ theme: 'dark', accent: 'rose' }) });
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(attrs['data-accent'], 'rose');
  assert.equal(typeof listeners.DOMContentLoaded, 'function', 'the rest waits for DOMContentLoaded');
});

test('System leaves data-theme off so prefers-color-scheme decides; unknown values fall back', () => {
  assert.deepEqual(readPrefs(JSON.stringify({ theme: 'system', accent: 'teal' })), { theme: 'system', accent: 'teal' });
  assert.deepEqual(readPrefs(JSON.stringify({ theme: 'neon', accent: '<x>' })), { theme: 'system', accent: 'blue' });
  assert.deepEqual(readPrefs('not json'), { theme: 'system', accent: 'blue' });
  const { attrs } = run({ getItem: () => JSON.stringify({ theme: 'system', accent: 'blue' }) });
  assert.equal('data-theme' in attrs, false);
  assert.equal(attrs['data-accent'], 'blue');
});

test('storage that throws, or is missing, is safe: System and Blue', () => {
  for (const storage of [{ getItem() { throw new Error('blocked'); } }, undefined, null]) {
    const { attrs } = run(storage);
    assert.equal('data-theme' in attrs, false);
    assert.equal(attrs['data-accent'], 'blue');
  }
  const root = { setAttribute() {}, removeAttribute() {} };
  assert.doesNotThrow(() => applyPrefs(root, readPrefs(null)));
});

test('a choice is saved, and a failing write is ignored', () => {
  const saved = {};
  const button = (pref, value) => ({ getAttribute: (k) => (k === 'data-pref' ? pref : value), setAttribute() {} });
  const clicked = (b) => ({ target: { closest: () => b } });
  const attrs = {};
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, className: '' };
  const listeners = {};
  const document = { documentElement: root, readyState: 'complete', addEventListener: (n, f) => { listeners[n] = f; }, querySelectorAll: () => [], getElementById: () => null };
  const window = { localStorage: { getItem: () => saved.v ?? null, setItem: (k, v) => { saved.v = v; } } };
  vm.runInNewContext(SCRIPT, { document, window, Array, JSON, parseFloat, Date, String, isNaN, URLSearchParams, location: { search: '', hash: '' } });
  listeners.click(clicked(button('theme', 'light')));
  listeners.click(clicked(button('accent', 'violet')));
  assert.deepEqual(JSON.parse(saved.v), { theme: 'light', accent: 'violet' });
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(attrs['data-accent'], 'violet');
  window.localStorage.setItem = () => { throw new Error('full'); };
  assert.doesNotThrow(() => listeners.click(clicked(button('theme', 'dark'))));
  assert.equal(attrs['data-theme'], 'dark', 'still applied for this page');
});

test('Appearance: the cards and controls, with aria-pressed, outside every save form', () => {
  const html = page();
  assert.match(html, /data-settings-section="appearance"/);
  assert.match(html, /&larr; Settings/);
  assert.match(html, /data-settings-done/);
  assert.match(html, /Saved on this device/);
  for (const t of ['System', 'Light', 'Dark', 'Blue', 'Teal', 'Violet', 'Rose', 'Graphite']) assert.ok(html.includes(t), t);
  const buttons = [...html.matchAll(/<button type="button"[^>]*data-pref="[^"]+"[^>]*>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 8);
  for (const b of buttons) assert.match(b, /aria-pressed="(true|false)"/);
  assert.equal([...html.matchAll(/<form\b/g)].length, 0, 'no form on the page, so nothing is posted');
  assert.match(settingsPage(data(), 'fixture', ''), /section=appearance/, 'a card on the overview');
  // and no save form on any other page contains them
  for (const section of ['everyday', 'preferences', 'connections', 'advanced', undefined]) {
    const other = settingsPage(data(), 'fixture', '', undefined, { section });
    for (const m of other.matchAll(/<form\b[^]*?<\/form>/g)) assert.doesNotMatch(m[0], /data-pref/);
  }
});

test('Appearance controls use no UPPER_CASE names (the save would refuse unknown keys)', () => {
  const html = page();
  assert.doesNotMatch(html, /\sname="[^"]*[A-Z][^"]*"/);
  assert.doesNotMatch(html, /\sname=/, 'the buttons have no name at all');
  assert.doesNotMatch(html, /\bid="s-/);
});
