/**
 * curate-chunk-v2.ts — curate a v2 chunk-stage training set from the DB graph.
 *
 * v1's set was an incidental grab-bag: 60% single-chunk because the maxChars cap
 * dropped the long multi-topic conversations (see docs/chunk-segmentation-v2.md).
 * v2 selects for GOOD splits using the signal already in the DB —
 *   chunks → chunk_buckets → buckets → synthesized_bucket_chunks → articles —
 * and balances single vs multi on purpose.
 *
 * Quality tiers (per conversation):
 *   A  multi-chunk AND chunks span >=2 distinct buckets   → genuine multi-topic split (core signal)
 *   B  single-chunk AND synthesized into an article       → clean single-topic ("when NOT to split")
 *   C  multi-chunk but all chunks in ONE bucket           → fine sub-splits within a topic (down-weighted)
 *   D  everything else (unsynth single / unassigned)      → excluded
 *
 * Emits the SAME messages-format as v1 (system+user+assistant), so it is a drop-in
 * for the existing trainer — this is the "whole-conv v2.0" intermediate. The
 * streaming reframe (v2.1) reuses the same selection. test = frozen benchmark,
 * always excluded; valid = held-out fraction; train = the rest.
 *
 *   bun run scripts/curate-chunk-v2.ts [--out DIR] [--max-chars N] [--single-frac F] [--c-cap R] [--valid-frac F] [--limit N]
 */
import { Database } from "bun:sqlite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DB_PATH, REPO_ROOT } from "./state-path.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";
import { CHUNK_PROMPT, formatConversation, type Conversation, type Message } from "./chunk-recent.js";

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
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
interface ConvRow { uuid: string; name: string; nchunks: number; nbuckets: number; nsynth: number; tier: Tier }
interface Built { uuid: string; tier: Tier; nchunks: number; chars: number; line: { messages: { role: string; content: string }[] } }

function tierOf(nchunks: number, nbuckets: number, nsynth: number): Tier {
    if (nchunks > 1 && nbuckets >= 2) return "A";
    if (nchunks === 1 && nsynth >= 1) return "B";
    if (nchunks > 1 && nbuckets < 2) return "C";
    return "D";
}

