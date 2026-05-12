# Lucien

> Personal AI memory that compounds.

Lucien is an MCP server that synthesizes your conversations with AI into a personal wiki — a structured, durable record of your thinking that any AI assistant can read during future conversations. The wiki is yours, in plain markdown, version-controlled with git, and readable with any tool that handles markdown.

## What this is for

If you have substantive conversations with AI — about your projects, your thinking, your work — you've probably noticed the memory problem. Each conversation starts cold. Context you've built up over weeks isn't there. Vendor-side memory features are flat and opaque. You end up copy-pasting the same background information into every new chat, or repeatedly re-explaining the same things.

Lucien addresses this differently. Rather than embedding conversations and retrieving similar chunks (the RAG approach), Lucien synthesizes conversations into Wikipedia-style articles organized by topic. A new conversation can load the relevant articles and have actual context — not just textually similar passages, but a structured understanding of the topic that has accumulated over time.

The result is a personal wiki that grows alongside your thinking, reflects how your views evolve, and gives any AI assistant immediate access to your accumulated context.

## How it works

Lucien runs as an MCP server. Your AI client (Claude Desktop, Claude Code, Claude.ai, anything that supports MCP) connects to it. Two things happen:

**During conversations**, the AI can query the wiki — search articles, read specific pages, follow links between related topics. It's read-only by default; the AI doesn't modify the wiki unless you explicitly ask it to.

**On a schedule** (typically nightly), a synthesis pass reads your recent conversations, segments them by topic, classifies the segments into buckets, and updates the relevant articles. Each pass operates like a Wikipedia editor making small, conservative contributions — integrating new material rather than overwriting, preserving how your thinking has evolved, flagging conflicts on talk pages rather than silently resolving them.

The wiki itself — what we call *the Dreaming* — is just a directory of markdown files on your machine. You can edit it directly in any text editor, browse it with Obsidian or any other wiki tool, and the next synthesis pass will respect your changes. Lucien curates; you own.

## Quick start

Install Lucien as an MCP server in your Claude client:

```
claude mcp add lucien -- npx -y lucien-mcp
```

Then, in any Claude conversation:

```
Run lucien_setup
```

This creates `~/Dreaming/` with the standard structure (articles, Meta pages with editorial conventions, git history). Customize the path with `lucien_setup dreaming_path=/some/other/location` if you prefer.

To browse your wiki as a wiki, install [Obsidian](https://obsidian.md) and open `~/Dreaming/` as a vault. No configuration needed; it Just Works because the Dreaming is in standard markdown vault format.

To enable scheduled synthesis (recommended):

```
0 3 * * * claude "run lucien synthesis"
```

This invokes Claude with the synthesis instruction nightly at 3 AM. Claude calls Lucien's tools, which orchestrate the pipeline. Token costs are visible in your normal Claude usage — there's no hidden billing.

## Design principles

Lucien is small because it composes mature substrate rather than building from scratch.

**The wiki is just markdown files in a directory.** No proprietary format. Readable with any tool. Editable with any editor. Version-controlled with git the way any text content would be.

**Editorial conventions inherit from Wikipedia.** Twenty-four years of refined practice in maintaining encyclopedic content — article structure, neutral point of view, citation conventions, the policy of integrating rather than overwriting — all of it transfers directly. We diverge only where personal scope genuinely requires it (no notability requirement, no NPOV in the public-encyclopedia sense, subject is the user).

**Operational rules live in the wiki itself.** The Meta pages (`Editorial_Guidelines.md`, `Article_Conventions.md`, `Topics_to_Ignore.md`, etc.) are wiki pages, editable like any other content, version-controlled with the rest. Lucien reads them at each synthesis run. The system documents and governs itself in its own substrate.

**Lucien serves; the user is sovereign.** The wiki is yours. Lucien is staff — a curator that does the routine maintenance work of integrating new material and surfacing patterns. The AI is a conversational partner, not an author. You direct, decide, and own.

## The mythology, briefly

Names from Neil Gaiman's *Sandman*. Roles map onto the system as you'd expect.

**You** are *Morpheus*, sovereign of your Dreaming. Your conversations generate the raw material.

**Lucien** is your librarian, the synthesis tool that maintains your wiki by reading what you've dreamed and organizing it into articles.

**Matthew** is the raven — your AI conversation partner. The role persists across whichever model you happen to be using; Matthew today might be Claude Opus, tomorrow something else.

**The Dreaming** is the wiki itself, the durable record of what you've thought about.

The mythology is enrichment, not infrastructure. You don't need to know any of it for the system to work.

## Architecture

```
~/Dreaming/                   # your personal wiki
  articles/                   # the synthesized content
    Archie.md
    Photography.md
    ...
  Meta/                       # operational pages (editorial guidelines, etc.)
    Editorial_Guidelines.md
    Article_Conventions.md
    Buckets.md
    Topics_to_Ignore.md
    ...
  Talk/                       # discussion pages paired with articles
  .git/                       # version history
  .lucien/                    # internal state (checkpoints, caches)
```

Lucien itself is an MCP server, installable as an npm package. It's stateless between calls — each tool invocation reads from disk, does its work, writes results, exits. No long-running process, no database, no service to manage. Synthesis is invoked by calling Claude with the synthesis instruction (manually or via cron); Claude does the LLM work and calls Lucien's tools to orchestrate.

The four-stage synthesis pipeline:

1. **Filter** — decide which conversations contain material worth synthesizing
2. **Segment** — within each conversation, identify topic boundaries
3. **Classify** — assign each segment to one or more buckets (topic categories)
4. **Synthesize** — for each bucket, integrate the assigned segments into the bucket's article

Each stage is cached independently so prompts can be iterated without re-running upstream work.

## What this isn't

Lucien is not a chatbot, a hosted service, a SaaS product, an embedding database, a vector retrieval system, an AI agent, or a memory feature attached to a specific model vendor. It's a small tool that maintains a wiki on your local filesystem based on what you and your AI assistants have been thinking about together.

For v1, Lucien is single-user and local-only. Sharing, multi-user, organizational use, and hosted deployment are deferred to v2.

## Status

Early development. The architecture is settled; the implementation is in progress. This README describes the system as designed; not all of it is built yet.

## License

TBD
