// The control panel and webhook for the worker (port 8095). Every request needs TRIGGER_TOKEN; without it set, the server doesn't start.
//   GET  /?key=TOKEN               status page: mode, "Check now", recent receipts (link it from an Actual note)
//   GET  /categories, /keywords    edit category descriptions (and exclude categories) and household keywords
//   GET  /settings                 change settings without editing .env (data/web-settings.json);  POST /settings-save, /settings-reset, /settings-reset-all
//   GET  /learned                  what the worker learned from your corrections in Actual;  POST /lesson-forget, /undo-lesson
//   GET  /privacy                  names kept out of what the remote decider gets (only with DECIDER_PROVIDER=remote)
//   POST /privacy-word-add, -remove, -notname-add, -notname-remove, -place-add, -place-remove, -notplace-add, -notplace-remove
//   GET  /go-live                  the confirmation step before leaving dry run
//   POST /run?key=TOKEN            webhook: check the inbox now (Nextcloud webhook, phone shortcut, curl)
//   POST /mode, /category-save, /keyword-add, /keyword-remove, /retry    the page's buttons (forms), then a 303 back with a notice
//   POST /category-exclude, /category-include    the Categories tab's Exclude / Include again buttons
//   POST /receipt-reread  read the receipt's photo again (marks it, then a check does the reading; nothing is written to Actual)
//   POST /receipt-reread-restore  put the reading from before the last Read again back ("Use old reading")
//   POST /receipt-cash    a cash receipt: create the transaction in Actual, or split the existing one found (only on a button press)
//   POST /receipt-check   look at the charge in Actual (read only) and say whether it still matches what was filed
//   POST /receipt-fix, /undo-receipt-fix   fix a receipt's item categories from its page (Save / Apply to Actual) and undo that
//   POST /undo-keyword, -category, -word, -notname, -notname-mark, -place, -notplace, -notplace-mark, -settings, -exclude    the Undo button in a notice
//   GET  /archived                the Archived tab: receipts you archived (searchable; Restore puts one back);  GET /archive-all the confirm step before archiving every Done receipt
//   POST /upload                  upload receipt photos / PDFs into the Nextcloud Inbox (multipart form on the Status tab), then check the inbox
//   POST /archive, /archive-all, /restore    archive one receipt (from its page) or all Done ones, and bring one back
//   GET  /receipt?id=STATEKEY[&result=&q=&sort=&dir=]  one receipt: photo, what was read, the decision, Previous / Next in the list's order;  GET /receipt-photo?id=…[&page=n][&raw=1] the picture
// The key can also be sent as an "Authorization: Bearer TOKEN" or "X-Trigger-Key: TOKEN" header.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { config, log, reloadStatus } from './config.js';
import { loadState, parseStateKey } from './state.js';
import { loadKeywords } from './keywords.js';
import { learnedData, MemoryError, seenIndex } from './memory.js';
import { resolveDryRun, envDisagreement } from './settings.js'; // the dry run / live switch (not the Settings tab)
import { upgradeStatus } from './actual-upgrade.js';
import { readSetupProblem } from './alert.js';
import { PrivateWordsError } from './private-words.js';
import * as actions from './panel-actions.js';
import * as settings from './panel-settings.js';
import { loadOverrides } from './web-settings.js';
import * as pages from './panel-pages.js';
import * as receipts from './panel-receipt.js';
import * as fix from './receipt-fix.js';
import * as reread from './reread.js';
import { commitResolution } from './receipt-resolution.js';
import * as cash from './cash.js';
import * as archive from './archive-actions.js';
import { boundaryOf, parseMultipart, uploadNotice, MAX_REQUEST_BYTES } from './upload.js';
import { archivedList, mainList, withSeen } from './receipt-lists.js';
import { bulkCandidates } from './archive-rules.js';
import { queueGroup } from './panel-queue.js';

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
async function readForm(req, limit = MAX_BODY, raw = false) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk); // past the limit: keep reading (so the answer can be sent) but keep nothing
  }
  if (size > limit) return null;
  return raw ? Buffer.concat(chunks) : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The receipts the status page lists (newest first, archived ones left out): also what Previous / Next on a receipt's page walk
 * through. Every receipt that is not Done is listed; only Done ones are capped (receipt-lists.js). `archivable`: how many Done
 * receipts "Archive all done receipts" would take.
 */
async function recentReceipts() {
  try {
    const state = withSeen(await loadState(), await seenIndex());
    return { ...mainList(state, config.dryRun), archivable: config.dryRun ? 0 : bulkCandidates(state).length, stateError: null };
  } catch (err) {
    return { recent: [], hiddenDone: 0, archivable: 0, stateError: err.message }; // shown on the page; never mistaken for "nothing processed yet"
  }
}

