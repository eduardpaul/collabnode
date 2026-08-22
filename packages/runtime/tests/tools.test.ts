import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore, type EmbeddingProvider } from "@collabnode/graph";
import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  bindGraphTools,
  CollabSession,
  deleteGraphNode,
  graphActors,
  graphChanges,
  graphDescribe,
  graphGet,
  graphList,
  graphNeighbors,
  graphQuery,
  graphSearch,
  graphSimilar,
  upsertGraphEdge,
  upsertGraphNode,
} from "../src/index.ts";

const schema = parseSchemaDocument(`
name: IdeaBoard
version: 1
config:
  schemaId: idea-board
  tags:
    enabled: true
  changeTracking:
    enabled: true
    mode: last-write
nodes:
  Feature:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
      description:
        type: string
    ui:
      label: "{title}"
  Task:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
      notes:
        type: string
    ui:
      label: "{title}"
  Person:
    properties:
      name:
        type: string
        required: true
    ui:
      label: "{name}"
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    ui:
      label: assigned
  PART_OF:
    from: [Task]
    to: [Feature]
`);

async function open() {
  return CollabSession.open(undefined, {
    schema,
    collab: new InMemoryCollabBackend(),
    graph: new InMemoryGraphStore(),
    actorId: "ada",
  });
}

