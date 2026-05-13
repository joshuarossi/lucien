import { test, expect } from "bun:test";
import { access } from "node:fs/promises";
import { ingestClaudeAi } from "./claude-ai.js";
import { PLAYWRIGHT_PROFILE_PATH as PROFILE } from "../state-path.js";

async function profileExists(): Promise<boolean> {
    try {
        await access(PROFILE);
        return true;
    } catch {
        return false;
    }
}

test("missing profile: returns empty result with helpful summary, complete=false", async () => {
    const result = await ingestClaudeAi({
        profilePath: "/tmp/lucien-nonexistent-profile-" + Date.now(),
        since: "1970-01-01T00:00:00.000Z",
        sleepMs: 0,
    });
    expect(result.conversations).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.summary).toMatch(/profile/i);
});

// This integration test only runs when the user has logged in via
// scripts/auth-claude-ai-login.ts. Skipped otherwise so CI / fresh
// clones don't fail.
const hasProfile = await profileExists();
const maybe = hasProfile ? test : test.skip;

maybe(
    "integration: fetches against real claude.ai with logged-in profile (slow)",
    async () => {
        const result = await ingestClaudeAi({
            profilePath: PROFILE,
            since: "2099-01-01T00:00:00.000Z", // future = empty result, just exercises auth path
            sleepMs: 0,
            authTimeoutMs: 1000, // don't wait for a human in CI / smoke runs
        });
        // Either the org list succeeds and filtering produces zero (since=future),
        // or we get a clean auth failure summary. Both are valid signals that the
        // pipeline executed end-to-end without crashing.
        expect(result.conversations).toEqual([]);
        expect(typeof result.summary).toBe("string");
    },
    60_000
);

test("watermark freezes at first failure even when a later conversation succeeds", async () => {
    // Responses are heterogeneous: org list is wrapped in {status,body},
    // the list-probe response is {successes,failures}, tree fetches are
    // wrapped in {status,body} again. Just use any[].
    const responses: any[] = [
        // /api/organizations  → wrapped as {status, body}
        { status: 200, body: [{ uuid: "org-1", name: "personal" }] },
        // List probe returns {successes, failures} directly (not wrapped).
        // Use `any` for the response slot to allow heterogeneous shapes.
        {
            successes: [
                {
                    orgId: "org-1",
                    orgName: "personal",
                    items: [
                        {
                            uuid: "convA",
                            name: "A",
                            summary: "",
                            created_at: "2026-05-10T10:00:00.000Z",
                            updated_at: "2026-05-10T10:00:00.000Z",
                        },
                        {
                            uuid: "convB",
                            name: "B",
                            summary: "",
                            created_at: "2026-05-10T11:00:00.000Z",
                            updated_at: "2026-05-10T11:00:00.000Z",
                        },
                        {
                            uuid: "convC",
                            name: "C",
                            summary: "",
                            created_at: "2026-05-10T12:00:00.000Z",
                            updated_at: "2026-05-10T12:00:00.000Z",
                        },
                    ],
                },
            ],
            failures: [],
        } as any,
        {
            status: 200,
            body: {
                uuid: "convA",
                name: "A",
                summary: "",
                created_at: "2026-05-10T10:00:00.000Z",
                updated_at: "2026-05-10T10:00:00.000Z",
                current_leaf_message_uuid: "mA",
                chat_messages: [
                    {
                        uuid: "mA",
                        sender: "human",
                        parent_message_uuid: null,
                        created_at: "2026-05-10T10:00:00.000Z",
                        content: [{ type: "text", text: "a" }],
                    },
                ],
            },
        },
        { status: 500, body: null },
        {
            status: 200,
            body: {
                uuid: "convC",
                name: "C",
                summary: "",
                created_at: "2026-05-10T12:00:00.000Z",
                updated_at: "2026-05-10T12:00:00.000Z",
                current_leaf_message_uuid: "mC",
                chat_messages: [
                    {
                        uuid: "mC",
                        sender: "human",
                        parent_message_uuid: null,
                        created_at: "2026-05-10T12:00:00.000Z",
                        content: [{ type: "text", text: "c" }],
                    },
                ],
            },
        },
    ];

    let idx = 0;
    const fakePage = {
        async goto() {},
        async evaluate() {
            const r = responses[idx++];
            if (!r) return responses[responses.length - 1];
            return r;
        },
    };
    const fakeCtx = {
        pages() {
            return [fakePage];
        },
        async newPage() {
            return fakePage;
        },
        async close() {},
    } as unknown as import("playwright").BrowserContext;

    const result = await ingestClaudeAi({
        context: fakeCtx,
        since: "1970-01-01T00:00:00.000Z",
        sleepMs: 0,
    });

    expect(result.conversations.map((c) => c.uuid)).toEqual(["convA", "convC"]);
    expect(result.complete).toBe(false);
    expect(result.new_watermark).toBe("2026-05-10T10:00:00.000Z");
});
