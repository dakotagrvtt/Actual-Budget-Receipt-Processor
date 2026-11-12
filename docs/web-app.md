[How it works](how-it-works.md) › The web app

# The web app

What the control panel does, how to reach it, and what each page is for.

**In short**

- The worker serves the web app on port 8095. Every request needs the `TRIGGER_TOKEN` key; `./receipts trigger-url` prints the link and the webhook URL.
- Tabs: **Inbox**, **Archive**, **Settings**, plus **+ Add receipt**. Fixing a receipt is covered in [Reviewing and fixing a receipt](review.md).
- Dry run changes nothing; live writes to Actual. Switch on the Activity page with **Go live...** or **Switch to dry run**.
- Settings saved in the app win over `.env` and apply at the next check, without a restart.
- It is plain HTTP with the key in the link: keep it on your own network.

## Getting around

The **Inbox** tab (with a badge counting receipts to review), **Archive** and **Settings** sit at the top, with **+ Add receipt** beside them; phones get them as a bottom bar.

- Times are shown in `TRIGGER_TIMEZONE`. Click a column heading to sort; each table has a filter box.

## The Inbox list

The list shows this mode's receipts, not archived ones, in three groups:

| Group | What is in it |
|---|---|
| **Review** | Needs you, including "check it in Actual". |
| **Waiting** | Waiting for the bank charge, or being read. |
| **Filed** | Done. Collapsed until you search or open a filed receipt. Shows the newest 100. |

Each row shows the store, total and a short status ("Waiting for the bank"). The search box filters all groups.

## The receipt page

Tapping a receipt opens its page: the photo, what the reader read, the bank charge, how it was filed and why it went to review.

- A status banner at the top holds the main actions and says what happened in Actual and what to do next. Less common actions are under **More**.
- After a save the banner reads "Saved" with an **Undo** button for the rest of the 15 minutes, even if you leave and come back.
- **Next receipt** (or the arrow keys) walks through the group you came from.
- Photos are only shown for receipts the worker has seen, never from a path in the link.

## Dry run and live

The Activity page (linked at the bottom of the Inbox list) has the mode switch, **Check now** and the results of recent checks.

- **Go live...** asks you to confirm; **Switch to dry run** does not. `./receipts mode dry|live` does the same.
- The switch applies at the start of the next check (**Check now** starts one). Going live processes the receipts seen in dry run again, for real.
- The switch is saved in `data/settings.json`; once that file exists, `DRY_RUN` in `.env` is ignored. Delete the file to go back to `.env`.

## Uploading receipts

**+ Add receipt** sends photos or PDFs from your device (a phone offers the camera) to the Nextcloud Inbox, the same as putting them there yourself. A check starts right away, also in dry run.

- JPG, PNG, WebP, HEIC and PDF, up to 25 MB each. A file that doesn't fit is turned away with a reason; the others still go in.
- Nothing is replaced: a taken name gets a time stamp, and the very same photo is skipped as "already in the Inbox".
- Without JavaScript the form sends up to 20 files at once.

## Archiving

Archiving a **Done** receipt moves its photo and `.json` out of Processed so old receipts stop piling up. It never changes Actual, except **Looks right: clear #review and archive**, which removes `#review` only. It is live only.

| What | How it works |
|---|---|
| One receipt | **Archive receipt** on its page. It ends that receipt's open Undo. |
| Many | **Archive all done receipts...** on the Activity page, up to 50 per press. Skips receipts still in their Undo window. |
| Automatic | With `ARCHIVE_AFTER_DAYS` above 0, after each check the worker archives Done receipts that old. |
| Where | `RECEIPTS_ARCHIVE`, in a folder per month of the receipt's date (`/Receipts/Archive/2026-03`). Nothing is overwritten. |
| Shrinking | With `ARCHIVE_SHRINK_PHOTOS`, photos are saved again as a smaller JPEG (only if at least 10% smaller); the full-size photo is gone. PDFs are moved as they are. |
| Restore | **Restore** on the Archive tab or the receipt moves it back where it was filed (Processed or Needs review) and the Inbox list. |

- Waiting and dry-run receipts can't be archived. A review or failed receipt that changed nothing in Actual can be archived from its page (**Archive receipt**; Actual is untouched). Bulk and automatic archiving never touch `#review` receipts.
- An archived receipt opens read-only. Learning is not affected.
- If the archive folder clashes with Processed or Needs review, archiving is off and the app says why; fix it under Settings → Connections.

## Categories and Keywords pages

Both are under Settings, for editing category descriptions and keywords (see [Picking categories](categories.md) and [Keywords](categories.md#keywords)). Changes apply at the next receipt.

- **Exclude group** and **Exclude** keep receipts out of a group or category (`EXCLUDE_CATEGORY_GROUPS`, `EXCLUDE_CATEGORIES`); **Include again** reverses it.
- **Undo** puts back the last change (a removed keyword, an exclude, an overwritten description) within 15 minutes.

## The Settings tab

The **Settings** tab links to one page per section: Everyday, Matching and review, Categories, Category rules, Learned corrections, Connections, Appearance and Advanced (plus Privacy with a hosted decider).

- These are the `.env` settings, each with its help line and current value; tuning ones sit under **Advanced**.
- A saved value goes into `data/web-settings.json` and wins over `.env`. **Use the .env value** or **Reset all to .env** removes it. Each page has **Undo**.
- A bad value saves nothing, and a changed Actual or Nextcloud login is tested first. Passwords are never shown.
- Models, providers, API keys, `TRIGGER_TOKEN`, `DRY_RUN` and paths stay in `.env`.

**Appearance** sets a **Theme** (System, Light or Dark) and an **Accent** color for this browser only.

## Reaching it and keeping it private

The page only listens on this machine until you set `TRIGGER_BIND=0.0.0.0` and run `./receipts restart`.

- **Keep it private.** It is plain HTTP and the key is in the link, so keep it on your own network and don't share the link. Anyone with the key can check the inbox, see recent receipts and their photos, go live, retry receipts, and edit descriptions, keywords and the privacy lists. Requests from other sites are refused.
- **From Actual:** paste `[Receipts](<app URL>)` into a category or group note; it shows as a link on the budget page.
- **Nextcloud webhook (optional):** the Webhook Listeners app (admin only) can call `POST /run` when a file lands in the inbox. Nextcloud sends webhooks from background jobs, so it is often no faster than the regular poll.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `TRIGGER_TOKEN` | set by setup | The key every request needs. |
| `TRIGGER_BIND` | `127.0.0.1` | `0.0.0.0` lets other devices on your network reach the app. |
| `TRIGGER_TIMEZONE` | `UTC` (setup fills in this computer's) | Time zone for times shown in the app. |
| `POLL_SECONDS` | 300 | Seconds between checks of the inbox. |
| `DRY_RUN` | `true` | Starting mode; ignored once `data/settings.json` exists. |
| `RECEIPTS_ARCHIVE` | `/Receipts/Archive` | Where archived receipts go. |
| `ARCHIVE_AFTER_DAYS` | 0 (never) | Archive Done receipts this many days old automatically. |
| `ARCHIVE_SHRINK_PHOTOS` | `true` | Save archived photos as smaller JPEGs. |
| `EXCLUDE_CATEGORY_GROUPS` | `Bills` | Category groups receipts never go to. |
| `EXCLUDE_CATEGORIES` | unset | Single categories receipts never go to. |

All settings: [.env.example](../.env.example), or Settings in the web app.
