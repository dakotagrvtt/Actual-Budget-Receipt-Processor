// The Settings tab: an overview of section cards, and one page per section with its existing save form(s). Every one of the 54 settings is
// on exactly one section page, in exactly one save form.
import { config } from './config.js';
import { actualAnchor } from './actual-link.js';
import { escape, layout, post, when, formAction, currentFrame, fromQuery } from './panel-layout.js';
import { cleanNav, navQuery } from './panel-status.js';

/** One setting's input, by type. A secret is never given a value: only "set" or "not set". */
function settingInput(s, invalid = false) {
  const id = `s-${s.key}`;
  const name = `name="${escape(s.key)}" id="${id}"${invalid ? ' aria-invalid="true"' : ''}${s.type !== 'number' ? ` aria-describedby="h-${escape(s.key)}"` : ''}`;
  switch (s.type) {
    case 'bool': {
      const on = ['true', '1', 'yes', 'on'].includes(String(s.value).trim().toLowerCase());
      return `<div class="check"><input type="hidden" name="${escape(s.key)}" value="false"><input type="checkbox" ${name} value="true"${on ? ' checked' : ''}><label for="${id}">${escape(s.label)}</label></div>`;
    }
    case 'enum': {
      const cur = String(s.value).trim().toLowerCase();
      return `<label for="${id}">${escape(s.label)}</label><select ${name}>${s.values.includes(cur) ? '' : '<option value="" selected>(not valid: pick one)</option>'}${s.values.map((v) => `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(({ on: 'Learn and use', record: 'Learn only', off: 'Off' })[v] ?? v)}</option>`).join('')}</select>`;
    }
    case 'account': {
      const opts = [...new Set([...(s.choices ?? []), ...(s.value ? [s.value] : [])])];
      return `<label for="${id}">${escape(s.label)}</label><select ${name}${s.key === 'CASH_ACCOUNT' ? ' data-settings-autofocus' : ''}><option value=""${s.value ? '' : ' selected'}>(not set)</option>${opts.map((o) => `<option value="${escape(o)}"${o === s.value ? ' selected' : ''}>${escape(o)}${(s.choices ?? []).includes(o) ? '' : ' (not in the list from the last check)'}</option>`).join('')}</select>`;
    }
    case 'secret':
      return `<label for="${id}">${escape(s.label)}</label><input type="password" ${name} value="" autocomplete="new-password" placeholder="${s.isSet ? 'Set. Leave empty to keep it' : 'Not set'}">`;
    case 'number':
      return `<label for="${id}">${escape(s.label)}</label><input type="text" inputmode="${s.int ? 'numeric' : 'decimal'}" ${name} value="${escape(s.value)}" aria-describedby="h-${s.key}">`;
    default:
      return `<label for="${id}">${escape(s.label)}</label><input type="text" ${name} value="${escape(s.value)}" maxlength="500" autocomplete="off"${s.type === 'url' ? ' inputmode="url"' : ''}>`;
  }
}

const SUMMARIES = {
  matching: 'Cash account, bank accounts and splitting purchases.',
  behaviour: 'Check frequency and the time zone shown in the app.',
  categorizing: 'Choose how uncertain purchases are handled.',
  holidays: 'Holiday context and restaurant purchases that need review.',
  connections: 'Actual, Nextcloud and the folders chosen during setup.',
  keywords: 'How keywords and past corrections guide categorization.',
};
const SHORT_HELP = {
  ACTUAL_LINK_URL: 'Leave blank to use the Actual server address.',
  CASH_ACCOUNT: 'Used when you create a cash purchase from a receipt.',
  MATCH_ACCOUNTS: 'Leave blank to search all open budget accounts.',
  OVERWRITE_CATEGORIZED: 'Allow a clear receipt to change a category set by an Actual rule.',
  SPLIT_TRANSACTIONS: 'Put items in separate categories within the same charge.',
  SPLIT_MIN_AMOUNT: 'Fold smaller parts into the main category.',
  APPLY_THEN_REVIEW: 'Apply confident items while uncertain items wait for review.',
  POLL_SECONDS: 'Check now in Activity can always start a check sooner.',
  TRIGGER_TIMEZONE: 'Used for the dates and times displayed in the app.',
  OCCASIONS: 'Help recognize gifts around US holidays.',
  GIFT_MEAL_MIN: 'Use 0 to turn this review rule off.',
  ARCHIVE_AFTER_DAYS: '0 means archive only when you choose.',
};
const ADVANCED_TITLES = {
  matching: 'Matching charges', categorizing: 'Review decisions', behaviour: 'Photos and archive',
  holidays: 'Holidays and gift meals', keywords: 'Keywords and learning',
};
const noticeNames = (settings, notice) => Boolean(notice && settings.some((s) => [`${s.label}:`, s.key].some((word) => String(notice).includes(word))));

