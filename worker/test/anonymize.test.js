// anonymize.js: pseudonyms, scrubbing, leak checks and the request built for the hosted decider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteRequest, decodeAnswer, describeLeaks, dropKnownNames, findLeaks, makeCodes, makeScrubber, onlyWordsFrom, pseudonym, pseudonymEntries, relativeDay, anonymizeOccasion } from '../src/anonymize.js';

const LABELS = ['Daily Expenses / Groceries', 'Daily Expenses / Sam', 'Fun / Gifts'];
const same = (text) => text;

test('pseudonym: Person A..Z, then AA, AB', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 52].map(pseudonym), ['Person A', 'Person B', 'Person Z', 'Person AA', 'Person AB', 'Person BA']);
});

test('makeScrubber: whole words, any case, possessives kept, stable pseudonyms', () => {
  const scrub = makeScrubber(pseudonymEntries(['Alex', 'Mary Ann'], ['alex', 'mary ann']));
  assert.equal(scrub("Alex's DC charger for ALEX"), "Person A's DC charger for Person A");
  assert.equal(scrub('alex’s bike'), 'Person A’s bike'); // curly apostrophe
  assert.equal(scrub('gift for mary  ann and Alex.'), 'gift for Person B and Person A.');
  assert.equal(scrub('ALEXA speaker, Alexander'), 'ALEXA speaker, Alexander'); // inside longer words: untouched
  assert.equal(scrub('2Alex'), '2Person A'); // a digit is not a letter: it does not hide the name
  assert.equal(scrub('Alex-Mary Ann'), 'Person A-Person B');
});

test('pseudonymEntries: the persisted order decides the letter, so removing a word never shifts the others', () => {
  const order = ['alex', 'jo', 'sam']; // alex was removed from the list later
  const entries = pseudonymEntries(['Sam', 'Jo'], order);
  assert.deepEqual(entries.map((e) => [e.word, e.pseudo]), [['Sam', 'Person C'], ['Jo', 'Person B']]);
});

test('makeScrubber: nothing to hide leaves the text as it is', () => {
  assert.equal(makeScrubber([])("Alex's"), "Alex's");
});

test('dropKnownNames: notNames are respected; initials dropped; a business name excuses nothing', () => {
  const opts = { notNames: ['Dove'] };
  assert.deepEqual(dropKnownNames(['Wendy', 'Jo', 'dove', 'J'], opts), ['Wendy', 'Jo']);
  assert.deepEqual(dropKnownNames(['J DOE'], opts), ['DOE']);
  assert.deepEqual(dropKnownNames(['Jo', 'JO', 'jo'], {}), ['Jo']);
});

test('makeScrubber: a digit next to a name does not hide it (MEMBER ALEX2, 4ALEX GIFT, ALEX_SMITH) and the leak check sees it too', () => {
  const entries = pseudonymEntries(['Alex'], ['alex']);
  const scrub = makeScrubber(entries);
  for (const [text, want] of [['MEMBER ALEX2', 'MEMBER Person A2'], ['4ALEX GIFT', '4Person A GIFT'], ['ALEX_SMITH', 'Person A_SMITH'], ['ALEXA', 'ALEXA']]) {
    assert.equal(scrub(text), want);
  }
  // the raw texts are leaks for the check, the scrubbed ones are not
  for (const raw of ['MEMBER ALEX2', '4ALEX GIFT', 'ALEX_SMITH']) {
    assert.equal(findLeaks({ s: raw }, { labels: [], words: ['Alex'] }).length, 1, raw);
    assert.equal(findLeaks({ s: scrub(raw) }, { labels: [], words: ['Alex'] }).length, 0, raw);
  }
});

test('makeScrubber and findLeaks: José typed as e + accent or as one character is the same word (NFKC)', () => {
  const nfc = 'Jos\u00e9';
  const nfd = 'Jose\u0301';
  for (const [listed, typed] of [[nfc, nfd], [nfd, nfc]]) {
    const scrub = makeScrubber(pseudonymEntries([listed], [listed.normalize('NFKC').toLowerCase()]));
    const out = scrub(`GIFT FOR ${typed.toUpperCase()}`);
    assert.equal(out, 'GIFT FOR Person A');
    assert.equal(findLeaks({ s: `GIFT FOR ${typed}` }, { labels: [], words: [listed] }).length, 1);
    assert.equal(findLeaks({ s: out }, { labels: [], words: [listed] }).length, 0);
  }
});

