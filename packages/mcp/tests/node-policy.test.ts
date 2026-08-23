import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { parseWorkspaceTypeDocument, SchemaError } from "@collabnode/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTools, generatePrompts, generateResources } from "../src/index.ts";
import { resolveNodeAccess } from "@collabnode/schema";

const TYPE_YAML = `
type: incident
version: 1

schema:
  nodes:
    Incident:
      identity:
        from: [title]
      properties:
        title:
          type: string
          required: true
        status:
          type: enum
          values: [open, closed]
          default: open
    Decision:
      identity:
        from: [title]
      properties:
        title:
          type: string
          required: true
    PrivateNote:
      identity:
        from: [title]
      properties:
        title:
          type: string
          required: true
        body:
          type: string
  edges:
    DECIDED_ON:
      from: [Decision]
      to: [Incident]
    ANNOTATES:
      from: [PrivateNote]
      to: [Incident]
    RELATES_TO:
      from: [Incident]
      to: [Incident, Decision]

tools:
  named:
    log_note:
      description: Attach a private note
      creates: PrivateNote
      into: ANNOTATES
    record_decision:
      description: Record a decision
      creates: Decision
  agents:
    - role: triage
      actorId: triage-bot
    - role: reviewer
      actorId: reviewer-bot
      nodes:
        readOnly: [Decision]
        hidden: [PrivateNote]
    - role: observer
      actorId: observer-bot
      nodes:
        readOnly: ["*"]
`;

const wsType = parseWorkspaceTypeDocument(TYPE_YAML);
const schema = wsType.schema;

interface Seeded {
  session: CollabSession;
  incident: string;
  decision: string;
  note: string;
}

async function seed(): Promise<Seeded> {
  const session = await CollabSession.open(undefined, {
    schema,
    collab: new InMemoryCollabBackend(),
    graph: new InMemoryGraphStore(),
    actorId: "host",
  });
  const incident = await session.upsertNode({ type: "Incident", properties: { title: "Outage" } });
  const decision = await session.upsertNode({ type: "Decision", properties: { title: "Roll back" } });
  const note = await session.upsertNode({
    type: "PrivateNote",
    properties: { title: "Vendor call", body: "escalate to legal" },
  });
  await session.upsertEdge({ type: "DECIDED_ON", from: decision, to: incident });
  await session.upsertEdge({ type: "ANNOTATES", from: note, to: incident });
  return { session, incident, decision, note };
}

function toolsFor(session: CollabSession, agentRole: string) {
  return buildTools(schema, session, { policy: wsType.tools, agentRole, graphKind: "memory" });
}

function call(
  tools: ReturnType<typeof buildTools>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`no tool ${name}; have ${tools.map((entry) => entry.name).join(", ")}`);
  }
  return tool.handler(args);
}

async function json<T>(result: Promise<{ content: Array<{ text: string }>; isError?: boolean }>) {
  const settled = await result;
  return JSON.parse(settled.content[0]!.text) as T;
}

