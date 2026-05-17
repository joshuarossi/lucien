# Editorial pass: in-place Wikipedia-editor restructuring

**Date:** 2026-05-17
**Status:** Approved (verbal), spec written, not yet implemented
**Scope:** Add a new post-synthesis editorial stage as a standalone tool. No change to ingest, chunking, chunk→bucket classification, or the merge worker. Nightly wiring is explicitly **out of scope** for this spec (separate later flip).

## Problem

The merge worker (`scripts/synthesize-update.ts`) is deliberately conservative: its prompt says *"Do NOT rewrite from scratch — work from the existing text. Keep all existing prose unless the new material directly contradicts."* That fidelity is correct for not losing the user's content and for idempotency, but it is **append-biased**: every nightly run adds new framing as fresh prose without reconciling it against what the article already says.

Observed on `Archie_Project` (407 lines, after the 2026-05-16 run): the same theses (producer/verifier separation, the Devin commitment moat, "spec is the new bottleneck", the TPS framing) are restated in 3–5 separate sections; TPS material is scattered on both sides of the Clarity-run narrative; the lead is one dense paragraph that doesn't preview the article (fails WP:LEAD). Paragraph-level prose is excellent; the **whole-article structure** degrades as the article grows. No current stage reconciles this.

The earlier idea of writing splits/merges/renames as Talk-page signals is retained but is not sufficient on its own: Talk conventions and consumers are unbuilt, so a Talk signal is latent, not actionable. The article itself needs to be actively kept well-structured.

## Goal

A perpetual editorial discipline — **not** convergence to a fixed point. New information keeps arriving every night and must keep flowing in via the merge worker; the editorial pass keeps the *ever-growing* article well-structured as it grows, the way Wikipedia is never "done". Small git diffs are explicitly a non-goal; "always complete *and* always well-organized" is the goal.

## Design

### Placement

A new stage `synthesize-editorial`, backed by `scripts/wikify.ts`, conceptually sequenced **after** `synthesize-dispatch` and **before** `normalize-wikilinks`. This spec builds the tool and its tests only. It is **not** added to `nightly.sh` here — rollout is manual-prove-then-auto-enable (see Rollout).

`wikify.ts` is also a standalone CLI:

```
bun run scripts/wikify.ts --bucket Archie_Project [--dry-run]
bun run scripts/wikify.ts --all [--dry-run]
bun run scripts/wikify.ts --changed-since <git-ref> [--dry-run]   # nightly mode (unused until wired)
```

The merge worker is **untouched**. Its conservative, idempotent, citation-safe behavior is a separate concern and a dependency, not a thing this changes.

### Change detection

`--changed-since <ref>` lists `articles/*.md` with `Synthesis update:` commits in the Dreaming repo since `<ref>`. `--bucket` targets one. `--all` targets every article. Only targeted articles are edited (≈18 on a typical night, not 77).

### The editorial worker (per article)

One `claude` call per article. **Input: the full current article text only — no source chunks.** This is a pure editorial transform of the text, which makes it independently testable and re-runnable.

Prompt mandate (the inverse of the merge prompt):

- Act as an expert Wikipedia editor producing one coherent article.
- **Consolidate:** every place the same point/thesis is restated → one canonical passage; replace the echoes with nothing (the point is made once) — do not add cross-references to a personal wiki.
- **Regroup:** scattered material on one topic → one section with subsections; fix heading hierarchy so depth tracks importance.
- **Lead:** rewrite to WP:LEAD — 2–4 paragraphs previewing the major sections, accessible first sentence.
- **Hard invariant — information-preserving:** every substantive claim and every `conv:HASH` present before the pass must survive. Material may be merged and relocated; it may **not** be dropped. Footnote markers may be renumbered, but every `[^N]`↔`[^N]:`↔`conv:HASH` relationship must remain intact and contiguous from 1.
- **Perpetual, not convergent:** the article grows every night; keep the grown article well-structured. Do not optimize for a small diff.
- **Cross-article actions are out of bounds for the editor.** Splitting into a new article, merging two articles, or renaming must NOT be executed. Instead append a dated entry to `Talk/<Article>.md` describing the suggested action and why. This is the accumulating-signal stream — written even though nothing consumes it yet.

