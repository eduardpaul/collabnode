// Fluid cold start: is container creation cheap enough for ephemeral workspaces?
const ROOT = "/home/eduapaul/repos/collabnode";
const { CollabSession, InMemoryGraphStore, loadSchemaFile } =
  await import(`${ROOT}/packages/node/dist/index.js`);
const { FluidCollabBackend } = await import(`${ROOT}/packages/fluid/dist/index.js`);
const { ensureTinylicious, releaseTinylicious } = await import(`${ROOT}/packages/fluid/dist/node.js`);

const schema = await loadSchemaFile(`${ROOT}/packages/bench/schema.yaml`);
const now = () => Number(process.hrtime.bigint()) / 1e6;

const spawn0 = now();
await ensureTinylicious(7070, {});
console.log(`tinylicious spawn: ${(now() - spawn0).toFixed(0)}ms (one-time)`);

const backend = new FluidCollabBackend({ domain: "http://localhost", port: 7070 });
const opens = [], totals = [];
for (let i = 0; i < 8; i += 1) {
  const t0 = now();
  const s = await CollabSession.open(undefined, {
    schema, collab: backend, graph: new InMemoryGraphStore(), actorId: "host",
  });
  const t1 = now();
  for (let n = 0; n < 10; n += 1) {
    await s.upsertNode({ type: "Task", properties: { title: `seed ${n}`, status: "todo" } });
  }
  s.snapshot();
  await s.close();
  opens.push(t1 - t0);
  totals.push(now() - t0);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`fluid open:  mean ${mean(opens).toFixed(1)}ms  max ${Math.max(...opens).toFixed(1)}ms`);
console.log(`fluid churn: mean ${mean(totals).toFixed(1)}ms (open + 10 writes + snapshot + close)`);
releaseTinylicious(7070);
process.exit(0);
