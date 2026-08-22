import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HocuspocusCollaborativeGraph } from "../src/graph.ts";
import { initializeIfNeeded } from "../src/ydoc.ts";

const schema = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
  changeTracking:
    enabled: true
    mode: history
  tags:
    enabled: true
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
      estimate:
        type: number
`);

function graphOf(): HocuspocusCollaborativeGraph {
  const doc = new Y.Doc();
  initializeIfNeeded(doc, schema);
  return new HocuspocusCollaborativeGraph(doc, schema);
}

describe("HocuspocusCollaborativeGraph", () => {
  it("patches per-key properties, stores tags, and records history", () => {
    const graph = graphOf();
    graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Ship", estimate: 2 },
      tags: ["RFP"],
      meta: {},
      history: {
        opId: "01a",
        op: "upsertNode",
        id: "t1",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:00.000Z",
        created: true,
        fields: ["title", "estimate"],
        changes: [
          { field: "title", before: null, after: "Ship" },
          { field: "estimate", before: null, after: 2 },
        ],
      },
    });
    graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Shipped" },
      patch: ["title"],
      meta: {},
      history: {
        opId: "01b",
        op: "upsertNode",
        id: "t1",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:01.000Z",
        created: false,
        fields: ["title"],
        changes: [{ field: "title", before: "Ship", after: "Shipped" }],
      },
    });
    const node = graph.snapshot().nodes[0];
    expect(node?.properties).toEqual({ title: "Shipped", estimate: 2 });
    expect(node?.tags).toEqual(["RFP"]);
    expect(graph.history()).toHaveLength(2);
    expect(graph.history({ id: "t1" }).at(-1)?.changes).toEqual([
      { field: "title", before: "Ship", after: "Shipped" },
    ]);
  });
});
