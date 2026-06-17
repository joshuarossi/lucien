import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { debugLogPath } from "./debug-log.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";
import { validateChunks } from "./chunk-validation.js";
import { loadMetaPolicyBlock } from "./meta-inline.js";

export const CHUNK_PROMPT = `You will analyze ONE conversation between a user and an AI assistant. Identify ALL distinct topic chunks within it.

CRITICAL INSTRUCTIONS:
- Most substantive conversations contain MULTIPLE chunks, not one. Look hard for topic shifts.
- A topic shift happens when the user moves from one subject to a substantially different subject. Examples:
  - Discussing one feature, then asking about a different feature
  - Working through a problem, then pivoting to a related but distinct concern
  - Asking about topic X, then asking about topic Y
- Even within a single broad topic, you should identify sub-chunks for specific aspects.
- Short conversations (under 4 messages) with a single Q&A may legitimately be one chunk. Most longer conversations are multiple chunks.
- Chunks MAY overlap. When a message at a topic boundary is genuinely substantive to BOTH the topic that is ending and the one beginning, include it in BOTH chunks — it is the end_message_uuid of one and falls within the range of the next. Do this only for genuine dual-membership, never for connective filler.

POLICY — the user's editorial policy pages (from /Users/joshrossi/Dreaming/Meta/) are reproduced IN FULL under META POLICY PAGES below. Do not read any files; everything you need is in this prompt. Two things there govern you:
  (1) Ignore rules — do NOT emit a chunk for any span whose subject falls under one; simply omit it.
  (2) Chunking style — the instructions above (how fine a chunk is, how aggressively to overlap vs. draw hard boundaries, when a whole conversation is one chunk) are DEFAULTS. If a Meta doc specifies different chunking-style preferences, follow it over those defaults.
- You MUST still segment the conversation into topic chunks in the output schema below — that is not optional and no Meta doc overrides it. This prompt defines WHAT to do (segment into chunks; this schema); the Meta docs define HOW (granularity, overlap aggressiveness, boundary hardness, what to ignore).

META POLICY PAGES:
{{META_DOCS}}

For each chunk, output:
- start_message_uuid: uuid of the first message in the chunk
- end_message_uuid: uuid of the last message in the chunk
- label: a specific, descriptive label. Aim for 4-10 words. Examples:
  GOOD: "Archie webhook architecture decisions"
  GOOD: "Sirui Aurora 35mm lens purchase deliberation"
  GOOD: "Bayesian updating framing for Lucien synthesis"
  BAD: "Technical discussion"
  BAD: "Q&A about software"
  BAD: "Conversation about Archie"

OUTPUT FORMAT:
Output ONLY a JSON object, nothing else. No markdown fences, no explanation, no preamble.

If the conversation has meaningful content:
{"chunks": [{"start_message_uuid": "...", "end_message_uuid": "...", "label": "..."}, ...]}

If the conversation has no meaningful content (all messages empty or pure noise):
{"chunks": []}

Here is the conversation:
`;

export interface Message {
    uuid: string;
    sender: string;
    text: string;
}

export interface Conversation {
    uuid: string;
    name: string;
    messages: Message[];
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Prompt is passed via stdin, not argv: transcripts routinely exceed
        // the OS ARG_MAX limit and posix_spawn fails with E2BIG.
        const proc = spawn("pi", ["-p"], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let settled = false;
        const stdin = proc.stdin;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            stdin?.destroy();
            reject(err);
        };

        stdin.on("error", fail);

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("exit", (code) => {
            if (settled) return;
            settled = true;
            if (code === 0) resolve(stdout);
            else reject(new Error(`claude exited ${code}: ${stderr}`));
        });
        proc.on("error", fail);

        stdin.end(prompt, "utf8");
    });
}

function extractJSON(response: string): any {
    const trimmed = response.trim();

    // Try direct parse
    try {
        return JSON.parse(trimmed);
    } catch { }

    // Strip markdown fences
    const stripped = trimmed
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/, "");
    try {
        return JSON.parse(stripped);
    } catch { }

    // Find the first { and the matching closing } (greedy from end)
    const firstBrace = response.indexOf("{");
    const lastBrace = response.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = response.slice(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(candidate);
        } catch { }
    }

    throw new Error("Could not extract valid JSON from response");
}

