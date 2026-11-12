// What every page of the control panel shares: escaping, the page frame, the one inline style (and the CSP that pins it and the
// script by hash), and the small pieces the pages are built from (forms, filter bar, sortable table, folder names).
import { config } from './config.js';
import { actualAnchor } from './actual-link.js';
import { SCRIPT, hashOf } from './panel-script.js';
import { WORKSPACE_CSS } from './panel-workspace-style.js';

export const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A time as the panel shows it (in TRIGGER_TIMEZONE); '' for none. */
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: config.trigger.timeZone }) : '');

/** A short time for a list: "Today 7:17 PM", "Yesterday", "Nov 1" (with the year when it is not this one); '' for none. The full time goes in a title. */
export function shortWhen(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const tz = config.trigger.timeZone;
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: tz });
  const diff = Math.round((Date.parse(day(now)) - Date.parse(day(d))) / 86400000);
  if (diff === 0) return `Today ${d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}`;
  if (diff === 1) return 'Yesterday';
  const sameYear = day(d).slice(0, 4) === day(now).slice(0, 4);
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** A purchase date for display only. Parse calendar dates in UTC to avoid shifting the day. */
export function displayDate(value, now = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ?? '';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  const year = Number(now.toLocaleDateString('en-US', { timeZone: config.trigger.timeZone, year: 'numeric' }));
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(date.getUTCFullYear() === year ? {} : { year: 'numeric' }) });
}

/** Display currency without changing the numeric formatter used by editable fields. */
export const displayMoney = (value) => money(value) ? `$${money(value)}` : '';

/** "Today 9:06 PM" as just the clock when it is today ("9:06 PM"), else the short date: the absolute time that goes with an "ago". */
export const clockOrDate = (iso) => shortWhen(iso).replace(/^Today /, '');

/** A <time> element: the short text in the page, the exact time as datetime and as a title. '' for no time. */
export function timeTag(iso, text = shortWhen(iso)) {
  if (!iso || Number.isNaN(Date.parse(iso))) return escape(text);
  return `<time datetime="${escape(new Date(iso).toISOString())}" title="${escape(when(iso))}">${escape(text)}</time>`;
}

/** A word for when a future time is, for a sentence: "today at 10:24 PM", "tomorrow at 9:00 AM", "on Nov 12 at 9:00 AM"; '' when the time has passed or isn't one. */
export function whenAhead(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime()) || d <= now) return '';
  const tz = config.trigger.timeZone;
  const clock = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const s = shortWhen(iso, now);
  if (s.startsWith('Today')) return `today at ${clock}`;
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: tz });
  if (Math.round((Date.parse(day(d)) - Date.parse(day(now))) / 86400000) === 1) return `tomorrow at ${clock}`;
  return `on ${s} at ${clock}`;
}

/** "just now", "2 min ago", "3 h ago", "2 days ago" for a time; the text itself when it is not a time ('not yet'). */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? '');
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

