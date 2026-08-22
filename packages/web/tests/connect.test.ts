import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { connect } from "../src/index.ts";

const yaml = `
name: TaskBoard
version: 1
config:
  schemaId: task-board
  changeTracking:
    enabled: true
    mode: last-write
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
`;

describe("connect", () => {
  it("joins a custom backend and sees host writes", async () => {
    const schema = parseSchemaDocument(yaml);
    const backend = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab: backend,
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const client = await connect({
      schema: JSON.stringify(host.schema),
      documentId: host.id,
      actorId: "browser",
      collab: { kind: "custom", backend },
    });

    const seen: string[] = [];
    const stop = client.session.onChange((_ops, snapshot) => {
      seen.push(...snapshot.nodes.map((node) => String(node.properties.title)));
    });

    await host.upsertNode({ type: "Task", properties: { title: "Draft Q3 plan" } });
    expect(client.session.snapshot().nodes).toHaveLength(1);
    expect(seen).toContain("Draft Q3 plan");

    const id = await client.session.upsertNode({
      type: "Task",
      properties: { title: "Review budget", status: "doing" },
    });
    const hosted = host.snapshot().nodes.find((node) => node.id === id);
    expect(hosted?.meta.updatedBy).toBe("browser");
    expect(hosted?.properties.status).toBe("doing");

    stop();
    await client.close();
    await host.close();
  });

  it("parses YAML text as schema", async () => {
    const schema = parseSchemaDocument(yaml);
    const backend = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab: backend,
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const client = await connect({
      schema: yaml,
      documentId: host.id,
      actorId: "tab",
      collab: { kind: "custom", backend },
    });
    expect(client.schema.schemaHash).toBe(schema.schemaHash);
    await client.close();
    await host.close();
  });

  it("rejects create-without-id", async () => {
    await expect(
      connect({
        schema: yaml,
        documentId: "",
        collab: { kind: "custom", backend: new InMemoryCollabBackend() },
      }),
    ).rejects.toThrow(/documentId/);
  });
});
