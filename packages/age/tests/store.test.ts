import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { AgeGraphStore, type AgeSqlClient } from "../src/store.ts";

const schema = parseSchemaDocument(`
name: HarborLanes
version: 1
config:
  schemaId: harbor-lanes
nodes:
  Shipment:
    properties:
      tracking:
        type: string
        required: true
  Hub:
    properties:
      code:
        type: string
        required: true
edges:
  HEADS_TO:
    from: [Shipment]
    to: [Hub]
`);

function mockClient(): { client: AgeSqlClient; sql: string[] } {
  const sql: string[] = [];
  const client: AgeSqlClient = {
    query: async (statement) => {
      sql.push(statement);
      if (statement.includes("FROM ag_catalog.ag_graph")) {
        return { rows: [] };
      }
      if (statement.includes("FROM ag_catalog.ag_label")) {
        return { rows: [] };
      }
      if (statement.includes("MATCH (n:Shipment)")) {
        return {
          rows: [
            {
              n: '{"id": 1, "label": "Shipment", "properties": {"collabId": "s1", "tracking": "HL-42"}}::vertex',
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { client, sql };
}

const SCOPE = { workspaceId: "lane-42", schemaId: "harbor" };

describe("AgeGraphStore", () => {
  it("runs AGE setup, MERGE ops, and Cypher queries against an injected client", async () => {
    const { client, sql } = mockClient();
    const store = new AgeGraphStore({ client, graphName: "harbor_lanes" });
    await store.applySchema(SCOPE, schema);
    await store.apply(SCOPE, {
      kind: "upsertNode",
      id: "s1",
      type: "Shipment",
      properties: { tracking: "HL-42" },
      meta: {},
    });
    const result = await store.query(SCOPE, "MATCH (n:Shipment) RETURN n");
    // One graph per workspace: the option is the base, not the final name.
    const graphName = store.graphNameFor(SCOPE);
    expect(graphName.startsWith("harbor_lanes_")).toBe(true);
    expect(sql.some((line) => line.includes(`create_graph('${graphName}')`))).toBe(true);
    expect(sql.some((line) => line.includes("create_vlabel"))).toBe(true);
    expect(sql.some((line) => line.includes("MERGE (n:Shipment {collabId: 's1'})"))).toBe(true);
    expect(sql.some((line) => line.includes("BEGIN"))).toBe(true);
    expect(result.rows[0]?.n).toMatchObject({
      id: "s1",
      type: "Shipment",
      properties: { tracking: "HL-42" },
    });
    await store.close();
  });

  it("refuses query before applySchema", async () => {
    const { client } = mockClient();
    const store = new AgeGraphStore({ client });
    await expect(store.query("MATCH (n:Shipment) RETURN n")).rejects.toThrow(/applySchema/);
  });

  it("keeps concurrent workspaces of one schema in separate graphs", async () => {
    const { client, sql } = mockClient();
    const store = new AgeGraphStore({ client });
    const a = { workspaceId: "retro-a", schemaId: schema.config.schemaId };
    const b = { workspaceId: "retro-b", schemaId: schema.config.schemaId };
    await store.applySchema(a, schema);
    await store.applySchema(b, schema);
    expect(store.graphNameFor(a)).not.toBe(store.graphNameFor(b));
    expect(sql.some((line) => line.includes(`create_graph('${store.graphNameFor(a)}')`))).toBe(true);
    expect(sql.some((line) => line.includes(`create_graph('${store.graphNameFor(b)}')`))).toBe(true);
    await store.close();
  });
});
