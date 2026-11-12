import './support.js';
// Price entry like Actual and the full-size receipt viewer: the shipped client script over small DOM stand-ins; synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WORKSPACE_SCRIPT } from '../src/panel-workspace-script.js';
import { WORKSPACE_CSS } from '../src/panel-workspace-style.js';

function node(tag, doc) {
  const n = {
    tag, attrs: {}, dataset: {}, style: {}, children: [], listeners: {}, cls: new Set(), textContent: '', className: '', isConnected: true,
    clientWidth: 1000, clientHeight: 600, offsetWidth: 1000, offsetHeight: 600,
    setAttribute(k, v) { n.attrs[k] = v; }, getAttribute: (k) => n.attrs[k],
    append(...c) { n.children.push(...c); }, replaceChildren(...c) { n.children = c; },
    addEventListener(t, f) { n.listeners[t] = f; },
    classList: { add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c), toggle: (c, on) => (on ? n.cls.add(c) : n.cls.delete(c)), contains: (c) => n.cls.has(c) },
    descendants() { return n.children.flatMap((c) => [c, ...(c.descendants ? c.descendants() : [])]); },
    querySelectorAll: (s) => n.descendants().filter((d) => d.tag === s),
    querySelector: (s) => (/\[name=/.test(s) ? null : n.descendants().find((d) => s.split(',').includes(d.tag)) ?? null),
    closest: (s) => (s === 'img' && n.tag === 'img' ? n : null),
    cloneNode: () => { const c = node(n.tag, doc); c.children = n.children.map((k) => k.cloneNode()); return c; },
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    focus() { doc.activeElement = n; },
  };
  return n;
}

function client() {
  const listeners = {}, doc = { activeElement: null };
  const titleNode = node('h2', doc), body = node('div', doc);
  const dialog = node('dialog', doc);
  dialog.open = false; dialog.contains = () => false; dialog.scrollTop = 0;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.listeners.close?.(); };
  const wrap = node('div', doc); wrap.children = [node('img', doc)];
  const fullBtn = node('button', doc); fullBtn.closest = (s) => (s === '[data-photo-full]' ? fullBtn : null);
  const main = { querySelector: () => null, contains: () => true };
  Object.assign(doc, {
    getElementById: (id) => ({ 'workspace-dialog': dialog, 'workspace-dialog-title': titleNode, 'workspace-dialog-body': body }[id] ?? null),
    querySelector: (s) => (s === '[data-app-main]' ? main : s === '[data-photo-wrap]' ? wrap : null),
    querySelectorAll: () => [], createElement: (t) => node(t, doc),
    addEventListener: (n, f) => { listeners[n] = f; },
    documentElement: { classList: { add() {} } },
  });
  class EventStandIn { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; } }
  const context = vm.createContext({
    document: doc, Event: EventStandIn, FormData: class { forEach() {} }, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, Array, Object, JSON, Promise, Error, String, Number, Math, WeakMap, Map,
    location: { href: 'http://127.0.0.1/receipt?key=k', origin: 'http://127.0.0.1', search: '?key=k' }, history: { state: {}, replaceState() {}, pushState() {} },
    fetch: async () => ({ ok: false }), matchMedia: () => ({ matches: false }),
    window: { fetch() {}, DOMParser() {}, addEventListener() {}, alert() {}, confirm: () => true, scrollTo() {} },
  });
  const marker = '  enhance();\n', at = WORKSPACE_SCRIPT.lastIndexOf(marker);
  vm.runInContext(WORKSPACE_SCRIPT.slice(0, at) + '  return;\n' + WORKSPACE_SCRIPT.slice(at + marker.length), context);
  return { listeners, dialog, body, fullBtn, doc };
}

// ---- price entry ----
function field(value = '', name = 'a0') {
  const events = [];
  const f = { value, name, selectionStart: value.length, selectionEnd: value.length, matches: (sel) => /input\.amt/.test(sel), setSelectionRange(a, b) { f.selectionStart = a; f.selectionEnd = b; }, dispatchEvent: (e) => { events.push(e); return true; }, events };
  return f;
}
function press(c, f, data, inputType = 'insertText') {
  let prevented = false;
  c.listeners.beforeinput({ target: f, inputType, data, preventDefault() { prevented = true; } });
  if (!prevented && data) { f.value = f.value.slice(0, f.selectionStart) + data + f.value.slice(f.selectionEnd); f.selectionStart = f.selectionEnd = f.value.length; }
  return prevented;
}
const typeAll = (c, f, text) => { for (const ch of text) press(c, f, ch); return f.value; };
const focus = (c, f) => c.listeners.focusin({ target: f });
const SERVER = /^[+-]?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

