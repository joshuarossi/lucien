# Lucien MVP — Product Requirements Document

**Status:** Draft
**Owner:** Josh Rossi
**Last updated:** 2026-05-11

---

## 1. Problem statement

People who interact substantively with AI assistants face a memory problem: each conversation starts without the context built up in previous conversations. Vendor-side memory features (Claude's memory, ChatGPT's memory) are flat lists of facts, opaque to the user, locked to a single provider, and structurally unable to represent how thinking evolves over time.

The result is friction. Users repeatedly re-explain background context, lose track of prior conclusions, and can't easily share their accumulated thinking across AI products or across people. The cost compounds over time as more substantive conversations happen and more context accumulates that has nowhere to go.

Existing approaches fail in characteristic ways:

- **Vendor memory** is flat, opaque, vendor-locked, and structurally limited to surface facts.
- **RAG-based personal memory tools** retrieve textually similar chunks rather than synthesizing structured understanding. They surface passages, not knowledge.
- **PKM tools (Obsidian, Roam, etc.)** require users to do all synthesis work manually. They store; they don't integrate.

None of the existing options produce a structured, evolving, user-owned record that any AI client can consult.

## 2. Solution overview

Lucien is an MCP server that synthesizes conversations with AI assistants into a personal wiki. The wiki — *the Dreaming* — is a directory of markdown files on the user's machine, structured as Wikipedia-style articles organized by topic. The user owns the substrate; Lucien curates.

Two surfaces:

- **Read** (used during conversations): the user's AI client queries Lucien for relevant articles. The AI gets actual context, not similarity-matched fragments.
- **Write** (scheduled or on demand): a synthesis pass reads new conversation transcripts, segments them by topic, classifies segments into buckets, and updates the relevant articles. Each pass operates with editorial discipline inherited from Wikipedia.

The wiki is human-readable, human-editable, version-controlled with git, and browsable with any markdown wiki tool (Obsidian, Wiki.js, plain text editor).

## 3. Goals and non-goals

### Goals (v1)

- Provide a fully functional personal memory management system for individual technical users
- Bootstrap a Dreaming from existing Claude.ai conversation export data
- Run continuous synthesis to keep the Dreaming current with new conversations
- Make the Dreaming readable by AI clients via MCP
- Allow user inspection and editing of the Dreaming through standard wiki tools or AI assistants
- Operate fully local — no data leaves the user's machine except through their normal AI API usage

### Non-goals (v1, deferred to v2+)

- Sharing or multi-user collaboration on a Dreaming
- Hosted/managed Lucien (user runs it locally)
- Organizational deployment (team-wide Dreamings, access control)
- Encryption at rest beyond what the filesystem provides
- Non-Claude AI provider support (architecture supports it; v1 focuses on Claude)
- Mobile or web-only setup (v1 requires command-line access)
- Real-time synthesis during conversations (synthesis is batch, typically nightly)

## 4. Target users

**Primary**: Individual technical users who have substantive, recurring conversations with AI assistants and value structured continuity. Characteristically:

- Comfortable installing MCP servers and editing configuration
- Use AI extensively for work, thinking, or both
- Have accumulated meaningful context across many conversations
- Are willing to maintain a wiki (read, occasionally edit) in exchange for compounding value

**Secondary** (v2+): Non-technical users via hosted version, teams via multi-user.

## 5. User stories

### Bootstrap (one-time)

> As a new user, I install Lucien, point it at my Claude export, and end up with a populated Dreaming reflecting my actual conversation history, without manual sorting or configuration of topics.

### Steady-state use (daily)

> As an ongoing user, I have conversations with my AI assistant. Overnight, Lucien synthesizes new content into my Dreaming. Next conversation, my AI has updated context.

### Reading during conversation

> As a user mid-conversation, my AI assistant automatically pulls relevant context from my Dreaming when needed, without me having to direct it to specific articles or paste in background information.

### Inspection and editing

> As a user, I can browse my Dreaming as a normal markdown wiki (in Obsidian, an editor, or via the AI itself), edit articles directly, and trust that my edits will be respected by future synthesis runs.

### Controlled writing

> As a user, my AI assistant only modifies the Dreaming when I explicitly ask it to. By default, it can read but not write.