const LEGACY_CSS = `
:root{
  color-scheme:light;
  /* layer 1: neutrals */
  --bg:#f5f6f8;--card:#ffffff;--sunken:#eceef2;--line:#dde0e6;--line-strong:#868d9a;--muted:#5a606b;--text:#1b1e24;
  --paper:#fffdf6;--paper-ink:#2a2a2a;--paper-line:#d9d4c4;--paper-rule:#9a9484;
  --shadow:0 1px 2px rgba(20,30,60,.06),0 4px 14px rgba(20,30,60,.05);
  /* layer 2: accent (data-accent) */
  --a-l:#2159c9;--as-l:#e8effc;--a-d:#6aa4ff;--as-d:#1b2a47;
  --accent:var(--a-l);--accent-soft:var(--as-l);--accent-fg:#fff;--focus:var(--accent);
  /* layer 3: fixed state and category tokens */
  --attn-dot:#b86e00;--attn-fg:#7a4a00;--attn-soft:#fdf3dd;--attn-badge-fg:#1c1200;
  --ok-dot:#268f4b;--ok-fg:#17663a;--ok-soft:#e6f4ea;
  --c0:#2a78d6;--c1:#eb6834;--c2:#1baf7a;--c3:#eda100;--c4:#e87ba4;--c5:#008300;--c6:#6250d6;--c7:#e34948;
  --bar:var(--card);--pad:12px;--ctl:44px;
}
:root[data-accent="teal"]{--a-l:#0b7a75;--as-l:#e4f5f3;--a-d:#4fd1c5;--as-d:#12302e}
:root[data-accent="violet"]{--a-l:#6d3fd1;--as-l:#eee8fb;--a-d:#b79bff;--as-d:#271f45}
:root[data-accent="rose"]{--a-l:#c2255c;--as-l:#fce6ee;--a-d:#ff8fb1;--as-d:#401c2b}
:root[data-accent="graphite"]{--a-l:#3a4150;--as-l:#e9ebef;--a-d:#cdd3dd;--as-d:#2a2f39}
:root[data-theme="light"]{color-scheme:light}
@media (prefers-color-scheme:dark){
:root:not([data-theme="light"]){
  color-scheme:dark;
  --bg:#101216;--card:#181b21;--sunken:#20242c;--line:#2c313a;--line-strong:#6f7785;--muted:#a3a9b5;--text:#eceef1;
  --paper:#e6e1d3;--paper-line:#bdb7a6;--shadow:0 1px 2px rgba(0,0,0,.4);
  --accent:var(--a-d);--accent-soft:var(--as-d);--accent-fg:#0b1220;
  --attn-dot:#e0a030;--attn-fg:#f2c268;--attn-soft:#2b2313;--ok-dot:#4cc27a;--ok-fg:#8fd9a8;--ok-soft:#14271c;
  --c0:#3987e5;--c1:#d95926;--c2:#199e70;--c3:#c98500;--c4:#d55181;--c5:#008300;--c6:#9085e9;--c7:#e66767;
}
:root:not([data-theme="light"])[data-accent="graphite"]{--accent-fg:#12151a}
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#101216;--card:#181b21;--sunken:#20242c;--line:#2c313a;--line-strong:#6f7785;--muted:#a3a9b5;--text:#eceef1;
  --paper:#e6e1d3;--paper-line:#bdb7a6;--shadow:0 1px 2px rgba(0,0,0,.4);
  --accent:var(--a-d);--accent-soft:var(--as-d);--accent-fg:#0b1220;
  --attn-dot:#e0a030;--attn-fg:#f2c268;--attn-soft:#2b2313;--ok-dot:#4cc27a;--ok-fg:#8fd9a8;--ok-soft:#14271c;
  --c0:#3987e5;--c1:#d95926;--c2:#199e70;--c3:#c98500;--c4:#d55181;--c5:#008300;--c6:#9085e9;--c7:#e66767;
}
:root[data-theme="dark"][data-accent="graphite"]{--accent-fg:#12151a}

:root{--surface:var(--card);--fg:var(--text);--warn:var(--attn-fg);--warnbg:var(--attn-soft);--warnline:var(--attn-dot);--ok:var(--ok-fg);--okbg:var(--ok-soft);--neutral:var(--muted);--neutralbg:var(--sunken);--dry:var(--muted);--drybg:var(--sunken);--info:var(--accent);--infobg:var(--accent-soft);--bad:var(--attn-fg);--badbg:var(--attn-soft);--control:var(--line-strong);--s1:.25rem;--s2:.5rem;--s3:.75rem;--s4:1rem;--s5:1.5rem;--r:8px;--rs:6px;--fs:1rem;--fs-s:.875rem}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--fg);max-width:48rem;margin:0 auto;padding:var(--s4) var(--s4) 3rem}
h1{font-size:1.25rem;margin:0 0 var(--s2);font-weight:650}h2{font-size:1.1rem;margin:var(--s5) 0 var(--s2);font-weight:650}h3{font-size:1rem;margin:var(--s4) 0 var(--s1)}
p{margin:.5rem 0}
[id]{scroll-margin-top:1rem}
input[id^=s-],select[id^=s-],textarea[id^=s-]{scroll-margin-top:5rem}
.section-links{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0}.section-links .btn{margin:0;min-height:44px;padding:0 var(--s3);font-size:var(--fs-s)}
.review-reasons ul{margin:.25rem 0 .75rem;padding-left:1.25rem}
a{color:var(--accent)}
.muted{color:var(--muted)}.small{font-size:var(--fs-s)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:var(--rs)}
nav{display:flex;gap:0;flex-wrap:wrap;margin:0 calc(-1*var(--s4)) var(--s4);padding:0 var(--s2);border-bottom:1px solid var(--line)}
nav a{flex:0 0 auto;display:flex;align-items:center;min-height:44px;padding:0 .7rem;color:var(--muted);text-decoration:none;border-bottom:3px solid transparent;white-space:nowrap;font-weight:500}
nav a.on{color:var(--fg);border-bottom-color:var(--accent);font-weight:650}
button,.btn{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:var(--s2);min-height:44px;padding:0 var(--s4);border:1px solid transparent;border-radius:var(--r);background:var(--accent);color:var(--accent-fg);cursor:pointer;margin:var(--s2) 0;font-weight:600;text-decoration:none;line-height:1.2}
button.small{min-height:36px;padding:0 var(--s3);margin:0;font-size:var(--fs-s)}
button.plain,.btn.plain{background:var(--surface);color:var(--accent);border-color:var(--line-strong)}
button.danger{background:#b3261e;color:#fff}
button.link{background:none;border:0;min-height:36px;padding:0 var(--s2);margin:0;color:var(--muted);font-weight:500;text-decoration:underline;font-size:var(--fs-s)}
button:disabled,.btn[aria-busy=true]{opacity:.6;cursor:default;pointer-events:none}
@media (pointer:coarse){button.small,button.link,.todo summary,.cards thead th{min-height:44px}.cards thead th{display:inline-flex;align-items:center}}
input[type=text],input[type=date],input[type=password],input[type=number],select,textarea{font:inherit;font-size:16px;width:100%;min-height:44px;padding:.5rem .7rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--fg)}
textarea{min-height:6rem;resize:vertical}
label{display:block;margin:.7rem 0 .2rem;font-weight:600;font-size:.9rem}
input[type=checkbox]{width:1.25rem;height:1.25rem;flex:0 0 auto}
.notice{padding:var(--s2) var(--s3);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:var(--r);background:var(--surface);margin:0 0 var(--s3);font-size:.95rem}
.notice.err{border-left-color:#b3261e}.notice.warn{border-left-color:var(--warnline)}
.notice form{display:inline;margin-left:var(--s2)}.notice button{margin:0}
.banner{padding:var(--s3);border-radius:var(--r);border:1px solid var(--line);background:var(--surface);margin:var(--s2) 0;font-size:.95rem}
.banner.live{background:var(--warnbg);border-color:var(--line);color:var(--fg)}.actualbar{display:flex;gap:var(--s2) var(--s3);align-items:center;flex-wrap:wrap;margin:var(--s2) 0}.actualbar p,.actualbar form{margin:0}.banner.ok{background:var(--okbg);border-color:var(--line);color:var(--ok)}.banner b{display:block}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3);margin:var(--s3) 0}
.tag{display:inline-block;font-size:.75rem;padding:.05rem .5rem;border:1px solid var(--line);border-radius:4px;color:var(--muted)}
.tag.draft{color:var(--warn);border-color:var(--warnline)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:var(--s2);border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.8rem}
td form{margin:0}.check{display:flex;gap:var(--s2);align-items:flex-start;margin:var(--s3) 0}.check input{margin-top:.2rem}.check label{margin:0}
.row{display:flex;gap:var(--s2);flex-wrap:wrap}.row>*{flex:1 1 10rem}
[hidden]{display:none!important}
.tools{display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin:var(--s2) 0}.tools>input,.tools>select{flex:1 1 9rem;width:auto}
.tools label{display:flex;gap:var(--s2);align-items:center;margin:0;font-weight:400;flex:0 0 auto}
th.sortable{cursor:pointer;white-space:nowrap;user-select:none}
.photo{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:var(--r);margin:var(--s2) 0}
.pager{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin:var(--s2) 0}.pager .pos{flex:0 0 auto;white-space:nowrap}
.pager a.btn,.pager span.btn{min-height:44px;margin:0;padding:0 var(--s3);border:1px solid var(--line);background:var(--surface);color:var(--accent);white-space:nowrap}
.pager span.btn{color:var(--muted)}
.pager form{flex:1 1 14rem;display:flex;gap:var(--s2);align-items:center;margin:0}.pager form button{margin:0}
.resolution-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s3);margin-bottom:var(--s3)}
.charge-choices{list-style:none;padding:0}.charge-choices li{padding:var(--s3);border:1px solid var(--line);border-radius:var(--r);margin-bottom:var(--s2)}
@media(max-width:40rem){.resolution-fields{grid-template-columns:1fr}}
.receipt-grid{display:grid;gap:0 var(--s5);grid-template-columns:minmax(0,1fr)}
details.how{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:0 var(--s3);margin:var(--s3) 0}details.how summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center}
details.how dt{font-weight:600;margin-top:var(--s2)}details.how dd{margin:0 0 0 var(--s2)}details.how[open]{padding-bottom:var(--s3)}
tr:target{outline:2px solid var(--accent);outline-offset:-2px}
.settings-page{max-width:60rem;margin:0 auto}.settings-heading{font-size:1.7rem;margin:var(--s4) 0 var(--s2)}.settings-intro{max-width:42rem;margin:0 0 var(--s2)}
.settings-shortcuts{display:flex;flex-wrap:wrap;gap:0 var(--s4);margin:var(--s2) 0 var(--s4);padding:0;border:0}.settings-shortcuts a{min-height:44px;display:inline-flex;align-items:center;font-size:var(--fs-s)}
.settings-section-label{font-size:var(--fs-s);color:var(--muted);margin:var(--s5) 0 var(--s2);font-weight:650}
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s3);align-items:start}
.settings-card{min-width:0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:0 var(--s4)}
.settings-card>summary{cursor:pointer;min-height:76px;padding:var(--s3) 0;line-height:1.5;list-style-position:outside;margin-left:1rem}
.settings-card-title{font-weight:650}.settings-card-description{display:block;color:var(--muted);font-size:var(--fs-s);font-weight:400;margin-top:.2rem}
.settings-card form{margin:0;padding:0 0 var(--s4)}.settings-card[open]>summary{border-bottom:1px solid var(--line);margin-bottom:var(--s3)}
.settings-page .setting{border:0;padding:var(--s2) 0 var(--s4)}.settings-page .setting-hint{margin:var(--s1) 0}
.setting-options{margin:var(--s1) 0 0}.setting-options>summary{cursor:pointer;color:var(--muted);font-size:var(--fs-s);min-height:32px;line-height:32px}.setting-options[open]>summary{color:var(--fg)}.setting-options .help{padding-top:var(--s1)}
.settings-fieldset{min-width:0;border:0;padding:0;margin:var(--s4) 0}.settings-fieldset legend{font-weight:650;font-size:1.05rem;padding:0}.settings-fieldset+.settings-fieldset{border-top:1px solid var(--line);padding-top:var(--s4)}
.settings-save{display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap;padding-top:var(--s2);border-top:1px solid var(--line)}.settings-save button{margin:0}
.settings-page :target{scroll-margin-top:var(--s4)}.settings-page input:target,.settings-page select:target{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:42rem){.settings-grid{grid-template-columns:minmax(0,1fr)}.settings-card{padding:0 var(--s3)}.settings-save{align-items:flex-start;flex-direction:column}.setting-options>summary{min-height:44px;line-height:44px}}
.setting{border-top:1px solid var(--line);padding:var(--s2) 0 var(--s3)}.setting label{margin:.2rem 0}.setting .help{margin:.2rem 0}
.setting .check{margin:.2rem 0}.setting .check label{margin:0;font-weight:600}
.setting .actions{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
.nobtn{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.grouphead{display:flex;gap:var(--s2);align-items:center;justify-content:space-between;flex-wrap:wrap}.grouphead h2{margin:var(--s4) 0 var(--s1)}
input[type=text].amt{width:7rem;text-align:right}.added input[type=text].amt{text-align:left}.added select{width:100%;min-height:44px;font-size:16px;padding:.25rem .5rem;border:1px solid var(--line);border-radius:var(--rs);background:var(--surface);color:var(--fg)}
select.pick{font-size:16px;min-height:44px;max-width:100%;padding:.25rem .5rem;border:1px solid var(--line);border-radius:var(--rs);background:var(--surface);color:var(--fg)}
.pill{display:inline-block;font-size:.8rem;font-weight:650;line-height:1.3;padding:.15rem .6rem;border-radius:4px;background:var(--neutralbg);color:var(--neutral);white-space:nowrap}
.pill.s-ok{background:var(--okbg);color:var(--ok)}.pill.s-warn{background:var(--warnbg);color:var(--warn)}.pill.s-bad{background:var(--badbg);color:var(--bad)}.pill.s-info{background:var(--infobg);color:var(--info)}.pill.s-dry{background:var(--drybg);color:var(--dry)}
.statusbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3);margin:0 0 var(--s2)}
.statusbar .when{flex:1 1 12rem}
.chip{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .7rem;border-radius:4px;font-size:.9rem;background:var(--okbg);color:var(--ok)}
.chip.dry{background:var(--drybg);color:var(--dry)}
.chip b{font-weight:650}
.chip::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:currentColor}
.actions-bar{display:flex;gap:var(--s2);flex-wrap:wrap;margin:var(--s2) 0}.actions-bar form{margin:0;flex:1 1 9rem}.actions-bar button,.actions-bar .btn{width:100%;margin:0}
.actions-bar .btn input{display:none}
.hint{margin:var(--s1) 0 var(--s3)}
.modeform{display:inline;margin:0}
[data-upload-status]{margin:var(--s2) 0;overflow-wrap:anywhere;padding:var(--s2) var(--s3);border-radius:var(--r);background:var(--infobg);color:var(--info)}[data-upload-status]:empty{display:none}
input.filebtn{width:100%;font-size:16px;margin:var(--s1) 0 var(--s2)}
.js input.filebtn{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;margin:0}
.js input.filebtn:focus-visible+label{outline:3px solid var(--focus);outline-offset:2px}
html:not(.js) label.btn[for=receipt-files]{display:none}
.js [data-nojs]{display:none}
html:not(.js) .actions-bar form[data-upload]{flex-basis:100%}
form[data-upload] button[data-nojs]{margin:var(--s1) 0 0}
.status td:nth-child(3){white-space:nowrap}
.list .sub{color:var(--muted);font-size:.85rem}
.list .line{color:var(--muted);font-size:.85rem;margin-top:var(--s1)}
.list a.rowlink{font-weight:600;color:var(--accent);text-decoration:none;word-break:break-word}
.list a.rowlink:hover{text-decoration:underline}
.pagehead{margin:0 0 var(--s3)}.pagehead h2{margin:var(--s2) 0 var(--s1);word-break:break-word}.pagehead .meta{display:flex;gap:var(--s2) var(--s3);flex-wrap:wrap;align-items:center}
.todo{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3);margin:var(--s3) 0}.todo.live{background:var(--warnbg);border-color:var(--warnline)}
.todo p{margin:var(--s1) 0}.todo form{margin:var(--s2) 0 0}.todo .lead{font-weight:600}
.todo .acts{display:flex;gap:var(--s2);flex-wrap:wrap;margin:var(--s2) 0}.todo .acts form{margin:0}.todo .acts button{margin:0}
.todo details{margin-top:var(--s2)}.todo summary{cursor:pointer;color:var(--muted);min-height:36px;display:flex;align-items:center;font-size:var(--fs-s)}
@media (max-width:40rem){
body{padding-left:var(--s3);padding-right:var(--s3)}
nav{margin-left:calc(-1*var(--s3));margin-right:calc(-1*var(--s3))}nav a{min-height:44px}
.cards thead tr{display:flex;flex-wrap:wrap;gap:var(--s2);margin-bottom:var(--s2)}.cards thead th{border:1px solid var(--line);border-radius:4px;padding:.3rem .8rem;background:var(--surface)}.cards thead th:empty{display:none}.cards thead{display:none}.js .cards thead{display:block}
.cards,.cards tbody{display:block}
.cards tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s1) var(--s3);position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3);margin:0 0 var(--s2)}
.cards td{border:0;padding:0;min-width:0}
.cards tr>td:nth-child(1){grid-column:1}.cards tr>td:nth-child(3){grid-column:2;grid-row:1;text-align:right;color:var(--muted);font-size:.85rem;white-space:nowrap}
.cards tr>td:nth-child(2){grid-column:1/-1}
.cards tr>td[data-act]{grid-column:1/-1;position:relative;z-index:1}.cards tr>td[data-act]:empty{display:none}.cards .viewcell{display:none}
.cards a.rowlink::after{content:"";position:absolute;inset:0}
.cards tr>td[data-act] form{margin:var(--s1) 0 0}
.archived-cards tr>td[data-label]::before{content:attr(data-label) ": ";color:var(--muted)}
.archived-cards tbody tr{grid-template-columns:1fr 1fr}.archived-cards tr>td{grid-column:1/-1!important;grid-row:auto!important;text-align:left!important;color:var(--fg)!important;font-size:.9rem!important;white-space:normal!important}
.archived-cards tr>td:nth-child(1){font-weight:600}
.archived-cards tr>td:nth-child(1)::before{content:none}
.pager form{flex-basis:100%}
.items thead{display:none}.items,.items tbody{display:block}
.items tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 var(--s3);padding:var(--s2) 0;border-bottom:1px solid var(--line)}
.items td{border:0;padding:0}
.items td:nth-child(2){grid-column:1/-1;grid-row:2;font-size:.85rem}
.items td:nth-child(3){grid-column:2;grid-row:1;text-align:right;white-space:nowrap}
.items td:nth-child(4){grid-column:1/-1;grid-row:3;margin-top:var(--s1)}
.items select.pick{width:100%}
.added thead{display:none}.added,.added tbody{display:block}
.added tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--s1) var(--s2);padding:var(--s2) 0;border-bottom:1px solid var(--line)}
.added td{border:0;padding:0}
.added td:nth-child(1){grid-column:1/-1;grid-row:1}.added td:nth-child(2){grid-column:1;grid-row:2}.added td:nth-child(4){grid-column:2;grid-row:2}.added td:nth-child(3){grid-column:1/-1;grid-row:3}
.added input[type=text].amt{width:100%}
}
@media (min-width:64rem){body.wide{max-width:80rem}.receipt-grid{grid-template-columns:minmax(0,5fr) minmax(0,6fr);align-items:start}.receipt-photos{position:sticky;top:.5rem;max-height:none;overflow:auto}}
`;