test('price entry: digits fill in from the cents', () => {
  const c = client(), f = field();
  focus(c, f);
  press(c, f, '5');
  assert.equal(f.value, '0.05');
  const g = field(); focus(c, g);
  assert.equal(typeAll(c, g, '1'), '0.01');
  assert.equal(typeAll(c, g, '2'), '0.12');
  assert.equal(typeAll(c, g, '34'), '12.34');
  assert.match(g.value, SERVER, 'the submitted string is the plain format the server accepts');
  const h = field(); focus(c, h);
  assert.equal(typeAll(c, h, '1234'), '12.34');
  const z = field(); focus(c, z);
  assert.equal(typeAll(c, z, '0'), '0.00');
  assert.equal(typeAll(c, z, '5'), '0.05');
});

test('price entry: every change fires a bubbling input event (live previews, split, Revert)', () => {
  const c = client(), f = field(); focus(c, f);
  typeAll(c, f, '12');
  assert.equal(f.events.length, 2);
  assert.ok(f.events.every((e) => e.type === 'input' && e.bubbles));
  press(c, f, undefined, 'deleteContentBackward');
  assert.equal(f.events.length, 3);
  assert.doesNotThrow(() => c.listeners.input({ target: f }), 'the shared input handler accepts it');
});

test('price entry: Backspace removes the last digit', () => {
  const c = client(), f = field(); focus(c, f);
  typeAll(c, f, '1234');
  assert.equal(press(c, f, undefined, 'deleteContentBackward'), true);
  assert.equal(f.value, '1.23');
  press(c, f, undefined, 'deleteContentBackward'); assert.equal(f.value, '0.12');
  press(c, f, undefined, 'deleteContentBackward'); assert.equal(f.value, '0.01');
  press(c, f, undefined, 'deleteContentBackward'); assert.equal(f.value, '');
  press(c, f, undefined, 'deleteContentBackward'); assert.equal(f.value, '');
});

test('price entry: typing "." switches that entry to normal typing; re-entering starts fresh', () => {
  const c = client(), f = field(); focus(c, f);
  assert.equal(typeAll(c, f, '4'), '0.04');
  assert.equal(typeAll(c, f, '.'), '4.');
  assert.equal(typeAll(c, f, '5'), '4.5', 'now ordinary typing: 4.5 means 4.50');
  const g = field(); focus(c, g);
  typeAll(c, g, '4'); typeAll(c, g, '.'); typeAll(c, g, '5');
  assert.equal(g.value, '4.5');
  press(c, g, undefined, 'deleteContentBackward'); // default handling, not intercepted
  const h = field(); focus(c, h);
  assert.equal(typeAll(c, h, ','), '.', 'comma works as the decimal separator');
  assert.equal(typeAll(c, h, '75'), '.75');
  assert.match(h.value, SERVER);
  // leave and come back: cents mode again, replacing the old value
  focus(c, g);
  assert.equal(typeAll(c, g, '9'), '0.09');
});

test('price entry: the first digit replaces a prefilled value, later digits append', () => {
  const c = client(), f = field('12.34'); focus(c, f);
  assert.equal(typeAll(c, f, '7'), '0.07');
  assert.equal(typeAll(c, f, '5'), '0.75');
  const g = field('12.34'); focus(c, g);
  press(c, g, undefined, 'deleteContentBackward');
  assert.equal(g.value, '1.23', 'Backspace edits the prefilled value instead of replacing it');
  const h = field('12.34'); focus(c, h); h.selectionStart = 0; h.selectionEnd = 5;
  assert.equal(typeAll(c, h, '9'), '0.09', 'select all and type');
});

