/**
 * Nightly synthesis dispatcher.
 *
 * Decomposes the synthesis stage into an inspectable plan + isolated workers:
 *
 *   1. Manifest  — pure function of DB state (zero token cost). For every bucket,
 *                   classify into create / update / backfill / orphan / skip and
 *                   emit `{ bucket: { mode, chunkIds } }` as JSON.
 *   2. Dispatch  — run a sliding pool of `synthesize-update.ts --only-bucket <name>`
 *                   child processes at `--concurrency N` (default 1). Each child is
 *                   the per-article worker: one bucket, one `claude` call, flat
 *                   minimal context, self-committing.
 *
 * The chunk→bucket judgement already happened upstream (cluster-assign-recent.ts);
 * the manifest is just a query over `chunk_buckets` minus `synthesized_bucket_chunks`.
 *
 * See docs/superpowers/specs/2026-05-16-synthesis-per-article-workers-design.md
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH, REPO_ROOT } from "./state-path.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(SCRIPT_DIR, "synthesize-update.ts");
const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");

// Heuristic: claude reports rate-limit / 5-hour-window exhaustion in stderr.
// Best-effort — there is no documented machine-readable signal — so this is
// intentionally broad. A false positive only stops launching NEW workers; the
// run resumes cleanly on re-invocation because synthesized_bucket_chunks makes
// the pipeline idempotent.
const RATE_LIMIT_RE =
    /usage limit|rate.?limit|5-hour|too many requests|exceeded.{0,24}limit|overloaded/i;

type Mode = "create" | "update" | "backfill" | "orphan" | "skip";

interface ManifestEntry {
    bucket: string;
    mode: Mode;
    chunkIds: number[];
}

interface CLIArgs {
    concurrency: number;
    dryRun: boolean;
    onlyBucket?: string;
}

function parseArgs(): CLIArgs {
    const args: CLIArgs = { concurrency: 1, dryRun: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--concurrency" && argv[i + 1]) {
            const n = parseInt(argv[i + 1]!, 10);
            if (!Number.isFinite(n) || n < 1) {
                console.error(`Invalid --concurrency "${argv[i + 1]}" (must be an integer >= 1)`);
                process.exit(1);
            }
            args.concurrency = n;
            i++;
        } else if (a === "--only-bucket" && argv[i + 1]) {
            args.onlyBucket = argv[i + 1];
            i++;
        } else if (a === "--dry-run") {
            args.dryRun = true;
        }
    }
    return args;
}

function bucketToFilename(name: string): string {
    return name.replace(/\s+/g, "_") + ".md";
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the work manifest from DB state + what's on disk. Deterministic, no
 * model call. Mirrors the branch classification in synthesize-update.ts so the
 * plan matches exactly what a worker would do.
 */
async function buildManifest(
    db: Database,
    onlyBucket?: string
): Promise<{ actionable: ManifestEntry[]; orphans: string[]; skipped: number }> {
    // Idempotent: a fresh DB may not have this table yet (synthesize-update
    // creates it lazily). Creating it empty here is harmless and keeps the
    // manifest query from throwing.
    db.exec(`
        CREATE TABLE IF NOT EXISTS synthesized_bucket_chunks (
            bucket_name TEXT NOT NULL,
            chunk_id INTEGER NOT NULL,
            synthesized_at TEXT NOT NULL,
            PRIMARY KEY (bucket_name, chunk_id)
        );
    `);

    let buckets = db
        .query("SELECT name FROM buckets ORDER BY name")
        .all() as { name: string }[];

    if (onlyBucket) {
        buckets = buckets.filter((b) => b.name === onlyBucket);
        if (buckets.length === 0) {
            console.error(`Bucket "${onlyBucket}" not found.`);
            process.exit(1);
        }
    }

    const assignedQuery = db.query(
        "SELECT chunk_id FROM chunk_buckets WHERE bucket_name = ? ORDER BY chunk_id"
    );
    const newQuery = db.query(`
        SELECT chunk_id FROM chunk_buckets
        WHERE bucket_name = ?
          AND chunk_id NOT IN (
              SELECT chunk_id FROM synthesized_bucket_chunks WHERE bucket_name = ?
          )
        ORDER BY chunk_id
    `);
    const historyCountQuery = db.query(
        "SELECT COUNT(*) AS n FROM synthesized_bucket_chunks WHERE bucket_name = ?"
    );

    const actionable: ManifestEntry[] = [];
    const orphans: string[] = [];
    let skipped = 0;

    for (const { name } of buckets) {
        const assigned = (assignedQuery.all(name) as { chunk_id: number }[]).map(
            (r) => r.chunk_id
        );
        const newIds = (newQuery.all(name, name) as { chunk_id: number }[]).map(
            (r) => r.chunk_id
        );
        const hasHistory =
            (historyCountQuery.get(name) as { n: number }).n > 0;
        const articleExists = await exists(
            join(ARTICLES_PATH, bucketToFilename(name))
        );

        let mode: Mode;
        let chunkIds: number[] = [];

        if (!articleExists && hasHistory) {
            // Synthesis history but the file is gone — worker would only warn.
            // Don't spawn a process for it; just report.
            orphans.push(name);
            continue;
        } else if (articleExists && !hasHistory) {
            // One-time backfill migration (no claude call in the worker).
            mode = "backfill";
            chunkIds = [];
        } else if (!articleExists && !hasHistory && assigned.length > 0) {
            mode = "create";
            chunkIds = assigned;
        } else if (articleExists && hasHistory && newIds.length > 0) {
            mode = "update";
            chunkIds = newIds;
        } else {
            // New bucket with no chunks, or existing article with no new material.
            mode = "skip";
            skipped++;
            continue;
        }

        actionable.push({ bucket: name, mode, chunkIds });
    }

    return { actionable, orphans, skipped };
}

