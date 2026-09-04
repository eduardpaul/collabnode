import { InMemoryCollabBackend, type CollaborativeGraph, type VersionToken } from "@collabnode/collab";
import { InMemoryGraphStore, type GraphOp } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { Projector } from "../src/projector.ts";

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
`);

const scope = { workspaceId: "w1", schemaId: "task-board" };

/**
 * A graph that reports versions, wrapping the in-memory one.
 *
 * The point of the double rather than a real Loro document is the second test:
 * a backend whose history has been trimmed past the last projected version has
 * to fall back, and that is hard to arrange on purpose and easy to get wrong.
 */
class VersionedDouble implements CollaborativeGraph {
  diffCalls = 0;
  answer: GraphOp[] | undefined = [];
  private counter = 0;

  constructor(private readonly inner: CollaborativeGraph) {}

  get schemaId(): string {
    return this.inner.schemaId;
  }
  get schemaHash(): string {
    return this.inner.schemaHash;
  }
  snapshot() {
    return this.inner.snapshot();
  }
  apply(op: GraphOp): void {
    this.counter += 1;
    this.inner.apply(op);
  }
  applyBatch(ops: GraphOp[]): void {
    this.counter += 1;
    this.inner.applyBatch(ops);
  }
  history(filter?: Parameters<CollaborativeGraph["history"]>[0]) {
    return this.inner.history(filter);
  }
  subscribe(listener: Parameters<CollaborativeGraph["subscribe"]>[0]) {
    return this.inner.subscribe(listener);
  }
  ensureCollab(nodeId: string, nodeType: string) {
    return this.inner.ensureCollab(nodeId, nodeType);
  }
  collabText(nodeId: string, field: string) {
    return this.inner.collabText(nodeId, field);
  }
  collabMap(nodeId: string, field: string) {
    return this.inner.collabMap(nodeId, field);
  }
  collabArray(nodeId: string, field: string) {
    return this.inner.collabArray(nodeId, field);
  }

  version(): VersionToken {
    return { kind: "double", encoded: String(this.counter) };
  }
  diffSince(): GraphOp[] | undefined {
    this.diffCalls += 1;
    return this.answer;
  }
  exportDoc(): Uint8Array {
    return new Uint8Array();
  }
  checkout(): void {}
}

function task(id: string, title: string): GraphOp {
  return { kind: "upsertNode", id, type: "Task", properties: { title }, meta: {} };
}

async function versionedProjector(): Promise<{
  graph: VersionedDouble;
  projector: Projector;
  ops: GraphOp[][];
}> {
  const backend = new InMemoryCollabBackend();
  const handle = await backend.open("w1", schema);
  const graph = new VersionedDouble(handle.graph);
  const projector = new Projector(schema, scope, graph, new InMemoryGraphStore(), 0);
  const ops: GraphOp[][] = [];
  projector.on((batch) => ops.push(batch));
  await projector.start();
  return { graph, projector, ops };
}

describe("Projector on a versioned backend", () => {
  it("asks the document what changed instead of comparing snapshots", async () => {
    const { graph, projector, ops } = await versionedProjector();
    graph.answer = [task("t1", "From diffSince")];
    graph.apply(task("t1", "Ignored by the projector"));
    await projector.drain();

    expect(graph.diffCalls).toBeGreaterThan(0);
    // The ops the store and the listeners saw are the document's answer, not a
    // snapshot comparison's.
    expect(ops.at(-1)).toEqual([task("t1", "From diffSince")]);
    projector.stop();
  });

  it("falls back to a snapshot diff when the document cannot answer", async () => {
    const { graph, projector, ops } = await versionedProjector();
    graph.answer = undefined;
    graph.apply(task("t1", "Real"));
    await projector.drain();

    expect(graph.diffCalls).toBeGreaterThan(0);
    expect(ops.at(-1)).toMatchObject([{ kind: "upsertNode", id: "t1" }]);
    expect(ops.at(-1)![0]).toMatchObject({ properties: { title: "Real" } });
    projector.stop();
  });

  it("does not advance the projected version past a diff it dropped", async () => {
    const { graph, projector, ops } = await versionedProjector();
    // Nothing changed as far as the document is concerned, so nothing commits
    // and the next diff must still be measured from the last committed version.
    graph.answer = [];
    graph.apply(task("t1", "Quiet"));
    await projector.drain();
    expect(ops).toHaveLength(0);

    graph.answer = [task("t1", "Quiet"), task("t2", "Loud")];
    graph.apply(task("t2", "Loud"));
    await projector.drain();
    expect(ops.at(-1)).toHaveLength(2);
    projector.stop();
  });
});
