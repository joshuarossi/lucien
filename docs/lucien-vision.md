# Morpheus & The Dreaming

*A Personal Knowledge Wiki as Substrate for AI Memory*

**Status:** Vision document / working title
**Author:** Josh
**Last updated:** May 2026

---

## TL;DR

Current AI memory systems are flat, opaque, vendor-locked, and structurally wrong for the work assistants actually do. They store either raw chat logs (retrieved by vector search, with no understanding of context) or extracted "facts" (a list with no structure, no provenance, no way to handle contradiction or change over time). Neither approach produces *understanding*; both produce *recall*.

**Morpheus** is a different design. The user owns a personal wiki — *The Dreaming* — modeled after Wikipedia, that lives as plain markdown files on their own machine or on encrypted storage they control. A synthesis process (Morpheus) reads conversations and integrates new information into the wiki: writing articles, drawing cross-links, citing source conversations, resolving conflicts on talk pages. Any AI the user works with reads and writes the wiki via MCP. The substrate outlives any specific model, provider, or vendor.

The result is a structured, evolving, inspectable representation of the user — what they think, why they think it, how their views have changed — that asymptotically converges on an accurate model of the subject while staying correctable, portable, and private.

---

## The Problem

The current state of AI memory is roughly two approaches, neither of which actually models the user:

**Raw chat retrieval (RAG).** Embed conversation chunks, embed the query, return the nearest neighbors. The model figures out at query time what's relevant. This is the dominant approach because it's the best you can do over an unstructured corpus. It fails because similarity isn't relevance, retrieved chunks lack context, and there's no integration across conversations — the model re-derives the same conclusions every time.

**Flat fact extraction.** Per-turn extraction of "facts about user" into a list. Cleaner than raw chat, but the list has no structure, no provenance, no temporal reasoning, no way to handle contradiction. New facts overwrite old ones. There's no synthesis. The result is a pile, not a model.

Both approaches share a deeper problem: they're built on the assumption that memory means *recall* (retrieving what was said) rather than *understanding* (knowing what it means and how it fits together).

They also share an operational problem: they're vendor-owned. ChatGPT's memory, Claude's memory, Gemini's memory — each is locked into the provider that built it. The user can't read it, audit it, export it, or take it with them. Switching providers means starting over. This is the AOL email of personal knowledge.

---

## Design Principles

The design is governed by one stance: *compose, don't replace*. The system does one new thing — synthesizes conversations into structured personal knowledge — and reuses solved tooling for everything else. Concretely:

- **Doesn't prescribe a scheduler.** The system exposes a CLI; users wire it into whatever scheduling they already have (cron, launchd, systemd, Task Scheduler, a homelab job runner). Anything that can shell out can drive Morpheus.
- **Doesn't prescribe an editor.** The Dreaming is markdown files. Users edit them in whatever editor they already use — Obsidian, VS Code, vim, a wiki engine's built-in editor. The system has no opinion.
- **Doesn't prescribe a wiki engine.** Markdown plus wikilinks is the format. Any wiki engine that reads that format works as a browsing surface. Users can switch engines without touching their data.
- **Doesn't replace version control.** The Dreaming directory is a git repo. Standard git is the version history, the branching tool, the rollback mechanism, the sync layer for users who want it.
- **Doesn't host the user's data.** Self-hosted runs on the user's machine. Eventual hosted versions store encrypted blobs the host cannot read. The substrate is always owned by the user.
- **Doesn't lock in any AI provider.** MCP is the interface. Any model that supports MCP can read the Dreaming. Switching models doesn't lose accumulated context.
- **Inherits Wikipedia's conventions.** Articles, cross-links, talk pages, edit history, citations, references, embedded media. Wikipedia solved these; the Dreaming uses them.

The novelty is concentrated in exactly one place: the synthesis pipeline. The prompts, the four-stage orchestration, the integration logic that turns raw conversations into well-shaped articles. Everything around it is composition of existing tools.

This is deliberate. Projects that succeed long-term are the ones that compose well with what users already have, not the ones that demand new ecosystems. Productive laziness — refusing to redo solved problems, refusing to impose preferences on users — is what makes the system shippable and durable.

---

## The Insight: Agents vs Assistants

