import { createServer } from "node:net";
import { CollabError } from "@collabnode/collab";
import { parseSchemaDocument } from "@collabnode/schema";
import { afterEach, describe, expect, it } from "vitest";
import { HocuspocusCollabBackend } from "../src/backend.ts";
import { ensureHocuspocus, stopHocuspocus } from "../src/server.ts";
import { hocuspocusUrl } from "../src/url.ts";
import type { Server } from "@hocuspocus/server";

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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("HocuspocusCollabBackend", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await stopHocuspocus(server);
    server = undefined;
  });

  it("replicates upserts to a second handle on the same document", async () => {
    const port = await freePort();
    server = await ensureHocuspocus(port);
    expect(server).toBeDefined();
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });
    const a = await backend.open(undefined, schema);
    const seen: string[] = [];
    const b = await backend.open(a.id, schema);
    b.graph.subscribe((snapshot) => {
      const title = snapshot.nodes[0]?.properties.title;
      if (typeof title === "string") {
        seen.push(title);
      }
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Hello" },
      meta: {},
    });
    await waitFor(() => b.graph.snapshot().nodes.length === 1);
    expect(b.graph.snapshot().nodes).toHaveLength(1);
    expect(seen).toContain("Hello");
    await a.close();
    await b.close();
  }, 20_000);

  it("rejects a hash mismatch", async () => {
    const port = await freePort();
    server = await ensureHocuspocus(port);
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });
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
    await a.close();
  }, 20_000);

  it("joins a document that already has many nodes", async () => {
    const port = await freePort();
    server = await ensureHocuspocus(port);
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });
    const a = await backend.open(undefined, schema);
    const count = 250;
    for (let i = 0; i < count; i += 1) {
      a.graph.apply({
        kind: "upsertNode",
        id: `t${i}`,
        type: "Task",
        properties: { title: `Task ${i}` },
        meta: {},
      });
    }
    expect(a.graph.snapshot().nodes).toHaveLength(count);
    const b = await backend.open(a.id, schema);
    await waitFor(() => b.graph.snapshot().nodes.length === count, 15_000);
    expect(b.graph.snapshot().nodes).toHaveLength(count);
    await a.close();
    await b.close();
  }, 30_000);

  it("replicates text properties through the graph snapshot", async () => {
    const notes = parseSchemaDocument(`
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
    const port = await freePort();
    server = await ensureHocuspocus(port);
    const backend = new HocuspocusCollabBackend({ url: hocuspocusUrl(port) });
    const a = await backend.open(undefined, notes);
    const b = await backend.open(a.id, notes);
    const graphTicks: number[] = [];
    b.graph.subscribe(() => {
      graphTicks.push(Date.now());
    });
    a.graph.apply({
      kind: "upsertNode",
      id: "n1",
      type: "Note",
      properties: { title: "Log" },
      meta: {},
    });
    await waitFor(() => b.graph.snapshot().nodes.length === 1);
    await a.graph.ensureCollab("n1", "Note");
    await b.graph.ensureCollab("n1", "Note");
    const ticksAfterUpsert = graphTicks.length;
    a.graph.collabText("n1", "body").insert(0, "hello");
    await waitFor(() => b.graph.collabText("n1", "body").toString() === "hello");
    expect(b.graph.collabText("n1", "body").toString()).toBe("hello");
    expect(b.graph.snapshot().nodes[0]?.properties.body).toBe("hello");
    await waitFor(() => graphTicks.length > ticksAfterUpsert);
    await a.close();
    await b.close();
  }, 20_000);
});

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for Hocuspocus replication");
}
