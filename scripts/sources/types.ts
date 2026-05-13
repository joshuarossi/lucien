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