/** The Content-Security-Policy for every page: only the one inline style and the one inline script (by hash), forms and fetch requests only to this server. */
const CSS = LEGACY_CSS + WORKSPACE_CSS;
export const CSP = `default-src 'none'; style-src ${hashOf(CSS)}; script-src ${hashOf(SCRIPT)}; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

// The name of each page for the browser tab and the page heading (a page can give its own: a receipt's store, a Settings section).
const PAGE_TITLES = { status: 'Inbox', archived: 'Archive', categories: 'Categories', keywords: 'Category rules', learned: 'Learned corrections', privacy: 'Privacy', settings: 'Settings' };

// The three top-level tabs. The categories, rules, learned and privacy pages live under Settings.
const TAB_OF = { status: 'status', archived: 'archived' };
const TAB_ICONS = {
  status: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  archived: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
};
const icon = (id) => `<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[id]}</svg>`;

// What the frame shows that the page itself does not know: how many receipts are in Review (the badge) and the setup problems (the list pane's alerts). trigger.js sets it around
// each render; the render is synchronous, so a request cannot see another request's value. null = unknown (no badge).
let frame = { reviewCount: null, setup: null, from: null };
export function withFrame(next, render) {
  const before = frame;
  frame = { reviewCount: null, setup: null, from: null, ...next };
  try { return render(); } finally { frame = before; }
}
/** What the frame in force carries: { reviewCount, setup: { alert, reloadError, settingsDamaged } }. */
export const currentFrame = () => frame;

/** The page frame: head, title, top navigation, optional notice. `active` is 'status' | 'archived' | 'categories' | 'keywords' | 'learned' | 'settings' | 'privacy'; the last four of those sit under the Settings tab. */
export function layout({ active, key, notice, body, undo, wide, noticeTone, reviewCount = frame.reviewCount, title = '', heading = '' }) {
  const k = `?key=${encodeURIComponent(key)}`;
  const tab = TAB_OF[active] ?? 'settings';
  const count = Number.isInteger(reviewCount) && reviewCount > 0 ? reviewCount : 0;
  const badge = `<span class="badge" data-review-badge${count ? '' : ' hidden'}><span data-count>${count || ''}</span><span class="sr-only"> to review</span></span>`;
  const link = (id, href, text, withIcon = false) => `<a data-navigate data-page="${id}" href="${href}${escape(k)}"${tab === id ? ' class="on" aria-current="page"' : ''}>${withIcon ? icon(id) : ''}${text}${id === 'status' ? badge : ''}</a>`;
  const tabs = (withIcon) => `${link('status', './', 'Inbox', withIcon)}${link('archived', 'archived', 'Archive', withIcon)}${link('settings', 'settings', 'Settings', withIcon)}`;
  const dry = config.dryRun;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(`${title || PAGE_TITLES[active] || 'Inbox'} · Receipts`)}</title><script>${SCRIPT}</script><style>${CSS}</style></head><body${wide ? ' class="wide"' : ''}>
<a class="skip-link" href="#app-main">Skip to content</a>
<header class="app-header"><a class="app-brand" data-navigate href="./${escape(k)}" title="Home" aria-label="Receipts, home">Receipts</a><nav class="app-tabs" aria-label="Main">${tabs(false)}</nav><div class="app-header-actions">
${actualAnchor('Actual &#8599;', '', 'header-actual')}<details class="header-add"><summary>+ Add receipt</summary><div class="header-menu header-upload"><form ${post('upload', key)} enctype="multipart/form-data" data-upload data-send="upload${escape(k)}&amp;defer=1" data-run="run${escape(k)}"><input class="filebtn" id="receipt-files" type="file" name="receipts" multiple required aria-label="Receipt photos or PDFs" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif"><label class="btn plain" for="receipt-files">Choose photos or PDFs</label><button class="plain" data-nojs>Send the chosen files</button></form><p>Up to 25 MB each · 20 files at a time.</p><p role="status" data-upload-status></p></div></details>
<a class="dry-chip" data-navigate data-dry-chip href="./${escape(k)}&amp;activity=1" title="The worker only logs what it would do. Nothing changes in Actual or Nextcloud."${dry ? '' : ' hidden'}>Dry run</a></div></header>
<main id="app-main" tabindex="-1" data-app-main data-active="${escape(active)}" data-tab="${tab}" data-review-count="${count}" data-dry="${dry ? 'true' : 'false'}" class="app-main${body.includes('workspace-shell') ? '' : ' standard-page'}"><h1 class="sr-only" tabindex="-1" data-page-heading>${escape(heading || title || PAGE_TITLES[active] || 'Inbox')}</h1>${noticeHtml(notice, undo, key, noticeTone)}${body}</main>
<nav class="tabs" aria-label="Main, bottom bar">${tabs(true)}</nav>
<dialog class="app-dialog" id="workspace-dialog" aria-labelledby="workspace-dialog-title"><div class="app-dialog-head"><h2 id="workspace-dialog-title"></h2><button type="button" class="small plain" data-dialog-close>Close</button></div><div class="app-dialog-body" id="workspace-dialog-body"></div></dialog>
</body></html>`;
}

