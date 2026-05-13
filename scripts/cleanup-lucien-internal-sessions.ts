/**
 * One-off cleanup script: removes conversations ingested before the sentinel landed
 * that were actually Lucien's own orchestration sessions (chunk, cluster-assign,
 * synthesize prompts). Idempotent on subsequent runs — finds zero matches when DB
 * is already clean.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "./state-path.js";

// These are the known prompt openers for Lucien's internal sessions that were
// ingested before the sentinel existed. We match against position=0 user messages.
const POLLUTED_PROMPT_PREFIXES = [
    "You are analyzing one conversation between a user and an AI assistant",
    "You will analyze ONE conversation between a user and an AI assistant",
    "You will assign topic labels to buckets",
    "You are organizing chunks of conversation into a personal wiki",
    "You are a Wikipedia editor maintaining a personal wiki",
];

async function main() {
    console.log(`Opening database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // Find all conversation UUIDs whose first message (position=0) is a user
    // message starting with one of the known polluted prompt prefixes.
    const pollutedUuids: string[] = [];

    for (const prefix of POLLUTED_PROMPT_PREFIXES) {
        const rows = db
            .query(
                `SELECT m.conversation_uuid
                 FROM messages m
                 WHERE m.position = 0
                   AND m.sender = 'user'
                   AND m.text LIKE ?`
            )
            .all(prefix + "%") as { conversation_uuid: string }[];

        for (const row of rows) {
            if (!pollutedUuids.includes(row.conversation_uuid)) {
                pollutedUuids.push(row.conversation_uuid);
            }
        }
    }

    console.log(`Found ${pollutedUuids.length} polluted conversation(s) to remove.`);

    if (pollutedUuids.length === 0) {
        console.log("Database is clean. Nothing to do.");
        return;
    }

    let totalMessages = 0;
    let totalChunks = 0;

    // Count what we're about to delete for the summary.
    for (const uuid of pollutedUuids) {
        const msgCount = (
            db.query("SELECT COUNT(*) as n FROM messages WHERE conversation_uuid = ?").get(uuid) as { n: number }
        ).n;
        const chunkCount = (
            db.query("SELECT COUNT(*) as n FROM chunks WHERE conversation_uuid = ?").get(uuid) as { n: number }
        ).n;
        totalMessages += msgCount;
        totalChunks += chunkCount;
    }

    console.log(`  Messages to delete: ${totalMessages}`);
    console.log(`  Chunks to delete:   ${totalChunks}`);
    console.log(`  Conversations to delete: ${pollutedUuids.length}`);
    console.log(`Deleting...`);

    // Wrap all deletes in a single transaction.
    db.transaction(() => {
        for (const uuid of pollutedUuids) {
            db.run("DELETE FROM chunks WHERE conversation_uuid = ?", [uuid]);
            db.run("DELETE FROM chunked_conversations WHERE conversation_uuid = ?", [uuid]);
            db.run("DELETE FROM messages WHERE conversation_uuid = ?", [uuid]);
            db.run("DELETE FROM conversations WHERE uuid = ?", [uuid]);
        }
    })();

    console.log(`\nDone.`);
    console.log(`  Conversations deleted: ${pollutedUuids.length}`);
    console.log(`  Messages deleted:      ${totalMessages}`);
    console.log(`  Chunks deleted:        ${totalChunks}`);
}

await main();