A useful distinction: not all AI work needs memory in the same way.

**Task-oriented agents** (a gardener, a barber, a code-execution worker) want *procedural* knowledge — how to do the job well — and benefit from *minimal* personal context. Memory here is a liability if it introduces variance into work that should be consistent. The job is specified; execution should be mechanical.

**Open-ended assistants** (thinking partners, researchers, designers, collaborators) need *semantic* memory — a rich, evolving understanding of the person they're working with. The work isn't specified; success is contextual. The value comes from knowing the user's frameworks, history, preferences, and reasoning patterns well enough to engage substantively with new questions.

The industry has largely conflated these. "AI memory" gets built as a generic feature attached to a model, optimized for neither use case well. Anthropic's recent "dreaming" feature for Managed Agents, for example, addresses procedural memory for task workers — useful, but solving the problem where memory matters least. The consumer chat experience, where personal understanding *is* the value, gets the weakest memory implementation.

Morpheus targets the assistant case explicitly. It's not for agents. It's for the open-ended collaborative work where understanding the user is the bottleneck.

---

## Architecture

The system has two named components and a clear separation between them.

### The Dreaming (the substrate)

A personal wiki, stored as markdown files in a directory. The user owns it — it's a folder on their machine, or encrypted blob storage on a host they control. The format is the same as Wikipedia in shape: articles, cross-links, talk pages, edit history, citations, references, embedded media, file attachments.

The Dreaming is *one person's structured understanding of their world*. An article on "Python" doesn't explain what Python is — Wikipedia does that, and the Dreaming's Python article links to it — it explains the *user's relationship to Python*: their history with it, current views, reasoning, related frameworks they apply. Articles can be about anything: concepts, projects, people, products, frameworks, places, events.

Citations are first-class. Every claim traces to evidence: either an *internal citation* to a past conversation that produced the claim, or an *external reference* to an article, paper, video, product page, or other artifact the user engaged with. The references section of a Dreaming is, collectively, a bibliography of the user — the corpus of external material that shaped their thinking.

### Morpheus (the process)

A synthesis pipeline that operates on the Dreaming. It runs periodically (nightly, weekly, on-demand) and integrates new conversations into the wiki. The pipeline has four conceptual stages:

1. **Filter.** Identify conversations worth integrating — novel, surprising, contradicting prior content, marked important by the user, behaviorally significant. Most conversations are noise and get forgotten.
2. **Map.** Determine which subjects, categories, and existing articles new information relates to.
3. **Compare.** Read the relevant existing articles and identify what changes — strengthening, weakening, extending, contradicting, adding new dimensions.
4. **Synthesize.** Write the updates. Refine articles, add new ones, maintain cross-links, surface conflicts on talk pages.

Morpheus is *interchangeable*. Today it might be Claude running a scheduled job; tomorrow it could be a local model. The Dreaming persists; the shaper can be replaced.

### The interface

The read path and the write path are different operations, performed by different actors, at different times.

**During conversation (read).** Any AI the user works with reads the Dreaming via MCP. It pulls relevant articles into context, follows cross-links, and uses the synthesized knowledge to inform its responses. The AI does not write to the Dreaming during the conversation — the conversation just produces a transcript, like any other AI conversation.

**During synthesis (write).** Morpheus runs as a separate operation, not in the conversation loop. It reads recent conversation transcripts, reads the existing Dreaming via MCP, and writes updates back via MCP. This is a deliberate, structured operation — not something that happens mid-conversation. Synthesis is the only path by which the Dreaming gets updated (other than the user editing it directly).

**The user (read and write).** The user can read and edit the Dreaming at any time — it's just markdown files, openable in any editor, browsable in any wiki engine. User edits are authoritative; subsequent syntheses respect them.

This separation matters. Mid-conversation writes would put every AI client in the position of updating the canonical representation of the user, which is a much larger trust surface than read-only access. They would also produce inconsistent updates depending on which model happened to be in the conversation, with no deliberation about whether the update is warranted given the broader corpus. Keeping synthesis as a dedicated operation means updates are considered, integrative, and consistent.

It also means a single Dreaming can serve multiple AI providers cleanly. Claude reads it. ChatGPT reads it. A local Llama reads it. None of them write to it — they just read. Morpheus is the one process with write authority, and it can be run by whichever model the user trusts for that role, on whatever cadence they choose.

