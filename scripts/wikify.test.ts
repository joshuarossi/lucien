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
