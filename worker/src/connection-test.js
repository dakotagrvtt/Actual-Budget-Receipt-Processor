// Tries new Connections settings before the Settings tab saves them, with a separate client of their own so the worker's
// own connections are never disturbed. Nextcloud: list the inbox over WebDAV. Actual: log in over HTTP the way the server's
// login endpoint works (POST <server>/account/login with {loginMethod:'password', password}, answered {status:'ok', data:{token}}; then /account/logout); the @actual-app/api
// init is a process-wide singleton the running check may be using, so it is not called here. Messages never contain a password.

// The webdav package is loaded only when a Nextcloud test runs (the tests of the pages never need it).
const TEST_TIMEOUT_MS = 15000;
const LOGOUT_TIMEOUT_MS = 3000;
export class ConnectionTestError extends Error {}

const ACTUAL_KEYS = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD'];
const NEXTCLOUD_KEYS = ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_APP_PASSWORD', 'RECEIPTS_INBOX'];

/** Remove a password from a message, in case an error text quotes it. */
const without = (text, ...secrets) => secrets.filter((s) => s && s.length >= 3).reduce((t, s) => t.split(s).join('***'), String(text));
const why = (err) => err?.cause?.code ?? err?.cause?.message ?? err?.code ?? err?.message ?? 'unknown error';

/** Sign the test session out again, so tests don't pile up sessions on the server. Best effort: errors are ignored. */
async function logout(serverURL, token, fetchFn) {
  try {
    await fetchFn(`${serverURL}/account/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
    });
  } catch { /* nothing to do */ }
}

/** Log in to the Actual server with the candidate address and password, the way @actual-app/api does. Throws ConnectionTestError. */
async function testActual({ serverURL, password }, { fetchFn = fetch } = {}) {
  let res;
  try {
    res = await fetchFn(`${serverURL}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginMethod: 'password', password }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ConnectionTestError(`Couldn't reach the Actual server at ${serverURL} (${without(why(err), password)}).`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch { /* not JSON: judged by the status below */ }
  const reply = body?.data && typeof body.data === 'object' ? body.data : body; // the server wraps the answer as { status, data }
  if (reply?.returnUrl) throw new ConnectionTestError('This server uses OpenID login, so the password can\'t be tested here.');
  if (res.ok && reply?.token) {
    await logout(serverURL, reply.token, fetchFn);
    return;
  }
  if (body?.reason === 'invalid-password' || (res.ok && body?.status === 'ok')) throw new ConnectionTestError('The Actual server refused that password.');
  if (res.status === 404) throw new ConnectionTestError(`${serverURL} answered, but it doesn't look like an Actual server (no login page there).`);
  throw new ConnectionTestError(`The Actual server at ${serverURL} answered HTTP ${res.status}${body?.reason ? ` (${String(body.reason).slice(0, 60)})` : ''}.`);
}

/** List the inbox with the candidate address, user and app password. Throws ConnectionTestError. */
async function testNextcloud({ url, user, password, inbox }, { createClientFn } = {}) {
  try {
    const make = createClientFn ?? (await import('webdav')).createClient;
    const client = make(`${url}/remote.php/dav/files/${encodeURIComponent(user)}`, { username: user, password });
    await client.getDirectoryContents(inbox, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.status === 401) throw new ConnectionTestError('Nextcloud refused that user name or app password.');
    if (err?.status === 404) throw new ConnectionTestError(`Nextcloud answered, but there is no folder ${inbox} for ${user} (or the address is not a Nextcloud).`);
    if (err?.status) throw new ConnectionTestError(`Nextcloud answered HTTP ${err.status} when listing ${inbox}.`);
    throw new ConnectionTestError(`Couldn't reach Nextcloud at ${url} (${without(why(err), password)}).`);
  }
}

/**
 * Test what the changed keys touch, using the candidate config (built with the new values). Resolves when everything passes;
 * otherwise throws a ConnectionTestError listing each failure. The sync ID has only its format checked (a UUID), by the schema.
 */
export async function testChanged(changedKeys, candidate, deps = {}) {
  const problems = [];
  if (changedKeys.some((k) => ACTUAL_KEYS.includes(k))) {
    await testActual(candidate.actual, deps).catch((e) => problems.push(e instanceof ConnectionTestError ? e.message : `Actual: ${without(e.message, candidate.actual.password)}`));
  }
  if (changedKeys.some((k) => NEXTCLOUD_KEYS.includes(k))) {
    await testNextcloud(candidate.nextcloud, deps).catch((e) => problems.push(e instanceof ConnectionTestError ? e.message : `Nextcloud: ${without(e.message, candidate.nextcloud.password)}`));
  }
  if (problems.length) throw new ConnectionTestError(problems.join(' '));
}
