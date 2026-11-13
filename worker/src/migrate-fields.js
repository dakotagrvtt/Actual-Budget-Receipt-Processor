// Which fields of state.json entries and of receipt summaries (<photo>.json) name a file, a folder or a file version, and how each
// one follows a storage migration. Every field is listed by record type; nothing is guessed from a field's name. An unknown field
// that looks like a version, or a path inside an old receipt folder, stops the migration instead of being copied unchanged.
//
// Version (etag) rules:
//   state key @etag             the inbox version the receipt was read from. Later code compares it with the filed photo (MOVE keeps
//                               the etag), so it follows the copy of the key's own file, else the copy of filedAs with that version.
//                               Neither copied with that version: kept as it was (the photo is gone; nothing compares it any more).
//   filing.etag                 the version of filing.from (before the move) or filing.to (after it). Must follow a copy: refused otherwise.
//   resolutionPending.fileEtag  the version of resolutionPending.from or of the key's inbox file. Must follow a copy: refused otherwise.
//   requeue.etag                the version of requeue.from or of <inbox>/<requeue.name>. Must follow a copy: refused otherwise.
//   summary archived.shrunk.etag  the original's version (archived.from) a shrunk copy was made from (local folders only). Follows the
//                               copy of archived.from with that version, else it is dropped: sha256 and size still identify the original
//                               (archive-files.js sameOriginal), so a dropped etag only means one more hash.
import path from 'node:path/posix';

