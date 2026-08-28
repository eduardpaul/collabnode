import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { ADVANCED_TOOLS, parseWorkspaceTypeDocument, SchemaError } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { buildTools, generatePrompts } from "../src/index.ts";

const YAML = (tools: string) => `
type: board
version: 1

schema:
  nodes:
    Task:
      identity:
        from: [title]
      properties:
        title:
          type: string
          required: true
    Person:
      identity:
        from: [name]
      properties:
        name:
          type: string
          required: true
  edges:
    ASSIGNED_TO:
      from: [Task]
      to: [Person]
${tools}
`;

const plain = parseWorkspaceTypeDocument(YAML(""));

async function session(schema = plain.schema) {
  return CollabSession.open(undefined, {
    schema,
    collab: new InMemoryCollabBackend(),
    graph: new InMemoryGraphStore(),
    actorId: "host",
  });
}

describe("tools.advanced", () => {
  it("generates none of the advanced tools by default", async () => {
    const host = await session();
    const names = buildTools(plain.schema, host, { policy: plain.tools }).map((t) => t.name);
    for (const tool of ADVANCED_TOOLS) {
      expect(names).not.toContain(tool);
    }
    // The everyday reads that replace them are all still there.
    expect(names).toEqual(
      expect.arrayContaining([
        "graph_describe",
        "graph_list",
        "graph_get",
        "graph_search",
        "graph_neighbors",
        "graph_changes",
      ]),
    );
    await host.close();
  });

  it("generates exactly the advanced tools a workspace names", async () => {
    const type = parseWorkspaceTypeDocument(
      YAML("\ntools:\n  advanced: [graph_query, graph_snapshot]\n"),
    );
    const host = await session(type.schema);
    const names = buildTools(type.schema, host, { policy: type.tools }).map((t) => t.name);
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_snapshot");
    expect(names).not.toContain("graph_diff_since");
    expect(names).not.toContain("graph_apply_batch");
    await host.close();
  });

  it("keeps the node policy in charge: a concealing role gets no Cypher even when asked for", async () => {
    const type = parseWorkspaceTypeDocument(
      YAML(`
tools:
  advanced: [graph_query, graph_diff_since]
  agents:
    - role: open
      actorId: open-bot
    - role: partial
      actorId: partial-bot
      nodes:
        hidden: [Person]
`),
    );
    const host = await session(type.schema);
    const open = buildTools(type.schema, host, {
      policy: type.tools,
      agentRole: "open",
    }).map((t) => t.name);
    const partial = buildTools(type.schema, host, {
      policy: type.tools,
      agentRole: "partial",
    }).map((t) => t.name);

    expect(open).toContain("graph_query");
    expect(open).toContain("graph_diff_since");
    // `advanced` opens a door; it does not open it wider than the role's policy.
    expect(partial).not.toContain("graph_query");
    expect(partial).not.toContain("graph_diff_since");
    await host.close();
  });

  it("advertises in graph_describe only the reads that were generated", async () => {
    const host = await session();
    const bare = buildTools(plain.schema, host, { policy: plain.tools });
    const described = JSON.parse(
      (await bare.find((t) => t.name === "graph_describe")!.handler({})).content[0]!.text,
    ) as { reads: string[] };
    expect(described.reads).not.toContain("graph_snapshot");
    expect(described.reads).not.toContain("graph_query");
    expect(described.reads).toContain("graph_list");

    const type = parseWorkspaceTypeDocument(YAML("\ntools:\n  advanced: [graph_snapshot]\n"));
    const withSnapshot = buildTools(type.schema, host, { policy: type.tools });
    const described2 = JSON.parse(
      (await withSnapshot.find((t) => t.name === "graph_describe")!.handler({})).content[0]!.text,
    ) as { reads: string[] };
    expect(described2.reads).toContain("graph_snapshot");
    expect(described2.reads).not.toContain("graph_query");
    await host.close();
  });

  it("only mentions graph_snapshot in the system prompt when it exists", () => {
    const off = generatePrompts(plain.schema, { documentId: "d1", type: plain }).find(
      (p) => p.name === "graph-system",
    )!;
    expect(off.text).not.toContain("over graph_snapshot");

    const type = parseWorkspaceTypeDocument(YAML("\ntools:\n  advanced: [graph_snapshot]\n"));
    const on = generatePrompts(type.schema, { documentId: "d1", type }).find(
      (p) => p.name === "graph-system",
    )!;
    expect(on.text).toContain("over graph_snapshot");
  });

  it("rejects a name that is not an advanced tool", () => {
    expect(() => parseWorkspaceTypeDocument(YAML("\ntools:\n  advanced: [graph_list]\n"))).toThrow(
      SchemaError,
    );
  });
});