### Verification gate (deterministic, not the LLM)

Before an edited article is accepted, `wikify.ts` runs deterministic checks on (original, edited):

1. **Citation preservation:** `set(conv:HASH in original) ⊆ set(conv:HASH in edited)`. Any hash that disappears → reject.
2. **Footnote integrity:** every `[^N]` has a matching `[^N]:` and vice versa; numbering contiguous from 1; every definition line carries exactly one backticked `conv:HASH`. Reuse the existing logic in `scripts/audit-articles.ts` (extract a shared helper if needed).
3. **Word-floor:** `wordCount(edited) ≥ FLOOR · wordCount(original)`, `FLOOR` configurable, default `0.70`. Restructuring should not roughly halve an article; a large drop signals content loss, not consolidation.
4. **Structural sanity:** edited article still starts with a single `# ` title and contains a `## References` section iff the original did.

On **any** failure: discard the edit, leave the merged article exactly as-is, log the failing check loudly. The run still succeeds; that article is simply not restructured this pass. The gate catches citation/claim-*count* loss; it does **not** catch nuance loss — that risk is owned by the manual-prove rollout.

### Commit & idempotency

- Each accepted edit → its own commit `Editorial restructure: <Article>` in the Dreaming repo (distinct from `Synthesis update:` so git history isolates the two operations).
- Pure function of current text: re-running on an already-well-structured article is a near-no-op by the prompt's own logic, not by a lock or flag. No structure-lock state is introduced (would contradict the perpetual-not-convergent goal).
- When wired to nightly (later): own stage with its own exit code and rate-limit halt contained to this stage so merge progress is never lost — mirrors `synthesize-dispatch`. Exact stage order vs. `normalize-wikilinks` (currently stage 5, `exit 14`) and the specific exit code are decided at wiring time, not here.

### Rollout (decided)

Manual-prove, then auto-enable:

1. This spec ships `wikify.ts` + verification gate + tests + CLI. **Not** in `nightly.sh`.
2. Run the CLI by hand on `Archie_Project` (and a handful of others). User reviews the real restructures.
3. Only after the user is satisfied: a separate, small follow-up change wires `synthesize-editorial` into `nightly.sh` (the `--changed-since` mode + `exit 15` + tracked-`*.md` commit, paralleling the `normalize-wikilinks` stage).

## Testing

`scripts/wikify.test.ts` unit-tests the deterministic pieces (the LLM call is exercised manually via `--dry-run`):

- **Change detector:** given a fake `git log` output, returns the correct changed-article set.
- **Citation preservation:** fixture whose "edited" version drops a `conv:HASH` → gate rejects.
- **Footnote integrity:** fixture with an orphaned `[^N]` / missing definition / non-contiguous numbering → gate rejects; a correctly-renumbered fixture → gate passes.
- **Word-floor:** edited at 0.69× → reject; at 0.71× → pass.
- **Structural sanity:** missing `# ` title or dropped `## References` → reject.
- **Acceptance proof (manual, not automated):** `bun run scripts/wikify.ts --bucket Archie_Project --dry-run` produces a restructured `Archie_Project` that the user reviews against the WP-quality critique (consolidated theses, regrouped TPS, rebuilt lead) with no lost citations.

## Out of scope

- Wiring into `nightly.sh` (separate follow-up after manual-prove).
- Graph hygiene: orphan files, filename normalization, redlinks. The spaced-wikilink→orphan root cause was fixed separately (lucien commit `07d7481`; `normalize-wikilinks` is now nightly stage 5). Cross-article split/merge/rename are emitted as Talk signals only, not executed.
- Any change to the merge worker, chunking, or chunk→bucket classification.

## Risks

- **Cost / rate-limit:** a second `claude` call per changed article. A one-call night already hit a rate-limit halt (2026-05-17). The separate-stage design contains the blast radius (merge completes regardless), and idempotency means an unfinished editorial pass self-heals next run — but on heavy nights editorial may lag.
- **Nuance loss:** "consolidate redundancy" is exactly where an LLM can over-compress and flatten a distinction the user valued. The deterministic gate cannot detect this. Sole mitigation: the manual-prove rollout — the user eyeballs real `Archie_Project` output before nightly automation is enabled.
