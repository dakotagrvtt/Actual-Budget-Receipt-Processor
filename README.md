# Actual-Budget-Receipt-Processor

Processes receipt photos uploaded to Nextcloud with a local vision model (llama.cpp), sorts each item into your Actual Budget categories with a local decision model, and splits the matching transaction in Actual when it is confident. Anything it is unsure about goes to a review folder.

## Receipt pipeline: Nextcloud → Qwen3.5-4B → Actual Budget

Upload a receipt photo (JPEG, PNG, WebP, HEIC) or PDF to a Nextcloud folder. A local vision model reads it,
assigns each line item one of your Actual budget categories, finds the matching card/bank transaction,
and categorizes it.

```
Nextcloud /Receipts/Inbox ──► worker ──► llama.cpp (Qwen3.5-4B, local GPU)
                                │
                                ├─ match found, totals check out ──► Actual: set category + "#receipt" note
                                │                                    Nextcloud: move to /Receipts/Processed (+ .json summary)
                                └─ anything doubtful ──────────────► Nextcloud: move to /Receipts/Needs review (+ .json with reasons)
```

Nothing leaves this machine except calls to your own Nextcloud and Actual servers.

Which models were picked, and the tests behind each choice: [docs/research.md](docs/research.md).

## How a receipt is handled

1. **Read**: the image is auto-rotated and downscaled (HEIC and up to 3 PDF pages are converted first). The reader (Qwen3.5-4B)
   returns merchant, store clues, date as printed, subtotal, tax, tip, total, payment method, cash handed over, whether it's a
   return, and line items.
   - First pass: the model answers directly (thinking off). In a 25-receipt test, Qwen with a 1,024-token
     thinking budget gave the same totals, dates and results as thinking off, at 2.4× the time. `LLM_THINKING=true`
     plus `READER_REASONING_BUDGET=1024` in `.env` turns it on.
   - If that answer isn't valid JSON or is missing fields, a second pass forces schema-valid JSON.
   - **Cash and return receipts** go straight to review: there's no bank charge to match, and the worker never
     creates transactions.
2. **Find the bank transaction.** Your bank sync has already imported the charge, so the worker never creates
   transactions. It looks for exactly one match:
   - **Amount:** an outflow equal to the receipt total. With `MATCH_TOLERANCE_PERCENT` set, it may be larger by up to
     that percentage, to allow for tips; any extra amount sends the change to review.
   - **Date:** from 1 day before to `MATCH_DAYS` after the receipt date, because bank posting lags. A charge dated the
     day before the receipt sends the change to review.
   - **Payee:** the payee name in Actual, or the bank's raw description (`imported_payee`), must look like the
     merchant on the receipt (`PAYEE_MIN_SCORE`). Names are compared after stripping card-processor prefixes
     (`SQ *`, `TST*`, `PAYPAL *`), store numbers, trailing city/state and punctuation, so `TST* JOES PIZZA #42` matches
     `Joe's Pizza`. Look-alike chains don't match: a shared generic first word (Dollar Tree vs Dollar General, Pizza Hut
     vs Pizza Ranch) isn't enough. For names it misses, add them to `data/payee-aliases.json` (see `payee-aliases.example.json`).
   - **Ties:** two candidates whose payees score within 0.15 of each other are ambiguous and go to review. The card's
     last 4 digits on the receipt only break a tie between accounts.
   - It skips transfers, existing splits and anything already tagged `#receipt`. Transactions your Actual rules
     already categorized are still matched.
   - **Not imported yet:** if nothing matches while the charge could still post (until the day after the `MATCH_DAYS`
     window), the receipt stays in the inbox and is re-checked every `MATCH_RECHECK_MINUTES` (60) without being read
     again. `./receipts run-now` re-checks right away. A **pending** charge is waited on until it clears, up to
     `MATCH_PENDING_WAIT_DAYS` (2) more days; after that it's applied and reviewed.
