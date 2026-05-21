/**
 * write-changelog.ts — prepend a per-run section to ~/Dreaming/Meta/Changelog.md.
 *
 * Fully deterministic, no model calls. Diffs the Dreaming `articles/` tree
 * between the pre-synthesis HEAD (passed as --since, the same SHA nightly.sh
 * captures for wikify's --changed-since) and the current HEAD, classifies
 * each changed file as new / updated / removed, and prepends a dated
 * section newest-first.
 *
 * Answers the two morning questions in one glance: a section dated today
 * means the pipeline completed through this stage; the list is what changed.
 *
 * Pure helpers (parseChanges, buildChangelogSection, prependSection) are
 * exported for tests; the CLI runs behind import.meta.main.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const DREAMING_PATH = join(homedir(), "Dreaming");
const CHANGELOG_PATH = join(DREAMING_PATH, "Meta", "Changelog.md");

const HEADER =
    "# Changelog\n\n" +
    "Nightly pipeline run log — one section per run, newest first. " +
    "A dated section means the pipeline completed through the changelog " +
    "stage; the list is what changed in `articles/` that run.\n\n";

export interface ArticleChange {
    kind: "new" | "updated" | "removed";
    article: string;
}

/** Parse `git diff --name-status` output into classified article changes. */
export function parseChanges(diffOutput: string): ArticleChange[] {
    const changes: ArticleChange[] = [];
    for (const raw of diffOutput.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/\t/);
        const status = parts[0] ?? "";
        // Renames/copies emit two paths; the LAST is the current file.
        const path = parts[parts.length - 1] ?? "";
        const m = path.match(/^articles\/(.+)\.md$/);
        if (!m) continue;
        let kind: ArticleChange["kind"];
        if (status.startsWith("A")) kind = "new";
        else if (status.startsWith("D")) kind = "removed";
        else kind = "updated"; // M, R, C, T, …
        changes.push({ kind, article: m[1]! });
    }
    return changes;
}

/** Build the dated `## YYYY-MM-DD — OK` section. */
export function buildChangelogSection(
    changes: ArticleChange[],
    date: string
): string {
    const rank = { new: 0, updated: 1, removed: 2 } as const;
    const sorted = [...changes].sort(
        (a, b) => rank[a.kind] - rank[b.kind] || a.article.localeCompare(b.article)
    );
    const lines = sorted.length
        ? sorted.map((c) => `- ${c.kind}: ${c.article}`)
        : ["- no article changes"];
    return `## ${date} — OK\n\n${lines.join("\n")}\n`;
}

/** Insert a new section newest-first: after the header, before existing sections. */
export function prependSection(existing: string | null, section: string): string {
    if (!existing) return HEADER + section;
    const firstSection = existing.search(/^## /m);
    if (firstSection !== -1) {
        return existing.slice(0, firstSection) + section + "\n" + existing.slice(firstSection);
    }
    // File exists but has no sections yet — append after a trimmed body.
    return existing.replace(/\s*$/, "") + "\n\n" + section;
}

function gitDiffNameStatus(since: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            "git",
            ["-C", DREAMING_PATH, "diff", "--name-status", since, "HEAD", "--", "articles/"],
            { stdio: ["ignore", "pipe", "ignore"] }
        );
        let out = "";
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.on("exit", (code) =>
            code === 0 ? resolve(out) : reject(new Error(`git diff exited ${code}`))
        );
        proc.on("error", reject);
    });
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const si = argv.indexOf("--since");
    const since = si !== -1 ? argv[si + 1] : undefined;
    if (!since) {
        console.log("write-changelog: no --since SHA given — skipping");
        return;
    }

    // --date overrides the section date (default: today). Used for seeding
    // the first entry with a prior run's date and for deterministic tests.
    const di = argv.indexOf("--date");
    const date =
        di !== -1 && argv[di + 1]
            ? argv[di + 1]!
            : new Date().toISOString().slice(0, 10);
    const changes = parseChanges(await gitDiffNameStatus(since));
    const section = buildChangelogSection(changes, date);

    const existing = (await fileExists(CHANGELOG_PATH))
        ? await readFile(CHANGELOG_PATH, "utf8")
        : null;
    await writeFile(CHANGELOG_PATH, prependSection(existing, section));

    const n = (k: ArticleChange["kind"]) => changes.filter((c) => c.kind === k).length;
    console.log(
        `write-changelog: ${date} — ${n("new")} new, ${n("updated")} updated, ${n("removed")} removed`
    );
}

if (import.meta.main) {
    await main();
}
