import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CollabSession,
  InMemoryCollabBackend,
  InMemoryGraphStore,
  loadWorkspaceTypeFile,
} from "collabnode";
import { seedBoard } from "./seed.ts";
import { normalizeToolName, parseToolArgs, voiceToolset } from "./voice-tools.ts";

const wsType = await loadWorkspaceTypeFile(join(dirname(fileURLToPath(import.meta.url)), "../workspaces/voice-board.yaml"));
const schema = wsType.schema;


const session = await CollabSession.open(undefined, {
  schema,
  collab: new InMemoryCollabBackend(),
  graph: new InMemoryGraphStore(),
  actorId: "server",
});
await seedBoard(session);
const seeded = session.snapshot().nodes.filter((node) => node.type === "Note").length;

const toolset = voiceToolset(session, "echo");

// The voice agent gets reads plus identity upserts, and nothing destructive.
assert.ok(toolset.names.includes("graph_list"));
assert.ok(toolset.names.includes("graph_get"));
assert.ok(toolset.names.includes("upsert_node_Note"));
assert.ok(toolset.names.includes("upsert_edge_AUTHORED"));
assert.ok(!toolset.names.some((name) => name.startsWith("graph_delete")));
assert.ok(!toolset.names.includes("graph_query"));

// Every definition has to be a JSON Schema object Voice Live can send to the model.
for (const definition of toolset.definitions) {
  assert.equal(definition.type, "function");
  assert.ok(definition.description.length > 0);
  assert.equal(definition.parameters.type, "object");
  assert.ok(!("$schema" in definition.parameters));
}

const upsertNote = toolset.definitions.find((item) => item.name === "upsert_node_Note");
assert.ok(upsertNote);
const properties = upsertNote.parameters.properties as Record<string, unknown>;
assert.ok("title" in properties);
assert.ok("body" in properties);

// buildTools makes every upsert argument optional, which a realtime voice model
// reads as permission to create a Note with a title and no body. The schema's
// own `required: true` flags have to reach the tool definition.
assert.deepEqual(upsertNote.parameters.required, ["title", "body"]);

// Optional properties stay optional.
const upsertPerson = toolset.definitions.find((item) => item.name === "upsert_node_Person");
assert.ok(upsertPerson);
assert.deepEqual(upsertPerson.parameters.required, ["name"]);

// Read tools take no required arguments.
const list = toolset.definitions.find((item) => item.name === "graph_list");
assert.ok(list);
assert.equal(list.parameters.required, undefined);

// Arguments arrive as a JSON string on response.function_call_arguments.done.
assert.deepEqual(parseToolArgs('{"types":["Note"]}'), { types: ["Note"] });
assert.deepEqual(parseToolArgs(""), {});
assert.deepEqual(parseToolArgs("not json"), {});
assert.deepEqual(parseToolArgs(undefined), {});

// The azure-realtime preview leaks harmony control tokens into both the tool
// name and the arguments. Observed verbatim from the service:
//   name      graph_search<|meta_sep|>commentary
//   arguments {"types":["Note"],"q":"Groceries","limit":10}search<|meta_sep|>analysis code
const known = new Map(toolset.names.map((name) => [name, true]));
assert.equal(normalizeToolName("graph_search<|meta_sep|>commentary", known), "graph_search");
assert.equal(normalizeToolName("upsert_node_Note<|meta_sep|>commentary", known), "upsert_node_Note");
assert.equal(normalizeToolName("graph_list", known), "graph_list");
assert.equal(normalizeToolName("GRAPH_LIST", known), "graph_list");
assert.equal(normalizeToolName("totally_unknown", known), "totally_unknown");

assert.deepEqual(
  parseToolArgs('{"types":["Note"],"q":"Groceries","limit":10}search<|meta_sep|>analysis code'),
  { types: ["Note"], q: "Groceries", limit: 10 },
);
// Braces inside string values must not end the scan early.
assert.deepEqual(parseToolArgs('{"body":"a } b","title":"T"}trailing'), {
  body: "a } b",
  title: "T",
});
assert.deepEqual(parseToolArgs('{"body":"esc \\" } still"}junk'), { body: 'esc " } still' });
assert.deepEqual(parseToolArgs('{"a":{"b":1}}tail'), { a: { b: 1 } });

// A leaky name still reaches the tool, rather than looping on "unknown tool".
const viaLeakyName = JSON.parse(
  await toolset.call("graph_list<|meta_sep|>commentary", { types: ["Note"] }),
) as { total: number };
assert.equal(viaLeakyName.total, seeded);

// An genuinely unknown name reports what is callable, so the model can recover.
const bad = JSON.parse(await toolset.call("nope", {})) as { error: string; available: string[] };
assert.match(bad.error, /unknown tool/);
assert.ok(bad.available.includes("graph_list"));

const listed = JSON.parse(await toolset.call("graph_list", { types: ["Note"] })) as {
  total: number;
  nodes: Array<{ label: string }>;
};
assert.equal(listed.total, seeded);
assert.ok(listed.nodes.some((node) => node.label === "Standup"));

const created = JSON.parse(
  await toolset.call("upsert_node_Note", {
    title: "Retro",
    body: "## Went well\n\n- the WebRTC handshake\n",
  }),
) as { created: boolean; type: string; label: string };
assert.equal(created.created, true);
assert.equal(created.label, "Retro");

// Spoken writes are attributable: they land as `echo`, not as the server actor.
const retro = session.snapshot().nodes.find((node) => node.properties.title === "Retro");
assert.equal(retro?.meta.updatedBy, "echo");

// Destructive tools are not on the list at all.
const deleted = JSON.parse(await toolset.call("graph_delete_node", { id: retro?.id })) as {
  error: string;
};
assert.match(deleted.error, /unknown tool/);

await session.close();
console.log("voice-tools.test.ts ok");
