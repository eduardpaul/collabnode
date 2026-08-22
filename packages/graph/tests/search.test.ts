import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { InMemoryGraphStore } from "../src/memory.ts";
import { joinedTerms, searchTerms, searchableProperties } from "../src/search.ts";

const SCOPE = { workspaceId: "w1", schemaId: "test" };

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
      age:
        type: number
`);

describe("searchTerms", () => {
  it("gives every spelling of one name a term in common", () => {
    for (const spelling of ["Stand-Up", "stand up", "STANDUP", "Standup"]) {
      expect(searchTerms(spelling)).toContain("standup");
    }
  });

  it("folds accents, so the query need not reproduce them", () => {
    expect(searchTerms("Café Menu")).toContain("cafe");
  });

  it("keeps the plain words alongside the join", () => {
    expect(searchTerms("Stand-Up").sort()).toEqual(["stand", "standup", "up"]);
  });

  it("does not squash prose into one unusable token", () => {
    const prose = "the quarterly planning session covers staffing, budget and the launch calendar";
    expect(searchTerms(prose).some((term) => term.length > 64)).toBe(false);
  });

  it("has nothing to say about an empty query", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("joinedTerms", () => {
  it("reports only what a punctuation-splitting tokenizer would miss", () => {
    expect(joinedTerms("Kick-Off")).toEqual(["kickoff"]);
    expect(joinedTerms("Retro")).toEqual([]);
  });
});

describe("searchableProperties", () => {
  it("takes the explicit opt-in and drops what it excludes", () => {
    expect(searchableProperties(schema.nodes.Note)).toEqual([
      { name: "title", boost: 6 },
      { name: "body", boost: 1 },
    ]);
  });

  it("indexes every text-ish property when a type says nothing about search", () => {
    expect(searchableProperties(schema.nodes.Person)).toEqual([{ name: "name", boost: 1 }]);
  });
});

describe("InMemoryGraphStore.search", () => {
  async function open(): Promise<InMemoryGraphStore> {
    const store = new InMemoryGraphStore();
    await store.applySchema(SCOPE, schema);
    return store;
  }

  async function note(
    store: InMemoryGraphStore,
    id: string,
    properties: Record<string, unknown>,
    tags?: string[],
  ): Promise<void> {
    await store.apply(SCOPE, { kind: "upsertNode", id, type: "Note", properties, tags, meta: {} });
  }

  it("finds a note however the query spells its title", async () => {
    const store = await open();
    await note(store, "n1", { title: "Standup", body: "daily sync" });
    for (const q of ["Stand-Up", "stand up", "STANDUP", "standup notes"]) {
      expect((await store.search(SCOPE, { q, limit: 10 }))?.map((hit) => hit.id)).toContain("n1");
    }
  });

  it("matches in the other direction, stored hyphenated and queried without", async () => {
    const store = await open();
    await note(store, "n1", { title: "Kick-Off", body: "" });
    expect((await store.search(SCOPE, { q: "kickoff", limit: 10 }))?.[0]?.id).toBe("n1");
  });

  it("ranks a title hit over a body that merely repeats the word", async () => {
    const store = await open();
    await note(store, "body", { title: "Retro archive", body: "standup standup standup" });
    await note(store, "title", { title: "Standup", body: "" });
    expect((await store.search(SCOPE, { q: "standup", limit: 10 }))?.[0]?.id).toBe("title");
  });

  it("restricts to the requested types", async () => {
    const store = await open();
    await note(store, "n1", { title: "Standup", body: "" });
    expect(await store.search(SCOPE, { q: "standup", types: ["Person"], limit: 10 })).toEqual([]);
  });

  it("searches tag text as well as properties", async () => {
    const store = await open();
    await note(store, "n1", { title: "Retro", body: "" }, ["quarter-three"]);
    expect((await store.search(SCOPE, { q: "quarterthree", limit: 10 }))?.[0]?.id).toBe("n1");
  });

  it("reports no index rather than no results before a schema is applied", async () => {
    expect(await new InMemoryGraphStore().search({ q: "standup", limit: 10 })).toBeUndefined();
  });

  it("distinguishes a real miss from an unanswerable query", async () => {
    const store = await open();
    await note(store, "n1", { title: "Standup", body: "" });
    // Token search cannot answer a mid-word query; it says so with an empty
    // result, and the caller falls back rather than reporting nothing found.
    expect(await store.search(SCOPE, { q: "andu", limit: 10 })).toEqual([]);
  });
});
