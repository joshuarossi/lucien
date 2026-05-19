import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";

const BATCH_SIZE = 25;

const ASSIGN_OR_PROPOSE_PROMPT = `You are organizing chunks of conversation into a personal wiki's bucket taxonomy. You have a list of EXISTING buckets and a batch of NEW topic labels. For each label, decide whether it fits into one or more existing buckets, or whether it represents a genuinely new topic that needs its own bucket.

DECISION RULES:

- Strongly prefer assigning to existing buckets. Only propose a new bucket when no existing bucket is a reasonable fit — and even then, only when the topic is substantive enough to warrant its own article (not a single fleeting mention).
- A label may belong to multiple existing buckets when it genuinely spans them.
- If a label fits one or more existing buckets, do NOT also propose a new bucket for it. Existing buckets win in any tie.
- Bucket names are Wikipedia-style: title-cased, descriptive, 2-6 words. Use underscores or spaces consistently with the existing buckets shown below.
- New bucket descriptions should be 1-2 sentences explaining what the bucket covers.
- If a label is too thin or off-topic to deserve any bucket (existing or new), return empty buckets and no proposal.
- Across this batch, if two labels would both warrant the SAME new bucket, use the SAME bucket name in your proposal — don't create duplicates.
- POLICY: the user's editorial preferences — including how readily to create a new bucket versus merge into an existing one (i.e. a bias toward many small articles or fewer large ones) — may be defined in /Users/joshrossi/Dreaming/Meta/. Use the Read tool to consult the relevant documents there and follow them over the defaults above. This prompt defines WHAT to do; the Meta docs define HOW.

OUTPUT FORMAT:
Output ONLY a JSON object, nothing else. No markdown fences, no preamble.

{
  "assignments": [
    {"label_id": 1, "existing_buckets": ["Archie Project"], "new_bucket": null},
    {"label_id": 2, "existing_buckets": [], "new_bucket": {"name": "Vintage Lens Restoration", "description": "Repair, cleaning, and adaptation of vintage manual-focus lenses for modern cameras."}},
    {"label_id": 3, "existing_buckets": [], "new_bucket": null}
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

interface NewBucketProposal {
    name: string;
    description: string;
}

interface LLMAssignment {
    label_id: number;
    existing_buckets: string[];
    new_bucket: NewBucketProposal | null;
}

interface LLMResponse {
    assignments: LLMAssignment[];
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // Prompt is passed via stdin, not argv: batched labels can exceed
        // the OS ARG_MAX limit and posix_spawn fails with E2BIG.
        const proc = spawn("claude", ["-p"], {
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

function buildPrompt(bucketsMap: Map<string, Bucket>, chunks: ChunkRow[]): string {
    const bucketList = Array.from(bucketsMap.values());
    const bucketSection =
        "EXISTING BUCKETS:\n" +
        bucketList.map((b) => `- ${b.name}: ${b.description}`).join("\n");
    const labelSection =
        "LABELS TO ASSIGN:\n" +
        chunks.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
    return ASSIGN_OR_PROPOSE_PROMPT + bucketSection + "\n\n" + labelSection;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    if (dryRun) {
        console.log("DRY RUN MODE — no writes will be performed.\n");
    }

    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Load buckets into a mutable Map so newly-proposed buckets are visible to subsequent batches
    const initialBuckets = db.query("SELECT name, description FROM buckets").all() as Bucket[];
    if (initialBuckets.length === 0) {
        console.error("No buckets in database. Run cluster-taxonomy.ts first.");
        process.exit(1);
    }

    const bucketsMap = new Map<string, Bucket>();
    for (const b of initialBuckets) {
        bucketsMap.set(b.name, b);
    }
    console.log(`Loaded ${bucketsMap.size} buckets`);

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

    const insertChunkBucket = db.prepare(
        "INSERT OR IGNORE INTO chunk_buckets (chunk_id, bucket_name) VALUES (?, ?)"
    );
    const insertBucket = db.prepare(
        "INSERT INTO buckets (name, description) VALUES (?, ?)"
    );

    let existingAssignments = 0;
    let newBucketsCreated = 0;
    let unassigned = 0;
    let unknownBuckets = 0;
    let errored = 0;
    const startTime = Date.now();

    // Track new buckets created this run for the end-of-run summary
    const newBucketsThisRun: Bucket[] = [];

    // Dry-run accumulators
    const dryRunExisting: { chunk_id: number; label: string; bucket: string }[] = [];
    const dryRunNew: { chunk_id: number; label: string; bucket: NewBucketProposal }[] = [];
    const dryRunUnassigned: { chunk_id: number; label: string }[] = [];

    for (let batchStart = 0; batchStart < todo.length; batchStart += BATCH_SIZE) {
        const batch = todo.slice(batchStart, batchStart + BATCH_SIZE);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

        console.log(
            `[batch ${batchNum}/${totalBatches}] Assigning ${batch.length} chunks...`
        );

        const prompt = buildPrompt(bucketsMap, batch);
        let response: string | undefined;

        try {
            response = await callClaude(LUCIEN_PROMPT_SENTINEL + prompt);
            const result = extractJSON(response) as LLMResponse;
            const assignments = result.assignments ?? [];

            if (dryRun) {
                // Dry-run: just accumulate what would happen
                for (const a of assignments) {
                    const labelId = a.label_id as number;
                    if (!labelId || labelId < 1 || labelId > batch.length) continue;
                    const chunk = batch[labelId - 1];
                    const existingBuckets = (a.existing_buckets ?? []) as string[];
                    const newBucket = a.new_bucket ?? null;

                    if (existingBuckets.length === 0 && !newBucket) {
                        dryRunUnassigned.push({ chunk_id: chunk.id, label: chunk.label });
                        unassigned++;
                        continue;
                    }

                    for (const bucketName of existingBuckets) {
                        if (!bucketsMap.has(bucketName)) {
                            unknownBuckets++;
                            console.warn(`  [dry-run] Unknown bucket: "${bucketName}" (would skip)`);
                            continue;
                        }
                        dryRunExisting.push({ chunk_id: chunk.id, label: chunk.label, bucket: bucketName });
                        existingAssignments++;
                    }

                    if (newBucket && existingBuckets.length === 0) {
                        const normalizedName = newBucket.name.trim().replace(/\s+/g, " ");
                        if (bucketsMap.has(normalizedName)) {
                            console.warn(
                                `  [dry-run] LLM proposed new bucket "${normalizedName}" but it already exists — would treat as existing assignment`
                            );
                            dryRunExisting.push({ chunk_id: chunk.id, label: chunk.label, bucket: normalizedName });
                            existingAssignments++;
                        } else {
                            const proposal: NewBucketProposal = { name: normalizedName, description: newBucket.description };
                            // Add to bucketsMap so subsequent batches see it (even in dry-run)
                            bucketsMap.set(normalizedName, proposal);
                            dryRunNew.push({ chunk_id: chunk.id, label: chunk.label, bucket: proposal });
                            newBucketsCreated++;
                            console.log(
                                `  [dry-run] would create: ${normalizedName} — ${newBucket.description}`
                            );
                        }
                    }
                }
            } else {
                db.transaction(() => {
                    for (const a of assignments) {
                        const labelId = a.label_id as number;
                        if (!labelId || labelId < 1 || labelId > batch.length) continue;
                        const chunk = batch[labelId - 1];
                        const existingBuckets = (a.existing_buckets ?? []) as string[];
                        const newBucket = a.new_bucket ?? null;

                        if (existingBuckets.length === 0 && !newBucket) {
                            unassigned++;
                            continue;
                        }

                        // Assign to existing buckets
                        for (const bucketName of existingBuckets) {
                            if (!bucketsMap.has(bucketName)) {
                                unknownBuckets++;
                                console.warn(`  Unknown bucket: "${bucketName}" (skipping)`);
                                continue;
                            }
                            insertChunkBucket.run(chunk.id, bucketName);
                            existingAssignments++;
                        }

                        // Propose a new bucket only when no existing bucket was assigned
                        if (newBucket && existingBuckets.length === 0) {
                            const normalizedName = newBucket.name.trim().replace(/\s+/g, " ");

                            if (bucketsMap.has(normalizedName)) {
                                // LLM proposed a duplicate — treat as existing assignment
                                console.warn(
                                    `  LLM proposed new bucket "${normalizedName}" but it already exists — assigning to existing`
                                );
                                insertChunkBucket.run(chunk.id, normalizedName);
                                existingAssignments++;
                            } else {
                                // Create the new bucket and assign
                                insertBucket.run(normalizedName, newBucket.description);
                                const newEntry: Bucket = { name: normalizedName, description: newBucket.description };
                                // Update the mutable map so subsequent batches see this new bucket
                                bucketsMap.set(normalizedName, newEntry);
                                newBucketsThisRun.push(newEntry);
                                insertChunkBucket.run(chunk.id, normalizedName);
                                newBucketsCreated++;
                                console.log(
                                    `  [+] new bucket: ${normalizedName} — ${newBucket.description}`
                                );
                            }
                        }
                    }
                })();

                console.log(
                    `  → existing assignments so far: ${existingAssignments}, new buckets created: ${newBucketsCreated}`
                );
            }
        } catch (err: any) {
            console.error(`  ERROR: ${err.message}`);
            const debugPath = join(
                homedir(),
                "Downloads",
                `lucien-assign-recent-debug-batch-${batchNum}.txt`
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

    if (dryRun) {
        console.log(`\n=== DRY RUN SUMMARY (${elapsedSec}s) ===`);
        console.log(`  Would make ${existingAssignments} assignments to existing buckets`);
        console.log(`  Would create ${newBucketsCreated} new buckets`);
        console.log(`  Would leave ${unassigned} chunks unassigned`);
        console.log(`  Unknown bucket references (would warn + skip): ${unknownBuckets}`);
        console.log(`  Chunks in errored batches: ${errored}`);

        if (dryRunNew.length > 0) {
            console.log(`\nNEW BUCKETS THAT WOULD BE CREATED:`);
            const seen = new Set<string>();
            for (const entry of dryRunNew) {
                if (!seen.has(entry.bucket.name)) {
                    seen.add(entry.bucket.name);
                    console.log(`  [+] ${entry.bucket.name} — ${entry.bucket.description}`);
                }
            }
        }

        if (dryRunExisting.length > 0) {
            console.log(`\nSAMPLE EXISTING-BUCKET ASSIGNMENTS (first 20):`);
            for (const entry of dryRunExisting.slice(0, 20)) {
                console.log(`  chunk ${entry.chunk_id} → ${entry.bucket}  (label: "${entry.label}")`);
            }
        }

        if (dryRunUnassigned.length > 0) {
            console.log(`\nUNASSIGNED CHUNKS (first 10):`);
            for (const entry of dryRunUnassigned.slice(0, 10)) {
                console.log(`  chunk ${entry.chunk_id}: "${entry.label}"`);
            }
        }
        return;
    }

    console.log(`\nDone in ${elapsedSec}s.`);
    console.log(`  Assignments to existing buckets: ${existingAssignments}`);
    console.log(`  New buckets created: ${newBucketsCreated}`);
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

    // New buckets created this run
    if (newBucketsThisRun.length > 0) {
        console.log(`\nNEW BUCKETS THIS RUN:`);
        for (const b of newBucketsThisRun) {
            console.log(`  [+] ${b.name} — ${b.description}`);
        }
    }
}

await main();
