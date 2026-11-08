// The Privacy tab (shown with the hosted decider): what is sent, the names and places that are hidden, and what the scan found.
import { config } from './config.js';
import { escape, layout, post, toolbar, sortable } from './panel-layout.js';

/** Who runs the name and place scan, for the Privacy page: the cloud reader when there is one. */
const scanWhere = () => (config.reader.provider === 'remote' ? `the cloud reader (${escape(config.reader.host)}, CLOUD_NAME_SCAN=true; the raw text is sent to it)` : 'the reader model on this machine');

/** What the remote decider does and does not get; the first thing the Privacy page says. */
const PRIVACY_EXPLAINER = `The categorizer runs on TypeSafe's hosted model. It is sent the item lines, the store name, amounts and how your past purchases were filed, with category names replaced by codes (C01, C02...), dates turned into "12 days before this purchase", and the names below replaced by Person A, Person B... A store name is only ever the name of an Actual payee (never the bank's raw text, and never a transfer to one of your accounts), with long digit runs removed; where there is no such payee, no store name is sent. It never gets the receipt photo, card digits, payment method, addresses, the printed date or calendar event names. Places that could show where you live or shop (a city, state, street address or ZIP code) are replaced by "a city", "a state", "a street" or "a place" (ZIP codes are dropped). A business name such as "Papa John's" stays readable only where it appears in full; the same word anywhere else is still hidden. An item that fails the final privacy check is not sent and is marked unsure.`;

/** data: { words, found: [{ word, firstSeen }], notNames, placeWords, places: [{ word, type, firstSeen }], notPlaces } */
export function privacyPage({ words, found, notNames, placeWords = [], places = [], notPlaces = [] }, key, notice, undo) {
  const wordForm = (action, word, label) => `<form ${post(action, key)}><input type="hidden" name="word" value="${escape(word)}"><button class="small plain">${label}</button></form>`;
  const list = (id, label, cols, rows, empty) => `${toolbar(id, label)}${sortable(id, cols, rows, empty)}`;
  const wordRows = words.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-word-remove', w, 'Remove')}</td></tr>`).join('');
  const foundRows = found.map((f) => `<tr data-row><td>${escape(f.word)}</td><td class="small">${escape(f.firstSeen)}</td><td data-act>${wordForm('privacy-notname-add', f.word, 'Not a name')}</td></tr>`).join('');
  const notRows = notNames.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-notname-remove', w, 'Remove')}</td></tr>`).join('');
  const placeRows = placeWords.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-place-remove', w, 'Remove')}</td></tr>`).join('');
  const foundPlaceRows = places.map((f) => `<tr data-row><td>${escape(f.word)}</td><td class="small">${escape(f.type)}</td><td class="small">${escape(f.firstSeen)}</td><td data-act>${wordForm('privacy-notplace-add', f.word, 'Not a place')}</td></tr>`).join('');
  const notPlaceRows = notPlaces.map((w) => `<tr data-row><td>${escape(w)}</td><td data-act>${wordForm('privacy-notplace-remove', w, 'Remove')}</td></tr>`).join('');
  const body = `<p class="muted">${PRIVACY_EXPLAINER}</p>
<h2>Names to hide</h2>
<p class="muted small">Every word here is replaced in anything sent: first names, nicknames, pet names. Whole words only, any capitals, "Alex's" too.</p>
${list('p-words', 'names', ['Word', ''], wordRows, 'None yet')}
<form ${post('privacy-word-add', key)}>
<label for="word">Add a name</label><input type="text" id="word" name="word" maxlength="40" required placeholder="Alex">
<button>Add</button>
</form>
<h2>Names the scan found</h2>
<p class="muted small">Before a receipt is sent, ${scanWhere()} looks through the text for people's names. These were found and are hidden too. If one is not a name (a product, a brand), press "Not a name".</p>
${list('p-found', 'found names', ['Word', ['First seen', 'date'], ''], foundRows, 'Nothing found yet')}
<h2>Places to hide</h2>
<p class="muted small">Your town, street or ZIP code. Every one listed here is replaced by "a place" in anything sent. Whole words or phrases, any capitals.</p>
${list('p-places', 'places', ['Place', ''], placeRows, 'None yet')}
<form ${post('privacy-place-add', key)}>
<label for="place">Add a place</label><input type="text" id="place" name="word" maxlength="40" required placeholder="Springfield">
<button>Add</button>
</form>
<h2>Places the scan found</h2>
<p class="muted small">${scanWhere().replace(/^./, (c) => c.toUpperCase())} also looks for places. These were found and are replaced too. If one is not a place, press "Not a place".</p>
${list('p-foundplaces', 'found places', ['Place', 'Kind', ['First seen', 'date'], ''], foundPlaceRows, 'Nothing found yet')}
<h2>Not a place</h2>
<p class="muted small">Words the scan may flag but that are not places (for example a person called Lincoln). They are sent as they are.</p>
${list('p-notplaces', 'words', ['Word', ''], notPlaceRows, 'None')}
<h2>Not a name</h2>
<p class="muted small">Words the scan may flag but that are not people. They are sent as they are.</p>
${list('p-notnames', 'words', ['Word', ''], notRows, 'None')}`;
  return layout({ active: 'privacy', key, notice, body, undo });
}
