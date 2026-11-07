// The dry run / live switch: data/settings.json (config.settingsPath).
//   {"dryRun": false, "changedAt": "2026-11-06T12:00:00.000Z", "changedBy": "status page"}     (changedBy: "status page" | "cli")
// The rule, in one place:
//  - no settings file: DRY_RUN from .env applies;
//  - a usable file (a JSON object whose "dryRun" is true or false): it is THE switch, and DRY_RUN in .env is ignored;
//  - a file that exists but is unusable (bad JSON, wrong type, a directory, unreadable, a dangling symlink): dry run.
// The worker's DRY_RUN is fixed when its container is created, while ./receipts reads the host's .env, so the two could
// disagree; that is why a file, once it exists, always decides. The `receipts` script follows the same rule.
import fs from 'node:fs';
import { config, log } from './config.js';
import { writeJsonAtomic } from './file-lock.js';

let lastWarning = '';

/** The settings file as { dryRun, changedAt, changedBy }; null when it does not exist (lstat says ENOENT).
 *  A file that exists but is unusable comes back as { unusable: reason, dryRun: true, ... }: it fails closed to dry run
 *  and warns once per problem. A dangling symlink exists, so it is unusable, not missing. */
export function readSettings(file = config.settingsPath, warn = log) {
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return unusable(file, `could not look at it: ${err.message}`, warn);
  }
  let text;
  try {
    // Strict UTF-8 (a bad byte is an error, a BOM is kept and so fails the JSON parse), the same as the bash side.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch (err) {
    return unusable(file, `could not read it: ${err.message}`, warn);
  }
  try {
    const j = JSON.parse(text);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('it must be a JSON object');
    if (typeof j.dryRun !== 'boolean') throw new Error('"dryRun" must be true or false');
    lastWarning = '';
    return { dryRun: j.dryRun, changedAt: j.changedAt ?? null, changedBy: j.changedBy ?? null };
  } catch (err) {
    return unusable(file, err.message, warn);
  }
}
function unusable(file, why, warn) {
  problem(`${file} is not usable (${why}); staying in DRY RUN until it is fixed or deleted`, warn);
  return { unusable: why, dryRun: true, changedAt: null, changedBy: null };
}
function problem(msg, warn) {
  if (msg === lastWarning) return; // the file is re-read every cycle; say it once
  lastWarning = msg;
  warn(msg);
}

/** The mode in force. source: 'env' (no file) | 'settings' (a usable file) | 'unusable' (dry run). */
export function resolveDryRun(envDefault = config.envDryRun, file = config.settingsPath, warn = log) {
  const s = readSettings(file, warn);
  if (!s) return { dryRun: envDefault, source: 'env', settings: null };
  if (s.unusable) return { dryRun: true, source: 'unusable', settings: s };
  return { dryRun: s.dryRun, source: 'settings', settings: s };
}

const word = (dry) => (dry ? 'dry run' : 'live');

/** A clear sentence when a usable settings file says something other than DRY_RUN in .env (which is then ignored); else null. */
export function envDisagreement(resolved = resolveDryRun(), envDefault = config.envDryRun) {
  if (resolved.source !== 'settings' || resolved.dryRun === envDefault) return null;
  const to = resolved.dryRun ? 'live' : 'dry';
  return `DRY_RUN in .env (${envDefault}) is ignored; the switch on the status page (data/settings.json) says ${word(resolved.dryRun)}. Use the page or ./receipts mode ${to === 'live' ? 'live to go live' : 'dry to stop'}.`;
}

let lastEnvNote = '';

/** Re-read the mode into config.dryRun. Call only between cycles, never mid-cycle. Logs when it changes. */
export function refreshMode() {
  const resolved = resolveDryRun();
  const { dryRun, settings, source } = resolved;
  if (dryRun !== config.dryRun) {
    log(`mode changed: ${word(config.dryRun)} -> ${word(dryRun)}${modeReason(source, settings)}`);
    config.dryRun = dryRun;
  }
  const note = envDisagreement(resolved) ?? '';
  if (note !== lastEnvNote) {
    lastEnvNote = note;
    if (note) log(note);
  }
  return config.dryRun;
}

function modeReason(source, settings) {
  if (source === 'settings') return ` (set by ${settings.changedBy ?? 'unknown'}${settings.changedAt ? ` at ${settings.changedAt}` : ''})`;
  if (source === 'unusable') return ' (settings file is unusable; staying in dry run)';
  return ' (settings file removed; back to DRY_RUN in .env)';
}

/** True when this worker is live but the switch now says dry run: stop before the next receipt (switching to live
 *  only applies at the start of a cycle). An unusable file counts as dry run. */
export function mustStopForDry(resolved = resolveDryRun()) {
  return !config.dryRun && resolved.dryRun;
}

/** Save the mode atomically. changedBy: 'status page' or 'cli'. */
export async function writeSettings({ dryRun, changedBy }, file = config.settingsPath) {
  const settings = { dryRun: Boolean(dryRun), changedAt: new Date().toISOString(), changedBy };
  await writeJsonAtomic(file, settings);
  return settings;
}
