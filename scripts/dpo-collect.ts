/**
 * dpo-collect — assemble the final centered ORPO/DPO preference set.
 *
 * GOAL (per design steer): do NOT teach "chunk more" or "chunk less". Teach the
 * CORRECT amount for THIS conversation. Each verified-correct segmentation is the
 * chosen; we bracket it with negatives on BOTH sides so it is a basin:
 *   - UNDER-split negatives  (merge adjacent, collapse-to-1)   → punish too few.
 *   - OVER-split negatives    (split a chunk, explode/multi-cut) → punish too many.
 * Crucially, LONG single/few-topic windows get OVER-split negatives, so the model
 * cannot generalize "long ⇒ split more" (the 8-chunks-on-a-long-article failure).
 *
 * Balance: slight over-split lean (~1.3:1 over:under) corpus-wide — the explosion
 * failure is the more visible one — enforced by a window-preserving trim. Both
 * one-step deviations AND extremes (collapse-to-1, explode-to-~2x, long multi-cut)
 * are included.
 *
 * Sources:
 *   - train.jsonl / valid.jsonl   (prompt + chosen + transcript; ideal vs prod via sig match)
 *   - ideal-labels.json           (Opus-verified windows → trusted chosen)
 *   - judge-windows.json + judge-out/<id>.json  (per-boundary truth for prod windows)
 *
 * Outputs (benchmark/finetune/chunk-v3/dpo/):
 *   orpo-train.jsonl / orpo-valid.jsonl              clean {prompt,chosen,rejected}
 *   orpo-{train,valid}.with-meta.jsonl               + provenance (dir/tag/source/windowId)
 *   dpo-info.json                                    composition stats
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const V3 = join(ROOT, "benchmark/finetune/chunk-v3");
const OUT = join(V3, "dpo");

type Chunk = { start_message_uuid: string; end_message_uuid: string; label: string };
type Rec = { messages: { role: string; content: string }[] };
type Neg = { dir: "over" | "under"; tag: string; rej: Chunk[] };
type Pair = { dir: "over" | "under"; route: "train" | "valid"; windowId: string; record: Rec; chosen: Chunk[]; neg: Neg; source: string };

const argNum = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };

const MSG_ANCHOR = /\n\[[^\]\n]+\]\s*\(uuid:\s*([^)\s]+)\)/g;
function transcriptUuids(user: string): string[] {
    const out: string[] = []; let m: RegExpExecArray | null; MSG_ANCHOR.lastIndex = 0;
    while ((m = MSG_ANCHOR.exec(user))) out.push(m[1]);
    return out;
}
function convUuid(user: string): string { const m = user.match(/Conversation:.*?\(uuid:\s*([^)\s]+)\)/); return m ? m[1] : "unknown"; }
const sig = (c: Chunk[]) => c.map((x) => `${x.start_message_uuid}>${x.end_message_uuid}`).join("|");

function partitionOk(chunks: Chunk[], pos: Map<string, number>): boolean {
    let prevEnd = -Infinity;
    for (const c of chunks) {
        const s = pos.get(c.start_message_uuid), e = pos.get(c.end_message_uuid);
        if (s == null || e == null || e < s || s < prevEnd) return false;
        prevEnd = e;
    }
    return true;
}
const spanOf = (c: Chunk, pos: Map<string, number>) => {
    const s = pos.get(c.start_message_uuid), e = pos.get(c.end_message_uuid);
    return s == null || e == null ? null : { s, e };
};
// Split chunk c into n contiguous pieces on message boundaries (each piece keeps c's label).
function cutInto(c: Chunk, n: number, pos: Map<string, number>, uuids: string[]): Chunk[] | null {
    const sp = spanOf(c, pos); if (!sp) return null;
    const { s, e } = sp, len = e - s + 1;
    if (n < 2 || n > len) return null;
    const out: Chunk[] = []; let prev = s;
    for (let j = 1; j <= n; j++) {
        const end = j === n ? e : s + Math.floor((j * len) / n) - 1;
        if (end < prev) return null;
        out.push({ start_message_uuid: uuids[prev], end_message_uuid: uuids[end], label: c.label });
        prev = end + 1;
    }
    return out;
}
const midSplit = (c: Chunk, pos: Map<string, number>, uuids: string[]) => cutInto(c, 2, pos, uuids);

// UNDER-split negatives: too few chunks. collapse-to-1 (extreme) then adjacent merges.
function genUnder(C: Chunk[]): Neg[] {
    const k = C.length, out: Neg[] = [];
    if (k < 2) return out;
    if (k >= 3) out.push({ dir: "under", tag: "collapse_all", rej: [{ start_message_uuid: C[0].start_message_uuid, end_message_uuid: C[k - 1].end_message_uuid, label: C[0].label }] });
    for (let bi = 0; bi < k - 1; bi++) {
        const merged: Chunk = { start_message_uuid: C[bi].start_message_uuid, end_message_uuid: C[bi + 1].end_message_uuid, label: C[bi].label };
        out.push({ dir: "under", tag: "merge_adjacent", rej: [...C.slice(0, bi), merged, ...C.slice(bi + 2)] });
    }
    return out;
}
// OVER-split negatives: too many chunks. explosion/multi-cut (extreme) then single splits.
function genOver(C: Chunk[], pos: Map<string, number>, uuids: string[]): Neg[] {
    const out: Neg[] = [];
    const splittable = C.map((c, i) => ({ i, sp: spanOf(c, pos) })).filter((x) => x.sp && x.sp.e - x.sp.s >= 2) as { i: number; sp: { s: number; e: number } }[];
    if (C.length === 1) {
        const sp = splittable[0]?.sp;
        if (sp) {
            const msgs = sp.e - sp.s + 1, n = Math.min(4, Math.floor(msgs / 2));
            if (n >= 2) { const p = cutInto(C[0], n, pos, uuids); if (p) out.push({ dir: "over", tag: `multicut_${n}`, rej: p }); }
            const two = cutInto(C[0], 2, pos, uuids); if (two) out.push({ dir: "over", tag: "split_one", rej: two });
        }
        return out;
    }
    if (splittable.length >= 2) {
        const rej: Chunk[] = [];
        for (let i = 0; i < C.length; i++) {
            const hit = splittable.find((x) => x.i === i);
            if (hit) { const two = midSplit(C[i], pos, uuids); rej.push(...(two ?? [C[i]])); } else rej.push(C[i]);
        }
        out.push({ dir: "over", tag: "explode", rej });
    }
    splittable.sort((a, b) => (b.sp.e - b.sp.s) - (a.sp.e - a.sp.s));
    for (const { i } of splittable) {
        const two = midSplit(C[i], pos, uuids);
        if (two) out.push({ dir: "over", tag: "split_one", rej: [...C.slice(0, i), ...two, ...C.slice(i + 1)] });
    }
    return out;
}

async function loadSet(name: string): Promise<Rec[]> {
    return (await readFile(join(V3, name), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Keep K items but visit windows round-robin first, so trimming never wipes a
// window's only pair before trimming windows that have several.
function windowPreservingKeep(pairs: Pair[], K: number): Pair[] {
    if (pairs.length <= K) return pairs;
    const byWin = new Map<string, Pair[]>();
    for (const p of pairs) { (byWin.get(p.windowId) ?? byWin.set(p.windowId, []).get(p.windowId)!).push(p); }
    const queues = [...byWin.values()];
    const kept: Pair[] = [];
    let round = 0;
    while (kept.length < K) {
        let progressed = false;
        for (const q of queues) { if (q[round]) { kept.push(q[round]); progressed = true; if (kept.length >= K) break; } }
        if (!progressed) break;
        round++;
    }
    return kept;
}

async function main() {
    const maxOver = argNum("--max-over", 3);
    const maxUnder = argNum("--max-under", 3);
    const lean = argNum("--lean", 1.3); // target over:under

    const train = await loadSet("train.jsonl");
    const valid = await loadSet("valid.jsonl");
    const sets: Record<string, Rec[]> = { "train.jsonl": train, "valid.jsonl": valid };

    const ideal = JSON.parse(await readFile(join(V3, "ideal-labels.json"), "utf8")) as Record<string, { chunks: Chunk[] }>;
    const idealSigs = new Set(Object.values(ideal).map((v) => sig(v.chunks)));

    const all: Pair[] = [];
    const stats: any = { idealWindows: 0, idealSingle: 0, prodJudged: 0, prodMissing: 0, prodCorrected: 0, prodOverSplitRealFailure: 0, droppedMalformed: 0, boundaryMismatch: 0 };

    const emit = (record: Rec, C: Chunk[], pos: Map<string, number>, route: "train" | "valid", windowId: string, source: string) => {
        const overs = genOver(C, pos, uuidsOf(record)).filter((n) => partitionOk(n.rej, pos)).slice(0, maxOver);
        const unders = genUnder(C).filter((n) => partitionOk(n.rej, pos)).slice(0, maxUnder);
        for (const neg of [...overs, ...unders]) all.push({ dir: neg.dir, route, windowId, record, chosen: C, neg, source });
        return { o: overs.length, u: unders.length };
    };
    const uuidCache = new WeakMap<Rec, string[]>();
    function uuidsOf(rec: Rec): string[] { let u = uuidCache.get(rec); if (!u) { u = transcriptUuids(rec.messages[1].content); uuidCache.set(rec, u); } return u; }

    // ---- ideal windows (trusted chosen) ----
    for (const setName of ["train.jsonl", "valid.jsonl"] as const) {
        const route = setName === "train.jsonl" ? "train" : "valid";
        for (const rec of sets[setName]) {
            let C: Chunk[]; try { C = JSON.parse(rec.messages[2].content).chunks ?? []; } catch { continue; }
            if (!C.length || !idealSigs.has(sig(C))) continue;
            const u = uuidsOf(rec); const pos = new Map(u.map((x, i) => [x, i]));
            const s0 = pos.get(C[0].start_message_uuid), e0 = pos.get(C[C.length - 1].end_message_uuid);
            const windowId = `${convUuid(rec.messages[1].content)}:${s0 ?? "?"}-${e0 ?? "?"}`;
            emit(rec, C, pos, route, windowId, "ideal");
            stats.idealWindows++; if (C.length === 1) stats.idealSingle++;
        }
    }

    // ---- prod windows (corrected chosen from judge output) ----
    const windows = JSON.parse(await readFile(join(OUT, "judge-windows.json"), "utf8")) as
        { id: string; windowId: string; mc: number; chunks: Chunk[]; recRef: { set: string; idx: number } }[];
    const outFiles = new Set((await readdir(join(OUT, "judge-out")).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));

    for (const w of windows) {
        if (!outFiles.has(w.id)) { stats.prodMissing++; continue; }
        let verdict: any; try { verdict = JSON.parse(await readFile(join(OUT, "judge-out", `${w.id}.json`), "utf8")); } catch { stats.prodMissing++; continue; }
        const flags: { index: number; real_shift: boolean }[] = Array.isArray(verdict?.boundaries) ? verdict.boundaries : [];
        const nB = w.chunks.length - 1;
        if (flags.length !== nB) stats.boundaryMismatch++;
        const real: boolean[] = [];
        for (let i = 1; i <= nB; i++) { const f = flags.find((b) => b.index === i); real.push(f ? f.real_shift !== false : true); }

        const rec = sets[w.recRef.set][w.recRef.idx];
        const route = w.recRef.set === "train.jsonl" ? "train" : "valid";
        const u = uuidsOf(rec); const pos = new Map(u.map((x, i) => [x, i]));

        // CORRECT: collapse runs separated only by non-shift boundaries.
        const corrected: Chunk[] = []; let cur = { ...w.chunks[0] };
        for (let i = 1; i < w.chunks.length; i++) {
            if (real[i - 1]) { corrected.push(cur); cur = { ...w.chunks[i] }; }
            else cur = { start_message_uuid: cur.start_message_uuid, end_message_uuid: w.chunks[i].end_message_uuid, label: cur.label };
        }
        corrected.push(cur);
        stats.prodJudged++;
        const changed = corrected.length !== w.chunks.length;
        if (changed) stats.prodCorrected++;
        if (!partitionOk(corrected, pos)) { stats.droppedMalformed++; continue; }

        emit(rec, corrected, pos, route, w.windowId, "prod-judged");
        // real-failure-shaped over-split negative: cleaned chosen vs the original prod over-split.
        if (changed && partitionOk(w.chunks, pos)) {
            all.push({ dir: "over", route, windowId: w.windowId, record: rec, chosen: corrected, neg: { dir: "over", tag: "over_split_prod", rej: w.chunks }, source: "prod-judged" });
            stats.prodOverSplitRealFailure++;
        }
    }

    // ---- enforce slight over-split lean (~lean:1) with window-preserving trim ----
    let over = all.filter((p) => p.dir === "over");
    let under = all.filter((p) => p.dir === "under");
    const before = { over: over.length, under: under.length };
    if (over.length > lean * under.length) over = windowPreservingKeep(over, Math.round(lean * under.length));
    else if (under.length > over.length / lean) under = windowPreservingKeep(under, Math.round(over.length / lean));
    const final = [...over, ...under];

    // ---- write ----
    const toRecord = (p: Pair) => ({
        prompt: [p.record.messages[0], p.record.messages[1]],
        chosen: [{ role: "assistant", content: JSON.stringify({ chunks: p.chosen }) }],
        rejected: [{ role: "assistant", content: JSON.stringify({ chunks: p.neg.rej }) }],
    });
    for (const route of ["train", "valid"] as const) {
        const ps = final.filter((p) => p.route === route);
        const clean = ps.map((p) => JSON.stringify(toRecord(p))).join("\n");
        const meta = ps.map((p) => JSON.stringify({ ...toRecord(p), meta: { dir: p.dir, tag: p.neg.tag, source: p.source, windowId: p.windowId, chosenCount: p.chosen.length, rejectedCount: p.neg.rej.length } })).join("\n");
        await writeFile(join(OUT, `orpo-${route}.jsonl`), clean + (clean ? "\n" : ""));
        await writeFile(join(OUT, `orpo-${route}.with-meta.jsonl`), meta + (meta ? "\n" : ""));
    }

    const tally = (ps: Pair[]) => { const m: Record<string, number> = {}; for (const p of ps) m[p.neg.tag] = (m[p.neg.tag] ?? 0) + 1; return m; };
    const O = final.filter((p) => p.dir === "over").length, U = final.filter((p) => p.dir === "under").length;
    const info = {
        builtAt: new Date().toISOString(), maxOver, maxUnder, lean,
        total: final.length,
        train: final.filter((p) => p.route === "train").length, valid: final.filter((p) => p.route === "valid").length,
        over: O, under: U, ratio: Number((O / Math.max(1, U)).toFixed(3)),
        beforeTrim: before, byTag: tally(final), stats,
    };
    await writeFile(join(OUT, "dpo-info.json"), JSON.stringify(info, null, 2));

    console.error(`dpo-collect complete:
  TOTAL pairs  ${final.length}   (train ${info.train} / valid ${info.valid})
  over-split   ${O}   under-split ${U}   ratio ${info.ratio}:1   (pre-trim ${before.over}/${before.under})
  ideal windows ${stats.idealWindows} (single-chunk ${stats.idealSingle})  |  prod judged ${stats.prodJudged}, corrected ${stats.prodCorrected}, missing ${stats.prodMissing}
  tags: ${JSON.stringify(info.byTag)}
  wrote -> ${OUT}/orpo-{train,valid}.jsonl`);
}

main();
