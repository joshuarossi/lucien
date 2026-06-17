/**
 * make-finetune-data.ts — emit LoRA training data (JSONL) from the gold pipeline output.
 *
 * The existing DB was produced by the old Claude-Opus pipeline, so its chunks /
 * assignments / articles are high-quality teacher outputs. This script turns that
 * gold into `messages`-format JSONL (system + user + assistant) for fine-tuning the
 * local model, using the EXACT production prompts so training matches inference.
 *
 *   bun run scripts/make-finetune-data.ts --stage chunk [--out <dir>] [--max-chars N] [--valid N] [--limit N]
 *
 * Output dir gets train.jsonl (+ valid.jsonl) and dataset-info.json (provenance).
 * The frozen benchmark cases are ALWAYS excluded — training on them would
 * invalidate the benchmark.
 *
 * Format: {"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}
 * mask_prompt is on in the trainer, so loss lands only on the assistant JSON.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DB_PATH, REPO_ROOT } from "./state-path.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";
import { bucketToFilename, bucketToStem } from "./bucket-names.js";
import { CHUNK_PROMPT, formatConversation, type Conversation, type Message } from "./chunk-recent.js";
import { buildPrompt as buildAssignPrompt, type Bucket, type ChunkRow } from "./cluster-assign-recent.js";
import { SYNTHESIS_PROMPT_BOOTSTRAP, formatChunks, type Chunk as SynthChunk } from "./synthesize.js";
import { buildEditorialPrompt } from "./wikify.js";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");
const BATCH_SIZE = 25;

function gitShow(ref: string, cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
        const p = spawn("git", ["show", ref], { cwd, stdio: ["ignore", "pipe", "ignore"] });
        let o = "";
        p.stdout.on("data", (d) => (o += d.toString()));
        p.on("exit", (code) => resolve(code === 0 ? o : null));
        p.on("error", () => resolve(null));
    });
}
function gitLines(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve) => {
        const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
        let o = "";
        p.stdout.on("data", (d) => (o += d.toString()));
        p.on("exit", () => resolve(o));
        p.on("error", () => resolve(""));
    });
}
function otherArticlesFrom(taxonomy: Bucket[], exclude: string): string {
    return taxonomy.filter((b) => b.name !== exclude).map((b) => `- ${bucketToStem(b.name)}: ${b.description}`).join("\n");
}

interface Line { messages: { role: "system" | "user" | "assistant"; content: string }[] }

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
}

async function loadSystemPrompt(stage: string): Promise<string> {
    const cfg = JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "configs", "sysprompt-v1.json"), "utf8"));
    const sp = cfg.stages?.[stage]?.systemPrompt;
    if (!sp) throw new Error(`no systemPrompt for stage "${stage}" in sysprompt-v1.json`);
    return sp;
}

async function benchmarkHoldout(file: string, key: (c: any) => string): Promise<Set<string>> {
    try {
        const data = JSON.parse(await readFile(join(REPO_ROOT, "benchmark", "dataset", file), "utf8"));
        const arr = Array.isArray(data) ? data : data.cases;
        return new Set(arr.map(key));
    } catch { return new Set(); }
}

/** Normalize a bucket name or article stem to one comparable key (spaces↔underscores, case). */
function normName(s: string): string { return s.toLowerCase().replace(/[_\s]+/g, "_"); }

/**
 * The unified benchmark quarantine. A bucket and its article are the SAME entity,
 * so synth and wikify benchmark cases must be cross-excluded from BOTH stages —
 * otherwise a wikify benchmark article leaks in as a synth training target (and
 * vice versa). Conversations and labels are quarantined too.
 */
interface Quarantine { conv: Set<string>; bucketNorm: Set<string>; label: Set<string> }
async function loadQuarantine(): Promise<Quarantine> {
    const conv = await benchmarkHoldout("chunk.json", (c) => c.id);
    const label = await benchmarkHoldout("cluster.json", (c) => c.label);
    const synthB = await benchmarkHoldout("synthesize.json", (c) => c.id);
    const wikS = await benchmarkHoldout("wikify.json", (c) => c.id);
    const bucketNorm = new Set([...synthB, ...wikS].map(normName));
    return { conv, bucketNorm, label };
}

function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a;
}

