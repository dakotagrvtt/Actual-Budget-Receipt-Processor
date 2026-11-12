[How it works](how-it-works.md) › Finding the bank charge

# Finding the bank charge

How the worker (the program that does the rest) finds the bank transaction a receipt belongs to.

**In short**

- Your bank sync has already imported the charge; the worker never creates transactions here.
- It needs exactly one match on amount, date and payee.
- No match yet: the receipt waits in the inbox and is re-checked every hour.
- Anything unclear changes nothing in Actual; the receipt goes to **Needs review** with a JSON file saying why.
- A tip makes a restaurant charge higher than the receipt: set `MATCH_TOLERANCE_PERCENT=25`.

## What counts as a match

A transaction must pass all three tests, and be the only one that does.

- **Amount:** an outflow equal to the receipt total, or larger by up to `MATCH_TOLERANCE_PERCENT` (tips; reviewed if money moves).
- **Date:** from 1 day before the receipt date (reviewed if money moves) to `MATCH_DAYS` after, since posting lags.
- **Payee:** the payee or the bank's raw description must look like the store (`PAYEE_MIN_SCORE`).

Transfers, splits and anything tagged `#receipt` are skipped; charges your rules already categorized are still matched.

## How store names are compared

Prefixes, store numbers and city are stripped, so `TST* JOES PIZZA #42` matches `Joe's Pizza`.

- **Look-alike chains don't match:** a shared first word (Dollar Tree vs Dollar General) isn't enough.
- **Names it misses:** add them to `data/payee-aliases.json` (see `payee-aliases.example.json`).
- **Clues** such as `target.com` can match when the logo is cut off (never a city).
- **Two charges that fit about equally** go to review.

## When the charge isn't there yet

The receipt waits in the inbox until the day after the `MATCH_DAYS` window, re-checked hourly without being read again.

- **Check now** (under **Activity and test mode**, or `./receipts run-now`) re-checks right away.
- A **pending** charge is waited on up to 2 more days to clear; after that it's applied and reviewed.
- Still no match: review. If the payee was the problem, the JSON lists charges that fit amount and date, so you can add an alias.

## When the receipt has no readable date

The worker searches the 14 days before the upload; a match there is used, and anything that moves money is reviewed.

- **Only an older match** (up to a year back): nothing is applied, except by the extended search below; the review JSON and the receipt page name it.
- **Uploading a backlog of old receipts:** raise `MATCH_NO_DATE_RECENT_DAYS` for that batch.

<details><summary>The extended search (120 days)</summary>

When the recent days hold no charge and the wait is over, the worker searches back further.

- Exactly one charge must have the exact amount and a payee that fits the store, and no other charge there may fit.
- A match is always tagged `#review` and filed in **Needs review**.

</details>

## Tips

Set `MATCH_TOLERANCE_PERCENT=25` so a restaurant charge with a tip still matches. It is reviewed if it moves money; a receipt that only confirms the category gets just a note.

## The receipt check

Items should add up to the subtotal (within 2%; tax-included prices count). If not, the missing money goes to the store's usual category or Uncategorized, and a split or recategorize is reviewed.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `MATCH_TOLERANCE_PERCENT` | `0` | Allowed tip, in percent of the total |
| `MATCH_DAYS` | `4` | Days after the receipt date the charge may post |
| `PAYEE_MIN_SCORE` | `0.6` | How closely (0 to 1) the payee must match |
| `MATCH_RECHECK_MINUTES` | `60` | How often a waiting receipt is re-checked |
| `MATCH_PENDING_WAIT_DAYS` | `2` | Extra days to wait for a pending charge to clear |
| `MATCH_NO_DATE_RECENT_DAYS` | `14` | Undated: days before upload searched |
| `MATCH_NO_DATE_LOOKBACK_DAYS` | `365` | How far back an older charge is named |
| `MATCH_NO_DATE_EXTENDED_DAYS` | `120` | Undated: extended search; `0` is off |

All settings: [.env.example](../.env.example), or Settings in the web app.
