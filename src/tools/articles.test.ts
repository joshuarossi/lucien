import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import {
    slugifyHeading,
    parseToc,
    extractSection,
    countSubstringOccurrences,
    extractWikilinkTargetsFromMarkdown,
    resolveWikilinkToStem,
    listArticles,
    getArticleLinks,
    searchArticles,
    articleResourceUri,
    parseArticleResourceUri,
} from "./articles.ts";

test("slugifyHeading matches GitHub/Obsidian convention", () => {
    expect(slugifyHeading("KNN filter-order pitfall")).toBe("knn-filter-order-pitfall");
    expect(slugifyHeading("  Hello — World!!  ")).toBe("hello-world");
});

test("parseToc skips headings inside fenced code blocks", () => {
    const md = `
# Real

\`\`\`
## fake heading in fence
\`\`\`

## Also Real
`;
    const toc = parseToc(md);
    expect(toc.map((e) => e.title)).toEqual(["Real", "Also Real"]);
    expect(toc.map((e) => e.anchor)).toEqual(["real", "also-real"]);
});

test("extractSection includes subsection runs until peer heading", () => {
    const md = `
## Aaa
body-a
### Sub
sub-text
## Bbb
body-b
`;
    const s = extractSection(md, "aaa");
    expect(s).toContain("## Aaa");
    expect(s).toContain("### Sub");
    expect(s).not.toContain("## Bbb");
});

test("extractSection does not end at ## inside a code fence", () => {
    const md = `
## Outer
before

\`\`\`
## not a real boundary
\`\`\`

after
## Peer
done
`;
    const s = extractSection(md, "outer");
    expect(s).toContain("## not a real boundary");
    expect(s).toContain("after");
    expect(s).not.toContain("## Peer");
});

test("extractSection uses first duplicate anchor", () => {
    const md = `
## Dup
first
## Dup
second
`;
    const s = extractSection(md, "dup");
    expect(s).toContain("first");
    expect(s).not.toContain("second");
});

test("extractSection returns null when anchor missing", () => {
    expect(extractSection("# Only\n", "nope")).toBeNull();
});

test("countSubstringOccurrences is non-overlapping", () => {
    expect(countSubstringOccurrences("foo foo foo", "foo", true)).toBe(3);
    expect(countSubstringOccurrences("aaaa", "aa", true)).toBe(2);
});

test("listArticles returns sorted stems for markdown files only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-list-"));
    await mkdir(join(dir, "articles"));
    await writeFile(join(dir, "articles", "Zebra.md"), "# Z\n");
    await writeFile(join(dir, "articles", "Alpha.md"), "# A\n");
    await writeFile(join(dir, "articles", "notes.txt"), "skip\n");
    await writeFile(join(dir, "articles", ".hidden.md"), "# H\n");

    const { articles } = await listArticles(dir);
    expect(articles).toEqual(["Alpha", "Zebra"]);
});

test("listArticles throws when articles directory missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-list-missing-"));
    await expect(listArticles(dir)).rejects.toThrow(/Articles directory not found/);
});

test("extractWikilinkTargetsFromMarkdown skips fences, conv links, and fragments", () => {
    const md = `See [[Alpha]] and [[conv:abc]].

\`\`\`
[[Ignored]]
\`\`\`

[[Beta|label]] and [[Other_Article#section]].
`;
    expect(extractWikilinkTargetsFromMarkdown(md)).toEqual(["Alpha", "Beta", "Other_Article"]);
});

test("resolveWikilinkToStem maps spaces and case-insensitive stems", () => {
    const stems = new Set(["Other_Article", "UPPER"]);
    expect(resolveWikilinkToStem("Other Article", stems)).toBe("Other_Article");
    expect(resolveWikilinkToStem("other_article", stems)).toBe("Other_Article");
    expect(resolveWikilinkToStem("upper", stems)).toBe("UPPER");
});

test("getArticleLinks computes outbound, inbound, and drops self-links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-links-"));
    await mkdir(join(dir, "articles"));
    await writeFile(
        join(dir, "articles", "Hub.md"),
        "[[Spoke_One]] [[Spoke Two]] [[Hub]]"
    );
    await writeFile(join(dir, "articles", "Spoke_One.md"), "[[Hub]]");
    await writeFile(join(dir, "articles", "Spoke_Two.md"), "x");

    const hub = await getArticleLinks(dir, "Hub");
    expect(hub.outbound).toEqual(["Spoke_One", "Spoke_Two"]);

    const spokeTwo = await getArticleLinks(dir, "Spoke_Two");
    expect(spokeTwo.inbound).toEqual(["Hub"]);

    const spokeOne = await getArticleLinks(dir, "Spoke_One");
    expect(spokeOne.inbound).toEqual(["Hub"]);
    expect(spokeOne.outbound).toEqual(["Hub"]);
});

test("searchArticles summaries rank by occurrences; hits respect limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-"));
    await mkdir(join(dir, "articles"));
    await writeFile(join(dir, "articles", "dense.md"), "term term\nother\n");
    await writeFile(join(dir, "articles", "sparse.md"), "one term\n");

    const many = await searchArticles(dir, "term", { limit: 100 });
    expect(many.summaries).toEqual([
        { article: "dense", occurrences: 2 },
        { article: "sparse", occurrences: 1 },
    ]);
    expect(many.hits.length).toBe(2);

    const capped = await searchArticles(dir, "term", { limit: 1 });
    expect(capped.summaries).toEqual(many.summaries);
    expect(capped.hits.length).toBe(1);
});

test("articleResourceUri round-trips a plain stem", () => {
    const uri = articleResourceUri("Archie_Project");
    expect(uri).toBe("lucien://article/Archie_Project");
    expect(parseArticleResourceUri(uri)).toBe("Archie_Project");
});

test("articleResourceUri round-trips stems with punctuation", () => {
    for (const stem of ["Recall.life_and_Don't_Wake_The_Baby", "No-Loss_Lottery_Project"]) {
        expect(parseArticleResourceUri(articleResourceUri(stem))).toBe(stem);
    }
});

test("parseArticleResourceUri rejects non-article and traversal URIs", () => {
    expect(parseArticleResourceUri("https://example.com/x")).toBeNull();
    expect(parseArticleResourceUri("lucien://article/")).toBeNull();
    expect(parseArticleResourceUri("lucien://article/..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(parseArticleResourceUri("lucien://article/a%2Fb")).toBeNull();
});