### Packaging

The system ships as a single package providing multiple interfaces over the same core functionality:

- An **MCP server** that exposes the Dreaming for read access during conversations
- **Slash commands** for invoking actions from within an AI client (run synthesis, dry-run, rollback, check status)
- **Skills** that teach an AI how to operate the system on the user's behalf — interpreting state, running maintenance tasks, handling talk-page conflicts
- A **CLI** that exposes every capability as a command, suitable for invocation from any automation tool

The CLI is the integration surface for automation. Anything that can shell out can drive Morpheus: cron, launchd, systemd timers, Task Scheduler, bash scripts, PowerShell scripts, CI pipelines, a homelab job runner, a Raspberry Pi reacting to some other event. The system has zero opinions about scheduling infrastructure, which is what makes "scheduling is the user's problem" a feature rather than a punt. Users plug Morpheus into whatever automation they already have.

The MCP/slash/skills interfaces are the conversation-side surface; the CLI is the automation-side surface. Both expose the same underlying capabilities; they're just different access patterns for different contexts. A user might never run the CLI directly and benefit fully because their cron job is running it. Another user might never set up cron and instead trigger synthesis via slash command. Both are valid. The core does the work; the interfaces are how different consumers reach it.

For daily operation, the answer is almost always a scheduled job invoking the CLI: cron, launchd, systemd timer, whatever fits the user's environment. Synthesis runs while the user sleeps; they wake to an updated Dreaming. The system's value compounds over years specifically because the user *doesn't* have to remember to feed it. A memory system that requires daily intervention is just a worse note-taking app.

The slash commands and skill-mediated triggers exist for *operational* use, not daily use: testing new synthesis prompts via dry-run, integrating a particularly substantive conversation immediately rather than waiting for the nightly run, recovering from a failed run, rolling back a bad synthesis. The skill makes the AI a competent operator of the user's system, capable of handling these maintenance tasks through normal conversation rather than memorized CLI flags.

---

## Key Design Properties

### Wikipedia-shaped

The governing heuristic is: *if Wikipedia has it, the Dreaming has it*. Articles, talk pages, edit history, citations, references, redirects, disambiguation, infoboxes, embedded media, file attachments, categories. None of this needs to be invented; Wikipedia solved it over twenty years and the conventions are correct for the use case. The deviation from Wikipedia is the *subject* — personal rather than public — not the structure.

This heuristic does enormous work. It removes thousands of small design decisions by defaulting them to "Wikipedia's answer, simplified for one-person use." It also makes the system immediately legible to anyone who has ever used Wikipedia, which is essentially everyone.

### Bayesian-in-spirit updating

When new information arrives about a topic that already has an article, Morpheus *integrates* rather than *replaces*. The Python article doesn't get overwritten with the latest take; it gets refined to reflect the accumulated evidence. Contradictions surface on the talk page rather than silently overwriting prior content. Errors get corrected by subsequent evidence.

This preserves *trajectories* — how the user's views have evolved over time — which is the most valuable information in a personal model and the part current memory systems most consistently lose. "Used to think X, encountered Y, now thinks Z" is qualitatively different from "thinks Z."

### Asymptotic convergence on subject-truth

Given enough evidence and consistent updating, the Dreaming's representation of the user converges on an accurate model of who they currently are, while preserving the history of who they've been. The convergence is on *truth about the subject* — not world-truth, not the user's self-image, but the truth-as-evidenced-by-actual-conversations.

This is not a fixed target; people change. The Dreaming tracks a moving subject, staying accurate over time rather than becoming stale. This is a stronger property than convergence to a fixed point.

### Self-correcting under use

Errors in the Dreaming are addressable. The synthesis pipeline doesn't have to be right on any given pass — it has to be roughly right on average and responsive to contradiction. When a new conversation conflicts with an existing article, the system reconciles. When the user disagrees with a characterization, they can edit it directly. When a synthesis produces an unsupported claim, subsequent syntheses can remove it. The system gets better with use rather than degrading.

### Cumulative value