describe("agent node policy", () => {
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await seed();
  });

  it("parses readOnly and hidden lists and rejects unknown type names", () => {
    const reviewer = wsType.tools?.agents?.find((agent) => agent.role === "reviewer");
    expect(reviewer?.nodes).toEqual({ readOnly: ["Decision"], hidden: ["PrivateNote"] });

    expect(() =>
      parseWorkspaceTypeDocument(`
type: broken
version: 1
schema:
  nodes:
    Thing:
      properties:
        name: { type: string }
tools:
  agents:
    - role: ghost
      actorId: ghost-bot
      nodes:
        hidden: [Nope]
`),
    ).toThrow(SchemaError);
  });

  it("expands '*' to every node type and lets hidden win over readOnly", () => {
    const observer = resolveNodeAccess(schema, wsType.tools, "observer");
    expect(observer.canWrite("Incident")).toBe(false);
    expect(observer.canWrite("PrivateNote")).toBe(false);
    expect(observer.isHidden("PrivateNote")).toBe(false);

    const reviewer = resolveNodeAccess(schema, wsType.tools, "reviewer-bot");
    expect(reviewer.readOnly.has("Decision")).toBe(true);
    expect(reviewer.hidden.has("PrivateNote")).toBe(true);
    expect(reviewer.hiddenEdges.has("ANNOTATES")).toBe(true);
    expect(reviewer.hiddenEdges.has("DECIDED_ON")).toBe(false);
  });

  it("gives an unrestricted role the whole surface", () => {
    const names = toolsFor(seeded.session, "triage").map((tool) => tool.name);
    expect(names).toContain("upsert_node_Incident");
    expect(names).toContain("upsert_node_Decision");
    expect(names).toContain("upsert_node_PrivateNote");
    expect(names).toContain("graph_query");
    expect(names).toContain("log_note");
  });

  it("drops write tools for read-only and hidden types", () => {
    const names = toolsFor(seeded.session, "reviewer").map((tool) => tool.name);
    expect(names).toContain("upsert_node_Incident");
    expect(names).not.toContain("upsert_node_Decision");
    expect(names).not.toContain("upsert_node_PrivateNote");
    expect(names).not.toContain("upsert_edge_ANNOTATES");
    // DECIDED_ON runs from Decision, which is read-only: rewiring a node is
    // touching it, so the edge tool goes too.
    expect(names).not.toContain("upsert_edge_DECIDED_ON");
    // Named tools inherit the policy of what they write.
    expect(names).not.toContain("log_note");
    expect(names).not.toContain("record_decision");
    // Cypher cannot be scoped to a view, so a concealing role does not get it.
    expect(names).not.toContain("graph_query");
  });

  it("keeps every read tool for a fully read-only role", () => {
    const names = toolsFor(seeded.session, "observer").map((tool) => tool.name);
    expect(names).not.toContain("upsert_node_Incident");
    expect(names).not.toContain("upsert_edge_DECIDED_ON");
    // Nothing is writable, so the delete tools are not offered at all.
    expect(names).not.toContain("graph_delete_node");
    expect(names).not.toContain("graph_delete_edge");
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_list");
    expect(names).toContain("graph_search");
  });

  it("refuses deletes of read-only nodes and allows them elsewhere", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const refused = await call(reviewer, "graph_delete_node", { id: seeded.decision });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("read-only");
    expect(seeded.session.snapshot().nodes.some((n) => n.id === seeded.decision)).toBe(true);

    const allowed = await call(reviewer, "graph_delete_node", { id: seeded.incident });
    expect(allowed.isError).toBeFalsy();
  });

  it("refuses an edge whose endpoint is read-only, per instance", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    // RELATES_TO may run Incident -> Incident, so the tool exists; this call
    // aims it at a read-only Decision instead.
    const refused = await call(reviewer, "upsert_edge_RELATES_TO", {
      from: seeded.incident,
      to: seeded.decision,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("read-only");

    const second = await seeded.session.upsertNode({
      type: "Incident",
      properties: { title: "Follow-up" },
    });
    const allowed = await call(reviewer, "upsert_edge_RELATES_TO", {
      from: seeded.incident,
      to: second,
    });
    expect(allowed.isError).toBeFalsy();
  });

  it("still reads read-only types and marks them in graph_describe", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const listed = await json<{ nodes: Array<{ id: string; type: string }> }>(
      call(reviewer, "graph_list"),
    );
    expect(listed.nodes.map((node) => node.type)).toContain("Decision");

    const described = await json<{
      nodes: Record<string, { readOnly?: true }>;
    }>(call(reviewer, "graph_describe"));
    expect(described.nodes.Decision?.readOnly).toBe(true);
    expect(described.nodes.Incident?.readOnly).toBeUndefined();
    expect(described.nodes.PrivateNote).toBeUndefined();

    const contract = await json<{ reads: string[]; writes: string[] }>(
      call(reviewer, "graph_describe"),
    );
    expect(contract.reads).not.toContain("graph_query");
    expect(contract.writes.length).toBeGreaterThan(0);

    const observer = await json<{ reads: string[]; writes: string[] }>(
      call(toolsFor(seeded.session, "observer"), "graph_describe"),
    );
    expect(observer.reads).toContain("graph_query");
    expect(observer.writes).toEqual([]);
  });

  it("keeps hidden types out of every read", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");

    const listed = await json<{ nodes: Array<{ type: string }>; total: number }>(
      call(reviewer, "graph_list"),
    );
    expect(listed.nodes.map((node) => node.type)).not.toContain("PrivateNote");
    expect(listed.total).toBe(2);

    const asked = await json<{ nodes: Array<{ type: string }> }>(
      call(reviewer, "graph_list", { types: ["PrivateNote"] }),
    );
    expect(asked.nodes).toEqual([]);

    const found = await json<{ nodes: Array<{ type: string }> }>(
      call(reviewer, "graph_search", { q: "Vendor" }),
    );
    expect(found.nodes).toEqual([]);

    const snapshot = await json<{
      nodes: Array<{ type: string }>;
      edges: Array<{ type: string }>;
    }>(call(reviewer, "graph_snapshot"));
    expect(snapshot.nodes.map((node) => node.type)).not.toContain("PrivateNote");
    expect(snapshot.edges.map((edge) => edge.type)).not.toContain("ANNOTATES");

    const incident = await json<{ incident: Array<{ type: string }> }>(
      call(reviewer, "graph_get", { id: seeded.incident }),
    );
    expect(incident.incident.map((edge) => edge.type)).toEqual(["DECIDED_ON"]);

    const neighbors = await json<{ neighbors: Array<{ node: { type: string } }> }>(
      call(reviewer, "graph_neighbors", { id: seeded.incident, depth: 2 }),
    );
    expect(neighbors.neighbors.map((hop) => hop.node.type)).toEqual(["Decision"]);
  });

  it("answers a hidden id the way it answers an id that never existed", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const hidden = await call(reviewer, "graph_get", { id: seeded.note });
    const absent = await call(reviewer, "graph_get", { id: "0".repeat(32) });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0]!.text).toBe(`id: unknown id: ${seeded.note}`);
    expect(absent.content[0]!.text).toBe(`id: unknown id: ${"0".repeat(32)}`);

    // …and a prefix probe cannot use ambiguity to prove a hidden node is there.
    const prefix = await call(reviewer, "graph_get", { id: seeded.note.slice(0, 6) });
    expect(prefix.content[0]!.text).toBe(`id: unknown id: ${seeded.note.slice(0, 6)}`);
  });

  it("keeps hidden types out of prompts and resources", () => {
    const prompts = generatePrompts(schema, {
      documentId: seeded.session.id,
      type: wsType,
      agentRole: "reviewer",
    });
    const names = prompts.map((prompt) => prompt.name);
    expect(names).toContain("work-on-Incident");
    expect(names).not.toContain("work-on-Decision");
    expect(names).not.toContain("work-on-PrivateNote");
    expect(names).not.toContain("link-ANNOTATES");
    expect(prompts.map((prompt) => prompt.text).join("\n")).not.toContain("PrivateNote");

    const access = resolveNodeAccess(schema, wsType.tools, "reviewer");
    const resources = generateResources(schema, seeded.session, { access });
    expect(resources.map((resource) => resource.name)).not.toContain("guidelines-node-PrivateNote");
  });

  it("keeps hidden nodes out of resource payloads", async () => {
    const access = resolveNodeAccess(schema, wsType.tools, "reviewer");
    const resources = generateResources(schema, seeded.session, { access });
    const schemaText = await resources.find((resource) => resource.name === "schema")!.read();
    const snapshotText = await resources.find((resource) => resource.name === "snapshot")!.read();
    expect(schemaText).not.toContain("PrivateNote");
    expect(snapshotText).not.toContain("PrivateNote");
    expect(snapshotText).not.toContain("escalate to legal");
  });

  it("hides history and change events about hidden types", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const changes = await json<{ events: Array<{ type?: string }> }>(
      call(reviewer, "graph_changes"),
    );
    const types = changes.events.map((event) => event.type);
    expect(types).not.toContain("PrivateNote");
    expect(types).not.toContain("ANNOTATES");
  });
});

