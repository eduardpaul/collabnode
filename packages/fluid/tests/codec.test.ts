import { describe, expect, it } from "vitest";
import {
  decodeHistoryEntry,
  decodeMeta,
  decodePropertyMap,
  decodeTags,
  encodeHistoryEntry,
  encodeMeta,
  encodePropertyEntries,
  encodeTags,
} from "../src/codec.ts";

describe("codec", () => {
  it("round-trips per-key properties, tags, and meta", () => {
    const properties = { title: "Ship", estimate: 3, done: false, note: null };
    const meta = { updatedBy: "ada", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(decodePropertyMap(encodePropertyEntries(properties))).toEqual(properties);
    expect(decodeTags(encodeTags(["rfp", "Q3"]))).toEqual(["rfp", "Q3"]);
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
  });

  it("round-trips a history entry", () => {
    const entry = {
      opId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      op: "upsertNode" as const,
      id: "n1",
      type: "Feature",
      actorId: "ada",
      at: "2026-01-01T00:00:00.000Z",
      fields: ["complexity"],
      changes: [{ field: "complexity", before: 2, after: 4 }],
      summary: "Checkout",
    };
    expect(decodeHistoryEntry(encodeHistoryEntry(entry))).toEqual(entry);
  });
});
