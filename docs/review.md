[How it works](how-it-works.md) › Reviewing and fixing a receipt

# Reviewing and fixing a receipt

How to check a receipt, fix its categories and amounts, read it again, and undo a change, all from the receipt's page in the [web app](web-app.md).

**In short**

- Open a receipt from the **Inbox** list, change an item's amount or category, press **Preview**, then save.
- The button that writes is **Save changes** (already applied), **Apply to Actual** (in Needs review, nothing applied yet) or **Looks right** (nothing to change).
- **Undo** lasts 15 minutes after a save or a cash **Create**. **Looks right** has no Undo.
- **Try again** and **Read again** are for misread receipts; neither writes to Actual by itself.
- Cash purchases have no bank charge, so you create the Actual transaction from the page; the worker never creates one by itself.

## Fixing items on the receipt page

When a bank charge was matched, each item under **Items & categories** has an amount box and a category menu. **Set all items** sets every row at once.

| Button | What it does |
|---|---|
| **Preview** | Divides the charge again the way the worker does (tax spread per category, [small parts](splitting.md) merged) and lists the parts. For a matched charge it reads nothing from Actual. |
| **Save changes** | Writes your fix to a receipt the worker already applied. |
| **Apply to Actual** | Writes a receipt in Needs review that had nothing applied. |
| **Looks right** | Shown when nothing was edited on a receipt waiting for your confirmation. Removes `#review` and records a "confirmed" mark for learning. |
| **Add a line** | A blank row (description, amount, category, tax mark) for something the reader skipped. Up to 10. |

- Use a negative amount for a discount. Your typed amounts are never changed by the worker's tax-line correction.
- The preview says whether the items add up to the receipt's subtotal (green within 2 cents). Saving is allowed either way, since the bank charge is what gets divided.
- A fix that would make one part bigger than the whole charge is refused.
- Amount edits and added lines are kept in the summary's `pageFix.amounts` and `pageFix.added`; Undo restores them.

## What saving checks

Every save re-reads the charge first and changes nothing if it isn't what it should be.

- **Save changes** refuses unless the charge is still exactly what the worker (or your last save) wrote. It keeps the `#receipt <file>` note and your other notes, and keeps `#review` unless **Mark as checked** is ticked (it is for `+review` receipts; it also moves the file to Processed).
- **Apply to Actual** refuses if the charge changed since the match, or is split, a transfer, already has a `#receipt` note, or sits outside `MATCH_ACCOUNTS` or in a hidden or income category. It does overwrite a category your rules set.
- A stale preview (double click, another tab) is refused, and so is a save while the worker is busy.
- After each write the charge is read back; if it doesn't match, the save stops and says to check the charge in Actual.

## What the page learns

Each item whose category you changed becomes a lesson; amount edits and added lines do not. Putting an item back as the worker had it ends its lesson. `LEARNING=off` records none of this. See [Learning from your corrections](learning.md).

## When you changed the charge in Actual

The page only knows its saved summary, so a charge you edited by hand in Actual can make it look out of date.

- **Check Actual now** (applied receipts, live only) reads that one charge and compares it. It never writes.
- When Actual differs, the item editor locks and each changed item shows "Changed in Actual: ...". Edit it in Actual instead.
- A `#review` receipt counts as reviewed (Done) once `#review` is gone from the charge in Actual, even if categories changed too.
- **Looks right: clear #review and archive** only removes `#review`; your category changes stay. If the amounts or `#receipt` note changed, use **Archive: keep what's in Actual**, which doesn't open Actual at all.

## Undo

**Undo** lasts 15 minutes after **Save changes** or a cash **Create**, never after **Looks right**.

- It puts the charge back only if it is still exactly what the page wrote; otherwise it changes nothing.
- It also restores the receipt's summary, takes back the lessons and moves the file back (never over another file).

## Reading it again

Which button to use depends on what already happened in Actual.

| Situation | What to do |
|---|---|
| Live, in Needs review, Actual unchanged | **Try again**: moves the file back to the inbox, so the next check reads it fresh. Refuses if the inbox already has that name. |
| Filed, waiting or dry run, and you want a better reading | **Read again** (under **More**): reads the stored photo with the reader configured now. |
| Applied and then reviewed | Undo the change in Actual (category or split, and the `#receipt` note), delete the file from Needs review and upload it again. |

Don't move a file back into the inbox by hand: the worker remembers files by name and version and may skip it, while a new upload is a new receipt.

**Read again** never writes to Actual and teaches nothing.

- A waiting or dry-run receipt carries on as if read that way the first time. A filed receipt only gets a new reading on its page; fix Actual from it with the usual Preview and **Save changes**.
- Doubts about the new reading show as "About the new reading". **Use old reading** puts the earlier one back.
- Refused while a page fix is saved and not undone, after Actual was found changed, when archived, or when the photo is gone.
- A failed re-read keeps what the receipt had, is retried at the next checks, then dropped with a note.

## Cash purchases

A cash purchase has no bank charge, so it goes to review with a reason pointing to **Create in Actual**, or Archive if you entered it by hand. Nothing is created in dry run.

- The page shows the item editor plus an **Account** menu, starting from the **Cash purchases go to** setting (`CASH_ACCOUNT`). Create is refused with no account.
- **Preview** looks at Actual read-only: the account, the payee (an existing one that fits the store name, else a new one), the parts, and any transaction in that account for exactly the total within 3 days that has no `#receipt` note.
- **Create in Actual** adds one cleared transaction for the receipt total on the purchase date, with one category or a split and the usual notes.
- If a same-amount transaction was found, **Split this one instead** applies the receipt to it with the checks of **Apply to Actual**. **Create a new one anyway** stays available.
- If Actual's rules change the new transaction's categories, the worker puts the previewed split back and says so. An interrupted Create is never added twice: Preview offers **Retry creation after lookup**.
- **Undo** (15 minutes) deletes the created transaction, or puts a split existing one back, while it is unchanged and not reconciled.
- **Archive receipt** moves a cash or refund receipt you entered by hand out of Needs review without changing Actual; Restore puts it back there.
- If the read total equals the cash tendered and is more than subtotal plus tax and tip, the worker uses the computed total and the page shows both.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `CASH_ACCOUNT` | unset | Actual account **Create in Actual** uses for a cash purchase. |
| `MATCH_ACCOUNTS` | unset (all open on-budget accounts) | Accounts searched for a receipt's charge. |
| `LEARNING` | `on` | `off` stops learning from your fixes. |

All settings: [.env.example](../.env.example), or Settings in the web app.
