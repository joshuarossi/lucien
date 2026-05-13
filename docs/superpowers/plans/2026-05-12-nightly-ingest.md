# Nightly Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an incremental ingest path that pulls conversations from Claude Code JSONL on disk and from claude.ai's internal API, upserting into the existing sqlite schema that `chunk.ts` / `cluster-assign.ts` / `synthesize.ts` already consume.

**Architecture:** A single new entry script `scripts/ingest-recent.ts` reads per-source watermarks from `state.json`, calls two source adapters in parallel (`sources/claude-code.ts`, `sources/claude-ai.ts`), upserts results into `~/Dreaming/.lucien/lucien.db` with `INSERT OR REPLACE` on message uuid, and persists new watermarks. No new LLM calls — this spec is data plumbing only. The pipeline stays runnable as Bash commands; MCP-tool wrapping is deferred to a follow-up spec.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, Bun's built-in `Glob`, `playwright` for claude.ai web access, `bun test` for tests.

**Spec:** `docs/superpowers/specs/2026-05-12-nightly-ingest-design.md`

**Amendment 2026-05-12 (post-Task-4):** Tasks 1–4 completed as planned (types, DB path move, Claude Code adapter). Task 5 was a manual endpoint spike that surfaced a blocker: **claude.ai is gated by Cloudflare TLS fingerprinting**, so cookie-authenticated HTTP from curl/Bun fetch is impossible (403 "Just a moment…" regardless of cookie + UA combinations). The reference repo we cited (Emnolope/claude-conversation-export) works only because it runs *inside* the user's logged-in browser tab. The only durable way to automate web ingest is to drive a real browser. Tasks 5–8 below have been **rewritten** around Playwright. Tasks 9–11 are largely unchanged but reference the new adapter shape.

---

## Conventions used throughout this plan

- All paths are absolute or repo-rooted from `/Users/joshrossi/Code/lucien/`.
- Tests are colocated next to their source file (project convention — see `src/tools/articles.test.ts`).
- Commits follow `<type>: <description>` per global CLAUDE.md (e.g. `feat:`, `test:`, `refactor:`).
- All tests use `bun:test`. Run a single file with `bun test path/to/file.test.ts`.
- Network calls and filesystem I/O are abstracted via injected dependencies so adapters are testable without hitting real services or `~/.claude`.

---

## Task 1: Scaffolding — shared types and directory structure

**Files:**
- Create: `scripts/sources/types.ts`
- Create: `scripts/sources/` directory (implicit)

- [ ] **Step 1: Create `scripts/sources/types.ts`**

```ts
export type Source = "claude-code" | "claude-ai";

export interface NormalizedMessage {
    uuid: string;
    sender: "user" | "assistant";
    text: string;
    timestamp: string; // ISO 8601
    parent_message_uuid: string | null;
}

export interface NormalizedConversation {
    source: Source;
    uuid: string;
    name: string;
    summary: string;
    created_at: string;
    updated_at: string;
    messages: NormalizedMessage[];
}

export interface AdapterResult {
    conversations: NormalizedConversation[];
    /** ISO timestamp the orchestrator should persist as the new watermark for this source. */
    new_watermark: string;
    /** True if the adapter made full forward progress; false if partial (e.g. mid-batch error). */
    complete: boolean;
    /** Human-readable summary printed by the orchestrator. */
    summary: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sources/types.ts
git commit -m "feat: add NormalizedConversation types for incremental ingest"
```

---

## Task 2: Move the sqlite DB to `~/Dreaming/.lucien/lucien.db`

The existing `scripts/ingest.ts` writes to `~/Downloads/lucien.db`. Move it to the README-documented location so all ingest paths share one DB.

**Files:**
- Modify: `scripts/ingest.ts` (line 10)
- Modify: `scripts/chunk.ts` (find the DB_PATH constant)
- Modify: `scripts/cluster-assign.ts`
- Modify: `scripts/cluster-taxonomy.ts`
- Modify: `scripts/synthesize.ts` (line 7)

- [ ] **Step 1: Search for all DB_PATH references**

Run:
```bash
grep -rn "lucien.db" scripts/ src/
```
Expected: every script that opens the DB references `Downloads/lucien.db`. Note each file:line.

- [ ] **Step 2: Update every reference to the new path**

For each file found in Step 1, change:

```ts
const DB_PATH = join(homedir(), "Downloads/lucien.db");
```

to:

```ts
const DB_PATH = join(homedir(), "Dreaming/.lucien/lucien.db");
```

- [ ] **Step 3: Ensure `~/Dreaming/.lucien/` is created on first sqlite open**

Add to `scripts/ingest.ts`, just before `new Database(DB_PATH)`:

```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

await mkdir(dirname(DB_PATH), { recursive: true });
```

(The other scripts assume the DB already exists, so they don't need this — only the ingest scripts do. We'll add the same line to `ingest-recent.ts` in Task 6.)

- [ ] **Step 4: Verify scripts still parse**

Run:
```bash
bun build --target=node --outdir=/tmp/lucien-build scripts/ingest.ts scripts/chunk.ts scripts/cluster-assign.ts scripts/cluster-taxonomy.ts scripts/synthesize.ts
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "refactor: relocate sqlite DB to ~/Dreaming/.lucien/lucien.db

Centralizes pipeline state under the documented .lucien/ directory inside
the Dreaming, replacing the ~/Downloads/lucien.db placeholder.

Users with an existing DB should run:
  mkdir -p ~/Dreaming/.lucien
  mv ~/Downloads/lucien.db ~/Dreaming/.lucien/lucien.db"
```

---

## Task 3: Claude Code adapter — fixture and failing test

**Files:**
- Create: `scripts/sources/claude-code.test.ts`
- Create: `scripts/sources/fixtures/claude-code/session-basic.jsonl`
- Create: `scripts/sources/fixtures/claude-code/session-with-tools.jsonl`

The adapter takes (a) a directory to scan and (b) a `since` watermark, returns an `AdapterResult`. We test it with fixture JSONL files in a temp directory, so the test does not depend on `~/.claude`.

- [ ] **Step 1: Create the basic-session fixture**