/** What every page frame carries: how many receipts are in Review (the badge; null when the list can't be read) and the setup problems (the list pane's alerts). */
async function frameData() {
  const { recent, stateError } = await recentReceipts();
  return { reviewCount: stateError ? null : recent.filter((r) => queueGroup(r) === 'review').length, setup: { alert: await readSetupProblem(), reloadError: reloadStatus.error, settingsDamaged: loadOverrides().damaged } };
}

/** The archived receipts (most recently archived first): the Archived tab, and Previous / Next on an archived receipt's page. */
async function archivedReceipts() {
  try {
    return { archived: archivedList(await loadState(), config.dryRun), stateError: null };
  } catch (err) {
    return { archived: [], stateError: err.message };
  }
}

/** What the status page shows: the mode in force, the mode waiting to start, the heartbeat and the recent receipts. */
async function statusData() {
  let heartbeat = 'not yet';
  try {
    heartbeat = (await fs.readFile(config.heartbeatPath, 'utf8')).trim(); // the time as written; the page says "2 min ago"
  } catch { /* first start */ }
  const { recent, hiddenDone, archivable, stateError } = await recentReceipts();
  const resolved = resolveDryRun();
  const { dryRun: next, source, settings } = resolved;
  return { dryRun: config.dryRun, pending: next !== config.dryRun ? next : null, settings: source === 'settings' ? settings : null, envNote: envDisagreement(resolved), apiNote: upgradeStatus.note, stateError, heartbeat, recent, hiddenDone, archivable, alert: await readSetupProblem(), reloadError: reloadStatus.error, settingsDamaged: loadOverrides().damaged };
}

const ROUTES = {
  '/mode': actions.changeMode,
  '/category-save': actions.saveCategory,
  '/keyword-add': actions.addKeywordFromForm,
  '/keyword-remove': actions.removeKeywordFromForm,
  '/retry': async (form, out) => {
    const message = await actions.tryAgain(form);
    out.retried = true; // only a success moves on to the next receipt
    return message;
  },
  '/archive': archive.archiveOne,
  '/archive-all': archive.archiveAll,
  '/restore': archive.restoreOne,
  '/receipt-fix': fix.commitFix,
  '/undo-receipt-fix': fix.undoFix,
  '/receipt-check': fix.checkActual,
  '/receipt-cash': cash.commitCash,
  '/receipt-resolve': commitResolution,
  '/receipt-reread': reread.requestReread,
  '/receipt-reread-restore': reread.restoreReading,
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
const BACK = { '/mode': './', '/category-save': './categories', '/keyword-add': './keywords', '/keyword-remove': './keywords', '/lesson-forget': './learned', '/retry': './', '/archive-all': './', '/restore': './archived', '/settings-save': './settings', '/settings-reset': './settings', '/settings-reset-all': './settings', '/category-exclude': './categories', '/category-include': './categories' };
for (const route of Object.keys(ROUTES)) if (route.startsWith('/privacy-')) BACK[route] = './privacy';
for (const r of actions.UNDO_ROUTES) BACK[`/${r}`] ??= UNDO_BACK[r] ?? './privacy';

const html = (res, body, code = 200) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': pages.CSP, 'X-Receipt-Action-Error': res.receiptActionError ? '1' : '0' }).end(res.receiptActionError ? body.replace(/class="notice(?: (?:err|warn))?"/, 'class="notice err" role="alert"') : body);
const text = (res, code, msg) => res.writeHead(code, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' }).end(`${msg}\n`);
/** Cut to n characters by code point, so an emoji is never split in half (encodeURIComponent throws on a lone surrogate). */
export const clip = (s, n = 300) => Array.from(String(s)).slice(0, n).join('');
const MAX_UNDO_LINK = 9000; // keep the redirect link far below Node's 16 KB header limit
const undoQuery = (undo) => (undo ? `&undo=${encodeURIComponent(undo.route)}&u=${encodeURIComponent(JSON.stringify(undo.fields))}` : '');
const redirect = (res, where, key, notice, undo, extra = '') => {
  let q = undoQuery(undo);
  if (q.length > MAX_UNDO_LINK) {
    q = '';
    notice = `${clip(notice, 240)} (Too long to offer Undo.)`;
  }
  res.writeHead(303, { Location: `${where}?key=${encodeURIComponent(key)}${extra}${notice ? `&notice=${encodeURIComponent(clip(notice))}${q}` : ''}` }).end();
};

/**
 * Read a body into one buffer, keeping nothing past `limit`. A Content-Length over the limit is turned away before any byte is kept;
 * with a Content-Length the buffer is allocated once (no second copy); chunked bodies are collected and cut off at the limit.
 * Returns the buffer, or null if too big (the rest is read and thrown away so the answer can still be sent).
 */
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    req.resume();
    return null;
  }
  if (Number.isInteger(declared) && declared >= 0 && req.headers['content-length'] !== undefined) {
    const buf = Buffer.allocUnsafe(declared);
    let got = 0;
    let over = false;
    for await (const chunk of req) {
      if (got + chunk.length > declared) over = true; // sent more than it said
      if (!over) { chunk.copy(buf, got); got += chunk.length; }
    }
    return over ? null : buf.subarray(0, got);
  }
  return readForm(req, limit, true);
}

