import type { BenchOptions, BenchRow } from "../types.js";
import { latencyStats, nowNs, nsToMs, settleMs, sizeLadder } from "../stats.js";
import {
  edgeCount,
  loadBenchSchema,
  openWorld,
  seedBlocks,
  seedTasks,
  taskCount,
  waitUntil,
  type World,
} from "../setup.js";

export async function runLimits(options: BenchOptions): Promise<BenchRow[]> {
  const schema = await loadBenchSchema();
  const rows: BenchRow[] = [];

  for (const size of sizeLadder(options.size)) {
    let world: World | undefined;
    const snapSamples: number[] = [];
    let errors = 0;
    let detail: string | undefined;

    try {
      const opened = await openWorld(options, schema, "limit-host");
      world = opened;
      const ids = await seedTasks(opened.host, size, "L");
      const edges = await seedBlocks(opened.host, ids);

      for (let i = 0; i < 20; i += 1) {
        const t0 = nowNs();
        opened.host.session.snapshot();
        snapSamples.push(nsToMs(nowNs() - t0));
      }

      const hostTasks = await taskCount(opened.host);
      const hostEdges = await edgeCount(opened.host);
      if (hostTasks.snapshot !== size || hostTasks.query !== size) {
        errors += 1;
        detail = `host tasks snapshot=${hostTasks.snapshot} query=${hostTasks.query} expected=${size}`;
      }
      if (edges > 0 && (hostEdges.snapshot !== edges || hostEdges.query !== edges)) {
        errors += 1;
        detail = `host edges snapshot=${hostEdges.snapshot} query=${hostEdges.query} expected=${edges}`;
      }

      const tJoin = nowNs();
      const peer = await opened.joinPeer("limit-peer");
      const joinMs = nsToMs(nowNs() - tJoin);
      const settled = await waitUntil(async () => {
        const tasks = await taskCount(peer);
        const peerEdges = await edgeCount(peer);
        return (
          tasks.snapshot >= size &&
          tasks.query >= size &&
          (edges === 0 || (peerEdges.snapshot >= edges && peerEdges.query >= edges))
        );
      }, settleMs(options.backend, options.graph));
      if (!settled) {
        const peerTasks = await taskCount(peer);
        errors += 1;
        detail = `joiner tasks snapshot=${peerTasks.snapshot} query=${peerTasks.query} expected=${size}`;
      }

      const stats = latencyStats(snapSamples);
      rows.push({
        scenario: "limits",
        backend: options.backend,
        graph: options.graph,
        opsPerSec: null,
        p50Ms: stats.p50Ms,
        p99Ms: stats.p99Ms,
        n: size,
        errors,
        param: `${size}n`,
        ok: errors === 0,
        detail: detail ?? `join ${joinMs.toFixed(1)}ms edges ${edges}`,
      });
    } catch (error) {
      errors += 1;
      rows.push({
        scenario: "limits",
        backend: options.backend,
        graph: options.graph,
        opsPerSec: null,
        p50Ms: 0,
        p99Ms: 0,
        n: size,
        errors,
        param: `${size}n`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await world?.close();
    }
  }

  return rows;
}