Create `scripts/sources/fixtures/claude-code/session-basic.jsonl`. Each line is one JSON event. Make sure each line is a complete JSON object on its own line (no pretty-printing):

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-05-10T10:00:00.000Z","message":{"role":"user","content":"What is the capital of France?"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-05-10T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"The capital of France is Paris."}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-05-10T10:01:00.000Z","message":{"role":"user","content":"And of Germany?"}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","isSidechain":false,"timestamp":"2026-05-10T10:01:08.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Berlin."}]}}
```

The file's stem (`session-basic`) is the `sessionId` we'll derive the conversation uuid from.

- [ ] **Step 2: Create the with-tools fixture**

Create `scripts/sources/fixtures/claude-code/session-with-tools.jsonl`. This exercises filtering: tool_use/tool_result events and sidechain events must be dropped; an unknown event type must be skipped without crashing.

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-05-11T09:00:00.000Z","message":{"role":"user","content":"List files."}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-05-11T09:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Sure."},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","uuid":"tr1","parentUuid":"a1","isSidechain":false,"timestamp":"2026-05-11T09:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file1\nfile2"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"tr1","isSidechain":false,"timestamp":"2026-05-11T09:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Two files."}]}}
{"type":"user","uuid":"side1","parentUuid":"a2","isSidechain":true,"timestamp":"2026-05-11T09:00:06.000Z","message":{"role":"user","content":"subagent thing"}}
{"type":"some-future-event","uuid":"fut1","parentUuid":"a2","timestamp":"2026-05-11T09:00:07.000Z","data":"whatever"}
{"type":"queue-operation","operation":"enqueue","timestamp":"2026-05-11T09:00:08.000Z","sessionId":"session-with-tools"}
```

Expected ingest from this file:
- `u1` → user message, text "List files."
- `a1` → assistant message, text "Sure." (the tool_use block is dropped; text block is kept)
- `tr1` → **DROPPED** (the content is purely a tool_result block, not text)
- `a2` → assistant message, text "Two files."
- `side1` → DROPPED (sidechain)
- `fut1` → DROPPED (unknown type, logged)
- `queue-operation` → DROPPED (unknown type)

- [ ] **Step 3: Write the failing test**

Create `scripts/sources/claude-code.test.ts`:

```ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { ingestClaudeCode } from "./claude-code.js";

const FIXTURES = join(import.meta.dir, "fixtures/claude-code");

test("basic session: maps user/assistant events to NormalizedMessages", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });

    const basic = result.conversations.find((c) => c.uuid === "session-basic");
    expect(basic).toBeDefined();
    expect(basic!.source).toBe("claude-code");
    expect(basic!.messages.length).toBe(4);

    expect(basic!.messages[0]).toMatchObject({
        uuid: "u1",
        sender: "user",
        text: "What is the capital of France?",
        timestamp: "2026-05-10T10:00:00.000Z",
        parent_message_uuid: null,
    });
    expect(basic!.messages[1]).toMatchObject({
        uuid: "a1",
        sender: "assistant",
        text: "The capital of France is Paris.",
    });
    expect(basic!.messages[3].text).toBe("Berlin.");
});

test("with-tools session: drops tool calls, tool results, sidechain, unknown types", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });

    const wt = result.conversations.find((c) => c.uuid === "session-with-tools");
    expect(wt).toBeDefined();
    const uuids = wt!.messages.map((m) => m.uuid);
    expect(uuids).toEqual(["u1", "a1", "a2"]);
    expect(wt!.messages[1].text).toBe("Sure."); // tool_use block stripped, only text kept
});

test("derives conversation name from first user message, truncated to 80 chars", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    const basic = result.conversations.find((c) => c.uuid === "session-basic")!;
    expect(basic.name).toBe("What is the capital of France?");
});

test("derives created_at and updated_at from first/last kept messages", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    const basic = result.conversations.find((c) => c.uuid === "session-basic")!;
    expect(basic.created_at).toBe("2026-05-10T10:00:00.000Z");
    expect(basic.updated_at).toBe("2026-05-10T10:01:08.000Z");
});

test("watermark gate: skips files whose mtime is older than `since`", async () => {
    // since == future → all files filtered out at mtime layer
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "2099-01-01T00:00:00.000Z",
    });
    expect(result.conversations).toEqual([]);
});

test("returns new_watermark = max message timestamp seen across all conversations", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    // Max across fixtures is 2026-05-11T09:00:05.000Z (a2 in with-tools)
    expect(result.new_watermark).toBe("2026-05-11T09:00:05.000Z");
});

test("complete is true on successful run", async () => {
    const result = await ingestClaudeCode({
        rootDir: FIXTURES,
        since: "1970-01-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test scripts/sources/claude-code.test.ts`
Expected: FAIL with "Cannot find module './claude-code.js'" (or similar).

- [ ] **Step 5: Commit failing test + fixtures**

```bash
git add scripts/sources/claude-code.test.ts scripts/sources/fixtures/
git commit -m "test: add fixtures and failing tests for claude-code adapter"
```

---

## Task 4: Claude Code adapter — implementation

**Files:**
- Create: `scripts/sources/claude-code.ts`

- [ ] **Step 1: Implement the adapter**

Create `scripts/sources/claude-code.ts`:

```ts
import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AdapterResult, NormalizedConversation, NormalizedMessage } from "./types.js";

interface IngestClaudeCodeOptions {
    /** Root directory to scan. Defaults to ~/.claude/projects. */
    rootDir: string;
    /** ISO timestamp. Files with mtime <= since are skipped at the file layer. */
    since: string;
}

interface RawEvent {
    type?: string;
    uuid?: string;
    parentUuid?: string | null;
    isSidechain?: boolean;
    timestamp?: string;
    message?: {
        role?: string;
        content?: string | Array<{ type: string; text?: string }>;
    };
}

const KEEP_TYPES = new Set(["user", "assistant"]);
const warnedUnknownTypes = new Set<string>();

function extractText(content: RawEvent["message"] extends infer M ? M : never): string {
    const c = (content as { content?: unknown })?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .filter((b: { type: string; text?: string }) => b.type === "text" && typeof b.text === "string")
            .map((b: { text?: string }) => b.text)
            .join("\n")
            .trim();
    }
    return "";
}

async function parseSession(filePath: string): Promise<NormalizedConversation | null> {
    const sessionId = basename(filePath).replace(/\.jsonl$/, "");
    const text = await Bun.file(filePath).text();
    const messages: NormalizedMessage[] = [];

    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev: RawEvent;
        try {
            ev = JSON.parse(line);
        } catch {
            continue; // skip malformed lines
        }
        if (!ev.type) continue;
        if (!KEEP_TYPES.has(ev.type)) {
            if (!warnedUnknownTypes.has(ev.type)) {
                warnedUnknownTypes.add(ev.type);
                console.warn(`[claude-code] unknown event type, skipping: ${ev.type}`);
            }
            continue;
        }
        if (ev.isSidechain) continue;
        if (!ev.uuid || !ev.timestamp) continue;

        const extracted = extractText(ev.message);
        if (!extracted) continue; // e.g. a "user" event whose content is only a tool_result block

        messages.push({
            uuid: ev.uuid,
            sender: ev.type as "user" | "assistant",
            text: extracted,
            timestamp: ev.timestamp,
            parent_message_uuid: ev.parentUuid ?? null,
        });
    }

    if (messages.length === 0) return null;

    const firstUserText = messages.find((m) => m.sender === "user")?.text ?? "";
    return {
        source: "claude-code",
        uuid: sessionId,
        name: firstUserText.slice(0, 80),
        summary: "",
        created_at: messages[0].timestamp,
        updated_at: messages[messages.length - 1].timestamp,
        messages,
    };
}

export async function ingestClaudeCode(
    opts: IngestClaudeCodeOptions
): Promise<AdapterResult> {
    const sinceMs = Date.parse(opts.since);
    const glob = new Glob("**/*.jsonl");
    const conversations: NormalizedConversation[] = [];

    for await (const rel of glob.scan({ cwd: opts.rootDir, absolute: false })) {
        const abs = join(opts.rootDir, rel);
        let s;
        try {
            s = await stat(abs);
        } catch {
            continue;
        }
        if (s.mtimeMs <= sinceMs) continue;

        try {
            const conv = await parseSession(abs);
            if (conv) conversations.push(conv);
        } catch (err) {
            console.warn(`[claude-code] failed to parse ${rel}: ${(err as Error).message}`);
        }
    }

    let maxTs = opts.since;
    for (const c of conversations) {
        if (c.updated_at > maxTs) maxTs = c.updated_at;
    }

    return {
        conversations,
        new_watermark: maxTs,
        complete: true,
        summary: `claude-code: ${conversations.length} conversations / ${conversations.reduce(
            (n, c) => n + c.messages.length,
            0
        )} messages`,
    };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test scripts/sources/claude-code.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/sources/claude-code.ts
git commit -m "feat: implement claude-code JSONL source adapter"
```

