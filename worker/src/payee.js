import fs from 'node:fs';
import { config, log } from './config.js';

// Words that bank descriptions add around the merchant name and that say nothing about who it is.
const NOISE = new Set('sq tst sp pp paypal pos debit credit card purchase recurring payment visa mc ach checkcard chk inc llc ltd co corp the www com net'.split(' '));

// Words many unrelated businesses share ("Dollar Tree" / "Dollar General", "Pizza Hut" / "Pizza Ranch"). They count
// toward a match but never carry it alone: no first-word bonus, no prefix match, and a match needs at least one shared
// word that isn't on this list.
const GENERIC = new Set(`dollar home pizza taco burger burgers fleet kwik quik quick family general gen super food foods auto
  store stores market mart shop shops shoppe gas station mini express discount outlet center centre depot supercenter
  wholesale whse grill cafe coffee kitchen bar restaurant deli bakery pharmacy drug drugs liquor liquors wine beer tire tires
  car wash motors hardware supply farm thrift hobby party pet pets sports beauty book books toy toys craft crafts office
  music golf pawn nail nails hair salon spa fitness gym pub brewing chicken garden flower flowers furniture mattress shoe
  shoes smoke vape big best first new city county american national united golden royal great star town country fresh
  value plus world house land club price prices save savings warehouse dept department child kids baby`.split(/\s+/));

// US state codes: bank descriptions end with "<city> <ST>".
const STATES = new Set('al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc'.split(' '));

