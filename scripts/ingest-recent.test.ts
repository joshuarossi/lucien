import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { runIngestRecent } from "./ingest-recent.js";

let dreamingDir: string;
let claudeCodeDir: string;

beforeEach(async () => {
    dreamingDir = await mkdtemp(join(tmpdir(), "lucien-dream-"));
    claudeCodeDir = await mkdtemp(join(tmpdir(), "lucien-cc-"));

    // Copy claude-code fixtures into the temp Claude Code dir
    const srcRoot = join(import.meta.dir, "sources/fixtures/claude-code");
    const glob = new Glob("**/*.jsonl");
    for await (const rel of glob.scan({ cwd: srcRoot, absolute: false })) {
        const dst = join(claudeCodeDir, rel);
        await mkdir(join(dst, ".."), { recursive: true });
        await copyFile(join(srcRoot, rel), dst);
    }
});

afterEach(async () => {
    await rm(dreamingDir, { recursive: true, force: true });
    await rm(claudeCodeDir, { recursive: true, force: true });
});

/**
 * Build a fake Playwright BrowserContext whose evaluate() returns scripted
 * responses in order. Used to drive the claude.ai adapter without a real
 * Playwright profile.
 */
function fakeClaudeAiContext(responses: Array<{ status: number; body: unknown }>) {
    let idx = 0;
    const fakePage = {
        async goto() {},
        async evaluate() {
            const r = responses[idx++];
            if (!r) throw new Error("unexpected evaluate call beyond scripted responses");
            return r;
        },
    };
    return {
        pages() {
            return [fakePage];
        },
        async newPage() {
            return fakePage;
        },
        async close() {},
    } as unknown as import("playwright").BrowserContext;
}

/** A minimal pair of scripted responses: 1 org, 1 conversation, with one user message. */
function scriptedClaudeAi() {
    return [
        { status: 200, body: [{ uuid: "org-1" }] },
        {
            status: 200,
            body: [
                {
                    uuid: "claude-ai-conv-1",
                    name: "Test web chat",
                    summary: "",
                    created_at: "2026-05-10T09:00:00.000Z",
                    updated_at: "2026-05-10T09:05:00.000Z",
                },
            ],
        },
        {
            status: 200,
            body: {
                uuid: "claude-ai-conv-1",
                name: "Test web chat",
                summary: "",
                created_at: "2026-05-10T09:00:00.000Z",
                updated_at: "2026-05-10T09:05:00.000Z",
                current_leaf_message_uuid: "wm1",
                chat_messages: [
                    {
                        uuid: "wm1",
                        sender: "human",
                        parent_message_uuid: null,
                        created_at: "2026-05-10T09:00:00.000Z",
                        content: [{ type: "text", text: "hello from web" }],
                    },
                ],
            },
        },
    ];
}

test("end-to-end: ingests both sources, writes sqlite, persists watermarks", async () => {
    const result = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        claudeAiContext: fakeClaudeAiContext(scriptedClaudeAi()),
        sleepMs: 0,
    });

    expect(result.claudeCode.conversations.length).toBeGreaterThan(0);
    expect(result.claudeAi.conversations.length).toBe(1);
    expect(result.claudeAi.conversations[0].uuid).toBe("claude-ai-conv-1");

    const db = new Database(join(dreamingDir, ".lucien", "lucien.db"));
    const convCount = (db.query("SELECT COUNT(*) as n FROM conversations").get() as { n: number }).n;
    const msgCount = (db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
    expect(convCount).toBe(
        result.claudeCode.conversations.length + result.claudeAi.conversations.length
    );
    expect(msgCount).toBeGreaterThan(0);
    db.close();
});

test("second run is a no-op when nothing has changed", async () => {
    // First run populates everything.
    await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        claudeAiContext: fakeClaudeAiContext(scriptedClaudeAi()),
        sleepMs: 0,
    });

    // Second run with the SAME scripted responses (same updated_at on the
    // single web conv) — watermark should filter it out, Claude Code mtime
    // hasn't moved, so we expect zero new conversations.
    const r2 = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        claudeAiContext: fakeClaudeAiContext(scriptedClaudeAi()),
        sleepMs: 0,
    });

    expect(r2.claudeCode.conversations.length).toBe(0);
    expect(r2.claudeAi.conversations.length).toBe(0);
});

test("writes state.json with both per-source watermarks", async () => {
    await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        claudeAiContext: fakeClaudeAiContext(scriptedClaudeAi()),
        sleepMs: 0,
    });
    const state = JSON.parse(
        await Bun.file(join(dreamingDir, ".lucien", "state.json")).text()
    );
    expect(state.claude_code.last_ingest_at).toMatch(/^\d{4}-/);
    expect(state.claude_ai.last_ingest_at).toMatch(/^\d{4}-/);
});

test("claude-ai failure: claude-code source still ingests", async () => {
    // Org list fails immediately → claude.ai returns empty, complete=false.
    const failingContext = fakeClaudeAiContext([{ status: 500, body: null }]);
    const result = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        claudeAiContext: failingContext,
        sleepMs: 0,
    });
    expect(result.claudeCode.conversations.length).toBeGreaterThan(0);
    expect(result.claudeAi.conversations).toEqual([]);
    expect(result.claudeAi.complete).toBe(false);
});
