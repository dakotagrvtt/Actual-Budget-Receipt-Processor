[How it works](how-it-works.md) › Picking categories

# Picking categories

How each item on a receipt gets its category, and what happens when the pipeline is unsure.

**In short**
- Your Actual rules (or your re-filing) set the store's usual category; the decider (the model that picks a category per item) moves items out of it only when clearly sure.
- Unsure items stay in the store's usual category, or become an Uncategorized part for you to fill in.
- Keywords you set (or that it learns) can file an item directly or nudge the decider.
- A whole-purchase check keeps a food-court visit from splitting three ways.
- Edit the category descriptions under **Settings › Categories** to teach it your household.

## Which decider to use

The decider runs locally and gives each item a probability for every category. Setup offers two; `DECIDER_MODEL` accepts any other `/v1/systemone` GGUF model.

| Decider | GPU memory | Right on the test receipts |
|---|---|---|
| d1-2B (default without setup) | about 2.7 GB | 90.9% |
| vLLM d3-flash 9B (suggested at 14 GB or more) | about 6.8 GB | 95.8% |

After changing it, run `./receipts download-models` and `./receipts restart`. More in [research](research.md#2-item-categorizers).

## Your Actual rules

The worker reads your rules (never changes them) and works out the category they give the matched charge. That, or the charge's current category if you re-filed it, is the store's usual category: the decider is told it, and unsure items stay there.

## How sure it must be

Two numbers come from each item's probabilities: **confidence** (the chosen category's probability) and **margin** (its lead over the next best).

| To... | It needs |
|---|---|
| Stay in the store's category | `CATEGORY_MIN_CONFIDENCE` (0.5) |
| Move out of it | `MOVE_MIN_CONFIDENCE` (0.6) and `MOVE_MIN_MARGIN` (0.2), so a near tie never moves money |

Below the first bar an item is unsure; the receipt is reviewed if that moves money. If wanted splits end up as single-category confirms, lower the move bars, at the cost of more wrong items ([research](research.md#7-confidence-as-a-probability-re-tuned)); [replay tests](testing.md) let you try thresholds offline.

## The whole-purchase check

`RECEIPT_CHECK` asks one more question per receipt (one more anonymized request with the [hosted decider](cloud.md#hosted-decider)): which single category fits the whole purchase? A Coke, a chicken bake and chicken strips then file together.

- If the answer is at least `RECEIPT_CHECK_MIN_CONFIDENCE` sure, an item keeps its own pick only if that pick passes its usual bar and leads by `MOVE_MIN_MARGIN`; the rest join the answer's category. Items still leave the store's usual category only if the answer itself passes the move bars.
- A real mixed run still splits: a household item at 80% keeps its category. `always` keywords are never pulled.
- If no single item picked the new category, the receipt gets a review note saying the move rests on the whole-purchase answer.

## When review is skipped

If the receipt agrees with your rule's category, the only change is a `#receipt` note, even with unsure items or a missed line. A recategorize or split is reviewed when an item is unsure, the items don't add up, or every past purchase at the store (3 or more) went elsewhere.

## What the decider sees

For each item it gets:

- the item name, with store department codes like `MED-` removed
- the other items on the receipt
- how you filed past purchases at that store (the pipeline's unchecked picks labeled apart)
- your rule's category and the charge's current category
- similar past items from any store, and your newest item notes per category ("Egg Book → Child")
- nearby holidays (worked out locally) as a gift hint
- only categories you haven't excluded (default: the Bills group; add others with `./receipts exclude`)

A restaurant charge over `GIFT_MEAL_MIN` is applied but reviewed, since it may be a gift meal.

## Category descriptions

The decider chooses among your category descriptions, so they hold household knowledge, such as what belongs to each kid. Edit them under **Settings › Categories**; changes apply at the next receipt.

An empty one gets a draft written locally from its past transactions (not with a cloud reader; on demand: `./receipts describe`). Rewrite drafts in your own words; yours are never overwritten.

## History gets better when you check it

The pipeline's own splits count only as unchecked picks until you remove `#review` or change them. When you split by hand, a few words in each part's note ("DVDs") help too. See [Learning from your corrections](learning.md).

## Keywords

A keyword says "items matching this phrase belong in this category", e.g. `Pampers` → `Daily Expenses / Kids`.

- It matches whole words, ignoring case, with plurals and run-ons (`DRPEPPER` matches `Dr Pepper`).
- A keyword for one store (`--at`) beats a global one; more words beat fewer.
- Two best keywords with different categories cancel out and flag the receipt.

Each keyword is `always` (files the item at 100%, skipping the decider) or `usually` (a hint that boosts that category). `KEYWORD_MODE` can override that for all keywords: `final`, `hint` or `off`.

| Where | How |
|---|---|
| App | **Category rules** page under Settings |
| CLI | `./receipts keyword add "Pampers" Kids [--at Target] [--always\|--usually]`; also `remove`, `list`, and `test "PAMPERS SWDRS SZ4"` |
| Actual | `#always Pampers` (or `#usually`) in a split part's or transaction's note adds it with that category |

Changes apply at the next receipt. A keyword you remove isn't brought back by a tag.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `DECIDER_MODEL` | `LiquidAI/d1-2B-GGUF:Q8_0` (setup asks) | Decider GGUF model |
| `DECIDER_CTX`, `DECIDER_BATCH` | 16384, 8192 (small-GPU setup: 8192, 4096) | Context and batch; d3-flash needs 8192, 4096 |
| `CATEGORY_MIN_CONFIDENCE` | `0.5` | Below this an item is unsure |
| `UNSURE_ITEMS_USE_STORE_CATEGORY` | `true` | Unsure items stay in the store's category |
| `MOVE_MIN_CONFIDENCE` | `0.6` | Confidence needed to move an item |
| `MOVE_MIN_MARGIN` | `0.2` | Lead needed to move |
| `RECEIPT_CHECK` | `true` | Whole-purchase question |
| `RECEIPT_CHECK_MIN_CONFIDENCE` | `0.5` | Bar for that answer |
| `GIFT_MEAL_MIN` | `50` | Restaurant charges over this many dollars are reviewed |
| `OCCASIONS_CALENDAR` | `false` | Also read birthdays from Nextcloud calendars (Nextcloud storage only) |
| `STRIP_DEPARTMENT_PREFIXES` | `true` | Remove codes like `MED-` from item names |
| `SIMILAR_ITEMS` | `true` | Send similar past items |
| `HOUSEHOLD_EXAMPLES` | `5` | Item notes per category sent; `0` sends none |
| `KEYWORD_MODE` | `mixed` | `mixed` follows each keyword's strength |
| `KEYWORD_HINT_WEIGHT` | `20` | How much a hint boosts its category |

All settings: [.env.example](../.env.example), or Settings in the web app.
