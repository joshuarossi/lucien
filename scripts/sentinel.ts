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
