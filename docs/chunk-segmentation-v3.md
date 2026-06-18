# Chunk segmentation — v3 design note

**Status:** built, ready to train · **Date:** 2026-06-17 · **Owner:** Josh
**Supersedes:** `chunk-segmentation-v2.md` (the v2 curated whole-conv set)

## 1. What v2 told us

The v2 chunk LoRA (`chunk-v2` on Gemma-4-e4b-OptiQ-4bit) was the best contestant on
the frozen 25-conv benchmark (boundary 78 / label 85 / grade C+, vs base 65/80/D),
and the reference-free rubric judge rated it genuinely good (coherence 86, 11
excellent / 12 acceptable / 2 poor). But two problems remained:

1. **Long-conv partition collapse (the one structural failure).** Clean capability
   cliff at ~25 messages: on long, dense conversations the model bolted nested child
   chunks inside a parent and dropped message spans, breaking the tiling. **Root
   cause:** the v2 build *excluded every conversation over the char cap*
   (`oversizedExcludedByTier` A=278, C=105) — so the model saw **zero** long
   examples in training.
2. **Over-splitting (the dominant error in absolute terms).** The rubric judge
   flagged `over_split` / `sub_topic_split` on ~13/25 convs, including short ones —
   driven by tier-C production gold (multi-chunk-in-one-bucket = sub-splits) and by
   intra-topic over-splits in production labels.

v2 was also **data-starved** (450 train examples; train loss ≈0.02 vs val ≈0.17 =
memorized), so it needed *more* and *harder* data.

## 2. What v3 does

Two independent levers, both in `scripts/curate-chunk-v3.ts` plus a relabel
pipeline.

### 2a. Windowing (fixes the long-conv collapse)

Long conversations are no longer dropped. Their production chunks are packed into
**windows that fit the context budget, cutting ONLY on chunk boundaries** (never
mid-topic). Each window becomes a normal training example whose gold cleanly tiles
that window — so the model finally sees long, valid, multi-chunk tilings.

- `--budget-chars` (default 30000) per window; `--hard-max` (44000) drops a lone
  mega-chunk.
- **Windowed single-chunk artifacts are dropped.** When char-heavy packing forces a
  window down to one chunk, it teaches "wrap the whole span in one chunk" (the v1
  envelope collapse) — so prod-sourced windowed singletons are dropped. *Exception:*
  a window the relabel **deliberately** merged to one chunk (a long plan → 1) is the
  strongest hard not-split example, and is kept.

### 2b. Curriculum (harder distribution, balanced signal)

- Drop **tier C** (multi-chunk single-bucket = the sub-split signal).
- Filter **hard structural defects** (overlap>1 / nested / unresolved) — teaching
  those re-creates the collapse.
- **Down-sample easy shorts** (≤8-msg single-chunk, train-loss≈0).
- Keep **long single-topic** convs whole.
- Balance single:multi (`--single-frac`).

### 2c. Calibrated relabel (the gold quality lever)

Production gold over-splits, so training on it teaches over-splitting. The relabel
pipeline replaces production gold on the hardest multi-chunk windows with curated
**ideal** gold from a strong model (Opus sub-agents):

```
curate-chunk-v3.ts --emit-manifest    # hardest multi-chunk windows, hardest-first
relabel-prep.ts --top N               # per-window prompt files + a self-contained
                                      #   Workflow script (ids EMBEDDED — the
                                      #   Workflow args channel was unreliable)
<run the emitted relabel-workflow.mjs via the Workflow tool>   # 1 sub-agent/window
relabel-collect.ts                    # validate anchors+tiling, audit aggressive
                                      #   merges, write ideal-labels.json
curate-chunk-v3.ts                    # folds the ideal cache in (cache-or-prod
                                      #   per window), rebuilds train/valid
```

`ideal-labels.json` is keyed by `windowId = uuid:startIdx-endIdx`; the build uses
the ideal label when present, else production gold.

## 3. The calibration — the hard-won part

The relabel prompt went through **two over-corrections** before settling. This is
the most important thing to preserve, because the instinct on each was wrong:

1. **"Merge lever" (too merge-happy).** First framing: "fix over-splitting, merge
   sub-topics decisively." On a 6-window demo it cut chunks −24% and an adversarial
   check found it *fused genuinely distinct topics* — the irreversible error.
2. **"Split-only / never reduce below prod" (too split-happy).** Over-corrected on
   the recoverability asymmetry (over-split is recoverable; under-split is a
   permanent, silent loss). But baking "keep-split-when-uncertain" into the **gold**
   just trains the model to over-split — the very error v3 exists to fix. The
   asymmetry is a *runtime* property (belongs to inference / a future DPO stage),
   **not** the SFT gold.