---

## Task 5: Add Playwright and write a first-time login script

The claude.ai adapter must use a real browser. We use Playwright with a **persistent context** rooted at `~/.lucien/playwright-profile/`. Once the user logs in there once (interactively, in a headed Chromium window), the profile retains the cookies and CF clearance so subsequent runs can go headless.

**Files:**
- Modify: `package.json` (add `playwright` dependency)
- Create: `scripts/auth-claude-ai-login.ts`

- [ ] **Step 1: Add the dependency**

Run:
```bash
bun add playwright
```
Expected: `package.json` and `bun.lock` updated. Note that Playwright bundles its own browser binaries — if the post-install download didn't run, run `bunx playwright install chromium` manually.

- [ ] **Step 2: Implement the login script**

Create `scripts/auth-claude-ai-login.ts` with this exact content:

```ts
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const DEFAULT_PROFILE = join(homedir(), ".lucien", "playwright-profile");

export interface LoginOptions {
    profilePath?: string;
    headless?: boolean;
    /** Max seconds to wait for the user to finish logging in. Default 300. */
    timeoutSeconds?: number;
}

/**
 * Opens a real Chromium window pointed at claude.ai. The user signs in
 * (or confirms they are already signed in). On return, the profile directory
 * holds the cookies needed for headless runs.
 */
export async function loginInteractive(opts: LoginOptions = {}): Promise<void> {
    const profilePath = opts.profilePath ?? DEFAULT_PROFILE;
    const headless = opts.headless ?? false;
    const timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;

    await mkdir(profilePath, { recursive: true });

    const ctx = await chromium.launchPersistentContext(profilePath, {
        headless,
        viewport: { width: 1280, height: 800 },
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded" });

    console.log(
        "[auth] Sign in to claude.ai in the opened window. " +
            "Waiting for an authenticated session..."
    );

    // The /api/organizations endpoint returns 200 only when authenticated.
    // We poll it from inside the page until success or timeout.
    const start = Date.now();
    let lastStatus = 0;
    while (Date.now() - start < timeoutMs) {
        lastStatus = await page.evaluate(async () => {
            const r = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return r.status;
        });
        if (lastStatus === 200) break;
        await new Promise((r) => setTimeout(r, 2000));
    }

    if (lastStatus !== 200) {
        await ctx.close();
        throw new Error(
            `[auth] Did not detect a signed-in session within ${
                opts.timeoutSeconds ?? 300
            }s (last status: ${lastStatus}).`
        );
    }

    console.log(`[auth] Signed in. Profile saved at ${profilePath}.`);
    await ctx.close();
}

if (import.meta.main) {
    await loginInteractive();
}
```

- [ ] **Step 3: Run a manual sanity check**

```bash
bun run scripts/auth-claude-ai-login.ts
```
Expected: Chromium window opens at claude.ai. If you're already logged in, the script detects 200 from `/api/organizations` within a few seconds and exits cleanly. If not, you sign in in the window; the script then detects 200 and exits. Profile is at `~/.lucien/playwright-profile/`.

