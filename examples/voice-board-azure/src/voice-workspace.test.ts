import assert from "node:assert/strict";
import {
  CollabSession,
  InMemoryCollabBackend,
  InMemoryGraphStore,
  compileTemplate,
  localEmbeddings,
  loadWorkspaceTypeFile,
  createHub,
} from "collabnode";

// Load the declarative workspace type from workspaces/voice-board.yaml
const wsType = await loadWorkspaceTypeFile(new URL("../workspaces/voice-board.yaml", import.meta.url).pathname);

assert.equal(wsType.name, "voice-board");
assert.equal(wsType.version, 1);
assert.ok(wsType.schema.nodes.Note);
assert.ok(wsType.schema.nodes.Task);
assert.ok(wsType.schema.nodes.Person);
assert.ok(wsType.schema.edges.AUTHORED);
assert.ok(wsType.schema.edges.ASSIGNED_TO);
assert.ok(wsType.schema.edges.PRODUCES_TASK);

// Named tools validated
assert.ok(wsType.tools?.named?.dictate_note);
assert.equal(wsType.tools.named.dictate_note.creates, "Note");
assert.equal(wsType.tools.named.dictate_note.into, "AUTHORED");

assert.ok(wsType.tools?.named?.add_task);
assert.equal(wsType.tools.named.add_task.creates, "Task");
assert.equal(wsType.tools.named.add_task.into, "ASSIGNED_TO");

// Test template compilation (1 Person + 2 Notes + 3 Tasks + 2 AUTHORED + 3 ASSIGNED_TO + 1 PRODUCES_TASK = 12 ops)
const ops = compileTemplate(wsType, { author: "Ada" });
assert.equal(ops.length, 12);

// Test live seeding on CollabSession with in-memory store and local embeddings
let embeddings: any;
try {
  await import("@huggingface/transformers");
  embeddings = localEmbeddings();
} catch {
  embeddings = undefined;
}

const store = new InMemoryGraphStore({ embeddings });
const session = await CollabSession.open("voice-workspace-1", {
  schema: wsType.schema,
  collab: new InMemoryCollabBackend(),
  graph: store,
  actorId: "server",
});

const result = await session.seedTemplate(wsType, { author: "Ada" });
assert.equal(result.applied, 12);

const snapshot = session.snapshot();
assert.equal(snapshot.nodes.length, 6); // 1 Person, 2 Notes, 3 Tasks
assert.equal(snapshot.edges.length, 6); // 2 AUTHORED, 3 ASSIGNED_TO, 1 PRODUCES_TASK

// Validate Notes
const authorNode = snapshot.nodes.find((n) => n.type === "Person");
assert.ok(authorNode);
assert.equal(authorNode?.properties.name, "Ada");

const standupNode = snapshot.nodes.find((n) => n.properties.title === "Standup");
assert.ok(standupNode);
assert.equal(session.collabText(standupNode!.id, "body").toString(), "## Yesterday\n\n- shipped the WebRTC handshake\n");

const headcountNode = snapshot.nodes.find((n) => n.properties.title === "Q3 headcount");
assert.ok(headcountNode);

// Validate Tasks
const doneTask = snapshot.nodes.find((n) => n.properties.title === "Ship WebRTC reconnection");
assert.ok(doneTask);
assert.equal(doneTask?.properties.status, "done");
assert.equal(doneTask?.properties.priority, "high");

const doingTask = snapshot.nodes.find((n) => n.properties.title === "Interview backend candidate");
assert.ok(doingTask);
assert.equal(doingTask?.properties.status, "doing");

const todoTask = snapshot.nodes.find((n) => n.properties.title === "Update MCP documentation");
assert.ok(todoTask);
assert.equal(todoTask?.properties.status, "todo");

// Validate Task and Note relationships
const assignedEdges = snapshot.edges.filter((e) => e.type === "ASSIGNED_TO");
assert.equal(assignedEdges.length, 3);
assert.ok(assignedEdges.every((e) => e.to === authorNode?.id));