test('makeScrubber: a business name is protected only where it appears in full; every other occurrence of the word is scrubbed', () => {
  const entries = pseudonymEntries(['John'], ['john']);
  const scrub = makeScrubber(entries, { protect: ["Papa John's", 'Sam’s Club'] });
  assert.equal(scrub("PAPA JOHN'S PIZZA FOR JOHN"), "PAPA JOHN'S PIZZA FOR Person A");
  assert.equal(scrub('papa john’s, john, Papa Johns'), 'papa john’s, Person A, Papa Johns'); // curly apostrophe is the same span; "Johns" is another word
  assert.equal(scrub('JOHN AT PAPA JOHN'), 'Person A AT PAPA Person A'); // not the full name
  assert.equal(scrub('XPAPA JOHN\'S'), "XPAPA Person A'S"); // glued to a letter: not the span
  // the private-use placeholder characters cannot be smuggled in
  const smuggled = scrub("\uE0000\uE001 JOHN \uE0001\uE001 PAPA JOHN'S");
  assert.ok(!smuggled.includes('Person A\uE001') && /Person A/.test(smuggled) && smuggled.endsWith("PAPA JOHN'S"), smuggled);
  assert.equal(findLeaks({ s: "PAPA JOHN'S PIZZA" }, { labels: [], words: ['John'], protect: ["Papa John's"] }).length, 0);
  assert.equal(findLeaks({ s: "PAPA JOHN'S PIZZA FOR JOHN" }, { labels: [], words: ['John'], protect: ["Papa John's"] }).length, 1);
});

test('makeCodes: choices C01.., other labels X01.., answers decode only to choices', () => {
  const codes = makeCodes(LABELS);
  assert.equal(codes.code(LABELS[1]), 'C02');
  assert.equal(codes.code('Bills / Rent'), 'X01');
  assert.equal(codes.code('Bills / Rent'), 'X01');
  assert.equal(codes.code(null), null);
  assert.equal(codes.label('C03'), 'Fun / Gifts');
  assert.equal(codes.label('X01'), undefined); // not a choice
  assert.equal(codes.label('C99'), undefined);
});

test('relativeDay: before, after, same day, no date', () => {
  assert.equal(relativeDay('2026-10-14', '2026-10-26'), '12 days before this purchase');
  assert.equal(relativeDay('2026-10-25', '2026-10-26'), '1 day before this purchase');
  assert.equal(relativeDay('2026-10-26', '2026-10-26'), 'the same day as this purchase');
  assert.equal(relativeDay('2026-10-28', '2026-10-26'), '2 days after this purchase');
  assert.equal(relativeDay(null, '2026-10-26'), null);
});

test('anonymizeOccasion: only a built-in holiday keeps its name; a birthday, a calendar event or a spoofed source loses it', () => {
  const when = '3 day(s) after the purchase';
  assert.equal(anonymizeOccasion({ name: "Father's Day", builtin: true, when }), "Father's Day (US holiday), 3 day(s) after this purchase");
  assert.equal(anonymizeOccasion({ name: "Mom's birthday", builtin: false, source: 'Contact birthdays', when }), 'a birthday or personal occasion, 3 day(s) after this purchase');
  // a calendar that calls itself "US holiday" (or an event named like a holiday) is still not the built-in list
  assert.equal(anonymizeOccasion({ name: 'Christmas at Grandma Rose', builtin: false, source: 'US holiday', when }), 'a birthday or personal occasion, 3 day(s) after this purchase');
  // plain strings carry no trustworthy source: never a name
  assert.equal(anonymizeOccasion("Father's Day (US holiday) on 2026-06-21, 3 day(s) after the purchase"), 'a birthday or personal occasion, 3 day(s) after this purchase');
  assert.equal(anonymizeOccasion('weird'), 'an occasion near this purchase');
});

