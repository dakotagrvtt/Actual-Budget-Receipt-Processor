// Exception workflow: correct OCR metadata, find a charge read-only, then resume processing or select a charge explicitly.
// This module never writes to Actual. Normal receipts continue through the unattended worker unchanged.
import crypto from 'node:crypto';
import path from 'node:path/posix';
import { config, filesPlace } from './config.js';
import { loadState, saveState, parseStateKey, patchEntry } from './state.js';
import { exclusive } from './session-lock.js';
import { PanelError } from './panel-actions.js';
import { openActual, refuseInDryRun, parseAmount } from './receipt-fix.js';
import { paidCash, cents, money } from './reconcile.js';
import { shiftDay, today } from './dates.js';
import { selectionSnapshot } from './receipt-selection.js';
import { reviewCause } from './review-cause.js';

const names = ['merchant', 'date', 'total', 'payment_method'];
export const resolutionValues = (receipt = {}) => ({ merchant: String(receipt.merchant ?? ''), date: receipt.date ?? '', total: receipt.total == null ? '' : money(cents(receipt.total)), payment_method: paidCash(receipt) ? 'cash' : /visa|card|credit|debit|master|amex|discover/i.test(receipt.payment_method ?? '') ? 'card' : 'other' });
export function parseResolution(params, original) {
  const current = resolutionValues(original);
  const values = Object.fromEntries(names.map((name) => [name, String(params.get(`receipt-${name}`) ?? current[name]).trim()]));
  if (!values.merchant || values.merchant.length > 120 || /[\r\n]/.test(values.merchant)) throw new PanelError('Enter the merchant name (up to 120 characters).');
  if (values.date && (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || !Number.isFinite(Date.parse(values.date)) || new Date(values.date).toISOString().slice(0, 10) !== values.date || values.date > shiftDay(today(), 1))) throw new PanelError('Enter a real purchase date, no later than tomorrow, or leave it blank if it is unreadable.');
  const total = parseAmount(values.total);
  if (total === null || total <= 0) throw new PanelError('Enter a positive receipt total, with at most two decimal places.');
  if (!['card', 'cash', 'other'].includes(values.payment_method)) throw new PanelError('Choose Card, Cash or Other for the payment method.');
  return { ...values, date: values.date || null, total: total / 100 };
}
export function resolutionAllowed(entry, summary) {
  return Boolean(entry && !entry.archived && !entry.filing && !entry.applied && !entry.creating && !entry.reread && (!entry.done ? entry.waiting : true) && summary?.receipt && !summary.alreadyApplied && (!summary.plan?.applied || entry.resolutionPending));
}

const signature = (id, entry, summary, fields, candidates) => crypto.createHmac('sha256', config.trigger.token).update(JSON.stringify([id, entry.at ?? '', entry.result ?? '', entry.filedAs ?? '', entry.applied ?? null, summary.receipt, fields, candidates.map((c) => c.snapshot)])).digest('hex');
const corrected = (receipt, fields) => {
  const result = { ...structuredClone(receipt), ...fields, manualFields: names };
  // A corrected store name must not keep matching against the old OCR's store clues.
  if (fields.merchant !== receipt.merchant) delete result.store_clues;
  return result;
};

async function candidatesFor(actual, fields, entry) {
  await actual.syncNow();
  const labels = await actual.categoryLabels();
  const allowed = (await import('./category-notes.js')).receiptLabels([...labels.keys()]);
  const ids = new Map([...labels].map(([label, id]) => [id, label]));
  const date = fields.date ?? String(entry.lastmod ?? entry.at ?? today()).slice(0, 10);
  const window = { start: shiftDay(date, fields.date ? -7 : -14), end: shiftDay(date, Math.max(7, config.match.days)) };
  const candidates = [];
  for await (const { t, account, payeeName, payeeIsTransfer } of actual.budgetTransactions(window.start, window.end, { matchAccounts: true })) {
    if (t.is_child || t.transfer_id || payeeIsTransfer || /#receipt\b/.test(t.notes ?? '') || t.amount !== -cents(fields.total)) continue;
    const category = ids.get(t.category) ?? null;
    const keep = Boolean(t.is_parent || t.reconciled || (t.category && !allowed.includes(category)));
    candidates.push({ id: t.id, date: t.date, amount: money(-t.amount), account: account.name, payee: payeeName ?? t.imported_payee ?? 'Unknown payee', category, keep, pending: t.cleared === false, snapshot: selectionSnapshot(t), parts: (t.subtransactions ?? []).map((s) => ({ category: ids.get(s.category) ?? 'Uncategorized', amount: money(-s.amount), items: [] })) });
  }
  candidates.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(date)) - Math.abs(Date.parse(b.date) - Date.parse(date)) || a.account.localeCompare(b.account) || a.id.localeCompare(b.id));
  return { candidates: candidates.slice(0, 30), window, truncated: candidates.length > 30 };
}

