import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { InMemoryGraphStore } from "../src/memory.ts";
import { cosineSimilarity, vectorProperties, vectorText } from "../src/vector.ts";
import type { EmbeddingProvider } from "../src/vector.ts";

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
        vector: true
      body:
        type: text
        search: true
        vector: true
      pinned:
        type: boolean
  Person:
    properties:
      name:
        type: string
`);

/**
 * A stand-in for a real model: each topic owns one axis, and a text lands on
 * the axes whose words it uses. Words are not shared between a query and the
 * note it should find, which is the whole point — a lexical index cannot make
 * these matches and a stub that hashed tokens could not test that.
 */
const TOPICS = [
  ["hiring", "headcount", "interview", "recruiting", "candidate"],
  ["pricing", "invoice", "payment", "billing", "refund"],
  ["standup", "sync", "daily", "retro", "meeting"],
];

export function topicEmbeddings(): EmbeddingProvider {
  return {
    id: "topic-stub",
    dimensions: TOPICS.length + 1,
    async embed(texts) {
      return texts.map((text) => {
        const words = text.toLowerCase().split(/[^a-z0-9]+/);
        const vector = new Float32Array(TOPICS.length + 1);
        for (const word of words) {
          const axis = TOPICS.findIndex((topic) => topic.includes(word));
          // Everything unrecognized piles onto the last axis, so two unrelated
          // texts still look a little alike, the way real embeddings do.
          vector[axis === -1 ? TOPICS.length : axis] += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((value) => value / norm) as Float32Array;
      });
    },
  };
}

describe("vectorText", () => {
  it("joins the opted-in properties, in schema order", () => {
    expect(vectorProperties(schema.nodes.Note)).toEqual(["title", "body"]);
    expect(vectorText(schema.nodes.Note, { title: "Standup", body: "daily sync", pinned: true })).toBe(
      "Standup\ndaily sync",
    );
  });

  it("is empty for a type that opted out entirely", () => {
    expect(vectorProperties(schema.nodes.Person)).toEqual([]);
    expect(vectorText(schema.nodes.Person, { name: "Ada" })).toBe("");
  });

  it("skips a property that is present but blank", () => {
    expect(vectorText(schema.nodes.Note, { title: "Standup", body: "  " })).toBe("Standup");
  });
});

describe("cosineSimilarity", () => {
  it("scores an identical vector at 1 and an orthogonal one at 0", () => {
    const a = Float32Array.from([1, 0, 0]);
    expect(cosineSimilarity(a, Float32Array.from([1, 0, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0);
  });

  it("refuses to compare vectors of different widths rather than guessing", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});

describe("InMemoryGraphStore.searchVector", () => {
  async function open(embeddings = topicEmbeddings()): Promise<InMemoryGraphStore> {
    const store = new InMemoryGraphStore({ embeddings });
    await store.applySchema(SCOPE, schema);
    return store;
  }

  async function note(
    store: InMemoryGraphStore,
    id: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await store.apply(SCOPE, { kind: "upsertNode", id, type: "Note", properties, meta: {} });
  }

  it("finds a note by what it is about, not by the words it uses", async () => {
    const store = await open();
    await note(store, "hiring", { title: "Q3 headcount", body: "interview loop" });
    await note(store, "money", { title: "Invoice terms", body: "billing" });
    const hits = await store.searchVector(SCOPE, { q: "anything on recruiting?", limit: 10 });
    expect(hits?.[0]?.id).toBe("hiring");
    // The lexical index cannot: no word is shared with either note.
    expect(await store.search(SCOPE, { q: "anything on recruiting?", limit: 10 })).toEqual([]);
  });

  it("ranks by a node's own vector when given likeId, and leaves that node out", async () => {
    const store = await open();
    await note(store, "a", { title: "Q3 headcount", body: "interview loop" });
    await note(store, "b", { title: "Candidate pipeline", body: "recruiting" });
    await note(store, "c", { title: "Invoice terms", body: "billing" });
    const hits = await store.searchVector(SCOPE, { likeId: "a", limit: 10 });
    expect(hits?.map((hit) => hit.id)).toEqual(["b", "c"]);
  });

  it("restricts to the requested types", async () => {
    const store = await open();
    await note(store, "a", { title: "Q3 headcount", body: "" });
    expect(await store.searchVector(SCOPE, { q: "hiring", types: ["Person"], limit: 10 })).toEqual([]);
  });

  it("forgets a node's vector when the node is deleted", async () => {
    const store = await open();
    await note(store, "a", { title: "Q3 headcount", body: "" });
    await store.apply(SCOPE, { kind: "deleteNode", id: "a" });
    expect(await store.searchVector(SCOPE, { q: "hiring", limit: 10 })).toEqual([]);
  });

  it("re-embeds when the vectorized text changes", async () => {
    const store = await open();
    await note(store, "a", { title: "Q3 headcount", body: "" });
    await note(store, "a", { title: "Invoice terms", body: "" });
    const hits = await store.searchVector(SCOPE, { q: "billing", limit: 10 });
    expect(hits?.[0]?.id).toBe("a");
    expect((await store.searchVector(SCOPE, { q: "hiring", limit: 10 }))?.[0]?.score).toBeLessThan(0.5);
  });

  it("stays quiet about a subject the graph says nothing on", async () => {
    // A vector index always returns its nearest neighbour, however far away, so
    // "nothing here is about that" has to come from the provider's own sense of
    // where its scale stops meaning anything.
    const picky: EmbeddingProvider = { ...topicEmbeddings(), minSimilarity: 0.5 };
    const store = await open(picky);
    await note(store, "a", { title: "Q3 headcount", body: "interview loop" });
    expect(await store.searchVector(SCOPE, { q: "refund", limit: 10 })).toEqual([]);
    expect((await store.searchVector(SCOPE, { q: "hiring recruiting", limit: 10 }))?.[0]?.id).toBe("a");
  });

  it("keeps every neighbour when the provider declares no floor", async () => {
    const store = await open();
    await note(store, "a", { title: "Q3 headcount", body: "interview loop" });
    expect((await store.searchVector(SCOPE, { q: "refund", limit: 10 }))?.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("reports no index rather than no results when there is no provider", async () => {
    const store = new InMemoryGraphStore();
    await store.applySchema(SCOPE, schema);
    expect(await store.searchVector(SCOPE, { q: "hiring", limit: 10 })).toBeUndefined();
    expect(store.searchModes(SCOPE)).toEqual({ text: true, vector: false });
  });

  it("reports no vector index for a schema that never asked for one", async () => {
    const plain = parseSchemaDocument(`
name: Plain
version: 1
config: { schemaId: plain }
nodes:
  Note:
    properties:
      title: { type: string }
`);
    const store = new InMemoryGraphStore({ embeddings: topicEmbeddings() });
    await store.applySchema(SCOPE, plain);
    expect(store.searchModes(SCOPE)).toEqual({ text: true, vector: false });
    expect(await store.searchVector(SCOPE, { q: "hiring", limit: 10 })).toBeUndefined();
  });

  it("keeps the write when the provider fails, and simply has no vector for it", async () => {
    const broken: EmbeddingProvider = {
      id: "broken",
      dimensions: 4,
      async embed() {
        throw new Error("model is down");
      },
    };
    const store = await open(broken);
    await note(store, "a", { title: "Q3 headcount", body: "" });
    expect(store.getNode(SCOPE, "a")?.properties.title).toBe("Q3 headcount");
    expect(await store.searchVector(SCOPE, { q: "hiring", limit: 10 })).toBeUndefined();
  });
});