const input = (extra = {}) => ({
  labels: LABELS,
  receipt: {
    store: 'POS 4242 TARGET 1234 SPRINGFIELD IL', payee: 'Target', merchant: 'Target', date: '2026-10-26', total: 10.5,
    // fields that must never get into a request
    store_clues: ['123 Main St'], card_last4: '4242', payment_method: 'visa', cash_tendered: 20, date_as_printed: '10/26/26',
    items: [{ description: 'MED-GUM', amount: 2 }, { description: 'MILK', plain: 'whole milk', amount: 3.5 }],
  },
  index: 0,
  history: [{ date: '2026-10-14', amount: 20, parts: [{ category: LABELS[0], amount: 15, notes: 'milk' }, { category: 'Bills / Rent', amount: 5 }] }],
  itemHistory: [
    { items: 'whole milk', category: LABELS[0], store: 'Target', payee: 'Target', date: '2026-09-01' },
    { items: 'gum', category: LABELS[1], store: null, date: '2026-08-01' },
  ],
  realPayees: ['Target'],
  known: { ruleLabel: LABELS[0], currentLabel: LABELS[2], occasions: ["Mom's birthday (Contact birthdays) on 2026-10-29, 3 day(s) after the purchase"] },
  hint: { phrase: 'gum', category: LABELS[1] },
  notes: { [LABELS[1]]: "Sam's clothes" },
  similar: true,
  instructions: 'Which category?',
  model: 'jev-latest',
  today: '2026-11-06',
  ...extra,
});

test('buildRemoteRequest: the pipeline\'s unchecked picks are labeled, never tallied, the same as on the local path', () => {
  const { body } = buildRemoteRequest(input({
    history: [
      { date: '2026-10-14', amount: 20, by: 'household', parts: [{ category: LABELS[0], amount: 15, notes: 'milk', by: 'household' }, { category: LABELS[1], amount: 5, by: 'pipeline' }] },
      { date: '2026-10-10', amount: 9, by: 'pipeline', parts: [{ category: LABELS[2], amount: 9, notes: null, by: 'pipeline' }] },
    ],
    itemHistory: [
      { items: 'gum yours', category: LABELS[1], store: null, date: '2026-08-01', by: 'household' },
      { items: 'gum pipeline', category: LABELS[2], store: null, date: '2026-08-02', by: 'pipeline' },
    ],
  }), same);
  const s = body.state;
  assert.deepEqual(s.past_purchases_at_this_store, [{ when: '12 days before this purchase', amount: 20, filed_as: ['C01 15 (milk)', 'C02 5 [filed by pipeline, unchecked]'] }]);
  assert.deepEqual(s.past_purchases_filed_by_the_pipeline_unchecked, [{ when: '16 days before this purchase', amount: 9, filed_as: ['C03 9'] }]);
  const gum = s.similar_items_filed_before.find((x) => x.items === 'gum pipeline');
  assert.equal(gum.filed_by, 'pipeline, unchecked');
  assert.equal('filed_by' in s.similar_items_filed_before.find((x) => x.items === 'gum yours'), false);
  assert.deepEqual(s.similar_items_by_category, { C02: 1 }); // the pipeline's C03 is not counted
  assert.deepEqual(s.items_this_household_filed_before.C03, ['gum pipeline [filed by pipeline, unchecked]']);
  assert.deepEqual(s.items_this_household_filed_before.C02, ['gum yours']);
});

test('buildRemoteRequest: every label occurrence becomes a code, in choices and everywhere in the state', () => {
  const { body, codes } = buildRemoteRequest(input(), same);
  const text = JSON.stringify(body);
  for (const l of [...LABELS, 'Bills / Rent']) assert.ok(!text.includes(l), `${l} leaked`);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions.category.criteria), ['C01', 'C02', 'C03']);
  assert.equal(body.questions.category.criteria.C02, "Sam: Sam's clothes");
  assert.equal(body.questions.category.criteria.C01, 'The "Groceries" budget category (group: Daily Expenses)');
  const s = body.state;
  assert.equal(s.category_your_rules_give_this_store, 'C01');
  assert.equal(s.current_category_of_the_bank_transaction, 'C03');
  assert.deepEqual(s.past_purchases_at_this_store, [{ when: '12 days before this purchase', amount: 20, filed_as: ['C01 15 (milk)', 'X01 5'] }]);
  assert.deepEqual(Object.keys(s.items_this_household_filed_before).sort(), ['C01', 'C02']);
  assert.deepEqual(s.items_this_household_filed_before.C01, ['whole milk (at Target)']);
  assert.deepEqual(s.household_keyword, { phrase: 'gum', category: 'C02' });
  assert.ok(s.similar_items_filed_before.every((x) => /^C0\d$/.test(x.filed_as)));
  assert.deepEqual(Object.keys(s.similar_items_by_category).every((k) => /^C0\d$/.test(k)), true);
  assert.equal(s.item, 'GUM');
  assert.deepEqual(s.other_items_on_receipt, ['MILK (whole milk)']);
  assert.deepEqual(s.birthdays_and_holidays_near_this_date, ['a birthday or personal occasion, 3 day(s) after this purchase']);
  assert.equal(codes.label('C02'), LABELS[1]);
});

