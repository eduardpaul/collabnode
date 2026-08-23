import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { CollabSession } from "@collabnode/runtime";
import { parseWorkspaceTypeDocument } from "@collabnode/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTools, generatePrompts, toolJsonSchema } from "../src/index.ts";

const TYPE_YAML = `
type: planner
version: 1

schema:
  nodes:
    BoardState:
      singleton: true
      description: The plan's status, one per board
      properties:
        status:
          type: enum
          values: [idle, planning, approved]
          default: idle
        owner:
          type: string
          required: true
    Task:
      identity:
        from: [title]
      properties:
        title:
          type: string
          required: true
  edges: {}
projection: memory
`;

const wsType = parseWorkspaceTypeDocument(TYPE_YAML);
const schema = wsType.schema;

async function session(): Promise<CollabSession> {
  return CollabSession.open(undefined, {
    schema,
    collab: new InMemoryCollabBackend(),
    graph: new InMemoryGraphStore(),
    actorId: "agent",
  });
}

function tool(tools: ReturnType<typeof buildTools>, name: string) {
  const found = tools.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

describe("singleton node types on the tool surface", () => {
  let live: CollabSession;
  let tools: ReturnType<typeof buildTools>;

  beforeEach(async () => {
    live = await session();
    tools = buildTools(schema, live, { graphKind: "memory" });
  });

  it("offers no id argument, and says there is only one", () => {
    const singleton = tool(tools, "upsert_node_BoardState");
    const properties = toolJsonSchema(singleton, schema).properties;
    expect(Object.keys(properties)).not.toContain("id");
    expect(singleton.description).toContain("exactly one");

    // The identity-keyed type keeps its id argument.
    const task = tool(tools, "upsert_node_Task");
    expect(Object.keys(toolJsonSchema(task, schema).properties)).toContain("id");
  });

  it("accepts a partial update without restating required properties", async () => {
    const singleton = tool(tools, "upsert_node_BoardState");

    const created = await singleton.handler({ owner: "ada", status: "planning" });
    expect(created.isError).toBeFalsy();

    const updated = await singleton.handler({ status: "approved" });
    expect(updated.isError).toBeFalsy();

    const states = live.snapshot().nodes.filter((node) => node.type === "BoardState");
    expect(states).toHaveLength(1);
    expect(states[0]?.properties).toMatchObject({ owner: "ada", status: "approved" });
  });

  it("does not mark every property required in the JSON Schema", () => {
    // The mirroring that stops a voice model creating an empty Note would here
    // forbid touching one field of a node that already exists.
    expect(toolJsonSchema(tool(tools, "upsert_node_BoardState"), schema).required).toBeUndefined();
    expect(toolJsonSchema(tool(tools, "upsert_node_Task"), schema).required).toEqual(["title"]);
  });

  it("still refuses a create that is missing a required property", async () => {
    const result = await tool(tools, "upsert_node_BoardState").handler({ status: "planning" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("owner");
    expect(live.snapshot().nodes.filter((node) => node.type === "BoardState")).toHaveLength(0);
  });

  it("reports itself in graph_describe and in the prompt contract", async () => {
    const described = JSON.parse((await tool(tools, "graph_describe").handler({})).content[0]!.text) as {
      nodes: Record<string, { singleton?: true }>;
    };
    expect(described.nodes.BoardState?.singleton).toBe(true);
    expect(described.nodes.Task?.singleton).toBeUndefined();

    const prompts = generatePrompts(schema, { documentId: live.id, type: wsType });
    const contract = prompts.map((prompt) => prompt.text).join("\n");
    expect(contract).toContain("Single instance");
  });
});
