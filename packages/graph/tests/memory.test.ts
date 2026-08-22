import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  applyPropertyPatch,
  diffSnapshots,
  InMemoryGraphStore,
  selectHistory,
  trimHistory,
  type GraphSnapshot,
} from "../src/index.ts";

const SCOPE = { workspaceId: "w1", schemaId: "test" };

const schema = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
  Person:
    properties:
      name:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
`);

describe("InMemoryGraphStore", () => {
  it("upserts, queries, and deletes", async () => {
    const store = new InMemoryGraphStore();
    await store.applySchema(SCOPE, schema);
    await store.apply(SCOPE, {
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Ship" },
      meta: { createdBy: "ada" },
    });
    await store.apply(SCOPE, {
      kind: "upsertNode",
      id: "p1",
      type: "Person",
      properties: { name: "Ada" },
      meta: {},
    });
    await store.apply(SCOPE, {
      kind: "upsertEdge",
      id: "e1",
      type: "ASSIGNED_TO",
      from: "t1",
      to: "p1",
      properties: {},
      meta: {},
    });

    const tasks = await store.query(SCOPE, "MATCH (n:Task) RETURN n");
    expect(tasks.rows).toHaveLength(1);
    expect((tasks.rows[0]?.n as { properties: { title: string } }).properties.title).toBe("Ship");

    const assigned = await store.query(SCOPE, 
      "MATCH (a:Task)-[r:ASSIGNED_TO]->(b:Person) RETURN a, r, b",
    );
    expect(assigned.rows).toHaveLength(1);

    await store.apply(SCOPE, { kind: "deleteNode", id: "t1" });
    expect(store.getNode(SCOPE, "t1")).toBeUndefined();
    expect(store.getEdge(SCOPE, "e1")).toBeUndefined();
    await store.close();
  });
});

describe("diffSnapshots", () => {
  it("emits upserts and deletes", () => {
    const previous: GraphSnapshot = {
      schemaId: "task-board",
      schemaHash: "abc",
      nodes: [{ id: "t1", type: "Task", properties: { title: "Old" }, meta: {} }],
      edges: [],
    };
    const next: GraphSnapshot = {
      schemaId: "task-board",
      schemaHash: "abc",
      nodes: [{ id: "t2", type: "Task", properties: { title: "New" }, meta: {} }],
      edges: [
        {
          id: "e1",
          type: "ASSIGNED_TO",
          from: "t2",
          to: "p1",
          properties: {},
          meta: {},
        },
      ],
    };
    const ops = diffSnapshots(previous, next);
    expect(ops.map((op) => op.kind).sort()).toEqual(["deleteNode", "upsertEdge", "upsertNode"]);
  });
});

describe("applyPropertyPatch", () => {
  it("writes only patched keys so concurrent edits commute", () => {
    const base = { title: "Checkout", complexity: 2 };
    const afterTitle = applyPropertyPatch(base, { title: "Ada title" }, ["title"]);
    const afterBoth = applyPropertyPatch(afterTitle, { complexity: 4 }, ["complexity"]);
    expect(afterBoth).toEqual({ title: "Ada title", complexity: 4 });
  });
});

describe("selectHistory", () => {
  it("filters by id and actor then sorts by at/opId", () => {
    const entries = selectHistory(
      [
        {
          opId: "b",
          op: "upsertNode",
          id: "n1",
          actorId: "ada",
          at: "2026-01-01T00:00:02.000Z",
        },
        {
          opId: "a",
          op: "upsertNode",
          id: "n1",
          actorId: "chidi",
          at: "2026-01-01T00:00:01.000Z",
        },
        {
          opId: "c",
          op: "upsertNode",
          id: "n2",
          actorId: "ada",
          at: "2026-01-01T00:00:03.000Z",
        },
      ],
      { id: "n1" },
    );
    expect(entries.map((entry) => entry.opId)).toEqual(["a", "b"]);
  });
});

describe("trimHistory", () => {
  it("drops oldest by at then opId, not insert order", () => {
    const kept = trimHistory(
      [
        { opId: "late-insert", op: "upsertNode", id: "n1", actorId: "ada", at: "2026-01-01T00:00:01.000Z" },
        { opId: "early-clock", op: "upsertNode", id: "n2", actorId: "chidi", at: "2026-01-01T00:00:00.000Z" },
        { opId: "newest", op: "upsertNode", id: "n3", actorId: "ada", at: "2026-01-01T00:00:02.000Z" },
      ],
      2,
    );
    expect(kept.map((entry) => entry.opId)).toEqual(["late-insert", "newest"]);
  });
});