// ---- Sections: the overview links to one page per save group (settings?section=<id>). The ids are the values of the save forms'
// `section` field, so a save, a reset and their Undo come back to the same page (trigger.js, whitelisted with settingsSection). ----
export const SETTINGS_SECTIONS = ['everyday', 'preferences', 'connections', 'appearance', 'advanced'];
const SECTION_TITLES = { everyday: 'Everyday', preferences: 'Matching and review', connections: 'Connections', appearance: 'Appearance', advanced: 'Advanced' };
const SECTION_SUMMARIES = {
  everyday: 'Cash purchases, splitting, archiving and learning.',
  preferences: 'How charges are matched, how purchases are categorized and when a receipt needs review.',
  connections: 'Actual, Nextcloud and the receipt folders.',
  appearance: 'Theme and accent color on this device.',
  advanced: 'Fine-tuning, resetting saved settings, and what can only be set in .env.',
};
/** A section id from a query or form, or '' when it is not one of SETTINGS_SECTIONS. */
export const settingsSection = (value) => (SETTINGS_SECTIONS.includes(String(value ?? '')) ? String(value) : '');
const TOP_KEYS = ['CASH_ACCOUNT', 'SPLIT_TRANSACTIONS', 'ARCHIVE_AFTER_DAYS', 'LEARNING'];
/** The section page that holds a setting (the same split as the save forms). */
export const sectionOfSetting = (s) => (TOP_KEYS.includes(s.key) ? 'everyday' : s.advanced ? 'advanced' : s.section === 'connections' ? 'connections' : 'preferences');
/**
 * Where Done on a Settings page goes back to, from the `from` query: { value, to, qs } or null. Only three fixed pages are accepted (the list,
 * the Archive, a receipt), reached only by a relative address; the receipt id is length-checked and the filter and sort cleaned, so no other
 * address (another site, `//host`, a script) can come out of it. `value` is the clean text to carry on; `to` + `?key=…` + `qs` the link.
 */
export function cleanFrom(raw) {
  const text = String(raw ?? '');
  if (!text || text.length > 2300 || /[\\\u0000-\u001f]/.test(text) || text.startsWith('//')) return null;
  let u;
  try { u = new URL(text, 'http://from.invalid/'); } catch { return null; }
  if (u.origin !== 'http://from.invalid') return null;
  const to = { '/': './', '/archived': 'archived', '/receipt': 'receipt' }[u.pathname];
  if (!to) return null;
  const id = u.searchParams.get('id') ?? '';
  if (to === 'receipt' && (!id || id.length > 2000)) return null;
  const qs = `${to === 'receipt' ? `&id=${encodeURIComponent(id)}` : ''}${navQuery(cleanNav(u.searchParams))}${to === './' && u.searchParams.get('activity') === '1' ? '&activity=1' : ''}`;
  return { to, qs, value: `${to}${qs ? `?${qs.slice(1)}` : ''}` };
}
/** The Done link of a Settings page: back to where Settings was opened from (the list when unknown). */
const DONE_NAMES = { './': 'Inbox', archived: 'Archive', receipt: 'the receipt' };
/** `overview`: the Settings overview, where the tab bar already leads back, so Done shows only when Settings was opened from a receipt. */
const doneLink = (key, overview = false) => {
  const from = currentFrame().from;
  if (overview && from?.to !== 'receipt') return '';
  return `<p class="settings-done"><a class="btn plain" data-navigate data-settings-done href="${from ? escape(`${from.to}?key=${encodeURIComponent(key)}${from.qs}`) : `./?key=${escape(encodeURIComponent(key))}`}">Done · back to ${DONE_NAMES[from?.to] ?? 'Inbox'}</a></p>`;
};
/** A page that sits under Settings (Categories, Category rules, Learned corrections, Privacy): "← Settings", its title, the page, Done. */
export const underSettings = (key, title, body) => `<div class="settings-page"><a class="settings-back" data-navigate href="settings?key=${escape(encodeURIComponent(key))}${fromQuery()}">&larr; Settings</a><h2 class="settings-heading">${escape(title)}</h2>${body}${doneLink(key)}</div>`;
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