3. **Settled: "segment correctly, with a gentle split tiebreak."** Produce the
   exactly-right segmentation, forced toward neither direction:
   - A **multi-stage plan/process is ONE topic** — a 5-part plan is one chunk, not
     five ("phase 2 of *what*?"). This is the most common over-split to fix.
   - **Split genuinely distinct topics** — downstream needs real splits.
   - **Never fuse** two genuinely distinct subjects / never drop a span.
   - On **genuine doubt only**, lean ~**52/48 toward splitting** — a gentle
     tiebreak, *not* license to over-split.

   This is the `RUBRIC` in `relabel-prep.ts`. **Do not rebuild a merge lever, and do
   not bias the gold toward more chunks.**

**Fusion backstop.** `verify-workflow.mjs` (generated by the verify step) runs an
adversarial check on every aggressive merge: "does this chunk fuse genuinely
distinct subjects?" — with a verifier that knows a plan / multi-facet single topic
is *not* a fusion. Genuine fusions revert to production gold (the safer, more-split
version). On the v3 run, **0 of 45** aggressive merges were fusions.

## 4. The v3 dataset (final)

- **1043 train / 115 valid.** 227 calibrated-ideal + 816 production windows in
  train. avg 2.26 chunks. **0 leakage / overlap / nested / unresolved.**
- Full relabel: **856 → 670 chunks (−22%)** on the hardest-250 cohort — verified to
  be correct over-split removal, not under-splitting.
- **Difficulty profile (the point — make it hard to train):**

  | | hard | medium | easy |
  |---|---|---|---|
  | not-split (don't fragment) | **72** (≥13 msgs, one topic) | 44 | 151 |
  | split (find boundaries) | **76** (≥21 msgs, multi-topic) | 192 | 508 |

  Hard split ≈ hard not-split (balanced); the set leans split-heavy overall, which
  is deliberate anti-collapse signal.

## 5. How we'll know it worked

- **Train/val loss curve = the read on "hard enough."** If it starts low and stays
  flat, the set is too easy — down-sample the easy-split bucket (a **free rebuild**,
  since all relabel outputs are cached on disk).
- Re-run `scripts/chunk-eval.ts` both lenses (`--mode prod` drift check vs
  production gold; `--mode rubric` reference-free goodness) against the new
  checkpoint. Success = the ≥25-msg cliff-zone collapse is gone (valid tilings on
  long convs) without regressing the shorts, and over-split flags drop.

Suggested training: ~700 iters, rank 16, lr 1e-5 (the v2 sweet spot before it
overfit at 900).

## 6. What's in git vs on disk

Only the **recipe** is tracked: the scripts + each `dataset-info.json`. All
generated data is gitignored — `*.jsonl`, `ideal-labels*.json`, `relabel/`,
`verify/`, `relabel-manifest.json`, `aggressive-merges.json`. The expensive
artifacts (`relabel/out/` agent outputs + `ideal-labels.json`) live on local disk
and are cheaply regenerable (`relabel-collect.ts` from `out/`), so a curriculum
re-tune is a free, instant `curate-chunk-v3.ts` re-run — no re-relabeling.

## 7. Not done / next

- **v3.1 ORPO — BUILT (centered, not asymmetric).** Earlier note here proposed an
  under-split-heavy "over-split-is-safe" lean. That was wrong: in practice both
  failure modes are real (0-chunk collapse AND ~8-chunk explosion), so the goal is
  the CORRECT amount for each conversation, not a direction. The chosen already
  encodes the correct count; we bracket it on BOTH sides so it is a basin —
  under-split negatives (merge adjacent, collapse-to-1) AND over-split negatives
  (split a chunk, explode-to-~2x, long-single-topic multi-cut). Load-bearing
  property: long/few-chunk windows MUST appear with over-split negatives so the
  model cannot learn "long ⇒ split more". Balance is a *slight* over-split lean
  (~1.3:1) — the explosion is the more visible failure — enforced corpus-wide.
  - Pipeline: `scripts/dpo-prep.ts` (perturb + stage prod windows) →
    `dpo-judge-prod-windows` Workflow (one agent per prod multi-chunk window:
    classify each boundary real-shift vs over-split; this both vets prod gold as a
    clean chosen and validates under-split negatives) → `scripts/dpo-collect.ts`
    (corrects prod over-splits into a clean chosen, generates the centered/leaned
    pair set). Output: `benchmark/finetune/chunk-v3/dpo/orpo-{train,valid}.jsonl`
    (TRL conversational-preference; `.with-meta.jsonl` carries dir/tag/source).
  - First build: 2,482 pairs (1.3:1 over:under). 46% of prod windows were found
    over-split by the judge and corrected before use as chosen.
- Scale the relabel beyond the hardest 250 if the loss curve / eval warrant it.
