// "Open in Actual" links. The base address is a setting (ACTUAL_LINK_URL, default: the worker's Actual address) and so is untrusted text:
// only http(s) is accepted, it is rebuilt from origin + path (no user info, query or fragment), and trailing slashes are dropped.
import { config, cleanLinkBase } from './config.js';

export { cleanLinkBase };
import { knownAccounts } from './known-accounts.js';

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Actual id of an account known by name (from the last check), only when exactly one account has that name and its id is a real id. */
export function accountIdOf(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) return '';
  const same = knownAccounts().filter((a) => a.name === wanted);
  return same.length === 1 && ACCOUNT_ID.test(String(same[0].id ?? '')) ? same[0].id : '';
}

/** The link target: the account's page when its id is known, else the base; '' (no link) when there is no usable base. */
export function actualUrl(accountName = '') {
  const base = cleanLinkBase(config.actual.linkURL);
  if (!base) return '';
  const id = accountIdOf(accountName);
  return id ? `${base}/accounts/${encodeURIComponent(id)}` : `${base}/`;
}

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** An <a> to Actual (new tab), or '' when there is no usable address. `inner` is HTML the caller has already escaped. */
export function actualAnchor(inner, accountName = '', cls = '') {
  const href = actualUrl(accountName);
  return href ? `<a${cls ? ` class="${esc(cls)}"` : ''} href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : '';
}
