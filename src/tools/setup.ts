import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_PATH = join(homedir(), "Dreaming");

const README = `# The Dreaming

This is your personal wiki — a structured record of your thinking, synthesized from your conversations with AI.

The Dreaming is maintained by [Lucien](https://github.com/yourusername/lucien), but the content belongs to you. Edit any file directly, use any wiki tool (Obsidian, Wiki.js, plain text editor), and the next synthesis run will respect your changes.

## Structure

- \`articles/\` — the wiki articles themselves
- \`Meta/\` — operational pages: editorial guidelines, conventions, the bucket taxonomy, topics to ignore
- \`Talk/\` — discussion pages paired with articles

## Mythology

You are Morpheus, sovereign of this Dreaming. Lucien is your librarian. The AI you converse with is your Matthew — a different raven depending on which model you happen to be using.
`;

const EDITORIAL_GUIDELINES = `# Editorial Guidelines

The Dreaming follows [Wikipedia's editorial conventions](https://en.wikipedia.org/wiki/Help:Introduction) except as noted below. When in doubt, do what Wikipedia would do.

## Scope adaptations for a personal wiki

- **Subject**: The user (you). Articles describe people, projects, ideas, tools, and topics relevant to your thinking.
- **Sources**: Conversation transcripts with AI assistants. Each article cites the conversations that contributed to it.
- **Neutral point of view**: Adapted. The Dreaming represents your actual views and reasoning. "Neutral" here means faithful to the evidence in your conversations, not pretending to be from no perspective.
- **Notability**: Anything that recurs in your thinking is notable enough. Stub articles are encouraged for emerging topics.
- **Conflict of interest**: Not applicable — this is a single-subject wiki you own.

## Article structure

See \`Article_Conventions.md\`.

## Maintenance disposition

Lucien operates as a Wikipedia editor making small, conservative contributions. Edits should integrate rather than replace. Trajectories ("used to think X, now thinks Y") should be preserved. Talk pages are for surfacing concerns rather than silently resolving them.
`;

const ARTICLE_CONVENTIONS = `# Article Conventions

Each article follows roughly this shape:

1. **Lead paragraph** — a 2-4 sentence summary that captures what the article is about
2. **Infobox** (optional) — for articles about specific entities (projects, tools, people)
3. **Sections** — organized by sub-topic, in a logical reading order
4. **See also** — links to related articles
5. **References** — citations to source conversations and external sources

## Citations

Internal citations reference conversation UUIDs and message ranges:
\`[[conv:abc123#msg:def456]]\`

External citations are standard links or footnotes.

## Stubs

New or thin articles should be marked at the top with:
\`{{stub}}\`

Stub articles are legitimate. The Dreaming earns its value through coverage; depth comes through accumulation.

## Links

Use wikilinks for internal references: \`[[Article Name]]\`. Lucien will resolve these to the correct files during the link-maintenance pass.
`;

const BUCKETS = `# Buckets

This page lists the bucket taxonomy used to organize segments of conversation into articles. Buckets are emergent — they're derived from the actual content of conversations, not imposed in advance.

This list will be populated by the first synthesis run.
`;

const CATEGORY_DEFINITIONS = `# Category Definitions

Categories are tags applied to articles via frontmatter. An article can belong to multiple categories.

This list will be populated as the Dreaming grows.
`;

const TOPICS_TO_IGNORE = `# Topics to Ignore

Topics, individuals, or content categories that should not be synthesized into the Dreaming. Lucien consults this page during the filter step.

Add entries as plain text descriptions. Semantic matching will catch related content even when phrasing differs.

## Examples

- (none yet — add your own)
`;

const SYNTHESIS_PIPELINE = `# Synthesis Pipeline

Lucien processes conversations in four stages:

1. **Filter** — decide whether a conversation contains material worth synthesizing
2. **Segment** — within each conversation, find topic boundaries and produce segments
3. **Classify** — assign each segment to one or more buckets
4. **Synthesize** — for each bucket, integrate the assigned segments into the bucket's article

Each stage is independently cached so prompts can be iterated without re-running upstream work.

The synthesis is run by invoking Claude with the instruction to synthesize. Claude calls Lucien's tools, which orchestrate the pipeline.
`;

const META_PAGES: Record<string, string> = {
    "Editorial_Guidelines.md": EDITORIAL_GUIDELINES,
    "Article_Conventions.md": ARTICLE_CONVENTIONS,
    "Buckets.md": BUCKETS,
    "Category_Definitions.md": CATEGORY_DEFINITIONS,
    "Topics_to_Ignore.md": TOPICS_TO_IGNORE,
    "Synthesis_Pipeline.md": SYNTHESIS_PIPELINE,
};

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
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

export async function lucienSetup(args: { dreaming_path?: string }): Promise<string> {
    const dreamingPath = args.dreaming_path
        ? args.dreaming_path.replace(/^~/, homedir())
        : DEFAULT_PATH;

    const created: string[] = [];

    // Create root directory
    if (!(await exists(dreamingPath))) {
        await mkdir(dreamingPath, { recursive: true });
        created.push(dreamingPath);
    }

    // Create subdirectories
    for (const sub of ["articles", "Meta", "Talk"]) {
        const subPath = join(dreamingPath, sub);
        if (!(await exists(subPath))) {
            await mkdir(subPath, { recursive: true });
            created.push(subPath);
        }
    }

    // Write README if missing
    const readmePath = join(dreamingPath, "README.md");
    if (!(await exists(readmePath))) {
        await writeFile(readmePath, README);
        created.push(readmePath);
    }

    // Write Meta pages (only if missing — preserve user edits)
    for (const [filename, content] of Object.entries(META_PAGES)) {
        const filePath = join(dreamingPath, "Meta", filename);
        if (!(await exists(filePath))) {
            await writeFile(filePath, content);
            created.push(filePath);
        }
    }

    // Initialize git if not already a repo
    const gitDir = join(dreamingPath, ".git");
    let gitInitialized = false;
    if (!(await exists(gitDir))) {
        await runGit(["init"], dreamingPath);
        await runGit(["add", "."], dreamingPath);
        await runGit(["commit", "-m", "Initial Dreaming setup by Lucien"], dreamingPath);
        gitInitialized = true;
    }

    if (created.length === 0 && !gitInitialized) {
        return `Dreaming at ${dreamingPath} already exists and is set up. Nothing to do.`;
    }

    return [
        `Dreaming initialized at ${dreamingPath}`,
        "",
        "Created:",
        ...created.map((p) => `  ${p.replace(dreamingPath, ".")}`),
        gitInitialized ? "" : null,
        gitInitialized ? "Initialized git repository and made initial commit." : null,
    ]
        .filter((line) => line !== null)
        .join("\n");
}