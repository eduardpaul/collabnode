import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { CollabError, InMemoryCollabBackend } from "../src/index.ts";

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

describe("InMemoryCollabBackend", () => {
  it("replicates upserts to a second handle on the same document", async () => {
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, schema);
    const seen: string[] = [];
    const b = await backend.open(a.id, schema);
    b.graph.subscribe((snapshot) => {
      seen.push(snapshot.nodes[0]?.properties.title as string);
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Hello" },
      meta: {},
    });
    expect(b.graph.snapshot().nodes).toHaveLength(1);
    expect(seen).toEqual(["Hello"]);
    await a.close();
    await b.close();
  });

  it("rejects a hash mismatch", async () => {
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, schema);
    const other = parseSchemaDocument(`
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
      extra:
        type: string
`);
    await expect(backend.open(a.id, other)).rejects.toBeInstanceOf(CollabError);
  });

  it("keeps concurrent title and score patches on a per-key map", async () => {
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, schema);
    const b = await backend.open(a.id, schema);
    a.graph.apply({
      kind: "upsertNode",
      id: "f1",
      type: "Task",
      properties: { title: "Checkout", complexity: 2 },
      meta: {},
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "f1",
      type: "Task",
      properties: { title: "Ada title" },
      patch: ["title"],
      meta: {},
    });
    b.graph.apply({
      kind: "upsertNode",
      id: "f1",
      type: "Task",
      properties: { complexity: 4 },
      patch: ["complexity"],
      meta: {},
    });
    const node = b.graph.snapshot().nodes.find((record) => record.id === "f1");
    expect(node?.properties).toEqual({ title: "Ada title", complexity: 4 });
    await a.close();
    await b.close();
  });

  it("keeps concurrent history appends from two writers", async () => {
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, schema);
    const b = await backend.open(a.id, schema);
    a.graph.apply({
      kind: "upsertNode",
      id: "n1",
      type: "Task",
      properties: { title: "A" },
      meta: {},
      history: {
        opId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        op: "upsertNode",
        id: "n1",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:01.000Z",
        summary: "A",
      },
    });
    b.graph.apply({
      kind: "upsertNode",
      id: "n2",
      type: "Task",
      properties: { title: "B" },
      meta: {},
      history: {
        opId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        op: "upsertNode",
        id: "n2",
        type: "Task",
        actorId: "chidi",
        at: "2026-01-01T00:00:02.000Z",
        summary: "B",
      },
    });
    const hist = b.graph.history();
    expect(hist.map((entry) => entry.actorId).sort()).toEqual(["ada", "chidi"]);
    expect(hist.map((entry) => entry.id).sort()).toEqual(["n1", "n2"]);
    await a.close();
    await b.close();
  });
});

describe("historyLimit", () => {
  it("drops oldest history entries past the limit", async () => {
    const limited = parseSchemaDocument(`
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
`);
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, limited);
    for (const id of ["n1", "n2", "n3"]) {
      a.graph.apply({
        kind: "upsertNode",
        id,
        type: "Task",
        properties: { title: id },
        meta: {},
        history: {
          opId: id,
          op: "upsertNode",
          id,
          type: "Task",
          actorId: "ada",
          at: `2026-01-01T00:00:0${id.slice(1)}.000Z`,
          summary: id,
        },
      });
    }
    expect(a.graph.history().map((entry) => entry.id)).toEqual(["n2", "n3"]);
    await a.close();
  });

  it("drops oldest by at/opId when insert order disagrees", async () => {
    const limited = parseSchemaDocument(`
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
`);
    const backend = new InMemoryCollabBackend();
    const a = await backend.open(undefined, limited);
    a.graph.apply({
      kind: "upsertNode",
      id: "late",
      type: "Task",
      properties: { title: "late" },
      meta: {},
      history: {
        opId: "b",
        op: "upsertNode",
        id: "late",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:02.000Z",
      },
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "early",
      type: "Task",
      properties: { title: "early" },
      meta: {},
      history: {
        opId: "a",
        op: "upsertNode",
        id: "early",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:01.000Z",
      },
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "newest",
      type: "Task",
      properties: { title: "newest" },
      meta: {},
      history: {
        opId: "c",
        op: "upsertNode",
        id: "newest",
        type: "Task",
        actorId: "ada",
        at: "2026-01-01T00:00:03.000Z",
      },
    });
    expect(a.graph.history().map((entry) => entry.id)).toEqual(["late", "newest"]);
    await a.close();
  });
});
