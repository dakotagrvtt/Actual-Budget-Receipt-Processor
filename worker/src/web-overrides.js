// Reads data/web-settings.json, the settings changed on the status page's Settings tab:
//   { "values": { "POLL_SECONDS": "600", ... }, "changedAt": "2026-11-06T12:00:00.000Z" }
// Values are strings exactly as they would be written in .env. A key in this file wins over .env; a key not in it falls
// back to .env. This module imports nothing from config.js (config.js reads the file while it is being built).
import fs from 'node:fs';
import { SETTINGS_BY_KEY } from './web-settings-schema.js';

let lastWarning = '';

/**
 * The overrides as { values, changedAt, exists, damaged, ignored }.
 *  - no file: { values: {}, exists: false, damaged: null };
 *  - a usable file: values holds the known keys only; `ignored` lists the keys that are not on the Settings tab (never applied);
 *  - a file that can't be read or understood: values is {} (so .env is used) and `damaged` says why. It warns once per problem.
 */
export function readOverrides(file, warn = console.warn) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (err) {
    if (err.code === 'ENOENT') {
      lastWarning = '';
      return { values: {}, changedAt: null, exists: false, damaged: null, ignored: [] };
    }
    return damaged(file, `could not read it: ${err.message}`, warn);
  }
  try {
    const j = JSON.parse(text);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('it must be a JSON object');
    if (typeof j.values !== 'object' || j.values === null || Array.isArray(j.values)) throw new Error('"values" must be an object');
    const values = {};
    const ignored = [];
    for (const [key, value] of Object.entries(j.values)) {
      if (typeof value !== 'string') throw new Error(`the value of ${key} must be a string`);
      if (SETTINGS_BY_KEY.has(key)) values[key] = value;
      else ignored.push(key);
    }
    lastWarning = '';
    return { values, changedAt: typeof j.changedAt === 'string' ? j.changedAt : null, exists: true, damaged: null, ignored };
  } catch (err) {
    // A JSON error message quotes the start of the file, which may hold a password: say only that it is not JSON.
    return damaged(file, err instanceof SyntaxError ? 'it is not valid JSON' : err.message, warn);
  }
}

function damaged(file, why, warn) {
  const msg = `${file} is damaged (${why}); ignoring it and using .env until it is reset on the Settings tab`;
  if (msg !== lastWarning) {
    lastWarning = msg;
    warn(`${new Date().toISOString()} ${msg}`);
  }
  return { values: {}, changedAt: null, exists: true, damaged: why, ignored: [] };
}