3. **Check the receipt.** Line items must add up to the printed subtotal (within 2%), and the date must be plausible.
4. **Split.** The amount the bank charged, including any tip, is divided across the receipt's categories by
   line-item share. Tax and tip are spread proportionally, so the parts always add up exactly to the bank amount.
   - **One category, same as the transaction's:** nothing changes except a `#receipt` note.
   - **One category, different from the transaction's:** the transaction switches to the receipt's category, but only
     if at least one item is confident (`MOVE_MIN_CONFIDENCE`) about the new one.
     Set `OVERWRITE_CATEGORIZED=false` to send these to review instead.
   - **Charges filed under a category receipts don't use** (Saving For, bills, debt, Tithing, hidden or income
     categories) are never changed: the receipt goes to review.
   - **Returns and coupons:** a category whose items net negative (an exchange, or a coupon bigger than its items)
     becomes a credit part, and the receipt goes to review.
   - **Several categories:** the transaction becomes an Actual split, with one part per category. Each part's note
     lists its items, and the parent gets a `#receipt <file>` note.

If finding the transaction isn't clear-cut, nothing changes in Actual and the receipt goes to `Needs review` with a
JSON file that says why. That covers no match once the waiting time is over, a payee that doesn't match, two equally
good matches, cash and return receipts, and charges in categories receipts don't change. When the payee
doesn't match, the JSON lists the transactions that did match on amount and date, so you can see whether an alias is missing.

If the transaction is found but some items are doubtful, the confident part is still applied and the receipt goes
to `Needs review` too (`APPLY_THEN_REVIEW=true`, the default):
- Unsure items become an **Uncategorized** split part whose note lists them with d1's guess, e.g. `MED-DVD'S (maybe Child 34%)`.
  If the store has a usual category, unsure items go there instead: the transaction's current category first (so a
  charge you re-filed by hand stays where you put it), then your rule's. Items moved there this way are listed as doubts.
- Other reasons a change is applied but reviewed: a tip or other extra amount, a charge dated the day before the
  receipt, a receipt with no readable date, a credit part, or a store whose every past purchase went elsewhere.
- Money the reader missed (items add up to less than the printed subtotal) goes to the store's usual category, or to
  the Uncategorized part.
- The parent's note gets a `#review` tag, so you can find these in Actual by searching for it.

Set `APPLY_THEN_REVIEW=false` to hold such receipts for review without changing anything.

**DRY_RUN=true** (the default) logs every decision and changes nothing, in either Actual or Nextcloud.

## Setup

1. Config:
   ```
   cp .env.example .env && chmod 600 .env
   ```
   - Fill in the Actual server URL, password and Sync ID (Settings → Show advanced settings).
   - Set `ACTUAL_API_VERSION` to your Actual server's version.
   - Add a Nextcloud **app password** (Personal settings → Security), not your login password.
2. In Nextcloud, create `/Receipts/Inbox`. With `DRY_RUN=false`, the worker also creates the other two folders.
3. Start it and check the connections:
   ```
   ./receipts start
   ./receipts check
   ```
4. Watch the dry-run decisions with `./receipts logs`. When they look right, switch to live mode with
   `./receipts mode live` (it asks you to confirm). Receipts seen during the dry run are processed again for real.

## Running it

Once started, the pipeline runs on its own: no AI assistant or manual step is involved.
- The worker checks the inbox every `POLL_SECONDS` (300 seconds by default), so uploading a receipt to Nextcloud is all you do.
  An empty inbox costs one small Nextcloud request; Actual is only opened when there's a receipt.
- All three containers restart automatically after a crash or a reboot (`restart: unless-stopped`, with Docker enabled
  at boot). `./receipts stop` keeps them stopped, including across reboots, until `./receipts start`.
- The worker waits until both models have loaded. If Actual or Nextcloud is unreachable, that poll is logged as failed
  and retried on the next one. A receipt that fails 3 times goes to `Needs review`.
- Container logs are capped at about 30 MB per service.

| Command | What it does |
|---|---|
| `./receipts start` / `stop` | Start everything (builds the worker if needed) / stop it and free the GPU |
| `./receipts status` | Mode, container health, time of the last poll, last log lines |
| `./receipts logs` | Follow the worker log |
| `./receipts run-now` | Check the inbox now instead of waiting for the next poll |
| `./receipts trigger-url` | The status page link (with a "check now" button) and the webhook URL |
| `./receipts check` | Test the connections to Nextcloud, Actual and both models (changes nothing) |
| `./receipts mode dry` / `live` | Switch between dry run and live (live asks you to confirm) |
| `./receipts restart` | Pick up edits to `.env` or `data/category-notes.json` |
| `./receipts update` | Rebuild the worker after code changes or a new `ACTUAL_API_VERSION` |
| `./receipts replay …` | Dry-run comparison against your own categorizing (see below) |
| `./receipts describe` | Write descriptions for categories that have none (`--refresh` rewrites the auto ones) |
| `./receipts item-test <name> <decider\|rules>` | Leave-one-out test of the decider (or the `rules` baseline, no model) on your own hand-made splits (changes nothing) |
| `./receipts keyword …` | Household keywords: `add`, `remove`, `list`, `test` (see Keywords below) |

