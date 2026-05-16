/**
 * One-off: convert HTML-anchor citation format to Markdown footnotes.
 *
 *   inline:   <sup id="cite-N-K">[[N]](#ref-N)</sup>   →   [^N]
 *             (also handles the escaped variant [\[N\]] inside the sup)
 *   ref row:  N. <a id="ref-N"></a>[↩a](#cite-N-1) … `conv:HASH` — desc
 *                                                  →   [^N]: `conv:HASH` — desc
 *
 * Articles already in footnote form are left untouched (idempotent — no
 * <sup/<a id means nothing to do). The malformed `[[1]]` phantom links
 * only ever occur INSIDE the <sup> wrapper, so replacing the whole wrapper
 * removes them at the same time.
 *
 * --dry-run : report per-file change counts + a sample, write nothing.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ARTICLES = join(homedir(), "Dreaming", "articles");
const DRY = process.argv.includes("--dry-run");

// Inline: whole <sup …>…</sup> whose id is cite-N-K  →  [^N]
const INLINE = /<sup id="cite-(\d+)-\d+">.*?<\/sup>/g;

// Reference row: leading "N. ", an <a id="ref-N"></a>, any number of
// [↩x](#cite-…) back-links, then the `conv:HASH` (+ optional — desc).
const REFROW =
    /^\s*\d+\.\s*<a id="ref-(\d+)"><\/a>(?:\s*\[↩[^\]]*\]\(#cite-[^)]*\))*\s*(`conv:[0-9a-fA-F]{8}`.*)$/;

const files = (await readdir(ARTICLES)).filter((f) => f.endsWith(".md"));
let changedFiles = 0;
let sampleShown = false;

for (const file of files) {
    const path = join(ARTICLES, file);
    const original = await readFile(path, "utf-8");
    if (!original.includes('<sup id="cite-') && !original.includes('<a id="ref-')) {
        continue; // already footnote-style or no citations
    }

    const inlineCount = (original.match(INLINE) ?? []).length;

    let refRows = 0;
    const out = original
        .split("\n")
        .map((line) => {
            const m = line.match(REFROW);
            if (m) {
                refRows++;
                return `[^${m[1]}]: ${m[2].trim()}`;
            }
            return line;
        })
        .join("\n")
        .replace(INLINE, (_w, n) => `[^${n}]`);

    if (out !== original) {
        changedFiles++;
        console.log(
            `  ${file}  —  ${inlineCount} inline cites, ${refRows} ref rows → footnotes`
        );
        if (DRY && !sampleShown && inlineCount > 0 && refRows > 0) {
            sampleShown = true;
            const firstRef = out.split("\n").find((l) => /^\[\^\d+\]: /.test(l));
            const firstInline = (out.match(/\[\^\d+\]/) ?? [])[0];
            console.log(`\n  sample inline → ${firstInline}`);
            console.log(`  sample refrow → ${firstRef}\n`);
        }
        if (!DRY) await writeFile(path, out);
    }
}

console.log(
    `\n${DRY ? "[DRY RUN] " : ""}${changedFiles} file(s) ${DRY ? "would be" : ""} converted to footnote citations.`
);