/** The Undo button: a POST form carrying the signed fields exactly as they were handed out (route, then every field in order). Shared by the notice line and the receipt's Saved banner. */
export function undoForm(undo, key) {
  const fields = Object.entries(undo.fields).map(([n, v]) => hidden(n, v)).join('');
  return `<form ${post(undo.route, key)}>${fields}<button class="small plain">Undo</button></form>`;
}

/** The notice line; after a removal it carries an Undo button (a POST form with what is needed to put the item back). */
function noticeHtml(notice, undo, key, tone) {
  if (!notice) return '';
  const state = tone === 'err' ? ' err' : tone === 'warn' ? ' warn' : '';
  if (!undo) return `<p class="notice${state}"${state ? ' role="alert"' : ''}>${escape(notice)}</p>`;
  return `<div class="notice">${escape(notice)}${undoForm(undo, key)}</div>`;
}

// The forms on the Settings pages (and their Undo) keep where Done goes back to (`from`, cleaned by cleanFrom) in the address they post to, so it survives the redirect.
const FROM_ACTIONS = new Set(['settings-save', 'settings-reset', 'settings-reset-all', 'undo-settings', 'category-save', 'category-exclude', 'category-include', 'keyword-add', 'keyword-remove', 'lesson-forget', 'undo-keyword', 'undo-category', 'undo-lesson', 'undo-exclude']);
/** `&from=…` (escaped for an attribute) when the page in force was opened from somewhere, else ''. */
export const fromQuery = () => (frame.from ? `&amp;from=${escape(encodeURIComponent(frame.from.value))}` : '');
/** The attributes of a POST form to an action of this server, carrying the key. */
export const post = (action, key) => `method="post" action="${formAction(action, key)}${FROM_ACTIONS.has(action) ? fromQuery() : ''}"`;

