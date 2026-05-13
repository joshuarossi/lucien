import { chromium, type BrowserContext } from "playwright";
import { access } from "node:fs/promises";
import type { AdapterResult, NormalizedConversation } from "./types.js";
import {
    filterListBySince,
    treeToNormalizedConversation,
    type ConvListItem,
    type ConvTree,
} from "./claude-ai-linearize.js";
import { PLAYWRIGHT_PROFILE_PATH } from "../state-path.js";

export interface IngestClaudeAiOptions {
    /** Path to the Playwright persistent-context profile directory. */
    profilePath?: string;
    /** ISO timestamp watermark. */
    since: string;
    /** Sleep between conversation fetches (ms). Default 1000; tests can pass 0. */
    sleepMs?: number;
    /** Max time to wait for the user to solve a Cloudflare challenge. Default 5 min. */
    authTimeoutMs?: number;
    /** Inject a context for tests. If provided, profilePath is ignored. */
    context?: BrowserContext;
    /**
     * Optional predicate: return true if a conversation is already in the
     * local DB at this updated_at (so we can skip the expensive tree fetch).
     * Production wiring queries sqlite; tests can stub it.
     */
    isAlreadyIngested?: (uuid: string, updated_at: string) => boolean | Promise<boolean>;
}

async function profileExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Patch the obvious automation signals Cloudflare's bot detection looks at.
 * Runs before any page script on every navigation. Combined with launching
 * real Chrome (channel:chrome) and suppressing --enable-automation, this is
 * enough for CF to treat the session as a regular browser.
 */
async function applyStealth(ctx: BrowserContext): Promise<void> {
    // Runs in the browser context, not Node — Navigator / window are globals there.
    await ctx.addInitScript(`
        Object.defineProperty(Navigator.prototype, "webdriver", {
            get: () => false,
            configurable: true,
        });
        if (typeof window.chrome === "undefined") {
            window.chrome = { runtime: {} };
        }
        Object.defineProperty(navigator, "languages", {
            get: () => ["en-US", "en"],
        });
    `);
}