let uploading = false; // one upload request at a time: each is buffered whole in memory
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000; // a 25 MB photo on a slow link must not be cut off at the server's default

/**
 * POST /upload: files chosen on the Status tab go into the Nextcloud Inbox (upload.js), then a check starts, as "Check now" does.
 * The page key is already checked. A browser says where a request came from (Sec-Fetch-Site): one from another site is refused; a request
 * without that header (curl, a script holding the key) is allowed. With Accept: application/json (the page's script, one file per request) the
 * answer is JSON and the check is left to the script (?defer=1), else the browser is sent back to the page with a notice.
 */
async function handleUpload(req, res, url, key, onTrigger, deps) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    req.resume();
    return text(res, 403, 'forbidden: the upload came from another site');
  }
  const json = String(req.headers.accept ?? '').includes('application/json');
  const answer = (code, body, notice) => (json
    ? res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(body))
    : redirect(res, './', key, notice));
  const refuse = (code, message) => answer(code, { saved: [], skipped: [], refused: [], message }, message);
  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) { req.resume(); return refuse(400, 'The upload was not understood (it was not a file form). Nothing was uploaded.'); }
  if (uploading) { req.resume(); return refuse(503, 'Another upload is in progress. Wait for it to finish, then try again. Nothing was uploaded.'); }
  uploading = true;
  try {
    const body = await readBody(req, MAX_REQUEST_BYTES);
    if (!body) return refuse(413, `Nothing was uploaded: the files together are more than ${MAX_REQUEST_BYTES / 1048576} MB. Upload fewer at a time.`);
    let files;
    try {
      ({ files } = parseMultipart(body, boundary));
    } catch {
      return refuse(400, 'The upload could not be read. Nothing was uploaded.');
    }
    files = files.filter((f) => f.filename !== '' || f.data.length > 0); // an empty file box sends one nameless, empty part
    const nc = deps.nextcloud ?? (await import('./nextcloud.js'));
    let result;
    try {
      result = await nc.uploadToInbox(files);
    } catch (err) {
      log(`upload failed: ${err.message}`);
      return refuse(502, `Nextcloud could not be reached (${err.message}). Nothing was uploaded.`);
    }
    log(`upload from the status page: ${result.saved.length} saved, ${result.refused.length} refused (${result.saved.map((s) => s.as).join(', ')})`);
    if (result.saved.length && url.searchParams.get('defer') !== '1') onTrigger('upload');
    return answer(200, result, uploadNotice(result, config.dryRun));
  } finally {
    uploading = false;
  }
}

/** POST /run: the webhook (and the page's "Check now" form). */
function handleRun(req, res, key, onTrigger, url = null) {
  req.resume(); // ignore any webhook payload
  onTrigger(req.headers['user-agent']?.includes('Nextcloud') ? 'Nextcloud webhook' : 'trigger');
  // A browser form gets the page back; a webhook gets a short JSON answer.
  if ((req.headers.accept ?? '').includes('text/html')) {
    // Check now on the Activity view comes back to it (only that one value is accepted).
    const activity = url?.searchParams.get('from') === 'activity' ? '&activity=1' : '';
    res.writeHead(303, { Location: `./?key=${encodeURIComponent(key)}${activity}&started=1` }).end();
  } else {
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}\n');
  }
}

