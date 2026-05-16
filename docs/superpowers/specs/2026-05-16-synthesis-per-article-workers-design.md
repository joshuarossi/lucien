# Synthesis: per-article isolated workers

**Date:** 2026-05-16
**Status:** Approved (verbal), implementing
**Scope:** Restructure the synthesis stage of the nightly pipeline. No change to chunking or chunk→bucket classification.

## Problem

`scripts/synthesize-update.ts` is a single monolithic process that loops every bucket (~71)
in-sequence, calling `claude` once per bucket inside one long-lived script. Consequences:

- **No failure isolation.** A crash or a bad `claude` response partway through leaves the run
  half-done with no clean boundary; the whole script is the unit of failure.
- **No parallelism.** Buckets are processed strictly serially even though each bucket's work is
  completely independent (one article, its own chunks, its own `claude` call).
- **The work plan is implicit.** "Which articles have new material and which chunks" exists only
  as a SQL query buried inside the loop. It cannot be inspected, diffed, or tested without
  running the whole thing.

The semantic pipeline is already correct and is **not** changing:

1. `chunk-recent.ts` — split conversations into topic-coherent chunks. (LLM)
2. `cluster-assign-recent.ts` — assign each chunk to one or more buckets, propose new buckets.
   One-to-many. (LLM) Writes `chunk_buckets`.
3. Synthesis — per article, integrate that article's new chunks into the existing article.

Only stage 3's **execution shape** changes.

## Design

Decompose stage 3 into three concerns:

### 1. Manifest (deterministic, zero token cost)

The work plan is a pure function of DB state left by stage 2 plus what's on disk. No model call.

For each bucket, classify into exactly one of:

| Mode | Condition | Action |
|---|---|---|
| `update` | article file exists, has unsynthesized chunks | worker integrates new chunks |
| `create` | no article file, no synthesis history, has assigned chunks | worker bootstraps a new article |
| `backfill` | article file exists, no synthesis history | **deterministic, no worker**: mark all current chunks synthesized (one-time migration from the old bootstrap path) |
| `orphan` | no article file, synthesis history exists | **deterministic, no worker**: warn and skip (file deleted manually) |
| `skip` | no unsynthesized chunks | excluded from manifest |

`backfill` and `orphan` are bookkeeping/filesystem facts with no LLM component, so the manifest
builder performs them inline. The emitted manifest therefore contains **only actionable
entries** — `create` and `update` — each as `{ bucket: { mode, chunkIds: number[] } }`.

The manifest is printed as JSON. `--dry-run` prints it and exits: no workers, no tokens, fully
inspectable. This is the artifact the user asked for.

### 2. Dispatcher (orchestration)

Reads the manifest and runs a **sliding worker pool**:

- `--concurrency N` (default **1**). At N=1 behavior is equivalent to today's sequential loop —
  this makes the change behavior-preserving at the default and parallelism strictly opt-in.
- Sliding pool, **not** fixed batches: when a worker exits, immediately start the next manifest
  entry. Article sizes vary by >100x (a 4,400-word article + 40 chunks vs. a stub), so fixed
  batches would idle slots waiting on the slowest member.
- **Rate-limit-aware early stop.** A worker that detects `claude` rate-limit / 5-hour-window
  exhaustion exits with a distinct code (`2`). On seeing exit `2`, the dispatcher stops
  launching new workers and lets in-flight ones drain. Re-running later resumes cleanly because
  `synthesized_bucket_chunks` already makes the pipeline idempotent — only unfinished articles
  remain in the next manifest. Included in v1: the entire motivation for this work is the
  5-hour usage window, and fanning out N workers makes them hit the ceiling simultaneously
  rather than independently.
- After all workers finish, the dispatcher performs **one** git commit of all written articles
  (preserves today's single-synthesis-commit behavior) and prints the run summary.

### 3. Worker (`synthesize-one.ts`, isolated, minimal context)

One OS process, one bucket, one `claude` call. Given `--bucket <name>` (+ optional `--dry-run`):

- Loads only that bucket, its existing article (if any), and only its unsynthesized chunks.
- Owns the `create` vs `update` branch decision for its single article (same prompts and
  validation as today's Branch 3 / Branch 4).
- Writes the article, marks its chunks synthesized in `synthesized_bucket_chunks`. Does **not**
  git commit (dispatcher owns the commit).
- Exit codes: `0` success, `2` rate-limited, `1` any other error. On non-zero the bucket's
  chunks stay unsynthesized and reappear in the next run's manifest (idempotent retry).

Context per worker is flat and tiny — one article + a few chunks — which is the WOR-104
compounding lesson applied structurally: no corpus-wide payload, no growth across buckets.

## Code structure

**Constraint discovered during implementation:** the two synthesis prompt constants in
`synthesize-update.ts` contain hand-escaped citation markup with an existing inconsistency
between them (`[\\[1\\]]` in the bootstrap prompt vs. `[\[1\]]` in the update prompt). Moving
that text into a shared module is a real corruption risk that would silently affect every
synthesized article's citations. The decomposition is therefore done **without touching the
existing file**:

- **`scripts/synthesize-update.ts`** — **unchanged.** Its existing `--only-bucket <name>` flag
  already runs the full Branch 1–4 logic (backfill / orphan / create / update) for exactly one
  bucket, with minimal flat context. It *is* the per-article worker.
- **`scripts/synthesize-dispatch.ts`** (new, the only new file) — builds the manifest from DB
  state (read-only), prints it as JSON, and runs a sliding pool of
  `bun run scripts/synthesize-update.ts --only-bucket <name>` child processes at
  `--concurrency N` (default 1), with rate-limit-aware early stop.

Trade-off vs. the original 3-file plan: each worker self-commits its one article (existing
`--only-bucket` behaviour: commit message `Synthesis update: <bucket>`), so a run produces N
small per-article commits instead of one aggregate commit. This is acceptable and arguably
better — per-article git granularity, and a failed worker leaves a clean boundary. The
single-aggregate-commit behaviour is intentionally dropped.

## CLI compatibility

`synthesize-update.ts` keeps its exact current interface (used directly as the worker and
still usable standalone). The new nightly entry point is
`bun run scripts/synthesize-dispatch.ts`, supporting: `--dry-run` (print manifest JSON, spawn
nothing, zero tokens), `--only-bucket <name>` (manifest filtered to one), `--concurrency N`
(default 1). The runbook's nightly step changes from `synthesize-update.ts` to
`synthesize-dispatch.ts`.

## Out of scope

- N-buckets→1-article consolidation (bucket≡article 1:1 stays).
- Re-evaluating existing chunk→bucket assignments.
- Any change to `chunk-recent.ts` / `cluster-assign-recent.ts`.

## Testing

- Manifest builder: unit-testable against a seeded in-memory sqlite — assert mode classification
  (update/create/backfill/orphan/skip) and chunkId sets, with zero `claude` calls.
- Dispatcher: sliding-pool refill and rate-limit early-stop tested with a fake worker binary
  (no real `claude`).
- Worker: covered by the existing synthesis behavior; `--dry-run` parity check.
- End-to-end: `--concurrency 1` must produce the same article writes as the pre-refactor script
  on the same DB state (behavior-preserving at default).
