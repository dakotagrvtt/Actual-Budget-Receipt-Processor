# Actual-Budget-Receipt-Processor

Processes receipt photos uploaded to Nextcloud with a local vision model (llama.cpp), sorts each item into your Actual Budget categories with a local decision model, and splits the matching transaction in Actual when it is confident. Anything it is unsure about goes to a review folder.

## Receipt pipeline: photo of a receipt → categorized in Actual Budget

Take a photo of a receipt and upload it. A few minutes later the matching bank charge in
[Actual Budget](https://actualbudget.org) (a free budgeting app you run yourself) is filed under the right budget
categories, item by item. If the receipt covers several categories (groceries and cleaning supplies, say), the charge
is split into one part per category.

**By default everything runs on your own computer.** Your receipt photos and purchases are sent nowhere except to your
own Actual and Nextcloud servers. Two optional features send data to a cloud service. Both are off unless you switch
them on, and both are explained under [Privacy](#privacy).

**On this page:**
[How it works](#how-it-works) ·
[What you need](#what-you-need) ·
[Install](#install) ·
[Your first receipt](#your-first-receipt) ·
[Everyday use](#everyday-use) ·
[Teaching it your household](#teaching-it-your-household) ·
[Commands](#commands) ·
[Settings that matter](#settings-that-matter) ·
[Privacy](#privacy) ·
[Troubleshooting](#troubleshooting) ·
[More reading](#more-reading)

## How it works

1. **You upload** a receipt photo or PDF to the `Receipts/Inbox` folder in [Nextcloud](https://nextcloud.com) (a
   self-hosted file service). The Nextcloud phone app can do this automatically.
2. **The reader reads it.** A vision AI model running on your computer (the *reader*) reads the store, date, total and
   every line item.
3. **It finds the bank charge.** Your bank sync has already put the charge into Actual. The pipeline finds it by
   amount, date and store name. It never creates transactions.
4. **The decider picks categories.** A second AI model (the *decider*) chooses a budget category for each item. It
   learns from how you filed past purchases at the same store, from your category descriptions and from your keywords.
5. **It files the result.** The charge is recategorized, or split by category, and the receipt moves to
   `Receipts/Processed`.
6. **Doubtful ones wait for you.** Anything it isn't sure about goes to `Receipts/Needs review` with a note saying
   why. Charges it changed but wants you to check are tagged `#review` in Actual, so you can search for them.

It starts in **dry run** mode: it shows what it would do and changes nothing, until you switch it to **live**.

The details (matching rules, splitting, tax, review rules) are in [How it works](docs/how-it-works.md).

## What you need

- A Linux computer with [Docker](https://docs.docker.com/engine/install/) (a tool that runs programs in tidy
  containers; setup checks it for you).
- A graphics card (AMD, Intel or NVIDIA) with about 9 GB of free graphics memory. With less than 10 GB, setup picks
  smaller settings that need about 8 GB. With no graphics card it runs on the processor: it works, only slowly, which is
  fine because receipts aren't urgent.
- About 10 GB of disk space for the two AI models (they download once, about 8 GB).
- An Actual Budget server with your bank transactions in it (bank sync or imported files).
- A Nextcloud server to upload receipts to.

## Install

```
git clone https://github.com/dakotagrvtt/Actual-Budget-Receipt-Processor.git receipt-pipeline
cd receipt-pipeline
./receipts setup
```

Setup asks before anything big, and you can run it again at any time (it only asks for what's missing).
`./receipts setup --yes` takes the default answer to every question. It:

1. checks Docker, and offers to start it at boot so the pipeline comes back after a reboot;
2. asks for your Actual and Nextcloud details, and says where to find each one;
3. detects your graphics card (or that there is none) and picks matching settings;
4. downloads the models;
5. offers to create the `Receipts/Inbox` folder in Nextcloud;
6. starts everything, tests the connections, and writes a first description for each of your budget categories from
   your past transactions;
7. prints the link to your **status page**.

## Your first receipt

1. Upload a receipt for a purchase that is already in Actual to `Receipts/Inbox`.
2. Open the status page and press **Check for receipts now**. It shows what it *would* do. Nothing is changed yet. (The
   details are in `./receipts logs`.)
3. When the results look right, press **Go live**. Receipts it already looked at in dry run are then processed for real.

## Everyday use

Upload receipts. That's all. The pipeline checks the inbox every 5 minutes and keeps running after a reboot. The models
unload themselves after 5 idle minutes, so the graphics card is free between receipts.

The **status page** is your control panel. Its link contains a secret key, so open it from the link setup printed, or
run `./receipts trigger-url` to print it again (`http://localhost:8095` without the key says "forbidden"). Bookmark it,
or paste it as a link into an Actual note. From it you can:

- see recent receipts and what happened to each, and open one to see its photo, what was read, and why it went to
  review. A receipt's page has a **What to do** box, **Previous / Next** (or the arrow keys) and a menu to move through
  the receipts in the order and filter of the list, **Try again**, and a **How this page works** section;
- check the inbox right now;
- switch between dry run and live (it takes effect at the next check);
- edit your category descriptions and keywords, with an **Undo** button after a removal;
- exclude category groups or single categories that receipts should never go to (**Categories** tab);
- change many of the settings below without editing `.env` (**Settings** tab; a value saved there wins over `.env`);
- press **Try again** on a live receipt that went to review without changing anything in Actual;
- **fix a receipt's item categories** on its page, without going into Actual: pick another category for an item, press
  **Preview** to see the charge divided again (tax included), then **Save to Actual** (a receipt already applied; the
  split is rewritten) or **Apply to Actual** (a receipt in Needs review with a matched charge; it also moves the file to
  Processed). Each item you change is a lesson, as if you had corrected it in Actual. There is an **Undo** for 15
  minutes, and nothing is written in a dry run.

The status page uses plain HTTP and anyone with the link can use it, so keep it on your own network and keep the link
private.

**Receipts that need review** keep their reason in a `.json` file next to them in `Receipts/Needs review`. Whatever the
pipeline did apply is tagged `#review` in Actual. Unsure items are put in the store's usual category, or in an
"Uncategorized" part whose note gives the decider's best guess. Fix those in Actual like any other transaction.

## Teaching it your household

It gets better the more it knows about who buys what.

- **Category descriptions.** One or two sentences per category about what belongs in it ("the kids' clothes, toys and
  diapers"). Setup writes a first draft from your past transactions. Edit them on the status page in your own words.
- **Keywords.** For things a description can't capture: a brand that always goes to one person, a store where
  everything is for the kids. Add them on the status page, or right in Actual:
  - type `#always Pampers` in the note of a split part, and from then on Pampers always go to that category;
  - `#usually` does the same, but as a strong hint instead of a rule.
- **Your own splits.** When you split a charge by hand, a word or two in each part's note ("diapers", "DVDs") teaches
  it what goes where.
- **Your fixes.** When the pipeline files a charge and you later change a category in Actual, it notices (every few
  hours) and remembers. After you make the same fix a couple of times at one store, it adds a keyword for it. The
  **Learned** tab on the status page shows what it learned, and **Forget** drops anything wrong. Learning only runs in
  live mode. To switch it off, set `LEARNING=off` in `.env`.

More detail: [Keywords](docs/how-it-works.md#keywords) and
[Learning from your corrections](docs/how-it-works.md#learning-from-your-corrections).

## Commands

You don't need these day to day. `./receipts help` lists them.

| Command | What it does |
|---|---|
| `./receipts setup` | First-time setup; run it again to fill in anything missing |
| `./receipts download-models` | Download the models (safe to re-run; also needed after changing `DECIDER_MODEL` or `READER_LOCAL_MODEL`) |
| `./receipts start` / `stop` | Start everything / stop it and free the graphics card |
| `./receipts restart` | Restart the worker so it picks up changes to `.env` |
| `./receipts update` | Rebuild the worker after a code update |
| `./receipts status` | Mode, whether everything is running, any alert, the last log lines |
| `./receipts logs` | Follow the log as receipts are processed (Ctrl-C stops watching; it keeps running) |
| `./receipts check` | Test the connections to Nextcloud, Actual and the models (changes nothing) |
| `./receipts run-now` | Check the inbox now, like the button on the status page |
| `./receipts mode` | Show the mode; `mode dry` or `mode live` switches it, like the status page switch (`live` asks you to confirm) |
| `./receipts trigger-url` | Print the status page link and the webhook address again |
| `./receipts exclude` | Pick the category groups (and single categories) receipts never go to, such as bills and savings; restarts the worker |
| `./receipts describe` | Write descriptions for categories that have none (`--refresh` rewrites the auto-written ones; with a cloud reader it asks first) |
| `./receipts keyword …` | Add, remove, list and test keywords, e.g. `keyword add "Pampers" Kids --always` |
| `./receipts replay …` | Re-run receipts you have already filed and compare, changing nothing |
| `./receipts item-test …` | Test the decider on your own hand-made splits, changing nothing |

## Settings that matter

Every setting lives in `.env`. [`.env.example`](.env.example) lists all of them, each with a short comment and its
default. Setup fills in the required ones. Run `./receipts restart` after editing `.env`. Many of them (the connections to
Actual and Nextcloud, matching, categorizing, the check interval, holidays, keywords and learning) can also be changed on
the status page's **Settings** tab (everyday settings first, tuning ones under **Advanced settings**): each shows where its value comes from (`.env`, this page or the default), a
**Use the .env value** button undoes an override, and a change applies at the start of the next check, without a
restart. A value saved there is kept in `data/web-settings.json` and wins over `.env`; `./receipts status` says so when
that file exists. Models, GPU, providers and API keys, the status page's own key and every file path stay in `.env`. The
ones you are most likely to want:

| Setting | What it does |
|---|---|
| `MATCH_TOLERANCE_PERCENT=25` | Allows restaurant tips (the charge is higher than the receipt) |
| `MATCH_ACCOUNTS` | Only look for charges in these Actual accounts |
| `EXCLUDE_CATEGORY_GROUPS` | Category groups receipts never go to, such as bills and savings (`./receipts exclude` sets it; single categories go in `EXCLUDE_CATEGORIES`). The status page hides them too |
| `DECIDER_MODEL` | The decider model. Setup picks d3-flash 9B when your graphics card has 14 GB or more, else d1-2B. Run `./receipts download-models` after changing it |
| `READER_LOCAL_MODEL` | A different reader model (see below) |
| `LEARNING=off` | Turns off learning from your corrections |
| `MODEL_SLEEP_SECONDS=-1` | Keeps the models loaded (use this if another app shares the graphics card) |

The values in `.env.example` are the ones that tested best, so you rarely need to change them. What each one did in
testing is in [docs/research.md](docs/research.md#11-setting-by-setting). To try a value on your own receipts, run
`./receipts replay` (it changes nothing).

Short on graphics memory? Setup can run the decider on a hosted service instead. That sends anonymized text out, so
read [Privacy](#privacy) first.

### Trying a different reader model

The reader is the vision model that reads receipt photos. To try another one, put one line in `.env`:

```
READER_LOCAL_MODEL=bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF:Q4_K_M
```

That is a Hugging Face repo and a quant (the compression level), written like `DECIDER_MODEL`. Then:

1. `./receipts download-models` fetches the model and its image projector. It stops with a clear message if the repo
   has none, because a model without one can't read images. `READER_LOCAL_MMPROJ` picks a particular projector by file
   name or quant.
2. `./receipts restart`. `./receipts status` shows the reader model in use.
3. `./receipts replay` on your own receipts, and compare with the default before trusting it. A bigger model needs more
   graphics memory, and a model that is better on paper can read your receipts worse.

To go back, delete the `READER_LOCAL_MODEL` line (and `READER_LOCAL_MMPROJ`) and run `./receipts restart`. The default
files stay in `models/`, so nothing is downloaded again.

## Privacy

**Default: everything is local.** With the settings from `./receipts setup` (`READER_PROVIDER=local`,
`DECIDER_PROVIDER=local`), the photo, the reading, the categorizing and everything you taught it stay on your computer
in the `data/` folder. The only outside connections are to your own Actual and Nextcloud servers, and the one-time model
downloads. `./receipts status` prints a line for the reader and the decider only when one of them is hosted.

There are two optional cloud features. Each is off unless you choose it in `./receipts setup` or in `.env`.

| | What leaves your machine | Goes to | Keep it local with |
|---|---|---|---|
| Cloud reader | The whole receipt photo | The provider you choose (OpenAI or OpenRouter) | `READER_PROVIDER=local` (the default) |
| Hosted decider | Anonymized text about each item (no photos) | TypeSafe | `DECIDER_PROVIDER=local` (the default) |

To go back after switching one on, set it to `local` in `.env` and run `./receipts restart`. That also starts the local
services again.

### Cloud reader (optional): your receipt photos leave your machine

Each photo is sent to a cloud vision model, using your own OpenAI or OpenRouter API key (`READER_PROVIDER=remote`).
Think about this first:

- **The whole photo is sent.** It shows the store and its address (where you shop), the date and time, everything you
  bought, the prices, the last digits of your card, member or loyalty numbers, sometimes your name or a cashier's, and
  barcodes. Location data (EXIF) is removed from the photo before it is sent. The anonymizing used for the hosted
  decider does **not** apply to photos. A cloud reader sees everything on the receipt.
- **The provider may keep requests for a while** (for example to watch for abuse), and policies differ and change.
  Check the provider's current policy. With OpenRouter the request goes on to a third-party model provider whose policy
  applies. OpenRouter has privacy settings that limit providers that log or train on data. Check them.
- **It costs money per photo**, and it has not been tested on this pipeline's receipts. Before switching, run
  `./receipts replay` with the cloud reader and compare it with the local one. (Replay also sends the photos.)
- **Category descriptions are not written automatically.** Writing them sends category names, store names, amounts and
  your item notes. `./receipts describe` lists what it would send and asks first.
- **With the hosted decider too:** the scan that finds names to hide runs through the reader. So your raw item lines,
  store names and category notes would go to the cloud reader's provider before anonymizing. The worker refuses to start
  with both hosted unless you set `CLOUD_NAME_SCAN=true` to accept that.

With a cloud reader, `./receipts start` does not start the local reader, which frees about 5.6 GB of graphics memory.
Settings for the local reader (`LLM_THINKING`, `LLM_NAME`, the sampling settings) do not apply. Details and error
handling: [Cloud reader](docs/how-it-works.md#cloud-reader-optional).

### Hosted decider (optional): anonymized text leaves your machine

If your graphics card is short on memory, the decider can run on TypeSafe's hosted Jev model instead
(`DECIDER_PROVIDER=remote`; setup asks). You need a TypeSafe API key. Your photos stay on your machine (unless you also
use the cloud reader). What is sent, always anonymized first (there is no switch to turn that off):

- the item lines and amounts, and the other items on the receipt;
- the store name as it appears in Actual, and your past purchases, notes and category descriptions for that store, with
  category names replaced by codes (`C01`, `C02`…);
- dates as "12 days before this purchase";
- people's names as "Person A", "Person B"…, and places as "a city" or "a street".

**Never sent:** the photo, card digits, the payment method, addresses, the printed date, and calendar event names.

Names are found from your own lists (`PRIVATE_WORDS`, `PRIVATE_PLACES`, editable on the status page under **Privacy**)
and by a scan from the reader. No automatic scan is perfect, so before switching, run
`./receipts replay --preview-remote <folder>` to see exactly what would be sent. It sends nothing to the hosted decider.
(With a cloud reader the photos still go to the reader's provider.) More detail:
[Hosted decider](docs/how-it-works.md#hosted-decider-optional).

## Troubleshooting

- **Something isn't working:** run `./receipts check`. It tests every connection and says what's wrong.
  `./receipts status` shows a **WORKER ALERT** line when a setup problem (such as a refused API key) has paused the
  checks. Receipts wait in the inbox until you fix it and run `./receipts restart`.
- **Out of graphics memory:** stop other apps using the card, or put `DECIDER_GPU_LAYERS=0` in `.env` and run
  `./receipts restart`. That moves the decider to the processor and frees about 2.5 GB. If another app shares the card,
  also set `MODEL_SLEEP_SECONDS=-1` so the models never give their memory back.
- **A receipt went to review:** its `.json` says why. If nothing was changed in Actual, fix the cause (a keyword, a
  payee alias) and press **Try again** on the status page. If a charge was matched you can instead fix the item categories on the receipt's page and press **Apply to Actual**. Otherwise fix the charge in Actual by hand. For a badly read
  photo, upload a clearer one.
- **The store name never matches the bank's name:** copy `payee-aliases.example.json` to `data/payee-aliases.json` and
  list the different spellings of each store together.
- **The status page says "forbidden":** the link needs its key. Run `./receipts trigger-url` and use that link.

## More reading

- [How it works](docs/how-it-works.md): matching, splitting, tax, review rules, the status page, keywords, learning,
  the webhook, replay tests, and the cloud reader and hosted decider in detail.
- [Research](docs/research.md): how the models and defaults were chosen, with test results and hardware notes.
- [`.env.example`](.env.example): every setting with its default.

## License

[AGPL-3.0](LICENSE)