// A store number ("#0123", "T-1234", "2345"): what follows it in a bank description is the location.
const STORE_NO = /(?:[\s*]#?\s*|#\s*)(?:[a-z]{1,2}-)?\d{3,}|\s?#\s*\d+/;

const significant = (t) => t.length >= 3 || /^\d+$/.test(t);
const distinctive = (t) => significant(t) && !GENERIC.has(t);

/** Words of a merchant name: "CASEYS GEN STORE 2345 SPRINGFIELD IL" → ["caseys", "gen", "store"]. */
function tokens(name) {
  let s = (name ?? '').toLowerCase().replace(/['’`]/g, '');
  const cut = STORE_NO.exec(s);
  if (cut && s.slice(0, cut.index).replace(/[^a-z]+/g, ' ').trim().split(' ').some((t) => t.length >= 3)) s = s.slice(0, cut.index);
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  // Digits are store numbers, except a brand that is (or starts with) a short number: "76", "7-Eleven".
  const words = s.split(' ').filter((t, i) => t && (!/\d/.test(t) || (i === 0 && /^\d{1,3}$/.test(t))));
  let out = words.filter((t) => !NOISE.has(t));
  // "... SPRINGFIELD IL": drop a trailing state code and the city word before it, if a real name is left.
  if (out.length >= 3 && STATES.has(out.at(-1)) && out.slice(0, -2).some(significant)) out = out.slice(0, -2);
  return out;
}

// Same word, or one is the start of the other ("menard" / "menards"). A generic word only counts as a prefix of a
// longer word if it's most of it, so "home" doesn't match "homegoods".
function wordMatch(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 4 || !l.startsWith(s)) return false;
  return GENERIC.has(s) ? s.length / l.length >= 0.75 : s.length >= 5 || s.length / l.length >= 0.75;
}

// One name is a run of whole words in the other: "walmart" in "wal mart supercenter", "price chopper" in
// "joes price chopper". Generic-only names count only as the start of the other ("family dollar" in
// "family dollar store"), never a single generic word ("dollar" in "dollar tree").
function containment(x, y) {
  const cx = x.join('');
  if (cx.length < 3 && !/^\d+$/.test(cx)) return 0;
  for (let i = 0; i < y.length; i++) {
    let run = '';
    for (let j = i; j < y.length && run.length < cx.length; j++) run += y[j];
    if (run !== cx) continue;
    if (x.some(distinctive) || /^\d+$/.test(cx)) return 0.9;
    if (x.length >= 2 && i === 0) return 0.9;
    return 0.5;
  }
  return 0;
}

/** 0–1: how likely two merchant names refer to the same business. */
export function similarity(a, b) {
  const na = tokens(a);
  const nb = tokens(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na.join('') === nb.join('')) return 1;
  const contained = Math.max(containment(na, nb), containment(nb, na));
  const ta = na.filter(significant);
  const tb = nb.filter(significant);
  if (ta.length === 0 || tb.length === 0) return contained;
  const matched = ta.filter((t) => tb.some((u) => wordMatch(t, u)));
  let score = (0.8 * matched.length) / Math.min(ta.length, tb.length);
  // Brand names come first: "costco wholesale" ~ "costco whse", "maple thrift" ~ "maple transitional".
  if (distinctive(ta[0]) && ta[0].length >= 4 && wordMatch(ta[0], tb[0])) score = Math.max(score, 0.7);
  if (ta.length >= 2 && tb.length >= 2 && wordMatch(ta[0], tb[0]) && wordMatch(ta[1], tb[1]) && (distinctive(ta[0]) || distinctive(ta[1]))) {
    score = Math.max(score, 0.75); // "blue door oak park" ~ "blue door thrift oak parkoak"
  }
  if (!matched.some(distinctive)) score = Math.min(score, 0.5); // only generic words in common: "pizza hut" / "pizza ranch"
  return Math.max(contained, score);
}

/**
 * Optional /data/payee-aliases.json: groups of names for the same merchant, for cases the fuzzy match misses.
 * [["Walmart", "WM SUPERCENTER"], ["Amazon", "AMZN Mktp"]]
 */
let aliases = [];
export function loadAliases() {
  try {
    aliases = JSON.parse(fs.readFileSync(config.aliasesPath, 'utf8'));
    log(`loaded ${aliases.length} payee alias group(s)`);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`could not read ${config.aliasesPath}: ${err.message}`);
    aliases = [];
  }
}

/** Best score between the receipt's merchant (plus its aliases) and any of the transaction's payee strings. */
export function payeeScore(merchant, payeeStrings) {
  const names = [merchant];
  for (const group of aliases) if (group.some((n) => similarity(n, merchant) >= 0.9)) names.push(...group);
  let best = 0;
  for (const n of names) for (const p of payeeStrings) if (p) best = Math.max(best, similarity(n, p));
  return best;
}

// Card readers and payment services whose domain is printed on receipts from any store.
const PROCESSOR_DOMAINS = new Set(['clover', 'square', 'squareup', 'toasttab', 'toast', 'paypal', 'shopify', 'stripe', 'spoton', 'heartland', 'lightspeed', 'revel']);
// Street and address words: a clue containing one is an address, not a business name.
const ADDRESS = /\b(st|street|ave|avenue|rd|road|blvd|pkwy|parkway|hwy|highway|dr|drive|ln|lane|ct|suite|ste)\b\.?/i;
const CLUE_CAP = 0.8; // a clue alone never beats a merchant name that matches well
const CLUE_PENALTY = 0.1; // ...and loses a little more when the merchant name points elsewhere

/** "frontend@menards.com" / "www.menards.com" / "Target.com/Circle" → "menards" / "target"; null if not a domain. */
function domainName(clue) {
  const m = /(?:@|^|[\s/])(?:[a-z0-9-]+\.)*?([a-z0-9-]+)\.(?:com|net|org|us|co|biz|info|store|shop)\b/i.exec(clue.trim());
  return m ? m[1].toLowerCase() : null;
}

/** A domain label's best match: also counts a payee name buried in it ("informtarget" ~ "Target"). */
function domainScore(label, payeeStrings) {
  let best = payeeScore(label, payeeStrings);
  for (const p of payeeStrings) {
    if (!p) continue;
    const words = tokens(p);
    const compact = words.join('');
    if ((compact.length >= 4 && label.includes(compact)) || words.some((w) => distinctive(w) && w.length >= 5 && label.includes(w))) best = Math.max(best, 0.9);
  }
  return best;
}

/**
 * How well a receipt's store matches a transaction's payee strings. The merchant name scores as payeeScore does;
 * store_clues help only when they are a website/email domain or a multi-word business name. Single words are usually
 * the city ("Springfield"), so they're ignored. A clue's score is capped so it can't outrank a merchant name that
 * matches another transaction.
 */
export function storeScore(receipt, payeeStrings) {
  const merchantScore = receipt.merchant ? payeeScore(receipt.merchant, payeeStrings) : 0;
  let clueScore = 0;
  for (const clue of receipt.store_clues ?? []) {
    if (typeof clue !== 'string' || !clue.trim()) continue;
    const domain = domainName(clue);
    if (domain) {
      if (!PROCESSOR_DOMAINS.has(domain)) clueScore = Math.max(clueScore, domainScore(domain, payeeStrings));
    } else if (!ADDRESS.test(clue) && !/\d/.test(clue) && tokens(clue).filter(significant).length >= 2) {
      clueScore = Math.max(clueScore, payeeScore(clue, payeeStrings));
    }
  }
  clueScore = Math.min(clueScore, CLUE_CAP);
  if (merchantScore < 0.3) clueScore -= CLUE_PENALTY;
  return Math.max(merchantScore, clueScore, 0);
}
