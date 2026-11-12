[How it works](how-it-works.md) › Cloud options

# Cloud options

What leaves your machine if you swap the reader or decider for a hosted model (both optional, off by default).

**In short**

- By default both models run locally and nothing is sent out.
- A **cloud reader** sends whole receipt photos to OpenAI or OpenRouter. A **hosted decider** sends anonymized text to TypeSafe, never the photo.
- With both hosted, the worker needs `CLOUD_NAME_SCAN=true` to start.
- Both cost money and are untested here: try `./receipts replay` first (it changes nothing in Actual, but with the hosted decider it sends real, paid requests unless you add `--preview-remote`).
- To switch back, set `READER_PROVIDER=local` or `DECIDER_PROVIDER=local` and run `./receipts restart`.

## Cloud reader

With `READER_PROVIDER=remote`, a cloud vision model on your own OpenAI or OpenRouter key replaces the local reader (the model that turns a photo into data); **your receipt photos leave your house.**

`./receipts setup` asks; the local `llm` container then doesn't run. `./receipts start`, `status`, the startup log and the app ("model (remote: host)") all flag it.

### What leaves the machine

The whole photo (PDF pages and HEIC become a JPEG first, at most `MAX_IMAGE_SIDE` pixels) and the reader's instructions.

- **The provider sees all of it:** store and address (where you shop), date and time, everything you bought, prices, last card digits, member or loyalty numbers, sometimes your name or a cashier's, barcodes.
- **Not anonymized:** the hosted decider's anonymizer can't apply to photos.
- **Stripped first:** EXIF, including the phone's GPS location, from every photo (local too), after applying its rotation.
- **Not in the request:** the file name, the Nextcloud folder, your Actual data, the account.
- **Your key** goes only in the `Authorization` header and is never logged; provider error text is scrubbed of it (and of image data) and cut to 200 characters before it is shown.
- **Where it goes:** the provider may keep requests for a while (for example, abuse monitoring); check its policy. OpenRouter forwards to a third-party provider whose policy applies; its privacy settings can exclude ones that log or train on data.

