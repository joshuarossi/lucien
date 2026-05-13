# Nightly Ingest — Design

**Date:** 2026-05-12
**Status:** Approved (design phase)
**Scope:** Spec 1 of 2 — incremental ingestion only. MCP-tool wrapping and Claude-orchestrated automation are deferred to Spec 2.

## Goal

Replace the one-shot `scripts/ingest.ts` (which reads a manual Claude Data Export archive) with an **incremental ingest path** that pulls conversation data from two live sources and feeds the same sqlite tables the existing pipeline already consumes.

The two sources:

1. **Claude Code sessions** on local disk (`~/.claude/projects/**/*.jsonl`)
2. **claude.ai web conversations** via the internal cookie-authenticated API

After this lands, the nightly workflow is a manual Bash sequence:

```bash
bun run scripts/ingest-recent.ts        # new — this spec
bun run scripts/chunk.ts                # existing
bun run scripts/cluster-assign.ts       # existing
bun run scripts/synthesize.ts           # existing
```

Spec 2 will wrap these as MCP tools and add Claude-orchestrated automation.

## Non-goals

- Re-architecting any of `chunk.ts` / `cluster-assign.ts` / `cluster-taxonomy.ts` / `synthesize.ts`.
- Wrapping the pipeline as MCP tools.
- Cron entry, `Meta/Nightly_Synthesis.md`, or any "single deliverable" orchestration.
- Changing the sqlite schema.
- A new "evaluator" stage — the existing filter/segment/classify/synthesize pipeline already covers "update existing article / create new / discard."

## Architectural decisions