The Dreaming's worth is cumulative in a way no current system allows. Day one, it's a thin set of articles. Year one, it's a noticeably useful context layer. Year five, it's a structured representation of the user's thinking with thousands of articles and tens of thousands of cross-links — an artifact with no current equivalent because nothing has ever been allowed to accumulate this way.

---

## Why This Matters

### User ownership

The Dreaming is *the user's*. Plain markdown files, in a directory, on a machine or storage they control. They can read it, edit it, grep it, version it with git, back it up, encrypt it, fork it, share parts of it, or delete it. This is meaningfully different from every existing memory system, where the most sensitive distilled representation of the user lives in a vendor's database in an opaque format.

### Portability across providers

Because the substrate is open and the interface is standard (markdown + MCP), the Dreaming works with any AI provider. Switching models doesn't lose accumulated understanding. Multiple models can share the same Dreaming. The user's investment in personal context isn't held hostage by any vendor.

### Auditability

Every claim in the Dreaming traces to evidence through citations. The user can see *why* the system believes what it believes, when that belief was formed, and what conversation produced it. Errors are visible and correctable. This is impossible in current vendor memory systems, where the model's beliefs about the user are opaque.

### Privacy as a structural property

When the substrate is files the user owns, privacy isn't a policy claim — it's an architectural fact. Self-hosted, the data never leaves the user's machine. Hosted with end-to-end encryption (a v2 concern), the host stores encrypted blobs it cannot read; the user's chosen AI client decrypts locally to read and write. The threat surface is small and well-defined.

### Composability with non-AI tools

The Dreaming is just a wiki. The user can browse it on a Sunday afternoon, search it, follow links, write notes in it, use it as a personal knowledge management system independent of any AI. Once it exists, it's valuable even when no model is reading from it. This makes the value proposition durable: it's not "memory for AI," it's "personal knowledge base that AI can also read."

---

## How Retrieval Works

Current RAG approaches retrieve raw conversation chunks at query time and ask the model to reason over them. This re-does the synthesis work every conversation, with no accumulated structure.

Retrieval against the Dreaming is qualitatively different:

1. **Lookup, not search.** The query routes to the relevant article(s). The synthesis already happened; the model reads a structured answer rather than re-deriving one from raw material.
2. **Link traversal.** From the entry-point article, the model follows cross-links to related articles. The relevant conceptual neighborhood is traversed, not searched.
3. **Optional vector search over articles** (not over conversations) for queries that don't obviously match a title. The search corpus is small, dense, and high-quality — failure modes are dramatically less severe than vector search over raw chat.

This is cheaper, faster, more deterministic, and more accurate than RAG. Most of the cost lives at write-time (synthesis) rather than read-time (retrieval), which is the correct shape for a knowledge system.

---

## Bootstrap and Onboarding

No user starts fresh. Everyone has thousands of conversations across one or more providers, and that history is the training data for the initial Dreaming.

The bootstrap runs the same synthesis pipeline, scaled to handle the full corpus: extract entities and recurring themes to build a skeletal ontology, populate articles from relevant conversations, establish cross-links and surface generalizations. The bootstrap is heavier than steady-state synthesis but uses the same code path.

For a technically capable user, getting conversations onto disk is a non-issue. Claude, ChatGPT, and other providers offer data export — the user runs a script (or asks an AI to write one) that pulls their exports into a designated directory, and Morpheus reads from there. There's no infrastructure to wait for. The whole pipeline — export script, Morpheus process, MCP server pointing at the Dreaming directory — runs on the user's own machine using existing tools. Cron job, shell scripts, a markdown directory, an MCP server. Nothing exotic.

The non-trivial part is the synthesis pipeline itself — the prompts and orchestration that turn raw conversations into well-shaped articles. That's where the real engineering attention goes. Everything around it is composition of existing pieces.

For a non-technical user, eventually, this would all be packaged up: hosted, automated, integrated with provider APIs directly. That's a v2 concern. For v1, the user is technically capable and willing to run scripts, which is enough.

The bootstrap is also a one-time opportunity to set user expectations. A conservative, high-quality initial Dreaming (twenty good articles with clear citations) builds trust; a sprawling mediocre one gets written off. Better to under-cover at bootstrap and let steady-state synthesis fill in over time.

The bootstrap runs entirely on the user's own machine. Their conversation history never leaves their control.

