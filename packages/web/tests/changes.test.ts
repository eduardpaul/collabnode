import { describe, expect, it } from "vitest";
import { describeHistory, describeLastWrites, describeOps } from "../src/changes.ts";
import type { GraphSnapshot } from "@collabnode/graph";

const empty: GraphSnapshot = {
  schemaId: "web-board",
  schemaHash: "abc",
  nodes: [],
  edges: [],
};

describe("describeOps", () => {
  it("phrases a status move using the previous snapshot", () => {
    const previous: GraphSnapshot = {
      ...empty,
      nodes: [
        {
          id: "t1",
          type: "Task",
          properties: { title: "Review budget", status: "todo" },
          meta: { updatedBy: "chidi", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      ],
    };
    const next: GraphSnapshot = {
      ...empty,
      nodes: [
        {
          id: "t1",
          type: "Task",
          properties: { title: "Review budget", status: "doing" },
          meta: { updatedBy: "ada", updatedAt: "2026-01-01T00:00:01.000Z" },
        },
      ],
    };
    const events = describeOps(
      [
        {
          kind: "upsertNode",
          id: "t1",
          type: "Task",
          properties: { title: "Review budget", status: "doing" },
          meta: { updatedBy: "ada", updatedAt: "2026-01-01T00:00:01.000Z" },
        },
      ],
      next,
      previous,
    );
    expect(events).toEqual([
      {
        id: "upsertNode:t1:2026-01-01T00:00:01.000Z",
        actor: "ada",
        at: "2026-01-01T00:00:01.000Z",
        text: "moved “Review budget” todo → doing",
      },
    ]);
  });

  it("describes a new node as created", () => {
    const events = describeOps(
      [
        {
          kind: "upsertNode",
          id: "t2",
          type: "Task",
          properties: { title: "Write launch checklist", status: "todo" },
          meta: { createdBy: "chidi", createdAt: "t", updatedBy: "chidi", updatedAt: "t" },
        },
      ],
      empty,
      empty,
    );
    expect(events[0]?.actor).toBe("chidi");
    expect(events[0]?.text).toBe("created Task “Write launch checklist”");
  });
});

describe("describeLastWrites", () => {
  it("lists last-write meta newest first", () => {
    const events = describeLastWrites({
      ...empty,
      nodes: [
        {
          id: "a",
          type: "Task",
          properties: { title: "Old" },
          meta: { updatedBy: "server", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
        {
          id: "b",
          type: "Task",
          properties: { title: "New" },
          meta: { updatedBy: "ada", updatedAt: "2026-01-01T00:00:02.000Z" },
        },
      ],
    });
    expect(events.map((event) => event.text)).toEqual([
      "last wrote Task “New”",
      "last wrote Task “Old”",
    ]);
    expect(events[0]?.actor).toBe("ada");
  });
});

describe("describeHistory", () => {
  it("renders a field change as who changed X → Y", () => {
    const events = describeHistory([
      {
        opId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        op: "upsertNode",
        id: "f1",
        type: "Feature",
        actorId: "ada",
        at: "2026-01-01T00:00:01.000Z",
        created: false,
        fields: ["complexity"],
        changes: [{ field: "complexity", before: 2, after: 4 }],
        summary: "Checkout",
      },
    ]);
    expect(events).toEqual([
      {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        actor: "ada",
        at: "2026-01-01T00:00:01.000Z",
        text: "changed complexity 2 → 4 on Feature Checkout",
      },
    ]);
  });

  it("renders first-time field sets as changed, not created", () => {
    const events = describeHistory([
      {
        opId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        op: "upsertNode",
        id: "f1",
        type: "Feature",
        actorId: "ada",
        at: "2026-01-01T00:00:02.000Z",
        created: false,
        fields: ["complexity"],
        changes: [{ field: "complexity", before: null, after: 4 }],
        summary: "Checkout",
      },
    ]);
    expect(events[0]?.text).toBe("changed complexity ∅ → 4 on Feature Checkout");
  });

  it("renders creates from the created flag even when all befores are null", () => {
    const events = describeHistory([
      {
        opId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
        op: "upsertNode",
        id: "f1",
        type: "Feature",
        actorId: "ada",
        at: "2026-01-01T00:00:00.000Z",
        created: true,
        fields: ["title"],
        changes: [{ field: "title", before: null, after: "Checkout" }],
        summary: "Checkout",
      },
    ]);
    expect(events[0]?.text).toBe("created Feature “Checkout”");
  });
});
