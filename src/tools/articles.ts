import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface TocEntry {
    depth: number;
    title: string;
    anchor: string;
}

export interface SearchHit {
    article: string;
    anchor: string | null;
    line: number;
    excerpt: string;
}

/** Non-overlapping substring matches (whole file). */
export function countSubstringOccurrences(
    text: string,
    needle: string,
    caseSensitive: boolean
): number {
    const n = needle.trim();
    if (!n) return 0;
    const haystack = caseSensitive ? text : text.toLowerCase();
    const nd = caseSensitive ? n : n.toLowerCase();
    let count = 0;
    let pos = 0;
    while (true) {
        const idx = haystack.indexOf(nd, pos);
        if (idx === -1) break;
        count++;
        pos = idx + nd.length;
    }
    return count;
}

export interface ArticleSearchSummary {
    article: string;
    occurrences: number;
    /** Distinct query terms that matched this article (multi-term queries). */
    matched_terms?: string[];
    /** Number of query terms that appear in the article's title/stem. */
    title_matches?: number;
}

export function expandDreamingPath(dreaming_path?: string): string {
    const raw = dreaming_path?.trim() || join(homedir(), "Dreaming");
    return raw.replace(/^~(?=$|[/\\])/, homedir());
}

export function slugifyHeading(title: string): string {
    return title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function isFenceLine(line: string): boolean {
    return /^```/.test(line);
}

/** Heading outside fences; depth 1 = `#`, … 6 = `######`. */
function parseHeadingLine(line: string): { depth: number; title: string } | null {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!m) return null;
    return { depth: m[1]!.length, title: m[2]!.trim() };
}

export function parseToc(markdown: string): TocEntry[] {
    const lines = markdown.split(/\r?\n/);
    let inFence = false;
    const toc: TocEntry[] = [];

    for (const line of lines) {
        if (isFenceLine(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        const h = parseHeadingLine(line);
        if (h) {
            toc.push({
                depth: h.depth,
                title: h.title,
                anchor: slugifyHeading(h.title),
            });
        }
    }

    return toc;
}

function fenceAfterLine(lines: string[], lineIdx: number): boolean {
    let inFence = false;
    for (let i = 0; i <= lineIdx; i++) {
        if (isFenceLine(lines[i]!)) inFence = !inFence;
    }
    return inFence;
}

/**
 * First heading with matching anchor wins. Includes the heading line.
 * Stops before the next heading (outside fences) of equal or shallower depth.
 */
export function extractSection(markdown: string, anchor: string): string | null {
    const lines = markdown.split(/\r?\n/);
    let inFence = false;
    let startIdx = -1;
    let startDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        if (isFenceLine(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        const h = parseHeadingLine(line);
        if (!h) continue;

        if (slugifyHeading(h.title) === anchor) {
            startIdx = i;
            startDepth = h.depth;
            break;
        }
    }

    if (startIdx < 0) return null;

    const endIdxExclusive = (() => {
        let fence = fenceAfterLine(lines, startIdx);
        for (let j = startIdx + 1; j < lines.length; j++) {
            const line = lines[j]!;
            if (isFenceLine(line)) {
                fence = !fence;
                continue;
            }
            if (fence) continue;

            const h = parseHeadingLine(line);
            if (h && h.depth <= startDepth) return j;
        }
        return lines.length;
    })();

    return lines.slice(startIdx, endIdxExclusive).join("\n");
}

function normalizeArticleStem(article: string): string {
    const t = article.trim();
    if (!t) throw new Error("article name is required");
    const stem = t.endsWith(".md") ? t.slice(0, -3).trim() : t;
    if (!stem) throw new Error("article name is invalid");
    if (stem.includes("..")) throw new Error("article must not contain ..");
    if (isAbsolute(stem)) throw new Error("article must be a bare filename, not a path");
    if (stem.includes("/") || stem.includes("\\")) {
        throw new Error("article must not contain path separators");
    }
    if (stem.startsWith(".")) throw new Error("article must not be hidden or relative");
    return stem;
}

export async function resolveArticleMarkdownPath(
    dreamingPath: string,
    article: string
): Promise<string> {
    const stem = normalizeArticleStem(article);
    const filePath = join(dreamingPath, "articles", `${stem}.md`);
    try {
        await access(filePath);
    } catch {
        throw new Error(`Article not found: ${stem}.md under ${join(dreamingPath, "articles")}`);
    }
    return filePath;
}

export async function readArticleMarkdown(
    dreamingPath: string,
    article: string
): Promise<{ path: string; content: string }> {
    const path = await resolveArticleMarkdownPath(dreamingPath, article);
    const content = await readFile(path, "utf8");
    return { path, content };
}

/**
 * Stable MCP resource URI for an article. The scheme is the addressing
 * contract clients use to list/read the Dreaming as documents — keep it
 * stable (renaming it breaks every client's saved references).
 */
const ARTICLE_URI_PREFIX = "lucien://article/";

export function articleResourceUri(stem: string): string {
    return ARTICLE_URI_PREFIX + encodeURIComponent(stem);
}

/** Inverse of articleResourceUri. Returns the safe stem, or null if the URI is not a valid article resource. */
export function parseArticleResourceUri(uri: string): string | null {
    if (!uri.startsWith(ARTICLE_URI_PREFIX)) return null;
    const raw = uri.slice(ARTICLE_URI_PREFIX.length);
    if (!raw) return null;
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    try {
        return normalizeArticleStem(decoded);
    } catch {
        return null;
    }
}

/** Filename stems for every `*.md` article under `articles/`, sorted alphabetically (non-recursive). */
export async function listArticles(dreamingPath: string): Promise<{ articles: string[] }> {
    const articlesDir = join(dreamingPath, "articles");
    let names: string[];
    try {
        names = await readdir(articlesDir);
    } catch {
        throw new Error(`Articles directory not found: ${articlesDir}`);
    }

    const stems = names
        .filter((n) => n.endsWith(".md") && !n.startsWith("."))
        .map((n) => n.slice(0, -3))
        .sort((a, b) => a.localeCompare(b));

    return { articles: stems };
}

const wikilinkInnerRe = /\[\[([^\]]+)\]\]/g;

/** Raw wikilink targets from prose only (not fenced code); includes `[[conv:...]]` etc. — filter with resolve. */
export function extractWikilinkTargetsFromMarkdown(markdown: string): string[] {
    const lines = markdown.split(/\r?\n/);
    let inFence = false;
    const out: string[] = [];

    for (const line of lines) {
        if (isFenceLine(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        wikilinkInnerRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = wikilinkInnerRe.exec(line)) !== null) {
            const inner = m[1]!.trim();
            if (!inner || /^conv:/i.test(inner)) continue;
            const pipe = inner.split("|")[0]!;
            const hash = pipe.split("#")[0]!.trim();
            if (hash) out.push(hash);
        }
    }

    return out;
}

/** Map wikilink display text to an existing article stem (underscore filenames). */
export function resolveWikilinkToStem(raw: string, stems: Set<string>): string | null {
    const base = raw.trim();
    if (!base) return null;
    if (stems.has(base)) return base;
    const underscored = base.replace(/\s+/g, "_");
    if (stems.has(underscored)) return underscored;
    const lower = underscored.toLowerCase();
    const spacedLower = base.replace(/\s+/g, " ").trim().toLowerCase();
    for (const stem of stems) {
        if (stem.toLowerCase() === lower) return stem;
        if (stem.replace(/_/g, " ").trim().toLowerCase() === spacedLower) return stem;
    }
    return null;
}

/**
 * Outbound = other articles this file links to; inbound = articles that link to this file.
 * Self-links omitted. Unresolved wikilinks (no matching `.md`) omitted.
 */
export async function getArticleLinks(
    dreamingPath: string,
    article: string
): Promise<{ outbound: string[]; inbound: string[] }> {
    const stem = normalizeArticleStem(article);
    const { articles } = await listArticles(dreamingPath);
    const stemSet = new Set(articles);

    await resolveArticleMarkdownPath(dreamingPath, stem);

    const articlesDir = join(dreamingPath, "articles");
    const outboundByStem = new Map<string, Set<string>>();

    for (const name of articles) {
        const content = await readFile(join(articlesDir, `${name}.md`), "utf8");
        const targets = extractWikilinkTargetsFromMarkdown(content);
        const resolved = new Set<string>();
        for (const t of targets) {
            const r = resolveWikilinkToStem(t, stemSet);
            if (r !== null && r !== name) resolved.add(r);
        }
        outboundByStem.set(name, resolved);
    }

    const outbound = [...(outboundByStem.get(stem) ?? new Set())].sort((a, b) =>
        a.localeCompare(b)
    );

    const inbound: string[] = [];
    for (const [from, targets] of outboundByStem) {
        if (from === stem) continue;
        if (targets.has(stem)) inbound.push(from);
    }
    inbound.sort((a, b) => a.localeCompare(b));

    return { outbound, inbound };
}

export async function searchArticles(
    dreamingPath: string,
    query: string,
    options?: { limit?: number; case_sensitive?: boolean }
): Promise<{ summaries: ArticleSearchSummary[]; hits: SearchHit[] }> {
    const limit = options?.limit ?? 50;
    const caseSensitive = options?.case_sensitive ?? false;
    const q = query.trim();
    if (!q) throw new Error("search query is required");

    const articlesDir = join(dreamingPath, "articles");
    let names: string[];
    try {
        names = await readdir(articlesDir);
    } catch {
        throw new Error(`Articles directory not found: ${articlesDir}`);
    }

    // Split the query into terms on whitespace and scan each independently;
    // aggregate per-article so multi-word queries that never appear contiguously
    // (e.g. "v3 kaizen rollout") still surface the articles that hit the most
    // distinct terms, rather than returning zero. A single-term query (no
    // whitespace) behaves identically to a plain substring search.
    //
    // Drop a small list of trivial English stopwords so a query like
    // "the kaizen" doesn't ALSO scan for "the" (which matches every article
    // and rewards length over relevance). If a query is ONLY stopwords (e.g.
    // "the of"), fall back to scanning the whole query as a single substring
    // so we don't silently return zero.
    const STOPWORDS = new Set([
        "the", "a", "an", "of", "for", "to", "in", "on", "at",
        "and", "or", "is", "it", "as", "with",
    ]);
    const rawTerms = q.split(/\s+/).filter((t) => t.length > 0);
    const filtered = rawTerms.filter(
        (t) => !STOPWORDS.has(caseSensitive ? t.toLowerCase() : t.toLowerCase())
    );
    const terms = filtered.length > 0 ? filtered : [q];
    const isMulti = terms.length > 1;

    const summaries: ArticleSearchSummary[] = [];
    type HitWithCount = SearchHit & { _termCount: number };
    const allHits: HitWithCount[] = [];

    for (const name of names.sort()) {
        if (!name.endsWith(".md")) continue;
        const stem = name.slice(0, -3);
        let content: string;
        try {
            content = await readFile(join(articlesDir, name), "utf8");
        } catch {
            continue;
        }

        const matchedTerms: string[] = [];
        let totalOccurrences = 0;
        for (const t of terms) {
            const n = countSubstringOccurrences(content, t, caseSensitive);
            if (n > 0) {
                matchedTerms.push(t);
                totalOccurrences += n;
            }
        }
        if (totalOccurrences === 0) continue;

        // Title/stem match bonus: a query term appearing in the article's
        // stem (the H1 by convention here) signals the article is *about*
        // that term, not just mentioning it. Used as a secondary sort key
        // so e.g. `archie` foregrounds `Archie_Project` over articles that
        // merely reference it. Underscore separators don't interfere with
        // substring containment.
        const stemForMatch = caseSensitive ? stem : stem.toLowerCase();
        let titleMatches = 0;
        for (const t of terms) {
            const tL = caseSensitive ? t : t.toLowerCase();
            if (stemForMatch.includes(tL)) titleMatches++;
        }

        const summary: ArticleSearchSummary = {
            article: stem,
            occurrences: totalOccurrences,
        };
        if (isMulti) summary.matched_terms = matchedTerms;
        if (titleMatches > 0) summary.title_matches = titleMatches;
        summaries.push(summary);

        // Per-line hits: a line is a hit if it contains ANY term; lines that
        // contain MORE distinct terms rank higher in the final hit list.
        const lines = content.split(/\r?\n/);
        let inFence = false;
        let lastAnchor: string | null = null;
        const lcTerms = caseSensitive
            ? matchedTerms
            : matchedTerms.map((t) => t.toLowerCase());

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            const lineNo = i + 1;

            if (isFenceLine(line)) {
                inFence = !inFence;
            } else if (!inFence) {
                const h = parseHeadingLine(line);
                if (h) lastAnchor = slugifyHeading(h.title);
            }

            const compareLine = caseSensitive ? line : line.toLowerCase();
            let termCount = 0;
            for (const t of lcTerms) {
                if (compareLine.includes(t)) termCount++;
            }
            if (termCount > 0) {
                allHits.push({
                    article: stem,
                    anchor: lastAnchor,
                    line: lineNo,
                    excerpt: line.trim(),
                    _termCount: termCount,
                });
            }
        }
    }

    // Rank summaries: distinct terms matched (desc) → title/stem matches
    // (desc) → total occurrences (desc) → article name (asc) for stability.
    summaries.sort((a, b) => {
        const am = a.matched_terms?.length ?? 1;
        const bm = b.matched_terms?.length ?? 1;
        if (bm !== am) return bm - am;
        const at = a.title_matches ?? 0;
        const bt = b.title_matches ?? 0;
        if (bt !== at) return bt - at;
        if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
        return a.article.localeCompare(b.article);
    });

    // Rank hits: most-term-coverage first, then by article, then by line.
    allHits.sort(
        (a, b) =>
            b._termCount - a._termCount ||
            a.article.localeCompare(b.article) ||
            a.line - b.line
    );
    const hits: SearchHit[] = allHits.slice(0, limit).map(({ _termCount, ...h }) => h);

    return { summaries, hits };
}
