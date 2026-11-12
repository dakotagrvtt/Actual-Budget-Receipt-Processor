[How it works](how-it-works.md) › Running it

# Running it

What happens when things fail or hardware is tight.

**In short**

- If a model, Actual or Nextcloud is down, the worker (the program that does the rest) retries later; outages never use up a receipt's 3 attempts.
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
- If `data/state.json` (the worker's record of seen receipts) is damaged, every check fails with a log message. Restore a backup or delete it; applied receipts are recognized by their note.

## Re-used names and replaced photos

A different photo under an old name is a new receipt; the same photo uploaded again is not filed onto a second charge. If the worker can't tell which earlier transaction is this photo's, the receipt goes to review naming them. A photo replaced in the inbox is read anew at the next poll.

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

All settings: [.env.example](../.env.example), or Settings in the web app.