test('price entry: a pasted value stays as it is, and a prefilled value is untouched until typing', () => {
  const c = client(), f = field(); focus(c, f);
  assert.equal(press(c, f, '12.34', 'insertFromPaste'), false, 'paste is not intercepted');
  assert.equal(f.value, '12.34');
  assert.equal(typeAll(c, f, '5'), '12.345', 'after a paste, typing is normal typing');
  const g = field('4.18'); focus(c, g);
  assert.equal(g.value, '4.18');
});

test('price entry: negatives and discounts keep working', () => {
  const c = client(), f = field(); focus(c, f);
  assert.equal(typeAll(c, f, '-'), '-', 'a leading minus');
  assert.equal(typeAll(c, f, '250'), '-2.50');
  assert.match(f.value, SERVER);
  assert.equal(typeAll(c, f, '-'), '2.50', 'minus again flips back');
  const g = field('-2.50'); focus(c, g);
  assert.equal(typeAll(c, g, '300'), '-3.00', 'a prefilled discount stays a discount');
  press(c, g, undefined, 'deleteContentBackward'); assert.equal(g.value, '-0.30');
  const h = field(); focus(c, h);
  typeAll(c, h, '.'); typeAll(c, h, '5');
  assert.equal(h.value, '.5');
  const n = field(); focus(c, n);
  typeAll(c, n, '-'); typeAll(c, n, '.'); typeAll(c, n, '5');
  assert.equal(n.value, '-.5', 'a typed decimal discount is still accepted by the server pattern');
  assert.match(n.value, SERVER);
  const m = field('4.18'); focus(c, m);
  assert.equal(typeAll(c, m, '-'), '-4.18', 'minus on an existing amount makes it a discount');
});

test('price entry: capped at the server limit, and non-amount fields are left alone', () => {
  const c = client(), f = field(); focus(c, f);
  typeAll(c, f, '10000000'); assert.equal(f.value, '100000.00');
  typeAll(c, f, '1'); assert.equal(f.value, '100000.00', 'a ninth digit is ignored');
  const other = field('x', 'merchant'); other.matches = () => false; 
  assert.equal(press(c, other, '5'), false);
  assert.equal(other.value, 'x5');
});

// ---- viewer ----
const open = (c) => { c.listeners.click({ target: c.fullBtn }); const root = c.body.children[0]; return { root, tools: root.children[0], stage: root.children[1], canvas: root.children[1].children[0] }; };
const zoomBtn = (c, kind) => c.listeners.click({ target: { closest: (s) => (s === '[data-zoom]' ? { dataset: { zoom: kind } } : null) } });

test('viewer: "Show full size" opens zoom controls and returns focus to the button on close', () => {
  const c = client(); c.doc.activeElement = c.fullBtn;
  const v = open(c);
  assert.equal(c.dialog.open, true);
  assert.deepEqual(v.tools.children.map((b) => b.dataset.zoom ?? 'readout'), ['out', 'in', 'fit', 'readout']);
  assert.equal(v.tools.children[3].textContent, '100%');
  assert.ok(c.dialog.cls.has('photo-dialog'));
  assert.ok(v.canvas.children[0].children.length === 1, 'the photos are cloned into the canvas');
  c.dialog.close();
  assert.equal(c.doc.activeElement, c.fullBtn);
  assert.equal(c.dialog.cls.has('photo-dialog'), false);
});

test('viewer: zoom in, zoom out and Fit (buttons and keys) move the image with a CSSOM transform', () => {
  const c = client(); const v = open(c);
  zoomBtn(c, 'in');
  assert.match(v.canvas.style.transform, /scale\(1\.25\)/);
  assert.equal(v.tools.children[3].textContent, '125%');
  zoomBtn(c, 'in'); assert.match(v.canvas.style.transform, /scale\(1\.56\)/);
  zoomBtn(c, 'out'); assert.match(v.canvas.style.transform, /scale\(1\.25\)/);
  zoomBtn(c, 'out'); zoomBtn(c, 'out');
  assert.match(v.canvas.style.transform, /scale\(1\)/, 'never smaller than Fit');
  zoomBtn(c, 'in'); zoomBtn(c, 'in'); zoomBtn(c, 'fit');
  assert.equal(v.canvas.style.transform, 'translate(0px,0px) scale(1)');
  assert.equal(v.tools.children[3].textContent, '100%');
  const key = (k) => { let p = false; c.listeners.keydown({ key: k, preventDefault() { p = true; } }); return p; };
  assert.equal(key('+'), true); assert.match(v.canvas.style.transform, /scale\(1\.25\)/);
  key('-'); assert.match(v.canvas.style.transform, /scale\(1\)/);
  key('='); key('0'); assert.match(v.canvas.style.transform, /scale\(1\)/);
  assert.equal(v.stage.cls.has('can-pan'), false, 'no grab cursor at Fit');
  key('+'); assert.equal(v.stage.cls.has('can-pan'), true, 'grab cursor when zoomed');
});