export async function ingestClaudeAi(
    opts: IngestClaudeAiOptions
): Promise<AdapterResult> {
    const profilePath = opts.profilePath ?? PLAYWRIGHT_PROFILE_PATH;
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
        // headless: false because Cloudflare detects headless Chromium fingerprints
        // (navigator.webdriver, missing window features) and blocks the request
        // with 403 even when the persistent profile holds valid sessionKey +
        // cf_clearance cookies. A short-lived visible window is the trade-off.
        ctx = await chromium.launchPersistentContext(profilePath, {
            headless: false,
            channel: "chrome",
            ignoreDefaultArgs: ["--enable-automation"],
            args: ["--disable-blink-features=AutomationControlled"],
        });
        await applyStealth(ctx);
        ownsCtx = true;
    }

    try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded" });

        // 1. Org list — poll because Cloudflare may be presenting an interactive
        // "verify you are human" challenge. The first time around, the user
        // clicks the checkbox in the visible window and Cloudflare sets a
        // cf_clearance cookie that the persistent profile retains for ~30 days.
        // On subsequent runs the poll usually succeeds on the first attempt.
        const AUTH_TIMEOUT_MS = opts.authTimeoutMs ?? 5 * 60 * 1000;
        const POLL_INTERVAL_MS = 2000;
        const pollStart = Date.now();
        let orgsRes: { status: number; body: Array<{ uuid: string }> | null } = {
            status: 0,
            body: null,
        };
        let warnedHuman = false;
        while (Date.now() - pollStart < AUTH_TIMEOUT_MS) {
            orgsRes = await page.evaluate(async () => {
                const r = await fetch("/api/organizations", {
                    credentials: "include",
                    headers: { Accept: "application/json" },
                });
                return { status: r.status, body: r.status === 200 ? await r.json() : null };
            });
            if (orgsRes.status === 200) break;
            if (orgsRes.status === 401) break;
            // 5xx and other non-CF errors: stop polling. The server isn't
            // going to heal mid-loop, and we want a fast, deterministic exit
            // for tests and for production diagnostics alike.
            if (orgsRes.status >= 500) break;
            if (!warnedHuman && (orgsRes.status === 403 || orgsRes.status === 0)) {
                console.warn(
                    "[claude-ai] Cloudflare challenge detected — solve the 'Verify you are human' checkbox in the open Chromium window. Subsequent runs reuse the resulting cf_clearance cookie for ~30 days."
                );
                warnedHuman = true;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
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
        const orgs = orgsRes.body as Array<{ uuid: string; name?: string }>;

        // 2. Conversation list. Some orgs (e.g. corporate workspaces) deny
        // chat_conversations reads with "Invalid authorization for organization".
        // Try every org and aggregate from the ones that work.
        const listResult = await page.evaluate(async (orgList: Array<{ uuid: string; name?: string }>) => {
            const successes: Array<{ orgId: string; orgName?: string; items: unknown[] }> = [];
            const failures: Array<{ orgId: string; orgName?: string; status: number; bodyHead: string }> = [];
            for (const o of orgList) {
                const url = `/api/organizations/${o.uuid}/chat_conversations`;
                const r = await fetch(url, {
                    credentials: "include",
                    headers: { Accept: "application/json" },
                });
                if (r.status === 200) {
                    const body = await r.json();
                    successes.push({ orgId: o.uuid, orgName: o.name, items: body as unknown[] });
                } else {
                    const head = (await r.text()).slice(0, 200);
                    failures.push({ orgId: o.uuid, orgName: o.name, status: r.status, bodyHead: head });
                }
            }
            return { successes, failures };
        }, orgs);

        if (listResult.successes.length === 0) {
            console.warn(
                `[claude-ai] every org rejected chat_conversations read:\n${listResult.failures
                    .map((f) => `  ${f.status} org=${f.orgId} (${f.orgName ?? "?"}) :: ${f.bodyHead}`)
                    .join("\n")}`
            );
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: no readable orgs (${listResult.failures.length} attempted)`,
            };
        }

        for (const f of listResult.failures) {
            console.warn(
                `[claude-ai] skipping org ${f.orgId} (${f.orgName ?? "?"}): ${f.status}`
            );
        }
        console.log(
            `[claude-ai] reading from ${listResult.successes.length} org(s): ${listResult.successes
                .map((s) => `${s.orgName ?? s.orgId}=${s.items.length}`)
                .join(", ")}`
        );

        // Flatten items across all readable orgs, keeping track of which org
        // each item came from so the per-conversation tree fetch hits the
        // right endpoint.
        const itemsWithOrg = listResult.successes.flatMap((s) =>
            (s.items as ConvListItem[]).map((it) => ({ ...it, _orgId: s.orgId }))
        );
        const fresh = filterListBySince(itemsWithOrg, opts.since) as Array<
            ConvListItem & { _orgId: string }
        >;

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

        let skippedCached = 0;
        for (let i = 0; i < fresh.length; i++) {
            const item = fresh[i];
            const progress = `${i + 1}/${fresh.length}`;

            // DB pre-check: if we already have this conversation at this updated_at,
            // skip the expensive tree fetch entirely. (Sqlite INSERT OR REPLACE
            // would still produce the right end state, but this avoids the round
            // trip to claude.ai, which is the slow part.)
            if (opts.isAlreadyIngested) {
                const cached = await opts.isAlreadyIngested(item.uuid, item.updated_at);
                if (cached) {
                    skippedCached++;
                    if (!watermarkFrozen) {
                        watermark = new Date(item.updated_at).toISOString();
                    }
                    if (skippedCached % 25 === 0) {
                        console.log(`[claude-ai] ${progress} — ${skippedCached} cached so far`);
                    }
                    continue;
                }
            }

            if (sleepMs > 0) {
                await new Promise((r) => setTimeout(r, sleepMs));
            }
            console.log(`[claude-ai] ${progress} fetching ${item.uuid} (${item.name ?? ""})`);
            const treeRes = await page.evaluate(
                async ([oid, cid]: [string, string]) => {
                    const u = `/api/organizations/${oid}/chat_conversations/${cid}?tree=True&rendering_mode=messages&render_all_tools=true`;
                    const r = await fetch(u, {
                        credentials: "include",
                        headers: { Accept: "application/json" },
                    });
                    return { status: r.status, body: r.status === 200 ? await r.json() : null };
                },
                [item._orgId, item.uuid] as [string, string]
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
        if (skippedCached > 0) {
            console.log(`[claude-ai] skipped ${skippedCached} already-cached conversations`);
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
