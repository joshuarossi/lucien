/**
 * eval-pipeline.ts — DRY-RUN model evaluation harness.
 *
 * Runs every LLM stage of the Lucien pipeline (chunk → cluster-assign →
 * synthesize → wikify) through whatever `pi -p` resolves to, on a sample of
 * REAL data, and writes a single self-contained HTML report you can open in a
 * browser to judge model quality.
 *
 * STRICTLY READ-ONLY: the DB is opened readonly, the Dreaming is never written,
 * and nothing is git-committed. The only output is the HTML report under
 * reports/. It reuses the EXACT prompts + parsing/validation helpers of the
 * real pipeline scripts (imported, not copied) so the eval reflects production
 * behaviour rather than a drifting replica.
 *
 *   bun run scripts/eval-pipeline.ts [--limit N] [--stages chunk,cluster,synthesize,wikify]
 *
 * Default --limit is 25 (per stage). Latency-dominated: expect a long run.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { DB_PATH, REPO_ROOT } from "./state-path.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";
import { validateChunks } from "./chunk-validation.js";
import { sanitizeArticleOutput } from "./sanitize-article.js";
import { canonicalBucketKey } from "./bucket-names.js";

// Real pipeline prompts + helpers (imported so the eval can never drift):
import { CHUNK_PROMPT, formatConversation, type Conversation, type Message } from "./chunk-recent.js";
import { ASSIGN_OR_PROPOSE_PROMPT, buildPrompt as buildAssignPrompt, type Bucket as AssignBucket, type ChunkRow, type LLMResponse } from "./cluster-assign-recent.js";
import { SYNTHESIS_PROMPT_BOOTSTRAP, formatChunks, getOtherArticles, type Chunk as SynthChunk } from "./synthesize.js";
import {
    buildEditorialPrompt,
    splitModelOutput,
    ensureArticleStartsWithH1,
    verifyEditorialResult,
    checkFootnoteIntegrity,
    extractConvHashes,
} from "./wikify.js";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");
const CALL_TIMEOUT_MS = 8 * 60 * 1000;
const WIKIFY_FLOOR = 0.7;

// ---------------------------------------------------------------------------
// pi -p invocation (captures stdout, stderr, latency — stderr lets us detect a
// silent fallback off the configured local model).
// ---------------------------------------------------------------------------
interface PiResult {
    stdout: string;
    stderr: string;
    code: number | null;
    ms: number;
    timedOut: boolean;
}

function callPi(prompt: string): Promise<PiResult> {
    return new Promise((resolve) => {
        const start = Date.now();
        const proc = spawn("pi", ["-p"], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
        }, CALL_TIMEOUT_MS);
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        const done = (code: number | null) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code, ms: Date.now() - start, timedOut });
        };
        proc.on("exit", done);
        proc.on("error", (e) => {
            stderr += `\n[spawn error] ${(e as Error).message}`;
            done(-1);
        });
        proc.stdin.on("error", () => {});
        proc.stdin.end(LUCIEN_PROMPT_SENTINEL + prompt, "utf8");
    });
}

const FALLBACK_WARN = /No models match pattern/i;

function extractJSON(response: string): any {
    const trimmed = response.trim();
    try { return JSON.parse(trimmed); } catch {}
    const stripped = trimmed
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/, "");
    try { return JSON.parse(stripped); } catch {}
    const f = response.indexOf("{");
    const l = response.lastIndexOf("}");
    if (f !== -1 && l > f) {
        try { return JSON.parse(response.slice(f, l + 1)); } catch {}
    }
    throw new Error("Could not extract valid JSON from response");
}

function wordCount(s: string): number {
    const t = s.trim();
    return t ? t.split(/\s+/).length : 0;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface ChunkResult {
    convUuid: string;
    convName: string;
    messageCount: number;
    ms: number;
    rawLen: number;
    fallback: boolean;
    chunks: { label: string; start: string; end: string }[];
    repairs: string[];
    error?: string;
}
interface ClusterResult {
    batchSize: number;
    ms: number;
    fallback: boolean;
    error?: string;
    rows: { label: string; existing: string[]; unknown: string[]; newBucket?: { name: string; description: string }; unassigned: boolean }[];
}
interface SynthResult {
    bucket: string;
    description: string;
    chunkCount: number;
    ms: number;
    fallback: boolean;
    rawLen: number;
    article?: string;
    words?: number;
    citations?: number;
    footnoteOk?: boolean;
    footnoteErrors?: string[];
    error?: string;
}
interface WikifyResult {
    stem: string;
    ms: number;
    fallback: boolean;
    original: string;
    edited?: string;
    talk?: string | null;
    status: "edited" | "would-edit" | "rejected" | "unchanged" | "error";
    gateErrors: string[];
    origWords: number;
    editWords?: number;
    error?: string;
}

// ---------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------
async function runChunkStage(db: Database, metaBlock: string, limit: number): Promise<{ results: ChunkResult[]; labels: string[] }> {
    const chunkPrompt = CHUNK_PROMPT.replace("{{META_DOCS}}", metaBlock);
    const convos = db.query(`
        SELECT c.uuid, c.name
        FROM conversations c
        WHERE EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_uuid = c.uuid
              AND m.sender = 'assistant' AND trim(m.text) != ''
        )
        ORDER BY c.updated_at DESC
        LIMIT ?
    `).all(limit) as { uuid: string; name: string }[];

    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid = ? ORDER BY position`);
    const results: ChunkResult[] = [];
    const labels: string[] = [];

    let i = 0;
    for (const cv of convos) {
        i++;
        const messages = msgQ.all(cv.uuid) as Message[];
        const nonEmpty = messages.filter((m) => m.text && m.text.trim());
        const conv: Conversation = { uuid: cv.uuid, name: cv.name, messages };
        process.stdout.write(`  [chunk ${i}/${convos.length}] ${cv.name ?? cv.uuid}\n`);
        const pi = await callPi(chunkPrompt + formatConversation(conv));
        const r: ChunkResult = {
            convUuid: cv.uuid, convName: cv.name ?? "(untitled)",
            messageCount: nonEmpty.length, ms: pi.ms, rawLen: pi.stdout.length,
            fallback: FALLBACK_WARN.test(pi.stderr), chunks: [], repairs: [],
        };
        try {
            if (pi.timedOut) throw new Error("pi -p timed out");
            const parsed = extractJSON(pi.stdout);
            const { chunks, repairs } = validateChunks(parsed.chunks ?? [], nonEmpty, cv.uuid);
            r.chunks = chunks.map((c) => ({ label: c.label, start: c.start_message_uuid, end: c.end_message_uuid }));
            r.repairs = repairs;
            for (const c of chunks) labels.push(c.label);
        } catch (e: any) {
            r.error = e.message;
        }
        results.push(r);
    }
    return { results, labels };
}

async function runClusterStage(db: Database, metaBlock: string, labels: string[], limit: number): Promise<ClusterResult> {
    const buckets = db.query("SELECT name, description FROM buckets").all() as AssignBucket[];
    const bucketsMap = new Map<string, AssignBucket>();
    const keyToName = new Map<string, string>();
    for (const b of buckets) {
        bucketsMap.set(b.name, b);
        keyToName.set(canonicalBucketKey(b.name), b.name);
    }
    // Prefer labels produced by the chunk stage; fall back to real DB chunk labels.
    let sourceLabels = labels.slice(0, limit);
    if (sourceLabels.length < limit) {
        const more = db.query(`SELECT label FROM chunks ORDER BY id DESC LIMIT ?`).all(limit) as { label: string }[];
        for (const m of more) {
            if (sourceLabels.length >= limit) break;
            sourceLabels.push(m.label);
        }
    }
    const batch: ChunkRow[] = sourceLabels.map((label, idx) => ({ id: idx + 1, label }));
    const prompt = buildAssignPrompt(metaBlock, bucketsMap, batch);
    process.stdout.write(`  [cluster] assigning ${batch.length} labels…\n`);
    const pi = await callPi(prompt);
    const res: ClusterResult = { batchSize: batch.length, ms: pi.ms, fallback: FALLBACK_WARN.test(pi.stderr), rows: [] };
    try {
        if (pi.timedOut) throw new Error("pi -p timed out");
        const parsed = extractJSON(pi.stdout) as LLMResponse;
        const byId = new Map<number, (typeof parsed.assignments)[number]>();
        for (const a of parsed.assignments ?? []) byId.set(a.label_id, a);
        for (const row of batch) {
            const a = byId.get(row.id);
            const existing: string[] = [];
            const unknown: string[] = [];
            let newBucket: { name: string; description: string } | undefined;
            let unassigned = false;
            if (a) {
                for (const b of a.existing_buckets ?? []) {
                    const canon = keyToName.get(canonicalBucketKey(b));
                    if (canon) existing.push(canon); else unknown.push(b);
                }
                if (a.new_bucket && existing.length === 0) {
                    const norm = a.new_bucket.name.trim().replace(/\s+/g, " ");
                    const dupe = keyToName.get(canonicalBucketKey(norm));
                    if (dupe) existing.push(dupe);
                    else newBucket = { name: norm, description: a.new_bucket.description };
                }
                if (existing.length === 0 && !newBucket) unassigned = true;
            } else {
                unassigned = true;
            }
            res.rows.push({ label: row.label, existing, unknown, newBucket, unassigned });
        }
    } catch (e: any) {
        res.error = e.message;
    }
    return res;
}

async function runSynthesizeStage(db: Database, limit: number): Promise<SynthResult[]> {
    const buckets = db.query(`
        SELECT b.name, b.description, COUNT(cb.chunk_id) AS n
        FROM buckets b
        JOIN chunk_buckets cb ON cb.bucket_name = b.name
        GROUP BY b.name, b.description
        HAVING n BETWEEN 3 AND 60
        ORDER BY RANDOM()
        LIMIT ?
    `).all(limit) as { name: string; description: string; n: number }[];

    const chunksQ = db.query(`
        SELECT c.id, c.conversation_uuid, conv.name AS conversation_name,
               c.start_message_uuid, c.end_message_uuid, c.label
        FROM chunks c
        JOIN chunk_buckets cb ON cb.chunk_id = c.id
        JOIN conversations conv ON conv.uuid = c.conversation_uuid
        WHERE cb.bucket_name = ?
        ORDER BY conv.updated_at, c.id
    `);

    const results: SynthResult[] = [];
    let i = 0;
    for (const b of buckets) {
        i++;
        const chunks = chunksQ.all(b.name) as SynthChunk[];
        const chunkText = formatChunks(chunks, db);
        const others = getOtherArticles(db, b.name);
        const prompt = SYNTHESIS_PROMPT_BOOTSTRAP
            .replace(/\{\{BUCKET_NAME\}\}/g, b.name)
            .replace(/\{\{BUCKET_DESCRIPTION\}\}/g, b.description)
            .replace(/\{\{OTHER_ARTICLES\}\}/g, others)
            .replace(/\{\{CHUNKS\}\}/g, chunkText);
        process.stdout.write(`  [synth ${i}/${buckets.length}] ${b.name} (${b.n} chunks)\n`);
        const pi = await callPi(prompt);
        const r: SynthResult = {
            bucket: b.name, description: b.description, chunkCount: b.n,
            ms: pi.ms, fallback: FALLBACK_WARN.test(pi.stderr), rawLen: pi.stdout.length,
        };
        try {
            if (pi.timedOut) throw new Error("pi -p timed out");
            const article = sanitizeArticleOutput(pi.stdout);
            r.article = article;
            r.words = wordCount(article);
            r.citations = extractConvHashes(article).size;
            const fn = checkFootnoteIntegrity(article);
            r.footnoteOk = fn.ok;
            r.footnoteErrors = fn.errors;
        } catch (e: any) {
            r.error = e.message;
        }
        results.push(r);
    }
    return results;
}

async function runWikifyStage(limit: number): Promise<WikifyResult[]> {
    let files: string[];
    try {
        files = (await readdir(ARTICLES_PATH)).filter((f) => f.endsWith(".md"));
    } catch (e: any) {
        process.stdout.write(`  [wikify] cannot read ${ARTICLES_PATH}: ${e.message}\n`);
        return [];
    }
    // Shuffle, then pick the first `limit` in a sane size range (150–5000 words).
    for (let i = files.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j]!, files[i]!];
    }
    const picked: { stem: string; text: string }[] = [];
    for (const f of files) {
        if (picked.length >= limit) break;
        const text = await readFile(join(ARTICLES_PATH, f), "utf8");
        const w = wordCount(text);
        if (w < 150 || w > 5000) continue;
        picked.push({ stem: f.replace(/\.md$/, ""), text });
    }

    const results: WikifyResult[] = [];
    let i = 0;
    for (const { stem, text: original } of picked) {
        i++;
        process.stdout.write(`  [wikify ${i}/${picked.length}] ${stem}\n`);
        const pi = await callPi(buildEditorialPrompt(original));
        const r: WikifyResult = {
            stem, ms: pi.ms, fallback: FALLBACK_WARN.test(pi.stderr),
            original, status: "error", gateErrors: [], origWords: wordCount(original),
        };
        try {
            if (pi.timedOut) throw new Error("pi -p timed out");
            const split = splitModelOutput(pi.stdout);
            const edited = ensureArticleStartsWithH1(split.article, original);
            r.edited = edited;
            r.talk = split.talk;
            r.editWords = wordCount(edited);
            if (edited.trim() === original.trim()) {
                r.status = "unchanged";
            } else {
                const gate = verifyEditorialResult(original, edited, { floor: WIKIFY_FLOOR });
                r.gateErrors = gate.errors;
                r.status = gate.ok ? "would-edit" : "rejected";
            }
        } catch (e: any) {
            r.error = e.message;
            r.status = "error";
        }
        results.push(r);
    }
    return results;
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------
function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface ReportInput {
    modelId: string;
    modelStderr: string;
    startedAt: string;
    elapsedSec: number;
    limit: number;
    stages: string[];
    chunk: ChunkResult[];
    cluster: ClusterResult | null;
    synth: SynthResult[];
    wikify: WikifyResult[];
}

function buildHtml(d: ReportInput): string {
    // Markdown payload rendered client-side by marked; referenced by index.
    const md: string[] = [];
    const mref = (s: string) => { md.push(s); return md.length - 1; };

    const fmtMs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const pill = (txt: string, cls: string) => `<span class="pill ${cls}">${esc(txt)}</span>`;

    // ---- Summary ----
    const chunkParseFail = d.chunk.filter((c) => c.error).length;
    const synthFail = d.synth.filter((s) => s.error).length;
    const synthFnBad = d.synth.filter((s) => s.footnoteOk === false).length;
    const wikifyStatus = (st: string) => d.wikify.filter((w) => w.status === st).length;
    const allFallback = [
        ...d.chunk.map((c) => c.fallback),
        ...(d.cluster ? [d.cluster.fallback] : []),
        ...d.synth.map((s) => s.fallback),
        ...d.wikify.map((w) => w.fallback),
    ];
    const fallbackCount = allFallback.filter(Boolean).length;
    const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

    const summaryRows: string[] = [];
    if (d.stages.includes("chunk"))
        summaryRows.push(`<tr><td>Chunk</td><td>${d.chunk.length}</td><td>${chunkParseFail} parse-fail</td><td>${fmtMs(avg(d.chunk.map((c) => c.ms)))}</td><td>${d.chunk.reduce((a, c) => a + c.chunks.length, 0)} chunks total</td></tr>`);
    if (d.stages.includes("cluster") && d.cluster)
        summaryRows.push(`<tr><td>Cluster-assign</td><td>${d.cluster.batchSize} labels</td><td>${d.cluster.error ? "parse-fail" : "ok"}</td><td>${fmtMs(d.cluster.ms)}</td><td>${d.cluster.rows.filter((r) => r.newBucket).length} new buckets, ${d.cluster.rows.filter((r) => r.unassigned).length} unassigned</td></tr>`);
    if (d.stages.includes("synthesize"))
        summaryRows.push(`<tr><td>Synthesize</td><td>${d.synth.length}</td><td>${synthFail} fail, ${synthFnBad} bad footnotes</td><td>${fmtMs(avg(d.synth.map((s) => s.ms)))}</td><td>avg ${Math.round(avg(d.synth.filter((s) => s.words).map((s) => s.words!)))} words</td></tr>`);
    if (d.stages.includes("wikify"))
        summaryRows.push(`<tr><td>Wikify</td><td>${d.wikify.length}</td><td>${wikifyStatus("rejected")} rejected, ${wikifyStatus("error")} error</td><td>${fmtMs(avg(d.wikify.map((w) => w.ms)))}</td><td>${wikifyStatus("would-edit")} would-edit, ${wikifyStatus("unchanged")} unchanged</td></tr>`);

    // ---- Chunk section ----
    let chunkHtml = "";
    if (d.stages.includes("chunk")) {
        const rows = d.chunk.map((c) => {
            const status = c.error ? pill("ERROR", "bad") : pill(`${c.chunks.length} chunks`, "ok");
            const labels = c.error
                ? `<span class="err">${esc(c.error)}</span>`
                : `<ul class="labels">${c.chunks.map((ch) => `<li>${esc(ch.label)}</li>`).join("")}</ul>`;
            const reps = c.repairs.length ? `<div class="repairs">repairs: ${c.repairs.map(esc).join("; ")}</div>` : "";
            const fb = c.fallback ? pill("FALLBACK", "warn") : "";
            return `<tr>
                <td><div class="title">${esc(c.convName)}</div><div class="sub">${esc(c.convUuid.slice(0, 8))} · ${c.messageCount} msgs · ${fmtMs(c.ms)} ${fb}</div></td>
                <td>${status}${labels}${reps}</td>
            </tr>`;
        }).join("");
        chunkHtml = `<table class="grid"><thead><tr><th style="width:32%">Conversation</th><th>Model chunks (labels)</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    // ---- Cluster section ----
    let clusterHtml = "";
    if (d.stages.includes("cluster") && d.cluster) {
        if (d.cluster.error) {
            clusterHtml = `<p class="err">Parse error: ${esc(d.cluster.error)}</p>`;
        } else {
            const rows = d.cluster.rows.map((r) => {
                let dec: string;
                if (r.newBucket) dec = pill("NEW", "warn") + ` <b>${esc(r.newBucket.name)}</b><div class="sub">${esc(r.newBucket.description)}</div>`;
                else if (r.existing.length) dec = r.existing.map((b) => pill(b, "ok")).join(" ");
                else dec = pill("unassigned", "muted");
                const unk = r.unknown.length ? ` <span class="err">unknown: ${r.unknown.map(esc).join(", ")}</span>` : "";
                return `<tr><td>${esc(r.label)}</td><td>${dec}${unk}</td></tr>`;
            }).join("");
            clusterHtml = `<table class="grid"><thead><tr><th style="width:42%">Chunk label</th><th>Assignment</th></tr></thead><tbody>${rows}</tbody></table>`;
        }
    }

    // ---- Synthesize section ----
    let synthHtml = "";
    if (d.stages.includes("synthesize")) {
        synthHtml = d.synth.map((s) => {
            const head = `<div class="title">${esc(s.bucket)} ${s.fallback ? pill("FALLBACK", "warn") : ""}</div>
                <div class="sub">${s.chunkCount} chunks · ${fmtMs(s.ms)} · ${s.words ?? "?"} words · ${s.citations ?? 0} citations · footnotes ${s.footnoteOk === false ? pill("BAD", "bad") : pill("ok", "ok")}</div>`;
            if (s.error) return `<details class="card"><summary>${head}<span class="err"> — ${esc(s.error)}</span></summary></details>`;
            const fnErr = s.footnoteErrors?.length ? `<div class="repairs">footnote issues: ${s.footnoteErrors.map(esc).join("; ")}</div>` : "";
            const idx = mref(s.article ?? "");
            return `<details class="card"><summary>${head}</summary>${fnErr}<div class="md" data-md="${idx}"></div><details class="raw"><summary>raw markdown</summary><pre>${esc(s.article ?? "")}</pre></details></details>`;
        }).join("");
    }

    // ---- Wikify section ----
    let wikifyHtml = "";
    if (d.stages.includes("wikify")) {
        wikifyHtml = d.wikify.map((w) => {
            const stCls = w.status === "would-edit" ? "ok" : w.status === "rejected" ? "bad" : w.status === "error" ? "bad" : "muted";
            const head = `<div class="title">${esc(w.stem)} ${pill(w.status, stCls)} ${w.fallback ? pill("FALLBACK", "warn") : ""}</div>
                <div class="sub">${fmtMs(w.ms)} · ${w.origWords} → ${w.editWords ?? "?"} words</div>`;
            const gate = w.gateErrors.length ? `<div class="repairs">gate: ${w.gateErrors.map(esc).join("; ")}</div>` : "";
            const errLine = w.error ? `<span class="err"> — ${esc(w.error)}</span>` : "";
            const oIdx = mref(w.original);
            const eIdx = w.edited != null ? mref(w.edited) : -1;
            const cols = `<div class="diff"><div><h4>Original</h4><div class="md" data-md="${oIdx}"></div></div>
                <div><h4>Edited</h4>${eIdx >= 0 ? `<div class="md" data-md="${eIdx}"></div>` : "<p class=err>no edited output</p>"}</div></div>`;
            const talk = w.talk ? `<div class="repairs">TALK suggestion: ${esc(w.talk)}</div>` : "";
            return `<details class="card"><summary>${head}${errLine}</summary>${gate}${talk}${cols}</details>`;
        }).join("");
    }

    const banner = (d.modelStderr && FALLBACK_WARN.test(d.modelStderr)) || fallbackCount > 0
        ? `<div class="alert">⚠ Local-model fallback detected on ${fallbackCount} call(s) — output may be from a fallback provider, not the configured local model. Check the FALLBACK pills below.</div>`
        : "";

    const section = (id: string, title: string, body: string) =>
        body ? `<section><h2 id="${id}">${title}</h2>${body}</section>` : "";

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lucien pipeline — model eval</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
:root{--bg:#0f1115;--panel:#171a21;--ink:#e6e9ef;--mut:#9aa4b2;--line:#262b35;--ok:#1f7a4d;--bad:#9b2c2c;--warn:#8a6d1a;--acc:#3b82f6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:24px 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{margin:0 0 4px;font-size:20px}h2{margin:32px 0 12px;font-size:17px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta{color:var(--mut);font-size:13px}.wrap{padding:0 28px 80px;max-width:1200px;margin:0 auto}
nav{display:flex;gap:14px;margin-top:10px;flex-wrap:wrap}nav a{color:var(--acc);text-decoration:none;font-size:13px}
table.grid,table.sum{border-collapse:collapse;width:100%;margin:8px 0}
table.grid td,table.grid th,table.sum td,table.sum th{border:1px solid var(--line);padding:8px 10px;vertical-align:top;text-align:left}
th{background:var(--panel);font-size:13px;color:var(--mut)}
.title{font-weight:600}.sub{color:var(--mut);font-size:12.5px;margin-top:2px}
ul.labels{margin:6px 0 0;padding-left:18px}ul.labels li{margin:2px 0}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600;color:#fff}
.pill.ok{background:var(--ok)}.pill.bad{background:var(--bad)}.pill.warn{background:var(--warn)}.pill.muted{background:#3a4150;color:var(--mut)}
.err{color:#ff8a8a}.repairs{color:var(--warn);font-size:12.5px;margin-top:6px}
details.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
details.card>summary{cursor:pointer;list-style:none}details.card>summary::-webkit-details-marker{display:none}
details.raw{margin-top:10px}details.raw>summary{cursor:pointer;color:var(--mut);font-size:12.5px}
pre{background:#0b0d11;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;font-size:12.5px;white-space:pre-wrap}
.md{background:#0b0d11;border:1px solid var(--line);border-radius:6px;padding:6px 16px;margin-top:8px}
.md h1{font-size:19px}.md h2{border:0;font-size:16px}.md h3{font-size:14px}.md code{background:#1c2129;padding:1px 4px;border-radius:4px}
.diff{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px}.diff h4{margin:6px 0;color:var(--mut)}
.alert{background:#3a2a0a;border:1px solid var(--warn);color:#ffd479;padding:10px 14px;border-radius:8px;margin:14px 0}
</style></head><body>
<header>
  <h1>Lucien pipeline — model evaluation (dry run)</h1>
  <div class="meta">Model self-ID: <b>${esc(d.modelId)}</b> · <code>pi -p</code> · ${esc(d.startedAt)} · run ${(d.elapsedSec / 60).toFixed(1)} min · ${d.limit}/stage</div>
  <nav>
    ${d.stages.includes("chunk") ? '<a href="#chunk">Chunk</a>' : ""}
    ${d.stages.includes("cluster") ? '<a href="#cluster">Cluster-assign</a>' : ""}
    ${d.stages.includes("synthesize") ? '<a href="#synth">Synthesize</a>' : ""}
    ${d.stages.includes("wikify") ? '<a href="#wikify">Wikify</a>' : ""}
  </nav>
</header>
<div class="wrap">
  ${banner}
  <h2>Summary</h2>
  <table class="sum"><thead><tr><th>Stage</th><th>Samples</th><th>Failures</th><th>Avg latency</th><th>Notes</th></tr></thead><tbody>${summaryRows.join("")}</tbody></table>
  <p class="meta">Methodology: chunk samples the ${d.limit} most-recently-updated conversations; cluster-assign runs on the labels the chunk stage produced; synthesize samples random buckets with 3–60 chunks; wikify samples random articles of 150–5000 words. All prompts/validators are imported from the real pipeline scripts. Nothing was written to the DB or the Dreaming.</p>
  ${section("chunk", "Chunk", chunkHtml)}
  ${section("cluster", "Cluster-assign", clusterHtml)}
  ${section("synth", "Synthesize", synthHtml)}
  ${section("wikify", "Wikify (editorial)", wikifyHtml)}
</div>
<script>
const MD = ${JSON.stringify(md)};
function render(){
  if(!window.marked){setTimeout(render,200);return;}
  document.querySelectorAll('.md[data-md]').forEach(function(el){
    const i = +el.getAttribute('data-md');
    try{ el.innerHTML = marked.parse(MD[i] || ''); }catch(e){ el.textContent = MD[i] || ''; }
  });
}
render();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    const argv = process.argv.slice(2);
    let limit = 25;
    let stages = ["chunk", "cluster", "synthesize", "wikify"];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--limit" && argv[i + 1]) limit = parseInt(argv[++i]!, 10);
        else if (argv[i] === "--stages" && argv[i + 1]) stages = argv[++i]!.split(",").map((s) => s.trim());
    }

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    console.log(`Eval run — limit=${limit}, stages=${stages.join(",")}`);
    console.log(`DB: ${DB_PATH} (readonly)\n`);

    // Capture model identity once.
    console.log("Probing model identity…");
    const probe = await callPi("Identify yourself in one line: model name, provider/API, and version if known.");
    const modelId = probe.stdout.trim().replace(/\s+/g, " ").slice(0, 200) || "(no response)";
    console.log(`  → ${modelId}`);
    if (FALLBACK_WARN.test(probe.stderr)) console.log("  ⚠ fallback warning on probe");

    const db = new Database(DB_PATH, { readonly: true });
    const metaBlock = await loadMetaPolicyBlock();

    let chunkResults: ChunkResult[] = [];
    let producedLabels: string[] = [];
    let clusterResult: ClusterResult | null = null;
    let synthResults: SynthResult[] = [];
    let wikifyResults: WikifyResult[] = [];

    if (stages.includes("chunk")) {
        console.log("\n== Stage: chunk ==");
        const r = await runChunkStage(db, metaBlock, limit);
        chunkResults = r.results;
        producedLabels = r.labels;
    }
    if (stages.includes("cluster")) {
        console.log("\n== Stage: cluster-assign ==");
        clusterResult = await runClusterStage(db, metaBlock, producedLabels, limit);
    }
    if (stages.includes("synthesize")) {
        console.log("\n== Stage: synthesize ==");
        synthResults = await runSynthesizeStage(db, limit);
    }
    if (stages.includes("wikify")) {
        console.log("\n== Stage: wikify ==");
        wikifyResults = await runWikifyStage(limit);
    }

    const elapsedSec = (Date.now() - t0) / 1000;
    const html = buildHtml({
        modelId, modelStderr: probe.stderr, startedAt, elapsedSec, limit, stages,
        chunk: chunkResults, cluster: clusterResult, synth: synthResults, wikify: wikifyResults,
    });

    const reportsDir = join(REPO_ROOT, "reports");
    await mkdir(reportsDir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, "-");
    const outPath = join(reportsDir, `model-eval-${stamp}.html`);
    await writeFile(outPath, html);

    console.log(`\nDone in ${(elapsedSec / 60).toFixed(1)} min.`);
    console.log(`Report: ${outPath}`);
}

await main();
