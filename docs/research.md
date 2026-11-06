# Categorizing receipts with small local models: what we tested

This pipeline turns a receipt photo into a categorized (and, when needed, split) transaction in
[Actual Budget](https://actualbudget.org), using only models that run on a home GPU. These notes record which models
were tried for each step, how they were compared, and what the results were, so the choices in `compose.yaml` and
`.env.example` can be checked and redone on other hardware.

All tests below are **dry runs** against one household's real budget: nothing in Actual or Nextcloud was changed.
The sample is small (25 receipts, 44 hand-filed items), so read differences of one or two as noise.

**Status (November 2026):** reader, description and decision-model tests are done. Which decision model is best
depends on a household question the tests can't answer: see [More decision models](#4-more-decision-models).

## Summary

| Step | Choice | Why |
|---|---|---|
| Read the receipt | **Qwen3.5-4B** (Q8_0, thinking off) | The only reader of six with every total right; 20 s per receipt |
| Pick each item's category | **vLLM d3-flash 9B** (Q4_K_M); **LiquidAI d1-2B** (Q8_0) on small GPUs | Decision models give a confidence for each pick, which kept whole-receipt results at 97% vs Qwen's 75%. Against the household's own answers, d3-flash gets 95.8% of receipts right (14/16 exact) vs d1's 90.9%; see [section 4](#4-more-decision-models) |
| Biggest single gain | **Better category descriptions** | d1's correct picks on hard items went from 21/44 to 29/44 with no model change |
| Household specifics | **General descriptions + keywords** | Descriptions describe kinds of things; brand and one-off choices live in a keyword list (always / usually). As accurate as item-list descriptions; see [section 5](#5-general-descriptions-plus-keywords) |
| Not worth it | Reasoning on, a receipt-specific fine-tune, a 1B reader, having the reader rewrite item names | See [What didn't help](#what-didnt-help) |

Both models together use about 8.3 GB of VRAM as configured, or 7.4 GB with `compose.small-gpu.yaml`
([Hardware](#hardware)).

## How the pipeline uses models

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

- The **reader** is a general vision-language model served by llama.cpp (OpenAI-compatible API).
- The **decider** is a "System One"-style decision model served by llama.cpp's `/v1/systemone` endpoint. It scores
  every allowed category, so the pipeline gets a probability for its pick instead of free text.
- For each item the decider sees the item name, the rest of the receipt, how past purchases at that store were filed,
  every item note from past hand-made splits (from any store), and one description per category.
- Confidence gates: an item stays in the store's usual category at ≥ 0.5 (`CATEGORY_MIN_CONFIDENCE`) and is moved
  out of it only at ≥ 0.6 (`MOVE_MIN_CONFIDENCE`). Unsure items fall back to the store's category and the receipt
  goes to review.

## Test setup

- **Hardware:** AMD Radeon RX 7900 XT (20 GB), llama.cpp `server-vulkan` build b12124, Linux.
- **Receipt set:** 25 photos of real receipts (grocery, warehouse club, big-box, hardware and thrift stores, two
  paid in cash, several with no printed date). 16 of them match a bank transaction that was already filed by hand,
  so they can be scored against the household's own categorizing.
- **Item set:** every split transaction the household made by hand whose parts have a short note
  ("Nerds", "kids' shorts", "dinner for grandpa"): 32 purchases at 12 stores, **44 items**. These are the hard cases by
  construction: each one was filed somewhere other than the store's usual category. Only 3 of the 44 match the
  category the store's rule gives.
- **Leave-one-out:** while a purchase is being tested, it's hidden from both the store history and the item-note
  history, so the decider can't see the answer.
- Readers were tested one at a time on the GPU, with the same prompt, image preprocessing and JSON schema.
  The decider tests reuse saved readings, so every decider sees identical input.

### Metrics

| Metric | Meaning |
|---|---|
| Totals right | the receipt total read exactly (the field used to find the bank charge) |
| Dates read wrong | a date was returned that isn't the printed purchase date (worse than no date: no date goes to review) |
| Items add up | line items sum to the printed subtotal within 2% (otherwise an item was missed or misread) |
| Ready with no review | receipts the pipeline could apply without a human looking |
| Pick right | the decider's top category equals the household's |
| Filed right | what the pipeline would actually file after the confidence gates |
| Average match | per receipt, the share of the charged amount that ended up in the same categories as the household's own filing |

## 1. Receipt readers

25 receipts, reasoning/thinking off unless noted. Seconds are the median per receipt on the RX 7900 XT.

| | LFM3-VL 2B (thinking on) | **Qwen3.5-4B** | Gemma 4 E4B | Nemotron 3.5 Bolt E4B | MiniCPM-V 4.7 1B | LedgerLens 2B (receipt fine-tune) |
|---|---|---|---|---|---|---|
| Quantization | Q8_0 | Q8_0 | Q8_0 | Q8_K_XL | Q8_0 | Q4_K_M |
| Totals right | 24/25 | **25/25** | 22/25 | 22/25 | 23/25 | 23/25 |
| Dates read right (of 23 printed) | **16** | **16** | **16** | **16** | 15 | 13 |
| Dates read wrong | 1 | 1 | **0** | **0** | 7 | 3 |
| Items add up | 17 | **20** | 18 | 16 | 14 | n/a¹ |
| Cash receipts recognized | **2/2** | **2/2** | 1/2 | 1/2 | 0/2 | 1/2 |
| Ready with no review | 15 | **16** | 13 | 13 | 12 | 12 |
| Seconds per receipt | 28 | 20 | 9 | 9 | **7** | 9 |

¹ LedgerLens only works with its own training prompt, which has no subtotal, payment method or store clues, so this
check can't run and cash can't be detected from the change given.

Observations:
- **Qwen3.5-4B** was the only reader with every total right. LFM3 dropped a decimal ($40.62 → $400.62).
- **Gemma 4 and Nemotron** are twice as fast and never invented a date, but both misread a large total by $17–20 and
  both took the cash handed over as the total on a cash receipt.
- **MiniCPM-V 1B** wrote the same made-up date on receipts that have none printed. Fast, but unsafe here.
- **LedgerLens**, the only usable receipt-specific fine-tune found, did no better than general models. It was trained
  on Indonesian and Malaysian receipts (CORD, SROIE).
- One photo had its date misread by every model, so the image was the problem, not the models.

### Does reasoning help the reader?

| Qwen3.5-4B | Thinking off | Thinking budget 1,024 tokens |
|---|---|---|
| Totals right | 25/25 | 25/25 |
| Dates read wrong | 1 | 1 |
| Items add up | 20 | 20 (3 fixed, 3 broken) |
| Ready with no review | 16 | 16 |
| Seconds per receipt | **20** | 50 |

Same totals, dates and outcomes on all 25 receipts, at 2.4× the time. Thinking stays off (`LLM_THINKING=false`).

## 2. Item categorizers

### Hard items (44 hand-filed items, leave-one-out)

Same original category descriptions for every row.

| | Pick right | Filed right | Left uncategorized | Time per item |
|---|---|---|---|---|
| No model (store rule, else the store's most-used category) | 6 | 6 | 2 | 0 s |
| LiquidAI d1-2B | 21 | 14 | 7 | 0.4 s |
| LFM3-VL 2B (as a text categorizer) | 23 | 23 | 0 | 22 s |
| Qwen3.5-4B (as a text categorizer) | 24 | 24 | 0 | 1.8 s |

d1's "filed" number is lower because its unsure picks are held back. Before the description work its confidence
separated right from wrong poorly: right picks ranged 34–92%, wrong ones 31–90%.

### Whole receipts (the 16 comparable inbox receipts)

This is the test that matters more: most items on most receipts belong in the store's usual category, and a
categorizer has to leave them there.

| Decider | Average match | Exactly right |
|---|---|---|
| d1-2B | **97%** | **15/16** |
| Qwen3.5-4B (no confidence scores) | 75% | 7/16 |

Without confidence scores there's nothing to gate on, so every one of Qwen's guesses is applied. It moved ordinary
grocery items out of Groceries, and most of a big-box purchase out of the category the household uses for that store.
Qwen picks as well as d1 one item at a time, but is worse as the decider.

### What limits accuracy

About 15 of the 44 items can't be known from the item name: candy and soda that belong to one adult's personal
category, hummus and mints that belong to the other's, a kids' size versus an adult size, thrift-store "clothes"
for a particular person. No model size fixes that; it has to come from the household. That's what the category
descriptions are for.

## 3. Category descriptions

The decider chooses among one description per category. The original descriptions were written by a model from
each category's past transactions, then reviewed by the household. The new ones were written from the hard-item
misses and corrected by the household. They name items by brand, say what a category is *not* for, and give
price hints. Examples, shortened, with the household's names replaced:

| Category | Before | After |
|---|---|---|
| Groceries | Food and drink to eat at home: groceries, snacks, and pantry staples from supermarkets and warehouse clubs | Food and drink for the whole household to eat at home: produce, meat, dairy, bread, pantry staples, shared drinks and snacks. **Not** candy or soda treats (Adult 1's), hummus or mints (Adult 2's), baby food, diapers or distilled water (Kids), vitamins (Health), or cleaning and household supplies such as dishwasher detergent and batteries (Misc). |
| Adult 1 | Adult 1's own purchases: software, tech subscriptions, computer gear, games, men's clothes, candy or soda snacks | …computer gear, **chargers and cables**, **men's and adult-size clothes such as shorts and shirts**, and Adult 1's candy and soda treats (**Nerds, Reese's Pieces, Nutty Bars, Dr Pepper**) |
| Restaurants | Prepared food eaten out or taken away: fast food, sit-down meals, deli sandwiches | …**typically under $50**. Bigger restaurant bills are often gift meals (Gifts). |
| Gifts | Presents and treats for other people: clothing, socks, quilts, cards, occasion dinners | Presents for **people outside the household**, **usually bought around a birthday or a holiday**: …kettles, greeting cards, gift sets for other people's kids, and gift meals, which are **usually restaurant bills over $50** |

Results with d1-2B (calendar reading off, which is the default):

| | Original descriptions | New descriptions |
|---|---|---|
| Hard items, pick right | 21/44 | **29/44** |
| Hard items, filed right | 14/44 | **22/44** |
| Right picks' confidence (median) | 65% | 72% |
| Wrong picks' confidence (median) | 53% | 54% |
| Whole receipts, average match | 97% | 97% |
| Whole receipts, exactly right | 15/16 | 14/16 |

- The hard-item gain is **optimistic**: the new descriptions were written from these same 44 misses. The
  whole-receipt check is the fairer test, and it stayed at 97%.
- The one receipt that got worse moved a $3.99 bag of candy to a personal category on a receipt the household had
  filed whole. Whether that's a mistake is a judgment call.
- With birthdays from a Nextcloud calendar added as a gift hint (`OCCASIONS_CALENDAR=true`), the hard items went to
  30/44 picked and 24/44 filed. It's off by default for privacy; US holidays are always computed locally.

Other guardrails that came out of these runs:
- **Moving an item out of the store's category needs 0.6, staying needs 0.5.** In testing every wrong split was a
  near miss at 54–55% confidence.
- **A restaurant charge over $50** is applied and also sent to review as a possible gift meal (`GIFT_MEAL_MIN`).
- **Cash and return receipts** go straight to review: there's no bank charge, and the pipeline never creates
  transactions.

## What didn't help

| Idea | Result |
|---|---|
| Reader thinking on (1,024-token budget) | Same answers, 2.4× slower |
| Receipt-specific fine-tune (LedgerLens) | No better than general models; can't read subtotal or payment method |
| Smallest reader (MiniCPM-V 1B) | Invents dates |
| Having the reader rewrite item codes in plain words | Turned "MED-CHILD PIC" (children's books) into "child milk"; off (`READ_PLAIN_NAMES=false`) |
| The reader as categorizer (no decision model) | Good single picks, but 75% vs 97% on whole receipts |
| d1-2B on Transformers/ROCm instead of the GGUF | Identical answers, a 37 GB base image; removed |
| Lower confidence thresholds | d1's confidence overlaps for right and wrong picks; lowering lets wrong splits through |

## 4. More decision models

Five newer decision models, run through the same two tests with the new descriptions (calendar off). All are
4-bit GGUFs except d1-2B (Q8_0). VRAM is measured after loading, at 8k context (27B: 4k).

| Decider | Params | VRAM | Hard items: pick right | Hard items: filed right | Whole receipts: average | Whole receipts: exact | Per item | Confidence when right / wrong (median) |
|---|---|---|---|---|---|---|---|---|
| LiquidAI d1-2B (current) | 2B | 2.7 GB | 29 | 22 | **96.8%** | **14/16** | **0.4 s** | 72% / 54% |
| Base Labs elephant-1 | 9B | 5.6 GB | 32 | 26 | **96.8%** | **14/16** | 0.9 s | 79% / **47%** |
| vLLM d3-flash | 9B | 6.8 GB | 34 | 29 | 91.9% | 11/16 | 0.7 s | 86% / 73% |
| Perplexity pplx-decider-flash v1.2 | 4B | ~3.5 GB¹ | 33 | 30 | 92.2% | 12/16 | 2.3 s² | 85% / 75% |
| Perplexity pplx-decider v1.1 (Artemis IQ3_M) | 27B | 15.0 GB | **35** | **31** | 91.1% | 10/16 | 2.8 s | 92% / 73% |
| Cloudflare Clef-Flash | 9B | 6.8 GB | 23 | 7 | 93.8%³ | 15/16³ | 0.7 s | 47% / 46% |

¹ 2.9 GB file; not measured separately. ² One HTTP round trip per item plus the readout in JavaScript; not optimized.
³ Clef-Flash is unsure about almost everything (median 47%), so nearly every item falls back to the store's
category. That scores well on whole receipts and badly on hard items: it's barely deciding.

**How to read this.** The two tests pull in opposite directions:
- The **hard-item test** rewards a model that moves items out of the store's usual category, because every one of
  those 44 items was moved. Every larger model beats d1 here, and Perplexity 27B is best.
- The **whole-receipt test** rewards leaving things alone, because most receipts were filed whole. Only elephant-1
  matches d1 here.

The confident models' whole-receipt "misses" are mostly items the new descriptions say belong elsewhere, on
grocery trips the household had filed whole:

| Receipt (filed whole as) | Items moved out | By |
|---|---|---|
| Warehouse club (Groceries) | shampoo → Misc, hummus → Adult 2 | d3-flash, both Perplexity models; elephant-1 moved only the shampoo |
| Warehouse club (Groceries) | paper plates and foil → Misc | d3-flash |
| Grocery store (Groceries) | Gold Bond lotion → Health (d3-flash, Perplexity flash), a toy ball → Kids (Perplexity flash) | |
| Big-box store (Kids) | a bag of candy → Adult 1 | d1, d3-flash, both Perplexity models |
| Big-box store (Kids) | cleaners and hangers → Misc | Perplexity 27B |

So which model is "best" depends on whether the household wants those splits made. If yes, d3-flash or
Perplexity flash v1.2 are better than d1 and the whole-receipt numbers understate them. If not, elephant-1 is the
safe upgrade: d1's whole-receipt result, better hard-item picks, and the clearest gap between its confidence when
right and when wrong.

### Scored against the household's answers

The household reviewed those moves: all of them were right, except that Gold Bond belongs to Adult 2 (not Health), and
hangers can go to Misc or Home & Auto. The descriptions were updated to say so, and the three main candidates were
rerun. This time a receipt is scored against the household's filing *with those splits made*, so a model loses credit
for leaving shampoo in Groceries as well as for moving the wrong thing:

| Decider | Whole receipts: average | Whole receipts: exact | Still wrong |
|---|---|---|---|
| vLLM d3-flash 9B | **95.8%** | **14/16** | the two cleaners (left with the store's category) |
| LiquidAI d1-2B | 90.9% | 11/16 | plates, foil, shampoo, hummus, Gold Bond, cleaners |
| Perplexity flash v1.2 4B | 90.8% | 12/16 | plates, foil, Gold Bond, cleaners, hangers |
| Base Labs elephant-1 9B¹ | 90.3% | 10/16 | plates, foil, candy, Gold Bond, hummus, cleaners, hangers |

¹ elephant-1 was not rerun; this is its earlier run (before the Gold Bond and hanger changes) rescored.

The 16th receipt, a thrift-store trip split three ways, is hard for every model (about 63%) and counts against all of
them equally. Picks for hard items moved only a little with the update (d1 28/44, d3-flash 33/44, Perplexity flash
33/44). **This household now runs d3-flash** (`DECIDER_MODEL` in `.env`). The repository default stays d1-2B,
which fits small GPUs (see [Hardware](#hardware)).

Practical limits:
- **Perplexity 27B** needs 15 GB, so it can't share a 20 GB card with the reader.
- **Perplexity flash v1.2** has a newer protocol than llama.cpp's `/v1/systemone`. llama.cpp runs it with
  non-causal attention and returns per-token hidden states (`--embeddings --pooling none`), and the worker applies
  the model's readout matrix itself (`worker/src/pplx.js`). A sanity check confirmed the attention really is
  non-causal and that easy questions come back right at 88–99.9%.
- **elephant-1** is a community GGUF upload (MIT license), not an official one.

Looked at and skipped: Nimble 9B (non-commercial license, poorly calibrated), Strands Decider 2B (stock llama.cpp
can't run it), Tev1 4B (about the same as d1-2B on public benchmarks), Jev (hosted only, no open weights), and
Perplexity v1.2 27B (no GGUF that stock llama.cpp can load).

## 5. General descriptions plus keywords

Section 3's fixes worked by writing specific items into the descriptions ("Gold Bond", "Nerds, Reese's Pieces",
"Pantene"). That turns descriptions into lists the model has to scan, and every one-off makes them longer. The
alternative tested here:
- **Descriptions say kinds of things and whose they are**, plus typical stores ("Adult 2's own purchases: beauty, skin
  care and personal care products, ...").
- **Keywords hold the household's arbitrary choices**, things a stranger couldn't guess from a description: a lotion
  brand that one adult always uses, a candy one adult buys, a cleaner brand whose name says nothing. Each has a
  strength. **always** files the item without asking the model. **usually** gives the model a hint, then multiplies
  that category's probability by a weight (20) before taking the top pick. The model can still overrule a "usually"
  keyword when it's much surer of something else.
- **Similar past items**: the model also sees the 8 past items whose names best match this one, and how each was
  filed. Before, it saw only the newest 15 item notes per category, whatever they were.

Matching is on the raw receipt text: lowercase, apostrophes dropped, letters split from digits ("PANTENE10" →
"pantene 10"), whole words with an optional plural. Multi-word phrases also match when the receipt runs them
together ("DRPEPPER").

Results with d3-flash, scored against the household's answers as in section 4 (14 keywords: 6 always, 8 usually):

| Setup | Hard items: pick right | Hard items: filed right | Whole receipts: average | Whole receipts: exact |
|---|---|---|---|---|
| Specific descriptions (item lists) | 33 | 28 | 95.3% | 13/16 |
| Specific + similar items | **34** | **30** | 95.8% | 14/16 |
| General descriptions, no keywords | 26 | 21 | 91.8% | 11/16 |
| General + keywords, all final | 31 | 26 | **97.0%** | **14/16** |
| General + all final + similar items | 32 | 28 | **97.0%** | **14/16** |
| General + always/usually + similar items (chosen) | 33 | 29 | 90.8%¹ | 13/16 |
| General + candy-by-size wording + always/usually + similar | 33 | 29 | 93.2% | 11/16 |

¹ Apart from the hangers that every setup misses, the only miss is one cleaning pail on a small hardware-store
receipt (Misc instead of Home & Auto), a 66% pick that flips between runs. Because the receipt is small, that one
item costs 6 points of the average.
After the final code review fixes, the chosen setup was replayed once more on the live configuration: 97.0%, 14/16,
with the hangers as the only miss.

Keyword-matched items made up 11 of the 44 hard items and were right 10 times. The miss was a historical filing the
household has since changed. On the other 33, general and specific descriptions came within one pick of each
other. The keywords were partly taken from the test items, so the keyword rows say more about matching than about
the model.

What we learned:
- **A hint in the prompt alone does nothing.** Given `household_keyword: Gold Bond → Adult 2`, d3-flash still said
  Health at 63%. Weight 4 wasn't enough either. At weight 20, "usually" behaves almost like "always" unless the model
  is very sure.
- **Similar past items helped every setup** (+1–2 picks, +2–4 filed) and add about 300–650 tokens to the prompt.
- **Telling candy apart by size backfired.** We tried "a single bar or small bag is a personal treat, family-size
  and bulk packs are Groceries". The model then sent a $15 warehouse-club box of peppermint bark and the
  big-box-store M&M's to Adult 1. Candy, chips and soda can be anyone's, so for those items the history of similar
  items and a review are a better bet than a rule.
- **Dropping store names from the descriptions cost more than dropping items.** The first general draft left out
  the grocery stores and lost points on a big-box trip filed under Kids. Putting the stores back recovered most of it.

## Hardware

### Measured VRAM

Measured on Vulkan right after loading (RX 7900 XT). Image encoding needs some working memory on top of this, so leave
about 0.5 GB of headroom.

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
| Intel Arc | the same Vulkan images (Mesa's ANV driver). Set `RENDER_GID` to your host's `render` group | Not yet |
| NVIDIA | `compose.nvidia.yaml`: llama.cpp `server-cuda` images; needs the NVIDIA Container Toolkit | Not yet |
| CPU only | change `-ngl 99` to `-ngl 0` | Works, much slower |

To use an override, add it to `.env` so `./receipts` picks it up:
```
COMPOSE_FILE=compose.yaml:compose.nvidia.yaml                          # NVIDIA
COMPOSE_FILE=compose.yaml:compose.small-gpu.yaml                       # smaller budget, AMD or Intel
COMPOSE_FILE=compose.yaml:compose.nvidia.yaml:compose.small-gpu.yaml   # both
```

On Intel, llama.cpp also has a SYCL build (`server-intel`). Vulkan is the safer first try because it's the backend
these models were tested on. Qwen3.5's linear-attention layers aren't equally supported by every backend, and any
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

That's roughly 3.5–6 GB with everything loaded. Next to the pipeline's ~7.9 GB at its peak, the total stays under
14 GB of the A770's 16 GB. Immich's ML service unloads its models after they've been idle for a while
(`MACHINE_LEARNING_MODEL_TTL`), so its use peaks during import jobs.

On a 6–8 GB budget, stay on d1-2B. d3-flash (6.8 GB) doesn't fit beside the reader. Perplexity flash v1.2 (about
3.5 GB) would land just over 8 GB, and it scored no better than d1 against the household's answers.

## Reproducing

All of these change nothing in Actual or Nextcloud.

```
# Readers: dry-run a folder of receipts against your own filing, saving each reading
./receipts replay --nextcloud "/Receipts/Test"

# Deciders on whole receipts, reusing saved readings (identical input for every decider)
./receipts replay --readings /data/research/readers/qwen3.5-4b

# Deciders on your own hand-made splits (leave-one-out)
./receipts item-test <name> decider   # also: rules (no model)

# A different /v1/systemone model as the decider: set it in .env, restart, then run the two commands above again
#   DECIDER_MODEL=ggml-org/vllm-d3-flash-GGUF:Q4_K_M   (bigger models: also DECIDER_CTX=8192 DECIDER_BATCH=4096)
./receipts restart

# The Perplexity decider (pplx) was removed after the comparison above, so it can't be reproduced.
```

New readings are saved to `data/research/readings/`, and item-test results to `data/research/`.

The item test only needs your own splits to have a few words in each part's note. Your numbers will differ: they
depend on how many hand-made splits you have and how personal your categories are.

## Caveats

- One household, one budget, 25 receipts and 44 items. Differences of one or two items are noise.
- The item notes are shorthand written by a person ("dinner for grandpa"), not receipt text ("NERDS GUMMY CLSTR"), so
  the item test compares models with each other rather than measuring real-world accuracy.
- The new descriptions were written from the same misses they were tested on.
- Speeds are for one RX 7900 XT on Vulkan. Other cards and backends will differ.
