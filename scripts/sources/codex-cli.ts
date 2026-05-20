/**
 * Codex CLI source adapter.
 *
 * Codex stores each session as a JSONL "rollout" file under
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ts>-<session-uuid>.jsonl
 *
 * The first line of every file is `{type:"session_meta", payload:{id,...}}`;
 * subsequent lines are a mix of `response_item` (the actual messages),
 * `event_msg`, and `turn_context` (operational events we ignore).
 *
 * Within `response_item`, `payload.type === "message"` carries the chat
 * turns. `payload.role` is one of {user, assistant, developer} — we keep
 * user/assistant only. `payload.content[]` has `{type, text}` blocks
 * where user blocks are `input_text` and assistant blocks are
 * `output_text`. Both expose `.text`.
 *
 * One real wrinkle: Codex injects synthetic "user" messages at session
 * start (AGENTS.md instructions, <permissions>, <app-context>, etc.).
 * These are role=user but aren't actually the user typing. We strip
 * them via a prefix list, same pattern as LUCIEN_HISTORIC_PROMPT_PREFIXES
 * but for a different concern.
 *
 * `~/.codex/session_index.jsonl` is a partial catalog (recent sessions
 * only — older rollouts aren't always indexed). We use it as a
 * thread_name lookup when available and fall back to "Untitled".
 */
import { Glob } from "bun";
import { stat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AdapterResult, NormalizedConversation, NormalizedMessage } from "./types.js";

interface IngestCodexCliOptions {
    /** Root sessions directory — defaults to ~/.codex/sessions. */
    rootDir?: string;
    /** ~/.codex/session_index.jsonl path for thread-name lookups. */
    indexPath?: string;
    /** ISO timestamp. Files with mtime <= since are skipped at the file layer. */
    since: string;
}

interface RolloutEvent {
    timestamp?: string;
    type?: string;
    payload?: {
        id?: string;
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        timestamp?: string;
    };
}

interface SessionIndexRow {
    id: string;
    thread_name?: string;
    updated_at?: string;
}

/**
 * Prefixes that mark a role="user" event as a synthetic injection rather
 * than something the user actually typed. Add new entries if a Codex
 * release introduces a new context-injection wrapper.
 */
const SYNTHETIC_USER_PREFIXES = [
    "# AGENTS.md",
    "<INSTRUCTIONS>",
    "<permissions",
    "<app-context>",
    "<user_instructions>",
    "<environment_info>",
    "<environment_context>",
];

function isSyntheticUserText(text: string): boolean {
    const head = text.trimStart();
    return SYNTHETIC_USER_PREFIXES.some((p) => head.startsWith(p));
}

function extractText(content: RolloutEvent["payload"] extends infer P ? (P extends { content?: infer C } ? C : never) : never): string;
function extractText(content: Array<{ type?: string; text?: string }> | undefined): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => typeof b?.text === "string" && b.text.length > 0)
        .map((b) => b.text as string)
        .join("\n\n")
        .trim();
}

async function loadThreadNameIndex(indexPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const raw = await readFile(indexPath, "utf-8");
        for (const line of raw.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
                const row = JSON.parse(t) as SessionIndexRow;
                if (row.id && row.thread_name) map.set(row.id, row.thread_name);
            } catch {
                // ignore malformed lines
            }
        }
    } catch {
        // index file may not exist on a fresh install; no fatal
    }
    return map;
}

/**
 * Parse one rollout JSONL file into a normalized conversation.
 * Returns null if the file has no real user/assistant turns after filtering.
 */
async function parseRolloutFile(
    path: string,
    threadNames: Map<string, string>
): Promise<NormalizedConversation | null> {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;

    let sessionId: string | undefined;
    let createdAt: string | undefined;
    let lastTimestamp: string | undefined;
    const messages: NormalizedMessage[] = [];
    let prevUuid: string | null = null;
    let msgIndex = 0;

    for (const line of lines) {
        let ev: RolloutEvent;
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
        }

        if (ev.timestamp) lastTimestamp = ev.timestamp;

        if (ev.type === "session_meta") {
            sessionId = ev.payload?.id;
            createdAt = ev.payload?.timestamp ?? ev.timestamp;
            continue;
        }

        if (
            ev.type !== "response_item" ||
            ev.payload?.type !== "message" ||
            !ev.payload?.role
        ) {
            continue;
        }

        const role = ev.payload.role;
        if (role !== "user" && role !== "assistant") continue;

        const text = extractText(ev.payload.content);
        if (!text) continue;
        if (role === "user" && isSyntheticUserText(text)) continue;

        // Stable, deterministic uuid: session + index. Codex doesn't expose
        // per-message ids in response_item payloads.
        const uuid = `${sessionId ?? basename(path)}-msg-${msgIndex++}`;
        const msg: NormalizedMessage = {
            uuid,
            sender: role,
            text,
            timestamp: ev.timestamp ?? createdAt ?? new Date(0).toISOString(),
            parent_message_uuid: prevUuid,
        };
        messages.push(msg);
        prevUuid = uuid;
    }

    if (!sessionId || messages.length === 0) return null;

    const updatedAt =
        lastTimestamp ?? messages[messages.length - 1]?.timestamp ?? createdAt!;
    const name = threadNames.get(sessionId) ?? "Untitled";

    return {
        source: "codex-cli",
        uuid: sessionId,
        name,
        summary: "",
        created_at: createdAt ?? updatedAt,
        updated_at: updatedAt,
        messages,
    };
}

export async function ingestCodexCli(
    opts: IngestCodexCliOptions
): Promise<AdapterResult> {
    const rootDir = opts.rootDir ?? join(homedir(), ".codex", "sessions");
    const indexPath = opts.indexPath ?? join(homedir(), ".codex", "session_index.jsonl");
    const sinceMs = new Date(opts.since).getTime();

    let threadNames: Map<string, string>;
    try {
        threadNames = await loadThreadNameIndex(indexPath);
    } catch {
        threadNames = new Map();
    }

    const conversations: NormalizedConversation[] = [];
    let newest = opts.since;
    let scanned = 0;
    let kept = 0;
    let skipped = 0;
    let errored = 0;

    // YYYY/MM/DD/rollout-*.jsonl tree. Use a Glob to walk lazily.
    const glob = new Glob("**/rollout-*.jsonl");
    for await (const rel of glob.scan({ cwd: rootDir, onlyFiles: true, absolute: false })) {
        scanned++;
        const full = join(rootDir, rel);
        let mtime: number;
        try {
            mtime = (await stat(full)).mtimeMs;
        } catch {
            errored++;
            continue;
        }
        if (mtime <= sinceMs) {
            skipped++;
            continue;
        }
        try {
            const conv = await parseRolloutFile(full, threadNames);
            if (!conv) {
                skipped++;
                continue;
            }
            conversations.push(conv);
            if (conv.updated_at > newest) newest = conv.updated_at;
            kept++;
        } catch {
            errored++;
        }
    }

    return {
        conversations,
        new_watermark: newest,
        complete: errored === 0,
        summary: `codex-cli: scanned ${scanned} rollout(s), ingested ${kept}, skipped ${skipped}, errored ${errored}`,
    };
}
