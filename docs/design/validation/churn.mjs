// Workspace churn benchmark: open -> seed template -> writes -> snapshot -> close.
// Measures the cold-start cost that decides whether "ephemeral workspaces" is viable.
const ROOT = "/home/eduapaul/repos/collabnode";
const {
  CollabSession,
  InMemoryCollabBackend,
  InMemoryGraphStore,
  loadSchemaFile,
} = await import(`${ROOT}/packages/node/dist/index.js`);
const { HocuspocusCollabBackend } = await import(`${ROOT}/packages/hocuspocus/dist/index.js`);
const { ensureHocuspocus, stopHocuspocus } = await import(`${ROOT}/packages/hocuspocus/dist/node.js`);

const schema = await loadSchemaFile(`${ROOT}/packages/bench/schema.yaml`);

const now = () => Number(process.hrtime.bigint()) / 1e6;

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { mean, p50: at(50), p95: at(95), max: sorted[sorted.length - 1] };
}

const fmt = (n) => n.toFixed(1).padStart(8);

async function churn({ label, backend, store, iterations, templateSize, writes, batch }) {
  const phases = { open: [], seed: [], write: [], snapshot: [], close: [], total: [] };
  for (let i = 0; i < iterations; i += 1) {
    const t0 = now();
    const session = await CollabSession.open(undefined, {
      schema,
      collab: backend,
      graph: store(),
      actorId: "host",
    });
    const t1 = now();

    // Template seed: N nodes plus a chain of edges.
    if (batch) {
      const nodes = Array.from({ length: templateSize }, (_, n) => ({
        op: "upsertNode",
        ref: `n${n}`,
        type: "Task",
        properties: { title: `seed ${n}`, status: "todo" },
      }));
      const edges = Array.from({ length: Math.max(0, templateSize - 1) }, (_, n) => ({
        op: "upsertEdge",
        type: "BLOCKS",
        from: { ref: `n${n}` },
        to: { ref: `n${n + 1}` },
      }));
      await session.applyOps([...nodes, ...edges]);
    } else {
      const ids = [];
      for (let n = 0; n < templateSize; n += 1) {
        ids.push(await session.upsertNode({
          type: "Task",
          properties: { title: `seed ${n}`, status: "todo" },
        }));
      }
      for (let n = 1; n < ids.length; n += 1) {
        await session.upsertEdge({ type: "BLOCKS", from: ids[n - 1], to: ids[n] });
      }
    }
    const t2 = now();

    for (let w = 0; w < writes; w += 1) {
      await session.upsertNode({
        type: "Task",
        properties: { title: `live ${w}`, status: "doing" },
      });
    }
    const t3 = now();

    const snap = session.snapshot();
    if (snap.nodes.length !== templateSize + writes) {
      throw new Error(`snapshot lost nodes: ${snap.nodes.length}`);
    }
    const t4 = now();

    await session.close();
    const t5 = now();

    phases.open.push(t1 - t0);
    phases.seed.push(t2 - t1);
    phases.write.push(t3 - t2);
    phases.snapshot.push(t4 - t3);
    phases.close.push(t5 - t4);
    phases.total.push(t5 - t0);
  }
  const row = (name) => {
    const s = stats(phases[name]);
    return `${name.padEnd(9)} mean ${fmt(s.mean)}  p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  max ${fmt(s.max)}`;
  };
  console.log(`\n--- ${label} (n=${iterations}, template=${templateSize}, writes=${writes}) ---`);
  for (const name of ["open", "seed", "write", "snapshot", "close", "total"]) {
    console.log("  " + row(name));
  }
  return stats(phases.total);
}

const iterations = Number(process.env.ITER ?? 20);
const templateSize = Number(process.env.TEMPLATE ?? 25);
const writes = Number(process.env.WRITES ?? 10);

const memBackend = new InMemoryCollabBackend();
const memStore = new InMemoryGraphStore();
await churn({
  label: "memory + memory store, per-node seed",
  backend: memBackend, store: () => memStore,
  iterations, templateSize, writes, batch: false,
});
await churn({
  label: "memory + memory store, batch seed",
  backend: memBackend, store: () => memStore,
  iterations, templateSize, writes, batch: true,
});
await churn({
  label: "memory + projection: none, batch seed",
  backend: memBackend, store: () => undefined,
  iterations, templateSize, writes, batch: true,
});

const server = await ensureHocuspocus(1234);
try {
  const hp = new HocuspocusCollabBackend({ url: "ws://127.0.0.1:1234" });
  const hpStore = new InMemoryGraphStore();
  await churn({
    label: "hocuspocus + memory store, per-node seed",
    backend: hp, store: () => hpStore,
    iterations, templateSize, writes, batch: false,
  });
  await churn({
    label: "hocuspocus + memory store, batch seed",
    backend: hp, store: () => hpStore,
    iterations, templateSize, writes, batch: true,
  });
  await churn({
    label: "hocuspocus + projection: none, batch seed",
    backend: hp, store: () => undefined,
    iterations, templateSize, writes, batch: true,
  });
  if (server) {
    console.log(`\nhocuspocus documents resident after ${iterations * 3} closed sessions: ${server.hocuspocus.getDocumentsCount()}`);
  }
} finally {
  await stopHocuspocus(server);
}
process.exit(0);
