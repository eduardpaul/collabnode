import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { LadybugGraphStore } from "../src/store.ts";

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
        search: { boost: 6 }
      notes:
        type: text
        search: true
  Person:
    properties:
      name:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
`);

async function hasNative(): Promise<boolean> {
  try {
    await import("@ladybugdb/core");
    return true;
  } catch {
    return false;
  }
}

async function upsert(
  store: LadybugGraphStore,
  id: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await store.apply(SCOPE, { kind: "upsertNode", id, type: "Task", properties, meta: {} });
}

describe("LadybugGraphStore native", () => {
  it("applies schema and queries via Cypher", async (ctx) => {
    if (!(await hasNative())) {
      ctx.skip("@ladybugdb/core native binding is not installed");
    }
    const dir = await mkdtemp(join(tmpdir(), "collabnode-lbug-"));
    const store = new LadybugGraphStore({ path: join(dir, "graph.lbdb") });
    try {
      await store.applySchema(SCOPE, schema);
      await store.apply(SCOPE, {
        kind: "upsertNode",
        id: "t1",
        type: "Task",
        properties: { title: "Ship" },
        meta: { updatedBy: "ada" },
      });
      await store.apply(SCOPE, {
        kind: "upsertNode",
        id: "p1",
        type: "Person",
        properties: { name: "Ada" },
        meta: {},
      });
      await store.apply(SCOPE, {
        kind: "upsertEdge",
        id: "e1",
        type: "ASSIGNED_TO",
        from: "t1",
        to: "p1",
        properties: {},
        meta: {},
      });
      const result = await store.query(SCOPE, 
        "MATCH (a:Task)-[r:ASSIGNED_TO]->(b:Person) RETURN a.title, b.name",
      );
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LadybugGraphStore native full-text search", () => {
  it("finds a note however the query spells it, and stays current as rows change", async (ctx) => {
    if (!(await hasNative())) {
      ctx.skip("@ladybugdb/core native binding is not installed");
    }
    const dir = await mkdtemp(join(tmpdir(), "collabnode-lbfts-"));
    const store = new LadybugGraphStore({ path: join(dir, "graph.lbdb") });
    try {
      await store.applySchema(SCOPE, schema);
      // Ladybug downloads the FTS extension on first use. Offline, applySchema
      // leaves search unavailable rather than failing, and there is nothing to
      // assert here.
      const available = await store.search(SCOPE, { q: "anything", limit: 5 });
      if (available === undefined) {
        return;
      }

      await upsert(store, "t1", { title: "Standup", notes: "daily sync" });
      await upsert(store, "t2", { title: "Pay flow", notes: "billing standup standup standup" });

      const hyphenated = await store.search(SCOPE, { q: "Stand-Up", limit: 10 });
      expect(hyphenated?.map((hit) => hit.id)).toContain("t1");

      // The reverse direction: stored hyphenated, queried without.
      await upsert(store, "t3", { title: "Kick-Off", notes: "" });
      expect((await store.search(SCOPE, { q: "kickoff", limit: 10 }))?.map((hit) => hit.id)).toContain("t3");

      // A title hit outranks a body that merely repeats the word, because the
      // title tier carries the schema boost.
      const ranked = await store.search(SCOPE, { q: "standup", limit: 10 });
      expect(ranked?.[0]?.id).toBe("t1");

      // Ladybug maintains the index itself, so a fresh write is searchable with
      // no rebuild step in between.
      await upsert(store, "t4", { title: "Retro", notes: "quarterly" });
      expect((await store.search(SCOPE, { q: "quarterly", limit: 10 }))?.map((hit) => hit.id)).toEqual(["t4"]);

      await store.apply(SCOPE, { kind: "deleteNode", id: "t4" });
      expect(await store.search(SCOPE, { q: "quarterly", limit: 10 })).toEqual([]);

      expect(await store.search(SCOPE, { q: "standup", types: ["Person"], limit: 10 })).toEqual([]);
      expect(await store.search(SCOPE, { q: "   ", limit: 10 })).toEqual([]);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** The same topic-per-axis stand-in the graph package tests use, so no test downloads a model. */
const TOPICS = [
  ["hiring", "headcount", "interview", "recruiting", "candidate"],
  ["pricing", "invoice", "payment", "billing", "refund"],
  ["standup", "sync", "daily", "retro", "meeting"],
];

const topicEmbeddings: EmbeddingProvider = {
  id: "topic-stub",
  dimensions: TOPICS.length + 1,
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Float32Array(TOPICS.length + 1);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
        const axis = TOPICS.findIndex((topic) => topic.includes(word));
        vector[axis === -1 ? TOPICS.length : axis] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm) as Float32Array;
    });
  },
};

const vectorSchema = parseSchemaDocument(`
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
        search: { boost: 6 }
        vector: true
      notes:
        type: text
        search: true
        vector: true
  Person:
    properties:
      name:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
