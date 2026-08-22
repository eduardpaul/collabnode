import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { CollabSession } from "../src/index.ts";

const baseYaml = `
name: TaskBoard
version: 1
config:
  schemaId: task-board
  idStrategy: uuid
nodes:
  Task:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
      status:
        type: enum
        values: [todo, doing, done]
        default: todo
      estimate:
        type: number
  Person:
    properties:
      name:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
`;

describe("CollabSession", () => {
  it("projects mutations into the graph store for two peers", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const collab = new InMemoryCollabBackend();
    const hostStore = new InMemoryGraphStore();
    const host = await CollabSession.open(undefined, { schema, collab, graph: hostStore });
    const peerStore = new InMemoryGraphStore();
    const peer = await CollabSession.open(host.id, { schema, collab, graph: peerStore });

    const taskId = await host.upsertNode({ type: "Task", properties: { title: "Ship DSL" } });
    const personId = await host.upsertNode({ type: "Person", properties: { name: "Ada" } });
    await host.upsertEdge({ type: "ASSIGNED_TO", from: taskId, to: personId });

    await peer.query("MATCH (n:Task) RETURN n");
    const tasks = await peer.query("MATCH (n:Task) RETURN n");
    expect(tasks.rows).toHaveLength(1);
    expect(taskId).toHaveLength(32);

    await host.close();
    await peer.close();
  });

  it("stamps last-write provenance when change tracking is enabled", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: last-write
nodes:
  Task:
    properties:
      title:
        type: string
        required: true
`);
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "agent-1",
    });
    const id = await session.upsertNode({ type: "Task", properties: { title: "Tracked" } });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.meta.createdBy).toBe("agent-1");
    expect(node?.meta.updatedBy).toBe("agent-1");
    expect(node?.meta.createdAt).toBeTruthy();
    await session.close();
  });

  it("rejects unknown properties", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    await expect(
      session.upsertNode({ type: "Task", properties: { title: "X", nope: true } }),
    ).rejects.toThrow(/unknown properties/);
    await session.close();
  });

  it("enforces integer, min/max, and maxLength on upsert", async () => {
    const schema = parseSchemaDocument(`
name: Constrained
version: 1
config:
  schemaId: constrained
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
        maxLength: 8
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    await expect(
      session.upsertNode({ type: "Feature", properties: { title: "ok", complexity: 3.5 } }),
    ).rejects.toThrow(/integer/);
    await expect(
      session.upsertNode({ type: "Feature", properties: { title: "ok", complexity: 6 } }),
    ).rejects.toThrow(/<= 5/);
    await expect(
      session.upsertNode({ type: "Feature", properties: { title: "ok", complexity: -1 } }),
    ).rejects.toThrow(/>= 0/);
    await expect(
      session.upsertNode({
        type: "Feature",
        properties: { title: "too-long-title", complexity: 1 },
      }),
    ).rejects.toThrow(/length <= 8/);
    const id = await session.upsertNode({
      type: "Feature",
      properties: { title: "ok", complexity: 5 },
    });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties).toEqual({ title: "ok", complexity: 5 });
    await session.close();
  });

  it("merges properties on upsert so omitted keys stay and defaults apply only on create", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3, status: "doing" },
    });
    await session.upsertNode({
      type: "Task",
      id,
      properties: { status: "done" },
    });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties).toEqual({ title: "Ship DSL", estimate: 3, status: "done" });
    await session.close();
  });

  it("clears optional properties on explicit null and does not re-apply defaults", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3, status: "doing" },
    });
    await session.upsertNode({
      type: "Task",
      id,
      properties: { estimate: null, title: "Shipped" },
    });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties).toEqual({ title: "Shipped", status: "doing" });
    expect(node?.properties).not.toHaveProperty("estimate");
    await session.close();
  });

  it("rejects upsert when the id already belongs to a different type", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const personId = await session.upsertNode({ type: "Person", properties: { name: "Ada" } });
    await expect(
      session.upsertNode({ type: "Task", id: personId, properties: { title: "x" } }),
    ).rejects.toThrow(/is type 'Person', not 'Task'/);
    const person = session.snapshot().nodes.find((record) => record.id === personId);
    expect(person?.type).toBe("Person");
    expect(person?.properties).toEqual({ name: "Ada" });
    await session.close();
  });

  it("rejects null for required properties on update", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3 },
    });
    await expect(
      session.upsertNode({ type: "Task", id, properties: { title: null } }),
    ).rejects.toThrow(/missing required property 'title'/);
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties.title).toBe("Ship DSL");
    expect(node?.properties.estimate).toBe(3);
    await session.close();
  });

  it("merges on identity upsert without an explicit id", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3, status: "doing" },
    });
    const again = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", status: "done" },
    });
    expect(again).toBe(id);
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties).toEqual({ title: "Ship DSL", estimate: 3, status: "done" });
    await session.close();
  });

  it("ignores a random id when identity fields match an existing node", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3 },
    });
    const again = await session.upsertNode({
      type: "Task",
      id: crypto.randomUUID(),
      properties: { title: "Ship DSL", status: "done" },
    });
    expect(again).toBe(id);
    expect(session.snapshot().nodes).toHaveLength(1);
    expect(session.snapshot().nodes[0]?.properties.status).toBe("done");
    await session.close();
  });

  it("mints the identity id even when a random id is passed on create", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const random = crypto.randomUUID();
    const id = await session.upsertNode({
      type: "Task",
      id: random,
      properties: { title: "Ship DSL" },
    });
    expect(id).not.toBe(random);
    expect(id).toHaveLength(32);
    const again = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", status: "doing" },
    });
    expect(again).toBe(id);
    await session.close();
  });

  it("keeps the existing id when identity fields are renamed in place", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL" },
    });
    const again = await session.upsertNode({
      type: "Task",
      id,
      properties: { title: "Shipped" },
    });
    expect(again).toBe(id);
    expect(session.snapshot().nodes[0]?.properties.title).toBe("Shipped");
    await session.close();
  });

  it("rejects an id that points at a different identity-keyed node", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const first = await session.upsertNode({ type: "Task", properties: { title: "Alpha" } });
    await session.upsertNode({ type: "Task", properties: { title: "Beta" } });
    await expect(
      session.upsertNode({ type: "Task", id: first, properties: { title: "Beta" } }),
    ).rejects.toThrow(/different node than identity/);
    await session.close();
  });

  it("reuses an existing edge with the same type and endpoints", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const taskId = await session.upsertNode({ type: "Task", properties: { title: "Ship DSL" } });
    const personId = await session.upsertNode({ type: "Person", properties: { name: "Ada" } });
    const first = await session.upsertEdge({ type: "ASSIGNED_TO", from: taskId, to: personId });
    const second = await session.upsertEdge({ type: "ASSIGNED_TO", from: taskId, to: personId });
    expect(second).toBe(first);
    expect(session.snapshot().edges).toHaveLength(1);
    await session.close();
  });

  it("clears a defaulted optional with null instead of re-applying the default", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: 3, status: "doing" },
    });
    await session.upsertNode({
      type: "Task",
      id,
      properties: { status: null },
    });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties).toEqual({ title: "Ship DSL", estimate: 3 });
    expect(node?.properties).not.toHaveProperty("status");
    await session.close();
  });

  it("omits optional null on create instead of storing a null key", async () => {
    const schema = parseSchemaDocument(baseYaml);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Task",
      properties: { title: "Ship DSL", estimate: null },
    });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties.title).toBe("Ship DSL");
    expect(node?.properties.status).toBe("todo");
    expect(node?.properties).not.toHaveProperty("estimate");
    await session.close();
  });

  it("evaluates derived properties on the post-merge bag as IEEE floats", async () => {
    const schema = parseSchemaDocument(`
name: Scored
version: 1
config:
  schemaId: scored
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
      uncertainty:
        type: number
        integer: true
        min: 0
        max: 5
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Feature",
      properties: { title: "Checkout", complexity: 3, uncertainty: 4 },
    });
    const created = session.snapshot().nodes.find((record) => record.id === id);
    expect(created?.properties.effortWeight).toBe(5.4);

    await session.upsertNode({
      type: "Feature",
      id,
      properties: { title: "x" },
    });
    const patched = session.snapshot().nodes.find((record) => record.id === id);
    expect(patched?.properties).toEqual({
      title: "x",
      complexity: 3,
      uncertainty: 4,
      effortWeight: 5.4,
    });

    await session.upsertNode({
      type: "Feature",
      id,
      properties: { complexity: 5 },
    });
    const updated = session.snapshot().nodes.find((record) => record.id === id);
    expect(updated?.properties.effortWeight).toBe(9);

    await session.upsertNode({
      type: "Feature",
      id,
      properties: { uncertainty: null },
    });
    const cleared = session.snapshot().nodes.find((record) => record.id === id);
    expect(cleared?.properties).toEqual({ title: "x", complexity: 5 });
    expect(cleared?.properties).not.toHaveProperty("effortWeight");
    await session.close();
  });

  it("reports rapid edits in the order they happened", async () => {
    // `at` is an ISO string, so a burst of writes ties on the millisecond and
    // history falls through to the opId. That opId has to be monotonic or the
    // order here is randomness: before `ulid()` became monotonic, five quick
    // edits came back scrambled on every single run.
    const schema = parseSchemaDocument(`
name: Ordered
version: 1
config:
  schemaId: ordered
  changeTracking:
    enabled: true
    mode: history
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      revision:
        type: number
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const id = await session.upsertNode({
      type: "Note",
      properties: { title: "Checkout", revision: 0 },
    });
    for (let revision = 1; revision <= 5; revision += 1) {
      await session.upsertNode({ type: "Note", id, properties: { revision } });
    }
    const revisions = session
      .history({ id })
      .map((entry) => entry.changes?.find((change) => change.field === "revision")?.after);
    expect(revisions).toEqual([0, 1, 2, 3, 4, 5]);
    // And the last entry really is the last edit, which is what `.at(-1)` and
    // every "what changed most recently" read depends on.
    expect(session.history({ id }).at(-1)?.changes).toEqual([
      { field: "revision", before: 4, after: 5 },
    ]);
    await session.close();
  });

  it("records derived field diffs that match the stored node", async () => {
    const schema = parseSchemaDocument(`
name: Scored
version: 1
config:
  schemaId: scored
  changeTracking:
    enabled: true
    mode: history
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
      uncertainty:
        type: number
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const id = await session.upsertNode({
      type: "Feature",
      properties: { title: "Checkout", complexity: 3, uncertainty: 4 },
    });
    await session.upsertNode({ type: "Feature", id, properties: { complexity: 5 } });
    const node = session.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties.effortWeight).toBe(9);
    // Picked by what they changed rather than by position: these three upserts
    // share a millisecond, and this test is about the diffs, not the ordering.
    const update = session
      .history({ id })
      .find((entry) =>
        entry.changes?.some((change) => change.field === "complexity" && change.before === 3),
      );
    expect(update?.changes).toEqual(
      expect.arrayContaining([
        { field: "complexity", before: 3, after: 5 },
        { field: "effortWeight", before: 5.4, after: 9 },
      ]),
    );
    await session.upsertNode({ type: "Feature", id, properties: { uncertainty: null } });
    const cleared = session.snapshot().nodes.find((record) => record.id === id);
    expect(cleared?.properties).not.toHaveProperty("effortWeight");
    const clearHist = session
      .history({ id })
      .find((entry) =>
        entry.changes?.some((change) => change.field === "uncertainty" && change.after === null),
      );
    expect(clearHist?.changes).toEqual(
      expect.arrayContaining([
        { field: "uncertainty", before: 4, after: null },
        { field: "effortWeight", before: 9, after: null },
      ]),
    );
    expect(cleared?.properties).toEqual({ title: "Checkout", complexity: 5 });
    await session.close();
  });

  it("rejects division by zero when evaluating derived properties", async () => {
    const schema = parseSchemaDocument(`
name: Div
version: 1
config:
  schemaId: div
nodes:
  Item:
    properties:
      n:
        type: number
      ratio:
        type: number
        derived: "1 / n"
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    await expect(
      session.upsertNode({ type: "Item", properties: { n: 0 } }),
    ).rejects.toThrow(/division by zero/);
    await session.close();
  });

  it("records who created X and complexity 2→4 so a later peer sees both via history()", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
`);
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const id = await host.upsertNode({
      type: "Feature",
      properties: { title: "Checkout", complexity: 2 },
    });
    await host.upsertNode({ type: "Feature", id, properties: { complexity: 4 } });

    const peer = await CollabSession.open(host.id, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "chidi",
    });
    const hist = peer.history({ id });
    expect(hist.some((entry) => entry.actorId === "ada" && entry.summary === "Checkout")).toBe(true);
    const change = hist.find((entry) =>
      entry.changes?.some((diff) => diff.field === "complexity" && diff.before === 2 && diff.after === 4),
    );
    expect(change?.actorId).toBe("ada");
    await host.close();
    await peer.close();
  });


  it("keeps concurrent history appends from two writers", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
`);
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const peer = await CollabSession.open(host.id, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "chidi",
    });
    await Promise.all([
      host.upsertNode({ type: "Feature", properties: { title: "Ada item" } }),
      peer.upsertNode({ type: "Feature", properties: { title: "Chidi item" } }),
    ]);
    const hist = host.history();
    expect(hist).toHaveLength(2);
    expect(hist.map((entry) => entry.actorId).sort()).toEqual(["ada", "chidi"]);
    await host.close();
    await peer.close();
  });


  it("keeps concurrent title and score patches on a per-key map", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: last-write
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
`);
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const peer = await CollabSession.open(host.id, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "chidi",
    });
    const id = await host.upsertNode({
      type: "Feature",
      properties: { title: "Checkout", complexity: 2 },
    });
    await host.upsertNode({ type: "Feature", id, properties: { title: "Ada title" } });
    await peer.upsertNode({ type: "Feature", id, properties: { complexity: 4 } });
    const node = peer.snapshot().nodes.find((record) => record.id === id);
    expect(node?.properties.title).toBe("Ada title");
    expect(node?.properties.complexity).toBe(4);
    await host.close();
    await peer.close();
  });


  it("omits tags on upsert and keeps the existing set", async () => {
    const schema = parseSchemaDocument(`
name: Tagged
version: 1
config:
  schemaId: tagged
  tags:
    enabled: true
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({
      type: "Feature",
      properties: { title: "Checkout" },
      tags: ["RFP", "rfp", "Q3"],
    });
    expect(session.snapshot().nodes.find((record) => record.id === id)?.tags).toEqual(["RFP", "Q3"]);
    await session.upsertNode({ type: "Feature", id, properties: { complexity: 2 } });
    expect(session.snapshot().nodes.find((record) => record.id === id)?.tags).toEqual(["RFP", "Q3"]);
    await session.upsertNode({ type: "Feature", id, properties: { title: "Checkout" }, tags: [] });
    expect(session.snapshot().nodes.find((record) => record.id === id)?.tags).toEqual([]);
    await session.close();
  });


  it("stamps a per-op actor via options and runAs", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "server",
    });
    const adaId = await session.upsertNode(
      { type: "Feature", properties: { title: "From Ada" } },
      { actorId: "ada" },
    );
    const chidi = session.runAs("chidi");
    const chidiId = await chidi.upsertNode({ type: "Feature", properties: { title: "From Chidi" } });
    expect(session.snapshot().nodes.find((record) => record.id === adaId)?.meta.createdBy).toBe("ada");
    expect(session.snapshot().nodes.find((record) => record.id === chidiId)?.meta.createdBy).toBe("chidi");
    expect(session.history().map((entry) => entry.actorId).sort()).toEqual(["ada", "chidi"]);
    await chidi.close();
    await session.close();
  });


  it("redacts Chunk.text in history changes", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
nodes:
  Chunk:
    properties:
      text:
        type: string
        required: true
      preview:
        type: string
        required: true
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const body = "A".repeat(120);
    await session.upsertNode({
      type: "Chunk",
      properties: { text: body, preview: "A".repeat(80) },
    });
    const change = session.history()[0]?.changes?.find((diff) => diff.field === "text");
    expect(change?.after).toEqual({ length: 120, prefix: "A".repeat(80) });
    expect(session.history()[0]?.created).toBe(true);
    await session.close();
  });


  it("sets created only on the first upsert so later field fills are not creates", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const id = await session.upsertNode({ type: "Feature", properties: { title: "Checkout" } });
    await session.upsertNode({ type: "Feature", id, properties: { complexity: 4 } });
    const hist = session.history({ id });
    expect(hist).toHaveLength(2);
    expect(hist.filter((entry) => entry.created)).toHaveLength(1);
    const update = hist.find((entry) => entry.created !== true);
    expect(update?.changes).toEqual([{ field: "complexity", before: null, after: 4 }]);
    await session.close();
  });


  it("merges edge properties so partial upserts do not record unpatched keys as removed", async () => {
    const schema = parseSchemaDocument(`
name: Tracked
version: 1
config:
  schemaId: tracked
  changeTracking:
    enabled: true
    mode: history
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
    properties:
      note:
        type: string
      since:
        type: string
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const task = await session.upsertNode({ type: "Task", properties: { title: "Ship" } });
    const person = await session.upsertNode({ type: "Person", properties: { name: "Ada" } });
    const edgeId = await session.upsertEdge({
      type: "ASSIGNED_TO",
      from: task,
      to: person,
      properties: { note: "keep me", since: "2026-01-01" },
    });
    await session.upsertEdge({
      type: "ASSIGNED_TO",
      id: edgeId,
      from: task,
      to: person,
      properties: { since: "2026-02-01" },
    });
    const edge = session.snapshot().edges.find((record) => record.id === edgeId);
    expect(edge?.properties).toEqual({ note: "keep me", since: "2026-02-01" });
    // Both upserts land in the same millisecond. Ordering is trustworthy — see
    // "reports rapid edits in the order they happened" — but selecting the
    // update by what it is keeps this test about property merging.
    const entries = session.history().filter((entry) => entry.op === "upsertEdge");
    expect(entries.map((entry) => entry.created)).toEqual(expect.arrayContaining([true, false]));
    const update = entries.find((entry) => !entry.created);
    expect(update?.changes).toEqual([{ field: "since", before: "2026-01-01", after: "2026-02-01" }]);
    expect(update?.changes?.some((diff) => diff.field === "note")).toBe(false);
    await session.close();
  });

  it("projects text properties into the graph sink and coalesces keystrokes", async () => {
    const schema = parseSchemaDocument(`
name: Notes
version: 1
config:
  schemaId: notes
  changeTracking:
    enabled: true
    mode: last-write
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
      votes:
        type: map
      blocks:
        type: array
`);
    const collab = new InMemoryCollabBackend();
    const hostStore = new InMemoryGraphStore();
    const host = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: hostStore,
      actorId: "agent-1",
    });
    const peerStore = new InMemoryGraphStore();
    const peer = await CollabSession.open(host.id, {
      schema,
      collab,
      graph: peerStore,
      actorId: "peer",
    });
    const graphOps: string[] = [];
    peer.onChange((ops) => {
      graphOps.push(...ops.map((op) => op.kind));
    });

    const id = await host.upsertNode({
      type: "Note",
      properties: {
        title: "Outage",
        body: "## Timeline\n",
        votes: { ada: 1 },
        blocks: ["intro"],
      },
    });
    expect(peer.snapshot().nodes[0]?.properties).toMatchObject({
      title: "Outage",
      body: "## Timeline\n",
      votes: { ada: 1 },
      blocks: ["intro"],
    });
    const queried = await peer.query("MATCH (n:Note) RETURN n");
    const row = queried.rows[0]?.n as { properties?: Record<string, unknown> } | undefined;
    expect(row?.properties?.title).toBe("Outage");
    expect(row?.properties?.body).toBe("## Timeline\n");

    const beforeMeta = peer.snapshot().nodes[0]?.meta.updatedAt;
    await host.upsertNode({ type: "Note", id, properties: { body: "## Timeline\n- down\n" } });
    expect(peer.snapshot().nodes[0]?.properties.body).toBe("## Timeline\n- down\n");
    expect(peer.snapshot().nodes[0]?.properties.title).toBe("Outage");
    expect(peer.snapshot().nodes[0]?.meta.updatedBy).toBe("agent-1");
    expect(peer.snapshot().nodes[0]?.meta.updatedAt).not.toBe(beforeMeta);

    await host.upsertNode({ type: "Note", id, properties: { title: "Outage log" } });
    expect(peer.snapshot().nodes[0]?.properties.body).toBe("## Timeline\n- down\n");

    const opsBeforeKeystroke = graphOps.length;
    host.collabText(id, "body").insert(host.collabText(id, "body").toString().length, "x");
    host.collabText(id, "body").insert(host.collabText(id, "body").toString().length, "y");
    expect(peer.snapshot().nodes[0]?.properties.body).toBe("## Timeline\n- down\nxy");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Read past the session so the drain does not flush the pending keystrokes.
    const early = await peerStore.query(
      { workspaceId: peer.id, schemaId: peer.schema.config.schemaId },
      "MATCH (n:Note) RETURN n",
    );
    const earlyNode = early.rows[0]?.n as { properties?: Record<string, unknown> } | undefined;
    expect(earlyNode?.properties?.body).toBe("## Timeline\n- down\n");
    expect(graphOps.length).toBe(opsBeforeKeystroke);
    const afterType = await peer.query("MATCH (n:Note) RETURN n");
    const typed = afterType.rows[0]?.n as { properties?: Record<string, unknown> } | undefined;
    expect(typed?.properties?.body).toBe("## Timeline\n- down\nxy");
    expect(graphOps.length).toBe(opsBeforeKeystroke + 1);

    await host.close();
    await peer.close();
  });

  it("rejects omitted required text properties on create", async () => {
    const schema = parseSchemaDocument(`
name: Notes
version: 1
config:
  schemaId: notes
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
        required: true
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    await expect(
      session.upsertNode({ type: "Note", properties: { title: "Draft" } }),
    ).rejects.toThrow(/body/);
    await session.close();
  });

  it("rejects collabText unless the schema field is type text", async () => {
    const schema = parseSchemaDocument(`
name: Notes
version: 1
config:
  schemaId: notes
nodes:
  Note:
    properties:
      title:
        type: string
        required: true
      body:
        type: text
`);
    const session = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
    });
    const id = await session.upsertNode({ type: "Note", properties: { title: "Log", body: "hi" } });
    expect(() => session.collabText(id, "title")).toThrow(/text property/);
    expect(session.collabText(id, "body").toString()).toBe("hi");
    await session.close();
  });
});