describe("agent node policy on graph_apply_batch", () => {
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await seed();
  });

  it("is offered only to a role that may write something", () => {
    expect(toolsFor(seeded.session, "reviewer").map((tool) => tool.name)).toContain(
      "graph_apply_batch",
    );
    expect(toolsFor(seeded.session, "observer").map((tool) => tool.name)).not.toContain(
      "graph_apply_batch",
    );
  });

  it("refuses a batch write to a read-only type", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const refused = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "upsertNode", type: "Decision", properties: { title: "Sneak in" } }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("read-only");
    expect(
      seeded.session.snapshot().nodes.some((node) => node.properties.title === "Sneak in"),
    ).toBe(false);
  });

  it("refuses a batch delete of a read-only node, and of a hidden one", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");

    const readOnly = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "deleteNode", id: seeded.decision }],
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.content[0]!.text).toContain("read-only");
    expect(seeded.session.snapshot().nodes.some((node) => node.id === seeded.decision)).toBe(true);

    // A hidden node answers as an id that never existed, here as everywhere.
    const hidden = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "deleteNode", id: seeded.note }],
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0]!.text).toBe(`id: unknown id: ${seeded.note}`);
    expect(seeded.session.snapshot().nodes.some((node) => node.id === seeded.note)).toBe(true);
  });

  it("refuses a batch edge aimed at a read-only endpoint", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const refused = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "upsertEdge", type: "RELATES_TO", from: seeded.incident, to: seeded.decision }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("read-only");

    const hiddenEdge = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "upsertEdge", type: "ANNOTATES", from: seeded.note, to: seeded.incident }],
    });
    expect(hiddenEdge.isError).toBe(true);
  });

  it("nothing in a refused batch is applied", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const refused = await call(reviewer, "graph_apply_batch", {
      ops: [
        { op: "upsertNode", type: "Incident", properties: { title: "Allowed" } },
        { op: "upsertNode", type: "Decision", properties: { title: "Refused" } },
      ],
    });
    expect(refused.isError).toBe(true);
    const titles = seeded.session.snapshot().nodes.map((node) => node.properties.title);
    expect(titles).not.toContain("Allowed");
    expect(titles).not.toContain("Refused");
  });

  it("applies a batch a role is allowed to make, refs included", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const applied = await call(reviewer, "graph_apply_batch", {
      ops: [
        { op: "upsertNode", type: "Incident", ref: "next", properties: { title: "Follow-up" } },
        { op: "upsertEdge", type: "RELATES_TO", from: seeded.incident, to: { ref: "next" } },
      ],
    });
    expect(applied.isError).toBeFalsy();
    const snapshot = seeded.session.snapshot();
    const created = snapshot.nodes.find((node) => node.properties.title === "Follow-up");
    expect(created).toBeDefined();
    expect(
      snapshot.edges.some((edge) => edge.type === "RELATES_TO" && edge.to === created!.id),
    ).toBe(true);
  });

  it("rejects a malformed op instead of passing it through", async () => {
    const reviewer = toolsFor(seeded.session, "reviewer");
    const refused = await call(reviewer, "graph_apply_batch", {
      ops: [{ op: "drop_everything", id: seeded.incident }],
    });
    expect(refused.isError).toBe(true);
  });

  it("withholds graph_diff_since from a concealing role", () => {
    expect(toolsFor(seeded.session, "triage").map((tool) => tool.name)).toContain(
      "graph_diff_since",
    );
    // The reviewer cannot see PrivateNote, and a diff cannot be filtered after
    // the fact — same reason graph_query is withheld.
    expect(toolsFor(seeded.session, "reviewer").map((tool) => tool.name)).not.toContain(
      "graph_diff_since",
    );
    expect(toolsFor(seeded.session, "observer").map((tool) => tool.name)).toContain(
      "graph_diff_since",
    );
  });
});
