import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ingestClaudeCode } from "./sources/claude-code.js";
import { ingestClaudeAi } from "./sources/claude-ai.js";
import type { AdapterResult, NormalizedConversation } from "./sources/types.js";
import { LUCIEN_STATE_DIR } from "./state-path.js";

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
    claudeCodeRoot: string;
    stateDir?: string;          // defaults to LUCIEN_STATE_DIR
    claudeAiContext?: import("playwright").BrowserContext;
    sleepMs?: number;
}

export interface RunSummary {
    claudeCode: AdapterResult;
    claudeAi: AdapterResult;
}

export async function runIngestRecent(opts: RunOptions): Promise<RunSummary> {
    const stateDir = opts.stateDir ?? LUCIEN_STATE_DIR;
    const dbPath = join(stateDir, "lucien.db");
    const statePath = join(stateDir, "state.json");

    await mkdir(stateDir, { recursive: true });
    const state = await readState(statePath);

    // Open the DB up front so adapters can probe it for already-cached items.
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    const cacheLookup = db.prepare(
        "SELECT updated_at FROM conversations WHERE uuid = ?"
    );
    const isAlreadyIngested = (uuid: string, updated_at: string): boolean => {
        const row = cacheLookup.get(uuid) as { updated_at?: string } | undefined;
        if (!row?.updated_at) return false;
        return new Date(row.updated_at).toISOString() ===
            new Date(updated_at).toISOString();
    };

    const [claudeCode, claudeAi] = await Promise.all([
        ingestClaudeCode({
            rootDir: opts.claudeCodeRoot,
            since: state.claude_code.last_ingest_at,
        }),
        ingestClaudeAi({
            context: opts.claudeAiContext,
            since: state.claude_ai.last_ingest_at,
            sleepMs: opts.sleepMs,
            isAlreadyIngested,
        }),
    ]);

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
    const claudeCodeRoot =
        process.env.LUCIEN_CLAUDE_CODE_ROOT ?? join(homedir(), ".claude/projects");

    const result = await runIngestRecent({
        claudeCodeRoot,
    });
    console.log(result.claudeCode.summary);
    console.log(result.claudeAi.summary);
}
