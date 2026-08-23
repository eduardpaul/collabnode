import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { parseSchemaDocument, singletonId, SchemaError } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { CollabSession } from "../src/index.ts";

const YAML = `
name: Planner
version: 1
config:
  schemaId: planner
  idStrategy: uuid
nodes:
  BoardState:
    singleton: true
    properties:
      status:
        type: enum
        values: [idle, planning, approved]
        default: idle
      iteration:
        type: number
      owner:
        type: string
        required: true
  Task:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
edges:
  TRACKS:
    from: [BoardState]
    to: [Task]
`;

const schema = parseSchemaDocument(YAML);

async function open(backend = new InMemoryCollabBackend(), actorId = "ada"): Promise<CollabSession> {
  return CollabSession.open("doc-1", {
    schema,
    collab: backend,
    graph: new InMemoryGraphStore(),
    actorId,
  });
}

function statesOf(session: CollabSession) {
  return session.snapshot().nodes.filter((node) => node.type === "BoardState");
}

describe("singleton node types", () => {
  it("updates the one node instead of creating another", async () => {
    const session = await open();

    const first = await session.upsertNode({
      type: "BoardState",
      properties: { owner: "ada", status: "planning", iteration: 1 },
    });
    const second = await session.upsertNode({
      type: "BoardState",
      properties: { status: "approved", iteration: 2 },
    });

    expect(second).toBe(first);
    expect(statesOf(session)).toHaveLength(1);
    expect(statesOf(session)[0]?.properties).toMatchObject({
      owner: "ada",
      status: "approved",
      iteration: 2,
    });

    await session.close();
  });

  it("derives the id from the type, so replicas converge on one node", async () => {
    // Two peers on the same document, neither having seen the other's write.
    const backend = new InMemoryCollabBackend();
    const ada = await open(backend, "ada");
    const chidi = await CollabSession.open("doc-1", {
      schema,
      collab: backend,
      graph: new InMemoryGraphStore(),
      actorId: "chidi",
    });

    const byAda = await ada.upsertNode({ type: "BoardState", properties: { owner: "ada" } });
    const byChidi = await chidi.upsertNode({ type: "BoardState", properties: { owner: "chidi" } });

    expect(byAda).toBe(singletonId(schema, "BoardState"));
    expect(byChidi).toBe(byAda);
    expect(statesOf(ada)).toHaveLength(1);
    expect(statesOf(chidi)).toHaveLength(1);

    await ada.close();
    await chidi.close();
  });

  it("still enforces required properties when it creates", async () => {
    const session = await open();
    await expect(
      session.upsertNode({ type: "BoardState", properties: { status: "idle" } }),
    ).rejects.toThrow(/missing required property 'owner'/);
    expect(statesOf(session)).toHaveLength(0);

    // …and stops enforcing them once the node exists, because that is an update.
    await session.upsertNode({ type: "BoardState", properties: { owner: "ada" } });
    await session.upsertNode({ type: "BoardState", properties: { status: "planning" } });
    expect(statesOf(session)[0]?.properties).toMatchObject({ owner: "ada", status: "planning" });

    await session.close();
  });

  it("adopts a node created before the type was a singleton", async () => {
    const session = await open();
    // A document written under an older schema: same type, some other id.
    await session.applyOps([
      { op: "upsertNode", id: "legacy-state-id", type: "BoardState", properties: { owner: "ada" } },
    ]);

    const written = await session.upsertNode({
      type: "BoardState",
      properties: { status: "planning" },
    });

    expect(written).toBe("legacy-state-id");
    expect(statesOf(session)).toHaveLength(1);

    await session.close();
  });

  it("refuses an id that points at something else", async () => {
    const session = await open();
    await session.upsertNode({ type: "BoardState", properties: { owner: "ada" } });

    await expect(
      session.upsertNode({
        type: "BoardState",
        id: "some-other-id",
        properties: { owner: "chidi" },
      }),
    ).rejects.toThrow(SchemaError);
    expect(statesOf(session)).toHaveLength(1);

    await session.close();
  });

  it("collapses repeated writes inside one batch", async () => {
    const session = await open();

    const result = await session.batch((b) => {
      b.upsertNode({ type: "BoardState", properties: { owner: "ada", iteration: 1 } }, "state");
      b.upsertNode({ type: "BoardState", properties: { iteration: 2 } });
      b.upsertNode({ type: "Task", properties: { title: "Ship it" } }, "task");
      b.upsertEdge({ type: "TRACKS", from: { ref: "state" }, to: { ref: "task" } });
    });

    expect(statesOf(session)).toHaveLength(1);
    expect(statesOf(session)[0]?.properties.iteration).toBe(2);
    // The edge still lands on the singleton, because the ref resolved to it.
    expect(session.snapshot().edges[0]?.from).toBe(statesOf(session)[0]?.id);
    expect(result.applied).toBe(4);

    await session.close();
  });

  it("lets the singleton be deleted and created again", async () => {
    const session = await open();
    const id = await session.upsertNode({ type: "BoardState", properties: { owner: "ada" } });
    await session.deleteNode(id);
    expect(statesOf(session)).toHaveLength(0);

    const again = await session.upsertNode({ type: "BoardState", properties: { owner: "chidi" } });
    expect(again).toBe(id);
    expect(statesOf(session)).toHaveLength(1);

    await session.close();
  });

  it("leaves identity-keyed types alone", async () => {
    const session = await open();
    await session.upsertNode({ type: "Task", properties: { title: "One" } });
    await session.upsertNode({ type: "Task", properties: { title: "Two" } });
    expect(session.snapshot().nodes.filter((node) => node.type === "Task")).toHaveLength(2);

    await session.close();
  });
});
