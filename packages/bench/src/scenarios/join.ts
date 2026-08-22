import type { BenchOptions, BenchRow } from "../types.js";
import { latencyStats, nowNs, nsToMs, settleMs } from "../stats.js";
import { loadBenchSchema, openWorld, seedTasks, waitUntil } from "../setup.js";

const JOIN_ITERS = 5;

export async function runJoin(options: BenchOptions): Promise<BenchRow> {
  const schema = await loadBenchSchema();
  const world = await openWorld(options, schema, "join-host");
  const samples: number[] = [];
  let errors = 0;

  try {
    await seedTasks(world.host, options.size, "j");
    for (let i = 0; i < JOIN_ITERS; i += 1) {
      const t0 = nowNs();
      try {
        const peer = await world.joinPeer(`join-peer-${i}`);
        samples.push(nsToMs(nowNs() - t0));
        const ready = await waitUntil(
          () => peer.session.snapshot().nodes.length >= options.size,
          settleMs(options.backend, options.graph),
        );
        if (!ready) {
          errors += 1;
        }
      } catch {
        errors += 1;
      }
    }
    const stats = latencyStats(samples);
    return {
      scenario: "join",
      backend: options.backend,
      graph: options.graph,
      opsPerSec: null,
      p50Ms: stats.p50Ms,
      p99Ms: stats.p99Ms,
      n: stats.n,
      errors,
    };
  } finally {
    await world.close();
  }
}
