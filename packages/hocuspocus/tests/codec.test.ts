import { describe, expect, it } from "vitest";
import {
  decodeHistoryEntry,
  decodeMeta,
  decodePropertyMap,
  decodeTags,
  encodeHistoryEntry,
  encodeMeta,
  encodePropertyValue,
  encodeTags,
} from "../src/codec.ts";

describe("codec", () => {
  it("round-trips properties, tags, meta, and history", () => {
    const properties = { title: "Ship", estimate: 3, done: false, note: null };
    const encoded = new Map(
      Object.entries(properties).map(([key, value]) => [key, encodePropertyValue(value)]),
    );
    expect(decodePropertyMap(encoded)).toEqual(properties);
    expect(decodeTags(encodeTags(["RFP", "q3"]))).toEqual(["RFP", "q3"]);
    const meta = { updatedBy: "ada", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
    const entry = {
      opId: "01h",
      op: "upsertNode" as const,
      id: "n1",
      actorId: "ada",
      at: "2026-01-01T00:00:00.000Z",
      created: true,
    };
    expect(decodeHistoryEntry(encodeHistoryEntry(entry))).toEqual(entry);
  });
});
