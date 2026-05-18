/**
 * wikify.ts — in-place Wikipedia-editor restructuring pass.
 *
 * Standalone tool (NOT wired into nightly.sh — see the spec's Rollout section).
 * Pure helpers are exported for unit testing; the CLI runs behind
 * `import.meta.main`.
 *
 * Spec: docs/superpowers/specs/2026-05-17-lucien-editorial-pass-design.md
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, access, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DREAMING_PATH = join(homedir(), "Dreaming");
const ARTICLES_PATH = join(DREAMING_PATH, "articles");
const TALK_PATH = join(DREAMING_PATH, "Talk");

// Illustrative placeholder hashes the synthesis prompt warns against; never
// real citations, so excluded from the preservation set.
const SPEC_HASHES = new Set(["00000000", "00000001"]);

/** All real `conv:HASH` citation hashes in `text`, lowercased. */
export function extractConvHashes(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.matchAll(/conv:([0-9a-f]{8})/gi)) {
        const h = m[1]!.toLowerCase();
        if (!SPEC_HASHES.has(h)) out.add(h);
    }
    return out;
}

export interface CheckResult {
    ok: boolean;
    errors: string[];
}

/**
 * Verify footnote markers and definitions are consistent:
 * - every `[^N]` body marker has a `[^N]:` definition and vice versa
 * - marker numbers are contiguous from 1
 * - every definition line carries exactly one backticked `conv:HASH`
 */
export function checkFootnoteIntegrity(text: string): CheckResult {
    const errors: string[] = [];

    // Definition lines: `[^N]: ...` at line start.
    const defNums = new Set<number>();
    const defLineByNum = new Map<number, string>();
    for (const m of text.matchAll(/^\[\^(\d+)\]:(.*)$/gm)) {
        const n = parseInt(m[1]!, 10);
        defNums.add(n);
        defLineByNum.set(n, m[2]!);
    }

    // Body markers: `[^N]` NOT followed by `:` (definitions excluded).
    const markerNums = new Set<number>();
    for (const m of text.matchAll(/\[\^(\d+)\](?!:)/g)) {
        markerNums.add(parseInt(m[1]!, 10));
    }

    for (const n of markerNums) {
        if (!defNums.has(n)) errors.push(`marker [^${n}] has no definition`);
    }
    for (const n of defNums) {
        if (!markerNums.has(n)) errors.push(`definition [^${n}] has no marker`);
    }

    const all = [...new Set([...markerNums, ...defNums])].sort((a, b) => a - b);
    for (let i = 0; i < all.length; i++) {
        if (all[i] !== i + 1) {
            errors.push(
                `footnote numbers not contiguous from 1 (saw ${all.join(",")})`
            );
            break;
        }
    }

    for (const [n, line] of defLineByNum) {
        const backticked = line.match(/`conv:[0-9a-f]{8}`/gi) ?? [];
        if (backticked.length !== 1) {
            errors.push(
                `[^${n}] definition lacks a backticked \`conv:HASH\` (found ${backticked.length})`
            );
        }
    }

    return { ok: errors.length === 0, errors };
}

export interface VerifyOptions {
    floor: number; // edited word count must be >= floor * original word count
}

function wordCount(s: string): number {
    const t = s.trim();
    return t ? t.split(/\s+/).length : 0;
}

/**
 * Deterministic gate. On any failure the caller must discard the edit and keep
 * the original. Catches citation/structure loss; does NOT catch nuance loss.
 */
export function verifyEditorialResult(
    original: string,
    edited: string,
    opts: VerifyOptions
): CheckResult {
    const errors: string[] = [];

    // 1. Citation preservation: every original hash must survive.
    const before = extractConvHashes(original);
    const after = extractConvHashes(edited);
    for (const h of before) {
        if (!after.has(h)) errors.push(`dropped citation conv:${h}`);
    }

    // 2. Footnote integrity on the edited article.
    const fn = checkFootnoteIntegrity(edited);
    if (!fn.ok) errors.push(...fn.errors);

    // 3. Word floor.
    const ow = wordCount(original);
    const ew = wordCount(edited);
    if (ow > 0 && ew < opts.floor * ow) {
        errors.push(
            `word count ${ew} below floor ${Math.ceil(opts.floor * ow)} (original ${ow})`
        );
    }

    // 4. Structural sanity.
    const firstNonEmpty = edited.split("\n").find((l) => l.trim().length > 0) ?? "";
    if (!/^#\s+\S/.test(firstNonEmpty)) {
        errors.push("edited article does not start with an H1 title");
    }
    const hadRefs = /^##\s+References\s*$/m.test(original);
    const hasRefs = /^##\s+References\s*$/m.test(edited);
    if (hadRefs && !hasRefs) {
        errors.push("edited article dropped the ## References section");
    }

    return { ok: errors.length === 0, errors };
}

