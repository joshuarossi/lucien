# Nightly Ingest — Runbook

Spec 1 ships an incremental ingest path that pulls conversations from two sources into a local sqlite database, feeding the existing chunk / cluster-assign / synthesize pipeline.

All Lucien runtime state lives **inside this repo** at `./.lucien/` (gitignored). The Dreaming (`~/Dreaming/`) stays purely your markdown wiki content.

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
   A Chromium window opens at claude.ai. Sign in if needed. The script exits when it detects an authenticated session. The profile is stored at `./.lucien/playwright-profile/`.

3. If you have an existing `~/Downloads/lucien.db` from prior bootstrap runs, move it into place:
   ```bash
   mkdir -p ./.lucien
   mv ~/Downloads/lucien.db ./.lucien/lucien.db
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

All under `./.lucien/` in this repo (gitignored):

| Path | Purpose |
|---|---|
| `./.lucien/lucien.db` | sqlite — conversations, messages, chunks, buckets |
| `./.lucien/state.json` | per-source ingest watermarks |
| `./.lucien/playwright-profile/` | Playwright Chromium profile (cookies, local storage) |