const tagText = (t) => String(t ?? '').replace(/^W\//, '').replaceAll('"', '');
export const sameEtag = (a, b) => Boolean(a) && Boolean(b) && tagText(a) === tagText(b);
export function normalizeStoragePath(p) {
  if (typeof p !== 'string' || p.split('/').includes('..')) throw new Error(`Unsafe storage path: ${p}`);
  return path.normalize('/' + p).replace(/\/$/, '') || '/';
}
export const inside = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
export function mapStoragePath(p, from, to) {
  p = normalizeStoragePath(p);
  const folders = Object.entries(from).map(([k, v]) => [k, normalizeStoragePath(v)]).sort((a, b) => b[1].length - a[1].length);
  const found = folders.find(([, dir]) => inside(p, dir));
  return found ? path.join(normalizeStoragePath(to[found[0]]), p.slice(found[1].length)) : p;
}

export class UnsafeMigrationError extends Error {}
const pending = (what) => new UnsafeMigrationError(`Cannot safely translate ${what}. Let the pending operation finish (start the worker and wait one check) before migrating.`);

// Rule kinds: 'path' a file path, 'folder' a receipt folder, 'name' a bare file name (kept), 'text' anything else kept as it is,
// 'sidecar' a whole summary object, 'key' a state key. Functions handle the version fields (see the table above).
const PATH_RULE = 'path';
const SIDECAR = {
  file: 'name', // the photo's name as the Actual note's #receipt tag has it: never renamed
  archived: { from: PATH_RULE, key: 'key', shrunk: { etag: shrunkEtag } },
};
const ENTRY = {
  filedAs: PATH_RULE,
  folder: 'folder',
  summary: SIDECAR,
  filing: { from: PATH_RULE, to: PATH_RULE, dest: PATH_RULE, etag: filingEtag, summary: SIDECAR },
  resolutionPending: { from: PATH_RULE, fileEtag: resolutionEtag, summary: SIDECAR },
  requeue: { from: PATH_RULE, name: requeueName, etag: requeueEtag },
  archived: { folder: 'folder' },
  fixedOnPage: { before: { filedAs: PATH_RULE }, watch: { file: 'name' }, summaryBefore: SIDECAR },
  creating: { context: { summary: SIDECAR } },
};
// Fields whose name says "a path" when they show up somewhere unlisted.
const PATHISH = /^(filedAs|folder|from|to|dest|path|filename|file|dir)$|(Path|File|Folder|Dir)$/;

function versionVia(ctx, tag, paths) {
  if (tag == null || tag === '') return { tag: null };
  const hits = paths.filter(Boolean).map((p) => ctx.photo(p)).filter((c) => c?.etag && sameEtag(tag, c.sourceEtag));
  const tags = new Set(hits.map((c) => c.etag));
  if (tags.size > 1) throw pending('a file version that matches more than one copy');
  return { tag: tags.size ? [...tags][0] : null };
}
function filingEtag(v, parent, ctx) {
  const { tag } = versionVia(ctx, v, [parent.from, parent.to, parent.dest]);
  if (v && !tag) { if (ctx.lenient) { ctx.warn(`kept filing.etag of ${parent.from}: no copy with that version`); return v; } throw pending('filing.etag'); }
  return tag ?? v;
}
function resolutionEtag(v, parent, ctx) {
  const { tag } = versionVia(ctx, v, [parent.from, ctx.keyFile]);
  if (v && !tag) { if (ctx.lenient) { ctx.warn(`kept resolutionPending.fileEtag of ${parent.from}: no copy with that version`); return v; } throw pending('resolutionPending.fileEtag'); }
  return tag ?? v;
}
const requeueInbox = (parent, ctx) => (parent.name ? path.join(normalizeStoragePath(ctx.from.inbox), parent.name) : null);
function requeueEtag(v, parent, ctx) {
  const { tag } = versionVia(ctx, v, [parent.from, requeueInbox(parent, ctx)]);
  if (v && !tag) { if (ctx.lenient) { ctx.warn(`kept requeue.etag of ${parent.from}: no copy with that version`); return v; } throw pending('requeue.etag'); }
  return tag ?? v;
}
function requeueName(v, parent, ctx) {
  return typeof v === 'string' && v ? path.basename(ctx.map(requeueInbox(parent, ctx))) : v;
}
function shrunkEtag(v, parent, ctx, grand) {
  const { tag } = versionVia(ctx, v, [grand?.from]);
  return tag ?? undefined; // dropped: sha256 and size still identify the original
}

/** Refuse what can't be followed safely: an unlisted version field, or an unlisted path field pointing into an old folder. */
function checkUnknown(v, name, where, ctx) {
  if (v == null) return;
  if (/etag/i.test(name) && v !== '' && typeof v !== 'object') throw pending(`${where}.${name} (an unknown version field)`);
  if (typeof v === 'string') {
    if (PATHISH.test(name) && v.startsWith('/') && ctx.inOld(v)) throw pending(`${where}.${name} (an unknown file reference)`);
    return;
  }
  if (Array.isArray(v)) { for (const x of v) checkUnknown(x, name, where, ctx); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) checkUnknown(x, k, `${where}.${name}`, ctx);
}

function apply(v, rule, parent, ctx, where, grand) {
  if (rule === undefined) { checkUnknown(v, where.split('.').pop(), where.split('.').slice(0, -1).join('.') || 'entry', ctx); return v; }
  if (typeof rule === 'function') return rule(v, parent, ctx, grand);
  if (rule === 'text' || rule === 'name') return v;
  if (rule === PATH_RULE) return typeof v === 'string' && v.startsWith('/') ? ctx.map(v) : v;
  if (rule === 'folder') return typeof v === 'string' && v.startsWith('/') ? ctx.mapFolder(v) : v;
  if (rule === 'key') return typeof v === 'string' ? ctx.keyOf(v) : v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const next = apply(x, rule[k], v, ctx, `${where}.${k}`, parent);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return v;
}

/**
 * The rewriter for one migration. from/to: the folder maps; copies: [{ from, to, sourceEtag, etag }] (to: the new path; etag: the
 * version there, once verified). lenient: warn instead of refusing a version that follows no copy (used only after files moved).
 */
export function migrationRewriter(from, to, copies, { lenient = false, warn = () => {}, keys: savedKeys } = {}) {
  const exact = new Map(copies.map((c) => [c.from, c]));
  const oldDirs = Object.values(from).map(normalizeStoragePath);
  const map = (s) => exact.get(s)?.to ?? mapStoragePath(s, from, to);
  const ctx = {
    from, to, lenient, warn,
    map,
    mapFolder: (s) => mapStoragePath(s, from, to),
    inOld: (s) => { try { const p = normalizeStoragePath(s); return oldDirs.some((d) => inside(p, d)); } catch { return false; } },
    photo: (p) => exact.get(p),
    keyFile: null,
  };
  /** A state key: its file follows the copy; its version as in the table above. hints: other paths of the same receipt (filedAs). */
  const keyOf = (key, hints = []) => {
    const dry = key.startsWith('dry:') ? 'dry:' : '';
    const rest = key.slice(dry.length), at = rest.lastIndexOf('@');
    const file = at < 0 ? rest : rest.slice(0, at);
    if (!file.startsWith('/')) return key;
    if (at < 0) return dry + map(file);
    const tag = rest.slice(at + 1);
    let next = versionVia(ctx, tag, [file]).tag;
    if (!next) next = versionVia(ctx, tag, hints).tag;
    return `${dry}${map(file)}@${next ?? tag}`;
  };
  ctx.keyOf = (k) => (keys.has(k) ? keys.get(k) : keyOf(k, ctx.keyHints ?? []));
  const keys = new Map(savedKeys ?? []); // a resumed move: the key map computed before the stop
  /** One state entry under its (old) key. */
  const entry = (key, value) => {
    const file = key.replace(/^dry:/, '').split('@').slice(0, -1).join('@') || key.replace(/^dry:/, '');
    ctx.keyFile = file;
    try {
      // Older intents can lack a version or a durable destination: never guess which copied photo they own.
      for (const intent of [value?.filing, value?.resolutionPending, value?.requeue].filter(Boolean)) {
        const refs = [intent.from, intent.to, intent.dest, file, intent.name ? requeueInbox(intent, ctx) : null].filter(Boolean);
        if (!refs.some((r) => exact.has(r) && !r.endsWith('.json'))) throw new UnsafeMigrationError('Cannot identify a pending file operation. Let the pending operation finish (start the worker and wait one check) before migrating.');
      }
      return apply(value, ENTRY, null, ctx, 'entry');
    } finally { ctx.keyFile = null; }
  };
  /** A summary (<photo>.json) at old path `file` (the summary's own path). */
  const sidecar = (value, file) => {
    const photo = file.endsWith('.json') ? file.slice(0, -5) : file;
    ctx.keyHints = [photo];
    try { return apply(value, SIDECAR, null, ctx, 'summary'); } finally { ctx.keyHints = null; }
  };
  const state = (old) => {
    keys.clear();
    for (const [k, v] of Object.entries(old)) keys.set(k, keyOf(k, [v?.filedAs].filter((x) => typeof x === 'string')));
    const seen = new Map();
    for (const [k, n] of keys) {
      if (seen.has(n)) throw new UnsafeMigrationError(`Two receipts would share one state entry after migration (${seen.get(n)} and ${k}). Nothing was changed.`);
      seen.set(n, k);
    }
    return Object.fromEntries(Object.entries(old).map(([k, v]) => [keys.get(k), entry(k, v)]));
  };
  return { keyOf, map, entry, sidecar, state, keys };
}

/** state.json after the migration. Builds the key map that summaries (archived.key) then use. */
export function migratedState(state, from, to, copies, options) {
  return migrationRewriter(from, to, copies, options).state(state);
}