/**
 * The Settings tab. Without a section: the overview, a card with a chevron per section (and the Categories, Category rules, Learned and,
 * with the hosted decider, Privacy pages). With `opts.section`: that section's page, "← Settings", its existing save form(s) and Done.
 * A notice that names a setting (a refused save) shows the page of that setting, with the field marked; a failed connection test shows
 * Connections. Each save stays scoped to its own group; nothing about the forms, their fields or their labels changes here.
 */
export function settingsPage(data, key, notice, undo, opts = {}) {
  const k = escape(encodeURIComponent(key));
  // Enter submits Save even when a field's reset button precedes the visible Save button.
  const defaultSave = `<button class="nobtn" tabindex="-1" aria-hidden="true"${data.damaged ? ' disabled' : ''}>Save</button>`;
  const invalid = !undo && data.sections.flatMap((sec) => sec.settings).find((s) => noticeNames([s], notice));
  const connectionError = !undo && !invalid && /nothing was saved|could(?:n't| not) (?:reach|log)|connection test failed/i.test(String(notice ?? ''));
  const section = invalid ? sectionOfSetting(invalid) : connectionError ? 'connections' : settingsSection(opts.section);
  const reset = (s) => s.source === 'page' ? `<button class="small plain" name="reset" value="${escape(s.key)}" formaction="${formAction('settings-reset', key)}" formnovalidate${data.damaged ? ' disabled' : ''}>Use setup value</button>` : '';
  const rowsOf = (list) => list.map((s) => `<div class="setting${['text', 'url', 'secret', 'folder', 'list'].includes(s.type) ? ' wide' : ''}" data-setting="${escape(s.key)}">
${settingInput(s, invalid?.key === s.key)}
${SHORT_HELP[s.key] ? `<p class="muted small setting-hint">${escape(SHORT_HELP[s.key])}</p>` : ''}
<details class="setting-options"><summary aria-label="Help and options for ${escape(s.label)}">Help and options</summary>
<div class="muted small help" id="h-${escape(s.key)}">${escape(s.help ?? '')}${s.type === 'number' ? ` Between ${escape(s.min)} and ${escape(s.max)}.` : ''}${s.type !== 'secret' && s.default !== '' ? ` Default: ${escape(s.default)}.` : ''}</div>
<p class="muted small">${s.source === 'page' ? 'Saved on this page.' : s.source === 'env' ? 'Using the value chosen during setup.' : 'Using the built-in default.'}${s.type === 'secret' ? ` Password ${s.isSet ? 'saved' : 'not set'}.` : ''}</p>${reset(s)}
</details></div>`).join('');
  const groupsOf = (sec, settings) => {
    if (sec.id !== 'connections') return rowsOf(settings);
    const buckets = [ ['Actual Budget', (s) => s.key.startsWith('ACTUAL_')], ['Nextcloud', (s) => s.key.startsWith('NEXTCLOUD_')], ['Receipt folders', (s) => s.key.startsWith('RECEIPTS_')] ];
    const assigned = new Set();
    return buckets.map(([title, wants]) => { const selected = settings.filter(wants); selected.forEach((s) => assigned.add(s.key)); return selected.length ? `<fieldset class="settings-fieldset"><legend>${title}</legend>${title === 'Actual Budget' ? (actualAnchor('Open Actual &#8599;', '', 'actual-link') ? `<p class="small connection-actual">${actualAnchor('Open Actual &#8599;', '', 'actual-link')}</p>` : '') : ''}${title === 'Receipt folders' ? '<p class="muted small">The app manages these folders after setup.</p>' : ''}${rowsOf(selected)}</fieldset>` : ''; }).join('') + rowsOf(settings.filter((s) => !assigned.has(s.key)));
  };
  const saveRow = (label) => `<div class="settings-save"><button${data.damaged ? ' disabled' : ''}>${escape(label)}</button><span class="muted small">Applies at the next check.</span></div>`;
  // An advanced group is a card that opens by itself for a refused save of one of its settings. Connections is its own page (no card).
  const panel = (sec, settings, advanced = false) => {
    const id = advanced ? `settings-advanced-${sec.id}` : `settings-${sec.id}`;
    const anyway = sec.id === 'connections' && !advanced ? '<details class="setting-options connection-options"><summary>Connection test options</summary><p class="muted small">Connection changes are tested before saving. The sync ID is checked for its format.</p><div class="check"><input type="checkbox" name="anyway" value="yes" id="anyway"><label for="anyway">Save even if the connection test fails</label></div></details>' : '';
    const form = `<form ${post('settings-save', key)} aria-label="${escape(advanced ? `${sec.title} advanced settings` : sec.title)}">
${defaultSave}
${groupsOf(sec, settings)}${anyway}<input type="hidden" name="section" value="${advanced ? 'advanced' : escape(sec.id)}">${saveRow(`Save ${sec.title.toLowerCase()}`)}
</form>`;
    if (!advanced) return `<section class="settings-card settings-panel" id="${escape(id)}" aria-label="${escape(sec.title)}">${SUMMARIES[sec.id] ? `<p class="settings-card-description">${escape(SUMMARIES[sec.id])}</p>` : ''}${form}</section>`;
    return `<details class="settings-card" id="${escape(id)}"${noticeNames(settings, notice) ? ' open' : ''}><summary><span class="settings-card-title">${escape(sec.title)}</span></summary>
${form}</details>`;
  };
  const all = data.sections.flatMap((sec) => sec.settings);
  const top = TOP_KEYS.map((key_) => all.find((s) => s.key === key_)).filter(Boolean);
  const remaining = data.sections.map((sec) => ({ ...sec, settings: sec.settings.filter((s) => !TOP_KEYS.includes(s.key)) }));
  const main = remaining.filter((sec) => sec.id !== 'connections' && sec.settings.some((s) => !s.advanced));
  const connections = remaining.find((sec) => sec.id === 'connections');
  const advSections = remaining.map((sec) => ({ ...sec, settings: sec.settings.filter((s) => s.advanced) })).filter((sec) => sec.settings.length);
  const damaged = data.damaged ? `<div class="banner live"><b>The settings file is damaged</b>The saved settings could not be read (${escape(data.damaged)}). Setup values are in use. Saving is unavailable until this is reset.<form ${post('settings-reset-all', key)}><button class="danger">Reset all to setup values</button></form></div>` : '';
  const reloadError = data.reloadError ? `<div class="banner live"><b>The last settings reload failed</b>${escape(data.reloadError)}. The worker is still using the earlier settings.</div>` : '';
  const goTo = invalid ? `<p class="small"><a href="#s-${escape(invalid.key)}">Go to ${escape(invalid.label)}</a></p>` : connectionError ? '<p class="small"><a href="#settings-connections">Go to connections</a></p>' : '';
  const done = doneLink(key, !section);
  const fq = fromQuery();
  const frame = (inner) => layout({ active: 'settings', title: section ? SECTION_TITLES[section] : 'Settings', key, notice, body: `<div id="settings-page" class="settings-page"${section ? ` data-settings-section="${section}"` : ''}>${inner}</div>`, undo, noticeTone: invalid || connectionError ? 'err' : undefined });

  if (!section) {
    const card = (href, title, text) => `<li><a class="settings-link" data-navigate href="${href}"><span class="settings-link-text"><span class="settings-card-title">${escape(title)}</span><span class="settings-card-description">${escape(text)}</span></span>${CHEVRON}</a></li>`;
    const pageOf = (id) => `settings?key=${k}&amp;section=${id}${fq}`;
    const cards = [
      card(pageOf('everyday'), SECTION_TITLES.everyday, SECTION_SUMMARIES.everyday),
      main.length ? card(pageOf('preferences'), SECTION_TITLES.preferences, SECTION_SUMMARIES.preferences) : '',
      card(`categories?key=${k}${fq}`, 'Categories', 'Descriptions, and categories receipts must never use.'),
      card(`keywords?key=${k}${fq}`, 'Category rules', 'Keywords and payee aliases that choose a category.'),
      card(`learned?key=${k}${fq}`, 'Learned corrections', 'What the worker learned from your corrections.'),
      config.decider.provider === 'remote' ? card(`privacy?key=${k}${fq}`, 'Privacy', 'Names and places kept out of what the hosted decider sees.') : '',
      connections ? card(pageOf('connections'), SECTION_TITLES.connections, connections.settings.some((s) => !s.advanced && s.required && !(s.type === 'secret' ? s.isSet : s.value)) ? 'A required connection setting is missing. Open to set it.' : SECTION_SUMMARIES.connections) : '',
      card(pageOf('appearance'), SECTION_TITLES.appearance, SECTION_SUMMARIES.appearance),
      card(pageOf('advanced'), SECTION_TITLES.advanced, SECTION_SUMMARIES.advanced),
    ].join('');
    return frame(`${damaged}${reloadError}<h2 class="settings-heading">Settings</h2><p class="muted">Choose a section. Each one saves on its own.</p><ul class="settings-cards">${cards}</ul>${done}`);
  }

  const everyday = `<section class="settings-everyday"><form ${post('settings-save', key)} aria-label="Everyday settings">${defaultSave}${rowsOf(top)}<input type="hidden" name="section" value="everyday">${saveRow('Save settings')}</form></section>`;
  const preferences = main.length ? `<section class="settings-card settings-panel" id="settings-preferences" aria-label="Matching and review"><form ${post('settings-save', key)} aria-label="Matching and review">${defaultSave}${main.map((sec) => `<section id="settings-${escape(sec.id)}" aria-label="${escape(sec.title)}">${rowsOf(sec.settings.filter((s) => !s.advanced))}</section>`).join('')}<input type="hidden" name="section" value="preferences">${saveRow('Save preferences')}</form></section>` : '';
  const advanced = advSections.length ? `<section class="settings-advanced" id="advanced" aria-label="Advanced settings"><div class="settings-grid">${advSections.map((sec) => panel({ ...sec, title: ADVANCED_TITLES[sec.id] ?? sec.title }, sec.settings, true)).join('')}</div></section>` : '';
  const resetAll = data.exists && !data.damaged ? `<details class="how" id="settings-reset"><summary>Reset saved settings</summary><p class="muted small">Remove the changes saved here and return to your setup values. This does not change receipts or transactions.</p><form ${post('settings-reset-all', key)}><div class="check"><input type="checkbox" name="confirm" value="yes" id="confirm-reset" required><label for="confirm-reset">Reset every setting saved on this page</label></div><input type="hidden" name="section" value="advanced"><button class="danger">Reset all to setup values</button></form></details>` : '';
  const about = `<details class="how"><summary>About settings and setup</summary><p class="muted small">Values saved here take priority over setup values. Changes apply at the next check.${data.changedAt ? ` Last saved ${escape(when(data.changedAt))}.` : ''}</p><p class="muted small">Help and options beside a setting lets you return to its setup value.</p><p class="muted small">Set in .env only (then ./receipts restart): TRIGGER_TOKEN, TRIGGER_BIND, DRY_RUN (use the test mode switch in Activity), ACTUAL_API_VERSION, models, GPU and provider settings, API keys, CLOUD_NAME_SCAN, PRIVATE_WORDS, PRIVATE_PLACES, calendar settings and file paths.</p>${data.ignored?.length ? `<p class="muted small">Ignored settings in the saved file: ${escape(data.ignored.join(', '))}.</p>` : ''}</details>`;
  // Appearance is a per-device choice kept in the browser (panel-script.js). The buttons have no name and no form: they are never posted.
  const choice = (pref, value, text, swatch = '') => `<button type="button" class="pref-choice" data-pref="${pref}" data-value="${value}" aria-pressed="${value === 'system' || value === 'blue' ? 'true' : 'false'}">${swatch ? `<span class="swatch swatch-${swatch}" aria-hidden="true"></span>` : ''}${text}</button>`;
  const appearance = `<section class="settings-appearance" aria-label="Appearance"><div class="field"><span id="appearance-theme">Theme</span><div class="pref-options" role="group" aria-labelledby="appearance-theme">${choice('theme', 'system', 'System')}${choice('theme', 'light', 'Light')}${choice('theme', 'dark', 'Dark')}</div></div><div class="field"><span id="appearance-accent">Accent</span><div class="pref-options" role="group" aria-labelledby="appearance-accent">${[['blue', 'Blue'], ['teal', 'Teal'], ['violet', 'Violet'], ['rose', 'Rose'], ['graphite', 'Graphite']].map(([id, name]) => choice('accent', id, name, id)).join('')}</div></div><p class="muted">Saved on this device</p></section>`;
  const content = {
    appearance,
    everyday,
    preferences: preferences || '<p class="muted">Nothing to set here.</p>',
    connections: connections ? panel({ ...connections, title: 'Connections' }, connections.settings.filter((s) => !s.advanced)) : '<p class="muted">Nothing to set here.</p>',
    advanced: `${advanced}${resetAll}${about}`,
  }[section];
  return frame(`<a class="settings-back" data-navigate href="settings?key=${k}${fq}">&larr; Settings</a>${damaged}${reloadError}${goTo}<h2 class="settings-heading">${escape(SECTION_TITLES[section])}</h2>${content}${done}`);
}
