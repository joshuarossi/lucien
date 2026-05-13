import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, access, readFile } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");

const SYNTHESIS_PROMPT_UPDATE = `You are a Wikipedia editor maintaining a personal wiki — the Dreaming — for a user. The Dreaming captures what the user thinks, has worked on, and cares about, organized as Wikipedia-style articles synthesized from their conversations with AI assistants.

This article already exists. Below you will find the CURRENT TEXT of the article and a set of NEW SOURCE CHUNKS. Integrate the new material into the article. Do NOT rewrite from scratch — work from the existing text.

INTEGRATION RULES:

- Keep all existing prose unless the new material directly contradicts or supersedes it. When that happens, note the evolution ("initially …, later refined to …").
- Preserve all existing citations and their numbering exactly. New citations CONTINUE the numbering from the highest existing reference number — never restart from 1.
- Preserve any manual edits the user may have made — sections, phrasing, ordering. The user may have hand-edited this article in Obsidian; that is authoritative.
- Add new sections only when the new material does not fit naturally into existing sections.
- When the user's views have evolved over time, note that ("initially thought X, later refined to Y").
- When the user has expressed strong opinions, capture them accurately as the user's positions.
- Use wikilinks for references to other articles in the Dreaming: [[Article Name]]. You can link to any of the articles listed in OTHER ARTICLES below.
- Use neutral, factual prose. The article describes what the user thinks and does, not what you (the synthesizer) believe.
- Preserve nuance and specific details. Don't generalize away the particulars — the value is in the specifics.

CITATIONS — source conversations (required; matches Meta/Article_Conventions.md in the Dreaming):

Cite substantive claims from the chunks using Wikipedia-style numbered footnotes only. Do not use deprecated inline [conv:HASH], bullet lines like "- [conv:HASH] …" in the body, or multi-conversation brackets such as [conv:a, conv:b].

Inline form — place immediately after the claim. Preserve the backslashes before [ and ] exactly (they keep the visible text as [N] instead of nested markdown):

...claim text.<sup id="cite-1-1">[\[1\]](#ref-1)</sup>

Numbering and anchors:
- Assign reference numbers in order of first appearance in the article body (through the last substantive section; do not count ## References).
- EXISTING citations keep their numbers unchanged. New citations start from (highest existing number + 1).
- Canonical hash: in each reference line, use the first 8 lowercase hex digits of the conversation UUID (strip hyphens). Example: c7107ff6-5142-4e14-b429-6e718a53dc34 → c7107ff6.
- Same conversation cited multiple times: reuse one number N for all of those inline cites. One ## References row for that N.
- Inline ids: cite-N-K — N is the reference number; K is 1-indexed occurrence count (first cite of ref 3 is cite-3-1, second is cite-3-2).
- Reference row: put <a id="ref-N"></a> immediately after the list number.

## References section (at the end, after See also):

Each line is: list number, space, <a id="ref-N"></a>, immediately back-link(s) with no space before the first [ (mandatory), then a space, then exactly one markdown code span \`conv:HASH\` (the word conv:, the 8-char hash, and the backticks are all required), then optional — description. Never duplicate \`conv:HASH\` on one line; never emit bare conv:HASH without backticks.

1. <a id="ref-1"></a>[↩a](#cite-1-1) [↩b](#cite-1-2) \`conv:c7107ff6\` — Conversation title or short description
2. <a id="ref-2"></a>[↩](#cite-2-1) \`conv:1d1037a7\` — Conversation title or short description

Back-links (required on every reference row): exactly one inline cite → use [↩](#cite-N-1) only (not [↩a]). Two or more inline cites of the same ref → [↩a](#cite-N-1) [↩b](#cite-N-2) … (letters a–z, space-separated, one per inline occurrence).
Reference text after back-links: exactly one \`conv:HASH\` in markdown backticks — then an em-dash and title or brief description when the chunk/source name is known; otherwise just \`conv:HASH\` in backticks (no em-dash).
Two different conversations for one sentence: two adjacent <sup> tags, not one combined marker.
Every cite-N-K in the body must pair with ref-N in ## References; each ref-N must have at least one cite-N-K; numbers contiguous from 1.

LENGTH GUIDANCE:
- If new material is thin (≤3 chunks), the changes should be small — possibly a single sentence or paragraph extension. Don't pad.
- Match the depth of additions to the substance of the new chunks. Large new chunks warrant new sections; minor details warrant a sentence.

ARTICLE TO UPDATE:
Bucket: {{BUCKET_NAME}}
Bucket description: {{BUCKET_DESCRIPTION}}

OTHER ARTICLES (use [[wikilinks]] when referencing these):
{{OTHER_ARTICLES}}

CURRENT ARTICLE TEXT:
{{EXISTING_ARTICLE}}

NEW SOURCE CHUNKS TO INTEGRATE:
Below are ONLY the new chunks not yet reflected in the article above. Read all of them. Integrate their material into the existing article about {{BUCKET_NAME}}.

{{NEW_CHUNKS}}

OUTPUT:
Output ONLY the full updated markdown article. No preamble, no explanation, no JSON, no markdown code fences around the article. Just the complete article content as a markdown document, ready to overwrite the existing file.

The article should start with the title as a level-1 heading (# Title).

Before you finish, verify: every <sup id="cite-…"> matches a ref-N; every ref-N has correct ↩ back-links; each reference row contains \`conv:HASH\` in backticks, not bare conv: text; no existing reference numbers were changed.
`;