const producedEdges = snapshot.edges.filter((e) => e.type === "PRODUCES_TASK");
assert.equal(producedEdges.length, 1);
assert.equal(producedEdges[0]?.from, headcountNode?.id);
assert.equal(producedEdges[0]?.to, doingTask?.id);

// Search tests
const hits = await session.search({ q: "interview", limit: 5 });
assert.ok(hits && hits.length > 0);
const hitNode = snapshot.nodes.find((n) => n.id === hits[0]?.id);
assert.equal(hitNode?.type, "Task");

await session.close();


// Test Hub open with template auto-seeding for Voice Board
const hub = await createHub({
  sweepIntervalMs: 0,
});
hub.define(wsType);
const ws = await hub.open("voice-board", {
  id: "hub-voice-test",
  params: { author: "Ada" },
});
assert.equal(ws.session.snapshot().nodes.length, 6);
await ws.close();

// Validate C4 Architecture Workspace Type
const c4Type = await loadWorkspaceTypeFile(new URL("../workspaces/c4-architecture.yaml", import.meta.url).pathname);
assert.equal(c4Type.name, "c4-architecture");
assert.ok(c4Type.schema.nodes.Person);
assert.ok(c4Type.schema.nodes.SoftwareSystem);
assert.ok(c4Type.schema.nodes.Container);
assert.ok(c4Type.schema.nodes.Component);
assert.ok(c4Type.schema.edges.USES);
assert.ok(c4Type.schema.edges.CONTAINS);
assert.ok(c4Type.schema.edges.DELIVERS);

assert.ok(c4Type.tools?.named?.add_container);
assert.ok(c4Type.tools?.named?.add_component);

hub.define(c4Type);
const c4Ws = await hub.open("c4-architecture", {
  id: "hub-c4-test",
  params: {
    systemName: "Collabnode Platform",
    systemDescription: "Real-time ephemeral workspace runtime",
    primaryUser: "Software Engineer",
  },
});

// Canonical C4 starter template seeds 1 Person, 1 SoftwareSystem, 1 USES edge
const initialSnapshot = c4Ws.session.snapshot();
assert.equal(initialSnapshot.nodes.length, 2); // Person, SoftwareSystem
assert.equal(initialSnapshot.edges.length, 1); // USES

const coreSystem = initialSnapshot.nodes.find((n) => n.type === "SoftwareSystem");
assert.ok(coreSystem);
assert.equal(coreSystem?.properties.name, "Collabnode Platform");

const userPerson = initialSnapshot.nodes.find((n) => n.type === "Person");
assert.ok(userPerson);
assert.equal(userPerson?.properties.name, "Software Engineer");

// Live graph building: dynamically add Container and Component using the C4 schema
const webAppId = await c4Ws.session.upsertNode({
  type: "Container",
  properties: {
    name: "Web SPA Client",
    technology: "TypeScript, Vite, CodeMirror",
    description: "Browser frontend for collaborative editing",
    kind: "single_page_app",
  },
});
await c4Ws.session.upsertEdge({
  type: "CONTAINS",
  from: coreSystem!.id,
  to: webAppId,
});

const apiId = await c4Ws.session.upsertNode({
  type: "Container",
  properties: {
    name: "Hub API Server",
    technology: "Node.js, TypeScript",
    description: "Multi-tenant workspace runtime",
    kind: "api",
  },
});
await c4Ws.session.upsertEdge({
  type: "CONTAINS",
  from: coreSystem!.id,
  to: apiId,
});

await c4Ws.session.upsertEdge({
  type: "USES",
  from: webAppId,
  to: apiId,
  properties: { description: "Calls MCP and syncs CRDT", technology: "WebSocket / HTTPS" },
});

// Verify live graph state
const updatedSnapshot = c4Ws.session.snapshot();
assert.equal(updatedSnapshot.nodes.length, 4); // 1 Person, 1 SoftwareSystem, 2 Container
assert.equal(updatedSnapshot.edges.length, 4); // 1 initial USES, 2 CONTAINS, 1 new USES

await c4Ws.close();
await hub.close();

console.log("voice-workspace.test.ts ok: Multi-schema validation passed for Voice Board (Notes & Tasks) and C4 Architecture");


