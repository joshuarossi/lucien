import { test, expect } from "bun:test";
import { extractConvHashes, checkFootnoteIntegrity } from "./wikify.js";

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

import { buildEditorialPrompt } from "./wikify.js";

test("buildEditorialPrompt embeds the article and the hard invariants", () => {
    const p = buildEditorialPrompt("# Sample\n\nText with a claim.[^1]");
    expect(p).toContain("# Sample\n\nText with a claim.[^1]");
    expect(p).toContain("Wikipedia editor");
    expect(p).toContain("must survive"); // info-preserving invariant
    expect(p).toContain("<<<TALK>>>"); // cross-article contract
    expect(p).toContain("not optimize for a small diff"); // perpetual-not-convergent
});

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
    expect(spy.written).toBe(good);
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
        "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n";
    const { spy, io } = deps(async () => good);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: true });
    expect(r.status).toBe("would-edit");
    expect(spy.written).toBeUndefined();
    expect(spy.commit).toBeUndefined();
});

test("wikifyArticle appends a Talk block when the model emits one", async () => {
    const good =
        "# Topic\n\nRebuilt lead.\n\n## Body\n\nConsolidated.[^1][^2]\n\n" +
        "## References\n\n[^1]: `conv:a1b2c3d4` — One\n[^2]: `conv:deadbeef` — Two\n\n" +
        "<<<TALK>>>\nConsider splitting Body into its own article.\n<<<END TALK>>>";
    const { spy, io } = deps(async () => good);
    const r = await wikifyArticle("Topic", io, { floor: 0.7, dryRun: false });
    expect(r.status).toBe("edited");
    expect(spy.talk).toContain("Consider splitting Body");
});
