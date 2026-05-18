#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
    expandDreamingPath,
    parseToc,
    extractSection,
    readArticleMarkdown,
    listArticles,
    getArticleLinks,
    searchArticles,
    articleResourceUri,
    parseArticleResourceUri,
} from "./tools/articles.js";
import { lucienSetup } from "./tools/setup.js";

// The `instructions` string is returned in the MCP `initialize` handshake and
// surfaced to the model by every compliant client (Claude Code, Claude Desktop,
// claude.ai connectors) at connect time. This is the cross-client priming
// channel — the equivalent of a SessionStart hook, but it works everywhere the
// MCP is connected, including hosted/remote deployments.
const LUCIEN_INSTRUCTIONS = `The Dreaming (served by this server) is your synthesized, persistent memory of this user — a CURRENT-STATE LEDGER, not a transcript archive. Each ARTICLE is the consolidated understanding of its topic, already distilled from many past conversations: the synthesis from messages into understanding has been done for you. Recall is not understanding — do not reconstruct what the user thinks by searching raw history or stitching fragments together. Find the relevant article and read it; the article itself already contains the answer.

Before doing substantive work for this user, query the Dreaming instead of guessing:
- lucien_article_search — find the article(s) for a topic (start here)
- lucien_list_articles — full index
- lucien_article_read / lucien_article_section / lucien_article_toc — read an article in full
- lucien_get_links — follow the wiki graph when a topic genuinely spans articles

A topic may sometimes span more than one article, but each article is itself the complete synthesized understanding for its subject — you are reading a finished answer, not assembling one from pieces. Treat the article as the user's current position; \`conv:HASH\` footnotes are provenance — rely on the synthesized claim and trace rather than confabulate. Do not make the user re-explain what the Dreaming already records.

Use what you find SILENTLY, as priors that shape what you propose and what you don't — like a long-time colleague, not a system performing recall. Do not narrate it back ("Welcome back, I see you're working on X"); the value shows up in the relevance of the response, not in name-dropping. Treat doing the lookup BEFORE responding as itself the helpful move: overriding the pull to answer immediately from first principles is the point, not a detour.`;

const server = new Server(
    {
        name: "lucien",
        version: "0.0.1",
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
        instructions: LUCIEN_INSTRUCTIONS,
    }
);