async function main() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "chunk-v2"))!;
    const maxChars = parseInt(arg("--max-chars", "32000")!, 10);
    const singleFrac = parseFloat(arg("--single-frac", "0.4")!);   // target share of single-chunk (B) examples
    const cCap = parseFloat(arg("--c-cap", "0.5")!);               // cap |C| at this × |A|
    const validFrac = parseFloat(arg("--valid-frac", "0.1")!);
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const db = new Database(DB_PATH, { readonly: true });
    const systemPrompt = await loadSystemPrompt();
    const chunkPrompt = CHUNK_PROMPT.replace("{{META_DOCS}}", await loadMetaPolicyBlock());

    // test holdout — the frozen benchmark, never trained on
    const testIds = new Set((JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "dataset", "chunk.json"), "utf8")) as any[]).map((c) => c.id));

    // per-conversation quality signal from the DB graph
    const rows = db.query(`
        SELECT c.conversation_uuid uuid,
               COUNT(DISTINCT c.id) nchunks,
               COUNT(DISTINCT cb.bucket_name) nbuckets,
               COUNT(DISTINCT sbc.chunk_id) nsynth
        FROM chunks c
        LEFT JOIN chunk_buckets cb ON cb.chunk_id = c.id
        LEFT JOIN synthesized_bucket_chunks sbc ON sbc.chunk_id = c.id
        GROUP BY c.conversation_uuid
    `).all() as Omit<ConvRow, "name" | "tier">[];

    const nameQ = db.query(`SELECT name FROM conversations WHERE uuid=?`);
    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid=? ORDER BY position`);
    const chunkQ = db.query(`SELECT start_message_uuid, end_message_uuid, label FROM chunks WHERE conversation_uuid=? ORDER BY id`);

    const tierCounts: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0 };
    const built: Record<Tier, Built[]> = { A: [], B: [], C: [], D: [] };
    let skippedHoldout = 0, skippedNoAssistant = 0, oversizedByTier: Record<Tier, number> = { A: 0, B: 0, C: 0, D: 0 };

    for (const r of rows) {
        if (testIds.has(r.uuid)) { skippedHoldout++; continue; }
        const tier = tierOf(r.nchunks, r.nbuckets, r.nsynth);
        tierCounts[tier]++;
        if (tier === "D") continue; // excluded entirely

        const messages = (msgQ.all(r.uuid) as Message[]).filter((m) => m.text != null);
        if (!messages.some((m) => m.sender === "assistant" && (m.text ?? "").trim())) { skippedNoAssistant++; continue; }
        const gold = chunkQ.all(r.uuid) as { start_message_uuid: string; end_message_uuid: string; label: string }[];
        const name = (nameQ.get(r.uuid) as { name: string } | null)?.name ?? "";

        const user = chunkPrompt + formatConversation({ uuid: r.uuid, name, messages } as Conversation);
        const assistant = JSON.stringify({ chunks: gold });
        const chars = user.length + assistant.length;
        if (chars > maxChars) { oversizedByTier[tier]++; continue; }   // tracked: this is the cost of staying whole-conv

        built[tier].push({ uuid: r.uuid, tier, nchunks: r.nchunks, chars, line: { messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: user },
            { role: "assistant", content: assistant },
        ] } });
    }

    // selection + balance: take all A; cap C at cCap×|A|; sample B to hit singleFrac
    shuffle(built.A); shuffle(built.B); shuffle(built.C);
    const selA = built.A;
    const selC = built.C.slice(0, Math.floor(selA.length * cCap));
    const multi = selA.length + selC.length;
    const targetSingles = Math.round((singleFrac / (1 - singleFrac)) * multi);
    const selB = built.B.slice(0, targetSingles);

    let selected = [...selA, ...selC, ...selB];
    shuffle(selected);
    // --best N: quality-ordered truncation (Tier A first, then balanced B, then C),
    // so a smaller set keeps the multi-topic teaching signal instead of random loss.
    const best = arg("--best") ? parseInt(arg("--best")!, 10) : null;
    if (best) {
        const rank: Record<Tier, number> = { A: 0, B: 1, C: 2, D: 3 };
        selected = [...selected].sort((x, y) => rank[x.tier] - rank[y.tier]).slice(0, best);
        shuffle(selected);
    } else if (limit) {
        selected = selected.slice(0, limit);
    }

    const validN = Math.min(Math.floor(selected.length * validFrac), 120);
    const valid = selected.slice(0, validN);
    const train = selected.slice(validN);

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "train.jsonl"), train.map((b) => JSON.stringify(b.line)).join("\n") + "\n");
    await writeFile(join(outDir, "valid.jsonl"), valid.map((b) => JSON.stringify(b.line)).join("\n") + "\n");

    const compo = (set: Built[]) => {
        const t: Record<string, number> = {}; let single = 0, multiC = 0, chunks = 0;
        for (const b of set) { t[b.tier] = (t[b.tier] ?? 0) + 1; (b.nchunks === 1 ? single++ : multiC++); chunks += b.nchunks; }
        return { byTier: t, single, multi: multiC, avgChunks: +(chunks / (set.length || 1)).toFixed(2) };
    };
    const info = {
        stage: "chunk", version: "v2.0-curated-wholeconv", builtAt: new Date().toISOString(),
        format: "messages (system+user+assistant), same as v1 — drop-in for the trainer",
        selection: "DB-graph quality tiers; balanced single:multi", systemPromptFrom: "sysprompt-v1.json",
        params: { maxChars, singleFrac, cCap, validFrac, limit },
        testHoldout: testIds.size,
        tierCountsAllConvs: tierCounts,
        oversizedExcludedByTier: oversizedByTier,
        available: { A: built.A.length, B: built.B.length, C: built.C.length },
        selectedCounts: { A: selA.length, B: selB.length, C: selC.length, total: selected.length },
        counts: { train: train.length, valid: valid.length, total: selected.length },
        composition: { train: compo(train), valid: compo(valid) },
    };
    await writeFile(join(outDir, "dataset-info.json"), JSON.stringify(info, null, 2));

    console.log(`v2 curated chunk set → ${outDir}`);
    console.log(`  tiers across all DB convs:`, tierCounts);
    console.log(`  available within ${maxChars} chars: A=${built.A.length} B=${built.B.length} C=${built.C.length}`);
    console.log(`  GOOD multi-topic (A) excluded by maxChars cap:`, oversizedByTier.A, `(this is the cost of whole-conv — streaming recovers it)`);
    console.log(`  selected: A=${selA.length} C=${selC.length} B=${selB.length}  → total ${selected.length}`);
    console.log(`  train=${train.length} valid=${valid.length}  | train avg chunks/conv=${info.composition.train.avgChunks} single/multi=${info.composition.train.single}/${info.composition.train.multi}`);
    console.log(`  test holdout (frozen benchmark): ${testIds.size} convs, excluded`);
}

main();
