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

    const haystack = caseSensitive ? q : q.toLowerCase();
    const hits: SearchHit[] = [];
    const summaries: ArticleSearchSummary[] = [];

    for (const name of names.sort()) {
        if (!name.endsWith(".md")) continue;
        const stem = name.slice(0, -3);
        let content: string;
        try {
            content = await readFile(join(articlesDir, name), "utf8");
        } catch {
            continue;
        }

        const occurrences = countSubstringOccurrences(content, q, caseSensitive);
        if (occurrences > 0) summaries.push({ article: stem, occurrences });

        if (hits.length >= limit) continue;

        const lines = content.split(/\r?\n/);
        let inFence = false;
        let lastAnchor: string | null = null;

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
            if (compareLine.includes(haystack)) {
                hits.push({
                    article: stem,
                    anchor: lastAnchor,
                    line: lineNo,
                    excerpt: line.trim(),
                });
                if (hits.length >= limit) break;
            }
        }
    }

    summaries.sort(
        (a, b) =>
            b.occurrences - a.occurrences || a.article.localeCompare(b.article)
    );

    return { summaries, hits };
}