/** POST to one of the ROUTES: run the handler, then redirect back to its page with a notice. */
async function handleForm(req, res, url, key, deps = {}, onTrigger = null) {
  if (url.pathname === '/receipt-resolve' || url.pathname === '/receipt-check' || url.pathname === '/receipt-reread' || url.pathname === '/receipt-reread-restore' || url.pathname === '/receipt-cash') {
    const site = req.headers['sec-fetch-site']; // a form on another site must not make the worker open Actual or read a photo
    if (site && site !== 'same-origin' && site !== 'none') {
      req.resume();
      return text(res, 403, 'forbidden: the request came from another site');
    }
  }
  const form = await readForm(req);
  if (!form) {
    res.writeHead(413, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff', Connection: 'close' }).end('too large\n');
    return;
  }
  let message;
  const out = {};
  try {
    message = await ROUTES[url.pathname](form, out, deps);
  } catch (err) {
    if (!(err instanceof actions.PanelError || err instanceof PrivateWordsError || err instanceof MemoryError)) throw err; // these carry a message for the page
    message = err.message;
    out.error = true;
  }
  if (out.trigger && onTrigger) onTrigger(out.trigger); // e.g. Read again: the check does the reading
  if (url.pathname === '/retry') {
    const to = retryTarget(form, out);
    return redirect(res, to.where, key, message, out.undo, to.extra + (out.error ? '&action-error=1' : ''));
  }
  if (url.pathname === '/archive' || url.pathname === '/restore') {
    const to = (url.pathname === '/archive' ? archiveTarget : restoreTarget)(form, out);
    return redirect(res, to.where, key, message, out.undo, to.extra + (out.error ? '&action-error=1' : ''));
  }
  if (url.pathname === '/receipt-fix' || url.pathname === '/undo-receipt-fix' || url.pathname === '/receipt-resolve' || url.pathname === '/receipt-check' || url.pathname === '/receipt-reread' || url.pathname === '/receipt-reread-restore' || url.pathname === '/receipt-cash') {
    const to = fixTarget(form);
    return redirect(res, to.where, key, message, out.undo, to.extra + (out.error ? '&action-error=1' : ''));
  }
  // A Settings save, reset or Undo comes back to the section page it was made on (the form's `section`, whitelisted).
  const section = SETTINGS_BACK.has(url.pathname) ? pages.settingsSection(form.get('section')) : '';
  // A Settings-tab page keeps where Done goes back to (`from`, cleaned: only the list, the Archive or a receipt).
  const from = /^\.\/(settings|categories|keywords|learned|privacy)$/.test(BACK[url.pathname] ?? '') ? pages.cleanFrom(url.searchParams.get('from')) : null;
  redirect(res, BACK[url.pathname], key, message, out.undo, `${section ? `&section=${section}` : ''}${from ? `&from=${encodeURIComponent(from.value)}` : ''}${out.error ? '&action-error=1' : ''}`);
}
const SETTINGS_BACK = new Set(['/settings-save', '/settings-reset', '/settings-reset-all', '/undo-settings']);

/** A redirect to a receipt's page (the list when there is no usable id), keeping the list's filter and sort (cleaned from the form). */
function receiptTarget(id, form) {
  const nav = pages.navQuery(pages.cleanNav(form));
  if (id && id.length <= 2000) return { where: './receipt', extra: `&id=${encodeURIComponent(id)}${nav}` };
  return { where: './', extra: nav };
}

/** Where a change made on a receipt's page (and its Undo) sends you back to: that receipt's page. */
const fixTarget = (form) => receiptTarget(form.get('id'), form);

/**
 * Where Try again sends you back to. From the list: the list. From a receipt's page (from=receipt): the next receipt after a
 * success (that one is no longer there), the same receipt after a refusal. The target is never taken from the request:
 * it is one of two fixed pages, with only a receipt id and the list's filter and sort (cleaned) added to the query.
 */
export function retryTarget(form, out) {
  if (form.get('from') !== 'receipt') return { where: './', extra: '' };
  return receiptTarget(out.retried ? form.get('next') : form.get('entry'), form);
}

/** Where archiving from a receipt's page goes on to: the next receipt after a success (this one left the list), this receipt after a refusal. From anywhere else: the list. */
export function archiveTarget(form, out) {
  if (form.get('from') !== 'receipt') return { where: './', extra: '' };
  return receiptTarget(out.archived ? form.get('next') : form.get('id'), form);
}

/**
 * Where Restore goes: after a success, the restored receipt itself (from its page or from the Archive list), opened in its own group (no
 * nav: the archive list's filter and sort mean nothing on the main list). After a refusal: that archived receipt's page when pressed there,
 * else the Archive list. The target is one of the fixed pages; only the receipt id (length-checked) and the cleaned nav are added.
 */
export function restoreTarget(form, out) {
  if (out.restored) {
    const to = receiptTarget(form.get('id'), new URLSearchParams());
    return to.where === './' ? { where: './archived', extra: '' } : to;
  }
  if (form.get('from') !== 'receipt') return { where: './archived', extra: '' };
  const to = receiptTarget(form.get('id'), form);
  return to.where === './' ? { where: './archived', extra: to.extra } : to;
}

/** GET pages. Returns false when the path is not a page, so the caller answers 404. */
async function handlePage(res, url, key, notice, undo, deps) {
  res.receiptActionError = url.searchParams.get('action-error') === '1';
  const { pathname } = url;
  // The Review badge and the list pane's alerts in the page frame; the status page counts and shows its own.
  const draw = async (render) => pages.withFrame({ ...(await frameData()), from: pages.cleanFrom(url.searchParams.get('from')) }, render);
  if (pathname === '/') {
    const data = await statusData();
    html(res, pages.statusPage(data, key, notice, undo, { activity: url.searchParams.get('activity') === '1', group: pages.cleanNav(url.searchParams).group }));
    return true;
  }
  if (pathname === '/go-live') {
    html(res, await draw(() => pages.goLivePage(key, notice, undo)));
    return true;
  }
  if (pathname === '/archived') {
    const data = { ...(await archivedReceipts()), dryRun: config.dryRun, nav: pages.cleanNav(url.searchParams) };
    html(res, await draw(() => pages.archivedPage(data, key, notice, undo)));
    return true;
  }
  if (pathname === '/archive-all') {
    const data = { dryRun: config.dryRun, count: (await recentReceipts()).archivable };
    html(res, await draw(() => pages.archiveAllPage(data, key, notice, undo)));
    return true;
  }
  if (pathname === '/categories') {
    html(res, await draw(() => pages.categoriesPage(actions.categoriesData(), key, notice, undo)));
    return true;
  }
  if (pathname === '/settings') {
    html(res, await draw(() => pages.settingsPage(settings.settingsData(), key, notice, undo, { section: url.searchParams.get('section') })));
    return true;
  }
  if (pathname === '/receipt') {
    const view = await receipts.receiptView(url.searchParams.get('id'), deps, url.searchParams);
    const nav = pages.cleanNav(url.searchParams);
    if (view.code) html(res, await draw(() => pages.layout({ active: 'status', key, body: `<p>${pages.escape(view.message)}</p><p><a href="./?key=${pages.escape(encodeURIComponent(key))}${pages.escape(pages.navQuery(nav))}">Back to the list</a></p>` })), view.code);
    else if (view.entry.archived) {
      const where = pages.archivedNav((await archivedReceipts()).archived, view.id, nav);
      html(res, await draw(() => pages.receiptPage(view, key, notice, where, undo)));
    } else {
      const where = pages.receiptNav((await recentReceipts()).recent, view.id, nav);
      html(res, await draw(() => pages.receiptPage(view, key, notice, where, undo)));
    }
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
      const data = await actions.privacyData();
      html(res, await draw(() => pages.privacyPage(data, key, notice, undo)));
    } catch (err) {
      if (!(err instanceof PrivateWordsError)) throw err;
      text(res, 500, err.message); // the list is damaged: say so, not just "error"
    }
    return true;
  }
  if (pathname === '/learned') {
    const data = await learnedData();
    html(res, await draw(() => pages.learnedPage(data, key, notice, undo)));
    return true;
  }
  if (pathname === '/keywords') {
    const data = { keywords: await loadKeywords().catch(() => []), categories: actions.listCategories().map((c) => c.label), mode: config.keywordMode };
    html(res, await draw(() => pages.keywordsPage(data, key, notice, undo)));
    return true;
  }
  return false;
}

/** The request handler, separate from listen() so tests can run it on an ephemeral port. */
export function makeServer(onTrigger, deps = {}) {
  return http.createServer({ requestTimeout: UPLOAD_TIMEOUT_MS }, async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = keyOf(req, url);
      if (!allowed(key)) return text(res, 403, 'forbidden: this page needs its key in the link (?key=...). Run ./receipts trigger-url in the pipeline folder to print the full link.');
      const undo = actions.undoFromQuery(url.searchParams);
      const notice = url.searchParams.get('notice') || (url.searchParams.get('started') ? 'Checking the inbox now. Refresh in a minute to see the results.' : '');

      if (req.method === 'POST' && url.pathname === '/upload') return await handleUpload(req, res, url, key, onTrigger, deps);
      if (req.method === 'POST' && url.pathname === '/run') return handleRun(req, res, key, onTrigger, url);
      if (req.method === 'POST' && ROUTES[url.pathname]) return await handleForm(req, res, url, key, deps, onTrigger);
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
