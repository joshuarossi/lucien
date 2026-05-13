import { chromium, type BrowserContext } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import type { AdapterResult, NormalizedConversation } from "./types.js";
import {
    filterListBySince,
    treeToNormalizedConversation,
    type ConvListItem,
    type ConvTree,
} from "./claude-ai-linearize.js";

export interface IngestClaudeAiOptions {
    /** Path to the Playwright persistent-context profile directory. */
    profilePath?: string;
    /** ISO timestamp watermark. */
    since: string;
    /** Sleep between conversation fetches (ms). Default 1000; tests can pass 0. */
    sleepMs?: number;
    /** Inject a context for tests. If provided, profilePath is ignored. */
    context?: BrowserContext;
}

const DEFAULT_PROFILE = join(homedir(), ".lucien", "playwright-profile");

async function profileExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

export async function ingestClaudeAi(
    opts: IngestClaudeAiOptions
): Promise<AdapterResult> {
    const profilePath = opts.profilePath ?? DEFAULT_PROFILE;
    const sleepMs = opts.sleepMs ?? 1000;

    let ctx: BrowserContext;
    let ownsCtx = false;
    if (opts.context) {
        ctx = opts.context;
    } else {
        if (!(await profileExists(profilePath))) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: no profile at ${profilePath}. Run scripts/auth-claude-ai-login.ts first.`,
            };
        }
        ctx = await chromium.launchPersistentContext(profilePath, { headless: true });
        ownsCtx = true;
    }

    try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded" });

        // 1. Org list
        const orgsRes = await page.evaluate(async () => {
            const r = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return { status: r.status, body: r.status === 200 ? await r.json() : null };
        });
        if (orgsRes.status === 401) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary:
                    "claude-ai: profile is no longer authenticated (401). Re-run scripts/auth-claude-ai-login.ts.",
            };
        }
        if (orgsRes.status !== 200 || !orgsRes.body?.length) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: org list failed with status ${orgsRes.status}`,
            };
        }
        const orgId = (orgsRes.body as Array<{ uuid: string }>)[0].uuid;

        // 2. Conversation list
        const listRes = await page.evaluate(async (oid: string) => {
            const r = await fetch(`/api/organizations/${oid}/chat_conversations`, {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return { status: r.status, body: r.status === 200 ? await r.json() : null };
        }, orgId);
        if (listRes.status !== 200) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: conversation list failed with status ${listRes.status}`,
            };
        }
        const items = listRes.body as ConvListItem[];
        const fresh = filterListBySince(items, opts.since);

        // 3. Per-conversation tree fetch
        //
        // Watermark advancement stops at the first failure. We still try
        // later conversations in this run (so the user gets whatever data
        // is available now), but they do not advance the watermark — that
        // way the next run resumes at the failed item rather than skipping
        // permanently past it.
        const conversations: NormalizedConversation[] = [];
        let watermark = opts.since;
        let watermarkFrozen = false;
        let complete = true;

        for (let i = 0; i < fresh.length; i++) {
            const item = fresh[i];
            if (i > 0 && sleepMs > 0) {
                await new Promise((r) => setTimeout(r, sleepMs));
            }
            const treeRes = await page.evaluate(
                async ([oid, cid]: [string, string]) => {
                    const u = `/api/organizations/${oid}/chat_conversations/${cid}?tree=True&rendering_mode=messages&render_all_tools=true`;
                    const r = await fetch(u, {
                        credentials: "include",
                        headers: { Accept: "application/json" },
                    });
                    return { status: r.status, body: r.status === 200 ? await r.json() : null };
                },
                [orgId, item.uuid] as [string, string]
            );
            if (treeRes.status !== 200 || !treeRes.body) {
                console.warn(`[claude-ai] ${item.uuid} → status ${treeRes.status}, skipping`);
                complete = false;
                watermarkFrozen = true;
                continue;
            }
            const conv = treeToNormalizedConversation(treeRes.body as ConvTree);
            if (conv) conversations.push(conv);
            if (!watermarkFrozen) {
                watermark = new Date(item.updated_at).toISOString();
            }
        }

        return {
            conversations,
            new_watermark: watermark,
            complete,
            summary: `claude-ai: ${conversations.length} conversations / ${conversations.reduce(
                (n, c) => n + c.messages.length,
                0
            )} messages`,
        };
    } finally {
        if (ownsCtx) await ctx.close();
    }
}
