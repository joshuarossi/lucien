/**
 * normalize-footnotes.ts — deterministic footnote-integrity repair.
 *
 * Synthesis is *told* (in synthesize-update.ts) to keep `[^N]` markers and
 * `[^N]:` definitions bijective and contiguous, and to self-verify. It
 * violates this on large articles anyway (orphan markers like `[^22]` with
 * no definition, gaps in numbering), which makes wikify's gate reject the
 * article every night. Prompt instruction is advisory; this pass makes the
 * invariant constitutive — it ENFORCES it deterministically after synthesis,
 * before wikify.
 *
 * Repair policy (user decision 2026-05-19):
 *   - orphan body marker (`[^k]` with no `[^k]:` def): the citation was
 *     never written (no conv:HASH exists), nothing recoverable — drop the
 *     dangling marker from the prose, leave the sentence intact.
 *   - orphan definition (`[^k]:` with no body marker): unused reference —
 *     drop the line.
 *   - then renumber the survivors 1..N in order of first body appearance.
 *   - every drop is recorded in an auditable Talk-page note.
 * A healthy article (already passes checkFootnoteIntegrity) is returned
 * byte-identical — the pass is a no-op, hence idempotent and churn-free.
 *
 * Pure helpers are exported for tests; the CLI runs behind import.meta.main.
 */
