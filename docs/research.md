# Choosing small local models for receipts: what we tested

This page records what was measured and why the defaults are what they are. For how to use the pipeline, see the
[README](../README.md); for how it behaves, see [How it works](how-it-works.md).

**Contents**

- [The short version](#choosing-small-local-models-for-receipts-what-we-tested) and [two jobs, and a few terms](#two-jobs-and-a-few-terms)
- [1. Receipt readers](#1-receipt-readers)
- [2. Item categorizers](#2-item-categorizers)
- [3. Category descriptions](#3-category-descriptions)
- [4. More decision models](#4-more-decision-models)
- [5. General descriptions plus keywords](#5-general-descriptions-plus-keywords)
- [6. A hosted decider: Jev, anonymized](#6-a-hosted-decider-jev-anonymized)
- [7. Confidence as a probability, re-tuned](#7-confidence-as-a-probability-re-tuned)
- [8. Honest history, the receipt check, fewer examples](#8-honest-history-the-receipt-check-fewer-examples)
- [9. Missed discounts, tax codes as printed, the split bar](#9-missed-discounts-tax-codes-as-printed-the-split-bar)
- [10. Newer readers](#10-newer-readers-a-9b-general-model-and-three-small-ocr-models)
- [11. Setting by setting](#11-setting-by-setting): what each default did in testing
- [What didn't help](#what-didnt-help) · [Hardware](#hardware) · [Reproducing](#reproducing) · [Caveats](#caveats)

A receipt looks easy until you try to file one. The item names are abbreviations ("MED-CHILD PIC"), and the question
a budget cares about, *whose is this?*, isn't printed anywhere. These notes explain which local models this pipeline
uses to read receipts and file them in [Actual Budget](https://actualbudget.org), and why, so you can check the
settings in `compose.yaml` and `.env.example` or redo the tests on your own hardware.

> **The short version**
>
> **Reader:** Qwen3.5-4B (Q8_0, thinking off). **Decider:** LiquidAI d1-2B (Q8_0) by default; vLLM d3-flash 9B
> (Q4_K_M) if your GPU has room. The default pair uses about 8.3 GB of VRAM, or 7.4 GB with `compose.small-gpu.yaml`
> ([Hardware](#hardware)).
>
> 1. **Qwen3.5-4B was the only one of six readers with every total right**, at 20 s per receipt.
> 2. **Knowing when it's unsure beats guessing well.** The reader picks items as well as d1 but has no confidence to
>    hold back on: 75% on whole receipts against d1's 97%.
> 3. **Better category descriptions were the biggest gain:** d1's hard-item picks went from 21/44 to 29/44.
> 4. **Bigger deciders split out more; only the household can say if that's right.** Against its answers, d3-flash
>    averages 95.8% (14/16 exact), d1 90.9%.
> 5. **General descriptions plus always/usually keywords** matched descriptions full of item names. Reasoning, a
>    receipt fine-tune, a 1B reader and plain-language item names [didn't help](#what-didnt-help).
> 6. **A hosted decider works, anonymized.** Jev scored 96.5% (13/16) for about a cent per 25 receipts, with fewer
>    unsure items than d3-flash, and frees the decider's VRAM ([section 6](#6-a-hosted-decider-jev-anonymized)).

All tests are **dry runs** against one household's real budget (finished November 2026); nothing in Actual or
Nextcloud changed. With 25 receipts and 44 hand-filed items, treat differences of one or two as noise.

## Two jobs, and a few terms

**Reading** turns a photo into data (store, date, totals, payment, line items). It's a general vision-language model
on llama.cpp's OpenAI-compatible API, and a mistake means the wrong bank charge, or none. **Deciding** picks a budget
category per item, which often depends on the household more than the item. **The decider** is a "System One"-style
decision model on llama.cpp's `/v1/systemone` endpoint: instead of writing an answer, it scores every allowed
category, so the pipeline gets a probability for its pick.

```
receipt photo ──► reader (vision model) ──► JSON: store, date, totals, payment, line items
                                             │
                        worker (no model) ───┤  find the one bank transaction that matches
                                             │  (amount, date window, payee name), check items add up
                                             ▼
                  decider (decision model) ──► a category + confidence for each item
                                             │
                        worker (no model) ───┴─► apply: recategorize or split in Actual, or send to review
```

For each item the decider sees the item name, the rest of the receipt, how past purchases at that store were filed,
the newest item notes per category from past splits at any store (15 in these tests; the default is now 5, see [section 8](#8-honest-history-the-receipt-check-fewer-examples)), and one description per category (plus similar
past items with `SIMILAR_ITEMS=true`, [section 5](#5-general-descriptions-plus-keywords)).

- **Confidence** (the old scale, used for all the results here): 1 − normalized entropy of the probabilities, 1 if all
  on one category, 0 if spread evenly. It is no longer what the worker uses: confidence is now the probability of the
  chosen category, plus a margin over the best other one (`MOVE_MIN_MARGIN`); see [section 7](#7-confidence-as-a-probability-re-tuned). On
  the old scale an item needed 0.5 to count as sure (`CATEGORY_MIN_CONFIDENCE`) and 0.6 to leave the store's usual
  category (`MOVE_MIN_CONFIDENCE`); in testing, every wrong split was a near miss at 54–55%. Unsure items fall back to the
  store's category, and a receipt that moves money that way goes to review.
- **Pick right:** the top category is the household's. **Filed right:** so is what's filed after the confidence gates.
- **Leave-one-out:** the purchase being tested is hidden from the store history and item notes. The results below were measured
  before replay and `item-test` also hid everything dated after the purchase, so they could lean on later notes; see
  [Replay tests](testing.md#what-the-tests-dont-see) for what is hidden now and what still leaks.
- **Average match:** per receipt, the share of the charge filed in the household's own categories. **Exact** counts
  receipts where all of it was.

**What we tested on.** An AMD Radeon RX 7900 XT (20 GB), llama.cpp `server-vulkan` build b12124, Linux, and:

- **25 receipts** from grocery, warehouse club, big-box, hardware and thrift stores (two paid in cash, several with no
  printed date). The 16 that match a bank transaction the household filed by hand are the **whole receipts**.
- **44 hard items:** every hand-made split whose parts have a short note ("Nerds", "kids' shorts", "dinner for
  grandpa"), 32 purchases at 12 stores. Each was filed outside the store's usual category; only 3 of the 44 match the
  category the store's rule gives.

Readers ran one at a time with the same prompt, image preprocessing and JSON schema; decider tests reuse saved
readings, so every decider sees identical input.

## 1. Receipt readers

**Which vision model reads receipts most reliably?** Qwen3.5-4B: every total right (the field used to find the bank
charge) and the most receipts ready without review. A wrong date is worse than none (no date goes to review); "items
add up" means within 2% of the printed subtotal. Thinking off unless noted; median seconds per receipt.

| | LFM3-VL 2B (thinking on) | **Qwen3.5-4B** | Gemma 4 E4B | Nemotron 3.5 Bolt E4B | MiniCPM-V 4.7 1B | LedgerLens 2B (receipt fine-tune) |
|---|---|---|---|---|---|---|
| Quantization | Q8_0 | Q8_0 | Q8_0 | Q8_K_XL | Q8_0 | Q4_K_M |
| Totals right | 24/25 | **25/25** | 22/25 | 22/25 | 23/25 | 23/25 |
| Dates read right (of 23 printed) | **16** | **16** | **16** | **16** | 15 | 13 |
| Dates read wrong | 1 | 1 | **0** | **0** | 7 | 3 |
| Items add up | 17 | **20** | 18 | 16 | 14 | n/a |
| Cash receipts recognized | **2/2** | **2/2** | 1/2 | 1/2 | 0/2 | 1/2 |
| Ready with no review | 15 | **16** | 13 | 13 | 12 | 12 |
| Seconds per receipt | 28 | 20 | 9 | 9 | **7** | 9 |

LedgerLens only works with its own training prompt, which has no subtotal, payment method or store clues, so the
items check can't run and it can't detect cash from the change given.

**What we learned.** We expected a gentle speed-for-accuracy trade; it came down to digits. LFM3 dropped a decimal
($40.62 → $400.62). Gemma 4 and Nemotron are twice as fast and never invented a date, but both misread a large total
by $17–20 and took the cash handed over as the total on a cash receipt. MiniCPM-V 1B wrote the same made-up date on
receipts that have none printed: fast, but unsafe. LedgerLens, the only usable receipt fine-tune we found, was trained
on Indonesian and Malaysian receipts (CORD, SROIE) and did no better than general models. One photo had its date
misread by every model: the image was the problem.

### Does reasoning help the reader?

No: same totals, dates and outcomes on all 25 receipts at 2.4× the time, so thinking stays off (`LLM_THINKING=false`).

| Qwen3.5-4B | Thinking off | Thinking budget 1,024 tokens |
|---|---|---|
| Totals right | 25/25 | 25/25 |
| Dates read wrong | 1 | 1 |
| Items add up | 20 | 20 (3 fixed, 3 broken) |
| Ready with no review | 16 | 16 |
| Seconds per receipt | **20** | 50 |

## 2. Item categorizers

**Can the reader file items too, or do we need a decision model?** We need it. The reader picks single items about
as well, but with no confidence scores it can't tell when to leave an item alone, which is most of the job.

**Hard items** (44 hand-filed items, leave-one-out, the original descriptions for every row):

| | Pick right | Filed right | Left uncategorized | Time per item |
|---|---|---|---|---|
| No model (store rule, else the store's most-used category) | 6 | 6 | 2 | 0 s |
| LiquidAI d1-2B | 21 | 14 | 7 | 0.4 s |
| LFM3-VL 2B (as a text categorizer) | 23 | 23 | 0 | 22 s |
| Qwen3.5-4B (as a text categorizer) | 24 | 24 | 0 | 1.8 s |

d1 files fewer than it picks because unsure picks are held back. Before the section 3 work, its confidence separated
right from wrong poorly: right picks ranged 34–92%, wrong ones 31–90%.

**Whole receipts** (the 16 comparable ones) matter more: most items belong in the store's usual category, and a
categorizer has to leave them there.

| Decider | Average match | Exactly right |
|---|---|---|
| d1-2B | **97%** | **15/16** |
| Qwen3.5-4B (no confidence scores) | 75% | 7/16 |

With nothing to gate on, every one of Qwen's guesses is applied. It moved ordinary grocery items out of Groceries, and
most of a big-box purchase out of the category the household uses for that store.

**What limits accuracy.** About 15 of the 44 items can't be known from the name: candy and soda that belong to one
adult's personal category, hummus and mints that belong to the other's, a kids' size versus an adult size,
thrift-store "clothes" for a particular person. No model size fixes that; the category descriptions have to.

## 3. Category descriptions

**Can better descriptions do what a bigger model can't?** On hard items, largely: d1's correct picks went from 21/44
to 29/44, while whole receipts held at 97% average (exactly right: 15/16 before, 14/16 after).

The originals were written by a model from each category's past transactions and reviewed by the household. The new
ones were written from the hard-item misses and corrected by the household: they name brands, say what a category is
*not* for, and give price hints. Examples, shortened, names replaced:

| Category | Before | After |
|---|---|---|
| Groceries | Food and drink to eat at home: groceries, snacks, and pantry staples from supermarkets and warehouse clubs | Food and drink for the whole household to eat at home: produce, meat, dairy, bread, pantry staples, shared drinks and snacks. **Not** candy or soda treats (Adult 1's), hummus or mints (Adult 2's), baby food, diapers or distilled water (Kids), vitamins (Health), or cleaning and household supplies such as dishwasher detergent and batteries (Misc). |
| Adult 1 | Adult 1's own purchases: software, tech subscriptions, computer gear, games, men's clothes, candy or soda snacks | …computer gear, **chargers and cables**, **men's and adult-size clothes such as shorts and shirts**, and Adult 1's candy and soda treats (**Nerds, Reese's Pieces, Nutty Bars, Dr Pepper**) |
| Restaurants | Prepared food eaten out or taken away: fast food, sit-down meals, deli sandwiches | …**typically under $50**. Bigger restaurant bills are often gift meals (Gifts). |
| Gifts | Presents and treats for other people: clothing, socks, quilts, cards, occasion dinners | Presents for **people outside the household**, **usually bought around a birthday or a holiday**: …kettles, greeting cards, gift sets for other people's kids, and gift meals, which are **usually restaurant bills over $50** |

Results with d1-2B (calendar reading off, the default):

| | Original descriptions | New descriptions |
|---|---|---|
| Hard items, pick right | 21/44 | **29/44** |
| Hard items, filed right | 14/44 | **22/44** |
| Right picks' confidence (median) | 65% | 72% |
| Wrong picks' confidence (median) | 53% | 54% |
| Whole receipts, average match | 97% | 97% |
| Whole receipts, exactly right | 15/16 | 14/16 |

The hard-item gain is **optimistic**: the new descriptions were written from these same 44 misses. The fairer
whole-receipt check stayed at 97%; the one receipt that got worse moved a $3.99 bag of candy to a personal category on
a receipt filed whole, which is a judgment call. Birthdays from a Nextcloud calendar as a gift hint
(`OCCASIONS_CALENDAR=true`) took hard items to 30/44 picked and 24/44 filed; that's off by default for privacy (US
holidays are computed locally). And a restaurant charge over $50 is now applied and sent to review as a possible gift
meal (`GIFT_MEAL_MIN`).

## 4. More decision models

**With good descriptions, does a bigger decider help?** It depends on the household. Bigger models move more items
out of the store's usual category; once the household confirmed most of those moves, d3-flash 9B came out ahead with
a 95.8% average match against d1's 90.9%.

Five newer decision models took the same two tests with the new descriptions (calendar off). All are 4-bit GGUFs
except d1-2B (Q8_0). VRAM was measured after loading, at 8k context (27B: 4k); confidence is the median.

| Decider | Params | VRAM | Per item | Hard: pick right | Hard: filed right | Whole: average | Whole: exact | Confidence right / wrong |
|---|---|---|---|---|---|---|---|---|
| LiquidAI d1-2B (current) | 2B | 2.7 GB | **0.4 s** | 29 | 22 | **96.8%** | **14/16** | 72% / 54% |
| Base Labs elephant-1 | 9B | 5.6 GB | 0.9 s | 32 | 26 | **96.8%** | **14/16** | 79% / **47%** |
| vLLM d3-flash | 9B | 6.8 GB | 0.7 s | 34 | 29 | 91.9% | 11/16 | 86% / 73% |
| Perplexity pplx-decider-flash v1.2 | 4B | ~3.5 GB | 2.3 s | 33 | 30 | 92.2% | 12/16 | 85% / 75% |
| Perplexity pplx-decider v1.1 (Artemis IQ3_M) | 27B | 15.0 GB | 2.8 s | **35** | **31** | 91.1% | 10/16 | 92% / 73% |
| Cloudflare Clef-Flash | 9B | 6.8 GB | 0.7 s | 23 | 7 | 93.8% | 15/16 | 47% / 46% |

Perplexity flash's VRAM is estimated from its 2.9 GB file, and its 2.3 s is one HTTP round trip per item plus the
readout in JavaScript, not optimized. Ignore Clef-Flash's whole-receipt score: it's unsure about almost everything
(median 47%), so nearly every item falls back to the store's category. It's barely deciding.

**The two tests pull in opposite directions.** Hard items reward moving things out of the store's category (all 44
were moved): every larger model beats d1 except Clef-Flash (23 right, which is barely deciding, see above), and Perplexity 27B is best. Whole receipts reward leaving things alone:
only elephant-1 matches d1. Looking closer, most of the confident models' whole-receipt "misses" were items the new
descriptions say belong elsewhere, on trips the household had filed whole:

| Receipt (filed whole as) | Items moved out | By |
|---|---|---|
| Warehouse club (Groceries) | shampoo → Misc, hummus → Adult 2 | d3-flash, both Perplexity models; elephant-1 moved only the shampoo |
| Warehouse club (Groceries) | paper plates and foil → Misc | d3-flash |
| Grocery store (Groceries) | Gold Bond lotion → Health, a toy ball → Kids | lotion: d3-flash, Perplexity flash; ball: Perplexity flash |
| Big-box store (Kids) | a bag of candy → Adult 1 | d1, d3-flash, both Perplexity models |
| Big-box store (Kids) | cleaners and hangers → Misc | Perplexity 27B |

If the household wants those splits, d3-flash or Perplexity flash v1.2 beat d1 and the whole-receipt numbers
understate them. If not, elephant-1 is the safe upgrade: d1's whole-receipt result, better hard-item picks, and the
clearest gap between its confidence when right and when wrong.

### Scored against the household's answers

So we asked. All the moves were right, except that Gold Bond belongs to Adult 2 (not Health) and hangers can go to
Misc or Home & Auto. With the descriptions updated, the three main candidates were rerun and scored against the
household's filing *with those splits made*, so leaving shampoo in Groceries now costs credit too.

| Decider | Whole receipts: average | Whole receipts: exact | Still wrong |
|---|---|---|---|
| vLLM d3-flash 9B | **95.8%** | **14/16** | the two cleaners (left with the store's category) |
| LiquidAI d1-2B | 90.9% | 11/16 | plates, foil, shampoo, hummus, Gold Bond, cleaners |
| Perplexity flash v1.2 4B | 90.8% | 12/16 | plates, foil, Gold Bond, cleaners, hangers |
| Base Labs elephant-1 9B | 90.3% | 10/16 | plates, foil, candy, Gold Bond, hummus, cleaners, hangers |

elephant-1 was not rerun; its row is its earlier run (before the Gold Bond and hanger changes), rescored. The 16th
receipt, a thrift-store trip split three ways, is hard for every model (about 63%). Hard-item picks moved only a
little (d1 28/44, d3-flash 33/44, Perplexity flash 33/44). The tested household switched to d3-flash (`DECIDER_MODEL` in
`.env`); the repository default stays d1-2B, which fits small GPUs ([Hardware](#hardware)).

**Practical limits.** Perplexity 27B needs 15 GB, so it can't share a 20 GB card with the reader. Perplexity flash
v1.2 has a newer protocol than `/v1/systemone`: llama.cpp ran it with non-causal attention returning per-token hidden
states (`--embeddings --pooling none`), and the worker applied the readout matrix itself (`worker/src/pplx.js`, since
removed); a sanity check confirmed non-causal attention and easy questions right at 88–99.9%. elephant-1 is a
community GGUF upload (MIT license), not an official one.

Looked at and skipped: Nimble 9B (non-commercial license, poorly calibrated), Strands Decider 2B (stock llama.cpp can't
run it), Tev1 4B (about the same as d1-2B on public benchmarks), Jev (hosted only, no open weights), and Perplexity
v1.2 27B (no GGUF that stock llama.cpp can load).

## 5. General descriptions plus keywords

**Can descriptions stay general, with the quirks kept elsewhere?** Yes: with a keyword list, general descriptions did
as well as item lists. Section 3's fixes wrote items into the descriptions ("Gold Bond", "Nerds, Reese's Pieces",
"Pantene"), turning them into lists that grow with every one-off. The alternative has three parts:

- **Descriptions say kinds of things and whose they are**, plus typical stores ("Adult 2's own purchases: beauty, skin
  care and personal care products, ...").
- **Keywords hold the arbitrary choices** a stranger couldn't guess: a lotion brand one adult always uses, a candy one
  adult buys, a cleaner brand whose name says nothing. **always** files the item without the model. **usually** gives
  the model a hint, then multiplies that category's probability by a weight (20) before taking the top pick, so the
  model can still overrule it when much surer of something else. That's `KEYWORD_MODE=mixed` with
  `KEYWORD_HINT_WEIGHT=20` (now the default; it was 4 when this was measured). Matching is on the raw receipt text: lowercase,
  apostrophes dropped, letters split from digits ("PANTENE10" → "pantene 10"), whole words with an optional plural,
  and run-together phrases ("DRPEPPER").
- **Similar past items** (`SIMILAR_ITEMS=true`): up to 8 past items whose names share the most words with this one,
  and how each was filed. Without it, the only history from other stores is the newest 15 item notes per category (the setting at the time; now `HOUSEHOLD_EXAMPLES`, default 5).

Results with d3-flash, scored against the household's answers as in section 4, with 14 keywords (6 always, 8
usually). "All final" means every keyword skips the model, whatever its strength:

| Setup | Hard items: pick right | Hard items: filed right | Whole receipts: average | Whole receipts: exact |
|---|---|---|---|---|
| Specific descriptions (item lists) | 33 | 28 | 95.3% | 13/16 |
| Specific + similar items | **34** | **30** | 95.8% | 14/16 |
| General descriptions, no keywords | 26 | 21 | 91.8% | 11/16 |
| General + keywords, all final | 31 | 26 | **97.0%** | **14/16** |
| General + all final + similar items | 32 | 28 | **97.0%** | **14/16** |
| General + always/usually + similar items (chosen) | 33 | 29 | 90.8% | 13/16 |
| General + candy-by-size wording + always/usually + similar | 33 | 29 | 93.2% | 11/16 |

The chosen setup's 90.8% looks worse than it is. Apart from the hangers every setup misses, its only miss was one
cleaning pail on a small hardware-store receipt (Misc instead of Home & Auto), a 66% pick that flips between runs; on
a receipt that small, one item costs 6 points. After the final code review fixes, a replay on the live configuration
gave 97.0%, 14/16, with the hangers as the only miss.

Keyword-matched items were 11 of the 44 hard items and right 10 times (the miss was a historical filing the household
has since changed). On the other 33, general and specific descriptions came within one pick of each other. The
keywords were partly taken from the test items, so their rows say more about matching than about the model.

**What we learned:**

- **A hint in the prompt alone does nothing.** Given `household_keyword: Gold Bond → Adult 2`, d3-flash still said
  Health at 63%. Weight 4 wasn't enough either. At weight 20, "usually" acts almost like "always" unless the model is
  very sure.
- **Similar past items helped every setup** (+1–2 picks, +2–4 filed), for about 300–650 extra prompt tokens.
- **Telling candy apart by size backfired.** Told "a single bar or small bag is a personal treat, family-size and bulk
  packs are Groceries", the model sent a $15 warehouse-club box of peppermint bark and the big-box-store M&M's to
  Adult 1. Candy, chips and soda can be anyone's; similar-item history and a review beat a rule.
- **Dropping store names cost more than dropping items.** The first general draft left out the grocery stores and lost
  points on a big-box trip filed under Kids; putting them back recovered most of it.

## 6. A hosted decider: Jev, anonymized

**Can the decider run in the cloud without anything personal leaving the machine?** Yes, and it did at least as well
as the best local decider. TypeSafe's hosted Jev (`jev-latest`, 1.14) answers the same `/v1/systemone` questions as
the local GGUF models, so `DECIDER_PROVIDER=remote` only changes where the request goes. The reader stayed local in that test, and
every request is anonymized first ([how](cloud.md#hosted-decider)): category names become codes,
dates become relative, people become Person A…, and places become "a city". Anonymized text about the purchases still
leaves the machine, so this is a trade-off, not a free upgrade; the default stays local.

Same 25 receipts and saved readings as section 5, the chosen setup (general descriptions, always/usually keywords,
similar items):

| Decider | Runs on | Whole receipts: average | Exact | Unsure items | Cost for 25 receipts |
|---|---|---|---|---|---|
| vLLM d3-flash 9B (same day) | local GPU, 6.8 GB | 90.2% | 13/16 | 6 | electricity |
| Jev 1.14 (hosted, anonymized) | TypeSafe | **96.5%** | 13/16 | **2** | **$0.011** (272k input tokens, 112 requests) |

- **It was sure more often.** Jev left 2 items to the store's category for being unsure, against 6 for d3-flash. It
  got the cleaning pail and the citrus that d3-flash flips on, and still missed the hangers, like every decider.
- **Its other miss wasn't its fault.** The hummus keyword had been removed between the two runs, so Jev never saw it.
  Without it, Groceries is a reasonable pick.
- **Same answers twice.** Two runs gave identical results, so unlike the local models, Jev doesn't flip between runs.
- **Cost** is about $0.0005 per receipt, mostly the store history and the household's past items. Output is free.
- **The anonymizer needed real data to get right.** The first no-send preview (`replay --preview-remote`) found the
  household's city in two payee names, and the local name scan mistook a warehouse-club receipt's item codes for
  people ("BART PEARS", "CAGE FREE") when it was given 81 lines at once. Smaller batches, and a rule that an item line
  names a person only with a cue like FOR or GIFT, fixed that. Preview your own data before switching.

## 7. Confidence as a probability, re-tuned

An independent review found the old confidence (1 − normalized entropy over all ~30 categories) gated the wrong way: a
50/50 tie between two categories scored 0.80 and passed the 0.6 bar for splitting an item out, while a clear 70% pick
with a spread-out tail scored 0.52 and fell back. Confidence is now the chosen category's probability, and moving an
item out also needs a lead over the runner-up (`MOVE_MIN_MARGIN`). The same change labels the pipeline's own unchecked
filings for the decider, folds discount lines into their item, and lets one fix of a one-item receipt teach a keyword.

Replay of the household's receipts (d3-flash, Qwen3.5-4B readings, 16 scored):

| Build | Average match | Exact |
|---|---|---|
| Before (entropy confidence) | 84% | 9/16 |
| After, 0.5 / 0.6 / margin 0.2 | 90% | 10/16 |

Re-tuning used two item tests (44 items each, nearly identical results) swept offline from the saved probabilities, then real
replays of the candidates:

| Stay / move / margin | Item test, filed right | Replay average | Replay exact |
|---|---|---|---|
| 0.5 / 0.6 / 0.2 (kept) | 28/44 | **90%** | **10/16** |
| 0.5 / 0.5 / 0.2 | 28/44 | 88% | 10/16 |
| 0.5 / 0.5 / 0.1 | 28–29/44 | 87% | 10/16 |
| 0.5 / 0.4 / 0.2 | 28/44 | 88% | 10/16 |
| 0.5 / 0.4 / 0 | 30/44 | 79% | 8/16 |

The item test favours dropping the margin because its fallback is the store rule's category, right for only 3 of 44 items; live,
the fallback is the category the charge already has, which is usually right for most of it. On replay every lower bar
split out wrong items, and one $10 receipt was moved whole to the wrong category. `KEYWORD_HINT_WEIGHT` from 4 to 20 made
no difference on either test (1–2 lost one item). Both samples are small and were used to write the descriptions and
keywords, so the differences of one or two receipts aren't conclusive; re-tune with live corrections.

## 8. Honest history, the receipt check, fewer examples

Replay and `item-test` now hide everything dated on or after the purchase: store history, split notes and, with
`--with-memory`, what was learned. Before, one thrift-store receipt (June) was decided with the help of the same store's
August visit; without it, it scored 49% instead of 63%. So earlier results were slightly optimistic.

The changes measured on that honest replay (d3-flash, the same saved Qwen3.5-4B readings, 16 scored receipts) and on the
item test (44 hard items):

| Setup | Replay average | Exact | Item test: pick right | Filed right | Replay time |
|---|---|---|---|---|---|
| Receipt check on, 15 examples per category | 90% | 10/16 | 29/44 | 25/44 | about 130 s |
| Receipt check off | 89% | 10/16 | 30/44 | 25/44 | |
| No examples (`HOUSEHOLD_EXAMPLES=0`) | 89% | 10/16 | 30/44 | 27/44 | about 80 s |
| 5 examples (chosen) | 90% | 10/16 | 30/44 | 25/44 | about 97 s |

- **Receipt check** (`RECEIPT_CHECK`): the only replay difference is the thrift-store receipt. Asked about the whole
  purchase, the decider said Child (67%), which pulled one unsure item (DVDs) with the rest: 63% instead of 49%. In the
  learning test a food-court visit stays one category.
- **Examples**: with none, the DVDs were a near tie (25%, 2 points ahead) and went to review; with 5 or 15 they were
  pulled in with the receipt. On the item test, no examples filed 27/44 right against 25/44 for 5 or 15 (the household's split notes are
  similar to each other, so the newest 15 can crowd out the item's own context). 5 keeps the replay result and is about 25% faster than 15.
- **Your Actual rules by charge amount** are no longer told to the decider (they still set the store's category), and
  learned keywords are limited by item price as well as charge size. With all of this round's changes together, no
  replay receipt other than the thrift-store one changed.
- **Learned keywords** in the learning test: "chicken strp", learned from a $13.78 food-court visit, filed the next
  food-court visit as Restaurants, and was not applied to a $50 grocery run at the same store (its 3 lb pack of chicken
  strips stayed Groceries).

**Tax by item.** A fresh reading of the 25 photos with tax marks found that nearly every item is taxed, and that most
receipts use two codes (Costco E and A, a regional grocery chain T and TF, Target T and BF): food at a reduced rate and everything else at
the full rate. One printed tax total can't be divided between two rates, so those receipts fell back to the proportional
spread, and the one-rate receipts came out the same as proportional. No score changed.

The reader now also copies the receipt's tax lines (for example "A 7.0% TAX 1.57"), and each line is spread over the items with
that code. Tax codes are never interpreted, because they mean different things at different stores; only the receipt's
own lines say what is taxed at which rate. In a re-read of the 25 photos the reader found the per-rate lines on every
two-rate Costco receipt, and on one the lines matched the items to the cent (a full-rate line and a reduced food-rate
line, each equal to its rate times its items). There the by-rate spread moves 44¢ between two categories compared with the proportional one. No
replay receipt used it yet, for good reasons: that receipt's charge isn't in the budget; the other two-rate Costco
receipts have instant savings the reader didn't list, so their items don't add up to the subtotal; and the regional grocery chain,
Walmart and one Target receipt had line codes that didn't match the items' codes (T vs TF, TAX1 vs R). All of those fall
back to proportional. Expect cents, not category changes.

Two of the 25 fresh readings differed from the earlier ones (swapped item prices on one, a total 10¢ off on another, both
on photos the reader already struggled with). That's reading variance, not the tax marks: decisions on the new readings
were the same with the tax spread on and off.

## 9. Missed discounts, tax codes as printed, the split bar

The household reviewed the misses from §8 and confirmed three of the pipeline's splits as right, so those three receipts
are now scored against the pipeline's answer. The scores below use that corrected answer key (16 scored receipts,
d3-flash).

**Missed discounts.** On several receipts the reader leaves out an instant saving or coupon, so the items add up to more
than the printed subtotal and every category gets a little too much. Telling the reader about discounts made it worse:
it listed "Manual Weight" lines as items, invented an item, and still skipped the coupons. That prompt was reverted.
Instead the code now uses the receipt's own tax lines to find where the missing money was. Each tax line says how much
was taxed at its rate, so when exactly one tax group is over by the gap (or several are, adding up to the gap), the
difference comes off that group's items, spread by price, and the receipt goes to review with a note. If the tax lines
don't settle it, nothing changes.

The reader now also copies tax codes exactly, keeping case (one store prints both "S" and "s"), and copies each tax
line's taxable amount when it is printed.

| Setup | Replay average | Exact |
|---|---|---|
| New readings, discount fix off | 90.4% | 9/16 |
| New readings, discount fix on | 90.8% | 12/16 |
| Earlier readings, discount fix on | 92.2% | 12/16 |

With the fix on, the three receipts with missed savings came out to the household's amounts to the cent. The new
readings score lower overall only because one Target receipt was read worse this time (an item missed), which is reader
variance; on the earlier readings it was right.

**The split bar.** Tested against the corrected answer key, with `MOVE_MIN_CONFIDENCE` from 0.4 to 0.8 and
`MOVE_MIN_MARGIN` from 0.1 to 0.4. At 0.4–0.5 one receipt the household files as a single category gets split. 0.6 and 0.7 give the same
results (92.1%). 0.8 scores 92.9%, but only because one food-court receipt goes to review instead of being split, and
that receipt is already handled by the receipt check. The margin changed nothing. They stay at 0.6 and 0.2.

## 10. Newer readers: a 9B general model and three small OCR models

**Can a newer vision model replace Qwen3.5-4B?** Four candidates from late 2026 read the same 26 inbox photos with the
pipeline's own instructions, and then the usual decider (d3-flash) filed each model's readings, scored against the
household's 16 answers. Qwen3.5-4B's readings had every total right in section 1, so its readings serve as the answer key
for the reading columns. The four ran at the same time on one GPU, so their times are slower than each would be alone.

| | **Qwen3.5-4B (current)** | MiMo-V2.6 9B | OvisOCR3 0.8B | Xiaomi-OCR-0 0.8B | GLM-OCR ~1B |
|---|---|---|---|---|---|
| Quantization | Q8_0 | Q4_K_M | Q8_0 | BF16 | Q8_0 |
| Photos read (of 26) | **26** | **26** | **26** | 24 | 23 |
| Totals the same as Qwen's | 26 | 24 | 24 | 22 | 21 |
| Dates the same as Qwen's | 20 | 18 | 0 | 13 | 0 |
| Items add up | **20** | 18 | 16 | 14 | 9 |
| Cash receipts recognized | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| Receipts filed (of 16) | **16** | 14 | 8 | 0 | 7 |
| Average match (unfiled = 0%) | **90.6%** | 78.4% | 49.8% | 0% | 39.5% |
| Exact (of 16) | **11** | 8 | 6 | 0 | 5 |
| Seconds per receipt (shared GPU) | 20 (alone) | ~40 | ~20 | ~30 | 22 (alone) |

**What we learned.** None of them beats the current reader, and the reasons are about following instructions, not
seeing text.

- **MiMo-V2.6** (Xiaomi's Qwen3.5-9B tuned for code and agents) came closest. Two wrong totals or dates meant two
  receipts were never matched to their bank charge, and on the rest it did about as well as Qwen at twice the size.
- **OvisOCR3** copied every date exactly as printed ("10/26/26") instead of in the required format, so half the
  receipts couldn't be matched to a charge. The ones it could match scored well. It also read fewer item lists that add
  up than Qwen.
- **Xiaomi-OCR-0** marked every receipt as a return, so nothing was filed.
- **GLM-OCR** first didn't finish a single photo in 30 minutes. With flash attention off, as its users advise, its image
  step was too large for the Vulkan driver and ran on the CPU. With flash attention left on and the image capped
  (`--image-max-tokens 2048`) it reads a photo in 22 s, but like Ovis it gave no date in the required format, its item
  lists added up on only 9 of 26, and 3 answers ran out of room before the JSON was finished.

The small OCR models read text well, but they are trained on their own short prompts. A receipt here needs more than
text: the date in a fixed format, which line is the subtotal, tax codes, discounts as negative amounts, cash or card.
Each would need its own prompt and clean-up code, and even then Ovis's item lines were worse.

**Reading isn't the bottleneck.** With Qwen3.5-4B, every total is right, and of the four remaining misses three come from
deciding (whose is this?) and one partly from a missed item line. That's also why splitting the job (a small OCR model writes the text and a
separate text model turns it into the receipt JSON) isn't worth a third model: it can only fix reading errors, and
there are few left.

## 11. Setting by setting

The settings that affect accuracy, and what each did in testing. Each result compares a setting on and off in one test on one
household's 25 receipts, so a difference of a receipt or two is noise. The values in `.env.example` are the tested ones.
To try a value on your own receipts, run `./receipts replay` (it changes nothing).

| Setting | What it does | In testing | Verdict |
|---|---|---|---|
| `DECIDER_MODEL` | Which model picks the categories | 9B d3-flash 95.8% (14 of 16 exact) vs the default 2B d1 90.9% (11 of 16) | Bigger helps, if it fits |
| Hosted decider (Jev) | Categorizes on TypeSafe's servers, anonymized | 96.5% vs 90.2% for d3-flash on the same day, fewer unsure items, about $0.01 per 25 receipts | Helps; anonymized data leaves your machine |
| `KEYWORD_MODE=mixed` | `#always` keywords skip the model; `#usually` ones are strong hints | No keywords 91.8% (11 of 16); with keywords up to 97.0% (14 of 16) | Helps the most |
| `KEYWORD_HINT_WEIGHT` | How strong a `#usually` hint is | 4 and 20 scored the same | No difference |
| `MOVE_MIN_CONFIDENCE`, `MOVE_MIN_MARGIN` | How sure an item must be, and how far ahead of the runner-up, to leave the store's usual category | 0.6 and 0.2: 90% (10 of 16); every lower bar 79–88%, with wrong items split out | Helps; keep |
| `CATEGORY_MIN_CONFIDENCE` | How sure an item must be to count as sure at all | Tuned together with the two above; 0.5 kept | Keep |
| `SIMILAR_ITEMS` | Shows how items with similar names were filed before | 2 more of 44 hard items filed right; 13 → 14 exact | Small help |
| `RECEIPT_CHECK` | One extra question per receipt: what was the whole purchase for? | 90% vs 89%; one mixed receipt 63% vs 49%; keeps a food-court visit in one category | Small help |
| `HOUSEHOLD_EXAMPLES` | How many of your newest split notes per category the decider sees | 15 and 5: 90%; 0: 89% and one item sent to review; 5 is about 25% faster than 15 | 5 |
| `TAX_BY_ITEM` | Spreads each printed tax rate over the items with that rate's code | Moves cents between parts (44¢ on one two-rate receipt), not categories; anything that doesn't add up falls back to proportional. It also fixed three receipts with a missed coupon to the cent | Harmless; small help |
| `LEARNING` | Learns from the categories you fix in Actual | A fixed food-court visit taught the next one; a grocery run at the same store was unaffected | Helps |
| `STRIP_DEPARTMENT_PREFIXES` | Drops store codes like "MED-" ("MED" reads as medical) | Not scored | Keep on |
| `READ_PLAIN_NAMES` | The reader rewrites item codes in plain words | Turned a children's book ("MED-CHILD PIC") into "child milk" | Hurts; off |
| `LLM_THINKING` | The reader thinks before answering | Same readings, 2.4× slower | Hurts speed; off |
| Cloud reader (`READER_PROVIDER=remote`) | A cloud vision model reads the photos | Not tested | Photos leave your machine and it costs money; compare with `./receipts replay` first |
| `UNSURE_ITEMS_USE_STORE_CATEGORY`, `OCCASIONS`, `HISTORY_DAYS`, `HISTORY_LIMIT` | Where unsure items go; holiday gift hints; how much store history is used | Not tested | Defaults |

## What didn't help

| Idea | Result |
|---|---|
| Reader thinking on (1,024-token budget) | Same answers, 2.4× slower |
| Telling the reader about discounts and weighed items | Listed weight lines as items, invented an item, still skipped coupons; reverted |
| Receipt-specific fine-tune (LedgerLens) | No better than general models; can't read subtotal or payment method |
| Smallest reader (MiniCPM-V 1B) | Invents dates |
| Small OCR readers (OvisOCR3, Xiaomi-OCR-0, GLM-OCR) and MiMo-V2.6 9B | All worse than Qwen3.5-4B on dates, totals or both ([section 10](#10-newer-readers-a-9b-general-model-and-three-small-ocr-models)) |
| Having the reader rewrite item codes in plain words | Turned "MED-CHILD PIC" (children's books) into "child milk"; off (`READ_PLAIN_NAMES=false`) |
| The reader as categorizer (no decision model) | Good single picks, but 75% vs 97% on whole receipts |
| d1-2B on Transformers/ROCm instead of the GGUF | Identical answers, a 37 GB base image; removed |
| Lower confidence thresholds | d1's confidence overlaps for right and wrong picks; lowering lets wrong splits through |
| A cloud reader (`READER_PROVIDER=remote`) | Not tested here. It sends the receipt photo off the machine and costs money per photo, so compare it with `./receipts replay` before using it |

## Hardware

### Measured VRAM

Measured on Vulkan right after loading (RX 7900 XT). Image encoding needs some working memory on top, so leave about
0.5 GB of headroom.

| Service | Settings | VRAM |
|---|---|---|
| Reader, Qwen3.5-4B Q8_0 + BF16 vision projector | default: 32k context, 4 slots | 5.6 GB |
| Reader | `compose.small-gpu.yaml`: 16k context, 1 slot | 5.1 GB |
| Decider, d1-2B Q8_0 | default: 16k context, 8k batch | 2.7 GB |
| Decider | `compose.small-gpu.yaml`: 8k context, 1 slot, 4k batch | 2.3 GB |
| Decider, d3-flash 9B Q4_K_M | `DECIDER_CTX=8192 DECIDER_BATCH=4096` | 6.8 GB |

The worker sends one request at a time, so one slot loses nothing. A receipt photo is about 4k tokens, and the
decider's longest prompt so far was about 2.4k.

### AMD, Intel, NVIDIA

| GPU | How | Tested |
|---|---|---|
| AMD (RDNA2 and newer) | default `compose.yaml`: llama.cpp `server-vulkan`, `/dev/dri` passed through | Yes (RX 7900 XT) |
| Intel Arc | the same Vulkan images (Mesa's ANV driver) | Not yet |
| NVIDIA | `compose.nvidia.yaml`: llama.cpp `server-cuda` images; needs the NVIDIA Container Toolkit | Not yet |
| CPU only | `LLM_GPU_LAYERS=0` and `DECIDER_GPU_LAYERS=0` in `.env` (default 99, all on the GPU), plus `compose.cpu.yaml` | Works, much slower |

On AMD and Intel, set `RENDER_GID` to your host's `render` group (`./receipts setup` fills it in when it finds the
card). To use an override, add it to `.env` so `./receipts` picks it up (setup does this for the card it finds):
```
COMPOSE_FILE=compose.yaml:compose.nvidia.yaml                          # NVIDIA
COMPOSE_FILE=compose.yaml:compose.small-gpu.yaml                       # smaller budget, AMD or Intel
COMPOSE_FILE=compose.yaml:compose.nvidia.yaml:compose.small-gpu.yaml   # both
```

On Intel, llama.cpp also has a SYCL build (`server-intel`). Vulkan is the safer first try because it's the backend
these models were tested on: Qwen3.5's linear-attention layers aren't equally supported by every backend, and any
missing operation silently falls back to the CPU.

### Example: a shared 16 GB card with a 6–8 GB budget

Say an Intel Arc A770 (16 GB) also runs Immich's machine learning, and the pipeline may use at most 6–8 GB:

| Budget | Setup | GPU memory | Trade-off |
|---|---|---|---|
| ≤ 8 GB | `compose.small-gpu.yaml` | about 7.4 GB (+0.5 GB while reading) | none measured: same models and quantizations as tested |
| ≤ 6 GB | `compose.small-gpu.yaml` + `DECIDER_GPU_LAYERS=0` | about 5.1 GB (+0.5 GB) | d1 runs on the CPU: a few seconds per item instead of 0.4 s, using ~2.5 GB of system RAM |
| ≤ 4 GB | also a smaller reader quantization (Q6_K or Q4_K_M) | about 3.5–4 GB | **untested:** smaller quantizations may misread digits, which is what the reader test punishes most |

What Immich needs, estimated from its model files (not measured):

| Immich model | Files (FP32 ONNX) | Likely GPU memory with OpenVINO (FP16 by default) |
|---|---|---|
| `buffalo_l` (faces) | 0.2 GB | under 0.5 GB |
| `ViT-SO400M-16-SigLIP2-384__webli` (smart search) | 1.7 GB image + 2.8 GB text | about 2.5–3 GB, up to ~5 GB if it stays FP32 |
| `PP-OCRv6_small` (OCR) | small | under 0.5 GB |

That's roughly 3.5–6 GB with everything loaded; with the pipeline's ~7.9 GB peak, the total stays under 14 GB of the
A770's 16 GB. Immich unloads idle models (`MACHINE_LEARNING_MODEL_TTL`), so its use peaks during import jobs. On a
6–8 GB budget, stay on d1-2B: d3-flash (6.8 GB) doesn't fit beside the reader, and Perplexity flash v1.2 (about 3.5 GB)
would land just over 8 GB while scoring no better than d1 against the household's answers.

## Reproducing

All of these change nothing in Actual or Nextcloud.

```
# Readers: dry-run a folder of receipts against your own filing, saving each reading
./receipts replay --nextcloud "/Receipts/Test"

# Deciders on whole receipts, reusing saved readings (identical input for every decider)
./receipts replay --readings /data/research/readings

# Deciders on your own hand-made splits (leave-one-out)
./receipts item-test <name> decider   # also: rules (no model); sees only history from before each split

# A different /v1/systemone model as the decider: set it in .env, download it, restart, then run the two commands above again
#   DECIDER_MODEL=ggml-org/vllm-d3-flash-GGUF:Q4_K_M   (bigger models: also DECIDER_CTX=8192 DECIDER_BATCH=4096)
./receipts download-models
./receipts restart

# A different local reader (a vision model: its repo needs an mmproj file): set it in .env, download it, restart, replay again
#   READER_LOCAL_MODEL=bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF:Q4_K_M   (optional READER_LOCAL_MMPROJ=F16, a file name or quant)
./receipts download-models
./receipts restart
./receipts replay --nextcloud "/Receipts/Test"
#   delete the READER_LOCAL_MODEL line and ./receipts restart to go back to Qwen3.5-4B

# The hosted Jev decider: first look at exactly what would be sent (nothing is sent), then the same replay with Jev
./receipts replay --readings /data/research/readings --preview-remote jev-preview
#   then choose the hosted decider in ./receipts setup and run the replay without --preview-remote

# The Perplexity decider (pplx) was removed after the comparison above, so it can't be reproduced.
```

New readings are saved to `data/research/readings/`, and item-test results to `data/research/`. The item test only
needs your own splits to have a few words in each part's note. Your numbers will differ: they depend on how many
hand-made splits you have and how personal your categories are.

## Caveats

- One household, one budget, 25 receipts and 44 items. Differences of one or two items are noise.
- The item notes are shorthand written by a person ("dinner for grandpa"), not receipt text ("NERDS GUMMY CLSTR"), so
  the item test compares models with each other rather than measuring real-world accuracy.
- The new descriptions were written from the same misses they were tested on.
- Speeds are for one RX 7900 XT on Vulkan. Other cards and backends will differ.

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

**What the first test suggests** ([research.md section 10](#10-newer-readers-a-9b-general-model-and-three-small-ocr-models)):
the OCR models were given the general model's instructions, which isn't their style, and still OvisOCR3 got 24 of 26
totals right and scored 96% on the receipts it could match. Its misses were mostly dates copied as printed, which code can
fix. Its weak spot was item lines (16 of 26 added up, against Qwen's 20), which code can't easily fix. Start with
OvisOCR3: a template prompt in its own style, the date and return handling moved into code, then the same replay test
against Qwen3.5-4B and the household's answers.
