import { parseSchemaDocument } from "@collabnode/schema";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { initializeIfNeeded } from "../src/doc.ts";
import { LoroCollaborativeGraph } from "../src/graph.ts";

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
      notes:
        type: text
      labels:
        type: array
      settings:
        type: map
edges:
  BLOCKS:
    from: [Task]
    to: [Task]
`);

function graphOf(): LoroCollaborativeGraph {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  initializeIfNeeded(doc, schema);
  return new LoroCollaborativeGraph(doc, schema);
}

function upsert(
  graph: LoroCollaborativeGraph,
  id: string,
  properties: Record<string, unknown>,
  extra: { patch?: string[]; tags?: string[]; actorId?: string; opId?: string } = {},
): void {
  graph.apply({
    kind: "upsertNode",
    id,
    type: "Task",
    properties: properties as never,
    ...(extra.patch ? { patch: extra.patch } : {}),
    ...(extra.tags ? { tags: extra.tags } : {}),
    meta: {},
    ...(extra.actorId
      ? {
          history: {
            opId: extra.opId ?? id,
            op: "upsertNode" as const,
            id,
            type: "Task",
            actorId: extra.actorId,
            at: "2026-01-01T00:00:00.000Z",
          },
        }
      : {}),
  });
}

describe("LoroCollaborativeGraph", () => {
  it("round-trips nodes, typed property values, and tags", () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "Ship", estimate: 2 }, { tags: ["RFP"] });

    const snapshot = graph.snapshot();
    expect(snapshot.schemaId).toBe("task-board");
    expect(snapshot.nodes).toHaveLength(1);
    const node = snapshot.nodes[0]!;
    expect(node.properties.title).toBe("Ship");
    // Not "2": values go into Loro natively, so numbers come back as numbers
    // without an encode/decode pair in the middle.
    expect(node.properties.estimate).toBe(2);
    expect(node.tags).toEqual(["RFP"]);
  });

  it("patches only the named keys and clears the ones the patch omits", () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "Ship", estimate: 2 });
    upsert(graph, "t1", { title: "Shipped" }, { patch: ["title"] });
    expect(graph.snapshot().nodes[0]!.properties).toMatchObject({
      title: "Shipped",
      estimate: 2,
    });

    upsert(graph, "t1", {}, { patch: ["estimate"] });
    expect(graph.snapshot().nodes[0]!.properties.estimate).toBeUndefined();
  });

  it("replaces the whole property map when no patch is given", () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "Ship", estimate: 2 });
    upsert(graph, "t1", { title: "Only" });
    expect(graph.snapshot().nodes[0]!.properties.estimate).toBeUndefined();
  });

  it("deletes a node's incident edges with it", () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "One" });
    upsert(graph, "t2", { title: "Two" });
    graph.apply({
      kind: "upsertEdge",
      id: "e1",
      type: "BLOCKS",
      from: "t1",
      to: "t2",
      properties: {},
      meta: {},
    });
    expect(graph.snapshot().edges).toHaveLength(1);

    graph.apply({ kind: "deleteNode", id: "t2" });
    const snapshot = graph.snapshot();
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["t1"]);
    expect(snapshot.edges).toEqual([]);
  });

  it("commits a batch as one change and one notification", () => {
    const graph = graphOf();
    let notifications = 0;
    const stop = graph.subscribe(() => {
      notifications += 1;
    });
    graph.applyBatch([
      { kind: "upsertNode", id: "a", type: "Task", properties: { title: "A" }, meta: {} },
      { kind: "upsertNode", id: "b", type: "Task", properties: { title: "B" }, meta: {} },
      { kind: "upsertNode", id: "c", type: "Task", properties: { title: "C" }, meta: {} },
    ]);
    stop();
    expect(notifications).toBe(1);
    expect(graph.snapshot().nodes).toHaveLength(3);
  });

  it("exposes text, map, and array fields and hydrates them into the snapshot", async () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "Ship" });
    await graph.ensureCollab("t1", "Task");

    graph.collabText("t1", "notes").insert(0, "hello");
    graph.collabMap("t1", "settings").set("colour", "green");
    graph.collabArray("t1", "labels").push("urgent");

    const node = graph.snapshot().nodes[0]!;
    expect(node.properties.notes).toBe("hello");
    expect(node.properties.settings).toEqual({ colour: "green" });
    expect(node.properties.labels).toEqual(["urgent"]);
  });

  it("refuses a live field the schema does not declare", async () => {
    const graph = graphOf();
    upsert(graph, "t1", { title: "Ship" });
    await graph.ensureCollab("t1", "Task");
    expect(() => graph.collabText("t1", "title")).toThrow(/no text field/);
  });

  it("merges concurrent creation of the same node id", () => {
    const a = graphOf();
    const b = new LoroDoc();
    b.setPeerId(2);
    initializeIfNeeded(b, schema);
    const other = new LoroCollaborativeGraph(b, schema);

    // Both peers create `t1` without having seen the other. Plain container
    // creation would give each its own container and lose one side's writes.
    upsert(a, "t1", { title: "From A", estimate: 1 });
    upsert(other, "t1", { estimate: 9 }, { patch: ["estimate"] });

    a.importUpdate(other.exportUpdate());
    other.importUpdate(a.exportUpdate());

    const left = a.snapshot().nodes;
    const right = other.snapshot().nodes;
    expect(left).toHaveLength(1);
    expect(left).toEqual(right);
    expect(left[0]!.properties.title).toBe("From A");
  });
});