import { readFile, writeFile, readdir, appendFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { checkFootnoteIntegrity } from "./wikify.ts";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");
const TALK_PATH = join(DREAMING_PATH, "Talk");

const DEF_LINE = /^[ \t]*\[\^(\d+)\]:/;

export interface NormalizeResult {
    article: string;
    changed: boolean;
    droppedMarkers: number[];
    droppedDefs: { num: number; conv: string | null }[];
    talk: string | null;
}

/** Distinct body-marker numbers in order of first appearance (defs masked). */
function bodyMarkerOrder(text: string): number[] {
    const masked = text
        .split("\n")
        .map((l) => (DEF_LINE.test(l) ? "" : l))
        .join("\n");
    const order: number[] = [];
    const seen = new Set<number>();
    for (const m of masked.matchAll(/\[\^(\d+)\]/g)) {
        const n = parseInt(m[1]!, 10);
        if (!seen.has(n)) {
            seen.add(n);
            order.push(n);
        }
    }
    return order;
}

/**
 * Deterministically repair footnote integrity. No-op (byte-identical,
 * changed=false) when the article already passes checkFootnoteIntegrity.
 */
export function normalizeFootnotes(article: string): NormalizeResult {
    if (checkFootnoteIntegrity(article).ok) {
        return {
            article,
            changed: false,
            droppedMarkers: [],
            droppedDefs: [],
            talk: null,
        };
    }

    const defNums = new Set<number>();
    const defConv = new Map<number, string | null>();
    for (const line of article.split("\n")) {
        const m = line.match(/^[ \t]*\[\^(\d+)\]:(.*)$/);
        if (m) {
            const n = parseInt(m[1]!, 10);
            defNums.add(n);
            const c = m[2]!.match(/conv:[0-9a-f]{8}/i);
            defConv.set(n, c ? c[0]!.toLowerCase() : null);
        }
    }

    const bodyOrder = bodyMarkerOrder(article);
    const bodySet = new Set(bodyOrder);

    const kept = bodyOrder.filter((n) => defNums.has(n)); // marker AND def
    const droppedMarkers = bodyOrder.filter((n) => !defNums.has(n));
    const droppedDefs = [...defNums]
        .filter((n) => !bodySet.has(n))
        .sort((a, b) => a - b)
        .map((n) => ({ num: n, conv: defConv.get(n) ?? null }));

    // old -> new, contiguous from 1 in body order.
    const remap = new Map<number, number>();
    kept.forEach((oldN, i) => remap.set(oldN, i + 1));

    const dropMarkerSet = new Set(droppedMarkers);
    const dropDefSet = new Set(droppedDefs.map((d) => d.num));

    const out = article
        .split("\n")
        .filter((line) => {
            const m = line.match(DEF_LINE);
            return !(m && dropDefSet.has(parseInt(m[1]!, 10)));
        })
        .map((line) => {
            // Drop orphan markers (with an optional single leading space so
            // we don't leave `word  .`); renumber the rest. Definition-line
            // prefixes carry `[^k]` too and are renumbered by the same map.
            return line.replace(
                /[ \t]?\[\^(\d+)\]/g,
                (whole, num: string) => {
                    const n = parseInt(num, 10);
                    if (dropMarkerSet.has(n)) return "";
                    const nn = remap.get(n);
                    // Preserve a leading space we may have consumed.
                    const lead = /^[ \t]/.test(whole) ? whole[0]! : "";
                    return nn ? `${lead}[^${nn}]` : whole;
                }
            );
        })
        .join("\n");

    const post = checkFootnoteIntegrity(out);
    if (!post.ok) {
        // Should never happen; fail loud rather than emit broken output.
        throw new Error(
            `normalize-footnotes post-condition failed: ${post.errors.join("; ")}`
        );
    }

    const parts: string[] = [];
    if (droppedMarkers.length) {
        parts.push(
            `Dropped ${droppedMarkers.length} orphan citation marker(s) — ` +
                droppedMarkers.map((n) => `[^${n}]`).join(", ") +
                ` — synthesis emitted the marker but no definition; no \`conv:HASH\` ever existed, so nothing was recoverable. Prose text left intact.`
        );
    }
    if (droppedDefs.length) {
        parts.push(
            `Dropped ${droppedDefs.length} unused definition(s): ` +
                droppedDefs
                    .map((d) => `[^${d.num}]${d.conv ? ` (\`${d.conv}\`)` : ""}`)
                    .join(", ") +
                ` — no body marker referenced them.`
        );
    }
    parts.push("Renumbered surviving footnotes contiguously from 1.");
    const talk = parts.join(" ");

    return {
        article: out,
        changed: out !== article,
        droppedMarkers,
        droppedDefs,
        talk,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fileExists(p: string): Promise<boolean> {
    return access(p).then(
        () => true,
        () => false
    );
}

async function resolveStems(argv: string[]): Promise<string[]> {
    const bi = argv.indexOf("--bucket");
    if (bi !== -1 && argv[bi + 1]) return [argv[bi + 1]!];
    const files = await readdir(ARTICLES_PATH);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}

function gitCommit(message: string, paths: string[]): Promise<void> {
    return new Promise((resolve) => {
        const add = spawn("git", ["add", "--", ...paths], {
            cwd: DREAMING_PATH,
            stdio: "ignore",
        });
        add.on("exit", () => {
            const c = spawn("git", ["commit", "-m", message], {
                cwd: DREAMING_PATH,
                stdio: "ignore",
            });
            c.on("exit", () => resolve());
            c.on("error", () => resolve());
        });
        add.on("error", () => resolve());
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const stems = await resolveStems(argv);
    console.log(
        `normalize-footnotes: ${stems.length} article(s)${dryRun ? " [DRY RUN]" : ""}`
    );
    const stamp = new Date().toISOString().slice(0, 10);
    let repaired = 0;

    for (const stem of stems) {
        const articlePath = join(ARTICLES_PATH, `${stem}.md`);
        if (!(await fileExists(articlePath))) continue;
        const original = await readFile(articlePath, "utf8");
        let r: NormalizeResult;
        try {
            r = normalizeFootnotes(original);
        } catch (err) {
            console.log(`  ERRORED ${stem} — ${(err as Error).message}`);
            continue;
        }
        if (!r.changed) continue;
        repaired++;
        const detail =
            `${r.droppedMarkers.length} orphan marker(s), ` +
            `${r.droppedDefs.length} orphan def(s)`;
        if (dryRun) {
            console.log(`  WOULD-FIX ${stem} — ${detail}`);
            continue;
        }
        await writeFile(articlePath, r.article);
        const paths = [`articles/${stem}.md`];
        if (r.talk) {
            const talkPath = join(TALK_PATH, `${stem}.md`);
            await appendFile(
                talkPath,
                `\n## ${stamp} — footnote normalization\n\n${r.talk}\n`
            );
            paths.push(`Talk/${stem}.md`);
        }
        await gitCommit(`Normalize footnotes: ${stem}`, paths);
        console.log(`  FIXED ${stem} — ${detail}`);
    }
    console.log(
        `Summary: ${repaired} repaired, ${stems.length - repaired} already valid`
    );
}

if (import.meta.main) {
    await main();
}