## Checkpointing and State

The pipeline has two recurring processes — exporting transcripts from providers, and synthesizing them into the Dreaming — and each needs its own checkpoint. They are deliberately decoupled: the export side knows about provider APIs and what's been downloaded; the synthesis side knows about the Dreaming and what's been integrated. They communicate through a shared directory of transcripts.

### Export checkpoint

The export script tracks what's been pulled from each provider. On day one, "download everything." On day two, "download everything since last time." Per provider, the checkpoint records the last-exported conversation ID (or equivalent provider-specific cursor). The export script runs on its own schedule, writes new transcripts to a designated directory, and advances its checkpoint when complete.

Export is cheap, so it can run frequently (hourly, daily) without significant cost. If an export run fails, the checkpoint doesn't advance, and the next run picks up from the same place.

### Synthesis checkpoint

Morpheus tracks what's been integrated into the Dreaming. Per source, the checkpoint records the last-processed conversation ID. Each run reads the export directory, identifies transcripts newer than the checkpoint, runs them through the four-stage pipeline, writes to the Dreaming, and advances the checkpoint at the end.

Synthesis is expensive (LLM inference over potentially many conversations, with several passes per conversation), so it runs less frequently — nightly is the natural cadence. The Dreaming directory is a git repo; each Morpheus run produces a commit. The synthesis checkpoint can reference both the last-processed conversation ID and the git SHA of the Dreaming after that run, giving full reproducibility and rollback.

### Why decouple

If the two checkpoints were combined, an export failure would block synthesis and a synthesis failure would block exports. Decoupled, each can fail and recover independently. Export catches up when the provider API is reachable; synthesis catches up when Morpheus runs successfully. The shared transcript directory is the buffer between them.

This also lets the schedules diverge naturally. Exports might run hourly; synthesis nightly. If a user runs synthesis manually after a particularly substantive conversation, that doesn't interfere with the regular export schedule.

### Other details

- **ID-based, not timestamp-based.** Timestamps have edge cases around clock skew and simultaneous conversations. IDs are unambiguous.
- **Stage-level state for bootstrap.** The bootstrap synthesis might process thousands of conversations; intermediate checkpointing between pipeline stages prevents needing to redo expensive work on retry. Steady-state runs are short enough that a single end-of-run checkpoint is fine.
- **Dry-run mode for synthesis.** Run Morpheus against transcripts *without* committing to the Dreaming, for iterating on prompts. Try a new prompt against last week's conversations, see what it would write, decide whether to commit. Combined with git-versioned state, this gives a solid iteration loop on the synthesis itself.

Idempotency falls out naturally: if a run fails partway through, the checkpoint hasn't been advanced, so the next run picks up from the same place. Failed runs are safe to retry. Re-running on the same checkpoint produces the same output (modulo LLM nondeterminism in the synthesis prompts).

---

## Scope of v1

The goal of v1 is to validate the core thesis: *does the synthesis pipeline produce a Dreaming that's qualitatively better than current memory systems for the user's own use?*

For a technically capable user, v1 is buildable in evenings and weekends. The only part requiring real engineering attention is the synthesis pipeline itself — the prompts, the staging, the integration logic. Everything else is glue:

- A script that pulls conversation exports from providers into a directory (LLMs can write this)
- A markdown directory representing the Dreaming, version-controlled with git
- An MCP server exposing the directory for read access during conversations
- Slash commands / CLI subcommands for running synthesis, running export, checking status, dry-run, and rollback
- Skills that teach an AI how to operate the system on the user's behalf
- A checkpoint file tracking what's been processed
- Carefully written synthesis prompts for the four-stage pipeline

How synthesis gets triggered is left to the user. Cron, an AI client's scheduled-task feature, manual invocation via slash command, asking the AI to run it — any of these works. The package provides the capabilities; the user wires them up however suits their workflow.

**In scope:**
- Citations to source conversations
- External references as first-class citations
- Talk-page mechanism for surfacing conflicts
- User-editable substrate (user edits respected by future synthesis)
- Dry-run mode for iterating on synthesis prompts

