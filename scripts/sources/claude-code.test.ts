import { test, expect } from "bun:test";
import { join } from "node:path";
import { ingestClaudeCode } from "./claude-code.js";

const FIXTURES = join(import.meta.dir, "fixtures/claude-code");

test("basic session: maps user/assistant events to NormalizedMessages", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });

    const basic = result.conversations.find((c) => c.uuid === "session-basic");
    expect(basic).toBeDefined();
    expect(basic!.source).toBe("claude-code");
    expect(basic!.messages.length).toBe(4);

    expect(basic!.messages[0]).toMatchObject({
        uuid: "u1",
        sender: "user",
        text: "What is the capital of France?",
        timestamp: "2026-05-10T10:00:00.000Z",
        parent_message_uuid: null,
    });
    expect(basic!.messages[1]).toMatchObject({
        uuid: "a1",
        sender: "assistant",
        text: "The capital of France is Paris.",
    });
    expect(basic!.messages[3].text).toBe("Berlin.");
});

test("with-tools session: drops tool calls, tool results, sidechain, unknown types", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });

    const wt = result.conversations.find((c) => c.uuid === "session-with-tools");
    expect(wt).toBeDefined();
    const uuids = wt!.messages.map((m) => m.uuid);
    expect(uuids).toEqual(["u1", "a1", "a2"]);
    expect(wt!.messages[1].text).toBe("Sure."); // tool_use block stripped, only text kept
});

test("derives conversation name from first user message, truncated to 80 chars", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    const basic = result.conversations.find((c) => c.uuid === "session-basic")!;
    expect(basic.name).toBe("What is the capital of France?");
});

test("derives created_at and updated_at from first/last kept messages", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    const basic = result.conversations.find((c) => c.uuid === "session-basic")!;
    expect(basic.created_at).toBe("2026-05-10T10:00:00.000Z");
    expect(basic.updated_at).toBe("2026-05-10T10:01:08.000Z");
});

test("watermark gate: skips files whose mtime is older than `since`", async () => {
    // since == future → all files filtered out at mtime layer
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "2099-01-01T00:00:00.000Z",
    });
    expect(result.conversations).toEqual([]);
});

test("returns new_watermark = max message timestamp seen across all conversations", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    // Max across fixtures is 2026-05-11T09:00:05.000Z (a2 in with-tools)
    expect(result.new_watermark).toBe("2026-05-11T09:00:05.000Z");
});

test("complete is true on successful run", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
});