describe("standalone graph tools", () => {
  it("describes types, identity, and properties", async () => {
    const session = await open();
    const described = graphDescribe(session);
    expect(described.name).toBe("IdeaBoard");
    expect(described.nodes.Task?.identity).toEqual(["title"]);
    expect(described.nodes.Task?.properties.title?.required).toBe(true);
    expect(described.edges.ASSIGNED_TO?.from).toEqual(["Task"]);
    expect(described.reads).toContain("graph_list");
    await session.close();
  });

  it("lists a compact index and searches without q", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Feature", properties: { title: "Checkout" }, tags: ["q3"] });
    await upsertGraphNode(session, { type: "Task", properties: { title: "Ship" }, tags: ["q3"] });
    const listed = graphList(session, { types: ["Task"] });
    expect(listed.total).toBe(1);
    expect(listed.nodes[0]).toMatchObject({ type: "Task", label: "Ship" });
    expect(listed.nodes[0]?.properties).toEqual({ title: "Ship" });
    const tagged = await graphSearch(session, { tag: "q3" });
    expect(tagged.total).toBe(2);
    expect(tagged.nodes.map((node) => node.type).sort()).toEqual(["Feature", "Task"]);
    await session.close();
  });

  it("gets by unique id prefix and writes back derived-free records", async () => {
    const session = await open();
    const created = await upsertGraphNode(session, { type: "Person", properties: { name: "Ada" } });
    expect(created.created).toBe(true);
    expect(created.label).toBe("Ada");
    const got = graphGet(session, { id: created.id.slice(0, 8) });
    expect(got.kind).toBe("node");
    if (got.kind === "node") {
      expect(got.node.label).toBe("Ada");
    }
    await session.close();
  });

  it("walks neighbors to depth 2", async () => {
    const session = await open();
    const feature = await upsertGraphNode(session, { type: "Feature", properties: { title: "Checkout" } });
    const task = await upsertGraphNode(session, { type: "Task", properties: { title: "Ship" } });
    const person = await upsertGraphNode(session, { type: "Person", properties: { name: "Ada" } });
    await upsertGraphEdge(session, { type: "PART_OF", from: task.id, to: feature.id });
    await upsertGraphEdge(session, { type: "ASSIGNED_TO", from: task.id, to: person.id });
    const one = graphNeighbors(session, { id: feature.id, direction: "in" });
    expect(one.neighbors).toHaveLength(1);
    expect(one.neighbors[0]?.node.id).toBe(task.id);
    const two = graphNeighbors(session, { id: feature.id, depth: 2 });
    expect(two.neighbors.map((row) => row.node.id).sort()).toEqual([person.id, task.id].sort());
    expect(two.neighbors.some((row) => row.depth === 2 && row.node.id === person.id)).toBe(true);
    await session.close();
  });

  it("links by identity object and find-or-links endpoints", async () => {
    const session = await open();
    const task = await upsertGraphNode(session, { type: "Task", properties: { title: "Ship" } });
    const person = await upsertGraphNode(session, { type: "Person", properties: { name: "Ada" } });
    const first = await upsertGraphEdge(session, {
      type: "ASSIGNED_TO",
      from: { type: "Task", title: "Ship" },
      to: { type: "Person", name: "Ada" },
    });
    expect(first.created).toBe(true);
    expect(first.from).toBe(task.id);
    expect(first.to).toBe(person.id);
    const second = await upsertGraphEdge(session, {
      type: "ASSIGNED_TO",
      from: task.id,
      to: person.id,
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    await session.close();
  });

  it("rejects mutating cypher and missing deletes", async () => {
    const session = await open();
    const node = await upsertGraphNode(session, { type: "Feature", properties: { title: "Checkout" } });
    await expect(graphQuery(session, { cypher: "CREATE (n:Task)" })).rejects.toThrow(/read-only/);
    await expect(deleteGraphNode(session, { id: "missing" })).rejects.toThrow(/unknown id/);
    const deleted = await deleteGraphNode(session, { id: node.id });
    expect(deleted).toMatchObject({ existed: true, kind: "node", type: "Feature", cascadedEdges: 0 });
    await session.close();
  });

  it("reports last-write changes and actors", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Feature", properties: { title: "Checkout" } });
    const changes = graphChanges(session, {});
    expect(changes.mode).toBe("last-write");
    expect(changes.deletesOmitted).toBe(true);
    expect(changes.events.some((event) => event.label === "Checkout")).toBe(true);
    const actors = graphActors(session);
    expect(actors.sessionActorId).toBe("ada");
    expect(actors.actors.map((row) => row.actorId)).toContain("ada");
    const bound = bindGraphTools(session);
    expect(bound.graphList({ types: ["Feature"] }).total).toBe(1);
    await session.close();
  });

  it("returns created=false and full properties on identity upsert", async () => {
    const session = await open();
    const first = await upsertGraphNode(session, { type: "Feature", properties: { title: "Checkout" } });
    const second = await upsertGraphNode(session, {
      type: "Feature",
      properties: { title: "Checkout", description: "Pay flow" },
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.properties.description).toBe("Pay flow");
    await session.close();
  });
});

describe("search tolerates how people actually spell things", () => {
  const spellings = ["Stand-Up", "stand up", "STANDUP", "standup", "standup notes"];

  it.each(spellings)("finds a note titled 'Standup' when asked for %j", async (q) => {
    const session = await open();
    await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    expect((await graphSearch(session, { q })).nodes[0]?.label).toBe("Standup");
    await session.close();
  });

  it("matches in the other direction too, stored hyphenated and queried without", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Task", properties: { title: "Stand-Up" } });
    expect((await graphSearch(session, { q: "standup" })).nodes[0]?.label).toBe("Stand-Up");
    await session.close();
  });

  it("ranks the exact title above a note that merely mentions it", async () => {
    const session = await open();
    await upsertGraphNode(session, {
      type: "Task",
      properties: { title: "Standup retro archive", notes: "standup standup standup" },
    });
    await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    const found = await graphSearch(session, { q: "standup" });
    expect(found.nodes[0]?.label).toBe("Standup");
    expect(found.nodes[0]?.score).toBeGreaterThan(found.nodes[1]?.score ?? 0);
    await session.close();
  });

  it("still answers mid-word substring queries the index cannot tokenize", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Feature", properties: { title: "Pay flow" } });
    const found = await graphSearch(session, { q: "ay" });
    expect(found.nodes.map((node) => node.label)).toEqual(["Pay flow"]);
    // Fallback hits are unranked, and say so rather than inventing a score.
    expect(found.nodes[0]?.score).toBeUndefined();
    await session.close();
  });

  it("honours type and tag filters on ranked hits", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" }, tags: ["q3"] });
    await upsertGraphNode(session, { type: "Feature", properties: { title: "Standup" } });
    expect((await graphSearch(session, { q: "standup", types: ["Feature"] })).total).toBe(1);
    expect((await graphSearch(session, { q: "standup", tag: "q3" })).nodes[0]?.type).toBe("Task");
    await session.close();
  });

  it("finds a write as soon as it lands, and stops finding a delete", async () => {
    const session = await open();
    const { id } = await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    expect((await graphSearch(session, { q: "stand-up" })).total).toBe(1);
    await upsertGraphNode(session, { type: "Task", id, properties: { title: "Standup", notes: "moved to Fridays" } });
    expect((await graphSearch(session, { q: "fridays" })).total).toBe(1);
    await deleteGraphNode(session, { id });
    expect((await graphSearch(session, { q: "stand-up" })).total).toBe(0);
    await session.close();
  });

  it("sees what a runAs clone wrote, since both project into one store", async () => {
    const session = await open();
    const echo = session.runAs("echo");
    await upsertGraphNode(echo, { type: "Task", properties: { title: "Standup" } });
    expect((await graphSearch(session, { q: "Stand-Up" })).total).toBe(1);
    await session.close();
  });
});

describe("upsert adopts a near-miss identity instead of duplicating", () => {
  it("updates the stored note and keeps its original spelling", async () => {
    const session = await open();
    const original = await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    const again = await upsertGraphNode(session, {
      type: "Task",
      properties: { title: "Stand-Up", notes: "moved to Fridays" },
    });
    expect(again.id).toBe(original.id);
    expect(again.created).toBe(false);
    const node = session.snapshot().nodes.find((record) => record.id === original.id);
    // The id hashes the stored title, so that spelling has to win.
    expect(node?.properties.title).toBe("Standup");
    expect(node?.properties.notes).toBe("moved to Fridays");
    expect(session.snapshot().nodes).toHaveLength(1);
    await session.close();
  });

  it("creates rather than guessing when two stored notes both nearly match", async () => {
    const session = await open();
    // An explicit id skips adoption, which is how a graph written before this
    // existed ends up holding two spellings of one name.
    await upsertGraphNode(session, { type: "Task", id: "seed-a", properties: { title: "Stand Up" } });
    await upsertGraphNode(session, { type: "Task", id: "seed-b", properties: { title: "stand-up" } });
    expect(session.snapshot().nodes).toHaveLength(2);
    await upsertGraphNode(session, { type: "Task", properties: { title: "STANDUP" } });
    expect(session.snapshot().nodes).toHaveLength(3);
    await session.close();
  });

  it("resolves an edge ref through a near-miss title", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    const person = await upsertGraphNode(session, { type: "Person", properties: { name: "Ada" } });
    await expect(
      upsertGraphEdge(session, {
        type: "ASSIGNED_TO",
        from: { type: "Task", title: "Stand-Up" },
        to: person.id,
      }),
    ).resolves.toBeTruthy();
    await session.close();
  });
});