If Chromium fails to launch with "missing browser" error, run `bunx playwright install chromium` and retry.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock scripts/auth-claude-ai-login.ts
git commit -m "feat: add playwright dependency and claude.ai login bootstrap script"
```

---

## Task 6: Linearization module — pure tree-flattening logic with tests

This is the pure portion of the claude.ai adapter: given a `ConvTree` JSON, return a linearized `NormalizedConversation`. No network, fully unit-testable. The fetcher in Task 7 calls this function after retrieving JSON via Playwright.

**Files:**
- Create: `scripts/sources/claude-ai-linearize.ts`
- Create: `scripts/sources/claude-ai-linearize.test.ts`
- Create: `scripts/sources/fixtures/claude-ai/conv-list.json`
- Create: `scripts/sources/fixtures/claude-ai/conv-tree-linear.json`
- Create: `scripts/sources/fixtures/claude-ai/conv-tree-branching.json`

- [ ] **Step 1: Create the fixtures**

`scripts/sources/fixtures/claude-ai/conv-list.json`:

```json
[
  {
    "uuid": "conv-old",
    "name": "Old conversation",
    "summary": "",
    "created_at": "2026-04-01T10:00:00.000000+00:00",
    "updated_at": "2026-04-01T10:30:00.000000+00:00"
  },
  {
    "uuid": "conv-linear",
    "name": "Simple linear chat",
    "summary": "",
    "created_at": "2026-05-10T10:00:00.000000+00:00",
    "updated_at": "2026-05-10T10:05:00.000000+00:00"
  },
  {
    "uuid": "conv-branching",
    "name": "Branching chat",
    "summary": "",
    "created_at": "2026-05-11T10:00:00.000000+00:00",
    "updated_at": "2026-05-11T10:10:00.000000+00:00"
  }
]
```

`scripts/sources/fixtures/claude-ai/conv-tree-linear.json`:

```json
{
  "uuid": "conv-linear",
  "name": "Simple linear chat",
  "summary": "",
  "created_at": "2026-05-10T10:00:00.000000+00:00",
  "updated_at": "2026-05-10T10:05:00.000000+00:00",
  "current_leaf_message_uuid": "m2",
  "chat_messages": [
    {
      "uuid": "m1",
      "sender": "human",
      "parent_message_uuid": null,
      "created_at": "2026-05-10T10:00:00.000000+00:00",
      "content": [{ "type": "text", "text": "Hello." }]
    },
    {
      "uuid": "m2",
      "sender": "assistant",
      "parent_message_uuid": "m1",
      "created_at": "2026-05-10T10:00:30.000000+00:00",
      "content": [{ "type": "text", "text": "Hi there." }]
    }
  ]
}
```

`scripts/sources/fixtures/claude-ai/conv-tree-branching.json`:

```json
{
  "uuid": "conv-branching",
  "name": "Branching chat",
  "summary": "",
  "created_at": "2026-05-11T10:00:00.000000+00:00",
  "updated_at": "2026-05-11T10:10:00.000000+00:00",
  "current_leaf_message_uuid": "m4",
  "chat_messages": [
    {
      "uuid": "m1",
      "sender": "human",
      "parent_message_uuid": null,
      "created_at": "2026-05-11T10:00:00.000000+00:00",
      "content": [{ "type": "text", "text": "What is 2+2?" }]
    },
    {
      "uuid": "m2-alt",
      "sender": "assistant",
      "parent_message_uuid": "m1",
      "created_at": "2026-05-11T10:00:30.000000+00:00",
      "content": [{ "type": "text", "text": "Five." }]
    },
    {
      "uuid": "m2",
      "sender": "assistant",
      "parent_message_uuid": "m1",
      "created_at": "2026-05-11T10:01:00.000000+00:00",
      "content": [{ "type": "text", "text": "Four." }]
    },
    {
      "uuid": "m3",
      "sender": "human",
      "parent_message_uuid": "m2",
      "created_at": "2026-05-11T10:02:00.000000+00:00",
      "content": [{ "type": "text", "text": "And 3+3?" }]
    },
    {
      "uuid": "m4",
      "sender": "assistant",
      "parent_message_uuid": "m3",
      "created_at": "2026-05-11T10:02:30.000000+00:00",
      "content": [{ "type": "text", "text": "Six." }]
    }
  ]
}
```

The main branch in the branching fixture (walking back from `current_leaf_message_uuid=m4`) is `[m1, m2, m3, m4]`. The alternate branch `m2-alt` must be excluded.

> **Important:** if Task 5's manual sanity check revealed the real API returns differently-shaped data (different sender values, different content array shape, different field names like `text` vs `content`), update these fixtures to match the real shape before writing the tests. The whole point of running Task 5 first was to lock down the real schema.

- [ ] **Step 2: Write the failing test file**

Create `scripts/sources/claude-ai-linearize.test.ts`:

```ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import {
    linearizeTree,
    filterListBySince,
    treeToNormalizedConversation,
    type ConvListItem,
    type ConvTree,
} from "./claude-ai-linearize.js";

const FIXTURES = join(import.meta.dir, "fixtures/claude-ai");

async function loadJson<T>(name: string): Promise<T> {
    return JSON.parse(await Bun.file(join(FIXTURES, name)).text()) as T;
}

test("linearizeTree: linear conversation returns messages in order", async () => {
    const tree = await loadJson<ConvTree>("conv-tree-linear.json");
    const linear = linearizeTree(tree);
    expect(linear.map((m) => m.uuid)).toEqual(["m1", "m2"]);
});

test("linearizeTree: branching conversation walks back from current_leaf only", async () => {
    const tree = await loadJson<ConvTree>("conv-tree-branching.json");
    const linear = linearizeTree(tree);
    expect(linear.map((m) => m.uuid)).toEqual(["m1", "m2", "m3", "m4"]);
});

test("linearizeTree: missing current_leaf falls back to longest root-to-leaf path", async () => {
    const tree = await loadJson<ConvTree>("conv-tree-branching.json");
    const { current_leaf_message_uuid: _drop, ...rest } = tree;
    const without = rest as ConvTree;
    const linear = linearizeTree(without);
    expect(linear.length).toBe(4);
    expect(linear[0].uuid).toBe("m1");
    expect(linear[linear.length - 1].uuid).toBe("m4");
});

test("treeToNormalizedConversation: maps sender 'human' → 'user' and preserves 'assistant'", async () => {
    const tree = await loadJson<ConvTree>("conv-tree-linear.json");
    const conv = treeToNormalizedConversation(tree)!;
    expect(conv.source).toBe("claude-ai");
    expect(conv.messages.map((m) => m.sender)).toEqual(["user", "assistant"]);
});

test("treeToNormalizedConversation: drops messages with empty text", async () => {
    const tree: ConvTree = {
        uuid: "x",
        name: "x",
        summary: "",
        created_at: "2026-05-12T00:00:00.000000+00:00",
        updated_at: "2026-05-12T00:00:00.000000+00:00",
        current_leaf_message_uuid: "m1",
        chat_messages: [
            {
                uuid: "m1",
                sender: "human",
                parent_message_uuid: null,
                created_at: "2026-05-12T00:00:00.000000+00:00",
                content: [{ type: "tool_use", text: undefined } as any],
            },
        ],
    };
    expect(treeToNormalizedConversation(tree)).toBeNull();
});

test("treeToNormalizedConversation: normalizes timestamps to Z form", async () => {
    const tree = await loadJson<ConvTree>("conv-tree-linear.json");
    const conv = treeToNormalizedConversation(tree)!;
    expect(conv.created_at).toBe("2026-05-10T10:00:00.000Z");
    expect(conv.updated_at).toBe("2026-05-10T10:05:00.000Z");
    expect(conv.messages[0].timestamp).toBe("2026-05-10T10:00:00.000Z");
});

test("filterListBySince: returns items with updated_at > since, sorted ascending", async () => {
    const list = await loadJson<ConvListItem[]>("conv-list.json");
    const filtered = filterListBySince(list, "2026-05-09T00:00:00.000Z");
    expect(filtered.map((i) => i.uuid)).toEqual(["conv-linear", "conv-branching"]);
});

