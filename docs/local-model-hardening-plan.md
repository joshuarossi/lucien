# Local-Model Hardening Plan

Roadmap for running the Lucien pipeline on the local model (`pi` → `optiq serve
--model mlx-community/Qwen3.6-27B-OptiQ-4bit`), drawn up after the first local
`chunk-recent` run (2026-06-10: 26 conversations, 108 chunks, evaluated at
B+ — boundary judgment near-expert, mechanics flaky). The dependency logic:
Phase 1 makes runs reliable, Phase 2 measures where the model actually falls
short, Phase 3 fixes the one contract that is wrong-shaped regardless of
model, Phase 4 spends fine-tuning effort only where the scorecard proves it's
needed.

## Phase 1 — Deterministic hardening (no model changes)

| # | Change | Where | Status |
|---|--------|-------|--------|
| 1 | UUID validate-and-repair: every emitted boundary UUID must exist in the conversation; otherwise snap (conversation-uuid paste → first/last message; chimera splice → unique long-prefix match ≥8 chars), log the repair, fail the conversation only if no match clears the threshold. Also: inverted-range swap, trailing-coverage extension. | `scripts/chunk-validation.ts`, wired into `chunk-recent.ts` / `chunk.ts` | ✅ 2026-06-10, with tests |
| 2 | Strip tool-result payloads from claude-code transcripts | `scripts/sources/claude-code.ts` | ❌ **Dropped — misdiagnosed.** The three giants (367KB/183KB/141KB) are ~85% assistant *prose*, not build logs (only ~10KB of 690KB matches command/tool patterns), and the adapter already drops `tool_result` blocks in `extractText`. If a giant still won't chunk after item 3, the remedy is Phase 3 windowing. |
| 3 | Inline Meta docs into prompts instead of "go Read them with tools" — kills agent-loop context accumulation (a 34k-char conversation ballooned to a 105k-token prefill); calls become single-turn with one bounded prefill. `Meta/Changelog.md` excluded (machine-written run log, not policy). Discovery-by-location preserved: new Meta pages are picked up next run with zero code change. | `meta-inline.ts` → `chunk-recent.ts`, `chunk.ts` (which also gained the Meta policy section it never had), `synthesize-update.ts` (both prompts), `cluster-assign-recent.ts` | ✅ 2026-06-10 |
| 4 | Synthesis word-floor gate (70%, mirrors wikify) — truncated output can no longer clobber an article | `synthesize-update.ts` | ✅ 2026-06-09 |
| 5 | Serving fixes: prompt-cache cap, 28GB wired limit, restart loop | `serve.sh` | ✅ 2026-06-09 |
| 6 | Overlap policy tightened to "at most one shared boundary message" (the 27B produced a 6-message overlap and a full-envelope chunk) | `~/Dreaming/Meta/Chunking.md` | ✅ 2026-06-10 |

**Acceptance:** re-run `chunk-recent` → the 3 giants chunk without a crash;
zero unrepaired UUIDs; wired memory never exceeds ~26GB.

## Phase 2 — Finish the baseline evaluation, stage by stage

4. `cluster-assign-recent` — run alone, then audit: did the 108 chunks land in
   sensible buckets? (Bucket judgment is the most taste-dependent stage; this
   is where the local model is most likely to diverge from Opus.)
5. `synthesize-dispatch --concurrency 1` — the headline test. Watch:
   word-floor gate hits, footnote `[^N]` discipline, citation fidelity,
   integration quality on small vs. big articles.
6. `wikify` on whatever synthesis touched — its deterministic gate gives a
   pass/fail score per article for free.
7. Write the scorecard: per stage — pass / pass-with-gates / needs-adapter /
   needs-redesign. Row one is filled in: **chunking = pass-with-gates (UUID
   repair)**; see `reports/chunking-eval-2026-06-10.html`.

## Phase 3 — The synthesis redesign (brainstorm first)

8. **Targeted-edit synthesis:** change the contract from "re-emit the whole
   merged article" to "here are tonight's chunks; edit `articles/X.md` in
   place" using pi's native edit tools. Output scales with the delta, not
   accumulated article size — what makes 188KB articles (Archie_Project)
   feasible locally. Wikify stays the compaction stage that periodically
   re-integrates structure (LSM-tree shape: nightly appends, slow-cadence
   compaction). Needs a design pass: gate design (post-state validation +
   `git checkout` revert), and what happens to the word-floor gate when edits
   are legitimate.
9. **Windowing** stays in the back pocket — only if a post-Phase-1 transcript
   still exceeds ~50k tokens of real dialogue: cut at long time-gaps, overlap
   > max chunk size, UUID-span dedupe. (The 367KB giant is the likely first
   customer.)

## Phase 4 — Per-stage adapters (the actual goal)

10. Pick the first adapter from the Phase 2 scorecard — whichever stage scored
    worst. Training data is already on disk: the SQLite DB has every Opus
    transcript→chunks pair; the Dreaming's git history has every synthesis and
    editorial commit. Pipeline gates = eval harness.
11. Wire adapter selection into the pipeline — `optiq serve --adapter` mounts
    multiple adapters on one base; requests pick per call. Each pipeline
    script names its stage's adapter: per-station experts, hot-swapped per
    request, one resident 27B.
12. (Optional, parallel) 24GB laptop as a second station — small model serving
    the cheap stages, task-level parallelism instead of tensor-level.