/** Spawn one worker for one bucket. Resolves with its outcome. */
function runWorker(
    bucket: string
): Promise<{ bucket: string; ok: boolean; rateLimited: boolean; tailLine: string }> {
    return new Promise((resolve) => {
        const proc = spawn(
            "bun",
            ["run", WORKER_SCRIPT, "--only-bucket", bucket],
            { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] }
        );

        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.stderr.on("data", (d) => (err += d.toString()));

        const finish = (ok: boolean) => {
            const combined = out + "\n" + err;
            const rateLimited = RATE_LIMIT_RE.test(combined);
            // Last non-empty stdout line is the worker's own summary of this bucket
            // (→ created / → updated / — no new material / — backfill / ERROR).
            const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
            const tailLine = lines[lines.length - 1] ?? (ok ? "(no output)" : "(failed, no output)");
            resolve({ bucket, ok, rateLimited, tailLine });
        };

        proc.on("exit", (code) => finish(code === 0));
        proc.on("error", (e) => {
            err += String(e);
            finish(false);
        });
    });
}

async function main() {
    const args = parseArgs();

    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH, { readonly: false });

    const { actionable, orphans, skipped } = await buildManifest(
        db,
        args.onlyBucket
    );
    db.close();

    // The inspectable artifact: { bucket: { mode, chunkIds } }
    const manifestObj: Record<string, { mode: Mode; chunkIds: number[] }> = {};
    for (const e of actionable) {
        manifestObj[e.bucket] = { mode: e.mode, chunkIds: e.chunkIds };
    }

    console.log("\n=== MANIFEST ===");
    console.log(JSON.stringify(manifestObj, null, 2));
    const created = actionable.filter((e) => e.mode === "create").length;
    const updates = actionable.filter((e) => e.mode === "update").length;
    const backfills = actionable.filter((e) => e.mode === "backfill").length;
    console.log(
        `\n${actionable.length} actionable (${updates} update, ${created} create, ` +
        `${backfills} backfill), ${orphans.length} orphan, ${skipped} skipped.`
    );
    if (orphans.length > 0) {
        console.log(
            `Orphaned (synthesis history but article file missing — check the Dreaming):`
        );
        for (const o of orphans) console.log(`  - ${o}`);
    }

    if (args.dryRun) {
        console.log("\nDRY RUN — no workers spawned, no tokens spent.");
        return;
    }

    if (actionable.length === 0) {
        console.log("\nNothing to do.");
        return;
    }

    console.log(
        `\nDispatching ${actionable.length} worker(s) at concurrency ${args.concurrency}...\n`
    );

    const queue = [...actionable];
    let okCount = 0;
    let failCount = 0;
    let stoppedForRateLimit = false;
    const startTime = Date.now();
    let started = 0;

    async function workerLoop(): Promise<void> {
        while (true) {
            if (stoppedForRateLimit) return;
            const entry = queue.shift();
            if (!entry) return;
            started++;
            const idx = started;
            console.log(
                `[${idx}/${actionable.length}] → ${entry.bucket} (${entry.mode}` +
                `${entry.chunkIds.length ? `, ${entry.chunkIds.length} chunk(s)` : ""})`
            );
            const res = await runWorker(entry.bucket);
            if (res.ok) {
                okCount++;
                console.log(`    ${entry.bucket}: ${res.tailLine}`);
            } else {
                failCount++;
                console.log(`    ${entry.bucket}: FAILED — ${res.tailLine}`);
            }
            if (res.rateLimited && !stoppedForRateLimit) {
                stoppedForRateLimit = true;
                console.warn(
                    `\n!! Rate-limit / usage-window signal detected from worker "${entry.bucket}". ` +
                    `Halting: no new workers will start; in-flight workers will finish.\n` +
                    `   Re-run later — synthesized_bucket_chunks makes this idempotent, ` +
                    `so only unfinished articles will remain in the manifest.`
                );
            }
        }
    }

    const pool = Math.min(args.concurrency, actionable.length);
    await Promise.all(Array.from({ length: pool }, () => workerLoop()));

    const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
    const notRun = queue.length;
    console.log(`\nDone in ${elapsedMin} minutes.`);
    console.log(`  Workers succeeded: ${okCount}`);
    console.log(`  Workers failed:    ${failCount}`);
    if (notRun > 0) {
        console.log(
            `  Not started:       ${notRun}` +
            (stoppedForRateLimit ? " (halted on rate-limit signal)" : "")
        );
    }
    if (failCount > 0 || notRun > 0) {
        console.log(
            `  Failed/unstarted buckets keep their chunks un-synthesized and ` +
            `reappear in the next run's manifest.`
        );
    }
    if (stoppedForRateLimit) process.exit(3);
}

await main();
