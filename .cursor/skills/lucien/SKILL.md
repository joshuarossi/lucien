---
name: lucien
description: >-
  Use whenever the user references their own work, projects, opinions, history,
  tools, people, or accumulated context — that material likely lives in their
  personal wiki (the Dreaming) and can be queried via Lucien's MCP tools instead
  of asking them to re-explain. Also triggers on explicit mention of Lucien, the
  Dreaming, lucien_* tools, or personal-wiki synthesis.
---

# Lucien

## Core principle

**Default to searching the Dreaming whenever the user references their own context.** Searching and finding nothing is cheap. Asking the user to re-explain something they've spent hours discussing is not. The Dreaming exists so the AI doesn't have to cold-start each session — reach for it aggressively rather than apologizing for not remembering.

## Read-only invariant

The AI **never** writes to the Dreaming. Not via any MCP tool, not by editing files on disk, not by drafting "here's what I'd add to the article" blocks for the user to paste in. **Synthesis is the only writer.** It runs separately, nightly, and integrates new conversations into existing articles through its own pipeline. If you notice something the Dreaming should know, just engage with it in conversation — the nightly pass will see the transcript and integrate it.

This is architectural, not a convenience rule. Direct-from-session edits break the refinement model (articles are monotonic in information, accreting citations rather than getting overwritten) and break provenance (every claim cites the verbatim turn it originated from). Helping by editing is the wrong kind of helping.

## What it is

Lucien is an MCP server that exposes **the Dreaming** — the user's personal wiki under `~/Dreaming` by default (override with `dreaming_path`). Conversations are synthesized over time into Wikipedia-style markdown articles; assistants query those articles read-only during chat instead of starting cold.

Lucien is **not** RAG over raw transcripts. It maintains structured articles that accumulate context (projects, opinions, history, tools, people). The wiki is plain markdown + git + optional Obsidian; the user owns and edits files directly. Articles refine over time — claims gain citations rather than get rewritten.

## Dreaming layout

- `articles/` — topic articles (`Title_With_Underscores.md`)
- `Meta/` — editorial rules, buckets taxonomy, topics to ignore (Lucien reads these during synthesis)
- `Talk/` — discussion pages paired with articles
- `.lucien/` — pipeline caches/checkpoints (implementation detail)

Article **stems** passed to tools are filename stems with underscores (e.g. `Mechanical_Development_Manifesto`), not human titles or abbreviations.

## MCP tools — how to choose

| Tool | Role |
|------|------|
| `lucien_article_search` | Substring search across all articles; ranked occurrence counts + sample hits with section anchors. Default retrieval entry when the user references their own context. |
| `lucien_article_section` | Read one section by anchor slug (from search or TOC). Prefer over full read for narrow questions. |
| `lucien_article_toc` | Headings + anchors only — plan reads without loading body text. |
| `lucien_article_read` | Full markdown (frontmatter through References). Use when scope spans many sections or structure is unknown. |
| `lucien_list_articles` | Alphabetical catalog of stems — "what exists?" without a search needle. |
| `lucien_get_links` | Outbound / inbound wikilink edges for one article (`[[...]]`, resolves to existing `.md` stems). Use for graph navigation and backlinks. |
| `lucien_setup` | Only when the user explicitly wants a new Dreaming initialized. If they already have articles or mention an existing wiki, do not call setup. If existence is unclear, try `lucien_article_search` first; success implies the Dreaming is present. |
| `ping` | Transport health check only — not for content. |

Follow tool descriptions in the MCP schema for full WHEN TO USE text.

## Worked example

User: *"What's the plan for Archie this quarter?"*

1. `lucien_article_search` with query `Archie` — returns `Archie_Project` as the strongest match plus related articles (`AI_Coding_Workflow`, `Mechanical_Development_Manifesto`) with section anchors.
2. `lucien_article_toc` on `Archie_Project` — scan section headings to find the relevant one (roadmap, current state, near-term work).
3. `lucien_article_section` on that anchor — load only the section that answers the question.
4. Optional: `lucien_get_links` on `Archie_Project` if the question touches the conceptual neighborhood and you need to know which related articles also matter.

The pattern is **search → toc → section**, with full `lucien_article_read` only when the question genuinely spans the article or you need surrounding context the section omits.

## Conventions

- **Anchors**: GitHub/Obsidian slug (lowercase, hyphenated). `"KNN filter-order pitfall"` → `knn-filter-order-pitfall`.
- **Wikilinks**: `[[Article_Name]]` or spaces in the label; tools normalize to stems. `[[conv:...]]` citations are not article links. Links inside fenced code blocks are ignored for link extraction.
- **Case**: Search is case-insensitive unless `case_sensitive: true` is set.

## In-repo reference

For architecture, mythology names, and pipeline stages, see `README.md` and `docs/Lucien-PRD.md`.