import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { buildTools, toAgentTools, createGraphMcpServer, generateResources, toolName } from "../src/index.ts";

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
`);

describe("schema-driven MCP catalog", () => {
  it("upserts via generated tools and is visible to a second peer", async () => {
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const peer = await CollabSession.open(host.id, {
      schema,
      collab,
      graph: new InMemoryGraphStore(),
      actorId: "peer",
    });

    const tools = buildTools(schema, host, "memory");
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_history");
    expect(names).toContain("graph_get");
    expect(names).toContain("graph_search");
    expect(names).toContain("graph_list");
    expect(names).toContain("graph_changes");
    expect(names).toContain("graph_actors");
    expect(names).toContain("graph_neighbors");
    expect(names).toContain("graph_snapshot");
    expect(tools.find((tool) => tool.name === "graph_get")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "graph_delete_node")?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(names).toContain(toolName("upsert_node", "Task"));
    expect(names).toContain(toolName("upsert_edge", "ASSIGNED_TO"));

    const upsert = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const created = await upsert.handler({ title: "Ship DSL", status: "doing", estimate: 3 });
    expect(created.isError).toBeFalsy();
    const payload = JSON.parse(created.content[0]!.text) as { id: string };
    expect(payload.id).toHaveLength(32);

    const patched = await upsert.handler({ id: payload.id, title: "Ship DSL" });
    expect(patched.isError).toBeFalsy();
    const after = host.snapshot().nodes.find((record) => record.id === payload.id);
    expect(after?.properties).toEqual({ title: "Ship DSL", status: "doing", estimate: 3 });

    const rows = await peer.query("MATCH (n:Task) RETURN n");
    expect(rows.rows).toHaveLength(1);

    const resources = generateResources(schema, host);
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        "collabnode://schema",
        "collabnode://snapshot",
        "collabnode://guidelines/node/Task",
        "collabnode://guidelines/edge/ASSIGNED_TO",
      ]),
    );

    expect(() => createGraphMcpServer(host, { graphKind: "memory" })).not.toThrow();

    await host.close();
    await peer.close();
  });

  it("treats upsert_node args as a patch and honors null clears", async () => {
    const host = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const upsert = buildTools(schema, host, "memory").find((tool) => tool.name === "upsert_node_Task")!;
    const created = await upsert.handler({ title: "Ship DSL", status: "doing", estimate: 3 });
    const payload = JSON.parse(created.content[0]!.text) as { id: string };

    expect(() => upsert.inputSchema.parse({ status: "done" })).toThrow();
    const statusPatch = upsert.inputSchema.parse({ id: payload.id, status: "done" }) as Record<
      string,
      unknown
    >;
    const statusResult = await upsert.handler(statusPatch);
    expect(statusResult.isError).toBeFalsy();
    expect(host.snapshot().nodes.find((record) => record.id === payload.id)?.properties).toEqual({
      title: "Ship DSL",
      status: "done",
      estimate: 3,
    });

    const cleared = upsert.inputSchema.parse({
      id: payload.id,
      title: "Ship DSL",
      estimate: null,
    }) as Record<string, unknown>;
    const clearResult = await upsert.handler(cleared);
    expect(clearResult.isError).toBeFalsy();
    const after = host.snapshot().nodes.find((record) => record.id === payload.id);
    expect(after?.properties).toEqual({ title: "Ship DSL", status: "done" });
    expect(after?.properties).not.toHaveProperty("estimate");

    await host.close();
  });

  it("does not accept derived fields on upsert tools and computes them server-side", async () => {
    const derivedSchema = parseSchemaDocument(`
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
      uncertainty:
        type: number
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    const host = await CollabSession.open(undefined, {
      schema: derivedSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const upsert = buildTools(derivedSchema, host, "memory").find(
      (tool) => tool.name === "upsert_node_Feature",
    )!;
    const created = await upsert.handler({
      title: "Checkout",
      complexity: 3,
      uncertainty: 4,
      effortWeight: 99,
    });
    expect(created.isError).toBeFalsy();
    const payload = JSON.parse(created.content[0]!.text) as {
      id: string;
      created: boolean;
      properties: { effortWeight?: number };
    };
    expect(payload.created).toBe(true);
    expect(payload.properties.effortWeight).toBe(5.4);
    const node = host.snapshot().nodes.find((record) => record.id === payload.id);
    expect(node?.properties.effortWeight).toBe(5.4);
    expect(node?.properties).not.toEqual(expect.objectContaining({ effortWeight: 99 }));
    await host.close();
  });

  it("reads persisted history through graph_history", async () => {
    const tracked = parseSchemaDocument(`
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
      estimate:
        type: number
`);
    const host = await CollabSession.open(undefined, {
      schema: tracked,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "ada",
    });
    const upsert = buildTools(tracked, host, "memory").find((tool) => tool.name === "upsert_node_Task")!;
    const created = await upsert.handler({ title: "Ship", estimate: 2 });
    const payload = JSON.parse(created.content[0]!.text) as { id: string };
    await upsert.handler({ id: payload.id, estimate: 4 });
    const historyTool = buildTools(tracked, host, "memory").find((tool) => tool.name === "graph_history")!;
    const listed = await historyTool.handler({ id: payload.id });
    const payloadHistory = JSON.parse(listed.content[0]!.text) as {
      entries: Array<{
        actorId: string;
        changes?: Array<{ field: string; before: unknown; after: unknown }>;
      }>;
    };
    const entries = payloadHistory.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((entry) => entry.actorId === "ada")).toBe(true);
    expect(
      entries.some((entry) =>
        entry.changes?.some((diff) => diff.field === "estimate" && diff.before === 2 && diff.after === 4),
      ),
    ).toBe(true);
    await host.close();
  });
});