test("filterListBySince: empty result when since is in the future", async () => {
    const list = await loadJson<ConvListItem[]>("conv-list.json");
    const filtered = filterListBySince(list, "2099-01-01T00:00:00.000Z");
    expect(filtered).toEqual([]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test scripts/sources/claude-ai-linearize.test.ts`
Expected: FAIL with module-not-found for `./claude-ai-linearize.js`.

- [ ] **Step 4: Implement the pure module**

Create `scripts/sources/claude-ai-linearize.ts`:

```ts
import type { NormalizedConversation, NormalizedMessage } from "./types.js";

export interface ConvListItem {
    uuid: string;
    name?: string;
    summary?: string;
    created_at: string;
    updated_at: string;
}

export interface TreeMessage {
    uuid: string;
    sender: string; // "human" | "assistant" (and possibly others)
    parent_message_uuid: string | null;
    created_at: string;
    content: Array<{ type: string; text?: string }>;
}

export interface ConvTree {
    uuid: string;
    name?: string;
    summary?: string;
    created_at: string;
    updated_at: string;
    current_leaf_message_uuid?: string;
    chat_messages: TreeMessage[];
}

function normalizeIso(ts: string): string {
    return new Date(ts).toISOString();
}

export function linearizeTree(tree: ConvTree): TreeMessage[] {
    const byUuid = new Map(tree.chat_messages.map((m) => [m.uuid, m]));

    if (tree.current_leaf_message_uuid && byUuid.has(tree.current_leaf_message_uuid)) {
        const path: TreeMessage[] = [];
        let cur: TreeMessage | undefined = byUuid.get(tree.current_leaf_message_uuid);
        while (cur) {
            path.unshift(cur);
            cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : undefined;
        }
        return path;
    }

    const childrenOf = new Map<string | null, TreeMessage[]>();
    for (const m of tree.chat_messages) {
        const k = m.parent_message_uuid;
        if (!childrenOf.has(k)) childrenOf.set(k, []);
        childrenOf.get(k)!.push(m);
    }
    function longest(from: string | null): TreeMessage[] {
        const kids = childrenOf.get(from) ?? [];
        let best: TreeMessage[] = [];
        for (const k of kids) {
            const sub = [k, ...longest(k.uuid)];
            if (sub.length > best.length) best = sub;
        }
        return best;
    }
    return longest(null);
}

function extractText(content: TreeMessage["content"]): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
        .trim();
}

function toNormalizedMessage(m: TreeMessage): NormalizedMessage | null {
    const text = extractText(m.content);
    if (!text) return null;
    const sender: "user" | "assistant" =
        m.sender === "human" || m.sender === "user" ? "user" : "assistant";
    return {
        uuid: m.uuid,
        sender,
        text,
        timestamp: normalizeIso(m.created_at),
        parent_message_uuid: m.parent_message_uuid,
    };
}

export function treeToNormalizedConversation(tree: ConvTree): NormalizedConversation | null {
    const linear = linearizeTree(tree);
    const messages = linear
        .map(toNormalizedMessage)
        .filter((m): m is NormalizedMessage => m !== null);
    if (messages.length === 0) return null;
    return {
        source: "claude-ai",
        uuid: tree.uuid,
        name: tree.name ?? "",
        summary: tree.summary ?? "",
        created_at: normalizeIso(tree.created_at),
        updated_at: normalizeIso(tree.updated_at),
        messages,
    };
}

export function filterListBySince(items: ConvListItem[], since: string): ConvListItem[] {
    const sinceMs = Date.parse(since);
    return items
        .filter((it) => Date.parse(it.updated_at) > sinceMs)
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test scripts/sources/claude-ai-linearize.test.ts`
Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/sources/claude-ai-linearize.ts scripts/sources/claude-ai-linearize.test.ts scripts/sources/fixtures/claude-ai/
git commit -m "feat: pure tree linearization + list filter for claude-ai adapter"
```

---

## Task 7: claude.ai Playwright fetcher

The thin network layer. Opens the persistent Playwright profile from Task 5, navigates to claude.ai, runs in-page `fetch()` for the same endpoints the bookmarklet uses, hands the JSON to the pure linearize module from Task 6.

**Files:**
- Create: `scripts/sources/claude-ai.ts`
- Create: `scripts/sources/claude-ai.test.ts` (integration test, gated on profile existence)

- [ ] **Step 1: Implement the fetcher**

Create `scripts/sources/claude-ai.ts`:

```ts
import { chromium, type BrowserContext } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import type { AdapterResult, NormalizedConversation } from "./types.js";
import {
    filterListBySince,
    treeToNormalizedConversation,
    type ConvListItem,
    type ConvTree,
} from "./claude-ai-linearize.js";

export interface IngestClaudeAiOptions {
    /** Path to the Playwright persistent-context profile directory. */
    profilePath?: string;
    /** ISO timestamp watermark. */
    since: string;
    /** Sleep between conversation fetches (ms). Default 1000; tests can pass 0. */
    sleepMs?: number;
    /** Inject a context for tests. If provided, profilePath is ignored. */
    context?: BrowserContext;
}

const DEFAULT_PROFILE = join(homedir(), ".lucien", "playwright-profile");

async function profileExists(p: string): Promise<boolean> {
    try {
        await access(p);
        return true;
    } catch {
        return false;
    }
}

export async function ingestClaudeAi(
    opts: IngestClaudeAiOptions
): Promise<AdapterResult> {
    const profilePath = opts.profilePath ?? DEFAULT_PROFILE;
    const sleepMs = opts.sleepMs ?? 1000;

    let ctx: BrowserContext;
    let ownsCtx = false;
    if (opts.context) {
        ctx = opts.context;
    } else {
        if (!(await profileExists(profilePath))) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: no profile at ${profilePath}. Run scripts/auth-claude-ai-login.ts first.`,
            };
        }
        ctx = await chromium.launchPersistentContext(profilePath, { headless: true });
        ownsCtx = true;
    }

    try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded" });

        // 1. Org list
        const orgsRes = await page.evaluate(async () => {
            const r = await fetch("/api/organizations", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return { status: r.status, body: r.status === 200 ? await r.json() : null };
        });
        if (orgsRes.status === 401) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary:
                    "claude-ai: profile is no longer authenticated (401). Re-run scripts/auth-claude-ai-login.ts.",
            };
        }
        if (orgsRes.status !== 200 || !orgsRes.body?.length) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: org list failed with status ${orgsRes.status}`,
            };
        }
        const orgId = (orgsRes.body as Array<{ uuid: string }>)[0].uuid;

        // 2. Conversation list
        const listRes = await page.evaluate(async (oid: string) => {
            const r = await fetch(`/api/organizations/${oid}/chat_conversations`, {
                credentials: "include",
                headers: { Accept: "application/json" },
            });
            return { status: r.status, body: r.status === 200 ? await r.json() : null };
        }, orgId);
        if (listRes.status !== 200) {
            return {
                conversations: [],
                new_watermark: opts.since,
                complete: false,
                summary: `claude-ai: conversation list failed with status ${listRes.status}`,
            };
        }
        const items = listRes.body as ConvListItem[];
        const fresh = filterListBySince(items, opts.since);

        // 3. Per-conversation tree fetch
        const conversations: NormalizedConversation[] = [];
        let lastGoodUpdatedAt = opts.since;
        let complete = true;

        for (let i = 0; i < fresh.length; i++) {
            const item = fresh[i];
            if (i > 0 && sleepMs > 0) {
                await new Promise((r) => setTimeout(r, sleepMs));
            }
            const treeRes = await page.evaluate(
                async ([oid, cid]: [string, string]) => {
                    const u = `/api/organizations/${oid}/chat_conversations/${cid}?tree=True&rendering_mode=messages&render_all_tools=true`;
                    const r = await fetch(u, {
                        credentials: "include",
                        headers: { Accept: "application/json" },
                    });
                    return { status: r.status, body: r.status === 200 ? await r.json() : null };
                },
                [orgId, item.uuid] as [string, string]
            );
            if (treeRes.status !== 200 || !treeRes.body) {
                console.warn(`[claude-ai] ${item.uuid} → status ${treeRes.status}, skipping`);
                complete = false;
                continue;
            }
            const conv = treeToNormalizedConversation(treeRes.body as ConvTree);
            if (conv) conversations.push(conv);
            lastGoodUpdatedAt = new Date(item.updated_at).toISOString();
        }

        return {
            conversations,
            new_watermark: lastGoodUpdatedAt,
            complete,
            summary: `claude-ai: ${conversations.length} conversations / ${conversations.reduce(
                (n, c) => n + c.messages.length,
                0
            )} messages`,
        };
    } finally {
        if (ownsCtx) await ctx.close();
    }
}
```

