---
description: Lucien MCP server — personal wiki (the Dreaming). Use Bun for this TypeScript project.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Lucien (this repository)

**Lucien** (`lucien-mcp`) is an MCP server that exposes **the Dreaming**: the user’s personal wiki as markdown on disk (default `~/Dreaming`; most tools accept `dreaming_path` to override). The server is **stdio-only** — it is not a long-lived HTTP app in this repo.

- **`src/index.ts`** — MCP server, tool registration, stdio transport.
- **`src/tools/`** — wiki operations (`articles.ts`, `setup.ts`, co-located `*.test.ts`).
- **`scripts/`** — synthesis pipeline scripts (separate from the MCP process; see `README.md`).

**Commands:** `bun run dev` runs the server from source; `bun run build` emits `dist/` (publish target); `bun test` runs tests.

**On-disk wiki:** `articles/` (stem filenames like `Topic_With_Underscores.md`), `Meta/`, `Talk/`, `.lucien/` for implementation caches. Prefer search/read/link tools for content; call **`lucien_setup`** only when initializing a **new** Dreaming. For tool choice and layout, see `.cursor/skills/lucien/SKILL.md`. For product narrative and architecture, see **`README.md`** and **`docs/`** (e.g. `Lucien-PRD.md`, `lucien-vision.md`).

**Pipeline vocabulary — keep these concepts distinct:**

- **Conversation** — one session talking to an AI provider.
- **Chunk** — a contiguous segment of a conversation focused on one topic; one conversation can produce many chunks as the user changes topics.
- **Bucket** — a staging/grouping area for similar chunks. Buckets are intermediate synthesis inputs, not articles.
- **Article** — the markdown output in the Dreaming: the current synthesized wiki page for an article topic.

Do **not** collapse bucket and article in explanations, code comments, or user-facing logs. Chunks are assigned to buckets; buckets/source chunks then inform whether synthesis updates an existing article or creates a new article. A brand-new topic may create a new bucket first and later create a new article; therefore bucket names must not be treated as inherently dependent on existing article names. During synthesis, logs should be article-centric and mention buckets/chunks as source material/provenance.

**Long-running operations:** do not run long pipeline jobs (nightly, synthesis, bulk imports, editorial passes) in the foreground unless the user explicitly asks. Reuse a persistent tmux session named `lucien-runner` so the user can attach and the agent is not blocked for hours:

```sh
tmux has-session -t lucien-runner 2>/dev/null || \
  tmux new-session -d -s lucien-runner -c /Users/joshrossi/Code/lucien

tmux send-keys -t lucien-runner 'cd /Users/joshrossi/Code/lucien && ./scripts/nightly.sh' C-m
```

Inspect progress with `tmux capture-pane -pt lucien-runner -S -200`; the user can attach with `tmux attach -t lucien-runner`. Use the same session for future long-running Lucien tasks rather than creating one-off sessions.

The sections below are **general Bun defaults** for TypeScript in this codebase (this package does not ship a web UI unless you add one).

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
