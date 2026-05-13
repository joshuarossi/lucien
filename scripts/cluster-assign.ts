import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";
const BATCH_SIZE = 25;

const ASSIGN_PROMPT = `You will assign topic labels to buckets. You have a list of buckets (each with a name and description) and a batch of topic labels. For each label, determine which buckets it belongs to.

A label may belong to one bucket, multiple buckets, or in rare cases, no bucket. Multi-bucket assignment is expected when a label genuinely spans multiple areas (e.g., a label about "Webhook architecture in Archie" might belong to both an "Archie Project" bucket and a "Webhooks and Integrations" bucket).

Only assign to a bucket if the label clearly belongs there. Don't force assignments — if a label doesn't fit any bucket well, return an empty array for it.

OUTPUT FORMAT:
Output ONLY a JSON object, nothing else. No markdown fences, no preamble.

{
  "assignments": [
    {"label_id": 1, "buckets": ["Archie Project", "Webhooks and Integrations"]},
    {"label_id": 2, "buckets": ["Cinematography and Color Science"]},
    {"label_id": 3, "buckets": []},
    ...
  ]
}

The label_id corresponds to the number prefix in the input list.

`;

interface Bucket {
    name: string;
    description: string;
}

interface ChunkRow {
    id: number;
    label: string;
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["-p", prompt], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("exit", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`claude exited ${code}: ${stderr}`));
        });
        proc.on("error", reject);
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

function buildPrompt(buckets: Bucket[], chunks: ChunkRow[]): string {
    const bucketSection =
        "BUCKETS:\n" +
        buckets.map((b) => `- ${b.name}: ${b.description}`).join("\n");
    const labelSection =
        "LABELS TO ASSIGN:\n" +
        chunks.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
    return ASSIGN_PROMPT + bucketSection + "\n\n" + labelSection;
}

async function main() {
    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Load buckets
    const buckets = db.query("SELECT name, description FROM buckets").all() as Bucket[];
    if (buckets.length === 0) {
        console.error("No buckets in database. Run cluster-taxonomy.ts first.");
        process.exit(1);
    }
    console.log(`Loaded ${buckets.length} buckets`);

    const bucketNames = new Set(buckets.map((b) => b.name));

    // Find chunks that haven't been assigned yet
    const todo = db
        .query(
            `SELECT c.id, c.label 
       FROM chunks c
       WHERE c.id NOT IN (SELECT DISTINCT chunk_id FROM chunk_buckets)
       ORDER BY c.id`
        )
        .all() as ChunkRow[];

    console.log(`Chunks to assign: ${todo.length}`);
    if (todo.length === 0) {
        console.log("All chunks already assigned. Nothing to do.");
        return;
    }

    const insert = db.prepare(
        "INSERT OR IGNORE INTO chunk_buckets (chunk_id, bucket_name) VALUES (?, ?)"
    );

    let totalAssignments = 0;
    let unassigned = 0;
    let errored = 0;
    let unknownBuckets = 0;
    const startTime = Date.now();

    for (let batchStart = 0; batchStart < todo.length; batchStart += BATCH_SIZE) {
        const batch = todo.slice(batchStart, batchStart + BATCH_SIZE);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

        console.log(
            `[batch ${batchNum}/${totalBatches}] Assigning ${batch.length} chunks...`
        );

        const prompt = buildPrompt(buckets, batch);
        let response: string | undefined;

        try {
            response = await callClaude(LUCIEN_PROMPT_SENTINEL + prompt);
            const result = extractJSON(response);
            const assignments = result.assignments ?? [];

            db.transaction(() => {
                for (const a of assignments) {
                    const labelId = a.label_id as number;
                    if (!labelId || labelId < 1 || labelId > batch.length) continue;
                    const chunk = batch[labelId - 1];
                    const assignedBuckets = (a.buckets ?? []) as string[];

                    if (assignedBuckets.length === 0) {
                        unassigned++;
                        continue;
                    }

                    for (const bucketName of assignedBuckets) {
                        if (!bucketNames.has(bucketName)) {
                            unknownBuckets++;
                            console.warn(`  Unknown bucket: "${bucketName}" (skipping)`);
                            continue;
                        }
                        insert.run(chunk?.id ?? 0, bucketName);
                        totalAssignments++;
                    }
                }
            })();

            console.log(`  → total assignments so far: ${totalAssignments}`);
        } catch (err: any) {
            console.error(`  ERROR: ${err.message}`);
            const debugPath = join(
                homedir(),
                "Downloads",
                `lucien-assign-debug-batch-${batchNum}.txt`
            );
            try {
                await writeFile(
                    debugPath,
                    `PROMPT:\n${prompt}\n\n---\n\nRESPONSE:\n${response ?? "(undefined)"}`
                );
                console.error(`  Raw response saved to ${debugPath}`);
            } catch { }
            errored += batch.length;
        }
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\nDone in ${elapsedSec}s.`);
    console.log(`  Total assignments: ${totalAssignments}`);
    console.log(`  Chunks left unassigned: ${unassigned}`);
    console.log(`  Unknown bucket references: ${unknownBuckets}`);
    console.log(`  Chunks in errored batches (will retry next run): ${errored}`);

    // Per-bucket distribution
    console.log(`\nPer-bucket chunk counts:`);
    const dist = db
        .query(
            `SELECT bucket_name, COUNT(*) as n 
       FROM chunk_buckets 
       GROUP BY bucket_name 
       ORDER BY n DESC`
        )
        .all() as { bucket_name: string; n: number }[];
    for (const d of dist) {
        console.log(`  ${d.n.toString().padStart(4)} — ${d.bucket_name}`);
    }
}

await main();