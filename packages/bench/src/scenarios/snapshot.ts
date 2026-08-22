import type { BenchOptions, BenchRow } from "../types.js";
import { latencyStats, nowNs, nsToMs } from "../stats.js";
import { loadBenchSchema, openWorld, seedTasks } from "../setup.js";

const SNAPSHOT_ITERS = 100;

export async function runSnapshot(options: BenchOptions): Promise<BenchRow> {
  const schema = await loadBenchSchema();
  const world = await openWorld(options, schema, "snap");
  const samples: number[] = [];
  let errors = 0;

  try {
    await seedTasks(world.host, options.size, "s");
    for (let i = 0; i < SNAPSHOT_ITERS; i += 1) {
      const t0 = nowNs();
      try {
        world.host.session.snapshot();
        samples.push(nsToMs(nowNs() - t0));
      } catch {
        errors += 1;
      }
    }
    const stats = latencyStats(samples);
    return {
      scenario: "snapshot",
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