## 6. Key requirements

### R1. Installable via standard MCP install commands

Lucien is published as an npm package (`lucien-mcp`). Users install via:

```
claude mcp add lucien -- npx -y lucien-mcp
```

Or via equivalent Claude Desktop/ChatGPT/etc. config. No separate installer, no Docker required, no service registration.

### R2. Self-initializing

On first run of the setup tool, Lucien creates the Dreaming directory with default structure and Meta pages. If the directory already exists, it leaves existing content alone (no overwrite). Idempotent.

### R3. Bootstrap from export data

Lucien can ingest a Claude.ai export (the `conversations.json` and related files), normalize the data, and run full synthesis to populate an initial Dreaming.

### R4. Incremental synthesis

On a schedule (cron-driven for v1), Lucien processes only conversations new since the last synthesis. Uses checkpoint files to track what has been processed.

### R5. Four-stage synthesis pipeline

Pipeline operates as described in section 8. Each stage independently cached so prompts can be iterated.

### R6. Read tools for AI consumption

MCP server exposes tools for AI clients to query the Dreaming during conversations: search articles, read articles, list articles, follow links.

### R7. Write tools gated to explicit user invocation

MCP server exposes synthesis and edit tools but they only execute when the user explicitly invokes them in a conversation. Default conversational behavior is read-only.

### R8. Wiki-engine agnostic

The Dreaming is plain markdown in a directory. No Lucien-specific format. Compatible with Obsidian, Wiki.js, any markdown editor, or direct file access.

### R9. User-respecting deletion

If a conversation is deleted from the source (empty messages in export), Lucien excludes it from synthesis. Honors user intent.

### R10. User-respecting topic exclusion

Meta:Topics_to_Ignore.md lists topics the user doesn't want synthesized. Lucien consults it during the filter step. Excluded content is not silently added to the Dreaming.

### R11. Token transparency

