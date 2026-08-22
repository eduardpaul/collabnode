import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { LadybugGraphStore } from "../src/store.ts";
import { opToCypher } from "../src/cypher.ts";
import { schemaToDdl } from "../src/ddl.ts";

const SCOPE = { workspaceId: "w1", schemaId: "test" };

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
    properties:
      since:
        type: datetime
`);

describe("schemaToDdl", () => {
  it("emits node and rel tables including provenance columns", () => {
    const ddl = schemaToDdl(schema);
    expect(ddl.some((line) => line.includes("CREATE NODE TABLE IF NOT EXISTS Task"))).toBe(true);
    expect(ddl.some((line) => line.includes("updatedBy STRING"))).toBe(true);
    expect(ddl.some((line) => line.includes("CREATE REL TABLE IF NOT EXISTS ASSIGNED_TO"))).toBe(
      true,
    );
    expect(ddl.some((line) => line.includes("collabId STRING"))).toBe(true);
  });
});

describe("opToCypher", () => {
  it("merges nodes and recreates edges by collabId", () => {
    const node = opToCypher({
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Ship" },
      meta: { updatedBy: "ada" },
    });
    expect(node[0]).toContain("MERGE (n:Task {id: 't1'})");
    expect(node[0]).toContain("n.updatedBy = 'ada'");

    const edge = opToCypher({
      kind: "upsertEdge",
      id: "e1",
      type: "ASSIGNED_TO",
      from: "t1",
      to: "p1",
      properties: { since: "2026-01-01" },
      meta: {},
    });
    expect(edge[0]).toContain("DELETE r");
    expect(edge[1]).toContain("CREATE (a)-[r:ASSIGNED_TO");
  });
});

describe("LadybugGraphStore", () => {
  it("runs DDL and ops against an injected connection", async () => {
    const statements: string[] = [];
    const store = new LadybugGraphStore({
      path: ":memory:",
      open: async () => ({
        db: { close: () => undefined },
        conn: {
          query: async (statement: string) => {
            statements.push(statement);
            return [];
          },
        },
      }),
    });
    await store.applySchema(SCOPE, schema);
    await store.apply(SCOPE, {
      kind: "upsertNode",
      id: "t1",
      type: "Task",
      properties: { title: "Ship" },
      meta: {},
    });
    expect(statements[0]).toMatch(/CREATE NODE TABLE/);
    expect(statements.some((line) => line.includes("MERGE (n:Task"))).toBe(true);
    await store.close();
  });
});
