import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { debugLogPath } from "./debug-log.js";

const CLAUDE_CWD = join(homedir(), "Dreaming");

const TAXONOMY_PROMPT = `You will analyze a list of topic labels extracted from a user's conversations with AI assistants. Your job is to produce a coherent bucket taxonomy — a set of named buckets that organize these topics into a meaningful structure.

Each bucket represents a distinct area, project, topic, or theme. Buckets become the article names in the user's personal wiki, so they should be:
- Specific enough to be useful (not generic like "Technology" or "Work")
- Broad enough to contain multiple related labels (not so narrow that each chunk is its own bucket)
- Named clearly in noun-phrase form (e.g., "Archie Project", "Cinematography and Color Science", "AI Memory Systems")

Aim for 30-60 buckets total. You may produce fewer if the content concentrates in clear areas, or more if there is genuine diversity that resists compression.

Look for:
- Named projects (specific tools, products, codebases)
- Named people (collaborators, mentors, family)
- Domain areas (photography, color science, web development)
- Recurring concepts and methods (composition patterns, mental models, aphorisms)
- Specific technologies (named tools, frameworks, services)

A chunk's label may belong in multiple buckets — that's expected and fine. Your job here is only to produce the bucket list, not to assign labels yet.

OUTPUT FORMAT:
Output ONLY a JSON object, nothing else. No markdown fences, no preamble, no explanation.

{
  "buckets": [
    {"name": "Archie Project", "description": "Brief description of what content belongs here"},
    {"name": "Cinematography and Color Science", "description": "..."},
    ...
  ]
}

Here are the labels:

`;

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Prompt is passed via stdin, not argv: the full label set can exceed
        // the OS ARG_MAX limit and posix_spawn fails with E2BIG.
        const proc = spawn("claude", ["-p", "--model", "opus"], {
            cwd: CLAUDE_CWD,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let settled = false;
        const stdin = proc.stdin;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            stdin?.destroy();
            reject(err);
        };

        stdin.on("error", fail);

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("exit", (code) => {
            if (settled) return;
            settled = true;
            if (code === 0) resolve(stdout);
            else reject(new Error(`claude exited ${code}: ${stderr}`));
        });
        proc.on("error", fail);

        stdin.end(prompt, "utf8");
    });
}

function extractJSON(response: string): any {
    const trimmed = response.trim();
    try {
        return JSON.parse(trimmed);
    } catch { }

    const stripped = trimmed
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/, "");
    try {
        return JSON.parse(stripped);
    } catch { }

    const firstBrace = response.indexOf("{");
    const lastBrace = response.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = response.slice(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(candidate);
        } catch { }
    }

    throw new Error("Could not extract valid JSON from response");
}

async function main() {
    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Check if buckets already exist
    const existingCount = (db.query("SELECT COUNT(*) as n FROM buckets").get() as { n: number }).n;
    if (existingCount > 0) {
        console.log(`\n${existingCount} buckets already exist in database.`);
        console.log("To re-run: DELETE FROM buckets; DELETE FROM chunk_buckets;");
        return;
    }

    // Pull all distinct labels
    const labels = (db
        .query("SELECT DISTINCT label FROM chunks ORDER BY label")
        .all() as { label: string }[]).map((r) => r.label);

    console.log(`Loaded ${labels.length} distinct labels`);

    const labelText = labels.map((l, i) => `${i + 1}. ${l}`).join("\n");
    const prompt = TAXONOMY_PROMPT + labelText;

    console.log(`Calling Claude to generate taxonomy...`);
    const startTime = Date.now();

    let response: string | undefined;
    try {
        response = await callClaude(prompt);
        const result = extractJSON(response);
        const buckets = result.buckets ?? [];

        if (buckets.length === 0) {
            throw new Error("No buckets returned");
        }

        console.log(`Got ${buckets.length} buckets back`);

        const insert = db.prepare(
            "INSERT INTO buckets (name, description) VALUES (?, ?)"
        );

        db.transaction(() => {
            for (const bucket of buckets) {
                insert.run(bucket.name, bucket.description ?? "");
            }
        })();

        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\nDone in ${elapsedSec}s. ${buckets.length} buckets written to database.`);
        console.log("\nBucket list:");
        for (const b of buckets) {
            console.log(`  - ${b.name}`);
        }
    } catch (err: any) {
        console.error(`ERROR: ${err.message}`);
        const debugPath = await debugLogPath("lucien-taxonomy-debug.txt");
        try {
            await writeFile(
                debugPath,
                `PROMPT:\n${prompt}\n\n---\n\nRESPONSE:\n${response ?? "(undefined)"}`
            );
            console.error(`Raw response saved to ${debugPath}`);
        } catch { }
        process.exit(1);
    }
}

await main();