test('buildRemoteRequest: amount rules are not sent (they are a threshold, not evidence about the items)', () => {
  const amountRules = [{ upTo: 11, category: LABELS[1] }, { over: 11, category: LABELS[0] }, { over: 50, category: 'Bills / Rent' }];
  const { body } = buildRemoteRequest(input({ known: { ruleLabel: LABELS[0], amountRules } }), same);
  assert.equal('your_rules_by_charge_amount_at_this_store' in body.state, false);
  assert.ok(!JSON.stringify(body).includes('Bills / Rent'));
  assert.equal(body.state.category_your_rules_give_this_store, 'C01');
});

test('buildRemoteRequest: store clues, card digits, payment, cash, the printed date and the purchase date are never sent', () => {
  const text = JSON.stringify(buildRemoteRequest(input(), same).body);
  for (const secret of ['123 Main St', '4242', 'visa', '10/26/26', 'store_clues', 'card_last4', 'payment_method', 'cash_tendered', 'date_as_printed', '2026-10-26', '2026-10-14', '2026-09-01']) {
    assert.ok(!text.includes(secret), `${secret} was sent`);
  }
  assert.deepEqual(Object.keys(buildRemoteRequest(input(), same).body.state).sort(), [
    'birthdays_and_holidays_near_this_date', 'category_your_rules_give_this_store', 'current_category_of_the_bank_transaction', 'household_keyword', 'item', 'item_price',
    'items_this_household_filed_before', 'other_items_on_receipt', 'past_purchases_at_this_store', 'similar_items_by_category', 'similar_items_filed_before', 'store', 'total',
  ]);
});

test('buildRemoteRequest: every free text goes through scrub with its kind (so what is scanned is what is sent)', () => {
  const seen = [];
  buildRemoteRequest(input(), (text, kind) => (seen.push([kind, text]), text));
  const kinds = new Set(seen.map(([k]) => k));
  for (const k of ['item', 'note', 'category', 'keyword', 'similar', 'store']) assert.ok(kinds.has(k), k);
  assert.ok(seen.some(([k, t]) => k === 'category' && t.startsWith('Sam:')));
  assert.ok(seen.some(([k, t]) => k === 'note' && t === 'milk'));
});

test('decodeAnswer: choice and probabilities go back to labels; unknown codes stay or drop', () => {
  const { codes } = buildRemoteRequest(input(), same);
  const out = decodeAnswer({ choice: 'C03', confidence: 0.7, probabilities: { C01: 0.1, C02: 0.2, C03: 0.7, C77: 0 } }, codes);
  assert.deepEqual(out, { choice: 'Fun / Gifts', confidence: 0.7, probabilities: { [LABELS[0]]: 0.1, [LABELS[1]]: 0.2, [LABELS[2]]: 0.7 } });
  assert.equal(decodeAnswer({ choice: 'C99', confidence: 1 }, codes).choice, 'C99');
  assert.equal(decodeAnswer(undefined, codes), undefined);
});

test('findLeaks: a label or a listed word anywhere is found; the path names the field, never the value', () => {
  const body = { state: { item: 'gift for Alex', notes: ['fine', 'moved to Daily Expenses / Sam'], 'Alex': 1 }, questions: {} };
  const leaks = findLeaks(body, { labels: LABELS, words: ['Alex'] });
  assert.deepEqual(leaks, [{ path: 'state.item', kind: 'listed word' }, { path: 'state.notes[1]', kind: 'category label' }, { path: 'state (a key)', kind: 'listed word' }]);
  assert.ok(!JSON.stringify(leaks).includes('gift for'));
  assert.deepEqual(findLeaks({ state: { item: 'ALEXA, alexander, Person A' } }, { labels: LABELS, words: ['Alex'] }), []);
  assert.deepEqual(findLeaks({ state: { item: "ALEX'S" } }, { labels: [], words: ['alex'] }), [{ path: 'state.item', kind: 'listed word' }]);
  // a word the scan found is told apart from one you listed; the description never has a value in it
  const two = findLeaks({ a: 'for Jo', b: 'for Alex' }, { labels: [], words: ['Alex', 'Jo'], found: ['Jo'] });
  assert.equal(describeLeaks(two), 'a (found name), b (listed word)');
});

