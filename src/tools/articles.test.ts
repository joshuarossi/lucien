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

test("searchArticles multi-word: ranks by distinct terms matched, then occurrences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-multi-"));
    await mkdir(join(dir, "articles"));
    // a: hits all three terms (most coverage) but few total occurrences
    await writeFile(join(dir, "articles", "a.md"), "v3 was a thing\nkaizen happens\nrollout\n");
    // b: hits two terms with many occurrences (would dominate by sum alone)
    await writeFile(
        join(dir, "articles", "b.md"),
        "kaizen kaizen kaizen kaizen\nrollout rollout\n"
    );
    // c: hits only one common term
    await writeFile(join(dir, "articles", "c.md"), "rollout only\n");
    // d: matches nothing
    await writeFile(join(dir, "articles", "d.md"), "unrelated content here\n");

    const r = await searchArticles(dir, "v3 kaizen rollout");
    expect(r.summaries.map((s) => s.article)).toEqual(["a", "b", "c"]);
    expect(r.summaries[0]!.matched_terms).toEqual(["v3", "kaizen", "rollout"]);
    expect(r.summaries[1]!.matched_terms).toEqual(["kaizen", "rollout"]);
    expect(r.summaries[2]!.matched_terms).toEqual(["rollout"]);
});

test("searchArticles multi-word: contiguous phrase that never appears still surfaces best-coverage articles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-phrase-"));
    await mkdir(join(dir, "articles"));
    // The exact phrase "v3 kaizen rollout" never appears, but tps hits all 3
    await writeFile(
        join(dir, "articles", "tps.md"),
        "Discussion of kaizen and the v3 work, plus rollout planning.\n"
    );
    await writeFile(join(dir, "articles", "noise.md"), "irrelevant text\n");

    const r = await searchArticles(dir, "v3 kaizen rollout");
    expect(r.summaries.length).toBe(1);
    expect(r.summaries[0]!.article).toBe("tps");
});

test("searchArticles multi-word: hits prefer lines with more distinct term coverage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-hits-"));
    await mkdir(join(dir, "articles"));
    await writeFile(
        join(dir, "articles", "x.md"),
        "first line has v3\nsecond line has v3 and kaizen\nthird line has only kaizen\n"
    );

    const r = await searchArticles(dir, "v3 kaizen");
    expect(r.hits[0]!.line).toBe(2); // the two-term line ranks first
    expect(r.hits.map((h) => h.line)).toEqual([2, 1, 3]);
});

test("searchArticles boosts articles whose stem contains a query term", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-title-"));
    await mkdir(join(dir, "articles"));
    // about.md references archie many times in body; Archie_Project's stem
    // contains "archie" so it should outrank about.md despite fewer mentions.
    await writeFile(
        join(dir, "articles", "about.md"),
        "archie archie archie archie\n"
    );
    await writeFile(join(dir, "articles", "Archie_Project.md"), "archie once\n");
    const r = await searchArticles(dir, "archie");
    expect(r.summaries[0]!.article).toBe("Archie_Project");
    expect(r.summaries[0]!.title_matches).toBe(1);
    expect(r.summaries[1]!.article).toBe("about");
});

test("searchArticles drops stopwords from multi-word queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-stop-"));
    await mkdir(join(dir, "articles"));
    // hot.md hits only the meaningful term; noise.md hits only "the".
    await writeFile(join(dir, "articles", "hot.md"), "kaizen is everywhere here\n");
    await writeFile(join(dir, "articles", "noise.md"), "the the the the\n");
    const r = await searchArticles(dir, "the kaizen");
    expect(r.summaries.length).toBe(1);
    expect(r.summaries[0]!.article).toBe("hot");
    // The remaining single meaningful term means no multi-term metadata.
    expect(r.summaries[0]!.matched_terms).toBeUndefined();
});

test("searchArticles stopword-only query falls back to whole-query substring", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-stoponly-"));
    await mkdir(join(dir, "articles"));
    await writeFile(join(dir, "articles", "a.md"), "the of the of\n");
    const r = await searchArticles(dir, "the of");
    // Falls back to whole-query substring, which appears once contiguously.
    expect(r.summaries.length).toBe(1);
    expect(r.summaries[0]!.article).toBe("a");
});

test("searchArticles single-term: backward-compatible (no matched_terms on summary)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucien-search-single-"));
    await mkdir(join(dir, "articles"));
    await writeFile(join(dir, "articles", "x.md"), "alpha alpha beta\n");
    const r = await searchArticles(dir, "alpha");
    expect(r.summaries).toEqual([{ article: "x", occurrences: 2 }]);
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