interface Bucket {
    name: string;
    description: string;
}

interface Chunk {
    id: number;
    conversation_uuid: string;
    conversation_name: string;
    start_message_uuid: string;
    end_message_uuid: string;
    label: string;
}

interface MessageRow {
    uuid: string;
    sender: string;
    text: string;
    position: number;
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
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

function runGit(args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn("git", args, { cwd, stdio: "ignore" });
        proc.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`git ${args.join(" ")} exited with code ${code}`));
        });
        proc.on("error", reject);
    });
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function bucketToFilename(name: string): string {
    return name.replace(/\s+/g, "_") + ".md";
}

function formatChunks(chunks: Chunk[], db: Database): string {
    const messagesQuery = db.query(`
    SELECT uuid, sender, text, position
    FROM messages
    WHERE conversation_uuid = ?
      AND position >= (SELECT position FROM messages WHERE uuid = ?)
      AND position <= (SELECT position FROM messages WHERE uuid = ?)
    ORDER BY position
  `);

    const parts: string[] = [];

    for (const chunk of chunks) {
        const messages = messagesQuery.all(
            chunk.conversation_uuid,
            chunk.start_message_uuid,
            chunk.end_message_uuid
        ) as MessageRow[];

        const nonEmpty = messages.filter((m) => m.text && m.text.trim());
        if (nonEmpty.length === 0) continue;

        const conversationLabel = chunk.conversation_name || chunk.conversation_uuid;
        const messageText = nonEmpty
            .map((m) => `[${m.sender}]\n${m.text}`)
            .join("\n\n");

        parts.push(
            `=== CHUNK: ${chunk.label} ===\n` +
            `Source conversation: "${conversationLabel}" (uuid: ${chunk.conversation_uuid})\n\n` +
            messageText
        );
    }

    return parts.join("\n\n---\n\n");
}

function getOtherArticles(db: Database, excluding: string): string {
    const others = db
        .query("SELECT name, description FROM buckets WHERE name != ? ORDER BY name")
        .all(excluding) as Bucket[];

    return others.map((b) => `- ${b.name}: ${b.description}`).join("\n");
}

interface CLIArgs {
    onlyBucket?: string;
    dryRun?: boolean;
}

function parseArgs(): CLIArgs {
    const args: CLIArgs = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--only-bucket" && argv[i + 1]) {
            args.onlyBucket = argv[i + 1];
            i++;
        } else if (a === "--dry-run") {
            args.dryRun = true;
        }
    }
    return args;
}

