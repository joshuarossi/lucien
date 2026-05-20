import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCodexCli } from "./codex-cli.ts";

/** Build a fake Codex rollout file with the line shapes the adapter expects. */
async function writeRollout(
    rootDir: string,
    sessionId: string,
    yyyy: string,
    mm: string,
    dd: string,
    lines: Record<string, unknown>[]
): Promise<string> {
    const dir = join(rootDir, yyyy, mm, dd);
    await mkdir(dir, { recursive: true });
    const ts = `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
    const filename = `rollout-${ts.replace(/[:.]/g, "-")}-${sessionId}.jsonl`;
    const path = join(dir, filename);
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
}

test("codex-cli adapter: parses a real-shaped rollout file, skips synthetic users", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucien-codex-test-"));
    await writeFile(
        join(root, "session_index.jsonl"),
        JSON.stringify({
            id: "test-session-1",
            thread_name: "Refactor auth module",
            updated_at: "2026-05-01T12:00:00Z",
        }) + "\n"
    );
    await writeRollout(root, "test-session-1", "2026", "05", "01", [
        {
            timestamp: "2026-05-01T12:00:00Z",
            type: "session_meta",
            payload: { id: "test-session-1", timestamp: "2026-05-01T12:00:00Z", cwd: "/x" },
        },
        // Synthetic "user" — AGENTS.md injection; must be filtered.
        {
            timestamp: "2026-05-01T12:00:01Z",
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "# AGENTS.md instructions for /x\n..." }],
            },
        },
        // Developer-role message — must be skipped on role alone.
        {
            timestamp: "2026-05-01T12:00:02Z",
            type: "response_item",
            payload: {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: "<permissions instructions>" }],
            },
        },
        // Real user input — keep.
        {
            timestamp: "2026-05-01T12:00:03Z",
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Help me refactor the auth flow." }],
            },
        },
        // event_msg — operational, skip.
        { timestamp: "2026-05-01T12:00:04Z", type: "event_msg", payload: { kind: "thinking" } },
        // Assistant reply — keep.
        {
            timestamp: "2026-05-01T12:00:05Z",
            type: "response_item",
            payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Sure — let's start by mapping the current paths." }],
            },
        },
    ]);

    const r = await ingestCodexCli({
        rootDir: root,
        indexPath: join(root, "session_index.jsonl"),
        since: "1970-01-01T00:00:00.000Z",
    });

    expect(r.complete).toBe(true);
    expect(r.conversations.length).toBe(1);
    const c = r.conversations[0]!;
    expect(c.source).toBe("codex-cli");
    expect(c.uuid).toBe("test-session-1");
    expect(c.name).toBe("Refactor auth module");
    // Synthetic user + developer + event_msg all filtered; 2 real messages.
    expect(c.messages.length).toBe(2);
    expect(c.messages[0]!.sender).toBe("user");
    expect(c.messages[0]!.text).toBe("Help me refactor the auth flow.");
    expect(c.messages[1]!.sender).toBe("assistant");
    expect(c.messages[1]!.text).toContain("mapping the current paths");
    expect(c.messages[1]!.parent_message_uuid).toBe(c.messages[0]!.uuid);
});

test("codex-cli adapter: empty sessions dir returns no conversations", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucien-codex-empty-"));
    const r = await ingestCodexCli({
        rootDir: root,
        indexPath: join(root, "session_index.jsonl"),
        since: "1970-01-01T00:00:00.000Z",
    });
    expect(r.conversations.length).toBe(0);
    expect(r.complete).toBe(true);
});

test("codex-cli adapter: rollout with only synthetic users is skipped entirely", async () => {
    const root = await mkdtemp(join(tmpdir(), "lucien-codex-synthetic-"));
    await writeRollout(root, "s2", "2026", "05", "02", [
        {
            timestamp: "2026-05-02T00:00:00Z",
            type: "session_meta",
            payload: { id: "s2", timestamp: "2026-05-02T00:00:00Z" },
        },
        {
            timestamp: "2026-05-02T00:00:01Z",
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }],
            },
        },
    ]);
    const r = await ingestCodexCli({
        rootDir: root,
        since: "1970-01-01T00:00:00.000Z",
    });
    expect(r.conversations.length).toBe(0);
});
