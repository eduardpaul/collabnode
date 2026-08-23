import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { init, webJoinInfo } from "../src/index.ts";

const schema = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
nodes:
  Task:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
`);

describe("init", () => {
  it("starts an in-process session with an MCP fetch handler", async () => {
    const node = await init({
      schema,
      actorId: "api",
      collab: { kind: "memory" },
      graph: { kind: "memory" },
      mcp: true,
    });
    expect(node.documentId).toBeTruthy();
    expect(node.handleMcp).toBeTypeOf("function");
    const id = await node.session.upsertNode({ type: "Task", properties: { title: "From server" } });
    const rows = await node.session.query("MATCH (n:Task) RETURN n");
    expect(rows.rows).toHaveLength(1);
    expect(id).toHaveLength(32);
    await node.close();
  });

  it("joins a custom backend so two init() calls share the graph", async () => {
    const backend = new InMemoryCollabBackend();
    const host = await init({
      schema,
      actorId: "host",
      collab: { kind: "custom", backend },
      graph: { kind: "custom", store: new InMemoryGraphStore() },
      mcp: false,
    });
    const peer = await init({
      schema,
      actorId: "peer",
      documentId: host.documentId,
      collab: { kind: "custom", backend },
      graph: { kind: "custom", store: new InMemoryGraphStore() },
      mcp: false,
    });
    await host.session.upsertNode({ type: "Task", properties: { title: "Shared" } });
    const rows = await peer.session.query("MATCH (n:Task) RETURN n");
    expect(rows.rows).toHaveLength(1);
    await host.close();
    await peer.close();
  });

  it("records collab join metadata and refuses webJoinInfo for memory", async () => {
    const node = await init({
      schema,
      actorId: "api",
      collab: { kind: "memory" },
      graph: { kind: "memory" },
      mcp: false,
    });
    expect(node.collab).toEqual({ kind: "memory" });
    expect(() => webJoinInfo(node)).toThrow(/Fluid or Hocuspocus/);
    await node.close();
  });

  it("starts Hocuspocus and exposes webJoinInfo", async () => {
    const node = await init({
      schema,
      actorId: "api",
      collab: { kind: "hocuspocus", port: 19_234 },
      graph: { kind: "memory" },
      mcp: false,
    });
    expect(node.collab).toEqual({ kind: "hocuspocus", url: "ws://127.0.0.1:19234" });
    const join = webJoinInfo(node);
    expect(join.documentId).toBe(node.documentId);
    expect(join.collab.kind).toBe("hocuspocus");
    const id = await node.session.upsertNode({ type: "Task", properties: { title: "Hocuspocus" } });
    expect(id).toHaveLength(32);
    await node.close();
  }, 20_000);
});
