import { test, expect, describe } from "bun:test";
import { sanitizeArticleOutput } from "./sanitize-article.js";

describe("sanitizeArticleOutput", () => {
    test("clean article passes through unchanged (modulo trim)", () => {
        const input = `# My Topic

This is the lead paragraph about the topic.

## Background

Some background information here with enough text to be substantial.
`;
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(input.trim());
    });

    test("strips leading preamble before # Heading", () => {
        const input = `I'll proceed with the only defensible output: an honest stub that fabricates nothing and emits no dead citations.

# My Topic

This is the lead paragraph about the topic. It has enough content to be valid.

## Background

Some background information here.`;
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(`# My Topic

This is the lead paragraph about the topic. It has enough content to be valid.

## Background

Some background information here.`);
    });

    test("strips 'Here is the article:' preamble", () => {
        const input = `Here is the article:

# Topic Title

This is the article body with sufficient content for validation purposes.

## Details

More details here about the topic in question.`;
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(`# Topic Title

This is the article body with sufficient content for validation purposes.

## Details

More details here about the topic in question.`);
    });

    test("removes trailing '**Note for the maintainer:**' block", () => {
        const input = `# My Topic

This is the lead paragraph about the topic with enough content.

## Background

Some background information here.

**Note for the maintainer:** I did not generate the requested citations because the source material did not contain enough detail.`;
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(`# My Topic

This is the lead paragraph about the topic with enough content.

## Background

Some background information here.`);
    });

    test("accepts {{stub}} article with no # heading", () => {
        const input = `{{stub}}

This article has not yet been written. It will be populated in a future synthesis run.`;
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(input.trim());
    });

    test("throws on pure refusal with no heading", () => {
        const input = `I cannot create this article because the source material does not contain enough information to write a meaningful Wikipedia-style entry without fabricating content.`;
        expect(() => sanitizeArticleOutput(input)).toThrow(
            "sanitizeArticleOutput: no markdown heading or {{stub}} found — output is not an article"
        );
    });

    test("throws on empty input", () => {
        expect(() => sanitizeArticleOutput("")).toThrow(
            "sanitizeArticleOutput: no markdown heading or {{stub}} found — output is not an article"
        );
    });

    test("throws on whitespace-only input", () => {
        expect(() => sanitizeArticleOutput("   \n\n   ")).toThrow(
            "sanitizeArticleOutput: no markdown heading or {{stub}} found — output is not an article"
        );
    });

    test("throws when only a sub-heading (##) exists with no top-level # and no {{stub}}", () => {
        const input = `Some preamble text here that is not a heading.

## Sub Heading

Content under the sub-heading which is not a top-level article heading.`;
        expect(() => sanitizeArticleOutput(input)).toThrow(
            "sanitizeArticleOutput: no markdown heading or {{stub}} found — output is not an article"
        );
    });

    test("unwraps fenced ```markdown block", () => {
        const input = "```markdown\n# My Topic\n\nThis is the article body with sufficient content to pass validation.\n\n## Details\n\nMore details here.\n```";
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(`# My Topic

This is the article body with sufficient content to pass validation.

## Details

More details here.`);
    });

    test("unwraps fenced ``` block without language tag", () => {
        const input = "```\n# My Topic\n\nThis is the article body with sufficient content to pass validation.\n\n## Details\n\nMore details here.\n```";
        const result = sanitizeArticleOutput(input);
        expect(result).toBe(`# My Topic

This is the article body with sufficient content to pass validation.

## Details

More details here.`);
    });
});