async function buildChunk() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "chunk"))!;
    const maxChars = parseInt(arg("--max-chars", "32000")!, 10);
    const validN = parseInt(arg("--valid", "80")!, 10);
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const db = new Database(DB_PATH, { readonly: true });
    const meta = await loadMetaPolicyBlock();
    const systemPrompt = await loadSystemPrompt("chunk");
    const chunkPrompt = CHUNK_PROMPT.replace("{{META_DOCS}}", meta);
    const holdout = await benchmarkHoldout("chunk.json", (c) => c.id);

    // Conversations with at least one gold chunk, with assistant content.
    const convos = db.query(`
        SELECT DISTINCT c.uuid, c.name
        FROM conversations c
        JOIN chunks ch ON ch.conversation_uuid = c.uuid
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_uuid=c.uuid AND m.sender='assistant' AND trim(m.text)!='')
        ORDER BY c.uuid
    `).all() as { uuid: string; name: string }[];

    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid=? ORDER BY position`);
    const chunkQ = db.query(`SELECT start_message_uuid, end_message_uuid, label FROM chunks WHERE conversation_uuid=? ORDER BY id`);

    const lines: Line[] = [];
    let skippedHoldout = 0, skippedOversized = 0, skippedEmpty = 0;

    for (const cv of convos) {
        if (holdout.has(cv.uuid)) { skippedHoldout++; continue; }
        const messages = (msgQ.all(cv.uuid) as Message[]).filter((m) => m.text != null);
        const gold = chunkQ.all(cv.uuid) as { start_message_uuid: string; end_message_uuid: string; label: string }[];
        if (gold.length === 0) { skippedEmpty++; continue; }

        const user = chunkPrompt + formatConversation({ uuid: cv.uuid, name: cv.name, messages } as Conversation);
        const assistant = JSON.stringify({ chunks: gold });
        if (user.length + assistant.length > maxChars) { skippedOversized++; continue; }

        lines.push({ messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: user },
            { role: "assistant", content: assistant },
        ] });
    }

    shuffle(lines);
    const capped = limit ? lines.slice(0, limit) : lines;
    const valid = capped.slice(0, Math.min(validN, Math.floor(capped.length * 0.1)));
    const train = capped.slice(valid.length);

    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "train.jsonl"), train.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (valid.length) await writeFile(join(outDir, "valid.jsonl"), valid.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const avgChars = Math.round(capped.reduce((a, l) => a + l.messages.reduce((s, m) => s + m.content.length, 0), 0) / (capped.length || 1));
    const info = {
        stage: "chunk", builtAt: new Date().toISOString(), format: "messages (system+user+assistant)",
        source: "gold chunks from lucien.db (Opus-era pipeline)", systemPromptFrom: "benchmark/configs/sysprompt-v1.json",
        counts: { train: train.length, valid: valid.length, total: capped.length },
        excluded: { benchmarkHoldout: skippedHoldout, oversized_over_maxChars: skippedOversized, noGoldChunks: skippedEmpty },
        maxChars, approxAvgCharsPerExample: avgChars, approxAvgTokensPerExample: Math.round(avgChars / 4),
    };
    await writeFile(join(outDir, "dataset-info.json"), JSON.stringify(info, null, 2));

    console.log(`chunk fine-tune data → ${outDir}`);
    console.log(`  train.jsonl: ${train.length}   valid.jsonl: ${valid.length}`);
    console.log(`  excluded — benchmark holdout: ${skippedHoldout}, oversized(>${maxChars}c): ${skippedOversized}, no-gold: ${skippedEmpty}`);
    console.log(`  avg ~${avgChars} chars (~${Math.round(avgChars / 4)} tokens) per example`);
}

async function writeDataset(stage: string, outDir: string, lines: Line[], validN: number, limit: number | null, excluded: Record<string, number>, extra: Record<string, unknown> = {}) {
    shuffle(lines);
    const capped = limit ? lines.slice(0, limit) : lines;
    const valid = capped.slice(0, Math.min(validN, Math.floor(capped.length * 0.1)));
    const train = capped.slice(valid.length);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "train.jsonl"), train.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (valid.length) await writeFile(join(outDir, "valid.jsonl"), valid.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const avgChars = Math.round(capped.reduce((a, l) => a + l.messages.reduce((s, m) => s + m.content.length, 0), 0) / (capped.length || 1));
    const info = {
        stage, builtAt: new Date().toISOString(), format: "messages (system+user+assistant)",
        systemPromptFrom: "benchmark/configs/sysprompt-v1.json",
        counts: { train: train.length, valid: valid.length, total: capped.length },
        excluded, approxAvgCharsPerExample: avgChars, approxAvgTokensPerExample: Math.round(avgChars / 4), ...extra,
    };
    await writeFile(join(outDir, "dataset-info.json"), JSON.stringify(info, null, 2));
    console.log(`${stage} fine-tune data → ${outDir}`);
    console.log(`  train.jsonl: ${train.length}   valid.jsonl: ${valid.length}`);
    console.log(`  excluded — ${Object.entries(excluded).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    console.log(`  avg ~${avgChars} chars (~${Math.round(avgChars / 4)} tokens) per example`);
}

