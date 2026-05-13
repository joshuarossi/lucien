/**
 * One-off: replace `[[Space Joined Name]]` wikilinks with `[[Space_Joined_Name]]`
 * across every article in the Dreaming, but only when the underscored form matches
 * an existing article filename. This avoids accidentally rewriting links to topics
 * that aren't yet articles (e.g. `[[Cartier-Bresson]]` stays as-is).
 *
 * Idempotent: re-running after a successful pass finds zero matches.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ARTICLES_DIR = join(homedir(), "Dreaming", "articles");
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith(".md"));
    const stems = new Set(files.map((f) => f.replace(/\.md$/, "")));

    let totalEdits = 0;
    const perFile: Record<string, number> = {};

    for (const file of files) {
        const path = join(ARTICLES_DIR, file);
        const original = await readFile(path, "utf-8");
        let edited = original;

        // Match [[…]] where the inner text has no pipe, hash, or already-underscored
        // alternative. We only rewrite when the underscored form would be a valid stem.
        edited = edited.replace(/\[\[([^\]|#]+)\]\]/g, (whole, inner: string) => {
            // Already underscore form? leave alone.
            if (!inner.includes(" ")) return whole;
            const underscored = inner.replace(/\s+/g, "_");
            if (!stems.has(underscored)) return whole; // no matching article
            return `[[${underscored}]]`;
        });

        if (edited !== original) {
            const before = (original.match(/\[\[[^\]|#]+\]\]/g) ?? []).filter(
                (l) => /\s/.test(l)
            ).length;
            const after = (edited.match(/\[\[[^\]|#]+\]\]/g) ?? []).filter(
                (l) => /\s/.test(l)
            ).length;
            const editsHere = before - after;
            perFile[file] = editsHere;
            totalEdits += editsHere;

            if (!DRY_RUN) {
                await writeFile(path, edited);
            }
        }
    }

    console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Total link rewrites: ${totalEdits}`);
    console.log(`Files affected: ${Object.keys(perFile).length}`);
    for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${n.toString().padStart(4)}  ${f}`);
    }
}

await main();
