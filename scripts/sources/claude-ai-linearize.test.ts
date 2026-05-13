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
