# Editorial Pass (wikify.ts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/wikify.ts` — a standalone in-place Wikipedia-editor restructuring tool with a deterministic verification gate, runnable as a CLI, not yet wired into nightly.

**Architecture:** Pure, unit-tested deterministic functions (hash extraction, footnote integrity, the verification gate, changed-article parsing, model-output splitting) plus one orchestrator `wikifyArticle()` that takes the model call as an injected dependency so it is testable without the LLM. The merge worker and `nightly.sh` are untouched.

**Tech Stack:** Bun, TypeScript, `bun:test`, `claude -p` (subprocess), git subprocess. Spec: `docs/superpowers/specs/2026-05-17-lucien-editorial-pass-design.md`.

---

## File Structure

- Create: `scripts/wikify.ts` — all logic: pure helpers (exported), `wikifyArticle()` orchestrator (exported, DI), `main()` CLI behind `import.meta.main`.
- Create: `scripts/wikify.test.ts` — unit tests for every pure helper and the orchestrator's branching.

No existing files are modified. The conv-hash and footnote regexes are small; they are reimplemented inline rather than extracted from `audit-articles.ts` to avoid coupling (spec allows "if needed" — not needed).

Conventions reused from `scripts/synthesize-update.ts`: `callClaude` (spawn `claude -p`, write prompt to stdin), `runGit` (spawn git), `DREAMING_PATH = join(homedir(),"Dreaming")`, `ARTICLES_PATH = join(DREAMING_PATH,"articles")`.

---

### Task 1: conv:HASH extraction

**Files:**
- Create: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { extractConvHashes } from "./wikify.js";

test("extractConvHashes returns the lowercased set, excluding spec placeholders", () => {
    const text =
        "claim one.[^1] claim two.[^2]\n\n" +
        "[^1]: `conv:a1b2c3d4` — Title\n" +
        "[^2]: `conv:DEADBEEF` — Other\n" +
        "[^3]: `conv:00000000` — placeholder that must be ignored\n";
    const hashes = extractConvHashes(text);
    expect([...hashes].sort()).toEqual(["a1b2c3d4", "deadbeef"]);
});

