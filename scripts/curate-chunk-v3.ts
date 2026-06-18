/**
 * curate-chunk-v3.ts — windowed, curriculum-curated chunk-stage training set.
 *
 * v2 (curate-chunk-v2.ts) was a curated whole-conv set that EXCLUDED every
 * conversation whose prompt exceeded the char cap — exactly the long multi-topic
 * threads. The eval (judge-rubric-gemma-e4b-chunk-v2) showed two consequences:
 *   1. ONE genuine failure: long-span partition collapse (nested/overlapping/
 *      gapped chunks) on the only two long convs in the benchmark (48, 74 msgs),
 *      because the model saw ZERO long examples in training.
 *   2. The dominant ERROR (over-splitting / sub-topic splitting, flagged on ~13/25
 *      convs incl. short ones) — taught by tier-C prod gold (multi-chunk inside a
 *      single bucket = sub-splits) and by intra-topic over-splits in prod labels.
 *
 * v3 attacks both, deterministically:
 *   WINDOWING   — long convs are no longer dropped. We pack their prod chunks into
 *                 windows that fit the budget, CUTTING ONLY ON CHUNK BOUNDARIES
 *                 (never mid-topic). Each window is a normal training example whose
 *                 gold cleanly tiles that window → teaches valid long-conv tiling.
 *   CURRICULUM  — drop tier C (the sub-split signal); down-sample easy shorts
 *                 (≤--easy-msgs single-chunk, train-loss≈0); keep long single-topic
 *                 convs whole; over-represent multi-topic (tier A). The point is a
 *                 HARDER distribution than v2 so train/val loss starts high and
 *                 actually has signal to learn (v2 memorized 450 easy examples).
 *
 * LABEL SOURCE is pluggable per window. By default the gold is the production DB
 * chunks (what the running pipeline wrote). If an ideal-label cache exists
 * (--ideal-cache, keyed by windowId "uuid:startIdx-endIdx"), its curated chunks
 * REPLACE the prod gold for that window — this is how the "merge / de-sub-topic"
 * relabel lever folds in WITHOUT rewriting the pipeline. `--emit-manifest` writes
 * the per-window payloads a strong model (Opus sub-agent) scores into that cache.
 *
 * Emits the SAME messages-format (system+user+assistant) as v1/v2 — drop-in for
 * the trainer and the existing inference path; only the inputs are windowed.
 *
 *   bun run scripts/curate-chunk-v3.ts [--out DIR] [--budget-chars N] [--hard-max N]
 *       [--easy-msgs N] [--easy-keep F] [--c-keep F] [--single-frac F]
 *       [--valid-frac F] [--ideal-cache FILE] [--emit-manifest] [--limit N]
 */
import { Database } from "bun:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DB_PATH, REPO_ROOT } from "./state-path.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";
import { CHUNK_PROMPT, formatConversation, type Conversation, type Message } from "./chunk-recent.js";

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
}
function hasFlag(name: string): boolean {
    return process.argv.includes(name);
}
function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a;
}
async function loadSystemPrompt(): Promise<string> {
    const cfg = JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "configs", "sysprompt-v1.json"), "utf8"));
    const sp = cfg.stages?.chunk?.systemPrompt;
    if (!sp) throw new Error("no stages.chunk.systemPrompt");
    return sp;
}

type Tier = "A" | "B" | "C" | "D";
function tierOf(nchunks: number, nbuckets: number, nsynth: number): Tier {
    if (nchunks > 1 && nbuckets >= 2) return "A";
    if (nchunks === 1 && nsynth >= 1) return "B";
    if (nchunks > 1 && nbuckets < 2) return "C";
    return "D";
}

interface ChunkRow { start_message_uuid: string; end_message_uuid: string; label: string }
interface PlacedChunk { row: ChunkRow; s: number; e: number }
/** A window is a contiguous run of whole chunks over a message sub-range. */
interface Window {
    convUuid: string; name: string; tier: Tier;
    windowId: string;            // "uuid:startIdx-endIdx"
    startIdx: number; endIdx: number;
    msgs: Message[];             // the window's messages (the model's input)
    chunks: ChunkRow[];          // gold chunks for this window (anchors live in msgs)
    isWindowed: boolean;         // true when the parent conv was split into >1 window
    nchunks: number; nmsgs: number; chars: number;
}

/**
 * Structural health of a window's gold against its OWN messages. Mirrors the
 * eval harness taxonomy. overlap>1, nested, and unresolved are hard defects —
 * teaching them is exactly the v2 long-conv collapse we are fixing. Interior
 * gaps are tolerated (production legitimately omits "ignore"-policy spans).
 */
