import { test, expect } from "bun:test";
import {
    linearizeConversation,
    toNormalized,
    type ExportConversation,
} from "./import-openai-export.ts";

/** A small export-shaped conversation: a tree with one abandoned branch. */
function sampleConversation(): ExportConversation {
    return {
        id: "conv-1",
        title: "Camera panning",
        create_time: 1700000000,
        update_time: 1700000100,
        current_node: "leaf",
        mapping: {
            root: { id: "root", message: null, parent: null },
            sys: {
                id: "sys",
                parent: "root",
                message: { id: "sys", author: { role: "system" }, content: { parts: [""] } },
            },
            u1: {
                id: "u1",
                parent: "sys",
                message: {
                    id: "u1",
                    author: { role: "user" },
                    content: { parts: ["How do I pan a camera smoothly?"] },
                    create_time: 1700000010,
                },
            },
            // abandoned retry branch off u1 — not on the current_node path
            a_dead: {
                id: "a_dead",
                parent: "u1",
                message: {
                    id: "a_dead",
                    author: { role: "assistant" },
                    content: { parts: ["(discarded answer)"] },
                },
            },
            leaf: {
                id: "leaf",
                parent: "u1",
                message: {
                    id: "leaf",
                    author: { role: "assistant" },
                    content: { parts: ["Use a fluid head and move from the hips."] },
                    create_time: 1700000020,
                },
            },
        },
    };
}

test("linearizeConversation walks current_node→root, skips system, prunes dead branches", () => {
    const msgs = linearizeConversation(sampleConversation());
    expect(msgs.map((m) => m.uuid)).toEqual(["u1", "leaf"]); // sys dropped, a_dead pruned
    expect(msgs[0]!.sender).toBe("user");
    expect(msgs[1]!.sender).toBe("assistant");
    expect(msgs[1]!.text).toContain("fluid head");
    expect(msgs[1]!.parent_message_uuid).toBe("u1");
    expect(msgs.some((m) => m.text.includes("discarded"))).toBe(false);
});

test("toNormalized maps fields and stamps source=chatgpt", () => {
    const c = toNormalized(sampleConversation())!;
    expect(c.source).toBe("chatgpt");
    expect(c.uuid).toBe("conv-1");
    expect(c.name).toBe("Camera panning");
    expect(c.created_at).toBe(new Date(1700000000 * 1000).toISOString());
    expect(c.messages.length).toBe(2);
});

test("toNormalized returns null for a conversation with no real turns", () => {
    const c: ExportConversation = {
        id: "empty-1",
        current_node: "x",
        mapping: {
            root: { id: "root", message: null, parent: null },
            x: {
                id: "x",
                parent: "root",
                message: { id: "x", author: { role: "system" }, content: { parts: ["sys"] } },
            },
        },
    };
    expect(toNormalized(c)).toBeNull();
});

test("toNormalized falls back to 'Untitled' when title is empty", () => {
    const c = sampleConversation();
    c.title = "";
    expect(toNormalized(c)!.name).toBe("Untitled");
});

test("linearizeConversation drops non-string content parts (images etc.)", () => {
    const c: ExportConversation = {
        id: "mm-1",
        current_node: "u",
        mapping: {
            root: { id: "root", message: null, parent: null },
            u: {
                id: "u",
                parent: "root",
                message: {
                    id: "u",
                    author: { role: "user" },
                    content: { content_type: "multimodal_text", parts: [{ asset_pointer: "x" } as unknown as string, "describe this"] },
                },
            },
        },
    };
    const msgs = linearizeConversation(c);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe("describe this");
});
