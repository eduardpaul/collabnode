import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { LoroCollabBackend, type LoroDocStore } from "../src/backend.ts";

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

const otherSchema = parseSchemaDocument(`
name: Other
version: 1
config:
  schemaId: other-board
nodes:
  Note:
    properties:
      body:
        type: string
`);

function task(id: string, title: string) {
  return {
    kind: "upsertNode" as const,
    id,
    type: "Task",
    properties: { title } as never,
    meta: {},
  };
}

function memoryStore(): LoroDocStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async load(id) {
      return blobs.get(id);
    },
    async save(id, bytes) {
      blobs.set(id, bytes);
    },
    async delete(id) {
      blobs.delete(id);
    },
  };
}

describe("LoroCollabBackend", () => {
  it("declares versioning, unlike the Yjs and Fluid backends", () => {
    expect(new LoroCollabBackend().capabilities).toEqual({
      namedDocuments: true,
      deletion: true,
      presence: true,
      versioning: true,
    });
  });

  it("is create-or-join on one id", async () => {
    const backend = new LoroCollabBackend();
    expect(await backend.exists("w1")).toBe(false);

    const a = await backend.open("w1", schema);
    a.graph.apply(task("t1", "One"));
    const b = await backend.open("w1", schema);

    expect(b.graph.snapshot().nodes).toHaveLength(1);
    expect(await backend.exists("w1")).toBe(true);
    await a.close();
    await b.close();
  });

  it("mints an id when asked for one", async () => {
    const backend = new LoroCollabBackend();
    const handle = await backend.open(undefined, schema);
    expect(handle.id).toMatch(/[0-9a-f-]{36}/);
    await handle.close();
  });

  it("refuses a document opened with a different schema", async () => {
    const backend = new LoroCollabBackend();
    const handle = await backend.open("w1", schema);
    await expect(backend.open("w1", otherSchema)).rejects.toThrow(/schemaId mismatch/);
    await handle.close();
  });

  it("reports peers to everyone in the room", async () => {
    const backend = new LoroCollabBackend();
    const a = await backend.open("w1", schema, { actorId: "ada" });
    const joins: string[] = [];
    a.presence().on("join", (peer) => joins.push(peer.actorId));

    const b = await backend.open("w1", schema, { actorId: "grace", peerKind: "agent" });
    expect(joins).toEqual(["grace"]);
    expect(a.presence().peers().map((p) => p.actorId)).toEqual(["ada", "grace"]);

    await b.close();
    expect(a.presence().peers().map((p) => p.actorId)).toEqual(["ada"]);
    await a.close();
  });

  it("empties the document for a handle still holding it after delete", async () => {
    const backend = new LoroCollabBackend();
    const handle = await backend.open("w1", schema);
    handle.graph.apply(task("t1", "One"));

    await backend.delete("w1");
    expect(handle.graph.snapshot().nodes).toEqual([]);
    expect(await backend.exists("w1")).toBe(false);
    await handle.close();
  });
});

describe("persistence", () => {
  it("round-trips a document, its history, and its versions through a store", async () => {
    const store = memoryStore();
    const first = new LoroCollabBackend({ store, persistDebounceMs: 0 });
    const handle = await first.open("w1", schema);
    handle.graph.applyBatch([
      {
        ...task("t1", "One"),
        history: {
          opId: "op-1",
          op: "upsertNode",
          id: "t1",
          type: "Task",
          actorId: "ada",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    const version = handle.graph.version!();
    handle.graph.apply(task("t2", "Two"));
    await handle.close();
    expect(store.blobs.has("w1")).toBe(true);

    // A different process: the store is all it has.
    const second = new LoroCollabBackend({ store, persistDebounceMs: 0 });
    const reopened = await second.open("w1", schema);
    expect(reopened.graph.snapshot().nodes).toHaveLength(2);
    expect(reopened.graph.history()).toHaveLength(1);
    // The version minted before the restart still names a point this document
    // can diff from — which is the whole reason to keep the history.
    expect(reopened.graph.diffSince!(version)).toEqual([
      { kind: "upsertNode", id: "t2", type: "Task", properties: { title: "Two" }, tags: [], meta: {} },
    ]);
    await reopened.close();
  });

  it("writes the final edit even when the debounce has not fired", async () => {
    const store = memoryStore();
    const backend = new LoroCollabBackend({ store, persistDebounceMs: 10_000 });
    const handle = await backend.open("w1", schema);
    handle.graph.apply(task("t1", "One"));
    await handle.close();

    const reopened = await new LoroCollabBackend({ store }).open("w1", schema);
    expect(reopened.graph.snapshot().nodes).toHaveLength(1);
    await reopened.close();
  });

  it("keeps a shallow store small, at the cost of old versions", async () => {
    const store = memoryStore();
    const backend = new LoroCollabBackend({ store, persistAs: "shallow", persistDebounceMs: 0 });
    const handle = await backend.open("w1", schema);
    for (let i = 0; i < 200; i += 1) {
      handle.graph.apply(task(`t${i}`, `Task ${i}`));
    }
    const early = handle.graph.version!();
    handle.graph.apply(task("last", "Last"));
    await handle.close();

    const reopened = await new LoroCollabBackend({ store }).open("w1", schema);
    expect(reopened.graph.snapshot().nodes).toHaveLength(201);
    expect(reopened.graph.diffSince!(early)).toBeUndefined();
    await reopened.close();
  });

  it("reports existence from the store, not just from memory", async () => {
    const store = memoryStore();
    const backend = new LoroCollabBackend({ store, persistDebounceMs: 0 });
    const handle = await backend.open("w1", schema);
    await handle.close();

    const fresh = new LoroCollabBackend({ store });
    expect(await fresh.exists("w1")).toBe(true);
    expect(await fresh.exists("nope")).toBe(false);

    await backend.delete("w1");
    expect(await fresh.exists("w1")).toBe(false);
  });
});