- **No direct Anthropic SDK use, ever.** All LLM work continues to happen inside Claude Code itself (Pattern B). This spec touches only data plumbing.
- **The watermark is a performance filter, not a correctness mechanism.** Idempotency comes from `INSERT OR REPLACE` on message uuid (already the schema's primary key). A re-run that re-parses an already-seen file is correct, just slower.
- **Per-source watermarks** so a failure in one source doesn't poison the other.
- **The existing `scripts/ingest.ts` stays as-is** — it remains useful for bootstrap from a Data Export archive when starting on a new machine.

## File layout

### New files

| Path | Purpose |
|---|---|
| `scripts/ingest-recent.ts` | Entry point. Reads watermarks, runs both adapters in parallel, upserts into sqlite, writes new watermarks, prints summary. |
| `scripts/sources/types.ts` | Shared `NormalizedConversation` / `NormalizedMessage` types both adapters produce. |
| `scripts/sources/claude-code.ts` | Adapter for `~/.claude/projects/**/*.jsonl`. |
| `scripts/sources/claude-ai.ts` | Adapter for the claude.ai internal API. |
| `scripts/auth-set-claude-ai-cookie.ts` | One-time helper. Reads cookie value from stdin, writes `~/.lucien/credentials.json` with mode `0600`. |

### Modified files

| Path | Change |
|---|---|
| `scripts/ingest.ts` | Change hard-coded `DB_PATH` from `~/Downloads/lucien.db` to `~/Dreaming/.lucien/lucien.db`. No schema change. |

### New on-disk state

| Path | Purpose |
|---|---|
| `~/Dreaming/.lucien/lucien.db` | The existing sqlite database (same schema), relocated to the README-documented location. |
| `~/Dreaming/.lucien/state.json` | Per-source watermarks. See **Watermark** below. |
| `~/.lucien/credentials.json` | claude.ai session cookie, mode `0600`. Outside the Dreaming because it is per-machine and not part of versioned wiki content. |

## Normalized data model

`scripts/sources/types.ts`:

```ts
export type Source = "claude-code" | "claude-ai";

export interface NormalizedConversation {
  source: Source;
  uuid: string;              // stable per source — sessionId for Claude Code, conv uuid for claude.ai
  name: string;              // best-effort title
  summary: string;           // empty string if unavailable
  created_at: string;        // ISO 8601
  updated_at: string;        // ISO 8601
  messages: NormalizedMessage[];
}

export interface NormalizedMessage {
  uuid: string;              // stable per source
  sender: "user" | "assistant";
  text: string;
  timestamp: string;         // ISO 8601
  parent_message_uuid: string | null;
}
```

Tool calls and tool results are dropped at the adapter layer. The existing sqlite schema is untouched.

## Adapter — Claude Code JSONL (`sources/claude-code.ts`)

**Input:** `since: string` (ISO 8601 watermark).

**Algorithm:**

1. Glob `~/.claude/projects/**/*.jsonl`.
2. Filter to files with `mtime > since` (performance gate; full scan on first run).
3. For each file, stream-parse line by line.
4. Map events:
   - Event types `user` / `assistant` → one `NormalizedMessage` each.
   - Tool calls, tool results, system events, summaries, sidechain events — **dropped**.
5. Derive the `NormalizedConversation`:
   - `uuid` = filename stem (the session UUID).
   - `name` = first user message text, truncated to ~80 chars; empty string if none.
   - `created_at` = first kept message timestamp.
   - `updated_at` = last kept message timestamp.
6. Return all `NormalizedConversation`s with `source: "claude-code"`.

**Open-session correctness:** Claude Code appends to an in-progress session's JSONL as the conversation continues. Re-parsing the same file is correct because the message-uuid UPSERT in the writer deduplicates. The watermark just means we don't bother re-parsing files whose mtime hasn't moved.

**Resumed/compacted sessions across multiple files:** Treated as one conversation per file in v1. Each file's `sessionId` may also appear inside other files (resume), but downstream chunking does not depend on cross-file continuity. Revisit only if synthesis noise warrants.

**Unknown event types:** logged once per type, then silently skipped. Schema drift across Claude Code versions must never crash an ingest.

## Adapter — claude.ai web (`sources/claude-ai.ts`)

**Input:** `since: string`.

**Auth:** Read `~/.lucien/credentials.json`. If missing, malformed, or the cookie returns 401, log a clear "re-run scripts/auth-set-claude-ai-cookie.ts" message and return `[]`. **Do not** crash the run — the Claude Code source must still ingest.

**Endpoints:**

1. `GET https://claude.ai/api/organizations`
   Headers: `Cookie: sessionKey=<value>`.
   Use the first organization (single-user assumption).

2. `GET https://claude.ai/api/organizations/{orgId}/chat_conversations`
   Returns the list with `uuid`, `name`, `summary`, `created_at`, `updated_at`.
   **Unverified endpoint** — see *Risks*. If it returns 404, the adapter aborts cleanly with a documented fallback path.

3. `GET https://claude.ai/api/organizations/{orgId}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
   Full conversation tree, including alternative branches.

**Algorithm:**

1. Read cookie. Missing → log + return `[]`.
2. Fetch org list, pick first.
3. Fetch conversation list. Filter to `updated_at > since`.
4. For each surviving conversation:
   - Sleep 1s (sequential, rate-limited — this is not a hot path).
   - Fetch the tree.
   - On 4xx/5xx: log, skip, continue. Do not advance watermark past this conversation.
   - Flatten the tree to a linear `Message[]` by walking the **current/main branch only**:
     - Prefer following `current_leaf_message_uuid` back to root if present.
     - Otherwise, take the longest root-to-leaf path.
   - Map human messages → `sender: "user"`, assistant messages → `sender: "assistant"`. Drop tool calls/results.
   - Emit one `NormalizedConversation` per conversation.

**Partial-progress watermark:** The adapter returns its own "effective watermark" — the `updated_at` of the last *successfully-fetched* conversation. The orchestrator persists this even on partial failures, so a retry picks up the rest rather than redoing already-fetched work.

## Orchestrator — `scripts/ingest-recent.ts`

```
1. Ensure ~/Dreaming/.lucien/ exists.
2. Read state.json (default both watermarks to epoch).
3. Run both adapters in parallel via Promise.allSettled.
4. Open sqlite at ~/Dreaming/.lucien/lucien.db.
5. In a single transaction, upsert all returned conversations and messages
   using INSERT OR REPLACE (matches scripts/ingest.ts).
6. Persist new per-source watermarks to state.json.
7. Print summary:
     claude-code: 4 conversations / 87 messages (watermark → 2026-05-12T08:14:03Z)
     claude-ai:   2 conversations / 31 messages (watermark → 2026-05-12T07:55:11Z)
```

Exit code 0 on success. Non-zero only if sqlite write fails (data loss scenario). Adapter-level failures are logged but do not fail the process.

## Watermark file

`~/Dreaming/.lucien/state.json`:

```json
{
  "claude_code": { "last_ingest_at": "2026-05-11T08:00:00Z" },
  "claude_ai":   { "last_ingest_at": "2026-05-11T08:00:00Z" }
}
```

- Missing file → both keys default to `1970-01-01T00:00:00Z`.
- Missing key → that source defaults to epoch (first run for that source).
- Updated atomically (write to `state.json.tmp`, then rename).

## Auth helper — `scripts/auth-set-claude-ai-cookie.ts`

Reads cookie from stdin (avoids shell history), writes `~/.lucien/credentials.json` with mode `0600`. Creates `~/.lucien/` if missing.

Usage:

```bash
pbpaste | bun run scripts/auth-set-claude-ai-cookie.ts
# or
bun run scripts/auth-set-claude-ai-cookie.ts < cookie.txt
```

## Database location migration

Existing users with a database at `~/Downloads/lucien.db` need to move it:

```bash
mkdir -p ~/Dreaming/.lucien
mv ~/Downloads/lucien.db ~/Dreaming/.lucien/lucien.db
```

Documented in the spec; no code-level migration shim.

## Risks

1. **`/api/organizations/{orgId}/chat_conversations` list endpoint is unverified.** The bookmarklet repo only documents the fetch-one endpoint. The claude.ai sidebar must call *something* to populate, and inspection of network traffic should reveal it. Implementation plan must start with a curl spike against this endpoint before writing the adapter. If it doesn't exist, the fallback is Playwright SPA scraping of the sidebar — uglier, deferred until proven necessary.

2. **Claude Code JSONL schema drift.** Anthropic ships new event types from time to time. Parser must default to "skip unknown types" rather than crash.

3. **Cookie expiry is silent until 401.** Acceptable for v1. Surfaced as a clear "re-run auth helper" error.

4. **One-time DB path migration.** Documented; no automated migration.

5. **Tool-call/tool-result filtering may discard signal.** In Claude Code sessions, occasionally a tool call/result *is* the substantive content (e.g., reading a file the user is reasoning about). v1 drops these; revisit if synthesis quality suffers.

## Test plan

- `sources/claude-code.ts`: unit test against a fixture JSONL containing user, assistant, tool-call, tool-result, and an unknown event type. Assert: correct messages emitted, tool events dropped, unknown event logged-once and skipped.
- `sources/claude-ai.ts`: unit test against a fixture conversation-tree JSON with a branching tree. Assert: main-branch linearization, tool events dropped.
- `ingest-recent.ts`: integration test against a temp sqlite, fixture data from both adapters. Assert: rows present, watermark advanced correctly, second run is a no-op.
- Partial-failure test for claude.ai: one conversation 500s mid-batch. Assert: subsequent conversations skipped (or attempted then skipped), watermark stops at the last successful one.
- Auth-missing test: `credentials.json` absent. Assert: claude.ai adapter returns `[]` cleanly, Claude Code adapter still runs.

## Out of scope (reminder)

Spec 2 will cover:
- Wrapping the four pipeline stages as MCP tools.
- Replacing the `claude`-CLI-spawning pattern inside `synthesize.ts`.
- Writing `Meta/Nightly_Synthesis.md` (the operational instruction page).
- Cron entry / slash command for one-shot nightly orchestration.
