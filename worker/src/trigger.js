// The control panel and webhook for the worker (port 8095). Every request needs TRIGGER_TOKEN; without it set, the server doesn't start.
//   GET  /?key=TOKEN               status page: mode, "Check for receipts now", recent receipts (link it from an Actual note)
//   GET  /categories, /keywords    edit category descriptions (and exclude categories) and household keywords
//   GET  /settings                 change settings without editing .env (data/web-settings.json);  POST /settings-save, /settings-reset, /settings-reset-all
//   GET  /learned                  what the worker learned from your corrections in Actual;  POST /lesson-forget, /undo-lesson
//   GET  /privacy                  names kept out of what the remote decider gets (only with DECIDER_PROVIDER=remote)
//   POST /privacy-word-add, -remove, -notname-add, -notname-remove, -place-add, -place-remove, -notplace-add, -notplace-remove
//   GET  /go-live                  the confirmation step before leaving dry run
//   POST /run?key=TOKEN            webhook: check the inbox now (Nextcloud webhook, phone shortcut, curl)
//   POST /mode, /category-save, /keyword-add, /keyword-remove, /retry    the page's buttons (forms), then a 303 back with a notice
//   POST /category-exclude, /category-include    the Categories tab's Exclude / Include again buttons
//   POST /undo-keyword, -category, -word, -notname, -notname-mark, -place, -notplace, -notplace-mark, -settings, -exclude    the Undo button in a notice
//   GET  /receipt?id=STATEKEY      one receipt: photo, what was read, the decision;  GET /receipt-photo?id=…[&page=n][&raw=1] the picture
// The key can also be sent as an "Authorization: Bearer TOKEN" or "X-Trigger-Key: TOKEN" header.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { config, log, reloadStatus } from './config.js';
import { loadState, parseStateKey } from './state.js';
import { loadKeywords } from './keywords.js';
import { learnedData, MemoryError } from './memory.js';
import { resolveDryRun, envDisagreement } from './settings.js'; // the dry run / live switch (not the Settings tab)
import { upgradeStatus } from './actual-upgrade.js';
import { readSetupProblem } from './alert.js';
import { PrivateWordsError } from './private-words.js';
import * as actions from './panel-actions.js';
import * as settings from './panel-settings.js';
import { loadOverrides } from './web-settings.js';
import * as pages from './panel-pages.js';
import * as receipts from './panel-receipt.js';

const PORT = 8095;
const MAX_BODY = 64 * 1024; // the largest form the page legitimately sends is a few KB