test("extractConvHashes returns an empty set when there are no citations", () => {
    expect(extractConvHashes("# Title\n\nNo citations here.").size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'extractConvHashes' not found`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): conv:HASH extraction helper"
```

---

### Task 2: Footnote integrity check

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { checkFootnoteIntegrity } from "./wikify.js";

test("checkFootnoteIntegrity passes a well-formed article", () => {
    const ok =
        "a.[^1] b.[^2]\n\n## References\n\n" +
        "[^1]: `conv:a1b2c3d4` — One\n" +
        "[^2]: `conv:deadbeef` — Two\n";
    expect(checkFootnoteIntegrity(ok)).toEqual({ ok: true, errors: [] });
});

test("checkFootnoteIntegrity flags a marker with no definition", () => {
    const bad = "a.[^1] b.[^2]\n\n[^1]: `conv:a1b2c3d4` — One\n";
    const r = checkFootnoteIntegrity(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("marker [^2] has no definition");
});

test("checkFootnoteIntegrity flags a definition with no marker", () => {
    const bad =
        "a.[^1]\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";
    const r = checkFootnoteIntegrity(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("definition [^2] has no marker");
});

test("checkFootnoteIntegrity flags non-contiguous numbering", () => {
    const bad = "a.[^1] b.[^3]\n\n[^1]: `conv:a1b2c3d4`\n[^3]: `conv:deadbeef`\n";
    const r = checkFootnoteIntegrity(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("not contiguous");
});

test("checkFootnoteIntegrity flags a definition missing a backticked conv:HASH", () => {
    const bad = "a.[^1]\n\n[^1]: conv:a1b2c3d4 — no backticks\n";
    const r = checkFootnoteIntegrity(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("[^1] definition lacks a backticked");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'checkFootnoteIntegrity' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): footnote integrity check"
```

---

### Task 3: The verification gate

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { verifyEditorialResult } from "./wikify.js";

const ORIGINAL =
    "# Topic\n\nLead.\n\n## Body\n\nClaim a.[^1] Claim b.[^2]\n\n" +
    "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";

test("verifyEditorialResult passes a faithful restructure", () => {
    const edited =
        "# Topic\n\nA rebuilt two-paragraph lead previewing the body.\n\n" +
        "## Body\n\nClaim b and claim a, consolidated.[^1][^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";
    expect(verifyEditorialResult(ORIGINAL, edited, { floor: 0.7 }).ok).toBe(true);
});

test("verifyEditorialResult rejects a dropped citation hash", () => {
    const edited =
        "# Topic\n\nLead.\n\n## Body\n\nClaim a only.[^1]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4` — One\n";
    const r = verifyEditorialResult(ORIGINAL, edited, { floor: 0.7 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("dropped citation");
    expect(r.errors.join(" ")).toContain("deadbeef");
});

test("verifyEditorialResult rejects falling below the word floor", () => {
    const edited =
        "# Topic\n\n## References\n\n" +
        "[^1]: `conv:a1b2c3d4`\n[^2]: `conv:deadbeef`\n"; // far too short
    const r = verifyEditorialResult(ORIGINAL, edited, { floor: 0.7 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("word count");
});

test("verifyEditorialResult rejects a dropped References section", () => {
    const edited = "# Topic\n\nLead.\n\n## Body\n\nClaim a.[^1] Claim b.[^2]\n";
    const r = verifyEditorialResult(ORIGINAL, edited, { floor: 0.7 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("References");
});

test("verifyEditorialResult rejects a missing H1 title", () => {
    const edited =
        "Lead with no title.\n\n## Body\n\na.[^1] b.[^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4`\n[^2]: `conv:deadbeef`\n";
    const r = verifyEditorialResult(ORIGINAL, edited, { floor: 0.7 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("H1 title");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'verifyEditorialResult' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): deterministic verification gate"
```

---

### Task 4: Model-output splitting (article + optional Talk block)

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

The editorial prompt instructs the model to output the article, optionally followed by a sentinel-delimited Talk block for cross-article suggestions it must not execute. `splitModelOutput` is the pure parser for that contract, and also strips an accidental ```` ``` ```` code-fence wrapper.

- [ ] **Step 1: Write the failing test**

```ts
import { splitModelOutput } from "./wikify.js";

test("splitModelOutput returns the article and null talk when no block", () => {
    const r = splitModelOutput("# Topic\n\nBody.\n");
    expect(r.article).toBe("# Topic\n\nBody.");
    expect(r.talk).toBeNull();
});

test("splitModelOutput separates a sentinel-delimited Talk block", () => {
    const out =
        "# Topic\n\nBody.\n\n" +
        "<<<TALK>>>\nConsider splitting the Foo section into its own article.\n<<<END TALK>>>\n";
    const r = splitModelOutput(out);
    expect(r.article).toBe("# Topic\n\nBody.");
    expect(r.talk).toBe("Consider splitting the Foo section into its own article.");
});

test("splitModelOutput strips a wrapping markdown code fence", () => {
    const out = "```markdown\n# Topic\n\nBody.\n```";
    const r = splitModelOutput(out);
    expect(r.article).toBe("# Topic\n\nBody.");
    expect(r.talk).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'splitModelOutput' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (15 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): model-output splitter (article + Talk block)"
```

---

### Task 5: Changed-article parsing

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

`parseChangedArticles` turns raw `git log --name-only --pretty=format:%H` output (from the Dreaming repo, filtered to `Synthesis update:` commits) into the set of article stems to edit. The CLI shells out to git and feeds the text in; the parser is pure.

- [ ] **Step 1: Write the failing test**

```ts
import { parseChangedArticles } from "./wikify.js";

test("parseChangedArticles extracts unique article stems from name-only log", () => {
    const log =
        "articles/Archie_Project.md\n" +
        "articles/AI_Coding_Workflow.md\n" +
        "articles/Archie_Project.md\n" + // duplicate across commits
        "articles/.obsidian/workspace.json\n" + // ignored: not articles/*.md
        "Talk/Archie_Project.md\n"; // ignored: not under articles/
    expect([...parseChangedArticles(log)].sort()).toEqual([
        "AI_Coding_Workflow",
        "Archie_Project",
    ]);
});

test("parseChangedArticles returns empty set for empty input", () => {
    expect(parseChangedArticles("").size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'parseChangedArticles' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
/** Article stems (filename minus .md) from raw `git log --name-only` output. */
export function parseChangedArticles(gitLog: string): Set<string> {
    const stems = new Set<string>();
    for (const line of gitLog.split("\n")) {
        const m = line.trim().match(/^articles\/([^/]+)\.md$/);
        if (m) stems.add(m[1]!);
    }
    return stems;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): changed-article log parser"
```

---

### Task 6: Editorial prompt builder

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildEditorialPrompt } from "./wikify.js";

test("buildEditorialPrompt embeds the article and the hard invariants", () => {
    const p = buildEditorialPrompt("# Sample\n\nText with a claim.[^1]");
    expect(p).toContain("# Sample\n\nText with a claim.[^1]");
    expect(p).toContain("Wikipedia editor");
    expect(p).toContain("must survive"); // info-preserving invariant
    expect(p).toContain("<<<TALK>>>"); // cross-article contract
    expect(p).toContain("not optimize for a small diff"); // perpetual-not-convergent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'buildEditorialPrompt' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (18 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): editorial prompt builder"
```

---

### Task 7: `wikifyArticle` orchestrator (model injected for testing)

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

`wikifyArticle` ties it together: read file → build prompt → call model → split output → verify → on pass write (+ append Talk, + commit) / on fail keep original. The model call and the side-effecting fns are injected so the orchestrator is unit-testable with no LLM, no git, no disk.

- [ ] **Step 1: Write the failing test**

```ts
import { wikifyArticle } from "./wikify.js";

const ORIG =
    "# Topic\n\nLead.\n\n## Body\n\nClaim a.[^1] Claim b.[^2]\n\n" +
    "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";

function deps(model: (p: string) => Promise<string>) {
    const calls: Record<string, string> = {};
    return {
        spy: calls,
        io: {
            readArticle: async () => ORIG,
            writeArticle: async (s: string) => {
                calls.written = s;
            },
            appendTalk: async (s: string) => {
                calls.talk = s;
            },
            commit: async (msg: string) => {
                calls.commit = msg;
            },
            callModel: model,
        },
    };
}

test("wikifyArticle writes and commits a faithful restructure", async () => {
    const good =
        "# Topic\n\nA proper rebuilt lead spanning the body.\n\n" +
        "## Body\n\nConsolidated a and b.[^1][^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";
    const { spy, io } = deps(async () => good);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: false });
    expect(r.status).toBe("edited");
    expect(spy.written).toBe(good + "\n");
    expect(spy.commit).toBe("Editorial restructure: Topic");
});

test("wikifyArticle keeps original and does NOT commit when gate fails", async () => {
    const bad = "# Topic\n\nDropped b.[^1]\n\n## References\n\n[^1]: `conv:a1b2c3d4`\n";
    const { spy, io } = deps(async () => bad);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: false });
    expect(r.status).toBe("rejected");
    expect(r.errors.join(" ")).toContain("deadbeef");
    expect(spy.written).toBeUndefined();
    expect(spy.commit).toBeUndefined();
});

test("wikifyArticle dry-run never writes or commits even on a good edit", async () => {
    const good =
        "# Topic\n\nRebuilt lead.\n\n## Body\n\nConsolidated.[^1][^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4`\n[^2]: `conv:deadbeef`\n";
    const { spy, io } = deps(async () => good);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: true });
    expect(r.status).toBe("would-edit");
    expect(spy.written).toBeUndefined();
    expect(spy.commit).toBeUndefined();
});

test("wikifyArticle appends a Talk block when the model emits one", async () => {
    const good =
        "# Topic\n\nRebuilt lead.\n\n## Body\n\nConsolidated.[^1][^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4`\n[^2]: `conv:deadbeef`\n\n" +
        "<<<TALK>>>\nConsider splitting Body into its own article.\n<<<END TALK>>>";
    const { spy, io } = deps(async () => good);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: false });
    expect(r.status).toBe("edited");
    expect(spy.talk).toContain("Consider splitting Body");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'wikifyArticle' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (22 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): wikifyArticle orchestrator with injected IO"
```

---

### Task 8: Real IO adapters + CLI `main()`

**Files:**
- Modify: `scripts/wikify.ts`
- Test: `scripts/wikify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { parseArgs } from "./wikify.js";

test("parseArgs --bucket with dry-run", () => {
    expect(parseArgs(["--bucket", "Archie_Project", "--dry-run"])).toEqual({
        mode: { kind: "bucket", stem: "Archie_Project" },
        dryRun: true,
        floor: 0.7,
    });
});

test("parseArgs --all with custom floor", () => {
    expect(parseArgs(["--all", "--floor", "0.6"])).toEqual({
        mode: { kind: "all" },
        dryRun: false,
        floor: 0.6,
    });
});

test("parseArgs --changed-since ref", () => {
    expect(parseArgs(["--changed-since", "HEAD~5"])).toEqual({
        mode: { kind: "changed-since", ref: "HEAD~5" },
        dryRun: false,
        floor: 0.7,
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/wikify.test.ts`
Expected: FAIL — `Export named 'parseArgs' not found`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/wikify.ts`:

```ts
export type CliMode =
    | { kind: "bucket"; stem: string }
    | { kind: "all" }
    | { kind: "changed-since"; ref: string };

export interface CliArgs {
    mode: CliMode;
    dryRun: boolean;
    floor: number;
}

export function parseArgs(argv: string[]): CliArgs {
    let mode: CliMode | null = null;
    let dryRun = false;
    let floor = 0.7;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--bucket" && argv[i + 1]) {
            mode = { kind: "bucket", stem: argv[++i]! };
        } else if (a === "--all") {
            mode = { kind: "all" };
        } else if (a === "--changed-since" && argv[i + 1]) {
            mode = { kind: "changed-since", ref: argv[++i]! };
        } else if (a === "--dry-run") {
            dryRun = true;
        } else if (a === "--floor" && argv[i + 1]) {
            floor = parseFloat(argv[++i]!);
        }
    }
    if (!mode) {
        throw new Error(
            "usage: wikify.ts (--bucket <stem> | --all | --changed-since <ref>) [--dry-run] [--floor N]"
        );
    }
    return { mode, dryRun, floor };
}

function callClaude(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["-p"], { stdio: ["pipe", "pipe", "pipe"] });
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
        proc.on("exit", (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`git ${args.join(" ")} exited ${code}`))
        );
        proc.on("error", reject);
    });
}

function gitCapture(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.on("exit", (code) =>
            code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`))
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

function ioFor(stem: string): ArticleIO {
    const articlePath = join(ARTICLES_PATH, `${stem}.md`);
    const talkPath = join(TALK_PATH, `${stem}.md`);
    return {
        readArticle: () => readFile(articlePath, "utf8"),
        writeArticle: (c) => writeFile(articlePath, c),
        appendTalk: (e) => appendFile(talkPath, e),
        commit: async (msg) => {
            await runGit(["add", "--", `articles/${stem}.md`], DREAMING_PATH);
            if (await fileExists(talkPath)) {
                await runGit(["add", "--", `Talk/${stem}.md`], DREAMING_PATH);
            }
            await runGit(["commit", "-m", msg], DREAMING_PATH);
        },
        callModel: callClaude,
    };
}

async function resolveStems(mode: CliMode): Promise<string[]> {
    if (mode.kind === "bucket") return [mode.stem];
    if (mode.kind === "all") {
        const files = await readdir(ARTICLES_PATH);
        return files
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.replace(/\.md$/, ""));
    }
    // changed-since: Dreaming commits titled "Synthesis update:" since ref.
    const log = await gitCapture(
        [
            "log",
            "--name-only",
            "--pretty=format:",
            "--grep=Synthesis update:",
            `${mode.ref}..HEAD`,
        ],
        DREAMING_PATH
    );
    return [...parseChangedArticles(log)];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const stems = await resolveStems(args.mode);
    console.log(
        `wikify: ${stems.length} article(s)${args.dryRun ? " [DRY RUN]" : ""}, floor=${args.floor}`
    );
    const summary: Record<string, number> = {};
    for (const stem of stems) {
        const articlePath = join(ARTICLES_PATH, `${stem}.md`);
        if (!(await fileExists(articlePath))) {
            console.log(`  SKIP ${stem} (no such article)`);
            summary.skipped = (summary.skipped ?? 0) + 1;
            continue;
        }
        try {
            const r = await wikifyArticle(stem, ioFor(stem), {
                floor: args.floor,
                dryRun: args.dryRun,
            });
            summary[r.status] = (summary[r.status] ?? 0) + 1;
            const tail = r.errors.length ? ` — ${r.errors.join("; ")}` : "";
            console.log(`  ${r.status.toUpperCase()} ${stem}${tail}`);
        } catch (err) {
            summary.errored = (summary.errored ?? 0) + 1;
            console.log(`  ERRORED ${stem} — ${(err as Error).message}`);
        }
    }
    console.log(
        "Summary: " +
            Object.entries(summary)
                .map(([k, v]) => `${v} ${k}`)
                .join(", ")
    );
}

if (import.meta.main) {
    await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test scripts/wikify.test.ts`
Expected: PASS (25 tests total).

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `bun test`
Expected: All files pass (previous 53 + new wikify tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/wikify.ts scripts/wikify.test.ts
git commit -m "feat(wikify): real IO adapters and CLI entrypoint"
```

---

### Task 9: Manual acceptance proof on Archie_Project

**Files:** none (manual verification step — the spec's acceptance gate).

- [ ] **Step 1: Dry-run the tool on the redundant article**

Run: `bun run scripts/wikify.ts --bucket Archie_Project --dry-run`
Expected: prints `WOULD-EDIT Archie_Project` (or `REJECTED …` with the failing checks). No file changes, no commits (`git -C ~/Dreaming status` clean).

- [ ] **Step 2: Produce a reviewable artifact**

Run:
```bash
cp ~/Dreaming/articles/Archie_Project.md /tmp/Archie_before.md
bun run scripts/wikify.ts --bucket Archie_Project   # live, single article
diff <(git -C ~/Dreaming show HEAD~1:articles/Archie_Project.md) ~/Dreaming/articles/Archie_Project.md | head -120
```
Expected: a committed `Editorial restructure: Archie_Project`; the diff shows consolidated theses (producer/verifier, Devin moat, spec-bottleneck stated once), regrouped TPS material, a rebuilt 2–4 paragraph lead, and **no dropped `conv:` hashes**.

- [ ] **Step 3: Human review checkpoint**

STOP. Present the before/after to the user for the nuance-loss judgement the deterministic gate cannot make. Do not wire into `nightly.sh`. If the user approves the quality, the separate nightly-wiring follow-up (out of scope here) can proceed; if not, iterate on `EDITORIAL_PROMPT` and re-run Step 2.

---

## Self-Review

**1. Spec coverage:**
- Standalone `scripts/wikify.ts` + CLI (`--bucket`/`--all`/`--changed-since`/`--dry-run`/`--floor`) → Tasks 1–8.
- Input is article text only, no chunks → Task 6 prompt + Task 7 orchestrator.
- Info-preserving + verification gate (citation preservation, footnote integrity, word-floor, structural sanity) → Tasks 2–3, enforced in Task 7.
- Perpetual-not-convergent + consolidate/regroup/lead mandate → Task 6 prompt; `unchanged` short-circuit in Task 7.
- Cross-article actions → Talk signal (not executed) → Task 4 split + Task 7 append.
- Own commit `Editorial restructure: <stem>` → Task 7/8.
- Not wired into nightly; manual-prove rollout → no `nightly.sh` task; Task 9 is the acceptance gate.
- Tests for detector + gate incl. a dropped-citation fixture that must reject → Tasks 3, 5, 7. No spec gap found.

**2. Placeholder scan:** No TBD/TODO; every code step contains complete runnable code; commands have expected output.

**3. Type consistency:** `CheckResult` (Tasks 2,3), `VerifyOptions.floor` (Task 3) matches `WikifyOptions.floor`/`parseArgs` default 0.7 (Tasks 7,8); `ArticleIO` method names (`readArticle`/`writeArticle`/`appendTalk`/`commit`/`callModel`) identical in Task 7 definition, Task 7 tests, and Task 8 `ioFor`. `SplitOutput.article/talk` consistent across Tasks 4 and 7. `WikifyResult.status` values (`edited`/`would-edit`/`rejected`/`unchanged`) consistent between Task 7 impl, Task 7 tests, and Task 8 summary.
