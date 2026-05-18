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