function windowDefects(w: Window): { hard: boolean; overlap: boolean; nested: boolean; unresolved: boolean; gapMsgs: number } {
    const pos = new Map<string, number>();
    w.msgs.forEach((m, i) => pos.set(m.uuid, i));
    const ranges: [number, number][] = [];
    let unresolved = false;
    for (const c of w.chunks) {
        const s = pos.get(c.start_message_uuid), e = pos.get(c.end_message_uuid);
        if (s === undefined || e === undefined) { unresolved = true; continue; }
        ranges.push([Math.min(s, e), Math.max(s, e)]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let overlap = false, nested = false;
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
        const [as, ae] = ranges[i]!, [bs, be] = ranges[j]!;
        const o = Math.min(ae, be) - Math.max(as, bs) + 1;
        if (o > 1) overlap = true;
        if ((bs >= as && be <= ae) || (as >= bs && ae <= be)) nested = true;
    }
    const covered = new Set<number>();
    for (const [s, e] of ranges) for (let k = s; k <= e; k++) covered.add(k);
    let gapMsgs = 0;
    for (let k = 0; k < w.msgs.length; k++) if (!covered.has(k)) gapMsgs++;
    return { hard: overlap || nested || unresolved, overlap, nested, unresolved, gapMsgs };
}

/** Resolve each chunk's anchors to message indices; drop chunks we can't place. */
function placeChunks(rows: ChunkRow[], positions: Map<string, number>): PlacedChunk[] {
    const placed: PlacedChunk[] = [];
    for (const row of rows) {
        const s = positions.get(row.start_message_uuid);
        const e = positions.get(row.end_message_uuid);
        if (s === undefined || e === undefined) continue;          // unresolvable anchor → skip
        placed.push({ row, s: Math.min(s, e), e: Math.max(s, e) });
    }
    placed.sort((a, b) => a.s - b.s || a.e - b.e);
    return placed;
}

/**
 * Greedily pack chunks into windows on chunk boundaries so each window's
 * (prompt + transcript + gold) stays within budget. A single chunk larger than
 * budget becomes its own window if it fits hardMax, else the conv is dropped.
 */
function buildWindows(
    conv: { uuid: string; name: string; tier: Tier }, messages: Message[], placed: PlacedChunk[],
    fixedOverhead: number, budget: number, hardMax: number,
): { windows: Window[]; dropped: { reason: string } | null } {
    if (placed.length === 0) return { windows: [], dropped: { reason: "no placeable chunks" } };

    const sizeOf = (group: PlacedChunk[]): { msgs: Message[]; chars: number } => {
        const startIdx = group[0]!.s, endIdx = group[group.length - 1]!.e;
        const msgs = messages.slice(startIdx, endIdx + 1);
        const user = formatConversation({ uuid: conv.uuid, name: conv.name, messages: msgs } as Conversation);
        const assistant = JSON.stringify({ chunks: group.map((g) => g.row) });
        return { msgs, chars: fixedOverhead + user.length + assistant.length };
    };

    // Whole conv in one window when it fits — the common case (shorts, mediums,
    // long single-topic convs we want kept whole).
    const whole = sizeOf(placed);
    const mkWindow = (group: PlacedChunk[], isWindowed: boolean): Window => {
        const startIdx = group[0]!.s, endIdx = group[group.length - 1]!.e;
        const { msgs, chars } = sizeOf(group);
        return {
            convUuid: conv.uuid, name: conv.name, tier: conv.tier,
            windowId: `${conv.uuid}:${startIdx}-${endIdx}`, startIdx, endIdx,
            msgs, chunks: group.map((g) => g.row), isWindowed,
            nchunks: group.length, nmsgs: msgs.length, chars,
        };
    };
    if (whole.chars <= budget) return { windows: [mkWindow(placed, false)], dropped: null };

    // Otherwise pack consecutive chunks; cut only on a chunk boundary.
    const windows: Window[] = [];
    let cur: PlacedChunk[] = [];
    for (const ch of placed) {
        if (cur.length === 0) { cur.push(ch); continue; }
        const tentative = [...cur, ch];
        if (sizeOf(tentative).chars > budget) { windows.push(mkWindow(cur, true)); cur = [ch]; }
        else cur.push(ch);
    }
    if (cur.length) windows.push(mkWindow(cur, true));

    // A lone chunk that still blows the hard cap is a pathological mega-span; drop it.
    const kept = windows.filter((w) => w.chars <= hardMax);
    const droppedOversize = windows.length - kept.length;
    if (kept.length === 0) return { windows: [], dropped: { reason: "all windows over hardMax" } };
    // re-tag isWindowed: if only one window survived it's effectively whole
    if (kept.length === 1) kept[0]!.isWindowed = whole.chars > budget;
    return { windows: kept, dropped: droppedOversize ? { reason: `${droppedOversize} window(s) over hardMax dropped` } : null };
}

async function main() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "chunk-v3"))!;
    const budget = parseInt(arg("--budget-chars", "30000")!, 10);       // user+assistant+overhead ceiling per window
    const hardMax = parseInt(arg("--hard-max", "44000")!, 10);          // absolute drop ceiling for a lone mega-chunk
    const easyMsgs = parseInt(arg("--easy-msgs", "8")!, 10);            // ≤ this msgs AND single-chunk = "easy short"
    const easyKeep = parseFloat(arg("--easy-keep", "0.25")!);          // fraction of easy shorts to retain
    const cKeep = parseFloat(arg("--c-keep", "0")!);                   // fraction of tier-C windows to retain (0 = drop)
    const singleFrac = parseFloat(arg("--single-frac", "0.35")!);      // target share of single-chunk windows
    const validFrac = parseFloat(arg("--valid-frac", "0.1")!);
    const idealCachePath = arg("--ideal-cache", join(outDir, "ideal-labels.json"))!;
    const emitManifest = hasFlag("--emit-manifest");
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const db = new Database(DB_PATH, { readonly: true });
    const systemPrompt = await loadSystemPrompt();
    const chunkPrompt = CHUNK_PROMPT.replace("{{META_DOCS}}", await loadMetaPolicyBlock());
    // formatConversation adds a small per-conv header + per-message framing; the
    // prompt + system are the fixed cost shared by every window.
    const fixedOverhead = systemPrompt.length + chunkPrompt.length;

    // ideal-label cache (per-window curated gold). Optional.
    let idealCache: Record<string, { chunks: ChunkRow[] }> = {};
    if (existsSync(idealCachePath)) {
        try { idealCache = JSON.parse(await readFile(idealCachePath, "utf8")); } catch { idealCache = {}; }
    }

    const testIds = new Set((JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "dataset", "chunk.json"), "utf8")) as any[]).map((c) => c.id));

    const rows = db.query(`
        SELECT c.conversation_uuid uuid,
               COUNT(DISTINCT c.id) nchunks,
               COUNT(DISTINCT cb.bucket_name) nbuckets,
               COUNT(DISTINCT sbc.chunk_id) nsynth
        FROM chunks c
        LEFT JOIN chunk_buckets cb ON cb.chunk_id = c.id
        LEFT JOIN synthesized_bucket_chunks sbc ON sbc.chunk_id = c.id
        GROUP BY c.conversation_uuid
    `).all() as { uuid: string; nchunks: number; nbuckets: number; nsynth: number }[];

    const nameQ = db.query(`SELECT name FROM conversations WHERE uuid=?`);
    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid=? ORDER BY position`);
    const chunkQ = db.query(`SELECT start_message_uuid, end_message_uuid, label FROM chunks WHERE conversation_uuid=? ORDER BY id`);

    const allWindows: Window[] = [];
    const stats = {
        convs: 0, skippedHoldout: 0, skippedNoAssistant: 0, skippedTierD: 0,
        droppedConvs: 0, windowedConvs: 0, droppedReasons: [] as string[],
        idealHits: 0,
    };
    const tierConvCounts: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0 };

    for (const r of rows) {
        if (testIds.has(r.uuid)) { stats.skippedHoldout++; continue; }
        const tier = tierOf(r.nchunks, r.nbuckets, r.nsynth);
        tierConvCounts[tier]++;
        if (tier === "D") { stats.skippedTierD++; continue; }

        const messages = (msgQ.all(r.uuid) as Message[]).filter((m) => m.text && m.text.trim());
        if (!messages.some((m) => m.sender === "assistant" && (m.text ?? "").trim())) { stats.skippedNoAssistant++; continue; }
        const name = (nameQ.get(r.uuid) as { name: string } | null)?.name ?? "";
        const positions = new Map<string, number>();
        messages.forEach((m, i) => positions.set(m.uuid, i));
        const placed = placeChunks(chunkQ.all(r.uuid) as ChunkRow[], positions);

        const { windows, dropped } = buildWindows({ uuid: r.uuid, name, tier }, messages, placed, fixedOverhead, budget, hardMax);
        if (dropped && windows.length === 0) { stats.droppedConvs++; stats.droppedReasons.push(`${r.uuid.slice(0, 8)}: ${dropped.reason}`); continue; }
        if (windows.length > 1) stats.windowedConvs++;
        stats.convs++;

        // apply ideal cache per window
        for (const w of windows) {
            const ideal = idealCache[w.windowId];
            if (ideal?.chunks?.length) {
                w.chunks = ideal.chunks;
                w.nchunks = ideal.chunks.length;
                (w as any).labelSource = "ideal";
                stats.idealHits++;
            } else {
                (w as any).labelSource = "prod";
            }
        }
        allWindows.push(...windows);
    }

    // -------- structural defect filter --------
    // Drop windows whose gold has overlap>1 / nested / unresolved anchors (prod-gold
    // quality noise) — teaching those re-creates the v2 long-conv tiling collapse.
    const defectStats = { hard: 0, overlap: 0, nested: 0, unresolved: 0, gapWindows: 0 };
    const clean = allWindows.filter((w) => {
        const d = windowDefects(w);
        if (d.gapMsgs > 0) defectStats.gapWindows++;
        if (d.hard) { defectStats.hard++; if (d.overlap) defectStats.overlap++; if (d.nested) defectStats.nested++; if (d.unresolved) defectStats.unresolved++; return false; }
        return true;
    });

    // -------- curriculum selection --------
    // The teaching signal is whether a window contains a BOUNDARY:
    //   multi-chunk windows (≥2 chunks)  → keep ALL (the scarce, valuable split signal).
    //   single-chunk windows             → the "don't split" counter-signal, controlled:
    //       - windowed singletons (1 chunk carved from a long conv by char-packing) are
    //         DROPPED — they teach whole-span envelopes (the v1 single-chunk collapse).
    //       - easy shorts (≤easyMsgs, whole-conv) are down-sampled to easyKeep.
    //   tier C (multi-chunk, single-bucket = sub-splits) → dropped (cKeep, the over-split signal).
    // A windowed single-chunk window is normally a char-packing ENVELOPE artifact
    // (drop — it teaches whole-span envelopes). EXCEPTION: if it came from the
    // relabel (a former multi-chunk window the labeler deliberately MERGED to one
    // topic, e.g. a long plan → 1 chunk), it is a HARD "don't-split" example — the
    // strongest not-split signal there is — so keep it.
    const windowedSingleton = (w: Window) => w.isWindowed && w.nchunks === 1 && (w as any).labelSource !== "ideal";
    const easySingle = (w: Window) => !w.isWindowed && w.nchunks === 1 && w.nmsgs <= easyMsgs;

    const droppedWindowedSingletons = clean.filter(windowedSingleton).length;
    let pool = clean.filter((w) => !windowedSingleton(w));
    const tierCWin = pool.filter((w) => w.tier === "C");
    pool = pool.filter((w) => w.tier !== "C").concat(shuffle(tierCWin).slice(0, Math.round(tierCWin.length * cKeep)));

    const easy = shuffle(pool.filter(easySingle));
    const selEasy = easy.slice(0, Math.round(easy.length * easyKeep));
    pool = [...pool.filter((w) => !easySingle(w)), ...selEasy];

    // balance single:multi toward singleFrac — trim singles only; never drop multi.
    const multi = pool.filter((w) => w.nchunks > 1);
    const singles = shuffle(pool.filter((w) => w.nchunks === 1));
    const targetSingles = Math.round((singleFrac / (1 - singleFrac)) * multi.length);
    let selected = shuffle([...multi, ...singles.slice(0, Math.min(singles.length, targetSingles))]);

    if (limit) selected = selected.slice(0, limit);

    // -------- emit relabel manifest (for the merge lever) and exit ----------
    // Every relabel target is an ACTUAL training window: the multi-chunk windows
    // (where over-split / collapse lives), hardest-first so a top-N relabel within
    // budget spends on the highest-leverage examples. A sub-agent scores each
    // .indexedTranscript per the chunking rubric → ideal-labels.json (keyed by
    // windowId) → re-run curate to fold the curated gold in.
    if (emitManifest) {
        await mkdir(outDir, { recursive: true });
        const manifest = selected
            .filter((w) => w.nchunks > 1)
            .sort((a, b) => b.nmsgs - a.nmsgs)
            .map((w) => ({
                windowId: w.windowId, convUuid: w.convUuid, name: w.name, tier: w.tier,
                isWindowed: w.isWindowed, nmsgs: w.nmsgs, nProdChunks: w.nchunks, prodChunks: w.chunks,
                indexedTranscript: w.msgs.map((m, i) => `[#${i} ${m.sender}] (uuid: ${m.uuid}) ${m.text.length > 700 ? m.text.slice(0, 700) + " …[truncated]" : m.text}`).join("\n"),
            }));
        const mpath = join(outDir, "relabel-manifest.json");
        await writeFile(mpath, JSON.stringify({ builtAt: new Date().toISOString(), budget, count: manifest.length, windows: manifest }, null, 2));
        console.log(`relabel manifest → ${mpath}  (${manifest.length} multi-chunk training windows, hardest first)`);
        return;
    }

    const validN = Math.min(Math.floor(selected.length * validFrac), 120);
    const valid = selected.slice(0, validN);
    const train = selected.slice(validN);

    const toLine = (w: Window) => ({
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: chunkPrompt + formatConversation({ uuid: w.convUuid, name: w.name, messages: w.msgs } as Conversation) },
            { role: "assistant", content: JSON.stringify({ chunks: w.chunks }) },
        ],
    });

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "train.jsonl"), train.map((w) => JSON.stringify(toLine(w))).join("\n") + "\n");
    await writeFile(join(outDir, "valid.jsonl"), valid.map((w) => JSON.stringify(toLine(w))).join("\n") + "\n");

    // composition / difficulty report
    const band = (n: number) => n <= 8 ? "<=8" : n <= 12 ? "9-12" : n <= 20 ? "13-20" : n <= 28 ? "21-28" : n <= 50 ? "29-50" : ">50";
    const compo = (set: Window[]) => {
        const t: Record<string, number> = {}, bands: Record<string, number> = {}, src: Record<string, number> = {};
        let single = 0, multiC = 0, windowed = 0, chunks = 0;
        for (const w of set) {
            t[w.tier] = (t[w.tier] ?? 0) + 1;
            bands[band(w.nmsgs)] = (bands[band(w.nmsgs)] ?? 0) + 1;
            src[(w as any).labelSource] = (src[(w as any).labelSource] ?? 0) + 1;
            (w.nchunks === 1 ? single++ : multiC++); if (w.isWindowed) windowed++; chunks += w.nchunks;
        }
        return { byTier: t, byMsgBand: bands, labelSource: src, single, multi: multiC, windowed, avgChunks: +(chunks / (set.length || 1)).toFixed(2) };
    };
    const info = {
        stage: "chunk", version: "v3.0-windowed-curriculum", builtAt: new Date().toISOString(),
        format: "messages (system+user+assistant), windowed on chunk boundaries — drop-in for the trainer",
        params: { budget, hardMax, easyMsgs, easyKeep, cKeep, singleFrac, validFrac, idealCache: existsSync(idealCachePath) ? idealCachePath : null, limit },
        testHoldout: testIds.size,
        tierConvCounts,
        windowing: { convsKept: stats.convs, convsWindowed: stats.windowedConvs, convsDropped: stats.droppedConvs, totalWindows: allWindows.length },
        defects: { ...defectStats, cleanWindows: clean.length },
        labels: { idealWindows: stats.idealHits, source: stats.idealHits ? "prod + ideal cache" : "prod DB chunks" },
        pool: { droppedWindowedSingletons, easyShorts: easy.length, easyKept: selEasy.length, tierCWindows: tierCWin.length, tierCKeep: cKeep, multiKept: multi.length },
        counts: { train: train.length, valid: valid.length, total: selected.length },
        composition: { train: compo(train), valid: compo(valid) },
        droppedSample: stats.droppedReasons.slice(0, 20),
        skipped: { holdout: stats.skippedHoldout, noAssistant: stats.skippedNoAssistant, tierD: stats.skippedTierD },
    };
    await writeFile(join(outDir, "dataset-info.json"), JSON.stringify(info, null, 2));

    console.log(`v3 windowed/curriculum chunk set → ${outDir}`);
    console.log(`  tier convs:`, tierConvCounts);
    console.log(`  windowing: kept ${stats.convs} convs → ${allWindows.length} windows (${stats.windowedConvs} convs split, ${stats.droppedConvs} dropped)`);
    console.log(`  defects filtered: ${defectStats.hard} hard (${defectStats.overlap} overlap, ${defectStats.nested} nested, ${defectStats.unresolved} unresolved) → ${clean.length} clean`);
    console.log(`  curriculum: dropped ${droppedWindowedSingletons} windowed-singletons, easy shorts ${easy.length}→${selEasy.length} (keep ${easyKeep}), tierC ${tierCWin.length} (keep ${cKeep}), multi ${multi.length} kept`);
    console.log(`  labels: ${stats.idealHits} ideal / ${allWindows.length - stats.idealHits} prod`);
    console.log(`  train=${train.length} valid=${valid.length}  | train single/multi=${info.composition.train.single}/${info.composition.train.multi} avgChunks=${info.composition.train.avgChunks}`);
    console.log(`  train msg-bands:`, info.composition.train.byMsgBand);
}

main();