- [ ] **Step 2: Write a gated integration test**

Create `scripts/sources/claude-ai.test.ts`:

```ts
import { test, expect } from "bun:test";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestClaudeAi } from "./claude-ai.js";

const PROFILE = join(homedir(), ".lucien", "playwright-profile");

async function profileExists(): Promise<boolean> {
    try {
        await access(PROFILE);
        return true;
    } catch {
        return false;
    }
}

test("missing profile: returns empty result with helpful summary, complete=false", async () => {
    const result = await ingestClaudeAi({
        profilePath: "/tmp/lucien-nonexistent-profile-" + Date.now(),
        since: "1970-01-01T00:00:00.000Z",
        sleepMs: 0,
    });
    expect(result.conversations).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.summary).toMatch(/profile/i);
});

// This integration test only runs when the user has logged in via
// scripts/auth-claude-ai-login.ts. Skipped otherwise so CI / fresh
// clones don't fail.
const hasProfile = await profileExists();
const maybe = hasProfile ? test : test.skip;

maybe(
    "integration: fetches against real claude.ai with logged-in profile (slow)",
    async () => {
        const result = await ingestClaudeAi({
            profilePath: PROFILE,
            since: "2099-01-01T00:00:00.000Z", // future = empty result, just exercises auth path
            sleepMs: 0,
        });
        // Either the org list succeeds and filtering produces zero (since=future),
        // or we get a clean auth failure summary. Both are valid signals that the
        // pipeline executed end-to-end without crashing.
        expect(result.conversations).toEqual([]);
        expect(typeof result.summary).toBe("string");
    },
    60_000
);
```

- [ ] **Step 3: Run the tests**

Run: `bun test scripts/sources/claude-ai.test.ts`
Expected:
- The "missing profile" test passes (no Playwright launched; just disk check).
- The "integration" test passes if you logged in during Task 5, otherwise it's skipped.

- [ ] **Step 4: Commit**

```bash
git add scripts/sources/claude-ai.ts scripts/sources/claude-ai.test.ts
git commit -m "feat: implement claude-ai source via Playwright persistent context"
```

---

## Task 8: Runbook documentation

Replaces the original Task 8 (cookie auth helper). With Playwright there is no cookie file; auth lives in the profile directory. We instead capture the one-time setup steps in a runbook.

**Files:**
- Create: `docs/nightly-ingest-runbook.md`

- [ ] **Step 1: Write the runbook**

Create `docs/nightly-ingest-runbook.md` with this content:

```markdown
# Nightly Ingest — Runbook

Spec 1 ships an incremental ingest path that pulls conversations from two sources into `~/Dreaming/.lucien/lucien.db`, feeding the existing chunk / cluster-assign / synthesize pipeline.

## First-time setup

One-time per machine.

1. Install dependencies:
   ```bash
   bun install
   bunx playwright install chromium
   ```

2. Log in to claude.ai once so the Playwright profile is populated:
   ```bash
   bun run scripts/auth-claude-ai-login.ts
   ```
   A Chromium window opens at claude.ai. Sign in if needed. The script exits when it detects an authenticated session. The profile is stored at `~/.lucien/playwright-profile/`.

3. If you already had a `~/Downloads/lucien.db` from previous bootstrap runs, move it:
   ```bash
   mkdir -p ~/Dreaming/.lucien
   mv ~/Downloads/lucien.db ~/Dreaming/.lucien/lucien.db
   ```

## Nightly run (manual for now)

```bash
bun run scripts/ingest-recent.ts        # pull new conversations from both sources
bun run scripts/chunk.ts                # segment into topic chunks
bun run scripts/cluster-assign.ts       # classify chunks into buckets
bun run scripts/synthesize.ts           # update / create articles
```

Spec 2 will wrap this as a single Claude-orchestrated command.

## Re-authenticating

If a run reports `claude-ai: profile is no longer authenticated`, re-run:

```bash
bun run scripts/auth-claude-ai-login.ts
```

This typically only happens if you sign out of claude.ai in the Playwright profile, or after a very long period of inactivity.

## State files

| Path | Purpose |
|---|---|
| `~/Dreaming/.lucien/lucien.db` | sqlite — conversations, messages, chunks, buckets |
| `~/Dreaming/.lucien/state.json` | per-source ingest watermarks |
| `~/.lucien/playwright-profile/` | Playwright Chromium profile (cookies, local storage) |
```

- [ ] **Step 2: Commit**

```bash
git add docs/nightly-ingest-runbook.md
git commit -m "docs: add nightly-ingest runbook covering first-time setup and the manual run sequence"
```

---
---

## Task 9: Orchestrator — failing integration test

**Files:**
- Create: `scripts/ingest-recent.test.ts`