`check`, `replay`, `describe`, `item-test` and `keyword` use their own copy of the budget (`data/actual-cache-tools`), so they are safe to
run while the worker is running. `worker` shows as `unhealthy` in `status` if its poll loop hasn't run for over an
hour beyond `POLL_SECONDS`.

### Checking on demand: status page, webhook, Actual link

The worker serves a small page on port 8095. It shows the mode, the time of the last check and recent results,
and has a **Check for receipts now** button. `POST /run` on the same port is a webhook that does the same thing.
Every request needs the `TRIGGER_TOKEN` key (generated by `./receipts start`); `./receipts trigger-url` prints both URLs.
- **From Actual:** notes on the budget page support Markdown, so a link there works as a button without changing
  Actual. Paste `[Check receipts](<status page URL>)` into a category or group note.
- **From your phone or the Nextcloud server:** the page only listens on this machine by default. Set
  `TRIGGER_BIND=0.0.0.0` in `.env` and run `./receipts restart` to reach it from your network. Anyone who has the key
  can trigger a check and see recent receipt names and results.
- **Nextcloud webhook (optional):** the Webhook Listeners app (admin only) can call `POST /run` when a file is
  created in the inbox, using a `NodeCreatedEvent` listener filtered on the folder path. Nextcloud sends webhooks from
  background jobs, so without dedicated webhook workers it's often no faster than the regular poll (`POLL_SECONDS`, 5 minutes by default).

When you upgrade Actual, set `ACTUAL_API_VERSION` to the new version and run `./receipts update`. The API must match
the server.

## Limitations and knobs

- **Dates.** The reader copies the purchase date as printed, and the worker parses it (US month/day; day/month only
  when the first number can't be a month). Return-by dates, future dates, and dates more than 400 days before the
  upload are ignored.
- **No readable date.** The worker looks for the charge in the `MATCH_NO_DATE_RECENT_DAYS` (14) days before the
  upload. A match there is used, and anything that moves money is reviewed. If the only match is older (up to
  `MATCH_NO_DATE_LOOKBACK_DAYS`, 365), nothing is applied: the review JSON names that charge so you can check it.
  When uploading a backlog of old receipts, raise `MATCH_NO_DATE_RECENT_DAYS` for that batch.
- **Store names.** Store names can also match through clues on the receipt, such as `menards.com`, when the logo is
  cut off. Only website/email domains and multi-word business names count as clues, never a city, and a clue scores
  lower than the store name. History is looked up by the bank's payee name.
- **Your Actual rules.** The worker reads your rules (read-only) and works out which category they give the matched
  transaction, following Actual's own order and specificity. Checked against six months of transactions, it agreed
  93% of the time; the rest were ones you re-filed by hand. It understands split rules (only whole-transaction
  categories count), "approximately" amounts, regex, "contains" on payee names, tags and on/off-budget conditions;
  recurring-date conditions are treated as not matching. d1 is told the store's rule category. Items d1 is unsure
  about (under `CATEGORY_MIN_CONFIDENCE`) stay in the store's usual category (`UNSURE_ITEMS_USE_STORE_CATEGORY`), so
  only confident items are split out. Generated category descriptions also list the stores your rules send there.
- **Moving items out of the store's category** needs `MOVE_MIN_CONFIDENCE`. It defaults to `CATEGORY_MIN_CONFIDENCE` (0.5, the bar
  for staying); we run 0.6. In testing, every wrong split was a near miss at 54–55% (cookie dough → Home & Auto, Nerds → Adult 1, shampoo → Health).
  If real splits you want end up as single-category confirms, lower it.
- **When review is skipped.** If the receipt agrees with the category your rule already set, the only change is a
  `#receipt` note listing the items. Unsure items or a missed line don't send it to review. A recategorize or split
  goes to review (after being applied, see above) when an item is under `CATEGORY_MIN_CONFIDENCE`, the items don't
  add up to the subtotal, or it disagrees with the store's history: every past purchase at the store (3 or more) went
  to one category.