test('viewer: Ctrl+wheel zooms around the cursor, and a plain wheel zooms a single page', () => {
  const c = client(); const v = open(c);
  let prevented = 0;
  v.stage.listeners.wheel({ ctrlKey: true, deltaY: -100, clientX: 600, clientY: 350, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  // cursor at (500,300) inside the stage; the point under it stays put: x = 500 - 500 * 1.15
  assert.equal(v.canvas.style.transform, 'translate(-75px,-45px) scale(1.15)');
  v.stage.listeners.wheel({ ctrlKey: false, deltaY: 100, clientX: 600, clientY: 350, preventDefault() { prevented++; } });
  assert.match(v.canvas.style.transform, /scale\(1\)/);
});

test('viewer: dragging pans when zoomed, stays inside the image, and a drag does not close the viewer', () => {
  const c = client(); const v = open(c);
  zoomBtn(c, 'in'); zoomBtn(c, 'in'); // 1.56 -> content 1560 wide, stage 1000
  const s = v.stage.listeners;
  s.pointerdown({ button: 0, clientX: 500, clientY: 300, pointerId: 1 });
  s.pointermove({ clientX: 450, clientY: 280 });
  assert.ok(v.stage.cls.has('panning'));
  assert.match(v.canvas.style.transform, /^translate\(-?\d+(\.\d+)?px,-?\d+(\.\d+)?px\) scale\(1\.56\)$/);
  s.pointermove({ clientX: -5000, clientY: -5000 });
  assert.match(v.canvas.style.transform, /translate\(-560px,-336px\)/, 'cannot be dragged past the image edge');
  s.pointerup({});
  assert.equal(v.stage.cls.has('panning'), false);
  s.click({ target: { closest: () => null } });
  assert.equal(c.dialog.open, true, 'the click that ends a drag does not close');
});

test('viewer: clicking the backdrop or the space around the image closes it; clicking the image does not', () => {
  const c = client(); c.doc.activeElement = c.fullBtn;
  const v = open(c);
  v.stage.listeners.click({ target: { closest: (s) => (s === 'img' ? {} : null) } });
  assert.equal(c.dialog.open, true, 'on the image: stays');
  v.stage.listeners.click({ target: { closest: () => null } });
  assert.equal(c.dialog.open, false, 'beside the image: closes');
  assert.equal(c.doc.activeElement, c.fullBtn, 'focus returns to Show full size');
  open(c);
  c.listeners.click({ target: c.dialog });
  assert.equal(c.dialog.open, false, 'the backdrop (the dialog itself) closes');
  assert.equal(c.doc.activeElement, c.fullBtn);
});

test('viewer: Esc closes it and focus returns to Show full size', () => {
  const c = client(); c.doc.activeElement = c.fullBtn;
  open(c);
  c.doc.activeElement = c.body;
  let prevented = false;
  c.listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(c.dialog.open, false);
  assert.equal(prevented, true);
  assert.equal(c.doc.activeElement, c.fullBtn);
});

test('viewer: the CSS is CSP-safe and the viewer uses no style attribute', () => {
  assert.doesNotMatch(WORKSPACE_SCRIPT, /setAttribute\(\s*'style'/);
  assert.match(WORKSPACE_SCRIPT, /canvas\.style\.transform/);
  assert.match(WORKSPACE_CSS, /\.photo-stage\.can-pan\{cursor:grab\}/);
  assert.match(WORKSPACE_CSS, /\.photo-stage\.panning\{cursor:grabbing/);
  assert.doesNotMatch(WORKSPACE_CSS, /\.photo-canvas[^{]*\{[^}]*transition/, 'no animation to respect reduced motion with');
});