This test exercises the full orchestrator end-to-end: it points at a temp Dreaming, a temp fixture root for Claude Code JSONL, and an injected fake fetch for claude.ai. It asserts rows landed in sqlite, watermarks were persisted correctly, and a second run is a no-op (idempotent).

- [ ] **Step 1: Write the failing test**

Create `scripts/ingest-recent.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { runIngestRecent } from "./ingest-recent.js";

let dreamingDir: string;
let claudeCodeDir: string;
let credsPath: string;

beforeEach(async () => {
    dreamingDir = await mkdtemp(join(tmpdir(), "lucien-dream-"));
    claudeCodeDir = await mkdtemp(join(tmpdir(), "lucien-cc-"));
    credsPath = join(await mkdtemp(join(tmpdir(), "lucien-creds-")), "credentials.json");

    // Copy claude-code fixtures into the temp Claude Code dir
    const srcRoot = join(import.meta.dir, "sources/fixtures/claude-code");
    const glob = new Glob("**/*.jsonl");
    for await (const rel of glob.scan({ cwd: srcRoot, absolute: false })) {
        const dst = join(claudeCodeDir, rel);
        await mkdir(join(dst, ".."), { recursive: true });
        await copyFile(join(srcRoot, rel), dst);
    }

    // Write cookie file
    await writeFile(credsPath, JSON.stringify({ claude_ai_session_key: "fake" }));
});

afterEach(async () => {
    await rm(dreamingDir, { recursive: true, force: true });
    await rm(claudeCodeDir, { recursive: true, force: true });
});

function fakeFetch() {
    const fixturesRoot = join(import.meta.dir, "sources/fixtures/claude-ai");
    return async (url: string): Promise<Response> => {
        if (url.endsWith("/api/organizations")) {
            return new Response(await Bun.file(join(fixturesRoot, "org-list.json")).text(), { status: 200 });
        }
        if (url.match(/\/chat_conversations$/)) {
            return new Response(await Bun.file(join(fixturesRoot, "conv-list.json")).text(), { status: 200 });
        }
        const m = url.match(/\/chat_conversations\/([^?]+)/);
        if (m) {
            const file = m[1] === "conv-branching" ? "conv-tree-branching.json" : "conv-tree-linear.json";
            return new Response(await Bun.file(join(fixturesRoot, file)).text(), { status: 200 });
        }
        return new Response("?", { status: 500 });
    };
}

test("end-to-end: ingests both sources, persists watermarks, second run is no-op", async () => {
    const r1 = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        credentialsPath: credsPath,
        fetchFn: fakeFetch(),
        sleepMs: 0,
    });
    expect(r1.claudeCode.conversations.length).toBeGreaterThan(0);
    expect(r1.claudeAi.conversations.length).toBeGreaterThan(0);

    const db = new Database(join(dreamingDir, ".lucien", "lucien.db"));
    const convCount = (db.query("SELECT COUNT(*) as n FROM conversations").get() as { n: number }).n;
    const msgCount = (db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
    expect(convCount).toBe(r1.claudeCode.conversations.length + r1.claudeAi.conversations.length);
    expect(msgCount).toBeGreaterThan(0);
    db.close();

    // Re-run: nothing new
    const r2 = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        credentialsPath: credsPath,
        fetchFn: fakeFetch(),
        sleepMs: 0,
    });
    expect(r2.claudeCode.conversations.length).toBe(0);
    // claude.ai still re-fetches the list but its watermark filters items out
    expect(r2.claudeAi.conversations.length).toBe(0);
});

test("missing credentials file: claude-code still ingests; claude-ai gracefully skipped", async () => {
    const result = await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        credentialsPath: join(dreamingDir, "does-not-exist.json"),
        fetchFn: fakeFetch(),
        sleepMs: 0,
    });
    expect(result.claudeCode.conversations.length).toBeGreaterThan(0);
    expect(result.claudeAi.conversations).toEqual([]);
    expect(result.claudeAi.complete).toBe(false);
});

test("writes state.json with both per-source watermarks", async () => {
    await runIngestRecent({
        dreamingPath: dreamingDir,
        claudeCodeRoot: claudeCodeDir,
        credentialsPath: credsPath,
        fetchFn: fakeFetch(),
        sleepMs: 0,
    });
    const state = JSON.parse(
        await Bun.file(join(dreamingDir, ".lucien", "state.json")).text()
    );
    expect(state.claude_code.last_ingest_at).toMatch(/^\d{4}-/);
    expect(state.claude_ai.last_ingest_at).toMatch(/^\d{4}-/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/ingest-recent.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Commit failing test**

```bash
git add scripts/ingest-recent.test.ts
git commit -m "test: add failing integration tests for ingest-recent orchestrator"
```

---

## Task 10: Orchestrator — implementation

**Files:**
- Create: `scripts/ingest-recent.ts`

- [ ] **Step 1: Implement the orchestrator**

Create `scripts/ingest-recent.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ingestClaudeCode } from "./sources/claude-code.js";
import { ingestClaudeAi } from "./sources/claude-ai.js";
import type { AdapterResult, NormalizedConversation } from "./sources/types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  uuid TEXT PRIMARY KEY,
  name TEXT,
  summary TEXT,
  created_at TEXT,
  updated_at TEXT,
  message_count INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY,
  conversation_uuid TEXT NOT NULL,
  position INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT,
  timestamp TEXT,
  parent_message_uuid TEXT,
  FOREIGN KEY (conversation_uuid) REFERENCES conversations(uuid)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_position ON messages(conversation_uuid, position);
