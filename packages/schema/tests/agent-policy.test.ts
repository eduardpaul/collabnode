import { describe, expect, it } from "vitest";
import {
  nodeAccessFrom,
  openNodeAccess,
  parseWorkspaceTypeDocument,
  redactSchema,
  resolveNodeAccess,
  SchemaError,
} from "../src/index.ts";

const YAML = `
type: board
version: 1
schema:
  nodes:
    Task:
      properties:
        title: { type: string, required: true }
    Person:
      properties:
        name: { type: string, required: true }
    Secret:
      properties:
        body: { type: string }
  edges:
    ASSIGNED_TO:
      from: [Task]
      to: [Person]
    MENTIONS:
      from: [Secret]
      to: [Task, Person]
tools:
  agents:
    - role: worker
      actorId: worker-bot
    - role: auditor
      actorId: auditor-bot
      nodes:
        readOnly: [Task]
        hidden: [Secret]
`;

const wsType = parseWorkspaceTypeDocument(YAML);
const schema = wsType.schema;

describe("agent node policy", () => {
  it("leaves an agent without a policy unrestricted", () => {
    const worker = resolveNodeAccess(schema, wsType.tools, "worker");
    expect(worker.restricted).toBe(false);
    expect(worker.canWrite("Secret")).toBe(true);
    expect(redactSchema(schema, worker)).toBe(schema);
  });

  it("matches a role by actorId as well as by role name", () => {
    expect(resolveNodeAccess(schema, wsType.tools, "auditor-bot").hidden.has("Secret")).toBe(true);
    expect(resolveNodeAccess(schema, wsType.tools, "nobody").restricted).toBe(false);
    expect(resolveNodeAccess(schema, wsType.tools, undefined).restricted).toBe(false);
  });

  it("separates 'see but do not touch' from 'do not know it exists'", () => {
    const auditor = resolveNodeAccess(schema, wsType.tools, "auditor");
    expect(auditor.canWrite("Task")).toBe(false);
    expect(auditor.isHidden("Task")).toBe(false);
    expect(auditor.isHidden("Secret")).toBe(true);
    expect(auditor.visibleNodeTypes).toEqual(["Task", "Person"]);
    expect(auditor.anyWritable).toBe(true);
  });

  it("hides an edge type only when every instance must touch a hidden node", () => {
    const auditor = resolveNodeAccess(schema, wsType.tools, "auditor");
    // MENTIONS always starts at a Secret; ASSIGNED_TO never touches one.
    expect(auditor.isEdgeHidden("MENTIONS")).toBe(true);
    expect(auditor.isEdgeHidden("ASSIGNED_TO")).toBe(false);
    // …but ASSIGNED_TO starts at a read-only Task, so it cannot be written.
    expect(auditor.canWriteEdge("ASSIGNED_TO")).toBe(false);
  });

  it("expands '*' and lets hidden win the overlap", () => {
    const policy = nodeAccessFrom(schema, { readOnly: ["*"], hidden: ["Secret"] });
    expect(policy.readOnly).toEqual(new Set(["Task", "Person"]));
    expect(policy.hidden).toEqual(new Set(["Secret"]));
    expect(policy.anyWritable).toBe(false);
    expect(policy.canWrite("Task")).toBe(false);
  });

  it("redacts hidden types out of the schema, keeping the hash", () => {
    const auditor = resolveNodeAccess(schema, wsType.tools, "auditor");
    const view = redactSchema(schema, auditor);
    expect(Object.keys(view.nodes)).toEqual(["Task", "Person"]);
    expect(Object.keys(view.edges)).toEqual(["ASSIGNED_TO"]);
    expect(view.schemaHash).toBe(schema.schemaHash);
    expect(JSON.stringify(view)).not.toContain("Secret");
  });

  it("drops a hidden endpoint from a surviving edge type", () => {
    const policy = nodeAccessFrom(schema, { hidden: ["Person"] });
    const view = redactSchema(schema, policy);
    expect(view.edges.MENTIONS?.to).toEqual(["Task"]);
    expect(view.edges.ASSIGNED_TO).toBeUndefined();
  });

  it("rejects a policy naming a type the schema does not declare", () => {
    expect(() =>
      parseWorkspaceTypeDocument(`
type: board
version: 1
schema:
  nodes:
    Task:
      properties:
        title: { type: string }
tools:
  agents:
    - role: auditor
      actorId: auditor-bot
      nodes:
        readOnly: [Ghost]
`),
    ).toThrow(/undeclared node type 'Ghost'/);
  });

  it("rejects two agents claiming the same role", () => {
    expect(() =>
      parseWorkspaceTypeDocument(`
type: board
version: 1
schema:
  nodes:
    Task:
      properties:
        title: { type: string }
tools:
  agents:
    - role: auditor
      actorId: one
    - role: auditor
      actorId: two
`),
    ).toThrow(SchemaError);
  });

  it("treats an empty policy as no policy", () => {
    expect(nodeAccessFrom(schema, {}).restricted).toBe(false);
    expect(nodeAccessFrom(schema, { readOnly: [], hidden: [] }).restricted).toBe(false);
    expect(openNodeAccess(schema).visibleNodeTypes).toEqual(["Task", "Person", "Secret"]);
  });
});
