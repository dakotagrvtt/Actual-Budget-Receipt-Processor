// The Settings tab page: every setting from web-settings-schema.js as a form, one per section, plus Advanced and Reset.
import { escape, layout, post, when, formAction } from './panel-layout.js';

const SOURCE_TEXT = { page: 'this page', env: '.env', default: 'default' };

/** One setting's input, by type. A secret is never given a value: only "set" or "not set". */
function settingInput(s) {
  const id = `s-${s.key}`;
  const name = `name="${escape(s.key)}" id="${id}"`;
  switch (s.type) {
    case 'bool': {
      const on = ['true', '1', 'yes', 'on'].includes(String(s.value).trim().toLowerCase());
      return `<div class="check"><input type="hidden" name="${escape(s.key)}" value="false"><input type="checkbox" ${name} value="true"${on ? ' checked' : ''}><label for="${id}">${escape(s.label)}</label></div>`;
    }
    case 'enum': {
      const cur = String(s.value).trim().toLowerCase();
      return `<label for="${id}">${escape(s.label)}</label><select ${name}>${s.values.includes(cur) ? '' : '<option value="" selected>(not valid: pick one)</option>'}${s.values.map((v) => `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(v)}</option>`).join('')}</select>`;
    }
    case 'secret':
      return `<label for="${id}">${escape(s.label)}</label><input type="password" ${name} value="" autocomplete="new-password" placeholder="${s.isSet ? 'Set. Leave empty to keep it' : 'Not set'}">`;
    case 'number':
      return `<label for="${id}">${escape(s.label)}</label><input type="text" inputmode="${s.int ? 'numeric' : 'decimal'}" ${name} value="${escape(s.value)}" aria-describedby="h-${s.key}">`;
    default:
      return `<label for="${id}">${escape(s.label)}</label><input type="text" ${name} value="${escape(s.value)}" maxlength="500" autocomplete="off"${s.type === 'url' ? ' inputmode="url"' : ''}>`;
  }
}

function rangeText(s) {
  if (s.type === 'number') return ` Between ${s.min} and ${s.max}.`;
  return '';
}

/** data: from settingsData() */
export function settingsPage(data, key, notice, undo) {
  const reset = (s) => (s.source === 'page'
    ? `<button class="small plain" name="reset" value="${escape(s.key)}" formaction="${formAction('settings-reset', key)}" formnovalidate>Use the .env value</button>`
    : '');
  const rowsOf = (list) => list.map((s) => `<div class="setting">
${settingInput(s)}
<div class="muted small help" id="h-${escape(s.key)}">${escape(s.help)}${escape(rangeText(s))}${s.type === 'secret' ? '' : s.default !== '' ? ` Default: ${escape(s.default)}.` : ''}</div>
<div class="actions"><span class="tag${s.source === 'page' ? ' draft' : ''}">from ${escape(SOURCE_TEXT[s.source])}</span>${s.type === 'secret' ? `<span class="tag">${s.isSet ? 'set' : 'not set'}</span>` : ''}${reset(s)}</div>
</div>`).join('');
  // Main settings: one form per section (a section with only advanced settings has none). Each form sends only its own fields.
  const sections = data.sections.filter((sec) => sec.settings.some((s) => !s.advanced)).map((sec) => {
    const anyway = sec.id === 'connections'
      ? '<div class="check"><input type="checkbox" name="anyway" value="yes" id="anyway"><label for="anyway">Save even if the connection test fails</label></div><p class="muted small">Before a change to an address, user, password or the inbox is saved, it is tried: Actual by logging in, Nextcloud by listing the inbox. The sync ID is only checked for its form.</p>'
      : '';
    return `<form ${post('settings-save', key)}>
<button class="nobtn" tabindex="-1" aria-hidden="true">Save</button>
<h2>${escape(sec.title)}</h2>
${rowsOf(sec.settings.filter((s) => !s.advanced))}
${anyway}<input type="hidden" name="section" value="${escape(sec.id)}">
<button>Save ${escape(sec.title.toLowerCase())}</button>
</form>`;
  }).join('\n');
  // Advanced: one form of its own inside a <details>. Closed unless one of its settings is set on this page or the notice is about one.
  const advSections = data.sections.map((sec) => ({ ...sec, settings: sec.settings.filter((s) => s.advanced) })).filter((sec) => sec.settings.length);
  const advAll = advSections.flatMap((sec) => sec.settings);
  const openAdvanced = advAll.some((s) => s.source === 'page' || (notice && [`${s.label}:`, s.key].some((w) => String(notice).includes(w))));
  const advanced = advAll.length
    ? `<details class="how" id="advanced"${openAdvanced ? ' open' : ''}><summary>Advanced settings</summary>
<p class="muted small">Tuning that most people never need. The defaults work well; change one only if you know why.</p>
<form ${post('settings-save', key)}>
<button class="nobtn" tabindex="-1" aria-hidden="true">Save</button>
${advSections.map((sec) => `<h3>${escape(sec.title)}</h3>\n${rowsOf(sec.settings)}`).join('\n')}
<input type="hidden" name="section" value="advanced">
<button>Save advanced settings</button>
</form></details>`
    : '';
  const damaged = data.damaged ? `<div class="banner live"><b>The settings file is damaged</b>data/web-settings.json can't be read (${escape(data.damaged)}). It is ignored and .env is used. Nothing can be saved on this page until it is reset.<form ${post('settings-reset-all', key)}><button class="danger">Reset all to .env</button></form></div>` : '';
  const reloadError = data.reloadError ? `<div class="banner live"><b>The last settings reload failed</b>${escape(data.reloadError)}. The worker is still using the earlier settings.</div>` : '';
  const resetAll = data.exists && !data.damaged
    ? `<h2>Reset</h2><form ${post('settings-reset-all', key)}><div class="check"><input type="checkbox" name="confirm" value="yes" id="confirm-reset" required><label for="confirm-reset">Put every setting on this page back to its .env value</label></div><button class="plain">Reset all to .env</button></form>`
    : '';
  const body = `${damaged}${reloadError}<p class="muted">Change settings without editing .env. A value saved here wins over .env; "Use the .env value" goes back. Saved changes apply at the start of the next check (press "Check for receipts now" on the Status tab to do it right away).${data.changedAt ? ` Last saved ${escape(when(data.changedAt))}.` : ''}</p>
${data.ignored?.length ? `<p class="muted small">Ignored in the file (not settings of this page): ${escape(data.ignored.join(', '))}.</p>` : ''}
${sections}
${advanced}
${resetAll}
<p class="muted small">Set in .env only (then ./receipts restart): TRIGGER_TOKEN, TRIGGER_BIND, DRY_RUN (the Status tab has its own switch), ACTUAL_API_VERSION, the models, GPU and provider settings, API keys, CLOUD_NAME_SCAN, PRIVATE_WORDS, PRIVATE_PLACES, the calendar settings and every file path.</p>`;
  return layout({ active: 'settings', key, notice, body, undo });
}