- **Splits need Actual 26.8.0 or newer.** Older API versions crash when an existing transaction is converted into a split
  (fixed in actualbudget/actual#8467). On older versions, or with `SPLIT_TRANSACTIONS=false`, an uncategorized charge
  gets the largest category; one that already has a category keeps it, and the note lists the breakdown.
- **Undoing a change:** the parent transaction's note keeps the original note plus `#receipt <file>`, and the Nextcloud
  `.json` summary records what was changed. Undo it in Actual by hand: delete the split parts, set the category, and
  remove `#receipt <file>` from the note (otherwise the receipt is treated as already applied and never matched again).
- **Tips.** A restaurant charge is often higher than the printed total. Set `MATCH_TOLERANCE_PERCENT=25` to allow that;
  matches with a tip are applied and reviewed.
- **Cash purchases** have no bank charge, so they go to review. The worker never creates transactions.
- **Small parts:** split parts under `SPLIT_MIN_AMOUNT` (default 1.00) are folded into the transaction's current
  category, or into the largest part. The Uncategorized part and credit parts are never folded into a category.
- **Outages and restarts.** If a model, Actual or Nextcloud is down, the poll stops and retries later; outages never
  count toward a receipt's 3 attempts. On stop or restart the worker finishes the receipt it's on (3-minute grace
  period). If it crashes after changing Actual but before moving the file, the next poll recognizes the `#receipt`
  note and only moves the file. Half-uploaded (`.part`) and empty files are skipped.
- **GPU sharing and other GPUs.** Both models together use about 8.3 GB of VRAM, or 7.4 GB with `compose.small-gpu.yaml`
  (about 5.1 GB with the decider on the CPU). If another app is using the whole card, start this first or stop that app.
  AMD and Intel use the default Vulkan images (set `RENDER_GID`); NVIDIA uses `compose.nvidia.yaml`. See
  [docs/research.md](docs/research.md#hardware). To run on the CPU instead, change `-ngl 99` to `-ngl 0` (slower, but
  receipts aren't urgent).
- **Reprocess a receipt:** move it back into the inbox, remove `#receipt <file>` from the transaction's note if it was
  applied, and delete its entry from `data/state.json` if it has the same ETag.

## Categorizing, offline mode, and replay tests

- **Two models, two jobs.** Qwen3.5-4B (`llm`) reads the receipt. The decider (`decider-gguf`, on llama.cpp; d1-2B
  unless `DECIDER_MODEL` says otherwise) picks a category for each item and returns a confidence. Items under
  `CATEGORY_MIN_CONFIDENCE` are settled as described above: the store's usual category, or an Uncategorized part for
  you to fill in, and the receipt goes to review if that moves money.
  (Using the reader model for this step instead was tried: it picked about as well one item at a time but, with no
  confidence scores, moved too many items out of the store's usual category: 75% average match against 97%.)
- **A bigger decider.** `DECIDER_MODEL` in `.env` swaps d1-2B for any `/v1/systemone` model in `./models`.
  vLLM d3-flash 9B (`ggml-org/vllm-d3-flash-GGUF:Q4_K_M`, with `DECIDER_CTX=8192 DECIDER_BATCH=4096`) splits out more
  of the right items (95.8% vs 90.9% on the test receipts) but needs about 6.8 GB instead of 2.7 GB. "d1" in the rest of
  this README means whichever decider you run. Details in [docs/research.md](docs/research.md).
- **Holidays and gift meals.** Holidays near the purchase date (computed locally) go to d1 as a gift hint.
  Reading birthdays from your Nextcloud calendars is possible (`OCCASIONS_CALENDAR=true`) but off by default.
  A restaurant charge over `GIFT_MEAL_MIN` ($50) is applied as usual but sent to review: it may be a gift meal.
- **What d1 sees for each item:**
  - the item name, with store department codes like `MED-` / `BED-` removed (`STRIP_DEPARTMENT_PREFIXES`)
  - the other items on the receipt
  - how you filed past purchases at the same store
  - with `SIMILAR_ITEMS=true`, up to 8 past items from any store that share words with this one, and how they were filed
  - every item note in your past splits, from any store, grouped by category (for example "Egg Book → Child", "DC Charger → Adult 1")
  - only the spending categories: bills, debt and savings are hidden (`EXCLUDE_CATEGORY_GROUPS`, `EXCLUDE_CATEGORIES`)
- **Category descriptions (`data/category-notes.json`).** d1 chooses among these descriptions, so they're how it
  learns household knowledge, such as what goes to Adult 1, Adult 2 or Child.
  - When a spending category has no description, the worker has the reader model write one from that category's past
    transactions (stores, your item notes, amounts). This happens before each batch of receipts, or on demand:
    `./receipts describe` (add `--refresh` to rewrite only the auto ones).
  - Written entries are marked `"auto": true`. Review them, and rewrite any in your own words. To mark one as yours,
    replace the entry with a plain string or delete the `"auto"` flag. Yours are never overwritten.
    See `category-notes.example.json` for both forms.
- **Plain-language item names (`READ_PLAIN_NAMES`) are off.** In testing, the reader decoded "MED-CHILD PIC" (children's books) as "child milk".
- **History gets better on its own.** Splits the pipeline makes list their items in each part's note, so later
  receipts from the same store learn from them. When you split by hand, a few words in each part's note (such as
  "DVDs") help the same way.
- **Offline.** `llm` loads its model files by path and `decider-gguf` runs with `--offline`, so neither contacts
  Hugging Face. To download a different decider model, remove `--offline` from its command in `compose.yaml` for one start.
- **Replay tests** compare the pipeline with purchases you've already categorized or split, without changing anything.
  Upload those receipts to a Nextcloud folder such as `/Receipts/Test`, then run:
  ```
  ./receipts replay --nextcloud "/Receipts/Test"
  ```
  `--only 212537,212930` limits it to files whose names contain those strings. You can also pass a single file from `./data` (`/data/receipt.jpg`).
  New readings are saved to `data/research/readings/<name>.read.json`; `--readings <folder>` re-decides every saved reading in a folder (both `.read.json` and the older `.lfm3-read.json` are accepted), and `--receipt /data/research/readings/x.read.json` reuses one. To compare deciders, set `DECIDER_MODEL` in `.env`, run `./receipts restart`, and replay the same `--readings` folder. Test output goes to `data/research/`.

### Keywords

A keyword says "items matching this phrase belong in this category", e.g. `Gold Bond` → `Daily Expenses / Adult 2`. They live
in `data/keywords.json` (`{"keywords":[{"phrase","category","store","strength","added","from"}]}`) and match whole words in the item
text, ignoring case and apostrophes, with plurals (`nerd`/`NERDS`) and run-ons for multi-word phrases (`DRPEPPER` matches
`Dr Pepper`). A keyword with a store (`--at`) only applies at that store and beats a global one; more words beat fewer;
two best keywords with different categories cancel out and the receipt is flagged ("keywords disagree").

- **Strength:** each keyword is `always` or `usually` (default `usually`). **`KEYWORD_MODE=mixed` (recommended)** files
  `always` keywords like `final` and treats `usually` keywords like `hint`. `final`, `hint` and `off` (the default) are
  global overrides that ignore strength.
- **`KEYWORD_MODE=final`:** a matching item skips the model and is filed at 100% confidence.
- **`KEYWORD_MODE=hint`:** the model is told the keyword's category. With the d1 decision model, that category's
  probability is also multiplied by `KEYWORD_HINT_WEIGHT` (default 4; 1 = prompt only) and the confidence recomputed.
  Other backends get the prompt hint only. `off` (the default) ignores keywords.
- **CLI:** `./receipts keyword add "Gold Bond" "Adult 2" [--at Target] [--always|--usually]`, `keyword remove <phrase> [--at <store>]`,
  `keyword list`, `keyword test "GOLD BOND LOTION" [--at <store>]`. Categories can be the full label, the part after
  ` / `, or a unique prefix.
- **`#always` in Actual:** put `#always Gold Bond` in a split part's (or a categorized transaction's) notes and the
  worker adds that phrase with the part's category on its next receipt (phrase: 1-4 words, up to a `|`, `;` or `#`;
  a bare `#always` uses the part's item note). `#usually <phrase>` does the same with strength `usually`, and a tag with
  only a different strength updates an existing Actual-made keyword for the same category. The worker only reads Actual; the tag is ignored in item notes.