/** A hidden form field. */
export const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;

/** A filter bar for the rows of #id: text box, optional dropdowns and checkboxes. Hidden until the script runs. */
export function toolbar(id, label, { selects = [], checks = [] } = {}) {
  const sels = selects.map((s) => `<select data-field="${escape(s.field)}" aria-label="${escape(s.label)}"><option value="">${escape(s.all)}</option>${s.values.map((v) => { const [val, text] = Array.isArray(v) ? v : [v, v]; return `<option value="${escape(val)}">${escape(text)}</option>`; }).join('')}</select>`).join('');
  const boxes = checks.map((c) => `<label><input type="checkbox" data-field="${escape(c.field)}"> ${escape(c.text)}</label>`).join('');
  return `<div class="tools" data-tools="${escape(id)}" hidden><input type="text" data-q placeholder="Filter ${escape(label)}" aria-label="Filter ${escape(label)}" autocomplete="off">${sels}${boxes}</div>`;
}
/** A sortable table (`cls`: extra classes, e.g. "cards" to show rows as cards on a phone). cols: ['Name', ['Added', 'date'], ''] (an empty title is not sortable). */
export function sortable(id, cols, rows, empty, cls = '') {
  const th = cols.map((c) => (Array.isArray(c) ? `<th data-type="${c[1]}"${c[2] ? ` data-key="${c[2]}"` : ''}>${c[0]}</th>` : `<th>${c}</th>`)).join('');
  return `<div class="scroll"><table id="${escape(id)}" data-sortable${cls ? ` class="${escape(cls)}"` : ''}><thead><tr>${th}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
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
export const archiveDir = () => folder(config.nextcloud.archive);