**Out of scope for v1:**
- Hosted version
- End-to-end encryption / multi-device sync
- Multi-user support
- Article sharing across users
- Graph view / advanced visualizations
- Web UI beyond what wiki engines provide off-the-shelf
- Mobile clients
- Provider-direct integrations (manual or scripted exports are fine for v1)
- Prescribed scheduling (the user picks)

The v2 / hosted offering would add encrypted blob storage with passkey-based access, eventual support for multi-user and selective sharing, a graph view rendering the link structure spatially, and proper provider integrations that don't require the user to maintain export scripts. None of this is necessary to prove the core works. v1 exists to answer the question "is the synthesized Dreaming actually valuable in daily use?" Everything else follows downstream.

---

## What This Isn't

- **Not a replacement for Wikipedia.** The Dreaming covers personal context; Wikipedia covers general knowledge. They compose through links.
- **Not an agent memory.** Task-oriented agents want procedural knowledge and specifications, not semantic models of users.
- **Not a chat log search.** Searching raw conversations is a fallback for things the Dreaming doesn't cover, not the primary retrieval mechanism.
- **Not a vendor product.** The substrate is open and portable by design. Any commercial offering (hosted version) competes on operational quality, not on lock-in.
- **Not autonomous.** The user reads and edits the Dreaming. Talk pages surface conflicts for human resolution. The system is corrigible, not authoritative.

---

## Relationship to Other Work

The design is largely *assembly of existing components in the right configuration*. Markdown is solved. Wiki engines are solved. Git is solved. MCP is a standardized interface. LLM inference is cheap and reliable. The only piece that doesn't exist off-the-shelf is the synthesis pipeline itself, which is where the actual novelty lives.

This is a deliberate constraint. Projects that require inventing new primitives rarely ship. Projects that assemble existing pieces correctly ship and last. The novelty is concentrated where it adds value (synthesis) and avoided where stable solutions already exist (storage, format, retrieval, rendering).

The closest conceptual ancestors: Wikipedia (structure and conventions), personal knowledge management systems like Obsidian and Logseq (markdown-as-substrate, graph views), Andrej Karpathy's "LLM-as-OS" framing (which positions the model as a kernel and external storage as disk — the Dreaming is the user's home directory in that OS), and the Complementary Learning Systems literature in neuroscience (hippocampus + cortex, episodic + semantic memory, consolidation through replay).

---

## Open Questions for v1

- **Article granularity.** What's the right size for an article? Per-entity, per-topic, per-project? Probably a mix with soft size caps triggering splits.
- **Synthesis prompt design.** The pipeline has four stages; each needs a careful prompt. This is where most of the v1 engineering effort will go.
- **Citation format.** How to anchor citations to specific conversation messages reliably (hash-addressed? message IDs? line ranges?).
- **User-edit-vs-synthesis conflict resolution.** How to distinguish user-authored content from synthesis-authored content and resolve overlaps gracefully.
- **Bootstrap quality bar.** What's "good enough" for an initial Dreaming to be valuable on first use rather than feeling like noise.

These are engineering questions, not design questions. The architecture is settled; the implementation details get worked out by building.

---

## Naming

**Morpheus** is the synthesis process. Names work on three levels: the mythological Morpheus (shaper of dreams, giver of form), Matrix Morpheus (the figure who shows you the system you're in and offers clarity), and Gaiman's Sandman Morpheus (sovereign of the Dreaming, custodian of stories, the role being more durable than any single occupant).

**The Dreaming** is the wiki itself — the realm where stories about the user live, are curated, and evolve over time. The name signals that this is a *place you visit* with depth and topology, not a database you query.

Naming the substrate and the process separately matters: the Dreaming persists, Morpheus runs. The Dreaming is *yours*; Morpheus is *interchangeable*. The architectural separation between substrate and process is encoded in the language.

---

## Sequence

This is the second of two projects. The first is **Archie**, an SDLC orchestration system that handles specification-driven software development — the *opposite* end of the agent/assistant split. Archie is for mechanical execution of well-specified work; Morpheus is for open-ended thinking that needs personal context.

Archie is well along. Morpheus starts after Archie ships. The two systems compose cleanly: rich thinking happens with an assistant against the Dreaming, produces a specification, and the specification feeds Archie for mechanical execution. The Dreaming is upstream of the spec; Archie is downstream.

The thinking on Morpheus is mostly done. The next step is implementation.