function isRefusalOrPlaceholder(response: string | undefined): boolean {
    if (!response) return true;
    const trimmed = response.trim();
    if (trimmed === "") return true;
    if (trimmed.includes("Response intentionally left blank")) return true;
    if (trimmed.includes("response not yet generated")) return true;
    if (trimmed.includes("Response not yet generated")) return true;
    if (trimmed.includes("I cannot") || trimmed.includes("I can't")) {
        // Only treat as refusal if there's no JSON in the response
        if (!trimmed.includes("{")) return true;
    }
    return false;
}

export function formatConversation(conv: Conversation): string {
    const messages = conv.messages
        .filter((m) => m.text && m.text.trim())
        .map((m) => `[${m.sender}] (uuid: ${m.uuid})\n${m.text}\n`)
        .join("\n---\n");
    return `Conversation: ${conv.name} (uuid: ${conv.uuid})\n\n${messages}`;
}

async function main() {
    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Meta pages are inlined once per run; they change only by hand-edit.
    const chunkPrompt = CHUNK_PROMPT.replace(
        "{{META_DOCS}}",
        await loadMetaPolicyBlock()
    );

    db.exec(`
    CREATE TABLE IF NOT EXISTS chunked_conversations (
      conversation_uuid TEXT PRIMARY KEY,
      chunked_at TEXT NOT NULL,
      status TEXT
    );
  `);

    // Migrate older databases that created chunked_conversations without the
    // `status` column. CREATE TABLE IF NOT EXISTS doesn't add columns to an
    // existing table, so we check via PRAGMA and ALTER if needed.
    const ccCols = db
        .query("PRAGMA table_info(chunked_conversations)")
        .all() as Array<{ name: string }>;
    if (!ccCols.some((c) => c.name === "status")) {
        db.exec("ALTER TABLE chunked_conversations ADD COLUMN status TEXT");
    }

    // Select both new conversations (never chunked) and stale ones (grown since last chunk).
    const todoQuery = db.query(`
    SELECT c.uuid, c.name, c.updated_at,
           CASE
             WHEN cc.conversation_uuid IS NULL THEN 'new'
             ELSE 'stale'
           END AS reason
    FROM conversations c
    LEFT JOIN chunked_conversations cc ON cc.conversation_uuid = c.uuid
    WHERE cc.conversation_uuid IS NULL
       OR c.updated_at > cc.chunked_at
    ORDER BY c.updated_at ASC
  `);
    const todo = todoQuery.all() as {
        uuid: string;
        name: string;
        updated_at: string;
        reason: "new" | "stale";
    }[];

    console.log(`Conversations to process: ${todo.length}`);
    if (todo.length === 0) {
        console.log("Nothing new or grown since last run. Nothing to do.");
        return;
    }

    const newCount = todo.filter((r) => r.reason === "new").length;
    const staleCount = todo.filter((r) => r.reason === "stale").length;
    console.log(`  ${newCount} new, ${staleCount} grown (stale)`);

    const messagesQuery = db.query(`
    SELECT uuid, sender, text
    FROM messages
    WHERE conversation_uuid = ?
    ORDER BY position
  `);

    const deleteStaleChunks = db.prepare(`
    DELETE FROM chunks WHERE conversation_uuid = ?
  `);

    const insertChunk = db.prepare(`
    INSERT INTO chunks (conversation_uuid, start_message_uuid, end_message_uuid, label)
    VALUES (?, ?, ?, ?)
  `);

    const markChunked = db.prepare(`
    INSERT OR REPLACE INTO chunked_conversations (conversation_uuid, chunked_at, status)
    VALUES (?, ?, ?)
  `);

    let totalChunks = 0;
    let i = 0;
    let stats = {
        chunked: 0,
        refreshed_stale: 0,
        empty: 0,
        no_assistant: 0,
        refused: 0,
        errored: 0,
    };

    for (const convMeta of todo) {
        i++;
        const messages = messagesQuery.all(convMeta.uuid) as Message[];
        const nonEmpty = messages.filter((m) => m.text && m.text.trim());

        const reasonLabel =
            convMeta.reason === "stale" ? "stale: refresh" : "new";

        // Skip 1: conversation is fully empty (likely deleted)
        if (nonEmpty.length === 0) {
            console.log(
                `[${i}/${todo.length}] ${convMeta.uuid} — empty/deleted, skipping (${reasonLabel})`
            );
            markChunked.run(convMeta.uuid, new Date().toISOString(), "empty");
            stats.empty++;
            continue;
        }

        // Skip 2: conversation has no assistant response (Claude has nothing to chunk)
        const assistantMessages = nonEmpty.filter((m) => m.sender === "assistant");
        if (assistantMessages.length === 0) {
            console.log(
                `[${i}/${todo.length}] ${convMeta.uuid} — no assistant response, skipping (${reasonLabel})`
            );
            markChunked.run(convMeta.uuid, new Date().toISOString(), "no_assistant");
            stats.no_assistant++;
            continue;
        }

        console.log(
            `[${i}/${todo.length}] ${convMeta.uuid} — ${convMeta.name || "(untitled)"} (${reasonLabel})`
        );

        // For stale conversations, remove old chunks before inserting fresh ones.
        if (convMeta.reason === "stale") {
            deleteStaleChunks.run(convMeta.uuid);
        }

        const conv: Conversation = {
            uuid: convMeta.uuid,
            name: convMeta.name,
            messages,
        };
        const prompt = chunkPrompt + formatConversation(conv);

        let response: string | undefined;
        try {
            response = await callClaude(LUCIEN_PROMPT_SENTINEL + prompt);

            // Detect refusal-like responses before attempting parse
            if (isRefusalOrPlaceholder(response)) {
                console.log(
                    `  → model declined to process (likely content filter), marking complete`
                );
                markChunked.run(convMeta.uuid, new Date().toISOString(), "refused");
                stats.refused++;
                continue;
            }

            const result = extractJSON(response);
            // Repair near-miss anchors (chimera uuids, conversation-uuid
            // pastes) and trailing coverage gaps; throws into the catch
            // below when an anchor is genuinely unresolvable.
            const { chunks, repairs } = validateChunks(
                result.chunks ?? [],
                nonEmpty,
                convMeta.uuid
            );
            for (const repair of repairs) {
                console.log(`  repair: ${repair}`);
            }

            db.transaction(() => {
                for (const chunk of chunks) {
                    insertChunk.run(
                        convMeta.uuid,
                        chunk.start_message_uuid,
                        chunk.end_message_uuid,
                        chunk.label
                    );
                }
                markChunked.run(convMeta.uuid, new Date().toISOString(), "chunked");
            })();

            totalChunks += chunks.length;
            if (convMeta.reason === "stale") {
                stats.refreshed_stale++;
            } else {
                stats.chunked++;
            }
            console.log(`  → ${chunks.length} chunks (running total: ${totalChunks})`);
        } catch (err: any) {
            console.error(`  ERROR: ${err.message}`);
            const debugPath = await debugLogPath(`lucien-debug-${convMeta.uuid}.txt`);
            try {
                await writeFile(
                    debugPath,
                    `PROMPT:\n${prompt}\n\n---\n\nRESPONSE:\n${response ?? "(undefined - call failed)"
                    }`
                );
                console.error(`  Raw response saved to ${debugPath}`);
            } catch { }
            stats.errored++;
            // Don't mark complete; will retry on next run
        }
    }

    const finalCount = db.query("SELECT COUNT(*) as n FROM chunks").get() as {
        n: number;
    };
    console.log(`\nDone.`);
    console.log(`  Total chunks in database: ${finalCount.n}`);
    console.log(`  Stats:`);
    console.log(`    Chunked (new): ${stats.chunked}`);
    console.log(`    Refreshed (stale): ${stats.refreshed_stale}`);
    console.log(`    Empty/deleted: ${stats.empty}`);
    console.log(`    No assistant response: ${stats.no_assistant}`);
    console.log(`    Refused by model: ${stats.refused}`);
    console.log(`    Errored: ${stats.errored}`);
}

if (import.meta.main) {
    await main();
}
