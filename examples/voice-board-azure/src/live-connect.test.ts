import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHub,
  loadWorkspaceTypeFile,
  openCollab,
  type CollabJoin,
} from "collabnode";
import { connect } from "@collabnode/web";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Start real Fluid backend (Tinylicious)
const { backend: collabBackend, join: collabJoin, close: closeCollab } = await openCollab(
  { kind: "fluid" },
  "server",
);

// 2. Start Hub with Fluid backend
const hub = await createHub({
  collab: collabBackend,
  graph: { kind: "memory" },
  sweepIntervalMs: 0,
});

const voiceType = await loadWorkspaceTypeFile(join(root, "workspaces/voice-board.yaml"));
const c4Type = await loadWorkspaceTypeFile(join(root, "workspaces/c4-architecture.yaml"));

hub.define(voiceType);
hub.define(c4Type);

const wsVoice = await hub.open("voice-board", {
  id: "voice-board-1",
  actorId: "server",
  params: { author: "Ada" },
});

const wsC4 = await hub.open("c4-architecture", {
  id: "c4-architecture-1",
  actorId: "server",
  params: { systemName: "Collabnode Platform", primaryUser: "Software Engineer" },
});

// 3. Simulate browser client joining Voice Board
const joinInfo = {
  documentId: wsVoice.session.id,
  schema: wsVoice.type.schema,
  collab: collabJoin as Extract<CollabJoin, { kind: "fluid" | "hocuspocus" }>,
};

const clientSession = await connect({
  schema: joinInfo.schema,
  documentId: joinInfo.documentId,
  actorId: "browser-user",
  collab: joinInfo.collab,
});

// 4. Verify client reads seeded notes & tasks
const clientSnapshot = clientSession.session.snapshot();
assert.equal(clientSnapshot.nodes.length, 6);
assert.equal(clientSnapshot.edges.length, 6);

const standup = clientSnapshot.nodes.find((n) => n.properties.title === "Standup");
assert.ok(standup);

// 5. Simulate client mutation
const newNoteId = await clientSession.session.upsertNode({
  type: "Note",
  properties: {
    title: "Client Live Test",
    body: "Created from web client",
  },
});
assert.ok(newNoteId);

// 6. Simulate browser client joining C4 Architecture board
const c4JoinInfo = {
  documentId: wsC4.session.id,
  schema: wsC4.type.schema,
  collab: collabJoin as Extract<CollabJoin, { kind: "fluid" | "hocuspocus" }>,
};

const c4ClientSession = await connect({
  schema: c4JoinInfo.schema,
  documentId: c4JoinInfo.documentId,
  actorId: "browser-architect",
  collab: c4JoinInfo.collab,
});

const c4Snapshot = c4ClientSession.session.snapshot();
assert.equal(c4Snapshot.nodes.length, 2);
assert.equal(c4Snapshot.edges.length, 1);

// 7. Cleanup
await clientSession.session.close();
await c4ClientSession.session.close();
await wsVoice.close();
await wsC4.close();
await hub.close();
await closeCollab();

console.log("live-connect.test.ts ok: Client successfully joined and synced with real Fluid Tinylicious backend without 0x8e4 error!");