export async function resolutionPreview(view, params, deps = {}) {
  if (!resolutionAllowed(view.entry, view.summary)) return null;
  const values = resolutionValues(view.summary.receipt);
  if (params?.get('resolve') !== '1') return { values, original: values };
  try {
    const fields = parseResolution(params, view.summary.receipt);
    return await exclusive(async () => {
      const actual = deps.actual ?? await import('./actual.js');
      await openActual(actual);
      try {
        const found = await candidatesFor(actual, fields, view.entry);
        return { values: resolutionValues(fields), original: values, fields, ...found, token: signature(view.id, view.entry, view.summary, fields, found.candidates) };
      } finally { await actual.close(); }
    }, { timeoutMs: deps.lockWaitMs ?? 4000 });
  } catch (err) {
    return { values: Object.fromEntries(names.map((n) => [n, params.get(`receipt-${n}`) ?? values[n]])), original: values, error: err.name === 'BusyError' ? 'The worker is checking receipts. Try finding charges again in a minute.' : err.message };
  }
}

async function load(id, nc) {
  const state = await loadState();
  const entry = state[id];
  if (!entry) throw new PanelError('This receipt is no longer on the list. Reload the page.');
  const summary = entry.resolutionPending?.summary ?? entry.summary ?? (entry.filedAs ? await nc.readSummary(entry.filedAs) : null) ?? (entry.reading?.receipt ? { file: path.basename(parseStateKey(id).file), receipt: entry.reading.receipt, problems: [entry.waiting?.reason ?? ''] } : null);
  if (!resolutionAllowed(entry, summary)) throw new PanelError('This receipt has already changed or was applied in Actual. Reload it before choosing a charge.');
  return { state, entry, summary };
}

