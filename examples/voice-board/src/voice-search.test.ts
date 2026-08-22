// Scripted stand-in for a voice call: drives the real voice toolset against the
// real schema + seed, so the tools the model sees are the ones under test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CollabSession,
  InMemoryCollabBackend,
  InMemoryGraphStore,
  localEmbeddings,
  loadWorkspaceTypeFile,
  type EmbeddingProvider,
} from "collabnode";
import { seedBoard } from "./seed.ts";
import { voiceToolset } from "./voice-tools.ts";

const wsType = await loadWorkspaceTypeFile(fileURLToPath(new URL("../workspaces/voice-board.yaml", import.meta.url)));
const schema = wsType.schema;

// The real model when it is installed, so this exercises what a user gets;
// nothing when it is not, and the semantic half of the run is skipped.
let embeddings: EmbeddingProvider | undefined;
try {
  await import("@huggingface/transformers");
  embeddings = localEmbeddings();
} catch {
  embeddings = undefined;
}

const session = await CollabSession.open(undefined, {
  schema,
  collab: new InMemoryCollabBackend(),
  graph: new InMemoryGraphStore({ embeddings }),
  actorId: "typist",
});
await seedBoard(session);
const tools = voiceToolset(session, "echo");
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(await tools.call(name, args));

const notes = () => session.snapshot().nodes.filter((node) => node.type === "Note");
console.log("seeded:", notes().map((node) => node.properties.title));

// The reported bug, in the words the model actually used.
for (const q of ["Stand-Up", "stand up", "STANDUP", "stand-up notes"]) {
  const found = await call("graph_search", { q, types: ["Note"] });
  assert.equal(found.nodes[0]?.label, "Standup", `q=${q}`);
  console.log(`graph_search q=${JSON.stringify(q)} -> ${found.nodes[0].label} (score ${found.nodes[0].score?.toFixed(1)})`);
}

// Dictating into it under the misheard title must not spawn a twin.
const before = notes().length;
const wrote = await call("upsert_node_Note", {
  title: "Stand-Up",
  body: "## Standup\n- shipped search",
});
assert.equal(wrote.created, false, "should update, not create");
assert.equal(notes().length, before, "note count must not grow");
assert.equal(wrote.label, "Standup", "stored title wins");
console.log(`upsert_node_Note title="Stand-Up" -> created=${wrote.created}, label=${wrote.label}, notes=${notes().length}`);

// Linking by a misheard title resolves too.
const edge = await call("upsert_edge_AUTHORED", {
  from: { type: "Person", name: "Ada" },
  to: { type: "Note", title: "Stand-Up" },
});
assert.ok(!edge.error, `edge failed: ${edge.error}`);
console.log("upsert_edge_AUTHORED to {title: 'Stand-Up'} -> ok");

// The half full text cannot do: no note contains the word "hiring".
if (session.searchModes().vector) {
  assert.ok(tools.names.includes("graph_similar"), "graph_similar should be offered");

  const asked = await call("graph_search", { q: "what did we decide about hiring?", types: ["Note"] });
  assert.equal(asked.nodes[0]?.label, "Q3 headcount");
  assert.equal(asked.nodes[0]?.match, "vector", "should be found by meaning, not wording");
  console.log(`graph_search q="what did we decide about hiring?" -> ${asked.nodes[0].label} (${asked.nodes[0].match})`);

  // Asking by name still puts the named note first, ahead of anything merely related.
  const named = await call("graph_search", { q: "standup", types: ["Note"] });
  assert.equal(named.nodes[0]?.label, "Standup");
  console.log(`graph_search q="standup" -> ${named.nodes[0].label} (${named.nodes[0].match})`);

  const similar = await call("graph_similar", { id: asked.nodes[0].id });
  assert.ok(
    !similar.nodes.some((node: { id: string }) => node.id === asked.nodes[0].id),
    "graph_similar must not return its own subject",
  );
  console.log(`graph_similar id=<Q3 headcount> -> ${similar.nodes.map((n: { label: string }) => n.label).join(", ") || "(nothing close enough)"}`);
} else {
  console.log("semantic search skipped: @huggingface/transformers is not installed");
}

await session.close();
console.log("voice-search.test.ts ok");
