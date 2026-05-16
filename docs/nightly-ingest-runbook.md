# Lucien — Ingest & Synthesis Runbook

Lucien runs as two parallel pipelines:

- **Bootstrap** — first-time setup, once per Dreaming. Reads a bulk Data Export, derives buckets from scratch, writes every article.
- **Nightly** — incremental. Pulls new conversations live from Claude Code on disk + claude.ai web, chunks only what's new (or grew), integrates new chunks into existing articles, preserves manual edits.

All Lucien runtime state lives **inside this repo** at `./.lucien/` (gitignored). The Dreaming (`~/Dreaming/`) stays purely your markdown wiki content, editable in Obsidian.

---

## First-time setup

One-time per machine.

1. Install dependencies:
   ```bash
   bun install
   bunx playwright install chromium
   ```

2. Log in to claude.ai once so the Playwright profile is populated:
   ```bash
   bun run scripts/auth-claude-ai-login.ts
   ```
   A Chromium window opens at claude.ai. Sign in if needed. The script exits when it detects an authenticated session. The profile is stored at `./.lucien/playwright-profile/`.

3. If you have an existing `~/Downloads/lucien.db` from prior bootstrap runs, move it into place:
   ```bash
   mkdir -p ./.lucien
   mv ~/Downloads/lucien.db ./.lucien/lucien.db
   ```

---

## Bootstrap pipeline (run once, when first setting up a Dreaming)

```bash
bun run scripts/ingest.ts               # bulk import from Claude Data Export JSON
bun run scripts/chunk.ts                # segment every conversation
bun run scripts/cluster-taxonomy.ts     # derive bucket set from scratch
bun run scripts/cluster-assign.ts       # assign every chunk to a bucket
bun run scripts/synthesize.ts           # write every article from scratch
```

The bootstrap scripts assume a fresh DB or empty wiki. They explicitly refuse to overwrite existing state where it would silently corrupt data:

- `cluster-taxonomy.ts` exits if buckets already exist (you have to `DELETE FROM buckets` to reseed).
- `synthesize.ts` skips articles that already exist on disk unless `--force`, which regenerates from scratch and **clobbers manual edits**.

Use this pipeline once. After that, run the nightly pipeline below.

---

## Nightly pipeline (every day; safe to re-run any time)

```bash
bun run scripts/ingest-recent.ts        # pull new conversations from both sources
bun run scripts/chunk-recent.ts         # chunk only new conversations and those that grew
bun run scripts/cluster-assign-recent.ts  # assign new chunks; propose new buckets when nothing fits
bun run scripts/synthesize-dispatch.ts  # build manifest, dispatch one isolated worker per article
```

`synthesize-dispatch.ts` builds an inspectable JSON manifest (`{ bucket: { mode, chunkIds } }`)
from DB state, then spawns `synthesize-update.ts --only-bucket <name>` as an isolated worker per
article. `--concurrency N` (default 1 = sequential, behaviour-identical to the old monolithic
run) controls the sliding worker pool. It halts launching new workers if a worker reports a
rate-limit / usage-window signal; re-running resumes cleanly (idempotent via
`synthesized_bucket_chunks`). `synthesize-update.ts` is unchanged and still usable standalone.

What each step does differently from bootstrap:

- **`ingest-recent.ts`** — incremental. Per-source watermarks in `.lucien/state.json` mean only new conversations land. Already-cached conversations are skipped at the per-tree level via sqlite pre-check.
- **`chunk-recent.ts`** — picks up two cases: (a) conversations never chunked before, (b) conversations whose `updated_at` is newer than `chunked_at` (had new messages appended). Stale conversations have their old chunks deleted and re-chunked.
- **`cluster-assign-recent.ts`** — for each new chunk, the LLM either assigns it to one or more existing buckets OR proposes a brand-new bucket (name + description) when nothing fits. Proposed buckets are inserted into the `buckets` table mid-run, so subsequent batches in the same run see them and don't duplicate. Strongly biased toward existing buckets.
- **`synthesize-update.ts`** — the article-writer with four branches per bucket:
  1. **Backfill** (one-time migration): an article exists on disk but the `synthesized_bucket_chunks` table has no rows for it. Assume the bootstrap path wrote it; mark every currently-assigned chunk as synthesized so future runs only see genuinely new chunks.
  2. **Orphaned**: synthesis history exists but the file is gone. Warn and skip.
  3. **New bucket → new article**: bucket exists, no file, no history. Run the bootstrap prompt to write a fresh article. (This is what happens when `cluster-assign-recent.ts` created a new bucket.)
  4. **Update existing**: file exists, new chunks exist. Read the article, send it to Claude with the new chunks and the UPDATE prompt that says "preserve existing prose, extend citation numbering, respect manual edits."