export async function commitResolution(form, out, deps = {}) {
  const id = form.get('id') ?? '';
  try {
    return await exclusive(async () => {
      refuseInDryRun(id);
      const nc = deps.nextcloud ?? await import('./nextcloud.js');
      const { entry, summary } = await load(id, nc);
      const fields = parseResolution(form, summary.receipt);
      if (!['select', 'recheck'].includes(form.get('action'))) throw new PanelError('Choose a charge or save the corrected reading for another check.');
      const actual = deps.actual ?? await import('./actual.js');
      await openActual(actual);
      let found;
      try { found = await candidatesFor(actual, fields, entry); } finally { await actual.close(); }
      if (!form.get('token') || form.get('token') !== signature(id, entry, summary, fields, found.candidates)) throw new PanelError('The receipt or available charges changed. Find matching charges again before saving. Nothing was changed.');
      const chosen = form.get('action') === 'select' ? found.candidates.find((c) => c.id === form.get('transaction')) : null;
      if (form.get('action') === 'select' && (!chosen || chosen.pending)) throw new PanelError('That charge cannot be chosen now. Wait until it has cleared, then find matching charges again.');
      const receipt = corrected(summary.receipt, fields);
      const at = new Date().toISOString();
      const saved = { ...summary, receipt, plan: null, transaction: null, problems: ['Reading corrected. Waiting for a bank charge.'], readingCorrection: { at, fields, before: summary.readingCorrection?.before ?? resolutionValues(summary.receipt) } };
      delete saved.alreadyApplied;
      delete saved.totalCorrected;
      delete saved.reread;
      delete saved.selection;
      if (chosen) {
        saved.transaction = { id: chosen.id, date: chosen.date, account: chosen.account, amount: chosen.amount, payee: chosen.payee, currentCategory: chosen.category, currentSplit: chosen.keep ? chosen.parts : null, pending: false };
        saved.selection = { at, snapshot: chosen.snapshot, keep: chosen.keep };
        saved.problems = chosen.keep ? [] : ['You chose this charge. Check the items and Preview before applying them.'];
        if (chosen.keep) saved.plan = { action: 'note', applied: true, parts: chosen.parts };
      }
      const inbox = parseStateKey(id).file;
      let from = entry.resolutionPending?.from ?? entry.filedAs ?? inbox;
      // A MOVE can succeed while its response is lost. Only recognize the destination when its version matches.
      if (entry.resolutionPending?.moveRequested && from !== inbox) {
        try { await nc.statPath(from); }
        catch (err) {
          if (err.status !== 404) throw err;
          const dest = await nc.statPath(inbox);
          if (!entry.resolutionPending.fileEtag || dest.etag !== entry.resolutionPending.fileEtag) throw new PanelError('The queued photo could not be verified. Nothing was changed in Actual.');
          from = inbox;
        }
      }
      // Keep the corrected record locally until its sidecar is confirmed. No Actual write has happened.
      const pending = { summary: saved, from, action: form.get('action') };
      await patchEntry(id, (e) => ({ ...e, ...(from === inbox ? { filedAs: from } : {}), resolutionPending: pending }));
      try { await nc.refile(from, from, saved); }
      catch (err) { throw new PanelError(`The corrected reading was kept, but could not be saved to ${filesPlace()} (${err.message}). Find matching charges again to finish saving it. Nothing was changed in Actual.`); }
      if (!chosen) {
        if (from !== inbox) {
          const source = await nc.statPath(from);
          if (!source.etag) throw new PanelError(`${filesPlace(true)} did not return the photo version. Try again in a minute.`);
          pending.fileEtag = source.etag; pending.moveRequested = true;
          await patchEntry(id, (e) => ({ ...e, resolutionPending: { ...pending } }));
          const moved = await nc.requeueFromReview(from, path.basename(inbox));
          if (!moved || moved.refused) throw new PanelError('The corrected reading was saved, but the receipt could not be queued. Try finding charges again. Nothing was changed in Actual.');
          pending.from = moved.moved ?? inbox; pending.moveRequested = false;
          await patchEntry(id, (e) => ({ ...e, filedAs: pending.from, resolutionPending: { ...pending, from: pending.from } }));
        }
        const stat = await nc.statPath(inbox);
        if (!stat.etag) throw new PanelError(`The corrected reading was saved, but ${filesPlace()} did not return its file version. Try again in a minute.`);
        const nextId = `${inbox}@${stat.etag}`;
        const next = { done: false, at, lastmod: stat.lastmod ?? entry.lastmod ?? at, reading: { receipt, mode: summary.readWith ?? 'corrected reading', reader: (await import('./receipt.js')).currentReader() }, receiptFields: fields };
        const latest = await loadState();
        delete latest[id]; latest[nextId] = next;
        await saveState(latest);
        form.set('id', nextId); out.trigger = 'corrected receipt';
        return 'Saved the corrected reading. The worker will check for its charge now; it will keep your corrections and will not read the photo again.';
      }
      const next = { ...entry, done: true, result: chosen.keep ? 'confirm' : 'review', at, filedAs: from, card: { store: receipt.merchant, date: receipt.date, total: receipt.total }, review: reviewCause({ result: 'review' }, saved), ...(chosen.keep ? { manualLink: { keep: true, at }, applied: { txnId: chosen.id, action: 'note', at, linked: true } } : {}) };
      for (const k of ['waiting', 'reading', 'error', 'attempts', 'resolutionPending', 'summary', 'receiptFields']) delete next[k];
      await patchEntry(id, () => next);
      return chosen.keep ? 'Linked to the charge you chose. Its amounts, categories and notes in Actual were kept. You can archive this receipt.' : 'Linked to the charge you chose. Nothing was changed in Actual. Check the item categories and use Preview before applying them.';
    }, { timeoutMs: deps.lockWaitMs ?? 20000 });
  } catch (err) {
    if (err instanceof PanelError) throw err;
    throw new PanelError(err.name === 'BusyError' ? 'The worker is busy. Try again in a minute.' : `Could not finish correcting the receipt (${err.message}). No change was sent to Actual.`);
  }
}
