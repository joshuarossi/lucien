import { test, expect, describe } from "bun:test";
import {
    validateChunks,
    ChunkValidationError,
    type ChunkMessage,
    type RawChunk,
} from "./chunk-validation.js";

const CONV_UUID = "fcfb15ff-51b4-488b-a765-cb9afbedbe44";

// Realistic uuidv7-style ids: shared timestamp prefix, distinct tails — the
// adversarial case for prefix matching.
const messages: ChunkMessage[] = [
    { uuid: "019ea48a-aaaa-7e57-8000-000000000001" },
    { uuid: "019ea48a-bbbb-7e57-8000-000000000002" },
    { uuid: "019ea48a-db3c-7e57-8000-000000000003" },
    { uuid: "019ea48b-cccc-7e57-8000-000000000004" },
    { uuid: "019ea48b-dddd-7e57-8000-000000000005" },
];

function chunk(start: string, end: string, label = "test chunk"): RawChunk {
    return { start_message_uuid: start, end_message_uuid: end, label };
}

describe("validateChunks", () => {
    test("valid anchors pass through unchanged with no repairs", () => {
        const raw = [
            chunk(messages[0].uuid, messages[2].uuid, "first topic"),
            chunk(messages[3].uuid, messages[4].uuid, "second topic"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks).toEqual(raw);
        expect(repairs).toEqual([]);
    });

    test("conversation uuid as start anchor snaps to first message", () => {
        // Observed twice on 2026-06-10: model pasted the conversation uuid
        // where message 0's uuid belonged.
        const raw = [
            chunk(CONV_UUID, messages[2].uuid, "concept"),
            chunk(messages[3].uuid, messages[4].uuid, "build"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[0].start_message_uuid).toBe(messages[0].uuid);
        expect(repairs).toHaveLength(1);
        expect(repairs[0]).toContain("conversation uuid");
    });

    test("conversation uuid as end anchor snaps to last message", () => {
        const raw = [chunk(messages[0].uuid, CONV_UUID)];
        const { chunks } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[0].end_message_uuid).toBe(messages[4].uuid);
    });

    test("chimera splice resolves via unique long-prefix match", () => {
        // Observed on 2026-06-10: end uuid was message 2's prefix fused with
        // message 1's suffix. The 13-char shared prefix with message 2 is
        // unique and above threshold.
        const chimera = "019ea48a-db3c-7e57-8000-000000000002";
        const raw = [
            chunk(messages[0].uuid, chimera, "diagnosis"),
            chunk(messages[3].uuid, messages[4].uuid, "follow-up"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[0].end_message_uuid).toBe(messages[2].uuid);
        expect(repairs[0]).toContain("prefix-matched");
    });

    test("anchor below prefix threshold fails the conversation", () => {
        // "019ea48a-" alone is shared by three messages — ambiguous, and any
        // resolution would be a guess. The conversation must fail and retry.
        const junk = "019ea48a-ffff-0000-0000-000000000000";
        const raw = [chunk(messages[0].uuid, junk)];
        expect(() => validateChunks(raw, messages, CONV_UUID)).toThrow(
            ChunkValidationError
        );
    });

    test("fully foreign anchor fails the conversation", () => {
        const raw = [chunk("deadbeef-0000-0000-0000-000000000000", messages[1].uuid)];
        expect(() => validateChunks(raw, messages, CONV_UUID)).toThrow(
            ChunkValidationError
        );
    });

    test("inverted range is swapped", () => {
        const raw = [
            chunk(messages[3].uuid, messages[1].uuid, "backwards"),
            chunk(messages[3].uuid, messages[4].uuid, "tail"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[0].start_message_uuid).toBe(messages[1].uuid);
        expect(chunks[0].end_message_uuid).toBe(messages[3].uuid);
        expect(repairs.some((r) => r.includes("inverted"))).toBe(true);
    });

    test("trailing gap extends the latest-ending chunk to the last message", () => {
        // Observed on 2026-06-10: final substantive exchange left uncovered.
        const raw = [
            chunk(messages[0].uuid, messages[1].uuid, "early"),
            chunk(messages[2].uuid, messages[3].uuid, "late"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[1].end_message_uuid).toBe(messages[4].uuid);
        expect(chunks[0].end_message_uuid).toBe(messages[1].uuid);
        expect(repairs.some((r) => r.includes("trailing gap"))).toBe(true);
    });

    test("interior gaps are left alone", () => {
        const raw = [
            chunk(messages[0].uuid, messages[0].uuid, "head"),
            chunk(messages[4].uuid, messages[4].uuid, "tail"),
        ];
        const { chunks, repairs } = validateChunks(raw, messages, CONV_UUID);
        expect(chunks[0].end_message_uuid).toBe(messages[0].uuid);
        expect(repairs).toEqual([]);
    });

    test("empty chunk list is respected (no chunks invented)", () => {
        const { chunks, repairs } = validateChunks([], messages, CONV_UUID);
        expect(chunks).toEqual([]);
        expect(repairs).toEqual([]);
    });

    test("empty message list yields no chunks", () => {
        const raw = [chunk(messages[0].uuid, messages[1].uuid)];
        const { chunks } = validateChunks(raw, [], CONV_UUID);
        expect(chunks).toEqual([]);
    });
});