async function buildCluster() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "cluster"))!;
    const maxChars = parseInt(arg("--max-chars", "100000")!, 10);
    const validN = parseInt(arg("--valid", "12")!, 10);
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const db = new Database(DB_PATH, { readonly: true });
    const meta = await loadMetaPolicyBlock();
    const systemPrompt = await loadSystemPrompt("cluster");
    const taxonomy = db.query("SELECT name, description FROM buckets ORDER BY name").all() as Bucket[];
    const bucketsMap = new Map<string, Bucket>();
    for (const b of taxonomy) bucketsMap.set(b.name, b);
    const quar = await loadQuarantine();

    const rows = db.query(`SELECT c.id, c.label, c.conversation_uuid FROM chunks c WHERE c.id IN (SELECT chunk_id FROM chunk_buckets) ORDER BY c.id`).all() as { id: number; label: string; conversation_uuid: string }[];
    const goldQ = db.query(`SELECT bucket_name FROM chunk_buckets WHERE chunk_id=?`);
    // Exclude benchmark labels and any chunk from a benchmark conversation.
    const eligible = rows.filter((r) => !quar.label.has(r.label) && !quar.conv.has(r.conversation_uuid));
    const skippedHoldout = rows.length - eligible.length;

    const lines: Line[] = [];
    let skippedOversized = 0;
    for (let s = 0; s < eligible.length; s += BATCH_SIZE) {
        const batch = eligible.slice(s, s + BATCH_SIZE);
        const rowsForPrompt: ChunkRow[] = batch.map((b) => ({ id: b.id, label: b.label }));
        const user = buildAssignPrompt(meta, bucketsMap, rowsForPrompt);
        const assignments = batch.map((b, i) => ({
            label_id: i + 1,
            existing_buckets: (goldQ.all(b.id) as { bucket_name: string }[]).map((x) => x.bucket_name),
            new_bucket: null,
        }));
        const assistant = JSON.stringify({ assignments });
        if (user.length + assistant.length > maxChars) { skippedOversized++; continue; }
        lines.push({ messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: user },
            { role: "assistant", content: assistant },
        ] });
    }
    await writeDataset("cluster", outDir, lines, validN, limit,
        { benchmarkHoldoutLabels: skippedHoldout, oversized_over_maxChars: skippedOversized },
        { batchSize: BATCH_SIZE, taxonomyBuckets: taxonomy.length, note: "gold = existing chunk_buckets assignments; new_bucket always null (cannot reconstruct historical 'new at the time')" });
}

async function buildSynthesize() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "synthesize"))!;
    const maxChars = parseInt(arg("--max-chars", "160000")!, 10);
    const validN = parseInt(arg("--valid", "15")!, 10);
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const db = new Database(DB_PATH, { readonly: true });
    const systemPrompt = await loadSystemPrompt("synthesize");
    const taxonomy = db.query("SELECT name, description FROM buckets ORDER BY name").all() as Bucket[];
    const quar = await loadQuarantine();

    const buckets = db.query(`
        SELECT b.name, b.description, COUNT(cb.chunk_id) n
        FROM buckets b JOIN chunk_buckets cb ON cb.bucket_name=b.name
        GROUP BY b.name, b.description HAVING n >= 1 ORDER BY b.name
    `).all() as { name: string; description: string; n: number }[];
    const chunksQ = db.query(`
        SELECT c.id, c.conversation_uuid, conv.name AS conversation_name,
               c.start_message_uuid, c.end_message_uuid, c.label
        FROM chunks c JOIN chunk_buckets cb ON cb.chunk_id=c.id
        JOIN conversations conv ON conv.uuid=c.conversation_uuid
        WHERE cb.bucket_name=? ORDER BY conv.updated_at, c.id
    `);

    const lines: Line[] = [];
    let skippedHoldout = 0, skippedNoArticle = 0, skippedOversized = 0, skippedConvSource = 0;
    for (const b of buckets) {
        // Unified quarantine: exclude synth AND wikify benchmark articles (same entity).
        if (quar.bucketNorm.has(normName(b.name))) { skippedHoldout++; continue; }
        let article: string;
        try { article = (await readFile(join(ARTICLES_PATH, bucketToFilename(b.name)), "utf8")).trim(); }
        catch { skippedNoArticle++; continue; }
        if (!/^\s*#\s+\S/.test(article.split("\n").find((l) => l.trim()) ?? "")) { skippedNoArticle++; continue; }
        const chunks = chunksQ.all(b.name) as SynthChunk[];
        // Don't even expose a benchmark chunk conversation as (masked) source material.
        if (chunks.some((c) => quar.conv.has(c.conversation_uuid))) { skippedConvSource++; continue; }
        const user = SYNTHESIS_PROMPT_BOOTSTRAP
            .replace(/\{\{BUCKET_NAME\}\}/g, b.name)
            .replace(/\{\{BUCKET_DESCRIPTION\}\}/g, b.description)
            .replace(/\{\{OTHER_ARTICLES\}\}/g, otherArticlesFrom(taxonomy, b.name))
            .replace(/\{\{CHUNKS\}\}/g, formatChunks(chunks, db));
        if (user.length + article.length > maxChars) { skippedOversized++; continue; }
        lines.push({ messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: user },
            { role: "assistant", content: article },
        ] });
    }
    await writeDataset("synthesize", outDir, lines, validN, limit,
        { benchmarkQuarantineBuckets: skippedHoldout, benchmarkConvAsSource: skippedConvSource, noOnDiskArticle: skippedNoArticle, oversized_over_maxChars: skippedOversized },
        { note: "gold = current on-disk article (post-editorial/normalize); unified quarantine excludes synth+wikify benchmark articles AND any bucket sourced from a benchmark chunk conversation" });
}