function keyOf(req, url) {
  const auth = req.headers.authorization ?? '';
  return url.searchParams.get('key') ?? req.headers['x-trigger-key'] ?? (auth.startsWith('Bearer ') ? auth.slice(7) : '');
}
export function allowed(key) {
  const a = Buffer.from(String(key));
  const b = Buffer.from(config.trigger.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read a urlencoded form body, refusing anything over MAX_BODY. Returns URLSearchParams, or null if it was too big. */
async function readForm(req, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk); // past the limit: keep reading (so the answer can be sent) but keep nothing
  }
  return size > limit ? null : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** What the status page shows: the mode in force, the mode waiting to start, the heartbeat and the recent receipts. */
async function statusData() {
  let heartbeat = 'not yet';
  let recent = [];
  let stateError = null;
  try {
    heartbeat = new Date(await fs.readFile(config.heartbeatPath, 'utf8')).toLocaleString('en-US', { timeZone: config.trigger.timeZone });
  } catch { /* first start */ }
  try {
    const state = await loadState();
    recent = Object.entries(state)
      .filter(([k]) => parseStateKey(k).dry === config.dryRun)
      .map(([k, v]) => ({ key: k, file: parseStateKey(k).file.split('/').pop(), ...v }))
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
      .slice(0, 15);
  } catch (err) {
    stateError = err.message; // shown on the page; never mistaken for "nothing processed yet"
  }
  const resolved = resolveDryRun();
  const { dryRun: next, source, settings } = resolved;
  return { dryRun: config.dryRun, pending: next !== config.dryRun ? next : null, settings: source === 'settings' ? settings : null, envNote: envDisagreement(resolved), apiNote: upgradeStatus.note, stateError, heartbeat, recent, alert: await readSetupProblem(), reloadError: reloadStatus.error, settingsDamaged: loadOverrides().damaged };
}

const ROUTES = {
  '/mode': actions.changeMode,
  '/category-save': actions.saveCategory,
  '/keyword-add': actions.addKeywordFromForm,
  '/keyword-remove': actions.removeKeywordFromForm,
  '/retry': (form) => actions.tryAgain(form),
  '/lesson-forget': actions.forgetLessonFromForm,
  '/settings-save': settings.saveSettings,
  '/settings-reset': settings.resetSetting,
  '/settings-reset-all': settings.resetAllSettings,
  '/category-exclude': settings.excludeCategory,
  '/category-include': settings.includeCategory,
  '/undo-settings': settings.undoSettings,
  '/undo-exclude': settings.undoExclude,
  '/undo-lesson': actions.undoLesson,
  '/undo-keyword': actions.undoKeyword,
  '/undo-category': actions.undoCategory,
  '/undo-word': actions.undoWord,
  '/undo-notname': actions.undoNotName,
  '/undo-notname-mark': actions.undoNotNameMark,
  '/undo-place': actions.undoPlace,
  '/undo-notplace': actions.undoNotPlace,
  '/undo-notplace-mark': actions.undoNotPlaceMark,
  '/privacy-word-add': actions.addPrivateWord,
  '/privacy-word-remove': actions.removePrivateWord,
  '/privacy-notname-add': actions.markNotName,
  '/privacy-notname-remove': actions.unmarkNotName,
  '/privacy-place-add': actions.addPrivatePlace,
  '/privacy-place-remove': actions.removePrivatePlace,
  '/privacy-notplace-add': actions.markNotPlace,
  '/privacy-notplace-remove': actions.unmarkNotPlace,
};
// Where each form sends you back to.
const UNDO_BACK = { 'undo-keyword': './keywords', 'undo-category': './categories', 'undo-lesson': './learned', 'undo-settings': './settings', 'undo-exclude': './categories' };
const BACK = { '/mode': './', '/category-save': './categories', '/keyword-add': './keywords', '/keyword-remove': './keywords', '/lesson-forget': './learned', '/retry': './', '/settings-save': './settings', '/settings-reset': './settings', '/settings-reset-all': './settings', '/category-exclude': './categories', '/category-include': './categories' };
for (const route of Object.keys(ROUTES)) if (route.startsWith('/privacy-')) BACK[route] = './privacy';
for (const r of actions.UNDO_ROUTES) BACK[`/${r}`] ??= UNDO_BACK[r] ?? './privacy';

const html = (res, body, code = 200) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': pages.CSP }).end(body);
const text = (res, code, msg) => res.writeHead(code, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }).end(`${msg}\n`);
/** Cut to n characters by code point, so an emoji is never split in half (encodeURIComponent throws on a lone surrogate). */
export const clip = (s, n = 300) => Array.from(String(s)).slice(0, n).join('');
const MAX_UNDO_LINK = 9000; // keep the redirect link far below Node's 16 KB header limit
const undoQuery = (undo) => (undo ? `&undo=${encodeURIComponent(undo.route)}&u=${encodeURIComponent(JSON.stringify(undo.fields))}` : '');
const redirect = (res, where, key, notice, undo) => {
  let q = undoQuery(undo);
  if (q.length > MAX_UNDO_LINK) {
    q = '';
    notice = `${clip(notice, 240)} (Too long to offer Undo.)`;
  }
  res.writeHead(303, { Location: `${where}?key=${encodeURIComponent(key)}${notice ? `&notice=${encodeURIComponent(clip(notice))}${q}` : ''}` }).end();
};

/** POST /run: the webhook (and the page's "Check for receipts now" form). */
function handleRun(req, res, key, onTrigger) {
  req.resume(); // ignore any webhook payload
  onTrigger(req.headers['user-agent']?.includes('Nextcloud') ? 'Nextcloud webhook' : 'trigger');
  // A browser form gets the page back; a webhook gets a short JSON answer.
  if ((req.headers.accept ?? '').includes('text/html')) {
    res.writeHead(303, { Location: `./?key=${encodeURIComponent(key)}&started=1` }).end();
  } else {
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}\n');
  }
}

