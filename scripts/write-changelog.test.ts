import { test, expect } from "bun:test";
import {
    parseChanges,
    buildChangelogSection,
    prependSection,
} from "./write-changelog.ts";

test("parseChanges classifies A/M/D and ignores non-article paths", () => {
    const diff = [
        "A\tarticles/Apex_Web_Broker_B_Theming.md",
        "M\tarticles/Archie_Project.md",
        "D\tarticles/Old_Topic.md",
        "M\tMeta/Editorial_Guidelines.md", // not under articles/ — ignored
        "M\tTalk/Archie_Project.md", // not under articles/ — ignored
    ].join("\n");
    expect(parseChanges(diff)).toEqual([
        { kind: "new", article: "Apex_Web_Broker_B_Theming" },
        { kind: "updated", article: "Archie_Project" },
        { kind: "removed", article: "Old_Topic" },
    ]);
});

test("parseChanges treats a rename as updated, using the new path", () => {
    const diff = "R096\tarticles/Old_Name.md\tarticles/New_Name.md";
    expect(parseChanges(diff)).toEqual([
        { kind: "updated", article: "New_Name" },
    ]);
});

test("buildChangelogSection orders new → updated → removed, alpha within", () => {
    const section = buildChangelogSection(
        [
            { kind: "updated", article: "Zebra" },
            { kind: "new", article: "Banana" },
            { kind: "updated", article: "Apple" },
            { kind: "new", article: "Avocado" },
        ],
        "2026-05-21"
    );
    expect(section).toBe(
        "## 2026-05-21 — OK\n\n" +
            "- new: Avocado\n" +
            "- new: Banana\n" +
            "- updated: Apple\n" +
            "- updated: Zebra\n"
    );
});

test("buildChangelogSection writes a placeholder line when nothing changed", () => {
    const section = buildChangelogSection([], "2026-05-21");
    expect(section).toBe("## 2026-05-21 — OK\n\n- no article changes\n");
});

test("prependSection creates the file with a header on first run", () => {
    const section = "## 2026-05-21 — OK\n\n- new: X\n";
    const out = prependSection(null, section);
    expect(out.startsWith("# Changelog\n")).toBe(true);
    expect(out).toContain(section);
});

test("prependSection inserts a new section newest-first, before existing ones", () => {
    const existing =
        "# Changelog\n\nintro text.\n\n" +
        "## 2026-05-20 — OK\n\n- updated: Old\n";
    const out = prependSection(existing, "## 2026-05-21 — OK\n\n- new: New\n");
    // New section appears before the old one.
    expect(out.indexOf("2026-05-21")).toBeLessThan(out.indexOf("2026-05-20"));
    // Header/intro preserved at the top.
    expect(out.startsWith("# Changelog\n\nintro text.")).toBe(true);
});