const readSchema = parseSchemaDocument(`
name: IdeaBoard
version: 1
config:
  schemaId: idea-board
  tags:
    enabled: true
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      description:
        type: string
    ui:
      label: "{title}"
  Task:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
      notes:
        type: string
    ui:
      label: "{title}"
  Person:
    properties:
      name:
        type: string
        required: true
    ui:
      label: "{name}"
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    ui:
      label: assigned
  PART_OF:
    from: [Task]
    to: [Feature]
`);

function parseText(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("MCP read tools", () => {


  it("gets a node with incident edge ids/types/labels and an edge with endpoints", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(readSchema, host, "memory");
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const upsertPerson = tools.find((tool) => tool.name === "upsert_node_Person")!;
    const upsertAssigned = tools.find((tool) => tool.name === "upsert_edge_ASSIGNED_TO")!;
    const get = tools.find((tool) => tool.name === "graph_get")!;

    const task = JSON.parse((await upsertTask.handler({ title: "Ship" })).content[0]!.text) as { id: string };
    const person = JSON.parse((await upsertPerson.handler({ name: "Ada" })).content[0]!.text) as { id: string };
    const edge = JSON.parse(
      (await upsertAssigned.handler({ from: task.id, to: person.id })).content[0]!.text,
    ) as { id: string };

    const nodeGot = await get.handler({ id: task.id });
    expect(nodeGot.isError).toBeFalsy();
    const nodePayload = parseText(nodeGot) as {
      kind: string;
      node: { id: string; type: string; label: string };
      incident: Array<{ id: string; type: string; label: string; from: string; to: string }>;
    };
    expect(nodePayload.kind).toBe("node");
    expect(nodePayload.node).toMatchObject({ id: task.id, type: "Task", label: "Ship" });
    expect(nodePayload.incident).toEqual([
      { id: edge.id, type: "ASSIGNED_TO", label: "assigned", from: task.id, to: person.id },
    ]);

    const edgeGot = await get.handler({ id: edge.id });
    expect(edgeGot.isError).toBeFalsy();
    const edgePayload = parseText(edgeGot) as {
      kind: string;
      edge: { id: string; type: string; label: string };
      incident: Array<{ id: string; type?: string; label?: string }>;
    };
    expect(edgePayload.kind).toBe("edge");
    expect(edgePayload.edge).toMatchObject({ id: edge.id, type: "ASSIGNED_TO", label: "assigned" });
    expect(edgePayload.incident).toEqual([
      { id: task.id, type: "Task", label: "Ship" },
      { id: person.id, type: "Person", label: "Ada" },
    ]);

    const missing = await get.handler({ id: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("unknown id");

    await host.close();
  });


  it("searches string properties and tags, filters by type/tag, and truncates values to 240 chars", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(readSchema, host, "memory");
    const upsertFeature = tools.find((tool) => tool.name === "upsert_node_Feature")!;
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const search = tools.find((tool) => tool.name === "graph_search")!;
    const longNotes = "x".repeat(300);

    await upsertFeature.handler({ title: "Checkout", description: "Pay flow", tags: ["rfp", "q3"] });
    await upsertTask.handler({ title: "Wire card", notes: longNotes, tags: ["q3"] });
    await upsertTask.handler({ title: "Unrelated", notes: "nope", tags: ["mobile"] });

    const byText = parseText(await search.handler({ q: "pay" })) as {
      nodes: Array<{ type: string; properties: Record<string, unknown> }>;
    };
    expect(byText.nodes).toHaveLength(1);
    expect(byText.nodes[0]?.type).toBe("Feature");

    const byTagSubstring = parseText(await search.handler({ q: "rfp" })) as {
      nodes: Array<{ type: string }>;
    };
    expect(byTagSubstring.nodes.map((node) => node.type)).toEqual(["Feature"]);

    const tagged = parseText(await search.handler({ q: "q3", tag: "q3" })) as {
      nodes: Array<{ type: string }>;
    };
    expect(tagged.nodes.map((node) => node.type).sort()).toEqual(["Feature", "Task"]);

    await upsertFeature.handler({ title: "Cased", tags: ["RFP"] });
    const cased = parseText(await search.handler({ tag: "rfp" })) as {
      nodes: Array<{ properties: { title?: string } }>;
    };
    expect(cased.nodes.map((node) => node.properties.title).sort()).toEqual(["Cased", "Checkout"]);

    const typed = parseText(await search.handler({ q: "q3", types: ["Task"], tag: "q3" })) as {
      nodes: Array<{
        type: string;
        properties: { notes?: { truncated: true; length: number; text: string } };
      }>;
    };
    expect(typed.nodes).toHaveLength(1);
    expect(typed.nodes[0]?.type).toBe("Task");
    expect(typed.nodes[0]?.properties.notes).toEqual({
      truncated: true,
      length: 300,
      text: "x".repeat(240),
    });

    const emptyTypes = parseText(await search.handler({ q: "pay", types: [] })) as {
      nodes: Array<{ type: string }>;
    };
    expect(emptyTypes.nodes).toHaveLength(1);
    expect(emptyTypes.nodes[0]?.type).toBe("Feature");

    const limited = parseText(await search.handler({ q: "q3", limit: 1 })) as { nodes: unknown[] };
    expect(limited.nodes).toHaveLength(1);

    const buried = `prefix-${"z".repeat(240)}-unique-token-tail`;
    await upsertTask.handler({ title: "Buried", notes: buried, tags: ["nfr"] });
    const snippet = parseText(await search.handler({ q: "unique-token" })) as {
      nodes: Array<{ properties: { notes?: { truncated: true; match?: string } } }>;
    };
    expect(snippet.nodes[0]?.properties.notes?.truncated).toBe(true);
    expect(snippet.nodes[0]?.properties.notes?.match).toContain("unique-token");

    await host.close();
  });


  it("defaults search limit to 20 and clamps to 100", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const upsert = buildTools(readSchema, host, "memory").find((tool) => tool.name === "upsert_node_Feature")!;
    const search = buildTools(readSchema, host, "memory").find((tool) => tool.name === "graph_search")!;
    for (let i = 0; i < 101; i++) {
      await upsert.handler({ title: `Hit ${i}`, description: "shared-needle" });
    }
    const byDefault = parseText(await search.handler({ q: "shared-needle" })) as { nodes: unknown[] };
    expect(byDefault.nodes).toHaveLength(20);
    const clamped = parseText(await search.handler({ q: "shared-needle", limit: 500 })) as { nodes: unknown[] };
    expect(clamped.nodes).toHaveLength(100);
    await host.close();
  });


  it("returns one-hop neighbors filtered by edge type and direction", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(readSchema, host, "memory");
    const upsertFeature = tools.find((tool) => tool.name === "upsert_node_Feature")!;
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const upsertPerson = tools.find((tool) => tool.name === "upsert_node_Person")!;
    const upsertAssigned = tools.find((tool) => tool.name === "upsert_edge_ASSIGNED_TO")!;
    const upsertPartOf = tools.find((tool) => tool.name === "upsert_edge_PART_OF")!;
    const neighbors = tools.find((tool) => tool.name === "graph_neighbors")!;

    const feature = JSON.parse((await upsertFeature.handler({ title: "Checkout" })).content[0]!.text) as {
      id: string;
    };
    const task = JSON.parse((await upsertTask.handler({ title: "Ship" })).content[0]!.text) as { id: string };
    const person = JSON.parse((await upsertPerson.handler({ name: "Ada" })).content[0]!.text) as { id: string };
    await upsertAssigned.handler({ from: task.id, to: person.id });
    await upsertPartOf.handler({ from: task.id, to: feature.id });

    const all = parseText(await neighbors.handler({ id: task.id })) as {
      neighbors: Array<{ direction: string; edge: { type: string }; node: { id: string } }>;
    };
    expect(all.neighbors).toHaveLength(2);
    expect(all.neighbors.map((row) => row.direction)).toEqual(["out", "out"]);

    expect(all.neighbors.map((row) => row.edge.type).sort()).toEqual(["ASSIGNED_TO", "PART_OF"]);

    const assigned = parseText(await neighbors.handler({ id: task.id, edgeTypes: ["ASSIGNED_TO"] })) as {
      neighbors: Array<{ node: { id: string; label: string } }>;
    };
    expect(assigned.neighbors).toHaveLength(1);
    expect(assigned.neighbors[0]?.node).toMatchObject({ id: person.id, label: "Ada" });

    const unspecifiedTypes = parseText(await neighbors.handler({ id: task.id, edgeTypes: [] })) as {
      neighbors: unknown[];
    };
    expect(unspecifiedTypes.neighbors).toHaveLength(2);

    const capped = parseText(await neighbors.handler({ id: task.id, limit: 1 })) as {
      neighbors: unknown[];
      truncated?: boolean;
    };
    expect(capped.neighbors).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const inbound = parseText(await neighbors.handler({ id: person.id, direction: "in" })) as {
      neighbors: Array<{ direction: string; node: { id: string } }>;
    };
    expect(inbound.neighbors).toEqual([expect.objectContaining({ direction: "in", node: expect.objectContaining({ id: task.id }) })]);

    const outboundFromPerson = parseText(await neighbors.handler({ id: person.id, direction: "out" })) as {
      neighbors: unknown[];
    };
    expect(outboundFromPerson.neighbors).toEqual([]);

    const missing = await neighbors.handler({ id: "missing" });
    expect(missing.isError).toBe(true);

    const longBody = "n".repeat(300);
    const longFeature = JSON.parse(
      (await upsertFeature.handler({ title: "Long", description: longBody })).content[0]!.text,
    ) as { id: string };
    await upsertPartOf.handler({ from: task.id, to: longFeature.id });
    const compactHop = parseText(await neighbors.handler({ id: task.id, edgeTypes: ["PART_OF"] })) as {
      neighbors: Array<{ node: { id: string; properties: { description?: unknown } } }>;
    };
    const longHop = compactHop.neighbors.find((row) => row.node.id === longFeature.id);
    expect(longHop?.node.properties.description).toEqual({
      truncated: true,
      length: 300,
      text: "n".repeat(240),
    });
    const full = parseText(await tools.find((tool) => tool.name === "graph_get")!.handler({ id: longFeature.id })) as {
      node: { properties: { description?: string } };
    };
    expect(full.node.properties.description).toBe(longBody);

    await host.close();
  });


  it("truncates long snapshot strings unless includeText is true, and filters by type", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(readSchema, host, "memory");
    const upsertFeature = tools.find((tool) => tool.name === "upsert_node_Feature")!;
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const upsertPerson = tools.find((tool) => tool.name === "upsert_node_Person")!;
    const upsertAssigned = tools.find((tool) => tool.name === "upsert_edge_ASSIGNED_TO")!;
    const snapshot = tools.find((tool) => tool.name === "graph_snapshot")!;
    const longNotes = "y".repeat(300);

    const feature = JSON.parse((await upsertFeature.handler({ title: "Checkout" })).content[0]!.text) as {
      id: string;
    };
    const task = JSON.parse((await upsertTask.handler({ title: "Ship", notes: longNotes })).content[0]!.text) as {
      id: string;
    };
    const person = JSON.parse((await upsertPerson.handler({ name: "Ada" })).content[0]!.text) as { id: string };
    await upsertAssigned.handler({ from: task.id, to: person.id });

    const truncated = parseText(await snapshot.handler({})) as {
      nodes: Array<{ id: string; type: string; properties: Record<string, unknown> }>;
      edges: unknown[];
    };
    expect(truncated.nodes).toHaveLength(3);
    const taskNode = truncated.nodes.find((node) => node.id === task.id);
    expect(taskNode?.properties.notes).toEqual({ truncated: true, length: 300 });
    expect(taskNode?.properties.title).toBe("Ship");

    const full = parseText(await snapshot.handler({ includeText: true })) as {
      nodes: Array<{ id: string; properties: Record<string, unknown> }>;
    };
    expect(full.nodes.find((node) => node.id === task.id)?.properties.notes).toBe(longNotes);

    const featuresOnly = parseText(await snapshot.handler({ types: ["Feature"] })) as {
      nodes: Array<{ type: string; id: string }>;
      edges: unknown[];
    };
    expect(featuresOnly.nodes.map((node) => node.id)).toEqual([feature.id]);
    expect(featuresOnly.edges).toEqual([]);

    const assignedSlice = parseText(await snapshot.handler({ types: ["ASSIGNED_TO"] })) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ type: string }>;
    };
    expect(assignedSlice.edges.map((edge) => edge.type)).toEqual(["ASSIGNED_TO"]);
    expect(assignedSlice.nodes.map((node) => node.id).sort()).toEqual([person.id, task.id].sort());

    const emptyTypes = parseText(await snapshot.handler({ types: [] })) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(emptyTypes.nodes).toHaveLength(3);

    const resource = generateResources(readSchema, host).find((item) => item.uri === "collabnode://snapshot")!;
    const resourceSnap = JSON.parse(await resource.read()) as {
      nodes: Array<{ id: string; properties: Record<string, unknown> }>;
    };
    expect(resourceSnap.nodes.find((node) => node.id === task.id)?.properties.notes).toEqual({
      truncated: true,
      length: 300,
    });

    await host.close();
  });


  it("falls back to title/name and lowercased edge types when ui.label is missing", async () => {
    const host = await CollabSession.open(undefined, {
      schema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(schema, host, "memory");
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const upsertPerson = tools.find((tool) => tool.name === "upsert_node_Person")!;
    const upsertAssigned = tools.find((tool) => tool.name === "upsert_edge_ASSIGNED_TO")!;
    const get = tools.find((tool) => tool.name === "graph_get")!;

    const task = JSON.parse((await upsertTask.handler({ title: "Ship DSL" })).content[0]!.text) as { id: string };
    const person = JSON.parse((await upsertPerson.handler({ name: "Ada" })).content[0]!.text) as { id: string };
    const edge = JSON.parse(
      (await upsertAssigned.handler({ from: task.id, to: person.id })).content[0]!.text,
    ) as { id: string };

    const nodeGot = parseText(await get.handler({ id: task.id })) as {
      node: { label: string };
      incident: Array<{ label: string }>;
    };
    expect(nodeGot.node.label).toBe("Ship DSL");
    expect(nodeGot.incident[0]?.label).toBe("assigned to");

    const personGot = parseText(await get.handler({ id: person.id })) as { node: { label: string } };
    expect(personGot.node.label).toBe("Ada");

    const edgeGot = parseText(await get.handler({ id: edge.id })) as { edge: { label: string } };
    expect(edgeGot.edge.label).toBe("assigned to");

    await host.close();
  });

  it("treats collab fields as ordinary properties on the existing tools", async () => {
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
    const collab = new InMemoryCollabBackend();
    const host = await CollabSession.open(undefined, {
      schema: notes,
      collab,
      graph: new InMemoryGraphStore(),
    });
    const peer = await CollabSession.open(host.id, {
      schema: notes,
      collab,
      graph: new InMemoryGraphStore(),
    });
    const tools = buildTools(notes, host, "memory");
    expect(tools.map((tool) => tool.name)).toContain("upsert_node_Note");
    expect(tools.map((tool) => tool.name).some((name) => name.includes("collab"))).toBe(false);

    const upsert = tools.find((tool) => tool.name === "upsert_node_Note")!;
    const created = await upsert.handler({ title: "Runbook", body: "# Steps\n" });
    const payload = JSON.parse(created.content[0]!.text) as { id: string };
    expect(payload.id).toBeTruthy();
    expect(peer.snapshot().nodes[0]?.properties.body).toBe("# Steps\n");

    const snapshot = tools.find((tool) => tool.name === "graph_snapshot")!;
    const snap = JSON.parse((await snapshot.handler({})).content[0]!.text) as {
      nodes: Array<{ properties: Record<string, unknown> }>;
    };
    expect(snap.nodes[0]?.properties.body).toBe("# Steps\n");

    const resources = generateResources(notes, host);
    const schemaText = await resources.find((resource) => resource.uri === "collabnode://schema")!.read();
    expect(schemaText).toContain('"body"');
    expect(schemaText).toContain('"text"');

    await host.close();
    await peer.close();
  });

  it("lists nodes, accepts search without q, and rejects mutating queries and missing deletes", async () => {
    const host = await CollabSession.open(undefined, {
      schema: readSchema,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });
    const tools = buildTools(readSchema, host, "memory");
    const upsertFeature = tools.find((tool) => tool.name === "upsert_node_Feature")!;
    const upsertTask = tools.find((tool) => tool.name === "upsert_node_Task")!;
    const list = tools.find((tool) => tool.name === "graph_list")!;
    const search = tools.find((tool) => tool.name === "graph_search")!;
    const query = tools.find((tool) => tool.name === "graph_query")!;
    const del = tools.find((tool) => tool.name === "graph_delete_node")!;
    const get = tools.find((tool) => tool.name === "graph_get")!;
    const upsertAssigned = tools.find((tool) => tool.name === "upsert_edge_ASSIGNED_TO")!;
    const upsertPerson = tools.find((tool) => tool.name === "upsert_node_Person")!;

    await upsertFeature.handler({ title: "Checkout" });
    const task = JSON.parse((await upsertTask.handler({ title: "Ship" })).content[0]!.text) as { id: string };
    const person = JSON.parse((await upsertPerson.handler({ name: "Ada" })).content[0]!.text) as { id: string };

    expect(() => search.inputSchema.parse({ tag: "q3" })).not.toThrow();
    const listed = parseText(await list.handler({ types: ["Task"] })) as {
      total: number;
      nodes: Array<{ type: string; label: string }>;
    };
    expect(listed.total).toBe(1);
    expect(listed.nodes[0]).toMatchObject({ type: "Task", label: "Ship" });

    const prefixed = parseText(await get.handler({ id: task.id.slice(0, 8) })) as { kind: string };
    expect(prefixed.kind).toBe("node");

    const linked = await upsertAssigned.handler({
      from: { type: "Task", title: "Ship" },
      to: { type: "Person", name: "Ada" },
    });
    expect(linked.isError).toBeFalsy();
    const linkPayload = JSON.parse(linked.content[0]!.text) as { from: string; to: string; created: boolean };
    expect(linkPayload).toMatchObject({ from: task.id, to: person.id, created: true });

    const mutating = await query.handler({ cypher: "CREATE (n:Task)" });
    expect(mutating.isError).toBe(true);
    expect(mutating.content[0]!.text).toContain("read-only");

    const missing = await del.handler({ id: "missing" });
    expect(missing.isError).toBe(true);

    const removed = parseText(await del.handler({ id: task.id })) as {
      existed: boolean;
      cascadedEdges: number;
    };
    expect(removed).toMatchObject({ existed: true, cascadedEdges: 1 });

    await host.close();
  });

  it("converts BoundTool[] to in-process AgentTool map via toAgentTools()", async () => {
    const collab = new InMemoryCollabBackend();
    const session = await CollabSession.open(undefined, {
      schema,
      collab,
    });

    const bound = buildTools(schema, session, "memory");
    const agentTools = toAgentTools(bound);

    expect(agentTools.upsert_node_Task).toBeDefined();
    expect(agentTools.graph_list).toBeDefined();
    expect(agentTools.graph_apply_batch).toBeDefined();
    expect(agentTools.graph_diff_since).toBeDefined();

    // Execute in-process tool directly
    const res = await agentTools.upsert_node_Task.execute({ title: "In-Process Agent Task" });
    expect(res.id).toBeDefined();
    expect(res.created).toBe(true);

    const snap = session.snapshot();
    expect(snap.nodes.length).toBe(1);
    expect(snap.nodes[0].properties.title).toBe("In-Process Agent Task");

    await session.close();
  });
});