/** POST to one of the ROUTES: run the handler, then redirect back to its page with a notice. */
async function handleForm(req, res, url, key) {
  const form = await readForm(req);
  if (!form) {
    res.writeHead(413, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }).end('too large\n');
    return;
  }
  let message;
  const out = {};
  try {
    message = await ROUTES[url.pathname](form, out);
  } catch (err) {
    if (!(err instanceof actions.PanelError || err instanceof PrivateWordsError || err instanceof MemoryError)) throw err; // these carry a message for the page
    message = err.message;
  }
  redirect(res, BACK[url.pathname], key, message, out.undo);
}

/** GET pages. Returns false when the path is not a page, so the caller answers 404. */
async function handlePage(res, url, key, notice, undo, deps) {
  const { pathname } = url;
  if (pathname === '/') {
    html(res, pages.statusPage(await statusData(), key, notice, undo));
    return true;
  }
  if (pathname === '/go-live') {
    html(res, pages.goLivePage(key, notice, undo));
    return true;
  }
  if (pathname === '/categories') {
    html(res, pages.categoriesPage(actions.categoriesData(), key, notice, undo));
    return true;
  }
  if (pathname === '/settings') {
    html(res, pages.settingsPage(settings.settingsData(), key, notice, undo));
    return true;
  }
  if (pathname === '/receipt') {
    const view = await receipts.receiptView(url.searchParams.get('id'), deps);
    if (view.code) html(res, pages.layout({ active: 'status', key, body: `<p>${pages.escape(view.message)}</p><p><a href="./?key=${pages.escape(encodeURIComponent(key))}">Back to the list</a></p>` }), view.code);
    else html(res, pages.receiptPage(view, key, notice));
    return true;
  }
  if (pathname === '/receipt-photo') {
    const page = Number(url.searchParams.get('page') ?? 1);
    const out = await receipts.receiptPhoto(url.searchParams.get('id'), { page, raw: url.searchParams.get('raw') === '1' }, deps);
    res.writeHead(out.code, out.headers).end(out.body);
    return true;
  }
  if (pathname === '/privacy' && config.decider.provider === 'remote') {
    try {
      html(res, pages.privacyPage(await actions.privacyData(), key, notice, undo));
    } catch (err) {
      if (!(err instanceof PrivateWordsError)) throw err;
      text(res, 500, err.message); // the list is damaged: say so, not just "error"
    }
    return true;
  }
  if (pathname === '/learned') {
    html(res, pages.learnedPage(await learnedData(), key, notice, undo));
    return true;
  }
  if (pathname === '/keywords') {
    const data = { keywords: await loadKeywords().catch(() => []), categories: actions.listCategories().map((c) => c.label), mode: config.keywordMode };
    html(res, pages.keywordsPage(data, key, notice, undo));
    return true;
  }
  return false;
}

/** The request handler, separate from listen() so tests can run it on an ephemeral port. */
export function makeServer(onTrigger, deps = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = keyOf(req, url);
      if (!allowed(key)) return text(res, 403, 'forbidden: this page needs its key in the link (?key=...). Run ./receipts trigger-url in the pipeline folder to print the full link.');
      const undo = actions.undoFromQuery(url.searchParams);
      const notice = url.searchParams.get('notice') || (url.searchParams.get('started') ? 'Checking the inbox now. Refresh in a minute to see the results.' : '');

      if (req.method === 'POST' && url.pathname === '/run') return handleRun(req, res, key, onTrigger);
      if (req.method === 'POST' && ROUTES[url.pathname]) return await handleForm(req, res, url, key);
      if (req.method === 'GET' && (await handlePage(res, url, key, notice, undo, deps))) return;
      text(res, 404, 'not found');
    } catch (err) {
      text(res, 500, 'error');
      log(`trigger page error: ${err.message}`);
    }
  });
}

export function startTriggerServer(onTrigger) {
  if (!config.trigger.token) {
    log('trigger page off: set TRIGGER_TOKEN to enable it');
    return;
  }
  makeServer(onTrigger).listen(PORT, '0.0.0.0', () => log(`trigger page listening on port ${PORT}`));
}
