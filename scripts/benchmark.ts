/**
 * benchmark.ts — a HumanEval-style benchmark for the Lucien LLM pipeline.
 *
 * A FROZEN dataset (curated conversations / labels / buckets / articles) plus
 * DETERMINISTIC automated scoring, so any change — system prompts, model swap,
 * a fine-tuned LoRA — gets a single comparable scorecard.
 *
 *   bun run scripts/benchmark.ts build [--force]          # freeze dataset from the DB
 *   bun run scripts/benchmark.ts run --config <name> [--stages a,b] [--limit N]
 *   bun run scripts/benchmark.ts compare <scoreA.json> <scoreB.json>
 *
 * `build` reads the DB once and snapshots benchmark/dataset/*.json. `run` and
 * `compare` never touch the DB or the Dreaming — they depend only on the frozen
 * dataset + a config file, which is what makes runs comparable. A config (see
 * benchmark/configs/) is the System Under Test: model, provider, and per-stage
 * pi flags + system prompt.
 *
 * Scoring is objective (format/integrity gates) for all stages, plus a curated
 * gold answer key for cluster-assign (label → correct bucket), bootstrapped
 * from the existing chunk_buckets assignments.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DB_PATH, REPO_ROOT } from "./state-path.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";
import { validateChunks, ChunkValidationError } from "./chunk-validation.js";
import { sanitizeArticleOutput } from "./sanitize-article.js";
import { canonicalBucketKey, bucketToStem } from "./bucket-names.js";

import { CHUNK_PROMPT, formatConversation, type Conversation, type Message } from "./chunk-recent.js";
import { ASSIGN_OR_PROPOSE_PROMPT, buildPrompt as buildAssignPrompt, type Bucket, type ChunkRow, type LLMResponse } from "./cluster-assign-recent.js";
import { SYNTHESIS_PROMPT_BOOTSTRAP, formatChunks, type Chunk as SynthChunk } from "./synthesize.js";
import {
    buildEditorialPrompt, splitModelOutput, ensureArticleStartsWithH1,
    verifyEditorialResult, checkFootnoteIntegrity, extractConvHashes,
} from "./wikify.js";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");
const DATASET_DIR = join(REPO_ROOT, "benchmark", "dataset");
const CONFIG_DIR = join(REPO_ROOT, "benchmark", "configs");
const RESULTS_DIR = join(REPO_ROOT, "benchmark", "results");
const CALL_TIMEOUT_MS = 8 * 60 * 1000;
const WIKIFY_FLOOR = 0.7;
const N = 25; // cases per stage at build time

type StageName = "chunk" | "cluster" | "synthesize" | "wikify";
const ALL_STAGES: StageName[] = ["chunk", "cluster", "synthesize", "wikify"];

// ---------------------------------------------------------------------------
// pi invocation (configurable flags + system prompt)
// ---------------------------------------------------------------------------
interface StageConfig { flags: string[]; systemPrompt: string | null }
interface Config {
    label: string;
    description?: string;
    model?: string | null;
    provider?: string | null;
    stages: Record<StageName, StageConfig>;
}
interface PiResult { stdout: string; stderr: string; code: number | null; ms: number; timedOut: boolean }

function callPi(prompt: string, cfg: Config, stage: StageConfig): Promise<PiResult> {
    const args = ["-p", ...stage.flags];
    if (cfg.model) args.push("--model", cfg.model);
    if (cfg.provider) args.push("--provider", cfg.provider);
    if (stage.systemPrompt) args.push("--system-prompt", stage.systemPrompt);
    return new Promise((resolve) => {
        const start = Date.now();
        const proc = spawn("pi", args, { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, CALL_TIMEOUT_MS);
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        const done = (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code, ms: Date.now() - start, timedOut }); };
        proc.on("exit", done);
        proc.on("error", (e) => { stderr += `\n[spawn error] ${(e as Error).message}`; done(-1); });
        proc.stdin.on("error", () => {});
        proc.stdin.end(LUCIEN_PROMPT_SENTINEL + prompt, "utf8");
    });
}

const FALLBACK_WARN = /No models match pattern/i;

function extractJSON(response: string): any {
    const t = response.trim();
    try { return JSON.parse(t); } catch {}
    const s = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(s); } catch {}
    const f = response.indexOf("{"), l = response.lastIndexOf("}");
    if (f !== -1 && l > f) { try { return JSON.parse(response.slice(f, l + 1)); } catch {} }
    throw new Error("Could not extract valid JSON from response");
}

function wordCount(s: string): number { const t = s.trim(); return t ? t.split(/\s+/).length : 0; }
function convHash(uuid: string): string { return uuid.replace(/-/g, "").slice(0, 8).toLowerCase(); }
async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Dataset shapes (frozen JSON)
// ---------------------------------------------------------------------------
interface Common { builtAt: string; repoSha: string; dreamingSha: string; meta: string; taxonomy: Bucket[] }
interface ChunkCase { id: string; name: string; messages: Message[] }
interface ClusterDataset { cases: { id: number; label: string; gold: string[] }[] }
interface SynthCase { id: string; bucket: string; description: string; chunkCount: number; chunksText: string; validHashes: string[] }
interface WikifyCase { id: string; original: string }

async function loadCommon(): Promise<Common> { return JSON.parse(await readFile(join(DATASET_DIR, "common.json"), "utf8")); }
async function loadStageData<T>(stage: string): Promise<T> { return JSON.parse(await readFile(join(DATASET_DIR, `${stage}.json`), "utf8")); }

// ---------------------------------------------------------------------------
// BUILD — freeze the dataset from the DB
// ---------------------------------------------------------------------------
function gitSha(cwd: string): Promise<string> {
    return new Promise((resolve) => {
        const p = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
        let o = ""; p.stdout.on("data", (d) => (o += d.toString()));
        p.on("exit", () => resolve(o.trim() || "unknown"));
        p.on("error", () => resolve("unknown"));
    });
}

async function build(force: boolean) {
    if ((await exists(join(DATASET_DIR, "common.json"))) && !force) {
        console.error("Dataset already exists. Re-freezing breaks comparability with prior scorecards.\nPass --force to overwrite intentionally.");
        process.exit(1);
    }
    await mkdir(DATASET_DIR, { recursive: true });
    const db = new Database(DB_PATH, { readonly: true });
    const meta = await loadMetaPolicyBlock();
    const taxonomy = db.query("SELECT name, description FROM buckets ORDER BY name").all() as Bucket[];
    const common: Common = {
        builtAt: new Date().toISOString(),
        repoSha: await gitSha(REPO_ROOT),
        dreamingSha: await gitSha(DREAMING_PATH),
        meta, taxonomy,
    };
    await writeFile(join(DATASET_DIR, "common.json"), JSON.stringify(common, null, 2));
    console.log(`common.json — ${taxonomy.length} buckets, meta ${meta.length} chars`);

    // chunk: substantive conversations, excluding CLI/meta noise.
    const convos = db.query(`
        SELECT c.uuid, c.name
        FROM conversations c
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_uuid=c.uuid AND m.sender='assistant' AND trim(m.text)!='')
          AND c.message_count >= 4
          AND coalesce(c.name,'') NOT LIKE '%command-%'
          AND coalesce(c.name,'') NOT LIKE '%local-command-caveat%'
        ORDER BY RANDOM() LIMIT ?
    `).all(N) as { uuid: string; name: string }[];
    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid=? ORDER BY position`);
    const chunkCases: ChunkCase[] = [];
    for (const cv of convos) {
        const messages = (msgQ.all(cv.uuid) as Message[]).filter((m) => m.text != null);
        // skip transcripts whose recent content is a CLI caveat wrapper
        if ((messages[0]?.text ?? "").includes("local-command-caveat")) continue;
        chunkCases.push({ id: cv.uuid, name: cv.name ?? "(untitled)", messages });
    }
    await writeFile(join(DATASET_DIR, "chunk.json"), JSON.stringify(chunkCases, null, 2));
    console.log(`chunk.json — ${chunkCases.length} conversations`);

    // cluster: real assigned chunks → gold = their current bucket(s).
    const rows = db.query(`
        SELECT c.id, c.label FROM chunks c
        WHERE c.id IN (SELECT chunk_id FROM chunk_buckets)
        ORDER BY RANDOM() LIMIT ?
    `).all(N) as { id: number; label: string }[];
    const goldQ = db.query(`SELECT bucket_name FROM chunk_buckets WHERE chunk_id=?`);
    const clusterCases = rows.map((r, i) => ({
        id: i + 1,
        label: r.label,
        gold: (goldQ.all(r.id) as { bucket_name: string }[]).map((x) => x.bucket_name),
    }));
    await writeFile(join(DATASET_DIR, "cluster.json"), JSON.stringify({ cases: clusterCases } as ClusterDataset, null, 2));
    console.log(`cluster.json — ${clusterCases.length} labels with gold buckets`);

    // synthesize: buckets with 3–60 chunks; freeze the formatted source material.
    const buckets = db.query(`
        SELECT b.name, b.description, COUNT(cb.chunk_id) n
        FROM buckets b JOIN chunk_buckets cb ON cb.bucket_name=b.name
        GROUP BY b.name, b.description HAVING n BETWEEN 3 AND 60
        ORDER BY RANDOM() LIMIT ?
    `).all(N) as { name: string; description: string; n: number }[];
    const chunksQ = db.query(`
        SELECT c.id, c.conversation_uuid, conv.name AS conversation_name,
               c.start_message_uuid, c.end_message_uuid, c.label
        FROM chunks c JOIN chunk_buckets cb ON cb.chunk_id=c.id
        JOIN conversations conv ON conv.uuid=c.conversation_uuid
        WHERE cb.bucket_name=? ORDER BY conv.updated_at, c.id
    `);
    const synthCases: SynthCase[] = [];
    for (const b of buckets) {
        const chunks = chunksQ.all(b.name) as SynthChunk[];
        const hashes = [...new Set(chunks.map((c) => convHash(c.conversation_uuid)))];
        synthCases.push({
            id: b.name, bucket: b.name, description: b.description, chunkCount: b.n,
            chunksText: formatChunks(chunks, db), validHashes: hashes,
        });
    }
    await writeFile(join(DATASET_DIR, "synthesize.json"), JSON.stringify(synthCases, null, 2));
    console.log(`synthesize.json — ${synthCases.length} buckets`);

    // wikify: existing articles, 150–5000 words.
    let files: string[] = [];
    try { files = (await readdir(ARTICLES_PATH)).filter((f) => f.endsWith(".md")); } catch {}
    for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [files[i], files[j]] = [files[j]!, files[i]!]; }
    const wikifyCases: WikifyCase[] = [];
    for (const f of files) {
        if (wikifyCases.length >= N) break;
        const text = await readFile(join(ARTICLES_PATH, f), "utf8");
        const w = wordCount(text);
        if (w < 150 || w > 5000) continue;
        wikifyCases.push({ id: f.replace(/\.md$/, ""), original: text });
    }
    await writeFile(join(DATASET_DIR, "wikify.json"), JSON.stringify(wikifyCases, null, 2));
    console.log(`wikify.json — ${wikifyCases.length} articles`);

    console.log(`\nFrozen at repo ${common.repoSha} / dreaming ${common.dreamingSha}. Dataset is now the benchmark — commit benchmark/dataset/ to lock it.`);
}

// ---------------------------------------------------------------------------
// Scoring — each returns a 0–100 case score + named checks
// ---------------------------------------------------------------------------
interface CaseScore { id: string; score: number; jsonValid?: boolean; checks: Record<string, number>; detail: string }

const GENERIC_LABELS = ["technical discussion", "conversation", "q&a", "discussion", "chat", "general discussion"];

function scoreChunk(c: ChunkCase, pi: PiResult): CaseScore {
    const checks: Record<string, number> = {};
    let parsed: any;
    try { if (pi.timedOut) throw new Error("timeout"); parsed = extractJSON(pi.stdout); }
    catch { return { id: c.id, score: 0, jsonValid: false, checks: { json: 0 }, detail: "invalid JSON" }; }
    const arr = Array.isArray(parsed?.chunks) ? parsed.chunks : null;
    if (!arr) return { id: c.id, score: 0, jsonValid: true, checks: { json: 1, schema: 0 }, detail: "no chunks array" };
    const schemaOk = arr.length === 0 ? 1 : arr.filter((x: any) => typeof x?.start_message_uuid === "string" && typeof x?.end_message_uuid === "string" && typeof x?.label === "string").length / arr.length;
    let anchors = 0; let detail = "";
    try {
        const { chunks, repairs } = validateChunks(arr, c.messages, c.id);
        anchors = chunks.length === 0 ? (arr.length === 0 ? 1 : 0) : Math.max(0, 1 - repairs.length / (2 * chunks.length));
        detail = `${chunks.length} chunks${repairs.length ? `, ${repairs.length} repairs` : ""}`;
    } catch (e: any) { anchors = 0; detail = e.message?.slice(0, 80) ?? "anchor error"; }
    const labels = arr.length === 0 ? 1 : arr.filter((x: any) => { const w = wordCount(x?.label ?? ""); return w >= 2 && w <= 12 && !GENERIC_LABELS.includes((x?.label ?? "").toLowerCase().trim()); }).length / arr.length;
    const nonempty = arr.length >= 1 ? 1 : 0; // curated cases are substantive
    checks.json = 1; checks.schema = schemaOk; checks.anchors = anchors; checks.labels = labels; checks.nonempty = nonempty;
    const score = 100 * (0.30 * schemaOk + 0.35 * anchors + 0.15 * labels + 0.20 * nonempty);
    return { id: c.id, score, jsonValid: true, checks, detail };
}

interface ClusterScore { f1: number; precision: number; recall: number; exactMatch: number; unknown: number; proposed: number; jsonValid: boolean; perLabel: CaseScore[] }
function scoreCluster(ds: ClusterDataset, taxonomy: Bucket[], pi: PiResult): ClusterScore {
    const keyToName = new Map<string, string>();
    for (const b of taxonomy) keyToName.set(canonicalBucketKey(b.name), b.name);
    let parsed: LLMResponse;
    try { if (pi.timedOut) throw new Error("timeout"); parsed = extractJSON(pi.stdout) as LLMResponse; }
    catch { return { f1: 0, precision: 0, recall: 0, exactMatch: 0, unknown: 0, proposed: 0, jsonValid: false, perLabel: [] }; }
    const byId = new Map<number, any>();
    for (const a of parsed.assignments ?? []) byId.set(a.label_id, a);
    let tp = 0, fp = 0, fn = 0, exact = 0, unknown = 0, proposed = 0;
    const perLabel: CaseScore[] = [];
    for (const cse of ds.cases) {
        const a = byId.get(cse.id);
        const predSet = new Set<string>();
        if (a) {
            for (const b of a.existing_buckets ?? []) { const canon = keyToName.get(canonicalBucketKey(b)); if (canon) predSet.add(canon); else unknown++; }
            if (a.new_bucket && predSet.size === 0) { const dup = keyToName.get(canonicalBucketKey(a.new_bucket.name ?? "")); if (dup) predSet.add(dup); else proposed++; }
        }
        const goldSet = new Set(cse.gold.map((g) => keyToName.get(canonicalBucketKey(g)) ?? g));
        let ltp = 0, lfp = 0, lfn = 0;
        for (const p of predSet) (goldSet.has(p) ? ltp++ : lfp++);
        for (const g of goldSet) if (!predSet.has(g)) lfn++;
        tp += ltp; fp += lfp; fn += lfn;
        const isExact = predSet.size === goldSet.size && [...predSet].every((p) => goldSet.has(p));
        if (isExact) exact++;
        const lf1 = ltp ? (2 * ltp) / (2 * ltp + lfp + lfn) : (goldSet.size === 0 && predSet.size === 0 ? 1 : 0);
        perLabel.push({ id: String(cse.id), score: 100 * lf1, checks: { f1: lf1 }, detail: `pred[${[...predSet].join(", ") || "—"}] gold[${[...goldSet].join(", ")}]` });
    }
    const precision = tp ? tp / (tp + fp) : 0;
    const recall = tp ? tp / (tp + fn) : 0;
    const f1 = tp ? (2 * precision * recall) / (precision + recall) : 0;
    return { f1, precision, recall, exactMatch: ds.cases.length ? exact / ds.cases.length : 0, unknown, proposed, jsonValid: true, perLabel };
}

function scoreSynth(c: SynthCase, pi: PiResult): CaseScore {
    const checks: Record<string, number> = {};
    let article: string;
    try { if (pi.timedOut) throw new Error("timeout"); article = sanitizeArticleOutput(pi.stdout); }
    catch (e: any) { return { id: c.id, score: 0, checks: { sanitize: 0 }, detail: (e.message ?? "rejected").slice(0, 80) }; }
    const h1 = /^\s*#\s+\S/.test(article.split("\n").find((l) => l.trim()) ?? "") ? 1 : 0;
    const refs = /^##\s+References\s*$/m.test(article) ? 1 : 0;
    const fn = checkFootnoteIntegrity(article);
    const fnOk = fn.ok ? 1 : 0;
    const hashes = [...extractConvHashes(article)];
    const valid = new Set(c.validHashes);
    const citReal = hashes.length === 0 ? 0 : hashes.filter((h) => valid.has(h)).length / hashes.length;
    const cit = hashes.length >= 1 ? citReal : 0;
    const words = wordCount(article);
    const wOk = words >= 50 ? 1 : 0;
    checks.h1 = h1; checks.refs = refs; checks.footnote = fnOk; checks.citations = cit; checks.words = wOk;
    const score = 100 * (0.15 * h1 + 0.15 * refs + 0.40 * fnOk + 0.20 * cit + 0.10 * wOk);
    return { id: c.id, score, checks, detail: `${words}w · ${hashes.length} cites · footnotes ${fn.ok ? "ok" : fn.errors.length + " err"}` };
}

function scoreWikify(c: WikifyCase, pi: PiResult): CaseScore & { gatePass: boolean } {
    const checks: Record<string, number> = {};
    let edited: string;
    try { if (pi.timedOut) throw new Error("timeout"); const sp = splitModelOutput(pi.stdout); edited = ensureArticleStartsWithH1(sp.article, c.original); }
    catch (e: any) { return { id: c.id, score: 0, checks: { output: 0 }, detail: (e.message ?? "no output").slice(0, 80), gatePass: false }; }
    const before = extractConvHashes(c.original); const after = extractConvHashes(edited);
    const citPres = before.size === 0 ? 1 : [...before].filter((h) => after.has(h)).length / before.size;
    const fnOk = checkFootnoteIntegrity(edited).ok ? 1 : 0;
    const hadRefs = /^##\s+References\s*$/m.test(c.original); const hasRefs = /^##\s+References\s*$/m.test(edited);
    const refsKept = hadRefs ? (hasRefs ? 1 : 0) : 1;
    const ow = wordCount(c.original), ew = wordCount(edited);
    const floor = ow === 0 ? 1 : ew >= WIKIFY_FLOOR * ow ? 1 : 0;
    const h1 = /^#\s+\S/.test(edited.split("\n").find((l) => l.trim()) ?? "") ? 1 : 0;
    checks.citations = citPres; checks.footnote = fnOk; checks.refs = refsKept; checks.floor = floor; checks.h1 = h1;
    const gate = verifyEditorialResult(c.original, edited, { floor: WIKIFY_FLOOR });
    const score = 100 * (0.35 * citPres + 0.25 * fnOk + 0.15 * refsKept + 0.15 * floor + 0.10 * h1);
    return { id: c.id, score, checks, detail: `${ow}→${ew}w · ${gate.ok ? "GATE PASS" : gate.errors.length + " gate err"}`, gatePass: gate.ok };
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
interface StageReport { stage: StageName; score: number; cases: CaseScore[]; headline: Record<string, number>; fallback: number; avgMs: number }
interface Scorecard {
    config: string; ranAt: string; modelId: string; datasetSha: string; limit: number | null;
    overall: number; stages: StageReport[];
}

function otherArticlesFrom(taxonomy: Bucket[], exclude: string): string {
    return taxonomy.filter((b) => b.name !== exclude).map((b) => `- ${bucketToStem(b.name)}: ${b.description}`).join("\n");
}

async function run(configName: string, stages: StageName[], limit: number | null) {
    const cfg: Config = JSON.parse(await readFile(join(CONFIG_DIR, `${configName}.json`), "utf8"));
    const common = await loadCommon();
    console.log(`Benchmark run — config=${cfg.label}, stages=${stages.join(",")}${limit ? `, limit=${limit}` : ""}`);
    console.log(`Dataset frozen ${common.builtAt} (repo ${common.repoSha})\n`);

    const probe = await callPi("Identify yourself in one line: model name, provider/API, version if known.", cfg, cfg.stages.chunk);
    const modelId = probe.stdout.trim().replace(/\s+/g, " ").slice(0, 200) || "(no response)";
    console.log(`Model: ${modelId}\n`);

    const reports: StageReport[] = [];
    const cap = <T,>(xs: T[]) => (limit ? xs.slice(0, limit) : xs);

    if (stages.includes("chunk")) {
        const cases = cap(await loadStageData<ChunkCase[]>("chunk"));
        const cs: CaseScore[] = []; const ms: number[] = []; let fb = 0;
        let i = 0;
        for (const c of cases) {
            i++; process.stdout.write(`  [chunk ${i}/${cases.length}] ${c.name}\n`);
            const prompt = CHUNK_PROMPT.replace("{{META_DOCS}}", common.meta) + formatConversation({ uuid: c.id, name: c.name, messages: c.messages } as Conversation);
            const pi = await callPi(prompt, cfg, cfg.stages.chunk);
            if (FALLBACK_WARN.test(pi.stderr)) fb++; ms.push(pi.ms);
            cs.push(scoreChunk(c, pi));
        }
        reports.push({ stage: "chunk", score: mean(cs.map((x) => x.score)), cases: cs, fallback: fb, avgMs: mean(ms), headline: { parse_rate: cs.filter((x) => x.jsonValid).length / (cs.length || 1) } });
    }
    if (stages.includes("cluster")) {
        const ds = await loadStageData<ClusterDataset>("cluster");
        const cases = cap(ds.cases);
        process.stdout.write(`  [cluster] ${cases.length} labels…\n`);
        const bucketsMap = new Map<string, Bucket>();
        for (const b of common.taxonomy) bucketsMap.set(b.name, b);
        const batch: ChunkRow[] = cases.map((c) => ({ id: c.id, label: c.label }));
        const prompt = buildAssignPrompt(common.meta, bucketsMap, batch);
        const pi = await callPi(prompt, cfg, cfg.stages.cluster);
        const sc = scoreCluster({ cases }, common.taxonomy, pi);
        reports.push({
            stage: "cluster", score: sc.f1 * 100, cases: sc.perLabel, fallback: FALLBACK_WARN.test(pi.stderr) ? 1 : 0, avgMs: pi.ms,
            headline: { f1: sc.f1, precision: sc.precision, recall: sc.recall, exact_match: sc.exactMatch, unknown_buckets: sc.unknown, new_proposals: sc.proposed, json_valid: sc.jsonValid ? 1 : 0 },
        });
    }
    if (stages.includes("synthesize")) {
        const cases = cap(await loadStageData<SynthCase[]>("synthesize"));
        const cs: CaseScore[] = []; const ms: number[] = []; let fb = 0; let i = 0;
        for (const c of cases) {
            i++; process.stdout.write(`  [synth ${i}/${cases.length}] ${c.bucket} (${c.chunkCount} chunks)\n`);
            const prompt = SYNTHESIS_PROMPT_BOOTSTRAP
                .replace(/\{\{BUCKET_NAME\}\}/g, c.bucket)
                .replace(/\{\{BUCKET_DESCRIPTION\}\}/g, c.description)
                .replace(/\{\{OTHER_ARTICLES\}\}/g, otherArticlesFrom(common.taxonomy, c.bucket))
                .replace(/\{\{CHUNKS\}\}/g, c.chunksText);
            const pi = await callPi(prompt, cfg, cfg.stages.synthesize);
            if (FALLBACK_WARN.test(pi.stderr)) fb++; ms.push(pi.ms);
            cs.push(scoreSynth(c, pi));
        }
        reports.push({ stage: "synthesize", score: mean(cs.map((x) => x.score)), cases: cs, fallback: fb, avgMs: mean(ms), headline: { footnote_ok_rate: cs.filter((x) => x.checks.footnote === 1).length / (cs.length || 1) } });
    }
    if (stages.includes("wikify")) {
        const cases = cap(await loadStageData<WikifyCase[]>("wikify"));
        const cs: CaseScore[] = []; const ms: number[] = []; let fb = 0, gate = 0; let i = 0;
        for (const c of cases) {
            i++; process.stdout.write(`  [wikify ${i}/${cases.length}] ${c.id}\n`);
            const pi = await callPi(buildEditorialPrompt(c.original), cfg, cfg.stages.wikify);
            if (FALLBACK_WARN.test(pi.stderr)) fb++; ms.push(pi.ms);
            const r = scoreWikify(c, pi); if (r.gatePass) gate++;
            cs.push(r);
        }
        reports.push({ stage: "wikify", score: mean(cs.map((x) => x.score)), cases: cs, fallback: fb, avgMs: mean(ms), headline: { gate_pass_rate: gate / (cs.length || 1) } });
    }

    const overall = mean(reports.map((r) => r.score));
    const card: Scorecard = { config: cfg.label, ranAt: new Date().toISOString(), modelId, datasetSha: common.repoSha, limit, overall, stages: reports };

    await mkdir(RESULTS_DIR, { recursive: true });
    const stamp = card.ranAt.replace(/[:.]/g, "-");
    const base = join(RESULTS_DIR, `${cfg.label}-${stamp}`);
    await writeFile(`${base}.json`, JSON.stringify(card, null, 2));
    await writeFile(`${base}.html`, renderHtml(card));

    console.log(`\n=== ${cfg.label} — overall ${round(overall)}/100 ===`);
    for (const r of reports) console.log(`  ${r.stage.padEnd(11)} ${round(r.score).toString().padStart(5)}  ${Object.entries(r.headline).map(([k, v]) => `${k}=${round(v <= 1 ? v * 100 : v)}`).join(" ")}${r.fallback ? `  ⚠${r.fallback} fallback` : ""}`);
    console.log(`\nScorecard: ${base}.json\nReport:    ${base}.html`);
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function bar(score: number): string {
    const c = score >= 80 ? "#1f7a4d" : score >= 50 ? "#8a6d1a" : "#9b2c2c";
    return `<div class="barwrap"><div class="bar" style="width:${Math.max(2, score)}%;background:${c}"></div><span>${round(score)}</span></div>`;
}
function renderHtml(card: Scorecard): string {
    const stageBlocks = card.stages.map((r) => {
        const head = Object.entries(r.headline).map(([k, v]) => `${k}: <b>${round(v <= 1 ? v * 100 : v)}</b>`).join(" · ");
        const rows = r.cases.map((c) => `<tr><td>${esc(c.id)}</td><td>${bar(c.score)}</td><td>${Object.entries(c.checks).map(([k, v]) => `<span class="chk ${v >= 1 ? "ok" : v <= 0 ? "bad" : "mid"}">${k}</span>`).join(" ")}</td><td class="dt">${esc(c.detail)}</td></tr>`).join("");
        return `<section><h2>${r.stage} — ${round(r.score)}/100</h2><p class="meta">${head} · avg ${(r.avgMs / 1000).toFixed(1)}s/call${r.fallback ? ` · ⚠ ${r.fallback} fallback` : ""}</p>
        <table><thead><tr><th>case</th><th>score</th><th>checks</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Benchmark — ${esc(card.config)}</title><style>
:root{--bg:#0f1115;--ink:#e6e9ef;--mut:#9aa4b2;--line:#262b35;--panel:#171a21}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:22px 28px;border-bottom:1px solid var(--line)}h1{margin:0 0 4px;font-size:20px}h2{font-size:16px;margin:28px 0 6px}
.wrap{padding:0 28px 70px;max-width:1100px;margin:0 auto}.meta{color:var(--mut);font-size:12.5px}
.overall{font-size:34px;font-weight:700;margin:6px 0}
table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:middle}
th{background:var(--panel);color:var(--mut);font-size:12px}.dt{color:var(--mut);font-size:12px}
.barwrap{position:relative;background:#0b0d11;border:1px solid var(--line);border-radius:4px;height:18px;width:160px}
.bar{height:100%;border-radius:3px}.barwrap span{position:absolute;right:6px;top:0;font-size:11px;line-height:18px}
.chk{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;margin:1px 0}
.chk.ok{background:#173d2a;color:#5fd49a}.chk.bad{background:#3d1717;color:#ff8a8a}.chk.mid{background:#3a3415;color:#e8c75a}
</style></head><body>
<header><h1>Lucien pipeline benchmark — ${esc(card.config)}</h1>
<div class="overall">${round(card.overall)}<span style="font-size:16px;color:var(--mut)">/100 overall</span></div>
<div class="meta">${esc(card.modelId)} · ${esc(card.ranAt)} · dataset ${esc(card.datasetSha)}${card.limit ? ` · limit ${card.limit}` : ""}</div></header>
<div class="wrap">${stageBlocks}</div></body></html>`;
}

// ---------------------------------------------------------------------------
// COMPARE
// ---------------------------------------------------------------------------
async function compare(aPath: string, bPath: string) {
    const a: Scorecard = JSON.parse(await readFile(aPath, "utf8"));
    const b: Scorecard = JSON.parse(await readFile(bPath, "utf8"));
    const fmt = (n: number) => round(n).toString().padStart(6);
    const delta = (x: number, y: number) => { const d = round(y - x); return (d >= 0 ? "+" : "") + d; };
    console.log(`\nA: ${a.config}  (${a.modelId.slice(0, 40)})`);
    console.log(`B: ${b.config}  (${b.modelId.slice(0, 40)})\n`);
    console.log(`${"stage".padEnd(12)}${"A".padStart(7)}${"B".padStart(8)}${"Δ".padStart(9)}`);
    console.log("-".repeat(36));
    const stages = [...new Set([...a.stages.map((s) => s.stage), ...b.stages.map((s) => s.stage)])];
    for (const st of stages) {
        const sa = a.stages.find((s) => s.stage === st)?.score ?? 0;
        const sb = b.stages.find((s) => s.stage === st)?.score ?? 0;
        console.log(`${st.padEnd(12)}${fmt(sa)}${fmt(sb)}${delta(sa, sb).padStart(9)}`);
    }
    console.log("-".repeat(36));
    console.log(`${"OVERALL".padEnd(12)}${fmt(a.overall)}${fmt(b.overall)}${delta(a.overall, b.overall).padStart(9)}\n`);
    // headline deltas per stage
    for (const st of stages) {
        const ha = a.stages.find((s) => s.stage === st)?.headline ?? {};
        const hb = b.stages.find((s) => s.stage === st)?.headline ?? {};
        const keys = [...new Set([...Object.keys(ha), ...Object.keys(hb)])];
        if (!keys.length) continue;
        console.log(`${st}:`);
        for (const k of keys) {
            const va = round((ha[k] ?? 0) <= 1 ? (ha[k] ?? 0) * 100 : ha[k] ?? 0);
            const vb = round((hb[k] ?? 0) <= 1 ? (hb[k] ?? 0) * 100 : hb[k] ?? 0);
            console.log(`  ${k.padEnd(18)} ${fmt(va)} → ${fmt(vb)}  (${delta(va, vb)})`);
        }
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    if (cmd === "build") {
        await build(argv.includes("--force"));
    } else if (cmd === "run") {
        const config = flag("--config"); if (!config) { console.error("--config <name> required"); process.exit(1); }
        const stages = (flag("--stages")?.split(",").map((s) => s.trim()) ?? ALL_STAGES) as StageName[];
        const limStr = flag("--limit"); const limit = limStr ? parseInt(limStr, 10) : null;
        await run(config, stages, limit);
    } else if (cmd === "compare") {
        const [, a, b] = argv; if (!a || !b) { console.error("usage: compare <A.json> <B.json>"); process.exit(1); }
        await compare(a, b);
    } else {
        console.log("usage:\n  benchmark.ts build [--force]\n  benchmark.ts run --config <name> [--stages chunk,cluster,synthesize,wikify] [--limit N]\n  benchmark.ts compare <A.json> <B.json>");
    }
}

await main();
