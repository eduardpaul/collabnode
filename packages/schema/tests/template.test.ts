import { describe, expect, it } from "vitest";
import { compileTemplate, parseWorkspaceTypeDocument, SchemaError, validateParams } from "../src/index.ts";

const RETRO_YAML = `
type: retro
version: 3

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
    AUTHOR:
      from: [Item]
      to: [Person]
      directed: true

params:
  sprint:
    type: number
    required: true
  members:
    type: array
    of: string
  includeActionItems:
    type: boolean
    default: true

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
    - type: Column
      as: action_items
      when: "includeActionItems == true"
      properties:
        title: "Action items"
    - forEach: members
      as: "member_{item}"
      type: Person
      properties:
        name: "{item}"
  edges:
    - forEach: members
      when: "item == 'Alice'"
      type: AUTHOR
      from: "{ ref: 'went_well' }"
      to: "member_{item}"

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

describe("validateParams", () => {
  it("validates required parameters and fills defaults", () => {
    const paramDefs = {
      sprint: { type: "number" as const, required: true },
      title: { type: "string" as const, default: "Default Title" },
      members: { type: "array" as const, of: "string" as const },
    };

    const res = validateParams(paramDefs, { sprint: 42 });
    expect(res).toEqual({
      sprint: 42,
      title: "Default Title",
    });
  });

  it("throws SchemaError on missing required parameter", () => {
    const paramDefs = {
      sprint: { type: "number" as const, required: true },
    };
    expect(() => validateParams(paramDefs, {})).toThrow(SchemaError);
  });

  it("throws SchemaError on type mismatch", () => {
    const paramDefs = {
      sprint: { type: "number" as const },
      members: { type: "array" as const, of: "string" as const },
    };
    expect(() => validateParams(paramDefs, { sprint: "not-a-number" })).toThrow(SchemaError);
    expect(() => validateParams(paramDefs, { members: [123] })).toThrow(SchemaError);
  });
});

describe("compileTemplate", () => {
  it("compiles the retro template with params and forEach", () => {
    const wsType = parseWorkspaceTypeDocument(RETRO_YAML);
    const ops = compileTemplate(wsType, {
      sprint: 42,
      members: ["Alice", "Bob"],
      includeActionItems: true,
    });

    expect(ops).toHaveLength(6); // 3 columns + 2 persons + 1 edge (Alice only)

    // Verify 3 columns
    expect(ops[0]).toEqual({
      op: "upsertNode",
      type: "Column",
      ref: "went_well",
      properties: { title: "Went well" },
    });
    expect(ops[1]).toEqual({
      op: "upsertNode",
      type: "Column",
      ref: "to_improve",
      properties: { title: "To improve" },
    });
    expect(ops[2]).toEqual({
      op: "upsertNode",
      type: "Column",
      ref: "action_items",
      properties: { title: "Action items" },
    });

    // Verify 2 persons
    expect(ops[3]).toEqual({
      op: "upsertNode",
      type: "Person",
      ref: "member_Alice",
      properties: { name: "Alice" },
    });
    expect(ops[4]).toEqual({
      op: "upsertNode",
      type: "Person",
      ref: "member_Bob",
      properties: { name: "Bob" },
    });

    // Verify edge for Alice
    expect(ops[5]).toEqual({
      op: "upsertEdge",
      type: "AUTHOR",
      from: { ref: "went_well" },
      to: { ref: "member_Alice" },
      properties: {},
    });
  });

  it("respects conditional guards (when: false)", () => {
    const wsType = parseWorkspaceTypeDocument(RETRO_YAML);
    const ops = compileTemplate(wsType, {
      sprint: 42,
      members: ["Charlie"],
      includeActionItems: false,
    });

    // 2 columns (action_items skipped) + 1 person + 0 edges (Alice only)
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => (op.op === "upsertNode" ? op.ref : undefined))).toEqual([
      "went_well",
      "to_improve",
      "member_Charlie",
    ]);
  });

  it("handles object arrays in forEach with nested properties", () => {
    const wsType = parseWorkspaceTypeDocument(`
type: incident
version: 1
schema:
  nodes:
    Alert:
      properties:
        severity: { type: string }
        message: { type: string }
  edges: {}
params:
  alerts:
    type: array
template:
  nodes:
    - forEach: alerts
      as: "alert_{index}"
      type: Alert
      properties:
        severity: "{item.severity}"
        message: "Alert {index + 1}: {item.msg}"
`);

    const ops = compileTemplate(wsType, {
      alerts: [
        { severity: "sev1", msg: "DB connection pool exhausted" },
        { severity: "sev2", msg: "Elevated latency on checkout" },
      ],
    });

    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      op: "upsertNode",
      type: "Alert",
      ref: "alert_0",
      properties: {
        severity: "sev1",
        message: "Alert 1: DB connection pool exhausted",
      },
    });
    expect(ops[1]).toEqual({
      op: "upsertNode",
      type: "Alert",
      ref: "alert_1",
      properties: {
        severity: "sev2",
        message: "Alert 2: Elevated latency on checkout",
      },
    });
  });
});
