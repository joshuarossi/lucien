import { test, expect } from "bun:test";
import { normalizeFootnotes } from "./normalize-footnotes.ts";
import { checkFootnoteIntegrity } from "./wikify.ts";

const REFS = "\n\n## References\n\n";

test("healthy article is a byte-identical no-op", () => {
    const a =
        "# T\n\nClaim one.[^1] Claim two.[^2]" +
        REFS +
        "[^1]: `conv:a1b2c3d4` — one\n[^2]: `conv:deadbeef` — two\n";
    const r = normalizeFootnotes(a);
    expect(r.changed).toBe(false);
    expect(r.article).toBe(a);
    expect(r.talk).toBeNull();
});

test("orphan marker (Lucien_Synthesis_Pipeline shape) is dropped, prose intact", () => {
    // defs 1..2, body cites [^1][^2] and a phantom [^9]
    const a =
        "# T\n\nA.[^1] B.[^2] C is unsourced.[^9]" +
        REFS +
        "[^1]: `conv:a1b2c3d4` — one\n[^2]: `conv:deadbeef` — two\n";
    const r = normalizeFootnotes(a);
    expect(r.changed).toBe(true);
    expect(r.droppedMarkers).toEqual([9]);
    expect(r.article).toContain("C is unsourced.\n"); // marker + its space gone
    expect(r.article).not.toContain("[^9]");
    expect(checkFootnoteIntegrity(r.article).ok).toBe(true);
    expect(r.talk).toContain("orphan citation marker");
});

test("orphan definition (Jira shape) is dropped", () => {
    const a =
        "# T\n\nOnly A is cited.[^1]" +
        REFS +
        "[^1]: `conv:a1b2c3d4` — one\n[^2]: `conv:deadbeef` — unused\n";
    const r = normalizeFootnotes(a);
    expect(r.changed).toBe(true);
    expect(r.droppedDefs).toEqual([{ num: 2, conv: "conv:deadbeef" }]);
    expect(r.article).not.toContain("conv:deadbeef");
    expect(checkFootnoteIntegrity(r.article).ok).toBe(true);
});

test("survivors are renumbered contiguously in body order", () => {
    // body order is 3 then 1; defs 1 and 3 exist (2 missing entirely)
    const a =
        "# T\n\nFirst.[^3] Second.[^1]" +
        REFS +
        "[^1]: `conv:11111111` — was one\n[^3]: `conv:33333333` — was three\n";
    const r = normalizeFootnotes(a);
    expect(checkFootnoteIntegrity(r.article).ok).toBe(true);
    expect(r.article).toContain("First.[^1] Second.[^2]");
    expect(r.article).toContain("[^1]: `conv:33333333`");
    expect(r.article).toContain("[^2]: `conv:11111111`");
});

test("idempotent — a second pass is a no-op", () => {
    const a =
        "# T\n\nA.[^1] B.[^2] phantom[^7]" +
        REFS +
        "[^1]: `conv:a1b2c3d4` — one\n[^5]: `conv:deadbeef` — unused\n[^2]: `conv:cafebabe` — two\n";
    const once = normalizeFootnotes(a);
    expect(once.changed).toBe(true);
    expect(checkFootnoteIntegrity(once.article).ok).toBe(true);
    const twice = normalizeFootnotes(once.article);
    expect(twice.changed).toBe(false);
    expect(twice.article).toBe(once.article);
});
