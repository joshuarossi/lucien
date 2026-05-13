import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { PLAYWRIGHT_PROFILE_PATH } from "./state-path.js";

export interface LoginOptions {
    profilePath?: string;
    headless?: boolean;
    /** Max seconds to wait for the user to finish logging in. Default 300. */
    timeoutSeconds?: number;
}

/**
 * Opens a real Chromium window pointed at claude.ai. The user signs in
 * (or confirms they are already signed in). On return, the profile directory
 * holds the cookies needed for headless runs.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<void> {
    const profilePath = opts.profilePath ?? PLAYWRIGHT_PROFILE_PATH;
    const headless = opts.headless ?? false;
    const timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;

    await mkdir(profilePath, { recursive: true });

    const ctx = await chromium.launchPersistentContext(profilePath, {
        headless,
        viewport: { width: 1280, height: 800 },
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded" });

    console.log(
        "[auth] Sign in to claude.ai in the opened window. " +
            "Waiting for an authenticated session..."
    );

    // The /api/organizations endpoint returns 200 only when authenticated.
    // We poll it from inside the page until success or timeout.
    const start = Date.now();
    let lastStatus = 0;
    while (Date.now() - start < timeoutMs) {
        lastStatus = await page.evaluate(async () => {
            const r = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return r.status;
        });
        if (lastStatus === 200) break;
        await new Promise((r) => setTimeout(r, 2000));
    }

    if (lastStatus !== 200) {
        await ctx.close();
        throw new Error(
            `[auth] Did not detect a signed-in session within ${
                opts.timeoutSeconds ?? 300
            }s (last status: ${lastStatus}).`
        );
    }

    console.log(`[auth] Signed in. Profile saved at ${profilePath}.`);
    await ctx.close();
}

if (import.meta.main) {
    await loginInteractive();
}
