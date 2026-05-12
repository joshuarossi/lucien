import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const EXPORT_PATH = join(
    homedir(),
    "Downloads/data-e4d5cee8-64de-4767-b8f4-3d3011367edb-1778546131-bdee5b91-batch-0000/conversations.json"
);
const DB_PATH = join(homedir(), "Downloads/lucien.db");

interface Message {
    uuid: string;
    text: string;
    sender: string;
    created_at: string;
    parent_message_uuid: string;
}

interface Conversation {
    uuid: string;
    name: string;
    summary: string;
    created_at: string;
    updated_at: string;
    chat_messages: Message[];
}

async function main() {
    console.log(`Reading ${EXPORT_PATH}...`);
    const raw = await readFile(EXPORT_PATH, "utf-8");
    const data: Conversation[] = JSON.parse(raw);
    console.log(`Loaded ${data.length} conversations`);

    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Schema
    db.exec(`
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
    
    CREATE INDEX IF NOT EXISTS idx_msg_conv_position 
      ON messages(conversation_uuid, position);
    
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_uuid TEXT NOT NULL,
      start_message_uuid TEXT NOT NULL,
      end_message_uuid TEXT NOT NULL,
      label TEXT NOT NULL,
      FOREIGN KEY (conversation_uuid) REFERENCES conversations(uuid)
    );
    
    CREATE INDEX IF NOT EXISTS idx_chunk_conv ON chunks(conversation_uuid);
    
    CREATE TABLE IF NOT EXISTS buckets (
      name TEXT PRIMARY KEY,
      description TEXT
    );
    
    CREATE TABLE IF NOT EXISTS chunk_buckets (
      chunk_id INTEGER NOT NULL,
      bucket_name TEXT NOT NULL,
      PRIMARY KEY (chunk_id, bucket_name),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id),
      FOREIGN KEY (bucket_name) REFERENCES buckets(name)
    );
    
    CREATE INDEX IF NOT EXISTS idx_chunk_buckets_bucket 
      ON chunk_buckets(bucket_name);
  `);

    console.log("Schema ready. Inserting data...");

    const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations 
    (uuid, name, summary, created_at, updated_at, message_count) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);

    const insertMsg = db.prepare(`
    INSERT OR REPLACE INTO messages 
    (uuid, conversation_uuid, position, sender, text, timestamp, parent_message_uuid) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

    const insertAll = db.transaction((convs: Conversation[]) => {
        for (const conv of convs) {
            insertConv.run(
                conv.uuid,
                conv.name ?? "",
                conv.summary ?? "",
                conv.created_at,
                conv.updated_at,
                conv.chat_messages.length
            );
            let position = 0;
            for (const msg of conv.chat_messages) {
                insertMsg.run(
                    msg.uuid,
                    conv.uuid,
                    position++,
                    msg.sender,
                    msg.text ?? "",
                    msg.created_at,
                    msg.parent_message_uuid
                );
            }
        }
    });

    insertAll(data);

    const convCount = db.query("SELECT COUNT(*) as n FROM conversations").get() as { n: number };
    const msgCount = db.query("SELECT COUNT(*) as n FROM messages").get() as { n: number };

    console.log(`\nDone.`);
    console.log(`  Conversations: ${convCount.n}`);
    console.log(`  Messages: ${msgCount.n}`);
    console.log(`  Database: ${DB_PATH}`);
}

await main();