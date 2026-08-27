import { describe, expect, it } from "vitest";
import { emptyMeta, walk, type GraphSnapshot } from "../src/index.ts";

function snap(): GraphSnapshot {
  return {
    schemaId: "s",
    schemaHash: "h",
    nodes: [
      { id: "epic", type: "Epic", properties: { title: "E" }, meta: emptyMeta() },
      { id: "feat", type: "Feature", properties: { title: "F" }, meta: emptyMeta() },
      { id: "task", type: "Task", properties: { title: "T" }, meta: emptyMeta() },
      { id: "risk", type: "Risk", properties: { title: "R" }, meta: emptyMeta() },
    ],
    edges: [
      { id: "e1", type: "HAS_FEATURE", from: "epic", to: "feat", properties: {}, meta: emptyMeta() },
      { id: "e2", type: "HAS_TASK", from: "feat", to: "task", properties: {}, meta: emptyMeta() },
      { id: "e3", type: "HAS_RISK", from: "epic", to: "risk", properties: {}, meta: emptyMeta() },
    ],
  };
}

describe("walk", () => {
  it("follows outbound edges to unbounded depth", () => {
    const result = walk(snap(), "epic", { direction: "out" });
    expect(result.hops.map((h) => h.node.id).sort()).toEqual(["feat", "risk", "task"]);
    expect(result.hops.find((h) => h.node.id === "task")?.depth).toBe(2);
    expect(result.truncated).toBeUndefined();
  });

  it("restricts edge types and inbound parent lookup", () => {
    const down = walk(snap(), "epic", {
      edgeTypes: ["HAS_FEATURE", "HAS_TASK"],
      direction: "out",
    });
    expect(down.hops.map((h) => h.node.id).sort()).toEqual(["feat", "task"]);

    const parent = walk(snap(), "feat", { edgeTypes: ["HAS_FEATURE"], direction: "in", depth: 1 });
    expect(parent.hops).toHaveLength(1);
    expect(parent.hops[0]?.node.id).toBe("epic");
  });

  it("returns empty hops for a missing start id", () => {
    expect(walk(snap(), "missing").hops).toEqual([]);
  });

  it("honors limit and marks truncated", () => {
    const result = walk(snap(), "epic", { direction: "out", limit: 1 });
    expect(result.hops).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