`);

describe("LadybugGraphStore native vector search", () => {
  it("finds a task by meaning, and keeps the index current as rows change", async (ctx) => {
    if (!(await hasNative())) {
      ctx.skip("@ladybugdb/core native binding is not installed");
    }
    const dir = await mkdtemp(join(tmpdir(), "collabnode-lbvec-"));
    const store = new LadybugGraphStore({
      path: join(dir, "graph.lbdb"),
      embeddings: topicEmbeddings,
    });
    try {
      await store.applySchema(SCOPE, vectorSchema);
      // Ladybug downloads the vector extension on first use. Offline,
      // applySchema leaves the index unavailable rather than failing.
      if (!store.searchModes(SCOPE).vector) {
        return;
      }

      await upsert(store, "t1", { title: "Q3 headcount", notes: "interview loop" });
      await upsert(store, "t2", { title: "Invoice terms", notes: "billing" });

      // No word here appears in either task, which is exactly what full text
      // cannot do.
      const hits = await store.searchVector(SCOPE, { q: "anything on recruiting?", limit: 10 });
      expect(hits?.[0]?.id).toBe("t1");
      expect((await store.search(SCOPE, { q: "anything on recruiting?", limit: 10 }))?.length ?? 0).toBe(0);

      // Written after the index was built: Ladybug maintains HNSW itself.
      await upsert(store, "t3", { title: "Candidate pipeline", notes: "" });
      const fresh = await store.searchVector(SCOPE, { q: "hiring", limit: 10 });
      expect(fresh?.map((hit) => hit.id)).toContain("t3");

      // "More like this" ranks by a stored vector and never returns its subject.
      const similar = await store.searchVector(SCOPE, { likeId: "t1", limit: 10 });
      expect(similar?.map((hit) => hit.id)).not.toContain("t1");
      expect(similar?.[0]?.id).toBe("t3");

      // Re-embedded when the vectorized text changes.
      await upsert(store, "t3", { title: "Refund policy", notes: "" });
      expect((await store.searchVector(SCOPE, { q: "billing", limit: 3 }))?.[0]?.id).not.toBe("t1");

      await store.apply(SCOPE, { kind: "deleteNode", id: "t3" });
      expect((await store.searchVector(SCOPE, { q: "hiring", limit: 10 }))?.map((hit) => hit.id)).not.toContain(
        "t3",
      );

      expect(await store.searchVector(SCOPE, { q: "hiring", types: ["Person"], limit: 10 })).toEqual([]);
      expect(await store.searchVector(SCOPE, { q: "   ", limit: 10 })).toBeUndefined();
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("backfills the rows that were written while the provider was failing", async (ctx) => {
    if (!(await hasNative())) {
      ctx.skip("@ladybugdb/core native binding is not installed");
    }
    // A provider that starts out broken reproduces the state the backfill
    // exists for — rows in the graph, no vectors against them — without
    // reopening the database, which Ladybug does not survive in-process once a
    // full-text index exists on it.
    let broken = true;
    const flaky: EmbeddingProvider = {
      id: topicEmbeddings.id,
      dimensions: topicEmbeddings.dimensions,
      async embed(texts, kind) {
        if (broken) {
          throw new Error("model is down");
        }
        return topicEmbeddings.embed(texts, kind);
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "collabnode-lbback-"));
    const store = new LadybugGraphStore({ path: join(dir, "graph.lbdb"), embeddings: flaky });
    try {
      await store.applySchema(SCOPE, vectorSchema);
      if (!store.searchModes(SCOPE).vector) {
        return;
      }
      await upsert(store, "t1", { title: "Q3 headcount", notes: "interview loop" });
      // The write landed; only its vector is missing.
      expect((await store.query(SCOPE, "MATCH (n:Task) RETURN n.id")).rows).toHaveLength(1);

      broken = false;
      // The index is there and the query embeds now, but nothing was ever
      // written into it.
      expect(await store.searchVector(SCOPE, { q: "recruiting", limit: 10 })).toEqual([]);

      await store.reindexVectors();
      expect((await store.searchVector(SCOPE, { q: "recruiting", limit: 10 }))?.[0]?.id).toBe("t1");
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LadybugGraphStore native restart", () => {
  it("can reopen a database it wrote to", async (ctx) => {
    if (!(await hasNative())) {
      ctx.skip("@ladybugdb/core native binding is not installed");
    }
    // Ladybug leaves full-text and vector index updates in the write-ahead log,
    // and replaying them on the next open segfaults the process instead of
    // raising — so an unchecked store cannot reopen its own database. `close()`
    // checkpoints to prevent that, and only a real reopen proves it.
    const dir = await mkdtemp(join(tmpdir(), "collabnode-lbrestart-"));
    const path = join(dir, "graph.lbdb");
    try {
      const first = new LadybugGraphStore({ path, embeddings: topicEmbeddings });
      await first.applySchema(SCOPE, vectorSchema);
      const indexed = first.searchModes(SCOPE);
      await upsert(first, "t1", { title: "Q3 headcount", notes: "interview loop" });
      await first.close();

      const second = new LadybugGraphStore({ path, embeddings: topicEmbeddings });
      await second.applySchema(SCOPE, vectorSchema);
      try {
        expect((await second.query(SCOPE, "MATCH (n:Task) RETURN n.id")).rows).toHaveLength(1);
        if (indexed.text) {
          expect((await second.search(SCOPE, { q: "headcount", limit: 5 }))?.map((hit) => hit.id)).toEqual([
            "t1",
          ]);
        }
        if (indexed.vector) {
          expect((await second.searchVector(SCOPE, { q: "recruiting", limit: 5 }))?.[0]?.id).toBe("t1");
        }
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
