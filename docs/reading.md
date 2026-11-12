[How it works](how-it-works.md) › Reading a receipt

# Reading a receipt

How a photo becomes data, and how to swap the model that reads it.

**In short**

- The reader (a vision model that turns a photo into data) pulls out the store, date, totals, payment method and line items.
- It copies tax marks and dates as printed; the worker (the program that does the rest) interprets them.
- Cash and return receipts skip matching and go straight to review.
- The default reader is Qwen3.5-4B, running locally; you can swap it.

## What the reader extracts

The reader copies what the receipt prints, without interpreting it. HEIC and up to 3 PDF pages are converted first.

- store name and clues, printed date, whether it is a return
- subtotal, tax, tip, total, a savings line, payment method, cash handed over
- line items; with `TAX_BY_ITEM` on, each item's tax mark (yes, no or unknown) and the printed tax lines

Tax codes keep their case (`t` and `T` can differ) and are never interpreted; [Splitting](splitting.md) uses them.

**Cash and return receipts** go straight to review: there is no bank charge to match, and the worker never creates a transaction by itself. Their items are still categorized for **Create in Actual** ([review](review.md)).

## Dates

The receipt page shows the worker's **Purchase date used** next to the **Printed date**.

- US month/day is assumed; day/month only when the first number can't be a month.
- Return-by dates, future dates, and dates more than 400 days before the upload are ignored.
- A date after the photo day (from a camera file name like `PXL_20261105_101530.jpg`, up to 31 days before upload) is ignored as a misread; names like `Order_2026-10-01.pdf` never count.

No readable date at all: see [Finding the bank charge](matching.md#when-the-receipt-has-no-readable-date).

## The local reader model

The reader runs on llama.cpp in the `llm` service: by default Qwen3.5-4B Q8_0 with its BF16 image projector (mmproj).

- To swap it, set `READER_LOCAL_MODEL=<hf repo>:<quant>`, then run `./receipts download-models` and `./receipts restart`.
- It must be a vision model with a projector; `download-models` refuses one without.
- Another model may need different `LLM_SAMPLING` and more graphics memory; measure it with `./receipts replay` first.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `TAX_BY_ITEM` | `true` | Also read each item's tax mark and the printed tax lines |
| `READER_LOCAL_MODEL` | `unsloth/Qwen3.5-4B-GGUF:Q8_0` | Reader model, as `<hf repo>:<quant>` |
| `READER_LOCAL_MMPROJ` | BF16 (another model: BF16, F16, then F32) | Which image projector to use |
| `LLM_SAMPLING` | temperature 0.1, top_k 20, top_p 0.95 | Sampling for the local reader |
| `LLM_THINKING` | `false` | `true` lets the reader think (also set `READER_REASONING_BUDGET`): same results, 2.4 times slower |
| `READER_REASONING_BUDGET` | `0` | Thinking tokens, e.g. 1024 |
| `READ_PLAIN_NAMES` | `false` | Ask for plain-language item names (often wrong in testing) |

All settings: [.env.example](../.env.example), or Settings in the web app.
