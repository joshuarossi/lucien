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
bun run scripts/cluster-assign.ts       # assign new chunks to existing buckets (same script — already incremental)
bun run scripts/synthesize-update.ts    # integrate ONLY new chunks into existing articles
```

What each step does differently from bootstrap:

- **`ingest-recent.ts`** — incremental. Per-source watermarks in `.lucien/state.json` mean only new conversations land. Already-cached conversations are skipped at the per-tree level via sqlite pre-check.
- **`chunk-recent.ts`** — picks up two cases: (a) conversations never chunked before, (b) conversations whose `updated_at` is newer than `chunked_at` (had new messages appended). Stale conversations have their old chunks deleted and re-chunked.
- **`cluster-assign.ts`** — same script as bootstrap. It was already incremental: `INSERT OR IGNORE` on `chunk_buckets` and a `NOT IN` filter on already-assigned chunks. It does NOT create new buckets — if a new chunk doesn't fit any existing bucket, the LLM picks the best fit available.
- **`synthesize-update.ts`** — the important one. For each bucket, finds chunks that have been assigned but not yet synthesized (tracked in a new `synthesized_bucket_chunks` table). If the article doesn't exist, it skips (won't bootstrap-from-scratch implicitly — that's the bootstrap script's job). If the article exists, it reads the existing markdown, sends it to Claude with the new chunks and an UPDATE prompt that says "preserve existing prose, extend citation numbering, respect manual edits, integrate new material." Writes the updated article. Records the new chunks as synthesized so future runs don't re-process them.

### One-time backfill

The first time `synthesize-update.ts` runs against a bucket whose article already exists (created by the bootstrap path), it backfills the `synthesized_bucket_chunks` table with every chunk currently assigned to that bucket — representing "we've already integrated these." After that, only genuinely new chunks are picked up. The backfill is logged so you know it happened.

### Dry-run

```bash
bun run scripts/synthesize-update.ts --dry-run
```

Prints which buckets have new material, how many chunks each, and a preview of the would-be output. No files written, no chunks marked synthesized.

### Filter to one bucket

```bash
bun run scripts/synthesize-update.ts --only-bucket Photography
```

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

- `cluster-taxonomy.ts` is bootstrap-only. The nightly pipeline does not expand the bucket set. If new conversations introduce a genuinely new topic, its chunks will be assigned to the closest existing bucket (possibly the wrong one) or potentially left unassigned. Plan to re-bootstrap the taxonomy periodically (quarterly?).
- `cluster-assign.ts` does not re-evaluate existing chunk→bucket assignments. Once assigned, a chunk's bucket is permanent unless manually deleted from `chunk_buckets`.
- Spec 2 will wrap all of this as MCP tools the cron-launched Claude orchestrates as a single command. Today the user runs the four scripts manually.
