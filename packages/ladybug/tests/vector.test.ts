import type { EmbeddingProvider } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  addVectorColumnStatement,
  createIndexStatement,
  dropColumnStatement,
  orphanColumns,
  pendingStatement,
  queryIndexStatement,
  reconcileIndexes,
  setVectorStatement,
  vectorColumn,
  vectorLiteral,
  vectorPlan,
} from "../src/vector.ts";

const schema = parseSchemaDocument(`
name: NoteBoard
version: 1
config:
  schemaId: note-board
nodes:
  Note:
    identity: { from: [title] }
    properties:
      title:
        type: string
        required: true
        vector: true
      body:
        type: text
        vector: true
      pinned:
        type: boolean
  Person:
    properties:
      name:
        type: string
`);

const provider: EmbeddingProvider = {
  id: "Xenova/bge-small-en-v1.5",
  dimensions: 4,
  async embed(texts) {
    return texts.map(() => Float32Array.from([0.5, 0.5, 0.5, 0.5]));
  },
};

const plans = vectorPlan(schema, provider);
const notePlan = plans[0]!;

describe("vectorPlan", () => {
  it("indexes only the types that asked to be embedded", () => {
    expect(plans).toEqual([
      {
        table: "Note",
        name: "vec_Note_xenova_bge_small_en_v1_5_4",
        column: "_vec_xenova_bge_small_en_v1_5_4",
        dimensions: 4,
        properties: ["title", "body"],
      },
    ]);
  });

  it("names the column after the model, so vectors from two models cannot mix", () => {
    const other = vectorColumn({ ...provider, id: "Xenova/all-MiniLM-L6-v2" });
    expect(other).not.toBe(vectorColumn(provider));
  });
});

describe("statements", () => {
  it("adds the column idempotently, for databases written before vectors existed", () => {
    expect(addVectorColumnStatement(notePlan)).toBe(
      "ALTER TABLE Note ADD IF NOT EXISTS _vec_xenova_bge_small_en_v1_5_4 FLOAT[4]",
    );
  });

  it("casts the literal, since an untyped list will not bind to FLOAT[N]", () => {
    expect(vectorLiteral([0.5, -0.25, 0, 1], 4)).toBe("CAST([0.5,-0.25,0,1], 'FLOAT[4]')");
  });

  it("pads a short vector rather than emitting a literal the binder will reject", () => {
    expect(vectorLiteral([1], 3)).toBe("CAST([1,0,0], 'FLOAT[3]')");
  });

  it("rounds noise away instead of spelling out float32 error", () => {
    expect(vectorLiteral([0.10000000149011612, 1e-9], 2)).toBe("CAST([0.1,0], 'FLOAT[2]')");
  });

  it("escapes the id it matches on", () => {
    expect(setVectorStatement(notePlan, "o'brien", [1, 0, 0, 0])).toContain("{id: 'o\\'brien'}");
  });

  it("asks the index for distances and expects to sort them itself", () => {
    const statement = queryIndexStatement(notePlan, [1, 0, 0, 0], 20);
    expect(statement).toContain("CALL QUERY_VECTOR_INDEX('Note', 'vec_Note_xenova_bge_small_en_v1_5_4'");
    expect(statement).toContain("RETURN node.id AS id, distance AS distance");
  });

  it("creates the index over the embedding column with a cosine metric", () => {
    expect(createIndexStatement(notePlan)).toBe(
      "CALL CREATE_VECTOR_INDEX('Note', 'vec_Note_xenova_bge_small_en_v1_5_4', '_vec_xenova_bge_small_en_v1_5_4', metric := 'cosine')",
    );
  });

  it("reads back exactly the properties the embedding is built from", () => {
    const statement = pendingStatement(notePlan, 64);
    expect(statement).toContain("IS NULL");
    expect(statement).toContain("n.title AS title, n.body AS body");
    expect(statement).toContain("LIMIT 64");
  });
});

describe("reconcileIndexes", () => {
  it("creates everything against a database that has never been indexed", () => {
    expect(reconcileIndexes(plans, [])).toEqual({ create: plans, drop: [] });
  });

  it("leaves an index alone when it already covers the right column", () => {
    const shown = [
      {
        table_name: "Note",
        index_name: notePlan.name,
        index_type: "HNSW",
        property_names: [notePlan.column],
      },
    ];
    expect(reconcileIndexes(plans, shown)).toEqual({ create: [], drop: [] });
  });

  it("drops an index left behind by a previous embedding model", () => {
    const shown = [
      {
        table_name: "Note",
        index_name: "vec_Note_all_minilm_l6_v2_384",
        index_type: "HNSW",
        property_names: ["_vec_all_minilm_l6_v2_384"],
      },
    ];
    const { create, drop } = reconcileIndexes(plans, shown);
    expect(drop).toEqual([{ table: "Note", name: "vec_Note_all_minilm_l6_v2_384" }]);
    expect(create).toEqual(plans);
  });

  it("ignores the full-text and primary-key indexes reported alongside", () => {
    const shown = [
      { table_name: "Note", index_name: "fts_Note_6", index_type: "FTS", property_names: ["title"] },
      { table_name: "Note", index_name: "_PK", index_type: "HASH", property_names: ["id"] },
    ];
    expect(reconcileIndexes(plans, shown).drop).toEqual([]);
  });
});

describe("orphanColumns", () => {
  it("claims every embedding column except the one in use", () => {
    const columns = ["id", "title", "_search_6", notePlan.column, "_vec_all_minilm_l6_v2_384"];
    expect(orphanColumns(notePlan, columns)).toEqual(["_vec_all_minilm_l6_v2_384"]);
    expect(dropColumnStatement("Note", "_vec_all_minilm_l6_v2_384")).toBe(
      "ALTER TABLE Note DROP IF EXISTS _vec_all_minilm_l6_v2_384",
    );
  });
});
