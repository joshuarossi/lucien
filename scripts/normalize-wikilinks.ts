/**
 * Normalize `[[Space Joined Name]]` wikilinks to `[[Space_Joined_Name]]` across
 * every article in the Dreaming, but only when the underscored form matches an
 * existing article filename. Links to topics that aren't yet articles (true
 * redlinks, e.g. `[[Cartier-Bresson]]`, `[[Mercury (planet)]]`) are left as-is.
 *
 * Handles the aliased and section forms — `[[Target|alias]]`,
 * `[[Target#Section]]`, `[[Target#Section|alias]]` — by underscoring ONLY the
 * link target. The alias is display text and the `#Section` anchor is matched
 * by Obsidian against the literal heading; both are preserved verbatim.
 *
 * Idempotent: already-underscored links and redlinks are untouched, so a second
 * pass finds zero matches.
 *
 * Run directly to normalize the on-disk corpus; imported for unit testing.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ARTICLES_DIR = join(homedir(), "Dreaming", "articles");

/**
 * Rewrite spaced wikilink targets to their underscore stem when that stem is a
 * known article. Pure: no filesystem access.
 *
 * @param content - article markdown
 * @param stems - set of canonical article stems (filename without `.md`)
 * @returns the rewritten content and the number of links changed
 */
export function normalizeWikilinks(
    content: string,
    stems: Set<string>
): { content: string; edits: number } {
    let edits = 0;

    // `[^\]]+?` so the inner text may legitimately contain `|` and `#`.
    const out = content.replace(/\[\[([^\]]+?)\]\]/g, (whole, inner: string) => {
        // inner is one of: Target | Target|Alias | Target#Section |
        //                  Target#Section|Alias
        const pipeIdx = inner.indexOf("|");
        const alias = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1);
        const beforeAlias = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);

        const hashIdx = beforeAlias.indexOf("#");
        const section = hashIdx === -1 ? null : beforeAlias.slice(hashIdx + 1);
        const target = hashIdx === -1 ? beforeAlias : beforeAlias.slice(0, hashIdx);

        // No space in the target → already canonical (or unspaced); leave alone.
        if (!target.includes(" ")) return whole;

        const underscored = target.replace(/\s+/g, "_");
        if (!stems.has(underscored)) return whole; // true redlink — don't touch

        let rebuilt = underscored;
        if (section !== null) rebuilt += `#${section}`; // anchor preserved verbatim
        if (alias !== null) rebuilt += `|${alias}`; // alias preserved verbatim
        edits++;
        return `[[${rebuilt}]]`;
    });

    return { content: out, edits };
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith(".md"));
    const stems = new Set(files.map((f) => f.replace(/\.md$/, "")));

    let totalEdits = 0;
    const perFile: Record<string, number> = {};

    for (const file of files) {
        const path = join(ARTICLES_DIR, file);
        const original = await readFile(path, "utf-8");
        const { content: edited, edits } = normalizeWikilinks(original, stems);

        if (edits > 0) {
            perFile[file] = edits;
            totalEdits += edits;
            if (!dryRun) await writeFile(path, edited);
        }
    }

    console.log(`${dryRun ? "[DRY RUN] " : ""}Total link rewrites: ${totalEdits}`);
    console.log(`Files affected: ${Object.keys(perFile).length}`);
    for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${n.toString().padStart(4)}  ${f}`);
    }
}

if (import.meta.main) {
    await main();
}
