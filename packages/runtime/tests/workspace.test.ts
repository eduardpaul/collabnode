import { CollabError, InMemoryCollabBackend } from "@collabnode/collab";
import { GraphStoreError, InMemoryGraphStore, type GraphOp } from "@collabnode/graph";
import { parseSchemaDocument, parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { CollabSession, Workspace } from "../src/index.ts";


const yaml = `
name: Retro
version: 1
config:
  schemaId: retro
  idStrategy: uuid
nodes:
  Column:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
  Item:
    properties:
      body:
        type: string
        required: true
      votes:
        type: number
        default: 0
edges:
  IN_COLUMN:
    from: [Item]
    to: [Column]
`;

const schema = parseSchemaDocument(yaml);
const scopeOf = (session: CollabSession) => ({
  workspaceId: session.id,
  schemaId: schema.config.schemaId,
});

describe("open is create-or-join", () => {
  it("lands two callers on the same document for one id", async () => {
    const collab = new InMemoryCollabBackend();
    const a = await CollabSession.open("retro-acme-s42", { schema, collab });
    const b = await CollabSession.open("retro-acme-s42", { schema, collab });
    expect(a.id).toBe("retro-acme-s42");
    expect(b.id).toBe(a.id);

    await a.upsertNode({ type: "Column", properties: { title: "Went well" } });
    expect(b.snapshot().nodes).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it("mints an id when the caller has none", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, { schema, collab });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    await session.close();
  });
});

describe("applyOps", () => {
  it("seeds nodes and edges in one batch, resolving refs across entries", async () => {
    const collab = new InMemoryCollabBackend();
    const store = new InMemoryGraphStore();
    const session = await CollabSession.open("seeded", { schema, collab, graph: store });

    const result = await session.applyOps([
      { op: "upsertNode", ref: "went_well", type: "Column", properties: { title: "Went well" } },
      { op: "upsertNode", ref: "first", type: "Item", properties: { body: "shipped it" } },
      { op: "upsertEdge", type: "IN_COLUMN", from: { ref: "first" }, to: { ref: "went_well" } },
    ]);

    expect(result.applied).toBe(3);
    expect(result.refs.went_well).toBeDefined();
    const snapshot = session.snapshot();
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0]?.from).toBe(result.refs.first);
    expect(snapshot.edges[0]?.to).toBe(result.refs.went_well);

    // The projection saw the whole batch, not a partial one.
    const projected = await session.query("MATCH (n:Item) RETURN n");
    expect(projected.rows).toHaveLength(1);
    await session.close();
  });

  it("commits the batch as one CRDT transaction, so one projection pass covers it", async () => {
    const collab = new InMemoryCollabBackend();
    const store = new InMemoryGraphStore();
    const session = await CollabSession.open("one-pass", { schema, collab, graph: store });
    const passes: GraphOp[][] = [];
    session.onChange((ops) => passes.push(ops));

    await session.applyOps(
      Array.from({ length: 20 }, (_, i) => ({
        op: "upsertNode" as const,
        type: "Item",
        properties: { body: `item ${i}` },
      })),
    );

    expect(session.snapshot().nodes).toHaveLength(20);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toHaveLength(20);
    await session.close();
  });

  it("resolves identity within the batch, so a repeated column is one node", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("dedup", { schema, collab });
    const result = await session.applyOps([
      { op: "upsertNode", type: "Column", properties: { title: "To improve" } },
      { op: "upsertNode", type: "Column", properties: { title: "to  improve" } },
    ]);
    expect(result.ids[0]).toBe(result.ids[1]);
    expect(session.snapshot().nodes).toHaveLength(1);
    // The stored spelling wins over the near-miss, as it does for single writes.
    expect(session.snapshot().nodes[0]?.properties.title).toBe("To improve");
    await session.close();
  });

  it("refuses an edge pointing at a ref no earlier entry declared", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("bad-ref", { schema, collab });
    await expect(
      session.applyOps([
        { op: "upsertNode", ref: "item", type: "Item", properties: { body: "orphan" } },
        { op: "upsertEdge", type: "IN_COLUMN", from: { ref: "item" }, to: { ref: "nowhere" } },
      ]),
    ).rejects.toThrow(/unknown ref 'nowhere'/);
    await session.close();
  });
});

describe("projection: none", () => {
  it("reads through snapshots and says so rather than answering Cypher", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("unprojected", { schema, collab });
    expect(session.projected).toBe(false);

    await session.upsertNode({ type: "Column", properties: { title: "Went well" } });
    expect(session.snapshot().nodes).toHaveLength(1);
    expect(session.searchModes()).toEqual({ text: false, vector: false });
    expect(await session.search({ q: "went", limit: 5 })).toBeUndefined();
    await expect(session.query("MATCH (n) RETURN n")).rejects.toBeInstanceOf(GraphStoreError);
    await session.close();
  });

  it("still delivers change events, which do not depend on a store", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("unprojected-events", { schema, collab });
    const seen: GraphOp[][] = [];
    session.onChange((ops) => seen.push(ops));
    await session.upsertNode({ type: "Item", properties: { body: "noted" } });
    expect(seen).toHaveLength(1);
    await session.close();
  });
});

