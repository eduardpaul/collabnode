import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { humanizeType, resolveLink, validEdgeTypes } from "../src/view/edges.ts";

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
  Person:
    properties:
      name:
        type: string
        required: true
  Incident:
    properties:
      title:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    directed: true
  BLOCKS:
    from: [Task]
    to: [Task]
    directed: true
`);

describe("validEdgeTypes", () => {
  it("allows Task → Person ASSIGNED_TO and Task → Task BLOCKS", () => {
    expect(validEdgeTypes(schema, "Task", "Person")).toEqual(["ASSIGNED_TO"]);
    expect(validEdgeTypes(schema, "Task", "Task")).toEqual(["BLOCKS"]);
    expect(validEdgeTypes(schema, "Person", "Task")).toEqual([]);
    expect(validEdgeTypes(schema, "Incident", "Task")).toEqual([]);
  });
});

describe("resolveLink", () => {
  it("flips the pair when only the reverse direction is legal", () => {
    const flipped = resolveLink(schema, "p1", "t1", "Person", "Task");
    expect(flipped).toEqual({ fromId: "t1", toId: "p1", types: ["ASSIGNED_TO"] });
    const none = resolveLink(schema, "i1", "t1", "Incident", "Task");
    expect(none.types).toEqual([]);
  });

  it("humanizes edge type names", () => {
    expect(humanizeType("ASSIGNED_TO")).toBe("assigned to");
  });
});
