/**
 * relabel-collect.ts — validate + merge sub-agent ideal-chunking outputs into the
 * v3 ideal-label cache. Reads relabel/out/<windowId>.json (each {"chunks":[...]}),
 * reconstructs each window's messages from the DB to verify anchors resolve WITHIN
 * the window and tile cleanly (no overlap>1 / nested / unresolved), then writes the
 * accepted set to ideal-labels.json keyed by windowId. curate-chunk-v3.ts folds it
 * in on the next run.
 *
 *   bun run scripts/relabel-collect.ts [--out-base DIR] [--cache FILE]
 */
import { Database } from "bun:sqlite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH, REPO_ROOT } from "./state-path.js";

function arg(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : def;
}
function extractJSON(s: string): any {
    try { return JSON.parse(s); } catch {}
    const t = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch {}
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    return null;
}

interface ChunkRow { start_message_uuid: string; end_message_uuid: string; label: string }

function validate(chunks: ChunkRow[], winUuids: string[]): { ok: boolean; reason?: string } {
    if (!Array.isArray(chunks) || chunks.length === 0) return { ok: false, reason: "no chunks" };
    const pos = new Map(winUuids.map((u, i) => [u, i]));
    const ranges: [number, number][] = [];
    for (const c of chunks) {
        if (!c?.start_message_uuid || !c?.end_message_uuid || !c?.label) return { ok: false, reason: "missing field" };
        const s = pos.get(c.start_message_uuid), e = pos.get(c.end_message_uuid);
        if (s === undefined || e === undefined) return { ok: false, reason: `anchor not in window: ${(c.label || "").slice(0, 30)}` };
        ranges.push([Math.min(s, e), Math.max(s, e)]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
        const [as, ae] = ranges[i]!, [bs, be] = ranges[j]!;
        if (Math.min(ae, be) - Math.max(as, bs) + 1 > 1) return { ok: false, reason: "overlap>1" };
        if ((bs >= as && be <= ae) || (as >= bs && ae <= be)) return { ok: false, reason: "nested" };
    }
    return { ok: true };
}

async function main() {
    const outBase = arg("--out-base", join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "relabel"))!;
    const cachePath = arg("--cache", join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "ideal-labels.json"))!;
    const outDir = join(outBase, "out");
    if (!existsSync(outDir)) { console.error(`no out dir: ${outDir}`); process.exit(1); }

    const db = new Database(DB_PATH, { readonly: true });
    const msgQ = db.query(`SELECT uuid, sender, text FROM messages WHERE conversation_uuid=? ORDER BY position`);
    const convCache = new Map<string, string[]>();   // convUuid → nonempty msg uuids in order
    const winUuids = (windowId: string): string[] => {
        const [convUuid, range] = windowId.split(":");
        const [a, b] = range!.split("-").map((n) => parseInt(n, 10));
        if (!convCache.has(convUuid!)) {
            const ms = (msgQ.all(convUuid!) as { uuid: string; text: string }[]).filter((m) => m.text && m.text.trim()).map((m) => m.uuid);
            convCache.set(convUuid!, ms);
        }
        return convCache.get(convUuid!)!.slice(a, b! + 1);
    };

    const cache: Record<string, { chunks: ChunkRow[]; source: string }> = existsSync(cachePath)
        ? JSON.parse(await readFile(cachePath, "utf8")) : {};

    // Prod chunk counts per window (from the manifest) — to AUDIT the merge against
    // the recoverability asymmetry: a large prod→ideal reduction is where the merge
    // lever could have crossed into a dangerous UNDER-split. We flag these for a
    // verification pass rather than trusting them silently.
    const manifestPath = join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "relabel-manifest.json");
    const prodCount = new Map<string, number>();
    if (existsSync(manifestPath)) {
        const m = JSON.parse(await readFile(manifestPath, "utf8"));
        for (const w of m.windows) prodCount.set(w.windowId, w.nProdChunks);
    }

    const files = (await readdir(outDir)).filter((f) => f.endsWith(".json"));
    let accepted = 0, rejected = 0; const rejReasons: string[] = [];
    let prodChunkSum = 0, idealChunkSum = 0;
    const aggressive: { windowId: string; prod: number; ideal: number }[] = [];
    for (const f of files) {
        const windowId = f.replace(/\.json$/, "");
        const raw = await readFile(join(outDir, f), "utf8");
        const parsed = extractJSON(raw);
        const chunks: ChunkRow[] = parsed?.chunks;
        const uuids = winUuids(windowId);
        const v = validate(chunks, uuids);
        if (!v.ok) { rejected++; rejReasons.push(`${windowId.slice(0, 12)}: ${v.reason}`); continue; }
        cache[windowId] = { chunks: chunks.map((c) => ({ start_message_uuid: c.start_message_uuid, end_message_uuid: c.end_message_uuid, label: c.label })), source: "opus-rubric" };
        accepted++; idealChunkSum += chunks.length;
        const prod = prodCount.get(windowId);
        if (prod !== undefined) {
            prodChunkSum += prod;
            // Under-split risk: ≥2 chunks removed AND at least halved, or any ≥3→1 collapse.
            if ((prod - chunks.length >= 2 && chunks.length <= prod / 2) || (prod >= 3 && chunks.length === 1)) {
                aggressive.push({ windowId, prod, ideal: chunks.length });
            }
        }
    }

    await writeFile(cachePath, JSON.stringify(cache, null, 2));
    aggressive.sort((a, b) => (b.prod - b.ideal) - (a.prod - a.ideal));
    const auditPath = join(REPO_ROOT, "benchmark", "finetune", "chunk-v3", "aggressive-merges.json");
    await writeFile(auditPath, JSON.stringify({ builtAt: new Date().toISOString(), count: aggressive.length, note: "windows where the merge cut chunk count hard — verify these did not fuse distinct topics (the irreversible error)", windows: aggressive }, null, 2));

    console.log(`relabel-collect: ${accepted} accepted, ${rejected} rejected → ${cachePath} (cache now ${Object.keys(cache).length} windows)`);
    if (accepted && prodChunkSum) console.log(`  merge effect (this batch): ${prodChunkSum} prod → ${idealChunkSum} ideal chunks (${(100 * (1 - idealChunkSum / prodChunkSum)).toFixed(0)}% fewer)`);
    console.log(`  AGGRESSIVE merges flagged for verification: ${aggressive.length} → ${auditPath}`);
    if (aggressive.length) console.log(`   ${aggressive.slice(0, 12).map((a) => `${a.windowId.slice(0, 16)} ${a.prod}→${a.ideal}`).join("\n   ")}`);
    if (rejected) console.log(`  rejections:\n   ${rejReasons.slice(0, 20).join("\n   ")}`);
}
main();