describe("one store, many workspaces", () => {
  it("keeps concurrent workspaces of the same schema apart", async () => {
    const collab = new InMemoryCollabBackend();
    const store = new InMemoryGraphStore();
    const shared = { schema, collab, graph: store, ownsStore: false };
    const a = await CollabSession.open("retro-a", shared);
    const b = await CollabSession.open("retro-b", shared);

    await a.upsertNode({ type: "Item", properties: { body: "only in a" } });
    await b.upsertNode({ type: "Item", properties: { body: "only in b" } });

    expect((await a.query("MATCH (n:Item) RETURN n")).rows).toHaveLength(1);
    expect((await b.query("MATCH (n:Item) RETURN n")).rows).toHaveLength(1);
    expect(store.getNode(scopeOf(a), a.snapshot().nodes[0]!.id)?.properties.body).toBe("only in a");
    expect(store.getNode(scopeOf(b), a.snapshot().nodes[0]!.id)).toBeUndefined();

    await a.close();
    // Closing one workspace must leave the shared store serving the other.
    expect((await b.query("MATCH (n:Item) RETURN n")).rows).toHaveLength(1);
    await b.close();
    await store.close();
  });
});

describe("destroy", () => {
  it("returns the final snapshot, drops the projection, and deletes the document", async () => {
    const collab = new InMemoryCollabBackend();
    const store = new InMemoryGraphStore();
    const session = await CollabSession.open("ends-here", {
      schema,
      collab,
      graph: store,
      ownsStore: false,
    });
    await session.upsertNode({ type: "Item", properties: { body: "secret" } });
    const scope = scopeOf(session);

    const final = await session.destroy();
    expect(final.nodes).toHaveLength(1);
    expect(final.nodes[0]?.properties.body).toBe("secret");

    expect(await collab.exists("ends-here")).toBe(false);
    expect(store.getNode(scope, final.nodes[0]!.id)).toBeUndefined();

    // The point of deletion: reopening the id must not read back what ended.
    const reopened = await CollabSession.open("ends-here", { schema, collab });
    expect(reopened.snapshot().nodes).toHaveLength(0);
    await reopened.close();
    await store.close();
  });
});

describe("presence", () => {
  it("reports peers joining and leaving one document", async () => {
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open("room", { schema, collab, actorId: "ada" });
    expect(host.peers().map((peer) => peer.actorId)).toEqual(["ada"]);

    const joins: string[] = [];
    const leaves: string[] = [];
    host.presence().on("join", (peer) => joins.push(peer.actorId));
    host.presence().on("leave", (peer) => leaves.push(peer.actorId));

    const agent = await CollabSession.open("room", {
      schema,
      collab,
      actorId: "triage-bot",
      peerKind: "agent",
    });
    expect(joins).toEqual(["triage-bot"]);
    expect(host.peers()).toHaveLength(2);
    expect(host.peers().find((peer) => peer.actorId === "triage-bot")?.kind).toBe("agent");

    agent.presence().set({ cursor: 12 });
    expect(host.peers().find((peer) => peer.actorId === "triage-bot")?.state).toEqual({
      cursor: 12,
    });

    await agent.close();
    expect(leaves).toEqual(["triage-bot"]);
    expect(host.peers()).toHaveLength(1);
    await host.close();
  });

  it("declares what the backend can do rather than leaving it to be discovered", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("caps", { schema, collab });
    expect(session.capabilities).toEqual({
      namedDocuments: true,
      deletion: true,
      presence: true,
      versioning: false,
    });
    await session.close();
  });
});

describe("backend delete", () => {
  it("empties the document for anyone still holding a handle", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("doomed", { schema, collab });
    await session.upsertNode({ type: "Item", properties: { body: "secret" } });
    await collab.delete("doomed");
    expect(session.snapshot().nodes).toHaveLength(0);
    await session.close();
  });

  it("refuses a schema mismatch on open, as join did", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open("typed", { schema, collab });
    const other = parseSchemaDocument(yaml.replace("version: 1", "version: 2"));
    await expect(collab.open("typed", other)).rejects.toBeInstanceOf(CollabError);
    await session.close();
  });
});

describe("seedTemplate", () => {
  it("instantiates a WorkspaceType template with params in a single transaction", async () => {
    const wsType = parseWorkspaceTypeDocument(`
type: retro
version: 1
schema:
  nodes:
    Column:
      properties:
        title: { type: string, required: true }
    Item:
      properties:
        body: { type: text }
        votes: { type: number, default: 0 }
    Person:
      properties:
        name: { type: string, required: true }
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
    AUTHOR:
      from: [Item]
      to: [Person]
params:
  sprint: { type: number, required: true }
  members: { type: array, of: string }
template:
  nodes:
    - type: Column
      as: went_well
      properties: { title: "Went well (Sprint {sprint})" }
    - type: Column
      as: to_improve
      properties: { title: "To improve" }
    - forEach: members
      as: "member_{item}"
      type: Person
      properties: { name: "{item}" }
    - type: Item
      as: first_item
      properties:
        body: "First note from Sprint {sprint}"
        votes: 1
  edges:
    - type: IN_COLUMN
      from: first_item
      to: went_well
    - forEach: members
      when: "item == 'Alice'"
      type: AUTHOR
      from: first_item
      to: "member_{item}"
`);

    const collab = new InMemoryCollabBackend();
    const session = await Workspace.open("retro-live-42", {
      schema: wsType.schema,
      collab,
    });

    const result = await session.seedTemplate(wsType, {
      sprint: 42,
      members: ["Alice", "Bob"],
    });

    expect(result.applied).toBe(7); // 2 columns + 2 persons + 1 item + 2 edges
    const snap = session.snapshot();
    expect(snap.nodes).toHaveLength(5);
    expect(snap.edges).toHaveLength(2);

    const wentWell = snap.nodes.find((n) => n.properties.title === "Went well (Sprint 42)");
    expect(wentWell).toBeDefined();

    const firstItem = snap.nodes.find((n) => n.type === "Item");
    expect(firstItem?.properties.body).toBe("First note from Sprint 42");
    expect(firstItem?.properties.votes).toBe(1);

    // CRDT text field verification
    expect(session.collabText(firstItem!.id, "body").toString()).toBe(
      "First note from Sprint 42",
    );

    await session.close();
  });
});