All LLM work is done by invoking Claude (the user's own configured Claude). Token costs appear in the user's normal Claude usage. No hidden API calls, no separate billing.

### R12. Version control by default

The Dreaming is a git repository. Every synthesis commits its changes. User can roll back, audit history, fork to another machine.

## 7. Architecture

### Components

- **Lucien MCP server**: a Node.js (compiled from TypeScript) MCP server, installed as `lucien-mcp` on npm, spawned on demand by AI clients via stdio transport.
- **The Dreaming**: a directory on the user's machine (default `~/Dreaming/`), containing markdown wiki content, git history, and internal state. Configurable location.
- **Transcripts**: raw conversation export data (default `~/Dreaming/.lucien/transcripts/`), processed by the synthesis pipeline. Configurable location.
- **AI clients**: any MCP-compatible client (Claude Desktop, Claude Code, Claude.ai web), which the user configures to connect to Lucien.

### Data flow

```
Export data         ───┐
(conversations.json)   │
                       ▼
                ┌──────────────┐
                │   Lucien     │
                │  (MCP tools) │
                └──────┬───────┘
                       │
                   reads/writes
                       │
                       ▼
                ┌─────────────┐         ┌─────────────┐
                │ The Dreaming│ ◄────── │ Obsidian /  │
                │ (markdown)  │         │ wiki engine │
                └─────────────┘         └─────────────┘
                       ▲
                       │
                    queries
                       │
                ┌──────┴──────┐
                │ AI client   │
                │ (via MCP)   │
                └─────────────┘
```

### Process model

Lucien is **stateless between calls**. Each tool invocation:

1. Reads checkpoint files and Meta pages from the Dreaming
2. Performs its work
3. Writes results to the Dreaming (creating a git commit if changes were made)
4. Returns

There is no long-running Lucien process. The MCP server lifecycle is owned by the AI client (which spawns/kills the subprocess based on MCP protocol). Scheduled synthesis is just `claude "run lucien synthesis"` from cron, which makes Claude invoke the synthesis tool, which runs to completion and exits.

### Nested LLM invocations

When the synthesis tool runs, it needs to do LLM work (filtering, segmentation, classification, synthesis). Lucien delegates this back to Claude by spawning `claude` subprocesses with the relevant prompts. This is "nested" only in the conceptual sense — the synthesis tool runs `claude -p "..."` as a subprocess to do each LLM call. Token accounting is transparent: every nested call shows up in the user's Claude usage.

## 8. Synthesis pipeline

### Stage 1: Filter

**Input**: a conversation (normalized to role/text/timestamp triples).
**Output**: boolean — should this conversation contribute to the Dreaming?

**Prompt logic**: identify whether the conversation contains substantive material (decisions, novel thinking, recurring topics) versus noise (quick lookups, throwaway interactions, deleted content). In bootstrap mode, the bar is low — Wikipedia stubs are encouraged. In steady-state mode, the bar is higher.

**Caching**: per-conversation, keyed by conversation UUID.

### Stage 2: Segment

**Input**: a filtered conversation.
**Output**: a list of segments, each with a message-UUID range and a descriptive topic label.

**Prompt logic**: walk through the conversation in sliding windows, identify topic boundaries, output `(start_uuid, end_uuid, descriptor)` records. Descriptors are free-form natural language ("discussing Archie webhook architecture", "thoughts on lens entrance pupils").

**Caching**: per-conversation, keyed by conversation UUID.

### Stage 3: Classify

**Input**: a segment descriptor, plus the current bucket taxonomy (loaded from `Meta/Buckets.md` and its index files).
**Output**: a list of bucket names the segment belongs to (zero, one, or more).

**Prompt logic**: given the segment description and the available buckets, decide which buckets it fits. May propose new buckets if no existing bucket fits (these get reviewed and either added to the taxonomy or merged with existing buckets during maintenance).

**Caching**: per-segment, keyed by segment hash.

**Bucket discovery (bootstrap only)**: before classification can run, the bucket taxonomy must exist. Bootstrap runs a one-time clustering pass on the segment descriptors from all filtered conversations, producing an initial set of ~20-50 buckets. Stored in `Meta/Buckets.md` and per-bucket index files in `Meta/buckets/`.

### Stage 4: Synthesize

**Input**: a bucket — the set of segments assigned to it, with the original conversation content available for retrieval.
**Output**: an updated article in `articles/<BucketName>.md`, with citations.

**Prompt logic**: the synthesis prompt invokes the Wikipedia-editor disposition. The model reads the current article (if any), reads the new segments, integrates them respectfully (preserving prior content, noting trajectories, flagging conflicts on the Talk page when necessary). Output is markdown in the established article format.

**Caching**: per-bucket, keyed by bucket name + content hash of input segments.

### Cross-cutting: link maintenance

After synthesis, a second pass scans articles for references to other articles' subjects and inserts wikilinks. Mostly pattern matching; LLM-assisted for harder cases (referring to a concept without using its exact title).

### Cross-cutting: maintenance pass

After each synthesis run, a maintenance pass examines articles for:

- Stub articles that have accumulated enough content to be promoted
- Articles that have grown long enough to consider splitting
- Articles with overlapping content that might be merged
- Bucket taxonomy proposals from the classify step

Maintenance does not act unilaterally on splits/merges — it flags them via Wikipedia-style maintenance templates (`{{split}}`, `{{merge}}`) on the relevant articles, leaving the actual decision to the next synthesis run or to user review.

## 9. MCP tool surface

### Setup and operations

- `lucien_setup(dreaming_path?)` — initialize a Dreaming directory at the given path (default `~/Dreaming`). Creates structure, writes default Meta pages, initializes git. Idempotent.
- `lucien_status()` — report current state: dreaming path, article count, last synthesis timestamp, pending transcripts.
- `lucien_ingest_export(export_path)` — copy/process a Claude export into the transcripts directory, register conversations as pending synthesis.
- `lucien_synthesize(options?)` — run a synthesis pass. Default behavior: process all pending transcripts. Options for partial runs (specific buckets, dry-run, etc.).

### Read tools (for use during conversations)

- `lucien_search(query, limit?)` — semantic + keyword search across articles. Returns ranked article titles with short snippets.
- `lucien_read_article(name)` — return the full content of a named article.
- `lucien_list_articles(category?)` — list all articles, optionally filtered by category tag.
- `lucien_get_links(article)` — return outbound and inbound links for an article.

### Write tools (gated)

- `lucien_edit_article(name, content)` — replace article content. Only invoked when user explicitly requests an edit.
- `lucien_append_to_talk(article, note)` — add a note to an article's Talk page.

## 10. Default Meta pages (created by lucien_setup)

- `Editorial_Guidelines.md` — bridge document referencing Wikipedia conventions with personal-scope adaptations
- `Article_Conventions.md` — article structure, citations, link conventions, stub markers
- `Buckets.md` — the bucket taxonomy (initially empty, populated by first synthesis)
- `Category_Definitions.md` — category tag definitions (initially empty, accumulates over time)
- `Topics_to_Ignore.md` — user-maintained exclusion list (initially empty)
- `Synthesis_Pipeline.md` — describes the four-stage pipeline; reference for Lucien itself

## 11. Configuration

Configuration via environment variables passed in the MCP server config:

- `DREAMING_PATH` — path to the Dreaming directory (default `~/Dreaming`)
- `TRANSCRIPTS_PATH` — path to transcripts (default `<DREAMING_PATH>/.lucien/transcripts`)
- `LUCIEN_MODEL` — model to use for synthesis (default: whatever the user's `claude` CLI is configured for)

The MCP server reads these at startup. Multiple Lucien instances with different `DREAMING_PATH` values are supported (personal vs. work Dreamings, etc.).

## 12. Out of scope for v1

Explicitly deferred:

- Hosted Lucien (managed service)
- Multi-user / shared Dreamings
- Encryption layer (rely on filesystem and git)
- Web UI for browsing (use Obsidian or similar)
- Non-Claude AI providers (architecture is provider-agnostic; v1 implements only Claude)
- Real-time synthesis (synthesis is batch)
- Mobile setup (CLI-only install)
- Topic exclusion via semantic matching beyond simple keyword/entity match (v1 starts with exact phrases on Topics_to_Ignore.md; semantic match can be added later)

## 13. Open questions

- **Prompt location**: do synthesis prompts live in the codebase or as Meta pages in the Dreaming? Current lean: codebase for v1, with future support for Meta-page overrides.
- **Model selection per stage**: should filter/segment/classify use a cheaper model while synthesis uses Opus? Current lean: use one model for v1 (whatever the user's Claude is configured for), optimize later.
- **Bucket file format**: exact schema for per-bucket index files in `Meta/buckets/`. Current lean: JSON with `{conversation_uuid, message_range, descriptor}` entries.
- **Article filename format**: spaces, underscores, or PascalCase? Current lean: `Title_Case_With_Underscores.md` for clean URL-safe naming with wikilink compatibility.
- **Talk page conventions**: when does Lucien write to a Talk page vs. update the article directly? Current lean: Talk for conflicts and uncertain integrations; article for new content that fits cleanly.

## 14. Success criteria

The MVP is successful if:

1. A user can install Lucien with a single command and run setup in their AI client
2. Bootstrap from an existing Claude export produces a populated, coherent Dreaming
3. Nightly synthesis successfully incorporates new conversation content
4. The user can browse and edit the Dreaming via Obsidian without breaking anything
5. AI clients can query the Dreaming during conversations and the context they retrieve is substantively useful
6. The user prefers Lucien-augmented conversations over equivalent conversations without Lucien

The deeper success criterion is whether the system's value compounds over time — whether the Dreaming becomes more useful at month six than month one, and at year two than month six. This can't be evaluated at MVP launch but is the test the design is optimizing for.

## 15. Implementation sequence

Rough order, allowing for iteration:

1. Project scaffolding (Bun + TypeScript, MCP SDK, basic server) — done
2. `lucien_setup` tool — done
3. Export ingestion: normalize Claude export into clean transcripts
4. Stage 1: filter prompt + caching
5. Stage 2: segment prompt + caching
6. Bucket discovery (clustering segment descriptors into taxonomy)
7. Stage 3: classify prompt + caching
8. Stage 4: synthesize prompt + article writing
9. Link maintenance pass
10. Read tools (search, read_article, list_articles)
11. Configure scheduled synthesis (cron documentation)
12. Polish: error handling, status reporting, idempotency checks

Each step produces a working artifact that can be tested before moving on.
