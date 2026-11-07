// Household keywords from the command line (no Actual access). Run via ./receipts keyword <command>:
//   add <phrase> <category> [--at <store>] [--always|--usually]    remove <phrase> [--at <store>]    list
//   test <item text> [--at <store>] [--amount <charge dollars>] [--item-amount <item price dollars>]
// Categories come from the keys of the category notes file (read-only); match the full label, the part after " / ",
// or a unique prefix of either, ignoring case.
import './private-umask.js';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { addKeyword, keywordAction, keywordFits, loadKeywords, matchKeyword, removeKeyword, strengthOf } from './keywords.js';
import { stripDepartment } from './categorize.js';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const args = process.argv.slice(2);
const cmd = args.shift();
let store = null;
const at = args.indexOf('--at');
if (at >= 0) {
  store = args[at + 1] ?? fail('--at needs a store name');
  args.splice(at, 2);
}

let amountCents = null;
const amt = args.indexOf('--amount');
if (amt >= 0) {
  const dollars = Number(args[amt + 1]);
  if (!Number.isFinite(dollars) || dollars <= 0) fail('--amount needs the charge in dollars, e.g. --amount 50.63');
  amountCents = Math.round(dollars * 100);
  args.splice(amt, 2);
}

let itemCents = null;
const itemAmt = args.indexOf('--item-amount');
if (itemAmt >= 0) {
  const dollars = Number(args[itemAmt + 1]);
  if (!Number.isFinite(dollars) || dollars <= 0) fail('--item-amount needs the item price in dollars, e.g. --item-amount 15.49');
  itemCents = Math.round(dollars * 100);
  args.splice(itemAmt, 2);
}

let strength = 'usually';
const flags = args.filter((a) => a === '--always' || a === '--usually');
if (flags.length) {
  if (cmd !== 'add') fail(`${flags[0]} only applies to "keyword add"`);
  if (new Set(flags).size > 1) fail('Use only one of --always and --usually');
  strength = flags[0].slice(2);
  for (let i = args.length - 1; i >= 0; i--) if (args[i] === flags[0]) args.splice(i, 1);
}

const DOES = { file: 'filed by keyword, no model call', hint: 'the model sees it as a hint', none: 'ignored (KEYWORD_MODE=off)' };
const doing = (k) => DOES[keywordAction(config.keywordMode, k)];

async function categories() {
  try {
    return Object.keys(JSON.parse(await fs.readFile(config.categoryNotesPath, 'utf8')));
  } catch (err) {
    return fail(`Cannot read the category list from ${config.categoryNotesPath}: ${err.message}`);
  }
}

async function resolveCategory(name) {
  const all = await categories();
  const q = name.trim().toLowerCase();
  const tail = (l) => l.split(' / ').pop().toLowerCase();
  const stages = [
    (l) => l.toLowerCase() === q || tail(l) === q,
    (l) => l.toLowerCase().startsWith(q) || tail(l).startsWith(q),
  ];
  for (const ok of stages) {
    const hits = all.filter(ok);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return fail(`"${name}" is ambiguous (${hits.join('; ')}). Categories:\n  ${all.join('\n  ')}`);
  }
  return fail(`Unknown category "${name}". Categories:\n  ${all.join('\n  ')}`);
}

const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const limitNote = (k) => {
  const limits = [Number.isFinite(k.maxCents) ? `charges up to ${dollars(k.maxCents)}` : null, Number.isFinite(k.maxItemCents) ? `items up to ${dollars(k.maxItemCents)}` : null].filter(Boolean);
  return limits.length ? ` (${limits.join(', ')})` : '';
};
const where = (s) => (s ? ` at ${s}` : '');
if (cmd === 'add') {
  if (args.length !== 2) fail('Usage: keyword add <phrase> <category> [--at <store>] [--always|--usually]');
  const category = await resolveCategory(args[1]);
  const k = await addKeyword({ phrase: args[0], category, store, strength, from: 'cli' });
  console.log(`Added: "${k.phrase}"${where(k.store)} → ${k.category} [${k.strength}]`);
} else if (cmd === 'remove') {
  if (args.length !== 1) fail('Usage: keyword remove <phrase> [--at <store>]');
  const n = await removeKeyword(args[0], store);
  if (!n) fail(`No keyword "${args[0]}"${where(store)}.`);
  console.log(`Removed "${args[0]}"${where(store)}.`);
} else if (cmd === 'list') {
  const list = await loadKeywords();
  if (!list.length) console.log('No keywords yet.');
  for (const k of list) console.log(`"${k.phrase}"${where(k.store)} → ${k.category}   [${strengthOf(k)}] (${k.from}, ${k.added})${limitNote(k)}`);
} else if (cmd === 'test') {
  if (args.length < 1) fail('Usage: keyword test <item text> [--at <store>] [--amount <charge dollars>] [--item-amount <item dollars>]');
  const text = args.join(' ');
  const all = await loadKeywords();
  const find = (list) => matchKeyword([stripDepartment(text)], store, list);
  // Like the worker: the size limits are applied before matching, so a keyword over its limit lets a lower one through.
  // A limit whose amount wasn't given can't be checked (and is reported below), so it doesn't filter.
  const fitting = all.filter((k) => keywordFits({ ...k, maxCents: amountCents == null ? undefined : k.maxCents, maxItemCents: itemCents == null ? undefined : k.maxItemCents }, amountCents, itemCents));
  const m = find(fitting);
  const stopped = !m && find(all);
  const show = m || (stopped && !stopped.tie ? stopped : null);
  if (!m && !show) console.log(stopped?.tie ? `Tie, keywords disagree:\n${stopped.tie.map((k) => `  "${k.phrase}"${where(k.store)} → ${k.category} [${strengthOf(k)}]`).join('\n')}` : `No keyword matches "${text}".`);
  else if (m?.tie) console.log(`Tie, keywords disagree:\n${m.tie.map((k) => `  "${k.phrase}"${where(k.store)} → ${k.category} [${strengthOf(k)}]`).join('\n')}`);
  else {
    console.log(`Match: "${show.phrase}"${where(show.store)} → ${show.category} [${strengthOf(show)}]${limitNote(show)}\n  KEYWORD_MODE=${config.keywordMode}: ${doing(show)}`);
    // Each limit is checked on its own, so the answer says which one stops the keyword.
    const check = (limit, given, flag, what) => {
      if (!Number.isFinite(limit)) return;
      if (given == null) console.log(`  The ${what} limit was not checked (add ${flag} <dollars>).`);
      else if (!keywordFits({ from: 'learned', maxCents: limit }, given)) console.log(`  Not applied: the ${what} is over the limit.`);
    };
    check(show.maxCents, amountCents, '--amount', 'charge');
    check(show.maxItemCents, itemCents, '--item-amount', 'item price');
  }
} else {
  fail('Usage: keyword add|remove|list|test ... (see ./receipts help)');
}
