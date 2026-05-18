import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, access } from "node:fs/promises";
import { DB_PATH } from "./state-path.js";
import { LUCIEN_PROMPT_SENTINEL } from "./sentinel.js";
import { sanitizeArticleOutput } from "./sanitize-article.js";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");

const SYNTHESIS_PROMPT_BOOTSTRAP = `You are a Wikipedia editor maintaining a personal wiki — the Dreaming — for a user. The Dreaming captures what the user thinks, has worked on, and cares about, organized as Wikipedia-style articles synthesized from their conversations with AI assistants.

This is a bootstrap run: this article does not yet exist. You will create it from scratch using the source material below.

EDITORIAL CONVENTIONS:

The Dreaming follows Wikipedia editorial conventions, adapted for personal scope. The subject of all articles is the user (their thinking, work, and life), and the sources are conversation transcripts.

- Write in Wikipedia article style: lead paragraph that summarizes the topic, then sections by sub-topic, then See also, then references.
- Use neutral, factual prose. The article describes what the user thinks and does, not what you (the synthesizer) believe.
- Preserve nuance and specific details. Don't generalize away the particulars — the value is in the specifics.
- When the user's views have evolved over time, note that ("initially thought X, later refined to Y").
- When the user has expressed strong opinions, capture them accurately as the user's positions.
- Use wikilinks for references to other articles in the Dreaming. The link target MUST be the exact article stem from OTHER ARTICLES below — underscores, never spaces: write [[AI_Coding_Workflow]], or with display text [[AI_Coding_Workflow|the coding workflow]]. The spaced form [[AI Coding Workflow]] resolves to nothing and creates a broken orphan link; it is forbidden.

CITATIONS — source conversations (required):

Cite substantive claims using Markdown footnotes. This is the ONLY allowed citation format.

Inline: place a footnote marker immediately after the claim.

...claim text.[^1]

Definitions: collect all footnote definitions in a "## References" section at the very end of the article (after "## See also"). One line per distinct source conversation:

[^1]: \`conv:HASH\` — Conversation title or short description

Rules:
- Number footnotes 1, 2, 3, … in order of first appearance in the body.
- Same conversation cited multiple times: reuse the same [^N] marker every time; emit exactly ONE [^N]: definition line for it.
- Two different conversations supporting one sentence: adjacent markers with no space — [^1][^2].
- Canonical hash: the first 8 lowercase hex digits of the conversation UUID, hyphens stripped. Example: 00000000-0000-0000-0000-000000000000 → 00000000. \`conv:00000000\` and \`conv:00000001\` are ILLUSTRATIVE PLACEHOLDERS and must NEVER appear in your output. Every conv:HASH you emit must be the real first-8 hex of a conversation UUID that appears in the SOURCE MATERIAL provided to you.
- In every definition line the conv:HASH MUST be wrapped in backticks. Exactly one \`conv:HASH\` per line. An optional " — short description" may follow.
- Every [^N] marker in the body must have a matching [^N]: definition, and vice versa. Numbers contiguous from 1.

NEVER fabricate a citation. If a claim cannot be tied to a specific conversation present in the SOURCE MATERIAL, leave the claim uncited — an uncited true statement is acceptable; a citation to a conversation that is not in the source material is a defect. Do not invent a hash, do not reuse a placeholder hash, do not guess.

FORBIDDEN — never emit any of these (they create broken phantom links in the wiki graph): HTML <sup> tags, <a id=...> anchors, #ref- or #cite- fragment links, escaped-bracket markers like [\[1\]], or wikilink-style numeric markers like [[1]]. Footnotes ([^N] / [^N]:) are the only citation syntax permitted.

LENGTH GUIDANCE:
- Articles should be as long as the source material justifies, no longer.
- A bucket with 30 chunks of substantive material can produce a long article (1500-3000 words).
- A bucket with 5 chunks should produce a shorter article (300-800 words).
- A bucket with thin material can produce a stub (a few sentences). Mark it with {{stub}} at the top.

ARTICLE TO WRITE:
Bucket: {{BUCKET_NAME}}
Bucket description: {{BUCKET_DESCRIPTION}}

OTHER ARTICLES (use [[wikilinks]] when referencing these):
{{OTHER_ARTICLES}}

SOURCE MATERIAL:
Below are the chunks assigned to this bucket. Each chunk has a label, a source conversation UUID, and the message text. Read all of them. Synthesize them into a coherent article about {{BUCKET_NAME}}.

{{CHUNKS}}

OUTPUT:
Output ONLY the markdown article. No preamble, no explanation, no JSON, no markdown code fences around the article. Just the article content as a markdown document, ready to be written to {{BUCKET_NAME}}.md.

The article should start with the title as a level-1 heading (# Title), followed by the lead paragraph, then sections.

Before you finish, verify: every [^N] marker in the body has a matching [^N]: definition; every [^N]: definition has at least one [^N] marker; each definition line contains \`conv:HASH\` in backticks, not bare conv: text; numbers are contiguous from 1.
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

    // Feed the canonical underscore stem (the on-disk filename minus .md), not
    // the spaced bucket name — this is the exact [[wikilink]] target the model
    // must emit. Mismatched spaced links create broken orphan files in Obsidian.
    return others
        .map((b) => `- ${b.name.replace(/\s+/g, "_")}: ${b.description}`)
        .join("\n");
}

interface CLIArgs {
    onlyBucket?: string;
    force?: boolean;
}

function parseArgs(): CLIArgs {
    const args: CLIArgs = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--only-bucket" && argv[i + 1]) {
            args.onlyBucket = argv[i + 1];
            i++;
        } else if (a === "--force") {
            args.force = true;
        }
    }
    return args;
}

async function main() {
    const args = parseArgs();

    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

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

    console.log(`Buckets to synthesize: ${buckets.length}`);

    const chunksQuery = db.query(`
    SELECT c.id, c.conversation_uuid, conv.name as conversation_name,
           c.start_message_uuid, c.end_message_uuid, c.label
    FROM chunks c
    JOIN chunk_buckets cb ON cb.chunk_id = c.id
    JOIN conversations conv ON conv.uuid = c.conversation_uuid
    WHERE cb.bucket_name = ?
    ORDER BY conv.updated_at, c.id
  `);

    const synthesizedArticles: string[] = [];
    let errored = 0;
    const startTime = Date.now();

    let i = 0;
    for (const bucket of buckets) {
        i++;
        const filename = bucketToFilename(bucket.name);
        const filePath = join(ARTICLES_PATH, filename);

        if (!args.force && (await exists(filePath))) {
            console.log(
                `[${i}/${buckets.length}] ${bucket.name} — already exists, skipping (use --force to regenerate)`
            );
            continue;
        }

        const chunks = chunksQuery.all(bucket.name) as Chunk[];

        if (chunks.length === 0) {
            console.log(
                `[${i}/${buckets.length}] ${bucket.name} — no chunks assigned, skipping`
            );
            continue;
        }

        console.log(
            `[${i}/${buckets.length}] ${bucket.name} — synthesizing from ${chunks.length} chunks...`
        );

        const chunkText = formatChunks(chunks, db);
        const otherArticles = getOtherArticles(db, bucket.name);

        const prompt = SYNTHESIS_PROMPT_BOOTSTRAP.replace(
            /\{\{BUCKET_NAME\}\}/g,
            bucket.name
        )
            .replace(/\{\{BUCKET_DESCRIPTION\}\}/g, bucket.description)
            .replace(/\{\{OTHER_ARTICLES\}\}/g, otherArticles)
            .replace(/\{\{CHUNKS\}\}/g, chunkText);

        let response: string | undefined;
        try {
            const callStart = Date.now();
            response = await callClaude(LUCIEN_PROMPT_SENTINEL + prompt);
            const callElapsed = ((Date.now() - callStart) / 1000).toFixed(1);

            const article = sanitizeArticleOutput(response);

            await writeFile(filePath, article + "\n");
            synthesizedArticles.push(filename);

            const wordCount = article.split(/\s+/).length;
            console.log(`  → wrote ${filename} (${wordCount} words, ${callElapsed}s)`);
        } catch (err: any) {
            console.error(`  ERROR: ${err.message}`);
            const debugPath = join(
                homedir(),
                "Downloads",
                `lucien-synthesis-debug-${bucketToFilename(bucket.name)}.txt`
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

    if (synthesizedArticles.length > 0) {
        console.log(
            `\nCommitting ${synthesizedArticles.length} articles to git...`
        );
        try {
            await runGit(["add", "articles"], DREAMING_PATH);
            const commitMsg = args.onlyBucket
                ? `Synthesis: ${args.onlyBucket}`
                : `Synthesis run: ${synthesizedArticles.length} articles`;
            await runGit(["commit", "-m", commitMsg], DREAMING_PATH);
            console.log(`Git commit created.`);
        } catch (err: any) {
            console.warn(`Git commit failed: ${err.message}`);
            console.warn(`Articles are still on disk; commit manually if needed.`);
        }
    }

    const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`\nDone in ${elapsedMin} minutes.`);
    console.log(`  Articles written: ${synthesizedArticles.length}`);
    console.log(`  Errored: ${errored}`);
    if (errored > 0) {
        console.log(
            `  Failed articles will retry on next run (they have no file on disk).`
        );
    }
}

await main();