// Resources expose the Dreaming as documents: every article is an addressable,
// readable resource. This is "lookup, not search" — clients (Claude Desktop,
// claude.ai, Claude Code) can list and attach articles directly. Reuses the
// same file logic as the tools; the default Dreaming path (~/Dreaming) is used
// since resource URIs carry no per-call dreaming_path.
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const dreamingPath = expandDreamingPath(undefined);
    let articles: string[] = [];
    try {
        ({ articles } = await listArticles(dreamingPath));
    } catch {
        // No Dreaming on this machine yet — expose nothing rather than error.
        return { resources: [] };
    }
    return {
        resources: articles.map((stem) => ({
            uri: articleResourceUri(stem),
            name: stem,
            mimeType: "text/markdown",
        })),
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const stem = parseArticleResourceUri(uri);
    if (!stem) {
        throw new Error(`Unknown resource URI: ${uri}`);
    }
    const dreamingPath = expandDreamingPath(undefined);
    const { content } = await readArticleMarkdown(dreamingPath, stem);
    return {
        contents: [{ uri, mimeType: "text/markdown", text: content }],
    };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "lucien_setup",
            description: `Initialize a new Dreaming directory at the given path (default ~/Dreaming). Creates the standard structure: articles/, Meta/ with default editorial conventions, Talk/, git history. Idempotent — running again on an existing Dreaming will not overwrite anything.

WHEN TO USE: Only call this if the user explicitly asks to set up Lucien, create a new Dreaming, or initialize a wiki. If the user is already referencing articles or talking about their existing Dreaming, do NOT call this — they have one and you should use the read tools instead.

If unsure whether a Dreaming exists at the default path, the right move is to attempt lucien_article_search with any query — if it succeeds, the Dreaming is already there. Only call lucien_setup when the user signals explicit initialization intent.`,
            inputSchema: {
                type: "object",
                properties: {
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
            },
        },
        {
            name: "ping",
            description: `Health check — returns pong.

WHEN TO USE: Only when something upstream must verify the Lucien MCP server is reachable (connector wiring, integration smoke tests, debugging transport issues). Not part of normal Dreaming retrieval — use the article and search tools for wiki content.`,
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
        {
            name: "lucien_article_toc",
            description: `Return the table of contents for an article: every heading with its depth, title, and anchor slug.

WHEN TO USE: Call this when you know the relevant article but want to see its internal structure before deciding what to read. Useful for:
- Inspecting a large article (e.g., one with many sections) before committing to a full read
- Finding the right section to call lucien_article_section against, when you didn't get a direct hit from search
- Showing the user the structure of an article they're asking about
- Picking the right section to follow when a wikilink points to a long article

Lightweight — pure structural parse, no content returned. Cheap to call speculatively to plan your retrieval strategy.

Anchors returned here are the exact strings to pass to lucien_article_section. Same slugification as lucien_article_search hits.`,
            inputSchema: {
                type: "object",
                properties: {
                    article: {
                        type: "string",
                        description:
                            'Filename stem with underscores (e.g. Mechanical_Development_Manifesto). Not display titles or abbreviations. Use lucien_article_search if unsure.',
                    },
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
                required: ["article"],
            },
        },
        {
            name: "lucien_article_section",
            description: `Read one section of an article by its anchor slug — from the heading line through to the next same-or-shallower heading. Includes the section heading itself.

WHEN TO USE: This is your default read tool for focused questions. If lucien_article_search returned an anchor that looks relevant, call this with that anchor rather than reading the full article. Section-level reads keep context budget tight and give you exactly the material the user is asking about. Most articles are organized so each section answers a specific sub-question; section reads honor that structure.

Use lucien_article_read instead when you need broader context, when the section isn't enough, or when you don't have an anchor yet.

ANCHOR FORMAT: Lowercase, hyphenated, punctuation stripped — the GitHub / Obsidian slug convention. "KNN filter-order pitfall" becomes "knn-filter-order-pitfall". Get anchors from lucien_article_toc or from lucien_article_search hits.

WIKILINKS WITHIN SECTIONS: Sections contain [[Other_Article]] references just like full articles. Follow them when relevant — the link is the user's own indication that the related article matters here.`,
            inputSchema: {
                type: "object",
                properties: {
                    article: {
                        type: "string",
                        description:
                            'Filename stem with underscores (e.g. Mechanical_Development_Manifesto). Not display titles or abbreviations. Use lucien_article_search if unsure.',
                    },
                    anchor: {
                        type: "string",
                        description:
                            "Section anchor slug (same as TOC anchor), e.g. knn-filter-order-pitfall.",
                    },
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
                required: ["article", "anchor"],
            },
        },
        {
            name: "lucien_article_read",
            description: `Read the full markdown body of an article in the Dreaming. Returns the complete file content including frontmatter, all sections, See also, and References.

WHEN TO USE: Reach for full-article read when the user's question spans multiple sections of an article, when you don't yet know which section is relevant, or when the article structure itself matters (article overview, broad context for a topic). For narrow questions where you already have a section anchor (from search results or TOC), prefer lucien_article_section to keep context focused.

WIKILINKS: Articles contain [[Other_Article]] references. These are real cross-references to other articles in the Dreaming. Follow them with another lucien_article_read call when the linked concept is relevant to the user's question. The link structure encodes the user's actual conceptual graph — traversing it brings in the context the user themselves considers related.

The \`article\` parameter is the filename stem with underscores (e.g., "Mechanical_Development_Manifesto", not "Mechanical Development Manifesto" or "MDM"). Use lucien_article_search if you don't know the exact filename.`,
            inputSchema: {
                type: "object",
                properties: {
                    article: {
                        type: "string",
                        description:
                            'Filename stem with underscores (e.g. Mechanical_Development_Manifesto). Not display titles or abbreviations. Use lucien_article_search if unsure.',
                    },
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
                required: ["article"],
            },
        },
        {
            name: "lucien_get_links",
            description: `Resolve internal wikilinks (\`[[...]]\`) for a single article against the whole wiki. Returns \`outbound\` (distinct article stems this page links to) and \`inbound\` (distinct stems of pages that link here). Only targets that match an existing \`articles/*.md\` stem are included; citation links like \`[[conv:...]]\` are skipped. Pipe aliases (\`[[Target|label]]\`), section fragments (\`[[Target#heading]]\`), spaces vs underscores in titles, and case differences are normalized when resolving to filenames. Wikilinks inside fenced code blocks are ignored — same spirit as heading parsing elsewhere.

WHEN TO USE: Call when you're navigating the user's conceptual graph rather than reading prose sequentially — exploring what an article connects to, finding backlinks ("who references this topic?"), planning multi-hop context before opening files, or explaining how a theme threads through the wiki. Prefer this over blindly regex-scanning markdown yourself: it applies the same resolution rules Lucien expects across the corpus.

RELATIONSHIP TO READ TOOLS: This returns stems only. Follow edges with lucien_article_read, or drill lucien_article_toc first when an inbound neighbor is large.

LIMITATIONS: Stub links to articles that do not yet exist disappear from both lists until the target file is created. Purely textual mentions without wikilink brackets are not edges — use lucien_article_search for those.`,
            inputSchema: {
                type: "object",
                properties: {
                    article: {
                        type: "string",
                        description:
                            'Filename stem with underscores (e.g. Mechanical_Development_Manifesto). Not display titles or abbreviations. Use lucien_article_search if unsure.',
                    },
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
                required: ["article"],
            },
        },
        {
            name: "lucien_list_articles",
            description: `List every wiki article in the Dreaming: the filename stem of each \`*.md\` file under \`articles/\`, sorted alphabetically. Each stem is the exact \`article\` argument for lucien_article_read, lucien_article_toc, and lucien_article_section (underscore form, e.g. \`Mechanical_Development_Manifesto\`).

WHEN TO USE: Reach for this when you need the wiki inventory without a search substring — the user asks what topics or articles exist, wants to browse what has been synthesized, you're verifying that a wikilink target article is present before opening it, or you're disambiguating similarly named concepts after search returned noisy hits. Also useful as orientation when you're new to this Dreaming and need to see the shape of the corpus before drilling into reads.

RELATIONSHIP TO SEARCH: lucien_article_search answers "where does X appear?" with ranked hits and anchors. This tool answers "what articles exist?" with a flat catalog. Prefer search aggressively whenever you have any substantive keyword, name fragment, or phrase — it surfaces relevance and section anchors. Prefer listing when the question is explicitly bibliographic or structural (full roster, sanity-check filenames, confirm a stem exists). Many workflows combine both: list to scan the territory, search to zoom.

Lightweight — directory listing only; no markdown bodies are read. Cheap and safe to call while planning a multi-step retrieval strategy.

FOLLOW-UP: Treat the returned stems as authoritative keys into the rest of the toolkit. Open structure with lucien_article_toc before committing to lucien_article_read. Follow \`[[Stem_With_Underscores]]\` wikilinks from articles by passing the same stem here and to the read tools.`,
            inputSchema: {
                type: "object",
                properties: {
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
            },
        },
        {
            name: "lucien_article_search",
            description: `Search the user's personal wiki (the Dreaming) for substrings matching the query. Returns per-article occurrence counts (ranked) and sample line-level hits with section anchors.

WHEN TO USE: Call this whenever the user references their own work, projects, opinions, history, preferences, products they use, people they know, or any accumulated personal context. The Dreaming contains the user's structured understanding of their own world — reaching for it lets you engage with substantive context instead of asking them to re-explain things.

Reach for this aggressively. It's much cheaper to search and find nothing than to ask "could you tell me more about X" when the user has already spent hours discussing X in past conversations. The wiki is the answer to "do I already know this about you?"

FOLLOW-UP: Hits include \`anchor\` values that thread directly into lucien_article_section — prefer section reads over full article reads when the question is narrow. Use lucien_article_read only when you need broad article context or the matched section's surroundings.

Case-insensitive by default. Use case_sensitive: true only when distinguishing "API" from "api" matters for the query.`,
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Substring to search for in each article line.",
                    },
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                    limit: {
                        type: "number",
                        description:
                            "Max line-level hits in hits[] (default 50). summaries always list every article with at least one occurrence.",
                    },
                    case_sensitive: {
                        type: "boolean",
                        description: "If true, match case exactly (default false).",
                    },
                },
                required: ["query"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "ping") {
        return { content: [{ type: "text", text: "pong" }] };
    }

    if (name === "lucien_setup") {
        const result = await lucienSetup(args as { dreaming_path?: string });
        return { content: [{ type: "text", text: result }] };
    }

    if (name === "lucien_article_toc") {
        const p = args as { article: string; dreaming_path?: string };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const { content } = await readArticleMarkdown(dreamingPath, p.article);
        const toc = parseToc(content);
        return { content: [{ type: "text", text: JSON.stringify({ article: p.article, toc }, null, 2) }] };
    }

    if (name === "lucien_article_section") {
        const p = args as { article: string; anchor: string; dreaming_path?: string };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const { content } = await readArticleMarkdown(dreamingPath, p.article);
        const section = extractSection(content, p.anchor.trim());
        return {
            content: [
                {
                    type: "text",
                    text:
                        section === null
                            ? JSON.stringify(
                                  {
                                      article: p.article,
                                      anchor: p.anchor,
                                      error: "section_not_found",
                                  },
                                  null,
                                  2
                              )
                            : JSON.stringify(
                                  { article: p.article, anchor: p.anchor, markdown: section },
                                  null,
                                  2
                              ),
                },
            ],
        };
    }

    if (name === "lucien_article_read") {
        const p = args as { article: string; dreaming_path?: string };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const { content } = await readArticleMarkdown(dreamingPath, p.article);
        return { content: [{ type: "text", text: content }] };
    }

    if (name === "lucien_get_links") {
        const p = args as { article: string; dreaming_path?: string };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const links = await getArticleLinks(dreamingPath, p.article);
        return {
            content: [{ type: "text", text: JSON.stringify(links, null, 2) }],
        };
    }

    if (name === "lucien_list_articles") {
        const p = args as { dreaming_path?: string };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const listed = await listArticles(dreamingPath);
        return {
            content: [{ type: "text", text: JSON.stringify(listed, null, 2) }],
        };
    }

    if (name === "lucien_article_search") {
        const p = args as {
            query: string;
            dreaming_path?: string;
            limit?: number;
            case_sensitive?: boolean;
        };
        const dreamingPath = expandDreamingPath(p.dreaming_path);
        const { summaries, hits } = await searchArticles(dreamingPath, p.query, {
            limit: p.limit,
            case_sensitive: p.case_sensitive,
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ summaries, hits }, null, 2) }],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);