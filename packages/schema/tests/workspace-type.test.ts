import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  parseDuration,
  parseWorkspaceTypeDocument,
  SchemaError,
  workspaceTypeId,
} from "../src/index.ts";
import { loadWorkspaceTypeFile } from "../src/node.ts";

const WORKSPACE_TYPE_YAML = `
type: retro
version: 3
description: Sprint retrospective workspace

schema:
  nodes:
    Column:
      properties:
        title:
          type: string
          required: true
    Item:
      properties:
        body:
          type: text
        votes:
          type: number
          default: 0
    Person:
      properties:
        name:
          type: string
          required: true
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
      directed: true

params:
  sprint:
    type: number
    required: true
  members:
    type: array
    of: string

template:
  nodes:
    - type: Column
      as: went_well
      properties:
        title: "Went well"
    - type: Column
      as: to_improve
      properties:
        title: "To improve"
    - forEach: members
      as: "member_{item}"
      type: Person
      properties:
        name: "{item}"

lifecycle:
  idleTimeout: 30m
  maxDuration: 4h
  endWhen: "MATCH (i:Item) WHERE i.votes = 0 RETURN count(i) = 0"

tools:
  expose: [graph_search, graph_neighbors]
  named:
    add_item:
      description: Add a retro item to a column
      creates: Item
      into: IN_COLUMN
  agents:
    - role: facilitator
      actorId: facilitator-bot

projection: none
retention:
  onEnd: delete
  artifact: required
`;

describe("parseDuration & formatDuration", () => {
  it("parses duration strings accurately", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseDuration("4h")).toBe(4 * 3600 * 1000);
    expect(parseDuration("1d")).toBe(24 * 3600 * 1000);
    expect(parseDuration("2w")).toBe(14 * 24 * 3600 * 1000);
    expect(parseDuration(1234)).toBe(1234);
  });

  it("formats durations accurately", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(30 * 60 * 1000)).toBe("30m");
    expect(formatDuration(4 * 3600 * 1000)).toBe("4h");
    expect(formatDuration(24 * 3600 * 1000)).toBe("1d");
  });

  it("throws on invalid duration strings", () => {
    expect(() => parseDuration("invalid")).toThrow(SchemaError);
    expect(() => parseDuration(-10)).toThrow(SchemaError);
    expect(() => parseDuration("")).toThrow(SchemaError);
  });
});

describe("parseWorkspaceTypeDocument", () => {
  it("parses the complete retro workspace type YAML from design doc §4", () => {
    const wsType = parseWorkspaceTypeDocument(WORKSPACE_TYPE_YAML);
    expect(wsType.name).toBe("retro");
    expect(wsType.version).toBe(3);
    expect(wsType.description).toBe("Sprint retrospective workspace");
    expect(wsType.projection).toBe("none");
    expect(wsType.retention).toEqual({
      onEnd: "delete",
      artifact: "required",
    });

    expect(wsType.schema.nodes.Column).toBeDefined();
    expect(wsType.schema.nodes.Item?.properties.body?.type).toBe("text");
    expect(wsType.schema.edges.IN_COLUMN?.from).toEqual(["Item"]);
    expect(wsType.schema.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    expect(wsType.params?.sprint).toEqual({ type: "number", required: true });
    expect(wsType.params?.members).toEqual({ type: "array", of: "string" });

    expect(wsType.template?.nodes).toHaveLength(3);
    expect(wsType.lifecycle?.idleTimeout).toBe("30m");
    expect(wsType.lifecycle?.maxDuration).toBe("4h");

    expect(wsType.tools?.expose).toEqual(["graph_search", "graph_neighbors"]);
    expect(wsType.tools?.named?.add_item?.creates).toBe("Item");
    expect(wsType.tools?.agents?.[0]?.role).toBe("facilitator");
  });

  it("produces workspaceTypeId as name@version", () => {
    const wsType = parseWorkspaceTypeDocument(WORKSPACE_TYPE_YAML);
    expect(workspaceTypeId(wsType)).toBe("retro@3");
  });

  it("validates template node types against schema", () => {
    expect(() =>
      parseWorkspaceTypeDocument(`
type: bad
version: 1
schema:
  nodes: {}
  edges: {}
template:
  nodes:
    - type: MissingNode
`),
    ).toThrow(/MissingNode/);
  });

  it("validates named tool creates/into types against schema", () => {
    expect(() =>
      parseWorkspaceTypeDocument(`
type: bad
version: 1
schema:
  nodes:
    Item: { properties: {} }
  edges: {}
tools:
  named:
    add:
      creates: Item
      into: MISSING_EDGE
`),
    ).toThrow(/MISSING_EDGE/);
  });
});

describe("loadWorkspaceTypeFile", () => {
  it("loads a workspace type from a file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collabnode-ws-type-"));
    const path = join(dir, "type.yaml");
    await writeFile(path, WORKSPACE_TYPE_YAML);

    const wsType = await loadWorkspaceTypeFile(path);
    expect(wsType.name).toBe("retro");
    expect(wsType.version).toBe(3);
    expect(wsType.schema.nodes.Column).toBeDefined();
  });
});