Two jobs send Actual data to the reader: category descriptions (below), never automatic with a cloud reader, and the [name scan](#with-both-hosted), on a cloud reader only with `CLOUD_NAME_SCAN=true`.

### Category descriptions

Describing a category that has none (`./receipts describe`, the worker's first run, the setup question) asks the reader: the category name, its transaction count and median amount, store names with counts, the stores your Actual rules send there, and up to 30 of your item notes.

With a cloud reader the worker never does this on its own (it logs that it skipped it); `./receipts describe` lists what would be sent and asks first (`--yes` skips that), and the setup question defaults to No.

### Trying it

Replay the same receipts with each reader and compare readings and totals (cloud costs per photo). `./receipts check` tests address and key without a photo, though some providers only reject a wrong key at the first receipt.

## Hosted decider

With `DECIDER_PROVIDER=remote`, the decider (the model that picks a category per item) runs on TypeSafe's hosted Jev model; **this sends anonymized text about your purchases to TypeSafe.** Photos and the reader stay local unless you also chose the cloud reader.

It frees about 3-7 GB of graphics memory. It needs a [TypeSafe](https://docs.typesafe.ai) key (input about $0.042 per million tokens, output free); `./receipts setup` asks, stores it and stops the local decider.

### What is sent

Everything is anonymized first, with no off switch. One request goes out per item, plus one per receipt about the whole purchase with `RECEIPT_CHECK` (all item lines with prices, same scan and last check).

- **Item lines, the receipt's other items:** with the replacements below; amounts as they are.
- **The store:** only its Actual payee name, long numbers removed. Never the bank's raw text, never transfers between your accounts.
- **Past purchases, notes, category descriptions:** every full category label ("Group / Category"), even inside a note, becomes a code (`C01`, `C02`...) only your machine can decode. A category's short name on its own is sent as written ("Groceries"), unless the name scan finds it names a person or place ("Kids / Alex"): then it is replaced everywhere, like any other name. The pipeline's unchecked picks are labeled `pipeline, unchecked`, as locally.
- **Dates:** "12 days before this purchase". Built-in holidays keep their name; other occasions become "a birthday or personal occasion".
- **People's names:** Person A, Person B..., the same letter for the same name.
- **Places:** "a city", "a state" or "a street" (places on your list: "a place"), ZIP codes dropped. A store named after its town goes out as, say, "Corner Thrift Shop a city".

**Never sent:** the photo, card digits, payment method, cash amounts, addresses, the printed date, calendar event names.

### How names and places are found

Each text is checked two ways:

1. **Your lists:** names, nicknames and pet names (`PRIVATE_WORDS`) and your town, street or ZIP (`PRIVATE_PLACES`). They seed the lists once; then edit them under **Settings → Privacy**.
2. **A reader scan** of everything about to be sent, plus every category name in your budget (12 texts at a time; each text scanned once, results cached locally) marks people's names and places.
   - In a receipt line a name only counts with a word like FOR, TO, GIFT or MEMBER, or if your notes already know it. Abbreviations and product words ("CAGE FREE") never count.
   - A business name such as "Papa John's" stays where it appears in full if no person or place is found in it; the same word elsewhere is still hidden.
   - Findings show on the Privacy page; press **Not a name** or **Not a place** to correct one.

### The last check

Each request is searched for every full category label and every listed or found name and place. A hit holds that item back as unsure; the log says where, not what.

- If the scan can't run (reader down), the receipt waits: nothing goes out unscanned.
- If `data/private-words.json` is damaged, nothing is sent until you fix or delete it; the worker never overwrites it.

### With both hosted

The scan runs on the reader, so a cloud reader's provider gets the scanned texts (item lines, store names, amounts, category names and notes) unanonymized.

- The worker refuses to start this way unless `CLOUD_NAME_SCAN=true`; setup explains and asks. Then the startup log and status page note it.
- Even with `--preview-remote`, a replay sends photos and scan texts to the cloud reader.

### Previewing

`./receipts replay --nextcloud "/Receipts/Processed" --preview-remote jev-preview` writes exactly what would be sent (a JSON file per item, `<receipt>.receipt.json` per receipt) to `data/research/jev-preview/`, marks items the last check would hold back, and calls no decider. `./receipts check` sends one fixed request with none of your data. `item-test` would send up to a year of split notes (to a cloud reader's scan as they are), so with the hosted decider it needs `--allow-remote` ([testing.md](testing.md)).

## When a hosted model fails

Setup problems pause processing and outages wait for the next poll, without using up attempts.

- **Setup problem** (refused key, no credit or quota, wrong model or address, unsupported region): a banner shows; fix the setting and run `./receipts restart`.
- **Outage** (down, rate-limited, unreachable): retried, then next poll.
- **Maybe already billed** (timeout, 408, 504 or 524 reply, answer broken off mid-download): retried next poll; three checks in a row count as one failed attempt.
- **Cloud reader:** a photo flagged by moderation, or an answer cut at the token limit, is a failed attempt (review after the third). Before the first good reading since start, one rejected image is skipped and a second pauses (the model probably can't take images); later, a failed attempt.
- **Jev** refusing an item: only it is unsure.

Paid results aren't bought twice: a cloud reading is kept until the reader changes, and Jev answers (never the request text or key) until the receipt is done.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `READER_PROVIDER` | `local` | `remote` = cloud reader |
| `READER_URL` | unset | API address (https) |
| `READER_API_KEY` | unset | OpenAI or OpenRouter key |
| `READER_MODEL` | unset | Vision model |
| `MAX_IMAGE_SIDE` | 2240 | Longest side of the JPEG sent |
| `DECIDER_PROVIDER` | `local` | `remote` = hosted Jev |
| `DECIDER_API_KEY` | unset | TypeSafe key |
| `RECEIPT_CHECK` | true | Whole-purchase request |
| `PRIVATE_WORDS` | unset (setup asks) | Names to hide |
| `PRIVATE_PLACES` | unset | Town, street or ZIP to hide |
| `CLOUD_NAME_SCAN` | false | `true` allows both hosted |

All settings: [.env.example](../.env.example), or Settings in the web app.