/**
 * A stand-in for a real model: each topic owns one axis, and a text lands on
 * the axes whose words it uses. A query and the note it should find share no
 * words at all, which is exactly the case full text cannot serve.
 */
const TOPICS = [
  ["hiring", "headcount", "interview", "recruiting", "candidate"],
  ["pricing", "invoice", "payment", "billing", "refund"],
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
name: NoteBoard
version: 1
config:
  schemaId: note-board
nodes:
  Note:
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
        search: { boost: 6 }
        vector: true
      body:
        type: string
        search: true
        vector: true
`);

async function openVector() {
  return CollabSession.open(undefined, {
    schema: vectorSchema,
    collab: new InMemoryCollabBackend(),
    graph: new InMemoryGraphStore({ embeddings: topicEmbeddings }),
    actorId: "ada",
  });
}

async function note(session: CollabSession, title: string, body = ""): Promise<string> {
  const { id } = await upsertGraphNode(session, { type: "Note", properties: { title, body } });
  return id;
}

describe("search answers by meaning as well as by wording", () => {
  it("finds a note about the subject even when it never uses the word", async () => {
    const session = await openVector();
    await note(session, "Q3 headcount", "interview loop");
    await note(session, "Invoice terms", "billing");
    const found = await graphSearch(session, { q: "what did we decide about recruiting?" });
    expect(found.nodes[0]?.label).toBe("Q3 headcount");
    // Says how it matched, so a caller can tell "about that" from "called that".
    expect(found.nodes[0]?.match).toBe("vector");
    await session.close();
  });

  it("keeps the exactly-named note on top when the query is a name", async () => {
    const session = await openVector();
    await note(session, "Interview loop", "candidate feedback");
    await note(session, "Hiring", "");
    const found = await graphSearch(session, { q: "hiring" });
    expect(found.nodes[0]?.label).toBe("Hiring");
    await session.close();
  });

  it("reports a hit both indexes agree on as matching both ways", async () => {
    const session = await openVector();
    await note(session, "Interview loop", "candidate screening");
    const found = await graphSearch(session, { q: "interview" });
    expect(found.nodes[0]?.match).toBe("both");
    await session.close();
  });

  it("leaves out the merely-nearest, since a vector index always returns something", async () => {
    const session = await openVector();
    await note(session, "Q3 headcount", "interview loop");
    await note(session, "Invoice terms", "billing refund");
    const found = await graphSearch(session, { q: "recruiting" });
    expect(found.nodes.map((node) => node.label)).toEqual(["Q3 headcount"]);
    await session.close();
  });

  it("scores and orders exactly as before when nothing is embedded", async () => {
    const session = await open();
    await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    const found = await graphSearch(session, { q: "stand-up" });
    expect(found.nodes[0]?.match).toBe("text");
    expect(found.nodes[0]?.score).toBeGreaterThan(0);
    expect(session.searchModes()).toEqual({ text: true, vector: false });
    await session.close();
  });
});

describe("graph_similar takes a node, not a query", () => {
  it("ranks other nodes by how much they read like the given one", async () => {
    const session = await openVector();
    const source = await note(session, "Q3 headcount", "interview loop");
    await note(session, "Candidate pipeline", "recruiting");
    await note(session, "Invoice terms", "billing refund");
    const found = await graphSimilar(session, { id: source });
    expect(found.nodes.map((node) => node.label)).toEqual(["Candidate pipeline"]);
    expect(found.nodes[0]?.match).toBe("vector");
    await session.close();
  });

  it("never returns the node it was asked about", async () => {
    const session = await openVector();
    const source = await note(session, "Q3 headcount", "interview loop");
    const found = await graphSimilar(session, { id: source });
    expect(found.nodes.map((node) => node.id)).not.toContain(source);
    await session.close();
  });

  it("comes back empty rather than failing where nothing is embedded", async () => {
    const session = await open();
    const { id } = await upsertGraphNode(session, { type: "Task", properties: { title: "Standup" } });
    expect(await graphSimilar(session, { id })).toEqual({ nodes: [], total: 0 });
    await session.close();
  });

  it("is only advertised where the store can embed", async () => {
    const vector = await openVector();
    expect(graphDescribe(vector).reads).toContain("graph_similar");
    await vector.close();
    const lexical = await open();
    expect(graphDescribe(lexical).reads).not.toContain("graph_similar");
    await lexical.close();
  });
});