### One-time backfill

The first time `synthesize-update.ts` runs against a bucket whose article already exists (created by the bootstrap path), it backfills the `synthesized_bucket_chunks` table with every chunk currently assigned to that bucket — representing "we've already integrated these." After that, only genuinely new chunks are picked up. The backfill is logged so you know it happened.

### Dry-run

```bash
bun run scripts/synthesize-dispatch.ts --dry-run
```

Prints the full manifest JSON (every actionable bucket, its mode, and its chunk IDs) plus
orphan/skip counts. Spawns no workers, spends zero tokens, writes nothing.

### Filter to one bucket

```bash
bun run scripts/synthesize-dispatch.ts --only-bucket Photography     # manifest + dispatch, one bucket
bun run scripts/synthesize-update.ts  --only-bucket Photography      # run the worker directly
```

### Concurrency

```bash
bun run scripts/synthesize-dispatch.ts --concurrency 5   # sliding pool of 5 workers
```

Default is 1 (sequential). Higher concurrency finishes faster in wall-clock but compresses the
same token spend into a tighter window — it hits the 5-hour usage limit harder and burstier.

---

## What to do when

| Situation | Pipeline | Notes |
|---|---|---|
| Setting up a new Dreaming on a new machine | Bootstrap | Then move to nightly |
| Routine daily/nightly run | Nightly | Default for ongoing use |
| Want to re-derive the bucket taxonomy from scratch | Bootstrap (re-run `cluster-taxonomy.ts` after manual `DELETE FROM buckets; DELETE FROM chunk_buckets; DELETE FROM synthesized_bucket_chunks`) | Will regenerate every article |
| A specific article has rotted and you want to nuke it | `rm ~/Dreaming/articles/Foo.md && bun run scripts/synthesize.ts --force --only-bucket Foo` | Bootstrap path with single-bucket filter |
| You hand-edited an article and want to test that nightly preserves it | `bun run scripts/synthesize-update.ts --only-bucket Foo --dry-run` first | Then drop `--dry-run` when you're satisfied |

---

## Re-authenticating

If a run reports `claude-ai: profile is no longer authenticated`, re-run:

```bash
bun run scripts/auth-claude-ai-login.ts
```

This typically only happens if you sign out of claude.ai in the Playwright profile, or after a very long period of inactivity (cf_clearance lasts ~30 days).

---

## State files

All under `./.lucien/` in this repo (gitignored):

| Path | Purpose |
|---|---|
| `./.lucien/lucien.db` | sqlite — conversations, messages, chunks, buckets, chunk_buckets, chunked_conversations, synthesized_bucket_chunks |
| `./.lucien/state.json` | per-source ingest watermarks |
| `./.lucien/playwright-profile/` | Playwright Chromium profile (cookies, local storage) |

---

## Known limitations

- `cluster-taxonomy.ts` is bootstrap-only and intentionally not used in nightly runs. The nightly bucket-set growth happens in `cluster-assign-recent.ts`, one bucket at a time as warranted. If the taxonomy ever drifts (too many overlapping new buckets, hand-edited bucket names, etc.), a periodic manual re-bootstrap (DELETE FROM buckets; DELETE FROM chunk_buckets; DELETE FROM synthesized_bucket_chunks; rerun bootstrap) is the recovery path.
- `cluster-assign-recent.ts` does not re-evaluate existing chunk→bucket assignments. Once a chunk is bucketed, that decision is permanent unless manually deleted from `chunk_buckets`.
- New buckets get **English-prose names from the LLM**. They may not perfectly match existing bucket naming conventions (underscore vs space, casing). Inspect new buckets in the run output and rename in sqlite if needed.
- Spec 2 will wrap all of this as MCP tools the cron-launched Claude orchestrates as a single command. Today the user runs the four scripts manually.
