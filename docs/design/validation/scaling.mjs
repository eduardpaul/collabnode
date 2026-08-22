// Does template seeding scale linearly or quadratically?
// Compares the per-node upsert loop (the only path before step 2) against the
// batch path (`applyOps`) added by it.
const ROOT = "/home/eduapaul/repos/collabnode";
const { CollabSession, InMemoryCollabBackend, InMemoryGraphStore, loadSchemaFile } =
  await import(`${ROOT}/packages/node/dist/index.js`);

const schema = await loadSchemaFile(`${ROOT}/packages/bench/schema.yaml`);
const backend = new InMemoryCollabBackend();
const now = () => Number(process.hrtime.bigint()) / 1e6;

const SIZES = [25, 50, 100, 200, 400, 800];

async function measure(label, seed, { projection }) {
  const rows = [];
  let base;
  for (const size of SIZES) {
    const session = await CollabSession.open(undefined, {
      schema,
      collab: backend,
      graph: projection ? new InMemoryGraphStore() : undefined,
      actorId: "host",
    });
    const t0 = now();
    await seed(session, size);
    const ms = now() - t0;
    if (session.snapshot().nodes.length !== size) {
      throw new Error(`${label}: expected ${size} nodes, got ${session.snapshot().nodes.length}`);
    }
    const perNode = (ms * 1000) / size;
    base ??= perNode;
    rows.push({ size, ms, perNode, ratio: perNode / base });
    await session.close();
  }
  console.log(`\n--- ${label} (projection: ${projection ? "memory" : "none"}) ---`);
  console.log("template   seed_ms   us/node   ratio_vs_linear");
  for (const r of rows) {
    console.log(
      `${String(r.size).padStart(6)}  ${r.ms.toFixed(1).padStart(9)}  ${r.perNode.toFixed(1).padStart(8)}  ${r.ratio.toFixed(2).padStart(10)}x`,
    );
  }
  return rows;
}

const perNodeSeed = async (session, size) => {
  for (let n = 0; n < size; n += 1) {
    await session.upsertNode({ type: "Task", properties: { title: `seed ${n}`, status: "todo" } });
  }
};

const batchSeed = async (session, size) =>
  session.applyOps(
    Array.from({ length: size }, (_, n) => ({
      op: "upsertNode",
      type: "Task",
      properties: { title: `seed ${n}`, status: "todo" },
    })),
  );

const loop = await measure("per-node upsertNode", perNodeSeed, { projection: true });
const batch = await measure("applyOps batch", batchSeed, { projection: true });
const batchNoProj = await measure("applyOps batch", batchSeed, { projection: false });

console.log("\n--- speedup at each template size ---");
console.log("template   loop_ms   batch_ms   batch_no_projection_ms   speedup");
for (let i = 0; i < SIZES.length; i += 1) {
  const l = loop[i], b = batch[i], n = batchNoProj[i];
  console.log(
    `${String(SIZES[i]).padStart(6)}  ${l.ms.toFixed(1).padStart(9)}  ${b.ms.toFixed(1).padStart(10)}  ${n.ms.toFixed(1).padStart(23)}  ${(l.ms / b.ms).toFixed(1).padStart(8)}x`,
  );
}
process.exit(0);