test('store: only an Actual payee name is sent, never the bank text; digit runs are stripped; a transfer payee is not a store', () => {
  const sent = (extra) => buildRemoteRequest(input(extra), same).body.state;
  // the payee entity name, with digit runs of 3+ taken out (a 2-digit store number stays)
  assert.equal(sent({ receipt: { ...input().receipt, payee: 'Target 1234 Springfield 62704' }, realPayees: ['Target 1234 Springfield 62704'] }).store, 'Target Springfield');
  assert.equal(sent({ receipt: { ...input().receipt, payee: 'Shop 24' }, realPayees: ['Shop 24'] }).store, 'Shop 24');
  // the raw bank text in receipt.store is never used, and no payee means no store
  assert.equal(sent({ receipt: { ...input().receipt, payee: null } }).store, null);
  assert.ok(!JSON.stringify(buildRemoteRequest(input(), same).body).includes('POS 4242'));
  // a payee that is not a real (non-transfer) Actual payee, e.g. "Alex's Checking", is not sent
  assert.equal(sent({ receipt: { ...input().receipt, payee: "Alex's Checking" } }).store, null);
});

test('store: history stores go out only as their payee; raw bank text and unknown payees never do', () => {
  const itemHistory = [
    { items: 'concert tickets', category: LABELS[2], store: 'Zelle to Jordan Smith', date: '2026-09-01' }, // bank text only
    { items: 'tickets again', category: LABELS[2], store: 'Transfer: Alex', payee: "Alex's Checking", date: '2026-09-02' }, // transfer payee
    { items: 'whole milk', category: LABELS[0], store: 'Target 5521', payee: 'Target', date: '2026-09-03' },
  ];
  const { body } = buildRemoteRequest(input({ itemHistory, hint: null }), same);
  const text = JSON.stringify(body);
  for (const secret of ['Zelle', 'Jordan', 'Transfer', "Alex's Checking", '5521']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(body.state.items_this_household_filed_before.C03, ['tickets again', 'concert tickets']);
  assert.deepEqual(body.state.items_this_household_filed_before.C01, ['whole milk (at Target)']);
  assert.ok(body.state.similar_items_filed_before.every((x) => x.store === null || x.store === 'Target'));
});

test('a full category label written in free text becomes its code (notes, descriptions, items) instead of blocking the request', () => {
  const notes = { 'Fun / Gifts': 'presents; food goes to Daily Expenses / Groceries, rent to bills / RENT' };
  const everyLabel = [...LABELS, 'Bills / Rent'];
  const receipt = { ...input().receipt, items: [{ description: 'MILK for fun / gifts', amount: 1 }] };
  const { body, codes } = buildRemoteRequest(input({ notes, receipt, allLabels: everyLabel }), same);
  assert.equal(body.questions.category.criteria.C03, 'Gifts: presents; food goes to C01, rent to X01');
  assert.equal(body.state.item, 'MILK for C03');
  // nothing left for the final check, which now looks for every label in the budget
  assert.deepEqual(findLeaks(body, { labels: [...everyLabel, ...codes.all()].filter((l) => l.includes(' / ')), words: [] }), []);
  // ... but it would still catch one that got through
  assert.equal(findLeaks({ state: { x: 'bills / rent' } }, { labels: everyLabel, words: [] }).length, 1);
});

test('invisible format characters and a mark glued after a name do not defeat the scrubber or the leak check', () => {
  const scrub = makeScrubber(pseudonymEntries(['Alex'], ['alex']));
  for (const raw of ['A\u200bLEX', 'AL\u200dEX', 'ALEX\u0301', 'GIFT FOR A\u00adLEX']) {
    assert.equal(findLeaks({ s: raw }, { labels: [], words: ['Alex'] }).length, 1, JSON.stringify(raw));
    const out = scrub(raw);
    assert.ok(/Person A/.test(out) && !/alex/i.test(out), JSON.stringify(out));
    assert.equal(findLeaks({ s: out }, { labels: [], words: ['Alex'] }).length, 0, JSON.stringify(out));
  }
});

test('onlyWordsFrom: a name made only of hidden words (ignoring \'s and punctuation) is not worth keeping readable', () => {
  assert.equal(onlyWordsFrom("Sam's", ['sam']), true);
  assert.equal(onlyWordsFrom('Jordan Smith', ['Jordan', 'Smith']), true);
  assert.equal(onlyWordsFrom("Sam's Club", ['Sam']), false);
});

test('makeScrubber places: each kind gets its neutral word, ZIP codes vanish, longer places win, people still get Person letters', () => {
  const places = [{ word: 'Fake Falls', type: 'city' }, { word: 'Fake', type: 'state' }, { word: '123 Main St', type: 'street' }, { word: '62704', type: 'zip' }, { word: 'Springfield', type: 'place' }];
  const scrub = makeScrubber(pseudonymEntries(['Alex'], ['alex']), { places });
  assert.equal(scrub('ALEX AT 123 MAIN ST, FAKE FALLS 62704'), 'Person A AT a street, a city');
  assert.equal(scrub('fake and springfield'), 'a state and a place');
  assert.equal(scrub('SPRINGFIELDS'), 'SPRINGFIELDS'); // whole words only
  // tokens can't be mistaken for places, and a 2-letter or country entry is not usable
  assert.equal(makeScrubber([], { places: [{ word: 'city', type: 'city' }, { word: 'IL', type: 'state' }, { word: 'USA', type: 'state' }] })('a city IL USA'), 'a city IL USA');
  // a place is never kept readable, not even inside a business name that is kept whole for people's words
  assert.equal(makeScrubber([], { places, protect: ['Springfield Hardware'] })('SPRINGFIELD HARDWARE IN SPRINGFIELD'), 'a place HARDWARE IN a place');
});

test('findLeaks: a hidden place left in the request is a leak of kind "place" (outside protected spans)', () => {
  const places = [{ word: 'Fake Falls', type: 'city' }];
  assert.deepEqual(findLeaks({ state: { store: 'Shop Fake Falls' } }, { labels: [], words: [], places }), [{ path: 'state.store', kind: 'place' }]);
  assert.deepEqual(findLeaks({ state: { store: 'Shop a city' } }, { labels: [], words: [], places }), []);
  // a protected business span does not hide a place from the check
  assert.deepEqual(findLeaks({ state: { store: 'Fake Falls Hawks Shop' } }, { labels: [], words: [], places, protect: ['Fake Falls Hawks Shop'] }), [{ path: 'state.store', kind: 'place' }]);
  // a number in the request (a price) is not a numeric place: the serialized check skips places
  assert.deepEqual(findLeaks({ total: 62704, state: { item: 'x' } }, { labels: [], words: [], places: [{ word: '62704', type: 'zip' }] }), []);
  assert.equal(describeLeaks(findLeaks({ a: 'in Fake Falls' }, { labels: [], words: [], places })), 'a (place)');
});

test('places: numbers only match as whole numbers ("123" is not in "12345", ZIP "62704" not in "627042")', () => {
  const scrub = makeScrubber([], { places: [{ word: '123', type: 'street' }, { word: '62704', type: 'zip' }] });
  assert.equal(scrub('12345 PAPER TOWELS 2PK'), '12345 PAPER TOWELS 2PK');
  assert.equal(scrub('Ship to 62704 now; 627042 id; 4627041'), 'Ship to now; 627042 id; 4627041');
  assert.equal(scrub('123 ROAD'), 'a street ROAD');
  assert.equal(findLeaks({ s: '12345' }, { labels: [], words: [], places: [{ word: '123', type: 'street' }] }).length, 0);
  assert.equal(findLeaks({ s: 'at 123' }, { labels: [], words: [], places: [{ word: '123', type: 'street' }] }).length, 1);
});

test('places: separators between a place\'s words may differ ("FAKE-FALLS", "FakeFalls", "FAKE  FALLS", a new line)', () => {
  const places = [{ word: 'Fake Falls', type: 'city' }];
  const scrub = makeScrubber([], { places });
  for (const t of ['FAKE-FALLS', 'FakeFalls', 'FAKE  FALLS', 'fake\nfalls', 'Fake, Falls']) {
    assert.equal(scrub(t), 'a city', JSON.stringify(t));
    assert.equal(findLeaks({ s: t }, { labels: [], words: [], places }).length, 1, JSON.stringify(t));
  }
  assert.equal(scrub('FAKE alone'), 'FAKE alone');
});

test('places: a state code and a ZIP code right after a replaced city go with it; US and other words stay', () => {
  const scrub = makeScrubber([], { places: [{ word: 'Fake Falls', type: 'city' }] });
  assert.equal(scrub('FAKE FALLS IL 62704'), 'a city');
  assert.equal(scrub('CORNER, FAKE FALLS, IL'), 'CORNER, a city');
  assert.equal(scrub('FAKE FALLS 62704-1234 PICKUP'), 'a city PICKUP');
  assert.equal(scrub('FAKE FALLS US'), 'a city US');
  assert.equal(scrub('FAKE FALLS mo and FAKE FALLS Pickup'), 'a city mo and a city Pickup');
});

test('buildRemoteRequest: the per-receipt question lists every item with its price, as codes and scrubbed text, and no single item, hint or correction', () => {
  const { body, codes } = buildRemoteRequest(input({ whole: true, wholeInstructions: 'Which one category fits the whole purchase?', similar: true }), same);
  const s = body.state;
  assert.equal(body.questions.category.instructions, 'Which one category fits the whole purchase?');
  assert.deepEqual(s.items_on_receipt, [{ item: 'GUM', price: 2 }, { item: 'MILK (whole milk)', price: 3.5 }]);
  for (const k of ['item', 'item_price', 'other_items_on_receipt', 'household_keyword', 'similar_items_filed_before', 'household_corrected_the_pipeline']) assert.equal(k in s, false, k);
  assert.equal(s.category_your_rules_give_this_store, 'C01');
  assert.equal(s.total, 10.5);
  assert.deepEqual(Object.keys(body.questions.category.criteria), ['C01', 'C02', 'C03'], 'the same codes as the item questions');
  assert.equal(codes.label('C03'), LABELS[2]);
  const text = JSON.stringify(body);
  for (const l of [...LABELS, 'Bills / Rent']) assert.ok(!text.includes(l), `${l} leaked`);
  assert.deepEqual(findLeaks(body, { labels: [...LABELS, 'Bills / Rent'], words: [] }), []);
  // the scrubber is applied to every item text, as for the item questions
  const seen = [];
  buildRemoteRequest(input({ whole: true, wholeInstructions: 'q' }), (t, kind) => { seen.push([kind, t]); return t; });
  assert.deepEqual(seen.filter(([k]) => k === 'item').map(([, t]) => t), ['MED-GUM', 'MILK (whole milk)'].map((t) => t.replace('MED-', '')));
});

test('a short category name the scan flagged ("Kids / Alex" -> Alex) is replaced in a note, a description and an item line, and the leak check stops it; ordinary category words stay', () => {
  const labels = ['Daily Expenses / Coffee', 'Kids / Alex'];
  const scrub = makeScrubber(pseudonymEntries(['Alex'], ['alex']));
  const { body } = buildRemoteRequest({
    labels, receipt: { date: '2026-10-26', total: 4, items: [{ description: 'SOCCER SOCKS ALEX', amount: 2 }, { description: 'COFFEE BEANS', amount: 2 }] },
    index: 0, history: [{ date: '2026-10-01', amount: 30, parts: [{ category: 'Kids / Alex', amount: 30, notes: 'soccer cleats for Alex' }] }],
    itemHistory: [], notes: { 'Kids / Alex': "Alex's school things" }, instructions: 'Pick one.', model: 'm',
  }, scrub);
  assert.equal(body.state.item, 'SOCCER SOCKS Person A');
  assert.deepEqual(body.state.other_items_on_receipt, ['COFFEE BEANS']);
  assert.deepEqual(body.state.past_purchases_at_this_store[0].filed_as, ['C02 30 (soccer cleats for Person A)']);
  assert.equal(body.questions.category.criteria.C02, "Person A: Person A's school things");
  assert.equal(body.questions.category.criteria.C01, 'The "Coffee" budget category (group: Daily Expenses)');
  assert.deepEqual(findLeaks(body, { labels, words: ['Alex'], found: ['Alex'] }), []);
  // one that slipped through is caught and called a found name; the ordinary word "Coffee" is no leak
  const raw = { state: { item: 'COFFEE BEANS', note: 'soccer cleats for Alex' }, criteria: { C01: 'The "Coffee" budget category' } };
  assert.deepEqual(findLeaks(raw, { labels, words: ['Alex'], found: ['Alex'] }), [{ path: 'state.note', kind: 'found name' }]);
});
