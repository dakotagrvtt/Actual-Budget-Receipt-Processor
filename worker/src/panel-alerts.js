// The setup-problem banners (paused worker, settings not reloaded, archiving off, photos leave this machine). They are plain cards at the
// top of the receipts list pane, on every view that has the pane. Pure: data in, HTML out.
import { config } from './config.js';
import { escape, when } from './panel-layout.js';

/** The setup-problem banner (alert.js): paused, or only the hosted decider refusing requests. */
export function alertBanner(alert) {
  if (!alert) return '';
  const refusing = alert.pausing === false;
  return `<div class="banner live"><b>${refusing ? 'The hosted decider is refusing requests' : 'The worker is paused'}</b>${escape(alert.message)}${alert.at ? ` <span class="muted small">(since ${escape(when(alert.at))})</span>` : ''}. ${refusing ? 'The affected items were marked unsure.' : 'Receipts wait in the inbox; none is marked as failed.'}</div>`;
}

/** Problems with the Settings tab's settings: the last reload failed (the earlier ones stay in use), or the file is damaged. */
export function settingsBanner({ reloadError, settingsDamaged }, key) {
  const link = `<a data-navigate href="settings?key=${escape(encodeURIComponent(key))}">Settings tab</a>`;
  return (reloadError ? `<div class="banner live"><b>The settings were not reloaded</b>${escape(reloadError)}. The worker is still using the earlier settings. Fix it on the ${link}, or in .env.</div>` : '')
    + (settingsDamaged ? `<div class="banner live"><b>The settings file is damaged</b>Settings saved on this page are ignored (.env is used) and nothing can be saved until it is reset on the ${link}.</div>` : '');
}

/** Shown while the Archive folder setting clashes with another folder: archiving is off, receipts are still processed. */
export function archiveBanner(key) {
  if (!config.archive.problem) return '';
  return `<div class="banner live"><b>Archiving is turned off</b>${escape(config.archive.problem)}. Receipts are still processed as usual. Fix the Archive folder on the <a data-navigate href="settings?key=${escape(encodeURIComponent(key))}&amp;section=connections">Settings tab</a> (Connections), or in .env.</div>`;
}

/** What a cloud reader means for privacy; empty for the local reader. */
export function readerBanner() {
  if (config.reader.provider !== 'remote') return '';
  return `<div class="banner live"><b>Receipt photos leave this machine</b>The reader is ${escape(config.llmName)}. Each photo is sent whole to ${escape(config.reader.host)}: store and address, date and time, everything you bought, prices, card digits, member numbers and sometimes names. Location data in the photo is removed first. The hosted decider's anonymizing does not apply to photos. The provider may keep requests for a while; check its current policy${/openrouter\.ai$/.test(config.reader.host) ? ' and your OpenRouter privacy settings (the request is forwarded to a third-party model provider)' : ''}. Each photo costs money.${config.decider.provider === 'remote' ? ' The name and place scan for the hosted decider also runs on this cloud reader (CLOUD_NAME_SCAN=true), so the raw receipt text goes to that provider before anonymizing.' : ''}</div>`;
}


/** All four banners for `setup` = { alert, reloadError, settingsDamaged } (what the status page and the page frame carry). */
export const railAlerts = (setup, key) => `${alertBanner(setup?.alert)}${settingsBanner(setup ?? {}, key)}${archiveBanner(key)}${readerBanner()}`;
