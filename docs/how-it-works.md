# How it works

The details behind the [README](../README.md): how a receipt is matched, split and reviewed, the settings that change each step, and the testing tools. Day to day you don't need `.env` or the command line: the [web app](#the-web-app-webhook-and-actual-link) switches dry run and live, edits descriptions, keywords and many settings, and retries receipts. Every setting named here can be set in `.env`; [`.env.example`](../.env.example) lists them all with their defaults. Run `./receipts restart` after changing one.

**What leaves the machine.** By default nothing but your requests to your own Actual and Nextcloud servers. The two optional cloud features, the [cloud reader](#cloud-reader-optional) (sends the receipt photo) and the [hosted decider](#hosted-decider-optional) (sends anonymized text), are off unless you set `READER_PROVIDER=remote` or `DECIDER_PROVIDER=remote`.

**Contents**

- [How a receipt is handled](#how-a-receipt-is-handled): read, match, check, split, review
- [The web app, webhook and Actual link](#the-web-app-webhook-and-actual-link)
- [Details and limits](#details-and-limits): dates, rules, confidence, outages, private files, GPU
- [Categorizing, offline mode, and replay tests](#categorizing-offline-mode-and-replay-tests)
- [Keywords](#keywords)
- [Learning from your corrections](#learning-from-your-corrections)
- [The local reader model](#the-local-reader-model)
- [Cloud reader (optional)](#cloud-reader-optional)
- [Hosted decider (optional)](#hosted-decider-optional)
- [Idea for later: a small OCR reader plus the decider](#idea-for-later-a-small-ocr-reader-plus-the-decider)

**Words used here.** The *reader* is the vision model that turns a photo into data. The *decider* is the model that picks a category for each item. The *worker* is the program that does everything else. A *transaction* is a bank charge in Actual. *Dry run* changes nothing; *live* writes to Actual.

## How a receipt is handled

1. **Read**: the image is auto-rotated and downscaled (HEIC and up to 3 PDF pages are converted first). The reader (Qwen3.5-4B by
   default) returns the merchant, store clues, the date as printed, subtotal, tax, tip, total, payment method, cash handed over,
   whether it is a return, and the line items.
   - **Tax marks (only with `TAX_BY_ITEM` on, which is the default; see below).** For each item the reader also says whether the receipt marks it as taxed (a tax code such
     as T or A beside the price, or a tax column): yes, no, or unknown when the receipt prints no marks. It copies the mark as
     printed, keeping upper and lower case (`t` and `T` can be different rates). It also copies the receipt's printed tax lines
     (code, rate, the taxed amount if the line prints one, and the amount).
   - Codes are never interpreted: an F (or any letter) is read like every other code, by the reader's taxed yes/no or by the receipt's own printed tax lines. What a letter means differs by store.
   - First pass: the model answers directly, with thinking off. Letting it think gave the same results at 2.4 times the time
     ([research, section 1](research.md#does-reasoning-help-the-reader)). `LLM_THINKING=true` plus `READER_REASONING_BUDGET=1024`
     in `.env` turns it on.
   - If that answer isn't valid JSON or is missing fields, a second pass forces schema-valid JSON.
   - With the optional cloud reader there is a single structured-output request instead (see [Cloud reader](#cloud-reader-optional)).
   - **Cash and return receipts** go straight to review: there's no bank charge to match, and the worker never
     creates a transaction by itself (a cash purchase's page has a Create in Actual button, see Cash purchases below;
     cash items are categorized first so that page starts from real picks).
2. **Find the bank transaction.** Your bank sync has already imported the charge, so the worker does not create
   transactions here (only a cash purchase's page button does). It looks for exactly one match:
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
     again. **Check now** (under **Activity and test mode**, or `./receipts run-now`) re-checks right away. A **pending** charge is waited on until it clears, up to
     `MATCH_PENDING_WAIT_DAYS` (2) more days; after that it's applied and reviewed.
3. **Check the receipt.** Line items must add up to the printed subtotal (within 2%), and the date must be plausible. If prices already include the tax (items add up to the total, and subtotal + tax equals the total), that counts as adding up and no tax is added on top.
4. **Split.** The amount the bank charged, including any tip, is divided across the receipt's categories by
   line-item share. Tip and rounding are spread in proportion to those shares, so the parts always add up exactly to the
   bank amount.
   - **Tax goes to the taxed items (`TAX_BY_ITEM`, on by default; set it to `false` and the tax is always spread in proportion to the amounts).** When the reader saw which items are taxed, the printed
     tax is shared only between the categories of those items, in proportion to their taxed amounts, so untaxed groceries
     don't pay tax on taxed household goods. It is used only when the receipt adds up (a printed subtotal that the items
     match within 2 cents, and subtotal + tax + tip equal to the total within 1 cent), every purchased line has a yes or
     no (not needed when per-rate lines decide), at least one is taxed, and the tax is a believable rate of the taxed items: above 0 and up to `TAX_BY_ITEM_MAX_RATE` (12%).
     With one tax code (or none), the whole tax is spread over the taxed items. With several codes (two rates), the printed
     tax lines (for example `A 7.000% TAX 4.39`) decide: they must add up to the tax within 1 cent, each taxed item's
     code must match a line, and each line is spread over the items with its code. When the receipt prints per-rate
     lines, the items' yes or no is ignored: a code with a line above 0 is taxed, a code with a 0 line, no line, or no code
     is not. Codes are never interpreted (a letter means different things at different stores and states); they are only
     matched to the receipt's own lines: by the same code ignoring case (exactly, only when the receipt prints two lines whose codes differ only in case, like
     `t` and `T`), else (for a line and a code still unmatched; items without a code count as a candidate too) by the numbers: the code's taxed items equal the line's taxed amount within 2 cents, or the line is its printed
     rate of them. That must give one clear pairing; if a line fits two codes, or a printed taxed amount differs from its
     matched items by more than 2 cents, the tax is proportional. The yes or no is used only for receipts with a single `TAX 2.68` line. Lines with the same code are added up,
     a "total tax" line without a code is ignored, and a printed rate must fit the items within about 5%. Several codes
     with no lines, lines that don't add up or don't match the items, or a rate over the cap, fall back to proportional.
     A negative category (a coupon bigger than its items) counts as no taxed amount.
     When the items are over the printed subtotal by more than the check above allows (a coupon the reader skipped, or a line
     it invented; this correction is also part of `TAX_BY_ITEM`), the prices are not tax-included, subtotal + tax + tip equal the total, two or more coded tax lines make up
     the tax and every item has a code, each line says what its items should net (its printed taxed amount, else its tax over
     its rate). If exactly one group of items is over by the gap, the gap is taken off that group's items in proportion to
     their prices, so the items add up and the tax spread can run; several groups are corrected only when each line prints
     its taxed amount and all are over. The receipt still goes to review with a note saying so. Items under the subtotal,
     or anything unclear, change nothing.
     The reader also copies the total savings the receipt prints on a line of its own ("INSTANT SAVINGS $4.00", "YOU SAVED 3.20") into
     `receipt.savings` (a positive number, null when none; readings from before have no such field). When that equals the gap
     (within 1 cent), a discount line was almost surely missed. If the items that got a share of the gap are not all in one category,
     the split between categories may be wrong, so the receipt gets a `#review` doubt (it matters only when money would move, like
     the other item doubts); when they share one category the category totals are right either way and nothing is flagged. The receipt
     page shows, above the item editor, a notice saying how much the items were over the subtotal, which items the worker lowered, that
     this usually means a missed discount line, and what to do (set that item's amount, or use Add a line). The notice also says "The
     receipt shows savings of 4.00, which matches" when it does, and stays out of the way (no such sentence) for old summaries. It goes
     away once you type your own amounts for those items; the per-item "as read; lowered by ..." hint works as before.
     Otherwise, and for every reading saved before this existed (they have no marks), tax is spread in proportion to the
     amounts. The log says when tax was placed by item, or by rate. The receipt's page shows each item's tax mark after its price and one line under the totals saying how the tax was spread (per rate, over the taxed items, or in proportion with the reason); the worker saves it in the summary as `plan.tax`, and older summaries are explained again from the reading.
   - **One category, same as the transaction's:** nothing changes except a `#receipt` note.
   - **One category, different from the transaction's:** the transaction switches to the receipt's category, but only
     if at least one item is clearly sure about the new one (`MOVE_MIN_CONFIDENCE` and `MOVE_MIN_MARGIN`, see below).
     Set `OVERWRITE_CATEGORIZED=false` to send these to review instead.
   - **Charges filed under a category receipts don't use** (`EXCLUDE_CATEGORY_GROUPS` / `EXCLUDE_CATEGORIES`, such as
     bills, debt and savings, plus hidden and income categories) are never changed: the receipt goes to review.
   - **Discounts and coupons on a line:** a negative line that is clearly a discount ("TPD/1234567 -3.00", "INSTANT
     SAVINGS") is folded into the item it discounts before anything is categorized, so a discount can't land in a
     different category than its item and shift money between parts. If the line has an item number, the item showing
     that number is used (above it, else below it); a number that no item shows leaves the line alone, except a line that is only two item numbers (Costco's "0000390146 /1111161  4.00-", if the reader lists it) when no item shows any number (the reader drops them): it goes to the item above it, unless that item has another tax code. Without a
     number the line must read as a discount (words like coupon, savings, save, off, discount, promo, instant, TPD,
     MFR, or a %) and goes to the nearest item above it. The item's price drops by the discount and its note says so,
     like "CEREAL (pipeline: after 3.00 off)". The receipt total and the split still add up to the charge. Any other
     negative line (an exchange such as "MENS SHIRT -19.99", "GIFT CARD -20"), a whole-receipt coupon with nothing above
     it, a discount as big as the item, and returns stay a line of their own, as in the next point.
   - **A numbers-only line the reader gave a plus sign:** the reader is told that an amount with a minus after it ("5.00-") is
     negative. If it still returns a line of only item numbers ("0000394696 /56366") as a positive amount while the items are over the
     printed subtotal (beyond the tolerance above), the worker flips that line to negative, but only when that brings the items closer to the
     subtotal and overshoots it by 2 cents at most; the best candidate first, more than one only if each still fits (not on a return
     receipt, not without a subtotal, and not when the prices look tax-included: items near the total, or a gap equal to the tax). If, after
     the flip, the fold and the tax-line correction, the items still don't add up to the subtotal (2 cents), the receipt gets a doubt and so
     `#review`; if they do, no review is needed. The receipt page mentions a flipped line either way. It is then folded like any discount, `flippedSign` is saved
     on the item it went to, and the tax-line correction above may fix what is still missing (for instance a discount line the
     reader skipped completely).
   - **Returns and coupons:** a category whose items net negative (an exchange, or a coupon bigger than its items)
     becomes a credit part, and the receipt goes to review.
   - **Several categories:** the transaction becomes an Actual split, with one part per category. Each part's note
     lists its items, and the parent gets a `#receipt <file>` note.

**Write guard.** Categorizing can take minutes, so right before any write the worker syncs with Actual and reads the transaction again. If its
account, amount, category, notes or split changed since it was matched (you edited it, or moved it to another account, meanwhile),
or its account is no longer one the matching would search (not in `MATCH_ACCOUNTS`, closed or off-budget), nothing is written and the receipt goes to
`Needs review` with the problem "the transaction changed in Actual while the receipt was being processed; nothing was changed".
A split is never written onto a charge that has become a split. A dry run writes nothing and does not do this check.

If finding the transaction isn't clear-cut, nothing changes in Actual and the receipt goes to `Needs review` with a
JSON file that says why. That covers no match once the waiting time is over, a payee that doesn't match, two equally
good matches, cash and return receipts, and charges in categories receipts don't change. When the payee
doesn't match, the JSON lists the transactions that did match on amount and date, so you can see whether an alias is missing.

If the transaction is found but some items are doubtful, the confident part is still applied and the receipt goes
to `Needs review` too (`APPLY_THEN_REVIEW=true`, the default):
- Unsure items become an **Uncategorized** split part whose note lists them with the decider's guess, e.g. `MED-DVD'S (maybe Child 34%)`.
  If the store has a usual category, unsure items go there instead: the transaction's current category first (so a
  charge you re-filed by hand stays where you put it), then your rule's. Items moved there this way are listed as doubts.
- Other reasons a change is applied but reviewed: a tip or other extra amount, a charge dated the day before the
  receipt, a receipt with no readable date, a credit part, or a store whose every past purchase went elsewhere.
- Money the reader missed (items add up to less than the printed subtotal) goes to the store's usual category, or to
  the Uncategorized part.
- The parent's note gets a `#review` tag, so you can find these in Actual by searching for it.

Set `APPLY_THEN_REVIEW=false` to hold such receipts for review without changing anything.


## The web app, webhook and Actual link

The worker serves the web app (a small control panel) on port 8095. Every request needs the `TRIGGER_TOKEN` key (generated by
`./receipts setup` or `./receipts start`); `./receipts trigger-url` prints the link and the webhook URL.

- **Navigation:** the top tabs are **Inbox** (with a badge counting the receipts to review), **Archive** and **Settings**, with **+ Add receipt** beside them; phones get the same three tabs as a bottom bar. There is no More menu for navigation: Categories, Category rules, Learned corrections and Privacy (only with a hosted decider) live under Settings.
- **Inbox list:** receipts of the current mode (archived ones are left out) in three groups: **Review** (needs you, including "check it in Actual"), **Waiting** (for the bank charge, or being read) and **Filed** (collapsed; it opens by itself when you search or open a filed receipt). Every receipt that is not Done is always listed; only Done ones are capped
  (the newest 100, with a line saying how many older ones are not shown). Each receipt is one row with its name (store and total when known), a short status phrase ("Waiting for the bank", "Paid cash · not in Actual", "Filed"), a short time ("Today 7:17 PM", "Yesterday", "Nov 1") and at most one short line; tapping it opens the receipt's page. The search box filters all groups. On desktop the page opens on "Pick a receipt" (with **Open first in Review**); phones start on the list. Alerts show at the top of the list.
- **Activity and test mode:** the link at the bottom of the Inbox list opens the diagnostics: the Live / Dry run state, when the worker last checked, **Check now**, the results table with its filters and the legend of statuses, **Switch to dry run** / **Go live...**, and **Archive all done receipts...**. A check started there (or by the webhook or `./receipts run-now`) also re-checks receipts waiting for their bank charge, and returns you to Activity.
- **Uploading receipts:** **+ Add receipt** sends photos or PDFs picked on the device you are using
  (a phone offers the camera and the photo library) to the Nextcloud Inbox. It is the same as putting the files there yourself. Types are the
  Inbox's (JPG, PNG, WebP, HEIC, PDF), checked by name and by the file's first bytes (a HEIC is also recognised by its compatible brands), up to
  25 MB each. With JavaScript each file is sent in its own request, one after the other, with "Uploading 3 of 20..." and a result per file, so one
  bad or slow file never sinks the rest, and the check starts once at the end; without JavaScript the plain form sends up to 20 files (100 MB) in
  one request. A file that doesn't fit is turned away with a reason while the others still go in. A photo whose contents are a different supported
  type than its ending (a HEIC some phones call `.jpg`) is saved under the ending that fits (`.heic`), because the worker reads a file by its
  ending. Each file is written under a hidden temporary name (`.upload-<id>-<name>`, skipped by the inbox listing) and renamed when complete, so a
  half-written file is never read; leftovers older than an hour are deleted at the start of a check. Nothing is replaced: a taken name gets a time
  stamp before the extension (`IMG_20261105_101530-<stamp>.jpg`, so a camera date at the start of the name still counts), but the very same photo
  (same name and bytes) is skipped as "already in the Inbox". Names are cleaned (no folders, no leading dot, no control or direction characters, at
  most 150 bytes). One upload request runs at a time (the next one is asked to try again), and a check starts right away, also in dry run (you then
  get previews). Like the other buttons it needs the page key; because a form on another site could post to it, a request that the browser marks
  as coming from another site (`Sec-Fetch-Site`) is refused, while a request without that header (curl) is allowed.
- **Fixing item categories and amounts on a receipt's page:** when a bank charge was matched, the receipt's page (open a receipt from the list) shows an amount box and a category
  menu for each item (under **Items & categories**; **Set all items** sets every row at once) (Actual's spending categories; excluded ones are marked). **Preview** divides the charge again with the
  same code the worker uses (tax spread per category, tiny parts merged, `SPLIT_MIN_CENTS`) and lists the parts; it reads
  nothing from Actual. The button that writes is **Save changes** for a receipt the worker already applied (any result
  except `already-applied`, which was never read), or **Apply to Actual** for one in Needs review with nothing applied. When nothing was edited on a receipt that is only waiting for your confirmation, **Looks right** is shown instead of Save changes. **Looks right** only removes `#review` (and records the "confirmed" mark for learning); it has no Undo, in any of its forms (this one, the one on a charge changed in Actual, and **Looks right: clear #review and archive**). Its banner shows the plain Filed state, and an Undo request for it is refused.
  - *Amounts and added lines:* the amount box takes a decimal with at most 2 places (negative for a discount, up to 100000). Below the
    items, **Add a line** gives a blank row (description, amount, category and, when the receipt prints tax marks, a tax mark menu) for
    something the reader skipped; filled rows stay through Preview and a new blank row appears (up to 10 lines; no JavaScript needed).
    An added line is taxed with the mark you pick (default: the mark of the item above, else the most common mark; "none" is allowed),
    so the per-rate tax spread still works. The preview says whether the items add up to the receipt's subtotal (or total minus tax when
    there is no subtotal), green when within 2 cents and a warning otherwise; saving is allowed either way, because the bank charge is
    what gets divided. What you type is never changed: after your edits the tax-line correction runs again, but it only lowers items you did not edit (if there are none,
    or one would drop to 0, it leaves the gap). The "items add up" check counts the numbers in the boxes (as read for items you left alone, as
    typed for the others, plus added lines), and says when the worker had lowered items to match the subtotal. Added descriptions are cleaned (control
    characters, spaces) and may not contain `|` or `#`. If your edits would make one part bigger than the whole charge, the preview and the save
    refuse. An item whose amount you change loses the pipeline's notes on it ("after 5.00 off", the tax-line correction). The edits are kept in the
    summary's `pageFix.amounts` and `pageFix.added`, the preview token covers them, Undo restores them with the categories, and they
    are not lessons.
  - *Saving* re-reads the charge first and refuses unless it is still exactly what the worker (or your last save from the
    page) wrote: same amount, `#receipt` note, category or split. It then writes the new split (replacing the old one),
    or one category (removing the split), keeps the `#receipt <file>` note and its other notes, and keeps `#review` unless
    **Mark as checked** is ticked (it is, for `+review` receipts), which also moves the file to Processed. With splits off the
    largest part gets the whole charge and the breakdown goes in the note, as in a normal run.
  - *Applying* refuses if the charge is gone, has another amount, is split, is a transfer, already has a `#receipt` note, is in an
    account outside `MATCH_ACCOUNTS`, was filed in a hidden or income category, or had its category changed since the match. It
    overwrites a category your rules set (you chose to apply), writes the note, moves the file to Processed (never over another
    file) and records the receipt like a normal apply.
  - The preview carries a token over the receipt's state, your choices and the parts; the save recomputes all of it from the
    server's own records and refuses a stale preview (a double click, another tab, a changed setting). A save and a poll cycle
    never overlap: both hold one lock, so a save waits for a running check for up to 20 seconds, otherwise it says the worker is busy
    and changes nothing.
  - *Learning:* each item whose category you changed becomes a lesson (changed amounts and added lines do not) (the shape the sweep makes, marked `via: page`); an item you put
    back as the worker had it ends its lesson. The watch is replaced by what the page wrote, so the sweep does not learn your own
    change again, and a lesson made on the page survives the sweep unless you later change the same item in Actual. `LEARNING=off`
    writes none of this. A lesson you pressed Forget on is not made again.
  - *What Actual has now:* the page only knows the saved summary, so when you change a charge in Actual by hand it can look out of date.
    Each look at a watched charge (the learning sweep, every 6 hours) is kept in `MEMORY_DIR/seen.json`, bounded like the marks, not in
    the summary files: when it was seen, the items whose category differs from what was filed, a change the items can't be matched to (an
    amount, a restructured split, one category for the whole charge, the charge gone), and whether `#review` is still in the notes. On an
    applied receipt (live only) **Check Actual now** (POST `/receipt-check`: key, no cross-site requests, the session lock) opens Actual,
    reads that one charge, compares it the way the sweep does (or, when it is no longer watched, with what the worker or this page last
    wrote, as Save does), keeps the look and sends you back with a notice. It never writes to Actual. When Actual differs the item editor is
    locked (no Preview or Save): each changed item shows "Changed in Actual: ...", the page says "edit it there", and "Looked at Actual 2 h
    ago" shows. A Save from the page replaces the look (Undo puts the earlier look back), and a look older than the receipt's last change is ignored. Items are matched
    by their place in the receipt, so two items with the same name are told apart. A Save also refuses when a look newer than its preview found the charge
    changed, and when a child note of a split was edited in Actual. Lines added on the page are marked in the watch snapshot and are never lessons. With
    `LEARNING=off` the saved checks (not an old watch snapshot) decide, and a Save drops an old watch entry.
  - *Reviewed:* a receipt tagged `#review` counts as reviewed once `#review` is gone from the charge's notes in Actual, even when categories
    were changed too (the sweep and Check Actual now both apply this). It then shows as Done in the Inbox list and on the receipt page, and
    **Archive receipt** no longer needs to clear anything. This is separate from the learning marks: removing `#review` with no other change
    is still a *confirmation*, a change is still a *correction* (lessons and provenance read those). Nothing is written to `state.json` for it;
    the lists read the look. Archiving one from Needs review (one at a time or Archive all) reads the charge again first and refuses if `#review` is back, then drops `+review` from the result so a
    Restore leaves a Done receipt. (The automatic archiving does not read it yet.)
  - *Undo* (15 minutes, after Save changes or a cash Create; never after **Looks right**) puts the charge back as it was (category, notes, children) only if it is still exactly what the page wrote;
    otherwise it changes nothing. It also restores the receipt's entry and summary, takes back the lessons and the watch, and moves the file back
    (never over another file). In a dry run the page only previews.
  - The Actual API call that changes an existing split is not checked against the real package in the tests (they use a fake budget):
    after every write the charge is read back and compared, and old children that are still there are deleted; if it still isn't
    right the save stops and says to check the charge in Actual.
- **Dry run and live:** **Go live...** opens a confirmation page with a box to tick; **Switch to dry run** needs no
  confirmation. The switch is saved in `data/settings.json` and applies at the start of the next check (press
  **Check now** to make that right away). `./receipts mode dry|live` writes the same file and doesn't
  touch `.env`. Going live processes the receipts already seen in dry run again, for real. Switching to dry run in
  the middle of a check stops it before the next receipt. Once `data/settings.json` exists it is the switch and
  `DRY_RUN` in `.env` is ignored (the app, `./receipts mode` and the log say so when the two disagree); delete
  the file to go back to `.env`. A `data/settings.json` that can't be read means dry run.
- **Read again:** a button on the receipt page (under **More**) that runs the reader (the one configured now) on the stored photo once more, so an
  old receipt gets later reader improvements. It never writes to Actual and is not a correction (no lessons, no marks). The POST
  (`/receipt-reread`: key, no cross-site requests, the session lock) only sets `reread` on the state entry, checks that the photo still
  exists and starts a check ("Check now"); the page shows "Reading again..." until the check has done the slow part, so no web request
  waits for the reader, and a re-read never races a page Save (both run under the session lock). Read again is refused once a real save from the page exists (**Looks right** does not count, and has no Undo), so it never meets an open Undo. In the check:
  - *waiting for its charge, or a dry-run receipt:* the photo is still in the inbox, `isDue` treats the flagged entry as due, and
    `processReceipt` drops the saved reading and reads the photo afresh; the result replaces the old reading and the normal flow goes on
    as if it had been read that way the first time.
  - *filed and applied:* `rereadFiled` (reread.js) downloads the filed photo and runs the same steps as a first read (`settleReading`:
    date, cash total, flipped and folded discounts, tax-gap repair; then `categorizeReceipt` against the charge, with the same history,
    lessons and rules, read-only). Only the reading in the summary (`receipt`, `readWith`, `categorizedWith`, `historyUsed`,
    `totalCorrected`) is replaced, in the Nextcloud copy; the old reading is kept in `summary.reread.before`, and `summary.plan` (what
    Actual has) is left as filed, so the Save checks still compare the charge with what the worker wrote. The editor starts from the new
    reading; changing Actual is the usual Preview and Save changes. A Preview made before the re-read is refused as stale.
  - *in Needs review without a change to Actual:* not offered; **Try again** already reads it from scratch.
  The new reading's own doubts (a flipped line, items off the subtotal, uncertain items, a missed discount over several categories) are
  kept in `summary.reread.doubts` and shown as "About the new reading"; `summary.problems` stays as it was when the receipt was filed
  and the #review tag in Actual is never added or removed by a re-read (a later Save does that, as always). Every change of the reading
  gives the summary a new `reread.at`, the page's reading id: the Preview form carries it (`rid`), and a Preview link made for another
  reading is ignored with a message. "Changed in Actual" labels from before the re-read are matched to the new items by name. The date is
  judged against the original upload time (`entry.lastmod`, kept when the file is filed), not the filed file's time.
  **Use old reading** (POST `/receipt-reread-restore`, same protections) puts `summary.reread.before` back (or, for a waiting receipt, the
  `previousReading` kept on its entry, only if the same reader made it; a finished dry-run receipt keeps none) as long as nothing was saved from the
  new reading, the receipt is not archived and the charge is not locked. It writes nothing to Actual, learns nothing, gives the summary a new
  reading id and leaves Read again available. "Mark as checked" alone does not block Read again (it changes no item); a real saved fix does.
  A re-read that fails never costs the receipt what it has: a waiting receipt keeps its reading and its waiting state, and the failure ends in a note on the page (a timeout or a counted cloud failure is tried up to 3 checks, an unusable answer once). For filed receipts, a real outage of the reader (model server asleep) is not counted (but ends the request after 24 hours) and the model server being down skips the other filed re-reads in that check; a timeout on this photo counts as a try; a switch between dry
  run and live that is pending refuses the request, and flags left over from another mode are cleared with a note.
  It is refused (with a plain message, and again when the check gets to it) when a page fix is saved and not undone (the picks and
  amounts are numbered by item; Undo it first), when a look at Actual found the charge changed (the editor is locked), when the receipt
  is archived, and when the photo is gone. A reader that fails keeps the request for the next check, three failed checks drop it with a
  note on the page.
- **Try again:** shown for live receipts that went to `Needs review` without changing Actual (a review, or a receipt
  that failed 3 times). It moves exactly the file that was filed back to the inbox, deletes its `.json` and clears
  its entry, so the next check reads it fresh. It never overwrites: it refuses when the inbox already has a file with
  that name, when the worker or the `.json` says Actual was changed, or for entries from older versions that don't
  record where the file went. A receipt that was applied and then reviewed has to be undone in Actual first (see
  [Undoing a change](#details-and-limits)); then delete it from `Needs review` and upload it again.
- **Archiving:** so old photos and list entries stop piling up, a receipt you agree is right can be archived. Archiving only moves
  and shrinks files and slims the worker's own record; it never changes Actual (except for the case below). It is live only.
  - *What can be archived:* a **Done** receipt. On its page, **Archive receipt**. Under **Activity and test mode**, **Archive all done
    receipts...** opens a confirm page that says how many (at most 50 per press) and what happens. A receipt marked **Applied — check it
    in Actual** can be archived one at a time only, with **Looks right: clear #review and archive** on its page: that first removes `#review`
    in Actual and changes nothing else about the charge (its split and category stay exactly as they are; it refuses if the charge is no longer what
    the worker wrote), moves the file to Processed and then archives it; if archiving fails after that, the page says so and you can press the button
    again at once. Waiting, retrying, review, failed and dry-run receipts are refused. An explicit single **Archive receipt** is allowed immediately after a save or a cash Create, and it ends that save's Undo ("Undo for the last save is no longer available."). **Archive all** and automatic archiving still skip a receipt whose Undo window (15 minutes) is open. A **Looks right** has no Undo, so every kind of archiving treats it as finished at once. Bulk and automatic archiving never touch `#review` receipts.
  - *If the Archive folder clashes* with another folder (for example `RECEIPTS_PROCESSED=/Receipts` makes the default `/Receipts/Archive` sit inside
    Processed), archiving is switched off (manual, bulk and automatic) and the Activity page and the Archive tab say why; receipts are still processed and
    the folder can be fixed under Settings → Connections. The folder is created when the first receipt is archived, not at every check.
  - *Where it goes:* the photo and its `.json` move to `RECEIPTS_ARCHIVE` (default `/Receipts/Archive`), into a folder for the month of the
    receipt's own date (`/Receipts/Archive/2026-03`; the month it was filed in when the summary has no date). A name counts as taken when the file or its `.json`
    exists, and then gets a time stamp in front, as everywhere: no photo and no summary is overwritten. If the photo moved but its summary could not be
    written (after a second try) the receipt is still archived at the new place, with a warning. The `.json` gets an `archived` note (when, where from, how much the photo shrank).
    The archive folder may not be, or be inside, Processed or Needs review.
  - *Shrinking (`ARCHIVE_SHRINK_PHOTOS`, on):* JPG, PNG, WebP and HEIC photos are saved again as JPEG (ImageMagick; HEIC through
    `heif-convert`; turned upright, metadata removed, at most 2400 px on the long side, quality 82) and kept only when at least 10%
    smaller, else moved unchanged. The name keeps its base with `.jpg`. PDFs are moved unchanged. The photo is never lost: the smaller copy is
    uploaded, its size checked and its `.json` written before the original and its old `.json` are deleted; if any step fails the original
    is moved instead (and the log says why). The full-size photo is gone after a shrink; Restore brings back the small one. A photo that was
    already missing from Nextcloud still archives the entry; the receipt's page then says the photo was already gone.
  - *The worker's record:* an archived entry in `state.json` keeps only the result, times, `applied` (so a re-upload under the same
    name is still recognized), the archive path, an `archived` note and a small `card` (store, date, total). The reading, the decider's
    answers, the failure counters and the page-fix details are dropped; the receipt page reads the full summary from the archived `.json`.
  - *Automatically (`ARCHIVE_AFTER_DAYS`, 0 = off):* after each check the worker archives Done receipts whose time (when it was filed, or when
    it was restored, whichever is later) is that many days old, at most 20 per check. A failure on one receipt is logged and skipped.
  - *The Archive tab:* a two-pane page: a list pane (search, sort, and one row per receipt with its name, total, "Was Filed · Archived <date>" and an inline **Restore**) beside the selected receipt. The archived receipt opens read-only (photo, items, split and tax line) under an "Archived <date>" banner with **Restore receipt**; its categories can't be
    changed and Try again is not offered while it is archived. The 15-minute Undo of a category fix is ended by archiving and is refused afterwards, even after a Restore. **Restore** moves the photo and `.json` back to Processed (never over another
    file), removes the `archived` note and opens the restored receipt in its group in the Inbox list, where `ARCHIVE_AFTER_DAYS` counts again from the restore.
  - Learning is not affected: it reads Actual and its own files (`data/memory`), never `state.json` or the receipt files.
- **Times** on the page use `TRIGGER_TIMEZONE`, which setup sets to this computer's time zone.
- **Receipt view:** tapping a receipt in the list opens its page, with the photo (up to 3 pages of a PDF, which you can
  also download), what the reader read, the bank charge, how it was filed and why it went to review. The photo is
  fetched from Nextcloud only for receipts the worker has seen, never from a path in the link. Dry-run results are
  kept for this in `data/dry-summaries/` (the newest 200). The page shows the photo beside the reading and decision on
  a wide screen, and starts with the receipt's name, status and time, then one status banner with its actions (Try again, Archive receipt, Restore, or Looks right / Save changes) and a short plain-words
  explanation of what happened in Actual and what to do next (the reasons fold out under the banner; the full reading is under **Receipt details**, and less common actions under **More**). A waiting receipt shows only the banner, **Next receipt** and the photo. After a save (Save changes or a cash Create) the banner reads "Saved" with an **Undo** button, and the list row says "Saved · Undo", for the rest of the 15 minutes even if you leave the receipt and come back; the Undo is hidden while a switch to dry run is pending. After **Looks right** the banner shows the plain Filed state, with no Undo. **Next receipt** (also the left and right arrow keys, except while typing in a field) walks through the receipts of the group you opened it from (Review, Waiting or Filed), in the order the list had, and never leaves that group; the group, the search and the sort are added to the receipt links by the page's script and the server works out the order
  from them (without JavaScript there is no search on the list, so the default newest-first order is used). The back link (**← Review**, or the group's name) returns to the list and scrolls to the receipt. **Try again** is on this page
  too, under the same rules as in the list; after it succeeds you land on the next receipt. The page ends with a
  collapsible **How this page works**.
- **Undo:** removing a keyword, a private word or place, marking something "Not a name/place", or saving over a
  category description shows an **Undo** button in the notice. It puts back exactly what was there, including a
  keyword's original date and source. Only the last change can be undone, within 15 minutes. A description that has
  been changed again since is not overwritten.
- **Sorting and filters:** click a column heading to sort (again to reverse). Each table has a filter box; the Activity
  page also filters by result, the keywords page by category, and the categories page can show only drafts. This
  needs JavaScript; without it the pages still work, unsorted.
- **Categories** and **Keywords** (under Settings): edit the category descriptions and add or remove keywords (see
  [Category descriptions](#categorizing-offline-mode-and-replay-tests) and [Keywords](#keywords)). Changes apply
  at the next receipt, without a restart. The Categories page lists every spending category from Actual (the worker
  keeps the list from its last check in `data/known-categories.json`), with an empty box for one that has no
  description yet. **Exclude group** and **Exclude** keep receipts out of a group or category; the **Excluded**
  section at the bottom has **Include again**. These write `EXCLUDE_CATEGORY_GROUPS` and `EXCLUDE_CATEGORIES` as
  settings (below), with **Undo**.
- **Settings:** the **Settings** tab opens an overview that links to a page per section: Everyday, Matching and review, Categories, Category rules, Learned corrections, Connections, Appearance and Advanced (plus Privacy when the decider is hosted). Each section page has "← Settings", saves on its own and returns to the same section with its notice and **Undo** (an Undo keeps values you typed but have not saved); **Done** returns to where you came from, such as the receipt you were editing, with its unsaved edits intact. The settings are the same as in `.env`, grouped as in `.env.example` (Connections, Matching, Categorizing,
  Behaviour, Holidays and gift meals). The everyday ones are shown first: Connections (Actual, Nextcloud and the four
  folders: Inbox, Processed, Needs review and Archive), `MATCH_ACCOUNTS`, `OVERWRITE_CATEGORIZED`, `SPLIT_TRANSACTIONS`, `SPLIT_MIN_AMOUNT`, `APPLY_THEN_REVIEW`,
  `POLL_SECONDS`, `TRIGGER_TIMEZONE`, `OCCASIONS` and `GIFT_MEAL_MIN`. The tuning ones (match windows and tolerances,
  confidence bars, the **Keywords and learning** section, history) sit under the **Advanced** section. Saving one form never touches the other's values. Each with its help line, its current value and where
  that comes from. A value saved on the page goes into `data/web-settings.json` (a JSON object of `.env`-style
  strings, mode 600) and wins over `.env`; **Use the .env value** removes one, **Reset all to .env** all of them. The
  worker re-reads `.env` plus that file at the start of every check and updates its settings in place, so no restart
  is needed (a different `POLL_SECONDS` is used for the wait after that check). A value is checked as `.env` values
  are, with the same ranges and spellings, before it is saved, and a bad one saves nothing. If the rebuild fails
  anyway the earlier settings stay in force and the app says why. A file that can't be read is ignored with a
  warning, and the page refuses to save until you press **Reset all to .env**. Before a change to the Actual or
  Nextcloud address, user, password or the inbox is saved, it is tried (a login to Actual over HTTP, a listing of the
  inbox over WebDAV, each with a separate connection, 15 seconds at most); if the test fails nothing is saved unless
  you tick **Save even if the connection test fails**. Passwords are never shown (only "set" or "not set"); an empty
  password box keeps the current one, and **Undo** keeps an old password only in the worker's memory, for 15 minutes.
  `./receipts exclude` writes `.env`, so it also removes its two keys from `data/web-settings.json`; what cannot be
  changed here (models, providers, API keys, `TRIGGER_TOKEN`, `DRY_RUN`, paths) stays in `.env`.
- **Appearance:** under Settings → Appearance, **Theme** (System, Light or Dark) and **Accent** (Blue, Teal, Violet, Rose or Graphite). They are stored per device, in the browser (not in `data/` or `.env`), and apply at once. If the browser blocks storage, the app falls back to System and Blue.
- **From Actual:** notes on the budget page support Markdown, so a link there works as a button without changing
  Actual. Paste `[Receipts](<app URL>)` into a category or group note.
- **From your phone or the Nextcloud server:** the page only listens on this machine by default. Set
  `TRIGGER_BIND=0.0.0.0` in `.env` and run `./receipts restart` to reach it from your network.
- **Keep it private.** The page is plain HTTP and the key is in the link, so keep it on your own network and don't
  share the link. Anyone who has the key can check the inbox, see recent receipts and their photos, go live, retry
  receipts, and edit descriptions, keywords and the privacy lists.
- **Nextcloud webhook (optional):** the Webhook Listeners app (admin only) can call `POST /run` when a file is
  created in the inbox, using a `NodeCreatedEvent` listener filtered on the folder path. Nextcloud sends webhooks from
  background jobs, so without dedicated webhook workers it's often no faster than the regular poll (`POLL_SECONDS`, 5 minutes by default).

**Actual upgrades.** With `ACTUAL_API_VERSION=auto` (the default in `.env.example`), the worker installs the
`@actual-app/api` version your Actual server runs when it starts (this needs internet once per Actual version),
caches it in `data/actual-api`, and falls back to the version built into the image if it can't. After you upgrade
Actual, the worker notices within about 10 minutes, restarts itself and installs the matching version. If that
install fails it keeps the old one and says so in the app instead of restarting again. With a pinned version
instead, set `ACTUAL_API_VERSION` to the new version and run `./receipts update`. The API must match the server.

## Details and limits

- **Dates.** The reader copies the purchase date as printed, and the worker parses it (US month/day; day/month only
  when the first number can't be a month). Return-by dates, future dates, and dates more than 400 days before the
  upload are ignored. When the file name starts with a camera or app stamp that has a time
  (`2026-11-05_101530.jpg`, `2026-11-05 10.15.30.jpg`, `20261105_101530.jpg`, or that after `IMG_`, `IMG-`, `PXL_`, `VID_`,
  `Screenshot_`, `Screenshot-`, `signal-` or `PHOTO_`) and the day is within 31 days before the upload, the earlier of that
  day and the upload time is the reference, and a printed date after the photo day is ignored as a misread. Other names
  (`Order_2026-10-01.pdf`, a statement's date range) are never used. The receipt page shows "Purchase date used" (what the
  worker settled on, or why there is none) next to the "Printed date".
- **No readable date.** The worker looks for the charge in the `MATCH_NO_DATE_RECENT_DAYS` (14) days before the
  upload. A match there is used, and anything that moves money is reviewed. If the only match is older (up to
  `MATCH_NO_DATE_LOOKBACK_DAYS`, 365), nothing is applied: the review JSON names that charge so you can check it.
  When uploading a backlog of old receipts, raise `MATCH_NO_DATE_RECENT_DAYS` for that batch.
  Exception: when the recent days hold no charge at all and the wait for the real charge is over (`MATCH_DAYS` + 1 days
  after the upload), the worker also searches back `MATCH_NO_DATE_EXTENDED_DAYS` (120, 0 = off; it must be more than
  `MATCH_NO_DATE_RECENT_DAYS` and at most `MATCH_NO_DATE_LOOKBACK_DAYS`, otherwise the Settings page refuses it and a
  conflicting `.env` turns it off with a warning). It is skipped if any charge of that amount (tip allowance included)
  shows up from the recent window through the end of the normal search window. Exactly one exact-amount charge must have
  a payee that fits the store, and no other candidate (tip-sized ones included) may have a fitting payee. The match is
  applied but always tagged `#review` and filed in Needs review, even when it only confirms a category.
  The receipt page shows the older-charge hint on a waiting receipt.
- **Store names.** Store names can also match through clues on the receipt, such as `target.com`, when the logo is
  cut off. Only website/email domains and multi-word business names count as clues, never a city, and a clue scores
  lower than the store name. History is looked up by the bank's payee name.
- **Your Actual rules.** The worker reads your rules (read-only) and works out which category they give the matched
  transaction, following Actual's own order and specificity. Checked against six months of transactions, it agreed
  93% of the time; the rest were ones you re-filed by hand. It understands split rules (only whole-transaction
  categories count), "approximately" amounts, regex, "contains" on payee names, tags and on/off-budget conditions;
  recurring-date conditions are treated as not matching. The decider is told the store's rule category. Items it is unsure
  about (under `CATEGORY_MIN_CONFIDENCE`) stay in the store's usual category (`UNSURE_ITEMS_USE_STORE_CATEGORY`), so
  only confident items are split out. Generated category descriptions also list the stores your rules send there.
- **How sure the decider is.** For each item the decider gives a probability for every category. The item's
  *confidence* is the probability of the category it chose, and its *margin* is how far that is ahead of the best other
  category (negative if another category is ahead, which fails the margin gate). If an answer comes
  without usable probabilities (a decider that sends none, or none for the chosen category), its reported
  confidence is used and the margin is unknown. The hosted decider's probabilities are mapped back to category names
  and used the same way. Keyword-filed items have confidence 100% and no margin.
- **Moving items out of the store's category** needs two things: `MOVE_MIN_CONFIDENCE` and a margin of at least
  `MOVE_MIN_MARGIN` (default 0.2), so a near tie never moves money. An unknown margin passes. Staying in the store's
  category needs only `CATEGORY_MIN_CONFIDENCE`. These two settings apply only when there is a store category to fall
  back to (`UNSURE_ITEMS_USE_STORE_CATEGORY`, and a rule or current category for the store). `MOVE_MIN_CONFIDENCE` defaults to 0.6 (never
  lower than `CATEGORY_MIN_CONFIDENCE`, the bar for staying).
  If real splits you want end up as single-category confirms, lower them. In testing, 0.6 with a 0.2 margin was the best
  setting and lower bars split out more wrong items ([research, section 7](research.md#7-confidence-as-a-probability-re-tuned)). `replay` and `item-test` save each
  item's probability and margin, so you can re-try thresholds offline once you have more receipts (see Replay tests).
- **Is it all one kind of purchase? (`RECEIPT_CHECK`, on by default).** Without it, a food-court visit (a Coke, a chicken bake, chicken strips) could split three ways, because
  every item is judged alone. So the decider is asked one more question per receipt (receipts with at least two items that keywords didn't all file): which single
  category fits the whole purchase, with a probability for each category, from the same `/v1/systemone` endpoint (and, with
  the hosted decider, as one more anonymized request). If that answer is confident (its probability reaches
  `RECEIPT_CHECK_MIN_CONFIDENCE`, default 0.5, the same bar as `CATEGORY_MIN_CONFIDENCE`: a coin flip is not an answer), an item
  whose own pick differs from it keeps its pick only if the pick clearly wins: it must pass the move gate
  (`MOVE_MIN_CONFIDENCE` and `MOVE_MIN_MARGIN`) and lead the receipt's category by `MOVE_MIN_MARGIN`. Every other item takes
  the receipt's category, with the receipt answer's probability and margin. After that, everything works as usual:
  - **The store's usual category:** "keeps its pick" means passing the gate the item will face anyway: only
    `CATEGORY_MIN_CONFIDENCE` if its pick is the store's category (or there is none), the move gate otherwise, plus the
    lead over the receipt's category. So snacks the decider is 58% sure are Groceries stay in Groceries even when the
    receipt answer says Home. A pulled-in item leaves the store's category only if the receipt answer itself clears the
    move gate; otherwise it falls back to the store's category like any unsure item. An item pulled into the store's own
    category counts as a store default (noted "(store default)", not learned from as a pick).
  - **Recategorizing the whole charge:** the receipt answer counts as the confident evidence the move needs, so a
    $13.78 food-court charge filed under Groceries by your rules becomes Restaurants when the receipt answer is sure.
    When no single item picked the new category by itself, the receipt also gets a review note saying the move rests on
    the whole-purchase answer alone.
  - **`always` keywords** still win and are never pulled. **`usually` keywords** are hints to the model; an item they
    steered is judged like the others, by its numbers after the hint.
  - **A real mixed run still splits:** items the decider is clearly sure of (a household item at 80%) keep their own
    category; only the unsure ones join the receipt's.
  The log shows the answer ("whole purchase: Restaurants 75%, 55% ahead of the next; pulled into it: …"), and the replay
  rows carry it (see Replay tests). `RECEIPT_CHECK=false` turns it off, so the effect can be compared with a replay.
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
- **Cash purchases** have no bank charge, so they go to review (the reason says to use Create in Actual on the receipt's page, or Archive if you entered it by hand). The worker never creates a transaction by itself; it does so only when you press a button on the receipt page, never in dry run:
  - The receipt is read and its items categorized as usual (a cash purchase has no bank payee, so the store name on the receipt is used). The page shows the item editor (categories, amounts, Add a line, the missed-discount notice) plus an **Account** menu that starts from the **Cash purchases go to** setting (`CASH_ACCOUNT`, one of the open on-budget accounts Actual had at the last check, empty = not set; Create is refused with no account).
  - **Preview** (a GET) looks at Actual read only, under the session lock for a moment (it says so when the worker is busy): the account, the payee (an existing real payee that fits the store by the same name match as bank payees, else a new one named like the merchant, created only on Create), and any transaction in that account for exactly the receipt total as an outflow within 3 days of the purchase date that carries no `#receipt` note. The preview shows the parts as a matched charge would get them (allocate, mergeParts, tax per item or rate), what it found, and is covered by the token together with the account and the transactions found, so the button refuses if any of that changed.
  - **Create in Actual** (POST `/receipt-cash`, action `create`; key, no cross-site requests, session lock) adds one transaction: the receipt total as an outflow (the purchase date used, cleared), one category or a split parent with children, notes as the worker writes them on matched charges (`#receipt <file>` plus the items for one category, the parts' notes on a split, `#review` when part is Uncategorized or the items don't add up). Actual runs its rules even with `learnCategories`/`runTransfers` off. The worker saves the planned transaction ID before adding it and records success before reading it back. If a rule changes the categories or split, the worker restores the previewed split and says so. A retry uses the recorded ID instead of adding another transaction. If the earlier add is present, the worker finishes recording it automatically. If it is absent after a full lookup, Preview offers **Retry creation after lookup**, using the original transaction ID. It also lets you keep an existing purchase unchanged. A purchase edited in Actual can be kept through the read-only recovery action. Older interrupted records are recovered from surviving summaries without guessing past item edits.
  - If a transaction of the same amount was found, the preview offers **Split this one instead** for an entry that is not already split (action `split`): it is treated as the matched charge and goes through the same Apply as a charge in review (all its guards: not already split, not a transfer, not pending, allowed category, account in MATCH_ACCOUNTS), and **Create a new one anyway** stays as the second choice.
  - Either way the receipt is filed as an applied one: the entry gets `applied` (`created: true` for a new transaction) and `fixedOnPage`, the summary gets `transaction`, `plan` and `pageFix`, the file moves from Needs review to Processed (Review with `#review`), and the learning watch and lessons work as for any page fix (category picks become lessons; amount edits and added lines don't). It shows as Done, **Check Actual now** and Save work on it, and it can be archived.
  - **Undo** (15 minutes) deletes the created transaction (its parts first), only while it is still exactly what was written (otherwise nothing is deleted), and moves the receipt back to Needs review with its earlier summary (no transaction). Undo of a split onto an existing transaction puts that transaction back as it was and unlinks the receipt.
  - **Undo** deletes a created transaction only while its date, payee, account, amount, notes and categories still match and it has not been reconciled. It also works if Nextcloud failed to save the new summary. Uncleared entries can be split through the cash page in the chosen account; ordinary bank matching keeps its pending-charge check.
  - **Archive (I entered it by hand)** is offered on the page for cash and refund receipts in Needs review only (`noChargeKind`); the reason ("cash, entered by hand") is kept with the archive entry, the Archive tab shows the store, date and total, and Restore puts such a receipt back in Needs review, not Processed.
- **A charge changed by hand in Actual:** **Looks right: clear #review and archive** only needs the same transaction, its amount, the amounts of its parts (as written) and the `#receipt` note: categories and part notes you changed are left alone, only the parent's `#review` is removed, the editor stays locked after archive and restore, no "confirmed" mark is recorded (the learning sweep still judges the change from the watch). If the amounts changed or the note is gone it is refused, and **Archive: keep what's in Actual** files the receipt without opening Actual at all (the result loses `+review`; the watch is kept). A flagged charge whose notes no longer contain `#review` counts as reviewed (Done), also when the `#receipt` note was removed too (`judge` and **Check Actual now** both say so; the sweep does not learn from a charge whose `#receipt` note is gone). A re-read changes nothing in Actual, so it never makes a look at Actual stale. A locked page shows each item's category as Actual has it (the changed item, else the part it was filed in), never the new reading's pick, and "Category now" says Split for a split.
- **Small parts:** split parts under `SPLIT_MIN_AMOUNT` (default 1.00) are folded into the transaction's current
  category, or into the largest part. The Uncategorized part and credit parts are never folded into a category.
- **Outages and restarts.** If a model, Actual or Nextcloud is down, the poll stops and retries later; outages never
  count toward a receipt's 3 attempts. (A cloud reader or hosted decider has one narrow exception: a request that may have
  been billed and failed on this receipt is counted, see Cloud reader.) On stop or restart the worker finishes the receipt it's on (3-minute grace
  period). If it crashes after changing Actual but before moving the file, the next poll recognizes the `#receipt`
  note and only moves the file. Half-uploaded (`.part`) and empty files are skipped. If `data/state.json` (the
  worker's memory of which receipts it has seen) is damaged, every check fails with a message saying so (in the log)
  instead of quietly starting over. Restore it from a backup, or delete it: receipts already applied are recognized
  by their `#receipt` note and only moved.
- **Durable filing.** Before moving a photo, the worker saves its intended destination, file version and full summary. If MOVE or summary PUT succeeds but its response is lost, the next check verifies the destination and finishes the same operation. Recovery also runs when Inbox is empty. A new upload under the old filename is kept separate. Page saves and cash creation retain their intended summary until Nextcloud confirms it; a restart or expired Undo window does not discard it.
- **Nextcloud deadlines.** Every WebDAV request has a 30-second cancellation deadline. Existing photo/summary reads for the panel retain their shorter 15-second deadline. These failures are service outages, so they do not consume a receipt's reading attempts.
- **Cash totals.** The worker only substitutes subtotal plus tax and tip when the read total equals the recorded cash tendered and exceeds the computed purchase total. The receipt page shows the original and substituted amounts. Without that evidence, it keeps the read total for review; an explicit corrected total is always kept.
- **Stale edits.** Cash previews cover the full candidate transaction snapshot. Automatic matching checks date, payee, account, amount, clearing, reconciliation, transfer and split status again before writing. Undo of an existing charge also checks the saved identity. Older saves without that identity cannot be undone by the page. Try again shares the session lock with page saves and cannot discard an uncertain cash intent.
- **Model request timeouts.** Every request to a model has its own time limit: 10 minutes for a reader (local or cloud), 5 for the
  local decider and 2 for the hosted decider. (Node's built-in limit of 300 seconds is raised to just above these, so the limits
  here are the ones that apply.) A request that runs out of time counts as a timeout of the pipeline's own, and so does a
  low-level header or body timeout from the network library.
- **Re-used file names.** The state keys a receipt by file name plus etag, so a different photo uploaded under a name used
  before is a new receipt. The `#receipt <file>` lookup that recovers from a crash always runs, but a tagged transaction
  that the state already records as applied for another upload under the same name is left out: it belongs to the earlier
  photo. Of what remains: none means a new receipt, matched and filed normally; one is this photo's own crash, so it is filed
  as already applied (and the same photo uploaded again under the same name is found this way too, instead of being filed
  onto a second charge); several mean the state can't say which belongs to this photo, so nothing is guessed: the receipt
  goes to review and names the transactions.
  The tag only counts when the file name is followed by the end of the note or by what the worker itself writes after it
  (` #review`, ` — items: ...`, `: ` and ` | `), never by a bare space and more text: file names can contain spaces, so
  `#receipt a.jpg scan.jpg` is the tag of `a.jpg scan.jpg`, not of `a.jpg`.
- **Replaced photos.** The listing's etag goes with the download and with the move out of the inbox as an `If-Match`
  condition (Nextcloud answers 412 when the file is no longer that version). If the photo was replaced before it was
  read, nothing is read and no attempt is counted; the new file is a receipt of its own at the next poll. If it was replaced
  after Actual was written, the old version's change stays recorded as applied (so it is not applied again, and the re-used-name
  rule above lets the new photo know that transaction belongs to the old one), the new file is not moved, and it is
  processed at the next poll. A move retried later uses the same listing etag, so it can never move a newer file.
- **Private files.** Everything the worker writes under `data/` (state, privacy word lists, learned data, notes files) is created
  `0600` in `0700` folders. At start the worker repairs the permissions of what is already there, and `./receipts` creates `data/`
  with mode 700. The worker and each one-off script set `umask 077` before anything else loads, so files made by other code
  (the Actual API installs under `data/actual-api`, npm's cache, the budget cache) are private too. Only the worker container
  mounts `data/`, and `models/` (read by llama.cpp) is never written by the worker, so nothing needs to be readable by another user.
- **GPU sharing and other GPUs.** Both models together use about 8.3 GB of VRAM, or 7.4 GB with `compose.small-gpu.yaml`
  (about 5.1 GB with that file and `DECIDER_GPU_LAYERS=0`, which runs the decider on the CPU). If another app is using
  the whole card, start this first or stop that app. AMD and Intel use the default Vulkan images (`RENDER_GID`, which
  setup fills in); NVIDIA uses `compose.nvidia.yaml`. Setup picks these for you. See
  [docs/research.md](research.md#hardware).
- **The models sleep when idle.** After `MODEL_SLEEP_SECONDS` (default 300) with no requests, each model unloads
  itself and frees its graphics memory; the next receipt wakes it in a few seconds. Health checks don't wake it. The
  containers stay up, so nothing has to start or stop them. A request to either model wakes it, including the decider's
  `/v1/systemone`. `-1` keeps them loaded all the time. **On a shared GPU, set `MODEL_SLEEP_SECONDS=-1`:** while a model
  sleeps its memory is free, so another app can take it, and then the reload fails when the next receipt arrives.
- **No GPU.** Setup notices and sets `LLM_GPU_LAYERS=0`, `DECIDER_GPU_LAYERS=0` and `compose.cpu.yaml` in `.env`, so
  both models run on the CPU (slower, but receipts aren't urgent). If it later finds a GPU, it offers to undo that.
- **Reprocess a receipt:** for a live receipt in `Needs review` that changed nothing in Actual, press **Try again** on
  the receipt's page. Otherwise undo the change in Actual (restore the category or remove the split, and remove the `#receipt` note), delete the file from `Needs review` and upload
  the receipt again. Don't move it back by hand: the worker remembers each file by its name and version, so a moved
  file may be skipped, while a new upload is a new receipt.

## Categorizing, offline mode, and replay tests

- **Two models, two jobs.** Qwen3.5-4B (`llm`, or the model in `READER_LOCAL_MODEL`) reads the receipt. The decider (`decider-gguf`, on llama.cpp; the
  model in `DECIDER_MODEL`) picks a category for each item with a probability for each category. Items under
  `CATEGORY_MIN_CONFIDENCE` are settled as described above: the store's usual category, or an Uncategorized part for
  you to fill in, and the receipt goes to review if that moves money.
  (Why not the reader for this step too? See [research, section 2](research.md#2-item-categorizers).)
- **Which decider.** Setup asks between d1-2B (`LiquidAI/d1-2B-GGUF:Q8_0`, about 2.7 GB of GPU memory) and vLLM
  d3-flash 9B (`ggml-org/vllm-d3-flash-GGUF:Q4_K_M`, about 6.8 GB, with `DECIDER_CTX=8192 DECIDER_BATCH=4096`), and
  suggests d3-flash when the card has 14 GB or more. d3-flash splits out more of the right items (95.8% vs 90.9% on the
  test receipts); details in [docs/research.md](research.md). Without setup the default is d1-2B. `DECIDER_MODEL` in
  `.env` takes any other `/v1/systemone` GGUF model, which `./receipts download-models` fetches into `./models`.
- **Holidays and gift meals.** Holidays near the purchase date (computed locally) go to the decider as a gift hint.
  Reading birthdays from your Nextcloud calendars is possible (`OCCASIONS_CALENDAR=true`) but off by default.
  A restaurant charge over `GIFT_MEAL_MIN` ($50) is applied as usual but sent to review: it may be a gift meal.
- **What the decider sees for each item:**
  - the item name, with store department codes like `MED-` / `BED-` removed (`STRIP_DEPARTMENT_PREFIXES`)
  - the other items on the receipt
  - how you filed past purchases at the same store. Purchases the pipeline filed itself and nobody confirmed or
    changed are listed apart, under `past_purchases_filed_by_the_pipeline_unchecked` (or a part is tagged `[filed by
    pipeline, unchecked]` inside a purchase you partly changed), because they only repeat its own earlier guesses
  - the category your Actual rules give this store for this charge. Rules that depend on the amount (say, Costco
    charges of $11.00 or less go to Restaurants) still pick that category, and the transaction's current category,
    but the amount ranges themselves are not sent: a threshold you set isn't evidence about the items, and on a
    $13.78 Costco charge the rule's "over $11 → Groceries" argued for the wrong category
  - with `SIMILAR_ITEMS=true`, up to 8 past items from any store that share words with this one, and how they were filed, with a per-category count (`similar_items_by_category`). Items the
    pipeline filed unchecked are shown with `filed_by: pipeline, unchecked` and are left out of that count
  - the newest item notes per category from your past splits, from any store (for example "Egg Book → Child", "DC Charger → Electronics"). `HOUSEHOLD_EXAMPLES` sets how many per category (default 5; 0 sends none).
    Unchecked pipeline entries can fill at most half of a category's room and end with `[filed by pipeline, unchecked]`
  - only the spending categories: bills, debt and savings are hidden (`EXCLUDE_CATEGORY_GROUPS`, `EXCLUDE_CATEGORIES`; set them with `./receipts exclude`)
- **Category descriptions (`data/category-notes.json`).** The decider chooses among these descriptions, so they're how it
  learns household knowledge, such as what goes to each person's category or to the kids. Edit them on the status
  page's **Categories** tab (excluded categories are not listed there); changes apply at the next receipt, without a restart.
  - When a spending category has no description, the worker has the reader model write one from that category's past
    transactions (stores, your item notes, amounts). This happens before each batch of receipts (not with a cloud reader), or on demand:
    `./receipts describe` (add `--refresh` to rewrite only the auto ones).
  - Written entries are marked `"auto": true` (shown as drafts on the Categories page). Review them, and rewrite any in
    your own words. Saving one on the Categories page marks it as yours; in the file, replace the entry with a plain string
    or delete the `"auto"` flag. Yours are never overwritten.
    See `category-notes.example.json` for both forms.
- **Plain-language item names (`READ_PLAIN_NAMES`) are off.** In testing, the reader decoded "MED-CHILD PIC" (children's books) as "child milk".
- **History gets better when you check it.** Splits the pipeline makes list their items in each part's note, and
  later receipts from the same store can see them, but as pipeline picks nobody has confirmed: they are labeled
  that way to the decider and never counted in its per-category tallies, so the pipeline can't vote for its own
  earlier guesses. They become your choices when you confirm them (remove `#review`) or change them. When you split by
  hand, a few words in each part's note (such as "DVDs") help the same way and count in full.
- **Offline.** `llm` loads its model files by path and `decider-gguf` runs with `--offline`, so neither contacts
  Hugging Face. `./receipts download-models` (and setup) fetch the models: for the decider it starts `decider-gguf` once
  without `--offline`, then puts it back offline. To use a different decider, set `DECIDER_MODEL` in `.env`, run
  `./receipts download-models`, then `./receipts restart`.
- **Replay tests** compare the pipeline with purchases you've already categorized or split, without changing anything.
  Upload those receipts to a Nextcloud folder such as `/Receipts/Test`, then run:
  ```
  ./receipts replay --nextcloud "/Receipts/Test"
  ```
  `--only 212537,212930` limits it to files whose names contain those strings. You can also pass a single file from `./data` (`/data/receipt.jpg`).
  New readings are saved to `data/research/readings/<name>.read.json`; `--readings <folder>` re-decides every saved reading in a folder (files ending `.read.json`, and the older `.lfm3-read.json`, are accepted), and `--receipt /data/research/readings/x.read.json` reuses one. To compare deciders, set `DECIDER_MODEL` in `.env`, run `./receipts download-models` and `./receipts restart`, and replay the same `--readings` folder. Test output goes to `data/research/`.
  Every replay also writes `data/research/replay-items.json` (or the file named by `--items-out`): one row for each
  item with the decider's `pick`, its `topProbability` and `margin` (before any fallback to the store's category), the
  `filed` category, and whether it `fellBack`. The pick and its numbers are the decider's own, taken before the fallback
  to the store's category. When a keyword hint changed the answer, `modelPick`, `modelTopProbability` and `modelMargin`
  hold the model's own, and `keywordTooWeak` shows a keyword that was tried and rejected. Use it to sweep `MOVE_MIN_CONFIDENCE`, `CATEGORY_MIN_CONFIDENCE` and
  `MOVE_MIN_MARGIN` offline without running the models again. `item-test` rows (`data/research/item-test-<name>.json`)
  also carry `confidence` (the top probability) and `margin`. With `RECEIPT_CHECK`, every row also has `receiptPick`,
  `receiptTopProbability` and `receiptMargin` (the whole-purchase answer; null when it wasn't asked),
  `itemProbabilityOfReceiptPick` (the item's own probability for that category) and `pulledByReceipt`, so
  `RECEIPT_CHECK_MIN_CONFIDENCE` can be swept offline; the per-receipt answer is also in the saved receipt JSON as
  `receiptCheck`. For `item-test` the row's `pick` is the item's category after the check (`receiptPick` and `pulledByReceipt`
  say what it did).
  - **They don't see the future.** The history ends the day before the purchase date, for a replayed receipt, an
    `item-test` transaction and the live worker alike (the receipt's date, or for an undated receipt today, or in a replay
    the transaction's date), and `HISTORY_DAYS` counts back from there, not from today. That applies to the store history and
    the item notes. With `--with-memory`, the lessons are cut to those the sweep had learned by that day (each lesson
    records the day it was learned; older ones fall back to the transaction's date, a lesson merged from several has its
    newest day), and the learned keywords are rebuilt from those lessons instead of read from the file. The live worker
    does not cut lessons: it uses everything it has learned. **What still leaks:** Actual keeps no edit times, so a note
    on an earlier purchase that you wrote or changed after the purchase date is seen as if it had always been there. Your
    own keywords, `#always` tags, category descriptions, Actual rules, payee names and the holiday list are today's.
    A replay of an old receipt is therefore somewhat optimistic wherever those helped.
  - **Re-reading the photos (to test the reader).** `./receipts replay --nextcloud "/Receipts/Test" --save-readings
    /data/research/readings-new` reads every photo with the reader as it is configured now and writes each reading to
    `data/research/readings-new/<name>.read.json` (without `--save-readings` they go to `data/research/readings/`, replacing
    earlier ones of the same name, so save them somewhere new to keep the old ones). `--only 212537,212930` limits it to some
    receipts, and a single local file works too (`/data/receipt.jpg`). Then decide from either folder without reading
    again: `./receipts replay --readings /data/research/readings-new`. To see what the per-item tax marks changed, read
    once with `TAX_BY_ITEM=true`, then replay that folder with `TAX_BY_ITEM=false` and `true` (restart between); compare
    the `pipeline:` lines, and look for `taxable` in the readings. Readings saved without tax marks always spread the tax in proportion.

## Keywords

A keyword says "items matching this phrase belong in this category", e.g. `Pampers` → `Daily Expenses / Kids`. They live
in `data/keywords.json` (`{"keywords":[{"phrase","category","store","strength","added","from"}]}`) and match whole words in the item
text, ignoring case and apostrophes, with plurals (`nerd`/`NERDS`) and run-ons for multi-word phrases (`DRPEPPER` matches
`Dr Pepper`). A keyword with a store (`--at`) only applies at that store and beats a global one; more words beat fewer;
two best keywords with different categories cancel out and the receipt is flagged ("keywords disagree").

- **Strength:** each keyword is `always` or `usually` (default `usually`). **`KEYWORD_MODE=mixed`** (recommended, and
  what `.env.example` sets) files `always` keywords like `final` and treats `usually` keywords like `hint`. `final`,
  `hint` and `off` are global overrides that ignore strength; `mixed` is also the default when `KEYWORD_MODE` is missing.
- **`KEYWORD_MODE=final`:** a matching item skips the model and is filed at 100% confidence.
- **`KEYWORD_MODE=hint`:** the model is told the keyword's category. That category's
  probability is also multiplied by `KEYWORD_HINT_WEIGHT` (default 20; 4 and 20 scored the same in testing;
  1 = prompt only) and the confidence and margin recomputed from the new probabilities. A keyword that would turn the
  model's pick into a different category is used only if the new pick would pass the same confidence gate it will
  face (staying in the store's category, or moving out of it). Otherwise the model's answer stands, and the item
  records that the keyword was too weak. `off` ignores keywords.
- **In the app:** the **Keywords** page under Settings lists them, adds them (phrase, category, optional store, strength) and removes
  them. Changes apply at the next receipt. A keyword you remove (there or with the CLI) isn't brought back by an
  `#always` tag.
- **CLI:** `./receipts keyword add "Pampers" Kids [--at Target] [--always|--usually]`, `keyword remove <phrase> [--at <store>]`,
  `keyword list`, `keyword test "PAMPERS SWDRS SZ4" [--at <store>] [--amount <charge dollars>] [--item-amount <item dollars>]`
  (the amounts check a learned keyword's size limits the way the worker does: a keyword over its limit is skipped before matching, so a lower one can apply; a limit with no amount given is reported as not checked). Categories can be the full label, the part after
  ` / `, or a unique prefix.
- **`#always` in Actual:** put `#always Pampers` in a split part's (or a categorized transaction's) notes and the
  worker adds that phrase with the part's category on its next receipt (phrase: 1–4 words and at most 40 characters,
  up to a `,`, `;`, `|`, `(` or the next `#`; a bare `#always` takes the words just before it, or else the part's item
  note when that is a single item). `#usually <phrase>` does the same with strength `usually`, and a tag with
  only a different strength updates an existing Actual-made keyword for the same category. The worker only reads Actual; the tag is ignored in item notes.

## Learning from your corrections

Nobody has to teach the pipeline anything. When you fix what it did, it learns. It never writes to Actual for this.

- **What it watches.** Every charge it files in live mode (a split, or one category) is written to
  `data/memory/watch.json`, up to 400 charges, each kept for 60 days. Dry runs and note-only receipts aren't watched.
- **When it looks.** About every 6 hours, between receipts, it reads the watched charges back from Actual. If a try
  fails, the wait doubles, up to 24 hours. A charge that is gone, changed amount, or lost its `#receipt` tag is dropped
  and teaches nothing. A charge you didn't touch also teaches nothing: silence isn't counted as agreement. The one
  exception is a receipt sent to review. If you remove `#review` and change nothing, that counts as a confirmation.
- **What counts as a correction.** It matches a part you recategorized by amount and note. A part that could be one of
  several is skipped. If you changed a lone item, or one part with a single item, that's a clear lesson about that item.
  If you moved a whole receipt to one category, it's a weaker lesson about all of its items together. Lessons go in
  `data/memory/lessons.json` (up to 1,000; repeats of the same item, store and category merge into one with a count).
- **How lessons are used.** With `LEARNING=on`, a corrected item shows up in the item history as yours (`by:
  corrected`), replacing what the pipeline had said. The decider also gets at most 3 short lines,
  `household_corrected_the_pipeline`, for corrected items that share a word with the one it's deciding (the same store
  ranks higher, and a whole receipt you moved only counts at that store). Splits the pipeline made and you never touched are
  not presented to the decider as your own choices: they are shown labeled `pipeline, unchecked`, and never counted in a tally. `data/memory/marks.json` keeps that record after the 60-day watch ends.
- **Learned keywords.** After the same correction at one store, a store-only keyword is added (`from: learned`). It
  needs 2 corrections, at least one of them a lone item, or 1 on a small receipt (3 items or fewer, $30 or less), whether it
  held one item or several.
  Fixing one small split part (3 items or fewer, $30 or less) counts like a small receipt. A part you filled in that
  had no category doesn't count as a small part. It starts as `usually`. After 3 corrections that all agree, and at
  least one of them a lone item, it becomes `always`. A big receipt moved as a whole never makes keywords on its own.
  It's never added where you already have a keyword for that phrase.
  - **One exception doesn't delete it.** When you file an item somewhere other than a learned keyword said (one gift filed
    elsewhere), that counts as a vote against the keyword, next to the corrections that taught it. While the keyword still
    has more votes, it stays, and an `always` keyword drops to `usually`. `always` needs at least 3 fixes, one a lone
    item, and more than three times as many for the keyword as against it, so it returns once 4 fixes agree against 1
    exception. When the votes against are as many as the votes for, it is removed; when there are more, the other
    category replaces it. Nothing is remembered as "never again": if the agreeing fixes outnumber the disagreeing ones
    again, the keyword is made again. A merged lesson (the same item fixed on several receipts) keeps every keyword it
    went against. A big receipt you moved whole doesn't count against a keyword. What you do
    yourself is permanent: removing a keyword (on the Keywords page or with the CLI) or pressing Forget on a lesson means
    it isn't learned again.
  - **Two size limits.** A learned keyword only applies to charges up to twice the size of what it learned from, and at
    least $30 (the small part or small receipt, or the whole charge for a lone item). It also only applies to items up to
    twice the largest price it learned from, and at least $5 (`maxItemCents`), so "COKE" learned from a $1.58 can at the
    food court doesn't file a $15.49 case on a grocery run. Both must pass. If the charge or the item's price isn't known, a
    keyword with that limit is skipped. Lessons from before item prices were kept give no item limit. Keywords you make
    have no limits. The Keywords page and `keyword list` show both.
- **Learned corrections** (under Settings) lists the lessons and learned keywords. **Forget** drops a lesson, and it
  isn't learned again from that charge. **Undo** brings it back.
- **`LEARNING`:** `on` (default) learns and uses it. `record` learns but doesn't use it, to compare. `off` does nothing:
  no sweep, and nothing is read. `MEMORY_DIR` (default `/data/memory`) is where the files are. If a file is damaged, it's
  reported once and receipts carry on without it.
- **Tests:** `replay` and `item-test` ignore what was learned unless you pass `--with-memory`. `item-test` scores only
  against splits you made yourself, unless you pass `--include-pipeline`.

## The local reader model

The reader is a vision model served by llama.cpp in the `llm` service: a model file plus an image projector (mmproj). By default
that is Qwen3.5-4B Q8_0 with the BF16 projector. `READER_LOCAL_MODEL=<hf repo>:<quant>` swaps it, the way `DECIDER_MODEL` swaps
the decider, and `READER_LOCAL_MMPROJ` picks the projector (file name or quant) if the repo has several. `./receipts` handles both
models with the same code: `download-models` starts the service once with internet access so llama.cpp downloads the model into
`models/`, adds the projector if one was named, checks that a projector arrived (a model without one can't read images, and is
refused), and puts the service back offline. At every start `./receipts` finds the downloaded files in `models/` and gives the
service their paths, so the model loads offline and nothing is re-resolved or downloaded again. When a repo has several
projectors and none is named, llama.cpp downloads one of its own choosing and `./receipts` uses what is on disk (BF16, then F16,
then F32 if there are several). `LLM_NAME` defaults to the model's name. A different model may need `LLM_SAMPLING` and a
different amount of graphics memory; try it with `./receipts replay` first.

## Cloud reader (optional)

By default the reader (Qwen3.5-4B on `llm`) runs on your machine and photos never leave it. With
`READER_PROVIDER=remote` the worker sends each photo to a cloud vision model instead, using your own OpenAI or
OpenRouter key (`READER_URL`, `READER_API_KEY`, `READER_MODEL`; `./receipts setup` asks, and `.env.example` has examples).
This is off by default, and **it sends your receipt photos out of your house**. To keep everything local, leave
`READER_PROVIDER=local` (or remove the line); `./receipts start` and `status` say when a cloud reader is in use.

**What leaves the machine.** The whole photo (a PDF page or HEIC is turned into a JPEG first, at most `MAX_IMAGE_SIDE`
pixels) and the reader's instructions. A receipt shows the store and its address (where you shop), the date and time,
everything you bought, prices, the last digits of your card, member or loyalty numbers, sometimes your name or a
cashier's name, and barcodes. The anonymizer used for the hosted decider does **not** apply to photos; it can't. A cloud
reader sees everything on the receipt. The worker removes the photo's metadata (EXIF, including the phone's GPS
location) for every photo, local or not, with ImageMagick `-strip`, after applying its rotation. The request holds
nothing else: not the file name, the Nextcloud folder, your Actual data or the account. (Two other features also ask the reader and do
carry Actual data, so they are not automatic with a cloud reader: category descriptions, see below, and the hosted decider's name
scan.) The API key travels only in the
`Authorization` header and is never logged, and a provider's error text is scrubbed of it (and of image data) and cut to 200
characters before it is shown.

**Where it goes.** The provider may keep requests for a while (for example for abuse monitoring), and policies differ and
change, so check the provider's current policy. OpenRouter forwards the request to a third-party model provider, whose
policy applies; OpenRouter has privacy settings that limit providers that log or train on data, so check them.

**If you also use the hosted decider.** Its name and place scan (below) is run by the reader, so with a cloud reader the
texts it scans (item lines, store names, your category notes) would go to the reader's provider, unanonymized, before the
anonymizing happens. The worker therefore refuses to start with both hosted unless you set `CLOUD_NAME_SCAN=true` to accept
that; `./receipts setup` explains it and asks. With the opt-in, the worker logs a note about it at startup and the status
page says so. `./receipts replay` with a cloud reader sends the photos (and, with `--preview-remote`, the scan texts) to the
provider; only the decider requests are written to files instead of sent.

**Category descriptions.** Writing them (`./receipts describe`, the first run of the worker, the setup question) asks the
reader about each category that has none, and the request holds the category name, the number of transactions filed there and
their median amount, the store names with counts, the stores your Actual rules send there, and up to 30 of your item notes.
With a cloud reader the worker never does this on its own (it logs once that it skipped it); `./receipts describe` lists the kinds of data that
would be sent and asks first (`--yes` skips the question), and the setup question defaults to No.

**How it asks.** `POST <READER_URL>/chat/completions` (`READER_URL` gets `/v1` added only when it has no path, as in `https://api.openai.com`; any path you give, such as `.../v1`, `.../api/v1` or `.../v1beta/openai`, is kept, and a trailing `/` or `/chat/completions` is dropped)
with `Authorization: Bearer <key>`, `model`, `messages`, `temperature` (0.1), `max_tokens` (4096) and `response_format`
with a strict `json_schema`. Strict mode rejects keywords such as `minItems`, `minimum` and `pattern`, so they are removed
from the schema that is sent; the worker checks the answer itself anyway. Fields only llama.cpp knows (`top_k`, `min_p`,
`repeat_penalty`, `chat_template_kwargs`) are not sent, and `LLM_THINKING` does not apply. A request is one paid call, not
the local reader's two passes. If the provider answers 400 that it can't do `json_schema`, the worker asks once more in plain
JSON mode with the schema in the prompt. If a model wants `max_completion_tokens` instead of `max_tokens` (some newer OpenAI
models), or refuses a `temperature`, it retries once with that fixed. OpenRouter also gets the optional header
`X-Title: receipt-pipeline`.

**Errors.** How the worker treats each kind of failure from a cloud reader:

- **Setup problems pause processing** without using up any receipt's attempts, and the app shows a banner. These are: a
  refused key (401, or a 403 that is not about content or region); 402 (no credit); 404 (wrong model name or address); a 429 that
  says the quota is used up (`insufficient_quota`); a 403 about an unsupported region; and a 400 that says the model doesn't exist.
  Fix `READER_API_KEY` (or the other setting) and run `./receipts restart`.
- **How "quota used up" is decided:** by the provider's structured error first (HTTP 402, or an `error.code` / `error.type` of
  `insufficient_quota`). Only an answer with no code or type is judged by its words, and the word "billing" alone does not count, so an
  ordinary rate limit that points at the billing page is retried, not a pause.
- **A 403 that says the receipt was flagged by moderation** fails only that receipt (one attempt, then review).
- **A 400 about an image** depends on what the worker has seen so far. Once this host and model has returned a good reading since the
  worker started, it is an error for that one receipt (a failed attempt), unless a different receipt had the same kind of 400 just
  before with no good reading in between (that looks like a setup problem and pauses). Before any good reading, the first such
  receipt is only skipped for that check: no attempt is counted, nothing is paused, and the check goes on with the next receipt,
  so one bad photo cannot block the inbox after a restart. It is skipped again at the next checks and counts as a failed attempt
  once it has been skipped in 3 checks in a row. A second, different receipt with an image 400 before any good reading pauses the
  worker (the model probably cannot take images).
- **Outages:** a 429 (not quota), 500, 502 or 503 is retried three times with a growing wait (a `Retry-After` header is honored). If
  it still fails, or the connection or DNS fails, that is an outage of the provider: the check stops, nothing is counted against
  the receipt, and the next poll tries again.
- **Possibly billed failures:** a 504, 524, 408, a timeout or an answer that could not be read to the end is not retried in the same
  check, because the provider may already have billed it. These are counted per receipt: the receipt is tried again at the next
  poll, and after three checks in a row it counts as a failed attempt, so one receipt can't be paid for forever. Only consecutive
  failures count: a new reading that succeeds, or any other outcome, starts the count again. Reusing a saved reading does not, so a
  cloud name scan that keeps timing out after the reading is saved still reaches three and stops being paid for. A counted
  failure on one receipt does not stop the rest of the inbox; a second one in the same check does (the third failure, which gives
  up on the receipt, is one of them).
- **Saved readings:** a reading that was paid for is kept if a later step fails, so a retry does not read the photo again. It
  remembers the provider, host and model that made it and is dropped if the reader has changed. An answer cut off at the token
  limit is an error for that receipt.
- **What a provider needed** (`max_completion_tokens`, no `temperature`, JSON mode) is remembered until the worker restarts.
- **Health check:** there is no `/health` to wait for. The worker makes one `GET <READER_URL>/models` with the key and treats any
  answer except a refused key as up.

**Switching back.** `./receipts start`, `restart` and `update` first make `COMPOSE_FILE` agree with `DECIDER_PROVIDER` and
`READER_PROVIDER` (the hosted-decider file in it exactly when the decider is remote, the cloud-reader file in it exactly when the
reader is remote, and last), say so in one line when they change it, then start the services the setup needs. So setting
`DECIDER_PROVIDER=local` and running `./receipts restart` brings the local decider back up.

**Running it.** `./receipts start` and `status` leave out the `llm` container (the overlay `compose.remote-reader.yaml` puts it
in a profile nothing turns on, and removes it from the worker's `depends_on`). With both the reader and the decider hosted, only the
worker runs. The app shows the reader as "model (remote: host)" and a notice that photos leave the machine, and the
worker logs one line at startup saying so. `./receipts check` tests the address and the key without sending a photo (some
providers list models without checking the key; then a wrong key shows at the first receipt).

**Before you switch.** It has not been tested on this pipeline's receipts, and it costs money per photo. Run
`./receipts replay` (it changes nothing) with `READER_PROVIDER=remote`, compare its readings and totals with the local
reader's on the same receipts, then decide.

## Hosted decider (optional)

By default both models run on your machine and nothing is sent out; keep `DECIDER_PROVIDER=local` to stay that way. If your graphics card is short on memory, the decider can run on
TypeSafe's hosted Jev model instead (`DECIDER_PROVIDER=remote`). **This sends anonymized text about your purchases to TypeSafe** (what exactly is below). Jev answers the same kind of question as the local
decider. You need an API key from [TypeSafe](https://docs.typesafe.ai); input costs about $0.042 per million tokens,
and output is free. The reader, and your receipt photos, stay on your machine (unless you also choose the cloud reader above). `./receipts setup` asks which
one you want, stores the key, and adds `compose.remote-decider.yaml` so the local decider no longer starts (that
frees about 3–7 GB of graphics memory).

**What is sent, per item.** Everything is anonymized first, and there is no switch to turn that off. With
`RECEIPT_CHECK` there is also one request per receipt about the whole purchase; it holds the same kinds of text (all the
item lines with their prices instead of a single item) and goes through the same scan and last check:

- the item lines and amounts, and the other items on the receipt;
- the store, only as the payee name in Actual (long numbers removed). The bank's raw text is never sent, nor are
  transfers between your own accounts;
- your past purchases, notes and category descriptions, with every category name replaced by a code (`C01`, `C02`…) (the pipeline's own unchecked picks are labeled `pipeline, unchecked`, exactly as for the local decider)
  that only your machine can turn back into a name. This also applies where a category name appears inside a note;
- dates as "12 days before this purchase". Built-in holidays keep their name; any other occasion becomes "a birthday
  or personal occasion";
- people's names as Person A, Person B…, always the same letter for the same name;
- places as "a city", "a state" or "a street", with ZIP codes dropped. A store whose name includes its town goes out
  as, say, "Corner Thrift Shop a city".

**Never sent:** the photo, card digits, the payment method, cash amounts, addresses, the printed date and calendar event names.

**How names and places are found.** In two ways, and every text is checked both ways:

1. **Your own lists:** first names, nicknames and pet names (`PRIVATE_WORDS`), and your town, street or ZIP code
   (`PRIVATE_PLACES`). Setup asks for the names; both seed the lists once, and you edit them under
   **Settings → Privacy**.
2. **A scan by the reader model** (the local one, unless you chose the cloud reader: then these texts go to its provider), which marks private people's names and places in everything about to be
   sent, 12 texts at a time. Results are cached in `data/name-scan-cache.json`, so each text is scanned once.
   - Receipt lines are product text, so a name found in one only counts if the line also says something like FOR,
     TO, GIFT or MEMBER, or the name is already known from your notes. Abbreviations and product words ("CAGE FREE")
     never count as names.
   - A business name such as "Papa John's" is left as it is where it appears in full, if the scan finds no person or
     place in it. The same word anywhere else is still hidden.
   - What the scan finds shows on the Privacy page. Press **Not a name** or **Not a place** for anything it got
     wrong.

**The last check.** Before each request goes out, the worker searches it for every category name and every listed or
found name and place. If one is there, that item is not sent and is treated as unsure. The log says where it was found, but
not what it was. If the scan can't run because the reader is down, the check stops and the receipt waits for a later poll (nothing is sent unscanned). If `data/private-words.json` is damaged, nothing is sent
until you fix or delete it. The worker never writes over it.

**Errors.** A rejected key (or a request Jev can't accept) pauses processing without using up any receipt's
attempts, and the app shows a banner. Fix `DECIDER_API_KEY` in `.env` and run `./receipts restart`. If Jev
refuses one item, only that item becomes unsure. Failures are counted per receipt exactly as for the cloud reader: a 504, 524,
408, a timeout or an unreadable answer counts (three checks in a row is a failed attempt); 429, other 5xx and connection errors
are an outage that stops the check without counting. Answers already paid for are kept on the receipt's entry in `data/state.json`
(the answer only, keyed by a hash of the finished request and the category order; never the request text or the key), so
if item 20 keeps timing out, items 1-19 are not bought again on the next poll. They are dropped when the receipt is finished.

**Checking and previewing.**

- `./receipts check` lists Jev's models and sends one fixed test request that contains none of your data, to confirm
  the key works.
- `./receipts replay --nextcloud "/Receipts/Processed" --preview-remote jev-preview` (the name is the folder under `data/research/`) writes exactly what would be
  sent, one JSON file per item (and `<receipt>.receipt.json` for the whole-purchase question), to
  `data/research/jev-preview/`, and calls no decider. With a cloud reader it still sends the receipt photos and the name-scan texts to that reader (and needs `CLOUD_NAME_SCAN=true`). Items the last check would hold back are marked in their file.
- `item-test` with the hosted decider would send up to a year of your split notes (anonymized first; with a cloud reader the
  name scan sends those notes to the reader's provider as they are), so it refuses unless you add `--allow-remote`.

## Idea for later: a small OCR reader plus the decider

Not built; noted so it can be tried some day. OCR (optical character recognition) means copying printed text out of an image. Today one general vision model (Qwen3.5-4B, about 5.5 GB of graphics memory)
both reads the receipt and follows a long set of rules about how to write it down. The idea is to split the work cleanly:

1. **A small OCR model only copies what is printed** into a short JSON template, in the template style these models are
   trained on: store, date as printed, item lines with their amounts and tax marks, tax lines, subtotal, total, payment and
   cash given. OvisOCR3, Xiaomi-OCR-0 and GLM-OCR are about 1 GB each and already do template extraction.
2. **Code does the interpreting** the general model does now: turn the printed date into the required format, tell a
   return from the sign of the total, and check that the items add up to the subtotal (as it already does).
3. **The decider does all the deciding**, as now. Because it answers choice questions, it could also settle the unclear
   reading cases if they are asked as choices: "is this line a discount on the item above, or an item?", "which of these
   lines is the total?". That costs extra decider calls per receipt.

**Why it's worth trying:** the reader would shrink from about 5.5 GB to about 1–1.5 GB. On a 6–8 GB graphics card that
leaves room for the bigger decider, which is where most of the remaining misses are, so the pipeline would run well on
much more hardware. On a 20 GB card it changes little.

**What's hard:** some of what looks like reading is judgment, and the OCR model or the code has to get it right: discount
and coupon lines (minus amounts), "Manual Weight" lines, voided items, items wrapped onto two lines, which number is the
total when the receipt also shows balance due, cash given and change, and which tax line goes with which tax mark.

**What the first test suggests** ([research.md section 10](research.md#10-newer-readers-a-9b-general-model-and-three-small-ocr-models)):
the OCR models were given the general model's instructions, which isn't their style, and still OvisOCR3 got 24 of 26
totals right and scored 96% on the receipts it could match. Its misses were mostly dates copied as printed, which code can
fix. Its weak spot was item lines (16 of 26 added up, against Qwen's 20), which code can't easily fix. Start with
OvisOCR3: a template prompt in its own style, the date and return handling moved into code, then the same replay test
against Qwen3.5-4B and the household's answers.
