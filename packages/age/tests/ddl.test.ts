import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { decodeAgeValue, parseAgtype } from "../src/agtype.ts";
import { opToCypher } from "../src/cypher.ts";
import { schemaToAgeDdl } from "../src/ddl.ts";
import { returnColumns, wrapCypher } from "../src/wrap.ts";
import { sanitizeGraphName } from "../src/names.ts";

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

describe("schemaToAgeDdl", () => {
  it("emits graph + vertex/edge labels", () => {
    const ddl = schemaToAgeDdl(schema);
    expect(ddl[0]).toBe("CREATE EXTENSION IF NOT EXISTS age");
    expect(ddl.some((line) => line.includes("create_graph('harbor_lanes')"))).toBe(true);
    expect(ddl.some((line) => line.includes("create_vlabel('harbor_lanes', 'Shipment')"))).toBe(
      true,
    );
    expect(ddl.some((line) => line.includes("create_elabel('harbor_lanes', 'HEADS_TO')"))).toBe(
      true,
    );
  });
});

describe("opToCypher", () => {
  it("merges nodes and recreates edges by collabId", () => {
    const node = opToCypher({
      kind: "upsertNode",
      id: "s1",
      type: "Shipment",
      properties: { tracking: "HL-42" },
      meta: { updatedBy: "ada" },
    });
    expect(node[0]).toContain("MERGE (n:Shipment {collabId: 's1'})");
    expect(node[0]).toContain("n.updatedBy = 'ada'");

    const edge = opToCypher({
      kind: "upsertEdge",
      id: "e1",
      type: "HEADS_TO",
      from: "s1",
      to: "h1",
      properties: {},
      meta: {},
    });
    expect(edge[0]).toContain("DELETE r");
    expect(edge[1]).toContain("CREATE (a)-[r:HEADS_TO");
  });
});

describe("wrapCypher", () => {
  it("parses RETURN aliases into an AGE AS clause", () => {
    expect(returnColumns("MATCH (n:Shipment) RETURN n")).toEqual(["n"]);
    expect(
      returnColumns(
        "MATCH (s:Shipment)-[:HEADS_TO]->(h:Hub) RETURN s.tracking, h.code AS hub",
      ),
    ).toEqual(["s_tracking", "hub"]);
    const wrapped = wrapCypher("harbor_lanes", "MATCH (n:Shipment) RETURN n");
    expect(wrapped.sql).toContain("cypher('harbor_lanes'");
    expect(wrapped.sql).toContain("AS (n agtype)");
  });

  it("passes Cypher parameters as agtype JSON", () => {
    const wrapped = wrapCypher("harbor_lanes", "MATCH (n {id: $id}) RETURN n", { id: "s1" });
    expect(wrapped.sql).toContain("$1::agtype");
    expect(wrapped.values).toEqual([JSON.stringify({ id: "s1" })]);
  });
});

describe("agtype", () => {
  it("decodes AGE vertex and edge strings into graph records", () => {
    expect(parseAgtype("1")).toBe(1);
    const node = decodeAgeValue(
      '{"id": 1, "label": "Shipment", "properties": {"collabId": "s1", "tracking": "HL-42", "updatedBy": "ada"}}::vertex',
    );
    expect(node).toEqual({
      id: "s1",
      type: "Shipment",
      properties: { tracking: "HL-42" },
      meta: { updatedBy: "ada" },
    });
    const edge = decodeAgeValue(
      '{"id": 2, "label": "HEADS_TO", "start_id": 1, "end_id": 3, "properties": {"collabId": "e1"}}::edge',
    );
    expect(edge).toMatchObject({ id: "e1", type: "HEADS_TO" });
  });
});

describe("sanitizeGraphName", () => {
  it("turns schema ids into AGE-safe names", () => {
    expect(sanitizeGraphName("harbor-lanes")).toBe("harbor_lanes");
    expect(sanitizeGraphName("ab")).toBe("ab_g");
  });
});