async function main() {
    const args = parseArgs();

    if (args.dryRun) {
        console.log("DRY RUN mode — files will not be written, DB will not be updated.");
    }

    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Idempotent DDL for the tracking table.
    db.exec(`
    CREATE TABLE IF NOT EXISTS synthesized_bucket_chunks (
      bucket_name TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      synthesized_at TEXT NOT NULL,
      PRIMARY KEY (bucket_name, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sbc_bucket ON synthesized_bucket_chunks(bucket_name);
  `);

    await mkdir(ARTICLES_PATH, { recursive: true });

    let buckets = db
        .query("SELECT name, description FROM buckets ORDER BY name")
        .all() as Bucket[];

    if (buckets.length === 0) {
        console.error(
            "No buckets in database. Run cluster-taxonomy.ts and cluster-assign.ts first."
        );
        process.exit(1);
    }

    if (args.onlyBucket) {
        buckets = buckets.filter((b) => b.name === args.onlyBucket);
        if (buckets.length === 0) {
            console.error(`Bucket "${args.onlyBucket}" not found.`);
            process.exit(1);
        }
        console.log(`Filtering to single bucket: ${args.onlyBucket}`);
    }

    console.log(`Buckets to evaluate: ${buckets.length}`);

    // Prepared statements.
    const newChunksQuery = db.query(`
    SELECT c.id, c.conversation_uuid, conv.name as conversation_name,
           c.start_message_uuid, c.end_message_uuid, c.label
    FROM chunks c
    JOIN chunk_buckets cb ON cb.chunk_id = c.id
    JOIN conversations conv ON conv.uuid = c.conversation_uuid
    WHERE cb.bucket_name = ?
      AND c.id NOT IN (SELECT chunk_id FROM synthesized_bucket_chunks WHERE bucket_name = ?)
    ORDER BY conv.updated_at, c.id
  `);

    const existingSynthesizedCountQuery = db.query(`
    SELECT COUNT(*) as n FROM synthesized_bucket_chunks WHERE bucket_name = ?
  `);

    const backfillStmt = db.prepare(`
    INSERT OR IGNORE INTO synthesized_bucket_chunks (bucket_name, chunk_id, synthesized_at)
    SELECT ?, chunk_id, ?
    FROM chunk_buckets
    WHERE bucket_name = ?
  `);

    const markSynthesizedStmt = db.prepare(`
    INSERT OR IGNORE INTO synthesized_bucket_chunks (bucket_name, chunk_id, synthesized_at)
    VALUES (?, ?, ?)
  `);

    const synthesizedArticles: string[] = [];
    let errored = 0;
    let backfilled = 0;
    let skippedNoMaterial = 0;
    let skippedNoArticle = 0;
    let updated = 0;
    const startTime = Date.now();

    let i = 0;
    for (const bucket of buckets) {
        i++;
        const filename = bucketToFilename(bucket.name);
        const filePath = join(ARTICLES_PATH, filename);
        const articleExists = await exists(filePath);

        // --- Self-healing migration from bootstrap state ---
        // If the article is on disk but this bucket has no synthesized rows yet,
        // treat all currently-assigned chunks as already synthesized (bootstrap output).
        if (articleExists) {
            const existingRow = existingSynthesizedCountQuery.get(bucket.name) as { n: number };
            if (existingRow.n === 0) {
                const now = new Date().toISOString();
                if (!args.dryRun) {
                    backfillStmt.run(bucket.name, now, bucket.name);
                }
                const backfilledRow = db
                    .query("SELECT COUNT(*) as n FROM chunk_buckets WHERE bucket_name = ?")
                    .get(bucket.name) as { n: number };
                console.log(
                    `[${i}/${buckets.length}] ${bucket.name} — backfill: marked ${backfilledRow.n} existing chunks as synthesized (one-time migration)`
                );
                backfilled++;
            }
        }

        // --- Determine new chunks (after potential backfill) ---
        const newChunks = newChunksQuery.all(bucket.name, bucket.name) as Chunk[];

        if (newChunks.length === 0) {
            console.log(
                `[${i}/${buckets.length}] ${bucket.name} — no new material, skipping`
            );
            skippedNoMaterial++;
            continue;
        }

        if (!articleExists) {
            console.log(
                `[${i}/${buckets.length}] ${bucket.name} — ${newChunks.length} new chunk(s) but no article on disk, skipping (run scripts/synthesize.ts to bootstrap)`
            );
            skippedNoArticle++;
            continue;
        }

        // --- Article exists AND new chunks exist: integrate ---
        console.log(
            `[${i}/${buckets.length}] ${bucket.name} — integrating ${newChunks.length} new chunk(s) into existing article...`
        );

        if (args.dryRun) {
            const chunkText = formatChunks(newChunks, db);
            const preview = chunkText.slice(0, 200);
            console.log(`  [DRY RUN] Would integrate ${newChunks.length} chunk(s).`);
            console.log(`  [DRY RUN] New chunk preview (first 200 chars): ${preview}`);
            continue;
        }

        const existingArticle = await readFile(filePath, "utf8");
        const newChunkText = formatChunks(newChunks, db);
        const otherArticles = getOtherArticles(db, bucket.name);

        const prompt = SYNTHESIS_PROMPT_UPDATE.replace(
            /\{\{BUCKET_NAME\}\}/g,
            bucket.name
        )
            .replace(/\{\{BUCKET_DESCRIPTION\}\}/g, bucket.description)
            .replace(/\{\{OTHER_ARTICLES\}\}/g, otherArticles)
            .replace(/\{\{EXISTING_ARTICLE\}\}/g, existingArticle.trim())
            .replace(/\{\{NEW_CHUNKS\}\}/g, newChunkText);

        let response: string | undefined;
        try {
            const callStart = Date.now();
            response = await callClaude(prompt);
            const callElapsed = ((Date.now() - callStart) / 1000).toFixed(1);

            let article = response.trim();
            article = article.replace(/^```(?:markdown|md)?\s*\n/i, "");
            article = article.replace(/\n```\s*$/, "");
            article = article.trim();

            if (!article || article.length < 50) {
                throw new Error(`Article too short: ${article.length} chars`);
            }

            await writeFile(filePath, article + "\n");
            synthesizedArticles.push(filename);

            // Mark the new chunks as synthesized.
            const now = new Date().toISOString();
            db.transaction(() => {
                for (const chunk of newChunks) {
                    markSynthesizedStmt.run(bucket.name, chunk.id, now);
                }
            })();

            updated++;
            const wordCount = article.split(/\s+/).length;
            console.log(`  → updated ${filename} (${wordCount} words, ${callElapsed}s)`);
        } catch (err: any) {
            console.error(`  ERROR: ${err.message}`);
            const debugPath = join(
                homedir(),
                "Downloads",
                `lucien-update-debug-${bucketToFilename(bucket.name)}.txt`
            );
            try {
                await writeFile(
                    debugPath,
                    `PROMPT:\n${prompt}\n\n---\n\nRESPONSE:\n${response ?? "(undefined)"}`
                );
                console.error(`  Raw response saved to ${debugPath}`);
            } catch { }
            errored++;
        }
    }

    if (synthesizedArticles.length > 0 && !args.dryRun) {
        console.log(
            `\nCommitting ${synthesizedArticles.length} updated articles to git...`
        );
        try {
            const updatedRelPaths = synthesizedArticles.map((f) => join("articles", f));
            await runGit(["add", ...updatedRelPaths], DREAMING_PATH);
            const commitMsg = args.onlyBucket
                ? `Synthesis update: ${args.onlyBucket}`
                : `Synthesis update: ${synthesizedArticles.length} articles`;
            await runGit(["commit", "-m", commitMsg], DREAMING_PATH);
            console.log(`Git commit created.`);
        } catch (err: any) {
            console.warn(`Git commit failed: ${err.message}`);
            console.warn(`Articles are still on disk; commit manually if needed.`);
        }
    }

    const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`\nDone in ${elapsedMin} minutes.`);
    console.log(`  Buckets evaluated:          ${buckets.length}`);
    console.log(`  Backfilled (migration):     ${backfilled}`);
    console.log(`  Skipped (no new material):  ${skippedNoMaterial}`);
    console.log(`  Skipped (no article):       ${skippedNoArticle}`);
    console.log(`  Updated:                    ${updated}`);
    console.log(`  Errored:                    ${errored}`);
    if (errored > 0) {
        console.log(
            `  Failed articles retain their new chunks as un-synthesized; they will retry on the next run.`
        );
    }
}

await main();