async function buildWikify() {
    const outDir = arg("--out", join(REPO_ROOT, "benchmark", "finetune", "wikify"))!;
    const maxChars = parseInt(arg("--max-chars", "48000")!, 10);
    const validN = parseInt(arg("--valid", "10")!, 10);
    const limit = arg("--limit") ? parseInt(arg("--limit")!, 10) : null;

    const systemPrompt = await loadSystemPrompt("wikify");
    const quar = await loadQuarantine();

    // Mine before→after pairs from "Editorial restructure: <stem>" commits in the Dreaming.
    const log = await gitLines(["log", "--grep=Editorial restructure:", "--format=%H%x09%s"], DREAMING_PATH);
    const commits = log.trim().split("\n").filter(Boolean).map((l) => { const [hash, ...rest] = l.split("\t"); return { hash: hash!, subject: rest.join("\t") }; });

    const lines: Line[] = [];
    const seen = new Set<string>();
    let skippedHoldout = 0, skippedNoPair = 0, skippedNoop = 0, skippedOversized = 0;
    for (const { hash, subject } of commits) {
        const m = subject.match(/Editorial restructure:\s*(.+?)\s*$/);
        if (!m) continue;
        const stem = m[1]!;
        // Unified quarantine: exclude wikify AND synth benchmark articles (same entity).
        if (quar.bucketNorm.has(normName(stem))) { skippedHoldout++; continue; }
        const before = await gitShow(`${hash}~1:articles/${stem}.md`, DREAMING_PATH);
        const after = await gitShow(`${hash}:articles/${stem}.md`, DREAMING_PATH);
        if (before == null || after == null) { skippedNoPair++; continue; }
        const b = before.trim(), a = after.trim();
        if (!b || !a || b === a) { skippedNoop++; continue; }
        const key = `${stem}:${b.length}:${a.length}`;
        if (seen.has(key)) continue; seen.add(key);
        const user = buildEditorialPrompt(b);
        if (user.length + a.length > maxChars) { skippedOversized++; continue; }
        lines.push({ messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: user },
            { role: "assistant", content: a },
        ] });
    }
    await writeDataset("wikify", outDir, lines, validN, limit,
        { benchmarkQuarantineStems: skippedHoldout, noParentVersion: skippedNoPair, noopEdits: skippedNoop, oversized_over_maxChars: skippedOversized },
        { editorialCommitsScanned: commits.length, note: "gold = before(parent)→after(commit) of 'Editorial restructure:' commits in ~/Dreaming git history" });
}

async function main() {
    const stage = arg("--stage", "chunk");
    const stages = stage === "all" ? ["chunk", "cluster", "synthesize", "wikify"] : [stage!];
    for (const s of stages) {
        if (s === "chunk") await buildChunk();
        else if (s === "cluster") await buildCluster();
        else if (s === "synthesize") await buildSynthesize();
        else if (s === "wikify") await buildWikify();
        else { console.error(`unknown stage "${s}"`); process.exit(1); }
        console.log("");
    }
}

await main();
