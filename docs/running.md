[How it works](how-it-works.md) › Running it

# Running it

What happens when things fail or hardware is tight.

**In short**

- If a model, Actual or Nextcloud (or the local receipt folder) is down, the worker (the program that does the rest) retries later; outages never use up a receipt's 3 attempts.
- A restart or crash is safe: a half-done filing is finished at the next check.
- Both models need about 8.3 GB of graphics memory (VRAM); with no GPU they run on the CPU.
- Models unload after 5 idle minutes; on a shared GPU set `MODEL_SLEEP_SECONDS=-1`.
- Everything under `data/` is private to your user.

## Outages and restarts

When a model, Actual or Nextcloud is down or stalls, the check stops and the next poll tries again; nothing counts against the receipt (except a cloud reader or hosted decider request that may have been billed: see [When a hosted model fails](cloud.md#when-a-hosted-model-fails)).

- Model requests time out after 10 minutes (reader), 5 (local decider) or 2 (hosted).
- On stop or restart the worker finishes its receipt (3-minute grace).
- After a crash the next check finishes the job; a change already in Actual is recognized by its `#receipt` note.
- Half-uploaded (`.part`) and empty files are skipped.
- If `data/state.json` (the worker's record of seen receipts) is damaged, every check fails and the status page says so. Restore a backup or delete it; applied receipts are recognized by their note.
- While a setup problem pauses the checks, `docker ps` shows the worker as unhealthy and the status page's banner says why. A failing check clears its banner by itself once a check succeeds.

## Re-used names and replaced photos

A different photo under an old name is a new receipt; the same photo uploaded again is not filed onto a second charge. If the worker can't tell which earlier transaction is this photo's, the receipt goes to review naming them. A photo replaced in the inbox is read anew at the next poll.

## Nextcloud or a local folder

The receipt files live in Nextcloud (`STORAGE=nextcloud`, the default) or in a folder on this computer (`STORAGE=local`). Setup asks, and you can run it again to switch.

### Local folder

- `RECEIPTS_DIR` (default `./receipt-files`) holds `Inbox`, `Processed`, `Needs review` and `Archive`. Setup, `./receipts start`, `update` and `migrate-storage` create any that are missing, private (`0700`).
- A relative `RECEIPTS_DIR` starts with `./`. A bare name such as `receipt-files` would be a Docker volume, not a folder; `./receipts start` adds the `./` for you.
- If folders are set on the Settings tab, they win over `.env`. Setup creates the folders named in `.env` and says which ones the Settings tab changes; create those yourself.
- `compose.local-files.yaml` mounts the folder into the worker. Setup and `./receipts start` keep it in `COMPOSE_FILE` exactly when `STORAGE=local`.
- Files are moved with hard links, so a move never replaces a file. Keep the folder on a normal Linux file system (not FAT or exFAT).
- Without Nextcloud, phones add receipts with **+ Add receipt** in the app, or any sync tool can fill the `Inbox` folder.
- The Nextcloud calendar (`OCCASIONS_CALENDAR`) needs Nextcloud; with a local folder the worker uses the US holidays only and says so in the log.
- `./receipts check` tests that the folder is there and writable; `./receipts status` shows which storage is in use.
- Running `docker compose` by hand instead of `./receipts`: create the folder and its four subfolders first (`mkdir -p -m 700`), and set `RECEIPTS_UID` and `RECEIPTS_GID`. Docker creates a missing folder owned by root, and the worker can't write there.

### The user the worker runs as

- In both storage modes the worker runs as you: setup puts your `id -u` and `id -g` in `.env` as `RECEIPTS_UID` and `RECEIPTS_GID`. When they are missing on an upgrade, `./receipts` takes the owner of the existing `data/` instead, so the worker keeps running as before (never as root). Direct compose runs default to `1000:1000`. The uid needs no passwd entry, and no `sudo` is needed.
- An existing `data/` may belong to uid 1000. Setup, startup and status check its owner without reading its contents, and if it differs they show `sudo chown -R <uid>:<gid> data`. Review and run that yourself; nothing runs sudo automatically. Keep directories at `0700` and files at `0600`.

### Changing storage or folders

To switch between Nextcloud and a local folder, run `./receipts setup`. After any other change to the local folder, the Nextcloud address or user, or a receipt folder, run `./receipts migrate-storage`. (A Settings tab save or reset that changes one asks you to confirm first.)

- **Another storage:** the receipts and their JSON summaries are copied, every subfolder, and verified by size and SHA-256 before state changes. A name already taken there gets a unique name. Originals stay; check the new storage before removing them.
- **Same storage, other folders:** the files are moved in place, through a hidden `.receipts-move-*` folder, so swapped or nested folders are safe. Old folders left empty are removed.
- The worker and web app are stopped while it runs, and the worker is started again afterwards (also after a failure) if it was running.
- Until it finishes, processing, uploads and file actions pause, and the status page says which migration is unfinished and how to finish or cancel it. The Settings tab stays usable.
- A stopped run carries on when you run it again. Only one runs at a time. Stop external sync tools meanwhile.
- `--cancel` undoes an unfinished copy and removes the copies it made (if it can't reach them, the run stays and the worker stays paused). A folder move can be cancelled only before its first file moves; after that it only goes forward. A run that is committing can't be cancelled.
- If the new storage's folders already hold files this install doesn't know (say, originals left by an earlier move away), it refuses, because the worker would file them again. Move them out, or use `--into-used` to copy beside them.
- A layout it can't tell apart (an old folder that was the whole storage, or two kinds that shared a folder and now differ) is refused with nothing changed. Put the settings back, and give folders that were one the same new folder.
- Moving from another Nextcloud account asks for that account's app password once; it is not saved.
- Don't move receipt folders by hand: state would still name the old places. Migration never changes Actual, in dry run or live mode.

Leave the `RECEIPTS_INBOX`, `RECEIPTS_PROCESSED`, `RECEIPTS_REVIEW` and `RECEIPTS_ARCHIVE` lines commented to use the storage defaults. Explicit paths, including Settings tab overrides, stay in force when storage changes.

### The storage marker

`.receipts-storage-id` at the top of the storage holds a random id, also recorded beside state (written in dry run too).

- It lets the worker recognize the same storage at a new Nextcloud address, login spelling or local path, with no migration. Setup handles a local folder you moved as a whole the same way.
- If it is missing while receipts are recorded, the worker pauses: the folder is probably empty or not mounted.
- A copied folder keeps its marker. Delete `.receipts-storage-id` in a copy that another install will use.
- A new install with no receipts yet (a mistyped first address, say) just takes the corrected settings.
- For the same storage reached another way that the worker did not recognize, run `./receipts migrate-storage --adopt`. It asks for confirmation and records the configured storage without copying or changing state. It refuses a different storage kind, changed folder paths, or an unfinished migration.

## GPU memory and sleeping models

The two models use about 8.3 GB of VRAM together.

- **Less memory:** `compose.small-gpu.yaml` uses 7.4 GB; adding `DECIDER_GPU_LAYERS=0` (decider on the CPU) brings it to about 5.1 GB.
- **GPU type:** setup picks the images (Vulkan for AMD and Intel, `compose.nvidia.yaml` for NVIDIA); see [research.md](research.md#hardware).
- **Sleep:** after `MODEL_SLEEP_SECONDS` without requests, each model unloads and frees its memory; the next receipt wakes it in a few seconds.
- **Shared card:** start this first or stop the other app, and set `MODEL_SLEEP_SECONDS=-1`, or another app can take a sleeping model's memory and the reload fails.

## No GPU

Setup notices a missing GPU and runs both models on the CPU (`LLM_GPU_LAYERS=0`, `DECIDER_GPU_LAYERS=0`, `compose.cpu.yaml`): slower, but fine. If it later finds a GPU, it offers to undo that.

## Offline

The models never contact Hugging Face while running; only `./receipts download-models` and setup fetch them. To change the decider, set `DECIDER_MODEL`, then run `./receipts download-models` and `./receipts restart`.

## Private files

Everything under `data/`, including Actual API files and caches, is private to your user (`0600` files, `0700` folders); the worker repairs older files' permissions at start.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `MODEL_SLEEP_SECONDS` | 300 | Idle seconds before a model unloads; `-1` never |
| `LLM_GPU_LAYERS` | 99 (all on the GPU) | `0` runs the reader on the CPU |
| `DECIDER_GPU_LAYERS` | 99 (all on the GPU) | `0` runs the decider on the CPU (frees 2.3-2.7 GB) |
| `DECIDER_MODEL` | `LiquidAI/d1-2B-GGUF:Q8_0` (setup asks) | Which decider runs |
| `RENDER_GID` | 987 (set by setup) | Group for AMD and Intel GPU access |
| `COMPOSE_FILE` | unset (set by setup) | Extra compose files for NVIDIA, small GPU or CPU |
| `STORAGE` | `nextcloud` (setup asks) | Where the receipt files are: `nextcloud` or `local` |
| `RECEIPTS_DIR` | `./receipt-files` | The local receipt folder, with `STORAGE=local` |
| `RECEIPTS_UID`, `RECEIPTS_GID` | your user (set by setup) | Who the worker runs as, in both storage modes |

All settings: [.env.example](../.env.example), or Settings in the web app.
