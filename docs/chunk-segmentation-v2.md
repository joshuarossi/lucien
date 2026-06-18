# Chunk segmentation — v2 design note

> **⚠️ Superseded by [`chunk-segmentation-v3.md`](./chunk-segmentation-v3.md).** v3
> kept the curation/quality-tier ideas below but did NOT adopt the streaming reframe
> (§3a) — it went windowed-whole-conv plus a calibrated relabel. Read v3 for the
> current approach; this doc is historical.

**Status:** proposal (superseded) · **Date:** 2026-06-17 · **Owner:** Josh
**Supersedes:** the v1 chunk LoRA (`minicpm5-chunk-segmented`)

## 1. What v1 told us

We fine-tuned a LoRA adapter on MiniCPM5-1B to run the chunk stage locally, and
evaluated it with a new, fair harness (`scripts/chunk-eval.ts`): the frozen
25-conversation benchmark, byte-identical prompts across models (sha256-verified),
zero train/test leakage (verified), judged by Opus 4.8 against two golds.

| | Base CPM | Adapter (vs GPT-5.5 gold) | Adapter (vs production-DB gold) |
|---|---|---|---|
| Valid JSON | 3/25 | 25/25 | 25/25 |
| Boundary | 0 | 36 | 54 |
| Label | 0 | 52 | 68 |
| Verdicts a/mi/ma | 0/0/25 | 0/7/18 | 4/10/10 |

The adapter **learned the output contract** (base produces invalid rambling; the
adapter produces well-formed JSON with real anchors) but **collapsed to one chunk
per conversation** — it will not split a multi-topic transcript. 14/25 were
whole-conversation envelopes, 9 abandoned the conversation after one early chunk,
2 hallucinated an end-anchor on the longest transcripts.

## 2. Root causes

1. **The training data was amputated.** `make-finetune-data.ts` drops any
   conversation whose prompt exceeds `maxChars: 32000`. That cut **409 of ~1,890**
   chunked conversations — and chunk count rises with length (avg chunks/conv:
   1.13 at 10–15k chars → 3.45 at 25–32k), so the cap removed exactly the
   long, multi-topic, many-split examples. The surviving set was 60% single-chunk
   (avg 1.78). The model faithfully learned "usually one chunk."
2. **The gold was wrong, too.** v1 was first judged against GPT-5.5, which
   **over-splits** (6.16 chunks/conv vs the production pipeline's 3.68). Part of
   the low score was the bar, not the model. **The production-DB gold is now the
   standing benchmark** — it is what the running system actually does.

## 3. Two changes for v2

### 3a. Reframe the task: streaming boundary detection

Whole-conversation segmentation asks a 1B to hold an entire transcript *and* emit
a globally-consistent multi-chunk plan. That is memory-heavy and exactly where the
model collapsed. Instead, decompose into **local, bounded decisions**:

- Slide a window of **K messages** (start: K≈8, or a fixed token budget) with
  stride S over the transcript.
- For each window, the model answers a small question: **does the topic shift
  within this window, at which message, and what is the new topic?**
  `{"boundary": false}` or `{"boundary_at": "<uuid>", "new_topic": "<label>"}`.
- Optionally pass a short **running-topic** carry (the current chunk's label) so a
  window isn't judged in a vacuum — bounded, O(1) context.
- Reassemble the emitted boundaries into chunks downstream (deterministic).

Why it fits: memory is **O(window)** regardless of conversation length — the 32k
amputation disappears (long convs simply yield more windows). Each decision is
small and local, which a 1B can actually learn. Training examples multiply
(one per window) and are individually cheap.

**Open params:** window size K, stride S (overlapping vs disjoint), whether the
"new_topic" label is free text or a constrained vocabulary, and how much
running-topic context to carry. These need one round of empirical tuning.

### 3b. Curate for *good* splits, not *any* splits

The DB already encodes split quality via the graph
`chunks → chunk_buckets → buckets → synthesized_bucket_chunks → articles`:

- **Tier A — genuine multi-topic (≈630 convs):** multi-chunk conversations whose
  chunks map to **≥2 distinct buckets** — i.e., the split separated real topics,
  validated by landing in different articles. The core teaching signal.
- **Tier B — clean single-topic (sample of ~907):** single-chunk convs that were
  synthesized into an article. Teaches *when not to split*. Sampled to balance, not
  to dominate (v1's failure was too much of this).
- **Down-weight — multi-chunk, single-bucket (≈329):** fine sub-splits within one
  topic. A little is fine; too much teaches over-splitting.
- **Quality gate:** prefer chunks present in `synthesized_bucket_chunks`
  (1,601 convs have every chunk synthesized) — the chunk demonstrably fed the wiki.
- **No length amputation.** Streaming windows long convs instead of dropping them.

Target a deliberate single:multi balance (≈40:60) rather than v1's incidental
60:40, with Tier A over-represented relative to the raw DB.

## 4. Data splits — train / validation / test

- **test** — the **frozen 25-conversation benchmark** (`benchmark/dataset/chunk.json`),
  unchanged from v1 so every adapter is comparable. Never seen in training/tuning.
- **validation** — a held-out sample (~8–10% of curated convs), for checkpoint
  selection / early stop. Disjoint from train.
- **train** — the remaining curated convs.

Leakage is enforced two ways, as in v1: the 25 test UUIDs are excluded from the
candidate pool, and the eval report re-scans the emitted training data for any
test UUID on every render (currently ✓ 0/25).

## 5. How we'll know it worked

Re-run `scripts/chunk-eval.ts` (generate → judge vs production-DB gold → report).
Success = the adapter starts producing **multiple chunks on multi-topic convs**
matching production granularity (≈3.7/conv), boundary score climbing out of the
50s, majors falling. The open question v1 raised — *can a 1B do this at all* —
gets an honest answer each iteration from the production-anchored benchmark.

## 6. Sequencing

1. Curation selection + quality tiers + balanced train/valid split (DB-driven). ← starting here
2. Emit format: streaming windows (3a) is the target; a whole-conv v2.0 (same
   format as v1 but curated + un-amputated) is a cheap intermediate if we want a
   quick data-only A/B before committing to the reframe.
3. Train (raise rank, more epochs per v1 notes), evaluate, iterate.
