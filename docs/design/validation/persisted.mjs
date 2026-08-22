// With persistence enabled (what any real deployment needs for crash recovery),
// does anything remove a terminated workspace?
//
// Before step 1 the answer was no: `CollabBackend` had only create/join, and a
// closed workspace stayed fully readable by anyone holding its id. This script
// is the regression guard for that.
const ROOT = "/home/eduapaul/repos/collabnode";
const { CollabSession, loadSchemaFile } = await import(`${ROOT}/packages/node/dist/index.js`);
const { HocuspocusCollabBackend } = await import(`${ROOT}/packages/hocuspocus/dist/index.js`);
const { deleteHocuspocusDocument } = await import(`${ROOT}/packages/hocuspocus/dist/node.js`);
const { Server } = await import(
  `${ROOT}/packages/hocuspocus/node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js`
);
const Y = await import(`${ROOT}/packages/hocuspocus/node_modules/yjs/dist/yjs.mjs`);

const schema = await loadSchemaFile(`${ROOT}/packages/bench/schema.yaml`);

/** Stand-in for the SQLite/Redis persistence any production Hocuspocus runs. */
const disk = new Map();
const persistence = {
  async onStoreDocument({ documentName, document }) {
    disk.set(documentName, Y.encodeStateAsUpdate(document));
  },
  async onLoadDocument({ documentName, document }) {
    const stored = disk.get(documentName);
    if (stored) Y.applyUpdate(document, stored);
    return document;
  },
};

const server = new Server({
  port: 1241, address: "127.0.0.1", quiet: true, stopOnSignals: false,
  extensions: [persistence],
});
await server.listen();
const backend = new HocuspocusCollabBackend({ url: "ws://127.0.0.1:1241" });

console.log(`backend capabilities: ${JSON.stringify(backend.capabilities)}`);

// Five workspaces, opened under caller-chosen ids and ended with destroy().
const ids = [];
for (let i = 0; i < 5; i += 1) {
  const id = `retro-${i}`;
  const session = await CollabSession.open(id, { schema, collab: backend, actorId: "host" });
  ids.push(id);
  await session.upsertNode({ type: "Task", properties: { title: `secret ${i}`, status: "todo" } });
  const artifact = await session.destroy();
  if (i === 0) {
    console.log(`destroy() returned the final snapshot: ${artifact.nodes.length} node(s), ` +
      `"${artifact.nodes[0]?.properties.title}"`);
  }
  await deleteHocuspocusDocument(server, id, (name) => disk.delete(name));
}
await new Promise((r) => setTimeout(r, 1000));

console.log(`resident documents:  ${server.hocuspocus.getDocumentsCount()}`);
console.log(`persisted documents: ${disk.size}`);
console.log(`bytes retained:      ${[...disk.values()].reduce((a, b) => a + b.length, 0)}`);

// What survives is framing, not content. A persistence extension debounces its
// writes, so an empty state can land after the purge; the record is a tombstone.
let retainedNodes = 0;
for (const update of disk.values()) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const nodes = doc.getMap("collabnode").get("nodes");
  retainedNodes += nodes && typeof nodes.size === "number" ? nodes.size : 0;
  doc.destroy();
}
console.log(`nodes inside them:   ${retainedNodes}  <-- content, as opposed to framing`);

const snoop = await CollabSession.open(ids[0], { schema, collab: backend, actorId: "snoop" });
const snap = snoop.snapshot();
console.log(`\nreopening a terminated workspace by id reads back: ${snap.nodes.length} node(s)` +
  (snap.nodes.length ? ` -> "${snap.nodes[0].properties.title}"  <-- LEAK` : "  <-- nothing left"));
await snoop.close();

await server.destroy();
process.exit(0);
