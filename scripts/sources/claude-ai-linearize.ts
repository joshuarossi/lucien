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
