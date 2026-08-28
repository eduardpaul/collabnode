import { describe, expect, it } from "vitest";
import type { GraphPlan } from "@collabnode/mcp";
import { applyPlan } from "../src/index.js";
import { createTestSession } from "./workspace.js";

describe("applyPlan", () => {
  it("costs one edge, not the batch, when transform drops an endpoint", async () => {
    const session = await createTestSession();
    const plan = {
      nodes: [
        { ref: "g1", type: "Goal", properties: { title: "Ship it" } },
        { ref: "t1", type: "Task", properties: { title: "reject me" } },
      ],
      edges: [{ type: "HAS_TASK", from: "g1", to: "t1" }],
    } as unknown as GraphPlan;

    const result = await applyPlan(session, plan, {
      transform: (_node, properties) => (properties.title === "reject me" ? undefined : properties),
    });

    expect(result.created).toBe(1);
    expect(result.edges).toBe(0);
    expect(result.droppedEdges).toHaveLength(1);
    expect(Object.keys(result.idsByRef)).toEqual(["g1"]);
    expect(session.snapshot().nodes).toHaveLength(1);
  });

  it("keeps an edge between two nodes that both survive", async () => {
    const session = await createTestSession();
    const plan = {
      nodes: [
        { ref: "g1", type: "Goal", properties: { title: "Ship it" } },
        { ref: "t1", type: "Task", properties: { title: "Write it" } },
      ],
      edges: [{ type: "HAS_TASK", from: "g1", to: "t1" }],
    } as unknown as GraphPlan;

    const result = await applyPlan(session, plan);

    expect(result.created).toBe(2);
    expect(result.edges).toBe(1);
    expect(result.droppedEdges).toEqual([]);
    expect(session.snapshot().edges).toHaveLength(1);
  });

  it("writes one node per ref when the plan repeats one", async () => {
    const session = await createTestSession();
    const plan = {
      nodes: [
        { ref: "g1", type: "Goal", properties: { title: "first" } },
        { ref: "g1", type: "Goal", properties: { title: "second" } },
      ],
      edges: [],
    } as unknown as GraphPlan;

    const result = await applyPlan(session, plan);

    expect(result.created).toBe(1);
    const nodes = session.snapshot().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.title).toBe("first");
    expect(result.idsByRef.g1).toBe(nodes[0]?.id);
  });
});
