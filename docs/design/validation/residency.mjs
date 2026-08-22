// Do closed workspaces actually go away, or accumulate server-side?
const ROOT = "/home/eduapaul/repos/collabnode";
const { CollabSession, InMemoryGraphStore, loadSchemaFile } =
  await import(`${ROOT}/packages/node/dist/index.js`);
const { HocuspocusCollabBackend } = await import(`${ROOT}/packages/hocuspocus/dist/index.js`);
const { Server } = await import(
  `${ROOT}/packages/hocuspocus/node_modules/@hocuspocus/server/dist/hocuspocus-server.esm.js`
);

const schema = await loadSchemaFile(`${ROOT}/packages/bench/schema.yaml`);
const server = new Server({ port: 1240, address: "127.0.0.1", quiet: true, stopOnSignals: false });
await server.listen();
const h = server.hocuspocus;
const backend = new HocuspocusCollabBackend({ url: "ws://127.0.0.1:1240" });

const ids = [];
for (let i = 0; i < 10; i += 1) {
  const s = await CollabSession.open(undefined, {
    schema, collab: backend, graph: new InMemoryGraphStore(), actorId: "host",
  });
  ids.push(s.id);
  await s.upsertNode({ type: "Task", properties: { title: `w${i}`, status: "todo" } });
  await s.close();
}

const settle = async (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`after 10 open+close cycles, immediately: ${h.getDocumentsCount()} documents resident`);
await settle(1500);
console.log(`after 1.5s settle:                       ${h.getDocumentsCount()} documents resident`);

// Can a terminated workspace's data still be re-read by anyone who knows the id?
const rejoin = await CollabSession.open(ids[0], {
  schema, collab: backend, graph: new InMemoryGraphStore(), actorId: "snoop",
});
console.log(`rejoin of a "terminated" workspace: ${rejoin.snapshot().nodes.length} node(s) still readable`);
await rejoin.close();

// Is there any API to actually destroy it?
await settle(500);
const before = h.getDocumentsCount();
const doc = h.documents.get(ids[0]);
if (doc) {
  await h.unloadDocument(doc);
  console.log(`unloadDocument(): ${before} -> ${h.getDocumentsCount()} resident`);
} else {
  console.log(`unloadDocument(): document not resident to unload (count=${before})`);
}
const back = await CollabSession.open(ids[0], {
  schema, collab: backend, graph: new InMemoryGraphStore(), actorId: "snoop2",
});
console.log(`after unload, rejoin sees: ${back.snapshot().nodes.length} node(s) (0 = gone, 1 = persisted elsewhere)`);
await back.close();

await server.destroy();
process.exit(0);
