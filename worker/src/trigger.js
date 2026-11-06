// A small web page and webhook for checking the inbox on demand, instead of waiting for the next poll.
//   GET  /?key=TOKEN        status page with a "Check for receipts now" button (link it from an Actual note)
//   POST /run?key=TOKEN     webhook: check the inbox now (Nextcloud webhook, phone shortcut, curl)
// The key can also be sent as an "Authorization: Bearer TOKEN" or "X-Trigger-Key: TOKEN" header.
// Every request needs TRIGGER_TOKEN; without it set, the server doesn't start.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { config, log } from './config.js';
import { loadState, parseStateKey } from './state.js';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function keyOf(req, url) {
  const auth = req.headers.authorization ?? '';
  return url.searchParams.get('key') ?? req.headers['x-trigger-key'] ?? (auth.startsWith('Bearer ') ? auth.slice(7) : '');
}
function allowed(key) {
  const a = Buffer.from(String(key));
  const b = Buffer.from(config.trigger.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function statusPage(key, notice) {
  let heartbeat = 'not yet';
  let recent = [];
  try {
    heartbeat = new Date(await fs.readFile(config.heartbeatPath, 'utf8')).toLocaleString('en-US', { timeZone: config.trigger.timeZone });
  } catch { /* first start */ }
  try {
    const state = await loadState();
    recent = Object.entries(state)
      .filter(([k]) => parseStateKey(k).dry === config.dryRun)
      .map(([k, v]) => ({ file: parseStateKey(k).file.split('/').pop(), ...v }))
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
      .slice(0, 15);
  } catch { /* nothing processed yet */ }
  const rows = recent
    .map((r) => `<tr><td>${escape(r.file)}</td><td>${escape(r.done ? r.result : r.waiting ? `waiting for the bank charge (next check ${r.waiting.nextCheck ? new Date(r.waiting.nextCheck).toLocaleString('en-US', { timeZone: config.trigger.timeZone }) : 'soon'})` : r.applied ? 'applied, moving the file' : `retrying (${r.error ?? 'error'})`)}</td><td>${escape(r.at ? new Date(r.at).toLocaleString('en-US', { timeZone: config.trigger.timeZone }) : '')}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipts</title><style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--accent:#2f6fde}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f2f2f7;--muted:#98989d;--line:#3a3a3c;--accent:#5e9bff}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);max-width:44rem;margin:2rem auto;padding:0 16px}
h1{font-size:1.3rem;margin:0 0 .25rem}.muted{color:var(--muted)}
button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;margin:1rem 0}
.notice{padding:.5rem .75rem;border:1px solid var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--line)}
</style></head><body>
<h1>Receipts</h1>
<div class="muted">${config.dryRun ? 'Dry run: decisions are logged, nothing changes' : 'Live: writes to Actual and moves files in Nextcloud'} · last check ${escape(heartbeat)} · checks every ${Math.round(config.pollSeconds / 60)} min</div>
${notice ? `<p class="notice">${escape(notice)}</p>` : ''}
<form method="post" action="run?key=${encodeURIComponent(key)}"><button>Check for receipts now</button></form>
<table><tr><th>Receipt</th><th>Result</th><th>When</th></tr>${rows || '<tr><td colspan="3" class="muted">Nothing processed yet</td></tr>'}</table>
</body></html>`;
}

export function startTriggerServer(onTrigger) {
  if (!config.trigger.token) {
    log('trigger page off: set TRIGGER_TOKEN to enable it');
    return;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const key = keyOf(req, url);
      if (!allowed(key)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden\n');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        req.resume(); // ignore any webhook payload
        onTrigger(req.headers['user-agent']?.includes('Nextcloud') ? 'Nextcloud webhook' : 'trigger');
        // A browser form gets the page back; a webhook gets a short JSON answer.
        if ((req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(303, { Location: `./?key=${encodeURIComponent(key)}&started=1` }).end();
        } else {
          res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}\n');
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const notice = url.searchParams.get('started') ? 'Checking the inbox now. Refresh in a minute to see the results.' : '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(await statusPage(key, notice));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('error\n');
      log(`trigger page error: ${err.message}`);
    }
  });
  server.listen(8095, '0.0.0.0', () => log('trigger page listening on port 8095'));
}