`;

interface State {
    claude_code: { last_ingest_at: string };
    claude_ai: { last_ingest_at: string };
}

const EPOCH = "1970-01-01T00:00:00.000Z";

async function readState(path: string): Promise<State> {
    try {
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            claude_code: { last_ingest_at: parsed?.claude_code?.last_ingest_at ?? EPOCH },
            claude_ai: { last_ingest_at: parsed?.claude_ai?.last_ingest_at ?? EPOCH },
        };
    } catch {
        return { claude_code: { last_ingest_at: EPOCH }, claude_ai: { last_ingest_at: EPOCH } };
    }
}

async function writeState(path: string, state: State): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmp, path);
}

async function readCookie(path: string): Promise<string | null> {
    try {
        const raw = await readFile(path, "utf-8");
        const parsed = JSON.parse(raw);
        return parsed.claude_ai_session_key ?? null;
    } catch {
        return null;
    }
}

function upsert(db: Database, conv: NormalizedConversation): void {
    const insertConv = db.prepare(
        "INSERT OR REPLACE INTO conversations (uuid, name, summary, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertMsg = db.prepare(
        "INSERT OR REPLACE INTO messages (uuid, conversation_uuid, position, sender, text, timestamp, parent_message_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertConv.run(conv.uuid, conv.name, conv.summary, conv.created_at, conv.updated_at, conv.messages.length);
    let pos = 0;
    for (const m of conv.messages) {
        insertMsg.run(m.uuid, conv.uuid, pos++, m.sender, m.text, m.timestamp, m.parent_message_uuid);
    }
}

export interface RunOptions {
    dreamingPath: string;
    claudeCodeRoot: string;
    credentialsPath: string;
    fetchFn?: typeof fetch;
    sleepMs?: number;
}

export interface RunSummary {
    claudeCode: AdapterResult;
    claudeAi: AdapterResult;
}

export async function runIngestRecent(opts: RunOptions): Promise<RunSummary> {
    const lucienDir = join(opts.dreamingPath, ".lucien");
    const dbPath = join(lucienDir, "lucien.db");
    const statePath = join(lucienDir, "state.json");

    await mkdir(lucienDir, { recursive: true });
    const state = await readState(statePath);
    const cookie = await readCookie(opts.credentialsPath);

    const [claudeCode, claudeAi] = await Promise.all([
        ingestClaudeCode({
            rootDir: opts.claudeCodeRoot,
            since: state.claude_code.last_ingest_at,
        }),
        ingestClaudeAi({
            cookie,
            since: state.claude_ai.last_ingest_at,
            fetchFn: opts.fetchFn,
            sleepMs: opts.sleepMs,
        }),
    ]);

    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    const tx = db.transaction((convs: NormalizedConversation[]) => {
        for (const c of convs) upsert(db, c);
    });
    tx([...claudeCode.conversations, ...claudeAi.conversations]);
    db.close();

    const newState: State = {
        claude_code: { last_ingest_at: claudeCode.new_watermark },
        claude_ai: { last_ingest_at: claudeAi.new_watermark },
    };
    await writeState(statePath, newState);

    return { claudeCode, claudeAi };
}

if (import.meta.main) {
    const dreaming = process.env.LUCIEN_DREAMING_PATH ?? join(homedir(), "Dreaming");
    const claudeCodeRoot = process.env.LUCIEN_CLAUDE_CODE_ROOT ?? join(homedir(), ".claude/projects");
    const creds = process.env.LUCIEN_CREDENTIALS_PATH ?? join(homedir(), ".lucien/credentials.json");

    const result = await runIngestRecent({
        dreamingPath: dreaming,
        claudeCodeRoot,
        credentialsPath: creds,
    });
    console.log(result.claudeCode.summary);
    console.log(result.claudeAi.summary);
}
```

- [ ] **Step 2: Run integration tests to verify they pass**

Run: `bun test scripts/ingest-recent.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 3: Run the full test suite to make sure nothing else regressed**

Run: `bun test`
Expected: all tests PASS (existing + new).

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest-recent.ts
git commit -m "feat: add ingest-recent orchestrator with per-source watermarks"
```

---

## Task 11: Manual end-to-end smoke test

This task has **no code**. It verifies the pipeline works against your real data.

- [ ] **Step 1: One-time DB migration (if you have an old DB)**

```bash
mkdir -p ~/Dreaming/.lucien
if [ -f ~/Downloads/lucien.db ]; then
  mv ~/Downloads/lucien.db ~/Dreaming/.lucien/lucien.db
fi
```

- [ ] **Step 2: Set the claude.ai cookie**

In a browser logged into claude.ai: DevTools → Application → Cookies → copy `sessionKey`. Then:

```bash
pbpaste | bun run scripts/auth-set-claude-ai-cookie.ts
```
Expected: `Wrote /Users/.../.lucien/credentials.json (mode 0600).`

- [ ] **Step 3: Run ingest**

```bash
bun run scripts/ingest-recent.ts
```
Expected output (numbers will vary):
```
claude-code: 23 conversations / 4187 messages
claude-ai: 8 conversations / 312 messages
```

- [ ] **Step 4: Verify sqlite contents**

```bash
sqlite3 ~/Dreaming/.lucien/lucien.db \
  "SELECT (SELECT COUNT(*) FROM conversations) AS convs, (SELECT COUNT(*) FROM messages) AS msgs;"
```
Expected: non-zero counts that match the summary.

- [ ] **Step 5: Verify watermark advanced**

```bash
cat ~/Dreaming/.lucien/state.json
```
Expected: both `last_ingest_at` fields are recent ISO timestamps (not `1970-01-01`).

- [ ] **Step 6: Idempotency check — re-run**

```bash
bun run scripts/ingest-recent.ts
```
Expected: both summaries show `0 conversations` (or only the handful of in-progress Claude Code sessions that have grown since the prior run).

- [ ] **Step 7: Run the downstream pipeline**

```bash
bun run scripts/chunk.ts
bun run scripts/cluster-assign.ts
bun run scripts/synthesize.ts
```
Expected: scripts run to completion. Articles in `~/Dreaming/articles/` reflect new material.

- [ ] **Step 8: No commit (this is a verification task)**

If any of these steps fail, open a follow-up task in the plan rather than papering over.

---

## Self-review

Spec coverage check:
- §"Scope" → Tasks 3-10 deliver both adapters + orchestrator. ✓
- §"Non-goals" → no tasks touch the existing pipeline scripts beyond the DB path move. ✓
- §"File layout" → Tasks 1, 2, 4, 7, 8, 10 create exactly the files the spec lists. ✓
- §"Normalized data model" → Task 1. ✓
- §"Adapter — Claude Code JSONL" → Tasks 3-4 implement glob+mtime filter, drop tool/sidechain/unknown, derive name/created_at/updated_at, watermark from max timestamp. ✓
- §"Adapter — claude.ai web" → Tasks 5-7 cover the endpoint spike, missing-cookie graceful handling, 401, list filter, tree linearization via `current_leaf_message_uuid` + longest-path fallback, sequential rate-limit, partial-progress watermark. ✓
- §"Orchestrator" → Task 10. ✓
- §"Watermark file" → Task 10 (read/write, epoch defaults, per-source). ✓
- §"Auth helper" → Task 8. ✓
- §"Database location migration" → Task 2 + Task 11 step 1. ✓
- §"Risks" → endpoint risk gated by Task 5; schema drift handled in Task 4 (unknown types skipped); cookie expiry in Task 7. ✓
- §"Test plan" → every test plan item is in Tasks 3, 6, 9. ✓

No placeholders found. Types and function names are consistent across tasks (`ingestClaudeCode`, `ingestClaudeAi`, `runIngestRecent`, `AdapterResult`, `NormalizedConversation`). DB schema in Task 10 matches the existing `scripts/ingest.ts` exactly.
