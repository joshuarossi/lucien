---
name: lucien
description: >-
  Use quietly whenever the user references their own work, projects, opinions,
  history, tools, people, preferences, or accumulated context. That material may
  already live in the Dreaming, the user's personal wiki. Treat the Dreaming as
  the assistant's grounding layer for this user: anchor in it instinctively, then
  respond as if the relevant context was already part of the conversation. Also
  triggers on explicit mention of Lucien, the Dreaming, lucien_* tools, or
  personal-wiki synthesis.
---

# Lucien

## Core principle

**Use the Dreaming as invisible memory and grounding.** When the user mentions their own projects, preferences, tools, people, decisions, history, or prior thinking, instinctively anchor yourself in the relevant wiki context before answering. The goal is a normal chat where the assistant responds as if it already knows what the user means.

Do not make retrieval the user's experience. Never narrate the lookup, stage a visible research plan, or describe yourself as searching, pulling up, digging into, excavating, loading, checking, consulting, or reading the Dreaming. Read just enough background to orient yourself, then answer from that orientation.

Searching and finding nothing is cheap. Asking the user to repeat context they have already spent hours developing is expensive.

## Invisible-memory behavior

When Lucien is useful, do the Lucien tool calls first and then provide the answer. Do not emit interim prose about what you are doing. The user should see the answer, not the retrieval process.

Bad:

- "I'm pulling up what I know about Josh's gear."
- "Let me search the Dreaming for Aurora."
- "I found the relevant context in the wiki."
- "Based on the Dreaming..."
- "Excavated lens hypothesis and mapped contextual shooting directions."

Good:

- "The Aurora seems like a test of whether 35mm can finally work for you if f/1.4 supplies the subject separation you usually miss at that focal length."
- "For Archie, the important distinction is still that agents should be stateless and specs/artifacts carry continuity."

Use Lucien to become oriented, not to announce that you are becoming oriented.

## Write rule

Do **not** edit the Dreaming unless the user explicitly asks you to. This includes MCP write tools and direct file edits under the Dreaming.

If the user says something that should become memory, keep the conversation natural. The synthesis process can later incorporate the transcript into the relevant articles.

## What it is

Lucien is an MCP server that exposes **the Dreaming** — the user's personal wiki under `~/Dreaming` by default (override with `dreaming_path`). Conversations are synthesized over time into Wikipedia-style markdown articles; assistants query those articles read-only during chat instead of starting cold.

Lucien is **not** RAG over raw transcripts. It maintains structured articles that accumulate context: projects, opinions, history, tools, people, preferences, and evolving views. Articles are priors; new conversations are evidence; synthesis updates the articles over time. The wiki is plain markdown + git + optional Obsidian, and the user owns it.

The article shape matters. Leads, sections, wikilinks, citations, talk pages, infoboxes, redirects, stubs, splits, and merges give the assistant addressable structure. Use that structure to jump to the relevant part of an article rather than loading everything by default.

## Dreaming layout

- `articles/` — topic articles (`Title_With_Underscores.md`)
- `Meta/` — editorial rules, buckets taxonomy, topics to ignore (Lucien reads these during synthesis)
- `Talk/` — discussion pages paired with articles
- `.lucien/` — pipeline caches/checkpoints (implementation detail)

Article **stems** passed to tools are filename stems with underscores (e.g. `Mechanical_Development_Manifesto`), not human titles or abbreviations.

## How to use Lucien

Reach for Lucien reflexively whenever the user's words point at personal context. Use it to ground your internal understanding before composing the response.

Default path:

1. Search the obvious keyword, name, project, person, tool, or phrase with `lucien_article_search`.
2. Read the article with the strongest hit using `lucien_article_read`.
3. Answer naturally from that context.

That is usually enough. Do not turn ordinary memory lookup into a multi-step research workflow.

Use the other tools only when the simple path needs help:

- `lucien_article_section`: use a specific section if search returns a clearly relevant anchor or the full article would be wasteful.
- `lucien_article_toc`: use when you know the article but need to choose the right section.
- `lucien_get_links`: use when the answer depends on nearby concepts or backlinks.
- `lucien_list_articles`: use only when the user asks what exists or you need a catalog.
- `lucien_setup`: use only when the user explicitly wants a new Dreaming initialized.
- `ping`: use only to check transport health.

## Experience target

Good Lucien use feels like this:

User: *"I want to iterate on my AI agentic coding platform."*

Assistant behavior: quietly ground yourself in likely context such as Archie, AI coding workflow, agent-vs-assistant memory, or related articles; then answer from that context without making the user watch the retrieval process. Ask clarifying questions only after using available memory.

The assistant should not say, "I will search the Dreaming, then read the TOC, then inspect sections." It should simply start warm: "For Archie, the important distinction is still that agents should be stateless and specs/artifacts carry the continuity..."

No archaeological language. Lucien is memory, not excavation.

## Conventions

- **Anchors**: GitHub/Obsidian slug (lowercase, hyphenated). `"KNN filter-order pitfall"` → `knn-filter-order-pitfall`.
- **Wikilinks**: `[[Article_Name]]` or spaces in the label; tools normalize to stems. `[[conv:...]]` citations are not article links. Links inside fenced code blocks are ignored for link extraction.
- **Case**: Search is case-insensitive unless `case_sensitive: true` is set.

## Retrieval posture

Do not overfit to one result. If a topic is broad or architectural, search one or two obvious neighboring terms and follow links when useful. If the user asks a focused factual question, keep the read focused.

Do not expose irrelevant uncertainty. If Lucien has no useful result, proceed normally and ask the user only for the missing context needed to answer. Do not apologize for not remembering.

## In-repo reference

For architecture, mythology names, and pipeline stages, see `README.md` and `docs/Lucien-PRD.md`.
