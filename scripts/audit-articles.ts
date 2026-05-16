/**
 * Read-only health check over every article in the Dreaming. Reports:
 *   - preamble:   first content line isn't `#` / `{{stub}}` (LLM chatter)
 *   - postamble:  trailing maintainer-note / refusal block
 *   - refusal:    refusal signal phrase anywhere in body
 *   - dangling:   `conv:HASH` citation whose conversation isn't in the DB
 *   - spec-hash:  all-zero sentinel placeholder hashes (00000000/00000001)
 *   - bad-link:   `[[Target]]` with spaces whose underscored form is not a stem
 *   - empty:      0-byte / <50-char file
 *
 * Writes nothing. Exit code is always 0; this is a report, not a gate.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DB_PATH } from "./state-path.js";

const ARTICLES = join(homedir(), "Dreaming", "articles");
// Only the all-zero sentinels are true placeholders. c7107ff6 / 1d1037a7
// were ALSO used in the prompt example, but they are REAL conversation
// UUIDs in the DB ("Dynamic range and bit depth in SDR video" / "Describing
// the Archie project") and their citations are legitimate — not pollution.
const SPEC_HASHES = ["00000000", "00000001"];
const REFUSAL_SIGNALS = [
    "requires your permission",
    "I did not generate",
    "fabricates nothing",
    "isn't on disk at the expected path",
    "I cannot create",
    "I'll proceed with",
];
const POSTAMBLE = [
    /^\*\*?Note for the maintainer/i,
    /^Note to (the )?maintainer/i,
    /^I (did not|cannot|could not) (generate|write|produce)/i,
    /^Let me know (which|how|if)/i,
];

const db = new Database(DB_PATH, { readonly: true });
const knownHashes = new Set<string>(
    (db.query("SELECT uuid FROM conversations").all() as { uuid: string }[]).map((r) =>
        r.uuid.replace(/-/g, "").slice(0, 8).toLowerCase()
    )
);

const files = (await readdir(ARTICLES)).filter((f) => f.endsWith(".md"));
const stems = new Set(files.map((f) => f.replace(/\.md$/, "")));

interface Finding {
    file: string;
    kind: string;
    detail: string;
}
const findings: Finding[] = [];

for (const file of files) {
    const path = join(ARTICLES, file);
    const body = await readFile(path, "utf-8");
    const trimmed = body.trim();

    if (trimmed.length < 50) {
        findings.push({ file, kind: "empty", detail: `${trimmed.length} chars` });
        continue;
    }

    const firstLine = trimmed.split("\n")[0];
    if (!/^\s*(#\s|\{\{stub\}\})/i.test(firstLine)) {
        findings.push({ file, kind: "preamble", detail: firstLine.slice(0, 90) });
    }

    for (const line of trimmed.split("\n")) {
        if (POSTAMBLE.some((re) => re.test(line.trim()))) {
            findings.push({ file, kind: "postamble", detail: line.trim().slice(0, 90) });
            break;
        }
    }

    for (const sig of REFUSAL_SIGNALS) {
        if (trimmed.includes(sig)) {
            findings.push({ file, kind: "refusal", detail: sig });
            break;
        }
    }

    for (const m of body.matchAll(/conv:([0-9a-f]{8})/gi)) {
        const h = m[1].toLowerCase();
        if (SPEC_HASHES.includes(h)) {
            findings.push({ file, kind: "spec-hash", detail: `conv:${h}` });
        } else if (!knownHashes.has(h)) {
            findings.push({ file, kind: "dangling", detail: `conv:${h}` });
        }
    }

    for (const m of body.matchAll(/\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g)) {
        const inner = m[1].trim();
        const underscored = inner.replace(/\s+/g, "_");
        if (stems.has(inner) || stems.has(underscored)) continue; // resolves fine
        const kind = inner.includes(" ") ? "bad-link" : "phantom-link";
        findings.push({ file, kind, detail: `[[${inner}]]` });
    }
}

// Group + print
const byKind: Record<string, Finding[]> = {};
for (const f of findings) (byKind[f.kind] ??= []).push(f);

console.log(`Audited ${files.length} articles. ${findings.length} findings.\n`);
for (const kind of ["empty", "preamble", "postamble", "refusal", "dangling", "spec-hash", "bad-link", "phantom-link"]) {
    const fs = byKind[kind];
    if (!fs?.length) continue;
    console.log(`## ${kind} (${fs.length})`);
    const seen = new Set<string>();
    for (const f of fs) {
        const key = `${f.file}|${f.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  ${f.file}  —  ${f.detail}`);
    }
    console.log();
}
db.close();
