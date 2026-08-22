import type { BenchOptions, BenchRow } from "../types.js";
import { latencyStats, nowNs, nsToMs, opsPerSec, warmupCount } from "../stats.js";
import { loadBenchSchema, nextStatus, openWorld, taskTitle } from "../setup.js";

export async function runWrites(options: BenchOptions): Promise<BenchRow> {
  const schema = await loadBenchSchema();
  const world = await openWorld(options, schema, "writer");
  const warmup = warmupCount(options.ops);
  const total = warmup + options.ops;
  const samples: number[] = [];
  const created: string[] = [];
  let errors = 0;
  const wallStart = nowNs();
  let measureStart = wallStart;

  try {
    for (let i = 0; i < total; i += 1) {
      if (i === warmup) {
        measureStart = nowNs();
      }
      const update = created.length > 0 && i % 5 === 0;
      const t0 = nowNs();
      try {
        if (update) {
          const id = created[i % created.length]!;
          await world.host.session.upsertNode({
            id,
            type: "Task",
            properties: { title: taskTitle("w", i), status: nextStatus(i) },
          });
        } else {
          const id = await world.host.session.upsertNode({
            type: "Task",
            properties: { title: taskTitle("w", i), status: "todo" },
          });
          created.push(id);
        }
        if (i >= warmup) {
          samples.push(nsToMs(nowNs() - t0));
        }
      } catch {
        errors += 1;
      }
    }
    const stats = latencyStats(samples);
    return {
      scenario: "writes",
      backend: options.backend,
      graph: options.graph,
      opsPerSec: opsPerSec(samples.length, nowNs() - measureStart),
      p50Ms: stats.p50Ms,
      p99Ms: stats.p99Ms,
      n: stats.n,
      errors,
    };
  } finally {
    await world.close();
  }
}