export interface SplitOutput {
    article: string;
    talk: string | null;
}

/** Parse the model contract: article text, then an optional Talk block. */
export function splitModelOutput(raw: string): SplitOutput {
    let s = raw.trim();

    // Strip an accidental ```lang ... ``` wrapper.
    const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
    if (fence) s = fence[1]!.trim();

    let talk: string | null = null;
    const idx = s.indexOf("<<<TALK>>>");
    if (idx !== -1) {
        const end = s.indexOf("<<<END TALK>>>", idx);
        const rawTalk =
            end === -1
                ? s.slice(idx + "<<<TALK>>>".length)
                : s.slice(idx + "<<<TALK>>>".length, end);
        talk = rawTalk.trim() || null;
        s = s.slice(0, idx).trim();
    }

    return { article: s, talk };
}

/** Article stems (filename minus .md) from raw `git log --name-only` output. */
export function parseChangedArticles(gitLog: string): Set<string> {
    const stems = new Set<string>();
    for (const line of gitLog.split("\n")) {
        const m = line.trim().match(/^articles\/([^/]+)\.md$/);
        if (m) stems.add(m[1]!);
    }
    return stems;
}

const EDITORIAL_PROMPT = `You are an expert Wikipedia editor improving ONE article in a personal wiki. You are NOT given new source material — your job is purely to restructure and tighten the article text below into the best possible single coherent Wikipedia-style article.

DO:
- Consolidate: wherever the same point, thesis, or example is restated in multiple places, merge it into ONE canonical passage and remove the echoes. State each thing once, in the right place. Do NOT add "see above" cross-references.
- Regroup: gather scattered material on one topic into one section with subsections. Fix the heading hierarchy so depth tracks importance.
- Lead: rewrite the lead to Wikipedia standards — 2 to 4 paragraphs that preview the major sections, with an accessible first sentence.

HARD INVARIANT — information-preserving (this is non-negotiable):
- Every substantive claim in the input must survive in the output. You may merge, compress, and relocate; you may NOT drop a claim.
- Every \`conv:HASH\` citation and every footnote must survive. Footnote markers [^N] may be renumbered, but every [^N] must have a matching [^N]: definition and vice versa, contiguous from 1, and every definition line must keep its backticked \`conv:HASH\`.
- Keep the single "# Title" H1 and the "## References" section.

PERPETUAL, NOT CONVERGENT:
- This article grows every night as new material is merged in. Your job is to keep the GROWN article well-structured. Do not optimize for a small diff; reorganize as much as the article needs.

CROSS-ARTICLE ACTIONS — DO NOT PERFORM THESE:
- Do not split this into multiple articles, merge it with another, or rename it.
- If you believe such an action is warranted, do NOT do it. Instead, after the article, emit a block:
<<<TALK>>>
<one short paragraph: the suggested cross-article action and why>
<<<END TALK>>>
- Omit the block entirely if you have no such suggestion.

OUTPUT:
Output ONLY the full restructured markdown article, starting with "# ", optionally followed by the single <<<TALK>>> block. No preamble, no explanation, no code fences.

ARTICLE TO RESTRUCTURE:
{{ARTICLE}}
`;

export function buildEditorialPrompt(articleText: string): string {
    return EDITORIAL_PROMPT.replace("{{ARTICLE}}", articleText);
}

export interface ArticleIO {
    readArticle: () => Promise<string>;
    writeArticle: (content: string) => Promise<void>;
    appendTalk: (entry: string) => Promise<void>;
    commit: (message: string) => Promise<void>;
    callModel: (prompt: string) => Promise<string>;
}

export interface WikifyOptions {
    floor: number;
    dryRun: boolean;
}

export interface WikifyResult {
    stem: string;
    status: "edited" | "would-edit" | "rejected" | "unchanged";
    errors: string[];
}

export async function wikifyArticle(
    stem: string,
    io: ArticleIO,
    opts: WikifyOptions
): Promise<WikifyResult> {
    const original = await io.readArticle();
    const raw = await io.callModel(buildEditorialPrompt(original));
    const { article, talk } = splitModelOutput(raw);

    if (article.trim() === original.trim()) {
        return { stem, status: "unchanged", errors: [] };
    }

    const gate = verifyEditorialResult(original, article, { floor: opts.floor });
    if (!gate.ok) {
        return { stem, status: "rejected", errors: gate.errors };
    }

    if (opts.dryRun) {
        return { stem, status: "would-edit", errors: [] };
    }

    await io.writeArticle(article + "\n");
    if (talk) {
        const stamp = new Date().toISOString().slice(0, 10);
        await io.appendTalk(`\n## ${stamp} — editorial suggestion\n\n${talk}\n`);
    }
    await io.commit(`Editorial restructure: ${stem}`);
    return { stem, status: "edited", errors: [] };
}
