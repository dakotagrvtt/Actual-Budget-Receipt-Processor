[How it works](how-it-works.md) › Learning from your corrections

# Learning from your corrections

How the pipeline learns from what you fix in Actual, without writing to Actual.

**In short**

- About every 6 hours it re-reads the charges it filed and notices what you changed.
- A corrected item counts as your choice, and the decider (the model that picks categories) is told about it.
- Repeated corrections at one store become learned keywords, with size limits.
- One exception doesn't delete a keyword; votes for and against decide.
- **Forget** on a lesson, or removing a keyword, is permanent.

## What it watches

Every charge filed in live mode is watched for 60 days and read back about every 6 hours. Dry runs aren't watched.

- An untouched charge teaches nothing, except that removing `#review` alone counts as a confirmation.
- A charge that is gone, changed amount or lost its `#receipt` tag is dropped.
- **A lone item** you recategorized is a clear lesson; **a whole receipt** moved to one category is a weaker one.

## How lessons are used

A corrected item shows in the history as yours, and the decider gets up to 3 "you corrected this before" lines for similar items. Splits you never touched are labeled unchecked and never counted.

## Learned keywords

After the same correction at one store, a store-only keyword is added (see [Keywords](categories.md#keywords)).

| Step | What it takes |
|---|---|
| Add as `usually` | 2 corrections, one a lone item; or 1 on a small receipt or split part (3 items or fewer, $30 or less) |
| Promote to `always` | 3 corrections that agree, one a lone item |

A big receipt moved whole never makes one, nor does a phrase you already have a keyword for.

**One exception doesn't delete it.** Filing an item elsewhere is a vote against.

- While votes for lead, it stays; `always` drops to `usually` until votes for are over three times those against.
- Votes against equal to votes for: removed. More against: the other category replaces it.
- If agreeing fixes lead again, it comes back. Only your own removals and **Forget** are permanent.

**Two size limits.** Both must pass (an unknown amount fails).

- **Charge:** up to twice the size it learned from, and at least $30.
- **Item:** up to twice the largest item price, and at least $5, so "COKE" from a $1.58 can doesn't file a $15.49 case.

Keywords you make have no limits.

## Managing lessons

**Learned corrections** (under Settings) lists lessons and learned keywords. **Forget** drops a lesson so it isn't learned again; **Undo** brings it back. Replay tests ignore it unless you pass `--with-memory`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `LEARNING` | `on` | `record` learns without using it; `off` does nothing |
| `MEMORY_DIR` | `/data/memory` | Where what it learned is kept |

All settings: [.env.example](../.env.example), or Settings in the web app.
