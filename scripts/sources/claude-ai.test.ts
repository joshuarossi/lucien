import { test, expect } from "bun:test";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestClaudeAi } from "./claude-ai.js";

const PROFILE = join(homedir(), ".lucien", "playwright-profile");

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
        });
        // Either the org list succeeds and filtering produces zero (since=future),
        // or we get a clean auth failure summary. Both are valid signals that the
        // pipeline executed end-to-end without crashing.
        expect(result.conversations).toEqual([]);
        expect(typeof result.summary).toBe("string");
    },
    60_000
);
