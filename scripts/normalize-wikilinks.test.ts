import { test, expect } from "bun:test";
import { normalizeWikilinks } from "./normalize-wikilinks.js";

// Canonical article stems present on disk (underscore form).
const stems = new Set([
    "AI_Coding_Workflow",
    "Archie_Project",
    "Lucien_Synthesis_Pipeline",
]);

test("rewrites a plain spaced link whose underscore stem exists", () => {
    const { content, edits } = normalizeWikilinks(
        "see [[AI Coding Workflow]] for context",
        stems
    );
    expect(content).toBe("see [[AI_Coding_Workflow]] for context");
    expect(edits).toBe(1);
});

test("rewrites the target of an aliased link but preserves the alias verbatim", () => {
    // This is the exact form that produced the AI Coding Workflow.md orphan.
    const { content, edits } = normalizeWikilinks(
        "the [[AI Coding Workflow|subagent-driven development pattern]] is key",
        stems
    );
    expect(content).toBe(
        "the [[AI_Coding_Workflow|subagent-driven development pattern]] is key"
    );
    expect(edits).toBe(1);
});

test("rewrites the target of a section link but preserves the #anchor verbatim", () => {
    const { content, edits } = normalizeWikilinks(
        "jump to [[Archie Project#The Clarity run]] here",
        stems
    );
    expect(content).toBe("jump to [[Archie_Project#The Clarity run]] here");
    expect(edits).toBe(1);
});

test("handles the combined #section|alias form", () => {
    const { content, edits } = normalizeWikilinks(
        "[[Archie Project#The journal|the BTS journal]]",
        stems
    );
    expect(content).toBe("[[Archie_Project#The journal|the BTS journal]]");
    expect(edits).toBe(1);
});

test("leaves a true redlink (no matching stem) untouched", () => {
    const { content, edits } = normalizeWikilinks(
        "unrelated [[Mercury (planet)]] and [[La Leche League]]",
        stems
    );
    expect(content).toBe("unrelated [[Mercury (planet)]] and [[La Leche League]]");
    expect(edits).toBe(0);
});

test("is idempotent: already-underscored links are left alone", () => {
    const input =
        "[[AI_Coding_Workflow]] and [[Archie_Project|the project]] and [[Lucien_Synthesis_Pipeline#Stage 4]]";
    const { content, edits } = normalizeWikilinks(input, stems);
    expect(content).toBe(input);
    expect(edits).toBe(0);
});

test("rewrites multiple distinct links in one pass", () => {
    const { content, edits } = normalizeWikilinks(
        "[[AI Coding Workflow]] then [[Archie Project|it]] then [[Mercury (planet)]]",
        stems
    );
    expect(content).toBe(
        "[[AI_Coding_Workflow]] then [[Archie_Project|it]] then [[Mercury (planet)]]"
    );
    expect(edits).toBe(2);
});
