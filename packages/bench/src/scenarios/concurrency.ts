import type { Collabnode } from "collabnode";
import type { BenchOptions, BenchRow } from "../types.js";
import { latencyStats, nowNs, nsToMs, opsPerSec } from "../stats.js";
import { loadBenchSchema, nextStatus, openWorld, taskTitle } from "../setup.js";

export async function runConcurrency(options: BenchOptions): Promise<BenchRow> {
  const schema = await loadBenchSchema();
  const actors = Math.max(1, options.concurrency);
  const world = await openWorld(options, schema, "actor-0");
  const sessions: Collabnode[] = [world.host];

  try {
    for (let i = 1; i < actors; i += 1) {
      sessions.push(await world.joinPeer(`actor-${i}`));
    }

    const perActor = Math.floor(options.ops / actors);
    const remainder = options.ops % actors;
    const samples: number[] = [];
    let errors = 0;

    const wallStart = nowNs();
    await Promise.all(
      sessions.map(async (node, actor) => {
        const count = perActor + (actor < remainder ? 1 : 0);
        for (let i = 0; i < count; i += 1) {
          const t0 = nowNs();
          try {
            await node.session.upsertNode({
              type: "Task",
              properties: {
                title: taskTitle(`c${actor}`, i),
                status: nextStatus(i),
              },
            });
            samples.push(nsToMs(nowNs() - t0));
          } catch {
            errors += 1;
          }
        }
      }),
    );
    const wall = nowNs() - wallStart;
    const stats = latencyStats(samples);
    return {
      scenario: "concurrency",
      backend: options.backend,
      graph: options.graph,
      opsPerSec: opsPerSec(samples.length, wall),
      p50Ms: stats.p50Ms,
      p99Ms: stats.p99Ms,
      n: stats.n,
      errors,
    };
  } finally {
    await world.close();
  }
}
