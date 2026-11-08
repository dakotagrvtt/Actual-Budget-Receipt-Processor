// What every page of the control panel shares: escaping, the page frame, the one inline style (and the CSP that pins it and the
// script by hash), and the small pieces the pages are built from (forms, filter bar, sortable table, folder names).
import { config } from './config.js';
import { SCRIPT, hashOf } from './panel-script.js';

export const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A time as the panel shows it (in TRIGGER_TIMEZONE); '' for none. */
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: config.trigger.timeZone }) : '');

const CSS = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--accent:#2f6fde;--warn:#b25000;--warnbg:#fff4e5;--okbg:#e8f5e9}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#98989d;--line:#3a3a3c;--accent:#5e9bff;--warn:#ffb866;--warnbg:#3a2a14;--okbg:#17301b}}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:48rem;margin:1.5rem auto;padding:0 16px}
h1{font-size:1.3rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.5rem 0 .25rem}.muted{color:var(--muted)}.small{font-size:.85rem}
nav{display:flex;gap:.25rem;flex-wrap:wrap;margin:0 0 1rem;border-bottom:1px solid var(--line)}
nav a{padding:.4rem .8rem;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}
nav a.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;margin:.5rem 0}
button.small{padding:.25rem .7rem;margin:0}button.plain{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.danger{background:#c0392b}
input[type=text],select,textarea{font:inherit;width:100%;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:5.5rem;resize:vertical}label{display:block;margin:.6rem 0 .15rem;font-weight:600;font-size:.9rem}
.notice{padding:.5rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--okbg)}
.banner{padding:.6rem .8rem;border-radius:8px;border:1px solid var(--line);margin:.5rem 0}
.banner.live{background:var(--warnbg);border-color:var(--warn)}.banner b{display:block}
.card{border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;margin:.6rem 0}
.tag{display:inline-block;font-size:.75rem;padding:.05rem .5rem;border:1px solid var(--line);border-radius:99px;color:var(--muted)}
.tag.draft{color:var(--warn);border-color:var(--warn)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
td form{margin:0}.check{display:flex;gap:.5rem;align-items:flex-start;margin:.8rem 0}.check input{margin-top:.3rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap}.row>*{flex:1 1 10rem}
[hidden]{display:none!important}
.tools{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.4rem 0}.tools>input,.tools>select{flex:1 1 9rem;width:auto}
.tools label{display:flex;gap:.4rem;align-items:center;margin:0;font-weight:400;flex:0 0 auto}
th.sortable{cursor:pointer;white-space:nowrap;user-select:none}
.notice form{display:inline;margin-left:.5rem}.notice button{margin:0}
.photo{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;margin:.5rem 0}
.pager{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.5rem 0}.pager .pos{flex:0 0 auto;white-space:nowrap}
.pager a.btn,.pager span.btn{padding:.25rem .7rem;border:1px solid var(--line);border-radius:8px;text-decoration:none;color:var(--accent);white-space:nowrap}
.pager span.btn{color:var(--muted)}
.pager form{flex:1 1 14rem;display:flex;gap:.5rem;align-items:center;margin:0}.pager form button{margin:0}
.todo p{margin:.2rem 0}.todo form{margin:.3rem 0 0}
.receipt-grid{display:grid;gap:0 1.5rem;grid-template-columns:minmax(0,1fr)}
details.how{border:1px solid var(--line);border-radius:8px;padding:.4rem .8rem;margin:1rem 0}details.how summary{cursor:pointer;font-weight:600}
details.how dt{font-weight:600;margin-top:.5rem}details.how dd{margin:0 0 0 .5rem}
tr:target{outline:2px solid var(--accent);outline-offset:-2px}
@media (min-width:64rem){body.wide{max-width:80rem}.receipt-grid{grid-template-columns:minmax(0,5fr) minmax(0,6fr);align-items:start}.receipt-photos{position:sticky;top:.5rem;max-height:calc(100vh - 1rem);overflow:auto}}
.setting{border-top:1px solid var(--line);padding:.4rem 0 .6rem}.setting label{margin:.2rem 0}.setting .help{margin:.2rem 0}
.setting .check{margin:.2rem 0}.setting .check label{margin:0;font-weight:600}
.setting .actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.nobtn{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.grouphead{display:flex;gap:.5rem;align-items:center;justify-content:space-between;flex-wrap:wrap}.grouphead h2{margin:1.2rem 0 .25rem}
select.pick{font:inherit;max-width:16rem;padding:.25rem .4rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input[type=password],input[type=number]{font:inherit;width:100%;padding:.45rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
`;

/** The Content-Security-Policy for every page: only the one inline style and the one inline script (by hash), forms only to this server. */
export const CSP = `default-src 'none'; style-src ${hashOf(CSS)}; script-src ${hashOf(SCRIPT)}; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** The page frame: head, title, top navigation, optional notice. `active` is 'status' | 'categories' | 'keywords' | 'learned' | 'settings' | 'privacy'. */
export function layout({ active, key, notice, body, undo, wide }) {
  const k = `?key=${encodeURIComponent(key)}`;
  const link = (id, href, text) => `<a href="${href}${escape(k)}"${active === id ? ' class="on"' : ''}>${text}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipts</title><style>${CSS}</style></head><body${wide ? ' class="wide"' : ''}>
<h1>Receipts</h1>
<nav>${link('status', './', 'Status')}${link('categories', 'categories', 'Categories')}${link('keywords', 'keywords', 'Keywords')}${link('learned', 'learned', 'Learned')}${link('settings', 'settings', 'Settings')}${config.decider.provider === 'remote' ? link('privacy', 'privacy', 'Privacy') : ''}</nav>
${noticeHtml(notice, undo, key)}
${body}
<script>${SCRIPT}</script>
</body></html>`;
}

/** The notice line; after a removal it carries an Undo button (a POST form with what is needed to put the item back). */
function noticeHtml(notice, undo, key) {
  if (!notice) return '';
  if (!undo) return `<p class="notice">${escape(notice)}</p>`;
  const fields = Object.entries(undo.fields).map(([n, v]) => hidden(n, v)).join('');
  return `<div class="notice">${escape(notice)}<form ${post(undo.route, key)}>${fields}<button class="small plain">Undo</button></form></div>`;
}

/** The attributes of a POST form to an action of this server, carrying the key. */
export const post = (action, key) => `method="post" action="${formAction(action, key)}"`;

/** A hidden form field. */
export const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;

/** A filter bar for the rows of #id: text box, optional dropdowns and checkboxes. Hidden until the script runs. */
export function toolbar(id, label, { selects = [], checks = [] } = {}) {
  const sels = selects.map((s) => `<select data-field="${escape(s.field)}" aria-label="${escape(s.label)}"><option value="">${escape(s.all)}</option>${s.values.map((v) => { const [val, text] = Array.isArray(v) ? v : [v, v]; return `<option value="${escape(val)}">${escape(text)}</option>`; }).join('')}</select>`).join('');
  const boxes = checks.map((c) => `<label><input type="checkbox" data-field="${escape(c.field)}"> ${escape(c.text)}</label>`).join('');
  return `<div class="tools" data-tools="${escape(id)}" hidden><input type="text" data-q placeholder="Filter ${escape(label)}" aria-label="Filter ${escape(label)}" autocomplete="off">${sels}${boxes}</div>`;
}
/** A sortable table. cols: ['Name', ['Added', 'date'], ''] (an empty title is not sortable). */
export function sortable(id, cols, rows, empty) {
  const th = cols.map((c) => (Array.isArray(c) ? `<th data-type="${c[1]}"${c[2] ? ` data-key="${c[2]}"` : ''}>${c[0]}</th>` : `<th>${c}</th>`)).join('');
  return `<div class="scroll"><table id="${escape(id)}" data-sortable><thead><tr>${th}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
}

/** A relative form action carrying the key, already escaped for an attribute. */
export const formAction = (action, key) => `${action}?key=${escape(encodeURIComponent(key))}`;

/** A number with two decimals; '' when it is not one. */
export const money = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n).toFixed(2) : '');
/** A label / value table row; '' when there is no value. */
export const fact = (label, value) => (value === '' || value === null || value === undefined ? '' : `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`);

// The folders as configured (RECEIPTS_REVIEW / RECEIPTS_PROCESSED), without the leading slash, for the help text.
export const folder = (p) => String(p ?? '').replace(/^\/+/, '');
export const reviewDir = () => folder(config.nextcloud.review);
export const processedDir = () => folder(config.nextcloud.processed);
