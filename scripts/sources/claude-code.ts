import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AdapterResult, NormalizedConversation, NormalizedMessage } from "./types.js";
import { LUCIEN_PROMPT_SENTINEL } from "../sentinel.js";

interface IngestClaudeCodeOptions {
    /** Root directory to scan. */
    rootDir: string;
    /** ISO timestamp. Files with mtime <= since are skipped at the file layer. */
    since: string;
}

interface RawEvent {
    type?: string;
    uuid?: string;
    parentUuid?: string | null;
    isSidechain?: boolean;
    timestamp?: string;
    message?: {
        role?: string;
        content?: string | Array<{ type: string; text?: string }>;
    };
}

const KEEP_TYPES = new Set(["user", "assistant"]);
const warnedUnknownTypes = new Set<string>();

function extractText(message: RawEvent["message"]): string {
    const c = message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
            .trim();
    }
    return "";
}

async function parseSession(filePath: string): Promise<NormalizedConversation | null> {
    const sessionId = basename(filePath).replace(/\.jsonl$/, "");
    const text = await Bun.file(filePath).text();
    const messages: NormalizedMessage[] = [];

    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev: RawEvent;
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
        }
        if (!ev.type) continue;
        if (!KEEP_TYPES.has(ev.type)) {
            if (!warnedUnknownTypes.has(ev.type)) {
                warnedUnknownTypes.add(ev.type);
                console.warn(`[claude-code] unknown event type, skipping: ${ev.type}`);
            }
            continue;
        }
        if (ev.isSidechain) continue;
        if (!ev.uuid || !ev.timestamp) continue;

        const extracted = extractText(ev.message);
        if (!extracted) continue;

        messages.push({
            uuid: ev.uuid,
            sender: ev.type as "user" | "assistant",
            text: extracted,
            timestamp: ev.timestamp,
            parent_message_uuid: ev.parentUuid ?? null,
        });
    }

    // Skip Lucien's own orchestration sessions — they begin with our sentinel.
    const firstUser = messages.find((m) => m.sender === "user");
    if (firstUser && firstUser.text.startsWith(LUCIEN_PROMPT_SENTINEL)) {
        console.warn(`[claude-code] skipping Lucien-internal session ${sessionId}`);
        return null;
    }

    if (messages.length === 0) return null;

    const firstUserText = messages.find((m) => m.sender === "user")?.text ?? "";
    return {
        source: "claude-code",
        uuid: sessionId,
        name: firstUserText.slice(0, 80),
        summary: "",
        created_at: messages[0].timestamp,
        updated_at: messages[messages.length - 1].timestamp,
        messages,
    };
}

export async function ingestClaudeCode(
    opts: IngestClaudeCodeOptions
): Promise<AdapterResult> {
    const sinceMs = Date.parse(opts.since);
    const glob = new Glob("**/*.jsonl");
    const conversations: NormalizedConversation[] = [];

    for await (const rel of glob.scan({ cwd: opts.rootDir, absolute: false })) {
        const abs = join(opts.rootDir, rel);
        let s;
        try {
            s = await stat(abs);
        } catch {
            continue;
        }
        if (s.mtimeMs <= sinceMs) continue;

        try {
            const conv = await parseSession(abs);
            if (conv && conv.updated_at > opts.since) conversations.push(conv);
        } catch (err) {
            console.warn(`[claude-code] failed to parse ${rel}: ${(err as Error).message}`);
        }
    }

    let maxTs = opts.since;
    for (const c of conversations) {
        if (c.updated_at > maxTs) maxTs = c.updated_at;
    }

    return {
        conversations,
        new_watermark: maxTs,
        complete: true,
        summary: `claude-code: ${conversations.length} conversations / ${conversations.reduce(
            (n, c) => n + c.messages.length,
            0
        )} messages`,
    };
}
