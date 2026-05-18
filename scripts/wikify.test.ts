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
