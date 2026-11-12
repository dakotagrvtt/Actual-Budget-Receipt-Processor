[How it works](how-it-works.md) › Splitting and writing to Actual

# Splitting and writing to Actual

How the bank amount is divided across categories, and what the worker writes in Actual.

**In short**

- The bank amount, tip included, is divided by item share; the parts always add up exactly.
- Several categories become an Actual split, one part per category, with a `#receipt <file>` note on the parent.
- Tax goes only to the taxed items when the receipt adds up; otherwise it is spread in proportion.
- Doubtful items stay in the store's usual category, else go to an **Uncategorized** part; the confident part is applied and, if money moved, the receipt goes to **Needs review**.
- Right before writing, the worker re-checks the transaction; if you changed it meanwhile, nothing is written.

## How the amount is split

Each category gets its share of the items, tip and rounding included.

| Situation | What happens |
|---|---|
| One category, same as the charge's | Only a `#receipt` note is added |
| One category, different | The charge switches, if an item is clearly sure ([how sure](categories.md)) |
| Several categories | An Actual split, one part per category; each part's note lists its items |
| A category that nets negative (an exchange) | A credit part; reviewed |
| Charge in an excluded, hidden or income category | Never changed; reviewed |

- **Small parts** under `SPLIT_MIN_AMOUNT` are folded into the charge's current category or the largest part. Uncategorized and credit parts never are.
- **Splits need Actual 26.8.0 or newer.** On older versions, or with `SPLIT_TRANSACTIONS=false`, an uncategorized charge gets the largest category, a categorized one keeps its own, and the note lists the breakdown.

## Discounts and coupons

A negative line that is clearly a discount is folded into its item (the one with its item number, else the one above), so it can't shift money between parts: "CEREAL (pipeline: after 3.00 off)".

- Exchanges, gift cards, whole-receipt coupons and returns stay lines of their own.
- A numbers-only discount line read as positive may be flipped to negative when that makes the items match the subtotal; the receipt page says so.

## How tax is placed

Tax is shared only among the taxed items' categories, so untaxed groceries don't pay tax on household goods. This needs the receipt to add up, a taxed item and a believable rate; otherwise tax is spread in proportion. The receipt page shows how it was spread.

<details><summary>Receipts with several tax rates</summary>

The printed tax lines (`A 7.000% TAX 4.39`) decide: each is spread over the items with its code. Codes are matched by letter, or by the numbers when that gives one clear pairing; anything unclear falls back to proportion.

</details>

<details><summary>Items over the printed subtotal (a missed discount)</summary>

When coded tax lines show which group of items is over, the gap is taken off that group so tax can still be placed. The receipt page shows which items were lowered and how to fix them. The receipt is then reviewed if money moves.

</details>

## When it goes to review

If finding the charge isn't clear-cut (no match, two matches, cash or return, an excluded category), nothing changes and the receipt goes to **Needs review** with a JSON file saying why. If it is found but some items are doubtful, the confident part is applied and, if that moves money (a split or new category), the receipt is reviewed (`APPLY_THEN_REVIEW`); one that only confirms the category gets just the note.

- **Unsure items** become an **Uncategorized** part whose note lists the decider's guess, e.g. `MED-DVD'S (maybe Child 34%)`. If the store has a usual category, they go there instead: the charge's current category first, then your rule's.
- **Missed money** (items below the subtotal) goes to the store's usual category, or to the Uncategorized part.
- **Also reviewed if money moves:** a tip, a charge dated the day before, no readable date, a credit part, or a store whose every past purchase went elsewhere.
- **The `#review` tag** goes on the parent's note, so you can search for it in Actual.

## Write guard

Right before writing, the worker reads the transaction again.

- If its account, amount, category, notes or split changed since matching, or its account is no longer searched, nothing is written and the receipt goes to **Needs review**.
- A split is never written onto a charge that has become a split.
- A dry run (changes nothing) writes nothing and skips this check.

## Undoing a change

The parent's note keeps your original note plus `#receipt <file>`, and the `.json` summary in Nextcloud records what changed. To undo it in Actual:

1. Delete the split parts.
2. Set the category.
3. Remove `#receipt <file>` from the note, or the receipt counts as applied and is never matched again.

## Actual upgrades

With `ACTUAL_API_VERSION=auto` the worker installs the API version your Actual server runs (internet needed once per version) and picks up an upgrade within about 10 minutes; if that fails, it says so in the app. With a pinned version, set the new one and run `./receipts update`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `TAX_BY_ITEM` | `true` | Tax goes to taxed items only; `false` spreads it in proportion |
| `TAX_BY_ITEM_MAX_RATE` | `0.12` | Highest believable tax rate |
| `SPLIT_TRANSACTIONS` | `true` | `false` never splits a charge |
| `SPLIT_MIN_AMOUNT` | `1.00` | Smaller parts are folded in |
| `OVERWRITE_CATEGORIZED` | `true` | `false` sends a one-category change of a categorized charge to review |
| `EXCLUDE_CATEGORY_GROUPS` | `Bills` (set by setup or `./receipts exclude`) | Category groups receipts never change |
| `EXCLUDE_CATEGORIES` | unset | Single categories receipts never change |
| `MATCH_ACCOUNTS` | unset (all open, on-budget accounts) | Accounts searched, and re-checked by the write guard |
| `APPLY_THEN_REVIEW` | `true` | `false` holds a doubtful receipt without changing anything |
| `ACTUAL_API_VERSION` | `auto` | Or pin a version |

All settings: [.env.example](../.env.example), or Settings in the web app.
