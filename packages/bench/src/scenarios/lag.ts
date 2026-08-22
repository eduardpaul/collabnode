import type { BenchOptions, BenchRow } from "../types.js";
import { lagTimeoutMs, latencyStats, nowNs, nsToMs } from "../stats.js";
import { loadBenchSchema, openWorld, taskTitle, withTimeout } from "../setup.js";

export async function runLag(options: BenchOptions): Promise<BenchRow> {
  const schema = await loadBenchSchema();
  const world = await openWorld(options, schema, "lag-writer");
  const reader = await world.joinPeer("lag-reader");
  const iterations = Math.min(options.ops, 500);
  const timeoutMs = lagTimeoutMs(options.backend, options.graph);
  const samples: number[] = [];
  let errors = 0;

  try {
    for (let i = 0; i < iterations; i += 1) {
      const title = taskTitle("lag", i);
      let stop = (): void => {};
      const seen = new Promise<bigint>((resolve) => {
        stop = reader.session.onChange((ops) => {
          if (ops.some((op) => op.kind === "upsertNode" && op.properties.title === title)) {
            stop();
            resolve(nowNs());
          }
        });
      });
      const t0 = nowNs();
      try {
        await world.host.session.upsertNode({
          type: "Task",
          properties: { title, status: "todo" },
        });
        const arrived = await withTimeout(
          seen,
          timeoutMs,
          `lag timeout waiting for "${title}"`,
        );
        samples.push(nsToMs(arrived - t0));
      } catch {
        errors += 1;
      } finally {
        stop();
      }
    }
    const stats = latencyStats(samples);
    return {
      scenario: "lag",
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
