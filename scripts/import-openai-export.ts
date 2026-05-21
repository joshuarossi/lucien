/**
 * import-openai-export.ts — one-shot importer for a ChatGPT data export.
 *
 * This is NOT a recurring nightly adapter. The OpenAI data export has a
 * specific shape — conversations sharded across `conversations-NNN.json`,
 * each conversation a `mapping` tree keyed by node id with a `current_node`
 * canonical leaf — that you only get from the export, not from scraping
 * chatgpt.com. So it's a manual, run-by-hand backfill; ongoing ChatGPT
 * freshness is a separate (future) Playwright adapter.
 *
 * Re-runnable with a cap so the ~2.4k-conversation backfill can be paced:
 * each run imports the next `--max N` conversations (oldest by create_time)
 * whose id isn't already in the DB, so each batch flows through one
 * nightly pipeline run rather than choking chunk-recent with everything.
 *
 *   bun run scripts/import-openai-export.ts <export-dir> [--max 200] [--dry-run]
 *
 * Pure helpers (linearizeConversation, toNormalized) are exported for tests.
 */
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DB_PATH } from "./state-path.js";
import type { NormalizedConversation, NormalizedMessage } from "./sources/types.js";

interface ExportMessage {
    id?: string;
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    create_time?: number | null;
}
interface ExportNode {
    id?: string;
    message?: ExportMessage | null;
    parent?: string | null;
}
export interface ExportConversation {
    id?: string;
    conversation_id?: string;
    title?: string;
    create_time?: number | null;
    update_time?: number | null;
    current_node?: string | null;
    mapping?: Record<string, ExportNode>;
}

function isoFromEpoch(sec: number | null | undefined): string {
    if (typeof sec !== "number" || !isFinite(sec)) return new Date(0).toISOString();
    return new Date(sec * 1000).toISOString();
}

/** Join the string parts of a message; non-text parts (images, etc.) dropped. */
function extractText(content: ExportMessage["content"]): string {
    const parts = content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
        .filter((p): p is string => typeof p === "string")
        .join("\n\n")
        .trim();
}

/**
 * Linearize one export conversation: walk `current_node` back to the root via
 * `parent` links (this prunes abandoned edit/retry branches automatically),
 * reverse to chronological order, keep only user/assistant message turns with
 * non-empty text. `parent_message_uuid` chains by emission order, since the
 * raw tree parent often points through skipped synthetic/system nodes.
 */
export function linearizeConversation(conv: ExportConversation): NormalizedMessage[] {
    const mapping = conv.mapping ?? {};
    const order: string[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = conv.current_node;
    while (cur && mapping[cur] && !seen.has(cur)) {
        seen.add(cur);
        order.push(cur);
        cur = mapping[cur]!.parent;
    }
    order.reverse(); // root → leaf

    const messages: NormalizedMessage[] = [];
    let prev: string | null = null;
    for (const nodeId of order) {
        const msg = mapping[nodeId]!.message;
        if (!msg) continue; // synthetic root node
        const role = msg.author?.role;
        if (role !== "user" && role !== "assistant") continue; // skip system/tool
        const text = extractText(msg.content);
        if (!text) continue;
        const uuid = msg.id ?? nodeId;
        messages.push({
            uuid,
            sender: role,
            text,
            timestamp: isoFromEpoch(msg.create_time),
            parent_message_uuid: prev,
        });
        prev = uuid;
    }
    return messages;
}

/** Export conversation → NormalizedConversation, or null if it has no real turns. */
export function toNormalized(conv: ExportConversation): NormalizedConversation | null {
    const uuid = conv.id ?? conv.conversation_id;
    if (!uuid) return null;
    const messages = linearizeConversation(conv);
    if (messages.length === 0) return null;
    return {
        source: "chatgpt",
        uuid,
        name: conv.title?.trim() || "Untitled",
        summary: "",
        created_at: isoFromEpoch(conv.create_time),
        updated_at: isoFromEpoch(conv.update_time),
        messages,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Read every `conversations-NNN.json` shard in the export dir into one array. */
async function readShards(exportDir: string): Promise<ExportConversation[]> {
    const all: ExportConversation[] = [];
    const glob = new Glob("conversations-*.json");
    for await (const rel of glob.scan({ cwd: exportDir, onlyFiles: true })) {
        const raw = await readFile(join(exportDir, rel), "utf8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) all.push(...arr);
    }
    return all;
}

function upsert(db: Database, conv: NormalizedConversation): void {
    const insertConv = db.prepare(
        "INSERT OR REPLACE INTO conversations (uuid, name, summary, created_at, updated_at, message_count, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const insertMsg = db.prepare(
        "INSERT OR REPLACE INTO messages (uuid, conversation_uuid, position, sender, text, timestamp, parent_message_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertConv.run(
        conv.uuid, conv.name, conv.summary, conv.created_at,
        conv.updated_at, conv.messages.length, conv.source
    );
    let pos = 0;
    for (const m of conv.messages) {
        insertMsg.run(m.uuid, conv.uuid, pos++, m.sender, m.text, m.timestamp, m.parent_message_uuid);
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const mi = argv.indexOf("--max");
    const max = mi !== -1 && argv[mi + 1] ? parseInt(argv[mi + 1]!, 10) : 200;
    const exportDir = argv.find((a) => !a.startsWith("--") && a !== String(max));
    if (!exportDir) {
        console.error("usage: import-openai-export.ts <export-dir> [--max N] [--dry-run]");
        process.exit(1);
    }

    const shards = await readShards(exportDir);
    console.log(`read ${shards.length} conversations from export`);

    const db = new Database(DB_PATH);
    // Defensive idempotent migration in case the importer is the first writer.
    const cols = db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "source")) {
        db.exec("ALTER TABLE conversations ADD COLUMN source TEXT");
    }
    const existing = new Set(
        (db.query("SELECT uuid FROM conversations").all() as Array<{ uuid: string }>).map((r) => r.uuid)
    );

    // Not-yet-imported, oldest first.
    const pending = shards
        .filter((c) => {
            const id = c.id ?? c.conversation_id;
            return id && !existing.has(id);
        })
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));

    const batch = pending.slice(0, max);
    console.log(
        `${existing.size} conversations already in DB; ${pending.length} pending; importing ${batch.length} (--max ${max})${dryRun ? " [DRY RUN]" : ""}`
    );

    let imported = 0;
    let empty = 0;
    const tx = db.transaction(() => {
        for (const raw of batch) {
            const conv = toNormalized(raw);
            if (!conv) { empty++; continue; }
            if (!dryRun) upsert(db, conv);
            imported++;
        }
    });
    tx();
    db.close();

    console.log(
        `${dryRun ? "would import" : "imported"} ${imported}, skipped ${empty} empty/all-synthetic; ` +
        `${pending.length - batch.length} still pending after this batch`
    );
}

if (import.meta.main) {
    await main();
}
