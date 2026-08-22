import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  createIndexStatement,
  ftsPlan,
  queryIndexStatement,
  reconcileIndexes,
  searchColumnValues,
} from "../src/fts.ts";

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
        search: { boost: 6 }
      body:
        type: text
        search: true
      pinned:
        type: boolean
  Person:
    properties:
      name:
        type: string
`);

describe("ftsPlan", () => {
  it("gives each boost its own index, since Ladybug has no per-column weight", () => {
    const plans = ftsPlan(schema).filter((plan) => plan.table === "Note");
    expect(plans).toEqual([
      {
        table: "Note",
        name: "fts_Note_6",
        properties: ["title"],
        columns: ["_search_6", "title"],
        boost: 6,
      },
      {
        table: "Note",
        name: "fts_Note_1",
        properties: ["body"],
        columns: ["_search_1", "body"],
        boost: 1,
      },
    ]);
  });

  it("leaves out properties the schema did not opt in", () => {
    const properties = ftsPlan(schema)
      .filter((plan) => plan.table === "Note")
      .flatMap((plan) => plan.properties);
    expect(properties).not.toContain("pinned");
  });

  it("falls back to every text-ish property when a type says nothing about search", () => {
    const person = ftsPlan(schema).filter((plan) => plan.table === "Person");
    expect(person).toEqual([
      {
        table: "Person",
        name: "fts_Person_1",
        properties: ["name"],
        columns: ["_search_1", "name"],
        boost: 1,
      },
    ]);
  });
});

describe("statements", () => {
  it("escapes the query text rather than interpolating it raw", () => {
    const plan = ftsPlan(schema)[0]!;
    const statement = queryIndexStatement(plan, ["o'brien", "standup"], 20);
    expect(statement).toContain("\\'brien");
    expect(statement).toContain("conjunctive := false");
    expect(statement).toContain("top := 20");
  });

  it("names the columns it indexes", () => {
    expect(createIndexStatement(ftsPlan(schema)[0]!)).toBe(
      "CALL CREATE_FTS_INDEX('Note', 'fts_Note_6', ['_search_6', 'title'])",
    );
  });
});

describe("searchColumnValues", () => {
  const plans = ftsPlan(schema).filter((plan) => plan.table === "Note");

  it("writes only the joins a tokenizer would miss, per tier", () => {
    expect(searchColumnValues(plans, { title: "Kick-Off", body: "daily sync" })).toEqual({
      _search_6: "kickoff",
      _search_1: "dailysync",
    });
  });

  it("skips the whole-value join for prose, which nobody types as one word", () => {
    const body = "the quarterly planning session covers staffing, budget and the launch calendar";
    expect(searchColumnValues(plans, { body })._search_1).toBe("");
  });

  it("joins a multi-word title, so 'standup' finds 'Stand Up'", () => {
    expect(searchColumnValues(plans, { title: "Stand Up" })._search_6).toBe("standup");
  });

  it("leaves a plain single word alone", () => {
    expect(searchColumnValues(plans, { title: "Retro" })._search_6).toBe("");
  });
});

describe("reconcileIndexes", () => {
  const plans = ftsPlan(schema);

  it("creates everything against an empty database", () => {
    expect(reconcileIndexes(plans, []).create).toHaveLength(plans.length);
  });

  it("leaves an index alone when its columns still match", () => {
    const shown = plans.map((plan) => ({
      table_name: plan.table,
      index_name: plan.name,
      index_type: "FTS",
      property_names: plan.columns,
    }));
    expect(reconcileIndexes(plans, shown)).toEqual({ create: [], drop: [] });
  });

  it("rebuilds an index whose schema fields changed", () => {
    const shown = [
      {
        table_name: "Note",
        index_name: "fts_Note_6",
        index_type: "FTS",
        property_names: ["title", "subtitle"],
      },
    ];
    const { create, drop } = reconcileIndexes(plans, shown);
    expect(drop.map((plan) => plan.name)).toEqual(["fts_Note_6"]);
    expect(create.map((plan) => plan.name)).toContain("fts_Note_6");
  });

  it("ignores the primary-key index Ladybug reports alongside FTS ones", () => {
    const shown = [
      { table_name: "Note", index_name: "_PK", index_type: "HASH", property_names: ["id"] },
    ];
    expect(reconcileIndexes(plans, shown).drop).toEqual([]);
  });
});
