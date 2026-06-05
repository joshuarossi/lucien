import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { debugLogPath } from "./debug-log.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";

const CHUNK_PROMPT = `You will analyze ONE conversation between a user and an AI assistant. Identify ALL distinct topic chunks within it.

CRITICAL INSTRUCTIONS:
- Most substantive conversations contain MULTIPLE chunks, not one. Look hard for topic shifts.
- A topic shift happens when the user moves from one subject to a substantially different subject. Examples:
  - Discussing one feature, then asking about a different feature
  - Working through a problem, then pivoting to a related but distinct concern
  - Asking about topic X, then asking about topic Y
- Even within a single broad topic, you should identify sub-chunks for specific aspects.
- Short conversations (under 4 messages) with a single Q&A may legitimately be one chunk. Most longer conversations are multiple chunks.

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

interface Message {
    uuid: string;
    sender: string;
    text: string;
}

interface Conversation {
    uuid: string;
    name: string;
    messages: Message[];
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Prompt is passed via stdin, not argv: transcripts routinely exceed
        // the OS ARG_MAX limit and posix_spawn fails with E2BIG.
        const proc = spawn("claude", ["-p", "--model", "opus"], {
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

function formatConversation(conv: Conversation): string {
    const messages = conv.messages
        .filter((m) => m.text && m.text.trim())
        .map((m) => `[${m.sender}] (uuid: ${m.uuid})\n${m.text}\n`)
        .join("\n---\n");
    return `Conversation: ${conv.name} (uuid: ${conv.uuid})\n\n${messages}`;
}

async function main() {
    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    db.exec(`
    CREATE TABLE IF NOT EXISTS chunked_conversations (
      conversation_uuid TEXT PRIMARY KEY,
      chunked_at TEXT NOT NULL,
      status TEXT
    );
  `);

    const todoQuery = db.query(`
    SELECT c.uuid, c.name 
    FROM conversations c
    WHERE c.uuid NOT IN (SELECT conversation_uuid FROM chunked_conversations)
    ORDER BY c.updated_at ASC
  `);
    const todo = todoQuery.all() as { uuid: string; name: string }[];

    console.log(`Conversations to chunk: ${todo.length}`);
    if (todo.length === 0) {
        console.log("All conversations already chunked. Nothing to do.");
        return;
    }

    const messagesQuery = db.query(`
    SELECT uuid, sender, text 
    FROM messages 
    WHERE conversation_uuid = ? 
    ORDER BY position
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
        empty: 0,
        no_assistant: 0,
        refused: 0,
        errored: 0,
    };

    for (const convMeta of todo) {
        i++;
        const messages = messagesQuery.all(convMeta.uuid) as Message[];
        const nonEmpty = messages.filter((m) => m.text && m.text.trim());

        // Skip 1: conversation is fully empty (likely deleted)
        if (nonEmpty.length === 0) {
            console.log(`[${i}/${todo.length}] ${convMeta.uuid} — empty/deleted, skipping`);
            markChunked.run(convMeta.uuid, new Date().toISOString(), "empty");
            stats.empty++;
            continue;
        }

        // Skip 2: conversation has no assistant response (Claude has nothing to chunk)
        const assistantMessages = nonEmpty.filter((m) => m.sender === "assistant");
        if (assistantMessages.length === 0) {
            console.log(
                `[${i}/${todo.length}] ${convMeta.uuid} — no assistant response, skipping`
            );
            markChunked.run(convMeta.uuid, new Date().toISOString(), "no_assistant");
            stats.no_assistant++;
            continue;
        }

        console.log(
            `[${i}/${todo.length}] ${convMeta.uuid} — ${convMeta.name || "(untitled)"}`
        );

        const conv: Conversation = {
            uuid: convMeta.uuid,
            name: convMeta.name,
            messages,
        };
        const prompt = CHUNK_PROMPT + formatConversation(conv);

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
            const chunks = result.chunks ?? [];

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
            stats.chunked++;
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
    console.log(`    Chunked: ${stats.chunked}`);
    console.log(`    Empty/deleted: ${stats.empty}`);
    console.log(`    No assistant response: ${stats.no_assistant}`);
    console.log(`    Refused by model: ${stats.refused}`);
    console.log(`    Errored: ${stats.errored}`);
}

await main();