/**
 * Marker prepended to every prompt Lucien shells out to `claude -p`.
 * The Claude Code source adapter (sources/claude-code.ts) skips any
 * session whose first user message starts with this string, preventing
 * the nightly pipeline from cannibalizing its own orchestration calls.
 *
 * Treat as a stable wire format: scripts produce it, the adapter consumes it.
 * If you change the value, you also need to update the adapter and clean
 * any sessions in the wild that still use the old marker.
 */
export const LUCIEN_PROMPT_SENTINEL = "<<LUCIEN_INTERNAL>> ";

/**
 * Historic prompt prefixes for Lucien-orchestration sessions that pre-date
 * the sentinel. Sessions whose first user message begins with any of these
 * strings were created by chunk.ts / chunk-recent.ts / cluster-assign*.ts /
 * synthesize*.ts before the sentinel was added. The Claude Code source
 * adapter checks against this list in addition to the sentinel so historic
 * sessions stay filtered out forever.
 *
 * Add new entries if a Lucien prompt's opening line changes.
 */
export const LUCIEN_HISTORIC_PROMPT_PREFIXES = [
    "You are analyzing one conversation between a user and an AI assistant",
    "You will analyze ONE conversation between a user and an AI assistant",
    "You will assign topic labels to buckets",
    "You are organizing chunks of conversation into a personal wiki",
    "You are a Wikipedia editor maintaining a personal wiki",
    // Citation-format spec example used while iterating on synthesize prompts;
    // leaked in as a fake "tea and coffee preferences" article.
    "Short Dreaming article only.",
];

export function isLucienInternalPrompt(firstUserText: string): boolean {
    if (firstUserText.startsWith(LUCIEN_PROMPT_SENTINEL)) return true;
    for (const prefix of LUCIEN_HISTORIC_PROMPT_PREFIXES) {
        if (firstUserText.startsWith(prefix)) return true;
    }
    return false;
}
