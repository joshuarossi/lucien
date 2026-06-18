/**
 * dpo-prep — turn the chunk-v3 SFT set into ORPO/DPO preference candidates.
 *
 * Strategy (see docs/chunk-segmentation-v3.md §7 "v3.1 DPO"):
 *   chosen   = an existing v3 segmentation (the assistant turn in train/valid.jsonl)
 *   rejected = a structural perturbation of that segmentation
 *
 * Two perturbation directions, mapped to the runtime over-split-is-safe asymmetry:
 *   - merge-adjacent  → UNDER-split negative (the costly, irreversible error). Heavy weight.
 *   - split-mid-topic → OVER-split  negative (the gentle, recoverable error).  Light weight.
 *
 * Trust model (resolves "ideal + judge-verified prod" / "judge ambiguous only"):
 *   - A window is "ideal" if its chunks match an entry in ideal-labels.json
 *     (Opus-relabeled, verified). Otherwise it is "prod" (raw production gold,
 *     which is known to over-split).
 *   - SPLIT negatives: emitted ONLY from ideal windows (chosen is trusted-coherent,
 *     so any further split is unambiguously worse). Written straight to trusted-pairs.
 *   - MERGE negatives from IDEAL windows: trusted — Opus already merged any
 *     non-shift, so every surviving boundary is a real topic shift. -> trusted-pairs.
 *   - MERGE negatives from PROD windows: AMBIGUOUS (a merge is only "bad" if the
 *     two chunks are genuinely distinct topics; if prod over-split a multi-stage
 *     process the merge is actually correct). -> staged for the judging workflow,
 *     one judge call per window.
 *
 * Outputs (under benchmark/finetune/chunk-v3/dpo/):
 *   trusted-pairs.jsonl   final-ready pairs that need no judging
 *   judge-windows.json    prod multi-chunk windows + their merge payloads, to judge
 *   judge-in/<id>.txt     self-contained judge prompt per prod window
 *   judge-windowIds.json  list of {id, windowId, mc} for the workflow to fan out over
 *   prep-info.json        counts / provenance
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V3 = join(ROOT, "benchmark/finetune/chunk-v3");
const OUT = join(V3, "dpo");
const JUDGE_IN = join(OUT, "judge-in");

type Chunk = { start_message_uuid: string; end_message_uuid: string; label: string };
type Rec = { messages: { role: string; content: string }[] };

const argVal = (k: string) => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

// Ordered message UUIDs as they appear in the formatted transcript. The
// conversation header "Conversation: … (uuid: X)" is NOT bracketed, so the
// bracketed-role anchor regex naturally excludes it. Anchors are captured up to
// the closing ")" — some conversations use suffixed ids ("<uuid>-msg-20"), so a
// fixed-length match would silently truncate them.
const MSG_ANCHOR = /\n\[[^\]\n]+\]\s*\(uuid:\s*([^)\s]+)\)/g;
function transcriptUuids(user: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    MSG_ANCHOR.lastIndex = 0;
    while ((m = MSG_ANCHOR.exec(user))) out.push(m[1]);
    return out;
}
function convUuid(user: string): string {
    const m = user.match(/Conversation:.*?\(uuid:\s*([^)\s]+)\)/);
    return m ? m[1] : "unknown";
}

// A rejected partition must be safe to train on: every anchor resolves, no
// chunk runs end-before-start, and no chunk overlaps its predecessor by more
// than the single shared boundary message the format permits. Gaps (uncovered
// messages) are legal and preserved from the source segmentation.
function partitionOk(chunks: Chunk[], pos: Map<string, number>): boolean {
    let prevEnd = -Infinity;
    for (const c of chunks) {
        const s = pos.get(c.start_message_uuid);
        const e = pos.get(c.end_message_uuid);
        if (s == null || e == null || e < s) return false;
        if (s < prevEnd) return false; // s === prevEnd is the legal shared boundary
        prevEnd = e;
    }
    return true;
}
function transcriptBlock(user: string): string {
    const i = user.indexOf("Here is the conversation:");
    return i >= 0 ? user.slice(i) : user;
}

const sig = (chunks: Chunk[]) => chunks.map((c) => `${c.start_message_uuid}>${c.end_message_uuid}`).join("|");
const safeId = (windowId: string) => windowId.replace(/[^A-Za-z0-9_-]/g, "_");

function fmtChunkList(chunks: Chunk[]): string {
    return chunks.map((c, i) => `  #${i + 1} [${c.start_message_uuid} … ${c.end_message_uuid}] "${c.label}"`).join("\n");
}

// ORPO conversational-preference record: prompt = system+user, completions are
// single-assistant-turn arrays. Extra columns (meta) kept separate in the JSONL.
function pair(rec: Rec, rejectedChunks: Chunk[], meta: object) {
    return {
        prompt: [rec.messages[0], rec.messages[1]],
        chosen: [{ role: "assistant", content: rec.messages[2].content }],
        rejected: [{ role: "assistant", content: JSON.stringify({ chunks: rejectedChunks }) }],
        meta,
    };
}

const JUDGE_RUBRIC = `You are an expert evaluator of conversation topic-segmentation ("chunking") for a knowledge-synthesis pipeline. Each chunk becomes ONE unit of information that updates ONE encyclopedia-style article, so the unit of a chunk is ONE COHERENT TOPIC.

You are given a conversation and a CANDIDATE segmentation with numbered boundaries (the seams between consecutive chunks). Your job is to classify each boundary.

CRITICAL granularity rule: a multi-stage process / plan is ONE topic, not many ("Step 1 / Step 2 / Step 3" are phases OF one task). A boundary that merely separates phases of one task is NOT a real topic shift. A boundary is a REAL topic shift only if the two sides are genuinely DISTINCT topics that belong in different articles.

For each boundary, decide real_shift:
  - true  → the two adjacent chunks are genuinely distinct topics; keeping them separate is correct.
  - false → the two adjacent chunks are the same topic / phases of one task; they should be MERGED (the segmentation over-split here).

Also give an overall_verdict for the whole candidate segmentation:
  - "excellent"  → coherent, well-placed boundaries, no over-splitting.
  - "acceptable" → minor issues but broadly correct.
  - "poor"       → significant over-splitting, fused distinct topics, or structural defects.`;

function judgePromptFor(transcript: string, chunks: Chunk[]): string {
    const boundaries = chunks.slice(0, -1).map((c, i) =>
        `  Boundary ${i + 1}: between chunk #${i + 1} "${c.label}" and chunk #${i + 2} "${chunks[i + 1].label}"`).join("\n");
    return `${JUDGE_RUBRIC}

=== CANDIDATE segmentation (${chunks.length} chunks) ===
${fmtChunkList(chunks)}

=== Boundaries to classify ===
${boundaries}

=== CONVERSATION ===
${transcript}

Output ONLY JSON, no prose:
{"overall_verdict":"excellent|acceptable|poor","boundaries":[{"index":1,"real_shift":true,"reason":"..."}]}
Include one entry per boundary above, in order.`;
}

async function loadSet(name: string): Promise<Rec[]> {
    const raw = await readFile(join(V3, name), "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

async function main() {
    const maxSplitPerWindow = Number(argVal("--max-split-per-window") ?? "2");
    await rm(OUT, { recursive: true, force: true });
    await mkdir(JUDGE_IN, { recursive: true });

    // Build the set of "ideal" signatures from the relabel cache.
    const ideal = JSON.parse(await readFile(join(V3, "ideal-labels.json"), "utf8")) as Record<string, { chunks: Chunk[] }>;
    const idealSigs = new Set<string>(Object.values(ideal).map((v) => sig(v.chunks)));

    const trusted: object[] = [];
    const judgeWindows: { id: string; windowId: string; mc: number; chunks: Chunk[]; recRef: { set: string; idx: number } }[] = [];
    const stats = {
        records: 0, ideal: 0, prod: 0,
        trustedSplit: 0, trustedMerge: 0, prodMergeWindows: 0, prodMergeCandidates: 0,
        skippedSingleChunkProd: 0, skippedMalformed: 0,
    };

    for (const set of ["train.jsonl", "valid.jsonl"]) {
        const recs = await loadSet(set);
        for (let idx = 0; idx < recs.length; idx++) {
            const rec = recs[idx];
            let chunks: Chunk[];
            try { chunks = JSON.parse(rec.messages[2].content).chunks ?? []; } catch { continue; }
            if (!chunks.length) continue;
            stats.records++;

            const user = rec.messages[1].content;
            const uuids = transcriptUuids(user);
            const pos = new Map(uuids.map((u, i) => [u, i]));
            const isIdeal = idealSigs.has(sig(chunks));
            isIdeal ? stats.ideal++ : stats.prod++;
            const startIdx = pos.get(chunks[0].start_message_uuid);
            const endIdx = pos.get(chunks[chunks.length - 1].end_message_uuid);
            const windowId = `${convUuid(user)}:${startIdx ?? "?"}-${endIdx ?? "?"}`;

            // ---- SPLIT negatives (over-split, soft) — IDEAL windows only ----
            if (isIdeal) {
                let made = 0;
                for (let ci = 0; ci < chunks.length && made < maxSplitPerWindow; ci++) {
                    const c = chunks[ci];
                    const s = pos.get(c.start_message_uuid), e = pos.get(c.end_message_uuid);
                    if (s == null || e == null || e - s < 2) continue; // need >=3 msgs for an interior boundary
                    const mid = s + Math.floor((e - s) / 2); // split AFTER message at `mid`
                    const left: Chunk = { start_message_uuid: uuids[s], end_message_uuid: uuids[mid], label: c.label };
                    const right: Chunk = { start_message_uuid: uuids[mid + 1], end_message_uuid: uuids[e], label: c.label };
                    const rejected = [...chunks.slice(0, ci), left, right, ...chunks.slice(ci + 1)];
                    if (!partitionOk(rejected, pos)) { stats.skippedMalformed++; continue; }
                    trusted.push(pair(rec, rejected, { windowId, source: "ideal", negative: "split_mid_topic", chunkIndex: ci }));
                    stats.trustedSplit++; made++;
                }
            }

            // ---- MERGE negatives (under-split, hard) ----
            if (chunks.length >= 2) {
                if (isIdeal) {
                    // every ideal boundary is a real shift -> trusted under-split negatives
                    for (let bi = 0; bi < chunks.length - 1; bi++) {
                        const merged: Chunk = {
                            start_message_uuid: chunks[bi].start_message_uuid,
                            end_message_uuid: chunks[bi + 1].end_message_uuid,
                            label: chunks[bi].label,
                        };
                        const rejected = [...chunks.slice(0, bi), merged, ...chunks.slice(bi + 2)];
                        if (!partitionOk(rejected, pos)) { stats.skippedMalformed++; continue; }
                        trusted.push(pair(rec, rejected, { windowId, source: "ideal", negative: "merge_adjacent", boundary: bi + 1 }));
                        stats.trustedMerge++;
                    }
                } else {
                    // prod multi-chunk window -> stage for judging (one call decides all boundaries)
                    const id = safeId(windowId) + `__${set.replace(".jsonl", "")}_${idx}`;
                    judgeWindows.push({ id, windowId, mc: uuids.length, chunks, recRef: { set, idx } });
                    await writeFile(join(JUDGE_IN, `${id}.txt`), judgePromptFor(transcriptBlock(user), chunks));
                    stats.prodMergeWindows++;
                    stats.prodMergeCandidates += chunks.length - 1;
                }
            } else if (!isIdeal) {
                stats.skippedSingleChunkProd++;
            }
        }
    }

    // Longest windows first — under-split failures concentrate in long conversations,
    // so if the run is capped these get judged first.
    judgeWindows.sort((a, b) => b.mc - a.mc);

    await writeFile(join(OUT, "trusted-pairs.jsonl"), trusted.map((p) => JSON.stringify(p)).join("\n") + "\n");
    await writeFile(join(OUT, "judge-windows.json"), JSON.stringify(judgeWindows, null, 2));
    await writeFile(join(OUT, "judge-windowIds.json"), JSON.stringify(judgeWindows.map((w) => ({ id: w.id, windowId: w.windowId, mc: w.mc })), null, 2));
    await writeFile(join(OUT, "prep-info.json"), JSON.stringify({ builtAt: new Date().toISOString(), maxSplitPerWindow, stats }, null, 2));

    console.error(`dpo-prep complete:
  records scanned     ${stats.records}   (ideal ${stats.ideal} / prod ${stats.prod})
  TRUSTED pairs       ${trusted.length}   (split ${stats.trustedSplit} / merge ${stats.trustedMerge})
  PROD windows to judge ${stats.prodMergeWindows}  (=> ${stats.prodMergeWindows} judge calls; ${stats.prodMergeCandidates} merge candidates inside)
  skipped 1-chunk prod  ${stats.skippedSingleChunkProd}
  wrote -> ${OUT}`);
}

main();
