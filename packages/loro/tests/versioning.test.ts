import { isVersioned, type CollaborativeGraph } from "@collabnode/collab";
import { parseSchemaDocument } from "@collabnode/schema";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { LoroCollabBackend } from "../src/backend.ts";
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
    historyLimit: 2
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
      estimate:
        type: number
edges:
  BLOCKS:
    from: [Task]
    to: [Task]
`);

function graphOf(peer = 1): LoroCollaborativeGraph {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  initializeIfNeeded(doc, schema);
  return new LoroCollaborativeGraph(doc, schema);
}

function task(id: string, title: string, actorId?: string) {
  return {
    kind: "upsertNode" as const,
    id,
    type: "Task",
    properties: { title } as never,
    meta: {},
    ...(actorId
      ? {
          history: {
            opId: `op-${id}`,
            op: "upsertNode" as const,
            id,
            type: "Task",
            actorId,
            at: `2026-01-0${id.length}T00:00:00.000Z`,
          },
        }
      : {}),
  };
}

describe("version tokens", () => {
  it("satisfies the VersionedGraph narrowing", () => {
    const graph: CollaborativeGraph = graphOf();
    expect(isVersioned(graph)).toBe(true);
  });

  it("names a version that survives a JSON round trip", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    const token = JSON.parse(JSON.stringify(graph.version())) as ReturnType<
      LoroCollaborativeGraph["version"]
    >;
    expect(token.kind).toBe("loro");
    graph.apply(task("t2", "Two"));
    expect(graph.diffSince(token)).toHaveLength(1);
  });

  it("refuses a token another backend minted rather than misreading it", () => {
    const graph = graphOf();
    expect(graph.diffSince({ kind: "hocuspocus", encoded: "whatever" })).toBeUndefined();
    expect(graph.diffSince({ kind: "loro", encoded: "not-base64!!" })).toBeUndefined();
  });
});

describe("diffSince", () => {
  it("returns the empty array when nothing changed, never undefined", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    expect(graph.diffSince(graph.version())).toEqual([]);
  });

  it("reports only the entities that changed, not the whole graph", () => {
    const graph = graphOf();
    for (let i = 0; i < 50; i += 1) {
      graph.apply(task(`t${i}`, `Task ${i}`));
    }
    const before = graph.version();
    graph.apply(task("t7", "Renamed"));

    const ops = graph.diffSince(before);
    expect(ops).toHaveLength(1);
    expect(ops![0]).toMatchObject({ kind: "upsertNode", id: "t7" });
  });

  it("reports a property change on an existing node", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    const before = graph.version();
    graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { estimate: 5 } as never,
      patch: ["estimate"],
      meta: {},
    });
    const ops = graph.diffSince(before)!;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "upsertNode", id: "t1" });
    expect((ops[0] as { properties: Record<string, unknown> }).properties).toMatchObject({
      title: "One",
      estimate: 5,
    });
  });

  it("reports deletions, including the edges a node delete took with it", () => {
    const graph = graphOf();
    graph.applyBatch([task("t1", "One"), task("t2", "Two")]);
    graph.apply({
      kind: "upsertEdge",
      id: "e1",
      type: "BLOCKS",
      from: "t1",
      to: "t2",
      properties: {},
      meta: {},
    });
    const before = graph.version();
    graph.apply({ kind: "deleteNode", id: "t2" });

    const ops = graph.diffSince(before)!;
    expect(ops).toContainEqual({ kind: "deleteNode", id: "t2" });
    expect(ops).toContainEqual({ kind: "deleteEdge", id: "e1" });
  });

  it("agrees with a snapshot diff over the same span", async () => {
    const { diffSnapshots } = await import("@collabnode/graph");
    const graph = graphOf();
    graph.applyBatch([task("t1", "One"), task("t2", "Two"), task("t3", "Three")]);
    const before = graph.version();
    const beforeSnapshot = graph.snapshot();

    graph.applyBatch([task("t2", "Two renamed"), task("t4", "Four")]);
    graph.apply({ kind: "deleteNode", id: "t1" });

    const byVersion = graph.diffSince(before)!;
    const bySnapshot = diffSnapshots(beforeSnapshot, graph.snapshot());
    const key = (op: { kind: string; id: string }): string => `${op.kind}:${op.id}`;
    expect(new Set(byVersion.map(key))).toEqual(new Set(bySnapshot.map(key)));
  });

  it("gives up on a version its history no longer reaches", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    const early = graph.version();
    graph.apply(task("t2", "Two"));

    const shallow = new LoroDoc();
    shallow.import(graph.exportDoc("shallow"));
    const trimmed = new LoroCollaborativeGraph(shallow, schema);

    // `undefined` is the signal to fall back to a full snapshot. It must not be
    // confused with the empty array, which means "nothing changed".
    expect(trimmed.diffSince(early)).toBeUndefined();
    expect(trimmed.snapshot().nodes).toHaveLength(2);
  });
});

describe("history", () => {
  it("keeps every entry, ignoring historyLimit, because the DAG holds them", () => {
    const graph = graphOf();
    for (let i = 0; i < 10; i += 1) {
      graph.apply(task(`t${i}`, `Task ${i}`, "ada"));
    }
    // The Yjs backend would have evicted all but the newest two.
    expect(graph.history()).toHaveLength(10);
    expect(graph.history({ actorId: "ada" })).toHaveLength(10);
    expect(graph.history({ actorId: "grace" })).toHaveLength(0);
  });

  it("stores nothing in the document itself", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One", "ada"));
    const json = graph.doc.toJSON() as { collabnode: Record<string, unknown> };
    expect(Object.keys(json.collabnode)).not.toContain("history");
  });

  it("survives an export/import round trip", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One", "ada"));
    graph.apply(task("t2", "Two", "grace"));

    const restored = new LoroDoc();
    restored.import(graph.exportDoc());
    expect(new LoroCollaborativeGraph(restored, schema).history()).toHaveLength(2);
  });

  it("is trimmed by a shallow export, together with the ops it describes", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One", "ada"));
    graph.apply(task("t2", "Two", "grace"));

    const shallow = new LoroDoc();
    shallow.import(graph.exportDoc("shallow"));
    const trimmed = new LoroCollaborativeGraph(shallow, schema);
    expect(trimmed.snapshot().nodes).toHaveLength(2);
    expect(trimmed.history().length).toBeLessThan(2);
  });
});

describe("checkout", () => {
  it("rewinds the document and comes back", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    const afterFirst = graph.version();
    graph.apply(task("t2", "Two"));
    expect(graph.snapshot().nodes).toHaveLength(2);

    graph.checkout(afterFirst);
    expect(graph.snapshot().nodes.map((n) => n.id)).toEqual(["t1"]);

    graph.checkout(undefined);
    expect(graph.snapshot().nodes).toHaveLength(2);
  });

  it("makes a rewound document read-only", () => {
    const graph = graphOf();
    graph.apply(task("t1", "One"));
    const afterFirst = graph.version();
    graph.apply(task("t2", "Two"));
    graph.checkout(afterFirst);
    expect(() => graph.apply(task("t3", "Three"))).toThrow();
  });
});

describe("restore", () => {
  it("rebuilds a document that can still be rewound", async () => {
    const backend = new LoroCollabBackend();
    const handle = await backend.open("w1", schema);
    handle.graph.applyBatch([task("t1", "One", "ada")]);
    const early = handle.graph.version!();
    handle.graph.applyBatch([task("t2", "Two", "ada")]);
    const bytes = handle.graph.exportDoc!();
    await handle.close();

    const review = await backend.restore(bytes, schema);
    expect(review.graph.snapshot().nodes).toHaveLength(2);
    expect(review.graph.history()).toHaveLength(2);

    review.graph.checkout!(early);
    expect(review.graph.snapshot().nodes).toHaveLength(1);
    await review.close();

    // The restored copy is detached: it did not resurrect the live document.
    expect(await backend.exists("w1")).toBe(true);
  });
});
