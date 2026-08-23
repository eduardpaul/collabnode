import { describe, expect, it } from "vitest";
import { parseSchemaDocument, parseWorkspaceTypeDocument, SchemaError } from "../src/index.ts";
import { singletonId } from "../src/identity.ts";

const YAML = `
name: Planner
version: 1
config:
  schemaId: planner
nodes:
  BoardState:
    singleton: true
    properties:
      status: { type: string }
  Task:
    identity:
      from: [title]
    properties:
      title: { type: string, required: true }
edges: {}
`;

describe("singleton node types", () => {
  it("parses singleton: true onto the node type", () => {
    const schema = parseSchemaDocument(YAML);
    expect(schema.nodes.BoardState?.singleton).toBe(true);
    expect(schema.nodes.Task?.singleton).toBeUndefined();
  });

  it("refuses singleton together with identity", () => {
    expect(() =>
      parseSchemaDocument(`
name: Broken
version: 1
config: { schemaId: broken }
nodes:
  Thing:
    singleton: true
    identity:
      from: [name]
    properties:
      name: { type: string, required: true }
edges: {}
`),
    ).toThrow(SchemaError);
  });

  it("changes the schema hash, so it is part of the contract", () => {
    const withFlag = parseSchemaDocument(YAML);
    const without = parseSchemaDocument(YAML.replace("    singleton: true\n", ""));
    expect(withFlag.schemaHash).not.toBe(without.schemaHash);
  });

  it("derives an id from the schema and the type, and only from those", () => {
    const schema = parseSchemaDocument(YAML);
    const again = parseSchemaDocument(YAML);
    expect(singletonId(schema, "BoardState")).toMatch(/^[0-9a-f]{32}$/);
    // Same schema, same answer, on any replica and in any process.
    expect(singletonId(again, "BoardState")).toBe(singletonId(schema, "BoardState"));
    // Different types, and different schemas, do not share a node.
    expect(singletonId(schema, "Task")).not.toBe(singletonId(schema, "BoardState"));
    const other = parseSchemaDocument(YAML.replace("schemaId: planner", "schemaId: other"));
    expect(singletonId(other, "BoardState")).not.toBe(singletonId(schema, "BoardState"));
  });

  it("refuses a template that seeds a singleton per item", () => {
    expect(() =>
      parseWorkspaceTypeDocument(`
type: planner
version: 1
schema:
  nodes:
    BoardState:
      singleton: true
      properties:
        status: { type: string }
params:
  members: { type: array, of: string }
template:
  nodes:
    - forEach: members
      type: BoardState
      properties: { status: "{item}" }
`),
    ).toThrow(SchemaError);
  });

  it("allows a template that seeds it once", () => {
    const wsType = parseWorkspaceTypeDocument(`
type: planner
version: 1
schema:
  nodes:
    BoardState:
      singleton: true
      properties:
        status: { type: string }
template:
  nodes:
    - type: BoardState
      as: state
      properties: { status: idle }
`);
    expect(wsType.schema.nodes.BoardState?.singleton).toBe(true);
  });
});
