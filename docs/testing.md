[How it works](how-it-works.md) › Replay tests and item tests

# Replay tests and item tests

How to check the pipeline against purchases you've already filed, without changing anything in Actual.

**In short**

- `./receipts replay` runs receipts through the pipeline and compares with what you filed; nothing is written to Actual. With the hosted decider it still sends real, paid requests unless you add `--preview-remote` ([Cloud options](cloud.md#previewing)).
- Readings and per-item numbers are saved, so other deciders and thresholds can be tested without re-reading photos.
- History stops the day before each purchase, so tests mostly don't see the future.

## Run a replay

Upload receipts to a Nextcloud folder such as `/Receipts/Test` (with a local receipt folder: a folder inside it) and run `./receipts replay --nextcloud "/Receipts/Test"` (or `./receipts replay /data/receipt.jpg` for one file in `./data`).

- `--only 212537,212930` keeps only files whose names contain those.
- Readings are saved to `data/research/readings/`, replacing ones of the same name; `--save-readings <folder>` writes them elsewhere.
- `--readings <folder>` re-decides every saved `.read.json` (or older `.lfm3-read.json`) without reading photos; `--receipt <file>.read.json` does one.
- **Compare deciders:** set `DECIDER_MODEL`, run `./receipts download-models` and `./receipts restart`, then replay the same `--readings` folder.
- **Test per-item tax marks:** read once with `TAX_BY_ITEM=true`, replay that folder with it off and on (restart between), compare the `pipeline:` lines. Readings without tax marks always spread tax in proportion.
- `item-test` scores only splits you made yourself, unless you pass `--include-pipeline`.

## What the tests don't see

Store history and item notes end the day before the purchase (the receipt's date, today if undated, or in a replay the transaction's date), in tests and live alike; `HISTORY_DAYS` counts back from there.

- **`--with-memory`** cuts learned lessons to those known by that day and rebuilds learned keywords from them. Without it, learned lessons are ignored; the live worker uses all of them.
- **Still leaks:** a note on an earlier purchase written or changed after the purchase date (Actual keeps no edit times), and today's keywords, `#always` tags, category descriptions, Actual rules, payee names and holiday list. So old receipts replay a bit optimistically.

## Output files

Test output goes to `data/research/`. Every replay writes `replay-items.json` (or `--items-out`), one row per item, to sweep `MOVE_MIN_CONFIDENCE`, `CATEGORY_MIN_CONFIDENCE` and `MOVE_MIN_MARGIN` without the models.

- Rows hold the decider's own `pick`, `topProbability` and `margin` (before any store-category fallback), what was `filed`, `fellBack`, keyword effects (`model*`, `keywordTooWeak`) and, with `RECEIPT_CHECK`, `receiptPick` and `pulledByReceipt`.
- `item-test` writes `data/research/item-test-<name>.json`; saved receipts keep `receiptCheck` for sweeping `RECEIPT_CHECK_MIN_CONFIDENCE`. Thresholds: [Picking categories](categories.md).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `DECIDER_MODEL` | `LiquidAI/d1-2B-GGUF:Q8_0` (setup asks) | The decider being tested |
| `HISTORY_DAYS` | 365 | Days of history before the purchase |
| `TAX_BY_ITEM` | true | Per-item tax marks |

All settings: [.env.example](../.env.example), or Settings in the web app.
